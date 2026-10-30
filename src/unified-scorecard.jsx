import { useState } from "react";

// Period scorecards for the Unified SR Dashboard — ported from the Success Rate Snippet.
// Rows in: { ts: 'YYYY-MM-DD', dim, total, success } (already filtered by handle / flow).
//
// Periods (relative to Y = latest complete day):
//   Yesterday  = Y            Day Before = Y-1
//   L7D        = Y-7 … Y-1    ("vs L7D" compares Y against it)
//   MTD        = 1st of Y's month … Y
//   LMTD       = 1st of previous month … same day-of-month (clamped to month end)

const C = {
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  good: "#22c55e",
  bad: "#ef4444",
};

const DAY = 86400000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => toDay(toMs(d) + n * DAY);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "—");

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const chg = (a, b) => (a != null && b > 0 ? ((a - b) * 100) / b : null);
const diff = (a, b) => (a != null && b != null ? a - b : null);
const fmtPct = (v, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtSigned = (v, unit, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));

/** Period boundaries from the latest data day. */
export function periods(yday) {
  const y = Number(yday.slice(0, 4));
  const m = Number(yday.slice(5, 7)) - 1;
  const dom = Number(yday.slice(8, 10));
  const pmStart = new Date(Date.UTC(y, m - 1, 1));
  const pmDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lmtdEnd = toDay(Date.UTC(pmStart.getUTCFullYear(), pmStart.getUTCMonth(), Math.min(dom, pmDays)));
  return {
    yday,
    dbefore: addDays(yday, -1),
    l7From: addDays(yday, -7),
    l7To: addDays(yday, -1),
    mtdFrom: `${yday.slice(0, 8)}01`,
    mtdTo: yday,
    lmtdFrom: toDay(pmStart.getTime()),
    lmtdTo: lmtdEnd,
  };
}

export function periodLabels(P) {
  return P
    ? {
        y: fmtDay(P.yday),
        db: fmtDay(P.dbefore),
        l7: `${fmtDay(P.l7From)} – ${fmtDay(P.l7To)}`,
        mtd: `${fmtDay(P.mtdFrom)} – ${fmtDay(P.mtdTo)}`,
        lmtd: `${fmtDay(P.lmtdFrom)} – ${fmtDay(P.lmtdTo)}`,
      }
    : {};
}

const inRange = (d, a, b) => d >= a && d <= b;
const z = () => ({ total: 0, success: 0 });
const empty = () => ({ y: z(), db: z(), l7: z(), mtd: z(), lmtd: z() });

/** { [dim]: { y, db, l7, mtd, lmtd } } of {total, success}, plus "__ALL__". */
export function aggregate(rows, P) {
  const out = {};
  const bump = (dim, key, r) => {
    const o = (out[dim] ||= empty());
    o[key].total += r.total;
    o[key].success += r.success;
  };
  for (const r of rows) {
    const keys = [];
    if (r.ts === P.yday) keys.push("y");
    if (r.ts === P.dbefore) keys.push("db");
    if (inRange(r.ts, P.l7From, P.l7To)) keys.push("l7");
    if (inRange(r.ts, P.mtdFrom, P.mtdTo)) keys.push("mtd");
    if (inRange(r.ts, P.lmtdFrom, P.lmtdTo)) keys.push("lmtd");
    for (const k of keys) {
      bump(r.dim, k, r);
      bump("__ALL__", k, r);
    }
  }
  return out;
}

const withTotal = (rows) => {
  const t = rows.find((r) => r.dim === "__ALL__");
  return { rows: rows.filter((r) => r.dim !== "__ALL__"), total: t ? { ...t, dim: "Overall" } : null };
};

/** metric: "sr" | "success" | "volume". */
export function scoreRows(agg, order, metric) {
  const sr = (x) => pct(x.success, x.total);
  const val = (x) => (metric === "success" ? x.success : x.total);
  return withTotal(
    [...order, "__ALL__"].map((dim) => {
      const a = agg[dim] || empty();
      if (metric === "sr") {
        const y = sr(a.y);
        const l7 = sr(a.l7);
        const mtd = sr(a.mtd);
        const lmtd = sr(a.lmtd);
        return { dim, cells: [y, sr(a.db), diff(y, l7), mtd, lmtd, diff(mtd, lmtd), l7] };
      }
      const l7avg = val(a.l7) / 7;
      return { dim, cells: [val(a.y), val(a.db), chg(val(a.y), l7avg), val(a.mtd), val(a.lmtd), chg(val(a.mtd), val(a.lmtd)), l7avg] };
    }),
  );
}

