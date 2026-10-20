// Breakdown math — pure functions shared by the browser (breakdown-table.jsx,
// sr-shared.jsx) and the backend (unifiedDashboard.js computes alerts
// for History / Slack with the exact same rules). No imports, no JSX.
//
// Input rows: { ts, handle?, kind, dim, code, descr?, total, success }
//   kind = psp | bank | instrument | flow | …  → code === "" is a day total for (ts, kind, dim),
//                                                code !== "" is failures by response code
//   kind = "code"                              → day-level failures per code (dim = code, descr = NPCI text)
//
// Per row, relative to Y (latest complete day):
//   SR now        = SR on Y
//   D-1/D-2/D-3   = Y-1..Y-3, with Δ = now − that day (pp for SR, % for counts)
//   LW            = same weekday last week (Y-7)
//   Δ SR vs avg   = SR now − SR over L7D (Y-7..Y-1)
//   Vol Δ vs avg  = Y volume vs L7D daily average, %
//   Lost txns     = max(0, SR_L7D − SR now) × Y volume
//   Impact (pp)   = Y volume × (SR now − SR_L7D) / total Y volume
//   ΔSR overall   = Σ impact (rate effect) + mix effect (volume shifted between rows)

export const ALERT_RULES = [
  { level: "CRIT", dsr: -3, impact: -0.3 },
  { level: "WARN", dsr: -1, impact: -0.1 },
];

const DAY = 86400000;
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const sub = (a, b) => (a != null && b != null ? a - b : null);
const chg = (a, b) => (a != null && b > 0 ? ((a - b) * 100) / b : null);
const z = () => ({ total: 0, success: 0 });

export function alertOf(dsr, impact) {
  if (dsr == null || impact == null) return null;
  return ALERT_RULES.find((r) => dsr <= r.dsr && impact <= r.impact)?.level || null;
}

const metricOf = (m, x) => {
  if (!x || !x.total) return m === "sr" ? null : 0;
  if (m === "sr") return pct(x.success, x.total);
  if (m === "success") return x.success;
  if (m === "failure") return x.total - x.success;
  return x.total;
};

/**
 * Latest complete day: the newest day whose total volume is at least `minRatio` of the
 * median of the 7 days before it. Guards against a day-level table that is still
 * loading yesterday when an early-morning run fires. Falls back to the newest day.
 */
export function pickYday(rows, { kind, minRatio = 0.7 } = {}) {
  const byDay = {};
  const k = kind || rows.find((r) => r.kind && r.kind !== "code")?.kind;
  for (const r of rows) {
    if (r.code || (k && r.kind !== k)) continue;
    byDay[r.ts] = (byDay[r.ts] || 0) + r.total;
  }
  const days = Object.keys(byDay).sort();
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const prev = days.slice(Math.max(0, i - 7), i).map((d) => byDay[d]).sort((a, b) => a - b);
    if (prev.length < 3) return days[i];
    const median = prev[Math.floor(prev.length / 2)];
    if (byDay[days[i]] >= minRatio * median) return days[i];
  }
  return days[days.length - 1] || null;
}

