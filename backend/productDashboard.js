// Product Wise dashboard — per-product health (UPI International, UPI Plugin and UPI Lite
// today; Mandates to follow). International covers Paytm TPAP handles (ptyes, ptaxis,
// ptsbi, pthdfc); UPI Plugin covers the @yesnext handle (see pluginDashboard.js); UPI Lite
// reads team_product summary tables (no handle split, 120-day window).
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
// A query marked snapshot: true returns a point-in-time count (no day column). Each run's
// rows are stamped asOf = window toDate and appended to the cached ones (same asOf
// replaced), so the UI can show the change between daily snapshots.
//
// Routes (all under /api/product):
//   GET  /state?product=        cached result + job state + schedule
//   POST /run {product}         run all queries of a product now (no-op if already running)
//   GET  /sql?product=&query=   rendered SQL for the current window

import fs from "fs";
import path from "path";
import { runTrino } from "./trinoClient.js";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
// tpap_pms.user_snapshot_v3.psp_id → handle (5 = @paytm, excluded).
const PSP_ID_CASE = `CASE u.psp_id WHEN 6 THEN 'ptyes' WHEN 7 THEN 'ptaxis' WHEN 8 THEN 'pthdfc' WHEN 9 THEN 'ptsbi' END`;

// UPI Lite: trend filter goes up to 120 days; snapshot history kept for the same span.
const LITE_DAYS = 120;
const LITE_SNAPSHOTS_KEPT = 120;
const LITE_SUMMARY_WHERE = `dt >= DATE '{{FROM_DATE}}' AND dt < DATE '{{TO_DATE}}'`;
// Shared by the three autopay counts (active / revoked / revoked and never re-enabled).
const LITE_AUTOPAY_SQL = `SELECT active_lite_autopay, users_who_revoked_lite_autopay, users_who_never_activated_again
FROM (
  SELECT count(DISTINCT umn) AS active_lite_autopay
  FROM hive.switch.standing_instructions_snapshot_v3
  WHERE dl_last_updated IS NOT NULL AND mandate_status = 'ACTIVE' AND lrn IS NOT NULL
) a
LEFT JOIN (
  SELECT count(DISTINCT rev.scope_cust_id) AS users_who_revoked_lite_autopay,
         count(DISTINCT CASE WHEN act.scope_cust_id IS NULL THEN rev.scope_cust_id END) AS users_who_never_activated_again
  FROM (
    SELECT mp.scope_cust_id, min(si.created_on) AS min_revoked
    FROM (
      SELECT created_on, txn_id FROM hive.switch.standing_instructions_snapshot_v3
      WHERE dl_last_updated IS NOT NULL AND lrn IS NOT NULL AND type = 'REVOKE'
    ) si
    LEFT JOIN (
      SELECT scope_cust_id, txn_id FROM hive.switch.standing_instructions_participants_snapshot_v3
      WHERE dl_last_updated >= DATE '2024-10-01'
    ) mp ON si.txn_id = mp.txn_id
    GROUP BY 1
  ) rev
  LEFT JOIN (
    SELECT mp.scope_cust_id, max(si.created_on) AS max_created
    FROM (
      SELECT txn_id, created_on FROM hive.switch.standing_instructions_snapshot_v3
      WHERE dl_last_updated IS NOT NULL AND type = 'CREATE' AND lrn IS NOT NULL
    ) si
    LEFT JOIN (
      SELECT scope_cust_id, txn_id FROM hive.switch.standing_instructions_participants_snapshot_v3
      WHERE dl_last_updated >= DATE '2024-10-01'
    ) mp ON si.txn_id = mp.txn_id
    GROUP BY 1
  ) act ON rev.scope_cust_id = act.scope_cust_id AND max_created > min_revoked
) b ON 1 = 1`;

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
    window: (nowMs) => {
      const today = istToday(nowMs);
      return { fromDate: ymd(new Date(today - LITE_DAYS * 86400000)), toDate: ymd(new Date(today)) };
    },
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
      // Sections 7 and 8. Successful rows count as SUCCESS, as in the reference charts.
      codes: {
        title: "Lite error type & app code (day × Lite payer)",
        sql: `SELECT
  CAST(date(dt) AS varchar)                                   AS ts,
  CASE WHEN payer_instrument = 'UPI_LITE' THEN 1 ELSE 0 END   AS lite,
  CASE WHEN success > 0 THEN 'SUCCESS' ELSE COALESCE(NULLIF(trim(error_type), ''), '(blank)') END     AS error_type,
  CASE WHEN success > 0 THEN 'SUCCESS' ELSE COALESCE(NULLIF(trim(app_resp_code), ''), '(blank)') END  AS code,
  sum(txn_init)                                               AS txn_init
FROM hive.team_product.upi_lite_summary
WHERE ${LITE_SUMMARY_WHERE}
GROUP BY 1, 2, 3, 4`,
        shape: (r) => ({ ts: String(r.ts).slice(0, 10), lite: num(r.lite), error_type: r.error_type, code: r.code, txn_init: num(r.txn_init) }),
      },
      // Section 9.
      autopay: {
        title: "Lite autopay active / revoked (snapshot)",
        snapshot: true,
        sql: LITE_AUTOPAY_SQL,
        shape: (r) => ({ active: num(r.active_lite_autopay), revoked: num(r.users_who_revoked_lite_autopay), never_again: num(r.users_who_never_activated_again) }),
      },
      // Section 10.
      mandate: {
        title: "Lite autopay mandate txns (day × category)",
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
      // Section 11.
      shield: {
        title: "Lite users with Security Shield (snapshot × PSP)",
        snapshot: true,
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
export function productWindow(nowMs = Date.now(), product = null) {
  if (product && PRODUCTS[product]?.window) return PRODUCTS[product].window(nowMs);
  const today = istToday(nowMs);
  return { fromDate: ymd(new Date(today - WINDOW_DAYS * 86400000)), toDate: ymd(new Date(today)) };
}

function renderSql(product, query, win) {
  return PRODUCTS[product].queries[query].sql
    .replaceAll("{{FROM_DATE}}", win.fromDate)
    .replaceAll("{{TO_DATE}}", win.toDate)
    .replaceAll("{{HANDLES}}", HANDLES.map((h) => `'${h}'`).join(", "));
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
  // jobs: { [product]: { [query]: { status: idle|running|done|error, error?, startedAt?, finishedAt? } } }
  const jobs = Object.fromEntries(
    Object.entries(PRODUCTS).map(([p, def]) => [p, Object.fromEntries(Object.keys(def.queries).map((q) => [q, { status: cache[p]?.[q] ? "done" : "idle" }]))]),
  );
  const running = {};
  let lastScheduledSlot = null;

  const productOf = (v) => {
    const p = String(v || "international");
    if (!PRODUCTS[p]) throw new Error(`Unknown product ${p}`);
    return p;
  };

  async function runQuery(product, query, win, trigger = "manual") {
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
    try {
      let raw;
      for (let attempt = 0; ; attempt += 1) {
        try {
          raw = spec.run
            ? await spec.run({ dataDir, onProgress: (note) => (jobs[product][query] = { status: "running", startedAt, note }) })
            : await runTrino(sql, { timeoutMs: TIMEOUT_MS });
          break;
        } catch (err) {
          if (!isTransient(err) || attempt >= RETRY_WAITS_MS.length) throw err;
          console.log(`[product:${product}] ${query} attempt ${attempt + 1} failed (${err.message}) — retrying in ${RETRY_WAITS_MS[attempt] / 1000}s`);
          jobs[product][query] = { status: "running", startedAt, note: `retry ${attempt + 1}` };
          await sleep(RETRY_WAITS_MS[attempt]);
        }
      }
      let rows = raw.map(spec.shape || SHAPE[query] || ((r) => r)).filter((r) => def.allHandles || r.handle);
      if (spec.snapshot) {
        const kept = (cache[product]?.[query]?.rows || []).filter((r) => r.asOf && r.asOf !== win.toDate);
        const dates = [...new Set(kept.map((r) => r.asOf))].sort().slice(-(LITE_SNAPSHOTS_KEPT - 1));
        rows = [...kept.filter((r) => dates.includes(r.asOf)), ...rows.map((r) => ({ ...r, asOf: win.toDate }))];
      }
      const finishedAt = Date.now();
      cache[product] ||= {};
      cache[product][query] = { rows, window: win, finishedAt, durationMs: finishedAt - startedAt };
      writeJsonFile(cacheFile, cache);
      jobs[product][query] = { status: "done", startedAt, finishedAt };
      history?.update(histId, { event: "success", elapsedMs: finishedAt - startedAt, rowCount: rows.length, analysis: analyze("product", `${product}-${query}`, rows) });
    } catch (err) {
      jobs[product][query] = { status: "error", error: err.message, startedAt, finishedAt: Date.now() };
      history?.update(histId, { event: "failed", error: err.message, elapsedMs: Date.now() - startedAt });
    }
  }

  function runProduct(product, trigger = "manual") {
    if (running[product]) return running[product];
    const win = productWindow(Date.now(), product);
    console.log(`[product:${product}] ${trigger} run ${win.fromDate} → ${win.toDate}`);
    running[product] = Promise.all(Object.keys(PRODUCTS[product].queries).map((q) => runQuery(product, q, win, trigger))).finally(() => {
      delete running[product];
    });
    return running[product];
  }

  // Scheduler: products with refreshEveryMin refresh on that interval; the rest fire at
  // each SCHEDULE_AT slot (IST) once per day.
  setInterval(() => {
    for (const [p, def] of Object.entries(PRODUCTS)) {
      if (!def.refreshEveryMin || running[p]) continue;
      const last = Math.min(...Object.keys(def.queries).map((q) => cache[p]?.[q]?.finishedAt || jobs[p][q].finishedAt || 0));
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
      // Skip if everything already ran after this slot (e.g. after a backend restart).
      if (Object.keys(PRODUCTS[p].queries).every((q) => cache[p]?.[q]?.finishedAt >= slotMs)) continue;
      void runProduct(p, "scheduled");
    }
  }, 60000).unref?.();

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
        running: Boolean(running[product]),
        jobs: jobs[product],
        cache: cache[product] || {},
        window: productWindow(Date.now(), product),
      };
    }),
  );

  app.post(
    "/api/product/run",
    handle((req) => {
      const product = productOf(req.body?.product);
      void runProduct(product, "manual");
      return { started: true };
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
      if (running[product]) return { started: "Already running — results will update shortly" };
      void runProduct(product, "manual");
      return { started: `Product Wise · ${PRODUCTS[product].title} (all sections)` };
    },
  };
}
