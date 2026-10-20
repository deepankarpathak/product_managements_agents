// Unified SR Dashboard — drill-down and sample transactions (on demand, /api/udash/drill/*).
//
// Two engines, because no single table carries every filter:
//   looker  team_product.LOOKER_TPAP_Txns_V3 (day level, 10 complete days) — impact-ranked
//           breakdown rows, same shape as the dashboard's section A, for any filter slice.
//           Has: payer handle, payee handle, category, OS, payer bank, flow, instrument, QR type, code.
//   raw     switch.txn_info_snapshot_v3 ⨝ txn_participants_snapshot_v3 (PAYER + PAYEE) on Trino.
//           Adds payee bank; SR by one dimension + top codes, and the
//           sample-transaction download. DWH participants lag ~12h, so recent hours come back thin.
//
// Queries can sit in the shared Trino queue for minutes, so every request is a job:
//   GET  /meta              fields, engines, windows
//   GET  /options           distinct filter values (cached; ?refresh=1 re-runs)
//   POST /run    {engine, filters, window, groupBy?}   → { jobId }
//   POST /sample {filters, window, failuresOnly, limit} → { jobId }
//   POST /duration {slice, day}                        → { jobId } | { cached, rows } 15-min SR, slice vs all
//   GET  /job/:id           { status, rows?, error?, sql }
//
// filters: { [fieldId]: { values: [..], exclude?: bool } }. Values are checked against a
// strict character set and quoted; field SQL comes only from FIELDS below.

import fs from "fs";
import path from "path";
import { runTrino } from "./trinoClient.js";
import { BD_DIMS, PSP_KEY, trimBreakdown } from "./unifiedDashboard.js";

const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
const TZ_MIN = 330;
const DAY = 86400000;

const IFSC4 = (alias) => `UPPER(SUBSTR(COALESCE(NULLIF(${alias}.bank_code, ''), ${alias}.detail_2, 'UNKN'), 1, 4))`;
const RAW_FLOW = "CASE WHEN t.category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END";
const RAW_CODE = "CASE WHEN t.status = 'SUCCESS' THEN '' ELSE COALESCE(NULLIF(trim(t.app_resp_code), ''), t.status) END";

// looker / raw: SQL expression per engine (absent = not filterable there).
export const FIELDS = [
  { id: "payer_psp", label: "Payer PSP (handle)", looker: "lower(payer_handle)", raw: "t.psp_handle" },
  { id: "payee_handle", label: "Payee PSP (handle)", looker: "lower(payee_handle)", raw: "lower(pe.handle)" },
  // Looker category = sub-flow (VPA2VPA, Paytm QR, 3P QR, Intent, ONUS, …); raw = txn category
  // (VPA2VPA / VPA2ACCOUNT / VPA2MERCHANT). initiation_mode is not offered: NULL on every raw txn.
  { id: "category", label: "Sub-flow / category", looker: "category", raw: "t.category" },
  { id: "os", label: "Operating system", looker: "os_type" },
  { id: "payer_bank", label: "Payer bank (IFSC)", looker: "COALESCE(NULLIF(trim(payer_bank), ''), 'Others')", raw: IFSC4("pr") },
  { id: "payee_bank", label: "Payee bank (IFSC)", raw: IFSC4("pe") },
  { id: "flow", label: "Flow", looker: "p2p_p2m_flag", raw: RAW_FLOW },
  { id: "instrument", label: "Payer instrument", looker: "COALESCE(payer_instrument, 'Others')" },
  { id: "qr_type", label: "QR type", looker: "qr_type" },
  { id: "code", label: "Response code", looker: "COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)')", raw: RAW_CODE },
  { id: "status", label: "Status", raw: "t.status" },
];
// rawT: the same expression inside the txn_info scan (no "t." alias), for txn-only fields.
for (const f of FIELDS) if (f.raw && !/\bp[re]\./.test(f.raw)) f.rawT = f.raw.replace(/\bt\./g, "");
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.id, f]));
// Raw "group by" choices for the SR table.
const RAW_GROUPS = ["payer_bank", "payee_bank", "payee_handle", "category", "payer_psp", "flow"];

