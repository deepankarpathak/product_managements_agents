// Product Wise dashboard — per-product health (UPI International, UPI Plugin, UPI Lite,
// UPI Refunds, Payouts and Mandates). International covers Paytm TPAP handles (ptyes, ptaxis,
// ptsbi, pthdfc); UPI Plugin covers the @yesnext handle (see pluginDashboard.js); UPI Lite
// reads team_product summary tables + switch txn_info (no handle split; 30-day default, extendable to 120).
//
// Each product has a few Trino queries that return raw daily counts grouped by
// (day, handle, dimension…). The UI slices them by date range (1–15 days) and handle,
// and compares against the equal-length period before, so one cached result serves
// every filter. The window is the last WINDOW_DAYS complete days (IST).
//
// A query may define run(ctx) instead of Trino SQL (UPI Plugin: live PMS via Redash, all
// days since launch including today); such a product may also set refreshEveryMin to be
// refreshed on an interval instead of once a day.
//
// UPI Refunds / Payouts read the live refund MySQL on the PTYBL Redash one IST day per SQL
// (fetchByDay): days already cached and older than SETTLE_DAYS are reused, so a refresh only
// queries the newest days (rows still PROCESSING / DEEMED settle within a day or two).
// Mandates do the same one day per Trino SQL (see MANDATE_DAY_SQL).
//
// A query marked snapshot: true returns a point-in-time count (no day column). Each run's
// rows are stamped asOf = window toDate and appended to the cached ones (same asOf
// replaced), so the UI can show the change between daily snapshots.
//
// Routes (all under /api/product):
//   GET  /state?product=        cached result + job state + schedule
//   POST /run {product, query?}  run one query (or every query of the product) now; queries
//                                already running are left alone
//   POST /stop {product, query?} stop one running query (or all of the product); the Trino
//                                query is killed and the last cached result is kept
//   GET  /sql?product=&query=    rendered SQL for the current window

import fs from "fs";
import zlib from "zlib";
import path from "path";
import { runTrino, runRedashWithEnv, sleep } from "./trinoClient.js";
import { analyze } from "./historyInsights.js";
import { frmRule } from "./frmRules.js";
import { appMessage } from "./errorSheet.js";
import { createStoreGroup, retireLegacy } from "./dayStore.js";
import { codeParty } from "./codeParty.js";
import { buildCompare, workbook } from "./ccCasaCompare.js";

// Copies of the APD SQL live in backend/reference/apd-sql/ (so Product Wise runs without third_party/apd_installer).
const APD_SQL = new URL("./reference/apd-sql/", import.meta.url);
import { fetchPluginDaily, PLUGIN_SQL, PLUGIN_START_DATE } from "./pluginDashboard.js";

const TZ_OFFSET_MIN = 330;
const TIMEOUT_MS = 20 * 60 * 1000;
// 15-day max range + the 15 days before it for period-over-period comparison.
const WINDOW_DAYS = 30;
// Backend refresh once a day after this IST time (snapshot tables are complete by then).
const SCHEDULE_AT = ["09:30"];
// Network blips to Trino ("fetch failed", resets) are retried with backoff; SQL errors are not.
const RETRY_WAITS_MS = [20000, 45000];
const isTransient = (err) => /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|other side closed|HTTP 50[234]/i.test(String(err?.message || err));

export const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
// tpap_pms.user_snapshot_v3.psp_id → handle (5 = @paytm, excluded).
const PSP_ID_CASE = `CASE u.psp_id WHEN 6 THEN 'ptyes' WHEN 7 THEN 'ptaxis' WHEN 8 THEN 'pthdfc' WHEN 9 THEN 'ptsbi' END`;

// UPI Lite: daily queries fetch the last LITE_DAYS days by default; a section's trend filter
// can extend a query's cached coverage up to LITE_MAX_DAYS (only the missing days are
// fetched). Snapshot history is kept for LITE_SNAPSHOTS_KEPT runs.
const LITE_DAYS = 30;
const LITE_MAX_DAYS = 120;
const LITE_SNAPSHOTS_KEPT = 120;
// Error-code query keeps the top N app codes of its window; the rest roll up into OTHER.
const LITE_CODES_KEPT = 100;
// Section 9 trend: CREATE / REVOKE per day over the last N days.
const LITE_AUTOPAY_TREND_DAYS = 7;
const LITE_SUMMARY_WHERE = `dt >= DATE '{{FROM_DATE}}' AND dt < DATE '{{TO_DATE}}'`;
// One query for section 9. SI is read twice (not 3×) and participants once (not 2×):
//   si_counts — active Lite mandates (grand total) + CREATE / REVOKE per day, via GROUPING SETS
//   cust      — per customer: first REVOKE and last CREATE, so "revoked" and "never re-enabled
//               (no CREATE after the first REVOKE)" come from the same pass.
// Rows: kind 'total' (one) + kind 'day' (one per day of the trend window).
const LITE_AUTOPAY_SQL = `WITH si AS (
  SELECT umn, txn_id, type, mandate_status, created_on
  FROM hive.switch.standing_instructions_snapshot_v3
  WHERE dl_last_updated IS NOT NULL AND lrn IS NOT NULL
),
si_day AS (
  SELECT *,
         CASE WHEN created_on >= TIMESTAMP '{{TREND_FROM}} 00:00:00' AND created_on < TIMESTAMP '{{TO_DATE}} 00:00:00'
              THEN CAST(date(created_on) AS varchar) END AS ts
  FROM si
),
si_counts AS (
  SELECT ts,
         grouping(ts)                                              AS is_total,
         count(DISTINCT CASE WHEN mandate_status = 'ACTIVE' THEN umn END) AS active,
         count_if(type = 'CREATE')                                 AS creates,
         count_if(type = 'REVOKE')                                 AS revokes
  FROM si_day
  GROUP BY GROUPING SETS ((), (ts))
),
cust AS (
  SELECT mp.scope_cust_id,
         min(CASE WHEN si.type = 'REVOKE' THEN si.created_on END) AS first_revoke,
         max(CASE WHEN si.type = 'CREATE' THEN si.created_on END) AS last_create
  FROM si
  JOIN (
    SELECT scope_cust_id, txn_id FROM hive.switch.standing_instructions_participants_snapshot_v3
    WHERE dl_last_updated >= DATE '2024-10-01'
  ) mp ON mp.txn_id = si.txn_id
  WHERE si.type IN ('CREATE', 'REVOKE') AND mp.scope_cust_id IS NOT NULL
  GROUP BY 1
),
rev AS (
  SELECT count_if(first_revoke IS NOT NULL)                                                       AS revoked,
         count_if(first_revoke IS NOT NULL AND (last_create IS NULL OR last_create <= first_revoke)) AS never_again
  FROM cust
)
SELECT 'total' AS kind, CAST(NULL AS varchar) AS ts, c.active, c.creates, c.revokes, r.revoked, r.never_again
FROM si_counts c CROSS JOIN rev r
WHERE c.is_total = 1
UNION ALL
SELECT 'day', ts, NULL, creates, revokes, NULL, NULL
FROM si_counts
WHERE is_total = 0 AND ts IS NOT NULL`;

// UPI Refunds / Payouts: refund MySQL ("Refund" data source on the PTYBL Redash).
const REFUND_URL_VAR = "MDASH_REDASH_URL";
const REFUND_KEY_VAR = "MDASH_REDASH_API_KEY";
const REFUND_DATA_SOURCE_ID = Number(process.env.REFUND_REDASH_DATA_SOURCE_ID) || 20;
// Cached days older than this are final; newer ones are re-queried on every refresh.
const SETTLE_DAYS = 2;
const REFUND_DAY_TIMEOUT_MS = 5 * 60 * 1000;
const DAY_RETRY_WAITS_MS = [5000, 15000, 30000];
// Days queried at once (each SQL is one indexed day, a few seconds on the refund MySQL).
const DAY_CONCURRENCY = 2;
// Refunds / Payouts window: the last 30 complete days, extended back to the 1st of the previous
// month so MTD vs LMTD is always covered.
const MONEY_MIN_DAYS = 30;
function moneyWindow(nowMs) {
  const today = istToday(nowMs);
  const yday = new Date(today - 86400000);
  const lmStart = Date.UTC(yday.getUTCFullYear(), yday.getUTCMonth() - 1, 1);
  return { fromDate: ymd(new Date(Math.min(lmStart, today - MONEY_MIN_DAYS * 86400000))), toDate: ymd(new Date(today)) };
}

// One SQL per IST day: {{DAY}} / {{NEXT_DAY}} are that day and the next (MySQL DATETIME is IST).
const REFUND_DAY_SQL = `SELECT
  DATE(created_date)                                              AS ts,
  COALESCE(extended_info ->> '$.refundType', '(none)')            AS refund_type,
  COALESCE(extended_info ->> '$.flowType', '(none)')              AS flow_type,
  mode,
  status,
  COALESCE(NULLIF(LEFT(extended_info ->> '$.payeeIfsc', 4), ''), '(blank)')    AS bank,
  CASE WHEN status = 'SUCCESS' THEN NULL ELSE COALESCE(NULLIF(reason_code, ''), CONCAT('(', LOWER(status), ')')) END  AS code,
  CASE WHEN status = 'SUCCESS' THEN NULL ELSE MAX(LEFT(remarks, 140)) END  AS msg,
  COUNT(*)                                                        AS c,
  SUM(refund_amount)                                              AS amt
FROM refund_info
WHERE created_date >= '{{DAY}}' AND created_date < '{{NEXT_DAY}}'
GROUP BY 1, 2, 3, 4, 5, 6, 7`;

const PAYOUT_DAY_SQL = `SELECT
  DATE(created_on)                                                AS ts,
  COALESCE(business_type, '(none)')                               AS business_type,
  status,
  CASE WHEN status = 'SUCCESS' THEN NULL ELSE COALESCE(NULLIF(resp_code, ''), CONCAT('(', LOWER(status), ')')) END  AS code,
  COUNT(*)                                                        AS c,
  SUM(amount)                                                     AS amt
FROM external_txn_info
WHERE created_on >= '{{DAY}}' AND created_on < '{{NEXT_DAY}}'
GROUP BY 1, 2, 3, 4`;

// Mandates (v4, 11 Nov 2026): one Trino SQL per IST day over switch txn_info + txn_participants (~30 s a day),
// replacing the five separate mandate pipelines (this tab's v3 + the Automatic Payments Dashboard's Mandate, CC Autopay,
// CC vs CASA and drill-down pulls). Counting rule = the APD "golden mandate unit" (UPI Alpha mandate_queries.sql):
//   scope   business_type MANDATE, UMN handle in the Paytm 5 (paytm, ptaxis, pthdfc, ptsbi, ptyes) — @paytm included;
//   unit    CREATE / REVOKE / PAUSE / UNPAUSE once per UMN per day, executions (COLLECT) once per UMN + execution
//           number per day (1st execution = 1, recurring = 2+; COLLECT without a number dropped); latest row wins;
//   code    NPCI response code, else app code, else status (PENDING …) — on non-success units only;
//   account payer leg CREDIT → CC, SAVINGS / CURRENT → CASA, else OTHER (= APD CC Autopay / CC vs CASA, same counts);
//   mode    extended_info initiationMode (00 collect / 04 intent / 13 QR / 11 mandate, NA unset); purpose 'NA' unset.
// Checked against the APD cache for 10 Nov 2026: Revoke / Pause / Unpause / recurring executions identical, Create +4,
// 1st execution +8 (late status updates), payer-bank splits within 1.
// Rows (every one has stage, purpose, mode, acct):
//   dim ALL                     every attempt × status (+ code when not successful)
//   dim PAYER_BANK / PAYEE_BANK / MCC / PAYER_HANDLE / PAYEE   every attempt × status by that key, top N keys per
//                               day × stage × purpose (MANDATE_SR_TOP) + Other
//   dim SIDE / BANK (payer bank) / F_PAYER_HANDLE / F_PAYEE_BANK / HANDLE (payee handle) / HANDLE_X_BANK (payee handle|bank)
//                               non-success units per code by that key — codes with ≥ MANDATE_SPLIT_MIN that day,
//                               top MANDATE_SPLIT_TOP keys + Other; kept for the newest MANDATE_SPLIT_DAYS days.
// SIDE = leg carrying a response code (PAYER = remitter bank, PAYEE = beneficiary side, else NPCI_PSP).
// Days before this tab's window live in data/product/_apd-history/ (scripts/import-apd-history.mjs, kept day-wise).
const MANDATE_SPLIT_MIN = 20;
const MANDATE_SPLIT_TOP = 20;
const MANDATE_SR_TOP = { PAYER_BANK: 40, PAYEE_BANK: 30, MCC: 40, PAYER_HANDLE: 20, PAYEE: 60 };
const MANDATE_SPLIT_DIMS = ["SIDE", "BANK", "F_PAYER_HANDLE", "F_PAYEE_BANK", "HANDLE", "HANDLE_X_BANK"];
// Failure split rows are kept for the newest days only (D-1 + the 14-day "normal" of the driver ranking).
const MANDATE_SPLIT_DAYS = 15;
// Kept in the store but left out of /state (they are ~30% of a day's rows): fetched per stage × code by the UI
// from GET /api/product/rows when picked in section 4.
export const MANDATE_ON_DEMAND_DIMS = ["F_PAYER_HANDLE", "F_PAYEE_BANK", "HANDLE_X_BANK"];
// Snapshot partitions read per day: the day itself + this many after it (a txn lives in the
// partition of its last update; mandate txns settle within a day or two). Unbounded, an old
// day would scan every partition up to today.
const MANDATE_LATE_DAYS = 3;
// Days fetched per chunk, newest first; the cache is saved after each chunk so the tab shows
// the newest days within a few minutes while older days fill in behind them.
const MANDATE_CHUNK_DAYS = 3;
// Purpose, mode and execution number come from txn_info.extended_info. When the Trino account
// can't read that column (seen 30 Oct 2026: masked to null for one user, readable for another),
// every attempt lands in purpose 'NA' and executions drop out — reject such a day instead of
// caching it.
const MANDATE_MAX_NO_PURPOSE = 0.5;
// Trino account for the Mandates queries: "backup" (TRINO_BACKUP_*) while extended_info is masked
// for the primary account (30 Oct 2026); set MANDATE_TRINO_ACCOUNT=primary once access is restored.
const MANDATE_TRINO_ACCOUNT = process.env.MANDATE_TRINO_ACCOUNT || "backup";
function checkMandateDay(rows, day) {
  let all = 0;
  let none = 0;
  for (const r of rows) {
    if (r.dim !== "ALL") continue;
    all += Number(r.c) || 0;
    if (r.purpose === "NA") none += Number(r.c) || 0;
  }
  if (all && none / all > MANDATE_MAX_NO_PURPOSE) {
    throw new Error(`${day}: ${Math.round((100 * none) / all)}% of mandate attempts have no purpose — switch.txn_info_snapshot_v3.extended_info reads as null for this Trino account (column masked?); kept the previous data`);
  }
}

