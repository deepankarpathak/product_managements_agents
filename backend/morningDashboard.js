// Morning Dashboard — UPI SR / error / U09 / bank monitoring.
//
// Runs one query per section, in parallel, on either Trino (DWH, long windows) or
// Redash (live switch MySQL, short windows). Failed sections drop into a serial
// retry queue. Last successful result per section is persisted to disk so opening
// the page never triggers a query.
//
// Routes (all under /api/mdash):
//   GET  /state                 config + per-section job state + cached results
//   POST /run        {sections?, durations?, engine?}   start (or restart) sections
//   POST /stop       {sections?}                         cancel running/queued/retrying
//   POST /retry-now  {section}                           skip the retry wait
//   GET  /config  · PUT /config                          dashboard settings
//   GET  /sql?section=&duration=&engine=                 rendered SQL (what would run)
//   GET  /connectivity                                   Trino + Redash health
//   GET  /freshness                                      DWH max(created_on)
//   POST /cache/clear                                    drop cached results
//   GET  /history                                        recent run log

import fs from "fs";
import path from "path";
import { runRedashOnce, runRedashWithEnv, runTrino, trinoEnv } from "./trinoClient.js";
// Re-exported for anything still importing them from here (moved to trinoClient.js).
export { runRedashWithEnv, runTrino };
import { analyze } from "./historyInsights.js";
import { computeAlerts, pickYday } from "../src/breakdown-math.mjs";
import { buildSrAlertHeadline, buildSrAlertSlack } from "./srAlertMessage.js";

// ─── Constants ───────────────────────────────────────────────────────────────

// breakdown / declines are listed first so "Refresh all" queues them first (they feed the KPI strip).
export const SECTIONS = ["breakdown", "declines", "sr", "errors", "u09", "bank", "share", "flowsr", "instrument", "psp", "payerbank", "errbreak"];

// Breakdown card tabs (Looker dimensions). Alerts are computed over all of them.
export const BREAKDOWN_KINDS = ["psp", "bank", "instrument", "flow"];

export const SECTION_META = {
  // Impact-ranked triage: day totals per (kind, dim) over 10 days, top failure codes per dim
  // for the last 2 days, and day-level failures per code (kind = "code", with NPCI description).
  breakdown: { title: "SR Breakdown (impact ranked)", keys: ["ts", "kind", "dim", "code", "descr"], sums: ["total", "success"], daily: true },
  // ₹ value of failed txns per code for the latest complete day (raw txns — Looker has no amount).
  declines: { title: "Decline codes · ₹ amount", keys: ["ts", "code"], sums: ["cnt", "amount"], daily: true },
  sr: { title: "Success Rate", keys: ["ts", "handle", "flow"], sums: ["total", "success"] },
  errors: { title: "Error Code Analysis", keys: ["ts", "code"], sums: ["cnt"] },
  // U09 comes in short spikes — 30-min points for the 1-day view so they aren't averaged away.
  u09: { title: "U09 Trend", keys: ["ts", "handle"], sums: ["total", "u09"], buckets: { "1d": 30 } },
  // anchorParticipants: on Trino, end the window at the latest DWH txn_participants row
  // (that table lags txn_info by hours) instead of showing an empty tail.
  bank: { title: "Bank-wise Success Rate", keys: ["ts", "bank", "flow"], sums: ["total", "success"], anchorParticipants: true },
  // Day-level sections read pre-aggregated Looker tables on Trino (complete days only).
  // sums "*" = every non-key column is a numeric measure (handle columns of a wide table).
  share: { title: "Txn Count / % Share Across Handles", keys: ["ts"], sums: "*", daily: true },
  flowsr: { title: "P2P vs P2M SR", keys: ["ts", "flow"], sums: ["total", "success"], daily: true },
  instrument: { title: "Instrument-wise SR", keys: ["ts", "flow", "instrument"], sums: ["total", "success"], daily: true },
  psp: { title: "Payee PSP SR", keys: ["ts", "psp"], sums: ["total", "success"], daily: true },
  // Hybrid: > 1 day reads the daily Looker table; <= 1 day reads raw txns in 4-hour buckets
  // (30-min for the 4-hour window, otherwise it would be a single point).
  payerbank: {
    title: "Payer Bank SR",
    keys: ["ts", "bank"],
    sums: ["total", "success"],
    anchorParticipants: true,
    buckets: { "4h": 30, "12h": 240, "1d": 240 },
  },
  errbreak: { title: "Error-wise Breakup", keys: ["ts", "code"], sums: ["cnt"], buckets: { "4h": 30, "12h": 240, "1d": 60 } },
};

export const DURATIONS = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "12h": 720,
  "1d": 1440,
  "2d": 2880,
  "3d": 4320,
  "4d": 5760,
  "7d": 10080,
};