export function scoreCols(metric, per) {
  if (metric === "sr") {
    return [
      { label: "Yesterday", title: per.y, fmt: (v) => fmtPct(v) },
      { label: "Day Before", title: per.db, fmt: (v) => fmtPct(v) },
      { label: "vs L7D", title: `Yesterday SR − L7D SR (${per.l7}), percentage points`, fmt: (v) => fmtSigned(v, " pp"), tone: true },
      { label: "MTD", title: per.mtd, fmt: (v) => fmtPct(v) },
      { label: "LMTD", title: per.lmtd, fmt: (v) => fmtPct(v) },
      { label: "MTD Δ", title: "MTD SR − LMTD SR, percentage points", fmt: (v) => fmtSigned(v, " pp"), tone: true },
      { label: "Last 7D Avg", title: `SR over ${per.l7}`, fmt: (v) => fmtPct(v) },
    ];
  }
  return [
    { label: "Yesterday", title: per.y, fmt: fmtNum },
    { label: "Day Before", title: per.db, fmt: fmtNum },
    { label: "vs L7D", title: `Yesterday vs L7D daily average (${per.l7}), % change`, fmt: (v) => fmtSigned(v, "%"), tone: true },
    { label: "MTD", title: per.mtd, fmt: fmtNum },
    { label: "LMTD", title: per.lmtd, fmt: fmtNum },
    { label: "MTD Δ%", title: "MTD vs LMTD, % change", fmt: (v) => fmtSigned(v, "%"), tone: true },
    { label: "Last 7D Avg", title: `Daily average over ${per.l7}`, fmt: fmtNum },
  ];
}

/**
 * Top-N failure codes: Y / MTD / LMTD failures, contribution %, MTD and Yday Δ.
 * pinned: a code kept out of the ranking and listed last (the backend's long-tail bucket).
 */
export function errorRows(agg, topN, descr = {}, pinned = null, { lmtdDays = 0, pick = null } = {}) {
  const fails = (x) => x.total - x.success;
  const codes = Object.keys(agg).filter((k) => k !== "__ALL__");
  const tot = { y: 0, db: 0, mtd: 0, lmtd: 0 };
  for (const c of codes) for (const k of Object.keys(tot)) tot[k] += fails(agg[c][k]);
  // D vs LMTD (opt-in): LMTD failures per day, D vs that daily average (%), contribution D − LMTD (pp).
  const dVsLmtd = (f) => (lmtdDays > 0 ? [f.lmtd / lmtdDays, chg(f.y, f.lmtd / lmtdDays), diff(pct(f.y, tot.y), pct(f.lmtd, tot.lmtd))] : []);
  const all = codes
    .map((code) => {
      const a = agg[code];
      return { code, f: { y: fails(a.y), db: fails(a.db), mtd: fails(a.mtd), lmtd: fails(a.lmtd) } };
    })
    .filter((r) => r.f.y > 0 || r.f.mtd > 0);
  const ranked = all.filter((r) => r.code !== pinned).sort((a, b) => b.f.y - a.f.y || b.f.mtd - a.f.mtd);
  const top = ranked.slice(0, topN);
  // pick (optional): { hidden, added } — codes removed from / added beyond the top N.
  const hidden = new Set(pick?.hidden || []);
  const added = (pick?.added || []).map((c) => ranked.find((r) => r.code === c)).filter((r) => r && !top.includes(r));
  const rows = [...top.filter((r) => !hidden.has(r.code)), ...added, ...all.filter((r) => r.code === pinned && !hidden.has(r.code))].map(({ code, f }) => ({
    dim: code,
    title: descr[code] || "",
    cells: [f.y, pct(f.y, tot.y), f.mtd, f.lmtd, pct(f.mtd, tot.mtd), pct(f.lmtd, tot.lmtd), chg(f.mtd, f.lmtd), chg(f.y, f.db), ...dVsLmtd(f)],
  }));
  const total = { dim: "All failures", cells: [tot.y, 100, tot.mtd, tot.lmtd, 100, 100, chg(tot.mtd, tot.lmtd), chg(tot.y, tot.db), ...dVsLmtd(tot)] };
  // defaults / options feed a row picker: the top N, and every code with its yesterday failures.
  const defaults = [...top, ...all.filter((r) => r.code === pinned)].map((r) => r.code);
  const options = [...ranked, ...all.filter((r) => r.code === pinned)].map((r) => ({ id: r.code, label: r.code, sub: `${Math.round(r.f.y).toLocaleString("en-IN")} fails · ${descr[r.code] || ""}` }));
  return { rows, total, defaults, options };
}

