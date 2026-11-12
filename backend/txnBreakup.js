// Transaction breakup — successful Paytm TPAP txns (payer handles ptyes / ptsbi / ptaxis / pthdfc) split into
// P2M / P2P / Lite / Mandate executions / ICCW (cash withdrawal) / International, count + GMV per IST day.
// Shown on Today (#today) via summary(); /api/txnbreakup for the raw days + manual refresh.
//
// One Trino query per day (switch txn_info + txn_participants snapshots, extended_info for purpose /
// initiationMode → runs on TXN_BREAKUP_TRINO_ACCOUNT, default "backup", same reason as Product Wise Mandates).
// Cache: data/txnbreakup/days/YYYY-MM-DD.json — a settled day is never re-queried.
// Schedule: after 09:30 IST each day fetch yesterday + any missing day of the last KEEP_DAYS (one at a time).
import path from "path";
import fs from "fs";
import { runTrino } from "./trinoClient.js";
import { writeJsonAtomic, readJson } from "./dayStore.js";

const TZ_OFFSET_MIN = 330;
const READY_AT = "09:30"; // switch snapshots for yesterday are complete by then
const KEEP_DAYS = 8; // latest day + 7 before it for the comparison
const TIMEOUT_MS = 20 * 60 * 1000;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const ACCOUNT = process.env.TXN_BREAKUP_TRINO_ACCOUNT || "backup";

export const SEGMENTS = ["P2M", "P2P", "Lite", "Mandate executions", "ICCW (cash withdrawal)", "International"];

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const addDays = (day, n) => ymd(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));
const istWall = (ms = Date.now()) => new Date(ms + TZ_OFFSET_MIN * 60000);

export function breakupSql(day) {
  const start = day;
  const end = addDays(day, 1);
  const endAhead = addDays(day, 2);
  return `WITH t AS (   -- Paytm TPAP handles as payer PSP, successful txns in the window
  SELECT txn_id, amount, type, category, txn_mode, business_type,
         json_extract_scalar(extended_info, '$.purpose')        AS purpose,
         json_extract_scalar(extended_info, '$.initiationMode') AS imode
  FROM hive.switch.txn_info_snapshot_v3
  WHERE dl_last_updated BETWEEN DATE '${start}' AND DATE '${endAhead}'
    AND created_on >= TIMESTAMP '${start} 00:00:00' AND created_on < TIMESTAMP '${end} 00:00:00'
    AND lower(psp_handle) IN ('ptyes', 'ptsbi', 'ptaxis', 'pthdfc')
    AND status = 'SUCCESS'
),
iccw AS (     -- payee MCC 6013 (cash withdrawal)
  SELECT DISTINCT txn_id FROM hive.switch.txn_participants_snapshot_v3
  WHERE participant_type = 'PAYEE' AND mcc = '6013'
    AND dl_last_updated BETWEEN DATE '${start}' AND DATE '${endAhead}'
)
SELECT segment, COUNT(*) AS success_count, SUM(amount) AS success_gmv
FROM (
  SELECT t.amount,
    CASE
      WHEN t.txn_mode = 'UPI_GLOBAL' THEN 'International'
      WHEN (t.txn_mode = 'UPI_LITE' AND t.category IN ('VPA2MERCHANT', 'VPA2ACCOUNT', 'VPA2VPA') AND t.type = 'PAY')
        OR t.category IN ('RECHARGE_LITE_TOP_UP', 'INITIAL_LITE_TOP_UP')
        OR (t.category = 'LITE_MANDATE' AND t.type = 'PAY')                    THEN 'Lite'
      WHEN t.business_type = 'MANDATE' AND t.type = 'COLLECT'                 THEN 'Mandate executions'
      WHEN t.txn_mode IS NULL AND t.business_type IS NULL AND t.type = 'PAY'
        AND t.category IN ('VPA2VPA', 'VPA2ACCOUNT')                          THEN 'P2P'
      WHEN t.txn_mode IS NULL AND t.business_type IS NULL AND t.type IN ('PAY', 'COLLECT')
        AND t.category = 'VPA2MERCHANT' THEN
        CASE WHEN t.type = 'PAY' AND i.txn_id IS NOT NULL
               AND ((t.purpose IN ('12', '13') AND t.imode = '18') OR (t.purpose = '00' AND t.imode = '15'))
             THEN 'ICCW (cash withdrawal)' ELSE 'P2M' END
    END AS segment
  FROM t LEFT JOIN iccw i ON i.txn_id = t.txn_id
) x
WHERE segment IS NOT NULL
GROUP BY segment
ORDER BY segment`;
}

