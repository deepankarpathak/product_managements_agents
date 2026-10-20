// Unified SR Dashboard — Morning Dashboard + Success Rate Snippet merged into one page.
//
// Same engine as the retired Morning Dashboard (one query per section, Trino / Redash, retry queue,
// backend refresh schedule, results cached on disk), with merged sections:
//   breakdown  A  impact-ranked SR breakdown (Looker, 10d) — per payer handle × flow
//   declines   B  ₹ value of failed txns per code (raw txns, latest complete day)
//   codes      B  failures per code since the 1st of last month (Looker) — MTD / LMTD contribution
//   raw        C/D/E  intraday SR by handle × flow, error codes (FAILURE-only and every
//                     non-success) and U09 — one raw-txn scan, the page derives each card
//   dims       C/G/H  day-level SR by flow / payee PSP / instrument, per handle × flow (Looker)
//   bank       F  intraday payer-bank SR (raw txn_info ⨝ txn_participants)
//   bankday    F  day-level payer-bank SR, per handle × flow (Looker)
//   share      I  txn count / % share across handles (Looker DTU / TPU)
//
// Day-level (Looker) sections group by payer handle and flow so the page can filter both
// without a re-query. Multi-shape results use GROUPING SETS: one table scan per query.
// Day-level sections run once a day (07:15) and re-run at 10:45 / 12:15 only if yesterday
// was missing or incomplete. Every run is written to the History tab ("unified"); the breakdown
// run posts the SR alert digest to Slack, scoped like the Morning Dashboard's (all payer handles,
// all flows, Morning PSP groups). The digest is claimed once per data day across dashboards, so
// Morning and Unified never both post it.
// Trino runs through trinoClient.js's runTrino so every dashboard shares one
// concurrency cap on the service account.
//
// Routes (all under /api/udash): same shape as /api/mdash.

import fs from "fs";
import path from "path";
import { runTrino } from "./trinoClient.js";
import { analyze } from "./historyInsights.js";
import { buildSrAlertHeadline, buildSrAlertSlack, buildSrAllClearSlack } from "./srAlertMessage.js";
import { computeAlerts, pickYday } from "../src/breakdown-math.mjs";
import { pspGroup } from "../src/unified-psp.mjs";
import { intradayBankAlerts, splitBankrep } from "./bankReport.js";

// ─── Constants ───────────────────────────────────────────────────────────────

// breakdown first so "Refresh all" queues it first (it feeds the KPI strip).
export const SECTIONS = ["breakdown", "declines", "codes", "dims", "raw", "bank", "bankday", "bankrep", "bankx", "share", "merchants", "bankalert", "bankdwh"];

export const BREAKDOWN_KINDS = ["psp", "bank", "instrument", "flow"];

