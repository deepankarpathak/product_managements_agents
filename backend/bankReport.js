// Unified SR Dashboard — Payer (remitter) bank report: post-processing of the "bankrep"
// section (Looker, since the 1st of last month). One query returns five row groups:
//   base        (ts, bank, handle, flow)  attempts / success — scorecard, trends, deep-dive by flow / handle
//   etype       (ts, bank, decline type)  failures by BD / TD / RD — failure split, TD watch
//   os          (ts, bank, os)            deep-dive by OS
//   instrument  (ts, bank, instrument)    deep-dive by instrument
//   code        (ts, bank, code)          deep-dive error codes, error spikes × banks
// base + etype go to /state; os / instrument / code are served per bank (view "bank:XXXX"),
// codes trimmed to each bank's top CODES_PER_BANK. Error spikes are computed here from the
// untrimmed code rows and shipped as result.extra.spikes.

const CODES_PER_BANK = 25;
const OTHER = "Other codes";
const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Period bounds from the latest day: MTD / LMTD (same day-of-month), last 7 / prior 7, last 14 / prior 14. */
export function bankPeriods(yday) {
  const y = Number(yday.slice(0, 4));
  const m = Number(yday.slice(5, 7)) - 1;
  const dom = Number(yday.slice(8, 10));
  const pm = new Date(Date.UTC(y, m - 1, 1));
  const pmDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    mtd: [`${yday.slice(0, 8)}01`, yday],
    lmtd: [iso(pm.getTime()), iso(Date.UTC(pm.getUTCFullYear(), pm.getUTCMonth(), Math.min(dom, pmDays)))],
    l7: [addDays(yday, -6), yday],
    p7: [addDays(yday, -13), addDays(yday, -7)],
    l14: [addDays(yday, -13), yday],
    p14: [addDays(yday, -27), addDays(yday, -14)],
  };
}

const inP = (ts, [a, b]) => ts >= a && ts <= b;
const days = ([a, b]) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY) + 1;

/**
 * Error codes whose share of attempts rose (monthly MTD vs LMTD, weekly L7 vs P7, 14-day L14 vs P14),
 * ranked by extra failures = Δ share × attempts now, and the banks each one hit: Δ share ≥ 0.05pp with
 * ≥ 1,000 extra failures (monthly / 14-day) or ≥ 500 (weekly).
 */
export function errorSpikes(baseRows, codeRows, { top = 30 } = {}) {
  const yday = baseRows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
  if (!yday) return null;
  const P = bankPeriods(yday);
  const PK = Object.keys(P);
  const att = {}; // bank -> period -> attempts; "__all" for overall
  for (const r of baseRows) {
    for (const k of PK) {
      if (!inP(r.ts, P[k])) continue;
      for (const b of [r.bank, "__all"]) {
        const a = (att[b] ||= {});
        a[k] = (a[k] || 0) + r.total;
      }
    }
  }
  const fail = {}; // code -> bank -> period -> failures
  const meta = {};
  for (const r of codeRows) {
    const f = r.total - r.success;
    if (f <= 0) continue;
    meta[r.dim] ||= { descr: r.descr || "", ctype: r.ctype || "" };
    for (const k of PK) {
      if (!inP(r.ts, P[k])) continue;
      for (const b of [r.bank, "__all"]) {
        const c = ((fail[r.dim] ||= {})[b] ||= {});
        c[k] = (c[k] || 0) + f;
      }
    }
  }
  const share = (c, a, k) => (a?.[k] > 0 ? ((c?.[k] || 0) * 100) / a[k] : null);
  const rise = (c, a, now, base) => {
    const sn = share(c, a, now);
    const sb = share(c, a, base);
    return sn == null || sb == null ? { d: null, extra: 0 } : { d: sn - sb, extra: ((sn - sb) / 100) * a[now] };
  };
  const codes = Object.keys(fail)
    .map((code) => {
      const c = fail[code].__all;
      const a = att.__all;
      const m = rise(c, a, "mtd", "lmtd");
      const w = rise(c, a, "l7", "p7");
      const f = rise(c, a, "l14", "p14");
      return { code, ...meta[code], m, w, f, best: Math.max(m.extra, w.extra, f.extra) };
    })
    .filter((x) => x.best > 0)
    .sort((x, y) => y.best - x.best)
    .slice(0, top);
  for (const x of codes) {
    x.banks = Object.keys(fail[x.code])
      .filter((b) => b !== "__all")
      .map((bank) => {
        const c = fail[x.code][bank];
        const a = att[bank] || {};
        const m = rise(c, a, "mtd", "lmtd");
        const w = rise(c, a, "l7", "p7");
        const f = rise(c, a, "l14", "p14");
        const hit = (m.d >= 0.05 && m.extra >= 1000) || (f.d >= 0.05 && f.extra >= 1000) || (w.d >= 0.05 && w.extra >= 500);
        return {
          bank,
          hit,
          mtdShare: share(c, a, "mtd"),
          lmtdShare: share(c, a, "lmtd"),
          l7Share: share(c, a, "l7"),
          p7Share: share(c, a, "p7"),
          mtdPerDay: (c.mtd || 0) / days(P.mtd),
          lmtdPerDay: (c.lmtd || 0) / days(P.lmtd),
          l7PerDay: (c.l7 || 0) / 7,
          m,
          w,
          f,
        };
      })
      .filter((b) => b.hit)
      .sort((p, q) => Math.max(q.m.extra, q.w.extra, q.f.extra) - Math.max(p.m.extra, p.w.extra, p.f.extra))
      .slice(0, 15);
  }
  return { yday, periods: P, codes };
}

