// Success Rate Snippet — P2M day-level SR / error snapshot for Paytm TPAP payer handles
// (ptyes, ptaxis, ptsbi, pthdfc). Mirrors Superset dashboard 575 on cdp-dataview.
//
// All four sections read the day-level Looker table on Trino, grouped by
// (dt, payer_handle, dimension) and returning raw integer counts. Every metric
// (Yesterday / Day Before / L7D / MTD / LMTD / deltas / contribution) is computed
// client-side, so one cached result serves every handle filter.
//
// Routes (all under /api/srsnippet):
//   GET  /state                 cached result + job state + schedule
//   POST /run                   run all sections now (no-op if already running)
//   GET  /sql?section=          rendered SQL for the current window

import fs from "fs";
import path from "path";
import { runTrino } from "./morningDashboard.js";
import { analyze } from "./historyInsights.js";

// History tab labels per section.
const SNIPPET_TITLES = { psp: "P2M Payee PSP SR", errors: "P2M Error codes", instrument: "P2M Instrument SR" };

export const SNIPPET_SECTIONS = ["psp", "errors", "instrument"];

const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
const TZ_OFFSET_MIN = 330;
const TIMEOUT_MS = 20 * 60 * 1000;
// Backend refresh: once a day after this IST time (Looker day table is complete by then),
// and again at the later slot in case the first run hit a lagging table.
const SCHEDULE_AT = ["09:00", "12:00"];

// Payee PSP grouping (per dashboard spec).
const PAYEE_PSP_CASE = `CASE
    WHEN lower(payee_handle) IN ('ybl', 'axl', 'ibl') THEN 'PhonePe'
    WHEN lower(payee_handle) IN ('okbizaxis', 'okbizicici', 'okpayaxis') THEN 'Google Pay'
    WHEN lower(payee_handle) IN ('pty', 'ptybl', 'ptys', 'paytm') THEN 'Paytm'
    ELSE 'Others'
  END`;

const BASE_WHERE = `FROM team_product.LOOKER_TPAP_Txns_V3
WHERE dt >= DATE '{{FROM_DATE}}'
  AND dt <  DATE '{{TO_DATE}}'
  AND p2p_p2m_flag = 'P2M'
  AND lower(payer_handle) IN ({{HANDLES}})`;

export const SNIPPET_SQL = {
  psp: `SELECT
  CAST(dt AS varchar)  AS ts,
  lower(payer_handle)  AS handle,
  ${PAYEE_PSP_CASE} AS dim,
  SUM(txn_init)        AS total,
  SUM(success)         AS success
${BASE_WHERE}
GROUP BY 1, 2, 3`,
  // Failures per code = non-successful txn_init. Rows that are fully successful contribute 0.
  errors: `SELECT
  CAST(dt AS varchar)  AS ts,
  lower(payer_handle)  AS handle,
  COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS dim,
  SUM(txn_init)        AS total,
  SUM(success)         AS success
${BASE_WHERE}
GROUP BY 1, 2, 3`,
  instrument: `SELECT
  CAST(dt AS varchar)                  AS ts,
  lower(payer_handle)                  AS handle,
  COALESCE(payer_instrument, 'Others') AS dim,
  SUM(txn_init)                        AS total,
  SUM(success)                         AS success
${BASE_WHERE}
GROUP BY 1, 2, 3`,
};

// ─── Window ──────────────────────────────────────────────────────────────────
// From the earlier of (1st of last month, today - 9 days) up to today (exclusive):
// covers LMTD, MTD, yesterday, day before and the 7 days before yesterday.

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

export function snippetWindow(nowMs = Date.now()) {
  const wall = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  const today = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const yday = new Date(today - 86400000);
  const lastMonthStart = Date.UTC(yday.getUTCFullYear(), yday.getUTCMonth() - 1, 1);
  const from = Math.min(lastMonthStart, today - 10 * 86400000);
  return { fromDate: ymd(new Date(from)), toDate: ymd(new Date(today)) };
}

function renderSql(section, win) {
  return SNIPPET_SQL[section]
    .replaceAll("{{FROM_DATE}}", win.fromDate)
    .replaceAll("{{TO_DATE}}", win.toDate)
    .replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", "));
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

