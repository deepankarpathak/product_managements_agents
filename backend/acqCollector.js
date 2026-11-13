// Acquiring SR (TSP) — queued, incremental collector for the #acqsr page.
//
// Every number on the page comes from one query shape: txn_info read in 10-minute created_on slots
// through a primary-key id range (~700k rows, 1–5 s per slot per cluster), the way Unified SR's Redash
// path reads the live switch DB. One slot query returns every flow (PPSL Intent V2, PPSL DQR, OCL DQR,
// Collect, …) with status and decline code, so the four Redash dashboard 95 panels cost one query per
// cluster per 10 minutes instead of seven queries per page refresh.
//
// Work is a queue of jobs (GET /api/acq/status → jobs), run one at a time:
//   recent:<cluster>    newest slots (LAG_MIN after the slot ends), then a settle re-read once a slot is
//                       SETTLE_MIN old — the settle read is final (PENDING / DEEMED left = still open after 20 min)
//   backfill:<cluster>  night only, under a DB-time budget: fills gaps (slots missed in the day); optional
//                       12h final re-read / BACKFILL_DAYS backfill when enabled
//   routing / ppsl      registered by acquiringSr.js (dashboard 69 routing checks, PMS merchants)
// A failed job waits RETRY_MIN[attempt] and retries (MAX_ATTEMPTS), like Unified SR's job runner.
// Slot boundaries for a whole run come from one batched id-lookup query.
//
// Stored under backend/data/acq/: one file per IST day in days/YYYY-MM-DD.json (per day flow totals, hourly
// totals, decline codes, stuck PENDING / DEEMED, and per 10-minute slot per cluster per flow [t, s, f, u09, p, d] —
// the slot series feeds the Recent view and the SR-impact history) and state.json (cluster heads, gaps, plans and
// the last ACQ_PROVISIONAL_HOURS of raw slot rows). Days older than ACQ_HOT_DAYS (30) are gzipped to archive/
// (ACQ_ARCHIVE_DIR to put them elsewhere) and read back on demand; archived days older than ACQ_RETENTION_DAYS (60)
// are removed (0 = keep forever). Only changed day files are rewritten. Every job run is logged to
// backend/data/acq-runs.jsonl (run history).
//
// Flows: ppsl_v2 UPI_INTENT_V2 · ppsl_dqr online/offline intent PPSL · ocl_dqr online/offline intent other PA
//   collect type COLLECT · p2m_other other VPA2MERCHANT · p2p VPA2VPA / VPA2ACCOUNT · lite *LITE* / LiteSync
//   other (mandate, refund, payout … — on C1, rarely here)
// U09 = FAILURE rows whose app_resp_code starts with U09 (dashboard 91 counts VPA2MERCHANT + mid).

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { runRedashWithEnv } from "./trinoClient.js";

const URL_VAR = "MDASH_REDASH_URL";
const KEY_VAR = "MDASH_REDASH_API_KEY";
export const CLUSTERS = { C2: 21, C3: 19, C6: 14 };
const SLOT_MIN = 10;
// A slot is first read this long after it ends, re-read at SETTLE_MIN and again at FINAL_LAG_MIN.
const LAG_MIN = Number(process.env.ACQ_LAG_MIN) || 5;
// Slave-friendly reading: during the day only "hot" slots (still in the DB buffer pool) are read — new slots
// LAG_MIN after they end and one settle re-read at SETTLE_MIN. A slot older than HOT_MAX_MIN that was not read
// becomes a gap. Cold reads (the 12h final re-read, gaps, the 7-day backfill, PMS merchants) run only in the
// NIGHT window (ACQ_NIGHT_WINDOW, IST, default 01:00-06:00; "off" = never automatically).
const SETTLE_MIN = 20;
const HOT_MAX_MIN = 45;
// Parsed again in createAcqCollector: ESM imports run before server.js loads .env, so a value set only in .env
// would be missed at import time.
const parseNight = () => {
  const v = String(process.env.ACQ_NIGHT_WINDOW || "01:00-06:00").trim();
  const m = v.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  return m ? { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]), text: v } : null;
};
let NIGHT = parseNight();
// Every query carries a MySQL MAX_EXECUTION_TIME hint: the DB itself kills it past this, so one slow scan can
// never pile up on the slave. Cold (night) reads get a longer limit.
const DB_MAX_SEC = Number(process.env.ACQ_DB_MAX_SEC) || 20;
const DB_MAX_NIGHT_SEC = Number(process.env.ACQ_DB_MAX_NIGHT_SEC) || 60;
// Pacing: after each query, rest at least as long as it ran (≤ 50% duty on the slave), never under QUERY_GAP_MS.
const DUTY_REST = process.env.ACQ_DUTY_REST != null ? Number(process.env.ACQ_DUTY_REST) : 1;
const FINAL_LAG_MIN = 12 * 60;
// Reach back this far for the first id of a slot: ids are not strictly ordered by created_on.
const ID_MARGIN_SEC = Number(process.env.ACQ_ID_MARGIN_SEC) || 30;
// Night (cold) reads split each 10-min slot into this many sub-window queries, so each query stays short.
const NIGHT_PARTS = Number(process.env.ACQ_NIGHT_PARTS) || 5;
// Night rest after each query, as a share of its run time, per host (0.5 → each slave busy at most ~2/3 of the time).
// Daytime trickle (opt-in via POST /api/acq/trickle): old slots read in small chunks — one 10-min slot on one
// cluster per chunk, in 1-min pieces, each piece capped at TRICKLE_MAX_SEC by the DB, resting TRICKLE_REST× its run
// time after it. A slow or stopped piece pauses only the trickle (TRICKLE_HOLD_MIN), never the live jobs.
const TRICKLE_PARTS = Number(process.env.ACQ_TRICKLE_PARTS) || 10;
const TRICKLE_MAX_SEC = Number(process.env.ACQ_TRICKLE_MAX_SEC) || 15;
const TRICKLE_SLOW_MS = (Number(process.env.ACQ_TRICKLE_SLOW_SEC) || 8) * 1000;
const TRICKLE_REST = process.env.ACQ_TRICKLE_REST != null ? Number(process.env.ACQ_TRICKLE_REST) : 3;
const TRICKLE_HOLD_MIN = Number(process.env.ACQ_TRICKLE_HOLD_MIN) || 30;
const NIGHT_DUTY_REST = process.env.ACQ_NIGHT_DUTY_REST != null ? Number(process.env.ACQ_NIGHT_DUTY_REST) : 0.5;
// Cold reads cost ~80 s of DB time per 10-min slot (C3, measured 9 Nov) whatever the split, so night work is
// capped at this much DB time per cluster per night (final re-reads, then gaps newest first, then backfill).
const NIGHT_BUDGET_MIN = process.env.ACQ_NIGHT_BUDGET_MIN != null ? Number(process.env.ACQ_NIGHT_BUDGET_MIN) : 200;
// Standing nightly rule: every night fills every missing slot of the last ACQ_NIGHT_DAYS days — the day that just
// ended, the day before it, and today so far — newest first. Older gaps only with a night plan (fillTo) or the trickle.
const NIGHT_DAYS = Number(process.env.ACQ_NIGHT_DAYS) || 2;
// Rolling history backfill: each night also reads the ACQ_DEEP_DAYS days before the oldest complete day (all
// clusters, all 144 slots) — e.g. oldest complete 6 Nov → that night fills 5 and 4 Nov. Fixed when the night starts;
// what is left carries over. Never older than the retention window. 0 = off.
const DEEP_DAYS = process.env.ACQ_DEEP_DAYS != null ? Number(process.env.ACQ_DEEP_DAYS) : 2;
// Slave-safe default (agreed 9 Nov 2026): no deep backfill and no 12h final re-read — an old slot costs ~80 s of
// slave DB time. History builds forward from the first run; the settle read is final. Re-enable with
// ACQ_BACKFILL_DAYS=<n> / ACQ_FINAL_REREAD=true (both run in the night window under the night budget).
const BACKFILL_DAYS = process.env.ACQ_BACKFILL_DAYS != null ? Number(process.env.ACQ_BACKFILL_DAYS) : 0;
const FINAL_REREAD = process.env.ACQ_FINAL_REREAD === "true";
const RETENTION_DAYS = process.env.ACQ_RETENTION_DAYS != null ? Number(process.env.ACQ_RETENTION_DAYS) : 60;
// Days newer than this stay as plain JSON in memory; older ones are gzipped to the archive and loaded on demand.
const HOT_DAYS = Number(process.env.ACQ_HOT_DAYS) || 30;
// Raw rows of each slot are kept this long (re-reads subtract them; the Recent view's decline codes per slot).
const PROVISIONAL_MIN = (Number(process.env.ACQ_PROVISIONAL_HOURS) || 24) * 60;
// Archived days parsed and kept in memory at most (least recently used dropped).
const ARCH_CACHE = Number(process.env.ACQ_ARCH_CACHE) || 64;
// First start: the head begins this far back (Recent view first); backfill covers the rest.
const START_BACK_MIN = 20;
// Per run caps keep each job short so other jobs get a turn.
const RECENT_PER_RUN = 18;
const BACKFILL_PER_RUN = Number(process.env.ACQ_BACKFILL_PER_RUN) || 12;
const BACKFILL_EVERY_MIN = Number(process.env.ACQ_BACKFILL_EVERY_MIN) || 3;
const QUERY_GAP_MS = (process.env.ACQ_QUERY_GAP_SEC != null ? Number(process.env.ACQ_QUERY_GAP_SEC) : 2) * 1000;
const TIMEOUT_MS = 5 * 60000;
const TZ_OFFSET_MIN = 330;
// A slot normally reads in 1–5 s; above SLOW_MS Redash is busy and the queue rests BACKOFF_MIN.
const SLOW_MS = Number(process.env.ACQ_SLOW_SEC || 12) * 1000;
const BACKOFF_MIN = 10;
const RETRY_MIN = [2, 5, 10];
const MAX_ATTEMPTS = 3;
const FAIL_REST_MIN = 10;
const SCHEDULER_MS = 30000;
const RUNS_MAX_BYTES = 2 * 1024 * 1024;

class HoldError extends Error {}

export const ACQ_FLOWS = ["ppsl_v2", "ppsl_dqr", "ocl_dqr", "collect", "p2m_other", "p2p", "lite", "other"];
// Slot series layout.
const T = 0;
const S = 1;
const F = 2;
const U09 = 3;
const P = 4;
const D = 5;

