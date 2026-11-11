/**
 * MCP server: start local PRD-agent stacks from Claude (Desktop / Claude Code / CLI).
 * Tools: letsbegin (all-in-one), startagent, startanalyst, agents_status.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_FALLBACK = path.resolve(__dirname, "../..");

function resolveRepoRoot() {
  const env = process.env.PRD_AGENT_ROOT?.trim();
  if (env && fs.existsSync(path.join(env, "package.json"))) {
    return path.resolve(env);
  }
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "package.json")) && fs.existsSync(path.join(cwd, "mcp/agents-launcher/index.js"))) {
    return cwd;
  }
  return REPO_ROOT_FALLBACK;
}

function forceStart() {
  return process.env.PRD_AGENT_FORCE_START === "1";
}

function ensureLogDir(root) {
  const dir = process.env.PRD_AGENT_LAUNCH_LOG_DIR?.trim() || path.join(root, ".claude");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

function appendSpawnBanner(logPath, title) {
  const line = `\n--- ${new Date().toISOString()} ${title} ---\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    /* ignore */
  }
}

function npmDetached(root, npmArgs, logFile, extraEnv = {}) {
  appendSpawnBanner(logFile, npmArgs.join(" "));
  const logFd = fs.openSync(logFile, "a");
  const child = spawn("npm", npmArgs, {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...extraEnv },
  });
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }
  child.unref();
  return child.pid;
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(1200);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

// ── Already-running process detection (11 Nov 2026) ─────────────────────────────────────────────
// A port check alone is not enough: `node --watch` keeps running after its server crashes ("Completed running
// 'server.js'. Waiting for file changes…"), so :5000 is closed while a backend watcher still exists. Starting
// another backend then gives two watchers — both run every scheduler and write the same cache files (this caused
// the duplicate backend of 11 Nov 2026). So before spawning, look for the process itself.
const realDir = (d) => {
  try {
    return fs.realpathSync(d);
  } catch {
    return path.resolve(d);
  }
};

/** PIDs (other than this one) whose command line matches `pattern` — and, when `dir` is given, whose cwd is `dir`. */
function pidsMatching(pattern, dir = null) {
  if (process.platform === "win32") return [];
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  const pids = (r.stdout || "")
    .split("\n")
    .map(Number)
    .filter((p) => p && p !== process.pid);
  if (!dir) return pids;
  const want = realDir(dir);
  return pids.filter((pid) => {
    const c = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const line = (c.stdout || "").split("\n").find((l) => l.startsWith("n"));
    return Boolean(line) && realDir(line.slice(1)) === want;
  });
}

const backendPids = (root) => pidsMatching("node .*server\\.js", path.join(root, "backend"));
const frontendPids = (root) => pidsMatching("react-scripts.*start", root);
const nextDevPids = (port) => pidsMatching(`next dev.*-p ${port}`);

