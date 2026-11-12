// Automatic Payments Dashboard (APD) — Phase 1 embed of third_party/apd_installer.
//
// The APD is a set of Python pull scripts (Trino / TPAP Redash -> per-day CSV caches -> data/ files)
// plus a static d3 page. Instead of its own launchd jobs (python http.server on :8770 + 10:00 refresh),
// this module:
//   - serves the page at /api/apd/page/automatic_payments/  (same origin through the CRA /api proxy)
//   - runs refresh_all.sh with APD_HOME pointing at the vendored copy and Trino / Redash credentials
//     taken from the project .env (APD_TRINO_* / APD_REDASH_* exported only to the child process)
//   - schedules it: every 30 min from 10:15 IST; refresh_all.sh itself runs once per day (log gate)
//
// Routes: GET /api/apd/state, POST /api/apd/run {force}, POST /api/apd/stop, GET|POST /api/apd/config {enabled}
// On / off (11 Nov 2026): data/apd-config.json { enabled }. Off — or the APD folder missing / renamed — means no
// scheduled or manual refresh, no Today freshness line and no sidebar entry. Product Wise does not depend on it.
// Env: APD_DIR (default ../third_party/apd_installer/home), APD_PYTHON (default /usr/bin/python3),
//      APD_SCHEDULE=false to turn the backend refresh off,
//      APD_TRINO_USER / APD_TRINO_PASSWORD (default TRINO_BACKUP_* then TRINO_SERVICE_*),
//      APD_REDASH_URL / APD_REDASH_API_KEY (default PTYES_REDASH_* = tpapredash).
import express from "express";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APD_DIR = path.resolve(process.env.APD_DIR || path.join(__dirname, "..", "third_party", "apd_installer", "home"));
const SITE = path.join(APD_DIR, "upi_spike_dashboard");
const AP = path.join(SITE, "automatic_payments");
const LOG = path.join(AP, "logs", "refresh_all.log");
const PY = process.env.APD_PYTHON || "/usr/bin/python3";
const TICK_MS = 30 * 60 * 1000;
const SCHEDULE_FROM = "10:15"; // IST; D-1 is complete in the Trino snapshot by 10:00

// Each board's "data through" = newest YYYY-MM-DD in its cache folder (or file time for single files).
const BOARDS = [
  { id: "mandate", label: "Mandate", dir: "upi_spike_dashboard/automatic_payments/cache/mandate" },
  { id: "cc", label: "CC Autopay", dir: "upi_spike_dashboard/automatic_payments/cache/cc_mandate" },
  { id: "cccasa", label: "CC vs CASA", dir: "trino/cc_casa_codes/cache" },
  { id: "interop", label: "Interop", dir: "upi_spike_dashboard/automatic_payments/interop/cache/days" },
  { id: "iccw", label: "ICCW", dir: "upi_spike_dashboard/automatic_payments/iccw/cache" },
  { id: "upiglobal", label: "UPI Global", file: "upi_spike_dashboard/automatic_payments/upi_global/data/global.json" },
  { id: "codewatch", label: "Code watch", file: "upi_spike_dashboard/automatic_payments/code_watch/data/code_watch.csv" },
];

const istParts = (d = new Date()) => {
  const s = new Date(d.getTime() + 5.5 * 3600e3).toISOString();
  return { date: s.slice(0, 10), hm: s.slice(11, 16) };
};

function trinoHost() {
  const raw = process.env.APD_TRINO_HOST || process.env.TRINO_API_URL || "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return "";
  }
}

function childEnv() {
  const e = process.env;
  return {
    ...e,
    APD_HOME: APD_DIR,
    APD_PYTHON: PY,
    APD_TRINO_HOST: trinoHost(),
    APD_TRINO_PORT: e.APD_TRINO_PORT || "443",
    APD_TRINO_USER: e.APD_TRINO_USER || e.TRINO_BACKUP_USER || e.TRINO_SERVICE_USER || "",
    APD_TRINO_PASSWORD: e.APD_TRINO_PASSWORD || (e.APD_TRINO_USER ? "" : e.TRINO_BACKUP_USER ? e.TRINO_BACKUP_PASSWORD : e.TRINO_SERVICE_PASSWORD) || "",
    APD_TRINO_CATALOG: "hive",
    APD_REDASH_URL: (e.APD_REDASH_URL || e.PTYES_REDASH_URL || "").replace(/\/+$/, ""),
    APD_REDASH_API_KEY: e.APD_REDASH_API_KEY || e.PTYES_REDASH_API_KEY || "",
    PYTHONWARNINGS: "ignore",
  };
}

