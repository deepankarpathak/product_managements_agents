// History insights — turn a dashboard section's raw result rows into the narrative
// fields stored with each History entry: summary, what stands out, action required,
// next steps, plus a few compact output tables.
//
// Rule-based (no LLM): runs on every scheduled refresh, so it must be instant and
// free. Thresholds are deliberately simple and stated in the text so a reader can
// judge them.

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const f2 = (v) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(2)}%`);
const pp = (v) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)} pp`);
const int = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);

/** Group rows → { name: { t, s, byTs: Map(ts → {t, s}) } } plus sorted bucket list. */
function groupSr(rows, nameOf, { total = "total", success = "success" } = {}) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const groups = new Map();
  for (const r of rows) {
    const name = nameOf(r);
    if (name == null) continue;
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { name, t: 0, s: 0, byTs: new Map() }));
    const t = Number(r[total]) || 0;
    const s = Number(r[success]) || 0;
    g.t += t;
    g.s += s;
    const p = g.byTs.get(r.ts) || { t: 0, s: 0 };
    p.t += t;
    p.s += s;
    g.byTs.set(r.ts, p);
  }
  return { buckets, groups: [...groups.values()].sort((a, b) => b.t - a.t) };
}

/** Latest bucket vs previous bucket and vs whole-window SR for one group. */
function srMoves(g, buckets) {
  const at = (ts) => {
    const p = g.byTs.get(ts);
    return p && p.t ? pct(p.s, p.t) : null;
  };
  const last = buckets[buckets.length - 1];
  const prev = buckets[buckets.length - 2];
  const latest = at(last);
  const previous = at(prev);
  const window = pct(g.s, g.t);
  let worst = null;
  for (const ts of buckets) {
    const v = at(ts);
    if (v != null && (worst == null || v < worst.v)) worst = { ts, v };
  }
  return { latest, previous, window, vsPrev: latest != null && previous != null ? latest - previous : null, vsWindow: latest != null && window != null ? latest - window : null, worst };
}

/**
 * Generic "success rate by group" analysis (handles, banks, PSPs, instruments, flows).
 * dropPp: a group whose latest-period SR is this far below its previous period is flagged.
 */
function srByGroup({ label, unit, rows, nameOf, minShare = 0.005, dropPp = 1, topRows = 15 }) {
  const { buckets, groups } = groupSr(rows, nameOf);
  const allT = groups.reduce((a, g) => a + g.t, 0);
  const allS = groups.reduce((a, g) => a + g.s, 0);
  const overall = { name: "ALL", t: allT, s: allS, byTs: new Map() };
  for (const g of groups) for (const [ts, p] of g.byTs) {
    const o = overall.byTs.get(ts) || { t: 0, s: 0 };
    o.t += p.t;
    o.s += p.s;
    overall.byTs.set(ts, o);
  }
  const ov = srMoves(overall, buckets);
  const big = groups.filter((g) => g.t >= allT * minShare).map((g) => ({ g, m: srMoves(g, buckets) }));
  const drops = big.filter((x) => x.m.vsPrev != null && x.m.vsPrev <= -dropPp).sort((a, b) => a.m.vsPrev - b.m.vsPrev);
  const gains = big.filter((x) => x.m.vsPrev != null && x.m.vsPrev >= dropPp).sort((a, b) => b.m.vsPrev - a.m.vsPrev);
  const lowest = [...big].filter((x) => x.m.window != null).sort((a, b) => a.m.window - b.m.window).slice(0, 3);
  const last = buckets[buckets.length - 1];
  const prev = buckets[buckets.length - 2];

  const standouts = [];
  if (ov.window != null) standouts.push(`Overall SR ${f2(ov.window)} across ${int(allT)} txns; latest ${unit} (${last}) ${f2(ov.latest)} (${pp(ov.vsPrev)} vs previous ${unit}).`);
  if (ov.worst && buckets.length > 2) standouts.push(`Lowest overall point: ${f2(ov.worst.v)} at ${ov.worst.ts}.`);
  if (lowest.length) standouts.push(`Lowest-SR ${label}s${minShare > 0 ? ` (≥${(minShare * 100).toFixed(1)}% volume)` : ""}: ${lowest.map((x) => `${x.g.name} ${f2(x.m.window)}`).join(", ")}.`);
  if (drops.length) standouts.push(`Fell ≥${dropPp} pp vs previous ${unit}: ${drops.slice(0, 5).map((x) => `${x.g.name} ${pp(x.m.vsPrev)}`).join(", ")}.`);
  if (gains.length) standouts.push(`Improved ≥${dropPp} pp: ${gains.slice(0, 5).map((x) => `${x.g.name} ${pp(x.m.vsPrev)}`).join(", ")}.`);

  const actions = drops.length
    ? drops.slice(0, 5).map((x) => `Check ${x.g.name}: SR ${f2(x.m.previous)} → ${f2(x.m.latest)} (${pp(x.m.vsPrev)}) on ${int(x.g.byTs.get(last)?.t)} txns.`)
    : [];
  const nextSteps = drops.length
    ? [`Break the flagged ${label}s down by error code (Error sections) for ${last}.`, `Re-run after the next refresh to see whether the drop persists.`]
    : [`No ${label} fell ≥${dropPp} pp vs the previous ${unit}; keep monitoring on the normal schedule.`];

  const table = {
    title: `SR by ${label} (top ${Math.min(topRows, big.length)} by volume)`,
    columns: [label, "Txns", "SR (window)", `SR latest ${unit}`, `Δ vs prev ${unit}`],
    rows: big.slice(0, topRows).map((x) => [x.g.name, int(x.g.t), f2(x.m.window), f2(x.m.latest), pp(x.m.vsPrev)]),
  };
  const trend = {
    title: `Overall SR per ${unit}`,
    columns: [unit, "Txns", "SR"],
    rows: buckets.slice(-12).map((ts) => {
      const p = overall.byTs.get(ts);
      return [ts, int(p.t), f2(pct(p.s, p.t))];
    }),
  };
  return {
    summary: `${label[0].toUpperCase()}${label.slice(1)}-wise success rate over ${buckets.length} ${unit}s (${buckets[0] || "—"} → ${last || "—"}): overall ${f2(ov.window)}, latest ${f2(ov.latest)}; ${drops.length} ${label}(s) fell ≥${dropPp} pp${prev ? ` vs ${prev}` : ""}.`,
    standouts,
    actions,
    nextSteps,
    tables: [table, trend],
  };
}

