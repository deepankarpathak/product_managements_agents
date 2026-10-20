// Product Wise dashboard — per-product health (UPI International and UPI Plugin today;
// UPI Lite and Mandates to follow). International covers Paytm TPAP handles (ptyes,
// ptaxis, ptsbi, pthdfc); UPI Plugin covers the @yesnext handle (see pluginDashboard.js).
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
// Routes (all under /api/product):
//   GET  /state?product=        cached result + job state + schedule
//   POST /run {product}         run all queries of a product now (no-op if already running)
//   GET  /sql?product=&query=   rendered SQL for the current window

import fs from "fs";
import path from "path";
import { runTrino } from "./morningDashboard.js";
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
      const rows = raw.map(SHAPE[query] || ((r) => r)).filter((r) => r.handle);
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