/** merged bankrep rows → { rows (base + etype), views ("bank:XXXX" → os / instrument / code rows), extra }. */
export function splitBankrep(rows) {
  const base = [];
  const detail = {}; // bank -> rows
  const codeRows = [];
  for (const r of rows) {
    if (r.grp === "base" || r.grp === "etype") base.push(r);
    else if (r.grp === "code") codeRows.push(r);
    else (detail[r.bank] ||= []).push(r);
  }
  // Each bank's top codes by window failures; the rest fold into one row per day.
  const byBank = {};
  for (const r of codeRows) (byBank[r.bank] ||= []).push(r);
  for (const [bank, list] of Object.entries(byBank)) {
    const tot = {};
    for (const r of list) tot[r.dim] = (tot[r.dim] || 0) + r.total - r.success;
    const keep = new Set(
      Object.entries(tot)
        .sort((a, b) => b[1] - a[1])
        .slice(0, CODES_PER_BANK)
        .map(([c]) => c),
    );
    const other = {};
    for (const r of list) {
      if (keep.has(r.dim)) (detail[bank] ||= []).push(r);
      else {
        const o = (other[r.ts] ||= { ts: r.ts, bank, grp: "code", handle: "", flow: "", dim: OTHER, ctype: "", descr: "", total: 0, success: 0 });
        o.total += r.total;
        o.success += r.success;
      }
    }
    (detail[bank] ||= []).push(...Object.values(other));
  }
  const views = Object.fromEntries(Object.entries(detail).map(([b, list]) => [`bank:${b}`, list]));
  return { rows: base, views, extra: { spikes: errorSpikes(base.filter((r) => r.grp === "base"), codeRows) } };
}

/**
 * Live payer-bank check over failed txns only. rows: bankalert rows — grp "fail" { ts (30-min bucket),
 * bank, code, total = failures } and grp "all" { ts, total = attempts, success }.
 *
 * Per bank the baseline is its usual traffic share, SR and gap to overall SR: L7D from the day-level
 * bank report, or (banks the Looker table files under "Others") yesterday from the raw IFSC split.
 * In each bucket: attempts_b ≈ attempts × share_b, SR_b ≈ 1 − failures_b / attempts_b; the bucket is
 * degraded when SR_b − SR_overall ≤ normal gap − dropPp (with attempts_b ≥ minTxns). An incident is a run
 * of ≥ 2 degraded buckets (≥ 60 min) anywhere in the window costing ≥ minLost txns.
 */