// ─── Persistence ─────────────────────────────────────────────────────────────

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** history: optional store from historyStore.js — every section run is also written there. */
export function registerSrSnippet(app, { dataDir, history = null }) {
  const cacheFile = path.join(dataDir, "srsnippet-cache.json");
  // cache: { [section]: { rows, window, finishedAt, durationMs } }
  const cache = readJsonFile(cacheFile, {});
  // jobs: { [section]: { status: idle|running|done|error, error?, startedAt?, finishedAt? } }
  const jobs = Object.fromEntries(SNIPPET_SECTIONS.map((s) => [s, { status: cache[s] ? "done" : "idle" }]));
  let running = null;
  let lastScheduledSlot = null;

  async function runSection(section, win, trigger = "manual") {
    const sql = renderSql(section, win);
    const startedAt = Date.now();
    jobs[section] = { status: "running", startedAt };
    const histId = history?.start(
      {
        dashboard: "srsnippet",
        section,
        sectionTitle: SNIPPET_TITLES[section],
        subject: `${SNIPPET_TITLES[section]} — D-1 / L7D / MTD${trigger === "scheduled" ? " (auto)" : ""}`,
        taskName: `Success Rate Snippet · ${SNIPPET_TITLES[section]} (${win.fromDate} → ${win.toDate}, exclusive)`,
        trigger: trigger === "scheduled" ? "schedule" : "manual",
        durationLabel: `${win.fromDate} → ${win.toDate}`,
        engine: "looker",
        window: { from: win.fromDate, to: win.toDate },
        sql,
        rerun: { section },
      },
      "running"
    );
    try {
      const raw = await runTrino(sql, { timeoutMs: TIMEOUT_MS });
      const rows = raw.map((r) => ({
        ts: String(r.ts).slice(0, 10),
        handle: r.handle,
        dim: r.dim,
        total: num(r.total),
        success: num(r.success),
      }));
      const finishedAt = Date.now();
      cache[section] = { rows, window: win, finishedAt, durationMs: finishedAt - startedAt };
      writeJsonFile(cacheFile, cache);
      jobs[section] = { status: "done", startedAt, finishedAt };
      history?.update(histId, { event: "success", elapsedMs: finishedAt - startedAt, rowCount: rows.length, analysis: analyze("srsnippet", section, rows) });
    } catch (err) {
      jobs[section] = { status: "error", error: err.message, startedAt, finishedAt: Date.now() };
      history?.update(histId, { event: "failed", error: err.message, elapsedMs: Date.now() - startedAt });
    }
  }

  function runAll(trigger = "manual") {
    if (running) return running;
    const win = snippetWindow();
    console.log(`[srsnippet] ${trigger} run ${win.fromDate} → ${win.toDate}`);
    running = Promise.all(SNIPPET_SECTIONS.map((s) => runSection(s, win, trigger))).finally(() => {
      running = null;
    });
    return running;
  }

  // Scheduler: fire at each SCHEDULE_AT slot (IST) once per day.
  setInterval(() => {
    const wall = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
    const hm = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
    const due = SCHEDULE_AT.filter((t) => t <= hm).pop();
    if (!due) return;
    const slot = `${ymd(wall)} ${due}`;
    if (slot === lastScheduledSlot) return;
    lastScheduledSlot = slot;
    // Skip if everything already ran after this slot (e.g. after a backend restart).
    const slotMs = Date.parse(`${slot.replace(" ", "T")}:00Z`) - TZ_OFFSET_MIN * 60000;
    if (SNIPPET_SECTIONS.every((s) => cache[s]?.finishedAt >= slotMs)) return;
    void runAll("scheduled");
  }, 60000).unref?.();

  const handle = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

  app.get(
    "/api/srsnippet/state",
    handle(() => ({
      handles: HANDLES,
      sections: SNIPPET_SECTIONS,
      schedule: SCHEDULE_AT,
      running: Boolean(running),
      jobs,
      cache,
      window: snippetWindow(),
    })),
  );

  app.post(
    "/api/srsnippet/run",
    handle(() => {
      void runAll("manual");
      return { started: true };
    }),
  );

  app.get(
    "/api/srsnippet/sql",
    handle((req) => {
      const section = String(req.query.section || "");
      if (!SNIPPET_SQL[section]) throw new Error(`Unknown section ${section}`);
      return { section, sql: renderSql(section, snippetWindow()) };
    }),
  );

  // Used by the History tab's Re-run (the snippet always refreshes all three sections).
  return {
    rerun() {
      if (running) return { started: "Already running — results will update shortly" };
      void runAll("manual");
      return { started: "Success Rate Snippet (all sections)" };
    },
  };
}
