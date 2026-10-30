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
import path from "path";
import { runTrino, runRedashWithEnv, sleep } from "./trinoClient.js";
import { analyze } from "./historyInsights.js";
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

// Mandates: one Trino SQL per IST day over switch txn_info + txn_participants (~1–2 min a day).
// Unit = the team's mandate SR definition (UPI Error Code Spikes Mandate tab / CC vs CASA autopay
// SR): executions (COLLECT) count once per UMN + payer scope_cust_id + execution number per day,
// latest status; CREATE / REVOKE / PAUSE / UNPAUSE once per txn; payer handle 'paytm' excluded;
// COLLECT without an execution number dropped. Payer account: CC = CREDIT, CASA = SAVINGS /
// CURRENT, else OTHER. Failure code = NPCI code, else app code.
// Initiation mode = extended_info initiationMode (00 collect / 04 intent / 13 QR / 11 mandate).
// dim ALL = every attempt (with mode); dim BANK / HANDLE = failures by payer bank / payee handle,
// only for codes with at least MANDATE_SPLIT_MIN failures that day (all payer accounts), top
// MANDATE_SPLIT_TOP keys per day × purpose × stage × code ranked across payer accounts, so a bank
// is kept (or pooled into Other) for every account alike. dim MCC / PAYER_BANK / PAYEE = every attempt by payee MCC / payer bank / payee
// handle (no code, no mode), top MANDATE_SR_TOP keys by attempts per day × purpose × stage. The
// payee leg carries no bank code for mandates, so the payee side is split by handle (acquirer PSP).
const MANDATE_SPLIT_MIN = 50;
const MANDATE_SPLIT_TOP = 10;
const MANDATE_SR_TOP = 30;
// Bank / handle split rows are kept for the newest days only (keeps the cache small).
const MANDATE_SPLIT_DAYS = 14;
// Snapshot partitions read per day: the day itself + this many after it (a txn lives in the
// partition of its last update; mandate txns settle within a day or two). Unbounded, an old
// day would scan every partition up to today.
const MANDATE_LATE_DAYS = 3;
// Days fetched per chunk, newest first; the cache is saved after each chunk so the tab shows
// the newest days within a few minutes while older days fill in behind them.
const MANDATE_CHUNK_DAYS = 3;
const MANDATE_DAY_SQL = `WITH tp AS (
  SELECT txn_id,
         MAX(CASE WHEN participant_type = 'PAYER' THEN CASE WHEN account_type = 'CREDIT' THEN 'CC' WHEN account_type IN ('SAVINGS', 'CURRENT') THEN 'CASA' ELSE 'OTHER' END END) AS acct,
         MAX(CASE WHEN participant_type = 'PAYER' THEN scope_cust_id END)    AS cust,
         MAX(CASE WHEN participant_type = 'PAYER' THEN handle END)           AS payer_handle,
         MAX(CASE WHEN participant_type = 'PAYER' THEN bank_code END)        AS payer_bank,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN lower(handle) END)    AS payee_handle,
         MAX(CASE WHEN participant_type = 'PAYEE' THEN mcc END)              AS mcc
  FROM hive.switch.txn_participants_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND participant_type IN ('PAYER', 'PAYEE')
  GROUP BY txn_id
),
ti AS (
  SELECT txn_id, created_on, CAST(date(created_on) AS varchar) AS ts, status, type, umn,
         COALESCE(NULLIF(trim(json_extract_scalar(extended_info, '$.purpose')), ''), '(none)')     AS purpose,
         COALESCE(NULLIF(trim(json_extract_scalar(extended_info, '$.initiationMode')), ''), 'NA')  AS mode,
         COALESCE(NULLIF(trim(npci_resp_code), ''), NULLIF(trim(app_resp_code), ''), 'UNKNOWN')    AS code,
         TRY_CAST(json_extract_scalar(extended_info, '$.MANDATE_EXECUTION_NUMBER') AS INTEGER)    AS ex
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '{{DAY}}' AND DATE '{{NEXT_DAY}}' + INTERVAL '${MANDATE_LATE_DAYS}' DAY
    AND created_on >= TIMESTAMP '{{DAY}} 00:00:00' AND created_on < TIMESTAMP '{{NEXT_DAY}} 00:00:00'
    AND business_type = 'MANDATE'
    AND type IN ('CREATE', 'COLLECT', 'REVOKE', 'PAUSE', 'UNPAUSE')
),
j AS (
  SELECT ti.*, COALESCE(tp.acct, 'OTHER') AS acct, tp.payer_bank, tp.payee_handle, NULLIF(trim(tp.mcc), '') AS mcc,
         CASE WHEN ti.type = 'CREATE' THEN 'CREATE'
              WHEN ti.type = 'COLLECT' AND ti.ex = 1 THEN 'EXEC1'
              WHEN ti.type = 'COLLECT' AND ti.ex > 1 THEN 'EXECR'
              WHEN ti.type IN ('REVOKE', 'PAUSE', 'UNPAUSE') THEN ti.type END                     AS stage,
         CASE WHEN ti.type = 'COLLECT' AND ti.umn IS NOT NULL AND tp.cust IS NOT NULL AND ti.ex IS NOT NULL
              THEN ti.umn || '|' || CAST(tp.cust AS varchar) || '|' || CAST(ti.ex AS varchar) ELSE ti.txn_id END  AS k
  FROM ti LEFT JOIN tp ON tp.txn_id = ti.txn_id
  WHERE COALESCE(tp.payer_handle, '') <> 'paytm'
),
u AS (   -- one row per attempt, latest status
  SELECT ts, purpose, stage, acct,
         max_by(status, created_on)        AS status,
         max_by(code, created_on)          AS code,
         max_by(payer_bank, created_on)    AS payer_bank,
         max_by(payee_handle, created_on)  AS payee_handle,
         max_by(mcc, created_on)           AS mcc,
         max_by(mode, created_on)          AS mode
  FROM j
  WHERE stage IS NOT NULL
  GROUP BY ts, purpose, stage, acct, k
),
g AS (
  SELECT ts, purpose, stage, acct, CASE WHEN GROUPING(payer_bank, payee_handle) = 3 THEN mode END AS mode, status, code,
         CASE WHEN GROUPING(payer_bank) = 0 THEN 'BANK' WHEN GROUPING(payee_handle) = 0 THEN 'HANDLE' ELSE 'ALL' END  AS dim,
         CASE WHEN GROUPING(payer_bank) = 0 THEN COALESCE(payer_bank, '(unknown)')
              WHEN GROUPING(payee_handle) = 0 THEN COALESCE(payee_handle, '(unknown)') END        AS k,
         count(*)                                                                                  AS c
  FROM (SELECT ts, purpose, stage, acct, mode, status, CASE WHEN status = 'FAILURE' THEN code END AS code, payer_bank, payee_handle FROM u)
  GROUP BY GROUPING SETS ((ts, purpose, stage, acct, mode, status, code),
                          (ts, purpose, stage, acct, status, code, payer_bank),
                          (ts, purpose, stage, acct, status, code, payee_handle))
),
gk AS (
  SELECT *,
         sum(c) OVER (PARTITION BY ts, purpose, stage, code, dim)                                  AS code_c,
         sum(c) OVER (PARTITION BY ts, purpose, stage, code, dim, k)                               AS k_c
  FROM g
),
r AS (
  SELECT *, dense_rank() OVER (PARTITION BY ts, purpose, stage, code, dim ORDER BY k_c DESC, k) AS rn
  FROM gk
),
s AS (   -- every attempt by payee MCC / payer bank / payee handle
  SELECT ts, purpose, stage, acct, status, dim, k, count(*) AS c
  FROM (SELECT ts, purpose, stage, acct, status, 'MCC' AS dim, COALESCE(mcc, '(unknown)') AS k FROM u
        UNION ALL SELECT ts, purpose, stage, acct, status, 'PAYER_BANK', COALESCE(payer_bank, '(unknown)') FROM u
        UNION ALL SELECT ts, purpose, stage, acct, status, 'PAYEE', COALESCE(payee_handle, '(unknown)') FROM u)
  GROUP BY 1, 2, 3, 4, 5, 6, 7
),
sk AS (
  SELECT ts, purpose, stage, dim, k, row_number() OVER (PARTITION BY ts, purpose, stage, dim ORDER BY sum(c) DESC, k) AS rk
  FROM s
  GROUP BY ts, purpose, stage, dim, k
)
SELECT ts, purpose, stage, acct, mode, status, code, dim,
       CASE WHEN dim = 'ALL' OR rn <= ${MANDATE_SPLIT_TOP} THEN k ELSE 'Other' END  AS k,
       sum(c)                                                                      AS c
FROM r
WHERE dim = 'ALL' OR (status = 'FAILURE' AND code_c >= ${MANDATE_SPLIT_MIN})
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
UNION ALL
SELECT s.ts, s.purpose, s.stage, s.acct, NULL, s.status, NULL, s.dim,
       CASE WHEN sk.rk <= ${MANDATE_SR_TOP} THEN s.k ELSE 'Other' END, sum(s.c)
FROM s JOIN sk ON sk.ts = s.ts AND sk.purpose = s.purpose AND sk.stage = s.stage AND sk.dim = s.dim AND sk.k = s.k
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;

const runRefundRedash = (sql, opts) => runRedashWithEnv(REFUND_URL_VAR, REFUND_KEY_VAR, REFUND_DATA_SOURCE_ID, sql, { ...opts, timeoutMs: REFUND_DAY_TIMEOUT_MS });

/**
 * run() for per-day products: one SQL per day of the window (DAY_CONCURRENCY at a time) on the
 * refund Redash, or on Trino when exec = runTrino. Settled days already in the cache are reused
 * instead of queried — only when the cache was built by the same query version (bump `version`
 * when the SQL's columns change).
 * chunkDays: fetch the days in chunks of that many (newest first, all of a chunk at once) and
 * hand what is fetched so far to ctx.savePartial(rows, coverage) after each chunk, so the UI
 * shows the newest days early and a stopped / failed run keeps the days already fetched.
 */
function fetchByDay(daySql, shape, version, { exec = runRefundRedash, chunkDays = 0 } = {}) {
  return async ({ win, cached, signal, onProgress, savePartial }) => {
    const days = [];
    for (let d = win.fromDate; d < win.toDate; d = addDays(d, 1)) days.push(d);
    const settledBefore = addDays(win.toDate, -SETTLE_DAYS);
    const prevRows = cached?.version === version ? cached.rows || [] : [];
    const have = new Set(prevRows.map((r) => r.ts));
    const reuse = (d) => d < settledBefore && have.has(d);
    // Newest first, so the days shown by default land early.
    const todo = days.filter((d) => !reuse(d)).reverse();
    const out = prevRows.filter((r) => r.ts >= win.fromDate && r.ts < win.toDate && reuse(r.ts));
    let done = 0;
    const fetchDay = async (d) => {
      const sql = daySql.replaceAll("{{DAY}}", d).replaceAll("{{NEXT_DAY}}", addDays(d, 1));
      // Retry each day on network blips so one dropped connection doesn't throw away the days already fetched.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const rows = await exec(sql, { signal });
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

/** { npci, bank, type } for a code like UPI-U31-XW / UPI-U16 / INT-2010 (null when unknown). */
function describeCode(code) {
  const doc = codeDoc();
  const parts = String(code || "").replace(/^UPI-/, "").split(/[-|]/);
  const npci = doc[parts[0]];
  const bank = parts.length > 1 ? doc[parts[parts.length - 1]] : null;
  if (!npci && !bank) return null;
  return { npci: npci ? `${parts[0]} ${npci.descr}` : "", bank: bank ? `${parts[parts.length - 1]} ${bank.descr}` : "", type: bank?.type || npci?.type || "" };
}

// ─── Products ────────────────────────────────────────────────────────────────

export const PRODUCTS = {
  international: {
    title: "UPI International",
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
    },
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
    maxDays: WINDOW_DAYS,
    codeInfo: true,
    queries: {
      // Every section slices this: SR by stage × CC / CASA, error codes, bank / handle split.
      daily: {
        title: "Mandate attempts (day × purpose × stage × payer account × mode × status × code; failures by payer bank / payee handle; SR by MCC / payer bank / payee handle)",
        daily: true,
        version: 3,
        sql: MANDATE_DAY_SQL.replaceAll("{{DAY}}", "{{FROM_DATE}}").replaceAll("{{NEXT_DAY}}", "{{TO_DATE}}"),
        run: async (ctx) => {
          const splitFrom = addDays(ctx.win.toDate, -MANDATE_SPLIT_DAYS);
          const trimSplit = (rows) => rows.filter((r) => (r.dim !== "BANK" && r.dim !== "HANDLE") || r.ts >= splitFrom);
          const rows = await fetchByDay(
            MANDATE_DAY_SQL,
            (r) => ({
              ts: String(r.ts).slice(0, 10),
              purpose: r.purpose,
              stage: r.stage,
              acct: r.acct,
              mode: r.mode ?? null,
              status: r.status,
              code: r.code ?? null,
              dim: r.dim,
              k: r.k ?? null,
              c: num(r.c),
            }),
            3,
            { exec: (sql, opts) => runTrino(sql, { ...opts, timeoutMs: TIMEOUT_MS }), chunkDays: MANDATE_CHUNK_DAYS },
          )({ ...ctx, savePartial: (part, cover) => ctx.savePartial(trimSplit(part), cover) });
          return trimSplit(rows);
        },
      },
    },
  },
};

const num = (v) => (v == null ? 0 : Number(v) || 0);

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

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** history: optional store from historyStore.js — every query run is also written there. */
export function registerProductDashboard(app, { dataDir, history = null }) {
  const cacheFile = path.join(dataDir, "product-cache.json");
  // cache: { [product]: { [query]: { rows, window, finishedAt, durationMs } } }
  const cache = readJsonFile(cacheFile, {});
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
      const merged = spec.daily ? mergeDaily(sameVersion(), rows, cover, def.maxDays) : { rows, window: cover };
      cache[product] ||= {};
      cache[product][query] = { ...merged, finishedAt: Date.now(), durationMs: Date.now() - startedAt, partial: true, ...(spec.version ? { version: spec.version } : {}) };
      writeJsonFile(cacheFile, cache);
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
        ({ rows, window: coverage } = mergeDaily(sameVersion(), rows, win, def.maxDays));
      }
      const finishedAt = Date.now();
      cache[product] ||= {};
      cache[product][query] = { rows, window: coverage, finishedAt, durationMs: finishedAt - startedAt, ...(spec.version ? { version: spec.version } : {}) };
      writeJsonFile(cacheFile, cache);
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
    if (!days || !def.queries[query].daily) return productWindow(Date.now(), product);
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
    for (const q of Object.values(pc || {})) for (const r of q.rows || []) if (r.code && !(r.code in out)) out[r.code] = describeCode(r.code);
    return out;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  };

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
        cache: cache[product] || {},
        window: productWindow(Date.now(), product),
        ...(PRODUCTS[product].codeInfo ? { codeInfo: codeInfoOf(cache[product]) } : {}),
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

  // Used by the History tab's Re-run (refreshes every query of the product).
  return {
    rerun(rec = {}) {
      const product = productOf(rec.product);
      if (isRunning(product)) return { started: "Already running — results will update shortly" };
      runProduct(product, "manual");
      return { started: `Product Wise · ${PRODUCTS[product].title} (all sections)` };
    },
  };
}