export const COLLECTOR_SQL = {
  // One row per boundary timestamp: first id at or after it (created_on index), plus MAX(id).
  boundsRow: "SELECT {{K}} AS k, (SELECT id FROM txn_info WHERE created_on >= '{{TS}}' ORDER BY created_on LIMIT 1) AS id",
  boundsMax: "SELECT -1 AS k, (SELECT MAX(id) FROM txn_info) AS id",
  slot: `SELECT
  CASE WHEN type = 'COLLECT' THEN 'collect'
       WHEN business_type = 'UPI_INTENT_V2' THEN 'ppsl_v2'
       WHEN business_type IN ('ONLINE_INTENT', 'OFFLINE_INTENT') AND payment_aggregator = 'PPSL' THEN 'ppsl_dqr'
       WHEN business_type IN ('ONLINE_INTENT', 'OFFLINE_INTENT') THEN 'ocl_dqr'
       WHEN category = 'VPA2MERCHANT' THEN 'p2m_other'
       WHEN category IN ('VPA2VPA', 'VPA2ACCOUNT') THEN 'p2p'
       WHEN category LIKE '%LITE%' OR type = 'LiteSync' THEN 'lite'
       ELSE 'other' END AS flow,
  status,
  IF(status = 'FAILURE', app_resp_code, NULL) AS code,
  IF(status IN ('PENDING', 'DEEMED'), type, NULL) AS t,
  IF(status = 'DEEMED', settlement_type, NULL) AS st,
  COUNT(*) AS cnt
FROM txn_info
WHERE id >= {{ID_FROM}} AND id < {{ID_TO}}
  AND created_on >= '{{FROM}}' AND created_on < '{{TO}}'
GROUP BY 1, 2, 3, 4, 5`,
};

const pad2 = (n) => String(n).padStart(2, "0");
/** IST wall-clock "YYYY-MM-DD HH:MM:SS" for an epoch ms. */
const istStamp = (ms) => {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};
const stampMs = (s) => Date.parse(`${s.replace(" ", "T")}Z`) - TZ_OFFSET_MIN * 60000;
const SLOT_MS = SLOT_MIN * 60000;
const floorSlot = (ms) => Math.floor((ms + TZ_OFFSET_MIN * 60000) / SLOT_MS) * SLOT_MS - TZ_OFFSET_MIN * 60000;
const todayStartMs = () => stampMs(`${istStamp(Date.now()).slice(0, 10)} 00:00:00`);

// Every TSP Redash call made by the #acqsr page's backend (collector, live view, routing checks) goes
// through countedRedash, so the page can show how many queries ran, how long they took and when.
// In memory: counts restart with the backend.
//
// Redash load guard, shared by all three sources:
//   • one gate — at most ACQ_REDASH_INFLIGHT (default 1) queries in flight; waiting calls are served
//     live view first, then collector, then routing checks, so a page refresh never waits behind a
//     backlog of backfill slots
//   • retry — a connection-level failure ("fetch failed", reset, connect timeout) is retried once after
//     a short pause; Redash HTTP errors and SQL errors are not
//   • breaker — ACQ_BREAKER_FAILS failures in a row (connection errors, HTTP 5xx, timeouts) stop every
//     non-forced call for a cool-down that doubles each time (10 → 20 → 40 → 60 min); one success resets
const istDay = () => istStamp(Date.now()).slice(0, 10);
export const acqRedashStats = { since: Date.now(), total: 0, errors: 0, ms: 0, day: istDay(), today: 0, lastAt: null, bySource: {}, recent: [] };

// C2, C3 and C6 are separate MySQL hosts (pawslmbc{2,3,6}switchdrdbp20): at most one query per data source
// (= per host) at a time, and at most INFLIGHT across all of them. Daytime jobs run one at a time anyway; only
// the night fill reads the three clusters side by side.
const INFLIGHT = Math.max(1, Number(process.env.ACQ_REDASH_INFLIGHT) || 3);
const BREAKER_FAILS = Math.max(1, Number(process.env.ACQ_BREAKER_FAILS) || 2);
const COOL_MIN = [10, 20, 40, 60];
const PRIORITY = { live: 0, collector: 1, routing: 2 };
const RETRY_MS = 8000;

export const acqGate = { inflight: 0, queue: [], fails: 0, trips: 0, coolUntil: 0, lastFailure: null };
export const redashCooling = () => Date.now() < acqGate.coolUntil;

export class RedashCoolingError extends Error {
  constructor() {
    super(`Redash cooling down after ${acqGate.fails} failed queries — resumes ${istStamp(acqGate.coolUntil).slice(11, 16)} IST`);
  }
}

const busyDs = new Set();
let gateSeq = 0;
const canRun = (ds) => acqGate.inflight < INFLIGHT && !busyDs.has(ds);
function take(ds) {
  acqGate.inflight += 1;
  busyDs.add(ds);
}
function acquire(source, ds) {
  if (canRun(ds)) {
    take(ds);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    acqGate.queue.push({ p: PRIORITY[source] ?? 3, seq: (gateSeq += 1), ds, resolve });
    acqGate.queue.sort((a, b) => a.p - b.p || a.seq - b.seq);
  });
}
function release(ds) {
  acqGate.inflight -= 1;
  busyDs.delete(ds);
  for (let i = 0; i < acqGate.queue.length;) {
    const w = acqGate.queue[i];
    if (!canRun(w.ds)) {
      i += 1;
      continue;
    }
    acqGate.queue.splice(i, 1);
    take(w.ds);
    w.resolve();
  }
}

/** Network-level failure: the request never got a proper answer from Redash. */
const isConnError = (err) => /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|UND_ERR/i.test(`${err.message} ${err.cause?.code || ""} ${err.cause?.message || ""}`);
/** Counts toward the breaker: Redash itself is unwell (not a bad SQL). */
const isRedashDown = (err) => isConnError(err) || /HTTP 5\d\d|timeout|timed out|exceeded/i.test(err.message);
const errText = (err) => {
  const why = err.cause?.code || err.cause?.message;
  return why && !err.message.includes(why) ? `${err.message} (${why})` : err.message;
};

export async function countedRedash(source, dataSourceId, sql, opts = {}) {
  const { force, ...runOpts } = opts;
  if (!force && redashCooling()) throw new RedashCoolingError();
  await acquire(source, dataSourceId);
  const t = Date.now();
  let ok = true;
  let error = null;
  let retried = false;
  // Redash job status 1 = waiting for a Redash worker, 2 = running on the DB.
  let startedAt = null;
  let sawPending = false;
  runOpts.onJobStatus = (st) => {
    if (st === 1) sawPending = true;
    if (st >= 2 && startedAt == null) startedAt = Date.now();
  };
  try {
    if (!force && redashCooling()) throw new RedashCoolingError();
    try {
      return await runRedashWithEnv(URL_VAR, KEY_VAR, dataSourceId, sql, runOpts);
    } catch (err) {
      if (!isConnError(err)) throw err;
      retried = true;
      await new Promise((r) => setTimeout(r, RETRY_MS));
      return await runRedashWithEnv(URL_VAR, KEY_VAR, dataSourceId, sql, runOpts);
    }
  } catch (err) {
    ok = false;
    error = errText(err);
    if (err instanceof RedashCoolingError) throw err;
    if (isRedashDown(err)) {
      acqGate.fails += 1;
      acqGate.lastFailure = { at: Date.now(), source, ds: dataSourceId, error };
      if (acqGate.fails >= BREAKER_FAILS && !redashCooling()) {
        acqGate.coolUntil = Date.now() + COOL_MIN[Math.min(acqGate.trips, COOL_MIN.length - 1)] * 60000;
        acqGate.trips += 1;
      }
    }
    err.message = error;
    throw err;
  } finally {
    release(dataSourceId);
    if (ok) {
      acqGate.fails = 0;
      acqGate.trips = 0;
    }
    const cooled = !ok && /cooling down/.test(error || "");
    if (!cooled) {
      const s = acqRedashStats;
      const ms = Date.now() - t;
      if (s.day !== istDay()) Object.assign(s, { day: istDay(), today: 0 });
      s.total += 1;
      s.today += 1;
      s.ms += ms;
      s.lastAt = Date.now();
      if (!ok) s.errors += 1;
      const b = (s.bySource[source] ||= { count: 0, errors: 0, ms: 0, lastAt: null });
      b.count += 1;
      b.ms += ms;
      b.lastAt = Date.now();
      if (!ok) b.errors += 1;
      s.recent.unshift({ at: Date.now(), source, ds: dataSourceId, ms, waitMs: sawPending && startedAt ? startedAt - t : null, ok, retried, error });
      s.recent.length = Math.min(s.recent.length, 30);
    }
  }
}

/** Gate + breaker state for the page. */
export function acqGateStatus() {
  return {
    inflight: acqGate.inflight,
    queued: acqGate.queue.length,
    maxInflight: INFLIGHT,
    fails: acqGate.fails,
    breakerFails: BREAKER_FAILS,
    coolUntil: redashCooling() ? acqGate.coolUntil : 0,
    lastFailure: acqGate.lastFailure,
  };
}

/** Manual "Retry now" clears the cool-down. */
export function resetRedashBreaker() {
  acqGate.coolUntil = 0;
  acqGate.fails = 0;
}

// ─── stored aggregates ───────────────────────────────────────────────────────

// The four Redash dashboard 95 panels; "acq4" = the four together.
export const RECENT_FLOWS = ["ppsl_v2", "ppsl_dqr", "ocl_dqr", "collect"];
const ACQ4 = "acq4";

function emptyState() {
  return { v: 2, clusters: {}, days: {}, provisional: {} };
}

/** Add (sign 1) or remove (sign −1) one slot's rows from the stored aggregates. */
function apply(state, cluster, slotStart, rows, sign) {
  const stamp = istStamp(slotStart);
  const dayKey = stamp.slice(0, 10);
  const hour = stamp.slice(11, 13);
  const hm = stamp.slice(11, 16);
  const day = (state.days[dayKey] ||= { slots: {}, flows: {}, hours: {}, codes: {}, stuck: {}, ts: {}, hcodes: {} });
  day.ts ||= {};
  day.hcodes ||= {};
  day.slots[cluster] = (day.slots[cluster] || 0) + sign;
  const slot = (day.ts[hm] ||= { c: {} });
  slot.c[cluster] = (slot.c[cluster] || 0) + sign;
  if (slot.c[cluster] <= 0) delete slot.c[cluster];
  for (const r of rows) {
    const n = sign * r.cnt;
    const f = (day.flows[`${cluster}|${r.flow}`] ||= { t: 0, s: 0, f: 0, p: 0, d: 0, u09: 0 });
    const a = (slot[`${cluster}|${r.flow}`] ||= [0, 0, 0, 0, 0, 0]);
    f.t += n;
    a[T] += n;
    const h = ((day.hours[hour] ||= {})[r.flow] ||= { t: 0, s: 0 });
    h.t += n;
    if (r.status === "SUCCESS") {
      f.s += n;
      h.s += n;
      a[S] += n;
    } else if (r.status === "FAILURE") {
      f.f += n;
      a[F] += n;
      if (r.code && r.code.startsWith("U09")) {
        f.u09 += n;
        a[U09] += n;
      }
      if (r.code) {
        day.codes[`${r.flow}|${r.code}`] = (day.codes[`${r.flow}|${r.code}`] || 0) + n;
        if (RECENT_FLOWS.includes(r.flow)) {
          const hc = (day.hcodes[hour] ||= {});
          hc[`${r.flow}|${r.code}`] = (hc[`${r.flow}|${r.code}`] || 0) + n;
        }
      }
    } else if (r.status === "PENDING" || r.status === "DEEMED") {
      if (r.status === "PENDING") {
        f.p += n;
        a[P] += n;
      } else {
        f.d += n;
        a[D] += n;
      }
      const k = `${r.status}|${r.t || "-"}|${r.st || "-"}`;
      day.stuck[k] = (day.stuck[k] || 0) + n;
    }
  }
}

