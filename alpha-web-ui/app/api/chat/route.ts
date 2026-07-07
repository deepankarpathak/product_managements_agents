import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { REPO_ROOT } from "@/lib/repo";

function getAnthropicToken(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const raw = execSync(
      "security find-generic-password -s 'Claude Code-credentials' -w",
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    const d = JSON.parse(raw);
    return d?.claudeAiOauth?.accessToken ?? "";
  } catch {
    return "";
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

type ClientEvent = Record<string, unknown>;

const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);

/**
 * Normalize a raw claude stream-json event into a compact client event.
 * Returns null for events we don't surface. Text is streamed via partial
 * deltas, so we deliberately skip the full `assistant` text block to avoid
 * duplicating it — we only pull tool_use blocks out of the assistant message.
 */
function* normalize(evt: any): Generator<ClientEvent> {
  const type = evt?.type;

  if (type === "system" && evt.subtype === "init") {
    yield {
      kind: "init",
      session_id: evt.session_id,
      model: evt.model,
      tools: evt.tools,
      mcp_servers: evt.mcp_servers,
    };
    return;
  }

  if (type === "rate_limit_event") {
    yield { kind: "rate_limit", info: evt.rate_limit_info };
    return;
  }

  if (type === "stream_event") {
    const ev = evt.event;
    if (ev?.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta") {
        yield { kind: "text", text: d.text };
      } else if (d?.type === "thinking_delta") {
        yield { kind: "thinking", text: d.thinking };
      }
    }
    return;
  }

  if (type === "assistant") {
    const blocks = evt.message?.content || [];
    for (const b of blocks) {
      if (b.type === "tool_use") {
        yield { kind: "tool_use", id: b.id, name: b.name, input: b.input };
      }
    }
    return;
  }

  if (type === "user") {
    const blocks = evt.message?.content || [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        let text = "";
        if (typeof b.content === "string") text = b.content;
        else if (Array.isArray(b.content))
          text = b.content
            .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
            .join("\n");
        const MAX = 4000;
        yield {
          kind: "tool_result",
          tool_use_id: b.tool_use_id,
          is_error: !!b.is_error,
          text: text.length > MAX ? text.slice(0, MAX) + "\n…(truncated)" : text,
        };
      }
    }
    return;
  }

  if (type === "result") {
    yield {
      kind: "result",
      session_id: evt.session_id,
      result: evt.result,
      is_error: !!evt.is_error,
      cost_usd: evt.total_cost_usd,
      duration_ms: evt.duration_ms,
      num_turns: evt.num_turns,
    };
    return;
  }
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const message: string = (body.message || "").toString();
  if (!message.trim()) {
    return new Response("Empty message", { status: 400 });
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : "opus";
  const resume: boolean = !!body.resume;
  // The client owns the conversation UUID so it can resume across turns.
  const sessionId: string =
    typeof body.sessionId === "string" && body.sessionId.length >= 8
      ? body.sessionId
      : randomUUID();

  const args = [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
    // No interactive surface in this headless chat: AskUserQuestion would be
    // auto-dismissed. Disallow it so the model asks clarifying questions as
    // prose and ends its turn; the user answers on the next message.
    "--disallowedTools",
    "AskUserQuestion",
    "--model",
    model,
  ];
  if (resume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  const token = getAnthropicToken();
  const child = spawn("claude", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(token ? { ANTHROPIC_API_KEY: token } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (obj: ClientEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send({ kind: "session", session_id: sessionId });

      // Buffer stdout by newline — JSONL chunks can split mid-line.
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // ignore non-JSON noise
          }
          for (const out of normalize(evt)) send(out);
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf8");
      });

      child.on("error", (err) => {
        send({ kind: "error", message: `Failed to start claude: ${err.message}` });
        finish();
      });

      child.on("close", (code) => {
        if (code && code !== 0 && stderrBuf.trim()) {
          send({ kind: "error", message: stderrBuf.trim().slice(0, 2000) });
        }
        send({ kind: "done", code });
        finish();
      });

      // Kill the child if the browser disconnects / aborts.
      req.signal.addEventListener("abort", () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* noop */
        }
        finish();
      });
    },
    cancel() {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
