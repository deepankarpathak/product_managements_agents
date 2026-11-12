// Acquiring SR (TSP) — backend for the #acqsr page: PTYBL Redash dashboard 95 "[Acquiring] SR
// Monitoring for DR" (PPSL Intent V2 · PPSL DQR · OCL DQR · Collect), dashboards 88 / 91 day views and
// the routing checks of dashboard 69, all fed from the live switch MySQL clusters
// (C2 = 21, C3 = 19, C6 = 14) on the PTYBL Redash (MDASH_REDASH_URL / MDASH_REDASH_API_KEY).
//
// Nothing here queries Redash on a page request. All Redash work is a queue of jobs in acqCollector.js,
// run one at a time (shared gate, retry, breaker): recent:<cluster>, backfill:<cluster>, plus the two
// jobs registered below (routing checks every hour, PMS PPSL merchants once a night). Pages read stored
// results only.
//
//   GET  /api/acq/status                   → job queue + status (Unified SR style), Redash counters
//   GET  /api/acq/recent?hours&bucket&cluster → 4 panel flows in 10/30/60-min buckets + SR-impact incidents
//   GET  /api/acq/history?days&cluster     → per day 10-min impact strips + incidents
//   GET  /api/acq/pattern?days&bucket&cluster → SR by time of day: each day's line, earlier-days band, night dip
//   GET  /api/acq/runs?limit               → job run history (backend/data/acq-runs.jsonl)
//   GET  /api/acq/daily                    → day-level aggregates, routing checks, code descriptions
//   POST /api/acq/jobs/run   {ids?}        → queue jobs now (all when ids empty)
//   POST /api/acq/jobs/stop  {ids?}        → stop queued / running jobs
//   POST /api/acq/jobs/retry {id}          → retry a failed / waiting job now (clears a Redash cool-down)
//   POST /api/acq/night/plan {fillTo, budgetMin, repeat} → what the night job (C2 + C3 + C6 in lockstep) fills
//   POST /api/acq/trickle {fillTo, budgetMin, everyMin} | {off:true} → daytime small-chunk backfill
//   POST /api/acq/collector/pause|resume   → Stop sync / Start sync (persists)

import { describeCode } from "./productDashboard.js";
import { acqRedashStats, CLUSTERS, COLLECTOR_SQL, createAcqCollector, inNight } from "./acqCollector.js";

export const ACQ_CLUSTERS = CLUSTERS;

// Routing hygiene (dashboard 69): PPSL traffic belongs on C2. Each check runs on C3 and C6 and is
// "bad" when its value is above `max`, or ("grow") when it rose since the previous run.
const ROUTING_EVERY_MIN = 60;
const PPSL_EVERY_MIN = 20 * 60;
const istHour = () => new Date(Date.now() + 330 * 60000).getUTCHours();
const PMS_DS_ID = 17;
export const ROUTING_CHECKS = [
  {
    id: "intent_v2",
    label: "UPI_INTENT_V2 txns, last 1h",
    max: 0,
    sql: "SELECT COUNT(*) AS n FROM txn_info WHERE business_type = 'UPI_INTENT_V2' AND updated_on >= NOW() - INTERVAL 1 HOUR",
  },
  // Index on type: zero rows on C3 / C6 is an empty index range.
  { id: "collect", label: "COLLECT txns (all time)", max: 0, sql: "SELECT COUNT(*) AS n FROM txn_info WHERE type = 'COLLECT'" },
  { id: "mf", label: "MF order-detail rows (all time)", grow: true, sql: "SELECT COUNT(*) AS n FROM mutual_funds_details" },
];
const PPSL_MERCHANT_SQL = "SELECT cluster, COUNT(*) AS n FROM merchant_details WHERE entity_name = 'PPSL' GROUP BY cluster";

