// Payer (remitter) bank health for the Unified SR Dashboard — pure functions shared by the page
// (F · Bank report) and backend scripts. No JSX, no fetch.
//
// Contribution splits the overall SR change across banks exactly (shift-share):
//   c_i = w_now · SR_now − w_base · SR_base   (w = share of attempts, SR in %)  → Σ c_i = ΔSR overall.
//
// Health v2 (v1 = the plain thresholds, kept for comparison):
//   significance  z = ΔSR / σ, σ = the bank's own day-to-day SR spread over the 30 days before the
//                 compared period (÷ √days for multi-day periods), floor 0.05pp. Watch / Critical
//                 need z ≤ −2, Improving z ≥ +2 — small banks' normal noise no longer tags them.
//   Critical      (contribution ≤ −0.03pp, or ΔSR ≤ −1pp on ≥ 1% of txns) and significant — and, when
//                 comparing yesterday, also critical-worthy the day before (2 days in a row) unless the
//                 one-day hit is ≥ 0.10pp of overall SR. A first-day critical shows as Watch ("day 1").
//   Watch         (contribution ≤ −0.01pp, or ΔSR ≤ −0.5pp) and significant.
//   Improving     contribution ≥ +0.01pp and z ≥ +2.

const DAY = 86400000;
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const inRange = (ts, [a, b]) => ts >= a && ts <= b;
export const nDays = ([a, b]) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;

export const SIGMA_FLOOR = 0.05;
export const Z_BAR = 2;
export const ONE_DAY_CRIT = -0.1;

/** groups: { key → { now: {t,s}, base: {t,s} } } → rows with SR, ΔSR, share and contribution (pp). */
export function contribution(groups) {
  const T = Object.values(groups).reduce((a, g) => ({ now: a.now + g.now.t, base: a.base + g.base.t }), { now: 0, base: 0 });
  return Object.entries(groups).map(([k, g]) => {
    const srNow = pct(g.now.s, g.now.t);
    const srBase = pct(g.base.s, g.base.t);
    const wNow = T.now ? g.now.t / T.now : 0;
    const wBase = T.base ? g.base.t / T.base : 0;
    return {
      _key: k,
      k,
      tNow: g.now.t,
      tBase: g.base.t,
      fNow: g.now.t - g.now.s,
      srNow,
      srBase,
      dsr: srNow != null && srBase != null ? srNow - srBase : null,
      share: wNow * 100,
      contrib: wNow * (srNow ?? 0) - wBase * (srBase ?? 0),
    };
  });
}

export function bump(m, k, which, r) {
  const g = (m[k] ||= { now: { t: 0, s: 0 }, base: { t: 0, s: 0 } });
  g[which].t += r.total;
  g[which].s += r.success;
}

/** Plain scorecard rows for one window { now: [a, b], base: [a, b] }. rows: { ts, bank, total, success }. */
export function scoreWindow(rows, win) {
  const g = {};
  for (const r of rows) {
    if (inRange(r.ts, win.now)) bump(g, r.bank, "now", r);
    if (inRange(r.ts, win.base)) bump(g, r.bank, "base", r);
  }
  return contribution(g);
}

export const healthV1 = (r) =>
  r.contrib <= -0.03 || (r.dsr != null && r.dsr <= -1 && r.share >= 1) ? "critical" : r.contrib <= -0.01 || (r.dsr != null && r.dsr <= -0.5) ? "watch" : r.contrib >= 0.01 ? "improving" : "stable";

const critWorthy = (r) => r.contrib <= -0.03 || (r.dsr != null && r.dsr <= -1 && r.share >= 1);
const watchWorthy = (r) => r.contrib <= -0.01 || (r.dsr != null && r.dsr <= -0.5);

/** Daily SR per bank: { bank → { day → SR } }. */
function dailySr(rows) {
  const m = {};
  for (const r of rows) {
    const d = ((m[r.bank] ||= {})[r.ts] ||= { t: 0, s: 0 });
    d.t += r.total;
    d.s += r.success;
  }
  return Object.fromEntries(Object.entries(m).map(([b, days]) => [b, Object.fromEntries(Object.entries(days).map(([d, x]) => [d, pct(x.s, x.t)]))]));
}

function sigmaOf(series, before, days = 30) {
  const vals = [];
  for (let i = 1; i <= days; i += 1) {
    const v = series?.[addDays(before, -i)];
    if (v != null) vals.push(v);
  }
  if (vals.length < 5) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1));
}

const l7Win = (day) => ({ now: [day, day], base: [addDays(day, -7), addDays(day, -1)] });

/**
 * Health v2 for every bank in `win`. compare: "yday" (one day vs the 7 days before) or "mtd".
 * Returns rows with { health, healthV1, sigma, z, streak, day1 }.
 */
export function bankHealth(rows, win, { compare = "yday" } = {}) {
  const list = scoreWindow(rows, win);
  const series = dailySr(rows);
  const span = nDays(win.now);
  // Critical-worthy (and watch-worthy) per bank on each of the 14 days before, for persistence and streaks.
  const prevDays = compare === "yday" ? Array.from({ length: 14 }, (_, i) => addDays(win.now[0], -(i + 1))) : [];
  const past = prevDays.map((d) => {
    const sc = Object.fromEntries(scoreWindow(rows, l7Win(d)).map((r) => [r.k, r]));
    return { d, sc };
  });
  const sig = (b, r, day) => {
    const s = sigmaOf(series[b], day);
    const sigma = s == null ? null : Math.max(SIGMA_FLOOR, s / Math.sqrt(span));
    return { sigma, z: sigma && r.dsr != null ? r.dsr / sigma : null };
  };
  return list.map((r) => {
    const { sigma, z } = sig(r.k, r, win.now[0]);
    const significant = z == null ? true : z <= -Z_BAR; // too little history: fall back to thresholds
    let health = "stable";
    let day1 = false;
    if (critWorthy(r) && significant) {
      if (compare !== "yday") health = "critical";
      else {
        const prev = past[0]?.sc[r.k];
        const prevSig = prev ? sig(r.k, prev, past[0].d) : { z: null };
        const prevCrit = prev && critWorthy(prev) && (prevSig.z == null || prevSig.z <= -Z_BAR);
        if (prevCrit || r.contrib <= ONE_DAY_CRIT) health = "critical";
        else {
          health = "watch";
          day1 = true;
        }
      }
    } else if (watchWorthy(r) && significant) health = "watch";
    else if (r.contrib >= 0.01 && (z == null || z >= Z_BAR)) health = "improving";
    // Streak: consecutive days (ending at the compared day) the bank was watch-worthy and significant.
    let streak = 0;
    if (health === "watch" || health === "critical") {
      streak = 1;
      for (const p of past) {
        const x = p.sc[r.k];
        if (!x || !watchWorthy(x)) break;
        const s = sig(r.k, x, p.d);
        if (s.z != null && s.z > -Z_BAR) break;
        streak += 1;
      }
    }
    return { ...r, health, healthV1: healthV1(r), sigma, z, streak, day1 };
  });
}