/** Backend watcher alive but its server down (crashed): touch server.js so `node --watch` restarts it, then wait for :5000. */
async function nudgeBackend(root) {
  const file = path.join(root, "backend", "server.js");
  const now = new Date();
  fs.utimesSync(file, now, now);
  for (let i = 0; i < 20; i++) {
    if (await portOpen(5000)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function openUrlInBrowser(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", shell: true }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

/** macOS: opens Terminal via .command bundle. Else returns manual hint. */
function openLiveLogTerminal(root) {
  if (process.env.PRD_AGENT_SKIP_TERMINAL === "1") {
    return { skipped: true, reason: "PRD_AGENT_SKIP_TERMINAL=1" };
  }
  const cmdFile = path.join(root, "scripts", "live-agent-logs.command");
  if (!fs.existsSync(cmdFile)) {
    return { skipped: true, reason: "live-agent-logs.command missing", cmdFile };
  }
  if (process.platform === "darwin") {
    spawn("open", [cmdFile], { detached: true, stdio: "ignore" }).unref();
    return { opened: true, cmdFile };
  }
  return {
    skipped: true,
    reason: "Auto Terminal is macOS-only; run: bash scripts/live-agent-logs.command",
    cmdFile,
  };
}

async function startMainStack(root) {
  const logDir = ensureLogDir(root);
  const logFile = path.join(logDir, "main-dev.log");
  if (!forceStart()) {
    const [p3000, p5000] = await Promise.all([portOpen(3000), portOpen(5000)]);
    if (p3000 && p5000) {
      return {
        ok: true,
        started: false,
        repoRoot: root,
        logFile,
        note: "Ports 3000 and 5000 already listening; skipped npm run dev. Set PRD_AGENT_FORCE_START=1 to spawn anyway.",
      };
    }
  }
  // Start only the half that is down — and only when no process for it exists. Spawning the full `npm run dev`
  // while one port is held gives a second stack whose frontend exits on :3000 and whose backend fights over :5000;
  // spawning a backend while a crashed watcher waits for a file change gives two backends.
  if (!forceStart()) {
    const [p3000, p5000] = await Promise.all([portOpen(3000), portOpen(5000)]);
    const be = backendPids(root);
    const fe = frontendPids(root);
    const notes = [];
    let nudged = null;
    if (!p5000 && be.length) {
      nudged = await nudgeBackend(root);
      notes.push(
        nudged
          ? `Backend watcher already running (pid ${be.join(", ")}) but :5000 was down — restarted it via its file watch; now listening.`
          : `Backend watcher already running (pid ${be.join(", ")}) but :5000 is still down after a restart nudge — check ${logFile}. Not starting a second backend.`,
      );
    }
    if (!p3000 && fe.length) notes.push(`Frontend process already running (pid ${fe.join(", ")}) but :3000 not answering yet — not starting a second one.`);
    const needBackend = !p5000 && !be.length;
    const needFrontend = !p3000 && !fe.length;
    if (needBackend && needFrontend) {
      const pid = npmDetached(root, ["run", "dev"], logFile);
      return { ok: true, started: true, pid, repoRoot: root, logFile };
    }
    if (needBackend) {
      const pid = npmDetached(root, ["run", "start:backend"], logFile);
      return { ok: true, started: "backend", pid, repoRoot: root, logFile, note: ["Frontend already up; started backend only.", ...notes].join(" ") };
    }
    if (needFrontend) {
      const pid = npmDetached(root, ["start"], logFile, { BROWSER: "none" });
      return { ok: true, started: "frontend", pid, repoRoot: root, logFile, note: ["Backend already up; started frontend only.", ...notes].join(" ") };
    }
    return { ok: nudged !== false, started: nudged ? "backend-restarted" : false, repoRoot: root, logFile, note: notes.join(" ") || "Already running." };
  }
  const pid = npmDetached(root, ["run", "dev"], logFile);
  return { ok: true, started: true, pid, repoRoot: root, logFile };
}

async function startAnalystStack(root) {
  const qaDir = path.join(root, "Query_Agent");
  if (!fs.existsSync(qaDir)) {
    return {
      ok: false,
      error: "Query_Agent directory not found. Clone or create it beside package.json, then retry.",
      repoRoot: root,
    };
  }
  const logDir = ensureLogDir(root);
  const logFile = path.join(logDir, "analyst-dev.log");
  if (!forceStart() && ((await portOpen(3040)) || nextDevPids(3040).length)) {
    return {
      ok: true,
      started: false,
      repoRoot: root,
      logFile,
      note: "Analyst already running (port 3040 listening or its next dev process exists); skipped npm run dev:analyst. Set PRD_AGENT_FORCE_START=1 to spawn anyway.",
    };
  }
  const pid = npmDetached(root, ["run", "dev:analyst"], logFile);
  return { ok: true, started: true, pid, repoRoot: root, logFile };
}

async function startAlphaStack(root) {
  const alphaDir = path.join(root, "alpha-web-ui");
  if (!fs.existsSync(alphaDir)) {
    return {
      ok: false,
      error: "alpha-web-ui directory not found. Run the sync from Google Drive first.",
      repoRoot: root,
    };
  }
  const logDir = ensureLogDir(root);
  const logFile = path.join(logDir, "alpha-dev.log");
  if (!forceStart() && ((await portOpen(3050)) || nextDevPids(3050).length)) {
    return {
      ok: true,
      started: false,
      repoRoot: root,
      logFile,
      note: "Alpha already running (port 3050 listening or its next dev process exists); skipped npm run dev:alpha. Set PRD_AGENT_FORCE_START=1 to spawn anyway.",
    };
  }
  const pid = npmDetached(root, ["run", "dev:alpha"], logFile);
  return { ok: true, started: true, pid, repoRoot: root, logFile };
}

const MCP_HOME = process.env.MCP_HOME?.trim() || "/Users/deepankarpathak/dev/mcp";
const MCP_SERVERS = [
  { name: "kb-mcp-server",          cmd: "node",    args: [`${MCP_HOME}/kb-mcp-server/src/index.js`],          log: "mcp-kb.log" },
  { name: "redash-mcp",             cmd: "node",    args: [`${MCP_HOME}/redash-mcp/dist/cli.js`],               log: "mcp-redash.log" },
  { name: "mcp-server-prometheus",  cmd: "node",    args: [`${MCP_HOME}/mcp-server-prometheus/build/index.js`], log: "mcp-prometheus.log" },
  { name: "superset-mcp",           cmd: `${MCP_HOME}/superset-mcp/venv/bin/python`, args: [`${MCP_HOME}/superset-mcp/main.py`], log: "mcp-superset.log" },
];

async function startMcps(root) {
  const logDir = ensureLogDir(root);
  const results = [];
  for (const srv of MCP_SERVERS) {
    const logFile = path.join(logDir, srv.log);
    // Every /letsbegin used to spawn another copy of each MCP server.
    const entry = srv.args[srv.args.length - 1];
    const running = spawnSync("pgrep", ["-f", entry], { encoding: "utf8" }).stdout.trim();
    if (running) {
      results.push({ name: srv.name, started: false, pid: Number(running.split("\n")[0]), logFile, note: "already running" });
      continue;
    }
    appendSpawnBanner(logFile, `${srv.cmd} ${srv.args.join(" ")}`);
    const logFd = fs.openSync(logFile, "a");
    const child = spawn(srv.cmd, srv.args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    child.unref();
    results.push({ name: srv.name, pid: child.pid, logFile });
  }
  return results;
}

const server = new McpServer({
  name: "prd-agent-launcher",
  version: "1.0.0",
});

server.tool(
  "letsbegin",
  "One-shot: start main agents (React :3000 + API :5000) and Analyst (:3040) if not already running; open browser tabs; on macOS open Terminal tailing combined dev logs with [api]/[analyst-api] lines. Maps to user slash /letsbegin.",
  async () => {
    const root = resolveRepoRoot();
    const main = await startMainStack(root);
    const analyst = await startAnalystStack(root);
    const alpha = await startAlphaStack(root);
    const mcpServers = await startMcps(root);
    const mainUrl = process.env.PRD_AGENT_MAIN_URL?.trim() || "http://localhost:3000";
    const analystUrl = process.env.REACT_APP_ANALYST_AGENT_URL?.trim() || "http://localhost:3040";
    const alphaUrl = process.env.REACT_APP_ALPHA_AGENT_URL?.trim() || "http://localhost:3050";

    openUrlInBrowser(mainUrl);
    setTimeout(() => openUrlInBrowser(analystUrl), 400);
    setTimeout(() => openUrlInBrowser(alphaUrl), 800);

    const terminal = openLiveLogTerminal(root);

    const payload = {
      ok: analyst.ok !== false && main.ok !== false && alpha.ok !== false,
      mainStack: main,
      analystStack: analyst,
      alphaStack: alpha,
      mcpServers,
      browserOpened: [mainUrl, analystUrl, alphaUrl],
      terminal,
      tips: [
        "Wait a few seconds for dev servers to bind ports; refresh browser if needed.",
        "API traffic: lines prefixed [api] (Express) and [analyst-api] (Next) appear in the tail window / log files.",
        "Disable HTTP request logs: PRD_AGENT_HTTP_LOG=0 on backend env or Query_Agent.",
        "Alpha Agent: http://localhost:3050 (also embedded as α tab in main UI)",
        "MCP server logs: .claude/mcp-kb.log, mcp-redash.log, mcp-prometheus.log, mcp-superset.log",
      ],
    };

    if (!analyst.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
  },
);

server.tool(
  "startagent",
  "Starts the main agent stack: Node backend (port 5000) + React app (port 3000). Serves PRD, UAT, BRD, and JIRA tabs in one UI. Skips if ports already up unless PRD_AGENT_FORCE_START=1. Logs: .claude/main-dev.log.",
  async () => {
    const root = resolveRepoRoot();
    const result = await startMainStack(root);
    const mainUrl = process.env.PRD_AGENT_MAIN_URL?.trim() || "http://localhost:3000";
    const body = {
      ...result,
      openUi: mainUrl,
      apiUrl: "http://localhost:5000",
      note: "If npm is missing from PATH when Claude launches MCP, fix PATH in MCP env (see docs/CLAUDE_AGENTS_LAUNCHER.md).",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    };
  },
);

server.tool(
  "startanalyst",
  "Starts Analyst / Query_Agent (npm run dev:analyst — Next.js :3040). Skips if port up unless PRD_AGENT_FORCE_START=1. Logs: .claude/analyst-dev.log.",
  async () => {
    const root = resolveRepoRoot();
    const result = await startAnalystStack(root);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: true,
      };
    }
    const analystUrl = process.env.REACT_APP_ANALYST_AGENT_URL?.trim() || "http://localhost:3040";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, iframeUrl: analystUrl }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "startalpha",
  "Starts Alpha Agent web-ui (npm run dev:alpha — Next.js :3050). Skips if port up unless PRD_AGENT_FORCE_START=1. Logs: .claude/alpha-dev.log.",
  async () => {
    const root = resolveRepoRoot();
    const result = await startAlphaStack(root);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: true,
      };
    }
    const alphaUrl = process.env.REACT_APP_ALPHA_AGENT_URL?.trim() || "http://localhost:3050";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...result, iframeUrl: alphaUrl }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "agents_status",
  "Checks whether default ports are accepting TCP connections: 3000 (main React), 5000 (API), 3040 (Analyst Next.js).",
  async () => {
    const [p3000, p5000, p3040, p3050] = await Promise.all([portOpen(3000), portOpen(5000), portOpen(3040), portOpen(3050)]);
    const body = {
      mainReact: { port: 3000, listening: p3000 },
      mainApi: { port: 5000, listening: p5000 },
      analystNext: { port: 3040, listening: p3040 },
      alphaNext: { port: 3050, listening: p3050 },
      repoRoot: resolveRepoRoot(),
      mcpServers: MCP_SERVERS.map(s => {
        const logFile = path.join(ensureLogDir(resolveRepoRoot()), s.log);
        return { name: s.name, logFile, logExists: fs.existsSync(logFile) };
      }),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    };
  },
);

server.tool(
  "start_mcps",
  "Start all external MCP servers (kb-mcp-server, redash-mcp, mcp-server-prometheus, superset-mcp) in background. Logs to .claude/mcp-*.log in the repo root.",
  async () => {
    const root = resolveRepoRoot();
    const results = await startMcps(root);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, mcpServers: results }, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
