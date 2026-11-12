// Claude via the local Claude Code CLI (`claude -p`), using whoever is logged in to Claude Code on
// this machine — no API key needed. One CLI process per conversation: messages go in as
// stream-json on stdin and each turn's `result` event comes back on stdout, so later turns reuse
// the same session (and its prompt cache) instead of paying CLI start-up again.
//
// The CLI runs in an empty sandbox dir with only project settings, no tools and no MCP servers,
// so none of the user's CLAUDE.md / hooks / plugins leak into the prompt.
//
//   const s = openClaudeSession({ system, model: "sonnet", signal });
//   const { text } = await s.send("question");   // repeat for follow-ups
//   s.close();

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_CLI_TURN_TIMEOUT_MS) || 180_000;
const SANDBOX = path.join(os.tmpdir(), "pm-console-claude-cli");

let cachedBin;
export function claudeCliPath() {
  if (cachedBin !== undefined) return cachedBin;
  const home = os.homedir();
  const candidates = [process.env.CLAUDE_CLI_PATH, "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(home, ".local/bin/claude"), path.join(home, ".claude/local/claude")].filter(Boolean);
  cachedBin = candidates.find((p) => fs.existsSync(p)) || null;
  return cachedBin;
}

export const claudeCliModel = () => String(process.env.CLAUDE_CLI_MODEL || "sonnet").trim();

export function openClaudeSession({ system, model = claudeCliModel(), signal } = {}) {
  const bin = claudeCliPath();
  if (!bin) throw new Error("Claude CLI not found — install Claude Code or set CLAUDE_CLI_PATH");
  fs.mkdirSync(SANDBOX, { recursive: true });
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", model, "--tools", "", "--no-session-persistence", "--setting-sources", "project", "--strict-mcp-config"];
  if (system) args.push("--system-prompt", system);
  const env = { ...process.env };
  // A backend started from inside Claude Code inherits these; the child must start as a fresh CLI.
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
  const child = spawn(bin, args, { cwd: SANDBOX, env, stdio: ["pipe", "pipe", "pipe"] });

  let pending = null;
  let stderr = "";
  let dead = null;
  let usedModel = model;
  const fail = (err) => {
    dead = dead || err;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(err);
    }
  };
  child.on("error", (e) => fail(new Error(`Claude CLI failed to start: ${e.message}`)));
  child.on("exit", (code) => fail(new Error(`Claude CLI exited (${code})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`)));
  child.stderr.on("data", (b) => {
    stderr = (stderr + b).slice(-2000);
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (d.type === "system" && d.subtype === "init" && d.model) usedModel = d.model;
    if (d.type !== "result" || !pending) return;
    const p = pending;
    pending = null;
    if (d.is_error) p.reject(new Error(`Claude CLI: ${String(d.result || d.subtype || "error").slice(0, 300)}`));
    else p.resolve({ text: String(d.result || ""), model: usedModel, costUsd: d.total_cost_usd, usage: d.usage });
  });

  const close = () => {
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => child.exitCode == null && child.kill("SIGTERM"), 2000).unref();
  };
  const onAbort = () => {
    fail(new Error("Stopped"));
    child.kill("SIGTERM");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    send(text) {
      if (dead) return Promise.reject(dead);
      if (pending) return Promise.reject(new Error("Claude CLI turn already in flight"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          fail(new Error(`Claude CLI turn timed out after ${TURN_TIMEOUT_MS / 1000}s`));
          child.kill("SIGTERM");
        }, TURN_TIMEOUT_MS);
        pending = {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        };
        child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      });
    },
    close() {
      signal?.removeEventListener("abort", onAbort);
      close();
    },
  };
}

// ─── One-shot generation (PRD / BRD / UAT / JIRA / Alpha via /api/generate, /api/claude, /api/alpha) ─────

/** Anthropic-style content (string or blocks) → plain text; non-text blocks become a short note. */
function contentText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return c == null ? "" : JSON.stringify(c);
  return c
    .map((b) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text || "";
      if (b?.type === "tool_result") return contentText(b.content);
      return `[${b?.type || "attachment"} omitted — Claude CLI channel is text-only]`;
    })
    .join("\n");
}

/**
 * Messages [{ role, content }] → one CLI turn. A single user message goes as-is; a longer
 * conversation is replayed as a transcript with the last user message as the request.
 */
export function messagesToPrompt(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && m.content != null);
  if (list.length <= 1) return contentText(list[0]?.content);
  const last = list[list.length - 1];
  const prior = (last.role === "user" ? list.slice(0, -1) : list).map((m) => `[${m.role === "assistant" ? "ASSISTANT" : "USER"}]\n${contentText(m.content)}`).join("\n\n");
  const ask = last.role === "user" ? contentText(last.content) : "Continue.";
  return `Conversation so far:\n\n${prior}\n\n[USER — reply to this]\n${ask}`;
}

/** Bedrock tier names double as CLI model aliases. */
export function cliModelFor({ model, tier } = {}) {
  const t = String(tier || "").toLowerCase();
  if (t === "sonnet" || t === "opus" || t === "haiku") return t;
  const m = String(model || "").trim();
  if (/^(sonnet|opus|haiku|claude-[a-z0-9.-]+)$/i.test(m)) return m;
  return claudeCliModel();
}

/** One request → Anthropic Messages-shaped result ({ content: [{ type: "text", text }], usage, model }). */
export async function runClaudeCliOnce({ system, messages, model, signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const s = openClaudeSession({ system, model: model || claudeCliModel(), signal: ctl.signal });
  try {
    const r = await s.send(messagesToPrompt(messages));
    const u = r.usage || {};
    return {
      content: [{ type: "text", text: r.text }],
      model: r.model,
      usage: { input_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output_tokens: u.output_tokens || 0 },
      costUsd: r.costUsd,
    };
  } catch (e) {
    if (ctl.signal.aborted && !signal?.aborted) throw new Error(`Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    s.close();
  }
}

/** Login check without spending tokens (`claude auth status`). */
export async function claudeCliStatus() {
  const bin = claudeCliPath();
  if (!bin) return { configured: false, ok: false, error: "Claude CLI not found (install Claude Code or set CLAUDE_CLI_PATH)" };
  return new Promise((resolve) => {
    const env = { ...process.env };
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
    const child = spawn(bin, ["auth", "status"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.stdout.on("data", (b) => (out += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ configured: true, ok: false, error: e.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(out);
        resolve(d.loggedIn ? { configured: true, ok: true, error: null, plan: d.subscriptionType || d.authMethod || null } : { configured: true, ok: false, error: "Claude CLI not logged in — run `claude` then /login" });
      } catch {
        resolve({ configured: true, ok: false, error: `Unexpected \`claude auth status\` output: ${out.slice(0, 120)}` });
      }
    });
  });
}