export const SECTION_META = {
  // Day totals per (handle, flow, kind, dim) over 10 days + top failure codes per row,
  // and day-level failures per code (kind = "code", with NPCI description).
  breakdown: { title: "SR Breakdown (impact ranked)", keys: ["ts", "handle", "flow", "kind", "dim", "code", "descr"], sums: ["total", "success"], daily: true },
  declines: { title: "Decline codes · ₹ amount", keys: ["ts", "handle", "flow", "code"], sums: ["cnt", "amount"], daily: true },
  codes: { title: "Decline codes · MTD / LMTD", keys: ["ts", "handle", "flow", "code", "descr", "etype", "etype1"], sums: ["total", "success"], daily: true },
  // u09 = failures with an app_resp_code U09* (Looker; the raw sections also match npci_resp_code).
  dims: { title: "Flow / PSP / Instrument SR (day-level)", keys: ["ts", "handle", "flow", "kind", "dim"], sums: ["total", "success", "u09"], daily: true },
  // grp "tot": per (ts, handle, flow, txn category, status, u09) · grp "code": per (ts, status, acode, ecode).
  raw: { title: "Intraday SR / error codes / U09 (raw txns)", keys: ["ts", "grp", "handle", "flow", "cat", "status", "u09", "acode", "ecode"], sums: ["cnt"], buckets: { "1d": 30 } },
  // grp "bank": per (ts, payer bank, flow) · grp "psp": per (ts, payee PSP key) with U09 count.
  bank: { title: "Payer bank SR + U09 by payee PSP (intraday)", keys: ["ts", "grp", "bank", "flow", "psp"], sums: ["total", "success", "u09"], anchorParticipants: true },
  merchants: { title: "Merchants, MCC and payer banks by IFSC (raw, 2 days)", keys: ["ts", "grp", "vpa", "name", "mcc", "pbank", "flow"], sums: ["total", "success"], daily: true },
  // Live (Redash) — scheduled only when config.intradayBankAlert.enabled.
  bankalert: { title: "Live payer-bank check (failed txns only)", keys: ["ts", "grp", "bank", "code"], sums: ["total", "success"], buckets: { "1h": 30, "12h": 30 } },
  // DWH payer-bank check: the latest 12 hours the DWH has (participants lag ~12h — the window is
  // anchored to their freshness), exact per-bank attempts. grp all (ts) · att (ts, bank) · fail (ts, bank, code).
  // grp-less: code '' = totals, else failures (+ successes of that code) per response code.
  bankx: { title: "Payer banks inside Looker \"Others\" (raw, 10 days)", keys: ["ts", "handle", "flow", "bank", "code"], sums: ["total", "success"], daily: true },
  bankdwh: { title: "DWH payer-bank check (12h)", keys: ["ts", "grp", "bank", "code"], sums: ["total", "success"], buckets: { "12h": 30 }, anchorParticipants: true },
  // Payer bank report: grp base (ts, bank, handle, flow) · etype · os · instrument · code — see bankReport.js.
  bankrep: { title: "Payer bank report (day-level)", keys: ["ts", "bank", "grp", "handle", "flow", "dim", "ctype", "descr"], sums: ["total", "success"], daily: true },
  bankday: { title: "Payer bank SR (day-level)", keys: ["ts", "handle", "flow", "bank"], sums: ["total", "success"], daily: true },
  share: { title: "Txn Count / % Share Across Handles", keys: ["ts"], sums: "*", daily: true },
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

// kind "intraday" = raw txn tables (minutes); kind "daily" = Looker day-level table
// (complete days). days "lmtd" = from the earlier of (1st of last month, today − 10d).
const intra = (keys) => Object.fromEntries(keys.map((k) => [k, { kind: "intraday", minutes: DURATIONS[k] }]));
const daily = (spec) => Object.fromEntries(Object.entries(spec).map(([k, n]) => [k, { kind: "daily", days: n }]));
const ALL_INTRADAY = intra(Object.keys(DURATIONS));

export const SECTION_DURATIONS = {
  breakdown: daily({ "10d": 10 }),
  declines: daily({ "1d": 1 }),
  codes: daily({ mtd: "lmtd" }),
  dims: daily({ mtd: "lmtd", "90d": 90, "180d": 180 }),
  raw: ALL_INTRADAY,
  bank: intra(["15m", "1h", "4h", "12h", "1d"]),
  bankday: daily({ "2d": 2, "3d": 3, "7d": 7, "15d": 15, "30d": 30 }),
  merchants: daily({ "2d": 2 }),
  bankrep: daily({ mtd: "lmtd" }),
  bankalert: intra(["1h", "12h"]),
  bankdwh: intra(["12h"]),
  bankx: daily({ "10d": 10 }),
  share: daily({ "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90, "180d": 180 }),
};

const durationsFor = (section) => SECTION_DURATIONS[section] || ALL_INTRADAY;
const specFor = (section, key) => durationsFor(section)[key];

// Raw-txn slots are 15 min after the Morning Dashboard's so the two don't hit Trino together.
const RAW_SLOTS = ["07:15", "10:45", "15:15", "19:45", "23:15"];
// Day-level: one run at 07:15; the later slots re-run only if yesterday is missing / incomplete.
const DAY_RULE = { type: "daily", at: ["07:15"], recheck: ["10:45", "12:15"] };

// Saved configs from an older section list drop their per-section schedule / durations.
const CONFIG_VERSION = 9;

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  handles: ["ptyes", "ptaxis", "pthdfc", "ptsbi"],
  defaultDuration: "2d",
  sectionDurations: {
    breakdown: "10d",
    declines: "1d",
    codes: "mtd",
    dims: "90d",
    raw: "2d",
    bank: "1d",
    bankday: "7d",
    merchants: "2d",
    bankrep: "mtd",
    bankalert: "12h",
    bankdwh: "12h",
    bankx: "10d",
    share: "7d",
  },
  // Backend refresh schedule (IST). recheck slots run only when the
  // last result is missing yesterday or yesterday's volume is < 70% of the prior-week median.
  schedule: {
    enabled: true,
    activeHours: ["07:00", "23:30"],
    rules: {
      breakdown: DAY_RULE,
      declines: DAY_RULE,
      codes: DAY_RULE,
      dims: DAY_RULE,
      raw: { type: "daily", at: RAW_SLOTS },
      bank: { type: "daily", at: RAW_SLOTS },
      bankday: DAY_RULE,
      // Raw participants lag ~12h in the DWH: run after yesterday has fully landed.
      merchants: { type: "daily", at: ["13:15"] },
      bankrep: DAY_RULE,
      bankx: DAY_RULE,
      // Every 12 hours over the previous 12 hours, only while intradayBankAlert.enabled (live switch DB).
      bankalert: { type: "daily", at: ["10:00", "22:00"] },
      // DWH (Trino) — a few seconds, no live-DB load; hourly within activeHours, each run looking back
      // 12h (so overnight incidents surface at 07:00). One Slack post per bank incident.
      bankdwh: { type: "interval", everyMin: 60 },
      share: DAY_RULE,
    },
  },
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
  redashEndLagMinutes: 5,
  sqlOverrides: {},
  // Live payer-bank alert (Redash on the switch DB, failed txns only — off until switched on).
  // Runs at 10:00 and 22:00 over the previous 12h; a bank alerts when its estimated SR gap to overall
  // is ≥ dropPp worse than normal for ≥ 60 min (≥ minTxns est. attempts per 30-min bucket, ≥ minLost
  // txns lost). One Slack post per bank incident per cooldownMin. Manual runs never post.
  intradayBankAlert: { enabled: false, dropPp: 2, minTxns: 300, minLost: 200, cooldownMin: 720 },
  // DWH payer-bank alert (Trino, the latest 12h the DWH has; the window ends at the DWH participants'
  // freshness — measured ~30 min to ~12h behind real time): same rules,
  // exact attempts. Runs hourly (07:00–23:30) over the latest 12h; Slack post per new bank incident.
  // Manual runs never post.
  dwhBankAlert: { enabled: true, dropPp: 2, minTxns: 300, minLost: 200 },
  // Payer banks (IFSC prefix) that the Looker table files under "Others", broken out in A from raw txns.
  othersBreakout: ["JIOP", "NESF", "SURY", "NSPB"],
};

// ─── SQL templates ───────────────────────────────────────────────────────────
// Placeholders as in the retired Morning Dashboard. Every section returns raw integer counts.

const TRINO_T = `WITH t AS (
  SELECT txn_id, created_on, status, app_resp_code, npci_resp_code, psp_handle AS handle, category AS cat,
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

const REDASH_FROM_JOIN = `FROM txn_participants tp FORCE INDEX (PRIMARY)
STRAIGHT_JOIN txn_info ti ON ti.txn_id = tp.txn_id
${REDASH_WHERE_TI}
  AND tp.id >= {{TP_ID_FROM}} AND tp.id < {{TP_ID_TO}}
  AND tp.participant_type = 'PAYER'`;

const REDASH_FLOW = `CASE WHEN ti.category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END`;

const LOOKER_TXNS = `FROM team_product.LOOKER_TPAP_Txns_V3
WHERE dt >= DATE '{{FROM_DATE}}'
  AND dt <  DATE '{{TO_DATE}}'`;

// Day-level sections keep every payer handle (ptyes / ptaxis / ptsbi / pthdfc / paytm)
// and flow (P2P / P2M / LITE) as columns; the page filters them.
const L_HANDLE = "lower(payer_handle)";
const L_FLOW = "COALESCE(p2p_p2m_flag, 'Others')";

// Payee PSP: every handle that either source report names is kept as its own key, the
// rest are 'others'. The page maps keys to the Morning grouping (PhonePe / GooglePay /
// AmazonPay / CRED / … / each Paytm handle) or the Snippet's 4 groups — see src/unified-psp.mjs.
export const PSP_HANDLES = [
  "paytm", "ptyes", "ptsbi", "pthdfc", "ptaxis", "ptybl", "pty", "ptys",
  "ybl", "ibl", "axl",
  "okbizaxis", "okbizicici", "okbizhdfcbank", "okbizsbi", "okaxis", "okicici", "okhdfcbank", "oksbi", "okpayaxis",
  "apl", "yapl", "rapl", "axisb", "yescred", "naviaxis", "superyes", "fkaxis",
];
const pspKeyOf = (col) => `CASE WHEN lower(${col}) IN (${PSP_HANDLES.map((h) => `'${h}'`).join(", ")}) THEN lower(${col}) ELSE 'others' END`;
export const PSP_KEY = pspKeyOf("payee_handle");

export const BD_DIMS = {
  psp: PSP_KEY,
  bank: "COALESCE(NULLIF(trim(payer_bank), ''), 'Others')",
  instrument: "COALESCE(payer_instrument, 'Others')",
  flow: L_FLOW,
};
// One scan: grouping sets per kind (totals + per-code failures). The flow kind's per-code
// rows are also the day-level failures per code (kind "code", with description) — see
// expandBreakdown().
const BREAKDOWN_LOOKER = `WITH b AS (
  SELECT
    dt,
    ${L_HANDLE} AS handle,
    ${L_FLOW} AS flow,
${BREAKDOWN_KINDS.filter((k) => k !== "flow").map((k) => `    ${BD_DIMS[k]} AS ${k}`).join(",\n")},
    COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
    description,
    txn_init,
    success
  ${LOOKER_TXNS.replace(/\n/g, "\n  ")}
)
SELECT
  CAST(dt AS varchar) AS ts,
  handle,
  flow,
  CASE WHEN grouping(psp) = 0 THEN 'psp' WHEN grouping(bank) = 0 THEN 'bank' WHEN grouping(instrument) = 0 THEN 'instrument' ELSE 'flow' END AS kind,
  CASE WHEN grouping(psp) = 0 THEN psp WHEN grouping(bank) = 0 THEN bank WHEN grouping(instrument) = 0 THEN instrument ELSE flow END AS dim,
  CASE WHEN grouping(code) = 0 THEN code ELSE '' END AS code,
  CASE WHEN grouping(psp, bank, instrument, code) = 14 THEN COALESCE(max(description), '') ELSE '' END AS descr,
  SUM(txn_init) AS total,
  SUM(success)  AS success
FROM b
GROUP BY GROUPING SETS (
  (dt, handle, flow, psp), (dt, handle, flow, psp, code),
  (dt, handle, flow, bank), (dt, handle, flow, bank, code),
  (dt, handle, flow, instrument), (dt, handle, flow, instrument, code),
  (dt, handle, flow), (dt, handle, flow, code)
)
HAVING grouping(code) = 1 OR SUM(txn_init) > SUM(success)`;

/** Flow-kind per-code rows → also kind "code" rows (dim = code, with description). */
function expandBreakdown(rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind === "flow" && r.code) {
      out.push({ ...r, descr: "" });
      out.push({ ...r, kind: "code", dim: r.code, code: "", descr: r.descr || "" });
    } else out.push(r);
  }
  return out;
}
const POST = { breakdown: expandBreakdown };

export const DEFAULT_SQL = {
  breakdown: { looker: BREAKDOWN_LOOKER },
  // Raw txns (Paytm payer handles): failed txn count and ₹ value per code, complete days.
  declines: {
    looker: `SELECT
  ts,
  handle,
  flow,
  code,
  COUNT(*)    AS cnt,
  SUM(amount) AS amount
FROM (
  SELECT DISTINCT
    txn_id,
    CAST(CAST(created_on AS date) AS varchar) AS ts,
    psp_handle AS handle,
    CASE WHEN category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END AS flow,
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
GROUP BY 1, 2, 3, 4`,
  },
  // Failures per code since the 1st of last month (MTD / LMTD contribution).
  // Failures per code since the 1st of last month (MTD / LMTD contribution), with the Looker
  // decline type: etype TD / BD / RD / Others, etype1 e.g. "TD Bank", "TD PSP", "RD NPCI".
  codes: {
    looker: `SELECT
  CAST(dt AS varchar) AS ts,
  ${L_HANDLE} AS handle,
  ${L_FLOW} AS flow,
  COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
  COALESCE(max(description), '') AS descr,
  COALESCE(max(error_type), '') AS etype,
  COALESCE(max(error_type_1), '') AS etype1,
  SUM(txn_init) AS total,
  SUM(success)  AS success
${LOOKER_TXNS}
GROUP BY 1, 2, 3, 4
HAVING SUM(txn_init) > SUM(success)`,
  },
  // One scan: SR per day × handle × flow, and by payee PSP, payer instrument, sub-flow
  // (Looker category: VPA2VPA, Paytm QR, 3P QR, Intent, ONUS, …), OS and Paytm Postpaid
  // (CREDITLINE whose payer bank is SURY — the Looker table files it under "Others").
  dims: {
    looker: `WITH b AS (
  SELECT
    dt,
    ${L_HANDLE} AS handle,
    ${L_FLOW} AS flow,
    ${PSP_KEY} AS psp,
    COALESCE(payer_instrument, 'Others') AS instrument,
    COALESCE(NULLIF(trim(category), ''), 'Others') AS sub,
    COALESCE(NULLIF(trim(os_type), ''), 'others') AS os,
    CASE WHEN payer_instrument = 'CREDITLINE' AND COALESCE(NULLIF(trim(payer_bank), ''), 'Others') IN ('Others', 'SURY') THEN 'Paytm Postpaid' END AS pp,
    CASE WHEN app_resp_code LIKE '{{U09_PATTERN}}' THEN txn_init - success ELSE 0 END AS u09,
    txn_init,
    success
  ${LOOKER_TXNS.replace(/\n/g, "\n  ")}
)
SELECT
  CAST(dt AS varchar) AS ts,
  handle,
  flow,
  CASE WHEN grouping(psp) = 0 THEN 'psp' WHEN grouping(instrument) = 0 THEN 'instrument' WHEN grouping(sub) = 0 THEN 'sub'
       WHEN grouping(os) = 0 THEN 'os' WHEN grouping(pp) = 0 THEN 'pp' ELSE 'flow' END AS kind,
  CASE WHEN grouping(psp) = 0 THEN psp WHEN grouping(instrument) = 0 THEN instrument WHEN grouping(sub) = 0 THEN sub
       WHEN grouping(os) = 0 THEN os WHEN grouping(pp) = 0 THEN pp ELSE flow END AS dim,
  SUM(txn_init) AS total,
  SUM(success)  AS success,
  SUM(u09)      AS u09
FROM b
GROUP BY GROUPING SETS ((dt, handle, flow), (dt, handle, flow, psp), (dt, handle, flow, instrument), (dt, handle, flow, sub), (dt, handle, flow, os), (dt, handle, flow, pp))
HAVING grouping(pp) = 1 OR pp IS NOT NULL`,
  },
  bankday: {
    looker: `SELECT
  CAST(dt AS varchar)            AS ts,
  ${L_HANDLE}                    AS handle,
  ${L_FLOW}                      AS flow,
  COALESCE(payer_bank, 'Others') AS bank,
  SUM(txn_init)                  AS total,
  SUM(success)                   AS success
${LOOKER_TXNS}
GROUP BY 1, 2, 3, 4`,
  },
  share: {
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
  // One scan for cards C (SR by handle × flow), D (error codes, FAILURE-only and every
  // non-success) and E (U09). Codes are blanked on successful txns so they don't multiply rows.
  raw: {
    trino: `${TRINO_T},
x AS (
  SELECT
    {{BUCKET}} AS ts,
    t.txn_id,
    t.handle,
    t.flow,
    t.cat,
    t.status,
    CASE WHEN t.app_resp_code LIKE '{{U09_PATTERN}}' OR t.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END AS u09,
    CASE WHEN t.status = 'SUCCESS' THEN '' ELSE COALESCE(NULLIF(t.app_resp_code, ''), '') END AS acode,
    CASE WHEN t.status = 'SUCCESS' THEN '' ELSE COALESCE(NULLIF(t.{{ERROR_COL}}, ''), '') END AS ecode
  FROM t
)
SELECT
  ts,
  CASE WHEN grouping(handle) = 0 THEN 'tot' ELSE 'code' END AS grp,
  COALESCE(handle, '') AS handle,
  COALESCE(flow, '')   AS flow,
  COALESCE(cat, '')    AS cat,
  status,
  COALESCE(u09, 0)     AS u09,
  COALESCE(acode, '')  AS acode,
  COALESCE(ecode, '')  AS ecode,
  COUNT(DISTINCT txn_id) AS cnt
FROM x
GROUP BY GROUPING SETS ((ts, handle, flow, cat, status, u09), (ts, status, acode, ecode))`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  'tot' AS grp,
  ti.psp_handle AS handle,
  ${REDASH_FLOW} AS flow,
  ti.category AS cat,
  ti.status AS status,
  CASE WHEN ti.app_resp_code LIKE '{{U09_PATTERN}}' OR ti.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END AS u09,
  '' AS acode,
  '' AS ecode,
  COUNT(*) AS cnt
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 3, 4, 5, 6, 7
UNION ALL
SELECT
  {{BUCKET}} AS ts,
  'code' AS grp,
  '' AS handle,
  '' AS flow,
  '' AS cat,
  ti.status AS status,
  0 AS u09,
  CASE WHEN ti.status = 'SUCCESS' THEN '' ELSE COALESCE(NULLIF(ti.app_resp_code, ''), '') END AS acode,
  CASE WHEN ti.status = 'SUCCESS' THEN '' ELSE COALESCE(NULLIF(ti.{{ERROR_COL}}, ''), '') END AS ecode,
  COUNT(*) AS cnt
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1, 6, 8, 9`,
  },
  // One participants scan for two cards: payer-bank SR (grp "bank", card F) and U09 by
  // payee PSP (grp "psp", card E). Remitter bank = first 4 chars of payer IFSC (bank_code),
  // falling back to detail_2; payee PSP key from the payee participant's handle.
  bank: {
    trino: `${TRINO_T}${TRINO_P},
pe AS (
  SELECT txn_id, arbitrary(handle) AS handle
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM_PAD}}'
    AND created_on <  TIMESTAMP '{{TO_PAD}}'
    AND participant_type = 'PAYEE'
  GROUP BY txn_id
),
x AS (
  SELECT
    {{BUCKET}} AS ts,
    t.txn_id,
    t.status,
    t.flow,
    UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) AS bank,
    ${pspKeyOf("pe.handle")} AS psp,
    CASE WHEN t.app_resp_code LIKE '{{U09_PATTERN}}' OR t.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END AS u09
  FROM t
  JOIN p ON t.txn_id = p.txn_id
  LEFT JOIN pe ON t.txn_id = pe.txn_id
)
SELECT
  ts,
  CASE WHEN grouping(bank) = 0 THEN 'bank' ELSE 'psp' END AS grp,
  COALESCE(bank, '') AS bank,
  COALESCE(flow, '') AS flow,
  COALESCE(psp, '')  AS psp,
  COUNT(DISTINCT txn_id) AS total,
  COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN txn_id END) AS success,
  COUNT(DISTINCT CASE WHEN u09 = 1 THEN txn_id END) AS u09
FROM x
GROUP BY GROUPING SETS ((ts, bank, flow), (ts, psp, flow))`,
    redash: `SELECT
  {{BUCKET}} AS ts,
  'bank' AS grp,
  UPPER(LEFT(COALESCE(NULLIF(tp.bank_code, ''), tp.detail_2, 'UNKN'), 4)) AS bank,
  ${REDASH_FLOW} AS flow,
  '' AS psp,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN ti.app_resp_code LIKE '{{U09_PATTERN}}' OR ti.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END) AS u09
${REDASH_FROM_JOIN}
GROUP BY 1, 3, 4
UNION ALL
SELECT
  {{BUCKET}} AS ts,
  'psp' AS grp,
  '' AS bank,
  ${REDASH_FLOW} AS flow,
  ${pspKeyOf("tp.handle")} AS psp,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN ti.app_resp_code LIKE '{{U09_PATTERN}}' OR ti.npci_resp_code LIKE '{{U09_PATTERN}}' THEN 1 ELSE 0 END) AS u09
${REDASH_FROM_JOIN.replace("'PAYER'", "'PAYEE'")}
GROUP BY 1, 4, 5`,
  },
  // Payer banks the Looker table files under "Others" (config.othersBreakout), from raw txns ⨝
  // PAYER participants over 10 complete days: per day × handle × flow × bank, totals (code '')
  // and failures per response code. The page adds them to A as their own payer-bank rows and
  // takes them out of "Others".
  bankx: {
    looker: `${TRINO_T}${TRINO_P},
x AS (
  SELECT
    CAST(CAST(t.created_on AS date) AS varchar) AS ts,
    t.handle,
    t.flow,
    UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) AS bank,
    t.txn_id,
    t.status,
    COALESCE(NULLIF(trim(t.app_resp_code), ''), '(blank)') AS code
  FROM t
  JOIN p ON t.txn_id = p.txn_id
  WHERE UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) IN ({{BREAKOUT}})
)
SELECT
  ts,
  handle,
  flow,
  bank,
  CASE WHEN grouping(code) = 0 THEN code ELSE '' END AS code,
  COUNT(DISTINCT txn_id) AS total,
  COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN txn_id END) AS success
FROM x
GROUP BY GROUPING SETS ((ts, handle, flow, bank), (ts, handle, flow, bank, code))
HAVING grouping(code) = 1 OR COUNT(DISTINCT CASE WHEN status <> 'SUCCESS' THEN txn_id END) > 0`,
  },
  // Payer bank report, one scan: per bank × day × handle × flow, plus per bank × day by OS,
  // instrument, decline type (failures) and error code (failures, with type and description).
  bankrep: {
    looker: `WITH b AS (
  SELECT
    dt,
    COALESCE(NULLIF(trim(payer_bank), ''), 'Others') AS bank,
    ${L_HANDLE} AS handle,
    ${L_FLOW} AS flow,
    COALESCE(NULLIF(trim(os_type), ''), 'others') AS os,
    COALESCE(payer_instrument, 'Others') AS instrument,
    COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') AS code,
    COALESCE(NULLIF(trim(error_type), ''), 'Unclassified') AS etype,
    description,
    txn_init,
    success
  ${LOOKER_TXNS.replace(/\n/g, "\n  ")}
)
SELECT
  CAST(dt AS varchar) AS ts,
  bank,
  CASE WHEN grouping(handle) = 0 THEN 'base' WHEN grouping(os) = 0 THEN 'os' WHEN grouping(instrument) = 0 THEN 'instrument'
       WHEN grouping(code) = 0 THEN 'code' ELSE 'etype' END AS grp,
  COALESCE(handle, '') AS handle,
  COALESCE(flow, '') AS flow,
  CASE WHEN grouping(os) = 0 THEN os WHEN grouping(instrument) = 0 THEN instrument WHEN grouping(code) = 0 THEN code
       WHEN grouping(etype) = 0 THEN etype ELSE '' END AS dim,
  CASE WHEN grouping(code) = 0 THEN COALESCE(max(etype), '') ELSE '' END AS ctype,
  CASE WHEN grouping(code) = 0 THEN COALESCE(max(description), '') ELSE '' END AS descr,
  SUM(txn_init) AS total,
  SUM(success)  AS success
FROM b
GROUP BY GROUPING SETS ((dt, bank, handle, flow), (dt, bank, os), (dt, bank, instrument), (dt, bank, etype), (dt, bank, code))
HAVING (grouping(code) = 1 AND grouping(etype) = 1) OR SUM(txn_init) > SUM(success)`,
  },
  // Yesterday + the day before, raw txns ⨝ participants (one scan for PAYER and PAYEE):
  //   grp "mcc"      SR by payee MCC per flow (the page shows P2M)
  //   grp "merchant" per merchant (P2M payee VPA) with ≥ 20 failures on a day
  //   grp "pbank"    SR by payer bank = IFSC prefix, per flow — splits the Looker table's
  //                  "Others" payer bank into the banks it hides.
  // Runs at 13:15 so the DWH participants table (lags ~12h) has all of yesterday.
  merchants: {
    looker: `WITH t AS (
  SELECT txn_id, arbitrary(created_on) AS created_on, arbitrary(status) AS status, arbitrary(category) AS category
  FROM switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM}}'
    AND created_on <  TIMESTAMP '{{TO}}'
    AND business_type IS NULL
    AND type IN ('PAY', 'COLLECT')
    AND category IN ('VPA2VPA', 'VPA2ACCOUNT', 'VPA2MERCHANT')
    AND psp_handle IN ({{HANDLES}})
  GROUP BY txn_id
),
p AS (
  SELECT
    txn_id,
    max(CASE WHEN participant_type = 'PAYER' THEN UPPER(SUBSTR(COALESCE(NULLIF(bank_code, ''), detail_2, 'UNKN'), 1, 4)) END) AS pbank,
    max(CASE WHEN participant_type = 'PAYEE' THEN vpa END) AS vpa,
    max(CASE WHEN participant_type = 'PAYEE' THEN name END) AS name,
    max(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS mcc
  FROM switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{{FROM_DATE}}'
    AND created_on >= TIMESTAMP '{{FROM_PAD}}'
    AND created_on <  TIMESTAMP '{{TO_PAD}}'
    AND participant_type IN ('PAYER', 'PAYEE')
  GROUP BY txn_id
),
j AS (
  SELECT
    CAST(CAST(t.created_on AS date) AS varchar) AS ts,
    CASE WHEN t.category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'P2P' ELSE 'P2M' END AS flow,
    COALESCE(p.pbank, 'UNKN') AS pbank,
    CASE WHEN t.category = 'VPA2MERCHANT' THEN COALESCE(NULLIF(lower(p.vpa), ''), '(unknown)') END AS vpa,
    p.name,
    COALESCE(NULLIF(trim(p.mcc), ''), '(none)') AS mcc,
    t.status
  FROM t
  LEFT JOIN p ON p.txn_id = t.txn_id
)
SELECT
  ts,
  CASE WHEN grouping(vpa) = 0 THEN 'merchant' WHEN grouping(pbank) = 0 THEN 'pbank' ELSE 'mcc' END AS grp,
  COALESCE(vpa, '') AS vpa,
  CASE WHEN grouping(vpa) = 0 THEN COALESCE(max(name), '') ELSE '' END AS name,
  CASE WHEN grouping(mcc) = 0 THEN mcc WHEN grouping(vpa) = 0 THEN COALESCE(max(mcc), '') ELSE '' END AS mcc,
  CASE WHEN grouping(pbank) = 0 THEN pbank ELSE '' END AS pbank,
  CASE WHEN grouping(flow) = 0 THEN flow ELSE '' END AS flow,
  COUNT(*) AS total,
  SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
FROM j
GROUP BY GROUPING SETS ((ts, flow, mcc), (ts, vpa), (ts, flow, pbank))
HAVING grouping(vpa) = 1 OR (vpa IS NOT NULL AND COUNT(*) - SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) >= 20)`,
  },
  // DWH payer-bank check (Trino): 30-min buckets × payer bank (IFSC prefix), exact attempts, plus
  // failures by response code, over the latest 12h the DWH participants table has.
  bankdwh: {
    trino: `${TRINO_T}${TRINO_P},
x AS (
  SELECT
    {{BUCKET}} AS ts,
    t.txn_id,
    t.status,
    COALESCE(NULLIF(t.app_resp_code, ''), t.status) AS code,
    UPPER(SUBSTR(COALESCE(NULLIF(p.bank_code, ''), p.detail_2, 'UNKN'), 1, 4)) AS bank
  FROM t
  LEFT JOIN p ON t.txn_id = p.txn_id
)
SELECT
  ts,
  CASE WHEN grouping(bank) = 1 THEN 'all' WHEN grouping(code) = 0 THEN 'fail' ELSE 'att' END AS grp,
  COALESCE(bank, '') AS bank,
  COALESCE(code, '') AS code,
  COUNT(DISTINCT txn_id) AS total,
  COUNT(DISTINCT CASE WHEN status = 'SUCCESS' THEN txn_id END) AS success
FROM x
GROUP BY GROUPING SETS ((ts), (ts, bank), (ts, bank, code))
HAVING grouping(code) = 1 OR COUNT(DISTINCT CASE WHEN status <> 'SUCCESS' THEN txn_id END) > 0`,
  },
  // Live payer-bank check (Redash, switch DB), light: the payer participant is joined only for
  // FAILED txns (~7% of rows); overall attempts / successes come from txn_info alone. A bank's
  // attempts are estimated from its usual share of traffic (see bankReport.js intradayBankAlerts).
  //   grp "fail": failures per 30-min bucket × payer bank (IFSC prefix) × response code
  //   grp "all":  attempts / successes per bucket
  bankalert: {
    // Two passes over the same txn_info id range: failed rows with the payer bank, then totals.
    // (A single LEFT JOIN pass measured slower: MySQL still probes participants for every row.)
    redash: `SELECT
  {{BUCKET}} AS ts,
  'fail' AS grp,
  UPPER(LEFT(COALESCE(NULLIF(tp.bank_code, ''), tp.detail_2, 'UNKN'), 4)) AS bank,
  COALESCE(NULLIF(ti.app_resp_code, ''), ti.status) AS code,
  COUNT(*) AS total,
  0 AS success
FROM txn_info ti FORCE INDEX (PRIMARY)
STRAIGHT_JOIN txn_participants tp ON tp.txn_id = ti.txn_id AND tp.participant_type = 'PAYER'
  -- txn_participants is partitioned by day on system_timestamp: without this range each txn_id
  -- lookup probes every partition (~900); with it, one or two.
  AND tp.system_timestamp >= '{{FROM_PAD}}' AND tp.system_timestamp < '{{TO_PAD}}'
${REDASH_WHERE_TI}
  AND ti.status <> 'SUCCESS'
GROUP BY 1, 3, 4
UNION ALL
SELECT
  {{BUCKET}} AS ts,
  'all' AS grp,
  '' AS bank,
  '' AS code,
  COUNT(*) AS total,
  SUM(CASE WHEN ti.status = 'SUCCESS' THEN 1 ELSE 0 END) AS success
FROM txn_info ti FORCE INDEX (PRIMARY)
${REDASH_WHERE_TI}
GROUP BY 1`,
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
    // Complete days only: [today - N, today) in IST. "lmtd": from the earlier of the 1st of
    // last month (relative to yesterday) and today - 10 days, so MTD, LMTD, L7D and D-1…D-3 fit.
    const dayMs = 86400000;
    const toMs = Math.floor((nowMs + cfg.tzOffsetMinutes * 60000) / dayMs) * dayMs;
    let fromMs = toMs - spec.days * dayMs;
    if (spec.days === "lmtd") {
      const y = new Date(toMs - dayMs);
      fromMs = Math.min(Date.UTC(y.getUTCFullYear(), y.getUTCMonth() - 1, 1), toMs - 10 * dayMs);
    }
    const days = Math.round((toMs - fromMs) / dayMs);
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
  if (section === "bankalert") return "redash"; // live check: switch DB only, any window
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
    BREAKOUT: (cfg.othersBreakout || []).filter((b) => /^[A-Z0-9]{2,6}$/.test(b)).map((b) => `'${b}'`).join(", ") || "''",
    TI_ID_FROM: idBounds?.tiFrom ?? "{{TI_ID_FROM}}",
    TI_ID_TO: idBounds?.tiTo ?? "{{TI_ID_TO}}",
    TP_ID_FROM: idBounds?.tpFrom ?? "{{TP_ID_FROM}}",
    TP_ID_TO: idBounds?.tpTo ?? "{{TP_ID_TO}}",
  };
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

// ─── Row merging ─────────────────────────────────────────────────────────────

export function mergeRows(section, rows) {
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
// Runs per view (after handle / flow are aggregated away), exactly as in the retired Morning Dashboard.
const CODES_KEPT = 5;
const CODES_GLOBAL = 20;
export function trimBreakdown(rows) {
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

// A run that waited out the shared Trino queue gets no auto-retry — the next slot (or a
// manual Refresh) tries again instead of stacking more queued queries.
const QUEUE_BOUND = /too many queued queries|exceeded \d+s timeout/i;

/** Yesterday (IST) present with ≥ 70% of the median daily volume of the 7 days before it. */
function yesterdayComplete(rows, cfg) {
  const wall = Date.now() + cfg.tzOffsetMinutes * 60000;
  const yday = new Date(Math.floor(wall / 86400000) * 86400000 - 86400000).toISOString().slice(0, 10);
  const byDay = {};
  for (const r of rows) {
    const day = String(r.ts).slice(0, 10);
    const v = r.total ?? r.cnt ?? Object.entries(r).reduce((a, [k, x]) => (k === "ts" ? a : a + (Number(x) || 0)), 0);
    byDay[day] = (byDay[day] || 0) + (Number(v) || 0);
  }
  if (!byDay[yday]) return false;
  const prev = Object.keys(byDay)
    .filter((d) => d < yday)
    .sort()
    .slice(-7)
    .map((d) => byDay[d])
    .sort((a, b) => a - b);
  if (prev.length < 3) return true;
  return byDay[yday] >= 0.7 * prev[Math.floor(prev.length / 2)];
}

// ─── Views (payer handle × flow) ─────────────────────────────────────────────
// breakdown and codes are too big to ship whole once split by handle and flow (~560k /
// ~110k rows), so each run precomputes one view per filter combination: rows filtered,
// handle / flow summed away, then trimmed as the Morning Dashboard does. The page fetches
// the view it shows (GET /view); /state never carries these rows.

export const HANDLE_OPTS = ["all", "tpap", "ptyes", "ptaxis", "ptsbi", "pthdfc"]; // all = incl. legacy @paytm
export const FLOW_OPTS = ["ALL", "P2P", "P2M", "LITE"];
const TPAP = new Set(["ptyes", "ptaxis", "ptsbi", "pthdfc"]);
const VIEW_SECTIONS = new Set(["breakdown", "codes"]);
const CODES_TOP = 60;
const LONG_TAIL = "Other codes (long tail)";

const inHandle = (h, sel) => sel === "all" || (sel === "tpap" ? TPAP.has(h) : h === sel);
const inFlow = (f, sel) => sel === "ALL" || f === sel;

function sumBy(rows, keys) {
  const map = new Map();
  for (const r of rows) {
    const k = keys.map((c) => r[c]).join("\u0001");
    let acc = map.get(k);
    if (!acc) {
      acc = Object.fromEntries(keys.map((c) => [c, r[c]]));
      acc.total = 0;
      acc.success = 0;
      map.set(k, acc);
    }
    acc.total += r.total;
    acc.success += r.success;
    for (const c of ["descr", "etype", "etype1"]) if (r[c] && !acc[c]) acc[c] = r[c];
  }
  return [...map.values()];
}

function buildView(section, rows, handle, flow) {
  const sel = rows.filter((r) => inHandle(r.handle, handle) && inFlow(r.flow, flow));
  if (section === "breakdown") {
    return trimBreakdown(sumBy(sel, ["ts", "kind", "dim", "code"]).map((r) => ({ ...r, descr: r.descr || "" })));
  }
  // codes: per (day, code); codes outside the top CODES_TOP by window failures fold into one row.
  const perCode = new Map();
  for (const r of sel) perCode.set(r.code, (perCode.get(r.code) || 0) + r.total - r.success);
  const top = new Set([...perCode].sort((a, b) => b[1] - a[1]).slice(0, CODES_TOP).map(([c]) => c));
  return sumBy(
    sel.map((r) => (top.has(r.code) ? r : { ...r, code: LONG_TAIL, descr: "" })),
    ["ts", "code"],
  ).map((r) => ({ ...r, descr: r.descr || "", etype: r.etype || "", etype1: r.etype1 || "" }));
}

/** Yields between views so a big breakdown (~6s of CPU in total) doesn't stall the server. */
export async function buildViews(section, rows) {
  const views = {};
  for (const h of HANDLE_OPTS) {
    for (const f of FLOW_OPTS) {
      views[`${h}|${f}`] = buildView(section, rows, h, f);
      await new Promise((r) => setImmediate(r));
    }
  }
  return views;
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

// ─── Trino executor ──────────────────────────────────────────────────────────

function trinoEnv() {
  return {
    url: (process.env.TRINO_API_URL || "").replace(/\/+$/, ""),
    user: process.env.TRINO_SERVICE_USER || "",
    password: process.env.TRINO_SERVICE_PASSWORD || "",
    source: process.env.TRINO_SOURCE || "morning-dashboard",
    catalog: process.env.TRINO_CATALOG || "",
    schema: process.env.TRINO_SCHEMA || "",
    executeAs: process.env.TRINO_EXECUTE_AS_USER || "",
    impersonation: String(process.env.TRINO_IMPERSONATION || "true").toLowerCase() !== "false",
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
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

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason || new Error("aborted"));
      },
      { once: true }
    );
  });

async function runRedashOnce(env, dataSourceId, sql, { signal, timeoutMs }) {
  if (!env.url || !env.key) throw new Error("Redash not configured (set PTYES_REDASH_URL + PTYES_REDASH_API_KEY in .env)");
  const headers = { Authorization: `Key ${env.key}`, "Content-Type": "application/json" };
  const deadline = Date.now() + timeoutMs;
  let res = await fetch(`${env.url}/api/query_results`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data_source_id: dataSourceId, query: sql, max_age: 0 }),
    signal,
  });
  let payload = await readJson(res);
  if (!res.ok) throw new Error(payload.message || payload.error?.message || `Redash HTTP ${res.status}`);
  if (process.env.UDASH_DEBUG) console.log("[udash:redash]", dataSourceId, JSON.stringify(payload).slice(0, 200), sql.slice(0, 120).replace(/\s+/g, " "));
  let resultId = payload.query_result?.id;
  let direct = payload.query_result;
  const jobId = payload.job?.id;
  try {
    while (!direct && !resultId) {
      if (Date.now() > deadline) throw new Error(`Redash query exceeded ${Math.round(timeoutMs / 1000)}s timeout`);
      await sleep(1500, signal);
      res = await fetch(`${env.url}/api/jobs/${jobId}`, { headers, signal });
      payload = await readJson(res);
      const job = payload.job || {};
      if (process.env.UDASH_DEBUG) console.log("[udash:redash] job", jobId, job.status, job.error || "");
      if (job.status === 3) resultId = job.query_result_id;
      else if (job.status === 4) throw new Error(job.error || "Redash job failed");
      else if (job.status === 5) throw new Error("Redash job cancelled");
    }
  } catch (err) {
    if (jobId) fetch(`${env.url}/api/jobs/${jobId}`, { method: "DELETE", headers }).catch(() => {});
    throw err;
  }
  if (!direct) {
    res = await fetch(`${env.url}/api/query_results/${resultId}`, { headers, signal });
    payload = await readJson(res);
    if (!res.ok) throw new Error(`Redash result fetch HTTP ${res.status}`);
    direct = payload.query_result;
  }
  return direct?.data?.rows || [];
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
      if (r.recheck != null && !(Array.isArray(r.recheck) && r.recheck.every(hm))) throw new Error(`schedule.${sec}: recheck must be ["HH:MM", …]`);
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