export function registerTxnBreakup(app, { dataDir }) {
  const daysDir = path.join(dataDir, "txnbreakup", "days");
  fs.mkdirSync(daysDir, { recursive: true });
  const fileOf = (day) => path.join(daysDir, `${day}.json`);
  const loadDay = (day) => readJson(fileOf(day));

  const state = { running: null, error: null, errorAt: 0, lastFinishedAt: 0 };

  /** Days that should be in the cache now: the last KEEP_DAYS complete days (yesterday only after READY_AT IST). */
  const wantedDays = () => {
    const wall = istWall();
    const today = ymd(wall);
    const hm = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
    const latest = addDays(today, hm >= READY_AT ? -1 : -2);
    return Array.from({ length: KEEP_DAYS }, (_, i) => addDays(latest, -i)); // newest first
  };

  async function fetchDay(day) {
    state.running = day;
    console.log(`[txnbreakup] query ${day} (Trino ${ACCOUNT})`);
    try {
      const rows = (await runTrino(breakupSql(day), { timeoutMs: TIMEOUT_MS, account: ACCOUNT })).map((r) => ({
        segment: r.segment,
        count: Number(r.success_count) || 0,
        gmv: Number(r.success_gmv) || 0,
      }));
      if (!rows.length) throw new Error(`no rows for ${day} (snapshot not landed yet?)`);
      writeJsonAtomic(fileOf(day), { day, ranAt: Date.now(), rows });
      state.error = null;
      state.lastFinishedAt = Date.now();
      return rows;
    } catch (err) {
      state.error = `${day}: ${err.message}`;
      state.errorAt = Date.now();
      console.error(`[txnbreakup] ${day} failed: ${err.message}`);
      throw err;
    } finally {
      state.running = null;
    }
  }

  /** Fetch missing days (newest first), one at a time. force=true re-queries `only` even if cached. */
  let loop = null;
  const fill = ({ force = false, only = null } = {}) => {
    if (loop) return loop;
    loop = (async () => {
      const todo = only ? [only] : wantedDays().filter((d) => !fs.existsSync(fileOf(d)));
      for (const d of todo) {
        if (!force && fs.existsSync(fileOf(d))) continue;
        try {
          await fetchDay(d);
        } catch {
          break; // stop on first failure; retried after RETRY_AFTER_MS
        }
      }
    })().finally(() => {
      loop = null;
    });
    return loop;
  };

  // Scheduler: every minute check for missing days (backs off after a failure).
  const tick = () => {
    if (loop) return;
    if (state.error && Date.now() - state.errorAt < RETRY_AFTER_MS) return;
    if (wantedDays().some((d) => !fs.existsSync(fileOf(d)))) void fill();
  };
  if (String(process.env.TXN_BREAKUP_SCHEDULE || "true").toLowerCase() !== "false") {
    setTimeout(tick, 15000).unref?.();
    setInterval(tick, 60000).unref?.();
  }

  const cachedDays = () =>
    fs
      .readdirSync(daysDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();

  /** Latest cached day per segment: count / GMV, share of total, Δ% vs avg of up to 7 days before. */
  function summary() {
    const days = cachedDays().slice(-KEEP_DAYS);
    const loaded = days.map(loadDay).filter(Boolean);
    const latest = loaded[loaded.length - 1] || null;
    const prev = loaded.slice(0, -1).slice(-7);
    const pct = (v, avg) => (avg ? (100 * (v - avg)) / avg : null);
    const avgOf = (seg, key) => {
      const v = prev.map((d) => d.rows.find((r) => r.segment === seg)?.[key]).filter((x) => x != null);
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
    };
    const rows = latest?.rows || [];
    const totalCount = rows.reduce((a, r) => a + r.count, 0);
    const totalGmv = rows.reduce((a, r) => a + r.gmv, 0);
    const order = (s) => (SEGMENTS.indexOf(s) + 1 || 99);
    const segments = [...rows]
      .sort((a, b) => order(a.segment) - order(b.segment))
      .map((r) => ({
        segment: r.segment,
        count: r.count,
        gmv: r.gmv,
        countShare: totalCount ? (100 * r.count) / totalCount : null,
        gmvShare: totalGmv ? (100 * r.gmv) / totalGmv : null,
        countDelta: pct(r.count, avgOf(r.segment, "count")),
        gmvDelta: pct(r.gmv, avgOf(r.segment, "gmv")),
        series: loaded.map((d) => d.rows.find((x) => x.segment === r.segment)?.count ?? null),
        gmvSeries: loaded.map((d) => d.rows.find((x) => x.segment === r.segment)?.gmv ?? null),
      }));
    const prevTotal = (key) => {
      const v = prev.map((d) => d.rows.reduce((a, r) => a + r[key], 0));
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
    };
    return {
      day: latest?.day || null,
      seriesDays: loaded.map((d) => d.day),
      ranAt: latest?.ranAt || null,
      comparedDays: prev.length,
      total: { count: totalCount, gmv: totalGmv, countDelta: pct(totalCount, prevTotal("count")), gmvDelta: pct(totalGmv, prevTotal("gmv")) },
      segments,
      running: state.running,
      error: state.error,
      missing: wantedDays().filter((d) => !fs.existsSync(fileOf(d))),
    };
  }

  app.get("/api/txnbreakup", (req, res) => {
    res.json({ ...summary(), days: cachedDays().map(loadDay).filter(Boolean) });
  });
  app.get("/api/txnbreakup/sql", (req, res) => {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day)) ? req.query.day : wantedDays()[0];
    res.type("text/plain").send(breakupSql(day));
  });
  // Body { day?: "YYYY-MM-DD" } → re-query that day; no day → fill missing days. Returns at once.
  app.post("/api/txnbreakup/refresh", (req, res) => {
    const day = req.body?.day;
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "day must be YYYY-MM-DD" });
    if (loop) return res.json({ started: false, running: state.running, note: "already running" });
    state.error = null;
    void fill(day ? { force: true, only: day } : {});
    res.json({ started: true });
  });

  return { summary };
}