export function intradayBankAlerts(rows, { bankrepRows = [], pbankRows = [], dropPp = 2, minTxns = 300, minLost = 200 } = {}) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const all = {};
  const fail = {}; // bank -> ts -> failures
  const att = {}; // bank -> ts -> attempts (DWH check only; the live check estimates them)
  const codes = {}; // bank -> ts -> code -> failures
  for (const r of rows) {
    const t = Number(r.total) || 0;
    if (r.grp === "all") {
      const a = (all[r.ts] ||= { t: 0, s: 0 });
      a.t += t;
      a.s += Number(r.success) || 0;
    } else if (r.grp === "att") {
      (att[r.bank] ||= {})[r.ts] = (att[r.bank][r.ts] || 0) + t;
    } else {
      // Failures = rows not successful (live rows carry success = 0; DWH code rows include successes).
      const f = t - (Number(r.success) || 0);
      if (f <= 0) continue;
      (fail[r.bank] ||= {})[r.ts] = (fail[r.bank][r.ts] || 0) + f;
      const c = ((codes[r.bank] ||= {})[r.ts] ||= {});
      c[r.code] = (c[r.code] || 0) + f;
    }
  }
  // Baselines: { share (of attempts), gap (SR − overall SR) } per bank.
  const baseOf = (list, keyOf) => {
    const m = {};
    const tot = { t: 0, s: 0 };
    for (const r of list) {
      const k = keyOf(r);
      const a = (m[k] ||= { t: 0, s: 0 });
      const t = Number(r.total) || 0;
      const sc = Number(r.success) || 0;
      a.t += t;
      a.s += sc;
      tot.t += t;
      tot.s += sc;
    }
    const o = tot.t ? (tot.s * 100) / tot.t : null;
    return Object.fromEntries(Object.entries(m).map(([k, a]) => [k, { share: tot.t ? a.t / tot.t : 0, gap: (a.s * 100) / a.t - o }]));
  };
  const base = bankrepRows.filter((r) => r.grp === "base" && ["ptyes", "ptaxis", "ptsbi", "pthdfc"].includes(r.handle));
  const yday = base.reduce((m, r) => (r.ts > m ? r.ts : m), "");
  const l7 = yday ? baseOf(base.filter((r) => r.ts >= addDays(yday, -6) && r.ts <= yday), (r) => r.bank) : {};
  const pDay = pbankRows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
  const raw = baseOf(pbankRows.filter((r) => r.ts === pDay), (r) => r.pbank);
  const incidents = [];
  let checked = 0;
  for (const [bank, byTs] of Object.entries(fail)) {
    const A = att[bank];
    const b = l7[bank] && bank !== "Others" ? { ...l7[bank], source: "L7D day-level" } : raw[bank] ? { ...raw[bank], source: "yesterday raw" } : null;
    if (!b || b.share <= 0) continue;
    checked += 1;
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const lost = run.reduce((a, c) => a + c.lost, 0);
        if (lost >= minLost) {
          const cc = {};
          for (const c of run) for (const [k, n] of Object.entries(codes[bank]?.[c.ts] || {})) cc[k] = (cc[k] || 0) + n;
          incidents.push({
            bank,
            from: run[0].ts,
            to: run[run.length - 1].ts,
            minutes: run.length * 30,
            lost,
            worstGap: Math.min(...run.map((c) => c.gap)),
            baseGap: b.gap,
            sr: run.reduce((a, c) => a + c.sr, 0) / run.length,
            source: b.source,
            topCodes: Object.entries(cc)
              .sort((x, y) => y[1] - x[1])
              .slice(0, 3),
          });
        }
      }
      run = [];
    };
    for (const ts of buckets) {
      const o = all[ts];
      if (!o?.t) {
        flush();
        continue;
      }
      const att = A?.[ts] ?? o.t * b.share; // exact (DWH) or estimated from the usual share (live)
      const f = byTs[ts] || 0;
      if (att < minTxns) {
        flush();
        continue;
      }
      const srO = (o.s * 100) / o.t;
      const sr = Math.max(0, 100 - (f * 100) / att);
      const gap = sr - srO;
      if (gap <= b.gap - dropPp) run.push({ ts, sr, gap, lost: Math.max(0, f - att * (1 - (srO + b.gap) / 100)) });
      else flush();
    }
    flush();
  }
  return { buckets, incidents: incidents.sort((x, y) => y.lost - x.lost), checked, from: buckets[0], to: buckets[buckets.length - 1] };
}