const SECTION_NUMBER = { bankx: "A others", breakdown: "A", declines: "B", codes: "B", raw: "C/D/E", dims: "C/G/H/I", bank: "E/F", bankday: "F", bankrep: "F", share: "I", merchants: "G/F", bankalert: "F live", bankdwh: "F DWH" };
const durationLabel = (key) => {
  const m = /^(\d+)([mhd])$/.exec(key || "");
  if (!m) return key;
  const n = Number(m[1]);
  const unit = { m: "min", h: "hour", d: "day" }[m[2]];
  return `last ${n} ${unit}${n > 1 && m[2] !== "m" ? "s" : ""}`;
};

/** history: optional store from historyStore.js — every run is also written there. */
export function registerUnifiedDashboard(app, { dataDir, history: historyStore = null }) {
  const CONFIG_FILE = path.join(dataDir, "udash-config.json");
  const RESULTS_FILE = path.join(dataDir, "udash-results.json");
  const SCHED_FILE = path.join(dataDir, "udash-schedule-state.json");

  const saved = readJsonFile(CONFIG_FILE, {});
  if (saved.version !== CONFIG_VERSION) {
    // Section list changed: per-section schedule / durations reset to defaults.
    delete saved.sectionDurations;
    if (saved.schedule) delete saved.schedule.rules;
    delete saved.version;
  }
  let config = validateConfig(mergeConfig(DEFAULT_CONFIG, saved));
  const results = readJsonFile(RESULTS_FILE, {}); // section -> last success payload
  for (const sec of Object.keys(results)) {
    if (!SECTIONS.includes(sec)) delete results[sec]; // sections merged / removed since
    else if (SECTION_META[sec].daily && results[sec].complete == null) {
      results[sec].complete = yesterdayComplete(results[sec].views?.["all|ALL"] || results[sec].rows || [], config);
    }
  }
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
    let template;
    try {
      template = templateFor(section, job.engine, config);
    } catch (err) {
      // A missing template must fail this section, not crash the server (execute runs unawaited).
      Object.assign(job, { status: "failed", error: err.message, finishedAt: Date.now(), controller: null });
      return;
    }
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
      const merged = mergeRows(section, POST[section] ? POST[section](rawRows) : rawRows);
      // bankrep keeps its summary rows in /state and serves per-bank detail as views.
      const split =
        section === "bankrep" ? splitBankrep(merged) : section === "bankalert" || section === "bankdwh" ? await liveBankCheck(merged, job.trigger, section) : null;
      const views = split ? split.views : VIEW_SECTIONS.has(section) ? await buildViews(section, merged) : null;
      const rows = split ? split.rows : views ? [] : merged;
      const finishedAt = Date.now();
      results[section] = {
        section,
        duration: job.duration,
        engine: job.engine,
        window: job.window,
        rows,
        ...(views && { views, rowCount: merged.length }),
        ...(split && { extra: split.extra }),
        ...(SECTION_META[section].daily && { complete: yesterdayComplete(merged, config) }),
        ranAt: finishedAt,
        elapsedMs: finishedAt - job.startedAt,
      };
      try {
        writeJsonFile(RESULTS_FILE, results);
      } catch (e) {
        console.warn("[udash] could not persist results:", e.message);
      }
      Object.assign(job, { status: "success", finishedAt, elapsedMs: finishedAt - job.startedAt, rowCount: merged.length });
      logHistory({ section, trigger: job.trigger, engine: job.engine, duration: job.duration, status: "success", attempt: job.attempt, at: finishedAt, elapsedMs: job.elapsedMs, rows: merged.length });
      historyStore?.update(job.historyId, {
        event: "success",
        engine: job.engine,
        window: job.window,
        sql: job.sql,
        attempt: job.attempt,
        elapsedMs: job.elapsedMs,
        rowCount: merged.length,
        analysis:
          section === "breakdown"
            ? await breakdownAlerts(views["all|ALL"], job.trigger)
            : analyze("unified", section, merged, { bucketMin: job.window.bucketMin, errorColumn: config.errorColumn }),
      });
    } catch (err) {
      const finishedAt = Date.now();
      const cancelled = controller.signal.aborted;
      const message = cancelled ? "Stopped by user" : err?.message || String(err);
      Object.assign(job, { finishedAt, elapsedMs: finishedAt - job.startedAt, error: message });
      logHistory({ section, trigger: job.trigger, engine: job.engine, duration: job.duration, status: cancelled ? "cancelled" : "failed", attempt: job.attempt, at: finishedAt, elapsedMs: job.elapsedMs, error: message });
      if (cancelled) {
        job.status = "cancelled";
      } else if (config.autoRetry && job.attempt <= config.maxRetries && !QUEUE_BOUND.test(message)) {
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
      console.warn(`[udash] ${section} ${job.engine} attempt ${job.attempt} ${job.status}: ${message}`);
    } finally {
      job.controller = null;
    }
  }

  /**
   * WARN / CRIT rows → History alert log and the Slack digest — same rules and scope as the
   * Morning Dashboard (all payer handles, all flows, Morning PSP groups). The digest is
   * claimed once per data day in the shared history store, whichever dashboard runs first.
   */
  async function breakdownAlerts(viewRows, trigger) {
    try {
      const rows = (viewRows || []).map((r) => (r.kind === "psp" ? { ...r, dim: pspGroup(r.dim, "detailed") } : r));
      const yday = pickYday(rows, { kind: "bank" });
      if (!yday) return null;
      const alerts = computeAlerts(rows, { kinds: BREAKDOWN_KINDS, yday });
      const bankName = (code) => config.remitterBanks?.find((b) => b.code === code)?.name || null;
      const fresh = historyStore?.recordAlerts?.({ dashboard: "unified", dataDay: yday, trigger, alerts }) || [];
      const slack = [];
      // One digest per data day, sent even when nothing breached (so a quiet Slack means "no
      // digest", never "all clear"); late CRITs after it go out on their own.
      if (historyStore?.claimDigest?.(yday, { alerts: alerts.length, trigger, dashboard: "unified" })) {
        const text = alerts.length ? buildSrAlertSlack(alerts, { day: yday, bankName }) : buildSrAllClearSlack(rows, { day: yday, bankName, kinds: BREAKDOWN_KINDS });
        const r = await postSlack(text);
        if (r === "ok") historyStore.finishDigest(yday, { sentAt: Date.now(), result: r });
        else historyStore.releaseDigest(yday);
        slack.push(`daily digest (${alerts.length ? `${alerts.length} alerts` : "all clear"}): ${r}`);
      } else {
        const lateCrit = fresh.filter((a) => a.level === "CRIT");
        if (lateCrit.length) {
          const r = await postSlack(buildSrAlertSlack(lateCrit, { day: yday, bankName }));
          slack.push(`CRIT (${lateCrit.length}): ${r}`);
        }
      }
      if (slack.length) console.log(`[udash] slack SR alerts ${yday}: ${slack.join("; ")}`);
      const head = alerts.length ? buildSrAlertHeadline(alerts, { day: yday, bankName }) : null;
      return {
        summary: head ? `${head.title} — ${head.text}` : `No WARN / CRIT rows for ${yday}.`,
        standouts: alerts.map((a) => fmtAlert(a, bankName)),
        actions: slack.map((x) => `Slack ${x}`),
        nextSteps: [],
        tables: [],
      };
    } catch (err) {
      console.warn("[udash] breakdown alerts failed:", err.message);
      return { summary: `Alert computation failed: ${err.message}`, standouts: [], actions: [], nextSteps: [], tables: [] };
    }
  }

  /**
   * Live intraday payer-bank check (section bankalert): evaluate, and on a scheduled run with the
   * alert enabled post new alerts to Slack (one per bank per cooldown). Manual runs never post.
   */
  async function liveBankCheck(rows, trigger, section = "bankalert") {
    const dwh = section === "bankdwh";
    const ALERT_STATE_FILE = path.join(dataDir, dwh ? "udash-bankdwh-state.json" : "udash-bankalert-state.json");
    const opt = (dwh ? config.dwhBankAlert : config.intradayBankAlert) || {};
    const res = intradayBankAlerts(rows, {
      bankrepRows: results.bankrep?.rows || [],
      pbankRows: (results.merchants?.rows || []).filter((r) => r.grp === "pbank"),
      dropPp: opt.dropPp ?? 2,
      minTxns: opt.minTxns ?? 300,
      minLost: opt.minLost ?? 200,
    });
    const posted = [];
    if (trigger === "schedule" && opt.enabled && res.incidents.length) {
      const last = readJsonFile(ALERT_STATE_FILE, {});
      // Live: one post per bank per cooldown. DWH: windows overlap little, so one post per bank incident start.
      const keyOf = (a) => (dwh ? `${a.bank}|${a.from}` : a.bank);
      const fresh = res.incidents.filter((a) => (dwh ? !last[keyOf(a)] : !(last[a.bank] > Date.now() - (opt.cooldownMin ?? 720) * 60000)));
      if (fresh.length) {
        const bankName = (code) => config.remitterBanks?.find((b) => b.code === code)?.name || "";
        const hm = (ts) => ts.slice(11, 16);
        const lines = fresh.map(
          (a) =>
            `• *${a.bank}${bankName(a.bank) ? ` (${bankName(a.bank)})` : ""}* ${hm(a.from)}–${hm(a.to)}+30m (${a.minutes} min): SR ~${a.sr.toFixed(1)}%, gap to overall ${a.worstGap.toFixed(2)}pp vs normal ${a.baseGap.toFixed(2)}pp · ~${Math.round(a.lost).toLocaleString("en-IN")} txns lost · top codes ${a.topCodes.map(([c, n]) => `${c} ${n}`).join(", ")}`,
        );
        const r = await postSlack(
          `:rotating_light: *Payer-bank incidents · ${res.from?.slice(0, 16)} → ${res.to?.slice(11, 16)}+30m IST* — ${fresh.length} bank${fresh.length > 1 ? "s" : ""} ≥${opt.dropPp ?? 2}pp below normal for 60+ min\n${lines.join("\n")}\n_${dwh ? `DWH (Trino) hourly check — data up to ${res.to?.slice(11, 16)}+30m IST (DWH freshness)` : "Live switch DB (failed txns only)"} · Unified SR Dashboard › F_`,
        );
        if (r === "ok") {
          for (const a of fresh) last[keyOf(a)] = Date.now();
          writeJsonFile(ALERT_STATE_FILE, last);
        }
        posted.push(`Slack ${fresh.length}: ${r}`);
      }
    }
    return { rows, views: null, extra: { ...res, posted, trigger } };
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
        dashboard: "unified",
        section,
        sectionTitle: `${SECTION_NUMBER[section]} · ${title}`,
        subject: `${title} — ${durationLabel(duration)}${trigger === "schedule" ? " (auto)" : ""}`,
        taskName: `Unified SR Dashboard · Section ${SECTION_NUMBER[section]} · ${title} (${durationLabel(duration)})`,
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
  // section -> "YYYY-MM-DD HH:MM" of the last slot handled. Persisted, so a restart doesn't
  // re-fire a slot that already started (even if that run failed).
  const doneSlots = readJsonFile(SCHED_FILE, {});
  const lastScheduled = {}; // section -> epoch ms of the last scheduled start (failure backoff)

  /** What the schedule would do for a section right now: { due, nextAt, note }. */
  function scheduleStatus(section) {
    const sch = config.schedule || {};
    const rule = sch.rules?.[section];
    if (!sch.enabled) return { note: "schedule paused" };
    if (!rule || rule.type === "off") return { note: "manual only" };
    const dur = durationFor(section);
    if (section === "bankalert") {
      if (!config.intradayBankAlert?.enabled) return { note: "off — live switch DB; enable in F" };
    } else if (section === "bankdwh" && !config.dwhBankAlert?.enabled) {
      return { note: "off — enable in F" };
    } else if (chooseEngine(section, dur, config) === "redash") return { note: "manual only (Redash)" };
    const w = wallNowMs();
    const today = fmtWall(w).slice(0, 10);
    const nowHM = fmtWall(w).slice(11, 16);
    const last = results[section]?.ranAt || 0;
    if (rule.type === "daily") {
      const recheck = new Set(rule.recheck || []);
      const slots = [...rule.at, ...recheck].sort();
      const passed = slots.filter((t) => t <= nowHM);
      if (passed.length) {
        const slot = passed[passed.length - 1];
        const key = `${today} ${slot}`;
        const skip = recheck.has(slot) && results[section]?.complete;
        if (!skip && doneSlots[section] !== key && last < slotRealMs(today, slot)) return { due: true, slotKey: key, rule, dur };
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
      if (st.slotKey) {
        doneSlots[section] = st.slotKey;
        try {
          writeJsonFile(SCHED_FILE, doneSlots);
        } catch {
          /* best effort */
        }
      }
      lastScheduled[section] = Date.now();
      console.log(`[udash] scheduled refresh: ${section} (${st.dur})`);
      startSection(section, st.dur, undefined, "schedule");
      started = true;
    }
    if (started) pumpParallel();
  }
  const ACTIVE_STATUSES = new Set(["queued", "running", "retry-wait"]);
  setTimeout(scheduleTick, 20000).unref?.();
  setInterval(scheduleTick, 60000).unref?.();

  // /state results without view rows, and without rows the page already holds:
  // have = "section:ranAt,…" — those sections come back with rows: null (keep yours).
  function publicResults(have) {
    const held = new Map(String(have || "").split(",").filter(Boolean).map((x) => x.split(":")));
    return Object.fromEntries(
      Object.entries(results).map(([sec, r]) => {
        const { views, ...rest } = r;
        const base = views ? { ...rest, hasViews: true } : rest;
        if (views && !rest.rows?.length) return [sec, { ...base, rows: [] }];
        return [sec, held.get(sec) === String(r.ranAt) ? { ...base, rows: null } : base];
      }),
    );
  }

  // ── Routes ──

  app.get(
    "/api/udash/state",
    handle((req) => ({
      now: Date.now(),
      config,
      durations: Object.keys(DURATIONS),
      durationOptions: Object.fromEntries(
        SECTIONS.map((s) => [s, Object.entries(durationsFor(s)).map(([key, spec]) => ({ key, kind: spec.kind }))])
      ),
      jobs: Object.fromEntries(SECTIONS.map((s) => [s, publicJob(jobs[s])])),
      results: publicResults(req.query.have),
      handleOpts: HANDLE_OPTS,
      flowOpts: FLOW_OPTS,
      retryQueue,
      schedule: Object.fromEntries(SECTIONS.map((sec) => {
        const st = scheduleStatus(sec);
        return [sec, { nextAt: st.due ? Date.now() : st.nextAt || null, note: st.note || null, rule: st.rule || null }];
      })),
    }))
  );

  app.get(
    "/api/udash/view",
    handle((req) => {
      const section = String(req.query.section || "");
      const r = results[section];
      if (section === "bankrep") {
        const key = `bank:${req.query.bank || ""}`;
        return { section, key, ranAt: r?.ranAt || null, rows: r?.views?.[key] || [] };
      }
      if (!VIEW_SECTIONS.has(section)) throw new Error(`${section} has no views`);
      const key = `${req.query.handle || "all"}|${req.query.flow || "ALL"}`;
      if (!r?.views) return { section, key, ranAt: null, rows: [] };
      if (!r.views[key]) throw new Error(`Unknown view ${key}`);
      return { section, key, ranAt: r.ranAt, rows: r.views[key] };
    })
  );

  // Incident annotations (NPCI / bank downtime notices, festivals): drawn on the trend charts
  // and shown in the bank deep-dive. [{ id, date, end?, label, scope: "all" | payer bank code }]
  const ANNOT_FILE = path.join(dataDir, "udash-annotations.json");
  app.get("/api/udash/annotations", handle(() => ({ annotations: readJsonFile(ANNOT_FILE, []) })));
  app.post(
    "/api/udash/annotations",
    handle((req) => {
      const { date, end = null, label, scope = "all" } = req.body || {};
      const day = /^\d{4}-\d{2}-\d{2}$/;
      if (!day.test(date || "")) throw new Error("date must be YYYY-MM-DD");
      if (end && (!day.test(end) || end < date)) throw new Error("end must be YYYY-MM-DD, on or after date");
      const text = String(label || "").trim();
      if (!text || text.length > 120) throw new Error("label: 1–120 characters");
      if (!/^(all|[A-Za-z0-9]{2,12})$/.test(scope)) throw new Error("scope: all or a payer bank code");
      const list = readJsonFile(ANNOT_FILE, []);
      const a = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, date, end: end || null, label: text, scope: scope === "all" ? "all" : scope.toUpperCase(), at: Date.now() };
      list.push(a);
      writeJsonFile(ANNOT_FILE, list);
      return { annotation: a, annotations: list };
    })
  );
  app.delete(
    "/api/udash/annotations/:id",
    handle((req) => {
      const list = readJsonFile(ANNOT_FILE, []).filter((a) => a.id !== req.params.id);
      writeJsonFile(ANNOT_FILE, list);
      return { annotations: list };
    })
  );

  app.post(
    "/api/udash/run",
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
    "/api/udash/stop",
    handle((req) => {
      const list = pickSections(req.body?.sections);
      list.forEach((s) => stopSection(s));
      return { stopped: list };
    })
  );

  app.post(
    "/api/udash/retry-now",
    handle((req) => {
      const s = pickSections([req.body?.section])[0];
      if (jobs[s].status !== "retry-wait") throw new Error(`${s} is not waiting to retry`);
      jobs[s].nextRetryAt = Date.now();
      void pumpRetries();
      return { ok: true };
    })
  );

  app.get("/api/udash/config", handle(() => ({ config, defaults: DEFAULT_CONFIG, defaultSql: DEFAULT_SQL })));

  app.put(
    "/api/udash/config",
    handle((req) => {
      const next = validateConfig(mergeConfig(config, req.body || {}));
      config = next;
      writeJsonFile(CONFIG_FILE, config);
      return { config };
    })
  );

  app.post(
    "/api/udash/config/reset",
    handle(() => {
      config = validateConfig(mergeConfig(DEFAULT_CONFIG, {}));
      writeJsonFile(CONFIG_FILE, config);
      return { config };
    })
  );

  app.get(
    "/api/udash/sql",
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
    "/api/udash/connectivity",
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
    "/api/udash/freshness",
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
    "/api/udash/cache/clear",
    handle(() => {
      for (const k of Object.keys(results)) delete results[k];
      writeJsonFile(RESULTS_FILE, results);
      return { ok: true };
    })
  );

  app.get("/api/udash/history", handle(() => ({ history })));

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