// Per-section duration options. kind "intraday" = raw txn tables (minutes);
// kind "daily" = Looker day-level table (complete days, value = days).
const intra = (keys) => Object.fromEntries(keys.map((k) => [k, { kind: "intraday", minutes: DURATIONS[k] }]));
const daily = (spec) => Object.fromEntries(Object.entries(spec).map(([k, n]) => [k, { kind: "daily", days: n }]));
const ALL_INTRADAY = intra(Object.keys(DURATIONS));
const LONG_DAILY = daily({ "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90, "180d": 180 });
const HYBRID = { ...intra(["4h", "12h", "1d"]), ...daily({ "2d": 2, "3d": 3, "7d": 7, "15d": 15 }) };

export const SECTION_DURATIONS = {
  breakdown: daily({ "10d": 10 }),
  declines: daily({ "1d": 1 }),
  sr: ALL_INTRADAY,
  errors: ALL_INTRADAY,
  u09: ALL_INTRADAY,
  // <= 1 day: raw txns (Redash / Trino); > 1 day: Looker daily (raw bank data lags ~12h in the DWH).
  bank: { ...intra(["15m", "1h", "4h", "12h", "1d"]), ...daily({ "2d": 2, "3d": 3, "7d": 7, "15d": 15, "30d": 30 }) },
  share: LONG_DAILY,
  flowsr: LONG_DAILY,
  instrument: LONG_DAILY,
  psp: daily({ "1d": 1, "2d": 2, "3d": 3, "5d": 5, "7d": 7, "15d": 15 }),
  payerbank: HYBRID,
  errbreak: HYBRID,
};

const durationsFor = (section) => SECTION_DURATIONS[section] || ALL_INTRADAY;
const specFor = (section, key) => durationsFor(section)[key];

const DEFAULT_CONFIG = {
  handles: ["ptyes", "ptaxis", "pthdfc", "ptsbi"],
  defaultDuration: "2d",
  sectionDurations: {
    breakdown: "10d",
    declines: "1d",
    sr: "4d",
    errors: "2d",
    u09: "1d",
    bank: "7d",
    share: "7d",
    flowsr: "90d",
    instrument: "30d",
    psp: "7d",
    payerbank: "7d",
    errbreak: "1d",
  },
  // Backend refresh schedule (IST). "daily" = run at each listed time once per day;
  // "interval" = re-run when the last result is older than everyMin, only inside
  // activeHours. Scheduled runs always use the section's default duration and never
  // run on Redash (live switch DB). Opening the page never runs anything.
  //
  // Slots fire ~30 min before each read (07:30–08:00, 11:00, 15:30, 20:00, 23:30) so
  // results are ready. Raw-txn sections run at all 5; day-level Looker sections only
  // change once a day, so they run at 07:00 plus 10:30 (catches a late-loading table).
  schedule: {
    enabled: true,
    activeHours: ["07:00", "23:30"],
    rules: {
      breakdown: { type: "daily", at: ["07:00", "10:30"] },
      declines: { type: "daily", at: ["07:00", "10:30"] },
      sr: { type: "daily", at: ["07:00", "10:30", "15:00", "19:30", "23:00"] },
      errors: { type: "daily", at: ["07:00", "10:30", "15:00", "19:30", "23:00"] },
      u09: { type: "daily", at: ["07:00", "10:30", "15:00", "19:30", "23:00"] },
      bank: { type: "daily", at: ["07:00", "10:30"] },
      share: { type: "daily", at: ["07:00", "10:30"] },
      flowsr: { type: "daily", at: ["07:00", "10:30"] },
      instrument: { type: "daily", at: ["07:00", "10:30"] },
      psp: { type: "daily", at: ["07:00", "10:30"] },
      payerbank: { type: "daily", at: ["07:00", "10:30"] },
      errbreak: { type: "daily", at: ["07:00", "10:30", "15:00", "19:30", "23:00"] },
    },
  },
  // Windows up to this many minutes run on Redash; longer ones on Trino.
  redashMaxMinutes: 240,
  redash: {
    url: "",
    dataSourceIds: [1],
    chunkMinutes: 60,
    chunkParallel: 2,
    idMarginSec: 180,
  },
  maxParallel: 4,
  autoRetry: true,
  maxRetries: 3,
  retryDelaySec: 30,
  trinoTimeoutSec: 1200,
  redashTimeoutSec: 900,
  bucketMinutes: {
    "15m": 1,
    "1h": 5,
    "4h": 10,
    "12h": 30,
    "1d": 60,
    "2d": 60,
    "3d": 60,
    "4d": 60,
    "7d": 240,
  },
  errorColumn: "app_resp_code",
  errorGrouping: "full",
  errorTopN: 10,
  u09Pattern: "U09%",
  bankTopN: 8,
  // Section 4 remitter-bank watchlist (IFSC 4-char prefix → display name). Always listed
  // first in the table and plotted in the chart, whatever their volume rank.
  remitterBanks: [
    { code: "SBIN", name: "State Bank of India" },
    { code: "BARB", name: "Bank of Baroda" },
    { code: "HDFC", name: "HDFC Bank" },
    { code: "UTIB", name: "Axis Bank" },
    { code: "ICIC", name: "ICICI Bank" },
    { code: "UBIN", name: "Union Bank of India" },
    { code: "PUNB", name: "Punjab National Bank" },
    { code: "CNRB", name: "Canara Bank" },
    { code: "INDB", name: "IndusInd Bank" },
    { code: "YESB", name: "Yes Bank" },
    { code: "IDFB", name: "IDFC FIRST Bank" },
    { code: "IOBA", name: "Indian Overseas Bank" },
    { code: "UCBA", name: "UCO Bank" },
    { code: "AIRP", name: "Airtel Payments Bank" },
    { code: "IPOS", name: "India Post Payments Bank" },
  ],
  tzOffsetMinutes: 330,
  // Live data: skip the newest N minutes so still-PENDING txns don't drag the last bucket's SR down.
  redashEndLagMinutes: 5,
  sqlOverrides: {},
};

// ─── SQL templates ───────────────────────────────────────────────────────────
// Placeholders: {{FROM}} {{TO}} {{FROM_DATE}} {{FROM_PAD}} {{TO_PAD}} {{BUCKET}}
// {{HANDLES}} {{ERROR_COL}} {{U09_PATTERN}}; Redash also {{TI_ID_FROM}} {{TI_ID_TO}}
// {{TP_ID_FROM}} {{TP_ID_TO}} (PK bounds — switch tables have no created_on index).
//
// Every section returns raw integer counts; rates are computed client-side
// (KB gotcha 2026-10-05: ROUND inside SQL loses precision).

// txn_info.psp_handle equals the PAYER handle for Paytm handles (verified against
// txn_participants, 2026-10-12) and is NULL otherwise. So SR / errors / U09 skip the
// participants join entirely — that table lags ~12h in the DWH and the join is ~35x
// slower on live MySQL. Only the bank section needs participants (payer IFSC).
// Live MySQL: always FORCE INDEX (PRIMARY) + id bounds — otherwise the optimiser picks
// the psp_handle / handle index and a 15-min window takes minutes instead of ~2s.

const TRINO_T = `WITH t AS (
  SELECT txn_id, created_on, status, app_resp_code, npci_resp_code, psp_handle AS handle,
    CASE WHEN category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END AS flow
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM}}'
    AND created_on <  TIMESTAMP '{{TO}}'
    AND business_type IS NULL
    AND type IN ('PAY', 'COLLECT')
    AND category IN ('VPA2VPA', 'VPA2ACCOUNT', 'VPA2MERCHANT')
    AND psp_handle IN ({{HANDLES}})
)`;

const TRINO_P = `,
p AS (
  SELECT txn_id, bank_code, detail_2
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM_PAD}}'
    AND created_on <  TIMESTAMP '{{TO_PAD}}'
    AND participant_type = 'PAYER'
    AND handle IN ({{HANDLES}})
)`;

const REDASH_WHERE_TI = `WHERE ti.id >= {{TI_ID_FROM}} AND ti.id < {{TI_ID_TO}}
  AND ti.created_on >= '{{FROM}}' AND ti.created_on < '{{TO}}'
  AND ti.psp_handle IN ({{HANDLES}})
  AND ti.business_type IS NULL
  AND ti.type IN ('PAY', 'COLLECT')
  AND ti.category IN ('VPA2VPA', 'VPA2ACCOUNT', 'VPA2MERCHANT')`;

// Bank join: drive from the participants PK range, then look up txn_info by txn_id.
// Without the forced order MySQL picks the handle index and scans every ptyes row ever.
const REDASH_FROM_JOIN = `FROM txn_participants tp FORCE INDEX (PRIMARY)
STRAIGHT_JOIN txn_info ti ON ti.txn_id = tp.txn_id
${REDASH_WHERE_TI}
  AND tp.id >= {{TP_ID_FROM}} AND tp.id < {{TP_ID_TO}}
  AND tp.participant_type = 'PAYER'`;

const REDASH_FLOW = `CASE WHEN ti.category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END`;

const LOOKER_TXNS = `FROM team_product.LOOKER_TPAP_Txns_V3
WHERE dt >= DATE '{{FROM_DATE}}'
  AND dt <  DATE '{{TO_DATE}}'`;

// Payee PSP grouping, verbatim from the Looker "Payee PSP SR" report.
const PAYEE_PSP_CASE = `CASE
    WHEN lower(payee_handle) IN ('paytm', 'ptyes', 'ptsbi', 'pthdfc', 'ptaxis', 'ptybl', 'pty', 'ptys') THEN payee_handle
    WHEN lower(payee_handle) IN ('ybl', 'ibl', 'axl') THEN 'PhonePe'
    WHEN upper(payee_handle) IN ('OKBIZAXIS', 'OKBIZICICI', 'OKBIZHDFCBANK', 'OKBIZSBI', 'OKAXIS', 'OKICICI', 'OKHDFCBANK', 'OKSBI') THEN 'GooglePay'
    WHEN upper(payee_handle) IN ('APL', 'YAPL', 'RAPL') THEN 'AmazonPay'
    WHEN upper(payee_handle) IN ('AXISB', 'YESCRED') THEN 'CRED'
    WHEN upper(payee_handle) = 'NAVIAXIS' THEN 'Navi'
    WHEN upper(payee_handle) = 'SUPERYES' THEN 'SuperMoney'
    WHEN upper(payee_handle) = 'FKAXIS' THEN 'Flipkart UPI'
    ELSE 'OTHERS'
  END`;

// Breakdown: one Looker scan, UNION of per-kind totals, per-kind code rows (whole window:
// top decline codes for the latest day + per-code trend lines) and per-code day totals
// with the NPCI description.
const BD_DIMS = {
  psp: PAYEE_PSP_CASE,
  bank: "COALESCE(NULLIF(trim(payer_bank), ''), 'Others')",
  instrument: "COALESCE(payer_instrument, 'Others')",
  flow: "COALESCE(p2p_p2m_flag, 'Others')",
};
const BREAKDOWN_LOOKER = `WITH b AS (
  SELECT
    dt,
${BREAKDOWN_KINDS.map((k) => `    ${BD_DIMS[k]} AS ${k}`).join(",\n")},
    COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
    description,
    txn_init,
    success
  ${LOOKER_TXNS.replace(/\n/g, "\n  ")}
)
${BREAKDOWN_KINDS.map(
  (k) => `SELECT CAST(dt AS varchar) AS ts, '${k}' AS kind, ${k} AS dim, '' AS code, '' AS descr, SUM(txn_init) AS total, SUM(success) AS success
FROM b GROUP BY dt, ${k}
UNION ALL
SELECT CAST(dt AS varchar) AS ts, '${k}' AS kind, ${k} AS dim, code, '' AS descr, SUM(txn_init) AS total, SUM(success) AS success
FROM b GROUP BY dt, ${k}, code
HAVING SUM(txn_init) > SUM(success)`,
).join("\nUNION ALL\n")}
UNION ALL
SELECT CAST(dt AS varchar) AS ts, 'code' AS kind, code AS dim, '' AS code, COALESCE(max(description), '') AS descr, SUM(txn_init) AS total, SUM(success) AS success
FROM b GROUP BY dt, code
HAVING SUM(txn_init) > SUM(success)`;

export const DEFAULT_SQL = {
  breakdown: { looker: BREAKDOWN_LOOKER },
  // Raw txns (Paytm payer handles): failed txn count and ₹ value per code, complete days.
  declines: {
    looker: `SELECT
  ts,
  code,
  COUNT(*)    AS cnt,
  SUM(amount) AS amount
FROM (
  SELECT DISTINCT
    txn_id,
    CAST(CAST(created_on AS date) AS varchar) AS ts,
    COALESCE(NULLIF(trim(app_resp_code), ''), status) AS code,
    amount
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM}}'
    AND created_on <  TIMESTAMP '{{TO}}'
    AND business_type IS NULL
    AND type IN ('PAY', 'COLLECT')
    AND category IN ('VPA2VPA', 'VPA2ACCOUNT', 'VPA2MERCHANT')
    AND psp_handle IN ({{HANDLES}})
    AND status <> 'SUCCESS'
)
GROUP BY 1, 2`,
  },
  psp: {
    looker: `SELECT
  CAST(dt AS varchar) AS ts,
  ${PAYEE_PSP_CASE} AS psp,
  SUM(txn_init) AS total,
  SUM(success)  AS success
${LOOKER_TXNS}
  AND payer_handle <> 'paytm'
GROUP BY 1, 2`,
  },
  payerbank: {
    looker: `SELECT
  CAST(dt AS varchar)            AS ts,
  COALESCE(payer_bank, 'Others') AS bank,
  SUM(txn_init)                  AS total,
  SUM(success)                   AS success
${LOOKER_TXNS}
  AND payer_handle <> 'paytm'
GROUP BY 1, 2`,
    trino: `${TRINO_T}${TRINO_P}
SELECT
  {{BUCKET}} AS ts,
  UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) AS bank,
  COUNT(DISTINCT t.txn_id) AS total,
  COUNT(DISTINCT CASE WHEN t.status = 'SUCCESS' THEN t.txn_id END) AS success
FROM t
JOIN p ON t.txn_id = p.txn_id
GROUP BY 1, 2`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  UPPER(LEFT(COALESCE(NULLIF(tp.bank_code, ''), tp.detail_2, 'UNKN'), 4)) AS bank,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
${REDASH_FROM_JOIN}
GROUP BY 1, 2`,
  },
  errbreak: {
    // Successful txns collapse into __NONFAIL__ (denominator); every other row is
    // bucketed by app_resp_code — same rule as the Looker report.
    looker: `SELECT
  CAST(dt AS varchar) AS ts,
  CASE WHEN success > 0 THEN '__NONFAIL__' ELSE COALESCE(NULLIF(app_resp_code, ''), '(blank)') END AS code,
  SUM(txn_init) AS cnt
${LOOKER_TXNS}
GROUP BY 1, 2`,
    trino: `${TRINO_T}
SELECT
  {{BUCKET}} AS ts,
  CASE WHEN t.status = 'SUCCESS' THEN '__NONFAIL__'
       ELSE COALESCE(NULLIF(t.app_resp_code, ''), t.status) END AS code,
  COUNT(DISTINCT t.txn_id) AS cnt
FROM t
GROUP BY 1, 2`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  CASE WHEN ti.status = 'SUCCESS' THEN '__NONFAIL__'
       ELSE COALESCE(NULLIF(ti.app_resp_code, ''), ti.status) END AS code,
  COUNT(*) AS cnt
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 2`,
  },
  share: {
    // One row per day; handle columns are txn counts. Share is computed client-side.
    looker: `SELECT
  CAST(dt AS varchar) AS ts,
  SUM(ptyes)  AS ptyes,
  SUM(ptaxis) AS ptaxis,
  SUM(pthdfc) AS pthdfc,
  SUM(ptsbi)  AS ptsbi,
  SUM(paytm)  AS paytm
FROM team_product.LOOKER_Day_Level_DTU_TPU
WHERE dt >= DATE '{{FROM_DATE}}'
  AND dt <  DATE '{{TO_DATE}}'
GROUP BY 1`,
  },
  flowsr: {
    // p2p_p2m_flag: P2P / P2M / LITE. SR = success / txn_init (as in the Looker report).
    looker: `SELECT
  CAST(dt AS varchar) AS ts,
  p2p_p2m_flag        AS flow,
  SUM(txn_init)       AS total,
  SUM(success)        AS success
${LOOKER_TXNS}
GROUP BY 1, 2`,
  },
  instrument: {
    looker: `SELECT
  CAST(dt AS varchar)                  AS ts,
  p2p_p2m_flag                         AS flow,
  COALESCE(payer_instrument, 'Others') AS instrument,
  SUM(txn_init)                        AS total,
  SUM(success)                         AS success
${LOOKER_TXNS}
GROUP BY 1, 2, 3`,
  },
  sr: {
    trino: `${TRINO_T}
SELECT
  {{BUCKET}}                                                       AS ts,
  t.handle                                                         AS handle,
  t.flow                                                           AS flow,
  COUNT(DISTINCT t.txn_id)                                         AS total,
  COUNT(DISTINCT CASE WHEN t.status = 'SUCCESS' THEN t.txn_id END) AS success
FROM t
GROUP BY 1, 2, 3`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  ti.psp_handle AS handle,
  ${REDASH_FLOW} AS flow,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 2, 3`,
  },
  errors: {
    // Non-failures collapse into __NONFAIL__ so the client gets the denominator too.
    trino: `${TRINO_T}
SELECT
  {{BUCKET}} AS ts,
  CASE WHEN t.status = 'FAILURE'
       THEN COALESCE(NULLIF(t.{{ERROR_COL}}, ''), '(blank)')
       ELSE '__NONFAIL__' END AS code,
  COUNT(DISTINCT t.txn_id) AS cnt
FROM t
GROUP BY 1, 2`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  CASE WHEN ti.status = 'FAILURE'
       THEN COALESCE(NULLIF(ti.{{ERROR_COL}}, ''), '(blank)')
       ELSE '__NONFAIL__' END AS code,
  COUNT(*) AS cnt
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 2`,
  },
  u09: {
    trino: `${TRINO_T}
SELECT
  {{BUCKET}} AS ts,
  t.handle AS handle,
  COUNT(DISTINCT t.txn_id) AS total,
  COUNT(DISTINCT CASE WHEN t.app_resp_code LIKE '{{U09_PATTERN}}'
                        OR t.npci_resp_code LIKE '{{U09_PATTERN}}' THEN t.txn_id END) AS u09
FROM t
GROUP BY 1, 2`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  ti.psp_handle AS handle,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.app_resp_code LIKE '{{U09_PATTERN}}'
             OR ti.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END) AS u09
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 2`,
  },
  bank: {
    // > 1 day: Looker daily (payer_bank is already the 4-char IFSC prefix). LITE excluded.
    looker: `SELECT
  CAST(dt AS varchar)            AS ts,
  COALESCE(payer_bank, 'Others') AS bank,
  p2p_p2m_flag                   AS flow,
  SUM(txn_init)                  AS total,
  SUM(success)                   AS success
${LOOKER_TXNS}
  AND payer_handle <> 'paytm'
  AND p2p_p2m_flag IN ('P2P', 'P2M')
GROUP BY 1, 2, 3`,
    // Remitter bank = first 4 chars of payer IFSC (bank_code), falling back to detail_2.
    // NOTE: DWH txn_participants lags txn_info by hours — see /freshness.
    trino: `${TRINO_T}${TRINO_P}
SELECT
  {{BUCKET}} AS ts,
  UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) AS bank,
  t.flow AS flow,
  COUNT(DISTINCT t.txn_id) AS total,
  COUNT(DISTINCT CASE WHEN t.status = 'SUCCESS' THEN t.txn_id END) AS success
FROM t
JOIN p ON t.txn_id = p.txn_id
GROUP BY 1, 2, 3`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  UPPER(LEFT(COALESCE(NULLIF(tp.bank_code, ''), tp.detail_2, 'UNKN'), 4)) AS bank,
  ${REDASH_FLOW} AS flow,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
${REDASH_FROM_JOIN}
GROUP BY 1, 2, 3`,
  },
};