export function errorCols(per, { dVsLmtd = false } = {}) {
  return [
    { label: "Yesterday Failures", title: per.y, fmt: fmtNum },
    { label: "Yesterday Contrib%", title: "Share of all failures yesterday", fmt: (v) => fmtPct(v) },
    { label: "MTD Failures", title: per.mtd, fmt: fmtNum },
    { label: "LMTD Failures", title: per.lmtd, fmt: fmtNum },
    { label: "MTD Contrib%", title: "Share of all MTD failures", fmt: (v) => fmtPct(v) },
    { label: "LMTD Contrib%", title: "Share of all LMTD failures", fmt: (v) => fmtPct(v) },
    { label: "MTD Δ%", title: "MTD failures vs LMTD failures, % change", fmt: (v) => fmtSigned(v, "%", 1), tone: false },
    { label: "Yday Δ%", title: "Yesterday failures vs Day Before failures, % change", fmt: (v) => fmtSigned(v, "%", 1), tone: false },
    ...(dVsLmtd
      ? [
          { label: "LMTD Fails/day", title: `LMTD failures ÷ days in LMTD (${per.lmtd})`, fmt: fmtNum },
          { label: "D vs LMTD Δ%", title: `Yesterday (${per.y}) failures vs LMTD daily average, % change`, fmt: (v) => fmtSigned(v, "%", 1), tone: false },
          { label: "Contrib D vs LMTD", title: "Yesterday contribution % − LMTD contribution %, percentage points", fmt: (v) => fmtSigned(v, " pp"), tone: false },
        ]
      : []),
  ];
}

/** Calendar days in the LMTD window (1st of last month → same day-of-month). */
export const lmtdDays = (P) => (P ? Math.round((Date.parse(`${P.lmtdTo}T00:00:00Z`) - Date.parse(`${P.lmtdFrom}T00:00:00Z`)) / 86400000) + 1 : 0);

// ─── table ───────────────────────────────────────────────────────────────────

const tone = (v, goodWhenUp) => {
  if (v == null || Math.abs(v) < 0.005) return C.text2;
  return v > 0 === goodWhenUp ? C.good : C.bad;
};
const th = {
  padding: "8px 10px",
  textAlign: "right",
  fontSize: 11,
  fontWeight: 600,
  color: C.text2,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: C.card,
};
const td = {
  padding: "7px 10px",
  textAlign: "right",
  fontSize: 13,
  borderBottom: `1px solid ${C.border}`,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};
const btn = {
  padding: "4px 10px",
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: "transparent",
  color: C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function toTsv(firstCol, cols, rows, total) {
  const lines = [[firstCol, ...cols.map((c) => c.label)].join("\t")];
  for (const r of [...rows, ...(total ? [total] : [])]) lines.push([r.dim, ...r.cells.map((v, i) => cols[i].fmt(v))].join("\t"));
  return lines.join("\n");
}

/** cols: [{ label, title, fmt, tone?: boolean (goodWhenUp) }]; rows: [{ dim, title?, cells }]. */
/** hide: column labels to leave out; tools: nodes (e.g. pickers) in the caption bar. */
export function ScoreTable({ firstCol, cols: allCols, rows: allRows, total: allTotal, caption, hide = null, tools = null }) {
  const keep = allCols.map((c) => !hide || !hide.includes(c.label));
  const cols = allCols.filter((_, i) => keep[i]);
  const trim = (r) => r && { ...r, cells: r.cells.filter((_, i) => keep[i]) };
  const rows = hide ? allRows.map(trim) : allRows;
  const total = hide ? trim(allTotal) : allTotal;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toTsv(firstCol, cols, rows, total));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const renderRow = (r, isTotal) => (
    <tr key={r.dim} style={isTotal ? { background: C.card2, fontWeight: 700 } : undefined}>
      <td style={{ ...td, textAlign: "left", color: C.text, fontWeight: isTotal ? 700 : 600 }} title={r.title || undefined}>
        {r.dim}
        {r.title ? <span style={{ color: C.muted, fontWeight: 400 }}> · {r.title.length > 48 ? `${r.title.slice(0, 48)}…` : r.title}</span> : null}
      </td>
      {r.cells.map((v, i) => {
        const c = cols[i];
        return (
          <td key={i} style={{ ...td, color: c.tone == null ? C.text : tone(v, c.tone) }}>
            {c.fmt(v)}
          </td>
        );
      })}
    </tr>
  );
  if (!rows.length && !total) return <div style={{ padding: 20, color: C.muted, fontSize: 13 }}>No data in the cached result.</div>;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 11, color: C.muted }}>
        <span style={{ flex: 1 }}>{caption}</span>
        {tools}
        <button type="button" style={btn} onClick={copy} disabled={!rows.length}>
          {copied ? "Copied" : "Copy (TSV)"}
        </button>
      </div>
      <div style={{ overflowX: "auto", maxHeight: 520 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>{firstCol}</th>
              {cols.map((c) => (
                <th key={c.label} style={th} title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => renderRow(r, false))}
            {total && renderRow(total, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
