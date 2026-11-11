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
import { runTrino } from "./trinoClient.js";
import { analyze } from "./historyInsights.js";

// History tab labels per section.
const SNIPPET_TITLES = { breakdown: "P2M SR Breakdown", psp: "P2M Payee PSP SR", errors: "P2M Error codes", instrument: "P2M Instrument SR" };

export const SNIPPET_SECTIONS = ["breakdown", "psp", "errors", "instrument"];

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

// Breakdown (triage table): day totals per (handle, kind, dim) over the last
// BREAKDOWN_DAYS days, plus per-failure-code rows over the same days (top decline
// codes for the latest day, per-code trend lines). code = '' marks a total row.
const BREAKDOWN_DAYS = 10;
const CODE_DAYS = BREAKDOWN_DAYS;
const BREAKDOWN_KINDS = [
  ["psp", PAYEE_PSP_CASE],
  ["bank", "COALESCE(NULLIF(trim(payer_bank), ''), 'Others')"],
  ["instrument", "COALESCE(payer_instrument, 'Others')"],
];
const BREAKDOWN_SQL = `WITH b AS (
  SELECT
    dt,
    lower(payer_handle) AS handle,
${BREAKDOWN_KINDS.map(([k, expr]) => `    ${expr} AS ${k}`).join(",\n")},
    COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
    txn_init,
    success
  FROM team_product.LOOKER_TPAP_Txns_V3
  WHERE dt >= DATE '{{BD_FROM}}'
    AND dt <  DATE '{{TO_DATE}}'
    AND p2p_p2m_flag = 'P2M'
    AND lower(payer_handle) IN ({{HANDLES}})
)
${BREAKDOWN_KINDS.map(
  ([k]) => `SELECT CAST(dt AS varchar) AS ts, handle, '${k}' AS kind, ${k} AS dim, '' AS code, SUM(txn_init) AS total, SUM(success) AS success
FROM b GROUP BY dt, handle, ${k}
UNION ALL
SELECT CAST(dt AS varchar) AS ts, handle, '${k}' AS kind, ${k} AS dim, code, SUM(txn_init) AS total, SUM(success) AS success
FROM b WHERE dt >= DATE '{{CODE_FROM}}' GROUP BY dt, handle, ${k}, code
HAVING SUM(txn_init) > SUM(success)`,
).join("\nUNION ALL\n")}`;

export const SNIPPET_SQL = {
  breakdown: BREAKDOWN_SQL,
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

const minusDays = (day, n) => ymd(new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000));

function renderSql(section, win) {
  return SNIPPET_SQL[section]
    .replaceAll("{{BD_FROM}}", minusDays(win.toDate, BREAKDOWN_DAYS))
    .replaceAll("{{CODE_FROM}}", minusDays(win.toDate, CODE_DAYS))
    .replaceAll("{{FROM_DATE}}", win.fromDate)
    .replaceAll("{{TO_DATE}}", win.toDate)
    .replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", "));
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

