import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BreakdownBody, DeclinesBody, MorningKpiStrip } from "./morning-breakdown.jsx";

// Morning Dashboard — UPI Success Rate, Error codes, U09, Bank-wise SR.
// Talks to backend /api/mdash/*. Opening the page only reads cached results;
// queries run only when Refresh / Refresh All is clicked (or the backend auto-retries
// a failed run).

const API = "/api/mdash";

const SECTION_TITLES = {
  breakdown: "A · SR Breakdown — impact ranked (PSP / bank / instrument / flow)",
  declines: "B · Decline Codes — NPCI description, ₹ amount, D-1…D-3",
  sr: "1 · Success Rate",
  errors: "2 · Error Code Analysis",
  u09: "3 · U09 Trend",
  bank: "4 · Bank-wise Success Rate",
  share: "5 · Txn Count / % Share Across Handles (DoD)",
  flowsr: "6 · P2P vs P2M Success Rate (MoM)",
  instrument: "7 · Instrument-wise Success Rate (P2P & P2M)",
  psp: "8 · Payee PSP Success Rate (DoD)",
  payerbank: "9 · Payer Bank Success Rate (DoD)",
  errbreak: "10 · Error-wise Breakup (app_resp_code)",
};
const SECTION_IDS = ["breakdown", "declines", "sr", "errors", "u09", "bank", "share", "flowsr", "instrument", "psp", "payerbank", "errbreak"];

// Per-section duration options come from the backend (/state.durationOptions):
// [{ key: "4h", kind: "intraday" }, { key: "3d", kind: "daily" }, …]. "daily" keys read the
// day-level Looker table; "intraday" keys read raw txns (Trino or Redash).
let DURATION_OPTS = {};
const labelFor = (d) => {
  if (DURATION_LABELS[d]) return DURATION_LABELS[d];
  const m = /^(\d+)([mhd])$/.exec(d || "");
  if (!m) return d;
  const n = Number(m[1]);
  const unit = { m: "min", h: "hour", d: "day" }[m[2]];
  return `${n} ${unit}${n > 1 && m[2] !== "m" ? "s" : ""}`;
};
const durationLabels = (id) =>
  DURATION_OPTS[id] ? Object.fromEntries(DURATION_OPTS[id].map((o) => [o.key, labelFor(o.key)])) : DURATION_LABELS;
const kindOf = (id, key) => DURATION_OPTS[id]?.find((o) => o.key === key)?.kind || "intraday";
const hasKind = (id, kind) => (DURATION_OPTS[id] || [{ kind: "intraday" }]).some((o) => o.kind === kind);
const enginesFor = (id) => [...(hasKind(id, "daily") ? ["looker"] : []), ...(hasKind(id, "intraday") ? ["trino", "redash"] : [])];
const ENGINE_NAME = { looker: "Looker (daily)", trino: "Trino", redash: "Redash" };
const DURATION_LABELS = {
  "15m": "15 min",
  "1h": "1 hour",
  "4h": "4 hours",
  "12h": "12 hours",
  "1d": "1 day",
  "2d": "2 days",
  "3d": "3 days",
  "4d": "4 days",
  "7d": "7 days",
};
const DURATION_MIN = { "15m": 15, "1h": 60, "4h": 240, "12h": 720, "1d": 1440, "2d": 2880, "3d": 4320, "4d": 5760, "7d": 10080 };
const ACTIVE = new Set(["queued", "running", "retry-wait"]);

// Dark-surface categorical palette (fixed order — colour follows entity, never rank).
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
// Increase = reds (light → deep), decrease = cool greys/blues.
const REDS = ["#fecaca", "#fca5a5", "#f87171", "#ef4444", "#dc2626", "#b91c1c"];
const COOLS = ["#94a3b8", "#7dd3fc", "#60a5fa", "#a5b4fc", "#67e8f9", "#cbd5e1"];

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#f59e0b",
  good: "#0ca30c",
  bad: "#d03b3b",
  warn: "#fab219",
  grid: "#1e293b",
};

// ─── utils ───────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const lsGet = (k, fb) => {
  try {
    const v = localStorage.getItem(`mdash:${k}`);
    return v == null ? fb : JSON.parse(v);
  } catch {
    return fb;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(`mdash:${k}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const fmtPct = (v, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtCompact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Map a day 'YYYY-MM-DD' to its period key for day / week (Monday) / month grain. */
function periodKey(day, grain) {
  if (grain === "month") return day.slice(0, 7);
  if (grain === "week") {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return `W ${d.toISOString().slice(0, 10)}`;
  }
  return day;
}
const fmtPp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)} pp`);
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

function engineFor(duration, cfg, id) {
  if (kindOf(id, duration) === "daily") return "looker";
  return DURATION_MIN[duration] <= (cfg?.redashMaxMinutes ?? 240) ? "redash" : "trino";
}

/** Split buckets into earlier / recent halves for "what moved" comparisons. */
function halves(buckets) {
  const mid = Math.floor(buckets.length / 2);
  return { early: new Set(buckets.slice(0, mid)), recent: new Set(buckets.slice(mid)) };
}

// ─── data shaping ────────────────────────────────────────────────────────────

function shapeSr(rows, flowFilter) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const handles = [...new Set(rows.map((r) => r.handle))].sort();
  const mk = () => buckets.map(() => ({ t: 0, s: 0 }));
  const overall = { ALL: mk(), P2P: mk(), P2M: mk() };
  const byHandle = Object.fromEntries(handles.map((h) => [h, mk()]));
  const handleFlow = {}; // handle -> flow -> {t,s,et,es,rt,rs}
  const { early } = halves(buckets);
  for (const r of rows) {
    const i = idx.get(r.ts);
    for (const k of ["ALL", r.flow]) {
      if (!overall[k]) continue;
      overall[k][i].t += r.total;
      overall[k][i].s += r.success;
    }
    if (flowFilter === "ALL" || r.flow === flowFilter) {
      byHandle[r.handle][i].t += r.total;
      byHandle[r.handle][i].s += r.success;
    }
    for (const f of ["ALL", r.flow]) {
      const a = ((handleFlow[r.handle] ||= {})[f] ||= { t: 0, s: 0, et: 0, es: 0, rt: 0, rs: 0 });
      a.t += r.total;
      a.s += r.success;
      if (early.has(r.ts)) {
        a.et += r.total;
        a.es += r.success;
      } else {
        a.rt += r.total;
        a.rs += r.success;
      }
    }
  }
  return { buckets, handles, overall, byHandle, handleFlow };
}

function shapeErrors(rows, grouping, topN) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const total = buckets.map(() => 0);
  const fail = buckets.map(() => 0);
  const codes = new Map(); // code -> per-bucket counts
  for (const r of rows) {
    const i = idx.get(r.ts);
    total[i] += r.cnt;
    if (r.code === "__NONFAIL__") continue;
    fail[i] += r.cnt;
    const code = grouping === "prefix" ? String(r.code).split("-")[0] : r.code;
    if (!codes.has(code)) codes.set(code, buckets.map(() => 0));
    codes.get(code)[i] += r.cnt;
  }
  const { early, recent } = halves(buckets);
  const sumWhere = (arr, set) => arr.reduce((a, v, i) => (set.has(buckets[i]) ? a + v : a), 0);
  const tE = sumWhere(total, early);
  const tR = sumWhere(total, recent);
  const all = [...codes.entries()].map(([code, counts]) => {
    const n = counts.reduce((a, b) => a + b, 0);
    const e = pct(sumWhere(counts, early), tE);
    const r = pct(sumWhere(counts, recent), tR);
    const delta = e != null && r != null ? r - e : null;
    const rel = e ? ((r - e) / e) * 100 : null;
    return { code, counts, n, share: pct(n, total.reduce((a, b) => a + b, 0)), early: e, recent: r, delta, rel };
  });
  all.sort((a, b) => b.n - a.n);
  const top = all.slice(0, topN);
  // Colour: increases get red shades by size of rise; decreases get cool shades.
  const inc = top.filter((c) => (c.delta ?? 0) > 0).sort((a, b) => b.delta - a.delta);
  const dec = top.filter((c) => !((c.delta ?? 0) > 0));
  inc.forEach((c, i) => {
    const step = Math.min(REDS.length - 1, Math.round(((inc.length - 1 - i) / Math.max(1, inc.length - 1)) * (REDS.length - 1)));
    c.color = REDS[step];
    c.up = true;
  });
  dec.forEach((c, i) => {
    c.color = COOLS[i % COOLS.length];
    c.up = false;
  });
  return { buckets, total, fail, top, otherCount: all.length - top.length };
}

function shapeU09(rows) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const handles = [...new Set(rows.map((r) => r.handle))].sort();
  const mk = () => buckets.map(() => ({ t: 0, u: 0 }));
  const overall = mk();
  const byHandle = Object.fromEntries(handles.map((h) => [h, mk()]));
  for (const r of rows) {
    const i = idx.get(r.ts);
    overall[i].t += r.total;
    overall[i].u += r.u09;
    byHandle[r.handle][i].t += r.total;
    byHandle[r.handle][i].u += r.u09;
  }
  return { buckets, handles, overall, byHandle };
}

function shapeBank(rows, flowFilter, topN) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const { early } = halves(buckets);
  const banks = new Map();
  for (const r of rows) {
    let b = banks.get(r.bank);
    if (!b) {
      b = { bank: r.bank, ALL: { t: 0, s: 0 }, P2P: { t: 0, s: 0 }, P2M: { t: 0, s: 0 }, et: 0, es: 0, rt: 0, rs: 0, series: buckets.map(() => ({ t: 0, s: 0 })) };
      banks.set(r.bank, b);
    }
    b.ALL.t += r.total;
    b.ALL.s += r.success;
    if (b[r.flow]) {
      b[r.flow].t += r.total;
      b[r.flow].s += r.success;
    }
    if (flowFilter === "ALL" || r.flow === flowFilter) {
      const p = b.series[idx.get(r.ts)];
      p.t += r.total;
      p.s += r.success;
      if (early.has(r.ts)) {
        b.et += r.total;
        b.es += r.success;
      } else {
        b.rt += r.total;
        b.rs += r.success;
      }
    }
  }
  const list = [...banks.values()].sort((a, b) => b.ALL.t - a.ALL.t);
  list.forEach((b) => {
    b.delta = b.et && b.rt ? pct(b.rs, b.rt) - pct(b.es, b.et) : null;
  });
  return { buckets, list, top: list.slice(0, topN) };
}

// ─── chart ───────────────────────────────────────────────────────────────────

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function tickLabel(ts, sameDay) {
  // ts = 'YYYY-MM-DD HH:mm' (intraday), 'YYYY-MM-DD' (day), 'W YYYY-MM-DD' (week), 'YYYY-MM' (month)
  if (ts.startsWith("W ")) return `wk ${ts.slice(10, 12)}/${ts.slice(7, 9)}`;
  if (ts.length === 7) return `${MONTHS[Number(ts.slice(5, 7)) - 1]} ${ts.slice(2, 4)}`;
  if (ts.length === 10) return `${ts.slice(8, 10)}/${ts.slice(5, 7)}`;
  return sameDay ? ts.slice(11) : `${ts.slice(8, 10)}/${ts.slice(5, 7)} ${ts.slice(11)}`;
}