function addRoutingJobs(collector) {
  const state = { at: null, checks: [], ppsl: null, error: null };
  const due = (everyMin) => (j) => Date.now() - (j.lastRunAt || 0) >= everyMin * 60000;
  const nextAt = (everyMin) => (j) => (j.lastRunAt || Date.now()) + everyMin * 60000;
  collector.addJob({
    id: "routing",
    group: "Checks",
    source: "routing",
    label: "Routing checks · C3 + C6 (dashboard 69)",
    due: due(ROUTING_EVERY_MIN),
    nextAt: nextAt(ROUTING_EVERY_MIN),
    run: async (ctx) => {
      const prev = Object.fromEntries(state.checks.map((c) => [`${c.id}|${c.cluster}`, c.value]));
      const out = [];
      let failed = 0;
      for (const cluster of ["C3", "C6"])
        for (const chk of ROUTING_CHECKS) {
          try {
            const r = await ctx.query("routing", CLUSTERS[cluster], chk.sql);
            const value = Number(r[0]?.n) || 0;
            const before = prev[`${chk.id}|${cluster}`];
            const bad = chk.grow ? before != null && value > before : value > chk.max;
            out.push({ id: chk.id, label: chk.label, cluster, value, prev: before ?? null, bad, rule: chk.grow ? "should not grow" : `should be ≤ ${chk.max}` });
          } catch (err) {
            if (ctx.signal.aborted || err.constructor.name === "HoldError") throw err;
            failed += 1;
            out.push({ id: chk.id, label: chk.label, cluster, error: err.message });
          }
        }
      state.checks = out.sort((a, b) => a.id.localeCompare(b.id) || a.cluster.localeCompare(b.cluster));
      state.at = Date.now();
      if (failed === out.length) throw new Error(out[0]?.error || "all checks failed");
      const bad = out.filter((c) => c.bad).length;
      return { note: `${out.length - failed} checks · ${bad} flagged${failed ? ` · ${failed} failed` : ""}` };
    },
  });
  collector.addJob({
    id: "ppsl",
    group: "Checks",
    source: "routing",
    label: "PPSL merchants per cluster · PMS (full table scan, ~75 s) — once a night",
    night: true,
    // Only 01:00–06:00 IST, even when the night window opens earlier: the PMS full scan is killed at 180s on a busy
    // evening slave and its failure pauses the whole queue.
    due: (j) => inNight() && istHour() >= 1 && istHour() < 6 && due(PPSL_EVERY_MIN)(j),
    run: async (ctx) => {
      const before = state.ppsl?.offC2;
      const rows = await ctx.query("routing", PMS_DS_ID, PPSL_MERCHANT_SQL, { maxSec: 180, slowMs: 180000 });
      const byCluster = Object.fromEntries(rows.map((r) => [String(r.cluster), Number(r.n) || 0]));
      const offC2 = Object.entries(byCluster).reduce((s, [k, n]) => (k.toLowerCase() === "c2" ? s : s + n), 0);
      state.ppsl = { at: Date.now(), byCluster, offC2, prev: before ?? null, bad: before != null && offC2 > before };
      return { note: `${offC2} off C2` };
    },
  });
  return state;
}