// Breakdown: keep total rows, and only the top CODES_KEPT failure codes per
// (day, handle, kind, dim) — the long tail is noise and bloats the cache.
const CODES_KEPT = 5;
const CODES_GLOBAL = 20;
function trimBreakdown(rows) {
  // Codes that matter anywhere in a kind (top CODES_GLOBAL by failures over the window)
  // are kept for every dim and day, so per-code trend lines are complete, not just
  // the days where the code happened to be in that row's top CODES_KEPT.
  const byKind = new Map();
  for (const r of rows) {
    if (!r.code) continue;
    const m = byKind.get(r.kind) || new Map();
    m.set(r.code, (m.get(r.code) || 0) + r.total - r.success);
    byKind.set(r.kind, m);
  }
  const major = new Map(
    [...byKind].map(([kind, m]) => [kind, new Set([...m].sort((a, b) => b[1] - a[1]).slice(0, CODES_GLOBAL).map(([c]) => c))]),
  );
  const groups = new Map();
  const out = [];
  for (const r of rows) {
    if (!r.code) {
      out.push(r);
      continue;
    }
    const k = `${r.ts}|${r.handle}|${r.kind}|${r.dim}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => b.total - b.success - (a.total - a.success));
    out.push(...g.filter((r, i) => i < CODES_KEPT || major.get(r.kind)?.has(r.code)));
  }
  return out;
}

// ─── From the Unified SR cache (Phase A: no Snippet query of its own) ────────
// Every Snippet section is a P2M slice of data Unified SR already pulls from the same Looker table with the
// same filters (txn_init / success, app_resp_code with '(blank)', handles ptyes / ptaxis / ptsbi / pthdfc):
//   breakdown  ← Unified breakdown views "<handle>|P2M" (10 days, kinds psp / bank / instrument, + code rows)
//   psp        ← Unified dims rows kind psp, flow P2M (90 days), payee handle grouped as PAYEE_PSP_CASE
//   instrument ← Unified dims rows kind instrument, flow P2M
//   errors     ← Unified codes views "<handle>|P2M" (since the 1st of last month; codes outside its top 60
//                arrive as "Other codes (long tail)")
const PAYEE_PSP_GROUP = (h) => {
  const x = String(h || "").toLowerCase();
  if (["ybl", "axl", "ibl"].includes(x)) return "PhonePe";
  if (["okbizaxis", "okbizicici", "okpayaxis"].includes(x)) return "Google Pay";
  if (["pty", "ptybl", "ptys", "paytm"].includes(x)) return "Paytm";
  return "Others";
};

/** unified: the object registerUnifiedDashboard returns. Returns a Snippet cache { [section]: { rows, window, finishedAt, durationMs, source } } or null. */
export function snippetFromUnified(unified, nowMs = Date.now()) {
  const bd = unified.section("breakdown");
  const dims = unified.section("dims");
  const codes = unified.section("codes");
  if (!bd?.views || !dims?.rows || !codes?.views) return null;
  const win = snippetWindow(nowMs);
  const inWin = (ts) => ts >= win.fromDate && ts < win.toDate;
  const sum = (rows, keyOf, make) => {
    const m = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (key == null) continue;
      const o = m.get(key) || make(r);
      o.total += num(r.total);
      o.success += num(r.success);
      m.set(key, o);
    }
    return [...m.values()];
  };
  // Per-code rows come from Unified's untrimmed per-code store (the views are trimmed per raw payee handle, which
  // under-counts a code once handles are grouped into PhonePe / Google Pay / Paytm / Others); totals from the views.
  const bdc = unified.breakdownCodes();
  if (!bdc) return null;
  const KINDS = ["psp", "bank", "instrument"];
  const dimOf = (r) => (r.kind === "psp" ? PAYEE_PSP_GROUP(r.dim) : r.dim);
  const codeRows = bdc.rows
    .filter((t) => t[2] === "P2M" && HANDLES.includes(t[1]) && KINDS.includes(t[3]) && inWin(t[0]))
    .map((t) => ({ ts: t[0], handle: t[1], kind: t[3], dim: t[4], code: t[5], total: t[6], success: t[7] }));
  const breakdown = [];
  const errors = [];
  for (const h of HANDLES) {
    const v = [...(bd.views[`${h}|P2M`] || []).filter((r) => KINDS.includes(r.kind) && !r.code && inWin(r.ts)), ...codeRows.filter((r) => r.handle === h)];
    breakdown.push(...sum(v, (r) => `${r.ts}|${r.kind}|${dimOf(r)}|${r.code || ""}`, (r) => ({ ts: r.ts, handle: h, kind: r.kind, dim: dimOf(r), code: r.code || "", total: 0, success: 0 })));
    errors.push(...sum((codes.views[`${h}|P2M`] || []).filter((r) => inWin(r.ts)), (r) => `${r.ts}|${r.code}`, (r) => ({ ts: r.ts, handle: h, dim: r.code, total: 0, success: 0 })));
  }
  const dimsOf = (kind, dimOf) =>
    sum(
      dims.rows.filter((r) => r.kind === kind && r.flow === "P2M" && HANDLES.includes(r.handle) && inWin(r.ts)),
      (r) => `${r.ts}|${r.handle}|${dimOf(r.dim)}`,
      (r) => ({ ts: r.ts, handle: r.handle, dim: dimOf(r.dim), total: 0, success: 0 }),
    );
  const meta = (src) => ({ window: win, finishedAt: src.ranAt || null, durationMs: 0, source: "unified" });
  return {
    breakdown: { rows: trimBreakdown(breakdown.filter((r) => !r.code || r.total > r.success)), ...meta(bd) },
    psp: { rows: dimsOf("psp", PAYEE_PSP_GROUP), ...meta(dims) },
    errors: { rows: errors.filter((r) => r.total > r.success), ...meta(codes) },
    instrument: { rows: dimsOf("instrument", (d) => d || "Others"), ...meta(dims) },
  };
}

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
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`; // unique: two backend processes must not share one temp file
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** history: optional store from historyStore.js — every section run is also written there. */
// unified: () => the object registerUnifiedDashboard returns. Phase A (11 Nov 2026): by default the Snippet runs
// no query of its own — /state is built from the Unified SR cache (snippetFromUnified; parity checked against the
// old Snippet query: psp / instrument / breakdown identical, top-15 error tables identical) and Refresh re-runs
// the Unified sections it reads. SRSNIPPET_OWN_QUERY=true brings back the old Trino query + 09:00 / 12:00 schedule.
// The old srsnippet-cache.json is left on disk untouched.
const UNIFIED_SOURCES = { breakdown: "breakdown", psp: "dims", instrument: "dims", errors: "codes" };
export function registerSrSnippet(app, { dataDir, history = null, unified = null }) {
  const ownQuery = String(process.env.SRSNIPPET_OWN_QUERY || "").toLowerCase() === "true" || !unified;
  let built = null; // { key, cache } — rebuilt only when a Unified section it reads has a new run
  const fromUnified = () => {
    const u = unified();
    const key = ["breakdown", "dims", "codes"].map((s) => u.section(s)?.ranAt || 0).join("|") + `|${u.breakdownCodes()?.ranAt || 0}|${snippetWindow().toDate}`;
    if (built?.key !== key) built = { key, cache: snippetFromUnified(u) };
    const health = Object.fromEntries((u.health() || []).map((h) => [h.section, h]));
    const jobsU = Object.fromEntries(
      SNIPPET_SECTIONS.map((s) => {
        const h = health[UNIFIED_SOURCES[s]] || {};
        const st = h.status === "running" || h.status === "queued" ? "running" : h.status === "failed" ? "error" : built.cache?.[s] ? "done" : "idle";
        return [s, { status: st, ...(h.error ? { error: h.error } : {}), ...(h.ranAt ? { finishedAt: h.ranAt } : {}) }];
      }),
    );
    return { cache: built.cache || {}, jobs: jobsU };
  };
  const rerunUnified = () => {
    const u = unified();
    return [...new Set(Object.values(UNIFIED_SOURCES))].map((section) => {
      try {
        return u.rerun({ section }).started;
      } catch (e) {
        return `${section}: ${e.message}`;
      }
    });
  };
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
      const mapped = raw.map((r) => ({
        ts: String(r.ts).slice(0, 10),
        handle: r.handle,
        ...(r.kind != null && { kind: r.kind, code: r.code || "" }),
        dim: r.dim,
        total: num(r.total),
        success: num(r.success),
      }));
      const rows = section === "breakdown" ? trimBreakdown(mapped) : mapped;
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
    if (!ownQuery) return; // data comes from Unified SR, which has its own schedule
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
    handle(() => {
      if (!ownQuery) {
        const u = fromUnified();
        return { handles: HANDLES, sections: SNIPPET_SECTIONS, schedule: ["Unified SR schedule"], source: "unified", running: Object.values(u.jobs).some((j) => j.status === "running"), jobs: u.jobs, cache: u.cache, window: snippetWindow() };
      }
      return { handles: HANDLES, sections: SNIPPET_SECTIONS, schedule: SCHEDULE_AT, source: "own", running: Boolean(running), jobs, cache, window: snippetWindow() };
    }),
  );

  app.post(
    "/api/srsnippet/run",
    handle(() => {
      if (!ownQuery) return { started: true, unified: rerunUnified() };
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

  // Used by the History tab's Re-run (the snippet always refreshes all sections).
  return {
    rerun() {
      if (!ownQuery) return { started: `Unified SR sections behind SR Snippet: ${rerunUnified().join("; ")}` };
      if (running) return { started: "Already running — results will update shortly" };
      void runAll("manual");
      return { started: "Success Rate Snippet (all sections)" };
    },
  };
}