/** Per-dim rows for one kind. Returns { rows, overall, days }. */
export function buildBreakdown(allRows, { kind, handleSel = "all", yday, metric = "sr" }) {
  const days = { now: yday, d1: addDays(yday, -1), d2: addDays(yday, -2), d3: addDays(yday, -3), lw: addDays(yday, -7) };
  const l7From = addDays(yday, -7);
  const l7To = addDays(yday, -1);
  // Y-9..Y, oldest first: x-axis for per-code trend lines.
  days.trend = Array.from({ length: 10 }, (_, i) => addDays(yday, i - 9));

  const dims = {};
  const codes = {};
  const codesD1 = {};
  const codeByDay = {}; // dim → code → ts → failures (every day in the cache, for trend lines)
  const all = { byDay: {}, l7: z() };
  const get = (dim) => (dims[dim] ||= { byDay: {}, l7: z() });
  const bump = (o, ts, r) => {
    const d = (o.byDay[ts] ||= z());
    d.total += r.total;
    d.success += r.success;
    if (ts >= l7From && ts <= l7To) {
      o.l7.total += r.total;
      o.l7.success += r.success;
    }
  };

  for (const r of allRows) {
    if (r.kind !== kind) continue;
    if (handleSel !== "all" && r.handle !== handleSel) continue;
    if (r.code) {
      const f = r.total - r.success;
      for (const d of [r.dim, "Overall"]) {
        const m = ((codeByDay[d] ||= {})[r.code] ||= {});
        m[r.ts] = (m[r.ts] || 0) + f;
      }
      const bucket = r.ts === yday ? codes : r.ts === days.d1 ? codesD1 : null;
      if (bucket) {
        const m = (bucket[r.dim] ||= {});
        m[r.code] = (m[r.code] || 0) + f;
      }
      continue;
    }
    bump(get(r.dim), r.ts, r);
    bump(all, r.ts, r);
  }

  const totalNow = all.byDay[yday]?.total || 0;
  const srAllNow = pct(all.byDay[yday]?.success || 0, totalNow);
  const srAllL7 = pct(all.l7.success, all.l7.total);

  const toRow = (dim, o, isOverall) => {
    const now = o.byDay[yday] || z();
    const srNow = pct(now.success, now.total);
    const srL7 = pct(o.l7.success, o.l7.total);
    const dsr = sub(srNow, srL7);
    const volAvg = o.l7.total / 7;
    const impact = isOverall ? dsr : srNow != null && srL7 != null && totalNow > 0 ? (now.total * (srNow - srL7)) / totalNow : null;
    const lost = srNow != null && srL7 != null ? Math.max(0, ((srL7 - srNow) / 100) * now.total) : null;
    const v = (d) => metricOf(metric, o.byDay[d]);
    const vNow = v(days.now);
    const dlt = (past) => (metric === "sr" ? sub(vNow, past) : chg(vNow, past));
    const avg = metric === "sr" ? srL7 : metricOf(metric, o.l7) / 7;
    const codeFails = codes[dim] || {};
    const top = Object.entries(codeFails)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return {
      dim,
      vol: now.total,
      srNow,
      srL7,
      failures: now.total - now.success,
      now: vNow,
      d1: v(days.d1),
      d2: v(days.d2),
      d3: v(days.d3),
      lw: v(days.lw),
      d1Δ: dlt(v(days.d1)),
      d2Δ: dlt(v(days.d2)),
      d3Δ: dlt(v(days.d3)),
      lwΔ: dlt(v(days.lw)),
      vsAvg: dlt(avg),
      dsr,
      volΔ: chg(now.total, volAvg),
      lost,
      impact,
      top,
      codeFails,
      codeFailsD1: codesD1[dim] || {},
      codeByDay: codeByDay[dim] || {},
      totalByDay: Object.fromEntries(Object.entries(o.byDay).map(([d, x]) => [d, x.total])),
      alert: isOverall ? null : alertOf(dsr, impact),
    };
  };

  const rows = Object.keys(dims)
    .filter((d) => (dims[d].byDay[yday]?.total || 0) > 0 || dims[d].l7.total > 0)
    .map((d) => toRow(d, dims[d], false));
  const overall = toRow("Overall", all, true);
  const rate = rows.reduce((s, r) => s + (r.impact || 0), 0);
  overall.lost = rows.reduce((s, r) => s + (r.lost || 0), 0);
  const allCodes = {};
  for (const m of Object.values(codes)) for (const [c, n] of Object.entries(m)) allCodes[c] = (allCodes[c] || 0) + n;
  overall.codeFails = allCodes;
  overall.top = Object.entries(allCodes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  overall.rate = rate;
  overall.mix = srAllNow != null && srAllL7 != null ? srAllNow - srAllL7 - rate : null;
  return { rows, overall, days };
}

/**
 * Decline-code table from kind = "code" rows. amounts: optional { [code]: ₹ } for Y.
 * Returns { rows, total, days } — counts per day, Δ % now vs each day, share of Y failures.
 */
export function buildDeclines(allRows, { yday, amounts = null }) {
  const days = { now: yday, d1: addDays(yday, -1), d2: addDays(yday, -2), d3: addDays(yday, -3), lw: addDays(yday, -7) };
  const l7From = addDays(yday, -7);
  const l7To = addDays(yday, -1);
  const codes = {};
  const tot = { byDay: {}, l7: 0 };
  for (const r of allRows) {
    if (r.kind !== "code") continue;
    const f = r.total - r.success;
    if (f <= 0) continue;
    const o = (codes[r.dim] ||= { byDay: {}, l7: 0, descr: "" });
    if (r.descr && !o.descr) o.descr = r.descr;
    o.byDay[r.ts] = (o.byDay[r.ts] || 0) + f;
    tot.byDay[r.ts] = (tot.byDay[r.ts] || 0) + f;
    if (r.ts >= l7From && r.ts <= l7To) {
      o.l7 += f;
      tot.l7 += f;
    }
  }
  const totNow = tot.byDay[yday] || 0;
  const toRow = (code, o) => {
    const v = (d) => o.byDay[d] || 0;
    const now = v(days.now);
    return {
      code,
      descr: o.descr || "",
      now,
      share: pct(now, totNow),
      amount: amounts ? amounts[code] ?? null : null,
      d1: v(days.d1),
      d2: v(days.d2),
      d3: v(days.d3),
      lw: v(days.lw),
      d1Δ: chg(now, v(days.d1)),
      d2Δ: chg(now, v(days.d2)),
      d3Δ: chg(now, v(days.d3)),
      lwΔ: chg(now, v(days.lw)),
      l7avg: o.l7 / 7,
      vsAvg: chg(now, o.l7 / 7),
      excess: now - o.l7 / 7,
    };
  };
  const rows = Object.entries(codes)
    .map(([c, o]) => toRow(c, o))
    .filter((r) => r.now > 0 || r.l7avg >= 1);
  const total = toRow("All failures", tot);
  total.share = totNow ? 100 : null;
  total.amount = amounts ? Object.values(amounts).reduce((s, x) => s + (x || 0), 0) : null;
  return { rows, total, days };
}

/**
 * Every WARN / CRIT row across kinds — what the backend stores and pushes.
 * Carries enough context for a self-contained escalation note: SR trend (D-1..D-3, LW),
 * top codes with NPCI description, share of the row's failures and the D-1 count.
 */
export function computeAlerts(allRows, { kinds, yday }) {
  const descr = {};
  for (const r of allRows) if (r.kind === "code" && r.descr && !descr[r.dim]) descr[r.dim] = r.descr;
  const out = [];
  for (const kind of kinds) {
    const { rows, overall } = buildBreakdown(allRows, { kind, yday });
    for (const r of rows) {
      if (!r.alert) continue;
      const codes = Object.entries(r.codeFails)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([code, n]) => ({ code, n, d1: r.codeFailsD1[code] ?? null, share: r.failures > 0 ? (n * 100) / r.failures : null, descr: descr[code] || "" }));
      out.push({
        kind,
        dim: r.dim,
        level: r.alert,
        srNow: r.srNow,
        srL7: r.srL7,
        dsr: r.dsr,
        impact: r.impact,
        lost: r.lost,
        vol: r.vol,
        failures: r.failures,
        trend: { d1: r.d1, d2: r.d2, d3: r.d3, lw: r.lw },
        overallSrNow: overall.srNow,
        top: r.top,
        codes,
      });
    }
  }
  return out.sort((a, b) => a.impact - b.impact);
}