function newestDay(dir) {
  try {
    const days = fs.readdirSync(dir).map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.csv$/)?.[1]).filter(Boolean).sort();
    return days[days.length - 1] || null;
  } catch {
    return null;
  }
}

function boardFreshness() {
  return BOARDS.map((b) => {
    if (b.dir) return { id: b.id, label: b.label, through: newestDay(path.join(APD_DIR, b.dir)) };
    try {
      return { id: b.id, label: b.label, updatedAt: fs.statSync(path.join(APD_DIR, b.file)).mtime.toISOString() };
    } catch {
      return { id: b.id, label: b.label, updatedAt: null };
    }
  });
}

/** Last run block of refresh_all.log: "=== <date time> start", "--- HH:MM:SS step", "    ok" / "    step FAILED", "=== ... done|FAILED". */
function lastRun() {
  let text = "";
  try {
    const st = fs.statSync(LOG);
    const fd = fs.openSync(LOG, "r");
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (/^=== .* start$/.test(lines[k])) { i = k; break; }
  if (i < 0) return null;
  const run = { startedAt: lines[i].slice(4, 23), endedAt: null, status: "running", steps: [] };
  for (const l of lines.slice(i + 1)) {
    let m;
    if ((m = l.match(/^--- (\d\d:\d\d:\d\d) (\S+)/))) run.steps.push({ name: m[2], at: m[1], status: "running" });
    else if (/^\s+ok$/.test(l) && run.steps.length) run.steps[run.steps.length - 1].status = "ok";
    else if (/FAILED \(see/.test(l) && run.steps.length) run.steps[run.steps.length - 1].status = "failed";
    else if ((m = l.match(/^=== (\S+ \S+) (done|FAILED)$/))) {
      run.endedAt = m[1];
      run.status = m[2] === "done" ? "done" : "failed";
    }
  }
  return run;
}

let pythonCheck = null;
function pythonReady() {
  if (pythonCheck && Date.now() - pythonCheck.at < 10 * 60e3) return pythonCheck;
  const r = spawnSync(PY, ["-c", "import trino, pandas, openpyxl"], { encoding: "utf8", timeout: 20000 });
  pythonCheck = { at: Date.now(), ok: r.status === 0, error: r.status === 0 ? null : (r.stderr || r.error?.message || "").trim().split("\n").pop() };
  return pythonCheck;
}

/** PIDs of refresh_all.sh runs (also ones started before a backend restart: they are detached and keep going). */
function refreshPids() {
  const r = spawnSync("/usr/bin/pgrep", ["-f", path.join(AP, "refresh_all.sh")], { encoding: "utf8" });
  return (r.stdout || "").split("\n").map(Number).filter(Boolean);
}

const CONFIG_FILE = path.join(__dirname, "data", "apd-config.json");
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
const isInstalled = () => fs.existsSync(path.join(AP, "index.html"));
/** { enabled, installed, active }: active = turned on AND the APD folder is there. */
export function apdStatus() {
  const cfg = readConfig();
  const enabled = cfg.enabled !== false;
  const installed = isInstalled();
  return { enabled, installed, active: enabled && installed, changedAt: cfg.changedAt || null, apdDir: APD_DIR };
}

export function registerApd(app) {
  let child = null; // { proc, startedAt, force, trigger }
  let lastExit = null;

  app.get("/api/apd/config", (_req, res) => res.json({ ok: true, ...apdStatus() }));
  app.post("/api/apd/config", express.json(), (req, res) => {
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ ok: false, error: "give { enabled: true | false }" });
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ enabled: req.body.enabled, changedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
    console.log(`[apd] Automatic Payments Dashboard turned ${req.body.enabled ? "on" : "off"}`);
    res.json({ ok: true, ...apdStatus() });
  });

  app.use(
    "/api/apd/page",
    express.static(SITE, { dotfiles: "deny", etag: true, maxAge: 0, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") })
  );

  function start({ force = false, trigger = "manual" } = {}) {
    const st = apdStatus();
    if (!st.enabled) return { started: false, reason: "Automatic Payments Dashboard is turned off" };
    if (!st.installed) return { started: false, reason: `APD files not found under ${APD_DIR}` };
    if (child || refreshPids().length) return { started: false, reason: "already running" };
    if (!fs.existsSync(path.join(AP, "refresh_all.sh"))) return { started: false, reason: `refresh_all.sh not found under ${AP}` };
    const env = childEnv();
    if (!env.APD_TRINO_USER || !env.APD_TRINO_PASSWORD || !env.APD_TRINO_HOST) return { started: false, reason: "Trino credentials missing (TRINO_API_URL + TRINO_BACKUP_* / TRINO_SERVICE_* or APD_TRINO_*)" };
    const args = [path.join(AP, "refresh_all.sh")];
    if (force) args.push("--force");
    const proc = spawn("/bin/zsh", args, { cwd: AP, env, detached: true, stdio: "ignore" });
    child = { proc, startedAt: new Date().toISOString(), force, trigger };
    proc.on("exit", (code, signal) => {
      lastExit = { code, signal, at: new Date().toISOString(), trigger, force };
      child = null;
    });
    proc.on("error", (err) => {
      lastExit = { code: -1, error: err.message, at: new Date().toISOString(), trigger, force };
      child = null;
    });
    return { started: true };
  }

  app.get("/api/apd/state", (_req, res) => {
    const env = childEnv();
    const py = pythonReady();
    const run = lastRun();
    const orphan = !child && run?.status === "running" && fs.existsSync(path.join(AP, ".lock")) && refreshPids().length > 0;
    res.json({
      ok: true,
      ...apdStatus(),
      apdDir: APD_DIR,
      pageUrl: "/api/apd/page/automatic_payments/",
      python: { path: PY, ok: py.ok, error: py.error },
      credentials: { trino: Boolean(env.APD_TRINO_USER && env.APD_TRINO_PASSWORD && env.APD_TRINO_HOST), trinoUser: env.APD_TRINO_USER, redash: Boolean(env.APD_REDASH_API_KEY) },
      schedule: { enabled: process.env.APD_SCHEDULE !== "false", from: `${SCHEDULE_FROM} IST`, everyMin: TICK_MS / 60e3, oncePerDay: true },
      running: child
        ? { startedAt: child.startedAt, force: child.force, trigger: child.trigger }
        : orphan
          ? { startedAt: new Date(`${run.startedAt.replace(" ", "T")}+05:30`).toISOString(), force: null, trigger: "earlier backend process" }
          : null,
      lastExit,
      lastRun: run,
      boards: boardFreshness(),
    });
  });

  app.post("/api/apd/run", express.json(), (req, res) => {
    const r = start({ force: req.body?.force !== false, trigger: "manual" });
    res.status(r.started ? 200 : 409).json({ ok: r.started, ...r });
  });

  app.post("/api/apd/stop", (_req, res) => {
    // refresh_all.sh is started detached, so its pid is also its process-group id: SIGTERM the group (zsh + python children).
    const pids = child ? [child.proc.pid] : refreshPids();
    let stopped = 0;
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGTERM");
        stopped++;
      } catch {
        try {
          process.kill(pid, "SIGTERM");
          stopped++;
        } catch {
          /* already gone */
        }
      }
    }
    res.json({ ok: true, stopped: stopped > 0 });
  });

  if (process.env.APD_SCHEDULE !== "false") {
    // refresh_all.sh marks the day "done" when the main Mandate step passes, even if other boards failed
    // (e.g. Trino 503). Re-run with --force up to RETRY_MAX times a day, RETRY_AFTER_MIN after the last run ended.
    const RETRY_MAX = 2;
    const RETRY_AFTER_MIN = 90;
    const retries = {};
    const tick = () => {
      if (!apdStatus().active) return; // turned off, or the APD folder is missing
      const now = istParts();
      if (now.hm < SCHEDULE_FROM) return;
      const run = lastRun();
      if (run?.endedAt?.startsWith(now.date) && run.steps.some((s) => s.status === "failed") && (retries[now.date] || 0) < RETRY_MAX) {
        const endedMs = new Date(`${run.endedAt.replace(" ", "T")}+05:30`).getTime();
        if (Date.now() - endedMs >= RETRY_AFTER_MIN * 60e3) {
          const r = start({ force: true, trigger: "retry" });
          if (r.started) retries[now.date] = (retries[now.date] || 0) + 1;
        }
        return;
      }
      const r = start({ force: false, trigger: "schedule" }); // refresh_all.sh exits at once if today's run is done
      if (!r.started && r.reason !== "already running" && apdStatus().active) console.warn(`[apd] scheduled refresh skipped: ${r.reason}`);
    };
    setTimeout(tick, 60e3).unref?.();
    setInterval(tick, TICK_MS).unref?.();
  }

  return {
    start,
    summary: () => {
      const st = apdStatus();
      if (!st.active) return { ...st }; // nothing to report: Today hides the APD line
      return { ...st, lastRun: lastRun(), running: Boolean(child) || refreshPids().length > 0, boards: boardFreshness() };
    },
  };
}