/** Error-code share analysis. rows: { ts, code, cnt }, where code "__NONFAIL__" = non-failures. */
function codeShare({ rows, topN = 10, riseThresholdPp = 0.05, label = "error code" }) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const mid = Math.floor(buckets.length / 2);
  const early = new Set(buckets.slice(0, mid));
  const total = { all: 0, early: 0, recent: 0 };
  const codes = new Map();
  for (const r of rows) {
    const n = Number(r.cnt) || 0;
    const isEarly = early.has(r.ts);
    total.all += n;
    total[isEarly ? "early" : "recent"] += n;
    if (r.code === "__NONFAIL__") continue;
    const c = codes.get(r.code) || { code: r.code, n: 0, e: 0, r: 0 };
    c.n += n;
    c[isEarly ? "e" : "r"] += n;
    codes.set(r.code, c);
  }
  const list = [...codes.values()].sort((a, b) => b.n - a.n);
  const fails = list.reduce((a, c) => a + c.n, 0);
  const top = list.slice(0, topN).map((c) => {
    const se = pct(c.e, total.early);
    const sr = pct(c.r, total.recent);
    return { ...c, share: pct(c.n, total.all), se, sr, d: se != null && sr != null ? sr - se : null };
  });
  const rising = top.filter((c) => c.d != null && c.d >= riseThresholdPp).sort((a, b) => b.d - a.d);
  const falling = top.filter((c) => c.d != null && c.d <= -riseThresholdPp).sort((a, b) => a.d - b.d);

  const standouts = [
    `${int(fails)} non-successful txns of ${int(total.all)} (${f2(pct(fails, total.all))}) across ${buckets.length} periods (${buckets[0] || "—"} → ${buckets[buckets.length - 1] || "—"}).`,
  ];
  if (top.length) standouts.push(`Top ${label}s: ${top.slice(0, 5).map((c) => `${c.code} ${f2(c.share)}`).join(", ")}.`);
  if (rising.length) standouts.push(`Rising (recent half vs earlier half, ≥${riseThresholdPp} pp of txns): ${rising.slice(0, 5).map((c) => `${c.code} ${pp(c.d)}`).join(", ")}.`);
  if (falling.length) standouts.push(`Falling: ${falling.slice(0, 5).map((c) => `${c.code} ${pp(c.d)}`).join(", ")}.`);
  return {
    summary: `Top ${top.length} ${label}s; ${rising.length} rising and ${falling.length} falling (recent half vs earlier half of the window).`,
    standouts,
    actions: rising.slice(0, 5).map((c) => `Investigate ${c.code}: share ${f2(c.se)} → ${f2(c.sr)} of txns (${pp(c.d)}).`),
    nextSteps: rising.length
      ? ["Split the rising codes by payer handle / remitter bank to find where they concentrate.", "Check bank / NPCI incident channels for the same window."]
      : ["No error code rose meaningfully; no action needed beyond normal monitoring."],
    tables: [
      {
        title: `Top ${top.length} ${label}s`,
        columns: ["Code", "Count", "% of txns", "Earlier half", "Recent half", "Δ"],
        rows: top.map((c) => [c.code, int(c.n), f2(c.share), f2(c.se), f2(c.sr), pp(c.d)]),
      },
    ],
  };
}