const MANDATE_DAY_SQL = `WITH ti AS (
  SELECT txn_id, created_on, status, umn,
         CASE WHEN type <> 'COLLECT' THEN type
              WHEN try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) = 1 THEN 'EXEC1' ELSE 'EXECR' END AS stage,
         CASE WHEN type = 'COLLECT' THEN umn || '|' || json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') ELSE umn END AS unit,
         COALESCE(NULLIF(trim(json_extract_scalar(extended_info, '$.purpose')), ''), 'NA') AS purpose,
         COALESCE(NULLIF(trim(json_extract_scalar(extended_info, '$.initiationMode')), ''), 'NA') AS mode,
         COALESCE(NULLIF(trim(npci_resp_code), ''), NULLIF(trim(app_resp_code), ''), status) AS code
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND business_type = 'MANDATE' AND type IN ('CREATE', 'COLLECT', 'REVOKE', 'PAUSE', 'UNPAUSE')
    AND (type <> 'COLLECT' OR try_cast(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS integer) >= 1)
    AND substring(umn, position('@' IN umn) + 1) IN ('paytm', 'ptaxis', 'pthdfc', 'ptsbi', 'ptyes')
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN CASE WHEN account_type = 'CREDIT' THEN 'CC' WHEN account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' ELSE 'OTHER' END END) AS acct,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS pbank,
         MAX(CASE WHEN participant_type = 'PAYER' THEN lower(handle) END) AS phandle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN NULLIF(trim(resp_code), '') END) AS prc,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN bank_code END) AS ebank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(handle) END) AS ehandle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN NULLIF(trim(mcc), '') END) AS mcc,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN NULLIF(trim(resp_code), '') END) AS erc
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
),
u AS (   -- one unit: per UMN per day (executions: per UMN + execution number), latest row wins
  SELECT ti.stage,
         max_by(ti.purpose, ti.created_on) AS purpose, max_by(ti.mode, ti.created_on) AS mode, max_by(ti.status, ti.created_on) AS status,
         max_by(ti.code, ti.created_on) AS code,
         max_by(COALESCE(tp.acct, 'OTHER'), ti.created_on) AS acct,
         max_by(CASE WHEN tp.prc IS NOT NULL THEN 'PAYER' WHEN tp.erc IS NOT NULL THEN 'PAYEE' ELSE 'NPCI_PSP' END, ti.created_on) AS side,
         max_by(COALESCE(tp.pbank, 'NA'), ti.created_on) AS pbank, max_by(COALESCE(tp.phandle, 'NA'), ti.created_on) AS phandle,
         max_by(COALESCE(tp.ebank, 'NA'), ti.created_on) AS ebank, max_by(COALESCE(tp.ehandle, 'NA'), ti.created_on) AS ehandle,
         max_by(COALESCE(tp.mcc, 'NA'), ti.created_on) AS mcc
  FROM ti LEFT JOIN tp ON ti.txn_id = tp.txn_id
  WHERE ti.umn IS NOT NULL
  GROUP BY ti.stage, ti.unit
),
g AS (   -- every attempt: totals (with code on non-success) and SR splits
  SELECT stage, purpose, mode, acct, status,
         CASE WHEN GROUPING(pbank) = 0 THEN 'PAYER_BANK' WHEN GROUPING(ebank) = 0 THEN 'PAYEE_BANK' WHEN GROUPING(mcc) = 0 THEN 'MCC'
              WHEN GROUPING(phandle) = 0 THEN 'PAYER_HANDLE' WHEN GROUPING(ehandle) = 0 THEN 'PAYEE' ELSE 'ALL' END AS dim,
         CASE WHEN GROUPING(ncode) = 0 THEN ncode END AS code,
         COALESCE(CASE WHEN GROUPING(pbank) = 0 THEN pbank END, CASE WHEN GROUPING(ebank) = 0 THEN ebank END, CASE WHEN GROUPING(mcc) = 0 THEN mcc END,
                  CASE WHEN GROUPING(phandle) = 0 THEN phandle END, CASE WHEN GROUPING(ehandle) = 0 THEN ehandle END) AS k,
         count(*) AS c
  FROM (SELECT u.*, CASE WHEN status = 'SUCCESS' THEN NULL ELSE code END AS ncode FROM u) u2
  GROUP BY GROUPING SETS ((stage, purpose, mode, acct, status, ncode), (stage, purpose, mode, acct, status, pbank), (stage, purpose, mode, acct, status, ebank),
                          (stage, purpose, mode, acct, status, mcc), (stage, purpose, mode, acct, status, phandle), (stage, purpose, mode, acct, status, ehandle))
),
gr AS (
  SELECT g.*, row_number() OVER (PARTITION BY stage, purpose, dim, k ORDER BY c DESC) AS one_k,
         sum(c) OVER (PARTITION BY stage, purpose, dim, k) AS k_c
  FROM g
),
gk AS (   -- rank keys of each split by attempts per stage x purpose
  SELECT stage, purpose, dim, k, dense_rank() OVER (PARTITION BY stage, purpose, dim ORDER BY k_c DESC, k) AS rk
  FROM gr WHERE one_k = 1 AND dim <> 'ALL'
),
f AS (   -- failures (every non-success unit) behind each code; not split by mode (as in v3) to keep rows down
  SELECT stage, purpose, acct, code,
         CASE WHEN GROUPING(side) = 0 THEN 'SIDE' WHEN GROUPING(pbank) = 0 THEN 'BANK' WHEN GROUPING(phandle) = 0 THEN 'F_PAYER_HANDLE'
              WHEN GROUPING(ehandle, ebank) = 0 THEN 'HANDLE_X_BANK' WHEN GROUPING(ebank) = 0 THEN 'F_PAYEE_BANK' ELSE 'HANDLE' END AS dim,
         CASE WHEN GROUPING(side) = 0 THEN side WHEN GROUPING(pbank) = 0 THEN pbank WHEN GROUPING(phandle) = 0 THEN phandle
              WHEN GROUPING(ehandle, ebank) = 0 THEN ehandle || '|' || ebank WHEN GROUPING(ebank) = 0 THEN ebank ELSE ehandle END AS k,
         count(*) AS c
  FROM u WHERE status <> 'SUCCESS'
  GROUP BY GROUPING SETS ((stage, purpose, acct, code, side), (stage, purpose, acct, code, pbank), (stage, purpose, acct, code, phandle),
                          (stage, purpose, acct, code, ebank), (stage, purpose, acct, code, ehandle), (stage, purpose, acct, code, ehandle, ebank))
),
fr AS (
  SELECT f.*, sum(c) OVER (PARTITION BY stage, purpose, code) / 6 AS code_c,
         sum(c) OVER (PARTITION BY stage, purpose, code, dim, k) AS k_c
  FROM f
),
fk AS (
  SELECT DISTINCT stage, purpose, code, dim, k, k_c FROM fr WHERE code_c >= ${MANDATE_SPLIT_MIN}
),
fkr AS (
  SELECT stage, purpose, code, dim, k, dense_rank() OVER (PARTITION BY stage, purpose, code, dim ORDER BY k_c DESC, k) AS rk FROM fk
)
SELECT DATE '{{DAY}}' AS ts, g.stage, g.purpose, g.mode, g.acct, g.status, g.code, g.dim,
       CASE WHEN g.dim = 'ALL' OR gk.rk <= CASE g.dim WHEN 'PAYER_BANK' THEN ${MANDATE_SR_TOP.PAYER_BANK} WHEN 'PAYEE_BANK' THEN ${MANDATE_SR_TOP.PAYEE_BANK} WHEN 'MCC' THEN ${MANDATE_SR_TOP.MCC} WHEN 'PAYER_HANDLE' THEN ${MANDATE_SR_TOP.PAYER_HANDLE} ELSE ${MANDATE_SR_TOP.PAYEE} END
            THEN g.k ELSE 'Other' END AS k,
       sum(g.c) AS c
FROM g LEFT JOIN gk ON gk.stage = g.stage AND gk.purpose = g.purpose AND gk.dim = g.dim AND gk.k = g.k
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
UNION ALL
SELECT DATE '{{DAY}}', f.stage, f.purpose, CAST(NULL AS varchar), f.acct, NULL, f.code, f.dim, CASE WHEN fkr.rk <= ${MANDATE_SPLIT_TOP} THEN f.k ELSE 'Other' END, sum(f.c)
FROM f JOIN fkr ON fkr.stage = f.stage AND fkr.purpose = f.purpose AND fkr.code = f.code AND fkr.dim = f.dim AND fkr.k = f.k
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;

// Top merchants (APD "Top merchants" panel, the user's query of 30 Oct 2026): successful purpose-14 Creates per payee
// VPA / name, COUNT(DISTINCT umn), every UMN on the switch (no UMN-handle filter, unlike the attempts above);
// cc = 1 when any participant is a CREDIT account. Each day keeps its top MANDATE_PAYEE_TOP payees per cc flag plus a
// "__ALL__" total row, so any D-1 … LMTD ranking can be summed. Window = since the 1st of last month (LMTD).
const MANDATE_PAYEE_TOP = 40;
const MANDATE_PAYEE_SQL = `WITH ti AS (
  SELECT txn_id, umn
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND business_type = 'MANDATE' AND type = 'CREATE' AND status = 'SUCCESS'
    AND json_extract_scalar(extended_info, '$.purpose') LIKE '%14%'
),
tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(vpa) END) AS vpa,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN name END) AS name,
         MAX(CASE WHEN account_type = 'CREDIT' THEN 1 ELSE 0 END) AS cc
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY txn_id
)
SELECT DATE '{{DAY}}' AS ts, tp.cc, COALESCE(tp.vpa, 'NULL') AS vpa, MAX(tp.name) AS name, COUNT(DISTINCT ti.umn) AS n
FROM ti JOIN tp ON ti.txn_id = tp.txn_id
GROUP BY 2, 3`;
const payeeShape = (r) => ({ ts: String(r.ts ?? r.dt).slice(0, 10), cc: Number(r.cc) || 0, vpa: String(r.vpa ?? ""), name: r.name || "", n: num(r.n) });
/** Per day × cc flag: top MANDATE_PAYEE_TOP payees + a "__ALL__" row with the day's total. */
function compactPayees(rows) {
  const g = new Map();
  for (const r of rows) {
    if (r.vpa === "__ALL__") continue;
    const k = `${r.ts}|${r.cc}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const out = [];
  for (const list of g.values()) {
    list.sort((a, b) => b.n - a.n);
    out.push(...list.slice(0, MANDATE_PAYEE_TOP), { ts: list[0].ts, cc: list[0].cc, vpa: "__ALL__", name: "All payees", n: list.reduce((a, r) => a + r.n, 0) });
  }
  return out;
}
// Days the APD already pulled with the same query (imported to data/product/_apd-history/payee) seed the first fill.
const APD_HISTORY = new URL("./data/product/_apd-history/", import.meta.url);
function apdHistoryRows(dataset, win, shape) {
  const rows = [];
  for (let d = win.fromDate; d < win.toDate; d = addDays(d, 1)) {
    let doc;
    try {
      doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`${dataset}/days/${d}.json.gz`, APD_HISTORY))).toString("utf8"));
    } catch {
      continue;
    }
    for (const a of doc.rows) rows.push(shape(Object.fromEntries(doc.cols.map((c, i) => [c, a[i]]))));
  }
  return rows;
}

// ICCW (UPI cash withdrawal at ATM / BC points), ported from the Automatic Payments Dashboard
// (third_party/apd_installer …/iccw/sql/iccw_day.sql). Identifiers (UPI Alpha, 2 Nov 2026): payee
// MCC '6013' AND extended_info purpose '12' / '13' only (MCC 6011 is microfinance EMIs on Paytm);
// scope: payer handle in the Paytm 5 (paytm, ptyes, ptaxis, pthdfc, ptsbi); one row per txn_id.
// Code = app_resp_code for FAILURE (status name for PENDING / DEEMED); side = which participant leg
// carries a non-'00' resp_code. One row per day × purpose × dim (TOTAL, PAYEE_HANDLE = acquirer,
// PAYER_HANDLE, PAYER_BANK = remitter bank, AMOUNT band, HOUR, CODE, CODE_PAYEE, CODE_BANK).
// Difference to the APD query: snapshot partitions are bounded to the day + ICCW_LATE_DAYS (APD
// reads every partition from the day on, which gets slower for older days).
const ICCW_LATE_DAYS = 3;
// Bump when the row shape changes (cached rows of another version are re-seeded / re-queried).
const ICCW_VERSION = 2;
// CODE_PAYEE / CODE_BANK rows: newest ICCW_SPLIT_DAYS days only, top ICCW_SPLIT_TOP keys per
// day × purpose × code (by failures) + Other — the raw split is ~1,900 rows a day.
const ICCW_SPLIT_DAYS = 15;
const ICCW_SPLIT_TOP = 10;
// … and only for codes with at least ICCW_SPLIT_MIN failures that day × purpose (the drill-down needs volume).
const ICCW_SPLIT_MIN = 20;
const ICCW_TRINO_ACCOUNT = process.env.ICCW_TRINO_ACCOUNT || MANDATE_TRINO_ACCOUNT; // reads extended_info
// Seed: days already pulled by the vendored APD (one CSV per day) are reused instead of re-queried.
const ICCW_PARTS = `(hive.switch.txn_info_snapshot_v3 / txn_participants_snapshot_v3: dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${ICCW_LATE_DAYS}' DAY)`;
const ICCW_DAY_SQL = `-- ICCW for Paytm payers, one IST day {{DAY}} ${ICCW_PARTS}
WITH ti AS (
  SELECT txn_id, status, hour(created_on) AS hr, try_cast(amount AS double) AS amt,
         COALESCE(json_extract_scalar(extended_info, '$.purpose'), 'NA') AS purpose,
         CASE WHEN status = 'SUCCESS' THEN 'SUCCESS' WHEN status = 'FAILURE' THEN COALESCE(app_resp_code, 'NULL') ELSE status END AS code,
         COALESCE(npci_resp_code, '') AS npci
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${ICCW_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND (extended_info LIKE '%"purpose": "1%' OR extended_info LIKE '%"purpose":"1%')
    AND json_extract_scalar(extended_info, '$.purpose') IN ('12', '13')
),
pp AS (
  SELECT txn_id,
         max(CASE WHEN participant_type = 'PAYER' THEN lower(handle) END) AS payer_handle,
         max(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS payer_bank,
         max(CASE WHEN participant_type = 'PAYER' THEN scope_cust_id END) AS cid,
         max(CASE WHEN participant_type = 'PAYEE' THEN lower(handle) END) AS payee_handle,
         max(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS payee_mcc,
         max(CASE WHEN participant_type = 'PAYER' AND resp_code IS NOT NULL AND resp_code NOT IN ('00', '') THEN 1 ELSE 0 END) AS payer_rc,
         max(CASE WHEN participant_type = 'PAYEE' AND resp_code IS NOT NULL AND resp_code NOT IN ('00', '') THEN 1 ELSE 0 END) AS payee_rc
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${ICCW_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND txn_id IN (SELECT txn_id FROM ti)
  GROUP BY 1
),
y AS (
  SELECT ti.*, COALESCE(pp.payer_handle, 'NULL') AS payer_handle, COALESCE(pp.payer_bank, 'NULL') AS payer_bank, COALESCE(pp.payee_handle, 'NULL') AS payee_handle, pp.cid,
         CASE WHEN ti.code = 'SUCCESS' THEN '' WHEN pp.payer_rc = 1 AND pp.payee_rc = 0 THEN 'PAYER' WHEN pp.payee_rc = 1 AND pp.payer_rc = 0 THEN 'PAYEE'
              WHEN pp.payer_rc = 1 AND pp.payee_rc = 1 THEN 'BOTH' ELSE 'NONE' END AS side,
         CASE WHEN ti.amt < 500 THEN '1 <500' WHEN ti.amt < 1000 THEN '2 500-999' WHEN ti.amt < 2000 THEN '3 1000-1999' WHEN ti.amt < 5000 THEN '4 2000-4999'
              WHEN ti.amt < 10000 THEN '5 5000-9999' ELSE '6 10000+' END AS band
  FROM ti JOIN pp ON ti.txn_id = pp.txn_id
  WHERE pp.payee_mcc = '6013' AND pp.payer_handle IN ('paytm', 'ptyes', 'ptaxis', 'pthdfc', 'ptsbi')
)
SELECT DATE '{{DAY}}' AS ts, purpose,
       CASE WHEN grouping(payee_handle, payer_handle, payer_bank, code, band, hr) = 63 THEN 'TOTAL'
            WHEN grouping(code) = 0 AND grouping(payee_handle) = 0 THEN 'CODE_PAYEE'
            WHEN grouping(code) = 0 AND grouping(payer_bank) = 0 THEN 'CODE_BANK'
            WHEN grouping(code) = 0 THEN 'CODE'
            WHEN grouping(payee_handle) = 0 THEN 'PAYEE_HANDLE'
            WHEN grouping(payer_handle) = 0 THEN 'PAYER_HANDLE'
            WHEN grouping(payer_bank) = 0 THEN 'PAYER_BANK'
            WHEN grouping(band) = 0 THEN 'AMOUNT'
            ELSE 'HOUR' END AS dim,
       CASE WHEN grouping(code) = 0 AND grouping(payee_handle) = 0 THEN code || '|' || payee_handle
            WHEN grouping(code) = 0 AND grouping(payer_bank) = 0 THEN code || '|' || payer_bank
            WHEN grouping(code) = 0 THEN code
            WHEN grouping(payee_handle) = 0 THEN payee_handle
            WHEN grouping(payer_handle) = 0 THEN payer_handle
            WHEN grouping(payer_bank) = 0 THEN payer_bank
            WHEN grouping(band) = 0 THEN band
            WHEN grouping(hr) = 0 THEN CAST(hr AS varchar) ELSE '' END AS k,
       CASE WHEN grouping(code) = 0 AND grouping(payee_handle) = 1 AND grouping(payer_bank) = 1 THEN max(npci) ELSE '' END AS npci,
       CASE WHEN grouping(code) = 0 AND grouping(payee_handle) = 1 AND grouping(payer_bank) = 1 THEN max_by(side, side_n) ELSE '' END AS side,
       count(*) AS att, count_if(status = 'SUCCESS') AS suc, count_if(status = 'FAILURE') AS fail,
       sum(amt) AS amt, sum(CASE WHEN status = 'SUCCESS' THEN amt ELSE 0 END) AS suc_amt, count(DISTINCT cid) AS users
FROM (SELECT y.*, count(*) OVER (PARTITION BY purpose, code, side) AS side_n FROM y) y
GROUP BY GROUPING SETS ((purpose), (purpose, payee_handle), (purpose, payer_handle), (purpose, payer_bank), (purpose, code),
                        (purpose, code, payee_handle), (purpose, code, payer_bank), (purpose, band), (purpose, hr))`;