function normalise(raw) {
  return raw.map((x) => ({
    flow: String(x.flow),
    status: String(x.status || "").toUpperCase(),
    code: x.code == null ? null : String(x.code),
    t: x.t == null ? null : String(x.t),
    st: x.st == null ? null : String(x.st),
    cnt: Number(x.cnt) || 0,
  }));
}

// ─── SR impact ───────────────────────────────────────────────────────────────
// A 10-min slot is "impacted" when its SR (success / all txns) is IMPACT.warnPp (warning) or
// IMPACT.critPp (critical) points below its baseline and it has at least IMPACT.minTxns txns.
// Baseline = median SR of the same flow at the same time of day (±30 min) over the previous 7 days;
// until 7 days are collected, the median of the previous 2 hours.
export const IMPACT = {
  minTxns: Number(process.env.ACQ_IMPACT_MIN_TXNS) || 100,
  warnPp: Number(process.env.ACQ_IMPACT_WARN_PP) || 2,
  critPp: Number(process.env.ACQ_IMPACT_CRIT_PP) || 5,
};
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

/** Sum of one slot over clusters (null when no selected cluster has read it). */
function slotAgg(state, ms, clusters, flow) {
  const st = istStamp(ms);
  const e = state.days[st.slice(0, 10)]?.ts?.[st.slice(11, 16)];
  if (!e) return null;
  const out = [0, 0, 0, 0, 0, 0];
  let read = 0;
  const flows = flow === ACQ4 ? RECENT_FLOWS : [flow];
  for (const c of clusters) {
    if (!e.c?.[c]) continue;
    read += 1;
    for (const f of flows) {
      const a = e[`${c}|${f}`];
      if (a) for (let i = 0; i < 6; i++) out[i] += a[i];
    }
  }
  if (!read) return null;
  out.read = read;
  return out;
}

function makeImpact(state, clusters) {
  const memo = new Map();
  const baseline = (ms, flow) => {
    const key = `${ms}|${flow}`;
    if (memo.has(key)) return memo.get(key);
    let srs = [];
    for (let d = 1; d <= 7; d++)
      for (let k = -3; k <= 3; k++) {
        const a = slotAgg(state, ms - d * 86400000 + k * SLOT_MS, clusters, flow);
        if (a && a.read === clusters.length && a[T] >= IMPACT.minTxns) srs.push(a[S] / a[T]);
      }
    let out = null;
    if (srs.length >= 5) out = { sr: median(srs), kind: "7d" };
    else {
      srs = [];
      for (let k = 1; k <= 12; k++) {
        const a = slotAgg(state, ms - k * SLOT_MS, clusters, flow);
        if (a && a.read === clusters.length && a[T] >= IMPACT.minTxns) srs.push(a[S] / a[T]);
      }
      if (srs.length >= 4) out = { sr: median(srs), kind: "2h" };
    }
    memo.set(key, out);
    return out;
  };
  /** One slot: totals + SR + baseline + severity (null = not read, -1 = too few txns). */
  const slot = (ms, flow) => {
    const a = slotAgg(state, ms, clusters, flow);
    if (!a) return null;
    const sr = a[T] ? a[S] / a[T] : null;
    // Not every selected cluster has read this slot yet: show, don't judge.
    if (a.read < clusters.length) return { a, sr, base: null, sev: -1, partial: true };
    if (a[T] < IMPACT.minTxns) return { a, sr, base: null, sev: -1 };
    const b = baseline(ms, flow);
    const drop = b ? (b.sr - sr) * 100 : null;
    const sev = drop == null ? 0 : drop >= IMPACT.critPp ? 2 : drop >= IMPACT.warnPp ? 1 : 0;
    return { a, sr, base: b?.sr ?? null, baseKind: b?.kind || null, drop, sev };
  };
  return { slot, baseline };
}

const fmtFlowRow = (a, base, extra = {}) => ({
  t: a[T],
  s: a[S],
  f: a[F],
  u09: a[U09],
  p: a[P],
  d: a[D],
  sr: a[T] ? (a[S] / a[T]) * 100 : null,
  base: base == null ? null : base * 100,
  ...extra,
});

/** Merge consecutive impacted slots (per flow) into incidents. */
function incidentsOf(impact, flows, fromMs, toMs, state) {
  const out = [];
  for (const flow of flows) {
    let cur = null;
    const close = () => {
      if (!cur) return;
      const sr = cur.t ? (cur.s / cur.t) * 100 : null;
      const base = cur.tb ? (cur.exp / cur.tb) * 100 : null;
      out.push({
        flow,
        from: cur.from,
        to: cur.to,
        minutes: (cur.to - cur.from) / 60000,
        sev: cur.sev,
        sr,
        base,
        dropPp: base != null && sr != null ? base - sr : null,
        worstSr: cur.worst * 100,
        txns: cur.t,
        failed: cur.f,
        u09: cur.u09,
        lostSuccess: Math.max(0, Math.round(cur.exp - cur.sb)),
        codes: topCodes(state, flow, cur.from, cur.to),
      });
      cur = null;
    };
    for (let ms = fromMs; ms < toMs; ms += SLOT_MS) {
      const x = impact.slot(ms, flow);
      if (x && x.sev >= 1) {
        cur ||= { from: ms, t: 0, s: 0, f: 0, u09: 0, exp: 0, tb: 0, sb: 0, sev: 0, worst: 1 };
        cur.to = ms + SLOT_MS;
        cur.t += x.a[T];
        cur.s += x.a[S];
        cur.f += x.a[F];
        cur.u09 += x.a[U09];
        cur.exp += x.base * x.a[T];
        cur.tb += x.a[T];
        cur.sb += x.a[S];
        cur.sev = Math.max(cur.sev, x.sev);
        cur.worst = Math.min(cur.worst, x.sr);
      } else close();
    }
    close();
  }
  return out.sort((a, b) => b.from - a.from);
}

/** Top decline codes in the hours an incident touches (codes are kept per hour). */
function topCodes(state, flow, fromMs, toMs) {
  const sum = {};
  const flows = flow === ACQ4 ? RECENT_FLOWS : [flow];
  for (let ms = Math.floor(fromMs / 3600000) * 3600000; ms < toMs; ms += 3600000) {
    const st = istStamp(ms);
    const hc = state.days[st.slice(0, 10)]?.hcodes?.[st.slice(11, 13)];
    if (!hc) continue;
    for (const [k, n] of Object.entries(hc)) {
      const [f, code] = k.split("|");
      if (flows.includes(f) && n > 0) sum[code] = (sum[code] || 0) + n;
    }
  }
  return Object.entries(sum)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, cnt]) => ({ code, cnt }));
}

// ─── slave protection helpers ────────────────────────────────────────────────