// ─── Per-section analyzers ───────────────────────────────────────────────────

const unitOf = (bucketMin) => (bucketMin >= 1440 ? "day" : "period");

const MORNING = {
  sr: (rows, ctx) => {
    const byHandle = srByGroup({ label: "payer handle", unit: unitOf(ctx.bucketMin), rows, nameOf: (r) => r.handle, minShare: 0 });
    const byFlow = srByGroup({ label: "flow", unit: unitOf(ctx.bucketMin), rows, nameOf: (r) => r.flow, minShare: 0 });
    return { ...byHandle, standouts: [...byHandle.standouts, ...byFlow.standouts.slice(2)], tables: [byHandle.tables[0], byFlow.tables[0], byHandle.tables[1]] };
  },
  errors: (rows, ctx) => codeShare({ rows, topN: 10, label: `${ctx.errorColumn || "error"} code` }),
  u09: (rows) => {
    const buckets = [...new Set(rows.map((r) => r.ts))].sort();
    const per = buckets.map((ts) => {
      const rs = rows.filter((r) => r.ts === ts);
      return { ts, t: sum(rs, "total"), u: sum(rs, "u09") };
    });
    const t = sum(per, "t");
    const u = sum(per, "u");
    const rates = per.map((p) => pct(p.u, p.t)).filter((v) => v != null).sort((a, b) => a - b);
    const median = rates.length ? rates[Math.floor(rates.length / 2)] : null;
    const peak = per.reduce((m, p) => (pct(p.u, p.t) > (m ? pct(m.u, m.t) : -1) ? p : m), null);
    const spikes = per.filter((p) => median && pct(p.u, p.t) >= median * 3 && p.u >= 50);
    return {
      summary: `U09 ${int(u)} of ${int(t)} txns (${pct(u, t)?.toFixed(3) ?? "—"}%); ${spikes.length} spike period(s) ≥3× the median rate.`,
      standouts: [
        `Median U09 rate ${median?.toFixed(3) ?? "—"}% per period.`,
        peak ? `Peak ${pct(peak.u, peak.t).toFixed(3)}% (${int(peak.u)} txns) at ${peak.ts}.` : "No U09 in window.",
      ],
      actions: spikes.slice(0, 5).map((p) => `U09 spike at ${p.ts}: ${int(p.u)} txns (${pct(p.u, p.t).toFixed(3)}%, ${(pct(p.u, p.t) / median).toFixed(1)}× median).`),
      nextSteps: spikes.length ? ["Check which payer handle / remitter bank drove the spike (Split by handle in the U09 card)."] : ["No U09 spike; normal monitoring."],
      tables: [{ title: "U09 per period (latest 12)", columns: ["Period", "Txns", "U09", "U09 %"], rows: per.slice(-12).map((p) => [p.ts, int(p.t), int(p.u), `${pct(p.u, p.t)?.toFixed(3) ?? "—"}%`]) }],
    };
  },
  bank: (rows, ctx) => srByGroup({ label: "remitter bank", unit: unitOf(ctx.bucketMin), rows, nameOf: (r) => r.bank, minShare: 0.005 }),
  share: (rows) => {
    const days = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const cols = [...new Set(days.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ts" && days.some((r) => Number(r[c]) > 0));
    const tot = (r) => cols.reduce((a, c) => a + (Number(r[c]) || 0), 0);
    const last = days[days.length - 1];
    const prev = days[days.length - 2];
    const moves = last && prev ? cols.map((c) => ({ c, now: pct(Number(last[c]) || 0, tot(last)), d: pct(Number(last[c]) || 0, tot(last)) - pct(Number(prev[c]) || 0, tot(prev)) })) : [];
    const big = moves.filter((m) => Math.abs(m.d) >= 0.5);
    return {
      summary: last ? `Latest day ${last.ts}: ${int(tot(last))} txns; ${cols.map((c) => `${c.toUpperCase()} ${f2(pct(Number(last[c]) || 0, tot(last)))}`).join(", ")}.` : "No data.",
      standouts: [
        ...(prev ? [`Total txns DoD: ${pp(pct(tot(last) - tot(prev), tot(prev)))?.replace(" pp", "%")}.`] : []),
        ...moves.map((m) => `${m.c.toUpperCase()} share ${f2(m.now)} (${pp(m.d)} DoD).`),
      ],
      actions: big.map((m) => `${m.c.toUpperCase()} share moved ${pp(m.d)} day-on-day — check for a routing / outage change.`),
      nextSteps: big.length ? ["Compare with the Success Rate section for the same handle and day."] : ["Shares stable (<0.5 pp DoD); no action."],
      tables: [{ title: "Txns per handle per day", columns: ["Day", "Total", ...cols.map((c) => c.toUpperCase())], rows: days.map((r) => [r.ts, int(tot(r)), ...cols.map((c) => `${int(r[c])} (${f2(pct(Number(r[c]) || 0, tot(r)))})`)]) }],
    };
  },
  flowsr: (rows) => srByGroup({ label: "flow", unit: "day", rows, nameOf: (r) => r.flow, minShare: 0, dropPp: 0.5 }),
  instrument: (rows) => srByGroup({ label: "flow · instrument", unit: "day", rows, nameOf: (r) => `${r.flow} · ${r.instrument}`, minShare: 0.002 }),
  psp: (rows) => srByGroup({ label: "payee PSP", unit: "day", rows, nameOf: (r) => r.psp, minShare: 0.002 }),
  payerbank: (rows, ctx) => srByGroup({ label: "payer bank", unit: unitOf(ctx.bucketMin), rows, nameOf: (r) => r.bank, minShare: 0.005 }),
  errbreak: (rows) => codeShare({ rows, topN: 25, label: "app_resp_code" }),
};

// SR Snippet rows: { ts, handle, dim, total, success } — daily, P2M only.
const SNIPPET = {
  psp: (rows) => srByGroup({ label: "payee PSP", unit: "day", rows, nameOf: (r) => r.dim, minShare: 0 }),
  instrument: (rows) => srByGroup({ label: "instrument", unit: "day", rows, nameOf: (r) => r.dim, minShare: 0.002 }),
  errors: (rows) =>
    codeShare({
      rows: rows.flatMap((r) => [
        { ts: r.ts, code: "__NONFAIL__", cnt: Number(r.success) || 0 },
        { ts: r.ts, code: r.dim, cnt: (Number(r.total) || 0) - (Number(r.success) || 0) },
      ]),
      topN: 15,
      label: "app_resp_code",
    }),
};

// Product Wise rows (section = "<product>-<query>"), daily, Paytm TPAP handles only.
const PRODUCT = {
  "international-activation": (rows) =>
    srByGroup({ label: "bank", unit: "day", rows: rows.map((r) => ({ ts: r.ts, bank: r.bank, total: r.attempts, success: r.activated })), nameOf: (r) => r.bank, minShare: 0.01 }),
  "international-txns": (rows) =>
    srByGroup({ label: "PSP handle", unit: "day", rows: rows.map((r) => ({ ts: r.ts, handle: r.handle, total: r.c, success: r.status === "SUCCESS" ? r.c : 0 })), nameOf: (r) => r.handle, minShare: 0 }),
  "international-countries": (rows) =>
    srByGroup({ label: "country", unit: "day", rows: rows.map((r) => ({ ts: r.ts, country: r.country, total: r.term, success: r.succ })), nameOf: (r) => r.country, minShare: 0.005 }),
  "international-errors": (rows) => codeShare({ rows: rows.map((r) => ({ ts: r.ts, code: r.code, cnt: r.c })), topN: 15, label: "error code" }),
};

/** Returns { summary, standouts[], actions[], nextSteps[], tables[] } or null. */
// Unified SR Dashboard sections, reshaped onto the Morning analyzers.
const UNIFIED = {
  raw: (rows, ctx) => {
    const m = new Map();
    for (const r of rows) {
      if (r.grp !== "tot") continue;
      const k = `${r.ts}|${r.handle}|${r.flow}`;
      const a = m.get(k) || { ts: r.ts, handle: r.handle, flow: r.flow, total: 0, success: 0 };
      a.total += r.cnt;
      if (r.status === "SUCCESS") a.success += r.cnt;
      m.set(k, a);
    }
    return MORNING.sr([...m.values()], ctx);
  },
  bank: (rows, ctx) => MORNING.bank(rows.filter((r) => r.grp === "bank"), ctx),
  bankday: (rows, ctx) => MORNING.payerbank(rows, ctx),
  share: (rows, ctx) => MORNING.share(rows, ctx),
  dims: (rows) => MORNING.flowsr(rows.filter((r) => r.kind === "flow").map((r) => ({ ...r, flow: r.dim }))),
};

export function analyze(dashboard, section, rows, ctx = {}) {
  const fn = ({ srsnippet: SNIPPET, product: PRODUCT, unified: UNIFIED }[dashboard] || MORNING)[section];
  if (!fn || !Array.isArray(rows)) return null;
  try {
    return fn(rows, ctx);
  } catch (err) {
    return { summary: `Insight generation failed: ${err.message}`, standouts: [], actions: [], nextSteps: [], tables: [] };
  }
}