// ─── Time helpers (all wall-clock math in the switch timezone, IST by default) ─

const pad2 = (n) => String(n).padStart(2, "0");

/** Format a "shifted" epoch (wall clock encoded as UTC) as `YYYY-MM-DD HH:MM:SS`. */
function fmtWall(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

export function computeWindow(durationKey, cfg, nowMs = Date.now(), engine = null, section = null) {
  const spec = section ? specFor(section, durationKey) : { kind: "intraday", minutes: DURATIONS[durationKey] };
  if (!spec) throw new Error(`Invalid duration ${durationKey} for ${section}`);
  if (spec.kind === "daily") {
    const days = spec.days;
    // Complete days only: [today - N, today) in IST.
    const dayMs = 86400000;
    const toMs = Math.floor((nowMs + cfg.tzOffsetMinutes * 60000) / dayMs) * dayMs;
    const fromMs = toMs - days * dayMs;
    return {
      duration: durationKey,
      minutes: days * 1440,
      bucketMin: 1440,
      fromMs,
      toMs,
      from: fmtWall(fromMs),
      to: fmtWall(toMs),
      fromDate: fmtWall(fromMs).slice(0, 10),
      toDate: fmtWall(toMs).slice(0, 10),
      fromPad: fmtWall(fromMs),
      toPad: fmtWall(toMs),
    };
  }
  const minutes = spec.minutes;
  const bucketMin = Number(SECTION_META[section]?.buckets?.[durationKey] || cfg.bucketMinutes?.[durationKey]) || 60;
  const bucketMs = bucketMin * 60000;
  const lagMin = engine === "redash" ? Number(cfg.redashEndLagMinutes) || 0 : 0;
  const wallNow = nowMs + cfg.tzOffsetMinutes * 60000 - lagMin * 60000;
  // Only complete buckets: end at the start of the current bucket. Sections with their
  // own (coarse) buckets end on the hour and bucket relative to the window start, so a
  // 4-hour bucket doesn't throw away up to 4 hours of fresh data.
  const relative = Boolean(SECTION_META[section]?.buckets?.[durationKey]);
  const alignMs = relative ? Math.min(bucketMs, 3600000) : bucketMs;
  const toMs = Math.floor(wallNow / alignMs) * alignMs;
  const fromMs = toMs - minutes * 60000;
  return {
    duration: durationKey,
    minutes,
    bucketMin,
    relative,
    anchor: fmtWall(fromMs),
    fromMs,
    toMs,
    from: fmtWall(fromMs),
    to: fmtWall(toMs),
    fromDate: fmtWall(fromMs).slice(0, 10),
    toDate: fmtWall(toMs + 86400000).slice(0, 10),
    fromPad: fmtWall(fromMs - 10 * 60000),
    toPad: fmtWall(toMs + 10 * 60000),
  };
}

const wallToMs = (s) => Date.parse(`${s.replace(" ", "T")}Z`);

/** Move an intraday window so it ends at `endMs` (wall clock), keeping its length. */
function shiftWindow(win, endMs) {
  const bucketMs = win.bucketMin * 60000;
  const alignMs = win.relative ? Math.min(bucketMs, 3600000) : bucketMs;
  const toMs = Math.floor(endMs / alignMs) * alignMs;
  const fromMs = toMs - win.minutes * 60000;
  return {
    ...win,
    anchor: fmtWall(fromMs),
    fromMs,
    toMs,
    from: fmtWall(fromMs),
    to: fmtWall(toMs),
    fromDate: fmtWall(fromMs).slice(0, 10),
    toDate: fmtWall(toMs + 86400000).slice(0, 10),
    fromPad: fmtWall(fromMs - 10 * 60000),
    toPad: fmtWall(toMs + 10 * 60000),
  };
}

function bucketExpr(engine, col, bucketMin, anchor) {
  if (anchor) {
    // Buckets counted from the window start: [anchor, anchor + n), [anchor + n, …)
    return engine === "trino"
      ? // bigint / bigint = truncating integer division (diff is >= 0 inside the window).
        // Don't write `/ 240.0`: that's DECIMAL division rounded to 1 dp, which shifts edges.
        `format_datetime(date_add('minute', (date_diff('minute', TIMESTAMP '${anchor}', ${col}) / ${bucketMin}) * ${bucketMin}, TIMESTAMP '${anchor}'), 'yyyy-MM-dd HH:mm')`
      : `DATE_FORMAT(DATE_ADD('${anchor}', INTERVAL FLOOR(TIMESTAMPDIFF(MINUTE, '${anchor}', ${col}) / ${bucketMin}) * ${bucketMin} MINUTE), '%Y-%m-%d %H:%i')`;
  }
  if (engine === "trino") {
    const inner =
      bucketMin < 60
        ? `date_add('minute', (minute(${col}) / ${bucketMin}) * ${bucketMin}, date_trunc('hour', ${col}))`
        : `date_add('hour', (hour(${col}) / ${bucketMin / 60}) * ${bucketMin / 60}, date_trunc('day', ${col}))`;
    return `format_datetime(${inner}, 'yyyy-MM-dd HH:mm')`;
  }
  const inner =
    bucketMin < 60
      ? `DATE_ADD(DATE_FORMAT(${col}, '%Y-%m-%d %H:00:00'), INTERVAL FLOOR(MINUTE(${col}) / ${bucketMin}) * ${bucketMin} MINUTE)`
      : `DATE_ADD(DATE(${col}), INTERVAL FLOOR(HOUR(${col}) / ${bucketMin / 60}) * ${bucketMin / 60} HOUR)`;
  return `DATE_FORMAT(${inner}, '%Y-%m-%d %H:%i')`;
}

// ─── SQL rendering ───────────────────────────────────────────────────────────

const sqlIdent = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`Invalid column name: ${s}`);
  return s;
};
const sqlStr = (s) => String(s).replace(/'/g, "''");

/** "looker" = day-level Looker table (runs on Trino); "trino" / "redash" = raw txn tables. */
export function chooseEngine(section, durationKey, cfg, override) {
  const spec = specFor(section, durationKey);
  if (!spec) throw new Error(`Invalid duration ${durationKey} for ${section}`);
  if (spec.kind === "daily") return "looker";
  if (override === "trino" || override === "redash") return override;
  return spec.minutes <= cfg.redashMaxMinutes ? "redash" : "trino";
}

export function templateFor(section, engine, cfg) {
  const tpl = cfg.sqlOverrides?.[section]?.[engine] || DEFAULT_SQL[section][engine];
  if (!tpl) throw new Error(`${section} has no ${engine} query`);
  return tpl;
}

export function renderSql(template, engine, win, cfg, idBounds) {
  const vars = {
    FROM: win.from,
    TO: win.to,
    FROM_DATE: win.fromDate,
    TO_DATE: win.toDate,
    FROM_PAD: win.fromPad,
    TO_PAD: win.toPad,
    BUCKET: engine === "looker" ? "CAST(dt AS varchar)" : bucketExpr(engine, engine === "trino" ? "t.created_on" : "ti.created_on", win.bucketMin, win.relative ? win.anchor : null),
    HANDLES: cfg.handles.map((h) => `'${sqlStr(h.toLowerCase())}'`).join(", "),
    ERROR_COL: sqlIdent(cfg.errorColumn),
    U09_PATTERN: sqlStr(cfg.u09Pattern),
    TI_ID_FROM: idBounds?.tiFrom ?? "{{TI_ID_FROM}}",
    TI_ID_TO: idBounds?.tiTo ?? "{{TI_ID_TO}}",
    TP_ID_FROM: idBounds?.tpFrom ?? "{{TP_ID_FROM}}",
    TP_ID_TO: idBounds?.tpTo ?? "{{TP_ID_TO}}",
  };
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ─── Row merging ─────────────────────────────────────────────────────────────

function mergeRows(section, rows) {
  const { keys } = SECTION_META[section];
  let { sums } = SECTION_META[section];
  if (sums === "*") sums = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => !keys.includes(c));
  const map = new Map();
  for (const r of rows) {
    const k = keys.map((c) => r[c]).join("\u0001");
    let acc = map.get(k);
    if (!acc) {
      acc = {};
      for (const c of keys) acc[c] = r[c] == null ? null : String(r[c]);
      for (const c of sums) acc[c] = 0;
      map.set(k, acc);
    }
    for (const c of sums) acc[c] += Number(r[c]) || 0;
  }
  return [...map.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// Breakdown: keep totals and code-kind rows, but only the top CODES_KEPT failure codes per
// (day, kind, dim) — the long tail of bank × code rows is noise and bloats the cache.
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
    const k = `${r.ts}|${r.kind}|${r.dim}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => b.total - b.success - (a.total - a.success));
    out.push(...g.filter((r, i) => i < CODES_KEPT || major.get(r.kind)?.has(r.code)));
  }
  return out;
}

// ─── Alerts (breakdown) ──────────────────────────────────────────────────────

const KIND_LABEL = { psp: "Payee PSP", bank: "Payer bank", instrument: "Instrument", flow: "Flow" };
const fmtAlert = (a, bankName) => {
  const name = a.kind === "bank" && bankName(a.dim) ? `${a.dim} (${bankName(a.dim)})` : a.dim;
  const codes = a.top.map(([c, n]) => `${c} ${Math.round(n).toLocaleString("en-IN")}`).join(", ");
  return `${a.level} · ${KIND_LABEL[a.kind] || a.kind} ${name}: SR ${a.srNow?.toFixed(2)}% (${a.dsr >= 0 ? "+" : ""}${a.dsr?.toFixed(2)}pp vs L7D), impact ${a.impact?.toFixed(3)}pp, lost ~${Math.round(a.lost || 0).toLocaleString("en-IN")} txns${codes ? ` · top codes ${codes}` : ""}`;
};

async function postSlack(text, url = process.env.SLACK_WEBHOOK_URL || "") {
  if (!url) return "skipped (SLACK_WEBHOOK_URL not set)";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return r.ok ? "ok" : `failed (${r.status})`;
  } catch (e) {
    return `failed (${e.message})`;
  }
}


// ─── Redash executor ─────────────────────────────────────────────────────────

// Paytm-handle (TPAP) txns live on tpap Redash `switchv2` (data source 1), so the
// PTYES_* pair wins; MDASH_* / REDASH_* are fallbacks. URL and key always come from
// the same pair so a key is never sent to another instance.
function redashEnv(cfg) {
  const pairs = [
    ["PTYES_REDASH_URL", "PTYES_REDASH_API_KEY"],
    ["MDASH_REDASH_URL", "MDASH_REDASH_API_KEY"],
    ["REDASH_URL", "REDASH_API_KEY"],
  ];
  const norm = (x) => String(x || "").trim().replace(/\/+$/, "").toLowerCase();
  const usable = pairs.filter(([u, k]) => process.env[u] && process.env[k]);
  if (cfg.redash.url) {
    const hit = usable.find(([u]) => norm(process.env[u]) === norm(cfg.redash.url));
    return { url: norm(cfg.redash.url), key: hit ? process.env[hit[1]] : "" };
  }
  const [u, k] = usable[0] || pairs[0];
  return { url: norm(process.env[u]), key: process.env[k] || "" };
}

/**
 * Sample (id, created_on) pairs with cheap PK seeks so a time window can be turned
 * into id bounds. One UNION ALL query per pass; widens the span until it covers
 * the earliest target.
 */
async function sampleIdTimeline(env, dsId, table, earliestWall, opts) {
  const top = await runRedashOnce(
    env,
    dsId,
    `SELECT id, DATE_FORMAT(created_on, '%Y-%m-%d %H:%i:%s') AS t FROM ${table} ORDER BY id DESC LIMIT 1`,
    opts
  );
  if (!top.length) throw new Error(`${table} is empty`);
  const maxId = Number(top[0].id);
  let span = table === "txn_info" ? 2_000_000 : 4_000_000;
  for (let pass = 0; pass < 12; pass++) {
    const N = 48;
    const ids = Array.from({ length: N + 1 }, (_, i) => Math.max(1, Math.round(maxId - (span * i) / N)));
    const sql = ids
      .map(
        (x) =>
          `(SELECT id, DATE_FORMAT(created_on, '%Y-%m-%d %H:%i:%s') AS t FROM ${table} WHERE id >= ${x} ORDER BY id LIMIT 1)`
      )
      .join("\nUNION ALL\n");
    const rows = (await runRedashOnce(env, dsId, sql, opts))
      .map((r) => ({ id: Number(r.id), t: String(r.t) }))
      .concat([{ id: maxId, t: String(top[0].t) }])
      .sort((a, b) => a.id - b.id);
    if (rows[0].t <= earliestWall || ids[N] <= 1) {
      // Dense pass between the last sample before the window and the max id, so chunk
      // bounds are ~1-2 min of ids wide instead of a coarse step (48 points over a wide span).
      let lo = rows[0].id;
      for (const r of rows) if (r.t <= earliestWall) lo = r.id;
      const M = 160;
      const dense = Array.from({ length: M + 1 }, (_, i) => Math.round(lo + ((maxId - lo) * i) / M));
      const denseSql = dense
        .map((x) => `(SELECT id, DATE_FORMAT(created_on, '%Y-%m-%d %H:%i:%s') AS t FROM ${table} WHERE id >= ${x} ORDER BY id LIMIT 1)`)
        .join("\nUNION ALL\n");
      const more = (await runRedashOnce(env, dsId, denseSql, opts)).map((r) => ({ id: Number(r.id), t: String(r.t) }));
      const merged = [...new Map([...rows, ...more].map((r) => [r.id, r])).values()].sort((a, b) => a.id - b.id);
      return { maxId, samples: merged };
    }
    // Not far back enough — extrapolate from observed rate and overshoot 1.5x.
    const first = rows[0];
    const last = rows[rows.length - 1];
    const secs = Math.max(1, (Date.parse(last.t.replace(" ", "T") + "Z") - Date.parse(first.t.replace(" ", "T") + "Z")) / 1000);
    const need = (Date.parse(last.t.replace(" ", "T") + "Z") - Date.parse(earliestWall.replace(" ", "T") + "Z")) / 1000;
    span = Math.max(span * 2, Math.round(((last.id - first.id) / secs) * need * 1.5));
  }
  throw new Error(`Could not locate id range for ${table}`);
}

/** Largest sampled id whose time <= wall (lower bound) / smallest with time >= wall (upper bound). */
function idAt(samples, wall, dir) {
  if (dir === "lower") {
    let best = samples[0].id;
    for (const s of samples) if (s.t <= wall) best = s.id;
    return best;
  }
  for (const s of samples) if (s.t >= wall) return s.id;
  return Number.MAX_SAFE_INTEGER;
}

async function runRedashSection(section, template, win, cfg, { signal, timeoutMs, onProgress }) {
  const env = redashEnv(cfg);
  const marginMs = (cfg.redash.idMarginSec || 180) * 1000;
  const chunkMs = Math.max(1, cfg.redash.chunkMinutes || 15) * 60000;
  const chunks = [];
  for (let s = win.fromMs; s < win.toMs; s += chunkMs) chunks.push([s, Math.min(win.toMs, s + chunkMs)]);
  const opts = { signal, timeoutMs: Math.min(timeoutMs, 120000) };
  const all = [];
  const sqlShown = [];
  for (const dsId of cfg.redash.dataSourceIds) {
    onProgress?.({ state: `locating id range (ds ${dsId})` });
    const earliest = fmtWall(win.fromMs - marginMs * 2);
    const needTp = template.includes("{{TP_ID_");
    const [ti, tp] = await Promise.all([
      sampleIdTimeline(env, dsId, "txn_info", earliest, opts),
      needTp ? sampleIdTimeline(env, dsId, "txn_participants", earliest, opts) : null,
    ]);
    let done = 0;
    const queue = [...chunks];
    const worker = async () => {
      while (queue.length) {
        if (signal.aborted) throw signal.reason || new Error("aborted");
        const [s, e] = queue.shift();
        const cw = { ...win, from: fmtWall(s), to: fmtWall(e) };
        const bounds = {
          tiFrom: idAt(ti.samples, fmtWall(s - marginMs), "lower"),
          tiTo: idAt(ti.samples, fmtWall(e + marginMs), "upper"),
          tpFrom: tp ? idAt(tp.samples, fmtWall(s - marginMs * 2), "lower") : 0,
          tpTo: tp ? idAt(tp.samples, fmtWall(e + marginMs * 2), "upper") : 0,
        };
        const sql = renderSql(template, "redash", cw, cfg, bounds);
        if (!sqlShown.length) {
          sqlShown.push(sql);
          onProgress?.({ sql, state: `ds ${dsId}: 0/${chunks.length} chunks` });
        }
        const rows = await runRedashOnce(env, dsId, sql, { signal, timeoutMs });
        all.push(...rows);
        done += 1;
        onProgress?.({ state: `ds ${dsId}: ${done}/${chunks.length} chunks`, progress: (done / chunks.length) * 100 });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, cfg.redash.chunkParallel || 1) }, worker));
  }
  return { rows: all, sampleSql: sqlShown[0] };
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
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function mergeConfig(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && k !== "sqlOverrides") {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function validateConfig(cfg) {
  if (!Array.isArray(cfg.handles) || !cfg.handles.length) throw new Error("handles must be a non-empty list");
  for (const h of cfg.handles) if (!/^[a-z0-9._-]+$/i.test(h)) throw new Error(`Invalid handle: ${h}`);
  if (!["app_resp_code", "npci_resp_code"].includes(cfg.errorColumn)) throw new Error("errorColumn must be app_resp_code or npci_resp_code");
  if (!DURATIONS[cfg.defaultDuration]) throw new Error("Invalid defaultDuration");
  for (const [s, d] of Object.entries(cfg.sectionDurations || {})) {
    if (!SECTIONS.includes(s)) throw new Error(`Unknown section ${s}`);
    if (d && !durationsFor(s)[d]) throw new Error(`Invalid duration for ${s}: ${d} (allowed: ${Object.keys(durationsFor(s)).join(", ")})`);
  }
  for (const [d, m] of Object.entries(cfg.bucketMinutes || {})) {
    const n = Number(m);
    if (!DURATIONS[d] || !(n > 0)) throw new Error(`Invalid bucket for ${d}`);
    if (n >= 60 ? 1440 % n !== 0 || n % 60 !== 0 : 60 % n !== 0) {
      throw new Error(`Bucket for ${d} must divide an hour (1,2,5,10,15,30) or a day in whole hours (60,120,180,240,360,…)`);
    }
  }
  if (!Array.isArray(cfg.redash.dataSourceIds) || !cfg.redash.dataSourceIds.every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("redash.dataSourceIds must be positive integers");
  }
  if (cfg.remitterBanks != null) {
    if (!Array.isArray(cfg.remitterBanks)) throw new Error("remitterBanks must be a list");
    for (const b of cfg.remitterBanks) {
      if (!b || !/^[A-Z0-9]{4}$/.test(b.code || "")) throw new Error(`remitterBanks: invalid IFSC prefix "${b?.code}" (4 letters, e.g. SBIN)`);
    }
  }
  const sch = cfg.schedule || {};
  const hm = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  if (sch.activeHours && !(sch.activeHours.length === 2 && sch.activeHours.every(hm))) {
    throw new Error('schedule.activeHours must be ["HH:MM", "HH:MM"]');
  }
  for (const [sec, r] of Object.entries(sch.rules || {})) {
    if (!SECTIONS.includes(sec)) throw new Error(`schedule: unknown section ${sec}`);
    if (!r || r.type === "off") continue;
    if (r.type === "daily") {
      if (!Array.isArray(r.at) || !r.at.length || !r.at.every(hm)) throw new Error(`schedule.${sec}: daily needs at: ["HH:MM", …]`);
    } else if (r.type === "interval") {
      if (!(Number(r.everyMin) >= 10)) throw new Error(`schedule.${sec}: everyMin must be >= 10`);
    } else {
      throw new Error(`schedule.${sec}: type must be daily, interval or off`);
    }
  }
  return cfg;
}

/** Latest PAYER row in the DWH participants table (wall clock), searched back 2 days. */
async function participantsLatest(win, signal) {
  const from = fmtWall(win.toMs - 2 * 86400000);
  const rows = await runTrino(
    `SELECT format_datetime(MAX(created_on), 'yyyy-MM-dd HH:mm:ss') AS mx
FROM switch.txn_participants_snapshot_v3
WHERE dl_last_updated >= DATE '${from.slice(0, 10)}'
  AND created_on >= TIMESTAMP '${from}'
  AND participant_type = 'PAYER'`,
    { signal, timeoutMs: 180000 }
  );
  return rows?.[0]?.mx || null;
}

// ─── Registration ────────────────────────────────────────────────────────────

const SECTION_NUMBER = { breakdown: "A", declines: "B", sr: 1, errors: 2, u09: 3, bank: 4, share: 5, flowsr: 6, instrument: 7, psp: 8, payerbank: 9, errbreak: 10 };
const durationLabel = (key) => {
  const m = /^(\d+)([mhd])$/.exec(key || "");
  if (!m) return key;
  const n = Number(m[1]);
  const unit = { m: "min", h: "hour", d: "day" }[m[2]];
  return `last ${n} ${unit}${n > 1 && m[2] !== "m" ? "s" : ""}`;
};

/** history: optional store from historyStore.js — every run is also written there. */
export function registerMorningDashboard(app, { dataDir, history: historyStore = null }) {
  const CONFIG_FILE = path.join(dataDir, "mdash-config.json");
  const RESULTS_FILE = path.join(dataDir, "mdash-results.json");

  let config = validateConfig(mergeConfig(DEFAULT_CONFIG, readJsonFile(CONFIG_FILE, {})));
  const results = readJsonFile(RESULTS_FILE, {}); // section -> last success payload
  const history = []; // newest first, capped

  /** section -> job */
  const jobs = Object.fromEntries(SECTIONS.map((s) => [s, { status: "idle" }]));
  const retryQueue = []; // section ids, FIFO
  let running = 0;
  const waiting = []; // sections waiting for a parallel slot
  let retryWorkerBusy = false;

  const publicJob = (j) => {
    const { controller, ...rest } = j;
    return rest;
  };

  const logHistory = (entry) => {
    history.unshift(entry);
    if (history.length > 100) history.length = 100;
  };

  function durationFor(section, overrides) {
    const opts = durationsFor(section);
    const d = [overrides?.[section], config.sectionDurations?.[section], config.defaultDuration].find((x) => x && opts[x]);
    return d || Object.keys(opts)[0];
  }

  async function execute(section) {
    const job = jobs[section];
    const controller = new AbortController();
    job.controller = controller;
    job.status = "running";
    job.startedAt = Date.now();
    job.attempt = (job.attempt || 0) + 1;
    job.progress = null;
    job.state = "submitted";
    job.error = null;
    let win = computeWindow(job.duration, config, Date.now(), job.engine, section);
    job.window = { from: win.from, to: win.to, bucketMin: win.bucketMin };
    historyStore?.update(job.historyId, { event: "running", engine: job.engine, attempt: job.attempt, window: job.window, error: null });
    const template = templateFor(section, job.engine, config);
    const onProgress = (p) => {
      if (p.state) job.state = p.state;
      if (p.progress != null) job.progress = Math.round(p.progress);
      if (p.remoteId) job.remoteId = p.remoteId;
      if (p.sql) job.sql = p.sql;
    };
    try {
      let rawRows;
      if (job.engine === "trino" && SECTION_META[section].anchorParticipants) {
        // DWH txn_participants lags txn_info by hours: end the window at its latest row.
        job.state = "checking DWH participants freshness";
        const latest = await participantsLatest(win, controller.signal);
        if (latest && wallToMs(latest) < win.toMs) {
          win = shiftWindow(win, wallToMs(latest));
          job.window = { from: win.from, to: win.to, bucketMin: win.bucketMin, anchoredTo: latest };
        }
      }
      if (job.engine === "trino" || job.engine === "looker") {
        job.sql = renderSql(template, job.engine, win, config);
        rawRows = await runTrino(job.sql, {
          signal: controller.signal,
          timeoutMs: config.trinoTimeoutSec * 1000,
          onProgress,
        });
      } else {
        job.sql = renderSql(template, "redash", win, config);
        const out = await runRedashSection(section, template, win, config, {
          signal: controller.signal,
          timeoutMs: config.redashTimeoutSec * 1000,
          onProgress,
        });
        rawRows = out.rows;
        if (out.sampleSql) job.sql = out.sampleSql;
      }
      const merged = mergeRows(section, rawRows);
      const rows = section === "breakdown" ? trimBreakdown(merged) : merged;
      const finishedAt = Date.now();
      results[section] = {
        section,
        duration: job.duration,
        engine: job.engine,
        window: job.window,
        rows,
        ranAt: finishedAt,
        elapsedMs: finishedAt - job.startedAt,
      };
      try {
        writeJsonFile(RESULTS_FILE, results);
      } catch (e) {
        console.warn("[mdash] could not persist results:", e.message);
      }
      Object.assign(job, { status: "success", finishedAt, elapsedMs: finishedAt - job.startedAt, rowCount: rows.length });
      logHistory({ section, trigger: job.trigger, engine: job.engine, duration: job.duration, status: "success", attempt: job.attempt, at: finishedAt, elapsedMs: job.elapsedMs, rows: rows.length });
      historyStore?.update(job.historyId, {
        event: "success",
        engine: job.engine,
        window: job.window,
        sql: job.sql,
        attempt: job.attempt,
        elapsedMs: job.elapsedMs,
        rowCount: rows.length,
        analysis:
          section === "breakdown"
            ? await breakdownAlerts(rows, job.trigger)
            : analyze("morning", section, rows, { bucketMin: job.window.bucketMin, errorColumn: config.errorColumn }),
      });
    } catch (err) {
      const finishedAt = Date.now();
      const cancelled = controller.signal.aborted;
      const message = cancelled ? "Stopped by user" : err?.message || String(err);
      Object.assign(job, { finishedAt, elapsedMs: finishedAt - job.startedAt, error: message });
      logHistory({ section, trigger: job.trigger, engine: job.engine, duration: job.duration, status: cancelled ? "cancelled" : "failed", attempt: job.attempt, at: finishedAt, elapsedMs: job.elapsedMs, error: message });
      if (cancelled) {
        job.status = "cancelled";
      } else if (config.autoRetry && job.attempt <= config.maxRetries) {
        job.status = "retry-wait";
        job.nextRetryAt = Date.now() + config.retryDelaySec * 1000;
        if (!retryQueue.includes(section)) retryQueue.push(section);
        void pumpRetries();
      } else {
        job.status = "failed";
      }
      historyStore?.update(job.historyId, {
        event: job.status,
        error: job.status === "retry-wait" ? `Attempt ${job.attempt} failed (retrying): ${message}` : message,
        sql: job.sql,
        attempt: job.attempt,
        elapsedMs: job.elapsedMs,
        window: job.window,
      });
      console.warn(`[mdash] ${section} ${job.engine} attempt ${job.attempt} ${job.status}: ${message}`);
    } finally {
      job.controller = null;
    }
  }

  /**
   * WARN / CRIT rows → History alert log (deduped per data day) and Slack (new CRITs only).
   * Returns the History "analysis" block for this breakdown run.
   */
  async function breakdownAlerts(rows, trigger) {
    try {
      const yday = pickYday(rows, { kind: "bank" });
      if (!yday) return null;
      const alerts = computeAlerts(rows, { kinds: BREAKDOWN_KINDS, yday });
      const bankName = (code) => config.remitterBanks?.find((b) => b.code === code)?.name || null;
      const fresh = historyStore?.recordAlerts?.({ dashboard: "morning", dataDay: yday, trigger, alerts }) || [];
      // Slack (title line + detail blocks; the full headline goes to History):
      //  • Daily digest: once per data day, all WARN / CRIT rows, sent by the first run that sees
      //    a complete day with alerts. A failed send releases the claim so the next run retries.
      //  • CRIT exemption: a CRIT first logged after that day's digest went out is posted
      //    immediately on its own (the digest already covers CRITs present when it is sent).
      const slack = [];
      if (alerts.length && historyStore?.claimDigest?.(yday, { alerts: alerts.length, trigger })) {
        const r = await postSlack(buildSrAlertSlack(alerts, { day: yday, bankName }));
        if (r === "ok") historyStore.finishDigest(yday, { sentAt: Date.now(), result: r });
        else historyStore.releaseDigest(yday);
        slack.push(`daily digest (${alerts.length}): ${r}`);
      } else {
        const lateCrit = fresh.filter((a) => a.level === "CRIT");
        if (lateCrit.length) {
          const r = await postSlack(buildSrAlertSlack(lateCrit, { day: yday, bankName }));
          slack.push(`CRIT (${lateCrit.length}): ${r}`);
        }
      }
      if (slack.length) console.log(`[mdash] slack SR alerts ${yday}: ${slack.join("; ")}`);
      // History: Minto headline (title + governing thought); per-row lines as standouts.
      const head = alerts.length ? buildSrAlertHeadline(alerts, { day: yday, bankName }) : null;
      return {
        summary: head ? `${head.title} — ${head.text}` : `No WARN / CRIT rows for ${yday}.`,
        standouts: alerts.map((a) => fmtAlert(a, bankName)),
        actions: slack.map((x) => `Slack ${x}`),
        nextSteps: [],
        tables: [],
      };
    } catch (err) {
      console.warn("[mdash] breakdown alerts failed:", err.message);
      return { summary: `Alert computation failed: ${err.message}`, standouts: [], actions: [], nextSteps: [], tables: [] };
    }
  }

  function pumpParallel() {
    while (running < config.maxParallel && waiting.length) {
      const section = waiting.shift();
      if (jobs[section].status !== "queued") continue;
      running += 1;
      execute(section).finally(() => {
        running -= 1;
        pumpParallel();
      });
    }
  }

  /** Failed sections retry one at a time, after their delay. */
  async function pumpRetries() {
    if (retryWorkerBusy) return;
    retryWorkerBusy = true;
    try {
      while (retryQueue.length) {
        const section = retryQueue[0];
        const job = jobs[section];
        if (job.status !== "retry-wait") {
          retryQueue.shift();
          continue;
        }
        const wait = (job.nextRetryAt || 0) - Date.now();
        if (wait > 0) {
          await new Promise((r) => setTimeout(r, Math.min(wait, 1000)));
          continue;
        }
        retryQueue.shift();
        running += 1;
        try {
          await execute(section);
        } finally {
          running -= 1;
          pumpParallel();
        }
      }
    } finally {
      retryWorkerBusy = false;
    }
  }

  function startSection(section, duration, engineOverride, trigger = "manual") {
    stopSection(section, { silent: true });
    const job = jobs[section];
    // A queued / retry-waiting run replaced by this one never ran to the end.
    if (job.historyId && ["queued", "retry-wait"].includes(job.status)) {
      historyStore?.update(job.historyId, { event: "cancelled", error: "Superseded by a newer run" });
    }
    Object.assign(job, {
      status: "queued",
      duration,
      engine: chooseEngine(section, duration, config, engineOverride),
      engineOverride: engineOverride || null,
      trigger,
      attempt: 0,
      queuedAt: Date.now(),
      error: null,
      progress: null,
      state: null,
      nextRetryAt: null,
      startedAt: null,
      finishedAt: null,
    });
    const title = SECTION_META[section].title;
    job.historyId =
      historyStore?.start({
        dashboard: "morning",
        section,
        sectionTitle: `${SECTION_NUMBER[section]} · ${title}`,
        subject: `${title} — ${durationLabel(duration)}${trigger === "schedule" ? " (auto)" : ""}`,
        taskName: `Morning Dashboard · Section ${SECTION_NUMBER[section]} · ${title} (${durationLabel(duration)})`,
        trigger,
        durationLabel: durationLabel(duration),
        engine: job.engine,
        rerun: { section, duration },
      }) || null;
    waiting.push(section);
  }

  function stopSection(section, { silent } = {}) {
    const job = jobs[section];
    const idx = retryQueue.indexOf(section);
    if (idx >= 0) retryQueue.splice(idx, 1);
    const w = waiting.indexOf(section);
    if (w >= 0) waiting.splice(w, 1);
    if (job.controller) {
      job.controller.abort(new Error("Stopped by user"));
    } else if (!silent && ["queued", "retry-wait"].includes(job.status)) {
      job.status = "cancelled";
      job.error = "Stopped by user";
      job.finishedAt = Date.now();
      historyStore?.update(job.historyId, { event: "cancelled", error: "Stopped by user" });
    }
  }

  const pickSections = (list) => {
    const arr = Array.isArray(list) && list.length ? list : SECTIONS;
    const bad = arr.filter((s) => !SECTIONS.includes(s));
    if (bad.length) throw new Error(`Unknown section(s): ${bad.join(", ")}`);
    return arr;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  // On Ctrl-C / kill, cancel in-flight queries so they don't keep running on the
  // live switch DB or Trino after the backend is gone.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      const live = SECTIONS.filter((s) => jobs[s].controller);
      live.forEach((s) => jobs[s].controller.abort(new Error("Backend shutting down")));
      setTimeout(() => process.exit(sig === "SIGINT" ? 130 : 143), live.length ? 1500 : 0);
    });
  }

  // ── Refresh schedule ──
  // Runs on the backend only (never because a page was opened). Each section's rule
  // re-runs its *default* duration; a manual run with another duration is kept until
  // the next slot / interval. Redash (live switch DB) is never scheduled.

  const tzMs = () => config.tzOffsetMinutes * 60000;
  const wallNowMs = () => Date.now() + tzMs();
  const slotRealMs = (day, hm) => wallToMs(`${day} ${hm}:00`) - tzMs();
  const doneSlots = {}; // section -> "YYYY-MM-DD HH:MM" of the last slot handled
  const lastScheduled = {}; // section -> epoch ms of the last scheduled start (failure backoff)

  /** What the schedule would do for a section right now: { due, nextAt, note }. */
  function scheduleStatus(section) {
    const sch = config.schedule || {};
    const rule = sch.rules?.[section];
    if (!sch.enabled) return { note: "schedule paused" };
    if (!rule || rule.type === "off") return { note: "manual only" };
    const dur = durationFor(section);
    if (chooseEngine(section, dur, config) === "redash") return { note: "manual only (Redash)" };
    const w = wallNowMs();
    const today = fmtWall(w).slice(0, 10);
    const nowHM = fmtWall(w).slice(11, 16);
    const last = results[section]?.ranAt || 0;
    if (rule.type === "daily") {
      const slots = [...rule.at].sort();
      const passed = slots.filter((t) => t <= nowHM);
      if (passed.length) {
        const slot = passed[passed.length - 1];
        const key = `${today} ${slot}`;
        if (doneSlots[section] !== key && last < slotRealMs(today, slot)) return { due: true, slotKey: key, rule, dur };
      }
      const upcoming = slots.find((t) => t > nowHM);
      const tomorrow = fmtWall(w + 86400000).slice(0, 10);
      return { rule, dur, nextAt: upcoming ? slotRealMs(today, upcoming) : slotRealMs(tomorrow, slots[0]) };
    }
    const [startHM, endHM] = sch.activeHours || ["00:00", "23:59"];
    const everyMs = Number(rule.everyMin) * 60000;
    const inHours = nowHM >= startHM && nowHM < endHM;
    const dueAt = last + everyMs;
    // If the last scheduled attempt failed, wait min(interval, 15 min) before trying again.
    const backoffUntil = (lastScheduled[section] || 0) + Math.min(everyMs, 15 * 60000);
    if (inHours && Date.now() >= dueAt && Date.now() >= backoffUntil) return { due: true, rule, dur };
    // Next run: when due, clipped into active hours.
    let next = Math.max(dueAt, Date.now());
    const nextHM = fmtWall(next + tzMs()).slice(11, 16);
    if (!(nextHM >= startHM && nextHM < endHM)) {
      const day = fmtWall(next + tzMs()).slice(0, 10);
      const startToday = slotRealMs(day, startHM);
      next = next < startToday ? startToday : slotRealMs(fmtWall(next + tzMs() + 86400000).slice(0, 10), startHM);
    }
    return { rule, dur, nextAt: next };
  }

  function scheduleTick() {
    let started = false;
    for (const section of SECTIONS) {
      if (ACTIVE_STATUSES.has(jobs[section].status)) continue;
      const st = scheduleStatus(section);
      if (!st.due) continue;
      if (st.slotKey) doneSlots[section] = st.slotKey;
      lastScheduled[section] = Date.now();
      console.log(`[mdash] scheduled refresh: ${section} (${st.dur})`);
      startSection(section, st.dur, undefined, "schedule");
      started = true;
    }
    if (started) pumpParallel();
  }
  const ACTIVE_STATUSES = new Set(["queued", "running", "retry-wait"]);
  setTimeout(scheduleTick, 20000).unref?.();
  setInterval(scheduleTick, 60000).unref?.();

  // ── Routes ──

  app.get(
    "/api/mdash/state",
    handle(() => ({
      now: Date.now(),
      config,
      durations: Object.keys(DURATIONS),
      durationOptions: Object.fromEntries(
        SECTIONS.map((s) => [s, Object.entries(durationsFor(s)).map(([key, spec]) => ({ key, kind: spec.kind }))])
      ),
      jobs: Object.fromEntries(SECTIONS.map((s) => [s, publicJob(jobs[s])])),
      results,
      retryQueue,
      schedule: Object.fromEntries(SECTIONS.map((sec) => {
        const st = scheduleStatus(sec);
        return [sec, { nextAt: st.due ? Date.now() : st.nextAt || null, note: st.note || null, rule: st.rule || null }];
      })),
    }))
  );

  app.post(
    "/api/mdash/run",
    handle((req) => {
      const { sections, durations, engine } = req.body || {};
      const list = pickSections(sections);
      for (const s of list) {
        const d = durationFor(s, durations);
        if (!durationsFor(s)[d]) throw new Error(`Invalid duration ${d} for ${s}`);
        startSection(s, d, engine);
      }
      pumpParallel();
      return { started: list };
    })
  );

  app.post(
    "/api/mdash/stop",
    handle((req) => {
      const list = pickSections(req.body?.sections);
      list.forEach((s) => stopSection(s));
      return { stopped: list };
    })
  );

  app.post(
    "/api/mdash/retry-now",
    handle((req) => {
      const s = pickSections([req.body?.section])[0];
      if (jobs[s].status !== "retry-wait") throw new Error(`${s} is not waiting to retry`);
      jobs[s].nextRetryAt = Date.now();
      void pumpRetries();
      return { ok: true };
    })
  );

  app.get("/api/mdash/config", handle(() => ({ config, defaults: DEFAULT_CONFIG, defaultSql: DEFAULT_SQL })));

  app.put(
    "/api/mdash/config",
    handle((req) => {
      const next = validateConfig(mergeConfig(config, req.body || {}));
      config = next;
      writeJsonFile(CONFIG_FILE, config);
      return { config };
    })
  );

  app.post(
    "/api/mdash/config/reset",
    handle(() => {
      config = validateConfig(mergeConfig(DEFAULT_CONFIG, {}));
      writeJsonFile(CONFIG_FILE, config);
      return { config };
    })
  );

  app.get(
    "/api/mdash/sql",
    handle((req) => {
      const section = pickSections([req.query.section])[0];
      const asked = String(req.query.duration || "");
      const duration = durationsFor(section)[asked] ? asked : durationFor(section);
      const engine = chooseEngine(section, duration, config, req.query.engine);
      const win = computeWindow(duration, config, Date.now(), engine, section);
      return {
        section,
        duration,
        engine,
        window: { from: win.from, to: win.to, bucketMin: win.bucketMin },
        overridden: Boolean(config.sqlOverrides?.[section]?.[engine]),
        template: templateFor(section, engine, config),
        rendered: renderSql(templateFor(section, engine, config), engine, win, config),
        note:
          engine === "redash"
            ? "Redash: id bounds are resolved at run time; the window is split into chunks and run per data source."
            : null,
      };
    })
  );

  app.get(
    "/api/mdash/connectivity",
    handle(async () => {
      const out = {};
      const t0 = Date.now();
      try {
        const rows = await runTrino("SELECT 1 AS ok", { signal: AbortSignal.timeout(30000), timeoutMs: 30000 });
        out.trino = { ok: rows?.[0]?.ok === 1, latencyMs: Date.now() - t0, host: safeHost(trinoEnv().url) };
      } catch (e) {
        out.trino = { ok: false, error: e.message, host: safeHost(trinoEnv().url), latencyMs: Date.now() - t0 };
      }
      const env = redashEnv(config);
      const t1 = Date.now();
      try {
        if (!env.url || !env.key) throw new Error("PTYES_REDASH_URL / PTYES_REDASH_API_KEY not set");
        const res = await fetch(`${env.url}/api/data_sources`, {
          headers: { Authorization: `Key ${env.key}` },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        const byId = Object.fromEntries(list.map((d) => [d.id, d]));
        out.redash = {
          ok: config.redash.dataSourceIds.every((id) => byId[id]),
          latencyMs: Date.now() - t1,
          host: safeHost(env.url),
          dataSources: config.redash.dataSourceIds.map((id) => ({
            id,
            name: byId[id]?.name || null,
            found: Boolean(byId[id]),
            paused: Boolean(byId[id]?.paused),
          })),
          available: list.map((d) => ({ id: d.id, name: d.name, type: d.type })),
        };
      } catch (e) {
        out.redash = { ok: false, error: e.message, host: safeHost(env.url), latencyMs: Date.now() - t1 };
      }
      out.checkedAt = Date.now();
      return out;
    })
  );

  app.get(
    "/api/mdash/freshness",
    handle(async () => {
      const win = computeWindow("2d", config);
      const one = (table, extra) =>
        `SELECT '${table}' AS tbl, format_datetime(MAX(created_on), 'yyyy-MM-dd HH:mm:ss') AS max_created_on
FROM switch.${table}
WHERE dl_last_updated >= DATE '${win.fromDate}' AND created_on >= TIMESTAMP '${win.from}'${extra}`;
      const sql = `${one("txn_info_snapshot_v3", "")}\nUNION ALL\n${one("txn_participants_snapshot_v3", " AND participant_type = 'PAYER'")}`;
      const rows = await runTrino(sql, { signal: AbortSignal.timeout(180000), timeoutMs: 180000 });
      const by = Object.fromEntries(rows.map((r) => [r.tbl, r.max_created_on]));
      const txn = by.txn_info_snapshot_v3 || null;
      const participants = by.txn_participants_snapshot_v3 || null;
      return {
        trinoMaxCreatedOn: txn && participants ? (txn < participants ? txn : participants) : txn || participants,
        tables: { txn_info: txn, txn_participants: participants },
        nowIst: fmtWall(Date.now() + config.tzOffsetMinutes * 60000),
      };
    })
  );

  app.post(
    "/api/mdash/cache/clear",
    handle(() => {
      for (const k of Object.keys(results)) delete results[k];
      writeJsonFile(RESULTS_FILE, results);
      return { ok: true };
    })
  );

  app.get("/api/mdash/history", handle(() => ({ history })));

  // Used by the History tab's Re-run: same section, same duration, manual trigger.
  return {
    rerun({ section, duration }) {
      if (!SECTIONS.includes(section)) throw new Error(`Unknown section ${section}`);
      const d = durationsFor(section)[duration] ? duration : durationFor(section);
      startSection(section, d, undefined, "manual");
      pumpParallel();
      return { started: `${SECTION_META[section].title} — ${durationLabel(d)}` };
    },
  };

}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