export const WINDOWS = {
  looker: { "10d": { days: 10, label: "Last 10 complete days" } },
  raw: {
    yday: { days: 1, label: "Yesterday (complete day)" },
    "2d": { days: 2, label: "Last 2 complete days" },
    "3d": { days: 3, label: "Last 3 complete days" },
    "24h": { hours: 24, label: "Last 24 hours (participants lag ~12h)" },
  },
};

const SAFE = /^[A-Za-z0-9 _.\-()&/:+#@]{1,80}$/;
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

function whereFor(engine, filters = {}) {
  const parts = [];
  for (const [id, spec] of Object.entries(filters)) {
    const f = FIELD[id];
    const vals = (spec?.values || []).map(String).filter((v) => v !== "");
    if (!vals.length) continue;
    if (!f) throw new Error(`Unknown filter ${id}`);
    if (!f[engine]) throw new Error(`${f.label} is not available on the ${engine === "looker" ? "day-level" : "raw-txn"} engine`);
    if (vals.length > 200) throw new Error(`Too many values for ${f.label}`);
    for (const v of vals) if (!SAFE.test(v)) throw new Error(`Invalid value for ${f.label}: ${v}`);
    parts.push(`${f[engine]} ${spec.exclude ? "NOT IN" : "IN"} (${vals.map(q).join(", ")})`);
  }
  return parts;
}

// ─── windows (IST wall clock, complete days end at today 00:00) ──────────────

const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:00`;
};

function windowFor(engine, key, nowMs = Date.now()) {
  const w = WINDOWS[engine]?.[key];
  if (!w) throw new Error(`Invalid window ${key} for ${engine}`);
  const wall = nowMs + TZ_MIN * 60000;
  const today = Math.floor(wall / DAY) * DAY;
  const toMs = w.hours ? Math.floor(wall / 3600000) * 3600000 : today;
  const fromMs = w.hours ? toMs - w.hours * 3600000 : toMs - w.days * DAY;
  return { key, from: fmt(fromMs), to: fmt(toMs), fromDate: fmt(fromMs).slice(0, 10), toDate: fmt(toMs + (w.hours ? DAY : 0)).slice(0, 10), padFrom: fmt(fromMs - 600000), padTo: fmt(toMs + 600000) };
}

/** Explicit day window for samples: [day 00:00, day+1 00:00). */
function dayWindow(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) throw new Error("day must be YYYY-MM-DD");
  const fromMs = Date.parse(`${day}T00:00:00Z`);
  return { key: day, from: fmt(fromMs), to: fmt(fromMs + DAY), fromDate: day, toDate: fmt(fromMs + DAY).slice(0, 10), padFrom: fmt(fromMs - 600000), padTo: fmt(fromMs + DAY + 600000) };
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

function lookerSql(filters, win) {
  const where = whereFor("looker", filters);
  const dims = { ...BD_DIMS, psp: PSP_KEY };
  // One scan: grouping sets per kind (totals + per-code failures); the flow kind's per-code
  // rows double as kind "code" (expanded by the caller), as in the dashboard's section A.
  return `WITH b AS (
  SELECT
    dt,
    ${dims.flow} AS flow,
    ${dims.psp} AS psp,
    ${dims.bank} AS bank,
    ${dims.instrument} AS instrument,
    COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
    description,
    txn_init,
    success
  FROM team_product.LOOKER_TPAP_Txns_V3
  WHERE dt >= DATE '${win.fromDate}'
    AND dt <  DATE '${win.toDate}'${where.map((w) => `\n    AND ${w}`).join("")}
)
SELECT
  CAST(dt AS varchar) AS ts,
  CASE WHEN grouping(psp) = 0 THEN 'psp' WHEN grouping(bank) = 0 THEN 'bank' WHEN grouping(instrument) = 0 THEN 'instrument' ELSE 'flow' END AS kind,
  CASE WHEN grouping(psp) = 0 THEN psp WHEN grouping(bank) = 0 THEN bank WHEN grouping(instrument) = 0 THEN instrument ELSE flow END AS dim,
  CASE WHEN grouping(code) = 0 THEN code ELSE '' END AS code,
  CASE WHEN grouping(psp, bank, instrument, code) = 14 THEN COALESCE(max(description), '') ELSE '' END AS descr,
  SUM(txn_init) AS total,
  SUM(success)  AS success
FROM b
GROUP BY GROUPING SETS (
  (dt, psp), (dt, psp, code), (dt, bank), (dt, bank, code),
  (dt, instrument), (dt, instrument, code), (dt, flow), (dt, flow, code)
)
HAVING grouping(code) = 1 OR SUM(txn_init) > SUM(success)`;
}

// Raw filters that touch only txn_info go inside the t scan (before the GROUP BY, so Trino
// prunes rows early); filters on participant columns stay on the joined result.
function splitRaw(filters) {
  const pick = (txnOnly) => Object.fromEntries(Object.entries(filters).filter(([id]) => Boolean(FIELD[id]?.rawT) === txnOnly));
  whereFor("raw", filters); // validates every filter against the raw engine
  return { inner: whereFor("rawT", pick(true)), outer: whereFor("raw", pick(false)) };
}

// Raw txns + one PAYER and one PAYEE participant row per txn (snapshots can repeat a txn).
function rawBase(win, inner = []) {
  return `WITH t AS (
  SELECT txn_id, arbitrary(created_on) AS created_on, arbitrary(status) AS status, arbitrary(amount) AS amount,
    arbitrary(rrn) AS rrn, arbitrary(app_resp_code) AS app_resp_code, arbitrary(npci_resp_code) AS npci_resp_code,
    arbitrary(category) AS category, arbitrary(initiation_mode) AS initiation_mode, arbitrary(psp_handle) AS psp_handle
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '${win.fromDate}'
    AND created_on >= TIMESTAMP '${win.from}'
    AND created_on <  TIMESTAMP '${win.to}'
    AND business_type IS NULL
    AND type IN ('PAY', 'COLLECT')
    AND category IN ('VPA2VPA', 'VPA2ACCOUNT', 'VPA2MERCHANT')
    AND psp_handle IN (${HANDLES.map(q).join(", ")})${inner.map((w) => `\n    AND ${w}`).join("")}
  GROUP BY txn_id
),
pr AS (
  SELECT txn_id, arbitrary(handle) AS handle, arbitrary(bank_code) AS bank_code, arbitrary(detail_2) AS detail_2
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '${win.fromDate}'
    AND created_on >= TIMESTAMP '${win.padFrom}'
    AND created_on <  TIMESTAMP '${win.padTo}'
    AND participant_type = 'PAYER'
  GROUP BY txn_id
),
pe AS (
  SELECT txn_id, arbitrary(handle) AS handle, arbitrary(bank_code) AS bank_code, arbitrary(detail_2) AS detail_2
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '${win.fromDate}'
    AND created_on >= TIMESTAMP '${win.padFrom}'
    AND created_on <  TIMESTAMP '${win.padTo}'
    AND participant_type = 'PAYEE'
  GROUP BY txn_id
)`;
}

const rawFrom = `FROM t
LEFT JOIN pr ON pr.txn_id = t.txn_id
LEFT JOIN pe ON pe.txn_id = t.txn_id`;

function rawAggSql(filters, win, groupBy) {
  if (!RAW_GROUPS.includes(groupBy)) throw new Error(`Cannot group by ${groupBy}`);
  const { inner, outer: where } = splitRaw(filters);
  return `${rawBase(win, inner)}
SELECT
  COALESCE(${FIELD[groupBy].raw}, '(none)') AS dim,
  ${RAW_CODE} AS code,
  COUNT(*) AS total,
  SUM(CASE WHEN t.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
${rawFrom}${where.length ? `\nWHERE ${where.join("\n  AND ")}` : ""}
GROUP BY 1, 2`;
}

function sampleSql(filters, win, { failuresOnly, limit }) {
  const { inner, outer: where } = splitRaw(filters);
  if (failuresOnly) inner.push("status <> 'SUCCESS'");
  return `${rawBase(win, inner)}
SELECT
  t.txn_id,
  t.rrn,
  format_datetime(t.created_on, 'yyyy-MM-dd HH:mm:ss') AS created_on,
  CAST(t.amount AS varchar) AS amount,
  t.status,
  COALESCE(NULLIF(trim(t.app_resp_code), ''), '') AS app_resp_code,
  COALESCE(t.npci_resp_code, '') AS npci_resp_code,
  t.psp_handle AS payer_psp,
  COALESCE(pr.handle, '') AS payer_handle,
  ${IFSC4("pr")} AS payer_bank,
  COALESCE(pe.handle, '') AS payee_handle,
  ${IFSC4("pe")} AS payee_bank,
  t.category,
  COALESCE(t.initiation_mode, '') AS initiation_mode
${rawFrom}${where.length ? `\nWHERE ${where.join("\n  AND ")}` : ""}
ORDER BY t.created_on DESC
LIMIT ${limit}`;
}

// Duration gate: 15-min buckets for one day — the escalated slice vs all 4 TPAP handles,
// all flows. Fixed scope, so one check per (slice, day) serves every page filter.
function durationSql(slice, win) {
  const inner = [];
  const sliceWhere = whereFor("raw", slice);
  const bucket = (col) => `format_datetime(date_add('minute', (minute(${col}) / 15) * 15, date_trunc('hour', ${col})), 'HH:mm')`;
  return `${rawBase(win, inner)}
SELECT 'all' AS series, ${bucket("t.created_on")} AS ts, COUNT(*) AS total, SUM(CASE WHEN t.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
FROM t
GROUP BY 1, 2
UNION ALL
SELECT 'slice' AS series, ${bucket("t.created_on")} AS ts, COUNT(*) AS total, SUM(CASE WHEN t.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
${rawFrom}${sliceWhere.length ? `\nWHERE ${sliceWhere.join("\n  AND ")}` : ""}
GROUP BY 1, 2`;
}

// Distinct values for the filter dropdowns.
function optionsSql(win) {
  const cols = {
    category: "category",
    os: "os_type",
    payer_bank: "payer_bank",
    instrument: "payer_instrument",
    qr_type: "qr_type",
    flow: "p2p_p2m_flag",
    payer_psp: "lower(payer_handle)",
    payee_handle: "lower(payee_handle)",
  };
  const ids = Object.keys(cols);
  // One scan: a grouping set per column; grouping(c) = 0 marks the column of the row.
  return `WITH b AS (
  SELECT ${ids.map((id) => `CAST(${cols[id]} AS varchar) AS ${id}`).join(", ")}, txn_init
  FROM team_product.LOOKER_TPAP_Txns_V3
  WHERE dt >= DATE '${win.fromDate}' AND dt < DATE '${win.toDate}'
),
g AS (
  SELECT
    CASE ${ids.map((id) => `WHEN grouping(${id}) = 0 THEN '${id}'`).join(" ")} END AS field,
    CASE ${ids.map((id) => `WHEN grouping(${id}) = 0 THEN ${id}`).join(" ")} END AS v,
    SUM(txn_init) AS n
  FROM b
  GROUP BY GROUPING SETS (${ids.map((id) => `(${id})`).join(", ")})
)
SELECT field, v, n FROM (
  SELECT field, v, n, row_number() OVER (PARTITION BY field ORDER BY n DESC) AS rk FROM g WHERE v IS NOT NULL
) WHERE rk <= 300`;
}

function rawOptionsSql() {
  // One recent hour is enough to list initiation modes / categories / statuses.
  const wall = Date.now() + TZ_MIN * 60000;
  const to = Math.floor(wall / 3600000) * 3600000 - 3600000;
  const from = to - 3600000;
  return `SELECT field, v, COUNT(*) AS n FROM (
  SELECT 'initiation_mode' AS field, initiation_mode AS v FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '${fmt(from).slice(0, 10)}' AND created_on >= TIMESTAMP '${fmt(from)}' AND created_on < TIMESTAMP '${fmt(to)}'
    AND business_type IS NULL AND psp_handle IN (${HANDLES.map(q).join(", ")})
  UNION ALL
  SELECT 'status' AS field, status AS v FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '${fmt(from).slice(0, 10)}' AND created_on >= TIMESTAMP '${fmt(from)}' AND created_on < TIMESTAMP '${fmt(to)}'
    AND business_type IS NULL AND psp_handle IN (${HANDLES.map(q).join(", ")})
) WHERE v IS NOT NULL GROUP BY 1, 2`;
}

// ─── registration ────────────────────────────────────────────────────────────

const num = (v) => (v == null ? 0 : Number(v) || 0);

export function registerUnifiedDrill(app, { dataDir }) {
  const OPTIONS_FILE = path.join(dataDir, "udash-drill-options.json");
  let options = (() => {
    try {
      return JSON.parse(fs.readFileSync(OPTIONS_FILE, "utf8"));
    } catch {
      return null;
    }
  })();
  let optionsJob = null;
  const jobs = new Map(); // id -> job
  let seq = 0;

  function startJob(kind, sql, post) {
    const id = `${Date.now().toString(36)}-${(seq += 1)}`;
    const job = { id, kind, status: "running", startedAt: Date.now(), sql, state: "submitted" };
    jobs.set(id, job);
    // Keep the last 100 jobs.
    if (jobs.size > 100) jobs.delete(jobs.keys().next().value);
    runTrino(sql, { timeoutMs: 45 * 60000, onProgress: (p) => p.state && (job.state = p.state) })
      .then((raw) => {
        Object.assign(job, { status: "done", rows: post(raw), finishedAt: Date.now() });
      })
      .catch((err) => {
        Object.assign(job, { status: "failed", error: err.message, finishedAt: Date.now() });
      });
    return job;
  }

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  app.get(
    "/api/udash/drill/meta",
    handle(() => ({
      fields: FIELDS.map((f) => ({ id: f.id, label: f.label, looker: Boolean(f.looker), raw: Boolean(f.raw) })),
      windows: Object.fromEntries(Object.entries(WINDOWS).map(([e, w]) => [e, Object.entries(w).map(([key, v]) => ({ key, label: v.label }))])),
      rawGroups: RAW_GROUPS,
      handles: HANDLES,
    })),
  );

  app.get(
    "/api/udash/drill/options",
    handle((req) => {
      const stale = !options || Date.now() - options.at > DAY;
      if ((req.query.refresh || stale) && !optionsJob) {
        const win = windowFor("looker", "10d");
        const lookerSqlText = optionsSql({ fromDate: win.fromDate, toDate: win.toDate });
        optionsJob = Promise.all([runTrino(lookerSqlText, { timeoutMs: 20 * 60000 }), runTrino(rawOptionsSql(), { timeoutMs: 20 * 60000 }).catch(() => [])])
          .then(([a, b]) => {
            const values = {};
            for (const r of [...a, ...b]) (values[r.field] ||= []).push({ v: String(r.v), n: num(r.n) });
            for (const k of Object.keys(values)) values[k].sort((x, y) => y.n - x.n);
            options = { at: Date.now(), values };
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(OPTIONS_FILE, JSON.stringify(options));
          })
          .catch((e) => console.warn("[udash:drill] options failed:", e.message))
          .finally(() => {
            optionsJob = null;
          });
      }
      return { loading: Boolean(optionsJob), options };
    }),
  );

  app.post(
    "/api/udash/drill/run",
    handle((req) => {
      const { engine = "looker", filters = {}, window = engine === "looker" ? "10d" : "yday", groupBy = "payer_bank" } = req.body || {};
      if (engine === "looker") {
        const win = windowFor("looker", window);
        const job = startJob("looker", lookerSql(filters, win), (raw) =>
          trimBreakdown(
            raw.flatMap((r) => {
              const row = { ts: String(r.ts).slice(0, 10), kind: r.kind, dim: r.dim, code: r.code || "", descr: "", total: num(r.total), success: num(r.success) };
              // Flow-kind per-code rows are also the day-level failures per code (kind "code").
              return r.kind === "flow" && r.code ? [row, { ...row, kind: "code", dim: row.code, code: "", descr: r.descr || "" }] : [row];
            }),
          ),
        );
        return { jobId: job.id, window: win };
      }
      if (engine === "raw") {
        const win = windowFor("raw", window);
        const job = startJob("raw", rawAggSql(filters, win, groupBy), (raw) => raw.map((r) => ({ dim: String(r.dim), code: r.code || "", total: num(r.total), success: num(r.success) })));
        return { jobId: job.id, window: win };
      }
      throw new Error(`Unknown engine ${engine}`);
    }),
  );

  app.post(
    "/api/udash/drill/sample",
    handle((req) => {
      const { filters = {}, window = "yday", day = null, failuresOnly = true, limit = 500 } = req.body || {};
      const n = Math.min(5000, Math.max(1, Number(limit) || 500));
      const win = day ? dayWindow(day) : windowFor("raw", window);
      const job = startJob("sample", sampleSql(filters, win, { failuresOnly: Boolean(failuresOnly), limit: n }), (raw) => raw);
      return { jobId: job.id, window: win };
    }),
  );

  // One check per (slice, day): finished results are kept on disk (a past day never
  // changes); a running check is shared by every caller.
  const DURATION_FILE = path.join(dataDir, "udash-duration-cache.json");
  const durationCache = (() => {
    try {
      return JSON.parse(fs.readFileSync(DURATION_FILE, "utf8"));
    } catch {
      return {};
    }
  })();
  const durationJobs = new Map();
  app.post(
    "/api/udash/drill/duration",
    handle((req) => {
      const { slice = {}, day } = req.body || {};
      const key = JSON.stringify([slice, day]);
      if (durationCache[key]) return { cached: true, rows: durationCache[key].rows };
      const prev = jobs.get(durationJobs.get(key));
      if (prev && prev.status !== "failed") return { jobId: prev.id, window: prev.window };
      const win = dayWindow(day);
      const job = startJob("duration", durationSql(slice, win), (raw) => {
        const rows = raw.map((r) => ({ series: r.series, ts: r.ts, total: num(r.total), success: num(r.success) }));
        durationCache[key] = { at: Date.now(), rows };
        // Keep the newest 300 checks.
        const keys = Object.keys(durationCache).sort((x, y) => durationCache[x].at - durationCache[y].at);
        keys.slice(0, Math.max(0, keys.length - 300)).forEach((k) => delete durationCache[k]);
        try {
          fs.writeFileSync(DURATION_FILE, JSON.stringify(durationCache));
        } catch {
          /* best effort */
        }
        return rows;
      });
      job.window = win;
      durationJobs.set(key, job.id);
      return { jobId: job.id, window: win };
    }),
  );

  app.get(
    "/api/udash/drill/job/:id",
    handle((req) => {
      const job = jobs.get(req.params.id);
      if (!job) throw new Error("Job not found (backend restarted?) — run it again");
      return job;
    }),
  );
}