const iccwShape = (r) => {
  const dim = String(r.dim);
  const k = r.k == null ? "" : String(r.k);
  const code = dim === "CODE" ? k : dim.startsWith("CODE_") ? k.split("|")[0] : null;
  return {
    ts: String(r.ts ?? r.dt).slice(0, 10),
    purpose: String(r.purpose),
    dim,
    k,
    ...(code && code !== "SUCCESS" ? { code } : {}),
    ...(r.npci ? { npci: String(r.npci) } : {}),
    ...(r.side ? { side: String(r.side) } : {}),
    att: num(r.att),
    suc: num(r.suc),
    fail: num(r.fail),
    amt: Math.round(num(r.amt)),
    samt: Math.round(num(r.suc_amt ?? r.samt)),
    users: num(r.users),
  };
};

/** Top ICCW_SPLIT_TOP keys per day × purpose × dim × code for CODE_PAYEE / CODE_BANK, rest pooled into Other; newest ICCW_SPLIT_DAYS days. */
function compactIccw(rows, toDate) {
  const splitFrom = addDays(toDate, -ICCW_SPLIT_DAYS);
  const out = [];
  const groups = new Map();
  for (const r of rows) {
    if (r.dim !== "CODE_PAYEE" && r.dim !== "CODE_BANK") {
      out.push(r);
      continue;
    }
    if (r.ts < splitFrom) continue;
    const g = `${r.ts}|${r.purpose}|${r.dim}|${r.code}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const list of groups.values()) {
    if (list.reduce((a, r) => a + r.att - r.suc, 0) < ICCW_SPLIT_MIN) continue; // non-success: PENDING / DEEMED rows have fail = 0
    list.sort((a, b) => b.att - b.suc - (a.att - a.suc) || b.att - a.att);
    out.push(...list.slice(0, ICCW_SPLIT_TOP));
    if (list.length > ICCW_SPLIT_TOP) {
      const rest = list.slice(ICCW_SPLIT_TOP);
      const o = { ...rest[0], k: `${rest[0].code}|Other` };
      for (const f of ["att", "suc", "fail", "amt", "samt", "users"]) o[f] = rest.reduce((a, r) => a + r[f], 0);
      out.push(o);
    }
  }
  return out;
}

/** Rows of the days the APD already pulled (iccw/cache/<day>.csv), shaped like a cached run. */
function iccwSeed(win) {
  return apdHistoryRows("iccw", win, iccwShape);
}

function checkIccwDay(rows, day) {
  if (!rows.some((r) => r.dim === "TOTAL" && Number(r.att) > 0)) {
    throw new Error(`${day}: no ICCW txns — extended_info purpose may be masked for this Trino account; kept the previous data`);
  }
}

// ─── UPI International: failure deep-dive (ported from the APD UPI Global page, 11 Nov 2026) ───────────────
// The APD pulled every UPI_GLOBAL txn (one row per txn, 37 fields) and re-pulled all of them on every run; this keeps
// daily aggregates instead: one row per day × PSP handle × cut × key × status with txns, ₹ amount and amount
// percentiles. Single-field cuts and fixed bands survive; free cross-filters and arbitrary amount ranges do not.
// Code = NPCI response code, else app code, else "(no code)" — non-success only (as the APD page).
// Amount bands (₹) and device-binding age bands are fixed below; hour = IST hour of created_on.
const GLOBAL_AMT_BANDS = [[500, "1 <500"], [1000, "2 500-999"], [2500, "3 1k-2.5k"], [5000, "4 2.5k-5k"], [10000, "5 5k-10k"], [25000, "6 10k-25k"], [Infinity, "7 25k+"]];
const GLOBAL_BIND_BANDS = [[24, "1 <24h"], [72, "2 24-72h (cooling)"], [168, "3 3-7d"], [720, "4 7-30d"], [Infinity, "5 30d+"]];
const sqlBands = (expr, bands, unknown) =>
  `CASE WHEN ${expr} IS NULL THEN '${unknown}' ${bands.map(([lim, l]) => (lim === Infinity ? `ELSE '${l}'` : `WHEN ${expr} < ${lim} THEN '${l}'`)).join(" ")} END`;
const jsBand = (v, bands, unknown) => (v == null || Number.isNaN(v) ? unknown : bands.find(([lim]) => v < lim)[1]);
// [dim, SQL expression over the joined txn row]; CODE / CODE_COUNTRY are null (skipped) on SUCCESS.
const GLOBAL_DIMS = [
  ["COUNTRY", "COALESCE(country, 'unknown')"],
  ["PAYER_BANK", "COALESCE(payer_bank, 'unknown')"],
  ["PAYEE_HANDLE", "COALESCE(lower(payee_handle), 'unknown')"],
  ["CODE", "CASE WHEN status <> 'SUCCESS' THEN code END"],
  ["CODE_COUNTRY", "CASE WHEN status <> 'SUCCESS' THEN code || '|' || COALESCE(country, 'unknown') END"],
  ["OS", "CASE WHEN os_app LIKE 'iOS%' THEN 'iOS' ELSE COALESCE(NULLIF(os_app, ''), 'unknown') END"],
  ["OS_VER", "COALESCE(NULLIF(os_app, ''), 'unknown')"],
  ["APP_VER", "COALESCE(NULLIF(app_ver, ''), 'unknown')"],
  ["MCC", "COALESCE(payee_mcc, 'unknown')"],
  ["ACC_TYPE", "COALESCE(payer_acc_type, 'unknown')"],
  ["BASE_CURR", "COALESCE(base_curr, 'unknown')"],
  ["INIT_MODE", "COALESCE(init_mode, 'unknown')"],
  ["PURPOSE", "COALESCE(purpose, 'unknown')"],
  ["LOC", "loc"],
  ["BIZ_SIZE", "COALESCE(biz_size, 'unknown')"],
  ["M_GENRE", "COALESCE(m_genre, 'unknown')"],
  ["BIO_AUTH", "COALESCE(NULLIF(bio_auth, ''), 'false')"],
  ["MIGRATION", "COALESCE(NULLIF(migration, ''), 'false')"],
  ["HOUR", "lpad(CAST(hour(created_on) AS varchar), 2, '0')"],
  ["AMOUNT", sqlBands("amount", GLOBAL_AMT_BANDS, "unknown")],
  ["BIND_AGE", sqlBands("bind_age_h", GLOBAL_BIND_BANDS, "unknown")],
  ["RESP_SIDE", "CASE WHEN status = 'SUCCESS' THEN NULL WHEN NULLIF(payer_resp, '') IS NOT NULL THEN 'PAYER' WHEN NULLIF(payee_resp, '') IS NOT NULL THEN 'PAYEE' ELSE 'NONE' END"],
];
const GLOBAL_DAY_SQL = `WITH t AS (
  SELECT txn_id, created_on, status, lower(psp_handle) AS handle, try_cast(amount AS double) AS amount,
         COALESCE(NULLIF(npci_resp_code, ''), NULLIF(app_resp_code, ''), '(no code)') AS code,
         json_extract_scalar(extended_info, '$.baseCurr') AS base_curr,
         json_extract_scalar(extended_info, '$.countryCode') AS country,
         json_extract_scalar(extended_info, '$.payerOsApp') AS os_app,
         json_extract_scalar(extended_info, '$.appVersion') AS app_ver,
         json_extract_scalar(extended_info, '$.businessSize') AS biz_size,
         json_extract_scalar(extended_info, '$.payeeMerchantGenre') AS m_genre,
         json_extract_scalar(extended_info, '$.initiationMode') AS init_mode,
         json_extract_scalar(extended_info, '$.purpose') AS purpose,
         json_extract_scalar(extended_info, '$.isMigrationFlow') AS migration,
         json_extract_scalar(extended_info, '$.isBioAuthTxn') AS bio_auth,
         round((to_unixtime(created_on) - 19800 - try_cast(json_extract_scalar(extended_info, '$.oauthDeviceBindingTime') AS double) / 1000) / 3600, 1) AS bind_age_h,
         CASE WHEN try_cast(json_extract_scalar(extended_info, '$.latitude') AS double) IS NULL
                OR (try_cast(json_extract_scalar(extended_info, '$.latitude') AS double) = 0 AND try_cast(json_extract_scalar(extended_info, '$.longitude') AS double) = 0) THEN 'none'
              WHEN try_cast(json_extract_scalar(extended_info, '$.latitude') AS double) BETWEEN 6 AND 37.5
               AND try_cast(json_extract_scalar(extended_info, '$.longitude') AS double) BETWEEN 68 AND 97.5 THEN 'India box' ELSE 'outside India' END AS loc
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '3' DAY AND txn_mode = 'UPI_GLOBAL'
    AND lower(psp_handle) IN ({{HANDLES}})
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
),
p AS (
  SELECT txn_id,
         max(CASE WHEN participant_type = 'PAYER' THEN bank_code END) AS payer_bank,
         max(CASE WHEN participant_type = 'PAYER' THEN account_type END) AS payer_acc_type,
         max(CASE WHEN participant_type = 'PAYER' THEN resp_code END) AS payer_resp,
         max(CASE WHEN participant_type = 'PAYEE' THEN handle END) AS payee_handle,
         max(CASE WHEN participant_type = 'PAYEE' THEN mcc END) AS payee_mcc,
         max(CASE WHEN participant_type = 'PAYEE' THEN resp_code END) AS payee_resp
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '3' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00' + INTERVAL '1' DAY
    AND txn_id IN (SELECT txn_id FROM t)
  GROUP BY txn_id
),
j AS (SELECT t.*, p.payer_bank, p.payer_acc_type, p.payer_resp, p.payee_handle, p.payee_mcc, p.payee_resp FROM t LEFT JOIN p ON p.txn_id = t.txn_id)
SELECT DATE '{{DAY}}' AS ts, handle, x.dim, x.k, status, count(*) AS c, sum(amount) AS amt,
       approx_percentile(amount, 0.25) AS p25, approx_percentile(amount, 0.5) AS p50, approx_percentile(amount, 0.75) AS p75, approx_percentile(amount, 0.9) AS p90
FROM j CROSS JOIN UNNEST(ARRAY[${GLOBAL_DIMS.map(([d]) => `'${d}'`).join(", ")}],
                         ARRAY[${GLOBAL_DIMS.map(([, e]) => e).join(",\n                               ")}]) AS x(dim, k)
WHERE x.k IS NOT NULL
GROUP BY 1, 2, 3, 4, 5`;
const globalShape = (r) => ({ ts: String(r.ts).slice(0, 10), handle: r.handle, dim: r.dim, k: r.k, status: r.status, c: num(r.c), amt: Math.round(num(r.amt)), p25: r.p25 == null ? null : Math.round(num(r.p25)), p50: r.p50 == null ? null : Math.round(num(r.p50)), p75: r.p75 == null ? null : Math.round(num(r.p75)), p90: r.p90 == null ? null : Math.round(num(r.p90)) });

/** Seed: the APD's txn-level pull (upi_global/data/txns.csv) aggregated exactly like GLOBAL_DAY_SQL (exact percentiles). */
// First fill: the APD's txn-level pull, imported per day to data/product/_apd-history/upi_global_txns.
function globalSeed(win) {
  const nul = (v) => (v == null || v === "" || v === "None" || v === "null" ? null : v);
  const g = new Map();
  for (const a of apdHistoryRows("upi_global_txns", win, (r) => r)) {
    const day = a.ts.slice(0, 10);
    if (day < win.fromDate || day >= win.toDate) continue;
    const handle = String(a.psp_handle || "").toLowerCase();
    if (!HANDLES.includes(handle)) continue;
    const status = a.status;
    const amount = nul(a.amount) == null ? null : Number(a.amount);
    const code = nul(a.npci) || nul(a.app) || "(no code)";
    const country = nul(a.country) || "unknown";
    const osApp = nul(a.os_app);
    const bind = nul(a.bind_age_h) == null ? null : Number(a.bind_age_h);
    const vals = {
      COUNTRY: country,
      PAYER_BANK: nul(a.payer_bank) || "unknown",
      PAYEE_HANDLE: (nul(a.payee_handle) || "unknown").toLowerCase(),
      CODE: status !== "SUCCESS" ? code : null,
      CODE_COUNTRY: status !== "SUCCESS" ? `${code}|${country}` : null,
      OS: osApp && osApp.startsWith("iOS") ? "iOS" : osApp || "unknown",
      OS_VER: osApp || "unknown",
      APP_VER: nul(a.app_ver) || "unknown",
      MCC: nul(a.payee_mcc) || "unknown",
      ACC_TYPE: nul(a.payer_acc_type) || "unknown",
      BASE_CURR: nul(a.base_curr) || "unknown",
      INIT_MODE: nul(a.init_mode) || "unknown",
      PURPOSE: nul(a.purpose) || "unknown",
      LOC: a.loc,
      BIZ_SIZE: nul(a.biz_size) || "unknown",
      M_GENRE: nul(a.m_genre) || "unknown",
      BIO_AUTH: nul(a.bio_auth) || "false",
      MIGRATION: nul(a.migration) || "false",
      HOUR: a.ts.slice(11, 13),
      AMOUNT: jsBand(amount, GLOBAL_AMT_BANDS, "unknown"),
      BIND_AGE: jsBand(bind, GLOBAL_BIND_BANDS, "unknown"),
      RESP_SIDE: status === "SUCCESS" ? null : nul(a.payer_resp) ? "PAYER" : nul(a.payee_resp) ? "PAYEE" : "NONE",
    };
    for (const [dim, k] of Object.entries(vals)) {
      if (k == null) continue;
      const key = `${day}|${handle}|${dim}|${k}|${status}`;
      let o = g.get(key);
      if (!o) g.set(key, (o = { ts: day, handle, dim, k, status, c: 0, amt: 0, amts: [] }));
      o.c += 1;
      if (amount != null) {
        o.amt += amount;
        o.amts.push(amount);
      }
    }
  }
  const q = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : null);
  return [...g.values()].map(({ amts, ...o }) => {
    const s = amts.sort((x, y) => x - y);
    return { ...o, amt: Math.round(o.amt), p25: q(s, 0.25) == null ? null : Math.round(q(s, 0.25)), p50: q(s, 0.5) == null ? null : Math.round(q(s, 0.5)), p75: q(s, 0.75) == null ? null : Math.round(q(s, 0.75)), p90: q(s, 0.9) == null ? null : Math.round(q(s, 0.9)) };
  });
}

// UPI Global txn-level rows (APD upi_global/sql/txns.sql, one IST day at a time): one row per UPI_GLOBAL txn with
// handles, banks, codes, amounts, country, app, merchant flags and binding age — no VPA, name, account, device or
// location (location is a coarse in-India / outside / none flag). ~1,100 rows a day; lets the page cross-filter cuts
// and filter by amount like the APD page. First fill from the APD's pull (_apd-history/upi_global_txns).
const GLOBAL_TXN_DAY_SQL = interopSqlFrom(new URL("upi_global/txns.sql", APD_SQL))
  .replaceAll("{E1}", "{{NEXT_DAY}}")
  .replaceAll("{E2}", "{{DAY_PLUS_2}}")
  .replaceAll("{S}", "{{DAY}}");
const globalTxnShape = (r) => {
  const n = (v) => (v == null || v === "" || v === "None" || v === "null" ? null : Number(v));
  const t = (v) => (v == null || v === "" || v === "None" || v === "null" ? null : String(v));
  return {
    ts: String(r.ts).slice(0, 10),
    tm: String(r.ts).slice(11, 16),
    handle: String(r.psp_handle || "").toLowerCase(),
    status: r.status,
    npci: t(r.npci), app: t(r.app), amount: n(r.amount), type: t(r.type), channel: t(r.channel_code),
    payer_handle: t(r.payer_handle), payer_bank: t(r.payer_bank), payer_acc_type: t(r.payer_acc_type), payer_resp: t(r.payer_resp),
    payee_handle: t(r.payee_handle), payee_bank: t(r.payee_bank), payee_mcc: t(r.payee_mcc), payee_resp: t(r.payee_resp),
    base_curr: t(r.base_curr), base_amt: n(r.base_amt), fx_rate: n(r.fx_rate), mkup_fee: n(r.mkup_fee), country: t(r.country),
    os_app: t(r.os_app), app_ver: t(r.app_ver), biz_size: t(r.biz_size), m_genre: t(r.m_genre), m_verified: t(r.m_verified),
    init_mode: t(r.init_mode), purpose: t(r.purpose), migration: t(r.migration), bio_auth: t(r.bio_auth), scan_entry: t(r.scan_entry),
    dev_bound: t(r.dev_bound), intl_consent: t(r.intl_consent), bind_age_h: n(r.bind_age_h), loc: t(r.loc),
  };
};
const globalTxnSeed = (win) => apdHistoryRows("upi_global_txns", win, globalTxnShape).filter((r) => HANDLES.includes(r.handle));

// Activations not completed, and why (APD upi_global/sql/activation_fail.sql, one day at a time): reason = the last
// FAILURE code of the day in tpap_pms.upi_user_activity_log (other than 0 / 106), else VALIDITY_ENDED, TURNED_OFF,
// NO_FINAL_RESPONSE (request pending, no failure, no activation — usually the user left at UPI PIN entry) or NO_LOG.
const PSP_OF_ID = { 6: "ptyes", 7: "ptaxis", 8: "pthdfc", 9: "ptsbi" };
const ACT_FAIL_DAY_SQL = `WITH a AS (
  SELECT a.id, a.customer_id, date(a.updated_on) AS d, u.psp_id, COALESCE(a.account_provider_ifsc, 'NULL') AS bank,
         date(a.created_on) = date(a.updated_on) AS is_new, date(a.val_end) <= date(a.updated_on) AS window_ended
  FROM hive.tpap_pms.account_activation_snapshot_v3 a
  JOIN hive.tpap_pms.user_snapshot_v3 u ON u.id = CAST(a.user_id AS bigint) AND u.dl_last_updated <= CURRENT_DATE
  WHERE a.dl_last_updated >= DATE '{{DAY}}' AND a.service_name = 'INTERNATIONAL' AND a.status <> 'ACTIVE'
    AND a.updated_on >= TIMESTAMP '{{DAY}} 00:00:00' AND a.updated_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
),
l AS (
  SELECT customer_id, replace(action, 'meta.app.v1.account.service.', '') AS step, status, COALESCE(resp_code, '-') AS rc, created_time_datalake AS t
  FROM hive.tpap_pms.upi_user_activity_log_to_dwh_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '2' DAY
    AND created_time_datalake >= TIMESTAMP '{{DAY}} 00:00:00' AND created_time_datalake < TIMESTAMP '{{NEXT_DAY}} 06:00:00'
    AND action IN ('meta.app.v1.account.service.action', 'meta.app.v1.account.service.action.check.status')
    AND customer_id IN (SELECT customer_id FROM a)
),
j AS (
  SELECT a.id, a.d, a.psp_id, a.bank, a.is_new, a.window_ended,
         max_by(CASE WHEN l.status = 'FAILURE' AND l.rc NOT IN ('0', '106', '-') THEN l.rc END, CASE WHEN l.status = 'FAILURE' AND l.rc NOT IN ('0', '106', '-') THEN l.t END) AS fail_code,
         max_by(CASE WHEN l.status = 'FAILURE' AND l.rc NOT IN ('0', '106', '-') THEN l.step END, CASE WHEN l.status = 'FAILURE' AND l.rc NOT IN ('0', '106', '-') THEN l.t END) AS fail_step,
         count_if(l.step = 'action' AND l.status = 'SUCCESS') AS act_ok, count(l.customer_id) AS log_rows
  FROM a LEFT JOIN l ON l.customer_id = a.customer_id AND l.t >= CAST(a.d AS timestamp) AND l.t < CAST(a.d AS timestamp) + INTERVAL '30' HOUR
  GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT d AS ts, psp_id, bank, is_new,
       COALESCE(fail_code, CASE WHEN window_ended THEN 'VALIDITY_ENDED' WHEN act_ok > 0 THEN 'TURNED_OFF' WHEN log_rows = 0 THEN 'NO_LOG' ELSE 'NO_FINAL_RESPONSE' END) AS reason,
       COALESCE(fail_step, '-') AS step, count(*) AS n
FROM j GROUP BY 1, 2, 3, 4, 5, 6`;
const actFailShape = (r) => ({ ts: String(r.ts ?? r.d).slice(0, 10), handle: PSP_OF_ID[r.psp_id] || `psp ${r.psp_id}`, bank: r.bank, isNew: String(r.is_new).toLowerCase() === "true", reason: String(r.reason), step: r.step, n: num(r.n) });
function actFailSeed(win) {
  return apdHistoryRows("upi_global_act_fail", win, actFailShape);
}
// Core translator (TPAP Redash ds 3, upi_config.response_code_translator): app code ↔ NPCI / CBS / switch / risk codes
// — the "NPCI RIS mapping" of the APD page. Snapshot, refreshed with the product.
const TRANSLATOR_SQL = "SELECT app_code, npci_code, cbs_code, ps_code, switch_code, risk_code, wallet_code, pg_code, updated_on FROM response_code_translator";
// Analyst notes per code (written 26 Oct 2026 from 15 Sep – 14 Oct data), kept as written: backend/reference/upi-global-notes.json.
const GLOBAL_NOTES_FILE = new URL("./reference/upi-global-notes.json", import.meta.url);
function globalNotes() {
  try {
    return JSON.parse(fs.readFileSync(GLOBAL_NOTES_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Seeded per-day run: seed(win) rows stand in for days the APD already pulled; only missing / unsettled days hit Trino. */
function seededByDay(sqlDay, shape, version, seed, { account = MANDATE_TRINO_ACCOUNT } = {}) {
  return async (ctx) => {
    let cached = ctx.cached;
    if (cached?.version !== version) {
      const rows = seed(ctx.win);
      const last = rows.reduce((a, r) => (r.ts > a ? r.ts : a), "");
      // The seed covers every day up to its newest one, including days without rows.
      cached = { version, rows, ...(last ? { window: { fromDate: ctx.win.fromDate, toDate: addDays(last, 1) } } : {}) };
      if (last) ctx.savePartial(rows, { fromDate: ctx.win.fromDate, toDate: addDays(last, 1) });
    }
    return fetchByDay(sqlDay.replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", ")), shape, version, {
      exec: (sql, opts) => runTrino(sql, { ...opts, timeoutMs: TIMEOUT_MS, account }),
      chunkDays: MANDATE_CHUNK_DAYS,
    })({ ...ctx, cached });
  };
}

const runRefundRedash = (sql, opts) => runRedashWithEnv(REFUND_URL_VAR, REFUND_KEY_VAR, REFUND_DATA_SOURCE_ID, sql, { ...opts, timeoutMs: REFUND_DAY_TIMEOUT_MS });

/**
 * run() for per-day products: one SQL per day of the window (DAY_CONCURRENCY at a time) on the
 * refund Redash, or on Trino when exec = runTrino. Settled days already in the cache are reused
 * instead of queried — only when the cache was built by the same query version (bump `version`
 * when the SQL's columns change).
 * chunkDays: fetch the days in chunks of that many (newest first, all of a chunk at once) and
 * hand what is fetched so far to ctx.savePartial(rows, coverage) after each chunk, so the UI
 * shows the newest days early and a stopped / failed run keeps the days already fetched.
 * check(rows, day): throw to reject a day's raw rows (bad upstream data) — the run fails and the
 * days already cached stay as they were.
 */
function fetchByDay(daySql, shape, version, { exec = runRefundRedash, chunkDays = 0, check } = {}) {
  return async ({ win, cached, signal, onProgress, savePartial }) => {
    const days = [];
    for (let d = win.fromDate; d < win.toDate; d = addDays(d, 1)) days.push(d);
    const settledBefore = addDays(win.toDate, -SETTLE_DAYS);
    const prevRows = cached?.version === version ? cached.rows || [] : [];
    const have = new Set(prevRows.map((r) => r.ts));
    // A day inside the cached coverage was fetched even when it returned no rows (sparse queries such as Port-Out).
    const cover = cached?.version === version ? cached.window : null;
    const reuse = (d) => d < settledBefore && (have.has(d) || (cover && d >= cover.fromDate && d < cover.toDate));
    // Newest first, so the days shown by default land early.
    const todo = days.filter((d) => !reuse(d)).reverse();
    const out = prevRows.filter((r) => r.ts >= win.fromDate && r.ts < win.toDate && reuse(r.ts));
    let done = 0;
    const fetchDay = async (d) => {
      const sql = daySql.replaceAll("{{DAY}}", d).replaceAll("{{NEXT_DAY}}", addDays(d, 1)).replaceAll("{{DAY_PLUS_2}}", addDays(d, 2));
      // Retry each day on network blips so one dropped connection doesn't throw away the days already fetched.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const rows = await exec(sql, { signal });
          check?.(rows, d);
          out.push(...rows.map(shape));
          onProgress?.(`${(done += 1)}/${todo.length} days`);
          return;
        } catch (err) {
          if (signal?.aborted || !isTransient(err) || attempt >= DAY_RETRY_WAITS_MS.length) throw err;
          onProgress?.(`${done}/${todo.length} days · ${d} retry ${attempt + 1}`);
          await sleep(DAY_RETRY_WAITS_MS[attempt], signal);
        }
      }
    };
    const runAll = async (list, concurrency) => {
      const queue = [...list];
      await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          while (queue.length) await fetchDay(queue.shift());
        }),
      );
    };
    onProgress?.(`0/${todo.length} days`);
    if (!chunkDays) {
      await runAll(todo, DAY_CONCURRENCY);
      return out;
    }
    const fetched = new Set();
    for (let i = 0; i < todo.length; i += chunkDays) {
      const chunk = todo.slice(i, i + chunkDays);
      await runAll(chunk, chunkDays);
      chunk.forEach((d) => fetched.add(d));
      if (i + chunkDays >= todo.length) break;
      // Coverage = the unbroken run of reused / fetched days ending at toDate.
      let from = win.toDate;
      while (from > win.fromDate && (reuse(addDays(from, -1)) || fetched.has(addDays(from, -1)))) from = addDays(from, -1);
      savePartial?.(out.filter((r) => r.ts >= from), { fromDate: from, toDate: win.toDate });
    }
    return out;
  };
}

// NPCI descriptions for refund / payout failure codes such as "UPI-U31-XW" (U31 = UPI error
// code, XW = bank response code), from docs/UPI_Error_Response_Code_Reference.md. First table
// row per code wins (the doc lists RespPay codes before the meta / mandate variants).
// ─── Interop (ported from the Automatic Payments Dashboard's Interop tab) ───────
// Same SQL as third_party/apd_installer …/interop/sql/interop_days.sql and port_out_days.sql (read
// from there, so both dashboards stay identical), run one IST day at a time on Trino with the
// tables qualified as hive.*. Window = every day since INTEROP_FIRST ("Till date" on the page);
// the first fill comes from the APD days imported to data/product/_apd-history/ (interop_days per
// day, port_out per month), so only the newest days hit Trino. The last SETTLE_DAYS are re-pulled
// every run (APD re-pulls 2 days too).
const INTEROP_FIRST = "2025-12-23";
const INTEROP_VERSION = 1;
const APD_INTEROP_SQL = new URL("interop/", APD_SQL);
const interopSql = (file) => interopSqlFrom(new URL(file, APD_INTEROP_SQL));
/** An APD SQL file made runnable per day here: {start} / {end} → {{DAY}} / {{NEXT_DAY}}, tables qualified as hive.*. */
function interopSqlFrom(url) {
  let sql;
  try {
    sql = fs.readFileSync(url, "utf8");
  } catch (e) {
    return `-- ${url.pathname} not found in the APD install (${e.message})\nSELECT 1 WHERE false`;
  }
  return sql
    .replaceAll("{start}", "{{DAY}}")
    .replaceAll("{end}", "{{NEXT_DAY}}")
    .replace(/(?<![\w.])(upi_txn|switch)\.(\w+_snapshot_v3)/g, "hive.$1.$2");
}
const INTEROP_DAY_SQL = interopSql("interop_days.sql");
const PORT_OUT_DAY_SQL = interopSql("port_out_days.sql");
// handle → app, the APD / Superset dataset 7408 mapping (port_pull.py APPS)
const INTEROP_APPS = [
  [["okhdfcbank", "okaxis", "oksbi", "okicici"], "Google Pay"], [["ybl", "axl", "ibl"], "PhonePe"], [["abfspay"], "Bajaj Finserv"],
  [["barodampay"], "BHIM Baroda Pay"], [["idbi"], "BHIM PayWiz / IDBI GO Mobile+"], [["upi"], "BHIM"], [["aubank"], "BHIM AUPay"],
  [["bandhan"], "BHIM Bandhan UPI"], [["dlb"], "BHIM DLB UPI / DhanSmart"], [["indus"], "BHIM IndusPay"], [["kbl"], "BHIM KBL"],
  [["federal"], "BHIM Lotza UPI"], [["pnb"], "BHIM PNB"], [["sbi"], "BHIM SBIPay"], [["uco"], "BHIM UCO UPI"], [["dbs"], "DigiBank DBS"],
  [["freecharge"], "Freecharge"], [["yesg"], "Groww Pay"], [["hsbc"], "HSBC Simply Pay"], [["icici"], "iMobile ICICI"], [["indie"], "Indie"],
  [["inhdfc"], "INDmoney"], [["indianbank", "allbank"], "IndOASIS"], [["kotak"], "Kotak"], [["ikwik"], "MobiKwik"], [["naviaxis"], "Navi"],
  [["unionbankofindia", "uboi", "unionbank"], "Union Ease"], [["ptaxis", "pthdfc", "ptyes", "ptsbi", "paytm"], "Paytm"], [["pz"], "PayZapp"],
  [["shriramhdfcbank"], "Shriram One"], [["sib"], "SIB Mirror+"], [["yespay"], "YES Pay Next"], [["tmb"], "TMB MBank"],
];
const INTEROP_APP = Object.fromEntries(INTEROP_APPS.flatMap(([hs, a]) => hs.map((h) => [h, a])));
const interopShape = (r) => ({ ts: String(r.ts ?? r.dt).slice(0, 10), status: r.status, cls: r.cls, purpose: r.purpose || "NA", dim: r.dim, k: r.k ?? "", n: num(r.n) });
const portOutShape = (r) => ({
  ts: String(r.ts ?? r.dt).slice(0, 10),
  status: r.status,
  bank: r.bank || "NA",
  oh: r.other_handle ?? r.oh ?? "",
  app: INTEROP_APP[r.other_handle ?? r.oh] || "Others",
  code: r.code || "",
  n: num(r.n),
});
const portOutSeed = (win) => apdMonthRows("port_out", win, portOutShape);

// ─── CC vs CASA · P2M (ported from the APD "CC vs CASA" tab, trino/cc_casa_codes/sql/day.sql) ──
// The P2M half of the APD query, unchanged: switch category VPA2MERCHANT, type PAY / COLLECT, not a
// mandate; payer account from the PAYER leg (CREDIT → CC, SAVINGS / CURRENT → CASA, else dropped);
// one attempt per txn (latest status). code = NPCI code, else app code (failures); app = app code.
// The Autopay half lives in the Mandates tab (payer-account filter), on the golden unit chosen there.
const CCCASA_P2M_DAY_SQL = `-- CC vs CASA · P2M, one IST day {{DAY}} (APD trino/cc_casa_codes/sql/day.sql, P2M scope)
WITH tp AS (
  SELECT txn_id,
         MAX(CASE WHEN account_type = 'CREDIT' THEN 'CC' WHEN account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' END) AS acct
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated >= DATE '{{DAY}}'
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND participant_type = 'PAYER'
  GROUP BY txn_id
),
ti AS (
  SELECT txn_id, created_on, DATE(created_on) AS dt, status, app_resp_code, npci_resp_code
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated >= DATE '{{DAY}}'
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND (business_type IS NULL OR business_type <> 'MANDATE') AND category = 'VPA2MERCHANT' AND type IN ('PAY', 'COLLECT')
),
u AS (   -- one attempt per txn, latest status
  SELECT ti.dt, tp.acct, max_by(ti.status, ti.created_on) AS status,
         max_by(ti.app_resp_code, ti.created_on) AS app_resp_code, max_by(ti.npci_resp_code, ti.created_on) AS npci_resp_code
  FROM ti JOIN tp ON ti.txn_id = tp.txn_id
  WHERE tp.acct IS NOT NULL
  GROUP BY ti.dt, tp.acct, ti.txn_id
)
SELECT dt AS ts, acct, CASE WHEN status = 'FAILURE' THEN 'FAILURE' ELSE status END AS status,
       CASE WHEN status = 'FAILURE' THEN COALESCE(npci_resp_code, app_resp_code, 'UNKNOWN') ELSE status END AS code,
       CASE WHEN status = 'FAILURE' THEN COALESCE(app_resp_code, 'UNKNOWN') ELSE status END AS app,
       COUNT(*) AS c
FROM u
GROUP BY 1, 2, 3, 4, 5`;
const CCCASA_STATUSES = new Set(["SUCCESS", "PENDING", "DEEMED", "INITIATED", "EXPIRED", "UNKNOWN"]);
const ccCasaShape = (r) => {
  // APD rows: code = app code / status name, ncode = NPCI code else app code.
  const app = r.app ?? r.code;
  const status = r.status ?? (CCCASA_STATUSES.has(app) ? app : "FAILURE");
  return { ts: String(r.ts ?? r.dt).slice(0, 10), acct: r.acct, status, code: r.ncode ?? r.code, app, c: num(r.c ?? r.txns) };
};
function ccCasaSeed(win) {
  return apdHistoryRows("cccasa", win, (r) => r).filter((r) => r.scope === "P2M").map(ccCasaShape);
}

// ─── Code watch (APD code_watch/sql/code_watch.sql) ─────────────────────────────
// UM8-ZM / UM8-Z6 / UO8 failures per day by mandate type, golden mandate unit (every purpose). Same SQL
// as the APD file, one IST day at a time; first fill from the APD's monthly files in _apd-history.
const CODE_WATCH_DAY_SQL = interopSqlFrom(
  new URL("code_watch/code_watch.sql", APD_SQL),
);
const codeWatchShape = (r) => ({ ts: String(r.ts ?? r.dt).slice(0, 10), stage: r.stage, code: r.code, att: num(r.att), suc: num(r.suc) });
/** APD history kept per month (code_watch, port_out): read the months the window touches, keep its days. */
function apdMonthRows(dataset, win, shape) {
  const rows = [];
  for (let m = `${win.fromDate.slice(0, 7)}-01`; m < win.toDate; m = addDays(`${m.slice(0, 7)}-28`, 4).slice(0, 7) + "-01") {
    let doc;
    try {
      doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`${dataset}/days/${m.slice(0, 7)}.json.gz`, APD_HISTORY))).toString("utf8"));
    } catch {
      continue;
    }
    for (const a of doc.rows) {
      const r = shape(Object.fromEntries(doc.cols.map((c, i) => [c, a[i]])));
      if (r.ts >= win.fromDate && r.ts < win.toDate) rows.push(r);
    }
  }
  return rows;
}

const CODE_DOC = new URL("../docs/UPI_Error_Response_Code_Reference.md", import.meta.url);
let codeDocCache = null;
function codeDoc() {
  if (codeDocCache) return codeDocCache;
  const map = {};
  try {
    for (const line of fs.readFileSync(CODE_DOC, "utf8").split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 4 || !/^[A-Z0-9]{1,6}$/.test(cells[1]) || !cells[2] || /^-+$/.test(cells[2])) continue;
      if (!map[cells[1]]) map[cells[1]] = { descr: cells[2], type: /^(TD|BD)$/.test(cells[3]) ? cells[3] : "" };
    }
  } catch (err) {
    console.log(`[product] code reference not loaded: ${err.message}`);
  }
  return (codeDocCache = map);
}

/** { npci, bank, type, frm? } for a code like UPI-U31-XW / UPI-U16 / INT-2010 (null when unknown).
 * U16-<rule no.> / M16-<risk score> codes take the NPCI FRM rule / EFRM model (docs/npci-frm/) as the decline description. */
export function describeCode(code) {
  const base = describeCodeBase(code);
  const pt = codeParty(code); // APD "Party": which side the code points to, and why
  return { ...(base || { npci: "", bank: "", type: "" }), party: pt.party, partyWhy: pt.why };
}
function describeCodeBase(code) {
  const doc = codeDoc();
  const parts = String(code || "").replace(/^UPI-/, "").split(/[-|]/);
  const npci = doc[parts[0]];
  const frm = frmRule(code);
  if (frm) return { npci: npci ? `${parts[0]} ${npci.descr}` : "", bank: `${frm.family === "M16" ? "NPCI EFRM model" : "NPCI FRM"} ${frm.descr}`, type: npci?.type || "BD", frm: frm.descr };
  const bank = parts.length > 1 ? doc[parts[parts.length - 1]] : null;
  // App's customer message + response constant from the error-code sheet (response_mapper), when the code is there.
  const am = appMessage(code);
  if (!npci && !bank) return am ? { npci: "", bank: "", type: "", app: am.app, constant: am.constant } : null;
  return { npci: npci ? `${parts[0]} ${npci.descr}` : "", bank: bank ? `${parts[parts.length - 1]} ${bank.descr}` : "", type: bank?.type || npci?.type || "", ...(am ? { app: am.app, constant: am.constant } : {}) };
}

// ─── Products ────────────────────────────────────────────────────────────────

const mandateRowShape = (r) => ({
  ts: String(r.ts).slice(0, 10),
  purpose: r.purpose,
  stage: r.stage,
  acct: r.acct,
  mode: r.mode ?? null,
  // Split rows count non-success units; the UI reads them as failures (status FAILURE), as in v3.
  status: r.status ?? "FAILURE",
  code: r.code ?? null,
  dim: r.dim,
  k: r.k ?? null,
  c: num(r.c),
});

export const PRODUCTS = {
  international: {
    title: "UPI International",
    codeInfo: true,
    queries: {
      // Sections 1 (by PSP) and 2 (by bank) both slice this.
      activation: {
        title: "Intl activation (day × PSP × bank)",
        sql: `SELECT
  CAST(date(a.updated_on) AS varchar)  AS ts,
  ${PSP_ID_CASE}  AS handle,
  COALESCE(NULLIF(trim(a.account_provider_ifsc), ''), '(blank)')  AS bank,
  count(*)                             AS attempts,
  count_if(a.status = 'ACTIVE')        AS activated
FROM hive.tpap_pms.account_activation_snapshot_v3 a
JOIN hive.tpap_pms.user_snapshot_v3 u
  ON u.id = CAST(a.user_id AS bigint) AND u.dl_last_updated <= CURRENT_DATE
WHERE a.dl_last_updated >= DATE '{{FROM_DATE}}'
  AND a.service_name = 'INTERNATIONAL'
  AND a.updated_on >= TIMESTAMP '{{FROM_DATE}} 00:00:00'
  AND a.updated_on <  TIMESTAMP '{{TO_DATE}} 00:00:00'
  AND u.psp_id IN (6, 7, 8, 9)
GROUP BY 1, 2, 3`,
      },
      // Section 3.
      txns: {
        title: "Intl txns (day × PSP × status)",
        sql: `SELECT
  CAST(date(created_on) AS varchar)  AS ts,
  lower(psp_handle)                  AS handle,
  status,
  count(*)                           AS c,
  sum(amount)                        AS amt
FROM hive.switch.txn_info_snapshot_v3
WHERE dl_last_updated BETWEEN DATE '{{FROM_DATE}}' AND DATE '{{TO_DATE}}'
  AND txn_mode = 'UPI_GLOBAL'
  AND created_on >= TIMESTAMP '{{FROM_DATE}} 00:00:00'
  AND created_on <  TIMESTAMP '{{TO_DATE}} 00:00:00'
  AND lower(psp_handle) IN ({{HANDLES}})
GROUP BY 1, 2, 3`,
      },
      // Section 5. SR = (SUCCESS + DEEMED) / (SUCCESS + FAILURE + DEEMED + PENDING).
      countries: {
        title: "Intl txns (day × PSP × country)",
        sql: `SELECT
  CAST(date(created_on) AS varchar)  AS ts,
  lower(psp_handle)                  AS handle,
  COALESCE(NULLIF(trim(json_extract_scalar(extended_info, '$.countryCode')), ''), 'UNKNOWN')  AS country,
  count(*)                                                            AS total,
  count_if(status IN ('SUCCESS', 'DEEMED'))                           AS succ,
  count_if(status IN ('SUCCESS', 'FAILURE', 'DEEMED', 'PENDING'))     AS term
FROM hive.switch.txn_info_snapshot_v3
WHERE dl_last_updated BETWEEN DATE '{{FROM_DATE}}' AND DATE '{{TO_DATE}}'
  AND txn_mode = 'UPI_GLOBAL'
  AND created_on >= TIMESTAMP '{{FROM_DATE}} 00:00:00'
  AND created_on <  TIMESTAMP '{{TO_DATE}} 00:00:00'
  AND lower(psp_handle) IN ({{HANDLES}})
GROUP BY 1, 2, 3`,
      },
      // Sections 4 and 6 — non-successful txns only; the success base comes from txns.
      errors: {
        title: "Intl error codes (day × PSP × payer bank × code)",
        sql: `SELECT
  CAST(date(t.created_on) AS varchar)  AS ts,
  lower(t.psp_handle)                  AS handle,
  COALESCE(p.bank_code, '(unknown)')   AS bank,
  t.status,
  COALESCE(NULLIF(trim(t.npci_resp_code), ''), NULLIF(trim(t.app_resp_code), ''), '(' || lower(t.status) || ')')  AS code,
  t.app_resp_code                      AS app,
  count(*)                             AS c,
  sum(t.amount)                        AS amt
FROM hive.switch.txn_info_snapshot_v3 t
LEFT JOIN hive.switch.txn_participants_snapshot_v3 p
  ON p.txn_id = t.txn_id AND p.participant_type = 'PAYER'
  AND p.dl_last_updated BETWEEN DATE '{{FROM_DATE}}' AND DATE '{{TO_DATE}}' + INTERVAL '1' DAY
WHERE t.dl_last_updated BETWEEN DATE '{{FROM_DATE}}' AND DATE '{{TO_DATE}}'
  AND t.txn_mode = 'UPI_GLOBAL'
  AND t.status <> 'SUCCESS'
  AND t.created_on >= TIMESTAMP '{{FROM_DATE}} 00:00:00'
  AND t.created_on <  TIMESTAMP '{{TO_DATE}} 00:00:00'
  AND lower(t.psp_handle) IN ({{HANDLES}})
GROUP BY 1, 2, 3, 4, 5, 6`,
      },
      // Failure deep-dive (APD UPI Global page), daily aggregates; first fill from the APD's txn-level pull.
      global: {
        title: "Intl txns by cut (day × PSP × country / payer bank / payee handle / code / code × country / OS / app version / MCC / account type / currency / mode / purpose / location / merchant / biometric / migration / hour / amount band / device-binding age / response leg × status: txns, ₹, amount percentiles)",
        daily: true,
        version: 1,
        sql: GLOBAL_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        shape: (r) => r,
        run: (ctx) => seededByDay(GLOBAL_DAY_SQL, globalShape, 1, globalSeed)(ctx),
      },
      // Activations not completed, by reason (APD activation_fail.sql); first fill from the APD's pull.
      activation_fail: {
        title: "Intl activations not completed (day × PSP × bank × new / existing × reason × step)",
        daily: true,
        version: 1,
        sql: ACT_FAIL_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        shape: (r) => r,
        run: (ctx) => seededByDay(ACT_FAIL_DAY_SQL, actFailShape, 1, actFailSeed)(ctx),
      },
      // Txn-level rows for cross-filters and the amount filter (APD UPI Global page); first fill from the APD's pull.
      txn_detail: {
        title: "Intl txns, one row per txn (handles, banks, codes, amount, country, app, merchant flags, binding age — no VPA / name / account / device)",
        daily: true,
        version: 1,
        sql: GLOBAL_TXN_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) => seededByDay(GLOBAL_TXN_DAY_SQL, globalTxnShape, 1, globalTxnSeed)(ctx),
      },
      // NPCI RIS mapping: app code ↔ NPCI / CBS / switch / risk codes (TPAP Redash).
      translator: {
        title: "Core response-code translator (TPAP Redash ds 3 · upi_config.response_code_translator)",
        source: "redash",
        sql: TRANSLATOR_SQL,
        shape: (r) => ({ handle: "all", app: r.app_code || "", npci: r.npci_code || "", cbs: r.cbs_code || "", ps: r.ps_code || "", sw: r.switch_code || "", risk: r.risk_code || "", wallet: r.wallet_code || "", pg: r.pg_code || "", updated: r.updated_on || "" }),
        run: () => runRedashWithEnv("PTYES_REDASH_URL", "PTYES_REDASH_API_KEY", 3, TRANSLATOR_SQL, { timeoutMs: 10 * 60 * 1000 }),
      },
    },
    // Extra /state fields: the analyst notes per code.
    extras: () => ({ notes: globalNotes() }),
  },
  plugin: {
    title: "UPI Plugin",
    source: "redash",
    // Live source with today's data — refresh hourly (incremental, cheap after backfill).
    refreshEveryMin: 60,
    window: (nowMs) => ({ fromDate: PLUGIN_START_DATE, toDate: ymd(new Date(istToday(nowMs) + 86400000)) }),
    queries: {
      daily: {
        title: "@yesnext onboarding funnel (day)",
        sql: Object.values(PLUGIN_SQL).join("\n\n"),
        run: ({ dataDir, onProgress }) => fetchPluginDaily({ stateFile: path.join(dataDir, "product-plugin-users.json"), onProgress }),
      },
    },
  },
  lite: {
    title: "UPI Lite",
    // Rows carry no PSP handle; keep them all.
    allHandles: true,
    window: (nowMs, days = LITE_DAYS) => {
      const today = istToday(nowMs);
      return { fromDate: ymd(new Date(today - days * 86400000)), toDate: ymd(new Date(today)) };
    },
    maxDays: LITE_MAX_DAYS,
    // daily: true  → rows keyed by ts; a run replaces its window's days and keeps the rest
    //                (so /run {days} only fetches the days not cached yet).
    // manual: true → never part of Refresh all or the daily schedule; runs only from its panel.
    queries: {
      // Section 1.
      accounts: {
        title: "Lite active accounts (snapshot)",
        snapshot: true,
        sql: `SELECT count(DISTINCT lite_acc.lrn) AS active_accounts
FROM (
  SELECT customer_id, id, psp_id FROM hive.tpap_pms.user_snapshot_v3
  WHERE dl_last_updated < CURRENT_DATE
) u
JOIN (
  SELECT acc_ref_id, id, user_id, lrn FROM hive.tpap_pms.lite_account_snapshot_v3
  WHERE dl_last_updated < CURRENT_DATE AND status = 'ACTIVE'
) lite_acc ON lite_acc.user_id = u.id`,
        shape: (r) => ({ active_accounts: num(r.active_accounts) }),
      },
      // Sections 2–6: activation / top-up / deregister / txn share / SR all slice this.
      trend: {
        title: "Lite summary (day × recharge txn type × Lite payer)",
        daily: true,
        sql: `SELECT
  CAST(date(dt) AS varchar)                                   AS ts,
  COALESCE(upi_lite_recharge_txns, '(none)')                  AS txn_type,
  CASE WHEN payer_instrument = 'UPI_LITE' THEN 1 ELSE 0 END   AS lite,
  sum(success)                                                AS success,
  sum(txn_init)                                               AS txn_init
FROM hive.team_product.upi_lite_summary
WHERE ${LITE_SUMMARY_WHERE}
GROUP BY 1, 2, 3`,
        shape: (r) => ({ ts: String(r.ts).slice(0, 10), txn_type: r.txn_type, lite: num(r.lite), success: num(r.success), txn_init: num(r.txn_init) }),
      },
      // Section 5 GMV. switch txn_mode UPI_LITE = the summary's UPI_LITE payer rows (counts match).
      gmv: {
        title: "Lite payer GMV (day)",
        daily: true,
        sql: `SELECT
  CAST(date(created_on) AS varchar)                          AS ts,
  count_if(status = 'SUCCESS')                               AS success,
  sum(CASE WHEN status = 'SUCCESS' THEN amount END)          AS gmv
FROM hive.switch.txn_info_snapshot_v3
WHERE dl_last_updated BETWEEN DATE '{{FROM_DATE}}' AND DATE '{{TO_DATE}}'
  AND txn_mode = 'UPI_LITE'
  AND created_on >= TIMESTAMP '{{FROM_DATE}} 00:00:00'
  AND created_on <  TIMESTAMP '{{TO_DATE}} 00:00:00'
GROUP BY 1`,
        shape: (r) => ({ ts: String(r.ts).slice(0, 10), success: num(r.success), gmv: num(r.gmv) }),
      },
      // Section 7 (error type / app code). Successful rows count as SUCCESS, as in the reference
      // charts. App codes outside the window's top LITE_CODES_KEPT roll up into OTHER.
      codes: {
        title: "Lite error type & app code (day × Lite payer)",
        daily: true,
        sql: `WITH base AS (
  SELECT
    CAST(date(dt) AS varchar)                                   AS ts,
    CASE WHEN payer_instrument = 'UPI_LITE' THEN 1 ELSE 0 END   AS lite,
    CASE WHEN success > 0 THEN 'SUCCESS' ELSE COALESCE(NULLIF(trim(error_type), ''), '(blank)') END     AS error_type,
    CASE WHEN success > 0 THEN 'SUCCESS' ELSE COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') END  AS code,
    sum(txn_init)                                               AS txn_init
  FROM hive.team_product.upi_lite_summary
  WHERE ${LITE_SUMMARY_WHERE}
  GROUP BY 1, 2, 3, 4
),
top_codes AS (
  SELECT code FROM base WHERE code <> 'SUCCESS'
  GROUP BY code ORDER BY sum(txn_init) DESC LIMIT ${LITE_CODES_KEPT}
)
SELECT ts, lite, error_type,
       CASE WHEN code = 'SUCCESS' OR code IN (SELECT code FROM top_codes) THEN code ELSE 'OTHER' END AS code,
       sum(txn_init) AS txn_init
FROM base
GROUP BY 1, 2, 3, 4`,
        shape: (r) => ({ ts: String(r.ts).slice(0, 10), lite: num(r.lite), error_type: r.error_type, code: r.code, txn_init: num(r.txn_init) }),
      },
      // Section 9: snapshot counts + CREATE / REVOKE per day, one query.
      autopay: {
        title: "Lite autopay active / revoked + daily CREATE / REVOKE (snapshot)",
        snapshot: true,
        sql: LITE_AUTOPAY_SQL,
        shape: (r) =>
          r.kind === "day"
            ? { kind: "day", ts: String(r.ts).slice(0, 10), creates: num(r.creates), revokes: num(r.revokes) }
            : { kind: "total", active: num(r.active), revoked: num(r.revoked), never_again: num(r.never_again), creates: num(r.creates), revokes: num(r.revokes) },
      },
      // Section 10.
      mandate: {
        title: "Lite autopay mandate txns (day × category)",
        daily: true,
        sql: `SELECT
  CAST(date(dt) AS varchar)                    AS ts,
  COALESCE(autopay_category, '(blank)')        AS category,
  sum(success)                                 AS success,
  sum(txn_init)                                AS txn_init
FROM hive.team_product.lite_autopay_txns
WHERE ${LITE_SUMMARY_WHERE}
GROUP BY 1, 2`,
        shape: (r) => ({ ts: String(r.ts).slice(0, 10), category: r.category, success: num(r.success), txn_init: num(r.txn_init) }),
      },
      // Section 11 — on demand only (heavy, and needs ups grants).
      shield: {
        title: "Lite users with Security Shield (snapshot × PSP)",
        snapshot: true,
        manual: true,
        sql: `WITH lite AS (
  -- active Lite accounts: latest status of each account = ACTIVE, rolled up to the user
  SELECT user_id
  FROM (
    SELECT id, user_id, max_by(status, updated_on) AS st
    FROM hive.tpap_pms.lite_account_snapshot_v3
    WHERE dl_last_updated <= CURRENT_DATE
    GROUP BY id, user_id
  )
  WHERE st = 'ACTIVE'
  GROUP BY user_id
),
usr AS (
  -- user's PSP and Paytm customer id
  SELECT id, max(psp_id) AS psp_id, max_by(customer_id, updated_on) AS customer_id
  FROM hive.tpap_pms.user_snapshot_v3
  WHERE dl_last_updated <= CURRENT_DATE
  GROUP BY id
),
shield AS (
  -- latest preference 44 = is_security_shield_enabled, per customer
  SELECT cust_id, preference_value, status
  FROM (
    SELECT cust_id, preference_value, status,
           ROW_NUMBER() OVER (PARTITION BY cust_id ORDER BY dl_last_updated DESC, updated_at DESC, id DESC) AS rn
    FROM hive.ups.user_preference_snapshot_v3
    WHERE preference_id = 44
      AND dl_last_updated >= DATE '2020-01-01'
  )
  WHERE rn = 1
),
x AS (
  SELECT CASE u.psp_id WHEN 6 THEN 'PTYES' WHEN 7 THEN 'PTAXIS' WHEN 8 THEN 'PTHDFC'
                       WHEN 9 THEN 'PTSBI' WHEN 5 THEN 'PAYTM' ELSE 'OTHER' END AS split,
         l.user_id,
         CASE WHEN u.customer_id IS NULL THEN 'no_customer_id'
              WHEN s.cust_id IS NULL THEN 'no_preference_record'
              WHEN s.status = 'ACTIVE' AND lower(s.preference_value) = 'true' THEN 'enabled'
              ELSE 'not_enabled' END AS shield
  FROM lite l
  LEFT JOIN usr u    ON u.id = l.user_id
  LEFT JOIN shield s ON s.cust_id = TRY_CAST(u.customer_id AS BIGINT)
)
SELECT COALESCE(split, 'TOTAL')                   AS split,
       COUNT(*)                                   AS active_lite_users,
       COUNT_IF(shield = 'enabled')               AS shield_enabled,
       COUNT_IF(shield = 'not_enabled')           AS shield_not_enabled,
       COUNT_IF(shield = 'no_preference_record')  AS no_preference_record,
       COUNT_IF(shield = 'no_customer_id')        AS no_customer_id
FROM x
GROUP BY ROLLUP (split)`,
        shape: (r) => ({
          split: r.split,
          users: num(r.active_lite_users),
          enabled: num(r.shield_enabled),
          not_enabled: num(r.shield_not_enabled),
          no_pref: num(r.no_preference_record),
          no_cust: num(r.no_customer_id),
        }),
      },
    },
  },
  refunds: {
    title: "UPI Refunds",
    source: "redash",
    allHandles: true,
    window: (nowMs) => moneyWindow(nowMs),
    codeInfo: true,
    queries: {
      // Every section slices this: overall / per flow (mode ONLINE), payee bank SR, failure codes.
      daily: {
        title: "Refunds (day × refundType × flowType × mode × status × payee bank × reason code)",
        daily: true,
        version: 2,
        sql: REFUND_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) =>
          fetchByDay(REFUND_DAY_SQL, (r) => ({
            ts: String(r.ts).slice(0, 10),
            refund_type: r.refund_type,
            flow_type: r.flow_type,
            mode: r.mode,
            status: r.status,
            bank: r.bank ?? null,
            code: r.code ?? null,
            msg: r.msg || null,
            c: num(r.c),
            amt: num(r.amt),
          }), 2)(ctx),
      },
    },
  },
  payouts: {
    title: "Payouts",
    source: "redash",
    allHandles: true,
    window: (nowMs) => moneyWindow(nowMs),
    codeInfo: true,
    queries: {
      daily: {
        title: "Payouts (day × business_type × status × resp_code)",
        daily: true,
        version: 1,
        sql: PAYOUT_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) =>
          fetchByDay(PAYOUT_DAY_SQL, (r) => ({
            ts: String(r.ts).slice(0, 10),
            business_type: r.business_type,
            status: r.status,
            code: r.code ?? null,
            c: num(r.c),
            amt: num(r.amt),
          }), 1)(ctx),
      },
    },
  },
  mandates: {
    title: "Mandates",
    allHandles: true,
    stateOmit: { daily: (r) => MANDATE_ON_DEMAND_DIMS.includes(r.dim) },
    maxDays: WINDOW_DAYS,
    codeInfo: true,
    queries: {
      // Every section slices this: SR by stage × CC / CASA, error codes, bank / handle split.
      daily: {
        // Long ranges (> 15 days a period): stage / code rows stay daily; SR splits are summed into 7-day blocks
        // inside each period (block = its first day), so period totals stay exact and trends get weekly points.
        longRange: (rows, { to, range }) => {
          const SR = ["PAYER_BANK", "PAYEE_BANK", "MCC", "PAYER_HANDLE", "PAYEE"];
          const curFrom = addDays(to, -(range - 1));
          const out = [];
          const g = new Map();
          for (const r of rows) {
            if (!SR.includes(r.dim)) {
              out.push(r); // stage / code rows, and the split rows (kept for the newest 15 days only)
              continue;
            }
            const pEnd = r.ts >= curFrom ? to : addDays(curFrom, -1);
            const pStart = r.ts >= curFrom ? curFrom : addDays(curFrom, -range);
            const back = Math.round((Date.parse(pEnd) - Date.parse(r.ts)) / 86400000);
            let ts = addDays(pEnd, -(Math.floor(back / 7) * 7 + 6));
            if (ts < pStart) ts = pStart;
            const key = `${ts}|${r.purpose}|${r.stage}|${r.acct}|${r.mode}|${r.status}|${r.code}|${r.dim}|${r.k}`;
            const o = g.get(key);
            if (o) o.c += r.c;
            else g.set(key, { ...r, ts });
          }
          return out.concat([...g.values()]);
        },
        title: "Mandate attempts, golden unit (day × stage × purpose × mode × payer account × status × code; SR by payer bank / payee bank / MCC / payer handle / payee handle; non-success per code by response leg / payer bank / payer handle / payee bank / payee handle / payee handle × bank)",
        daily: true,
        version: 4,
        sql: MANDATE_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: async (ctx) => {
          const splitFrom = addDays(ctx.win.toDate, -MANDATE_SPLIT_DAYS);
          const trimSplit = (rows) => rows.filter((r) => !MANDATE_SPLIT_DIMS.includes(r.dim) || r.ts >= splitFrom);
          const rows = await fetchByDay(
            MANDATE_DAY_SQL,
            mandateRowShape,
            4,
            { exec: (sql, opts) => runTrino(sql, { ...opts, timeoutMs: TIMEOUT_MS, account: MANDATE_TRINO_ACCOUNT }), chunkDays: MANDATE_CHUNK_DAYS, check: checkMandateDay },
          )({ ...ctx, savePartial: (part, cover) => ctx.savePartial(trimSplit(part), cover) });
          return trimSplit(rows);
        },
      },
      // Code watch: UM8-ZM / UM8-Z6 / UO8 failures per day by mandate type (APD code_watch.sql).
      codewatch: {
        title: "Code watch (day × mandate type × UM8-ZM / UM8-Z6 / UO8: units, successes; golden unit, every purpose)",
        daily: true,
        version: 1,
        sql: CODE_WATCH_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) => seededByDay(CODE_WATCH_DAY_SQL, codeWatchShape, 1, (win) => apdMonthRows("code_watch", win, codeWatchShape))(ctx),
      },
      // Top merchants: successful purpose-14 Creates per payee, since the 1st of last month (D-1 … MTD / LMTD).
      payees: {
        title: "Top merchants (day × payee VPA / name × CC flag: successful purpose-14 Creates, distinct UMNs; every UMN on the switch)",
        daily: true,
        version: 1,
        window: (nowMs) => moneyWindow(nowMs),
        maxDays: 75,
        sql: MANDATE_PAYEE_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: async (ctx) => {
          let cached = ctx.cached;
          if (cached?.version !== 1) {
            const seed = compactPayees(apdHistoryRows("payee", ctx.win, payeeShape));
            cached = { version: 1, rows: seed };
            const last = seed.reduce((a, r) => (r.ts > a ? r.ts : a), "");
            if (last) ctx.savePartial(seed, { fromDate: ctx.win.fromDate, toDate: addDays(last, 1) });
          }
          const rows = await fetchByDay(MANDATE_PAYEE_SQL, payeeShape, 1, {
            exec: (sql, opts) => runTrino(sql, { ...opts, timeoutMs: TIMEOUT_MS, account: MANDATE_TRINO_ACCOUNT }),
            chunkDays: MANDATE_CHUNK_DAYS,
          })({ ...ctx, cached, savePartial: (part, cover) => ctx.savePartial(compactPayees(part), cover) });
          return compactPayees(rows);
        },
      },
    },
  },
  cccasa: {
    title: "CC vs CASA · P2M",
    allHandles: true,
    maxDays: WINDOW_DAYS,
    codeInfo: true,
    queries: {
      p2m: {
        title: "P2M payments by payer account (day × CC / CASA × status × code: txns; one per txn, latest status)",
        daily: true,
        version: 1,
        sql: CCCASA_P2M_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) => seededByDay(CCCASA_P2M_DAY_SQL, ccCasaShape, 1, ccCasaSeed)(ctx),
      },
    },
  },
  interop: {
    title: "Interop",
    allHandles: true,
    codeInfo: true,
    // Every day since the first APD day, so the page can show "Till date" next to the chosen days.
    window: (nowMs) => ({ fromDate: INTEROP_FIRST, toDate: ymd(new Date(istToday(nowMs))) }),
    maxDays: 800,
    queries: {
      // Sections 1–3: Update payee VPA / Update MIC by payer bank; purpose BC (Port-In) by type / source app / Paytm handle / payer bank.
      // (Not named "days": that is the day-file folder inside every query folder, see dayStore.js.)
      daily: {
        title: "Interop mandates (day × status × class UPDATE_VPA / UPDATEMIC / IN_PORT / OTHER × purpose × total / payer bank / payer handle / UMN handle / source app: distinct UMNs)",
        daily: true,
        version: INTEROP_VERSION,
        sql: INTEROP_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) => seededByDay(INTEROP_DAY_SQL, interopShape, INTEROP_VERSION, (win) => apdHistoryRows("interop_days", win, interopShape))(ctx),
      },
      // Section 4: Port-Out (purpose BC UPDATE onto another app's UMN) by app, payer bank, failure code.
      port_out: {
        title: "Port-Out (day × status × payer bank × other app's handle × failure code: distinct new UMNs)",
        daily: true,
        version: INTEROP_VERSION,
        sql: PORT_OUT_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: (ctx) => seededByDay(PORT_OUT_DAY_SQL, portOutShape, INTEROP_VERSION, portOutSeed)(ctx),
      },
    },
  },
  iccw: {
    title: "ICCW",
    allHandles: true,
    maxDays: WINDOW_DAYS,
    codeInfo: true,
    queries: {
      // Every section slices this: daily SR, purpose, acquirer / Paytm handle / remitter bank / amount / hour, failure codes + where they fail.
      daily: {
        title: "ICCW txns (day × purpose × total / acquirer / Paytm handle / remitter bank / amount band / hour / code; code × acquirer, code × remitter bank)",
        daily: true,
        version: ICCW_VERSION,
        sql: ICCW_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: async (ctx) => {
          // First fill (or a new version): reuse the APD's per-day CSVs, so only missing / unsettled days hit Trino.
          const compact = (rows) => compactIccw(rows, ctx.win.toDate);
          let cached = ctx.cached;
          if (cached?.version !== ICCW_VERSION) {
            const seed = iccwSeed(ctx.win);
            cached = { version: ICCW_VERSION, rows: seed };
            // Save the seeded days at once, so the tab has data even if Trino is down for the newest days.
            const last = seed.reduce((a, r) => (r.ts > a ? r.ts : a), "");
            if (last) ctx.savePartial(compact(seed), { fromDate: ctx.win.fromDate, toDate: addDays(last, 1) });
          }
          const rows = await fetchByDay(ICCW_DAY_SQL, iccwShape, ICCW_VERSION, {
            exec: (sql, opts) => runTrino(sql, { ...opts, timeoutMs: TIMEOUT_MS, account: ICCW_TRINO_ACCOUNT }),
            chunkDays: MANDATE_CHUNK_DAYS,
            check: checkIccwDay,
          })({ ...ctx, cached, savePartial: (part, cover) => ctx.savePartial(compact(part), cover) });
          return compact(rows);
        },
      },
    },
  },
};

const num = (v) => (v == null ? 0 : Number(v) || 0);

// ─── History backfill: days before the live window, written to the day files only (As-of / long ranges) ───
// history(win): rows from the APD history imported to data/product/_apd-history (no query);
// trinoDay: the live per-day SQL, one Trino query per missing day; trinoRange: the query's window SQL in 30-day blocks.
// The live cache (meta.json, 30-day window) is never touched; a saved day is never overwritten.
export const BACKFILL = {
  "mandates/daily": {
    first: "2026-01-01",
    trinoDay: { sql: MANDATE_DAY_SQL, shape: mandateRowShape, check: checkMandateDay, keep: (r) => !MANDATE_SPLIT_DIMS.includes(r.dim), account: MANDATE_TRINO_ACCOUNT },
  },
  "mandates/payees": { first: "2026-09-01", history: (win) => compactPayees(apdHistoryRows("payee", win, payeeShape)) },
  "mandates/codewatch": { first: "2026-08-01", history: (win) => apdMonthRows("code_watch", win, codeWatchShape) },
  "iccw/daily": { first: "2025-10-01", history: (win) => compactIccw(iccwSeed(win), win.fromDate) },
  "international/global": { first: "2026-09-15", history: (win) => globalSeed(win) },
  "international/activation_fail": { first: "2026-09-15", history: (win) => actFailSeed(win) },
  "international/txn_detail": { first: "2026-09-15", history: (win) => globalTxnSeed(win) },
  "international/activation": { first: "2026-09-15", trinoRange: true },
  "international/txns": { first: "2026-09-15", trinoRange: true },
  "international/countries": { first: "2026-09-15", trinoRange: true },
  "international/errors": { first: "2026-09-15", trinoRange: true },
  "cccasa/p2m": { first: "2026-09-01", history: (win) => ccCasaSeed(win) },
};

// Normalise Trino rows per query (numbers as numbers, ts as YYYY-MM-DD).
const SHAPE = {
  activation: (r) => ({ ts: String(r.ts).slice(0, 10), handle: r.handle, bank: r.bank, attempts: num(r.attempts), activated: num(r.activated) }),
  txns: (r) => ({ ts: String(r.ts).slice(0, 10), handle: r.handle, status: r.status, c: num(r.c), amt: num(r.amt) }),
  countries: (r) => ({ ts: String(r.ts).slice(0, 10), handle: r.handle, country: r.country, total: num(r.total), succ: num(r.succ), term: num(r.term) }),
  errors: (r) => ({ ts: String(r.ts).slice(0, 10), handle: r.handle, bank: r.bank, status: r.status, code: r.code, app: r.app, c: num(r.c), amt: num(r.amt) }),
};

// ─── Window ──────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** UTC-midnight ms of today's IST date. */
function istToday(nowMs) {
  const wall = new Date(nowMs + TZ_OFFSET_MIN * 60000);
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
}

/** Last WINDOW_DAYS complete IST days: [fromDate, toDate) with toDate = today. */
export function productWindow(nowMs = Date.now(), product = null, days) {
  if (product && PRODUCTS[product]?.window) return PRODUCTS[product].window(nowMs, days);
  const today = istToday(nowMs);
  return { fromDate: ymd(new Date(today - WINDOW_DAYS * 86400000)), toDate: ymd(new Date(today)) };
}

const addDays = (d, n) => ymd(new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000));

function renderSql(product, query, win) {
  return PRODUCTS[product].queries[query].sql
    .replaceAll("{{FROM_DATE}}", win.fromDate)
    .replaceAll("{{TO_DATE}}", win.toDate)
    .replaceAll("{{TREND_FROM}}", addDays(win.toDate, -LITE_AUTOPAY_TREND_DAYS))
    .replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", "));
}

/**
 * Merge a daily query's new rows into its cached rows: the new window's days are replaced,
 * other cached days kept when the two windows touch or overlap (else the cache is replaced).
 * Coverage is trimmed to maxDays before toDate. Returns { rows, window } (window = coverage).
 */
function mergeDaily(prev, rows, win, maxDays) {
  const touches = prev?.window && prev.window.toDate >= win.fromDate && prev.window.fromDate <= win.toDate;
  let cover = touches
    ? { fromDate: prev.window.fromDate < win.fromDate ? prev.window.fromDate : win.fromDate, toDate: prev.window.toDate > win.toDate ? prev.window.toDate : win.toDate }
    : { ...win };
  if (maxDays) {
    const floor = addDays(cover.toDate, -maxDays);
    if (cover.fromDate < floor) cover = { ...cover, fromDate: floor };
  }
  const kept = touches ? prev.rows.filter((r) => r.ts < win.fromDate || r.ts >= win.toDate) : [];
  return { rows: [...kept, ...rows].filter((r) => r.ts >= cover.fromDate && r.ts < cover.toDate), window: cover };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** history: optional store from historyStore.js — every query run is also written there. */
export function registerProductDashboard(app, { dataDir, history = null }) {
  // cache: { [product]: { [query]: { rows, window, finishedAt, durationMs } } } — in memory; on disk one folder per
  // query under data/product/<product>/<query>/ (meta.json + days/YYYY-MM-DD.json, see dayStore.js), so a run rewrites
  // only the days it changed instead of the whole cache. The old single product-cache.json is migrated once.
  const store = createStoreGroup(path.join(dataDir, "product"));
  const cache = {};
  for (const name of store.list()) {
    const [p, q] = name.split("/");
    if (PRODUCTS[p]?.queries[q]) (cache[p] ||= {})[q] = store.load(name);
  }
  const legacyFile = path.join(dataDir, "product-cache.json");
  const legacy = readJsonFile(legacyFile, null);
  if (legacy) {
    for (const [p, qs] of Object.entries(legacy)) {
      for (const [q, v] of Object.entries(qs || {})) {
        if (!PRODUCTS[p]?.queries[q] || cache[p]?.[q] || !v) continue;
        (cache[p] ||= {})[q] = v;
        store.save(`${p}/${q}`, v);
      }
    }
    console.log(`[product] migrated product-cache.json to ${store.root} (old file kept as ${path.basename(retireLegacy(legacyFile) || "")})`);
  }
  // versionSince: first day saved with the query's current row version. Day files are never deleted, so after a
  // version bump older days on disk have another row shape; the as-of view skips days before this.
  const versionAt = {};
  for (const [p, qs] of Object.entries(cache)) for (const [q, v] of Object.entries(qs)) versionAt[`${p}/${q}`] = { version: v?.version ?? null, since: v?.versionSince ?? null };
  const persist = (product, query) => {
    try {
      const v = cache[product]?.[query];
      if (v) {
        const key = `${product}/${query}`;
        const was = versionAt[key];
        if (!was || was.version !== (v.version ?? null)) versionAt[key] = { version: v.version ?? null, since: was ? v.window?.fromDate ?? null : null };
        if (versionAt[key].since) v.versionSince = versionAt[key].since;
      }
      store.save(`${product}/${query}`, cache[product]?.[query]);
    } catch (e) {
      console.warn(`[product] could not persist ${product}/${query}: ${e.message}`);
    }
  };
  // jobs: { [product]: { [query]: { status: idle|running|done|error|stopped, error?, startedAt?, finishedAt? } } }
  const jobs = Object.fromEntries(
    Object.entries(PRODUCTS).map(([p, def]) => [p, Object.fromEntries(Object.keys(def.queries).map((q) => [q, { status: cache[p]?.[q] ? "done" : "idle" }]))]),
  );
  // inFlight: { [product]: { [query]: { promise, ctrl } } } — one run per query at a time.
  const inFlight = Object.fromEntries(Object.keys(PRODUCTS).map((p) => [p, {}]));
  const isRunning = (product) => Object.keys(inFlight[product]).length > 0;
  let lastScheduledSlot = null;

  const productOf = (v) => {
    const p = String(v || "international");
    if (!PRODUCTS[p]) throw new Error(`Unknown product ${p}`);
    return p;
  };

  async function runQuery(product, query, win, trigger, signal) {
    const def = PRODUCTS[product];
    const spec = def.queries[query];
    const sql = renderSql(product, query, win);
    const startedAt = Date.now();
    jobs[product][query] = { status: "running", startedAt };
    const histId = history?.start(
      {
        dashboard: "product",
        section: `${product}-${query}`,
        sectionTitle: `${def.title} · ${def.queries[query].title}`,
        subject: `${def.title} — ${def.queries[query].title}${trigger === "scheduled" ? " (auto)" : ""}`,
        taskName: `Product Wise · ${def.title} · ${def.queries[query].title} (${win.fromDate} → ${win.toDate}, exclusive)`,
        trigger: trigger === "scheduled" ? "schedule" : "manual",
        durationLabel: `${win.fromDate} → ${win.toDate}`,
        engine: def.source || "trino",
        window: { from: win.fromDate, to: win.toDate },
        sql,
        rerun: { product },
      },
      "running",
    );
    // Rows cached by an older query version have other columns: never merge them with new rows.
    const sameVersion = () => (cache[product]?.[query]?.version || null) === (spec.version || null) ? cache[product]?.[query] : null;
    // A chunked run() saves what it has so far: merged like a finished daily run, marked partial.
    const savePartial = (rows, cover) => {
      if (signal.aborted) return;
      const merged = spec.daily ? mergeDaily(sameVersion(), rows, cover, spec.maxDays ?? def.maxDays) : { rows, window: cover };
      cache[product] ||= {};
      cache[product][query] = { ...merged, finishedAt: Date.now(), durationMs: Date.now() - startedAt, partial: true, ...(spec.version ? { version: spec.version } : {}) };
      persist(product, query);
    };
    try {
      let raw;
      for (let attempt = 0; ; attempt += 1) {
        try {
          raw = spec.run
            ? await spec.run({ dataDir, signal, win, cached: cache[product]?.[query], onProgress: (note) => (jobs[product][query] = { status: "running", startedAt, note }), savePartial })
            : await runTrino(sql, { timeoutMs: TIMEOUT_MS, signal });
          break;
        } catch (err) {
          if (signal.aborted || !isTransient(err) || attempt >= RETRY_WAITS_MS.length) throw err;
          console.log(`[product:${product}] ${query} attempt ${attempt + 1} failed (${err.message}) — retrying in ${RETRY_WAITS_MS[attempt] / 1000}s`);
          jobs[product][query] = { status: "running", startedAt, note: `retry ${attempt + 1}` };
          await sleep(RETRY_WAITS_MS[attempt], signal);
        }
      }
      // A run() source that ignores the signal may still finish after Stop; drop its result.
      if (signal.aborted) throw signal.reason;
      let rows = raw.map(spec.shape || SHAPE[query] || ((r) => r)).filter((r) => def.allHandles || r.handle);
      let coverage = win;
      if (spec.snapshot) {
        const kept = (cache[product]?.[query]?.rows || []).filter((r) => r.asOf && r.asOf !== win.toDate);
        const dates = [...new Set(kept.map((r) => r.asOf))].sort().slice(-(LITE_SNAPSHOTS_KEPT - 1));
        rows = [...kept.filter((r) => dates.includes(r.asOf)), ...rows.map((r) => ({ ...r, asOf: win.toDate }))];
      } else if (spec.daily) {
        ({ rows, window: coverage } = mergeDaily(sameVersion(), rows, win, spec.maxDays ?? def.maxDays));
      }
      const finishedAt = Date.now();
      cache[product] ||= {};
      cache[product][query] = { rows, window: coverage, finishedAt, durationMs: finishedAt - startedAt, ...(spec.version ? { version: spec.version } : {}) };
      persist(product, query);
      jobs[product][query] = { status: "done", startedAt, finishedAt };
      history?.update(histId, { event: "success", elapsedMs: finishedAt - startedAt, rowCount: rows.length, analysis: analyze("product", `${product}-${query}`, rows) });
    } catch (err) {
      if (signal.aborted) {
        jobs[product][query] = { status: "stopped", startedAt, finishedAt: Date.now() };
        history?.update(histId, { event: "cancelled", error: "Stopped by user", elapsedMs: Date.now() - startedAt });
        return;
      }
      jobs[product][query] = { status: "error", error: err.message, startedAt, finishedAt: Date.now() };
      history?.update(histId, { event: "failed", error: err.message, elapsedMs: Date.now() - startedAt });
    }
  }

  // Refresh all / schedule: every query except manual ones.
  const autoQueries = (product) => Object.keys(PRODUCTS[product].queries).filter((q) => !PRODUCTS[product].queries[q].manual);

  /**
   * Window for one run of a query. days (daily queries only) = "make sure the last `days`
   * days are cached": only the days before the cached coverage are fetched, or null when
   * already covered.
   */
  function windowFor(product, query, days) {
    const def = PRODUCTS[product];
    const spec = def.queries[query];
    if (spec.window && !days) return spec.window(Date.now()); // query with its own window (e.g. mandate payees: LMTD)
    if (!days || !spec.daily) return productWindow(Date.now(), product);
    const want = productWindow(Date.now(), product, Math.min(days, def.maxDays || days));
    const cover = cache[product]?.[query]?.window;
    if (!cover || cover.toDate < want.toDate) return want;
    if (cover.fromDate <= want.fromDate) return null;
    return { fromDate: want.fromDate, toDate: cover.fromDate };
  }

  /** Start the given queries of a product (default: all but manual); running ones are skipped. */
  function runProduct(product, trigger = "manual", queries = autoQueries(product), { days } = {}) {
    const started = [];
    for (const q of queries) {
      if (inFlight[product][q]) continue;
      const win = windowFor(product, q, days);
      if (!win) continue;
      console.log(`[product:${product}] ${trigger} run ${q} ${win.fromDate} → ${win.toDate}`);
      const ctrl = new AbortController();
      const promise = runQuery(product, q, win, trigger, ctrl.signal).finally(() => {
        if (inFlight[product][q]?.ctrl === ctrl) delete inFlight[product][q];
      });
      inFlight[product][q] = { promise, ctrl };
      started.push(q);
    }
    return { started };
  }

  /** Stop the given running queries of a product (default: all). */
  function stopProduct(product, queries = Object.keys(inFlight[product])) {
    const stopped = queries.filter((q) => inFlight[product][q]);
    for (const q of stopped) inFlight[product][q].ctrl.abort(new Error("Stopped by user"));
    if (stopped.length) console.log(`[product:${product}] stopped ${stopped.join(", ")}`);
    return { stopped };
  }

  // Scheduler: products with refreshEveryMin refresh on that interval; the rest fire at
  // each SCHEDULE_AT slot (IST) once per day.
  setInterval(() => {
    for (const [p, def] of Object.entries(PRODUCTS)) {
      if (!def.refreshEveryMin || isRunning(p)) continue;
      const last = Math.min(...autoQueries(p).map((q) => cache[p]?.[q]?.finishedAt || jobs[p][q].finishedAt || 0));
      if (Date.now() - last >= def.refreshEveryMin * 60000) void runProduct(p, "scheduled");
    }
    const wall = new Date(Date.now() + TZ_OFFSET_MIN * 60000);
    const hm = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
    const due = SCHEDULE_AT.filter((t) => t <= hm).pop();
    if (!due) return;
    const slot = `${ymd(wall)} ${due}`;
    if (slot === lastScheduledSlot) return;
    lastScheduledSlot = slot;
    const slotMs = Date.parse(`${slot.replace(" ", "T")}:00Z`) - TZ_OFFSET_MIN * 60000;
    for (const p of Object.keys(PRODUCTS)) {
      if (PRODUCTS[p].refreshEveryMin) continue;
      // Only queries without a result since this slot (e.g. after a backend restart, don't
      // re-run the whole product because one query keeps failing).
      const stale = autoQueries(p).filter((q) => !(cache[p]?.[q]?.finishedAt >= slotMs));
      if (stale.length) runProduct(p, "scheduled", stale);
    }
  }, 60000).unref?.();

  /** Descriptions for every failure code in a product's cached rows. */
  const codeInfoOf = (pc) => {
    const out = {};
    for (const q of Object.values(pc || {}))
      for (const r of q.rows || []) {
        const c = r.code || (r.dim === "CODE" ? r.k : null); // International "global" rows carry the code as the CODE key
        if (c && !(c in out)) out[c] = describeCode(c);
      }
    return out;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

  // /state leaves out rows a product marks as on-demand (stateOmit[query](row)); /rows serves them filtered.
  const stateCache = (product) => {
    const omit = PRODUCTS[product].stateOmit || {};
    const out = {};
    for (const [q, v] of Object.entries(cache[product] || {})) out[q] = omit[q] ? { ...v, rows: v.rows.filter((r) => !omit[q](r)), omitted: true } : v;
    return out;
  };
  // ─── History backfill (see BACKFILL): fills day files before the live window, never touches the live cache ───
  const backfills = {}; // "<product>/<query>" → { status, from, to, done, total, written, error, startedAt, finishedAt }
  const backfillAborts = {};
  async function backfillOne(product, query, { from, to } = {}, signal) {
    const key = `${product}/${query}`;
    const spec = BACKFILL[key];
    const def = PRODUCTS[product].queries[query];
    const live = cache[product]?.[query];
    // Up to the day before the live window (or `to`), from the first day the source has (or `from`).
    const liveFrom = live?.window?.fromDate || addDays(productWindow(Date.now(), product).toDate, -WINDOW_DAYS);
    const end = to && to < liveFrom ? addDays(to, 1) : liveFrom; // exclusive
    const start = from && from > spec.first ? from : spec.first;
    const st = (backfills[key] = { status: "running", from: start, to: addDays(end, -1), done: 0, total: 0, written: 0, error: null, startedAt: Date.now(), finishedAt: null });
    const have = new Set(store.savedDays(key));
    const days = [];
    for (let d = start; d < end; d = addDays(d, 1)) if (!have.has(d)) days.push(d);
    st.total = days.length;
    const write = (rows) => (st.written += store.writeDays(key, rows).length);
    if (!days.length) return;
    if (spec.history) {
      write(spec.history({ fromDate: start, toDate: end }).filter((r) => !have.has(r.ts)));
      st.done = days.length;
      return;
    }
    const exec = (sql) => runTrino(sql, { signal, timeoutMs: TIMEOUT_MS, account: spec.trinoDay?.account || MANDATE_TRINO_ACCOUNT });
    const withRetry = async (fn) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await fn();
        } catch (err) {
          if (signal.aborted || !isTransient(err) || attempt >= DAY_RETRY_WAITS_MS.length) throw err;
          await sleep(DAY_RETRY_WAITS_MS[attempt], signal);
        }
      }
    };
    if (spec.trinoDay) {
      const { sql, shape, check, keep = () => true } = spec.trinoDay;
      const queue = days.slice().reverse(); // newest first: the days next to the live window land first
      await Promise.all(
        Array.from({ length: Math.min(MANDATE_CHUNK_DAYS, queue.length) }, async () => {
          while (queue.length && !signal.aborted) {
            const d = queue.shift();
            const raw = await withRetry(() => exec(sql.replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", ")).replaceAll("{{DAY}}", d).replaceAll("{{NEXT_DAY}}", addDays(d, 1))));
            check?.(raw, d);
            write(raw.map(shape).filter(keep));
            st.done += 1;
          }
        }),
      );
      return;
    }
    if (spec.trinoRange) {
      for (let a = start; a < end && !signal.aborted; a = addDays(a, 30)) {
        const b = addDays(a, 30) < end ? addDays(a, 30) : end;
        const sql = renderSql(product, query, { fromDate: a, toDate: b });
        const raw = await withRetry(() => exec(sql));
        const shape = def.shape || SHAPE[query] || ((r) => r);
        write(raw.map(shape).filter((r) => (PRODUCTS[product].allHandles || r.handle) && !have.has(r.ts)));
        st.done += Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
      }
    }
  }
  function startBackfill(product, queries, opts) {
    const list = (queries || Object.keys(PRODUCTS[product].queries)).filter((q) => BACKFILL[`${product}/${q}`]);
    if (!list.length) throw new Error(`nothing to backfill for ${product}`);
    if (backfillAborts[product]) throw new Error(`a backfill for ${product} is already running`);
    const ctrl = new AbortController();
    backfillAborts[product] = ctrl;
    (async () => {
      for (const q of list) {
        const key = `${product}/${q}`;
        try {
          await backfillOne(product, q, opts, ctrl.signal);
          if (backfills[key]) Object.assign(backfills[key], { status: ctrl.signal.aborted ? "stopped" : "done", finishedAt: Date.now() });
        } catch (err) {
          backfills[key] = { ...(backfills[key] || {}), status: ctrl.signal.aborted ? "stopped" : "error", error: err.message, finishedAt: Date.now() };
          console.warn(`[product] backfill ${key}: ${err.message}`);
        }
        console.log(`[product] backfill ${key}: ${backfills[key]?.status} · ${backfills[key]?.written || 0} days written`);
        if (ctrl.signal.aborted) break;
      }
      delete backfillAborts[product];
    })();
    return { started: list };
  }
  // POST /api/product/backfill { product, query?, from?, to? } · GET /api/product/backfill · POST /api/product/backfill/stop { product }
  app.post(
    "/api/product/backfill",
    handle((req) => {
      const product = productOf(req.body?.product);
      return startBackfill(product, queriesOf(product, req.body?.query), { from: req.body?.from, to: req.body?.to });
    }),
  );
  app.get(
    "/api/product/backfill",
    handle(() => ({ backfills, running: Object.keys(backfillAborts) })),
  );
  app.post(
    "/api/product/backfill/stop",
    handle((req) => {
      const product = productOf(req.body?.product);
      backfillAborts[product]?.abort();
      return { stopped: Boolean(backfillAborts[product]) };
    }),
  );

  // ─── CC vs CASA before / after a pivot day (APD RCC prioritisation) — JSON for the tab, or the .xlsx ───
  // GET /api/product/cccasa/compare?pivot=2026-10-07[&from=&to=][&format=xlsx]
  app.get("/api/product/cccasa/compare", (req, res) => {
    try {
      const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : undefined);
      const cmp = buildCompare({
        readRange: (name, a, b) => store.readRange(name, a, b),
        savedDays: (name) => store.savedDays(name),
        describe: describeCode,
        party: codeParty,
        pivot: day(req.query.pivot),
        from: day(req.query.from),
        to: day(req.query.to),
      });
      if (cmp.error) return res.status(404).json({ success: false, error: cmp.error });
      if (req.query.format === "xlsx") {
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="CC_vs_CASA_before_after_${cmp.pivot}_${cmp.to}.xlsx"`);
        return res.send(workbook(cmp));
      }
      res.json({ success: true, ...cmp });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ─── APD per-table SQL (backend/reference/apd-sql/…): the "View query" text of a table, placeholders unfilled ───
  // GET /api/product/apd-sql?path=mandate/tables/05_failure_codes.sql
  const APD_SQL_DIR = path.resolve(new URL("./reference/apd-sql/", import.meta.url).pathname);
  app.get("/api/product/apd-sql", (req, res) => {
    const rel = String(req.query.path || "");
    const file = path.resolve(APD_SQL_DIR, rel);
    if (!rel.endsWith(".sql") || !file.startsWith(APD_SQL_DIR + path.sep) || !fs.existsSync(file)) return res.status(404).json({ success: false, error: "unknown query file" });
    res.json({ success: true, path: rel, sql: fs.readFileSync(file, "utf8") });
  });

  // ─── As-of view: a product as it stood on an earlier day, from the saved day files (read-only) ───
  const dayCount = (w) => (w?.fromDate && w?.toDate ? Math.round((Date.parse(w.toDate) - Date.parse(w.fromDate)) / 86400000) : WINDOW_DAYS);
  /** Saved days of a product's daily queries: { first, last } across queries + per query. */
  const savedOf = (product) => {
    const per = {};
    for (const q of Object.keys(PRODUCTS[product].queries)) {
      const since = cache[product]?.[q]?.versionSince || "";
      const days = store.savedDays(`${product}/${q}`).filter((d) => d >= since);
      if (days.length) per[q] = { first: days[0], last: days[days.length - 1], n: days.length };
    }
    const v = Object.values(per);
    return { first: v.length ? v.map((x) => x.first).sort()[0] : null, last: v.length ? v.map((x) => x.last).sort().pop() : null, queries: per };
  };
  /** Rows of a daily query for the window of its usual length ending on `to` (inclusive). */
  const asOfRows = (product, query, to, range = 0) => {
    const live = cache[product]?.[query];
    const n = Math.max(dayCount(live?.window), 2 * range); // current + previous period of `range` days
    const toDate = addDays(to, 1);
    let from = addDays(toDate, -n);
    if (live?.versionSince && from < live.versionSince) from = live.versionSince;
    const { rows, days } = store.readRange(`${product}/${query}`, from, to);
    return { rows, window: { fromDate: days[0] || from, toDate }, days: days.length };
  };
  const asOfDay = (v) => {
    const to = String(v || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("give to=YYYY-MM-DD");
    return to;
  };
  // GET /api/product/asof?product=mandates&to=2026-10-31[&range=30] — the product's cache as of that day (saved day
  // files only); range = days per period, so current + previous period are loaded (long ranges: up to 366).
  app.get(
    "/api/product/asof",
    handle((req) => {
      const product = productOf(req.query.product);
      const to = asOfDay(req.query.to);
      const omit = PRODUCTS[product].stateOmit || {};
      const out = {};
      const range = Math.min(Math.max(Number(req.query.range) || 0, 0), 366);
      for (const [q, spec] of Object.entries(PRODUCTS[product].queries)) {
        const live = cache[product]?.[q];
        if (!store.savedDays(`${product}/${q}`).length) {
          if (live) out[q] = live; // snapshots / lookups (no day files): the current copy
          continue;
        }
        let { rows, window, days } = asOfRows(product, q, to, range);
        if (!days) continue;
        if (omit[q]) rows = rows.filter((r) => !omit[q](r));
        // Long ranges: a query may thin its rows (mandates: splits summed into 7-day blocks per period).
        if (range && 2 * range > WINDOW_DAYS && spec.longRange) rows = spec.longRange(rows, { to, range });
        out[q] = { ...(live || {}), rows, window, partial: false, asOf: to, range: range || null, ...(omit[q] ? { omitted: true } : {}) };
      }
      return {
        product,
        asOf: to,
        saved: savedOf(product),
        cache: out,
        ...(PRODUCTS[product].codeInfo ? { codeInfo: codeInfoOf(out) } : {}),
        ...(PRODUCTS[product].extras ? PRODUCTS[product].extras() : {}),
      };
    }),
  );

  // GET /api/product/rows?product=mandates&query=daily&dim=HANDLE_X_BANK&stage=CREATE&code=UM3[&purpose=14][&to=YYYY-MM-DD] — exact-match filters; to = as-of view.
  app.get(
    "/api/product/rows",
    handle((req) => {
      const product = productOf(req.query.product);
      const query = String(req.query.query || "daily");
      if (!PRODUCTS[product].queries[query]) throw new Error(`Unknown query ${query}`);
      const filters = Object.entries(req.query).filter(([k, v]) => !["product", "query", "to"].includes(k) && v !== "" && v != null);
      if (!filters.length) throw new Error("give at least one filter (e.g. dim)");
      const src = req.query.to ? asOfRows(product, query, asOfDay(req.query.to)).rows : cache[product]?.[query]?.rows || [];
      const rows = src.filter((r) => filters.every(([k, v]) => String(r[k] ?? "") === String(v)));
      return { product, query, count: rows.length, rows };
    }),
  );

  app.get(
    "/api/product/state",
    handle((req) => {
      const product = productOf(req.query.product);
      return {
        product,
        products: Object.fromEntries(Object.entries(PRODUCTS).map(([p, d]) => [p, d.title])),
        handles: HANDLES,
        schedule: PRODUCTS[product].refreshEveryMin ? [`every ${PRODUCTS[product].refreshEveryMin} min`] : SCHEDULE_AT,
        running: isRunning(product),
        jobs: jobs[product],
        cache: stateCache(product),
        window: productWindow(Date.now(), product),
        saved: savedOf(product),
        ...(PRODUCTS[product].codeInfo ? { codeInfo: codeInfoOf(cache[product]) } : {}),
        ...(PRODUCTS[product].extras ? PRODUCTS[product].extras() : {}),
      };
    }),
  );

  // Optional body.query (name or list) narrows /run and /stop to one panel's queries.
  const queriesOf = (product, q) => {
    if (q == null || q === "") return undefined;
    const list = (Array.isArray(q) ? q : [q]).map(String);
    for (const name of list) if (!PRODUCTS[product].queries[name]) throw new Error(`Unknown query ${name}`);
    return list;
  };

  // body.days (daily queries): extend cached coverage to the last `days` days.
  app.post(
    "/api/product/run",
    handle((req) => {
      const product = productOf(req.body?.product);
      const days = Number(req.body?.days) || undefined;
      return runProduct(product, "manual", queriesOf(product, req.body?.query), { days });
    }),
  );

  app.post(
    "/api/product/stop",
    handle((req) => {
      const product = productOf(req.body?.product);
      return stopProduct(product, queriesOf(product, req.body?.query));
    }),
  );

  app.get(
    "/api/product/sql",
    handle((req) => {
      const product = productOf(req.query.product);
      const query = String(req.query.query || "");
      if (!PRODUCTS[product].queries[query]) throw new Error(`Unknown query ${query}`);
      return { product, query, sql: renderSql(product, query, productWindow(Date.now(), product)) };
    }),
  );

  /**
   * One headline per product for the Today page, from the cache only (no query): the latest day with data,
   * its value, the average of the 7 days before and a 14-day series. kind "sr" values are % (delta in pp),
   * kind "count" values are counts (delta in %).
   */
  function summary() {
    const rowsOf = (p, q) => cache[p]?.[q]?.rows || [];
    // byDay(rows, fn) → Map(day → { n, d }) where fn(row) returns [num, den] or null.
    const byDay = (rows, fn) => {
      const m = new Map();
      for (const r of rows) {
        const v = fn(r);
        if (!v || !r.ts) continue;
        const day = String(r.ts).slice(0, 10);
        const o = m.get(day) || { n: 0, d: 0 };
        o.n += v[0];
        o.d += v[1];
        m.set(day, o);
      }
      return m;
    };
    const headline = (m, kind) => {
      const days = [...m.keys()].sort();
      const val = (d) => {
        const o = m.get(d);
        return kind === "sr" ? (o.d ? (100 * o.n) / o.d : null) : o.n;
      };
      const day = days[days.length - 1] || null;
      if (!day) return null;
      const prev = days.slice(-8, -1).map(val).filter((v) => v != null);
      const prevAvg = prev.length ? prev.reduce((a, v) => a + v, 0) / prev.length : null;
      const value = val(day);
      const delta = value == null || prevAvg == null ? null : kind === "sr" ? value - prevAvg : prevAvg ? (100 * (value - prevAvg)) / prevAvg : null;
      return { day, value, volume: m.get(day).d, prevAvg, delta, series: days.slice(-14).map(val) };
    };
    const ok = (s) => (s === "SUCCESS" ? 1 : 0);
    const meta = (p, qs) => {
      const list = qs.map((q) => ({ job: jobs[p][q], c: cache[p]?.[q] }));
      return {
        finishedAt: Math.max(0, ...list.map((x) => x.c?.finishedAt || 0)) || null,
        running: list.some((x) => x.job?.status === "running"),
        error: list.map((x) => (x.job?.status === "error" ? x.job.error : null)).find(Boolean) || null,
      };
    };
    const out = [];
    const add = (id, title, label, kind, m, qs, extra = []) => {
      const h = headline(m, kind);
      out.push({ id, title, label, kind, ...(h || { day: null }), extra: extra.filter((e) => e && e.value != null), ...meta(id, qs) });
    };

    const mand = rowsOf("mandates", "daily").filter((r) => r.dim === "ALL" && r.purpose === "14");
    const stageSr = (stage) => headline(byDay(mand.filter((r) => r.stage === stage), (r) => [r.status === "SUCCESS" ? r.c : 0, r.c]), "sr");
    const e1 = stageSr("EXEC1");
    const er = stageSr("EXECR");
    add("mandates", "Mandates", "Create SR · purpose 14", "sr", byDay(mand.filter((r) => r.stage === "CREATE"), (r) => [r.status === "SUCCESS" ? r.c : 0, r.c]), ["daily"], [
      e1 && { label: "1st execution SR", value: e1.value, kind: "sr", delta: e1.delta },
      er && { label: "Recurring execution SR", value: er.value, kind: "sr", delta: er.delta },
    ]);

    const iccw = rowsOf("iccw", "daily").filter((r) => r.dim === "TOTAL");
    const iccwCash = headline(byDay(iccw, (r) => [r.samt, 0]), "count");
    add("iccw", "ICCW", "Cash withdrawal SR", "sr", byDay(iccw, (r) => [r.suc, r.att]), ["daily"], [iccwCash && { label: "Cash withdrawn ₹", value: iccwCash.value, kind: "inr", delta: iccwCash.delta }]);

    const ix = rowsOf("interop", "daily").filter((r) => r.dim === "TOTAL");
    const ixSr = (cls) => headline(byDay(ix.filter((r) => r.cls === cls), (r) => [ok(r.status) * r.n, r.n]), "sr");
    const mic = ixSr("UPDATEMIC");
    const vpa = ixSr("UPDATE_VPA");
    add("interop", "Interop", "Port-In SR · purpose BC", "sr", byDay(ix.filter((r) => r.cls === "IN_PORT" && r.purpose === "BC"), (r) => [ok(r.status) * r.n, r.n]), ["daily", "port_out"], [
      mic && { label: "Update MIC SR", value: mic.value, kind: "sr", delta: mic.delta },
      vpa && { label: "Update VPA SR", value: vpa.value, kind: "sr", delta: vpa.delta },
    ]);

    const act = headline(byDay(rowsOf("international", "activation"), (r) => [r.activated, r.attempts]), "sr");
    add("international", "UPI International", "Txn SR", "sr", byDay(rowsOf("international", "txns"), (r) => [ok(r.status) * r.c, r.c]), ["txns", "activation"], [act && { label: "Activation SR", value: act.value, kind: "sr", delta: act.delta }]);

    const liteGmv = headline(byDay(rowsOf("lite", "gmv"), (r) => [r.gmv, 0]), "count");
    add("lite", "UPI Lite", "Successful Lite payments", "count", byDay(rowsOf("lite", "gmv"), (r) => [r.success, 0]), ["gmv"], [liteGmv && { label: "Lite GMV ₹", value: liteGmv.value, kind: "inr", delta: liteGmv.delta }]);

    add("refunds", "UPI Refunds", "Refund SR", "sr", byDay(rowsOf("refunds", "daily"), (r) => [ok(r.status) * r.c, r.c]), ["daily"]);
    add("payouts", "Payouts", "Payout SR", "sr", byDay(rowsOf("payouts", "daily"), (r) => [ok(r.status) * r.c, r.c]), ["daily"]);

    const plug = rowsOf("plugin", "daily");
    const pl = plug.reduce((a, r) => (!a || r.ts > a.ts ? r : a), null);
    out.push({ id: "plugin", title: "UPI Plugin", label: "Users onboarded", kind: "count", day: pl?.ts || null, value: pl?.users ?? null, extra: pl ? [{ label: "Accounts", value: pl.accounts, kind: "count" }, { label: "VPAs", value: pl.vpas, kind: "count" }] : [], ...meta("plugin", ["daily"]) });
    return out;
  }

  // Used by the History tab's Re-run (refreshes every query of the product).
  return {
    summary,
    rerun(rec = {}) {
      const product = productOf(rec.product);
      if (isRunning(product)) return { started: "Already running — results will update shortly" };
      runProduct(product, "manual");
      return { started: `Product Wise · ${PRODUCTS[product].title} (all sections)` };
    },
  };
}