/** Add the MySQL 8 per-statement time limit right after the first SELECT (applies to the whole statement). */
export const withMaxTime = (sql, sec) => sql.replace(/^\s*SELECT\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${Math.round(sec * 1000)}) */`);
const isDbKill = (err) => /maximum statement execution time exceeded|execution was interrupted|3024/i.test(err.message || "");
const istMinuteOfDay = (ms) => {
  const st = istStamp(ms);
  return Number(st.slice(11, 13)) * 60 + Number(st.slice(14, 16));
};
export function inNight(ms = Date.now()) {
  if (!NIGHT) return false;
  const m = istMinuteOfDay(ms);
  return NIGHT.from <= NIGHT.to ? m >= NIGHT.from && m < NIGHT.to : m >= NIGHT.from || m < NIGHT.to;
}
function nextNightAt(ms = Date.now()) {
  if (!NIGHT) return null;
  const startToday = stampMs(`${istStamp(ms).slice(0, 10)} 00:00:00`) + NIGHT.from * 60000;
  return startToday > ms ? startToday : startToday + 86400000;
}

// ─── collector + job queue ───────────────────────────────────────────────────

const ACTIVE = new Set(["queued", "running"]);

export function createAcqCollector({ dataDir }) {
  NIGHT = parseNight();
  const DIR = path.join(dataDir, "acq");
  const DAYS_DIR = path.join(DIR, "days");
  const ARCH_DIR = process.env.ACQ_ARCHIVE_DIR ? path.resolve(process.env.ACQ_ARCHIVE_DIR) : path.join(DIR, "archive");
  const STATE_FILE = path.join(DIR, "state.json");
  const LEGACY_FILE = path.join(dataDir, "acq-daily.json");
  const RUNS_FILE = path.join(dataDir, "acq-runs.jsonl");
  const dayFile = (d) => path.join(DAYS_DIR, `${d}.json`);
  const archFile = (d) => path.join(ARCH_DIR, `${d}.json.gz`);
  const listDays = (dir, ext) => {
    try {
      return fs
        .readdirSync(dir)
        .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})(\.json(?:\.gz)?)$/))
        .filter((m) => m && m[2] === ext)
        .map((m) => m[1])
        .sort();
    } catch {
      return [];
    }
  };
  // Unique temp name per write: with two backend processes running (duplicate `node --watch`), a shared
  // `<file>.tmp` was renamed away by one process under the other — ENOENT crashed the backend (11 Nov 2026).
  const writeAtomic = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  };
  function readSplit() {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch (e) {
      // Unreadable state: keep the day files, restart the cluster heads (the night job refills any gap).
      console.error(`[acq] ${STATE_FILE} unreadable (${e.message}) — rebuilding from day files`);
      fs.copyFileSync(STATE_FILE, `${STATE_FILE}.bad-${Date.now()}`);
      s = { clusters: {}, provisional: {} };
    }
    s.v = 3;
    s.clusters ||= {};
    s.provisional ||= {};
    s.days = {};
    for (const d of listDays(DAYS_DIR, ".json")) {
      try {
        s.days[d] = JSON.parse(fs.readFileSync(dayFile(d), "utf8"));
      } catch (e) {
        // Never overwrite a day file we could not read: set it aside and say so.
        console.error(`[acq] ${dayFile(d)} unreadable (${e.message}) — moved aside`);
        fs.renameSync(dayFile(d), `${dayFile(d)}.bad-${Date.now()}`);
      }
    }
    return s;
  }
  let migrate = false;
  let state = (() => {
    if (fs.existsSync(STATE_FILE)) return readSplit();
    try {
      const s = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
      if (s.v === 2) {
        migrate = true;
        return s;
      }
      // v1 had no 10-min slot series: keep it aside and rebuild.
      fs.renameSync(LEGACY_FILE, path.join(dataDir, "acq-daily.v1.json"));
    } catch {
      /* fresh */
    }
    return emptyState();
  })();
  state.v = 3;
  const dirtyDays = new Set();
  const archDays = new Set(listDays(ARCH_DIR, ".json.gz"));
  const archCache = new Map();
  function loadArch(d) {
    if (archCache.has(d)) {
      const v = archCache.get(d);
      archCache.delete(d);
      archCache.set(d, v);
      return v;
    }
    try {
      const v = JSON.parse(zlib.gunzipSync(fs.readFileSync(archFile(d))).toString("utf8"));
      archCache.set(d, v);
      if (archCache.size > ARCH_CACHE) archCache.delete(archCache.keys().next().value);
      return v;
    } catch (e) {
      console.error(`[acq] archive ${archFile(d)} unreadable: ${e.message}`);
      return undefined;
    }
  }
  /** Any stored day: in memory (hot) or from the archive. */
  const dayOf = (d) => state.days[d] || (archDays.has(d) ? loadArch(d) : undefined);
  const allDays = () => [...new Set([...archDays, ...Object.keys(state.days)])].sort();
  // Read-only state for the views: days resolve through the archive as well.
  const viewDays = new Proxy({}, { get: (_, k) => (typeof k === "string" ? dayOf(k) : undefined) });
  const view = () => ({ ...state, days: viewDays });
  /** A slot is about to be written into day d: bring an archived day back into memory first (never a partial copy). */
  function ensureHot(d) {
    if (state.days[d] || !archDays.has(d)) return;
    const v = loadArch(d);
    if (!v) throw new Error(`archived day ${d} unreadable — not writing into it`);
    archCache.delete(d);
    state.days[d] = v;
  }
  let rev = 0;
  const status = {
    enabled: process.env.ACQ_COLLECTOR !== "false",
    slotsRead: 0,
    backoffUntil: 0,
    slow: null,
    lastSlotAt: null,
  };
  const isHeld = () => !!state.paused || Date.now() < status.backoffUntil || redashCooling();
  const hm = (ms) => istStamp(ms).slice(11, 16);
  const holdReason = () =>
    state.paused
      ? "Sync stopped — press Start sync"
      : redashCooling()
        ? `Redash failing — queue paused until ${hm(acqGate.coolUntil)} IST`
        : Date.now() < status.backoffUntil
          ? `Redash slow (${Math.round((status.slow?.ms || 0) / 1000)}s query) — queue resting until ${hm(status.backoffUntil)} IST`
          : null;

  let dirty = 0;
  const dayMinus = (n) => istStamp(todayStartMs() - n * 86400000).slice(0, 10);
  /** Gzip one day to the archive, check the copy reads back identical, then drop the plain file. */
  function archiveDay(d) {
    const json = JSON.stringify(state.days[d]);
    writeAtomic(archFile(d), zlib.gzipSync(json));
    if (zlib.gunzipSync(fs.readFileSync(archFile(d))).toString("utf8") !== json) throw new Error(`archive copy of ${d} differs`);
    fs.rmSync(dayFile(d), { force: true });
    delete state.days[d];
    dirtyDays.delete(d);
    archDays.add(d);
    archCache.delete(d);
  }
  function save(force) {
    if (!force && (dirty += 1) < 6) return;
    dirty = 0;
    // Raw rows past the provisional window go; the counts already in the day are final.
    const provMin = Math.max(PROVISIONAL_MIN, FINAL_REREAD ? 36 * 60 : 0) + SLOT_MIN;
    for (const k of Object.keys(state.provisional)) if (Date.now() - Number(k.split("|")[1]) > provMin * 60000) delete state.provisional[k];
    const hotFrom = dayMinus(HOT_DAYS);
    for (const d of Object.keys(state.days))
      if (d < hotFrom)
        try {
          archiveDay(d);
        } catch (e) {
          console.error(`[acq] archiving ${d} failed (kept in memory): ${e.message}`);
        }
    if (RETENTION_DAYS > 0) {
      const keep = dayMinus(Math.max(RETENTION_DAYS, HOT_DAYS));
      for (const d of [...archDays])
        if (d < keep && !state.days[d]) {
          fs.rmSync(archFile(d), { force: true });
          archDays.delete(d);
          archCache.delete(d);
        }
    }
    for (const d of dirtyDays) if (state.days[d]) writeAtomic(dayFile(d), JSON.stringify(state.days[d]));
    dirtyDays.clear();
    const { days: _days, ...rest } = state;
    writeAtomic(STATE_FILE, JSON.stringify(rest));
  }

  // ── Redash access for jobs: one call at a time through the shared gate, counted per job.
  const lastQueryMs = {}; // per data source (host): pacing is per slave
  async function query(ctx, source, dataSourceId, sql, { maxSec = ctx.maxSec || DB_MAX_SEC, slowMs = ctx.slowMs || SLOW_MS } = {}) {
    if (!ctx.force && isHeld()) throw new HoldError(holdReason() || "held");
    const rest = Math.max(QUERY_GAP_MS, (lastQueryMs[dataSourceId] || 0) * (ctx.trickle ? TRICKLE_REST : ctx.night ? NIGHT_DUTY_REST : DUTY_REST));
    if (rest > 0) await sleepAbortable(rest, ctx.signal);
    if (!ctx.force && isHeld()) throw new HoldError(holdReason() || "held");
    const t = Date.now();
    ctx.job.queries += 1;
    try {
      const rows = await countedRedash(source, dataSourceId, withMaxTime(sql, maxSec), { timeoutMs: TIMEOUT_MS, signal: ctx.signal, force: ctx.force });
      const ms = Date.now() - t;
      lastQueryMs[dataSourceId] = ms;
      if (ctx.night) spendNight(ctx.cluster, ms);
      if (ctx.trickle) spendTrickle(ctx.cluster, ms);
      if (ctx.trickle && ms > slowMs) throw trickleRest(`${ctx.cluster} piece took ${(ms / 1000).toFixed(1)}s`);
      if (ms > slowMs) {
        status.slow = { at: Date.now(), ms, ds: dataSourceId };
        status.backoffUntil = Date.now() + BACKOFF_MIN * 60000;
      }
      return rows;
    } catch (err) {
      lastQueryMs[dataSourceId] = Date.now() - t;
      if (ctx.signal?.aborted) throw err;
      if (err instanceof RedashCoolingError) throw new HoldError(err.message);
      if (ctx.trickle && (isDbKill(err) || /timeout|timed out|exceeded/i.test(err.message))) {
        spendTrickle(ctx.cluster, Date.now() - t);
        throw trickleRest(isDbKill(err) ? `DB stopped a ${ctx.cluster} piece at ${maxSec}s` : err.message);
      }
      if (isDbKill(err) || /timeout|timed out|exceeded/i.test(err.message)) {
        status.slow = { at: Date.now(), ms: Date.now() - t, ds: dataSourceId, error: isDbKill(err) ? `killed by DB at ${maxSec}s` : err.message };
        status.backoffUntil = Date.now() + BACKOFF_MIN * 60000;
        throw new HoldError(`${isDbKill(err) ? `DB stopped the query at ${maxSec}s (slave busy)` : err.message} — resting until ${hm(status.backoffUntil)} IST`);
      }
      throw err;
    }
  }

  /**
   * Primary-key ranges for each slot, split into `parts` sub-windows, from one id-lookup query.
   * Ids follow created_on (checked on C3: no row crosses a boundary), so the margin is only a guard;
   * the created_on filter in the slot query keeps counts exact.
   */
  async function slotBounds(ctx, cluster, slots, parts = 1) {
    const step = SLOT_MS / parts;
    const edges = (s) => Array.from({ length: parts }, (_, k) => [s + k * step, s + (k + 1) * step]);
    const lo = (t) => istStamp(t - ID_MARGIN_SEC * 1000);
    const hi = (t) => istStamp(t + ID_MARGIN_SEC * 1000);
    const uniq = [...new Set(slots.flatMap((s) => edges(s).flatMap(([a, b]) => [lo(a), hi(b)])))];
    const sql = [...uniq.map((ts, k) => COLLECTOR_SQL.boundsRow.replace("{{K}}", k).replace("{{TS}}", ts)), COLLECTOR_SQL.boundsMax].join("\nUNION ALL\n");
    const rows = await query(ctx, "collector", CLUSTERS[cluster], sql);
    const byK = Object.fromEntries(rows.map((r) => [Number(r.k), r.id == null ? null : Number(r.id)]));
    const idAt = (ts) => byK[uniq.indexOf(ts)];
    const max = byK[-1];
    return slots.map((s) => ({
      s,
      parts: edges(s).map(([a, b]) => {
        const to = idAt(hi(b));
        return { a, b, from: idAt(lo(a)), to: to == null ? (max == null ? null : max + 1) : to };
      }),
    }));
  }

  async function readSlots(ctx, cluster, slots, onSlot) {
    if (!slots.length) return 0;
    const parts = ctx.parts || 1;
    const bounds = await slotBounds(ctx, cluster, slots, parts);
    for (const b of bounds) {
      // Automatic night runs stop once the cluster's nightly DB-time budget is spent.
      if (ctx.night && !ctx.force && nightLeft() <= 0) break;
      if (ctx.trickle && !ctx.force && trickleLeft() <= 0) break;
      let rows = [];
      for (const [k, p] of b.parts.entries()) {
        ctx.job.current = `${cluster} ${istStamp(p.a).slice(5, 16)}${parts > 1 ? ` (part ${k + 1}/${parts})` : ""}`;
        if (p.from == null || p.to == null) continue;
        const sql = COLLECTOR_SQL.slot.replace("{{ID_FROM}}", p.from).replace("{{ID_TO}}", p.to).replace("{{FROM}}", istStamp(p.a)).replace("{{TO}}", istStamp(p.b));
        rows = rows.concat(normalise(await query(ctx, "collector", CLUSTERS[cluster], sql)));
      }
      status.slotsRead += 1;
      status.lastSlotAt = Date.now();
      ctx.job.slots += 1;
      processSlot(cluster, b.s, rows);
      onSlot?.(b.s);
    }
    ctx.job.current = null;
    return slots.length;
  }

  function processSlot(cluster, slotStart, rows) {
    const key = `${cluster}|${slotStart}`;
    const d = istStamp(slotStart).slice(0, 10);
    ensureHot(d);
    dirtyDays.add(d);
    const old = state.provisional[key];
    if (old) {
      apply(state, cluster, slotStart, old.r, -1);
      delete state.provisional[key];
    }
    apply(state, cluster, slotStart, rows, 1);
    const age = Date.now() - (slotStart + SLOT_MS);
    // f: this read was the 12h final re-read, so it is not due again.
    if (age < PROVISIONAL_MIN * 60000) state.provisional[key] = age >= FINAL_LAG_MIN * 60000 ? { r: rows, a: Date.now(), f: 1 } : { r: rows, a: Date.now() };
    rev += 1;
    save(false);
  }

  // ── recent:<cluster> — newest slots + settle re-read (hot data only)
  const clusterState = (cluster) => {
    const c = (state.clusters[cluster] ||= {});
    if (c.head == null) c.head = c.tail = floorSlot(Date.now() - START_BACK_MIN * 60000);
    c.gaps ||= [];
    // Fell behind (stopped, backing off): don't chase cold slots in the day — skip ahead, leave a gap for the night.
    if (c.head < Date.now() - HOT_MAX_MIN * 60000) {
      const jumpTo = floorSlot(Date.now() - START_BACK_MIN * 60000);
      c.head = jumpTo; // the skipped slots are picked up by the night job (it looks for unread slots)
    }
    return c;
  };
  const headReady = (c) => c.head + SLOT_MS <= Date.now() - LAG_MIN * 60000;
  function rereadsDue(cluster) {
    const now = Date.now();
    const settle = [];
    const final = [];
    for (const [k, v] of Object.entries(state.provisional)) {
      const [cl, s] = k.split("|");
      if (cl !== cluster) continue;
      const end = Number(s) + SLOT_MS;
      if (now - end >= FINAL_LAG_MIN * 60000) {
        if (FINAL_REREAD && !v.f) final.push(Number(s));
      }
      // Settle only while still hot; missed settles are covered by the night final re-read.
      else if (v.a - end < SETTLE_MIN * 60000 && now - end >= SETTLE_MIN * 60000 && now - end < HOT_MAX_MIN * 60000) settle.push(Number(s));
    }
    return { settle: settle.sort((a, b) => a - b), final: final.sort((a, b) => a - b) };
  }
  async function runRecent(cluster, ctx) {
    const c = clusterState(cluster);
    const head = [];
    while (head.length < RECENT_PER_RUN && c.head + (head.length + 1) * SLOT_MS <= Date.now() - LAG_MIN * 60000) head.push(c.head + head.length * SLOT_MS);
    const reread = rereadsDue(cluster).settle.slice(0, Math.max(0, RECENT_PER_RUN - head.length));
    const isHead = new Set(head);
    // One id-lookup query for new + settle slots together.
    await readSlots(ctx, cluster, [...head, ...reread], (s) => {
      if (isHead.has(s)) c.head = s + SLOT_MS;
    });
    return {
      note: `${head.length} new · ${reread.length} settle re-read · data to ${hm(c.head)}${headReady(c) || rereadsDue(cluster).settle.length ? " · more due" : ""}`,
    };
  }

  // ── night fill — ONE job for all clusters, in lockstep: the same 10-min slot is read on C2, C3 and C6 before
  // stepping one slot further back, so every cluster ends the night covering the same time range. Order: newest
  // missing slot first (gaps from the day), down to the plan's fillTo (default: the first slot ever read, i.e.
  // holes only). Stops at the end of the window or when the night's DB-time budget (all clusters together) is spent.
  const CL_IDS = Object.keys(CLUSTERS);
  const NIGHT_STEPS_PER_RUN = 3;
  const nightKey = () => istStamp(Date.now() - 6 * 3600000).slice(0, 10); // the IST date the night started
  function spendNight(cluster, ms) {
    if (state.nightUse?.day !== nightKey()) state.nightUse = { day: nightKey(), ms: 0, byCluster: {} };
    state.nightUse.ms = (state.nightUse.ms || 0) + ms;
    state.nightUse.byCluster ||= {};
    state.nightUse.byCluster[cluster] = (state.nightUse.byCluster[cluster] || 0) + ms;
  }
  /** Active plan: one set via POST /api/acq/night/plan for this night (or every night when repeat). */
  const nightPlan = () => {
    const p = state.nightPlan;
    return p && (p.repeat || p.night === nightKey()) ? p : null;
  };
  // A one-night plan may open the night early that evening (openAt "HH:MM", 12:00 or later — e.g. 23:00 for a big
  // fill). It runs from openAt until the regular window takes over; every other night keeps ACQ_NIGHT_WINDOW.
  const openAtMin = (p) => (p?.openAt && !p.repeat ? Number(p.openAt.slice(0, 2)) * 60 + Number(p.openAt.slice(3, 5)) : null);
  const nightOpen = () => {
    if (inNight()) return true;
    const p = nightPlan();
    const open = openAtMin(p);
    if (open == null || !NIGHT || p.night !== nightKey()) return false;
    const now = istMinuteOfDay(Date.now());
    return now >= open || now < NIGHT.from;
  };
  const nightOpensAt = () => {
    const p = state.nightPlan;
    const open = openAtMin(p);
    const early = open != null ? stampMs(`${p.night} 00:00:00`) + open * 60000 : null;
    return early && early > Date.now() ? early : nextNightAt();
  };
  const budgetMs = () => (nightPlan()?.budgetMin ?? NIGHT_BUDGET_MIN * CL_IDS.length) * 60000;
  const nightUsedMs = () => (state.nightUse?.day === nightKey() ? state.nightUse.ms || 0 : 0);
  const nightLeft = () => budgetMs() - nightUsedMs();
  const slotRead = (cl, s) => {
    const st = istStamp(s);
    return (dayOf(st.slice(0, 10))?.ts?.[st.slice(11, 16)]?.c?.[cl] || 0) > 0;
  };
  function firstReadSlot() {
    const d = allDays()[0];
    const ts = dayOf(d)?.ts || {};
    const hms = Object.keys(ts)
      .filter((h) => Object.keys(ts[h].c || {}).length)
      .sort();
    return hms.length ? stampMs(`${d} ${hms[0]}:00`) : null;
  }
  // 00:00 IST of the first of the last NIGHT_DAYS days, counted back from the night's date (the evening it starts):
  // the night of 13→14 Nov covers 12 Nov, 13 Nov (just ended) and 14 Nov so far.
  const autoFloor = () => stampMs(`${istStamp(stampMs(`${nightKey()} 00:00:00`) - (NIGHT_DAYS - 1) * 86400000).slice(0, 10)} 00:00:00`);
  const SLOTS_PER_DAY = (24 * 60) / SLOT_MIN;
  const dayComplete = (d) => {
    const day = dayOf(d);
    return !!day && CL_IDS.every((cl) => (day.slots?.[cl] || 0) >= SLOTS_PER_DAY);
  };
  /** Oldest complete day and the deep floor DEEP_DAYS before it (null when off / nothing complete yet). */
  function deepTarget() {
    if (!DEEP_DAYS) return null;
    const from = allDays().find(dayComplete);
    if (!from) return null;
    let floor = stampMs(`${from} 00:00:00`) - DEEP_DAYS * 86400000;
    if (RETENTION_DAYS > 0) floor = Math.max(floor, todayStartMs() - (RETENTION_DAYS - 1) * 86400000);
    return { from, floor };
  }
  // Fixed for the whole night once it starts, so finishing a day mid-night does not move the target further back.
  const deepFloor = () => (state.nightDeep?.night === nightKey() ? state.nightDeep.floor : (deepTarget()?.floor ?? null));
  const fillFloor = () => {
    const p = nightPlan();
    return Math.min(autoFloor(), deepFloor() ?? Infinity, p?.fillTo ? stampMs(`${p.fillTo}:00`) : Infinity);
  };
  // Younger slots belong to the recent:* jobs (still hot).
  const fillTop = () => Math.min(floorSlot(Date.now() - HOT_MAX_MIN * 60000), ...CL_IDS.map((cl) => state.clusters[cl]?.head ?? Infinity));
  function nightSteps(limit = Infinity, floor = fillFloor()) {
    const out = [];
    if (floor == null) return out;
    for (let s = fillTop() - SLOT_MS; s >= floor && out.length < limit; s -= SLOT_MS) {
      const miss = CL_IDS.filter((cl) => !slotRead(cl, s));
      if (miss.length) out.push({ s, miss });
    }
    return out;
  }
  function nightSummary() {
    const steps = nightSteps();
    const byCluster = Object.fromEntries(CL_IDS.map((cl) => [cl, steps.filter((x) => x.miss.includes(cl)).length]));
    return {
      steps: steps.length,
      slots: steps.reduce((n, x) => n + x.miss.length, 0),
      byCluster,
      newest: steps[0]?.s ?? null,
      oldest: steps.at(-1)?.s ?? null,
      floor: fillFloor(),
      nightDays: NIGHT_DAYS,
      deep: DEEP_DAYS
        ? (() => {
            const fixed = state.nightDeep?.night === nightKey() ? state.nightDeep : null;
            const t = fixed || deepTarget();
            return t?.floor != null ? { days: DEEP_DAYS, from: t.from, to: istStamp(t.floor).slice(0, 10), fixed: !!fixed } : { days: DEEP_DAYS, from: null, to: null };
          })()
        : null,
      // Gaps older than the floor (since the first stored slot): left for a night plan or the trickle.
      olderSlots: (() => {
        const first = firstReadSlot();
        const floor = fillFloor();
        if (first == null || first >= floor) return 0;
        let n = 0;
        for (let s = floor - SLOT_MS; s >= first; s -= SLOT_MS) n += CL_IDS.filter((cl) => !slotRead(cl, s)).length;
        return n;
      })(),
    };
  }
  async function runNight(ctx) {
    if (state.nightDeep?.night !== nightKey()) {
      const t = deepTarget();
      state.nightDeep = { night: nightKey(), floor: t?.floor ?? null, from: t?.from ?? null };
    }
    ctx.maxSec = DB_MAX_NIGHT_SEC;
    ctx.slowMs = DB_MAX_NIGHT_SEC * 1000;
    ctx.parts = ctx.test?.parts || NIGHT_PARTS;
    ctx.night = true;
    let read = 0;
    const done = [];
    if (FINAL_REREAD)
      for (const cl of CL_IDS) {
        ctx.cluster = cl;
        const finals = rereadsDue(cl).final.slice(0, 3);
        if (finals.length && (ctx.force || nightLeft() > 0)) read += await readSlots(ctx, cl, finals);
      }
    for (const step of nightSteps(ctx.test?.limit || NIGHT_STEPS_PER_RUN)) {
      if (!ctx.force && nightLeft() <= 0) break;
      // Same slot on every missing cluster, side by side (separate hosts, one query each); the next step
      // starts only when all of them are done, so the clusters stay level.
      const res = await Promise.allSettled(step.miss.map((cl) => readSlots({ ...ctx, cluster: cl }, cl, [step.s])));
      for (const r of res) if (r.status === "fulfilled") read += r.value;
      const failed = res.find((r) => r.status === "rejected");
      if (failed) throw failed.reason;
      done.push(hm(step.s));
    }
    const left = nightSummary();
    return {
      note: `${read} slots (${done.join(", ") || "—"}) · ${left.steps} steps left${left.newest ? ` (${istStamp(left.newest).slice(5, 16)} → ${istStamp(left.oldest).slice(5, 16)})` : ""} · budget ${Math.round(nightUsedMs() / 60000)}/${Math.round(budgetMs() / 60000)} min`,
    };
  }

  // ── daytime trickle — same lockstep order as the night job (newest missing step first, every cluster of a
  // step before the next one back) but one cluster-slot per run, outside the night window, under a per-day budget.
  class TrickleRest extends Error {}
  const trickleRest = (why) => {
    state.trickleHoldUntil = Date.now() + TRICKLE_HOLD_MIN * 60000;
    return new TrickleRest(`${why} — trickle resting until ${hm(state.trickleHoldUntil)} IST`);
  };
  const istToday = () => istStamp(Date.now()).slice(0, 10);
  function spendTrickle(cluster, ms) {
    if (state.trickleUse?.day !== istToday()) state.trickleUse = { day: istToday(), ms: 0, byCluster: {} };
    state.trickleUse.ms += ms;
    state.trickleUse.byCluster[cluster] = (state.trickleUse.byCluster[cluster] || 0) + ms;
  }
  const tricklePlan = () => state.tricklePlan || null;
  const trickleUsedMs = () => (state.trickleUse?.day === istToday() ? state.trickleUse.ms : 0);
  const trickleLeft = () => (tricklePlan() ? tricklePlan().budgetMin * 60000 - trickleUsedMs() : 0);
  const trickleFloor = () => {
    const p = tricklePlan();
    if (!p?.fillTo) return null;
    return Math.min(stampMs(`${p.fillTo}:00`), firstReadSlot() ?? Infinity);
  };
  const trickleSteps = (limit) => (trickleFloor() == null ? [] : nightSteps(limit, trickleFloor()));
  const trickleHeld = () => Date.now() < (state.trickleHoldUntil || 0);
  function trickleDue(j) {
    const p = tricklePlan();
    if (!p || nightOpen() || trickleHeld() || trickleLeft() <= 0) return false;
    if (queue.length || current) return false; // live work first; the trickle only uses idle time
    if (Date.now() - (j.lastRunAt || 0) < p.everyMin * 60000) return false;
    return trickleSteps(1).length > 0;
  }
  async function runTrickle(ctx) {
    if (!tricklePlan()) return { note: "trickle is off — set a plan with POST /api/acq/trickle" };
    const step = trickleSteps(1)[0];
    if (!step) return { note: "nothing left to fill" };
    const cl = step.miss[0];
    Object.assign(ctx, { trickle: true, cluster: cl, maxSec: TRICKLE_MAX_SEC, slowMs: TRICKLE_SLOW_MS, parts: ctx.test?.parts || TRICKLE_PARTS });
    const t = Date.now();
    try {
      await readSlots(ctx, cl, [step.s]);
    } catch (err) {
      if (err instanceof TrickleRest) return { note: err.message };
      throw err;
    }
    const left = trickleSteps();
    return {
      note: `${cl} ${istStamp(step.s).slice(5, 16)} in ${((Date.now() - t) / 1000).toFixed(0)}s · ${left.reduce((n, x) => n + x.miss.length, 0)} cluster-slots left · today ${(trickleUsedMs() / 60000).toFixed(1)}/${tricklePlan()?.budgetMin} min DB`,
    };
  }
  /** Trickle plan: { fillTo: "YYYY-MM-DD HH:MM", budgetMin (DB minutes per IST day), everyMin (gap between chunks) } or null (off). */
  function setTricklePlan(p) {
    if (!p) state.tricklePlan = null;
    else {
      const fillTo = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.fillTo || "") ? p.fillTo : null;
      if (!fillTo) throw new Error("fillTo must be YYYY-MM-DD HH:MM");
      state.tricklePlan = {
        fillTo,
        budgetMin: Math.max(1, Math.min(120, Number(p.budgetMin) || 20)),
        everyMin: Math.max(2, Math.min(60, Number(p.everyMin) || 5)),
        setAt: Date.now(),
      };
    }
    state.trickleHoldUntil = 0;
    save(true);
    return state.tricklePlan;
  }
  function trickleSummary() {
    const steps = trickleSteps();
    const p = tricklePlan();
    return {
      plan: p,
      on: !!p,
      usedMin: Math.round(trickleUsedMs() / 6000) / 10,
      usedByCluster: Object.fromEntries(CL_IDS.map((cl) => [cl, Math.round((state.trickleUse?.day === istToday() ? state.trickleUse.byCluster[cl] || 0 : 0) / 6000) / 10])),
      holdUntil: trickleHeld() ? state.trickleHoldUntil : 0,
      slots: steps.reduce((n, x) => n + x.miss.length, 0),
      byCluster: Object.fromEntries(CL_IDS.map((cl) => [cl, steps.filter((x) => x.miss.includes(cl)).length])),
      newest: steps[0] ? istStamp(steps[0].s).slice(0, 16) : null,
      oldest: steps.at(-1) ? istStamp(steps.at(-1).s).slice(0, 16) : null,
      parts: TRICKLE_PARTS,
      maxSec: TRICKLE_MAX_SEC,
      slowSec: TRICKLE_SLOW_MS / 1000,
      rest: TRICKLE_REST,
      holdMin: TRICKLE_HOLD_MIN,
    };
  }

  // ── job registry + queue
  const defs = new Map();
  const jobs = {};
  const queue = [];
  let current = null;

  function addJob(def) {
    defs.set(def.id, def);
    jobs[def.id] ||= {
      id: def.id,
      label: def.label,
      group: def.group,
      source: def.source || "collector",
      status: "idle",
      attempt: 0,
      queries: 0,
      slots: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      elapsedMs: null,
      error: null,
      note: null,
      trigger: null,
      nextRetryAt: null,
      startedAt: null,
      current: null,
    };
  }
  for (const cl of Object.keys(CLUSTERS)) {
    addJob({
      id: `recent:${cl}`,
      group: "Recent",
      label: `${cl} · new slots ${LAG_MIN} min after they end + settle re-read at ${SETTLE_MIN} min`,
      run: (ctx) => runRecent(cl, ctx),
      due: () => headReady(clusterState(cl)) || rereadsDue(cl).settle.length > 0,
    });
  }
  addJob({
    id: "night",
    group: "Night",
    night: true,
    label: `C2 + C3 + C6 in lockstep · fill missing slots, newest first — night ${NIGHT ? NIGHT.text : "off"} IST, shared DB budget`,
    run: (ctx) => runNight(ctx),
    due: () => nightOpen() && nightLeft() > 0 && nightSteps(1).length > 0,
  });

  addJob({
    id: "trickle",
    group: "Night",
    label: `Day trickle · one cluster-slot per chunk in ${SLOT_MIN / TRICKLE_PARTS}-min pieces (≤${TRICKLE_MAX_SEC}s each, rest ${TRICKLE_REST}×) — only when idle, outside the night window`,
    run: (ctx) => runTrickle(ctx),
    due: (j) => trickleDue(j),
  });

  function logRun(entry) {
    try {
      fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
      fs.appendFileSync(RUNS_FILE, `${JSON.stringify(entry)}\n`);
      if (fs.statSync(RUNS_FILE).size > RUNS_MAX_BYTES) {
        const lines = fs.readFileSync(RUNS_FILE, "utf8").trim().split("\n");
        fs.writeFileSync(RUNS_FILE, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`);
      }
    } catch {
      /* history is best effort */
    }
  }

  function enqueue(id, trigger) {
    const j = jobs[id];
    if (!j || ACTIVE.has(j.status)) return false;
    Object.assign(j, { status: "queued", trigger, queuedAt: Date.now(), nextRetryAt: null });
    queue.push(id);
    setImmediate(pump);
    return true;
  }

  function pump() {
    if (current || !queue.length) return;
    // Held (stopped / Redash slow / failing): only manual runs go.
    let i = 0;
    if (isHeld()) {
      i = queue.findIndex((id) => jobs[id].trigger === "manual");
      if (i < 0) return;
    }
    const [id] = queue.splice(i, 1);
    runJob(id);
  }

  async function runJob(id) {
    const def = defs.get(id);
    const j = jobs[id];
    const ctrl = new AbortController();
    current = { id, ctrl };
    Object.assign(j, { status: "running", startedAt: Date.now(), queries: 0, slots: 0, error: null, note: null, current: null });
    const ctx = { job: j, signal: ctrl.signal, force: j.trigger === "manual", test: j.test || null, query: (source, ds, sql, opts) => query(ctx, source, ds, sql, opts) };
    j.test = null;
    try {
      const r = await def.run(ctx);
      Object.assign(j, { status: "success", attempt: 0, lastSuccessAt: Date.now(), note: r?.note || null });
    } catch (err) {
      if (ctrl.signal.aborted) Object.assign(j, { status: "cancelled", attempt: 0, error: "Stopped" });
      else if (err instanceof HoldError) {
        // Not the job's fault: wait for the hold to end, then run again.
        Object.assign(j, { status: "retry-wait", error: err.message, nextRetryAt: Math.max(status.backoffUntil, acqGate.coolUntil, Date.now() + 60000) });
      } else {
        j.attempt += 1;
        j.error = err.message;
        if (j.attempt < MAX_ATTEMPTS) Object.assign(j, { status: "retry-wait", nextRetryAt: Date.now() + RETRY_MIN[j.attempt - 1] * 60000 });
        else Object.assign(j, { status: "failed", attempt: 0 });
      }
    } finally {
      j.elapsedMs = Date.now() - j.startedAt;
      j.lastRunAt = Date.now();
      j.current = null;
      current = null;
      logRun({ at: Date.now(), id, label: j.label, trigger: j.trigger, status: j.status, ms: j.elapsedMs, queries: j.queries, slots: j.slots, note: j.note, error: j.error });
      save(true);
      setImmediate(pump);
    }
  }

  function scheduler() {
    if (!status.enabled) return;
    const now = Date.now();
    if (!state.paused) {
      for (const [id, def] of defs) {
        const j = jobs[id];
        if (ACTIVE.has(j.status)) continue;
        if (j.status === "retry-wait") {
          if (j.nextRetryAt <= now) enqueue(id, "retry");
          continue;
        }
        if (j.status === "failed" && now - (j.lastRunAt || 0) < FAIL_REST_MIN * 60000) continue;
        if (def.due(j)) enqueue(id, "auto");
      }
    }
    pump();
  }

  function start() {
    if (!status.enabled) return;
    setTimeout(scheduler, 10000);
    setInterval(scheduler, SCHEDULER_MS).unref?.();
  }

  // ── controls
  function run(ids, trigger = "manual", test = null) {
    const list = ids?.length ? ids : [...defs.keys()];
    for (const id of list) {
      if (test && jobs[id] && !ACTIVE.has(jobs[id].status)) jobs[id].test = test;
      const j = jobs[id];
      if (!j) continue;
      if (j.status === "retry-wait") j.status = "idle";
      enqueue(id, trigger);
    }
    return list;
  }
  function stop(ids) {
    const list = ids?.length ? ids : [...defs.keys()];
    for (const id of list) {
      const j = jobs[id];
      if (!j) continue;
      const qi = queue.indexOf(id);
      if (qi >= 0) queue.splice(qi, 1);
      if (j.status === "queued" || j.status === "retry-wait") Object.assign(j, { status: "cancelled", nextRetryAt: null, error: "Stopped" });
      if (current?.id === id) current.ctrl.abort(new Error("Stopped"));
    }
  }
  function retryNow(id) {
    const j = jobs[id];
    if (!j) return;
    if (redashCooling()) resetRedashBreaker();
    status.backoffUntil = 0;
    if (j.status === "retry-wait" || j.status === "failed" || j.status === "cancelled" || j.status === "idle") {
      j.status = "idle";
      enqueue(id, "manual");
    }
  }
  /** Night plan: { fillTo: "YYYY-MM-DD HH:MM" (oldest slot to reach), budgetMin (DB minutes, all clusters), repeat,
   *  openAt: "HH:MM" (one night only: start the night job this evening instead of at the window) }. */
  function setNightPlan(p) {
    if (!p) state.nightPlan = null;
    else {
      const fillTo = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(p.fillTo || "") ? p.fillTo : null;
      const budgetMin = Math.max(5, Math.min(900, Number(p.budgetMin) || NIGHT_BUDGET_MIN * CL_IDS.length));
      // Before the window opens, "tonight" is the night that starts at the next window.
      const night = inNight() ? nightKey() : istStamp(nextNightAt() - 6 * 3600000).slice(0, 10);
      const openAt = /^(1[2-9]|2[0-3]):[0-5]\d$/.test(p.openAt || "") && !p.repeat ? p.openAt : null;
      state.nightPlan = { fillTo, budgetMin, repeat: !!p.repeat, night, ...(openAt ? { openAt } : {}), setAt: Date.now() };
    }
    save(true);
    return state.nightPlan;
  }

  function setPaused(paused) {
    state.paused = !!paused;
    if (paused) stop();
    else {
      status.backoffUntil = 0;
      resetRedashBreaker();
      for (const j of Object.values(jobs)) if (j.status === "cancelled") j.status = "idle";
      setImmediate(scheduler);
    }
    save(true);
  }

  // ── reads for the page
  function coverage() {
    const night = nightSummary();
    const clusters = Object.fromEntries(
      Object.keys(CLUSTERS).map((cl) => {
        const c = state.clusters[cl];
        return [
          cl,
          c?.head
            ? {
                head: istStamp(c.head).slice(0, 16),
                tail: istStamp(c.tail).slice(0, 16),
                missing: night.byCluster[cl],
              }
            : null,
        ];
      }),
    );
    return {
      clusters,
      slotMin: SLOT_MIN,
      lagMin: LAG_MIN,
      settleMin: SETTLE_MIN,
      finalLagMin: FINAL_LAG_MIN,
      finalReread: FINAL_REREAD,
      backfillDays: BACKFILL_DAYS,
      retentionDays: RETENTION_DAYS,
      hotDays: HOT_DAYS,
      provisionalHours: PROVISIONAL_MIN / 60,
      storage: {
        dir: path.relative(dataDir, DIR) || ".",
        archiveDir: ARCH_DIR,
        days: allDays().length,
        firstDay: allDays()[0] || null,
        hot: Object.keys(state.days).length,
        archived: [...archDays].filter((d) => !state.days[d]).length,
        provisionalSlots: Object.keys(state.provisional).length,
      },
      slotsPerDay: (24 * 60) / SLOT_MIN,
      backfillPerRun: BACKFILL_PER_RUN,
      backfillEveryMin: BACKFILL_EVERY_MIN,
      nightWindow: NIGHT ? NIGHT.text : null,
      inNight: inNight(),
      nightOpen: nightOpen(),
      nightOpensAt: nightOpensAt(),
      nextNightAt: nextNightAt(),
      dbMaxSec: DB_MAX_SEC,
      dbMaxNightSec: DB_MAX_NIGHT_SEC,
      slowSec: SLOW_MS / 1000,
      hotMaxMin: HOT_MAX_MIN,
      finalsPending: Object.keys(CLUSTERS).reduce((n, cl) => n + rereadsDue(cl).final.length, 0),
      nightParts: NIGHT_PARTS,
      nightPlan: nightPlan(),
      nightBudgetMin: Math.round(budgetMs() / 60000),
      nightUsedMin: Math.round(nightUsedMs() / 6000) / 10,
      nightUsedByCluster: Object.fromEntries(CL_IDS.map((cl) => [cl, Math.round((state.nightUse?.day === nightKey() ? state.nightUse.byCluster?.[cl] || 0 : 0) / 6000) / 10])),
      night: {
        ...night,
        newest: night.newest && istStamp(night.newest).slice(0, 16),
        oldest: night.oldest && istStamp(night.oldest).slice(0, 16),
        floor: night.floor && istStamp(night.floor).slice(0, 16),
      },
      backfillLeftSlots: night.slots,
      trickle: trickleSummary(),
    };
  }

  function statusSnapshot() {
    return {
      at: Date.now(),
      enabled: status.enabled,
      paused: !!state.paused,
      held: isHeld(),
      holdReason: holdReason(),
      backoffUntil: status.backoffUntil > Date.now() ? status.backoffUntil : 0,
      slow: status.slow,
      slotsRead: status.slotsRead,
      lastSlotAt: status.lastSlotAt,
      current: current?.id || null,
      queue: [...queue],
      jobs: [...defs.keys()].map((id) => ({ ...jobs[id], nextDueAt: nextDueAt(id) })),
      gate: acqGateStatus(),
      coverage: coverage(),
      schedulerSec: SCHEDULER_MS / 1000,
    };
  }
  function nextDueAt(id) {
    const j = jobs[id];
    if (j.status === "retry-wait") return j.nextRetryAt;
    if (id.startsWith("recent:")) {
      const c = state.clusters[id.slice(7)];
      return c?.head ? c.head + SLOT_MS + LAG_MIN * 60000 : null;
    }
    if (id === "trickle") {
      const p = tricklePlan();
      if (!p || trickleLeft() <= 0) return null;
      if (nightOpen()) return null;
      return Math.max((j.lastRunAt || 0) + p.everyMin * 60000, state.trickleHoldUntil || 0);
    }
    if (id === "night") return nightOpen() ? j.lastRunAt || 0 : nightOpensAt();
    if (defs.get(id).night) return inNight() ? (j.lastRunAt || 0) + BACKFILL_EVERY_MIN * 60000 : nextNightAt();
    return defs.get(id).nextAt?.(j) ?? null;
  }

  function readRuns(limit = 200) {
    try {
      const lines = fs.readFileSync(RUNS_FILE, "utf8").trim().split("\n");
      return lines
        .slice(-limit)
        .reverse()
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Day-level payload (Daily view): no slot series. */
  function snapshot() {
    const days = allDays()
      .reverse()
      .map((d) => [d, dayOf(d)])
      .filter(([, day]) => day)
      .map(([d, day]) => {
        const codes = {};
        for (const [k, n] of Object.entries(day.codes)) {
          if (n <= 0) continue;
          const [flow, code] = k.split("|");
          (codes[flow] ||= []).push({ code, cnt: n });
        }
        for (const f of Object.keys(codes)) codes[f] = codes[f].sort((a, b) => b.cnt - a.cnt).slice(0, 40);
        // Slots still waiting for the 12h final re-read (the provisional rows themselves are kept longer).
        const provisional = Object.keys(state.provisional).filter((k) => {
          const s = Number(k.split("|")[1]);
          return istStamp(s).startsWith(d) && Date.now() - (s + SLOT_MS) < FINAL_LAG_MIN * 60000;
        }).length;
        return { day: d, slots: day.slots, flows: day.flows, hours: day.hours, codes, stuck: day.stuck, provisional };
      });
    return { at: Date.now(), days, collector: { ...coverage(), paused: !!state.paused, held: isHeld() }, flows: ACQ_FLOWS, sql: COLLECTOR_SQL };
  }

  /** Recent view: the four panel flows in 10/30/60-min buckets over the `hours` before `until` (default: newest data). */
  function recent({ hours = 3, bucketMin = 10, clusters, until = null } = {}) {
    const cl = clusters?.length ? clusters : Object.keys(CLUSTERS);
    const heads = cl.map((c) => state.clusters[c]?.head).filter(Boolean);
    const flows = [...RECENT_FLOWS, ACQ4];
    const days = allDays();
    const empty = { at: Date.now(), hours, bucketMin, clusters: cl, flows, buckets: [], incidents: [], codes: {}, impact: IMPACT, dataTo: null, live: !until, days };
    if (!heads.length) return empty;
    const vs = view();
    // Newest data of any selected cluster; buckets a cluster has not read yet are flagged (missing).
    const end = until ? Math.min(until, Math.max(...heads)) : Math.max(...heads);
    const bucketMs = bucketMin * 60000;
    const alignedEnd = Math.floor((end + TZ_OFFSET_MIN * 60000) / bucketMs) * bucketMs - TZ_OFFSET_MIN * 60000;
    const from = alignedEnd - hours * 3600000;
    const impact = makeImpact(vs, cl);
    const buckets = [];
    // The newest bucket may be partial (e.g. 22:00–22:20 of a 30-min bucket).
    for (let b = from; b < end; b += bucketMs) {
      const row = { from: b, to: Math.min(b + bucketMs, end), label: hm(b), partial: b + bucketMs > end, unsettled: false, flows: {} };
      for (const flow of flows) {
        const a = [0, 0, 0, 0, 0, 0];
        let exp = 0;
        let tb = 0;
        let sev = -2;
        let read = false;
        for (let s = b; s < row.to; s += SLOT_MS) {
          const x = impact.slot(s, flow);
          if (!x) continue;
          read = true;
          for (let i = 0; i < 6; i++) a[i] += x.a[i];
          if (x.base != null) {
            exp += x.base * x.a[T];
            tb += x.a[T];
          }
          sev = Math.max(sev, x.sev);
        }
        if (!read) continue;
        const base = tb ? exp / tb : null;
        // A wider bucket is judged on its own totals, not its worst slot.
        if (bucketMin > SLOT_MIN && base != null && a[T] >= IMPACT.minTxns) {
          const drop = (base - a[S] / a[T]) * 100;
          sev = drop >= IMPACT.critPp ? 2 : drop >= IMPACT.warnPp ? 1 : 0;
        }
        row.flows[flow] = fmtFlowRow(a, base, { sev });
      }
      const missing = new Set();
      for (const c of cl)
        for (let s = b; s < row.to; s += SLOT_MS) {
          const p = state.provisional[`${c}|${s}`];
          if (p && p.a - (s + SLOT_MS) < SETTLE_MIN * 60000) row.unsettled = true;
          if (!(state.clusters[c]?.head > s) || !slotAgg(vs, s, [c], ACQ4)) missing.add(c);
        }
      row.missing = [...missing];
      buckets.push(row);
    }
    // Decline codes over the window: per slot from the kept raw rows (last ACQ_PROVISIONAL_HOURS); when any read
    // slot in the window is older than that, per hour from the day's hourly codes (all clusters, whole hours).
    let codes = {};
    let codesBasis = { kind: "slot", from, to: end };
    for (const c of cl)
      for (let s = from; s < end; s += SLOT_MS) {
        const p = state.provisional[`${c}|${s}`];
        if (!p) {
          if (slotAgg(vs, s, [c], ACQ4)) codesBasis = null;
          continue;
        }
        for (const r of p.r) {
          if (r.status !== "FAILURE" || !r.code || !RECENT_FLOWS.includes(r.flow)) continue;
          for (const f of [r.flow, ACQ4]) {
            const m = (codes[f] ||= {});
            m[r.code] = (m[r.code] || 0) + r.cnt;
          }
        }
      }
    if (!codesBasis) {
      codes = {};
      const h0 = Math.floor((from + TZ_OFFSET_MIN * 60000) / 3600000) * 3600000 - TZ_OFFSET_MIN * 60000;
      let h1 = h0;
      for (let ms = h0; ms < end; ms += 3600000) {
        h1 = ms + 3600000;
        const st = istStamp(ms);
        const hc = vs.days[st.slice(0, 10)]?.hcodes?.[st.slice(11, 13)];
        for (const [k, n] of Object.entries(hc || {})) {
          if (n <= 0) continue;
          const [flow, code] = k.split("|");
          for (const f of [flow, ACQ4]) {
            const m = (codes[f] ||= {});
            m[code] = (m[code] || 0) + n;
          }
        }
      }
      codesBasis = { kind: "hour", from: h0, to: h1 };
    }
    for (const f of Object.keys(codes))
      codes[f] = Object.entries(codes[f])
        .map(([code, cnt]) => ({ code, cnt }))
        .sort((a, b) => b.cnt - a.cnt)
        .slice(0, 40);
    return {
      ...empty,
      buckets: buckets.reverse(),
      incidents: incidentsOf(impact, flows, from, end, vs),
      codes,
      codesBasis,
      dataTo: end,
      heads: Object.fromEntries(cl.map((c) => [c, state.clusters[c]?.head || null])),
    };
  }

  /** History view: per day, a 10-min severity strip per flow and the merged SR-impact incidents. */
  const historyCache = new Map();
  function history({ days = 7, clusters } = {}) {
    const cl = clusters?.length ? clusters : Object.keys(CLUSTERS);
    const key = `${rev}|${archDays.size}|${days}|${cl.join(",")}`;
    if (historyCache.has(key)) return historyCache.get(key);
    const flows = [...RECENT_FLOWS, ACQ4];
    const vs = view();
    const impact = makeImpact(vs, cl);
    const list = allDays()
      .reverse()
      .slice(0, days)
      .map((d) => {
        const start = stampMs(`${d} 00:00:00`);
        const end = Math.min(start + 86400000, Math.max(...cl.map((c) => state.clusters[c]?.head || 0)));
        const strips = {};
        const totals = {};
        for (const flow of flows) {
          const strip = [];
          const a = [0, 0, 0, 0, 0, 0];
          for (let s = start; s < start + 86400000; s += SLOT_MS) {
            const x = s < end ? impact.slot(s, flow) : null;
            strip.push(x ? x.sev : null);
            if (x) for (let i = 0; i < 6; i++) a[i] += x.a[i];
          }
          strips[flow] = strip;
          totals[flow] = fmtFlowRow(a, null);
        }
        const incidents = incidentsOf(impact, flows, start, end, vs);
        return {
          day: d,
          strips,
          totals,
          incidents,
          critical: incidents.filter((i) => i.sev === 2).length,
          warning: incidents.filter((i) => i.sev === 1).length,
          // Minutes in which any of the four flows was impacted.
          impactedMin: strips[RECENT_FLOWS[0]].reduce((n, _, k) => n + (RECENT_FLOWS.some((f) => strips[f][k] >= 1) ? SLOT_MIN : 0), 0),
        };
      });
    const out = { at: Date.now(), days: list, flows, clusters: cl, impact: IMPACT, slotMin: SLOT_MIN };
    historyCache.clear();
    historyCache.set(key, out);
    return out;
  }

  // ── Daily SR pattern: SR by time of day (IST) per flow, each day as its own line, plus the min–max / median
  // band of the earlier days, the night-vs-day gap and today's buckets that sit below the band.
  // Only slots read on every selected cluster and already past their settle re-read count (no half-cluster or
  // still-pending bias).
  const PATTERN_FLOWS = [ACQ4, ...RECENT_FLOWS, "p2m_other", "p2p"];
  const NIGHT_HRS = [0, 5]; // 00:00–05:59
  const DAY_HRS = [7, 21]; // 07:00–21:59
  const patternCache = new Map();
  function pattern({ days = 7, bucketMin = 30, clusters } = {}) {
    const cl = clusters?.length ? clusters : Object.keys(CLUSTERS);
    const settledTo = Date.now() - (SETTLE_MIN + LAG_MIN + SLOT_MIN) * 60000;
    const key = `${rev}|${archDays.size}|${days}|${bucketMin}|${cl.join(",")}|${floorSlot(settledTo)}`;
    if (patternCache.has(key)) return patternCache.get(key);
    const nB = (24 * 60) / bucketMin;
    const per = bucketMin / SLOT_MIN;
    const dayList = allDays().slice(-days);
    const vs = view();
    const today = istStamp(Date.now()).slice(0, 10);
    const sr = (x) => (x && x.t ? (x.s / x.t) * 100 : null);
    const flows = {};
    for (const flow of PATTERN_FLOWS) {
      const lines = {};
      const hours = { night: { t: 0, s: 0 }, day: { t: 0, s: 0 } };
      for (const d of dayList) {
        const start = stampMs(`${d} 00:00:00`);
        const line = [];
        for (let b = 0; b < nB; b++) {
          const x = { t: 0, s: 0, f: 0, u09: 0, slots: 0 };
          for (let k = 0; k < per; k++) {
            const ms = start + (b * per + k) * SLOT_MS;
            if (ms + SLOT_MS > settledTo) continue;
            const a = slotAgg(vs, ms, cl, flow);
            if (!a || a.read !== cl.length) continue;
            x.t += a[T];
            x.s += a[S];
            x.f += a[F];
            x.u09 += a[U09];
            x.slots += 1;
            const h = Number(istStamp(ms).slice(11, 13));
            const part = h >= NIGHT_HRS[0] && h <= NIGHT_HRS[1] ? hours.night : h >= DAY_HRS[0] && h <= DAY_HRS[1] ? hours.day : null;
            if (part) {
              part.t += a[T];
              part.s += a[S];
            }
          }
          line.push(x.slots ? { t: x.t, s: x.s, f: x.f, u09: x.u09, sr: sr(x), full: x.slots === per } : null);
        }
        lines[d] = line;
      }
      // Band from the earlier days (today excluded), full buckets only.
      const band = Array.from({ length: nB }, (_, b) => {
        const v = dayList.filter((d) => d !== today && lines[d][b]?.full && lines[d][b].t >= IMPACT.minTxns).map((d) => lines[d][b].sr);
        return v.length ? { min: Math.min(...v), max: Math.max(...v), med: median(v), n: v.length } : null;
      });
      // Typical shape: volume-weighted SR per bucket over all days → lowest / highest SR time.
      const shape = Array.from({ length: nB }, (_, b) => {
        let t = 0;
        let sOk = 0;
        for (const d of dayList) if (lines[d][b]) ((t += lines[d][b].t), (sOk += lines[d][b].s));
        return t ? { sr: (sOk / t) * 100, t } : null;
      });
      const ranked = shape.map((x, b) => (x && x.t >= IMPACT.minTxns * dayList.length ? { b, ...x } : null)).filter(Boolean);
      ranked.sort((a, b) => a.sr - b.sr);
      const below = (lines[today] || [])
        .map((x, b) =>
          x && band[b] && x.t >= IMPACT.minTxns && x.sr < band[b].med - IMPACT.warnPp
            ? { b, sr: x.sr, med: band[b].med, gap: band[b].med - x.sr, sev: band[b].med - x.sr >= IMPACT.critPp ? 2 : 1 }
            : null,
        )
        .filter(Boolean);
      const nightSr = sr(hours.night);
      const daySr = sr(hours.day);
      flows[flow] = {
        lines,
        band,
        below,
        summary: {
          nightSr,
          daySr,
          dipPp: nightSr != null && daySr != null ? daySr - nightSr : null,
          lowest: ranked[0] ? { b: ranked[0].b, sr: ranked[0].sr } : null,
          highest: ranked.at(-1) ? { b: ranked.at(-1).b, sr: ranked.at(-1).sr } : null,
          peakVol: shape.reduce((best, x, b) => (x && (!best || x.t > best.t) ? { b, t: x.t } : best), null),
          txns: hours.night.t + hours.day.t,
        },
      };
    }
    const out = {
      at: Date.now(),
      bucketMin,
      clusters: cl,
      days: dayList,
      today,
      settledTo,
      flows,
      hours: { night: NIGHT_HRS, day: DAY_HRS },
      impact: IMPACT,
      bandDays: dayList.filter((d) => d !== today).length,
    };
    patternCache.clear();
    patternCache.set(key, out);
    return out;
  }

  // One-time move from the single acq-daily.json to per-day files. The old file is kept (renamed), never deleted,
  // and only after every day and the rest of the state read back identical from the new files.
  if (migrate) {
    const before = { ...state, days: undefined };
    const dayJson = Object.fromEntries(Object.keys(state.days).map((d) => [d, JSON.stringify(state.days[d])]));
    for (const d of Object.keys(state.days)) dirtyDays.add(d);
    save(true);
    const back = readSplit();
    const bad = Object.keys(dayJson).filter((d) => JSON.stringify(back.days[d] ?? (archDays.has(d) ? loadArch(d) : null)) !== dayJson[d]);
    const restOk = JSON.stringify({ ...back, days: undefined, v: 3 }) === JSON.stringify({ ...before, v: 3 });
    if (bad.length || !restOk) {
      console.error(`[acq] migration check failed (days ${bad.join(", ") || "ok"}, state ${restOk ? "ok" : "differs"}) — keeping ${LEGACY_FILE}`);
      fs.rmSync(STATE_FILE, { force: true });
    } else {
      fs.renameSync(LEGACY_FILE, path.join(dataDir, `acq-daily.migrated-${istDay()}.json`));
      console.log(`[acq] moved ${Object.keys(dayJson).length} days to ${DIR}`);
    }
  }

  return { start, inNight, setNightPlan, setTricklePlan, addJob, run, stop, retryNow, setPaused, isHeld, statusSnapshot, snapshot, recent, history, pattern, readRuns, scheduler };
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason || new Error("aborted"));
      },
      { once: true },
    );
  });
}