function LineChart({ title, buckets, series, yFormat = (v) => v.toFixed(1), height = 260, unit = "", initialHidden }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  // Series listed in initialHidden start toggled off (legend click shows them).
  const [hidden, setHidden] = useState(() => new Set(initialHidden || []));
  const visible = series.filter((s) => !hidden.has(s.key));
  const pad = { l: 56, r: visible.length <= 4 ? 70 : 16, t: 12, b: 28 };
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;

  const vals = visible.flatMap((s) => s.values.filter((v) => v != null && Number.isFinite(v)));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  if (vals.length && Math.min(...vals) >= 0 && lo < 0) lo = 0;
  if (unit === "%" && vals.length && Math.max(...vals) <= 100 && hi > 100) hi = 100;
  const x = (i) => pad.l + (buckets.length <= 1 ? iw / 2 : (i * iw) / (buckets.length - 1));
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const sameDay = buckets.length && buckets[0].slice(0, 10) === buckets[buckets.length - 1].slice(0, 10);
  const nX = Math.max(2, Math.min(8, Math.floor(iw / 90)));
  const xTicks = buckets.length <= nX ? buckets.map((_, i) => i) : Array.from({ length: nX }, (_, k) => Math.round((k * (buckets.length - 1)) / (nX - 1)));

  const path = (vals2) => {
    let d = "";
    let pen = false;
    vals2.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (!buckets.length) return;
    const i = Math.round(((px - pad.l) / iw) * (buckets.length - 1));
    setHover(Math.max(0, Math.min(buckets.length - 1, i)));
  };

  const toggle = (k) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  // Direct labels at line ends for ≤4 series, nudged apart.
  const endLabels = [];
  if (visible.length <= 4) {
    visible.forEach((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && (s.values[i] == null || !Number.isFinite(s.values[i]))) i--;
      if (i >= 0) endLabels.push({ s, yy: y(s.values[i]) });
    });
    endLabels.sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < endLabels.length; k++) if (endLabels[k].yy - endLabels[k - 1].yy < 13) endLabels[k].yy = endLabels[k - 1].yy + 13;
  }

  return (
    <div style={{ marginBottom: 14 }}>
      {title && <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, margin: "4px 0 6px" }}>{title}</div>}
      {series.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginBottom: 6 }}>
          {series.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              title="Show / hide"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: hidden.has(s.key) ? C.muted : C.text2,
                fontSize: 11,
                textDecoration: hidden.has(s.key) ? "line-through" : "none",
              }}
            >
              <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color, opacity: hidden.has(s.key) ? 0.3 : 1 }} />
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div ref={ref} style={{ position: "relative" }}>
        {!buckets.length ? (
          <div style={{ height, display: "grid", placeItems: "center", color: C.muted, fontSize: 12 }}>No data in window</div>
        ) : (
          <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
            {yTicks.map((v, i) => (
              <g key={i}>
                <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth={1} />
                <text x={pad.l - 8} y={y(v) + 4} fill={C.muted} fontSize={10} textAnchor="end">
                  {yFormat(v)}
                  {unit}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={height - 8} fill={C.muted} fontSize={10} textAnchor="middle">
                {tickLabel(buckets[i], sameDay)}
              </text>
            ))}
            {visible.map((s) => (
              <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.width || 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {endLabels.map(({ s, yy }) => (
              <text key={s.key} x={pad.l + iw + 6} y={yy + 4} fill={C.text2} fontSize={10}>
                {s.label}
              </text>
            ))}
            {hover != null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={C.text2} strokeDasharray="3 3" />
                {visible.map((s) =>
                  s.values[hover] != null && Number.isFinite(s.values[hover]) ? (
                    <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke={C.card} strokeWidth={2} />
                  ) : null
                )}
              </g>
            )}
          </svg>
        )}
        {hover != null && buckets.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 4,
              left: x(hover) > width / 2 ? x(hover) - 230 : x(hover) + 12,
              width: 218,
              background: "#020617ee",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 11,
              color: C.text,
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            <div style={{ color: C.text2, marginBottom: 4 }}>{buckets[hover]}</div>
            {[...visible]
              .sort((a, b) => (b.values[hover] ?? -Infinity) - (a.values[hover] ?? -Infinity))
              .map((s) => (
                <div key={s.key} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden", whiteSpace: "nowrap" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: "none" }} />
                    {s.label}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {s.values[hover] == null ? "—" : `${yFormat(s.values[hover])}${unit}`}
                    {s.extra ? <span style={{ color: C.muted }}> {s.extra(hover)}</span> : null}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── table ───────────────────────────────────────────────────────────────────

function Table({ columns, rows, maxHeight = 360, empty = "No data" }) {
  const [sort, setSort] = useState(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const get = col?.sortValue || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.dir === "asc" ? 1 : -1);
    });
  }, [rows, sort, columns]);
  return (
    <div style={{ maxHeight, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 12 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                style={{
                  position: "sticky",
                  top: 0,
                  background: C.card2,
                  color: C.text2,
                  fontWeight: 600,
                  textAlign: c.align || "right",
                  padding: "7px 10px",
                  borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} style={{ padding: 16, textAlign: "center", color: C.muted }}>
                {empty}
              </td>
            </tr>
          )}
          {sorted.map((r, i) => (
            <tr key={r._key ?? i} style={{ borderBottom: `1px solid ${C.border}` }}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    padding: "6px 10px",
                    textAlign: c.align || "right",
                    color: C.text,
                    whiteSpace: "nowrap",
                    ...(c.style ? c.style(r) : {}),
                  }}
                >
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Red background for a worsening move; intensity scales with magnitude. */
const badCell = (badness, scale) => {
  if (badness == null || badness <= 0) return {};
  const a = Math.min(0.75, 0.12 + (badness / scale) * 0.6);
  return { background: `rgba(220, 38, 38, ${a.toFixed(2)})`, color: "#fff", fontWeight: 600 };
};
const goodText = (v) => (v != null && v < 0 ? { color: "#4ade80" } : {});

// ─── small UI bits ───────────────────────────────────────────────────────────

const btn = (variant = "default") => ({
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${variant === "primary" ? C.accent : variant === "danger" ? "#7f1d1d" : C.border}`,
  background: variant === "primary" ? C.accent : variant === "danger" ? "#450a0a" : C.card2,
  color: variant === "primary" ? "#111" : variant === "danger" ? "#fecaca" : C.text,
});
const selectStyle = { background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 };

function Seg({ value, options, onChange }) {
  return (
    <div style={{ display: "inline-flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: value === v ? "#1e3a5f" : C.card2,
            color: value === v ? "#fff" : C.text2,
            fontWeight: value === v ? 600 : 400,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const STATUS_STYLE = {
  idle: { label: "Not run", color: C.muted, icon: "○" },
  queued: { label: "Queued", color: C.text2, icon: "◷" },
  running: { label: "Running", color: "#38bdf8", icon: "⟳" },
  success: { label: "Done", color: C.good, icon: "✓" },
  failed: { label: "Failed", color: C.bad, icon: "✕" },
  cancelled: { label: "Stopped", color: C.warn, icon: "■" },
  "retry-wait": { label: "Retry queued", color: C.warn, icon: "↻" },
};

function StatusChip({ job, now }) {
  const st = STATUS_STYLE[job?.status || "idle"];
  let extra = "";
  if (job?.status === "running" && job.startedAt) extra = ` · ${fmtDur(now - job.startedAt)}`;
  if (job?.status === "running" && job.progress != null) extra += ` · ${job.progress}%`;
  if (job?.status === "retry-wait" && job.nextRetryAt) extra = ` · in ${fmtDur(Math.max(0, job.nextRetryAt - now))} (attempt ${job.attempt + 1})`;
  if (job?.status === "success" && job.elapsedMs) extra = ` · ${fmtDur(job.elapsedMs)}`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: st.color,
        border: `1px solid ${st.color}55`,
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{st.icon}</span>
      {st.label}
      {extra}
    </span>
  );
}

const ENGINE_BADGE = {
  trino: { label: "Trino · DWH", title: "Trino (DWH raw txns)", bg: "#1e1b4b", fg: "#a5b4fc" },
  redash: { label: "Redash · live", title: "Redash (live switch DB)", bg: "#052e16", fg: "#86efac" },
  looker: { label: "Trino · Looker daily", title: "Trino — day-level Looker table (complete days)", bg: "#3b0764", fg: "#e9d5ff" },
};
const EngineBadge = ({ engine }) => {
  const b = ENGINE_BADGE[engine] || ENGINE_BADGE.trino;
  return (
    <span
      title={b.title}
      style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: "2px 6px", borderRadius: 4, background: b.bg, color: b.fg, textTransform: "uppercase" }}
    >
      {b.label}
    </span>
  );
};

// ─── section card ────────────────────────────────────────────────────────────

function scheduleText(sched) {
  if (!sched) return null;
  if (sched.note) return sched.note;
  const r = sched.rule;
  const what = r?.type === "daily" ? `daily ${r.at.join(", ")}` : r?.type === "interval" ? `every ${r.everyMin} min` : "";
  const next = sched.nextAt ? new Date(sched.nextAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : null;
  return `auto-refresh ${what}${next ? ` · next ${next}` : ""}`;
}

function SectionCard({ id, job, result, cfg, duration, setDuration, now, onRun, onStop, onRetryNow, children, controls, sched, noView = false }) {
  const [view, setView] = useState(() => lsGet(`view:${id}`, "chart"));
  const [showSql, setShowSql] = useState(false);
  const [sql, setSql] = useState(null);
  useEffect(() => lsSet(`view:${id}`, view), [id, view]);
  const active = ACTIVE.has(job?.status);
  const plannedEngine = engineFor(duration, cfg, id);
  const stale = result && result.duration !== duration;

  const toggleSql = async () => {
    const next = !showSql;
    setShowSql(next);
    if (next) {
      try {
        setSql(job?.sql && active ? { rendered: job.sql, engine: job.engine } : await api(`/sql?section=${id}&duration=${duration}`));
      } catch (e) {
        setSql({ rendered: `-- ${e.message}` });
      }
    }
  };

  return (
    <section id={`mdash-${id}`} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16, scrollMarginTop: 70 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15, color: C.text, fontWeight: 700 }}>{SECTION_TITLES[id]}</h2>
        <StatusChip job={job} now={now} />
        <EngineBadge engine={active ? job.engine : plannedEngine} />
        <div style={{ marginLeft: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <select value={duration} onChange={(e) => setDuration(e.target.value)} style={selectStyle} aria-label="Duration">
            {Object.entries(durationLabels(id)).map(([k, l]) => (
              <option key={k} value={k}>
                Last {l}
              </option>
            ))}
          </select>
          {!noView && <Seg value={view} onChange={setView} options={[["chart", "Trend"], ["table", "Table"]]} />}
          <button type="button" style={btn()} onClick={toggleSql}>
            {showSql ? "Hide SQL" : "SQL"}
          </button>
          {job?.status === "retry-wait" && (
            <button type="button" style={btn()} onClick={onRetryNow}>
              Retry now
            </button>
          )}
          {active ? (
            <button type="button" style={btn("danger")} onClick={onStop}>
              ■ Stop
            </button>
          ) : (
            <button type="button" style={btn("primary")} onClick={onRun}>
              ⟳ Refresh
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11, color: C.muted, marginBottom: 10 }}>
        {result ? (
          <>
            <span>
              Data as of <b style={{ color: C.text2 }}>{fmtTime(result.ranAt)}</b>
            </span>
            <span>
              Window {result.window?.from?.slice(5, 16)} → {result.window?.to?.slice(5, 16)} IST · {result.window?.bucketMin >= 1440 ? "daily" : `${result.window?.bucketMin}-min buckets`}
            </span>
            <span>
              {result.engine} · {fmtDur(result.elapsedMs)} · {result.rows.length.toLocaleString()} rows
            </span>
            {(() => {
              // DWH tables lag (participants by hours) — flag when data stops short of the window.
              let last = result.rows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
              if (last.length === 10) last = `${last} 00:00`; // day-level rows
              const end = result.window?.to?.slice(0, 16);
              if (!last || !end) return null;
              const gapMin = (Date.parse(`${end.replace(" ", "T")}:00Z`) - Date.parse(`${last.replace(" ", "T")}:00Z`)) / 60000 - result.window.bucketMin;
              return gapMin >= result.window.bucketMin * 2 ? (
                <span style={{ color: C.warn }}>
                  ⚠ data ends at {last} — last ~{Math.round(gapMin / 60) || "<1"}h not yet in {result.engine === "trino" ? "DWH" : "source"}
                </span>
              ) : null;
            })()}
            {stale && <span style={{ color: C.warn }}>⚠ showing {labelFor(result.duration)} — refresh for {labelFor(duration)}</span>}
          </>
        ) : (
          <span>No cached data — press Refresh.</span>
        )}
        {job?.status === "running" && job.state && <span style={{ color: "#38bdf8" }}>{job.trigger === "schedule" ? "scheduled · " : ""}{job.state}</span>}
        {scheduleText(sched) && <span title="Backend refresh schedule — uses this section's default duration">⏱ {scheduleText(sched)}</span>}
      </div>

      {job?.error && ["failed", "retry-wait", "cancelled"].includes(job.status) && (
        <div
          role="alert"
          style={{
            background: job.status === "cancelled" ? "#422006" : "#450a0a",
            border: `1px solid ${job.status === "cancelled" ? "#854d0e" : "#7f1d1d"}`,
            color: job.status === "cancelled" ? "#fde68a" : "#fecaca",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            marginBottom: 10,
            wordBreak: "break-word",
          }}
        >
          <b>{job.status === "cancelled" ? "Stopped" : `Attempt ${job.attempt} failed`}:</b> {job.error}
          {job.status === "failed" && " — retries exhausted; press Refresh to run again."}
        </div>
      )}

      {showSql && (
        <pre
          style={{
            background: "#020617",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 10,
            fontSize: 11,
            color: "#cbd5e1",
            maxHeight: 280,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {sql ? `-- engine: ${sql.engine || ""}${sql.note ? `\n-- ${sql.note}` : ""}\n${sql.rendered}` : "Loading…"}
        </pre>
      )}

      {controls && <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10 }}>{controls}</div>}

      {result ? children(view) : null}
    </section>
  );
}

// ─── section bodies ──────────────────────────────────────────────────────────

function SrBody({ result, view, flow }) {
  const d = useMemo(() => shapeSr(result.rows, flow), [result, flow]);
  const overallSeries = [
    { key: "ALL", label: "Overall", color: SERIES[0], width: 2.5, values: d.overall.ALL.map((p) => pct(p.s, p.t)), extra: (i) => `(${fmtNum(d.overall.ALL[i].t)})` },
    { key: "P2P", label: "P2P", color: SERIES[1], values: d.overall.P2P.map((p) => pct(p.s, p.t)) },
    { key: "P2M", label: "P2M", color: SERIES[2], values: d.overall.P2M.map((p) => pct(p.s, p.t)) },
  ];
  const handleSeries = d.handles.map((h, i) => ({
    key: h,
    label: h.toUpperCase(),
    color: SERIES[i % SERIES.length],
    values: d.byHandle[h].map((p) => pct(p.s, p.t)),
    extra: (k) => `(${fmtNum(d.byHandle[h][k].t)})`,
  }));
  const yf = (v) => v.toFixed(1);

  if (view === "chart") {
    return (
      <>
        <LineChart title="Overall SR (all payer handles)" buckets={d.buckets} series={overallSeries} yFormat={yf} unit="%" />
        <LineChart title={`Payer-handle SR${flow !== "ALL" ? ` · ${flow}` : ""}`} buckets={d.buckets} series={handleSeries} yFormat={yf} unit="%" />
      </>
    );
  }
  const handleRows = d.handles.map((h) => {
    const f = d.handleFlow[h] || {};
    const A = f.ALL || {};
    const delta = A.et && A.rt ? pct(A.rs, A.rt) - pct(A.es, A.et) : null;
    return { _key: h, handle: h.toUpperCase(), vol: A.t, sr: pct(A.s, A.t), p2p: pct(f.P2P?.s, f.P2P?.t), p2pVol: f.P2P?.t, p2m: pct(f.P2M?.s, f.P2M?.t), p2mVol: f.P2M?.t, delta };
  });
  const tot = d.overall;
  const sum = (arr) => arr.reduce((a, p) => ({ t: a.t + p.t, s: a.s + p.s }), { t: 0, s: 0 });
  const [A, P, M] = [sum(tot.ALL), sum(tot.P2P), sum(tot.P2M)];
  handleRows.push({ _key: "__all", handle: "ALL", vol: A.t, sr: pct(A.s, A.t), p2p: pct(P.s, P.t), p2pVol: P.t, p2m: pct(M.s, M.t), p2mVol: M.t, delta: null });
  const bucketRows = d.buckets
    .map((b, i) => ({
      _key: b,
      ts: b,
      vol: tot.ALL[i].t,
      sr: pct(tot.ALL[i].s, tot.ALL[i].t),
      p2p: pct(tot.P2P[i].s, tot.P2P[i].t),
      p2m: pct(tot.P2M[i].s, tot.P2M[i].t),
      ...Object.fromEntries(d.handles.map((h) => [`h_${h}`, pct(d.byHandle[h][i].s, d.byHandle[h][i].t)])),
    }))
    .reverse();
  return (
    <>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, margin: "4px 0 6px" }}>Payer-handle summary (Δ = recent half vs earlier half of window)</div>
      <Table
        columns={[
          { key: "handle", label: "Payer handle", align: "left", render: (r) => <b>{r.handle}</b> },
          { key: "vol", label: "Txns", render: (r) => fmtNum(r.vol) },
          { key: "sr", label: "SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P SR", render: (r) => fmtPct(r.p2p) },
          { key: "p2pVol", label: "P2P txns", render: (r) => fmtNum(r.p2pVol) },
          { key: "p2m", label: "P2M SR", render: (r) => fmtPct(r.p2m) },
          { key: "p2mVol", label: "P2M txns", render: (r) => fmtNum(r.p2mVol) },
          { key: "delta", label: "Δ SR", render: (r) => fmtPp(r.delta), style: (r) => ({ ...badCell(r.delta == null ? null : -r.delta, 2), ...goodText(-r.delta) }) },
        ]}
        rows={handleRows}
      />
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, margin: "4px 0 6px" }}>Per bucket (latest first)</div>
      <Table
        columns={[
          { key: "ts", label: "Bucket (IST)", align: "left" },
          { key: "vol", label: "Txns", render: (r) => fmtNum(r.vol) },
          { key: "sr", label: "Overall SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P", render: (r) => fmtPct(r.p2p) },
          { key: "p2m", label: "P2M", render: (r) => fmtPct(r.p2m) },
          ...d.handles.map((h) => ({ key: `h_${h}`, label: h.toUpperCase(), render: (r) => fmtPct(r[`h_${h}`]) })),
        ]}
        rows={bucketRows}
      />
    </>
  );
}

function ErrorsBody({ result, view, cfg, metric, topN, visibleN, column, pivot }) {
  const n = topN || cfg.errorTopN;
  const d = useMemo(() => shapeErrors(result.rows, cfg.errorGrouping, n), [result, cfg.errorGrouping, n]);
  const maxDelta = Math.max(0.01, ...d.top.map((c) => c.delta || 0));
  if (view === "chart") {
    const series = d.top.map((c) => ({
      key: c.code,
      label: `${c.up ? "▲" : "▼"} ${c.code}`,
      color: c.color,
      width: c.up ? 2.5 : 1.5,
      dash: c.up ? undefined : "4 3",
      values: c.counts.map((n, i) => (metric === "pct" ? pct(n, d.total[i]) : n)),
      extra: (i) => (metric === "pct" ? `(${fmtNum(c.counts[i])})` : `(${fmtPct(pct(c.counts[i], d.total[i]))})`),
    }));
    return (
      <>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
          <span style={{ color: REDS[4] }}>▲ Red shades</span> = share of txns rose (deeper red = bigger rise); <span style={{ color: COOLS[2] }}>▼ dashed</span> = fell or flat. Compared: recent half vs earlier half of window.
        </div>
        <LineChart
          title={`Top ${d.top.length} ${column || cfg.errorColumn} codes · ${metric === "pct" ? "% of all txns" : "count"}${visibleN && d.top.length > visibleN ? ` — top ${visibleN} shown, click legend for more` : ""}`}
          buckets={d.buckets}
          series={series}
          initialHidden={visibleN ? d.top.slice(visibleN).map((c) => c.code) : undefined}
          yFormat={metric === "pct" ? (v) => v.toFixed(2) : (v) => fmtNum(v)}
          unit={metric === "pct" ? "%" : ""}
          height={300}
        />
        <LineChart
          title="Overall failure rate"
          buckets={d.buckets}
          series={[{ key: "f", label: "Failure %", color: SERIES[0], values: d.fail.map((f, i) => pct(f, d.total[i])) }]}
          yFormat={(v) => v.toFixed(2)}
          unit="%"
          height={160}
        />
      </>
    );
  }
  return (
    <Table
      columns={[
        { key: "code", label: "Error code", align: "left", render: (r) => <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: r.color, marginRight: 6 }} /><b>{r.code}</b></span> },
        { key: "n", label: "Failures", render: (r) => fmtNum(r.n) },
        { key: "share", label: "% of txns", render: (r) => fmtPct(r.share, 3) },
        { key: "early", label: "Earlier half", render: (r) => fmtPct(r.early, 3) },
        { key: "recent", label: "Recent half", render: (r) => fmtPct(r.recent, 3) },
        { key: "delta", label: "Δ share", render: (r) => (r.delta == null ? "—" : `${r.up ? "▲" : "▼"} ${r.delta > 0 ? "+" : ""}${r.delta.toFixed(3)} pp`), style: (r) => ({ ...badCell(r.delta, maxDelta), ...goodText(r.delta) }) },
        { key: "rel", label: "Δ %", render: (r) => (r.rel == null ? "—" : `${r.rel > 0 ? "+" : ""}${r.rel.toFixed(1)}%`), style: (r) => ({ ...badCell(r.rel, 100), ...goodText(r.rel) }) },
        // Per-period breakdown (latest first) when the window has few enough periods.
        ...(pivot && d.buckets.length <= 16
          ? [...d.buckets].reverse().map((b) => {
              const i = d.buckets.indexOf(b);
              return {
                key: `p_${b}`,
                label: tickLabel(b, d.buckets[0].slice(0, 10) === d.buckets[d.buckets.length - 1].slice(0, 10)),
                render: (r) => (metric === "pct" ? fmtPct(pct(r.counts[i], d.total[i]), 3) : fmtNum(r.counts[i])),
                sortValue: (r) => r.counts[i],
              };
            })
          : []),
      ]}
      rows={d.top.map((c) => ({ ...c, _key: c.code }))}
      empty="No failures in window"
    />
  );
}

function U09Body({ result, view, metric, split }) {
  const d = useMemo(() => shapeU09(result.rows), [result]);
  const val = (p) => (metric === "pct" ? pct(p.u, p.t) : p.u);
  const yf = metric === "pct" ? (v) => v.toFixed(3) : (v) => fmtNum(v);
  if (view === "chart") {
    const series = [
      { key: "all", label: "All handles", color: SERIES[0], width: 2.5, values: d.overall.map(val), extra: (i) => (metric === "pct" ? `(${fmtNum(d.overall[i].u)})` : `(${fmtPct(pct(d.overall[i].u, d.overall[i].t), 3)})`) },
      ...(split ? d.handles.map((h, i) => ({ key: h, label: h.toUpperCase(), color: SERIES[(i + 1) % SERIES.length], values: d.byHandle[h].map(val) })) : []),
    ];
    return <LineChart title={`U09 ${metric === "pct" ? "% of txns" : "count"}`} buckets={d.buckets} series={series} yFormat={yf} unit={metric === "pct" ? "%" : ""} height={280} />;
  }
  const rows = d.buckets
    .map((b, i) => ({
      _key: b,
      ts: b,
      t: d.overall[i].t,
      u: d.overall[i].u,
      p: pct(d.overall[i].u, d.overall[i].t),
      ...Object.fromEntries(d.handles.map((h) => [`h_${h}`, d.byHandle[h][i].u])),
    }))
    .reverse();
  const avg = rows.length ? rows.reduce((a, r) => a + (r.p || 0), 0) / rows.length : 0;
  return (
    <Table
      columns={[
        { key: "ts", label: "Bucket (IST)", align: "left" },
        { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
        { key: "u", label: "U09", render: (r) => fmtNum(r.u) },
        { key: "p", label: "U09 %", render: (r) => fmtPct(r.p, 3), style: (r) => badCell(r.p != null && avg ? r.p - avg * 1.2 : null, avg || 1) },
        ...d.handles.map((h) => ({ key: `h_${h}`, label: `${h.toUpperCase()} U09`, render: (r) => fmtNum(r[`h_${h}`]) })),
      ]}
      rows={rows}
    />
  );
}

// 15 fixed colours for the remitter-bank watchlist: the 8 categorical slots, then 7
// extra hues. Colour follows the bank's position in the watchlist, never its rank.
const BANK_COLORS = [...SERIES, "#0ea5e9", "#f472b6", "#a3e635", "#fb923c", "#2dd4bf", "#c084fc", "#facc15"];

function BankBody({ result, view, cfg, flow }) {
  const [q, setQ] = useState("");
  const [showOthers, setShowOthers] = useState(false);
  const [chartAll, setChartAll] = useState(false);
  const d = useMemo(() => shapeBank(result.rows, flow, cfg.bankTopN), [result, flow, cfg.bankTopN]);
  const watch = cfg.remitterBanks || [];
  const byCode = useMemo(() => new Map(d.list.map((b) => [b.bank, b])), [d]);
  const nameOf = (code) => watch.find((w) => w.code === code)?.name;

  if (view === "chart") {
    const present = watch.filter((w) => byCode.has(w.code));
    const series = present.map((w) => {
      const b = byCode.get(w.code);
      return {
        key: w.code,
        label: `${w.code} · ${w.name}`,
        color: BANK_COLORS[watch.indexOf(w) % BANK_COLORS.length],
        values: b.series.map((p) => pct(p.s, p.t)),
        extra: (k) => `(${fmtCompact(b.series[k].t)})`,
      };
    });
    const missing = watch.filter((w) => !byCode.has(w.code));
    return (
      <>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
          <Seg value={chartAll ? "all" : "8"} onChange={(v) => setChartAll(v === "all")} options={[["8", "First 8"], ["all", `All ${present.length}`]]} />
          <span style={{ fontSize: 11, color: C.muted }}>Click a legend entry to show / hide a bank.</span>
          {missing.length > 0 && <span style={{ fontSize: 11, color: C.warn }}>⚠ no data in window: {missing.map((w) => w.code).join(", ")}</span>}
        </div>
        <LineChart
          key={chartAll ? "all" : "8"}
          title={`SR — remitter banks (watchlist)${flow !== "ALL" ? ` · ${flow}` : ""}`}
          buckets={d.buckets}
          series={series}
          initialHidden={chartAll ? undefined : series.slice(8).map((x) => x.key)}
          yFormat={(v) => v.toFixed(1)}
          unit="%"
          height={320}
        />
      </>
    );
  }

  const toRow = (b, code, pinned) =>
    b
      ? { _key: code, code, name: nameOf(code), pinned, vol: b.ALL.t, sr: pct(b.ALL.s, b.ALL.t), p2p: pct(b.P2P.s, b.P2P.t), p2pVol: b.P2P.t, p2m: pct(b.P2M.s, b.P2M.t), p2mVol: b.P2M.t, delta: b.delta }
      : { _key: code, code, name: nameOf(code), pinned, missing: true };
  const watchCodes = new Set(watch.map((w) => w.code));
  const match = (r) => !q || r.code.includes(q.toUpperCase()) || (r.name || "").toLowerCase().includes(q.toLowerCase());
  const rows = [
    ...watch.map((w) => toRow(byCode.get(w.code), w.code, true)),
    ...(showOthers ? d.list.filter((b) => !watchCodes.has(b.bank)).map((b) => toRow(b, b.bank, false)) : []),
  ].filter(match);
  return (
    <>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter bank (code or name)" style={{ ...selectStyle, width: 220 }} />
        <label style={{ fontSize: 12, color: C.text2, display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} /> Also show other banks ({Math.max(0, d.list.length - watch.filter((w) => byCode.has(w.code)).length)})
        </label>
      </div>
      <Table
        maxHeight={520}
        columns={[
          {
            key: "code",
            label: "Remitter bank",
            align: "left",
            sortValue: (r) => r.name || r.code,
            render: (r) => (
              <span>
                {r.pinned && <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 6, background: BANK_COLORS[watch.findIndex((w) => w.code === r.code) % BANK_COLORS.length] }} />}
                <b>{r.name || r.code}</b>
                {r.name && <span style={{ color: C.muted }}> · {r.code}</span>}
              </span>
            ),
          },
          { key: "vol", label: "Txns", render: (r) => (r.missing ? <span style={{ color: C.warn }}>no data in window</span> : fmtNum(r.vol)) },
          { key: "sr", label: "Overall SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P SR", render: (r) => fmtPct(r.p2p) },
          { key: "p2pVol", label: "P2P txns", render: (r) => fmtNum(r.p2pVol) },
          { key: "p2m", label: "P2M SR", render: (r) => fmtPct(r.p2m) },
          { key: "p2mVol", label: "P2M txns", render: (r) => fmtNum(r.p2mVol) },
          { key: "delta", label: `Δ SR${flow !== "ALL" ? ` (${flow})` : ""}`, render: (r) => fmtPp(r.delta), style: (r) => ({ ...badCell(r.delta == null ? null : -r.delta, 3), ...goodText(-r.delta) }) },
        ]}
        rows={rows}
      />
    </>
  );
}

// ─── day-level sections (5–7) ────────────────────────────────────────────────

/** Section 5: wide rows {ts, ptyes, ptaxis, …} → per-handle count / share by day. */
function ShareBody({ result, view, metric }) {
  const d = useMemo(() => {
    const rows = [...result.rows].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ts" && rows.some((r) => Number(r[c]) > 0));
    // Fixed handle order so colours follow the handle, not its rank.
    const order = ["ptyes", "ptaxis", "pthdfc", "ptsbi", "paytm"];
    cols.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const days = rows.map((r) => r.ts);
    const totals = rows.map((r) => cols.reduce((a, c) => a + (Number(r[c]) || 0), 0));
    return { rows, cols, days, totals };
  }, [result]);
  const val = (r, i, c) => (metric === "share" ? pct(Number(r[c]) || 0, d.totals[i]) : Number(r[c]) || 0);
  if (view === "chart") {
    const series = d.cols.map((c, k) => ({
      key: c,
      label: c.toUpperCase(),
      color: SERIES[k % SERIES.length],
      values: d.rows.map((r, i) => val(r, i, c)),
      extra: (i) => (metric === "share" ? `(${fmtCompact(Number(d.rows[i][c]) || 0)})` : `(${fmtPct(pct(Number(d.rows[i][c]) || 0, d.totals[i]))})`),
    }));
    return (
      <>
        <LineChart
          title={metric === "share" ? "% share of Paytm txns by payer handle" : "Txn count by payer handle"}
          buckets={d.days}
          series={series}
          yFormat={metric === "share" ? (v) => v.toFixed(1) : fmtCompact}
          unit={metric === "share" ? "%" : ""}
          height={280}
        />
        {metric === "count" && (
          <LineChart title="Total txns (all handles)" buckets={d.days} series={[{ key: "t", label: "Total", color: SERIES[0], values: d.totals }]} yFormat={fmtCompact} height={150} />
        )}
      </>
    );
  }
  // Table: one row per day, DoD change; a fall in share / count is tinted red.
  const rows = d.rows
    .map((r, i) => {
      const o = { _key: r.ts, ts: r.ts, total: d.totals[i], totalDod: i ? pct(d.totals[i] - d.totals[i - 1], d.totals[i - 1]) : null };
      for (const c of d.cols) {
        o[c] = val(r, i, c);
        const prev = i ? val(d.rows[i - 1], i - 1, c) : null;
        o[`${c}_d`] = prev == null ? null : metric === "share" ? o[c] - prev : pct(o[c] - prev, prev);
      }
      return o;
    })
    .reverse();
  const fmtV = metric === "share" ? (v) => fmtPct(v) : fmtNum;
  const fmtD = (v) => (v == null ? "" : metric === "share" ? ` (${v > 0 ? "+" : ""}${v.toFixed(2)} pp)` : ` (${v > 0 ? "+" : ""}${v.toFixed(1)}%)`);
  return (
    <Table
      columns={[
        { key: "ts", label: "Day", align: "left" },
        { key: "total", label: "Total txns", render: (r) => <>{fmtNum(r.total)}<span style={{ color: C.muted }}>{r.totalDod == null ? "" : ` (${r.totalDod > 0 ? "+" : ""}${r.totalDod.toFixed(1)}%)`}</span></> },
        ...d.cols.map((c) => ({
          key: c,
          label: `${c.toUpperCase()} ${metric === "share" ? "share" : "txns"} (DoD)`,
          render: (r) => (
            <>
              {fmtV(r[c])}
              <span style={{ opacity: 0.85 }}>{fmtD(r[`${c}_d`])}</span>
            </>
          ),
          style: (r) => badCell(r[`${c}_d`] == null ? null : -r[`${c}_d`], metric === "share" ? 1 : 10),
        })),
      ]}
      rows={rows}
    />
  );
}

/** Aggregate day rows into grain periods: key -> group -> {t, s, days:Set}. */
function rollup(rows, grain, groupOf) {
  const periods = new Map();
  for (const r of rows) {
    const g = groupOf(r);
    if (g == null) continue;
    const k = periodKey(r.ts, grain);
    if (!periods.has(k)) periods.set(k, { days: new Set(), groups: {} });
    const p = periods.get(k);
    p.days.add(r.ts);
    const a = (p.groups[g] ||= { t: 0, s: 0 });
    a.t += r.total;
    a.s += r.success;
  }
  const keys = [...periods.keys()].sort();
  return { keys, periods };
}

const GRAIN_NAME = { day: "DoD", week: "WoW", month: "MoM" };

function FlowSrBody({ result, view, grain, lite }) {
  const flows = lite ? ["P2P", "P2M", "LITE"] : ["P2P", "P2M"];
  const { keys, periods } = useMemo(() => rollup(result.rows, grain, (r) => r.flow), [result, grain]);
  const sr = (k, f) => {
    const a = periods.get(k).groups[f];
    return a ? pct(a.s, a.t) : null;
  };
  if (view === "chart") {
    const series = flows.map((f, i) => ({
      key: f,
      label: f,
      color: SERIES[i],
      width: 2.5,
      values: keys.map((k) => sr(k, f)),
      extra: (j) => `(${fmtCompact(periods.get(keys[j]).groups[f]?.t || 0)})`,
    }));
    return <LineChart title={`Success rate by flow · ${grain}`} buckets={keys} series={series} yFormat={(v) => v.toFixed(2)} unit="%" height={280} />;
  }
  const expected = grain === "month" ? null : grain === "week" ? 7 : 1;
  const rows = keys
    .map((k, i) => {
      const o = { _key: k, k, days: periods.get(k).days.size };
      o.partial = expected ? o.days < expected : Number(k.slice(5, 7)) && o.days < new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0)).getUTCDate();
      for (const f of flows) {
        o[f] = sr(k, f);
        o[`${f}_t`] = periods.get(k).groups[f]?.t;
        o[`${f}_d`] = i && o[f] != null && sr(keys[i - 1], f) != null ? o[f] - sr(keys[i - 1], f) : null;
      }
      return o;
    })
    .reverse();
  return (
    <Table
      columns={[
        { key: "k", label: grain === "month" ? "Month" : grain === "week" ? "Week of" : "Day", align: "left", render: (r) => <>{r.k.replace(/^W /, "")}{r.partial ? <span style={{ color: C.warn }} title="Incomplete period"> · {r.days}d</span> : null}</> },
        ...flows.flatMap((f) => [
          { key: f, label: `${f} SR`, render: (r) => fmtPct(r[f]) },
          { key: `${f}_d`, label: `${f} ${GRAIN_NAME[grain]}`, render: (r) => fmtPp(r[`${f}_d`]), style: (r) => ({ ...badCell(r[`${f}_d`] == null ? null : -r[`${f}_d`], 1), ...goodText(-r[`${f}_d`]) }) },
          { key: `${f}_t`, label: `${f} txns`, render: (r) => fmtNum(r[`${f}_t`]) },
        ]),
      ]}
      rows={rows}
    />
  );
}

const INSTRUMENT_ORDER = ["SAVINGS", "CURRENT", "CREDIT", "CREDITLINE", "UPI_LITE", "Others"];

function InstrumentBody({ result, view, grain }) {
  const d = useMemo(() => {
    const found = [...new Set(result.rows.map((r) => r.instrument))];
    const instruments = [...INSTRUMENT_ORDER.filter((x) => found.includes(x)), ...found.filter((x) => !INSTRUMENT_ORDER.includes(x)).sort()];
    const byFlow = Object.fromEntries(["P2P", "P2M"].map((f) => [f, rollup(result.rows.filter((r) => r.flow === f), grain, (r) => r.instrument)]));
    return { instruments, byFlow };
  }, [result, grain]);
  const color = (inst) => SERIES[d.instruments.indexOf(inst) % SERIES.length];
  if (view === "chart") {
    return (
      <>
        {["P2P", "P2M"].map((f) => {
          const { keys, periods } = d.byFlow[f];
          // Skip near-empty instruments for this flow (e.g. CREDIT on P2P) — noise, not signal.
          const vol = (inst) => keys.reduce((a, k) => a + (periods.get(k).groups[inst]?.t || 0), 0);
          const totalVol = d.instruments.reduce((a, inst) => a + vol(inst), 0);
          const series = d.instruments
            .filter((inst) => vol(inst) > totalVol * 0.0005)
            .map((inst) => ({
              key: inst,
              label: inst,
              color: color(inst),
              values: keys.map((k) => {
                const a = periods.get(k).groups[inst];
                return a ? pct(a.s, a.t) : null;
              }),
              extra: (j) => `(${fmtCompact(periods.get(keys[j]).groups[inst]?.t || 0)})`,
            }));
          return <LineChart key={f} title={`${f} — success rate by payer instrument · ${grain}`} buckets={keys} series={series} yFormat={(v) => v.toFixed(1)} unit="%" height={260} />;
        })}
      </>
    );
  }
  // Table: instrument × flow over the whole window, Δ = latest period vs previous.
  const rows = d.instruments.map((inst) => {
    const o = { _key: inst, inst };
    for (const f of ["P2P", "P2M"]) {
      const { keys, periods } = d.byFlow[f];
      let t = 0;
      let sc = 0;
      keys.forEach((k) => {
        const a = periods.get(k).groups[inst];
        if (a) {
          t += a.t;
          sc += a.s;
        }
      });
      const at = (k) => (k && periods.get(k).groups[inst] ? pct(periods.get(k).groups[inst].s, periods.get(k).groups[inst].t) : null);
      const last = at(keys[keys.length - 1]);
      const prev = at(keys[keys.length - 2]);
      o[f] = t ? pct(sc, t) : null;
      o[`${f}_t`] = t || null;
      o[`${f}_last`] = last;
      o[`${f}_d`] = last != null && prev != null ? last - prev : null;
    }
    return o;
  });
  return (
    <Table
      columns={[
        { key: "inst", label: "Payer instrument", align: "left", render: (r) => <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color(r.inst), marginRight: 6 }} /><b>{r.inst}</b></span> },
        ...["P2P", "P2M"].flatMap((f) => [
          { key: f, label: `${f} SR (window)`, render: (r) => fmtPct(r[f]) },
          { key: `${f}_last`, label: `${f} SR latest ${grain}`, render: (r) => fmtPct(r[`${f}_last`]) },
          { key: `${f}_d`, label: `${f} ${GRAIN_NAME[grain]}`, render: (r) => fmtPp(r[`${f}_d`]), style: (r) => ({ ...badCell(r[`${f}_d`] == null ? null : -r[`${f}_d`], 2), ...goodText(-r[`${f}_d`]) }) },
          { key: `${f}_t`, label: `${f} txns`, render: (r) => fmtNum(r[`${f}_t`]) },
        ]),
      ]}
      rows={rows}
    />
  );
}

/**
 * Sections 8 & 9: success rate per group (payee PSP / payer bank) over time.
 * Chart: top `chartN` groups by volume visible, rest toggle-able. Table: top `topN`
 * groups × periods pivot (latest first) with change vs previous period; drops tinted red.
 */
function GroupSrBody({ result, view, groupKey, groupLabel, topN = 25, chartN = 8 }) {
  const d = useMemo(() => {
    const buckets = [...new Set(result.rows.map((r) => r.ts))].sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const groups = new Map();
    for (const r of result.rows) {
      const g = r[groupKey] ?? "(none)";
      if (!groups.has(g)) groups.set(g, { g, t: 0, s: 0, series: buckets.map(() => ({ t: 0, s: 0 })) });
      const a = groups.get(g);
      a.t += r.total;
      a.s += r.success;
      const p = a.series[idx.get(r.ts)];
      p.t += r.total;
      p.s += r.success;
    }
    const all = [...groups.values()].sort((a, b) => b.t - a.t);
    const overall = buckets.map((_, i) => all.reduce((acc, a) => ({ t: acc.t + a.series[i].t, s: acc.s + a.series[i].s }), { t: 0, s: 0 }));
    return { buckets, top: all.slice(0, topN), count: all.length, overall };
  }, [result, groupKey, topN]);
  const sameDay = d.buckets.length && d.buckets[0].slice(0, 10) === d.buckets[d.buckets.length - 1].slice(0, 10);

  if (view === "chart") {
    const series = [
      { key: "__all", label: "Overall", color: "#e2e8f0", width: 2.5, dash: "5 3", values: d.overall.map((p) => pct(p.s, p.t)), extra: (i) => `(${fmtCompact(d.overall[i].t)})` },
      ...d.top.map((a, i) => ({
        key: a.g,
        label: a.g,
        color: SERIES[i % SERIES.length],
        values: a.series.map((p) => pct(p.s, p.t)),
        extra: (k) => `(${fmtCompact(a.series[k].t)})`,
      })),
    ];
    return (
      <LineChart
        title={`SR by ${groupLabel} — top ${Math.min(chartN, d.top.length)} by volume shown${d.top.length > chartN ? `, ${d.top.length - chartN} more in legend` : ""}`}
        buckets={d.buckets}
        series={series}
        initialHidden={d.top.slice(chartN).map((a) => a.g)}
        yFormat={(v) => v.toFixed(1)}
        unit="%"
        height={320}
      />
    );
  }
  const periods = d.buckets.length <= 16 ? [...d.buckets].reverse() : d.buckets.slice(-16).reverse();
  const L = d.buckets.length;
  const rows = d.top.map((a) => {
    const last = L ? pct(a.series[L - 1].s, a.series[L - 1].t) : null;
    const prev = L > 1 ? pct(a.series[L - 2].s, a.series[L - 2].t) : null;
    return { _key: a.g, g: a.g, t: a.t, sr: pct(a.s, a.t), delta: last != null && prev != null ? last - prev : null, a };
  });
  return (
    <>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Top {d.top.length} of {d.count} {groupLabel}s by volume · Δ = latest period vs previous · red cell = SR fell vs previous period
      </div>
      <Table
        maxHeight={480}
        columns={[
          { key: "g", label: groupLabel, align: "left", render: (r) => <b>{r.g}</b> },
          { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
          { key: "sr", label: "SR (window)", render: (r) => fmtPct(r.sr) },
          { key: "delta", label: "Δ latest", render: (r) => fmtPp(r.delta), style: (r) => ({ ...badCell(r.delta == null ? null : -r.delta, 2), ...goodText(-r.delta) }) },
          ...periods.map((b) => {
            const i = d.buckets.indexOf(b);
            const at = (r, k) => (k >= 0 && r.a.series[k].t ? pct(r.a.series[k].s, r.a.series[k].t) : null);
            return {
              key: `p_${b}`,
              label: tickLabel(b, sameDay),
              render: (r) => fmtPct(at(r, i)),
              sortValue: (r) => at(r, i),
              style: (r) => {
                const cur = at(r, i);
                const prv = at(r, i - 1);
                return cur != null && prv != null ? badCell(prv - cur - 0.25, 3) : {};
              },
            };
          }),
        ]}
        rows={rows}
      />
    </>
  );
}

// ─── config page ─────────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: C.text2 }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: C.muted }}>{hint}</span>}
    </label>
  );
}

function Panel({ title, children, actions }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15, color: C.text }}>{title}</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
      </div>
      {children}
    </section>
  );
}

function ConfigPage({ state, now, durations, onRun, onStop, onRetryNow, reload }) {
  const cfg = state.config;
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(cfg)));
  const [msg, setMsg] = useState(null);
  const [conn, setConn] = useState(null);
  const [connBusy, setConnBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [history, setHistory] = useState([]);
  const [qSec, setQSec] = useState("sr");
  const [qEngine, setQEngine] = useState("trino");
  const [qInfo, setQInfo] = useState(null);
  const [qEdit, setQEdit] = useState("");

  useEffect(() => setDraft(JSON.parse(JSON.stringify(cfg))), [cfg]);

  const loadHistory = useCallback(() => api("/history").then((r) => setHistory(r.history)).catch(() => {}), []);
  useEffect(() => {
    loadHistory();
  }, [loadHistory, state.jobs]);

  const loadSql = useCallback(async () => {
    try {
      const engines = enginesFor(qSec);
      const eng = engines.includes(qEngine) ? qEngine : engines[0];
      const keys = (DURATION_OPTS[qSec] || []).filter((o) => o.kind === (eng === "looker" ? "daily" : "intraday")).map((o) => o.key);
      // Pick a sample window the engine would actually serve.
      const dur = eng === "redash" ? keys[0] : keys[keys.length - 1] || "";
      const info = await api(`/sql?section=${qSec}&duration=${dur}&engine=${eng}`);
      setQInfo(info);
      setQEdit(info.template);
    } catch (e) {
      setQInfo({ rendered: `-- ${e.message}` });
    }
  }, [qSec, qEngine]);
  useEffect(() => {
    loadSql();
  }, [loadSql, cfg]);

  const save = async (patch) => {
    setMsg(null);
    try {
      await api("/config", { method: "PUT", body: patch });
      setMsg({ ok: true, text: "Saved." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const testConn = async () => {
    setConnBusy(true);
    try {
      setConn(await api("/connectivity"));
    } catch (e) {
      setConn({ error: e.message });
    } finally {
      setConnBusy(false);
    }
  };
  const checkFresh = async () => {
    setFresh({ loading: true });
    try {
      setFresh(await api("/freshness"));
    } catch (e) {
      setFresh({ error: e.message });
    }
  };

  const set = (path, value) =>
    setDraft((d) => {
      const n = JSON.parse(JSON.stringify(d));
      const keys = path.split(".");
      let o = n;
      keys.slice(0, -1).forEach((k) => (o = o[k] ||= {}));
      o[keys[keys.length - 1]] = value;
      return n;
    });

  const input = { ...selectStyle, padding: "6px 8px" };
  const numField = (path, label, hint) => {
    const v = path.split(".").reduce((o, k) => o?.[k], draft);
    return (
      <Field label={label} hint={hint}>
        <input type="number" style={input} value={v ?? ""} onChange={(e) => set(path, e.target.value === "" ? "" : Number(e.target.value))} />
      </Field>
    );
  };

  const connRow = (name, c) =>
    c ? (
      <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
        <b style={{ color: c.ok ? C.good : C.bad }}>{c.ok ? "✓ Connected" : "✕ Not OK"}</b> · <b>{name}</b> {c.host ? `(${c.host})` : ""} · {c.latencyMs} ms
        {c.error && <div style={{ color: "#fecaca", marginTop: 2 }}>{c.error}</div>}
        {c.dataSources && (
          <div style={{ color: C.text2, marginTop: 2 }}>
            Data sources: {c.dataSources.map((d) => `${d.id} ${d.found ? `= ${d.name}${d.paused ? " (paused)" : ""}` : "(not found)"}`).join(", ")}
          </div>
        )}
      </div>
    ) : null;

  return (
    <div>
      <Panel
        title="Query control"
        actions={
          <>
            <button type="button" style={btn("primary")} onClick={() => onRun(SECTION_IDS)}>
              ⟳ Refresh all
            </button>
            <button type="button" style={btn("danger")} onClick={() => onStop(SECTION_IDS)}>
              ■ Stop all
            </button>
          </>
        }
      >
        <Table
          maxHeight={300}
          columns={[
            { key: "id", label: "Section", align: "left", render: (r) => SECTION_TITLES[r.id] },
            { key: "status", label: "Status", align: "left", render: (r) => <StatusChip job={r.job} now={now} /> },
            { key: "dur", label: "Duration", render: (r) => labelFor(r.job.duration || durations[r.id]) },
            { key: "eng", label: "Engine", render: (r) => r.job.engine || engineFor(durations[r.id], cfg, r.id) },
            { key: "att", label: "Attempt", render: (r) => r.job.attempt || "—" },
            { key: "last", label: "Last success", render: (r) => fmtTime(state.results[r.id]?.ranAt) },
            {
              key: "act",
              label: "",
              render: (r) => (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {r.job.status === "retry-wait" && (
                    <button type="button" style={btn()} onClick={() => onRetryNow(r.id)}>
                      Retry now
                    </button>
                  )}
                  {ACTIVE.has(r.job.status) ? (
                    <button type="button" style={btn("danger")} onClick={() => onStop([r.id])}>
                      Stop
                    </button>
                  ) : (
                    <button type="button" style={btn()} onClick={() => onRun([r.id])}>
                      Refresh
                    </button>
                  )}
                </span>
              ),
            },
          ]}
          rows={SECTION_IDS.map((id) => ({ _key: id, id, job: state.jobs[id] || {} }))}
        />
        {SECTION_IDS.some((id) => state.jobs[id]?.error) && (
          <div style={{ fontSize: 12, color: "#fecaca" }}>
            {SECTION_IDS.filter((id) => state.jobs[id]?.error).map((id) => (
              <div key={id}>
                <b>{id}:</b> {state.jobs[id].error}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            style={btn()}
            onClick={async () => {
              if (window.confirm("Clear all cached dashboard results? Sections will be empty until refreshed.")) {
                await api("/cache/clear", { method: "POST" });
                reload();
              }
            }}
          >
            Clear cached results
          </button>
        </div>
      </Panel>

      <SchedulePanel cfg={cfg} schedule={state.schedule} reload={reload} />

      <Panel
        title="Connectivity"
        actions={
          <>
            <button type="button" style={btn()} onClick={testConn} disabled={connBusy}>
              {connBusy ? "Testing…" : "Test connections"}
            </button>
            <button type="button" style={btn()} onClick={checkFresh}>
              Check DWH freshness
            </button>
          </>
        }
      >
        {!conn && !fresh && <div style={{ fontSize: 12, color: C.muted }}>Not checked yet.</div>}
        {conn?.error && <div style={{ color: "#fecaca", fontSize: 12 }}>{conn.error}</div>}
        {connRow("Trino (DWH)", conn?.trino)}
        {connRow("Redash", conn?.redash)}
        {conn?.redash?.available && (
          <details style={{ fontSize: 11, color: C.text2 }}>
            <summary style={{ cursor: "pointer" }}>Available Redash data sources</summary>
            {conn.redash.available.map((d) => `${d.id}: ${d.name} (${d.type})`).join(" · ")}
          </details>
        )}
        {fresh && (
          <div style={{ fontSize: 12, color: C.text, marginTop: 8 }}>
            {fresh.loading
              ? "Checking DWH freshness…"
              : fresh.error
                ? <span style={{ color: "#fecaca" }}>{fresh.error}</span>
                : <>DWH latest txn: <b>{fresh.trinoMaxCreatedOn || "none"}</b> · now (IST) {fresh.nowIst} — buckets after the latest txn will read low on Trino.</>}
          </div>
        )}
      </Panel>

      <Panel
        title="Settings"
        actions={
          <>
            <button
              type="button"
              style={btn()}
              onClick={async () => {
                if (window.confirm("Reset all settings (including SQL overrides) to defaults?")) {
                  await api("/config/reset", { method: "POST" });
                  reload();
                }
              }}
            >
              Reset defaults
            </button>
            <button
              type="button"
              style={btn("primary")}
              onClick={() =>
                save({
                  ...draft,
                  remitterBanks:
                    typeof draft.remitterBanks === "string"
                      ? draft.remitterBanks
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean)
                          .map((l) => {
                            const [code, ...rest] = l.split("=");
                            return { code: code.trim().toUpperCase(), name: rest.join("=").trim() || code.trim().toUpperCase() };
                          })
                      : draft.remitterBanks,
                  handles: (Array.isArray(draft.handles) ? draft.handles : String(draft.handles).split(","))
                    .map((h) => h.trim().toLowerCase())
                    .filter(Boolean),
                  redash: {
                    ...draft.redash,
                    dataSourceIds: (Array.isArray(draft.redash.dataSourceIds) ? draft.redash.dataSourceIds : String(draft.redash.dataSourceIds).split(","))
                      .map((n) => Number(String(n).trim()))
                      .filter((n) => n > 0),
                  },
                })
              }
            >
              Save settings
            </button>
          </>
        }
      >
        {msg && <div style={{ fontSize: 12, marginBottom: 10, color: msg.ok ? C.good : "#fecaca" }}>{msg.text}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
          <Field label="Payer handles" hint="Comma-separated">
            <input style={input} value={Array.isArray(draft.handles) ? draft.handles.join(", ") : draft.handles} onChange={(e) => set("handles", e.target.value)} />
          </Field>
          <Field label="Default duration">
            <select style={input} value={draft.defaultDuration} onChange={(e) => set("defaultDuration", e.target.value)}>
              {Object.entries(DURATION_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {SECTION_IDS.map((id) => (
            <Field key={id} label={`${SECTION_TITLES[id]} — duration`} hint={hasKind(id, "daily") ? (hasKind(id, "intraday") ? "≤ 1 day: raw txns · > 1 day: Looker daily" : "Looker daily (Trino)") : "Blank = default duration"}>
              <select style={input} value={draft.sectionDurations?.[id] || ""} onChange={(e) => set(`sectionDurations.${id}`, e.target.value || undefined)}>
                <option value="">(default)</option>
                {Object.entries(durationLabels(id)).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {numField("redashMaxMinutes", "Redash up to (minutes)", "Windows ≤ this use Redash (live), longer use Trino")}
          {numField("maxParallel", "Parallel queries", "Sections run at once")}
          <Field label="Auto-retry failed queries" hint="Failed sections re-run one at a time from a queue">
            <select style={input} value={draft.autoRetry ? "1" : "0"} onChange={(e) => set("autoRetry", e.target.value === "1")}>
              <option value="1">On</option>
              <option value="0">Off</option>
            </select>
          </Field>
          {numField("maxRetries", "Max retries")}
          {numField("retryDelaySec", "Retry delay (s)")}
          {numField("trinoTimeoutSec", "Trino timeout (s)")}
          {numField("redashTimeoutSec", "Redash timeout per chunk (s)")}
          <Field label="Redash URL" hint="Blank = PTYES_REDASH_URL. API key comes from .env (never stored here)">
            <input style={input} value={draft.redash?.url || ""} placeholder="(from PTYES_REDASH_URL)" onChange={(e) => set("redash.url", e.target.value)} />
          </Field>
          <Field label="Redash data source IDs" hint="Comma-separated; results from all are summed (shards)">
            <input style={input} value={Array.isArray(draft.redash?.dataSourceIds) ? draft.redash.dataSourceIds.join(", ") : draft.redash?.dataSourceIds} onChange={(e) => set("redash.dataSourceIds", e.target.value)} />
          </Field>
          {numField("redash.chunkMinutes", "Redash chunk (min)", "Window split into chunks to stay under Redash timeouts")}
          {numField("redash.chunkParallel", "Redash chunks in parallel", "Keep low — live switch DB")}
          {numField("redashEndLagMinutes", "Redash end lag (min)", "Skip newest minutes so PENDING txns settle")}
          <Field label="Error code column">
            <select style={input} value={draft.errorColumn} onChange={(e) => set("errorColumn", e.target.value)}>
              <option value="app_resp_code">app_resp_code</option>
              <option value="npci_resp_code">npci_resp_code</option>
            </select>
          </Field>
          <Field label="Error code grouping" hint="Prefix: U30-Z9 → U30">
            <select style={input} value={draft.errorGrouping} onChange={(e) => set("errorGrouping", e.target.value)}>
              <option value="full">Full code</option>
              <option value="prefix">Prefix only</option>
            </select>
          </Field>
          {numField("errorTopN", "Top N error codes")}
          <Field label="U09 match (SQL LIKE)" hint="Matches app_resp_code or npci_resp_code">
            <input style={input} value={draft.u09Pattern} onChange={(e) => set("u09Pattern", e.target.value)} />
          </Field>
          {numField("bankTopN", "Banks in trend chart")}
          <Field label="Section 4 remitter banks" hint="One per line: IFSC prefix = name (e.g. SBIN = State Bank of India)">
            <textarea
              style={{ ...input, minHeight: 150, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 }}
              value={typeof draft.remitterBanks === "string" ? draft.remitterBanks : (draft.remitterBanks || []).map((b) => `${b.code} = ${b.name}`).join("\n")}
              onChange={(e) => set("remitterBanks", e.target.value)}
            />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 6 }}>Bucket size per duration (minutes)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {Object.keys(DURATION_LABELS).map((k) => (
              <label key={k} style={{ fontSize: 11, color: C.text2, display: "flex", flexDirection: "column", gap: 3 }}>
                {DURATION_LABELS[k]}
                <input type="number" style={{ ...input, width: 70 }} value={draft.bucketMinutes?.[k] ?? ""} onChange={(e) => set(`bucketMinutes.${k}`, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="Queries"
        actions={
          <>
            <select style={selectStyle} value={qSec} onChange={(e) => setQSec(e.target.value)}>
              {SECTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {SECTION_TITLES[id]}
                </option>
              ))}
            </select>
            {enginesFor(qSec).length === 1 ? (
              <span style={{ fontSize: 12, color: C.text2 }}>{ENGINE_NAME[enginesFor(qSec)[0]]} only</span>
            ) : (
              <Seg value={enginesFor(qSec).includes(qEngine) ? qEngine : enginesFor(qSec)[0]} onChange={setQEngine} options={enginesFor(qSec).map((e) => [e, ENGINE_NAME[e]])} />
            )}
          </>
        }
      >
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
          Template {qInfo?.overridden ? <b style={{ color: C.warn }}>(custom override)</b> : "(default)"}. Placeholders: {"{{FROM}} {{TO}} {{FROM_DATE}} {{FROM_PAD}} {{TO_PAD}} {{BUCKET}} {{HANDLES}} {{ERROR_COL}} {{U09_PATTERN}}"}
          {qInfo?.engine === "looker" ? " {{TO_DATE}} (exclusive)" : ""}{qInfo?.engine === "redash" ? " {{TI_ID_FROM}} {{TI_ID_TO}} {{TP_ID_FROM}} {{TP_ID_TO}}" : ""}. Output columns must stay the same.
        </div>
        <textarea
          value={qEdit}
          onChange={(e) => setQEdit(e.target.value)}
          spellCheck={false}
          style={{ width: "100%", minHeight: 260, background: "#020617", color: "#cbd5e1", border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11, boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 8, margin: "8px 0 12px", flexWrap: "wrap" }}>
          <button type="button" style={btn("primary")} onClick={() => save({ sqlOverrides: { ...(cfg.sqlOverrides || {}), [qSec]: { ...(cfg.sqlOverrides?.[qSec] || {}), [qInfo?.engine || qEngine]: qEdit } } })}>
            Save override
          </button>
          <button
            type="button"
            style={btn()}
            onClick={() => {
              const next = JSON.parse(JSON.stringify(cfg.sqlOverrides || {}));
              if (next[qSec]) delete next[qSec][qInfo?.engine || qEngine];
              save({ sqlOverrides: next });
            }}
          >
            Reset to default
          </button>
        </div>
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: C.text2 }}>Rendered SQL ({qInfo?.duration} sample window{qInfo?.window ? `: ${qInfo.window.from} → ${qInfo.window.to}` : ""})</summary>
          <pre style={{ background: "#020617", border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: "#cbd5e1", whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
            {qInfo?.note ? `-- ${qInfo.note}\n` : ""}
            {qInfo?.rendered}
          </pre>
        </details>
      </Panel>

      <Panel title="Run history" actions={<button type="button" style={btn()} onClick={loadHistory}>Reload</button>}>
        <Table
          maxHeight={320}
          empty="No runs since backend start"
          columns={[
            { key: "at", label: "Finished", align: "left", render: (r) => fmtTime(r.at) },
            { key: "section", label: "Section", align: "left" },
            { key: "trigger", label: "Trigger", align: "left", render: (r) => r.trigger || "manual" },
            { key: "engine", label: "Engine", align: "left" },
            { key: "duration", label: "Duration", align: "left" },
            { key: "attempt", label: "Attempt" },
            { key: "status", label: "Status", align: "left", render: (r) => <span style={{ color: r.status === "success" ? C.good : r.status === "cancelled" ? C.warn : C.bad }}>{r.status}</span> },
            { key: "elapsedMs", label: "Took", render: (r) => fmtDur(r.elapsedMs) },
            { key: "rows", label: "Rows", render: (r) => r.rows ?? "—" },
            { key: "error", label: "Error", align: "left", render: (r) => <span title={r.error} style={{ color: "#fecaca" }}>{r.error ? r.error.slice(0, 80) : ""}</span> },
          ]}
          rows={history.map((h, i) => ({ ...h, _key: i }))}
        />
      </Panel>
    </div>
  );
}

function SchedulePanel({ cfg, schedule, reload }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(cfg.schedule || {})));
  const [msg, setMsg] = useState(null);
  useEffect(() => setDraft(JSON.parse(JSON.stringify(cfg.schedule || {}))), [cfg.schedule]);
  const input = { ...selectStyle, padding: "5px 8px" };
  const setRule = (id, patch) => setDraft((d) => ({ ...d, rules: { ...(d.rules || {}), [id]: { ...(d.rules?.[id] || {}), ...patch } } }));
  const save = async () => {
    setMsg(null);
    try {
      await api("/config", { method: "PUT", body: { schedule: draft } });
      setMsg({ ok: true, text: "Schedule saved." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  return (
    <Panel
      title="Refresh schedule"
      actions={
        <button type="button" style={btn("primary")} onClick={save}>
          Save schedule
        </button>
      }
    >
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
        Runs on the backend (IST) with each section&apos;s default duration — opening the page never runs a query. Redash windows are never scheduled. A
        manual run with another duration stays until the next slot / interval.
      </div>
      {msg && <div style={{ fontSize: 12, marginBottom: 8, color: msg.ok ? C.good : "#fecaca" }}>{msg.text}</div>}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 12, fontSize: 12, color: C.text2 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} /> Enabled
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Interval runs between
          <input style={{ ...input, width: 64 }} value={draft.activeHours?.[0] || ""} onChange={(e) => setDraft((d) => ({ ...d, activeHours: [e.target.value, d.activeHours?.[1] || "23:00"] }))} />
          and
          <input style={{ ...input, width: 64 }} value={draft.activeHours?.[1] || ""} onChange={(e) => setDraft((d) => ({ ...d, activeHours: [d.activeHours?.[0] || "07:00", e.target.value] }))} />
        </label>
      </div>
      <Table
        maxHeight={420}
        columns={[
          { key: "id", label: "Section", align: "left", render: (r) => SECTION_TITLES[r.id] },
          {
            key: "type",
            label: "Rule",
            align: "left",
            render: (r) => (
              <select style={input} value={r.rule.type || "off"} onChange={(e) => setRule(r.id, e.target.value === "daily" ? { type: "daily", at: r.rule.at || ["08:00"] } : e.target.value === "interval" ? { type: "interval", everyMin: r.rule.everyMin || 60 } : { type: "off" })}>
                <option value="off">Manual only</option>
                <option value="daily">Daily at…</option>
                <option value="interval">Every N min</option>
              </select>
            ),
          },
          {
            key: "val",
            label: "Times / minutes",
            align: "left",
            render: (r) =>
              r.rule.type === "daily" ? (
                <input style={{ ...input, width: 140 }} value={(r.rule.at || []).join(", ")} onChange={(e) => setRule(r.id, { at: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
              ) : r.rule.type === "interval" ? (
                <input type="number" style={{ ...input, width: 80 }} value={r.rule.everyMin ?? ""} onChange={(e) => setRule(r.id, { everyMin: Number(e.target.value) })} />
              ) : (
                <span style={{ color: C.muted }}>—</span>
              ),
          },
          { key: "next", label: "Status", align: "left", render: (r) => <span style={{ color: C.text2 }}>{scheduleText(schedule?.[r.id]) || "—"}</span> },
        ]}
        rows={SECTION_IDS.map((id) => ({ _key: id, id, rule: draft.rules?.[id] || { type: "off" } }))}
      />
    </Panel>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

export default function MorningDashboard() {
  const [state, setState] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [page, setPage] = useState("dash");
  const [now, setNow] = useState(Date.now());
  const [durOverrides, setDurOverrides] = useState(() => lsGet("durations.v2", {}));
  const [srFlow, setSrFlow] = useState("ALL");
  const [errMetric, setErrMetric] = useState("pct");
  const [u09Metric, setU09Metric] = useState("pct");
  const [u09Split, setU09Split] = useState(false);
  const [bankFlow, setBankFlow] = useState("ALL");
  const [shareMetric, setShareMetric] = useState("share");
  const [flowGrain, setFlowGrain] = useState(() => lsGet("grain.v2:flowsr", "week"));
  const [flowLite, setFlowLite] = useState(false);
  const [instGrain, setInstGrain] = useState(() => lsGet("grain:instrument", "day"));
  const [errbMetric, setErrbMetric] = useState("count");
  // Cross-links between A (breakdown) and B (decline codes).
  const [driverCode, setDriverCode] = useState(null); // A: which rows drive this code
  const [declineFocus, setDeclineFocus] = useState(null); // B: focus this code
  useEffect(() => lsSet("grain.v2:flowsr", flowGrain), [flowGrain]);
  useEffect(() => lsSet("grain:instrument", instGrain), [instGrain]);
  const skew = useRef(0);

  const reload = useCallback(async () => {
    try {
      const s = await api("/state");
      skew.current = s.now - Date.now();
      if (s.durationOptions) DURATION_OPTS = s.durationOptions;
      setState(s);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message);
    }
  }, []);

  // Read cached state once on open — never triggers a query.
  useEffect(() => {
    reload();
  }, [reload]);

  const anyActive = state && SECTION_IDS.some((id) => ACTIVE.has(state.jobs[id]?.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const poll = setInterval(reload, 2000);
    const tick = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [anyActive, reload]);

  // While idle, re-read cached state every minute so results from backend-scheduled
  // refreshes appear. Read-only — this never starts a query.
  const scheduleOn = Boolean(state?.config?.schedule?.enabled);
  useEffect(() => {
    if (anyActive || !scheduleOn) return undefined;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") reload();
      setNow(Date.now() + skew.current);
    }, 60000);
    return () => clearInterval(poll);
  }, [anyActive, scheduleOn, reload]);

  useEffect(() => lsSet("durations.v2", durOverrides), [durOverrides]);

  const cfg = state?.config;
  const durations = useMemo(() => {
    if (!cfg) return {};
    const pick = (id) => {
      const valid = durationLabels(id);
      const d = [durOverrides[id], cfg.sectionDurations?.[id], cfg.defaultDuration].find((x) => x && valid[x]);
      return d || Object.keys(valid)[0];
    };
    return Object.fromEntries(SECTION_IDS.map((id) => [id, pick(id)]));
  }, [cfg, durOverrides]);

  const run = async (sections) => {
    try {
      await api("/run", { method: "POST", body: { sections, durations } });
    } catch (e) {
      alert(e.message);
    }
    setNow(Date.now() + skew.current);
    reload();
  };
  const stop = async (sections) => {
    await api("/stop", { method: "POST", body: { sections } }).catch((e) => alert(e.message));
    reload();
  };
  const retryNow = async (section) => {
    await api("/retry-now", { method: "POST", body: { section } }).catch((e) => alert(e.message));
    reload();
  };
  const toggleSchedule = async () => {
    await api("/config", { method: "PUT", body: { schedule: { enabled: !cfg.schedule?.enabled } } }).catch((e) => alert(e.message));
    reload();
  };
  const toggleAutoRetry = async () => {
    await api("/config", { method: "PUT", body: { autoRetry: !cfg.autoRetry } }).catch((e) => alert(e.message));
    reload();
  };
  // Header "set all" applies to the intraday sections; day-level ones keep their own range.
  const setAllDurations = (d) => setDurOverrides((o) => ({ ...o, ...Object.fromEntries(SECTION_IDS.filter((id) => !hasKind(id, "daily")).map((id) => [id, d])) }));

  if (!state) {
    return (
      <div style={{ minHeight: "100%", background: C.bg, color: C.text2, padding: 24, fontFamily: "'Segoe UI', sans-serif" }}>
        {loadErr ? (
          <div>
            Could not reach the dashboard backend: {loadErr}.{" "}
            <button type="button" style={btn()} onClick={reload}>
              Retry
            </button>
          </div>
        ) : (
          "Loading cached dashboard…"
        )}
      </div>
    );
  }

  const jumpTo = (id) => document.getElementById(`mdash-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const failedCount = SECTION_IDS.filter((id) => ["failed", "retry-wait"].includes(state.jobs[id]?.status)).length;
  const common = (id) => ({
    id,
    job: state.jobs[id],
    result: state.results[id],
    cfg,
    duration: durations[id],
    setDuration: (d) => setDurOverrides((o) => ({ ...o, [id]: d })),
    now,
    onRun: () => run([id]),
    onStop: () => stop([id]),
    onRetryNow: () => retryNow(id),
    sched: state.schedule?.[id],
  });

  return (
    <div style={{ minHeight: "100%", background: C.bg, color: C.text, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: `${C.bg}f2`,
          backdropFilter: "blur(6px)",
          borderBottom: `1px solid ${C.border}`,
          padding: "10px 16px",
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>☀ Morning Dashboard</h1>
        <a
          href="/#history?dashboard=morning"
          target="_blank"
          rel="noopener noreferrer"
          title="Open run history (query, output, insights) in a new tab"
          style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          🕘 History ↗
        </a>
        <span style={{ fontSize: 11, color: C.muted }}>UPI · payer handles {cfg.handles.join(", ").toUpperCase()}</span>
        <Seg value={page} onChange={setPage} options={[["dash", "Dashboard"], ["config", "Configuration"]]} />
        <div style={{ marginLeft: "auto", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {page === "dash" && (
            <select
              style={selectStyle}
              value=""
              onChange={(e) => e.target.value && setAllDurations(e.target.value)}
              aria-label="Set duration for all sections"
            >
              <option value="">Set sections 1–3 to…</option>
              {Object.entries(DURATION_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  Last {l}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={toggleAutoRetry}
            title="Re-run failed queries automatically from a queue"
            style={{ ...btn(), color: cfg.autoRetry ? "#86efac" : C.text2 }}
          >
            Retry failed: {cfg.autoRetry ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={toggleSchedule}
            title="Backend refresh schedule (IST): raw-txn sections at 07:00, 10:30, 15:00, 19:30, 23:00; day-level Looker sections at 07:00 and 10:30"
            style={{ ...btn(), color: cfg.schedule?.enabled ? "#86efac" : C.text2 }}
          >
            Auto-refresh: {cfg.schedule?.enabled ? "On" : "Off"}
          </button>
          {failedCount > 0 && <span style={{ fontSize: 11, color: C.warn }}>{failedCount} failed/retrying</span>}
          <button type="button" style={btn("danger")} onClick={() => stop(SECTION_IDS)} disabled={!anyActive}>
            ■ Stop all
          </button>
          <button type="button" style={btn("primary")} onClick={() => run(SECTION_IDS)}>
            ⟳ Refresh all
          </button>
        </div>
      </header>

      <main style={{ padding: 16, maxWidth: 1400, margin: "0 auto" }}>
        {page === "config" ? (
          <ConfigPage state={state} now={now} durations={durations} onRun={run} onStop={stop} onRetryNow={retryNow} reload={reload} />
        ) : (
          <>
            <MorningKpiStrip state={state} sectionIds={SECTION_IDS} titles={SECTION_TITLES} now={now} onJump={jumpTo} onRefresh={run} />

            <SectionCard {...common("breakdown")} noView>
              {() => (
                <BreakdownBody
                  result={state.results.breakdown}
                  cfg={cfg}
                  focusCode={driverCode}
                  onClearFocus={() => setDriverCode(null)}
                  onCodeClick={(code) => {
                    setDeclineFocus(code);
                    jumpTo("declines");
                  }}
                />
              )}
            </SectionCard>

            <SectionCard {...common("declines")} noView>
              {() => (
                <DeclinesBody
                  result={state.results.breakdown}
                  amountResult={state.results.declines}
                  focus={declineFocus}
                  onFocus={setDeclineFocus}
                  onCodeClick={(code) => {
                    setDriverCode(code);
                    jumpTo("breakdown");
                  }}
                />
              )}
            </SectionCard>

            <SectionCard
              {...common("sr")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Flow (handle chart):</span>
                  <Seg value={srFlow} onChange={setSrFlow} options={[["ALL", "P2P + P2M"], ["P2P", "P2P"], ["P2M", "P2M"]]} />
                </>
              }
            >
              {(view) => <SrBody result={state.results.sr} view={view} flow={srFlow} />}
            </SectionCard>

            <SectionCard
              {...common("errors")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                  <Seg value={errMetric} onChange={setErrMetric} options={[["pct", "% of txns"], ["count", "Count"]]} />
                </>
              }
            >
              {(view) => <ErrorsBody result={state.results.errors} view={view} cfg={cfg} metric={errMetric} />}
            </SectionCard>

            <SectionCard
              {...common("u09")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                  <Seg value={u09Metric} onChange={setU09Metric} options={[["pct", "% of txns"], ["count", "Count"]]} />
                  <label style={{ fontSize: 12, color: C.text2, display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={u09Split} onChange={(e) => setU09Split(e.target.checked)} /> Split by handle
                  </label>
                </>
              }
            >
              {(view) => <U09Body result={state.results.u09} view={view} metric={u09Metric} split={u09Split} />}
            </SectionCard>

            <SectionCard
              {...common("bank")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
                  <Seg value={bankFlow} onChange={setBankFlow} options={[["ALL", "P2P + P2M"], ["P2P", "P2P"], ["P2M", "P2M"]]} />
                </>
              }
            >
              {(view) => <BankBody result={state.results.bank} view={view} cfg={cfg} flow={bankFlow} />}
            </SectionCard>

            <SectionCard
              {...common("share")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                  <Seg value={shareMetric} onChange={setShareMetric} options={[["share", "% Share"], ["count", "Txn count"]]} />
                </>
              }
            >
              {(view) => <ShareBody result={state.results.share} view={view} metric={shareMetric} />}
            </SectionCard>

            <SectionCard
              {...common("flowsr")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Grain:</span>
                  <Seg value={flowGrain} onChange={setFlowGrain} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} />
                  <label style={{ fontSize: 12, color: C.text2, display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={flowLite} onChange={(e) => setFlowLite(e.target.checked)} /> Include LITE
                  </label>
                </>
              }
            >
              {(view) => <FlowSrBody result={state.results.flowsr} view={view} grain={flowGrain} lite={flowLite} />}
            </SectionCard>

            <SectionCard
              {...common("instrument")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Grain:</span>
                  <Seg value={instGrain} onChange={setInstGrain} options={[["day", "Day"], ["week", "Week"], ["month", "Month"]]} />
                </>
              }
            >
              {(view) => <InstrumentBody result={state.results.instrument} view={view} grain={instGrain} />}
            </SectionCard>

            <SectionCard {...common("psp")}>
              {(view) => <GroupSrBody result={state.results.psp} view={view} groupKey="psp" groupLabel="payee PSP" topN={50} chartN={8} />}
            </SectionCard>

            <SectionCard {...common("payerbank")}>
              {(view) => <GroupSrBody result={state.results.payerbank} view={view} groupKey="bank" groupLabel="payer bank" topN={25} chartN={8} />}
            </SectionCard>

            <SectionCard
              {...common("errbreak")}
              controls={
                <>
                  <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                  <Seg value={errbMetric} onChange={setErrbMetric} options={[["count", "Count"], ["pct", "% of txns"]]} />
                </>
              }
            >
              {(view) => <ErrorsBody result={state.results.errbreak} view={view} cfg={cfg} metric={errbMetric} topN={25} visibleN={10} column="app_resp_code" pivot />}
            </SectionCard>
          </>
        )}
      </main>
    </div>
  );
}