const parseClusters = (q) =>
  String(q || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((c) => c in CLUSTERS);

export function registerAcquiringSr(app, { dataDir }) {
  const collector = createAcqCollector({ dataDir });
  const routing = addRoutingJobs(collector);
  collector.start();

  const ids = (req) => (Array.isArray(req.body?.ids) ? req.body.ids.map(String) : []);
  const withCodes = (obj, lists) => {
    const codeInfo = {};
    for (const list of lists) for (const c of list) if (!(c.code in codeInfo)) codeInfo[c.code] = describeCode(c.code);
    return { ...obj, codeInfo };
  };

  app.get("/api/acq/status", (req, res) => {
    res.json({ ...collector.statusSnapshot(), redash: acqRedashStats, routing: { at: routing.at } });
  });

  app.get("/api/acq/recent", (req, res) => {
    const hours = Math.min(24, Math.max(1, Number(req.query.hours) || 3));
    const bucketMin = [10, 30, 60].includes(Number(req.query.bucket)) ? Number(req.query.bucket) : 10;
    // Optional date view: date=YYYY-MM-DD&until=HH:MM (IST, 24:00 = end of day) — the window ends there.
    const dm = String(req.query.date || "").match(/^\d{4}-\d{2}-\d{2}$/);
    const um = String(req.query.until || "24:00").match(/^(\d{1,2}):(\d{2})$/);
    if (req.query.date && (!dm || !um || Number(um[1]) > 24 || Number(um[2]) > 59)) return res.status(400).json({ error: "date=YYYY-MM-DD and until=HH:MM" });
    const until = dm ? Date.parse(`${dm[0]}T00:00:00+05:30`) + (Number(um[1]) * 60 + Number(um[2])) * 60000 : null;
    const r = collector.recent({ hours, bucketMin, clusters: parseClusters(req.query.cluster), until });
    res.json(withCodes(r, [...Object.values(r.codes), ...r.incidents.map((i) => i.codes)]));
  });

  app.get("/api/acq/history", (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
    const h = collector.history({ days, clusters: parseClusters(req.query.cluster) });
    res.json(
      withCodes(
        h,
        h.days.flatMap((d) => d.incidents.map((i) => i.codes)),
      ),
    );
  });

  app.get("/api/acq/pattern", (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
    const bucketMin = [10, 30, 60].includes(Number(req.query.bucket)) ? Number(req.query.bucket) : 30;
    res.json(collector.pattern({ days, bucketMin, clusters: parseClusters(req.query.cluster) }));
  });

  app.get("/api/acq/runs", (req, res) => {
    res.json({ runs: collector.readRuns(Math.min(1000, Number(req.query.limit) || 200)) });
  });

  app.get("/api/acq/daily", (req, res) => {
    const snap = collector.snapshot();
    const out = withCodes(
      snap,
      snap.days.flatMap((d) => Object.values(d.codes)),
    );
    res.json({ ...out, redash: acqRedashStats, routing: { ...routing, sql: { checks: ROUTING_CHECKS, ppsl: PPSL_MERCHANT_SQL, collector: COLLECTOR_SQL } } });
  });

  app.post("/api/acq/jobs/run", (req, res) => {
    const limit = Number(req.body?.limit) || 0;
    const part = ["final", "gap", "tail"].includes(req.body?.part) ? req.body.part : null;
    const parts = [1, 2, 5, 10].includes(Number(req.body?.parts)) ? Number(req.body.parts) : null;
    collector.run(ids(req), "manual", limit || part || parts ? { limit: limit || null, part, parts } : null);
    res.json(collector.statusSnapshot());
  });
  app.post("/api/acq/jobs/stop", (req, res) => {
    collector.stop(ids(req));
    res.json(collector.statusSnapshot());
  });
  app.post("/api/acq/jobs/retry", (req, res) => {
    collector.retryNow(String(req.body?.id || ""));
    res.json(collector.statusSnapshot());
  });
  // Night plan: { fillTo: "YYYY-MM-DD HH:MM", budgetMin, repeat } — or { clear: true }.
  app.post("/api/acq/night/plan", (req, res) => {
    collector.setNightPlan(req.body?.clear ? null : req.body || {});
    res.json(collector.statusSnapshot());
  });
  app.post("/api/acq/trickle", (req, res) => {
    try {
      collector.setTricklePlan(req.body?.off ? null : req.body || {});
      res.json(collector.statusSnapshot());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.post("/api/acq/collector/pause", (req, res) => {
    collector.setPaused(true);
    res.json(collector.statusSnapshot());
  });
  app.post("/api/acq/collector/resume", (req, res) => {
    collector.setPaused(false);
    res.json(collector.statusSnapshot());
  });

  // Today page: headline TSP numbers from the stored aggregates (no query). "Acquiring (P2M)" = the page's
  // default flow set; a day is complete when every cluster has ≥ 95% of its 144 ten-minute slots.
  const HOME_FLOWS = ["ppsl_v2", "ppsl_dqr", "ocl_dqr", "collect", "p2m_other"];
  const SLOTS_PER_DAY = 144;
  function summary() {
    const snap = collector.snapshot();
    const days = snap.days.map((d) => {
      const per = {};
      let t = 0;
      let s = 0;
      for (const [k, v] of Object.entries(d.flows || {})) {
        const flow = k.split("|")[1];
        const o = (per[flow] ||= { t: 0, s: 0 });
        o.t += v.t;
        o.s += v.s;
        if (HOME_FLOWS.includes(flow)) {
          t += v.t;
          s += v.s;
        }
      }
      const slots = Object.values(d.slots || {});
      const complete = slots.length === Object.keys(CLUSTERS).length && slots.every((n) => n >= SLOTS_PER_DAY * 0.95);
      return { day: d.day, complete, t, sr: t ? (100 * s) / t : null, flows: Object.fromEntries(HOME_FLOWS.map((f) => [f, per[f] ? { t: per[f].t, sr: per[f].t ? (100 * per[f].s) / per[f].t : null } : null])) };
    });
    const full = days.filter((d) => d.complete);
    const latest = full[0] || null;
    const prev = full.slice(1, 8).filter((d) => d.sr != null);
    const prevAvg = prev.length ? prev.reduce((a, d) => a + d.sr, 0) / prev.length : null;
    const today = days.find((d) => !d.complete && (!latest || d.day > latest.day)) || null;
    let incidents = [];
    try {
      incidents = collector.recent({ hours: 3 }).incidents.map((i) => ({ flow: i.flow, from: i.from, to: i.to, sev: i.sev, sr: i.sr, base: i.base, dropPp: i.dropPp, txns: i.txns, codes: (i.codes || []).slice(0, 2).map((c) => c.code) }));
    } catch {
      /* no recent data */
    }
    return {
      at: snap.at,
      latest,
      delta: latest?.sr != null && prevAvg != null ? latest.sr - prevAvg : null,
      prevAvg,
      today,
      series: full.slice(0, 14).reverse().map((d) => d.sr),
      incidents,
      paused: !!snap.collector?.paused,
    };
  }
  return { summary };
}
