import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { periods, periodLabels, aggregate, errorRows, errorCols, ScoreTable } from "./unified-scorecard.jsx";
import { mccName } from "./mcc-names.js";
import { Zoomable } from "./trend-zoom.jsx";

// Product Wise dashboard — per-product health for Paytm TPAP handles
// (PTYES, PTAXIS, PTSBI, PTHDFC). UPI International, UPI Plugin (@yesnext, see
// PluginView), UPI Lite (all PSPs, see LiteView), UPI Refunds and Payouts (refund MySQL,
// see RefundsView / PayoutsView) and Mandates (switch txn_info, see MandatesView).
// Backend /api/product/* returns raw daily counts for the last 30 complete days; the range
// (1–15 days), handle filter and the "vs previous period" comparison are all computed here.
//
// Periods: Current = the last N days ending on the latest day present in the data;
//          Previous = the N days right before it. Charts show both (current shaded).

const API = "/api/product";
const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
const RANGES = [
  { n: 1, label: "1 day" },
  { n: 2, label: "2 days" },
  { n: 3, label: "3 days" },
  { n: 4, label: "4 days" },
  { n: 5, label: "5 days" },
  { n: 7, label: "7 days" },
  { n: 15, label: "15 days" },
];
const DEFAULT_RANGE = 4;
const TOP_BANKS = 15;
const TOP_ERRORS = 15;
// Error count change vs previous period beyond this is flagged rising / falling.
const TREND_PCT = 10;
// A day / bank whose SR is this many pp below the range SR is highlighted.
const LOW_SR_PP = 5;

const PRODUCTS = [
  { id: "international", label: "🌐 UPI International" },
  { id: "plugin", label: "🔌 UPI Plugin" },
  { id: "lite", label: "⚡ UPI Lite" },
  { id: "refunds", label: "↩ UPI Refunds" },
  { id: "payouts", label: "💸 Payouts" },
  { id: "mandates", label: "🔁 Mandates" },
  { id: "iccw", label: "🏧 ICCW" },
  { id: "interop", label: "🔀 Interop" },
  { id: "cccasa", label: "💳 CC vs CASA" },
];

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#fb923c",
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#fab219",
};
const SERIES = ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#f87171", "#a3e635"];
const HANDLE_COLOR = { ptyes: "#60a5fa", ptaxis: "#f472b6", ptsbi: "#34d399", pthdfc: "#fbbf24" };

// Known UPI International failure codes (npci_resp_code, else app_resp_code).
const CODE_MEANING = {
  "INT-5033": "INVALID_LOC_FOR_INTL_TXN_ANDROID — app blocks payment: location permission not granted (Android)",
  "INT-5032": "INVALID_LOC_FOR_INTL_TXN_IOS — app blocks payment: location permission not granted (iOS)",
  PM14: "Request timeout for UPI International (BD)",
  "U30-Z9": "DF_INSUFFICIENT_FUNDS_IN_REMITTER_ACCOUNT (BD)",
  "U31-XW": "RESPPAY_COMPLIANCE_VIOLATION_BENEFICIARY — declined on beneficiary side (BD)",
  RESP_VAL_QR_NOT_FOUND: "International QR validation found no QR; app code U08 SYSTEM_EXCEPTION (TD)",
  "U30-ZM": "DF_INVALID_MPIN — wrong UPI PIN (BD)",
  S96: "REMITTER_DISPATCH_FAILED (TD)",
  "U31-X7": "MERCHANT_ACQUIRER_NOT_REACHABLE (TD)",
  "U16-01176": "NPCI risk rule 1176 GLOBAL_UPI_LIMITS_NP_P2M_24HRS_NIPL — Nepal merchant > ₹35K/txn or ₹1L/24h",
  "U30-XV": "RESPPAY_COMPLIANCE_VIOLATION_REMITTER (BD)",
  "U30-K1": "DF_TXN_DECLINED_ON_RISK_SCORE_BY_REMITTER (BD)",
  "U16-00980": "NPCI risk rule 980 CUMAMT_GR_1LAC_24HR_APPROVED_N — payer sent > ₹1L in 24h",
  "U16-01188": "NPCI risk rule 1188 GLOBAL_UPI_LIMITS_BT_P2M_24HRS_NIPL — Bhutan merchant > ₹25K/txn or ₹1L/24h",
  "U30-IN": "REMITTER_ACT_INTL_SERVICE_NOT_ACTIVE — intl service not active on payer account (BD)",
  "(deemed)": "Deemed — outcome pending / not confirmed",
  U08: "SYSTEM_EXCEPTION (TD)",
};

// ISO country code → name for the country-wise section.
const COUNTRY_NAME = {
  NP: "Nepal",
  BT: "Bhutan",
  LK: "Sri Lanka",
  SG: "Singapore",
  AE: "UAE",
  US: "USA",
  QA: "Qatar",
  FR: "France",
  KH: "Cambodia",
  MU: "Mauritius",
  OM: "Oman",
  GB: "UK",
  MV: "Maldives",
  TT: "Trinidad & Tobago",
  UNKNOWN: "Unknown",
};
const TOP_COUNTRIES_CHART = 5;
const TOP_APP_CODES = 50;

// ─── utils ───────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const DAY = 86400000;
const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "—");

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const median = (a) => {
  const s = a.filter((v) => v != null).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const chg = (a, b) => (b > 0 ? ((a - b) * 100) / b : null);
const fmtPct = (v, dp = 1) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtSigned = (v, unit, dp = 1) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtInr = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
};
const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Every day in [from, to). */
function daysBetween(from, to) {
  const out = [];
  for (let t = toMs(from); t < toMs(to); t += DAY) out.push(toDay(t));
  return out;
}

/** Group-sum: rows → Map(key → { [field]: sum }). */
function sumBy(rows, keyOf, fields) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    let o = m.get(k);
    if (!o) m.set(k, (o = Object.fromEntries(fields.map((f) => [f, 0]))));
    for (const f of fields) o[f] += r[f] || 0;
  }
  return m;
}

const trendOf = (cur, prev) => {
  if (!prev && cur > 0) return { kind: "new", pct: null };
  const p = chg(cur, prev);
  if (p == null) return { kind: "flat", pct: null };
  if (p >= TREND_PCT) return { kind: "up", pct: p };
  if (p <= -TREND_PCT) return { kind: "down", pct: p };
  return { kind: "flat", pct: p };
};

// ─── UI bits ─────────────────────────────────────────────────────────────────

const btn = (primary) => ({
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${primary ? C.accent : C.border}`,
  background: primary ? C.accent : "transparent",
  color: primary ? "#2a1405" : C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
});
const pill = (on) => ({ ...btn(false), borderColor: on ? C.accent : C.border, color: on ? C.accent : C.text2 });

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

/**
 * cols: [{ key, label, title?, align?, render(row) → node, text?(row) → string (for copy), wrap? }]
 * rows: [{ id, ...data, _onClick?, _active?, _total? }]
 */
/** Sortable table: click a header to sort (again to reverse). Total rows (_total) stay on top. */
function Table({ cols, rows, maxHeight }) {
  const [sort, setSort] = useState(null); // { key, dir }
  const valueOf = (c, r) => {
    if (c.sortValue) return c.sortValue(r);
    const v = r[c.key];
    if (v != null && typeof v === "object") return v.sr ?? v.s ?? v.n ?? null;
    if (v != null) return v;
    const t = c.text ? c.text(r) : null;
    if (t == null) return null;
    const num = Number(String(t).replace(/[,%₹+\s]|pp/g, ""));
    return Number.isFinite(num) && /\d/.test(t) ? num : t;
  };
  const shown = useMemo(() => {
    if (!sort) return rows;
    const c = cols.find((x) => x.key === sort.key);
    if (!c) return rows;
    const top = rows.filter((r) => r._total);
    const rest = rows.filter((r) => !r._total);
    const cmp = (a, b) => {
      const x = valueOf(c, a);
      const y = valueOf(c, b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    };
    return [...top, ...rest.slice().sort(cmp)];
  }, [rows, cols, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const click = (c) => {
    if (c.noSort) return;
    setSort((s) => (s?.key === c.key ? (s.dir === -1 ? { key: c.key, dir: 1 } : null) : { key: c.key, dir: c.align === "left" ? 1 : -1 }));
  };
  return (
    <div style={{ overflowX: "auto", ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}) }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th
                key={c.key}
                onClick={() => click(c)}
                style={{ ...th, textAlign: c.align || "right", cursor: c.noSort ? "default" : "pointer", userSelect: "none", ...(maxHeight ? { position: "sticky", top: 0, zIndex: 1 } : {}) }}
                title={[c.title, c.noSort ? null : "Click to sort"].filter(Boolean).join(" · ")}
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === -1 ? " ▼" : " ▲") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr
              key={r.id}
              onClick={r._onClick}
              style={{
                background: r._total ? C.card2 : r._active ? "#1a2540" : undefined,
                fontWeight: r._total ? 700 : undefined,
                cursor: r._onClick ? "pointer" : undefined,
              }}
            >
              {cols.map((c) => (
                <td key={c.key} style={{ ...td, textAlign: c.align || "right", whiteSpace: c.wrap ? "normal" : "nowrap", color: C.text }}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function toTsv(cols, rows) {
  const cell = (c, r) => {
    if (c.text) return c.text(r);
    const v = c.render(r);
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  };
  return [cols.map((c) => c.label).join("\t"), ...rows.map((r) => cols.map((c) => cell(c, r)).join("\t"))].join("\n");
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Trend-line chart. days: x labels; lines: [{ name, color, values[], dashed? }];
 * bars?: { name, values[] } drawn faintly on their own scale; curFrom: index where the
 * current period starts (shaded). yFmt formats the line axis + tooltip. dots: always mark
 * every point (sparse series where most days are null).
 */
function TrendChart({ days, lines, bars, curFrom = 0, yFmt = (v) => fmtPct(v), barFmt = fmtNum, height = 230, dots = false }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const pad = { l: 52, r: 14, t: 12, b: 26 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const n = days.length || 1;
  const step = w / n;
  const xAt = (i) => pad.l + (i + 0.5) * step;

  const vals = lines.flatMap((s) => s.values.filter((v) => v != null));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  const span = hi - lo || Math.abs(hi) || 1;
  lo -= span * 0.12;
  hi += span * 0.12;
  if (vals.every((v) => v >= 0)) lo = Math.max(0, lo);
  const yAt = (v) => pad.t + h - ((v - lo) / (hi - lo)) * h;
  const barMax = bars ? Math.max(1, ...bars.values.map((v) => v || 0)) : 1;
  const ticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 58))));

  const path = (values) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - pad.l) / step);
    setHover(i >= 0 && i < n ? i : null);
  };

  return (
    <div ref={ref} style={{ position: "relative", padding: "8px 12px 4px" }}>
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
        {curFrom > 0 && (
          <>
            <rect x={pad.l} y={pad.t} width={curFrom * step} height={h} fill="#0b1220" opacity={0.55} />
            <text x={pad.l + 4} y={pad.t + 11} fontSize={10} fill={C.muted}>
              previous period
            </text>
          </>
        )}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + w} y1={yAt(t)} y2={yAt(t)} stroke={C.border} strokeDasharray={i ? "2,3" : undefined} />
            <text x={pad.l - 6} y={yAt(t) + 3} fontSize={10} fill={C.muted} textAnchor="end">
              {yFmt(t)}
            </text>
          </g>
        ))}
        {bars &&
          bars.values.map((v, i) =>
            v ? <rect key={i} x={xAt(i) - step * 0.32} width={step * 0.64} y={pad.t + h - (v / barMax) * h} height={(v / barMax) * h} fill="#475569" opacity={0.22} /> : null,
          )}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={d} x={xAt(i)} y={height - 8} fontSize={10} fill={i >= curFrom ? C.text2 : C.muted} textAnchor="middle">
              {fmtDay(d)}
            </text>
          ) : null,
        )}
        {lines.map((s) => (
          <g key={s.name}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2} strokeDasharray={s.dashed ? "5,4" : undefined} />
            {s.values.map((v, i) => (v != null && (dots || n <= 16 || i === hover) ? <circle key={i} cx={xAt(i)} cy={yAt(v)} r={2.6} fill={s.color} /> : null))}
          </g>
        ))}
        {hover != null && <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + h} stroke={C.text2} strokeOpacity={0.35} />}
      </svg>
      {hover != null && (
        <div
          style={{
            position: "absolute",
            top: 14,
            left: Math.min(xAt(hover) + 24, width - 210),
            background: "#0b1220ee",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "6px 9px",
            fontSize: 11,
            pointerEvents: "none",
            minWidth: 160,
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 3 }}>{fmtDay(days[hover])}</div>
          {bars && (
            <div style={{ color: C.text2 }}>
              {bars.name}: {barFmt(bars.values[hover])}
            </div>
          )}
          {lines.map((s) => (
            <div key={s.name} style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
              <span style={{ color: s.color }}>● {s.name}</span>
              <span>{yFmt(s.values[hover])}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: C.text2, padding: "2px 0 6px 40px" }}>
        {lines.map((s) => (
          <span key={s.name}>
            <span style={{ color: s.color }}>{s.dashed ? "┅" : "━"}</span> {s.name}
          </span>
        ))}
        {bars && (
          <span>
            <span style={{ color: "#64748b" }}>▮</span> {bars.name} (bars, own scale)
          </span>
        )}
      </div>
    </div>
  );
}

/** Display name of a table row, for the zoom title. */
const rowName = (r) => r.label ?? r.bank ?? r.type ?? r.code ?? r.cat ?? r.key ?? r.k ?? r.id ?? "";

/** Small daily line; with days (same length as values) it opens the zoomed daily view on click. */
function Spark({ values, color, curFrom = 0, days, name, metric = "Value", unit = "pct", upIsBad = false }) {
  const spark = <SparkLine values={values} color={color} curFrom={curFrom} />;
  if (!days || days.length !== values.length || values.filter((v) => v != null).length < 2) return spark;
  return (
    <Zoomable
      spec={() => ({
        title: `${metric} · ${name || "—"}`,
        subtitle: `Product Wise${(window.location.hash.match(/tab=([^&]+)/) || [])[1] ? ` · ${decodeURIComponent(window.location.hash.match(/tab=([^&]+)/)[1])}` : ""}`,
        days,
        lines: [{ name: metric, color: color && color !== "#94a3b8" ? color : "#60a5fa", values }],
        fmt: unit === "pct" ? (v) => fmtPct(v, 2) : fmtNum,
        unit: unit === "pct" ? "pct" : "count",
        upIsBad,
        curFrom,
      })}
    >
      {spark}
    </Zoomable>
  );
}

function SparkLine({ values, color, curFrom = 0 }) {
  const W = 92;
  const H = 22;
  const vs = values.map((v) => v ?? null);
  const nn = vs.filter((v) => v != null);
  if (nn.length < 2) return <span style={{ color: C.muted }}>—</span>;
  const lo = Math.min(...nn);
  const hi = Math.max(...nn);
  const x = (i) => (i * (W - 4)) / Math.max(1, vs.length - 1) + 2;
  const y = (v) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
  let d = "";
  let pen = false;
  vs.forEach((v, i) => {
    if (v == null) return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = vs.length - 1;
  return (
    <svg width={W} height={H} style={{ verticalAlign: "middle" }}>
      {curFrom > 0 && <rect x={x(curFrom) - 2} y={0} width={W - x(curFrom) + 2} height={H} fill="#1e293b" opacity={0.6} />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} />
      {vs[last] != null && <circle cx={x(last)} cy={y(vs[last])} r={2.2} fill={color} />}
    </svg>
  );
}

function TrendBadge({ t, upIsBad = true }) {
  if (t.kind === "new") return <span style={{ color: C.bad, fontWeight: 700 }}>NEW</span>;
  if (t.pct == null) return <span style={{ color: C.muted }}>—</span>;
  const color = t.kind === "flat" ? C.text2 : (t.kind === "up") === upIsBad ? C.bad : C.good;
  const arrow = t.kind === "up" ? "▲" : t.kind === "down" ? "▼" : "●";
  return (
    <span style={{ color, fontWeight: t.kind === "flat" ? 400 : 700 }}>
      {arrow} {fmtSigned(t.pct, "%", 0)}
    </span>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", minWidth: 120 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.text2 }}>{sub}</div>}
    </div>
  );
}

function JobBadge({ job, cached }) {
  if (job?.status === "running")
    return (
      <span style={{ fontSize: 11, color: C.warn, whiteSpace: "nowrap" }}>
        ● running · {fmtDur(Date.now() - job.startedAt)}
        {job.note ? ` · ${job.note}` : ""}
      </span>
    );
  if (!cached) return null;
  return (
    <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }} title={`Query took ${fmtDur(cached.durationMs)}`}>
      updated {fmtTime(cached.finishedAt)}
    </span>
  );
}

function toCsv(cols, rows) {
  const esc = (v) => {
    const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.map((c) => esc(c.label)).join(","), ...rows.map((r) => cols.map((c) => esc(c.text ? c.text(r) : c.render(r))).join(","))].join("\n");
}

function downloadCsv(name, cols, rows) {
  const url = URL.createObjectURL(new Blob([toCsv(cols, rows)], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, "_")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * onRefresh / onStop (optional): re-run or stop just this panel's query.
 * controls: filters shown under the header (always, even before data).
 * tableToggle: show the chart by default with a Trend / Table switch (chartless panels show the
 *   table); downloads: [{ label, name, cols, rows }] CSV buttons (default: the table).
 */
// ─── Alerts ──────────────────────────────────────────────────────────────────
// { level: "critical" | "warning", text } — shown as a count by a section title and a list under it.

const ALERT_COLOR = { critical: "#f87171", warning: "#fbbf24" };
const ALERT_SHOWN = 6;
const byLevel = (a, b) => (a.level === "critical" ? 0 : 1) - (b.level === "critical" ? 0 : 1);

function AlertCount({ alerts }) {
  if (!alerts?.length) return null;
  const crit = alerts.filter((a) => a.level === "critical").length;
  const warn = alerts.length - crit;
  const chip = (color, label) => (
    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 8px", verticalAlign: "middle" }}>{label}</span>
  );
  return (
    <>
      {crit > 0 && chip(ALERT_COLOR.critical, `● ${crit} critical`)}
      {warn > 0 && chip(ALERT_COLOR.warning, `● ${warn} warning`)}
    </>
  );
}

function AlertList({ alerts }) {
  const [all, setAll] = useState(false);
  const sorted = [...alerts].sort(byLevel);
  const shown = all ? sorted : sorted.slice(0, ALERT_SHOWN);
  return (
    <div style={{ padding: "8px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 4 }}>
      {shown.map((a, i) => (
        <div key={i} style={{ fontSize: 12, color: C.text, display: "flex", gap: 8, alignItems: "baseline" }}>
          <span style={{ color: ALERT_COLOR[a.level], fontWeight: 700, minWidth: 64, textTransform: "uppercase", fontSize: 10 }}>{a.level}</span>
          <span>
            {a.text}
            {a.detail?.map((d, j) => (
              <div key={j} style={{ color: C.text2, fontSize: 11, marginTop: 2 }}>
                {d}
              </div>
            ))}
          </span>
        </div>
      ))}
      {sorted.length > ALERT_SHOWN && (
        <button type="button" onClick={() => setAll(!all)} style={{ ...btn(false), alignSelf: "flex-start", fontSize: 11, padding: "2px 8px" }}>
          {all ? "Show fewer" : `+${sorted.length - ALERT_SHOWN} more`}
        </button>
      )}
    </div>
  );
}

function Section({ n, title, desc, job, cached, kpis, chart, cols, rows, note, alerts, onShowSql, onRefresh, onStop, tableMaxHeight, controls, tableToggle, downloads, emptyText, noTable, footer }) {
  const [view, setView] = useState("chart");
  const showChart = !tableToggle || view === "chart";
  const showTable = !tableToggle || view === "table" || !chart;
  const dl = downloads || (tableToggle ? [{ label: "⬇ CSV", name: title, cols, rows }] : []);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toTsv(cols, rows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            {n} · {title}
            <AlertCount alerts={alerts} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{desc}</div>
        </div>
        <JobBadge job={job} cached={cached} />
        {job?.status === "running"
          ? onStop && (
              <button type="button" onClick={onStop} style={{ ...btn(false), borderColor: C.bad, color: C.bad }} title="Stop this panel's query (keeps the last result)">
                ■ Stop
              </button>
            )
          : onRefresh && (
              <button type="button" onClick={onRefresh} style={btn(false)} title="Re-run only this panel's query">
                ↻ Refresh
              </button>
            )}
        {tableToggle && chart && (
          <button type="button" onClick={() => setView(view === "chart" ? "table" : "chart")} style={btn(false)} disabled={!rows.length} title="Switch between trendline and table">
            {view === "chart" ? "▦ Table" : "📈 Trend"}
          </button>
        )}
        {dl.map((d) => (
          <button key={d.label} type="button" onClick={() => downloadCsv(d.name, d.cols, d.rows)} style={btn(false)} disabled={!d.rows.length} title="Download as CSV">
            {d.label}
          </button>
        ))}
        {!noTable && (
          <button type="button" onClick={copy} style={btn(false)} disabled={!rows.length}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <button type="button" onClick={onShowSql} style={btn(false)}>
          SQL
        </button>
      </div>
      {controls && <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", padding: "8px 16px", borderBottom: `1px solid ${C.border}` }}>{controls}</div>}
      {alerts?.length > 0 && <AlertList alerts={alerts} />}
      {job?.status === "error" && (
        <div style={{ padding: "8px 16px", color: C.bad, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>Last run failed: {job.error}</div>
      )}
      {job?.status === "stopped" && (
        <div style={{ padding: "8px 16px", color: C.warn, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>
          Stopped at {fmtTime(job.finishedAt)}{cached ? " — showing the previous result." : "."}
        </div>
      )}
      {rows.length ? (
        <>
          {kpis && <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "12px 16px 0" }}>{kpis}</div>}
          {note && <div style={{ padding: "10px 16px 0", fontSize: 12, color: C.text2 }}>{note}</div>}
          {showChart && chart}
          {showTable && !noTable && <Table cols={cols} rows={rows} maxHeight={tableMaxHeight} />}
          {footer}
        </>
      ) : (
        <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>
          {job?.status === "running" ? `Running…${job.note ? ` ${job.note}` : ""}` : emptyText || "No data yet — click Refresh."}
        </div>
      )}
    </div>
  );
}

// ─── UPI Plugin (@yesnext) ───────────────────────────────────────────────────
//
// One cached query ("daily": a row per day since launch, today included) feeds every
// metric. Periods are IST calendar periods; weeks start Monday. "This week / month"
// include today so far.

const PLUGIN_METRICS = [
  { key: "users", title: "User Creation", desc: "Users created on the @yesnext handle (PMS user, scope 10 · source channel 79) — distinct scope_cust_id." },
  { key: "accounts", title: "Account Creation", desc: "Bank accounts linked by @yesnext users (PMS account), by account created_on." },
  { key: "vpas", title: "VPA Creation", desc: "VPAs created for @yesnext users (PMS user_vpa) — distinct VPA." },
  { key: "mpin_total", base: "accounts", baseLabel: "Accounts", title: "MPIN Total", desc: "Accounts with UPI PIN set (account.mpin_set = 1). SR = MPIN set / accounts linked." },
  {
    key: "mpin_listing",
    base: "listing_base",
    baseLabel: "Listed",
    title: "MPIN During Listing",
    desc: "PIN set on the account-listing page (account_cache.mpin_set = 1, via extended_info.tempAccRefId). SR = set during listing / accounts with a listing record.",
  },
  {
    key: "mpin_post",
    base: "post_base",
    baseLabel: "Not set at listing",
    title: "MPIN Post Addition",
    desc: "PIN set after the account was added (account.mpin_set = 1 and account_cache.mpin_set = 0). SR = set post addition / accounts without a PIN at listing.",
  },
];
const PLUGIN_TRENDS = [
  { n: 14, label: "14 days" },
  { n: 30, label: "30 days" },
  { n: 60, label: "60 days" },
  { n: 0, label: "All" },
];

/** IST calendar periods for "today" = YYYY-MM-DD. */
function pluginPeriods(today) {
  const t = toMs(today);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = t - dow * DAY;
  const monthStart = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 1);
  const lastMonthStart = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1);
  const range = (a, b) => ({ from: toDay(a), to: toDay(b) }); // inclusive
  return [
    { key: "total", label: "Total", from: "0000-00-00", to: today, title: "All days since launch" },
    { key: "today", label: "Today", ...range(t, t), title: `${fmtDay(today)} (so far)` },
    { key: "yday", label: "Yesterday", ...range(t - DAY, t - DAY) },
    { key: "tw", label: "This week", ...range(weekStart, t) },
    { key: "lw", label: "Last week", ...range(weekStart - 7 * DAY, weekStart - DAY) },
    { key: "tm", label: "This month", ...range(monthStart, t) },
    { key: "lm", label: "Last month", ...range(lastMonthStart, monthStart - DAY) },
    // Comparison bases for the partial current week / month: same number of days.
    { key: "lwtd", hidden: true, ...range(weekStart - 7 * DAY, t - 7 * DAY) },
    { key: "lmtd", hidden: true, ...range(lastMonthStart, Math.min(t - (monthStart - lastMonthStart), monthStart - DAY)) },
  ].map((p) => ({ ...p, title: p.title || (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`) }));
}

function PluginView({ cached, job, asOf, onShowSql }) {
  const [trend, setTrend] = useState(30);
  const rows = useMemo(() => cached?.rows || [], [cached]);
  // IST today (as-of view: that day); the cache window's toDate is tomorrow when data was fetched.
  const today = asOf || toDay(toMs(toDay(Date.now() + 330 * 60000)));
  const periods = useMemo(() => pluginPeriods(today), [today]);
  const byDay = useMemo(() => new Map(rows.map((r) => [r.ts, r])), [rows]);
  const sum = useCallback(
    (from, to, key) => rows.reduce((a, r) => (r.ts >= from && r.ts <= to ? a + (r[key] || 0) : a), 0),
    [rows],
  );
  const first = cached?.window?.fromDate || rows[0]?.ts || today;
  const allDays = useMemo(() => daysBetween(first, toDay(toMs(today) + DAY)), [first, today]);
  const days = trend ? allDays.slice(-trend) : allDays;

  const stat = (m, p) => {
    const c = sum(p.from, p.to, m.key);
    const b = m.base ? sum(p.from, p.to, m.base) : null;
    return { c, b, sr: m.base ? pct(c, b) : null };
  };
  const cellText = (m, p) => {
    const s = stat(m, p);
    return m.base ? `${s.c} (${fmtPct(s.sr)})` : String(s.c);
  };
  const vs = (cur, prev, what) => {
    const p = chg(cur, prev);
    return p == null ? (cur > 0 && !prev ? `new vs ${what}` : "—") : `${fmtSigned(p, "%", 0)} vs ${what}`;
  };

  const summaryCols = [
    { key: "m", label: "Metric", align: "left", render: (r) => r.m.title, text: (r) => r.m.title },
    ...periods.filter((p) => !p.hidden).map((p) => ({
      key: p.key,
      label: p.label,
      title: p.title,
      render: (r) => {
        const s = stat(r.m, p);
        return (
          <span>
            <b>{fmtNum(s.c)}</b>
            {r.m.base && <span style={{ color: C.text2, fontSize: 11 }}> · {fmtPct(s.sr)}</span>}
          </span>
        );
      },
      text: (r) => cellText(r.m, p),
    })),
  ];
  const summaryRows = PLUGIN_METRICS.map((m) => ({ id: m.key, m }));
  const P = Object.fromEntries(periods.map((p) => [p.key, p]));

  return (
    <>
      <Section
        n="Σ"
        title="@yesnext onboarding summary"
        desc={`Counts per period; MPIN rows show count · success rate. Today ${P.today.title}; this week ${P.tw.title}; last week ${P.lw.title}; this month ${P.tm.title}; last month ${P.lm.title}. Weeks start Monday (IST).`}
        job={job}
        cached={cached}
        onShowSql={onShowSql}
        cols={summaryCols}
        rows={rows.length ? summaryRows : []}
      />
      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>Trend</span>
        {PLUGIN_TRENDS.map((t) => (
          <button key={t.n} type="button" onClick={() => setTrend(t.n)} style={pill(trend === t.n)}>
            {t.label}
          </button>
        ))}
      </div>
      {PLUGIN_METRICS.map((m, i) => {
        const at = (d, k) => byDay.get(d)?.[k] || 0;
        const counts = days.map((d) => at(d, m.key));
        const s = Object.fromEntries(periods.map((p) => [p.key, stat(m, p)]));
        const sub = (k, prevK, what) => {
          const d = prevK ? vs(s[k].c, s[prevK].c, what) : "";
          return m.base ? `SR ${fmtPct(s[k].sr)}${d ? ` · ${d}` : ""}` : d || undefined;
        };
        const cols = [
          { key: "d", label: "Date", align: "left", render: (r) => fmtDay(r.d), text: (r) => r.d },
          { key: "c", label: m.title, render: (r) => fmtNum(r.c) },
          ...(m.base
            ? [
                { key: "b", label: m.baseLabel, render: (r) => fmtNum(r.b) },
                { key: "sr", label: "SR", render: (r) => <b>{fmtPct(r.sr)}</b>, text: (r) => fmtPct(r.sr) },
              ]
            : []),
        ];
        const dayRows = [...days]
          .reverse()
          .map((d) => ({ id: d, d, c: at(d, m.key), b: m.base ? at(d, m.base) : null, sr: m.base ? pct(at(d, m.key), at(d, m.base)) : null }));
        // Days with activity only (all days if the trend window has none).
        const active = dayRows.filter((r) => r.c || r.b);
        const tableRows = active.length ? active : dayRows;
        const span = days.length ? `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}` : "";
        return (
          <Section
            key={m.key}
            n={i + 1}
            title={m.title}
            desc={m.desc}
            note={`Table: days with activity, ${span}.`}
            job={job}
            cached={cached}
            onShowSql={onShowSql}
            kpis={
              <>
                <Kpi label="Total" value={fmtNum(s.total.c)} sub={m.base ? `SR ${fmtPct(s.total.sr)}` : `since ${fmtDay(first)}`} color={C.accent} />
                <Kpi label="Today" value={fmtNum(s.today.c)} sub={sub("today", "yday", "yday")} />
                <Kpi label="Yesterday" value={fmtNum(s.yday.c)} sub={sub("yday")} />
                <Kpi label="This week" value={fmtNum(s.tw.c)} sub={sub("tw", "lwtd", "LW to date")} />
                <Kpi label="Last week" value={fmtNum(s.lw.c)} sub={sub("lw")} />
                <Kpi label="This month" value={fmtNum(s.tm.c)} sub={sub("tm", "lmtd", "LM to date")} />
                <Kpi label="Last month" value={fmtNum(s.lm.c)} sub={sub("lm")} />
              </>
            }
            chart={
              m.base ? (
                <TrendChart
                  days={days}
                  lines={[{ name: `${m.title} SR`, color: SERIES[i % SERIES.length], values: days.map((d) => pct(at(d, m.key), at(d, m.base))) }]}
                  bars={{ name: m.title, values: counts }}
                  dots
                />
              ) : (
                <TrendChart days={days} lines={[{ name: m.title, color: SERIES[i % SERIES.length], values: counts }]} yFmt={(v) => (v == null ? "—" : fmtNum(v))} dots />
              )
            }
            cols={cols}
            rows={rows.length ? tableRows : []}
          />
        );
      })}
    </>
  );
}

// ─── UPI Lite ────────────────────────────────────────────────────────────────
//
// Daily queries (trend, gmv, codes, mandate) cache the last 30 days by default. Each section
// has its own trend filter; picking more days than a query has cached asks the backend for
// just the missing days (up to 120) and the section fills in when they land. Snapshot queries
// (accounts, autopay, shield) hold one row set per run (asOf = run date), so KPIs compare
// against the previous run. Yesterday = latest day in the section's data, D-2 = the day
// before. Shield (section 10) runs only from its own panel.

const LITE_TRENDS = [4, 7, 15, 30, 60, 90, 120];
const LITE_ERR_TRENDS = [4, 7, 10, 15, 30, 60, 90, 120];
const LITE_DEFAULT_TREND = 30;
const LITE_ERR_DEFAULT_TREND = 10;
const LITE_ACTIVATION = ["create_mandate_and_activation", "manual_activation"];
const LITE_TOPUP = ["manual_recurring_topup", "recurring_mandate_execution"];
const LITE_DEREGISTER = "Deregister Lite";
const LITE_TOP_CODES = 25;
const LITE_CHART_TOP = 5;
const LITE_SPLITS = ["PTYES", "PTAXIS", "PTSBI", "PTHDFC", "PAYTM", "OTHER", "TOTAL"];

/** Snapshot rows → [{ asOf, rows }], oldest first. */
function snapshotsOf(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.asOf)) m.set(r.asOf, []);
    m.get(r.asOf).push(r);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([asOf, rs]) => ({ asOf, rows: rs }));
}

/** Days a daily query covers: cached window start → latest day present in its rows. */
function coveredDays(cached) {
  let first = "";
  let last = "";
  for (const r of cached?.rows || []) {
    if (r.ts > last) last = r.ts;
    if (!first || r.ts < first) first = r.ts;
  }
  if (!last) return [];
  const from = cached.window?.fromDate && cached.window.fromDate < first ? cached.window.fromDate : first;
  return daysBetween(from, toDay(toMs(last) + DAY));
}

/** Job shown on a panel fed by several queries: running, then error, then stopped, then the first. */
function jobOf(jobs, qs) {
  const js = qs.map((q) => jobs[q]).filter(Boolean);
  return js.find((j) => j.status === "running") || js.find((j) => j.status === "error") || js.find((j) => j.status === "stopped") || js[0];
}

/**
 * Share-of-txns breakdown by keyOf(row) over `days`: each key's txn_init as % of the day's
 * total. SUCCESS is left out of the ranking (it is reported as its own KPI).
 */
function shareBreakdown(rows, keyOf, days, limit) {
  const daySet = new Set(days);
  const inRange = rows.filter((r) => daySet.has(r.ts));
  const dayTotal = sumBy(inRange, (r) => r.ts, ["txn_init"]);
  const byKeyDay = sumBy(inRange, (r) => `${keyOf(r)}|${r.ts}`, ["txn_init"]);
  const byKey = sumBy(inRange, keyOf, ["txn_init"]);
  const total = days.reduce((a, d) => a + (dayTotal.get(d)?.txn_init || 0), 0);
  const y = days[days.length - 1];
  const d2 = days[days.length - 2];
  const at = (k, d) => byKeyDay.get(`${k}|${d}`)?.txn_init || 0;
  const shareAt = (k, d) => (d ? pct(at(k, d), dayTotal.get(d)?.txn_init || 0) : null);
  const items = [...byKey.entries()]
    .filter(([k]) => k !== "SUCCESS")
    .sort((a, b) => b[1].txn_init - a[1].txn_init)
    .slice(0, limit)
    .map(([k, v]) => {
      const share = pct(v.txn_init, total);
      const ys = shareAt(k, y);
      return {
        id: k,
        key: k,
        c: v.txn_init,
        share,
        y: at(k, y),
        ys,
        d2s: shareAt(k, d2),
        dpp: ys != null && share != null ? ys - share : null,
        daily: days.map((d) => shareAt(k, d)),
        counts: days.map((d) => at(k, d)),
      };
    });
  return { items, total, success: { share: pct(byKey.get("SUCCESS")?.txn_init || 0, total), ys: shareAt("SUCCESS", y) } };
}

/** Per-section trend dropdown; flags when the pick needs more days than are cached. */
function TrendSelect({ value, options, onChange, covered, running }) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: C.muted }}>
      Trend
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {n} days
          </option>
        ))}
      </select>
      {covered < value && <span style={{ color: C.warn }}>{running ? `fetching ${value - covered} more days…` : `${covered} of ${value} days cached — ↻ Refresh to fetch`}</span>}
    </label>
  );
}

function Pills({ label, value, options, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>{label}</span>
      {options.map(([k, l]) => (
        <button key={k} type="button" onClick={() => onChange(k)} style={pill(value === k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Clickable series picker shown above a chart (the table stays hidden in trend view). */
function Chips({ items, sel, onToggle }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 16px 0" }}>
      {items.map((it) => {
        const i = sel.indexOf(it.key);
        return (
          <button key={it.key} type="button" onClick={() => onToggle(it.key)} title="Add / remove from chart" style={{ ...pill(i >= 0), padding: "3px 8px", fontWeight: 500 }}>
            {i >= 0 && <span style={{ color: SERIES[i % SERIES.length] }}>● </span>}
            {it.key}
            {it.sub && <span style={{ color: C.muted }}> · {it.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

const EMPTY_DAY = { act: 0, actM: 0, top: 0, topM: 0, dereg: 0, liteS: 0, liteI: 0, s: 0, i: 0 };

function LiteView({ cache, jobs, onShowSql, onRun, onStop }) {
  // Panel controls for the queries behind it (sections sharing a query refresh / stop it together).
  const ctl = (q) => {
    const qs = [].concat(q);
    return { job: jobOf(jobs, qs), cached: cache[qs[0]], onShowSql: () => onShowSql(qs), onRefresh: () => onRun(qs), onStop: () => onStop(qs), tableToggle: true };
  };

  const [trends, setTrends] = useState({ s2: LITE_DEFAULT_TREND, s3: LITE_DEFAULT_TREND, s4: LITE_DEFAULT_TREND, s5: LITE_DEFAULT_TREND, s6: LITE_DEFAULT_TREND, err: LITE_ERR_DEFAULT_TREND, mand: LITE_DEFAULT_TREND });
  const [errDim, setErrDim] = useState("type");
  const [errScope, setErrScope] = useState("all");
  const [typePick, setTypePick] = useState(null);
  const [codePick, setCodePick] = useState(null);
  const [catPick, setCatPick] = useState(null);
  useEffect(() => {
    setTypePick(null);
    setCodePick(null);
  }, [trends.err, errScope]);
  useEffect(() => setCatPick(null), [trends.mand]);
  const toggle = (sel, setSel, defaults, id) => {
    const base = sel || defaults;
    setSel(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  const cover = useMemo(() => Object.fromEntries(["trend", "gmv", "codes", "mandate"].map((q) => [q, coveredDays(cache[q])])), [cache]);
  // Picking more days than a query has cached fetches the missing days for it.
  const pickTrend = (key, qs, n) => {
    setTrends((t) => ({ ...t, [key]: n }));
    const short = qs.filter((q) => cover[q].length < n && jobs[q]?.status !== "running");
    if (short.length) onRun(short, n);
  };
  const trendCtl = (key, qs, options = LITE_TRENDS) => {
    const days = cover[qs[0]].slice(-trends[key]);
    return (
      <>
        <TrendSelect
          value={trends[key]}
          options={options}
          covered={Math.min(...qs.map((q) => cover[q].length))}
          running={qs.some((q) => jobs[q]?.status === "running")}
          onChange={(n) => pickTrend(key, qs, n)}
        />
        <span style={{ fontSize: 11, color: C.muted }}>{days.length ? `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])} · Yesterday = ${fmtDay(days[days.length - 1])}` : ""}</span>
      </>
    );
  };

  const has = (q) => (cache[q]?.rows || []).length > 0;
  const countFmt = (v) => (v == null ? "—" : fmtNum(v));
  const vsD2 = (a, b) => `${fmtSigned(chg(a, b), "%", 0)} vs D-2`;
  const ppVs = (a, b, what) => (a != null && b != null ? `${fmtSigned(a - b, " pp")} vs ${what}` : undefined);

  // ── Sections 2–6: per-day metrics from the summary table ──
  const byDay = useMemo(() => {
    const m = new Map();
    for (const r of cache.trend?.rows || []) {
      let o = m.get(r.ts);
      if (!o) m.set(r.ts, (o = { ...EMPTY_DAY }));
      if (LITE_ACTIVATION.includes(r.txn_type)) o.act += r.success;
      if (r.txn_type === "create_mandate_and_activation") o.actM += r.success;
      if (LITE_TOPUP.includes(r.txn_type)) o.top += r.success;
      if (r.txn_type === "recurring_mandate_execution") o.topM += r.success;
      if (r.txn_type === LITE_DEREGISTER) o.dereg += r.success;
      if (r.lite) {
        o.liteS += r.success;
        o.liteI += r.txn_init;
      }
      o.s += r.success;
      o.i += r.txn_init;
    }
    return m;
  }, [cache]);
  const gmvByDay = useMemo(() => new Map((cache.gmv?.rows || []).map((r) => [r.ts, r])), [cache]);
  /** Range view of the summary for section `key`: days, per-day getter, totals, Y / D-2. */
  const agg = (key) => {
    const days = cover.trend.slice(-trends[key]);
    const g = (d) => byDay.get(d) || EMPTY_DAY;
    const T = days.reduce((a, d) => Object.fromEntries(Object.keys(EMPTY_DAY).map((k) => [k, a[k] + g(d)[k]])), { ...EMPTY_DAY });
    const series = (f) => days.map((d) => f(g(d)));
    const rows = (f, total) => [...[...days].reverse().map((d) => ({ id: d, d, ...f(g(d), d) })), { id: "__total", _total: true, ...total }];
    const dateCol = { key: "d", label: "Date", align: "left", render: (r) => (r._total ? `Range (${days.length}d)` : fmtDay(r.d)), text: (r) => (r._total ? "Range" : r.d) };
    return { days, g, T, Y: g(days[days.length - 1]), D2: g(days[days.length - 2]), series, rows, dateCol, n: days.length };
  };
  const a2 = agg("s2");
  const a3 = agg("s3");
  const a4 = agg("s4");
  const a5 = agg("s5");
  const a6 = agg("s6");

  // ── Section 5 GMV ──
  const gm = (d) => gmvByDay.get(d) || { gmv: 0, success: 0 };
  const gY = gm(a5.days[a5.days.length - 1]);
  const gD2 = gm(a5.days[a5.days.length - 2]);
  const gT = a5.days.reduce((a, d) => ({ gmv: a.gmv + gm(d).gmv, success: a.success + gm(d).success }), { gmv: 0, success: 0 });
  const ticket = (o) => (o.success > 0 ? o.gmv / o.success : null);

  // ── Sections 1 / 8 / 10: snapshots ──
  const accSnaps = useMemo(() => snapshotsOf(cache.accounts?.rows || []), [cache]);
  const apSnaps = useMemo(() => snapshotsOf(cache.autopay?.rows || []), [cache]);
  const shSnaps = useMemo(() => snapshotsOf(cache.shield?.rows || []), [cache]);
  const lastOf = (s, k = 1) => s[s.length - k]?.rows || [];
  const accNow = lastOf(accSnaps)[0];
  const accPrev = lastOf(accSnaps, 2)[0];
  // Older autopay snapshots have no kind (one total row per run).
  const apTotal = (rows) => rows.find((r) => !r.kind || r.kind === "total");
  const apNow = apTotal(lastOf(apSnaps));
  const apPrev = apTotal(lastOf(apSnaps, 2));
  const apDays = lastOf(apSnaps)
    .filter((r) => r.kind === "day")
    .sort((x, y) => x.ts.localeCompare(y.ts));
  const shTotal = (rows) => rows.find((r) => r.split === "TOTAL");
  const shNow = shTotal(lastOf(shSnaps));
  const shPrev = shTotal(lastOf(shSnaps, 2));
  const snapDelta = (a, b, what = "prev run") => (a != null && b != null ? `${fmtSigned(a - b, "", 0)} (${fmtSigned(chg(a, b), "%")}) vs ${what}` : "first snapshot");
  const snapDesc = (s) => (s.length ? `Snapshot as of run ${fmtDay(s[s.length - 1].asOf)} (data up to the day before).` : "");

  // ── Section 7: error type / app code share ──
  const eDays = cover.codes.slice(-trends.err);
  const eY = eDays[eDays.length - 1];
  const eD2 = eDays[eDays.length - 2];
  const eSpan = eDays.length ? `${fmtDay(eDays[0])} – ${fmtDay(eY)}` : "—";
  const codeRows = useMemo(() => (cache.codes?.rows || []).filter((r) => errScope === "all" || r.lite), [cache, errScope]);
  const types = useMemo(() => shareBreakdown(codeRows, (r) => r.error_type, eDays, Infinity), [codeRows, eDays.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const codes = useMemo(() => shareBreakdown(codeRows, (r) => r.code, eDays, LITE_TOP_CODES), [codeRows, eDays.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const isType = errDim === "type";
  const bd = isType ? types : codes;
  const bdDefault = bd.items.slice(0, LITE_CHART_TOP).map((i) => i.key);
  const bdSel = (isType ? typePick : codePick) || bdDefault;
  const bdToggle = (k) => toggle(isType ? typePick : codePick, isType ? setTypePick : setCodePick, bdDefault, k);
  const bdLabel = isType ? "Error type" : "App resp code";
  const shareCols = [
    { key: "key", label: bdLabel, align: "left", render: (r) => <span>{bdSel.includes(r.key) && <span style={{ color: SERIES[bdSel.indexOf(r.key) % SERIES.length] }}>● </span>}<code style={{ fontSize: 12 }}>{r.key}</code></span>, text: (r) => r.key },
    { key: "c", label: "Txns (range)", title: eSpan, render: (r) => fmtNum(r.c), text: (r) => String(r.c) },
    { key: "share", label: "% of txns (range)", title: eSpan, render: (r) => fmtPct(r.share, 2) },
    { key: "y", label: "Yesterday", title: fmtDay(eY), render: (r) => fmtNum(r.y), text: (r) => String(r.y) },
    { key: "ys", label: "Yesterday %", title: fmtDay(eY), render: (r) => <b>{fmtPct(r.ys, 2)}</b>, text: (r) => fmtPct(r.ys, 2) },
    { key: "d2s", label: "D-2 %", title: fmtDay(eD2), render: (r) => fmtPct(r.d2s, 2) },
    { key: "dpp", label: "vs range", title: "Yesterday % − range %, percentage points", render: (r) => <span style={{ color: r.dpp > 0.05 ? C.bad : r.dpp < -0.05 ? C.good : C.text2 }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "daily", label: "Trend", title: `Daily % of txns, ${eSpan}`, render: (r) => <Spark values={r.daily} days={eDays} name={rowName(r)} metric="% of txns" unit="pct" upIsBad color={r.dpp > 0.05 ? C.bad : r.dpp < -0.05 ? C.good : "#94a3b8"} />, text: () => "" },
  ];
  const errDailyCols = [
    { key: "d", label: "Date", render: (r) => r.d },
    { key: "key", label: bdLabel, render: (r) => r.key },
    { key: "c", label: "Txns", render: (r) => String(r.c) },
    { key: "share", label: "% of day's txns", render: (r) => (r.share == null ? "" : r.share.toFixed(4)) },
  ];
  const errDailyRows = bd.items.flatMap((it) => eDays.map((d, i) => ({ id: `${it.key}|${d}`, d, key: it.key, c: it.counts[i], share: it.daily[i] })));

  // ── Section 9: mandate creation SR by autopay category ──
  const mDays = cover.mandate.slice(-trends.mand);
  const mY = mDays[mDays.length - 1];
  const mD2 = mDays[mDays.length - 2];
  const mSpan = mDays.length ? `${fmtDay(mDays[0])} – ${fmtDay(mY)}` : "—";
  const mand = useMemo(() => {
    const daySet = new Set(mDays);
    const inRange = (cache.mandate?.rows || []).filter((r) => daySet.has(r.ts));
    const byCat = sumBy(inRange, (r) => r.category, ["success", "txn_init"]);
    const byCatDay = sumBy(inRange, (r) => `${r.category}|${r.ts}`, ["success", "txn_init"]);
    const byD = sumBy(inRange, (r) => r.ts, ["success", "txn_init"]);
    const srAt = (c, d) => {
      const v = byCatDay.get(`${c}|${d}`);
      return v ? pct(v.success, v.txn_init) : null;
    };
    const daySr = (d) => (byD.get(d) ? pct(byD.get(d).success, byD.get(d).txn_init) : null);
    const z = { success: 0, txn_init: 0 };
    const items = [...byCat.entries()]
      .sort((a, b) => b[1].txn_init - a[1].txn_init)
      .map(([c, v]) => {
        const sr = pct(v.success, v.txn_init);
        const yv = byCatDay.get(`${c}|${mY}`) || z;
        const ysr = pct(yv.success, yv.txn_init);
        return { id: c, cat: c, key: c, sub: fmtPct(sr, 1), ...v, sr, ys: yv.success, ysr, d2sr: srAt(c, mD2), dpp: ysr != null && sr != null ? ysr - sr : null, daily: mDays.map((d) => srAt(c, d)) };
      });
    const all = [...byCat.values()].reduce((a, v) => ({ success: a.success + v.success, txn_init: a.txn_init + v.txn_init }), { ...z });
    const yAll = byD.get(mY) || z;
    const total = { id: "__total", _total: true, cat: "All categories", ...all, sr: pct(all.success, all.txn_init), ys: yAll.success, ysr: pct(yAll.success, yAll.txn_init), d2sr: daySr(mD2), dpp: null };
    total.dpp = total.ysr != null && total.sr != null ? total.ysr - total.sr : null;
    return { items, total, srAt, daySr, success: mDays.map((d) => byD.get(d)?.success || 0) };
  }, [cache, mDays.join(), mY, mD2]); // eslint-disable-line react-hooks/exhaustive-deps
  const catDefault = mand.items.slice(0, LITE_CHART_TOP).map((i) => i.cat);
  const catSel = catPick || catDefault;

  return (
    <>
      <Section
        n={1}
        title="UPI Lite active account count"
        desc={`Distinct LRNs on ACTIVE Lite accounts (lite_account_snapshot_v3) joined to their PMS user. ${snapDesc(accSnaps)} Each daily run adds a snapshot; the trend appears from the second one.`}
        {...ctl("accounts")}
        kpis={accNow && <Kpi label="UPI Lite active accounts" value={fmtNum(accNow.active_accounts)} sub={snapDelta(accNow.active_accounts, accPrev?.active_accounts)} color={C.accent} />}
        chart={accSnaps.length > 1 && <TrendChart days={accSnaps.map((s) => s.asOf)} lines={[{ name: "Active accounts", color: SERIES[0], values: accSnaps.map((s) => s.rows[0]?.active_accounts ?? null) }]} yFmt={countFmt} dots />}
        cols={[
          { key: "asOf", label: "Snapshot (run date)", align: "left", render: (r) => fmtDay(r.asOf), text: (r) => r.asOf },
          { key: "v", label: "Active accounts", render: (r) => <b>{fmtNum(r.v)}</b>, text: (r) => String(r.v) },
          { key: "dv", label: "Δ vs prev", render: (r) => fmtSigned(r.dv, "", 0), text: (r) => fmtSigned(r.dv, "", 0) },
        ]}
        rows={[...accSnaps].reverse().map((s, i, arr) => {
          const v = s.rows[0]?.active_accounts ?? null;
          const p = arr[i + 1]?.rows[0]?.active_accounts;
          return { id: s.asOf, asOf: s.asOf, v, dv: v != null && p != null ? v - p : null };
        })}
        tableMaxHeight={300}
      />

      <Section
        n={2}
        title="UPILite Activation & Recharge (DOD)"
        desc="Successful txns per day from team_product.upi_lite_summary. Activation = create_mandate_and_activation + manual_activation; Recurring top-ups = manual_recurring_topup + recurring_mandate_execution."
        {...ctl("trend")}
        controls={trendCtl("s2", ["trend"])}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Activations yesterday" value={fmtNum(a2.Y.act)} sub={vsD2(a2.Y.act, a2.D2.act)} color={C.accent} />
              <Kpi label="Top-ups yesterday" value={fmtNum(a2.Y.top)} sub={vsD2(a2.Y.top, a2.D2.top)} />
              <Kpi label={`Activations · ${a2.n}d`} value={fmtNum(a2.T.act)} sub={`${fmtNum(a2.T.act / (a2.n || 1))} / day`} />
              <Kpi label={`Top-ups · ${a2.n}d`} value={fmtNum(a2.T.top)} sub={`${fmtNum(a2.T.top / (a2.n || 1))} / day`} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={a2.days}
              lines={[
                { name: "UPI Lite Activation", color: SERIES[0], values: a2.series((o) => o.act) },
                { name: "Recurring Top ups", color: SERIES[1], values: a2.series((o) => o.top) },
              ]}
              yFmt={countFmt}
            />
          )
        }
        cols={[a2.dateCol, { key: "act", label: "UPI Lite Activation", render: (r) => fmtNum(r.act), text: (r) => String(r.act) }, { key: "top", label: "Recurring Top ups", render: (r) => fmtNum(r.top), text: (r) => String(r.top) }]}
        rows={has("trend") ? a2.rows((o) => ({ act: o.act, top: o.top }), { act: a2.T.act, top: a2.T.top }) : []}
        tableMaxHeight={420}
      />

      <Section
        n={3}
        title="UPILite Activation & Recharge through Mandate (DOD)"
        desc="Activation through mandate = create_mandate_and_activation / all activations. Recharge through mandate = recurring_mandate_execution / all recurring top-ups. Range values are pooled (sum ÷ sum)."
        {...ctl("trend")}
        controls={trendCtl("s3", ["trend"])}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Activation via mandate · yday" value={fmtPct(pct(a3.Y.actM, a3.Y.act))} sub={ppVs(pct(a3.Y.actM, a3.Y.act), pct(a3.T.actM, a3.T.act), `${a3.n}d`)} color={C.accent} />
              <Kpi label="Recharge via mandate · yday" value={fmtPct(pct(a3.Y.topM, a3.Y.top))} sub={ppVs(pct(a3.Y.topM, a3.Y.top), pct(a3.T.topM, a3.T.top), `${a3.n}d`)} />
              <Kpi label={`Activation via mandate · ${a3.n}d`} value={fmtPct(pct(a3.T.actM, a3.T.act))} sub={`${fmtNum(a3.T.actM)} of ${fmtNum(a3.T.act)}`} />
              <Kpi label={`Recharge via mandate · ${a3.n}d`} value={fmtPct(pct(a3.T.topM, a3.T.top))} sub={`${fmtNum(a3.T.topM)} of ${fmtNum(a3.T.top)}`} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={a3.days}
              lines={[
                { name: "UPILite Activation through mandate", color: SERIES[0], values: a3.series((o) => pct(o.actM, o.act)) },
                { name: "UPILite recharge through mandate", color: SERIES[1], values: a3.series((o) => pct(o.topM, o.top)) },
              ]}
            />
          )
        }
        cols={[
          a3.dateCol,
          { key: "actM", label: "Mandate activations", render: (r) => fmtNum(r.actM), text: (r) => String(r.actM) },
          { key: "act", label: "All activations", render: (r) => fmtNum(r.act), text: (r) => String(r.act) },
          { key: "actP", label: "Activation via mandate", render: (r) => <b>{fmtPct(pct(r.actM, r.act))}</b>, text: (r) => fmtPct(pct(r.actM, r.act)) },
          { key: "topM", label: "Mandate recharges", render: (r) => fmtNum(r.topM), text: (r) => String(r.topM) },
          { key: "top", label: "All top-ups", render: (r) => fmtNum(r.top), text: (r) => String(r.top) },
          { key: "topP", label: "Recharge via mandate", render: (r) => <b>{fmtPct(pct(r.topM, r.top))}</b>, text: (r) => fmtPct(pct(r.topM, r.top)) },
        ]}
        rows={has("trend") ? a3.rows((o) => ({ act: o.act, actM: o.actM, top: o.top, topM: o.topM }), { act: a3.T.act, actM: a3.T.actM, top: a3.T.top, topM: a3.T.topM }) : []}
        tableMaxHeight={420}
      />

      <Section
        n={4}
        title="Deregister UPILite (DOD)"
        desc={`Successful '${LITE_DEREGISTER}' txns per day (upi_lite_recharge_txns).`}
        {...ctl("trend")}
        controls={trendCtl("s4", ["trend"])}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Deregistered yesterday" value={fmtNum(a4.Y.dereg)} sub={vsD2(a4.Y.dereg, a4.D2.dereg)} color={chg(a4.Y.dereg, a4.D2.dereg) >= TREND_PCT ? C.bad : undefined} />
              <Kpi label={`Deregistered · ${a4.n}d`} value={fmtNum(a4.T.dereg)} sub={`${fmtNum(a4.T.dereg / (a4.n || 1))} / day`} />
              <Kpi label="Deregister per activation" value={fmtPct(pct(a4.T.dereg, a4.T.act))} sub={`${a4.n}d, deregistrations ÷ activations`} />
            </>
          )
        }
        chart={has("trend") && <TrendChart days={a4.days} lines={[{ name: "Deregister UPI Lite", color: SERIES[6], values: a4.series((o) => o.dereg) }]} yFmt={countFmt} />}
        cols={[a4.dateCol, { key: "dereg", label: "Deregister UPI Lite", render: (r) => fmtNum(r.dereg), text: (r) => String(r.dereg) }]}
        rows={has("trend") ? a4.rows((o) => ({ dereg: o.dereg }), { dereg: a4.T.dereg }) : []}
        tableMaxHeight={420}
      />

      <Section
        n={5}
        title="UPI Lite transaction share & GMV"
        desc="UPILite txns = successful txns with payer_instrument UPI_LITE. Share = UPILite txns / all successful txns in upi_lite_summary. GMV = sum(amount) of successful txn_mode UPI_LITE txns in switch txn_info (same txns as the UPILite count)."
        {...ctl(["trend", "gmv"])}
        controls={trendCtl("s5", ["trend", "gmv"])}
        kpis={
          has("trend") && (
            <>
              <Kpi label="UPILite txns yesterday" value={fmtNum(a5.Y.liteS)} sub={vsD2(a5.Y.liteS, a5.D2.liteS)} color={C.accent} />
              <Kpi label="Share yesterday" value={fmtPct(pct(a5.Y.liteS, a5.Y.s), 2)} sub={ppVs(pct(a5.Y.liteS, a5.Y.s), pct(a5.T.liteS, a5.T.s), `${a5.n}d`)} />
              {has("gmv") && <Kpi label="GMV yesterday" value={fmtInr(gY.gmv)} sub={vsD2(gY.gmv, gD2.gmv)} color={C.accent} />}
              {has("gmv") && <Kpi label="Avg ticket yesterday" value={fmtInr(ticket(gY))} sub={`${fmtInr(ticket(gT))} over ${a5.n}d`} />}
              <Kpi label={`UPILite txns · ${a5.n}d`} value={fmtNum(a5.T.liteS)} sub={`${fmtNum(a5.T.liteS / (a5.n || 1))} / day · share ${fmtPct(pct(a5.T.liteS, a5.T.s), 2)}`} />
              {has("gmv") && <Kpi label={`GMV · ${a5.n}d`} value={fmtInr(gT.gmv)} sub={`${fmtInr(gT.gmv / (a5.n || 1))} / day`} />}
            </>
          )
        }
        chart={
          has("trend") && (
            <>
              <TrendChart
                days={a5.days}
                lines={[{ name: "Share of total transactions", color: SERIES[0], values: a5.series((o) => pct(o.liteS, o.s)) }]}
                bars={{ name: "UPILite Txns", values: a5.series((o) => o.liteS) }}
                yFmt={(v) => fmtPct(v, 2)}
              />
              {has("gmv") && (
                <TrendChart
                  days={a5.days}
                  lines={[{ name: "UPILite GMV", color: SERIES[3], values: a5.days.map((d) => (gmvByDay.has(d) ? gm(d).gmv : null)) }]}
                  bars={{ name: "Avg ticket", values: a5.days.map((d) => ticket(gm(d))) }}
                  yFmt={fmtInr}
                  barFmt={fmtInr}
                />
              )}
            </>
          )
        }
        cols={[
          a5.dateCol,
          { key: "liteS", label: "UPILite Txns", render: (r) => fmtNum(r.liteS), text: (r) => String(r.liteS) },
          { key: "s", label: "All successful txns", render: (r) => fmtNum(r.s), text: (r) => String(r.s) },
          { key: "share", label: "Share of total", render: (r) => <b>{fmtPct(pct(r.liteS, r.s), 2)}</b>, text: (r) => fmtPct(pct(r.liteS, r.s), 2) },
          { key: "gmv", label: "GMV", render: (r) => fmtInr(r.gmv), text: (r) => (r.gmv == null ? "" : r.gmv.toFixed(2)) },
          { key: "tk", label: "Avg ticket", render: (r) => fmtInr(ticket(r)), text: (r) => (ticket(r) == null ? "" : ticket(r).toFixed(2)) },
        ]}
        rows={
          has("trend")
            ? a5.rows((o, d) => ({ liteS: o.liteS, s: o.s, ...(gmvByDay.has(d) ? { gmv: gm(d).gmv, success: gm(d).success } : { gmv: null, success: 0 }) }), { liteS: a5.T.liteS, s: a5.T.s, gmv: has("gmv") ? gT.gmv : null, success: gT.success })
            : []
        }
        tableMaxHeight={420}
      />

      <Section
        n={6}
        title="UPI Lite Success Rate"
        desc="UPILite SR = success / txn_init for payer_instrument UPI_LITE. Overall SR = success / txn_init across upi_lite_summary. Red = day UPILite SR more than 5 pp below the range SR."
        {...ctl("trend")}
        controls={trendCtl("s6", ["trend"])}
        kpis={
          has("trend") && (
            <>
              <Kpi label="UPILite SR yesterday" value={fmtPct(pct(a6.Y.liteS, a6.Y.liteI), 2)} sub={ppVs(pct(a6.Y.liteS, a6.Y.liteI), pct(a6.T.liteS, a6.T.liteI), `${a6.n}d`)} color={C.accent} />
              <Kpi label="Overall SR yesterday" value={fmtPct(pct(a6.Y.s, a6.Y.i), 2)} sub={ppVs(pct(a6.Y.s, a6.Y.i), pct(a6.T.s, a6.T.i), `${a6.n}d`)} />
              <Kpi label={`UPILite SR · ${a6.n}d`} value={fmtPct(pct(a6.T.liteS, a6.T.liteI), 2)} sub={ppVs(pct(a6.T.liteS, a6.T.liteI), pct(a6.T.s, a6.T.i), "overall")} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={a6.days}
              lines={[
                { name: "UPILite SR %", color: SERIES[1], values: a6.series((o) => pct(o.liteS, o.liteI)) },
                { name: "Overall SR %", color: "#e2e8f0", dashed: true, values: a6.series((o) => pct(o.s, o.i)) },
              ]}
              yFmt={(v) => fmtPct(v, 2)}
            />
          )
        }
        cols={[
          a6.dateCol,
          { key: "liteI", label: "UPILite init", render: (r) => fmtNum(r.liteI), text: (r) => String(r.liteI) },
          { key: "liteS", label: "UPILite success", render: (r) => fmtNum(r.liteS), text: (r) => String(r.liteS) },
          {
            key: "liteSr",
            label: "UPILite SR %",
            render: (r) => {
              const v = pct(r.liteS, r.liteI);
              const low = !r._total && v != null && v < pct(a6.T.liteS, a6.T.liteI) - LOW_SR_PP;
              return <b style={{ color: low ? C.bad : C.text }}>{fmtPct(v, 2)}</b>;
            },
            text: (r) => fmtPct(pct(r.liteS, r.liteI), 2),
          },
          { key: "i", label: "All init", render: (r) => fmtNum(r.i), text: (r) => String(r.i) },
          { key: "sr", label: "Overall SR %", render: (r) => fmtPct(pct(r.s, r.i), 2) },
        ]}
        rows={has("trend") ? a6.rows((o) => ({ liteS: o.liteS, liteI: o.liteI, s: o.s, i: o.i }), { liteS: a6.T.liteS, liteI: a6.T.liteI, s: a6.T.s, i: a6.T.i }) : []}
        tableMaxHeight={420}
      />

      <Section
        n={7}
        title="UPI Lite errors — error type & error codes"
        desc={`txn_init by ${isType ? "error_type" : `app_resp_code (top ${LITE_TOP_CODES}; codes outside the query window's top 100 are grouped as OTHER)`} as a % of the day's txn_init. Successful rows count as SUCCESS (shown as a KPI). Click a chip to add or remove it from the chart. Red = yesterday's share above the range share.`}
        {...ctl("codes")}
        controls={
          <>
            {trendCtl("err", ["codes"], LITE_ERR_TRENDS)}
            <Pills label="View" value={errDim} onChange={setErrDim} options={[["type", "Error type"], ["code", `Error codes (top ${LITE_TOP_CODES})`]]} />
            <Pills label="Rows" value={errScope} onChange={setErrScope} options={[["all", "All summary rows"], ["lite", "UPI_LITE payer only"]]} />
          </>
        }
        kpis={
          has("codes") && (
            <>
              <Kpi label="SUCCESS share yesterday" value={fmtPct(types.success.ys, 2)} sub={ppVs(types.success.ys, types.success.share, `${eDays.length}d`)} color={C.good} />
              <Kpi label="Top error type" value={types.items[0]?.key || "—"} sub={types.items[0] ? `${fmtPct(types.items[0].share, 2)} of txns · ${eDays.length}d` : undefined} />
              <Kpi label="Top error code" value={codes.items[0]?.key || "—"} sub={codes.items[0] ? `${fmtPct(codes.items[0].share, 2)} of txns · ${eDays.length}d` : undefined} />
              <Kpi label={`${isType ? "Types" : "Codes"} up yesterday`} value={bd.items.filter((i) => i.dpp > 0.05).length} color={C.bad} sub={`of ${bd.items.length}, share above range`} />
            </>
          )
        }
        chart={
          has("codes") && (
            <>
              <Chips items={bd.items.map((i) => ({ key: i.key, sub: fmtPct(i.share, 2) }))} sel={bdSel} onToggle={bdToggle} />
              <TrendChart days={eDays} lines={bdSel.map((k, i) => ({ name: k, color: SERIES[i % SERIES.length], values: bd.items.find((x) => x.key === k)?.daily || eDays.map(() => null) }))} yFmt={(v) => fmtPct(v, 2)} />
            </>
          )
        }
        cols={shareCols}
        rows={bd.items.map((i) => ({ ...i, _active: bdSel.includes(i.key), _onClick: () => bdToggle(i.key) }))}
        downloads={[
          { label: "⬇ Summary CSV", name: `UPI Lite ${bdLabel} share ${eSpan}`, cols: shareCols, rows: bd.items },
          { label: "⬇ Daily CSV", name: `UPI Lite ${bdLabel} daily ${eSpan}`, cols: errDailyCols, rows: errDailyRows },
        ]}
        tableMaxHeight={420}
      />

      <Section
        n={8}
        title="UPI Lite Autopay"
        desc={`Active Lite autopay = distinct UMNs with mandate_status ACTIVE and an LRN (standing_instructions_snapshot_v3). Revoked = customers with a Lite REVOKE; never re-enabled = no CREATE after their first revoke. Trend = Lite CREATE / REVOKE requests per day, last 7 days. One query computes all of it (REVOKE and CREATE in the same pass). ${snapDesc(apSnaps)}`}
        {...ctl("autopay")}
        kpis={
          apNow && (
            <>
              <Kpi label="Active Lite Autopay" value={fmtNum(apNow.active)} sub={snapDelta(apNow.active, apPrev?.active)} color={C.accent} />
              <Kpi label="Users who revoked Lite autopay" value={fmtNum(apNow.revoked)} sub={snapDelta(apNow.revoked, apPrev?.revoked)} />
              <Kpi label="Revoked, never re-enabled" value={fmtNum(apNow.never_again)} sub={`${fmtPct(pct(apNow.never_again, apNow.revoked))} of revoked users`} color={C.bad} />
              {apDays.length > 0 && <Kpi label={`CREATE / REVOKE · ${apDays.length}d`} value={`${fmtNum(apDays.reduce((s, r) => s + r.creates, 0))} / ${fmtNum(apDays.reduce((s, r) => s + r.revokes, 0))}`} />}
            </>
          )
        }
        chart={
          apDays.length > 0 && (
            <TrendChart
              days={apDays.map((r) => r.ts)}
              lines={[
                { name: "CREATE", color: SERIES[1], values: apDays.map((r) => r.creates) },
                { name: "REVOKE", color: SERIES[6], values: apDays.map((r) => r.revokes) },
              ]}
              yFmt={countFmt}
              dots
            />
          )
        }
        cols={
          apDays.length
            ? [
                { key: "ts", label: "Date", align: "left", render: (r) => fmtDay(r.ts), text: (r) => r.ts },
                { key: "creates", label: "CREATE", render: (r) => fmtNum(r.creates), text: (r) => String(r.creates) },
                { key: "revokes", label: "REVOKE", render: (r) => fmtNum(r.revokes), text: (r) => String(r.revokes) },
                { key: "net", label: "CREATE − REVOKE", render: (r) => fmtSigned(r.creates - r.revokes, "", 0), text: (r) => String(r.creates - r.revokes) },
              ]
            : [
                { key: "asOf", label: "Snapshot (run date)", align: "left", render: (r) => fmtDay(r.asOf), text: (r) => r.asOf },
                { key: "active", label: "Active Lite Autopay", render: (r) => <b>{fmtNum(r.active)}</b>, text: (r) => String(r.active) },
                { key: "revoked", label: "Users who revoked", render: (r) => fmtNum(r.revoked), text: (r) => String(r.revoked) },
                { key: "never", label: "Revoked, never re-enabled", render: (r) => fmtNum(r.never_again), text: (r) => String(r.never_again) },
              ]
        }
        rows={apDays.length ? [...apDays].reverse().map((r) => ({ ...r, id: r.ts })) : [...apSnaps].reverse().map((s) => ({ id: s.asOf, asOf: s.asOf, ...apTotal(s.rows) }))}
        tableMaxHeight={300}
      />

      <Section
        n={9}
        title="UPI Lite Mandate Creation success rate"
        desc="team_product.lite_autopay_txns by autopay_category. SR = success / txn_init; range SR is pooled. Click a chip to add or remove a category from the chart."
        {...ctl("mandate")}
        controls={trendCtl("mand", ["mandate"])}
        kpis={
          has("mandate") && (
            <>
              <Kpi label="Success txns yesterday" value={fmtNum(mand.total.ys)} color={C.accent} />
              <Kpi label="SR yesterday" value={fmtPct(mand.total.ysr, 2)} sub={ppVs(mand.total.ysr, mand.total.sr, `${mDays.length}d`)} />
              <Kpi label={`Success txns · ${mDays.length}d`} value={fmtNum(mand.total.success)} sub={`SR ${fmtPct(mand.total.sr, 2)}`} />
            </>
          )
        }
        chart={
          has("mandate") && (
            <>
              <Chips items={mand.items} sel={catSel} onToggle={(c) => toggle(catPick, setCatPick, catDefault, c)} />
              <TrendChart
                days={mDays}
                lines={[
                  ...catSel.map((c, i) => ({ name: c, color: SERIES[i % SERIES.length], values: mDays.map((d) => mand.srAt(c, d)) })),
                  { name: "Overall", color: "#e2e8f0", dashed: true, values: mDays.map((d) => mand.daySr(d)) },
                ]}
                bars={{ name: "Success txns", values: mand.success }}
                yFmt={(v) => fmtPct(v, 2)}
              />
            </>
          )
        }
        cols={[
          { key: "cat", label: "Autopay category", align: "left", render: (r) => (r._total ? r.cat : <span>{catSel.includes(r.cat) && <span style={{ color: SERIES[catSel.indexOf(r.cat) % SERIES.length] }}>● </span>}{r.cat}</span>), text: (r) => r.cat },
          { key: "success", label: "Success txns", title: mSpan, render: (r) => fmtNum(r.success), text: (r) => String(r.success) },
          { key: "txn_init", label: "Initiated", title: mSpan, render: (r) => fmtNum(r.txn_init), text: (r) => String(r.txn_init) },
          { key: "sr", label: "SR %", title: mSpan, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
          { key: "ys", label: "Yesterday success", title: fmtDay(mY), render: (r) => fmtNum(r.ys), text: (r) => String(r.ys) },
          { key: "ysr", label: "Yesterday SR", title: fmtDay(mY), render: (r) => fmtPct(r.ysr, 2) },
          { key: "d2sr", label: "D-2 SR", title: fmtDay(mD2), render: (r) => fmtPct(r.d2sr, 2) },
          { key: "dpp", label: "vs range", title: "Yesterday SR − range SR, percentage points", render: (r) => <span style={{ color: r.dpp == null || Math.abs(r.dpp) < 0.05 ? C.text2 : r.dpp > 0 ? C.good : C.bad }}>{fmtSigned(r.dpp, " pp")}</span>, text: (r) => fmtSigned(r.dpp, " pp") },
          { key: "daily", label: "Trend", title: `Daily SR, ${mSpan}`, render: (r) => (r._total ? "" : <Spark values={r.daily} days={mDays} name={rowName(r)} metric="SR" unit="pct" color="#94a3b8" />), text: () => "" },
        ]}
        rows={has("mandate") ? [...mand.items.map((i) => ({ ...i, _active: catSel.includes(i.cat), _onClick: () => toggle(catPick, setCatPick, catDefault, i.cat) })), mand.total] : []}
        tableMaxHeight={420}
      />

      <Section
        n={10}
        title="UPI Lite users with Security Shield"
        desc={`Users with an ACTIVE Lite account (latest status), by PSP, against their latest Security Shield preference (ups preference 44). Runs only when you click ↻ Refresh here — never with Refresh all or the daily schedule. ${snapDesc(shSnaps)}`}
        {...ctl("shield")}
        emptyText="Not run automatically — click ↻ Refresh on this panel to run it."
        kpis={
          shNow && (
            <>
              <Kpi label="Active Lite users" value={fmtNum(shNow.users)} sub={snapDelta(shNow.users, shPrev?.users)} />
              <Kpi label="Shield enabled" value={fmtNum(shNow.enabled)} sub={snapDelta(shNow.enabled, shPrev?.enabled)} color={C.accent} />
              <Kpi label="Enabled %" value={fmtPct(pct(shNow.enabled, shNow.users), 2)} sub={shPrev ? ppVs(pct(shNow.enabled, shNow.users), pct(shPrev.enabled, shPrev.users), "prev run") : undefined} />
            </>
          )
        }
        cols={[
          { key: "split", label: "PSP", align: "left", render: (r) => r.split },
          { key: "users", label: "Active Lite users", render: (r) => fmtNum(r.users), text: (r) => String(r.users) },
          { key: "enabled", label: "Shield enabled", render: (r) => fmtNum(r.enabled), text: (r) => String(r.enabled) },
          { key: "enP", label: "Enabled %", render: (r) => <b>{fmtPct(pct(r.enabled, r.users), 2)}</b>, text: (r) => fmtPct(pct(r.enabled, r.users), 2) },
          { key: "not", label: "Not enabled", render: (r) => fmtNum(r.not_enabled), text: (r) => String(r.not_enabled) },
          { key: "nopref", label: "No preference record", render: (r) => fmtNum(r.no_pref), text: (r) => String(r.no_pref) },
          { key: "nocust", label: "No customer id", render: (r) => fmtNum(r.no_cust), text: (r) => String(r.no_cust) },
        ]}
        rows={lastOf(shSnaps)
          .map((r) => ({ ...r, id: r.split, _total: r.split === "TOTAL" }))
          .sort((a, b) => (LITE_SPLITS.indexOf(a.split) + 1 || 99) - (LITE_SPLITS.indexOf(b.split) + 1 || 99))}
      />
    </>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

// ─── UPI Refunds / Payouts ───────────────────────────────────────────────────
//
// One cached "daily" query per product (refund MySQL via PTYBL Redash, last 30 complete days).
// The range picker (MONEY_RANGES, default 5 days) picks the current period; the previous
// period is the same number of days right before it. SR = SUCCESS / all rows (as in the
// reference queries — PROCESSING / DEEMED count as not successful).

const MONEY_RANGES = [1, 2, 3, 5, 7, 15];
const MONEY_DEFAULT_RANGE = 5;
const UDIR_SR_FLOOR = 80;
const REFUND_FLOWS = [
  { id: "VPA", label: "Refund via VPA", color: "#60a5fa", desc: "extended_info.refundType = VPA" },
  { id: "UDIR", label: "Refund via UDIR", color: "#f472b6", desc: "extended_info.flowType = UDIR" },
  { id: "DEFAULT", label: "Refund default (account)", color: "#fbbf24", desc: "refundType ACCOUNT, flowType DEFAULT / blank" },
];
const refundFlowOf = (r) => (r.flow_type === "UDIR" ? "UDIR" : r.refund_type === "VPA" ? "VPA" : "DEFAULT");

/** Current / previous periods of `range` days ending at the latest day in rows. */
function moneyPeriods(cached, range) {
  const rows = cached?.rows || [];
  let last = "";
  for (const r of rows) if (r.ts > last) last = r.ts;
  if (!last) return null;
  const from = cached.window?.fromDate || rows.reduce((a, r) => (r.ts < a ? r.ts : a), last);
  const all = daysBetween(from, toDay(toMs(last) + DAY));
  const cur = all.slice(-range);
  const prev = all.slice(-2 * range, -range);
  const chart = [...prev, ...cur];
  return { cur, prev, chart, curSet: new Set(cur), prevSet: new Set(prev), from: cur[0], to: cur[cur.length - 1] };
}

const spanLabel = (days) => (!days?.length ? "—" : days.length === 1 ? fmtDay(days[0]) : `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}`);

/** Day totals { c, s, f, o, amt, samt } for rows, keyed by ts. o = neither SUCCESS nor FAILURE. */
function statusByDay(rows) {
  const m = new Map();
  for (const r of rows) {
    let o = m.get(r.ts);
    if (!o) m.set(r.ts, (o = { c: 0, s: 0, f: 0, o: 0, amt: 0, samt: 0 }));
    o.c += r.c;
    o.amt += r.amt;
    if (r.status === "SUCCESS") {
      o.s += r.c;
      o.samt += r.amt;
    } else if (r.status === "FAILURE") o.f += r.c;
    else o.o += r.c;
  }
  return m;
}
const ZERO_DAY = { c: 0, s: 0, f: 0, o: 0, amt: 0, samt: 0 };
const addDaysOf = (m, days) => days.reduce((a, d) => Object.fromEntries(Object.keys(ZERO_DAY).map((k) => [k, a[k] + (m.get(d) || ZERO_DAY)[k]])), { ...ZERO_DAY });

function srTone(v, ref) {
  return v != null && ref != null && v < ref - LOW_SR_PP ? C.bad : C.text;
}

/** Daily table + KPIs + SR chart for one slice of rows (overall refunds / one flow / payouts). */
function useDailySlice(rows, P) {
  return useMemo(() => {
    if (!P) return null;
    const byDay = statusByDay(rows);
    const cur = addDaysOf(byDay, P.cur);
    const prev = addDaysOf(byDay, P.prev);
    const curSr = pct(cur.s, cur.c);
    const g = (d) => byDay.get(d) || ZERO_DAY;
    const tableRows = [...P.cur].reverse().map((d) => ({ id: d, d, ...g(d), sr: pct(g(d).s, g(d).c) }));
    tableRows.push({ id: "__total", d: "Total", _total: true, ...cur, sr: curSr });
    return { cur, prev, curSr, prevSr: pct(prev.s, prev.c), rows: tableRows, sr: P.chart.map((d) => pct(g(d).s, g(d).c)), count: P.chart.map((d) => g(d).c), byDay };
  }, [rows, P]);
}

function dailyCols(slice, { otherLabel = "Processing", amtLabel = "Amount ₹" } = {}) {
  return [
    { key: "d", label: "Date", align: "left", render: (r) => (r._total ? "Total" : fmtDay(r.d)), text: (r) => (r._total ? "Total" : r.d) },
    { key: "c", label: "Total", render: (r) => fmtNum(r.c) },
    { key: "s", label: "Success", render: (r) => fmtNum(r.s) },
    { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
    { key: "o", label: otherLabel, render: (r) => fmtNum(r.o) },
    { key: "sr", label: "SR", render: (r) => <b style={{ color: r._total ? C.text : srTone(r.sr, slice?.curSr) }}>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "amt", label: amtLabel, title: "Sum of amount, all statuses", render: (r) => fmtInr(r.amt) },
    { key: "samt", label: "Success ₹", render: (r) => fmtInr(r.samt) },
  ];
}

function sliceKpis(slice, { noun, amtNoun }) {
  if (!slice) return null;
  return (
    <>
      <Kpi label={noun} value={fmtNum(slice.cur.c)} sub={`${fmtSigned(chg(slice.cur.c, slice.prev.c), "%")} vs prev`} />
      <Kpi label="Success rate" value={fmtPct(slice.curSr, 2)} sub={slice.curSr != null && slice.prevSr != null ? `${fmtSigned(slice.curSr - slice.prevSr, " pp", 2)} vs prev` : "vs prev —"} color={slice.prevSr != null && slice.curSr < slice.prevSr - 0.5 ? C.bad : undefined} />
      <Kpi label="Failed" value={fmtNum(slice.cur.f)} sub={`${fmtSigned(chg(slice.cur.f, slice.prev.f), "%")} vs prev`} color={slice.prev.f && slice.cur.f > slice.prev.f * 1.1 ? C.bad : undefined} />
      <Kpi label={amtNoun} value={fmtInr(slice.cur.amt)} sub={`${fmtSigned(chg(slice.cur.amt, slice.prev.amt), "%")} vs prev`} />
    </>
  );
}

const TOP_N_OPTIONS = [
  [15, "Top 15"],
  [30, "Top 30"],
];
const REFUND_FLOW_FILTER = [["all", "All flows"], ...REFUND_FLOWS.map((f) => [f.id, f.label])];
const ppToneOf = (v) => (v == null || Math.abs(v) < 0.05 ? C.text2 : v > 0 ? C.good : C.bad);

/**
 * Decline codes for Refunds / Payouts, laid out like Unified SR "B · Decline Codes":
 *   day view — failures on the latest day Y with ₹, share, D-1 / D-2 / D-3 / LW (count · Δ now)
 *              and Δ vs the L7D daily average (+ top 3 payee banks when rows carry a bank);
 *   contribution — Yesterday / MTD / LMTD failures and contribution % (unified-scorecard).
 * rows: FAILURE rows { ts, code, c, amt, bank?, msg? }; yday: latest complete day.
 */
function DeclineCodes({ rows, yday, codeInfo, topN, bankLabel, noAmount = false }) {
  const [q, setQ] = useState("");
  const P = useMemo(() => (yday ? periods(yday) : null), [yday]);
  const day = useMemo(() => {
    if (!yday) return null;
    const at = (n) => toDay(toMs(yday) - n * DAY);
    const days = { now: yday, d1: at(1), d2: at(2), d3: at(3), lw: at(7) };
    const l7 = new Set(Array.from({ length: 7 }, (_, i) => at(i + 1)));
    const by = new Map();
    const banks = new Map();
    for (const r of rows) {
      let o = by.get(r.code);
      if (!o) by.set(r.code, (o = { code: r.code, now: 0, amount: 0, d1: 0, d2: 0, d3: 0, lw: 0, l7: 0, msg: r.msg || "" }));
      if (!o.msg && r.msg) o.msg = r.msg;
      if (r.ts === days.now) {
        o.now += r.c;
        o.amount += r.amt;
        if (r.bank) banks.set(`${r.code}|${r.bank}`, (banks.get(`${r.code}|${r.bank}`) || 0) + r.c);
      }
      for (const k of ["d1", "d2", "d3", "lw"]) if (r.ts === days[k]) o[k] += r.c;
      if (l7.has(r.ts)) o.l7 += r.c;
    }
    const total = { code: "All failures", now: 0, amount: 0, d1: 0, d2: 0, d3: 0, lw: 0, l7: 0 };
    for (const o of by.values()) for (const k of Object.keys(total)) if (k !== "code") total[k] += o[k];
    const finish = (o) => {
      const avg = o.l7 / 7;
      const out = { ...o, share: pct(o.now, total.now), vsAvg: chg(o.now, avg), excess: o.now - avg };
      for (const k of ["d1", "d2", "d3", "lw"]) out[`${k}Δ`] = chg(o.now, o[k]);
      return out;
    };
    const topBanks = (code) =>
      [...banks.entries()]
        .filter(([k]) => k.startsWith(`${code}|`))
        .map(([k, n]) => [k.slice(code.length + 1), n])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
    const list = [...by.values()].filter((o) => o.now || o.l7).map(finish).sort((a, b) => b.now - a.now || b.l7 - a.l7);
    return { days, list, total: finish(total), topBanks };
  }, [rows, yday]);

  const score = useMemo(() => {
    if (!P) return null;
    const descr = Object.fromEntries(Object.keys(codeInfo || {}).map((c) => [c, codeInfo[c]?.bank || codeInfo[c]?.npci || ""]));
    return errorRows(aggregate(rows.map((r) => ({ ts: r.ts, dim: r.code, total: r.c, success: 0 })), P), topN, descr);
  }, [rows, P, codeInfo, topN]);

  if (!day || !P) return <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>No failures in the cached data.</div>;
  const descOf = (code) => {
    const i = codeInfo?.[code];
    return { npci: i ? [i.npci, i.bank].filter(Boolean).join(" · ") : "", type: i?.type || "" };
  };
  const needle = q.trim().toLowerCase();
  const filtered = day.list.filter((r) => !needle || r.code.toLowerCase().includes(needle) || descOf(r.code).npci.toLowerCase().includes(needle) || (r.msg || "").toLowerCase().includes(needle));
  const shown = needle ? filtered : filtered.slice(0, topN);
  const dayCols = [
    { key: "d1", label: "D-1" },
    { key: "d2", label: "D-2" },
    { key: "d3", label: "D-3" },
    { key: "lw", label: "LW" },
  ];
  const per = periodLabels(P);
  const cols = [
    {
      key: "code",
      label: "Code · NPCI description",
      align: "left",
      wrap: true,
      render: (r) =>
        r._total ? (
          "All failures"
        ) : (
          <div style={{ minWidth: 240, maxWidth: 380 }}>
            <code style={{ fontSize: 12, fontWeight: 700 }}>{r.code}</code>
            {descOf(r.code).type && <span style={{ fontSize: 10, marginLeft: 6, padding: "0 5px", borderRadius: 4, border: `1px solid ${C.border}`, color: descOf(r.code).type === "TD" ? C.warn : C.text2 }}>{descOf(r.code).type}</span>}
            {descOf(r.code).npci && <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.35 }}>{descOf(r.code).npci}</div>}
            {r.msg && <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.35 }}>“{r.msg}”</div>}
          </div>
        ),
      text: (r) => (r._total ? "All failures" : `${r.code} ${descOf(r.code).npci}`),
    },
    { key: "now", label: `Failures ${fmtDay(day.days.now)}`, render: (r) => <b>{fmtNum(r.now)}</b>, text: (r) => String(r.now) },
    ...(noAmount ? [] : [{ key: "amount", label: "Amount", title: "₹ value of failed rows on the latest day", render: (r) => fmtInr(r.amount) }]),
    { key: "share", label: "Share", title: "Share of all failures that day", render: (r) => fmtPct(r.share) },
    ...dayCols.map((c) => ({
      key: c.key,
      label: c.label,
      title: `${fmtDay(day.days[c.key])}${c.key === "lw" ? " (same weekday last week)" : ""}; below: now vs that day`,
      render: (r) => (
        <div>
          <div>{fmtNum(r[c.key])}</div>
          <div style={{ fontSize: 11, color: ppToneOf(r[`${c.key}Δ`] == null ? null : -r[`${c.key}Δ`]) }}>{fmtSigned(r[`${c.key}Δ`], "%")}</div>
        </div>
      ),
      text: (r) => `${r[c.key]} (${fmtSigned(r[`${c.key}Δ`], "%")})`,
    })),
    {
      key: "vsAvg",
      label: "Δ vs L7D avg",
      title: "Latest day vs the daily average of the 7 days before it",
      render: (r) => (
        <div>
          <b style={{ color: ppToneOf(r.vsAvg == null ? null : -r.vsAvg) }}>{fmtSigned(r.vsAvg, "%")}</b>
          <div style={{ fontSize: 11, color: C.muted }}>{r.excess > 0 ? "+" : ""}{fmtNum(r.excess)} vs avg</div>
        </div>
      ),
      text: (r) => fmtSigned(r.vsAvg, "%"),
    },
    ...(bankLabel
      ? [
          {
            key: "banks",
            label: bankLabel,
            align: "left",
            render: (r) => (r._total ? "" : <span style={{ fontSize: 12 }}>{day.topBanks(r.code).map(([b, n]) => `${b} ${fmtNum(n)}`).join(", ")}</span>),
            text: (r) => (r._total ? "" : day.topBanks(r.code).map(([b, n]) => `${b} ${n}`).join(", ")),
          },
        ]
      : []),
  ];
  return (
    <div style={{ padding: "4px 0 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 16px" }}>
        <span style={{ fontSize: 11, color: C.muted, flex: 1 }}>
          Day view: failures on <b style={{ color: C.text2 }}>{fmtDay(day.days.now)}</b> (latest complete day) vs D-1…D-3, LW and the L7D average — fixed to the latest day, not the range picker. {needle ? "" : `Showing top ${Math.min(topN, filtered.length)} of ${filtered.length} codes.`}
        </span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter code / description…" style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: "5px 9px", width: 210 }} />
      </div>
      <Table cols={cols} rows={[...shown.map((r) => ({ ...r, id: r.code })), { ...day.total, id: "__total", _total: true }]} maxHeight={560} />
      <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 16px 8px" }}>Top error codes and contribution % — Yesterday / MTD / LMTD</div>
      <div style={{ padding: "0 16px" }}>
        {score && <ScoreTable firstCol="Error code" cols={errorCols(per)} rows={score.rows} total={score.total} caption={`Yesterday ${per.y} · MTD ${per.mtd} vs LMTD ${per.lmtd}`} />}
      </div>
    </div>
  );
}

function RefundsView({ cached, job, range, codeInfo, onShowSql, onRun, onStop }) {
  const [flowSel, setFlowSel] = useState("all");
  const [bankFlow, setBankFlow] = useState("UDIR");
  const [lowOnly, setLowOnly] = useState(false);
  const [bankTop, setBankTop] = useState(15);
  const [codeFlow, setCodeFlow] = useState("all");
  const [codeTop, setCodeTop] = useState(15);
  const P = useMemo(() => moneyPeriods(cached, range), [cached, range]);
  const online = useMemo(() => (cached?.rows || []).filter((r) => r.mode === "ONLINE"), [cached]);
  const inFlow = (sel) => (r) => sel === "all" || refundFlowOf(r) === sel;
  const overallRows = useMemo(() => online.filter(inFlow(flowSel)), [online, flowSel]);
  const overall = useDailySlice(overallRows, P);
  const curFrom = P ? P.prev.length : 0;
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const panel = { job, cached, onShowSql, onRefresh: onRun, onStop };
  const flowLabel = (sel) => (sel === "all" ? "all flows" : REFUND_FLOWS.find((f) => f.id === sel).label);

  // Flow comparison (current vs previous period per flow).
  const flows = useMemo(() => {
    if (!P) return null;
    const tag = (r) => ({ ...r, s: r.status === "SUCCESS" ? r.c : 0, f: r.status === "FAILURE" ? r.c : 0 });
    const by = (set) => sumBy(online.filter((r) => set.has(r.ts)).map(tag), refundFlowOf, ["c", "s", "f", "amt"]);
    const cur = by(P.curSet);
    const prev = by(P.prevSet);
    const daily = sumBy(online.map(tag), (r) => `${r.ts}|${refundFlowOf(r)}`, ["c", "s"]);
    const total = [...cur.values()].reduce((a, v) => a + v.c, 0);
    const items = REFUND_FLOWS.map((f) => {
      const c = cur.get(f.id) || { c: 0, s: 0, f: 0, amt: 0 };
      const p = prev.get(f.id) || { c: 0, s: 0, f: 0, amt: 0 };
      const sr = pct(c.s, c.c);
      const psr = pct(p.s, p.c);
      return { id: f.id, flow: f, ...c, share: pct(c.c, total), sr, psr, dpp: sr != null && psr != null ? sr - psr : null, cChg: chg(c.c, p.c) };
    });
    const lines = REFUND_FLOWS.map((f) => ({ name: f.label, color: f.color, values: P.chart.map((d) => pct(daily.get(`${d}|${f.id}`)?.s || 0, daily.get(`${d}|${f.id}`)?.c || 0)) }));
    return { items, lines };
  }, [online, P]);

  // Payee bank SR for the chosen flow (first 4 chars of extended_info.payeeIfsc).
  const banks = useMemo(() => {
    if (!P) return null;
    const src = online.filter(inFlow(bankFlow)).map((r) => ({ ...r, s: r.status === "SUCCESS" ? r.c : 0, f: r.status === "FAILURE" ? r.c : 0 }));
    const cur = sumBy(src.filter((r) => P.curSet.has(r.ts)), (r) => r.bank, ["c", "s", "f"]);
    const prev = sumBy(src.filter((r) => P.prevSet.has(r.ts)), (r) => r.bank, ["c", "s", "f"]);
    const daily = sumBy(src, (r) => `${r.ts}|${r.bank}`, ["c", "s"]);
    const srOf = (b, d) => {
      const v = daily.get(`${d}|${b}`);
      return v ? pct(v.s, v.c) : null;
    };
    const items = [...cur.entries()]
      .map(([b, v]) => {
        const p = prev.get(b) || { c: 0, s: 0, f: 0 };
        const sr = pct(v.s, v.c);
        const psr = pct(p.s, p.c);
        const lowDays = P.cur.filter((d) => {
          const x = srOf(b, d);
          return x != null && x < UDIR_SR_FLOOR;
        }).length;
        return { id: b, bank: b, ...v, sr, psr, dpp: sr != null && psr != null ? sr - psr : null, lowDays, daily: P.chart.map((d) => srOf(b, d)) };
      })
      .sort((a, b) => b.c - a.c);
    const all = [...cur.values()].reduce((a, v) => ({ c: a.c + v.c, s: a.s + v.s, f: a.f + v.f }), { c: 0, s: 0, f: 0 });
    return { items, all, overall: pct(all.s, all.c), srOf, low: items.filter((i) => (i.sr != null && i.sr < UDIR_SR_FLOOR) || i.lowDays > 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, P, bankFlow]);

  const codeRows = useMemo(() => online.filter((r) => r.status === "FAILURE" && r.code && inFlow(codeFlow)(r)), [online, codeFlow]);
  const lastDay = useMemo(() => (cached?.rows || []).reduce((a, r) => (r.ts > a ? r.ts : a), ""), [cached]);

  const showDayCols = P && P.cur.length > 1 && P.cur.length <= 7;
  const bankRows = banks ? (lowOnly ? banks.low : banks.items.slice(0, bankTop)) : [];
  const bankCols = banks
    ? [
        { key: "bank", label: "Payee bank (IFSC)", align: "left", render: (r) => r.bank, text: (r) => r.bank },
        { key: "c", label: "Refunds", render: (r) => fmtNum(r.c) },
        { key: "share", label: "Share", render: (r) => fmtPct(pct(r.c, banks.all.c)) },
        { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
        { key: "sr", label: "SR", title: curLabel, render: (r) => <b style={{ color: r.sr != null && r.sr < UDIR_SR_FLOOR ? C.bad : srTone(r.sr, banks.overall) }}>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
        { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
        { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
        { key: "low", label: `Days < ${UDIR_SR_FLOOR}%`, render: (r) => <span style={{ color: r.lowDays ? C.bad : C.muted }}>{r.lowDays}</span> },
        ...(showDayCols
          ? P.cur.map((d) => ({
              key: d,
              label: fmtDay(d),
              render: (r) => {
                const v = banks.srOf(r.bank, d);
                return <span style={{ color: v != null && v < UDIR_SR_FLOOR ? C.bad : C.text2 }}>{fmtPct(v)}</span>;
              },
              text: (r) => fmtPct(banks.srOf(r.bank, d)),
            }))
          : []),
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={ppToneOf(r.dpp) === C.text2 ? "#94a3b8" : ppToneOf(r.dpp)} curFrom={curFrom} />, text: () => "" },
      ]
    : [];

  const flowCols = flows
    ? [
        { key: "flow", label: "Flow", align: "left", render: (r) => <span><span style={{ color: r.flow.color }}>● </span>{r.flow.label}</span>, text: (r) => r.flow.label },
        { key: "c", label: "Refunds", title: curLabel, render: (r) => fmtNum(r.c) },
        { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
        { key: "cChg", label: "vs prev", render: (r) => fmtSigned(r.cChg, "%") },
        { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
        { key: "sr", label: "SR", title: curLabel, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
        { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
        { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
        { key: "amt", label: "Amount ₹", render: (r) => fmtInr(r.amt) },
        { key: "def", label: "Definition", align: "left", render: (r) => <span style={{ fontSize: 12, color: C.muted }}>{r.flow.desc}</span>, text: (r) => r.flow.desc },
      ]
    : [];
  const flowColor = flowSel === "all" ? "#60a5fa" : REFUND_FLOWS.find((f) => f.id === flowSel).color;

  return (
    <>
      <Section
        n={1}
        title={`UPI Refunds overall${flowSel === "all" ? "" : ` — ${flowLabel(flowSel)}`}`}
        desc={`refund_info, mode ONLINE, ${flowLabel(flowSel)}. SR = SUCCESS / all refunds. Current ${curLabel} vs previous ${prevLabel}. Red = day SR more than ${LOW_SR_PP} pp below the period SR.`}
        {...panel}
        controls={<Pills label="Flow" value={flowSel} options={REFUND_FLOW_FILTER} onChange={setFlowSel} />}
        kpis={sliceKpis(overall, { noun: "Refunds", amtNoun: "Refund amount" })}
        chart={overall && P && <TrendChart days={P.chart} lines={[{ name: `Refund SR · ${flowLabel(flowSel)}`, color: flowColor, values: overall.sr }]} bars={{ name: "Refunds", values: overall.count }} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        tableToggle
        cols={dailyCols(overall)}
        rows={overall?.rows || []}
        emptyText="No data yet — click Refresh (first load fetches every day since the 1st of last month)."
      />
      <Section
        n={2}
        title="Refund flow wise"
        desc="ONLINE refunds split into three flows that add up to the total: VPA (refundType VPA), UDIR (flowType UDIR) and default account refunds (the rest)."
        {...panel}
        chart={flows && P && <TrendChart days={P.chart} lines={flows.lines} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        cols={flowCols}
        rows={flows?.items || []}
      />
      <Section
        n={3}
        title={`Refund bank wise SR — ${flowLabel(bankFlow)}`}
        desc={`ONLINE refunds by payee bank (first 4 chars of extended_info.payeeIfsc), ranked by volume in ${curLabel}. Red = SR below ${UDIR_SR_FLOOR}%. The latest day can still move while refunds settle.`}
        {...panel}
        controls={
          <>
            <Pills label="Flow" value={bankFlow} options={REFUND_FLOW_FILTER} onChange={setBankFlow} />
            <Pills label="Banks" value={bankTop} options={TOP_N_OPTIONS} onChange={setBankTop} />
            <label style={{ fontSize: 12, color: C.text2, cursor: "pointer" }}>
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Only banks below {UDIR_SR_FLOOR}% (period or any day)
            </label>
          </>
        }
        kpis={
          banks && (
            <>
              <Kpi label="Refunds" value={fmtNum(banks.all.c)} sub={`${banks.items.length} payee banks`} />
              <Kpi label="SR" value={fmtPct(banks.overall, 2)} sub={flowLabel(bankFlow)} />
              <Kpi label={`Banks < ${UDIR_SR_FLOOR}%`} value={banks.low.length} color={banks.low.length ? C.bad : C.good} sub="period SR or any day" />
            </>
          )
        }
        cols={bankCols}
        rows={bankRows}
        tableMaxHeight={560}
        emptyText={banks && lowOnly ? `No bank below ${UDIR_SR_FLOOR}% in ${curLabel}.` : undefined}
      />
      <Section
        n={4}
        title={`Refund decline codes — NPCI description, ₹, D-1…D-3, MTD / LMTD contribution`}
        desc={`FAILURE refunds by reason_code (${flowLabel(codeFlow)}, mode ONLINE). NPCI description from docs/UPI_Error_Response_Code_Reference.md (UPI error code · bank response code); quoted text is the refund's remarks.`}
        {...panel}
        controls={
          <>
            <Pills label="Flow" value={codeFlow} options={REFUND_FLOW_FILTER} onChange={setCodeFlow} />
            <Pills label="Codes" value={codeTop} options={TOP_N_OPTIONS} onChange={setCodeTop} />
          </>
        }
        noTable
        cols={[]}
        rows={codeRows.length ? [{ id: "x" }] : []}
        chart={<DeclineCodes rows={codeRows} yday={lastDay} codeInfo={codeInfo} topN={codeTop} bankLabel="Top 3 payee banks" />}
      />
    </>
  );
}

function PayoutsView({ cached, job, range, codeInfo, onShowSql, onRun, onStop }) {
  const [typeSel, setTypeSel] = useState("all");
  const [codeTop, setCodeTop] = useState(15);
  const P = useMemo(() => moneyPeriods(cached, range), [cached, range]);
  const types = useMemo(() => {
    const m = sumBy(cached?.rows || [], (r) => r.business_type, ["c"]);
    return [...m.entries()].sort((a, b) => b[1].c - a[1].c).map(([t]) => t);
  }, [cached]);
  const rows = useMemo(() => (cached?.rows || []).filter((r) => typeSel === "all" || r.business_type === typeSel), [cached, typeSel]);
  const overall = useDailySlice(rows, P);
  const curFrom = P ? P.prev.length : 0;
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const panel = { job, cached, onShowSql, onRefresh: onRun, onStop };

  const byType = useMemo(() => {
    if (!P) return null;
    const tag = (r) => ({ ...r, s: r.status === "SUCCESS" ? r.c : 0, f: r.status === "FAILURE" ? r.c : 0 });
    const all = (cached?.rows || []).map(tag);
    const cur = sumBy(all.filter((r) => P.curSet.has(r.ts)), (r) => r.business_type, ["c", "s", "f", "amt"]);
    const prev = sumBy(all.filter((r) => P.prevSet.has(r.ts)), (r) => r.business_type, ["c", "s", "f", "amt"]);
    const daily = sumBy(all, (r) => `${r.ts}|${r.business_type}`, ["c", "s"]);
    const total = [...cur.values()].reduce((a, v) => a + v.c, 0);
    const items = types
      .filter((t) => cur.has(t) || prev.has(t))
      .map((t, i) => {
        const c = cur.get(t) || { c: 0, s: 0, f: 0, amt: 0 };
        const p = prev.get(t) || { c: 0, s: 0, f: 0, amt: 0 };
        const sr = pct(c.s, c.c);
        const psr = pct(p.s, p.c);
        return { id: t, type: t, color: SERIES[i % SERIES.length], ...c, share: pct(c.c, total), cChg: chg(c.c, p.c), sr, psr, dpp: sr != null && psr != null ? sr - psr : null, daily: P.chart.map((d) => pct(daily.get(`${d}|${t}`)?.s || 0, daily.get(`${d}|${t}`)?.c || 0)) };
      });
    return { items, lines: items.slice(0, 6).map((i) => ({ name: i.type, color: i.color, values: i.daily })) };
  }, [cached, P, types]);

  const codeRows = useMemo(() => rows.filter((r) => r.status === "FAILURE" && r.code), [rows]);
  const lastDay = useMemo(() => (cached?.rows || []).reduce((a, r) => (r.ts > a ? r.ts : a), ""), [cached]);

  const typeCols = byType
    ? [
        { key: "type", label: "Business type", align: "left", render: (r) => <span><span style={{ color: r.color }}>● </span>{r.type}</span>, text: (r) => r.type },
        { key: "c", label: "Payouts", title: curLabel, render: (r) => fmtNum(r.c) },
        { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
        { key: "cChg", label: "vs prev", render: (r) => fmtSigned(r.cChg, "%") },
        { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
        { key: "sr", label: "SR", title: curLabel, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
        { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
        { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
        { key: "amt", label: "Amount ₹", render: (r) => fmtInr(r.amt) },
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={r.color} curFrom={curFrom} />, text: () => "" },
      ]
    : [];
  const typeLabel = typeSel === "all" ? "all business types" : typeSel;

  return (
    <>
      <Section
        n={1}
        title="Payouts overall"
        desc={`external_txn_info (${typeLabel}). SR = SUCCESS / all payouts; DEEMED / pending count as not successful. Current ${curLabel} vs previous ${prevLabel}.`}
        {...panel}
        controls={types.length > 1 && <Pills label="Business type" value={typeSel} options={[["all", "All"], ...types.map((t) => [t, t])]} onChange={setTypeSel} />}
        kpis={sliceKpis(overall, { noun: "Payouts", amtNoun: "Payout amount" })}
        chart={overall && P && <TrendChart days={P.chart} lines={[{ name: "Payout SR", color: "#34d399", values: overall.sr }]} bars={{ name: "Payouts", values: overall.count }} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        tableToggle
        cols={dailyCols(overall, { otherLabel: "Deemed / other" })}
        rows={overall?.rows || []}
        emptyText="No data yet — click Refresh (first load fetches every day since the 1st of last month)."
      />
      <Section
        n={2}
        title="Payouts by business type"
        desc="Volume, SR and amount per business_type for the current period vs the previous one."
        {...panel}
        chart={byType && P && byType.items.length > 1 && <TrendChart days={P.chart} lines={byType.lines} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        cols={typeCols}
        rows={byType?.items || []}
      />
      <Section
        n={3}
        title="Payout decline codes — NPCI description, ₹, D-1…D-3, MTD / LMTD contribution"
        desc={`FAILURE payouts by resp_code (${typeLabel}). NPCI description from docs/UPI_Error_Response_Code_Reference.md (UPI error code · bank response code).`}
        {...panel}
        controls={<Pills label="Codes" value={codeTop} options={TOP_N_OPTIONS} onChange={setCodeTop} />}
        noTable
        cols={[]}
        rows={codeRows.length ? [{ id: "x" }] : []}
        chart={<DeclineCodes rows={codeRows} yday={lastDay} codeInfo={codeInfo} topN={codeTop} />}
      />
    </>
  );
}

// ─── ICCW ────────────────────────────────────────────────────────────────────
//
// UPI cash withdrawal at ATM / BC points (payee MCC 6013, purpose 12 / 13, Paytm payers), ported
// from the Automatic Payments Dashboard ICCW board. One cached "daily" query (Trino, one SQL per
// day, last 30 days; first fill seeded from the APD's per-day CSVs). Rows: dim TOTAL /
// PAYEE_HANDLE (acquirer) / PAYER_HANDLE / PAYER_BANK / AMOUNT / HOUR / CODE with att, suc, fail,
// amt, samt, users; CODE_PAYEE / CODE_BANK (k = "code|key") for the newest 15 days, codes with ≥ 20
// non-success that day. Non-success = att − suc (PENDING / DEEMED rows carry fail = 0).

const ICCW_PURPOSES = [["all", "All"], ["12", "Purpose 12"], ["13", "Purpose 13"]];
const ICCW_DIMS = [["PAYEE_HANDLE", "Acquirer"], ["PAYER_BANK", "Remitter bank"], ["PAYER_HANDLE", "Paytm handle"], ["AMOUNT", "Amount"], ["HOUR", "Hour"]];
const ICCW_SIDE = { PAYER: "Remitter bank", PAYEE: "Acquirer side", BOTH: "Both legs", NONE: "NPCI / switch" };
const ICCW_TOP_KEYS = 30;
const ICCW_TOP_CODES = 25;
// A split key is flagged when its SR is this many pp below its previous-period SR (min attempts).
const ICCW_DROP_PP = 2;
const ICCW_MIN_ATT = 100;
// A code is flagged when its latest-day count is ≥ 2× its L7D daily average and adds ≥ 0.10 pp of SR loss.
const ICCW_SPIKE_X = 2;
const ICCW_SPIKE_PP = 0.1;
const ZERO_ICCW = { att: 0, suc: 0, fail: 0, amt: 0, samt: 0, users: 0 };
const ICCW_FIELDS = Object.keys(ZERO_ICCW);
const iccwKeyLabel = (dim, k) =>
  dim === "PAYEE_HANDLE" || dim === "PAYER_HANDLE" ? `@${k}` : dim === "AMOUNT" ? `₹ ${k.slice(2).replace("<", "under ").replace("+", " and above")}` : dim === "HOUR" ? `${String(k).padStart(2, "0")}:00` : k;

function IccwView({ cached, job, range, codeInfo, onShowSql, onRun, onStop }) {
  const [purpose, setPurpose] = useState("all");
  const [dim, setDim] = useState("PAYEE_HANDLE");
  const [codePick, setCodePick] = useState(null);
  const P = useMemo(() => moneyPeriods(cached, range), [cached, range]);
  const all = useMemo(() => cached?.rows || [], [cached]);
  const rows = useMemo(() => all.filter((r) => purpose === "all" || r.purpose === purpose), [all, purpose]);
  const panel = { job, cached, onShowSql, onRefresh: onRun, onStop };
  const curFrom = P ? P.prev.length : 0;
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const y = P?.to;
  const purposeLabel = purpose === "all" ? "purpose 12 + 13" : `purpose ${purpose}`;

  // dim → Map("ts|k" → totals) for the selected purpose.
  const byDim = useMemo(() => {
    const out = {};
    for (const r of rows) {
      const m = (out[r.dim] ||= new Map());
      const key = `${r.ts}|${r.k}`;
      let o = m.get(key);
      if (!o) m.set(key, (o = { ...ZERO_ICCW }));
      for (const f of ICCW_FIELDS) o[f] += r[f] || 0;
    }
    return out;
  }, [rows]);
  const cell = useCallback((d, ts, k) => byDim[d]?.get(`${ts}|${k}`) || ZERO_ICCW, [byDim]);
  const sumDays = useCallback(
    (d, days, k) => days.reduce((a, ts) => Object.fromEntries(ICCW_FIELDS.map((f) => [f, a[f] + cell(d, ts, k)[f]])), { ...ZERO_ICCW }),
    [cell],
  );

  // ── 1 · Overall by day ──
  const overall = useMemo(() => {
    if (!P) return null;
    const g = (ts) => cell("TOTAL", ts, "");
    const cur = sumDays("TOTAL", P.cur, "");
    const prev = sumDays("TOTAL", P.prev, "");
    const tableRows = [...P.cur].reverse().map((d) => ({ id: d, d, ...g(d), other: g(d).att - g(d).suc - g(d).fail, sr: pct(g(d).suc, g(d).att) }));
    tableRows.push({ id: "__total", d: "Total", _total: true, ...cur, other: cur.att - cur.suc - cur.fail, sr: pct(cur.suc, cur.att), users: null });
    return { cur, prev, curSr: pct(cur.suc, cur.att), prevSr: pct(prev.suc, prev.att), rows: tableRows, sr: P.chart.map((d) => pct(g(d).suc, g(d).att)), count: P.chart.map((d) => g(d).att), yUsers: g(P.to).users };
  }, [P, cell, sumDays]);

  // ── 2 · By purpose (always both purposes) ──
  const byPurpose = useMemo(() => {
    if (!P) return null;
    const tot = (p, days) => {
      const m = sumBy(all.filter((r) => r.dim === "TOTAL" && r.purpose === p && days.has(r.ts)), () => p, ICCW_FIELDS);
      return m.get(p) || { ...ZERO_ICCW };
    };
    const curAll = sumBy(all.filter((r) => r.dim === "TOTAL" && P.curSet.has(r.ts)), () => "x", ["att"]).get("x")?.att || 0;
    return ["12", "13"].map((p) => {
      const c = tot(p, P.curSet);
      const pr = tot(p, P.prevSet);
      const acq = [...sumBy(all.filter((r) => r.dim === "PAYEE_HANDLE" && r.purpose === p && P.curSet.has(r.ts)), (r) => r.k, ["att"]).entries()].sort((a, b) => b[1].att - a[1].att).slice(0, 4);
      const daily = P.chart.map((d) => {
        const v = all.find((r) => r.dim === "TOTAL" && r.purpose === p && r.ts === d);
        return v ? pct(v.suc, v.att) : null;
      });
      const sr = pct(c.suc, c.att);
      const psr = pct(pr.suc, pr.att);
      return { id: p, p, ...c, share: pct(c.att, curAll), sr, psr, dpp: sr != null && psr != null ? sr - psr : null, acq, daily, _active: purpose === p, _onClick: () => setPurpose(purpose === p ? "all" : p) };
    });
  }, [all, P, purpose]);

  // ── 3 · SR by split ──
  const split = useMemo(() => {
    if (!P || !byDim[dim]) return null;
    const keys = new Set();
    for (const key of byDim[dim].keys()) keys.add(key.slice(11));
    const curAtt = sumDays("TOTAL", P.cur, "").att;
    let items = [...keys].map((k) => {
      const c = sumDays(dim, P.cur, k);
      const pr = sumDays(dim, P.prev, k);
      const sr = pct(c.suc, c.att);
      const psr = pct(pr.suc, pr.att);
      const yc = cell(dim, y, k);
      return {
        id: k,
        k,
        ...c,
        share: pct(c.att, curAtt),
        sr,
        psr,
        dpp: sr != null && psr != null ? sr - psr : null,
        ysr: pct(yc.suc, yc.att),
        yatt: yc.att,
        flag: sr != null && psr != null && c.att >= ICCW_MIN_ATT && sr - psr <= -ICCW_DROP_PP,
        daily: P.chart.map((d) => pct(cell(dim, d, k).suc, cell(dim, d, k).att)),
      };
    });
    items = items.filter((i) => i.att || i.yatt);
    if (dim === "AMOUNT") items.sort((a, b) => a.k.localeCompare(b.k));
    else if (dim === "HOUR") items.sort((a, b) => Number(a.k) - Number(b.k));
    else items = items.sort((a, b) => b.att - a.att).slice(0, ICCW_TOP_KEYS);
    const lines = (dim === "AMOUNT" || dim === "HOUR" ? [] : items.slice(0, 5)).map((i, n) => ({ name: iccwKeyLabel(dim, i.k), color: SERIES[n % SERIES.length], values: i.daily }));
    return { items, lines, flagged: items.filter((i) => i.flag) };
  }, [P, byDim, dim, sumDays, cell, y]);

  // ── 4 · Failure codes on the latest day ──
  const codes = useMemo(() => {
    if (!P || !byDim.CODE) return null;
    const at = (n) => toDay(toMs(y) - n * DAY);
    const l7 = Array.from({ length: 7 }, (_, i) => at(i + 1));
    const meta = new Map();
    for (const r of rows) if (r.dim === "CODE" && r.k !== "SUCCESS" && !meta.has(r.k)) meta.set(r.k, { npci: r.npci || "", side: r.side || "" });
    for (const r of rows) if (r.dim === "CODE" && r.ts === y && r.k !== "SUCCESS") meta.set(r.k, { npci: r.npci || meta.get(r.k)?.npci || "", side: r.side || meta.get(r.k)?.side || "" });
    const ns = (o) => o.att - o.suc;
    const yTot = cell("TOTAL", y, "");
    const yNs = ns(yTot);
    const items = [...meta.keys()]
      .map((k) => {
        const n = ns(cell("CODE", y, k));
        const d2 = ns(cell("CODE", at(1), k));
        const avg = l7.reduce((a, d) => a + ns(cell("CODE", d, k)), 0) / 7;
        const lost = pct(n, yTot.att);
        return {
          id: k,
          code: k,
          ...meta.get(k),
          n,
          amt: cell("CODE", y, k).amt,
          share: pct(n, yNs),
          lost,
          d2,
          avg,
          vsAvg: chg(n, avg),
          flag: n >= ICCW_SPIKE_X * avg && n > 0 && (lost || 0) - pct(avg, yTot.att || 1) >= ICCW_SPIKE_PP,
          daily: P.chart.map((d) => ns(cell("CODE", d, k))),
        };
      })
      .filter((i) => i.n || i.avg)
      .sort((a, b) => b.n - a.n || b.avg - a.avg);
    return { items: items.slice(0, ICCW_TOP_CODES), all: items, yNs, yAtt: yTot.att, l7 };
  }, [P, byDim, rows, cell, y]);
  const code = codePick && codes?.all.some((i) => i.code === codePick) ? codePick : codes?.items[0]?.code || null;

  // ── 5 · Where the selected code fails (latest day vs the 7 days before) ──
  const drill = useMemo(() => {
    if (!code || !codes || !y) return null;
    const side = (sd, base) => {
      const m = byDim[sd];
      if (!m) return [];
      const keys = new Set();
      for (const key of m.keys()) if (key.slice(11).startsWith(`${code}|`)) keys.add(key.slice(11 + code.length + 1));
      const tot = [...keys].reduce((a, k) => a + (cell(sd, y, `${code}|${k}`).att - cell(sd, y, `${code}|${k}`).suc), 0);
      return [...keys]
        .map((k) => {
          const n = cell(sd, y, `${code}|${k}`).att - cell(sd, y, `${code}|${k}`).suc;
          const known = codes.l7.filter((d) => m.has(`${d}|${code}|${k}`));
          const avg = known.length ? known.reduce((a, d) => a + cell(sd, d, `${code}|${k}`).att - cell(sd, d, `${code}|${k}`).suc, 0) / known.length : null;
          const own = k === "Other" ? 0 : cell(base, y, k).att;
          return { id: k, k, n, share: pct(n, tot), avg, vsAvg: avg == null ? null : chg(n, avg), rate: own ? pct(n, own) : null, own };
        })
        .filter((i) => i.n || i.avg)
        .sort((a, b) => (a.k === "Other") - (b.k === "Other") || b.n - a.n);
    };
    return { acq: side("CODE_PAYEE", "PAYEE_HANDLE"), bank: side("CODE_BANK", "PAYER_BANK") };
  }, [code, codes, byDim, cell, y]);

  const descOf = (c) => {
    const i = codeInfo?.[c];
    return { text: i ? [i.npci, i.bank, i.app && `app: “${i.app}”`].filter(Boolean).join(" · ") : "", type: i?.type || "" };
  };
  const srB = (v, ref) => <b style={{ color: srTone(v, ref) }}>{fmtPct(v, 2)}</b>;

  const overallCols = [
    { key: "d", label: "Date", align: "left", render: (r) => (r._total ? "Total" : fmtDay(r.d)), text: (r) => (r._total ? "Total" : r.d) },
    { key: "att", label: "Attempts", render: (r) => fmtNum(r.att) },
    { key: "suc", label: "Success", render: (r) => fmtNum(r.suc) },
    { key: "fail", label: "Failed", render: (r) => fmtNum(r.fail) },
    { key: "other", label: "Pending / deemed", render: (r) => fmtNum(r.other) },
    { key: "sr", label: "SR", render: (r) => srB(r.sr, r._total ? null : overall?.curSr), text: (r) => fmtPct(r.sr, 2) },
    { key: "amt", label: "Requested ₹", title: "Sum of amount, all statuses", render: (r) => fmtInr(r.amt) },
    { key: "samt", label: "Cash withdrawn ₹", title: "Sum of amount on SUCCESS", render: (r) => fmtInr(r.samt) },
    { key: "users", label: "Users", title: "Distinct payers that day (summed over purposes)", render: (r) => (r.users == null ? "" : fmtNum(r.users)) },
  ];
  const purposeCols = [
    { key: "p", label: "Purpose", align: "left", render: (r) => <span><b>Purpose {r.p}</b><div style={{ fontSize: 11, color: C.muted }}>{r.acq.map(([h]) => `@${h}`).join(", ")}</div></span>, text: (r) => r.p },
    { key: "att", label: "Attempts", title: curLabel, render: (r) => fmtNum(r.att) },
    { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
    { key: "sr", label: "SR", title: curLabel, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "samt", label: "Cash withdrawn ₹", render: (r) => fmtInr(r.samt) },
    { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color="#94a3b8" curFrom={curFrom} />, text: () => "" },
  ];
  const dimLabel = ICCW_DIMS.find(([d]) => d === dim)?.[1] || dim;
  const splitCols = [
    { key: "k", label: dimLabel, align: "left", render: (r) => <span style={{ color: r.flag ? C.bad : C.text, fontWeight: r.flag ? 700 : 400 }}>{iccwKeyLabel(dim, r.k)}</span>, text: (r) => r.k },
    { key: "att", label: "Attempts", title: curLabel, render: (r) => fmtNum(r.att) },
    { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
    { key: "sr", label: "SR", title: curLabel, render: (r) => <b style={{ color: r.flag ? C.bad : C.text }}>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "ysr", label: `SR ${fmtDay(y)}`, title: `Latest day (${fmtDay(y)}) · ${"attempts below"}`, render: (r) => <div>{fmtPct(r.ysr, 2)}<div style={{ fontSize: 11, color: C.muted }}>{fmtNum(r.yatt)}</div></div>, text: (r) => fmtPct(r.ysr, 2) },
    { key: "samt", label: "Cash withdrawn ₹", render: (r) => fmtInr(r.samt) },
    { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={r.flag ? C.bad : "#94a3b8"} curFrom={curFrom} />, text: () => "" },
  ];
  const codeCols = [
    {
      key: "code",
      label: "Code · description",
      align: "left",
      wrap: true,
      render: (r) => (
        <div style={{ minWidth: 240, maxWidth: 380 }}>
          <code style={{ fontSize: 12, fontWeight: 700, color: r.flag ? C.bad : C.text }}>{r.code}</code>
          {r.npci && r.npci !== r.code && <span style={{ fontSize: 11, color: C.muted, marginLeft: 6 }}>NPCI {r.npci}</span>}
          {descOf(r.code).type && <span style={{ fontSize: 10, marginLeft: 6, padding: "0 5px", borderRadius: 4, border: `1px solid ${C.border}`, color: descOf(r.code).type === "TD" ? C.warn : C.text2 }}>{descOf(r.code).type}</span>}
          {descOf(r.code).text && <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.35 }}>{descOf(r.code).text}</div>}
        </div>
      ),
      text: (r) => `${r.code} ${descOf(r.code).text}`,
    },
    { key: "side", label: "Raised by", title: "Participant leg carrying the response code", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{ICCW_SIDE[r.side] || (r.code === "PENDING" || r.code === "DEEMED" ? "Status" : "—")}</span>, text: (r) => r.side },
    { key: "n", label: `Count ${fmtDay(y)}`, render: (r) => <b>{fmtNum(r.n)}</b>, text: (r) => String(r.n) },
    { key: "share", label: "Share", title: "Share of the day's non-success", render: (r) => fmtPct(r.share) },
    { key: "lost", label: "SR lost", title: "Count ÷ the day's attempts, pp", render: (r) => fmtSigned(r.lost, " pp", 2) },
    { key: "amt", label: "₹", title: "Amount of these txns on the latest day", render: (r) => fmtInr(r.amt) },
    { key: "d2", label: "D-1", title: "Day before", render: (r) => fmtNum(r.d2) },
    { key: "avg", label: "L7D avg", title: "Daily average of the 7 days before", render: (r) => fmtNum(r.avg) },
    { key: "vsAvg", label: "vs avg", render: (r) => <span style={{ color: ppToneOf(r.vsAvg == null ? null : -r.vsAvg), fontWeight: r.flag ? 700 : 400 }}>{fmtSigned(r.vsAvg, "%", 0)}</span>, text: (r) => fmtSigned(r.vsAvg, "%", 0) },
    { key: "trend", label: "Daily", title: `Daily count, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="Count" unit="count" upIsBad color={r.flag ? C.bad : "#94a3b8"} curFrom={curFrom} />, text: () => "" },
  ];
  const drillCols = (label, base) => [
    { key: "k", label, align: "left", render: (r) => (base === "PAYEE_HANDLE" && r.k !== "Other" ? `@${r.k}` : r.k), text: (r) => r.k },
    { key: "n", label: `Count ${fmtDay(y)}`, render: (r) => <b>{fmtNum(r.n)}</b>, text: (r) => String(r.n) },
    { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
    { key: "rate", label: "Rate", title: `Count ÷ this ${label.toLowerCase()}'s own ICCW attempts that day`, render: (r) => (r.rate == null ? "—" : `${fmtPct(r.rate, 2)} of ${fmtNum(r.own)}`), text: (r) => fmtPct(r.rate, 2) },
    { key: "avg", label: "L7D avg", title: "Daily average over the 7 days before (days the key was in the top 10)", render: (r) => (r.avg == null ? "—" : fmtNum(r.avg)) },
    { key: "vsAvg", label: "vs avg", render: (r) => <span style={{ color: ppToneOf(r.vsAvg == null ? null : -r.vsAvg) }}>{fmtSigned(r.vsAvg, "%", 0)}</span>, text: (r) => fmtSigned(r.vsAvg, "%", 0) },
  ];

  const empty = "No data yet — click Refresh (the first load reuses the APD's cached days, then queries the newest days on Trino).";
  return (
    <>
      <Section
        n={1}
        title="ICCW overall"
        desc={`UPI cash withdrawal at ATM / BC points: payee MCC 6013, ${purposeLabel}, Paytm payer handles (paytm, ptyes, ptaxis, pthdfc, ptsbi); one row per txn. SR = SUCCESS / attempts (pending and deemed count as not successful). Current ${curLabel} vs previous ${prevLabel}.`}
        {...panel}
        controls={<Pills label="Purpose" value={purpose} options={ICCW_PURPOSES} onChange={setPurpose} />}
        kpis={
          overall && (
            <>
              <Kpi label="Attempts" value={fmtNum(overall.cur.att)} sub={`${fmtSigned(chg(overall.cur.att, overall.prev.att), "%")} vs prev`} />
              <Kpi label="Success rate" value={fmtPct(overall.curSr, 2)} sub={overall.curSr != null && overall.prevSr != null ? `${fmtSigned(overall.curSr - overall.prevSr, " pp", 2)} vs prev` : "vs prev —"} color={overall.prevSr != null && overall.curSr < overall.prevSr - 0.5 ? C.bad : undefined} />
              <Kpi label="Failed" value={fmtNum(overall.cur.fail)} sub={`${fmtSigned(chg(overall.cur.fail, overall.prev.fail), "%")} vs prev`} color={overall.prev.fail && overall.cur.fail > overall.prev.fail * 1.1 ? C.bad : undefined} />
              <Kpi label="Cash withdrawn" value={fmtInr(overall.cur.samt)} sub={`${fmtSigned(chg(overall.cur.samt, overall.prev.samt), "%")} vs prev`} />
              <Kpi label={`Users ${fmtDay(y)}`} value={fmtNum(overall.yUsers)} sub="distinct payers" />
            </>
          )
        }
        chart={overall && P && <TrendChart days={P.chart} lines={[{ name: "ICCW SR", color: "#34d399", values: overall.sr }]} bars={{ name: "Attempts", values: overall.count }} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        tableToggle
        cols={overallCols}
        rows={overall?.rows || []}
        emptyText={empty}
      />
      <Section
        n={2}
        title="SR by purpose"
        desc="Purpose 12 and 13 with their top acquirers (payee handles) in the current period. Click a row to filter every section to that purpose."
        {...panel}
        cols={purposeCols}
        rows={byPurpose || []}
        emptyText={empty}
      />
      <Section
        n={3}
        title={`SR by ${dimLabel.toLowerCase()}`}
        desc={`Current ${curLabel} vs previous ${prevLabel}, ${purposeLabel}${dim === "AMOUNT" || dim === "HOUR" ? "" : `, top ${ICCW_TOP_KEYS} by attempts`}. Red = SR at least ${ICCW_DROP_PP} pp below its previous-period SR (min ${ICCW_MIN_ATT} attempts).`}
        {...panel}
        controls={<Pills label="Split" value={dim} options={ICCW_DIMS} onChange={setDim} />}
        note={split?.flagged.length ? <div><b style={{ color: C.bad }}>▼ SR drop:</b> {split.flagged.map((i) => `${iccwKeyLabel(dim, i.k)} (${fmtSigned(i.dpp, " pp", 2)}, ${fmtNum(i.att)} att)`).join(" · ")}</div> : null}
        chart={split && P && split.lines.length > 0 && <TrendChart days={P.chart} lines={split.lines} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        cols={splitCols}
        rows={split?.items || []}
        tableMaxHeight={560}
        emptyText={empty}
      />
      <Section
        n={4}
        title={`Failure codes · ${fmtDay(y)}`}
        desc={`Non-success ICCW txns on the latest day by code (app_resp_code; PENDING / DEEMED = status), ${purposeLabel}, top ${ICCW_TOP_CODES}. Raised by = participant leg carrying the response code. Red = at least ${ICCW_SPIKE_X}× its L7D average and +${ICCW_SPIKE_PP} pp. Click a code for where it fails.`}
        {...panel}
        kpis={
          codes && (
            <>
              <Kpi label={`Non-success ${fmtDay(y)}`} value={fmtNum(codes.yNs)} sub={`${fmtPct(pct(codes.yNs, codes.yAtt), 2)} of attempts`} />
              <Kpi label="Spiking codes" value={codes.all.filter((i) => i.flag).length} color={codes.all.some((i) => i.flag) ? C.bad : undefined} sub={codes.all.filter((i) => i.flag).map((i) => i.code).slice(0, 3).join(", ") || "none"} />
            </>
          )
        }
        cols={codeCols}
        rows={(codes?.items || []).map((i) => ({ ...i, _active: i.code === code, _onClick: () => setCodePick(i.code) }))}
        tableMaxHeight={620}
        emptyText={empty}
      />
      <Section
        n={5}
        title={code ? `Where ${code} fails · ${fmtDay(y)}` : "Where the code fails"}
        desc={`${code ? `${descOf(code).text || ""} ` : ""}Acquirer (payee handle) and remitter (payer) bank split of the selected code on the latest day vs its average over the 7 days before. Rate = the code's count ÷ that acquirer's / bank's own ICCW attempts. Splits kept for the newest 15 days, top 10 per code (codes with ≥ 20 non-success that day).`}
        {...panel}
        noTable
        cols={[]}
        rows={drill && (drill.acq.length || drill.bank.length) ? [{ id: "x" }] : []}
        emptyText={code ? `No acquirer / bank split for ${code} on ${fmtDay(y)} (under 20 non-success, or older than 15 days).` : empty}
        chart={
          drill && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12, padding: "8px 0" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, margin: "4px 16px 8px" }}>By acquirer</div>
                <Table cols={drillCols("Acquirer", "PAYEE_HANDLE")} rows={drill.acq} maxHeight={420} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, margin: "4px 16px 8px" }}>By remitter bank</div>
                <Table cols={drillCols("Remitter bank", "PAYER_BANK")} rows={drill.bank} maxHeight={420} />
              </div>
            </div>
          )
        }
      />
    </>
  );
}

// ─── UPI International: failure deep-dive, RIS mapping, analyst notes, activation reasons ─────────
// Ported from the APD UPI Global page as daily aggregates (backend "global" / "activation_fail" / "translator").
const GLOBAL_CUTS = [
  ["COUNTRY", "Country"], ["PAYER_BANK", "Payer bank"], ["PAYEE_HANDLE", "Payee handle"], ["OS", "OS"], ["OS_VER", "OS version"], ["APP_VER", "App version"],
  ["MCC", "MCC"], ["ACC_TYPE", "Account type"], ["BASE_CURR", "Currency"], ["AMOUNT", "Amount band"], ["HOUR", "Hour"], ["BIND_AGE", "Device binding age"],
  ["LOC", "Location"], ["BIZ_SIZE", "Merchant size"], ["M_GENRE", "Online / offline"], ["BIO_AUTH", "Biometric"], ["MIGRATION", "Migration flow"],
  ["INIT_MODE", "Mode"], ["PURPOSE", "Purpose"], ["RESP_SIDE", "Responding leg"],
];
const REASON_LABEL = {
  NO_FINAL_RESPONSE: "No final response (usually left at UPI PIN entry)",
  VALIDITY_ENDED: "Validity ended",
  TURNED_OFF: "Turned off after activation",
  NO_LOG: "No app log",
};
const bandLabel = (k) => (/^\d /.test(k) ? k.slice(2) : k);

// ─── UPI Global · Explore txns: cross-filters and amount filter on txn-level rows (APD UPI Global page) ───
const AMT_BANDS = [[500, "1 <500"], [1000, "2 500-999"], [2500, "3 1k-2.5k"], [5000, "4 2.5k-5k"], [10000, "5 5k-10k"], [25000, "6 10k-25k"], [Infinity, "7 25k+"]];
const BIND_BANDS = [[24, "1 <24h"], [72, "2 24-72h (cooling)"], [168, "3 3-7d"], [720, "4 7-30d"], [Infinity, "5 30d+"]];
const band = (v, bands) => (v == null ? "unknown" : bands.find(([lim]) => v < lim)[1]);
const IX_CUTS = [
  ["status", "Status", (r) => r.status],
  ["code", "Code", (r) => (r.status === "SUCCESS" ? null : r.npci || r.app || "(no code)")],
  ["country", "Country", (r) => r.country || "unknown"],
  ["payer_bank", "Payer bank", (r) => r.payer_bank || "unknown"],
  ["payee_handle", "Payee handle", (r) => (r.payee_handle || "unknown").toLowerCase()],
  ["handle", "Paytm PSP", (r) => r.handle],
  ["os", "OS", (r) => (r.os_app && r.os_app.startsWith("iOS") ? "iOS" : r.os_app ? "Android" : "unknown")],
  ["os_app", "OS version", (r) => r.os_app || "unknown"],
  ["app_ver", "App version", (r) => r.app_ver || "unknown"],
  ["payee_mcc", "MCC", (r) => r.payee_mcc || "unknown"],
  ["payer_acc_type", "Account type", (r) => r.payer_acc_type || "unknown"],
  ["base_curr", "Currency", (r) => r.base_curr || "unknown"],
  ["init_mode", "Mode", (r) => r.init_mode || "unknown"],
  ["purpose", "Purpose", (r) => r.purpose || "unknown"],
  ["loc", "Location", (r) => r.loc || "unknown"],
  ["biz_size", "Merchant size", (r) => r.biz_size || "unknown"],
  ["m_genre", "Merchant genre", (r) => r.m_genre || "unknown"],
  ["bio_auth", "Biometric", (r) => r.bio_auth || "false"],
  ["migration", "Migration", (r) => r.migration || "false"],
  ["hour", "Hour", (r) => (r.tm || "").slice(0, 2) || "unknown"],
  ["amount", "Amount band", (r) => band(r.amount, AMT_BANDS)],
  ["bind", "Binding age", (r) => band(r.bind_age_h, BIND_BANDS)],
  ["leg", "Response leg", (r) => (r.status === "SUCCESS" ? null : r.payer_resp ? "PAYER" : r.payee_resp ? "PAYEE" : "NONE")],
];
const IX_CUT = Object.fromEntries(IX_CUTS.map(([k, l, f]) => [k, { label: l, f }]));

function IntlExplore({ cached, job, P, handleSel, codeInfo, onShowSql, onRun, onStop }) {
  const [cut, setCut] = useState("country");
  const [filters, setFilters] = useState([]); // [{ cut, value }]
  const [minAmt, setMinAmt] = useState("");
  const [maxAmt, setMaxAmt] = useState("");
  const [status, setStatus] = useState("all");
  const data = useMemo(() => {
    if (!P) return null;
    const lo = minAmt === "" ? -Infinity : Number(minAmt);
    const hi = maxAmt === "" ? Infinity : Number(maxAmt);
    const inRange = (r) => P.curSet.has(r.ts) || P.prevSet.has(r.ts);
    const pass = (r) =>
      inRange(r) &&
      (handleSel === "all" || r.handle === handleSel) &&
      (status === "all" || (status === "SUCCESS" ? r.status === "SUCCESS" : r.status !== "SUCCESS")) &&
      (r.amount == null ? lo === -Infinity && hi === Infinity : r.amount >= lo && r.amount <= hi) &&
      filters.every((f) => IX_CUT[f.cut].f(r) === f.value);
    const rows = (cached?.rows || []).filter(pass);
    const g = new Map();
    const tot = { cur: { n: 0, s: 0, amt: 0 }, prev: { n: 0, s: 0 } };
    for (const r of rows) {
      const per = P.curSet.has(r.ts) ? "cur" : "prev";
      tot[per].n += 1;
      if (r.status === "SUCCESS") tot[per].s += 1;
      const k = IX_CUT[cut].f(r);
      if (k == null) continue;
      let o = g.get(k);
      if (!o) g.set(k, (o = { id: k, k, n: 0, s: 0, amt: 0, amts: [], pn: 0, ps: 0 }));
      if (per === "cur") {
        o.n += 1;
        if (r.status === "SUCCESS") o.s += 1;
        if (r.amount != null) {
          o.amt += r.amount;
          o.amts.push(r.amount);
        }
      } else {
        o.pn += 1;
        if (r.status === "SUCCESS") o.ps += 1;
      }
    }
    const list = [...g.values()]
      .filter((o) => o.n || o.pn)
      .map((o) => ({ ...o, f: o.n - o.s, sr: pct(o.s, o.n), psr: pct(o.ps, o.pn), share: pct(o.n, tot.cur.n), med: median(o.amts) }))
      .sort((a, b) => b.n - a.n);
    return { list, tot, n: rows.length };
  }, [cached, P, handleSel, status, filters, minAmt, maxAmt, cut]);
  const addFilter = (value) => setFilters((fs) => (fs.some((f) => f.cut === cut) ? fs.map((f) => (f.cut === cut ? { cut, value } : f)) : [...fs, { cut, value }]));
  const cols = [
    {
      key: "k",
      label: IX_CUT[cut].label,
      align: "left",
      render: (r) => (
        <span>
          <code>{r.k}</code>
          {cut === "code" && codeInfo?.[r.k] && <span style={{ fontSize: 11, color: C.text2 }}> · {[codeInfo[r.k].npci, codeInfo[r.k].party].filter(Boolean).join(" · ")}</span>}
        </span>
      ),
      text: (r) => r.k,
    },
    { key: "n", label: "Txns", render: (r) => fmtNum(r.n) },
    { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
    { key: "f", label: "Not success", render: (r) => fmtNum(r.f) },
    { key: "sr", label: "SR", render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", sortValue: (r) => (r.sr != null && r.psr != null ? r.sr - r.psr : null), render: (r) => <span style={{ color: ppToneOf(r.sr != null && r.psr != null ? r.sr - r.psr : null) }}>{fmtSigned(r.sr != null && r.psr != null ? r.sr - r.psr : null, " pp", 2)}</span>, text: () => "" },
    { key: "amt", label: "₹", render: (r) => fmtNum(r.amt) },
    { key: "med", label: "Median ₹", render: (r) => fmtNum(r.med) },
  ];
  const inp = { background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 6px", fontSize: 12, width: 80 };
  return (
    <Section
      n={10}
      title="Explore txns · cross-filter any cut, amount range"
      desc={`One row per UPI International txn (handles, banks, codes, amounts, country, app, merchant flags, binding age — no VPA, name, account or device). Pick a cut; click a row to filter every other cut by it; filters stack. Current ${spanLabel(P?.cur)} vs previous ${spanLabel(P?.prev)}${handleSel === "all" ? "" : ` · ${handleSel}`}.`}
      job={job}
      cached={cached}
      onShowSql={onShowSql}
      onRefresh={onRun}
      onStop={onStop}
      controls={
        <>
          <select value={cut} onChange={(e) => setCut(e.target.value)} style={{ ...inp, width: 150 }} aria-label="Cut">
            {IX_CUTS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <Pills label="Status" value={status} options={[["all", "All"], ["SUCCESS", "Success"], ["FAIL", "Not success"]]} onChange={setStatus} />
          <span style={{ fontSize: 11, color: C.muted }}>₹</span>
          <input type="number" min="0" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} placeholder="min" style={inp} aria-label="Minimum amount" />
          <input type="number" min="0" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} placeholder="max" style={inp} aria-label="Maximum amount" />
        </>
      }
      kpis={
        data && (
          <>
            <Kpi label="Txns (filtered)" value={fmtNum(data.tot.cur.n)} sub={`prev ${fmtNum(data.tot.prev.n)}`} />
            <Kpi label="SR (filtered)" value={fmtPct(pct(data.tot.cur.s, data.tot.cur.n), 2)} sub={`prev ${fmtPct(pct(data.tot.prev.s, data.tot.prev.n), 2)}`} />
          </>
        )
      }
      note={
        filters.length ? (
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            Filters:
            {filters.map((f) => (
              <button key={f.cut} type="button" onClick={() => setFilters((fs) => fs.filter((x) => x.cut !== f.cut))} style={{ ...pill(true), padding: "1px 8px" }} title="Remove">
                {IX_CUT[f.cut].label} = {f.value} ✕
              </button>
            ))}
            <button type="button" onClick={() => setFilters([])} style={{ ...pill(false), padding: "1px 8px" }}>
              Clear all
            </button>
          </span>
        ) : (
          "Click a row to filter by it."
        )
      }
      cols={cols}
      rows={(data?.list || []).map((r) => ({ ...r, _onClick: () => addFilter(r.k), _active: filters.some((f) => f.cut === cut && f.value === r.k) }))}
      tableMaxHeight={520}
      emptyText={cached ? "No txns match these filters in the range." : "No txn-level data yet — click Refresh (the first load reuses the Automatic Payments Dashboard's saved days)."}
    />
  );
}

function IntlDeepDive({ cache, jobs, P, handleSel, codeInfo, notes, onShowSql, onRun, onStop }) {
  const [cut, setCut] = useState("COUNTRY");
  const [openCode, setOpenCode] = useState(null);
  const pickH = (r) => handleSel === "all" || r.handle === handleSel;
  const g = useMemo(() => (cache.global?.rows || []).filter(pickH), [cache.global, handleSel]); // eslint-disable-line react-hooks/exhaustive-deps
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const curFrom = P ? P.prev.length : 0;

  // key → { cur: {c,s,f,d,amt,famt,p50f}, prev: {...}, daily }
  const agg = (dim) => {
    const m = new Map();
    for (const r of g) {
      if (r.dim !== dim || !P) continue;
      const per = P.curSet.has(r.ts) ? "cur" : P.prevSet.has(r.ts) ? "prev" : null;
      let o = m.get(r.k);
      if (!o) m.set(r.k, (o = { k: r.k, cur: { c: 0, s: 0, f: 0, d: 0, amt: 0, famt: 0, fp50: [] }, prev: { c: 0, s: 0, f: 0, d: 0, amt: 0, famt: 0, fp50: [] }, byDay: new Map() }));
      const dd = o.byDay.get(r.ts) || { c: 0, s: 0 };
      dd.c += r.c;
      if (r.status === "SUCCESS") dd.s += r.c;
      o.byDay.set(r.ts, dd);
      if (!per) continue;
      const x = o[per];
      x.c += r.c;
      x.amt += r.amt;
      if (r.status === "SUCCESS") x.s += r.c;
      else if (r.status === "DEEMED") x.d += r.c;
      else {
        x.f += r.c;
        x.famt += r.amt;
        if (r.p50 != null) x.fp50.push([r.p50, r.c]);
      }
    }
    return m;
  };
  // Median failed ₹ over the period ≈ the count-weighted median of the daily medians (exact medians need txn rows).
  const wMedian = (pairs) => {
    const t = pairs.reduce((a, [, n]) => a + n, 0);
    let acc = 0;
    for (const [v, n] of [...pairs].sort((a, b) => a[0] - b[0])) if ((acc += n) >= t / 2) return v;
    return null;
  };

  const cutRows = useMemo(() => {
    if (!P) return [];
    const m = agg(cut);
    const tot = [...m.values()].reduce((a, o) => a + o.cur.f, 0);
    let list = [...m.values()]
      .filter((o) => o.cur.c || o.prev.c)
      .map((o) => {
        const sr = pct(o.cur.s, o.cur.c);
        const psr = pct(o.prev.s, o.prev.c);
        return { id: o.k, k: o.k, ...o.cur, sr, psr, dpp: sr != null && psr != null ? sr - psr : null, failShare: pct(o.cur.f, tot), medFail: wMedian(o.cur.fp50), daily: P.chart.map((d) => pct(o.byDay.get(d)?.s || 0, o.byDay.get(d)?.c || 0)) };
      });
    list = ["AMOUNT", "HOUR", "BIND_AGE"].includes(cut) ? list.sort((a, b) => a.k.localeCompare(b.k)) : list.sort((a, b) => b.c - a.c).slice(0, 40);
    return list;
  }, [g, P, cut]); // eslint-disable-line react-hooks/exhaustive-deps

  const ris = useMemo(() => {
    const m = new Map();
    for (const r of cache.translator?.rows || []) if (r.app && !m.has(r.app)) m.set(r.app, r);
    return m;
  }, [cache.translator]);
  const codeRows = useMemo(() => {
    if (!P) return [];
    const m = agg("CODE");
    const cc = new Map(); // code → country → n (current period)
    for (const r of g) {
      if (r.dim !== "CODE_COUNTRY" || !P.curSet.has(r.ts)) continue;
      const [code, country] = r.k.split("|");
      if (!cc.has(code)) cc.set(code, new Map());
      cc.get(code).set(country, (cc.get(code).get(country) || 0) + r.c);
    }
    const tot = [...m.values()].reduce((a, o) => a + o.cur.c, 0);
    return [...m.values()]
      .filter((o) => o.cur.c || o.prev.c)
      .map((o) => ({
        id: o.k,
        code: o.k,
        n: o.cur.c,
        share: pct(o.cur.c, tot),
        prev: o.prev.c,
        trend: trendOf(o.cur.c, o.prev.c),
        famt: o.cur.famt,
        medFail: wMedian(o.cur.fp50),
        countries: [...(cc.get(o.k) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
        ris: ris.get(o.k) || null,
        note: notes?.[o.k] || null,
        daily: P.chart.map((d) => o.byDay.get(d)?.c || 0),
      }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 30);
  }, [g, P, ris, notes]); // eslint-disable-line react-hooks/exhaustive-deps

  const reasons = useMemo(() => {
    if (!P) return null;
    const rows = (cache.activation_fail?.rows || []).filter(pickH);
    const by = new Map();
    let tot = 0;
    let ptot = 0;
    for (const r of rows) {
      const cur = P.curSet.has(r.ts);
      const prev = P.prevSet.has(r.ts);
      if (!cur && !prev) continue;
      let o = by.get(r.reason);
      if (!o) by.set(r.reason, (o = { id: r.reason, reason: r.reason, n: 0, prev: 0, isNew: 0, steps: new Map(), psp: new Map() }));
      if (cur) {
        o.n += r.n;
        tot += r.n;
        if (r.isNew) o.isNew += r.n;
        o.steps.set(r.step, (o.steps.get(r.step) || 0) + r.n);
        o.psp.set(r.handle, (o.psp.get(r.handle) || 0) + r.n);
      } else {
        o.prev += r.n;
        ptot += r.n;
      }
    }
    const list = [...by.values()].filter((o) => o.n || o.prev).map((o) => ({ ...o, share: pct(o.n, tot), trend: trendOf(o.n, o.prev) })).sort((a, b) => b.n - a.n);
    return { list, tot, ptot };
  }, [cache.activation_fail, P, handleSel]); // eslint-disable-line react-hooks/exhaustive-deps

  const cutLabel = GLOBAL_CUTS.find(([d]) => d === cut)?.[1] || cut;
  const cutCols = [
    { key: "k", label: cutLabel, align: "left", render: (r) => (cut === "MCC" && mccName(r.k) ? `${r.k} · ${mccName(r.k)}` : bandLabel(r.k)), text: (r) => r.k },
    { key: "c", label: "Txns", title: curLabel, render: (r) => fmtNum(r.c) },
    { key: "s", label: "Success", render: (r) => fmtNum(r.s) },
    { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
    { key: "d", label: "Deemed", render: (r) => fmtNum(r.d) },
    { key: "sr", label: "SR", render: (r) => <b style={{ color: srTone(r.sr, null) }}>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp) }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "failShare", label: "% of failures", render: (r) => fmtPct(r.failShare) },
    { key: "famt", label: "Failed ₹", render: (r) => fmtInr(r.famt) },
    { key: "medFail", label: "Median failed ₹", title: "Count-weighted median of the daily medians of failed amounts", render: (r) => fmtInr(r.medFail) },
    { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color="#94a3b8" curFrom={curFrom} />, text: () => "" },
  ];
  const descOf = (c) => {
    const i = codeInfo?.[c];
    return i ? [i.npci, i.bank, i.app && `app: “${i.app}”`].filter(Boolean).join(" · ") : "";
  };
  const codeCols = [
    {
      key: "code",
      label: "Code · description",
      align: "left",
      wrap: true,
      render: (r) => (
        <div style={{ minWidth: 260, maxWidth: 420 }}>
          <code style={{ fontWeight: 700 }}>{r.code}</code>
          {r.note && <span style={{ marginLeft: 6, fontSize: 11, color: C.accent }}>{r.note.title}</span>}
          {descOf(r.code) && <div style={{ fontSize: 11, color: C.text2 }}>{descOf(r.code)}</div>}
          {openCode === r.code && r.note && (
            <div style={{ fontSize: 11, color: C.text2, marginTop: 6, lineHeight: 1.45, whiteSpace: "normal" }}>
              {r.note.npci && <div><b>NPCI / RIS:</b> {r.note.npci}</div>}
              {r.note.why && <div style={{ marginTop: 3 }}><b>Why:</b> {r.note.why}</div>}
              {(r.note.evidence || []).map((e, i) => <div key={i} style={{ marginTop: 2 }}>• {e}</div>)}
              {r.note.owner && <div style={{ marginTop: 3 }}><b>Owner:</b> {r.note.owner}</div>}
              <div style={{ marginTop: 3, color: C.muted }}>{notes?._window}</div>
            </div>
          )}
        </div>
      ),
      text: (r) => `${r.code} ${descOf(r.code)}`,
    },
    { key: "ris", label: "RIS mapping", title: "Core translator: app code → NPCI / CBS / switch / risk code", align: "left", render: (r) => (r.ris ? <span style={{ fontSize: 12 }}>{[r.ris.npci && `NPCI ${r.ris.npci}`, r.ris.cbs && `CBS ${r.ris.cbs}`, r.ris.sw && `switch ${r.ris.sw}`, r.ris.risk && `risk ${r.ris.risk}`].filter(Boolean).join(" · ") || "—"}</span> : <span style={{ color: C.muted }}>not in translator</span>), text: (r) => (r.ris ? r.ris.npci : "") },
    { key: "n", label: "Count", title: curLabel, render: (r) => <b>{fmtNum(r.n)}</b>, text: (r) => String(r.n) },
    { key: "share", label: "Share", title: "Share of non-success txns", render: (r) => fmtPct(r.share) },
    { key: "prev", label: "Prev", title: prevLabel, render: (r) => fmtNum(r.prev) },
    { key: "trend", label: "vs Prev", render: (r) => <TrendBadge t={r.trend} />, text: (r) => (r.trend.kind === "new" ? "NEW" : fmtSigned(r.trend.pct, "%", 0)) },
    { key: "famt", label: "₹", render: (r) => fmtInr(r.famt) },
    { key: "medFail", label: "Median ₹", render: (r) => fmtInr(r.medFail) },
    { key: "countries", label: "Top countries", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{r.countries.map(([c, n]) => `${COUNTRY_NAME[c] || c} ${fmtNum(n)}`).join(", ")}</span>, text: (r) => r.countries.map(([c, n]) => `${c} ${n}`).join(", ") },
    { key: "daily", label: "Daily", render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="Count" unit="count" upIsBad color={r.trend.kind === "up" || r.trend.kind === "new" ? C.bad : "#94a3b8"} curFrom={curFrom} />, text: () => "" },
  ];
  const reasonCols = [
    { key: "reason", label: "Reason", align: "left", wrap: true, render: (r) => <span><code>{r.reason}</code>{REASON_LABEL[r.reason] && <span style={{ fontSize: 11, color: C.text2 }}> · {REASON_LABEL[r.reason]}</span>}{descOf(r.reason) && <div style={{ fontSize: 11, color: C.text2 }}>{descOf(r.reason)}</div>}</span>, text: (r) => r.reason },
    { key: "n", label: "Not completed", title: curLabel, render: (r) => <b>{fmtNum(r.n)}</b>, text: (r) => String(r.n) },
    { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
    { key: "prev", label: "Prev", title: prevLabel, render: (r) => fmtNum(r.prev) },
    { key: "trend", label: "vs Prev", render: (r) => <TrendBadge t={r.trend} />, text: (r) => (r.trend.kind === "new" ? "NEW" : fmtSigned(r.trend.pct, "%", 0)) },
    { key: "isNew", label: "New users", render: (r) => fmtPct(pct(r.isNew, r.n), 0) },
    { key: "psp", label: "PSP", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{[...r.psp.entries()].map(([h, n]) => `${h} ${fmtPct(pct(n, r.n), 0)}`).join(", ")}</span>, text: () => "" },
    { key: "steps", label: "Failed step", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{[...r.steps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([st, n]) => `${st} ${fmtNum(n)}`).join(", ")}</span>, text: () => "" },
  ];
  const panel = (q) => ({ job: jobs[q], cached: cache[q], onShowSql: () => onShowSql(q), onRefresh: () => onRun(q), onStop: () => onStop(q) });
  return (
    <>
      <Section
        n={7}
        title={`Why payments fail · by ${cutLabel.toLowerCase()}`}
        desc={`UPI International txns per cut, current ${curLabel} vs previous ${prevLabel}. Daily aggregates (from the APD UPI Global page): single cuts and fixed bands only — no free cross-filters or custom amount ranges. Location is a coarse flag (no coordinates leave the query).`}
        {...panel("global")}
        controls={<Pills label="Cut" value={cut} options={GLOBAL_CUTS} onChange={setCut} />}
        cols={cutCols}
        rows={cutRows}
        tableMaxHeight={560}
        emptyText="No data yet — click Refresh (the first load reuses the APD's txn-level pull, then queries the newest days)."
      />
      <Section
        n={8}
        title="Failure codes · RIS mapping and analyst notes"
        desc={`Non-success txns by code (NPCI code, else app code), current ${curLabel} vs previous ${prevLabel}, with the core translator mapping (TPAP Redash response_code_translator) and the analyst notes kept from the APD page — click a code with a note to expand it.`}
        {...panel("global")}
        cols={codeCols}
        rows={codeRows.map((r) => ({ ...r, _active: openCode === r.code, _onClick: r.note ? () => setOpenCode(openCode === r.code ? null : r.code) : undefined }))}
        tableMaxHeight={620}
      />
      <Section
        n={9}
        title="Activations not completed · why"
        desc={`Activations still not ACTIVE by the end of the day, by reason: the last failure code of the day in the app activity log (tpap_pms.upi_user_activity_log), else validity ended / turned off / no final response / no log. ${reasons ? `${fmtNum(reasons.tot)} not completed in ${curLabel} (previous ${fmtNum(reasons.ptot)}).` : ""}`}
        {...panel("activation_fail")}
        cols={reasonCols}
        rows={reasons?.list || []}
        tableMaxHeight={520}
        emptyText="No data yet — click Refresh."
      />
    </>
  );
}

// ─── Top merchants (Mandates tab) ───────────────────────────────────────────
// Ported from the Automatic Payments Dashboard: successful purpose-14 Creates (distinct UMNs) per payee, every UMN on
// the switch; each day keeps its top 40 payees per CC flag + an "__ALL__" total. Periods anchor on the latest day.
const MERCHANT_TOPS = [20, 40];
// ─── CC vs CASA · P2M (ported from the APD "CC vs CASA" tab, P2M scope) ─────

/** Section 3: CC vs CASA before / after a pivot day (APD RCC prioritisation), from the saved days; Excel download. */
function CcCasaCompare({ codeInfo }) {
  const [pivot, setPivot] = useState("2026-10-07");
  const [cmp, setCmp] = useState(null);
  const [err, setErr] = useState("");
  const [stagePick, setStagePick] = useState("P2M|P2M pay");
  useEffect(() => {
    let live = true;
    setErr("");
    api(`/cccasa/compare?pivot=${pivot}`)
      .then((d) => live && setCmp(d))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [pivot]);
  const stages = cmp ? [...new Set(cmp.sr.map((r) => `${r.scope}|${r.stage}`))] : [];
  const daily = cmp ? cmp.daily.filter((r) => `${r.scope}|${r.stage}` === stagePick) : [];
  const days = daily.map((r) => r.day);
  const pivotIdx = days.findIndex((d) => d >= (cmp?.pivot || pivot));
  const srCell = (v) => fmtPct(v, 2);
  const dpp = (v) => <span style={{ color: ppToneOf(v) }}>{fmtSigned(v, " pp", 2)}</span>;
  const srCols = [
    { key: "scope", label: "Scope", align: "left", render: (r) => r.scope },
    { key: "stage", label: "Stage", align: "left", render: (r) => r.stage },
    { key: "ccPreSr", label: "CC before", title: "CC SR before the pivot", render: (r) => srCell(r.ccPreSr) },
    { key: "ccPostSr", label: "CC after", render: (r) => srCell(r.ccPostSr) },
    { key: "ccDpp", label: "CC Δ", render: (r) => dpp(r.ccDpp), text: (r) => String(r.ccDpp ?? "") },
    { key: "casaPreSr", label: "CASA before", render: (r) => srCell(r.casaPreSr) },
    { key: "casaPostSr", label: "CASA after", render: (r) => srCell(r.casaPostSr) },
    { key: "casaDpp", label: "CASA Δ", render: (r) => dpp(r.casaDpp), text: (r) => String(r.casaDpp ?? "") },
    { key: "gapPre", label: "Gap before (CC − CASA)", render: (r) => fmtSigned(r.gapPre, " pp", 2) },
    { key: "gapPost", label: "Gap after", render: (r) => fmtSigned(r.gapPost, " pp", 2) },
    { key: "gapChange", label: "Gap change", render: (r) => dpp(r.gapChange), text: (r) => String(r.gapChange ?? "") },
    { key: "ccPostAtt", label: "CC attempts after", render: (r) => fmtNum(r.ccPostAtt) },
  ];
  const moverCols = [
    { key: "scope", label: "Scope · stage · acct", align: "left", render: (r) => `${r.scope} · ${r.stage} · ${r.acct}`, text: (r) => `${r.scope} ${r.stage} ${r.acct}` },
    { key: "code", label: "Code", align: "left", wrap: true, render: (r) => <div style={{ minWidth: 160, maxWidth: 300 }}><code style={{ fontWeight: 700 }}>{r.code}</code><div style={{ fontSize: 11, color: C.text2 }}>{r.description || r.app}</div></div>, text: (r) => r.code },
    { key: "party", label: "Party", align: "left", render: (r) => <span title={codeInfo?.[r.code]?.partyWhy || ""}>{r.party}{r.type ? ` · ${r.type}` : ""}</span>, text: (r) => r.party },
    { key: "prePct", label: "Before % of attempts", render: (r) => fmtPct(r.prePct, 2) },
    { key: "postPct", label: "After %", render: (r) => fmtPct(r.postPct, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp == null ? null : -r.dpp), fontWeight: 700 }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => String(r.dpp) },
    { key: "post", label: "Failures after", render: (r) => fmtNum(r.post) },
  ];
  return (
    <Section
      n={3}
      title={`Before / after ${cmp ? fmtDay(cmp.pivot) : fmtDay(pivot)} · CC vs CASA, Autopay + P2M`}
      desc={
        cmp
          ? `RCC prioritisation (APD): before = ${fmtDay(cmp.from)} – the day before the pivot (${cmp.preDays} days), after = ${fmtDay(cmp.pivot)} – ${fmtDay(cmp.to)} (${cmp.postDays} days). Autopay = purpose-14 mandates on the golden unit chosen for Mandates (@paytm UMNs included) — APD's old CC vs CASA board left @paytm out, so its Autopay numbers differ slightly. Days come from the saved history (Mandates backfilled since 1 Jan).`
          : "Loading the saved days…"
      }
      controls={
        <>
          <span style={{ fontSize: 11, color: C.muted }}>Pivot day</span>
          <input type="date" value={pivot} onChange={(e) => e.target.value && setPivot(e.target.value)} style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", fontSize: 12 }} aria-label="Pivot day" />
          <a href={`${API}/cccasa/compare?pivot=${cmp?.pivot || pivot}&format=xlsx`} style={{ ...btn(true), textDecoration: "none", padding: "3px 10px" }} title="About, Pre vs Post SR, Code movers, All codes, Daily SR, DoD top codes">
            ⬇ Excel
          </a>
          <Pills label="Chart" value={stagePick} options={stages.map((k) => [k, k.replace("|", " · ")])} onChange={setStagePick} />
        </>
      }
      chart={
        daily.length > 1 && (
          <TrendChart
            days={days}
            curFrom={pivotIdx < 0 ? days.length : pivotIdx}
            lines={[
              { name: "CC SR", color: SERIES[0], values: daily.map((r) => r.ccSr) },
              { name: "CASA SR", color: SERIES[1], values: daily.map((r) => r.casaSr) },
            ]}
            bars={{ name: "CC attempts", values: daily.map((r) => r.ccAtt) }}
          />
        )
      }
      cols={srCols}
      rows={(cmp?.sr || []).map((r) => ({ ...r, id: `${r.scope}|${r.stage}` }))}
      note={err || (cmp && "Shaded area = after the pivot. Code movers and the day-on-day top codes are below the table and in the Excel.")}
      footer={
        cmp && (
          <div style={{ padding: "0 16px 16px" }}>
            <div style={{ fontSize: 13, fontWeight: 700, margin: "8px 0" }}>Code movers · biggest change in % of attempts (≥ 50 failures)</div>
            <Table cols={moverCols} rows={cmp.movers.slice(0, 30).map((r) => ({ ...r, id: `${r.scope}|${r.stage}|${r.acct}|${r.code}` }))} maxHeight={420} />
            <div style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 8px" }}>Day on day · top 10 codes per scope × account, newest 14 days</div>
            <Table
              cols={[
                { key: "who", label: "Scope · acct", align: "left", render: (r) => `${r.scope} · ${r.acct}` },
                { key: "code", label: "Stage · code", align: "left", render: (r) => r.code },
                ...cmp.dodDays.slice().reverse().map((d) => ({ key: d, label: fmtDay(d), render: (r) => fmtNum(r[d]) })),
              ]}
              rows={cmp.dod.map((r) => ({ ...r, id: `${r.scope}|${r.acct}|${r.code}` }))}
              maxHeight={420}
            />
          </div>
        )
      }
    />
  );
}

function CcCasaView({ cached, job, range, codeInfo, onShowSql, onRun, onStop }) {
  const [acct, setAcct] = useState("CC");
  const [codeTop, setCodeTop] = useState(15);
  const P = useMemo(() => moneyPeriods(cached, range), [cached, range]);
  const rows = useMemo(() => (cached?.rows || []).map((r) => ({ ...r, amt: 0 })), [cached]);
  const cc = useDailySlice(useMemo(() => rows.filter((r) => r.acct === "CC"), [rows]), P);
  const casa = useDailySlice(useMemo(() => rows.filter((r) => r.acct === "CASA"), [rows]), P);
  const panel = { job, cached, onShowSql: () => onShowSql(P ? { path: "cc_casa/day.sql", params: { day: P.to }, note: `APD CC vs CASA query (Autopay + P2M) for ${P.to}; this tab uses its P2M part` } : undefined), onRefresh: onRun, onStop };
  const curFrom = P ? P.prev.length : 0;
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const dayRows = useMemo(() => {
    if (!P || !cc || !casa) return [];
    const g = (s, d) => s.byDay.get(d) || { c: 0, s: 0 };
    const mk = (id, label, a, b, extra = {}) => {
      const ccSr = pct(a.s, a.c);
      const casaSr = pct(b.s, b.c);
      return { id, label, ccN: a.c, ccSr, casaN: b.c, casaSr, gap: ccSr != null && casaSr != null ? ccSr - casaSr : null, ccShare: pct(a.c, a.c + b.c), ...extra };
    };
    return [
      mk("__cur", `Current · ${curLabel}`, cc.cur, casa.cur, { _total: true }),
      mk("__prev", `Previous · ${prevLabel}`, cc.prev, casa.prev, { _total: true }),
      ...[...P.cur].reverse().map((d) => mk(d, fmtDay(d), g(cc, d), g(casa, d))),
    ];
  }, [P, cc, casa, curLabel, prevLabel]);
  const srCols = [
    { key: "label", label: "Day", align: "left", render: (r) => r.label, text: (r) => r.label },
    { key: "ccN", label: "CC txns", render: (r) => fmtNum(r.ccN) },
    { key: "ccSr", label: "CC SR", render: (r) => <b>{fmtPct(r.ccSr, 2)}</b>, text: (r) => fmtPct(r.ccSr, 2) },
    { key: "casaN", label: "CASA txns", render: (r) => fmtNum(r.casaN) },
    { key: "casaSr", label: "CASA SR", render: (r) => <b>{fmtPct(r.casaSr, 2)}</b>, text: (r) => fmtPct(r.casaSr, 2) },
    { key: "gap", label: "CC − CASA", title: "CC SR minus CASA SR", render: (r) => <span style={{ color: ppToneOf(r.gap) }}>{fmtSigned(r.gap, " pp", 2)}</span>, text: (r) => fmtSigned(r.gap, " pp", 2) },
    { key: "ccShare", label: "CC share", title: "CC share of P2M txns (CC + CASA)", render: (r) => fmtPct(r.ccShare, 2) },
  ];
  const codeRows = useMemo(() => rows.filter((r) => r.status === "FAILURE" && (acct === "all" || r.acct === acct)).map((r) => ({ ts: r.ts, code: r.code, c: r.c, amt: 0, msg: r.app && r.app !== r.code ? `app code ${r.app}` : "" })), [rows, acct]);
  // APD "error-code matrix": top codes × the newest 14 days, share of attempts (or count), shaded vs the code's usual day.
  const [codeView, setCodeView] = useState("day");
  const [matrixMeasure, setMatrixMeasure] = useState("share");
  const matrix = useMemo(() => {
    if (!P) return null;
    const days = daysBetween(toDay(toMs(P.to) - 13 * DAY), toDay(toMs(P.to) + DAY));
    const att = new Map();
    const by = new Map();
    for (const r of rows) {
      if (acct !== "all" && r.acct !== acct) continue;
      att.set(r.ts, (att.get(r.ts) || 0) + r.c);
      if (r.status !== "FAILURE") continue;
      if (!by.has(r.code)) by.set(r.code, new Map());
      by.get(r.code).set(r.ts, (by.get(r.code).get(r.ts) || 0) + r.c);
    }
    const val = (m, d) => (matrixMeasure === "share" ? pct(m.get(d) || 0, att.get(d) || 0) : m.get(d) || 0);
    const list = [...by.entries()]
      .map(([code, m]) => ({ id: code, code, m, total: days.reduce((a, d) => a + (m.get(d) || 0), 0) }))
      .filter((o) => o.total)
      .sort((a, b) => b.total - a.total)
      .slice(0, codeTop)
      .map((o) => ({ ...o, ...Object.fromEntries(days.map((d) => [d, val(o.m, d)])), usual: median(days.slice(0, -1).map((d) => val(o.m, d))) }));
    return { days, list };
  }, [P, rows, acct, codeTop, matrixMeasure]);
  const shade = (v, usual) => {
    if (v == null || !usual) return undefined;
    const x = v / usual;
    return x >= 1.5 ? "rgba(248,113,113,.45)" : x >= 1.2 ? "rgba(248,113,113,.2)" : x <= 0.67 ? "rgba(52,211,153,.2)" : undefined;
  };
  const matrixCols = matrix
    ? [
        { key: "code", label: "Code", align: "left", wrap: true, render: (r) => <div style={{ minWidth: 180, maxWidth: 300 }}><code style={{ fontWeight: 700 }}>{r.code}</code><div style={{ fontSize: 11, color: C.text2 }}>{[codeInfo?.[r.code]?.npci, codeInfo?.[r.code]?.party].filter(Boolean).join(" · ")}</div></div>, text: (r) => r.code },
        ...matrix.days
          .slice()
          .reverse()
          .map((d) => ({
            key: d,
            label: fmtDay(d),
            render: (r) => <span style={{ display: "block", padding: "1px 4px", borderRadius: 3, background: shade(r[d], r.usual) }}>{matrixMeasure === "share" ? fmtPct(r[d], 2) : fmtNum(r[d])}</span>,
            text: (r) => String(r[d] ?? ""),
          })),
        { key: "usual", label: "Usual (median)", render: (r) => (matrixMeasure === "share" ? fmtPct(r.usual, 2) : fmtNum(r.usual)) },
      ]
    : [];
  const kpi = (s) => (s ? `${fmtPct(s.curSr, 2)}` : "—");
  return (
    <>
      <Section
        n={1}
        title="P2M success rate · credit card vs savings / current"
        desc={`P2M payments (switch VPA2MERCHANT, pay + collect, not mandates) by the payer account: CC = credit card, CASA = savings / current; one attempt per txn, latest status. Current ${curLabel} vs previous ${prevLabel}. Autopay CC vs CASA is in the Mandates tab (Payer account filter).`}
        {...panel}
        kpis={
          P && cc && casa ? (
            <>
              <Kpi label="CC SR" value={kpi(cc)} sub={`${fmtSigned(cc.curSr != null && cc.prevSr != null ? cc.curSr - cc.prevSr : null, " pp", 2)} vs prev · ${fmtNum(cc.cur.c)} txns`} />
              <Kpi label="CASA SR" value={kpi(casa)} sub={`${fmtSigned(casa.curSr != null && casa.prevSr != null ? casa.curSr - casa.prevSr : null, " pp", 2)} vs prev · ${fmtNum(casa.cur.c)} txns`} />
              <Kpi label="CC − CASA" value={fmtSigned(cc.curSr != null && casa.curSr != null ? cc.curSr - casa.curSr : null, " pp", 2)} sub="SR gap, current period" />
            </>
          ) : null
        }
        chart={
          P &&
          cc &&
          casa && (
            <TrendChart
              days={P.chart}
              curFrom={curFrom}
              lines={[
                { name: "CC SR", color: SERIES[0], values: cc.sr },
                { name: "CASA SR", color: SERIES[1], values: casa.sr },
              ]}
              bars={{ name: "CC txns", values: cc.count }}
              dots={P.chart.length < 20}
            />
          )
        }
        tableToggle
        cols={srCols}
        rows={dayRows}
        emptyText="No CC vs CASA data yet — click Refresh (the first load reuses the Automatic Payments Dashboard's saved days)."
      />
      <Section
        n={2}
        title="P2M failure codes · day on day"
        desc={`Failed P2M txns by code (NPCI code, else app code) for ${acct === "all" ? "CC + CASA" : acct === "CC" ? "credit-card payers" : "savings / current payers"}; latest day vs D-1…D-3, last week and the 7-day average.`}
        {...panel}
        controls={
          <>
            <Pills label="Account" value={acct} options={[["CC", "CC"], ["CASA", "CASA"], ["all", "All"]]} onChange={setAcct} />
            <Pills label="Codes" value={codeTop} options={TOP_N_OPTIONS} onChange={setCodeTop} />
            <Pills label="View" value={codeView} options={[["day", "Day view"], ["matrix", "14-day matrix"]]} onChange={setCodeView} />
            {codeView === "matrix" && <Pills label="Cells" value={matrixMeasure} options={[["share", "% of attempts"], ["n", "Failures"]]} onChange={setMatrixMeasure} />}
          </>
        }
        {...(codeView === "matrix"
          ? { cols: matrixCols, rows: matrix?.list || [], note: "Shading vs the code's usual day (median of the 13 days before): dark red ≥ 1.5×, light red ≥ 1.2×, green ≤ 0.67×." }
          : { noTable: true, cols: [], rows: codeRows.length ? [{ id: "x" }] : [], chart: <DeclineCodes rows={codeRows} yday={P?.to} codeInfo={codeInfo} topN={codeTop} noAmount /> })}
      />
      <CcCasaCompare codeInfo={codeInfo} />
    </>
  );
}

// ─── Code watch (APD code_watch: UM8-ZM / UM8-Z6 / UO8 by mandate type) ─────

const CW_CODES = ["UM8-ZM", "UM8-Z6", "UO8"];
const CW_STAGES = [["all", "All types"], ["CREATE", "Create"], ["UPDATE", "Update"], ["COLLECT", "Execution"], ["PAUSE", "Pause"], ["UNPAUSE", "Unpause"], ["PAYER_REVOKE", "Payer revoke"]];

function CodeWatch({ cached, job, onShowSql, onRun, onStop }) {
  const [stage, setStage] = useState("all");
  const [view, setView] = useState("n");
  const t = useMemo(() => {
    const rows = (cached?.rows || []).filter((r) => stage === "all" || r.stage === stage);
    const days = [...new Set(rows.map((r) => r.ts))].sort();
    if (!days.length) return null;
    const att = new Map();
    const fail = new Map(); // `${code}|${day}` → units failing with it
    const byStage = new Map(); // `${stage}|${code}|${day}`
    for (const r of rows) {
      if (r.code === "ALL") att.set(r.ts, (att.get(r.ts) || 0) + r.att);
      else {
        fail.set(`${r.code}|${r.ts}`, (fail.get(`${r.code}|${r.ts}`) || 0) + r.att);
        byStage.set(`${r.stage}|${r.code}|${r.ts}`, (byStage.get(`${r.stage}|${r.code}|${r.ts}`) || 0) + r.att);
      }
    }
    // the "ALL" bucket holds the units not failing with a watched code: attempts = ALL + the watched codes
    for (const [k, n] of fail) {
      const d = k.split("|")[1];
      att.set(d, (att.get(d) || 0) + n);
    }
    return { days, att, fail, byStage };
  }, [cached, stage]);
  const shown = t ? t.days.slice(-15).reverse() : [];
  const val = (n, d) => (view === "n" ? n : pct(n, t.att.get(d) || 0));
  const fmtV = (v) => (view === "n" ? fmtNum(v) : fmtPct(v, 2));
  const rows = t
    ? [
        { id: "__att", label: "All units (attempts)", _total: true, ...Object.fromEntries(shown.map((d) => [d, t.att.get(d) || 0])), isAtt: true },
        ...CW_CODES.map((c) => {
          const l7 = t.days.slice(-8, -1);
          const avg = l7.length ? l7.reduce((a, d) => a + (t.fail.get(`${c}|${d}`) || 0), 0) / l7.length : null;
          const now = t.fail.get(`${c}|${t.days[t.days.length - 1]}`) || 0;
          return { id: c, label: c, vsAvg: chg(now, avg), ...Object.fromEntries(shown.map((d) => [d, val(t.fail.get(`${c}|${d}`) || 0, d)])) };
        }),
        ...(stage === "all"
          ? CW_STAGES.slice(1).flatMap(([s, sl]) =>
              CW_CODES.filter((c) => shown.some((d) => t.byStage.get(`${s}|${c}|${d}`))).map((c) => ({
                id: `${s}|${c}`,
                label: `  ${sl} · ${c}`,
                ...Object.fromEntries(shown.map((d) => [d, view === "n" ? t.byStage.get(`${s}|${c}|${d}`) || 0 : null])),
              })),
            )
          : []),
      ]
    : [];
  const cols = [
    { key: "label", label: "Code", align: "left", render: (r) => <span style={{ whiteSpace: "pre" }}>{r.label}</span>, text: (r) => r.label.trim() },
    { key: "vsAvg", label: "Latest vs 7-day avg", render: (r) => (r.isAtt || r.vsAvg === undefined ? "—" : <span style={{ color: ppToneOf(r.vsAvg == null ? null : -r.vsAvg) }}>{fmtSigned(r.vsAvg, "%", 0)}</span>), text: (r) => fmtSigned(r.vsAvg, "%", 0) },
    ...shown.map((d) => ({ key: d, label: fmtDay(d), render: (r) => (r.isAtt ? fmtNum(r[d]) : fmtV(r[d])), text: (r) => (r[d] == null ? "" : String(r[d])) })),
  ];
  const chart = t && (
    <TrendChart
      days={t.days}
      lines={CW_CODES.map((c, i) => ({ name: c, color: SERIES[i], values: t.days.map((d) => val(t.fail.get(`${c}|${d}`) || 0, d)) }))}
      yFmt={(v) => (v == null ? "—" : fmtV(v))}
      dots={t.days.length < 20}
    />
  );
  return (
    <Section
      n={7}
      title="Code watch · UM8-ZM, UM8-Z6, UO8 by mandate type"
      desc="Mandate units whose latest attempt of the day failed with UM8-ZM, UM8-Z6 or UO8 (NPCI code, else app code). Golden unit, every purpose: Paytm UMNs, one per UMN per day (executions per UMN + execution number); Payer revoke = REVOKE raised from the payer's app. Same query as the Automatic Payments Dashboard's Code watch."
      job={job}
      cached={cached}
      onShowSql={() => onShowSql(t ? { path: "code_watch/code_watch.sql", params: { start: t.days[0], end: toDay(toMs(t.days[t.days.length - 1]) + DAY) }, note: `${t.days[0]} … ${t.days[t.days.length - 1]} (end exclusive)` } : undefined)}
      onRefresh={onRun}
      onStop={onStop}
      controls={
        <>
          <Pills label="Type" value={stage} options={CW_STAGES} onChange={setStage} />
          <Pills label="Show" value={view} options={[["n", "Failures"], ["pct", "% of units"]]} onChange={setView} />
        </>
      }
      chart={chart}
      tableToggle
      cols={cols}
      rows={rows}
      emptyText="No Code watch data yet — click Refresh (the first load reuses the Automatic Payments Dashboard's saved days)."
    />
  );
}

// ─── Interop (ported from the Automatic Payments Dashboard's Interop tab) ───

const IX_SPANS = [["7", "Last 7"], ["14", "Last 14"], ["mtd", "Month to date"], ["lm", "Last month"], ["jan", "Since 1 Jan"], ["all", "All"]];
const IX_MEASURES = [["SUCCESS", "Success"], ["FAILURE", "Failure"], ["SR", "SR"]];
// Payer bank names come in mixed case ("BANK OF BARODA" / "Bank Of Baroda"): merged case-insensitively, as on the APD page.
const IX_NICE = {
  "state bank of india": "SBI", "punjab national bank": "PNB", "bank of baroda": "Bank of Baroda", "idfc first bank": "IDFC First Bank", "pragati sahakari bank ltd": "Pragati Sahakari Bank",
  "the cosmos co-operative bank ltd": "Cosmos Co-op Bank", "rbl bank limited": "RBL Bank", "union bank of india": "Union Bank of India", "bank of india": "Bank of India (BOI)",
  "central bank of india": "Central Bank of India", "bank of maharashtra": "Bank of Maharashtra", "jammu and kashmir bank": "J&K Bank", "indian bank": "Indian Bank", "uco bank": "UCO Bank",
  "federal bank": "Federal Bank", "kerala gramin bank": "Kerala Gramin Bank", bank: "(blank bank name)",
};
const ixBank = (k) => {
  const l = String(k || "").trim().toLowerCase().replace(/\s+/g, " ");
  return IX_NICE[l] || String(k || "").trim().replace(/\s+/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase()) || "(blank bank name)";
};
// Port-Out payer bank = IFSC prefix of the original Paytm mandate's payer leg.
const IX_BANK_CODES = {
  SBIN: "SBI", BKID: "Bank of India (BOI)", CNRB: "Canara Bank", HDFC: "HDFC Bank", JAKA: "J&K Bank", ICIC: "ICICI Bank", BARB: "Bank of Baroda", PUNB: "PNB",
  IPOS: "India Post Payments Bank", FINO: "Fino Payments Bank", UBIN: "Union Bank of India", UTIB: "Axis Bank", IDIB: "Indian Bank", YESB: "Yes Bank", INDB: "IndusInd Bank",
  KKBK: "Kotak Mahindra Bank", IDFB: "IDFC First Bank", CBIN: "Central Bank of India", UCBA: "UCO Bank", IOBA: "Indian Overseas Bank", MAHB: "Bank of Maharashtra", FDRL: "Federal Bank",
  AIRP: "Airtel Payments Bank", JIOP: "Jio Payments Bank", AUBL: "AU Small Finance Bank", RATN: "RBL Bank", SIBL: "South Indian Bank", KVBL: "Karur Vysya Bank", PSIB: "Punjab & Sind Bank",
  IBKL: "IDBI Bank", CIUB: "City Union Bank", TMBL: "Tamilnad Mercantile Bank", KARB: "Karnataka Bank", DLXB: "Dhanlaxmi Bank", ESFB: "Equitas SFB", NA: "(bank not found)",
};
const IX_HANDLES = { paytm: "@paytm", ptyes: "@ptyes", ptaxis: "@ptaxis", pthdfc: "@pthdfc", ptsbi: "@ptsbi", OTHER: "Other handles" };

/** Group rows into { total: {S, F}, items: Map(label → {S, F}) } with S / F = Map(day → n). */
function ixGroup(rows, keyOf, isTotal) {
  const blank = () => ({ S: new Map(), F: new Map() });
  const put = (o, r) => {
    const m = r.status === "SUCCESS" ? o.S : o.F;
    m.set(r.ts, (m.get(r.ts) || 0) + r.n);
  };
  const total = blank();
  const items = new Map();
  for (const r of rows) {
    if (isTotal(r)) {
      put(total, r);
      continue;
    }
    const k = keyOf(r);
    if (k == null) continue;
    if (!items.has(k)) items.set(k, blank());
    put(items.get(k), r);
  }
  return { total, items };
}
const ixSum = (m, days) => days.reduce((a, d) => a + (m.get(d) || 0), 0);

function ixDays(allDays, span, custom) {
  const hi = allDays[allDays.length - 1];
  if (!hi) return [];
  if (span === "custom" && custom?.from && custom?.to) return allDays.filter((d) => d >= custom.from && d <= custom.to);
  if (span === "all") return allDays;
  if (span === "mtd") return allDays.filter((d) => d.slice(0, 7) === hi.slice(0, 7));
  if (span === "lm") {
    const p = toDay(Date.UTC(Number(hi.slice(0, 4)), Number(hi.slice(5, 7)) - 2, 1)).slice(0, 7);
    return allDays.filter((d) => d.slice(0, 7) === p);
  }
  if (span === "jan") return allDays.filter((d) => d >= `${hi.slice(0, 4)}-01-01`);
  return allDays.slice(-Number(span));
}

/** One Interop card: total trend (SR line, attempts bars) + table with Till date / chosen days / share / day columns. */
function IxPivot({ n, title, desc, group, allDays, days, nameLabel, measure, setMeasure, onlyFailures, top = 40, controls, panel, layout = "rows" }) {
  const shownDays = days.slice(-31).reverse();
  const val = (o, ds) => {
    const s = ixSum(o.S, ds);
    const f = ixSum(o.F, ds);
    return { s, f, sr: pct(s, s + f) };
  };
  const pick = (v) => (onlyFailures ? v.f : measure === "SUCCESS" ? v.s : measure === "FAILURE" ? v.f : v.sr);
  const fmtV = (v) => (onlyFailures || measure !== "SR" ? fmtNum(v) : fmtPct(v));
  const tot = val(group.total, days);
  const lastDay = [...group.total.S.keys(), ...group.total.F.keys()].reduce((a, d) => (d > a ? d : a), "");
  const quiet = lastDay && tot.s + tot.f === 0 ? ` No records in the chosen days — the last day with any is ${fmtDay(lastDay)} ${lastDay.slice(0, 4)} (same in the Automatic Payments Dashboard).` : "";
  const shareBase = onlyFailures ? tot.f : measure === "FAILURE" ? tot.f : tot.s;
  const mk = (id, label, o, extra = {}) => {
    const till = val(o, allDays);
    const cur = val(o, days);
    const row = { id, label, till, cur, share: extra._total ? null : pct(onlyFailures || measure === "FAILURE" ? cur.f : cur.s, shareBase), ...extra };
    for (const d of shownDays) row[d] = pick(val(o, [d]));
    return row;
  };
  const items = [...group.items.entries()]
    .map(([k, o]) => mk(k, k, o))
    .filter((r) => r.till.s + r.till.f > 0)
    .sort((a, b) => (onlyFailures ? b.cur.f - a.cur.f : b.cur.s + b.cur.f - (a.cur.s + a.cur.f)) || b.till.s + b.till.f - (a.till.s + a.till.f))
    .slice(0, top);
  const rows = [mk("__total", "Total", group.total, { _total: true }), ...items];
  const trio = (key, lab, sub) =>
    onlyFailures
      ? [{ key: `${key}f`, label: lab, title: sub, render: (r) => fmtNum(r[key].f), text: (r) => String(r[key].f) }]
      : [
          { key: `${key}s`, label: `${lab} success`, title: sub, render: (r) => fmtNum(r[key].s), text: (r) => String(r[key].s) },
          { key: `${key}f`, label: `${lab} failure`, title: sub, render: (r) => fmtNum(r[key].f), text: (r) => String(r[key].f) },
          { key: `${key}r`, label: `${lab} SR`, title: sub, render: (r) => <b>{fmtPct(r[key].sr)}</b>, text: (r) => fmtPct(r[key].sr) },
        ];
  const cols = [
    { key: "label", label: nameLabel, align: "left", render: (r) => r.label, text: (r) => r.label },
    ...trio("till", "Till date", `Every day since ${fmtDay(allDays[0])}`),
    ...trio("cur", spanLabel(days), "Chosen days"),
    { key: "share", label: "Share", title: onlyFailures || measure === "FAILURE" ? "Share of the chosen days' failures" : "Share of the chosen days' successes", render: (r) => (r._total ? "—" : fmtPct(r.share)) },
    ...shownDays.map((d) => ({ key: d, label: fmtDay(d), title: `${onlyFailures ? "Failures" : IX_MEASURES.find(([k]) => k === measure)[1]} on ${d}`, render: (r) => <span style={{ color: r[d] ? C.text : C.muted }}>{fmtV(r[d])}</span>, text: (r) => (r[d] == null ? "" : String(r[d])) })),
  ];
  // "Days as rows" (APD layout switch): one row per day, the top keys as columns, cells = the chosen measure.
  if (layout === "days") {
    const keys = items.slice(0, 15);
    const dayRows = [...days].reverse().map((d) => ({ id: d, label: fmtDay(d), d, total: pick(val(group.total, [d])), ...Object.fromEntries(keys.map((k) => [`k:${k.id}`, pick(val(group.items.get(k.id), [d]))])) }));
    const sumRow = { id: "__sum", label: `${spanLabel(days)}`, _total: true, total: pick(val(group.total, days)), ...Object.fromEntries(keys.map((k) => [`k:${k.id}`, pick(val(group.items.get(k.id), days))])) };
    cols.splice(0, cols.length,
      { key: "label", label: "Day", align: "left", sortValue: (r) => r.d || "", render: (r) => r.label, text: (r) => r.label },
      { key: "total", label: "Total", render: (r) => <b>{fmtV(r.total)}</b>, text: (r) => String(r.total ?? "") },
      ...keys.map((k) => ({ key: `k:${k.id}`, label: k.label, render: (r) => fmtV(r[`k:${k.id}`]), text: (r) => String(r[`k:${k.id}`] ?? "") })),
    );
    rows.splice(0, rows.length, sumRow, ...dayRows);
  }
  const chart = days.length > 1 && (
    <TrendChart
      days={days}
      lines={[{ name: onlyFailures ? "Failures" : "SR", color: SERIES[0], values: days.map((d) => (onlyFailures ? group.total.F.get(d) || 0 : val(group.total, [d]).sr)) }]}
      bars={onlyFailures ? undefined : { name: "Attempts (UMNs)", values: days.map((d) => (group.total.S.get(d) || 0) + (group.total.F.get(d) || 0)) }}
      yFmt={onlyFailures ? (v) => (v == null ? "—" : fmtNum(v)) : undefined}
      dots={days.length < 20}
    />
  );
  return (
    <Section
      n={n}
      title={title}
      desc={desc + quiet}
      {...panel}
      controls={
        <>
          {controls}
          {!onlyFailures && <Pills label="Day columns show" value={measure} options={IX_MEASURES} onChange={setMeasure} />}
        </>
      }
      chart={chart}
      tableToggle
      cols={cols}
      rows={rows}
      tableMaxHeight={560}
      emptyText="No Interop data yet — click Refresh (the first load reuses the Automatic Payments Dashboard's saved days)."
    />
  );
}

function InteropView({ cache, jobs, codeInfo, onShowSql, onRun, onStop }) {
  const [span, setSpan] = useState("14");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [layout, setLayout] = useState("rows");
  const [m, setM] = useState({ vpa: "SUCCESS", mic: "SUCCESS", bc: "SUCCESS", po: "SUCCESS" });
  const setMeasure = (k) => (v) => setM((o) => ({ ...o, [k]: v }));
  const [bcSplit, setBcSplit] = useState("type");
  const [poSplit, setPoSplit] = useState("app");
  const rows = useMemo(() => cache.daily?.rows || [], [cache.daily]);
  const po = useMemo(() => cache.port_out?.rows || [], [cache.port_out]);
  const allDays = useMemo(() => [...new Set([...rows.map((r) => r.ts), ...po.map((r) => r.ts)])].sort(), [rows, po]);
  const days = useMemo(() => ixDays(allDays, span, custom), [allDays, span, custom]);
  const panelOf = (q, file) => ({
    job: jobs[q],
    cached: cache[q],
    onShowSql: () => onShowSql(q, file && days.length ? { path: `interop/tables/${file}`, params: { start: days[0], end: days[days.length - 1] }, note: `chosen days ${days[0]} … ${days[days.length - 1]}; for Till date use start ${allDays[0]}` } : undefined),
    onRefresh: () => onRun(q),
    onStop: () => onStop(q),
  });

  const vpa = useMemo(() => ixGroup(rows.filter((r) => r.cls === "UPDATE_VPA" && (r.dim === "TOTAL" || r.dim === "BANK")), (r) => ixBank(r.k), (r) => r.dim === "TOTAL"), [rows]);
  const mic = useMemo(() => ixGroup(rows.filter((r) => r.cls === "UPDATEMIC" && (r.dim === "TOTAL" || r.dim === "BANK")), (r) => ixBank(r.k), (r) => r.dim === "TOTAL"), [rows]);
  const bc = useMemo(() => {
    const b = rows.filter((r) => r.purpose === "BC");
    const port = b.filter((r) => r.cls === "IN_PORT");
    if (bcSplit === "type") return ixGroup(b.filter((r) => r.dim === "TOTAL").flatMap((r) => [r, { ...r, _item: true }]), (r) => (r.cls === "IN_PORT" ? "Port-In (IN_PORT)" : "Other purpose BC (UPDATE / OUT_PORT / blank)"), (r) => !r._item);
    const dim = { app: "APP", handle: "UMN_H", bank: "BANK" }[bcSplit];
    const key = bcSplit === "bank" ? (r) => ixBank(r.k) : bcSplit === "handle" ? (r) => IX_HANDLES[r.k] || r.k : (r) => r.k || "Others";
    return ixGroup(port.filter((r) => r.dim === "TOTAL" || r.dim === dim), key, (r) => r.dim === "TOTAL");
  }, [rows, bcSplit]);
  const pout = useMemo(() => {
    const src = poSplit === "code" ? po.filter((r) => r.status === "FAILURE") : po;
    const key = poSplit === "app" ? (r) => r.app : poSplit === "bank" ? (r) => IX_BANK_CODES[r.bank] || r.bank : (r) => r.code || "(none)";
    return ixGroup(src.flatMap((r) => [r, { ...r, _item: true }]), key, (r) => !r._item);
  }, [po, poSplit]);

  const codeLabel = (c) => {
    const i = codeInfo?.[c];
    const t = i ? [i.npci, i.bank].filter(Boolean).join(" · ") : "";
    return t ? `${c} · ${t}`.slice(0, 140) : c;
  };
  const poGroup = poSplit === "code" ? { total: pout.total, items: new Map([...pout.items].map(([k, v]) => [codeLabel(k), v])) } : pout;
  const since = fmtDay(allDays[0]);
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <Pills label="Days" value={span} options={[...IX_SPANS, ["custom", "Custom"]]} onChange={setSpan} />
        {span === "custom" && (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
            <input type="date" value={custom.from} min={allDays[0]} max={allDays[allDays.length - 1]} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", fontSize: 12 }} aria-label="From" />
            –
            <input type="date" value={custom.to} min={custom.from || allDays[0]} max={allDays[allDays.length - 1]} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", fontSize: 12 }} aria-label="To" />
          </span>
        )}
        <Pills label="Layout" value={layout} options={[["rows", "Keys as rows"], ["days", "Days as rows"]]} onChange={setLayout} />
        <span style={{ fontSize: 12, color: C.muted }}>
          Chosen: {spanLabel(days)} ({days.length} days) · Till date = since {since}
        </span>
      </div>
      <IxPivot
        n={1}
        title="Update payee VPA · by payer bank"
        desc={`Superset update_payee_vpa (dataset 4598) split by payer bank: type UPDATE, txn id starting VPA. Count = distinct UMNs per day (upi_activities_data_snapshot_v3, dated by last update). Till date = since ${since}.`}
        group={vpa}
        allDays={allDays}
        days={days}
        nameLabel="Payer bank"
        measure={m.vpa}
        setMeasure={setMeasure("vpa")}
        panel={panelOf("daily", "01_update_payee_vpa_by_bank.sql")}
        layout={layout}
      />
      <IxPivot
        n={2}
        title="Update MIC · by payer bank"
        desc={`Superset updatemic_interop_report / update_mic_bank_wise_failure (datasets 4620, 7619): type UPDATEMIC, distinct UMNs per day by payer bank. Till date = since ${since}.`}
        group={mic}
        allDays={allDays}
        days={days}
        nameLabel="Payer bank"
        measure={m.mic}
        setMeasure={setMeasure("mic")}
        panel={panelOf("daily", "02_update_mic_by_bank.sql")}
        layout={layout}
      />
      <IxPivot
        n={3}
        title="Purpose BC · Port-In (mandates moving into Paytm)"
        desc="Port-In = type IN_PORT, purpose BC: a mandate made on another app (or another Paytm handle) moves to a Paytm handle with a new UMN. Other purpose-BC records (UPDATE / OUT_PORT / blank) are not port-ins — mostly failed BC updates, about half of them mandates leaving Paytm (see section 4). Distinct UMNs."
        group={bc}
        allDays={allDays}
        days={days}
        nameLabel={{ type: "Type", app: "Came from app", handle: "Moved to Paytm handle", bank: "Payer bank" }[bcSplit]}
        measure={m.bc}
        setMeasure={setMeasure("bc")}
        panel={panelOf("daily", "03_purpose_bc_port_in.sql")}
        layout={layout}
        controls={<Pills label="Split" value={bcSplit} options={[["type", "Port-In vs other BC"], ["app", "Source app"], ["handle", "Paytm handle"], ["bank", "Payer bank"]]} onChange={setBcSplit} />}
      />
      <IxPivot
        n={4}
        title="Port-Out · mandates leaving Paytm"
        desc="Port-Out = a Paytm mandate moved to another app: switch purpose-BC UPDATE whose new UMN is on the other app's handle (@ybl, @okaxis …). App = the app behind that handle; payer bank = bank of the original Paytm mandate (a failed port-out falls back to its own payer leg). Distinct new UMNs; most port-outs fail."
        group={poGroup}
        allDays={allDays}
        days={days}
        nameLabel={{ app: "Went to app", bank: "Payer bank", code: "Failure code" }[poSplit]}
        measure={m.po}
        setMeasure={setMeasure("po")}
        onlyFailures={poSplit === "code"}
        panel={panelOf("port_out", poSplit === "code" ? "07_port_out_failure_codes.sql" : "06_port_out_by_bank_or_app.sql")}
        layout={layout}
        controls={<Pills label="Split" value={poSplit} options={[["app", "App it went to"], ["bank", "Payer bank"], ["code", "Failure code"]]} onChange={setPoSplit} />}
      />
    </>
  );
}

function TopMerchants({ cached, job, onShowSql, onRun, onStop }) {
  const [cc, setCc] = useState("all");
  const [top, setTop] = useState(MERCHANT_TOPS[0]);
  const [mq, setMq] = useState("");
  const t = useMemo(() => {
    const rows = (cached?.rows || []).filter((r) => cc === "all" || (cc === "cc" ? r.cc === 1 : r.cc === 0));
    const y = rows.reduce((a, r) => (r.ts > a ? r.ts : a), "");
    if (!y) return null;
    const at = (n) => toDay(toMs(y) - n * DAY);
    const mtdFrom = `${y.slice(0, 8)}01`;
    const lm = new Date(Date.UTC(Number(y.slice(0, 4)), Number(y.slice(5, 7)) - 2, 1));
    const lmtdFrom = toDay(lm.getTime());
    const lmtdTo = toDay(Math.min(Date.UTC(lm.getUTCFullYear(), lm.getUTCMonth(), Number(y.slice(8, 10))), Date.UTC(lm.getUTCFullYear(), lm.getUTCMonth() + 1, 0)));
    const P = { d1: [y], d2: [at(1)], d3: [at(2)], l7: Array.from({ length: 7 }, (_, i) => at(i + 1)), mtd: [mtdFrom, y], lmtd: [lmtdFrom, lmtdTo] };
    const inP = (k, ts) => (k === "mtd" || k === "lmtd" ? ts >= P[k][0] && ts <= P[k][1] : P[k].includes(ts));
    const by = new Map();
    for (const r of rows) {
      const o = by.get(r.vpa) || { id: r.vpa, vpa: r.vpa, name: r.name, d1: 0, d2: 0, d3: 0, l7: 0, mtd: 0, lmtd: 0 };
      if (!o.name && r.name) o.name = r.name;
      for (const k of ["d1", "d2", "d3", "l7", "mtd", "lmtd"]) if (inP(k, r.ts)) o[k] += r.n;
      by.set(r.vpa, o);
    }
    const all = by.get("__ALL__") || { d1: 0, l7: 0, mtd: 0, lmtd: 0 };
    by.delete("__ALL__");
    const list = [...by.values()]
      .filter((o) => o.d1 || o.l7)
      .map((o) => ({ ...o, share: pct(o.d1, all.d1), vsL7: chg(o.d1, o.l7 / 7), mtdChg: chg(o.mtd, o.lmtd) }))
      .sort((a, b) => b.d1 - a.d1 || b.l7 - a.l7)
      .filter((o) => !mq.trim() || `${o.name} ${o.vpa}`.toLowerCase().includes(mq.trim().toLowerCase()))
      .slice(0, mq.trim() ? 200 : top);
    return { y, P, all, list };
  }, [cached, cc, top, mq]);
  const fmtSpan = (a) => (a.length === 2 ? `${fmtDay(a[0])} – ${fmtDay(a[1])}` : fmtDay(a[0]));
  const cols = t
    ? [
        { key: "name", label: "Merchant (payee)", align: "left", wrap: true, render: (r) => <div style={{ minWidth: 200, maxWidth: 320 }}><b>{r.name || "—"}</b><div style={{ fontSize: 11, color: C.muted }}>{r.vpa}</div></div>, text: (r) => `${r.name} ${r.vpa}` },
        { key: "d1", label: `D-1 ${fmtDay(t.P.d1[0])}`, render: (r) => <b>{fmtNum(r.d1)}</b>, text: (r) => String(r.d1) },
        { key: "share", label: "Share", title: "Share of the day's successful purpose-14 Creates", render: (r) => fmtPct(r.share) },
        { key: "d2", label: `D-2 ${fmtDay(t.P.d2[0])}`, render: (r) => fmtNum(r.d2) },
        { key: "d3", label: `D-3 ${fmtDay(t.P.d3[0])}`, render: (r) => fmtNum(r.d3) },
        { key: "l7", label: "L7D avg", title: fmtSpan([t.P.l7[6], t.P.l7[0]]), render: (r) => fmtNum(r.l7 / 7) },
        { key: "vsL7", label: "D-1 vs L7D", render: (r) => <span style={{ color: ppToneOf(r.vsL7) }}>{fmtSigned(r.vsL7, "%", 0)}</span>, text: (r) => fmtSigned(r.vsL7, "%", 0) },
        { key: "mtd", label: "MTD", title: fmtSpan(t.P.mtd), render: (r) => fmtNum(r.mtd) },
        { key: "lmtd", label: "LMTD", title: fmtSpan(t.P.lmtd), render: (r) => fmtNum(r.lmtd) },
        { key: "mtdChg", label: "MTD vs LMTD", render: (r) => <span style={{ color: ppToneOf(r.mtdChg) }}>{fmtSigned(r.mtdChg, "%", 0)}</span>, text: (r) => fmtSigned(r.mtdChg, "%", 0) },
      ]
    : [];
  return (
    <Section
      n={6}
      title="Top merchants · successful AutoPay mandate creations"
      desc={`Successful purpose-14 Creates per payee (distinct UMNs), every UMN on the switch (not only Paytm handles); ${cc === "cc" ? "credit-card mandates only" : cc === "casa" ? "non-credit-card mandates" : "all payer accounts"}. Each day keeps its top 40 payees; periods anchor on the latest day${t ? ` (${fmtDay(t.y)})` : ""}. Day total: ${t ? fmtNum(t.all.d1) : "—"} Creates.`}
      job={job}
      cached={cached}
      onShowSql={() => onShowSql(t ? { path: "mandate/tables/07_top_merchants.sql", params: { start: t.P.lmtd[0], end: t.y }, note: `LMTD start … D-1 ${t.y}` } : undefined)}
      onRefresh={onRun}
      onStop={onStop}
      controls={
        <>
          <Pills label="Account" value={cc} options={[["all", "All"], ["cc", "Credit card"], ["casa", "Not credit card"]]} onChange={setCc} />
          <Pills label="Show" value={top} options={MERCHANT_TOPS.map((n) => [n, `Top ${n}`])} onChange={setTop} />
          <input type="search" value={mq} onChange={(e) => setMq(e.target.value)} placeholder="Search merchant / VPA" aria-label="Search merchants" style={{ background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px", fontSize: 12, width: 170 }} />
        </>
      }
      cols={cols}
      rows={t?.list || []}
      tableMaxHeight={620}
      emptyText="No merchant data yet — click Refresh (the first load reuses the Automatic Payments Dashboard's saved days)."
    />
  );
}

// ─── Mandates ────────────────────────────────────────────────────────────────
//
// One cached "daily" query (Trino, one SQL per day, last 30 complete days). Unit = the team's
// golden mandate unit (v4, 11 Nov 2026): Paytm-app UMNs incl. @paytm; Create / Revoke / Pause / Unpause once per
// UMN per day, executions once per UMN + execution number per day; latest status. SR = SUCCESS / all attempts.
// Rows: dim ALL = every attempt (ts × purpose × stage × payer account × status × code);
// dim BANK / HANDLE = failures by payer bank / payee handle (newest 7 days, codes with ≥ 50
// failures that day, top 5 each + Other); dim MCC / PAYER_BANK / PAYEE = every attempt by payee
// MCC / payer bank / payee handle (top 20 a day + Other, no code, no mode). Mode (initiationMode)
// is on dim ALL only. The range picker (MONEY_RANGES) sets the current period.

const MANDATE_STAGES = [
  { id: "CREATE", label: "Create" },
  { id: "EXEC1", label: "1st execution" },
  { id: "EXECR", label: "Recurring execution" },
  { id: "REVOKE", label: "Revoke" },
  { id: "PAUSE", label: "Pause" },
  { id: "UNPAUSE", label: "Unpause" },
];
const MANDATE_ACCTS = ["CC", "CASA", "OTHER"];
const ACCT_LABEL = { CC: "CC", CASA: "CASA", OTHER: "Other" };
const ACCT_COLOR = { CC: "#f472b6", CASA: "#60a5fa", OTHER: "#a78bfa" };
const PURPOSE_LABEL = { 14: "14 · AutoPay" };
const MANDATE_MODES = [["04", "Intent · 04"], ["00", "Collect · 00"], ["13", "QR · 13"], ["11", "Mandate · 11"], ["NA", "Not set"]];
const MODE_LABEL = Object.fromEntries(MANDATE_MODES);
const MANDATE_SPLITS = [["MODE", "Mode"], ["MCC", "Payee MCC"], ["PAYER_BANK", "Payer bank"], ["PAYEE_BANK", "Payee bank"], ["PAYER_HANDLE", "Paytm payer handle"], ["PAYEE", "Payee handle"]];
// Section 4 "where it fails" splits (v4 rows): non-success units of the code per key.
const MANDATE_FAIL_SPLITS = [["BANK", "Payer bank"], ["F_PAYER_HANDLE", "Paytm payer handle"], ["F_PAYEE_BANK", "Payee bank"], ["HANDLE", "Payee handle"], ["HANDLE_X_BANK", "Payee handle × bank"]];
const FAIL_SPLIT_LABEL = Object.fromEntries(MANDATE_FAIL_SPLITS);
const MANDATE_ON_DEMAND = ["F_PAYER_HANDLE", "F_PAYEE_BANK", "HANDLE_X_BANK"]; // = backend MANDATE_ON_DEMAND_DIMS
const MANDATE_CODE_TOPS = [25, 50];
const MANDATE_SPLIT_TOPS = [15, 30, 40];
// Alert thresholds: SR down vs the previous period (or vs the 14-day average for D-1), in pp;
// a failure code's share of attempts up, in pp; a split key's latest-day failures vs its average.
// Slices with fewer than MANDATE_ALERT_MIN attempts (or failures) are not flagged.
const MANDATE_ALERT_PP = { critical: 2, warning: 1 };
const MANDATE_ALERT_SHARE_PP = { critical: 1, warning: 0.3 };
const MANDATE_ALERT_SPIKE = { critical: 2, warning: 1.5 };
const MANDATE_ALERT_MIN = 1000;
const MANDATE_ALERT_MIN_FAIL = 100;
// Top N banks per code (section 3), codes per payer bank (section 5) and drivers per SR alert.
const MANDATE_TOP_DRIVERS = 3;
// Section 4b, Spikes dashboard method: a bank's / handle's rate = its failures of the code ÷ its own
// attempts; normal = median daily rate over the 14 days before D-1 (≥ 5 known days); extra =
// (rate − normal) × attempts. Keep the ones adding 90% of the extra (≤ 10, each ≥ 100 extra).
const DRIVE_NORMAL_DAYS = 14;
const DRIVE_MIN_KNOWN = 5;
const DRIVE_MIN_EXTRA = 100;
const DRIVE_CUM = 0.9;
const DRIVE_ROWS = 10;
const SIDE_LABEL = { PAYER: "Payer's bank", PAYEE: "Merchant's side", NPCI_PSP: "NPCI / PSP" };
const medianOf = (vs) => {
  const v = vs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
};
const dropLevel = (dpp) => (dpp == null ? null : dpp <= -MANDATE_ALERT_PP.critical ? "critical" : dpp <= -MANDATE_ALERT_PP.warning ? "warning" : null);
// Days before D-1 the takeaway line averages over.
const MANDATE_TAKEAWAY_DAYS = 14;
const splitKeyLabel = (dim, k) => (dim === "MODE" ? MODE_LABEL[k] || k : dim === "MCC" && mccName(k) ? `${k} · ${mccName(k)}` : k);
const ZERO_ATT = { c: 0, s: 0, f: 0 };

function MandatesView({ cached, job, range, asOf, codeInfo, onShowSql, onRun, onStop }) {
  // Deep link (APD-style): #product?tab=mandates&stage=EXECR&purpose=14&mode=04&acct=CC&code=UM3&split=PAYER_BANK&where=HANDLE
  const link = useMemo(() => new URLSearchParams(window.location.hash.split("?")[1] || ""), []);
  const [purpose, setPurpose] = useState(() => link.get("purpose") || "14");
  const [acct, setAcct] = useState(() => link.get("acct") || "all");
  const [stage, setStage] = useState(() => link.get("stage") || "CREATE");
  const [codePick, setCodePick] = useState(() => link.get("code") || null);
  const [dim, setDim] = useState(() => link.get("where") || "BANK");
  const [q, setQ] = useState("");
  const [mode, setMode] = useState(() => link.get("mode") || "all");
  const [splitDim, setSplitDim] = useState(() => link.get("split") || "MODE");
  useEffect(() => {
    // Keep the address bar bookmarkable: tab + as-of from the page, the rest from this tab's filters.
    if (window.location.hash.split("?")[0] !== "#product") return;
    const h = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const set = (k, v, dflt) => (v && v !== dflt ? h.set(k, v) : h.delete(k));
    set("stage", stage, "CREATE");
    set("purpose", purpose, "14");
    set("mode", mode, "all");
    set("acct", acct, "all");
    set("code", codePick, null);
    set("split", splitDim, "MODE");
    set("where", dim, "BANK");
    window.history.replaceState(null, "", `#product?${h.toString()}`);
  }, [stage, purpose, mode, acct, codePick, splitDim, dim]);
  const [splitPick, setSplitPick] = useState(null);
  const [codeTop, setCodeTop] = useState(MANDATE_CODE_TOPS[0]);
  const [splitTop, setSplitTop] = useState(MANDATE_SPLIT_TOPS[0]);
  const P = useMemo(() => moneyPeriods(cached, range), [cached, range]);
  const curFrom = P ? P.prev.length : 0;
  const curLabel = spanLabel(P?.cur);
  const prevLabel = spanLabel(P?.prev);
  const panel = { job, cached, onShowSql: () => onShowSql(), onRefresh: onRun, onStop };
  // "View query" per table (APD queries/tables), filled with this view's stage / purpose / dates.
  const tableSql = (file) => ({
    onShowSql: () =>
      onShowSql({
        path: `mandate/tables/${file}`,
        params: { stage, purpose: purpose === "all" ? "14" : purpose, start: P?.from || "", end: P?.to || "" },
        note: purpose === "all" ? "purpose 14 shown; the APD table takes one purpose" : `${stage} · purpose ${purpose} · ${P?.from} … ${P?.to}`,
      }),
  });
  const accts = acct === "all" ? MANDATE_ACCTS : [acct];
  const stageLabel = MANDATE_STAGES.find((s) => s.id === stage)?.label || stage;
  const acctLabel = acct === "all" ? "all payer accounts" : ACCT_LABEL[acct];
  const modeLabel = mode === "all" ? "all modes" : MODE_LABEL[mode] || mode;

  const purposes = useMemo(() => {
    const m = sumBy((cached?.rows || []).filter((r) => r.dim === "ALL"), (r) => r.purpose, ["c"]);
    return [...m.entries()].sort((a, b) => b[1].c - a[1].c).map(([p]) => p);
  }, [cached]);
  const inPurpose = (r) => purpose === "all" || r.purpose === purpose;
  const base = useMemo(() => (cached?.rows || []).filter((r) => r.dim === "ALL" && inPurpose(r) && (mode === "all" || (r.mode || "NA") === mode)), [cached, purpose, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ts|stage|acct → { c, s, f }
  const att = useMemo(() => {
    const m = new Map();
    for (const r of base) {
      const k = `${r.ts}|${r.stage}|${r.acct}`;
      let o = m.get(k);
      if (!o) m.set(k, (o = { c: 0, s: 0, f: 0 }));
      o.c += r.c;
      if (r.status === "SUCCESS") o.s += r.c;
      else if (r.status === "FAILURE") o.f += r.c;
    }
    return m;
  }, [base]);
  const tot = useCallback(
    (days, st, as) => {
      const o = { c: 0, s: 0, f: 0 };
      for (const d of days)
        for (const a of as) {
          const v = att.get(`${d}|${st}|${a}`) || ZERO_ATT;
          o.c += v.c;
          o.s += v.s;
          o.f += v.f;
        }
      return o;
    },
    [att],
  );
  const srOf = (o) => pct(o.s, o.c);

  // Section 1: every stage, current vs previous period.
  const stages = useMemo(() => {
    if (!P) return [];
    return MANDATE_STAGES.map((st) => {
      const cur = tot(P.cur, st.id, accts);
      const prev = tot(P.prev, st.id, accts);
      const sr = srOf(cur);
      const psr = srOf(prev);
      const cc = srOf(tot(P.cur, st.id, ["CC"]));
      const casa = srOf(tot(P.cur, st.id, ["CASA"]));
      return {
        id: st.id,
        label: st.label,
        ...cur,
        cChg: chg(cur.c, prev.c),
        sr,
        psr,
        dpp: sr != null && psr != null ? sr - psr : null,
        cc,
        casa,
        gap: cc != null && casa != null ? casa - cc : null,
        daily: P.chart.map((d) => srOf(tot([d], st.id, accts))),
      };
    }).filter((r) => r.c || tot(P.prev, r.id, accts).c);
  }, [P, tot, acct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Section 2: the selected stage day on day.
  const day = useMemo(() => {
    if (!P) return null;
    const cur = tot(P.cur, stage, accts);
    const prev = tot(P.prev, stage, accts);
    const acctSr = (days, a) => srOf(tot(days, stage, [a]));
    const rows = [...P.cur].reverse().map((d) => {
      const o = tot([d], stage, accts);
      return { id: d, d, ...o, o: o.c - o.s - o.f, sr: srOf(o), cc: acctSr([d], "CC"), casa: acctSr([d], "CASA"), ccN: tot([d], stage, ["CC"]).c, casaN: tot([d], stage, ["CASA"]).c };
    });
    rows.push({ id: "__total", _total: true, ...cur, o: cur.c - cur.s - cur.f, sr: srOf(cur), cc: acctSr(P.cur, "CC"), casa: acctSr(P.cur, "CASA"), ccN: tot(P.cur, stage, ["CC"]).c, casaN: tot(P.cur, stage, ["CASA"]).c });
    const shown = MANDATE_ACCTS.filter((a) => accts.includes(a) && P.chart.some((d) => tot([d], stage, [a]).c));
    const lines = shown.map((a) => ({ name: ACCT_LABEL[a], color: ACCT_COLOR[a], values: P.chart.map((d) => acctSr([d], a)) }));
    if (shown.length > 1) lines.push({ name: "All", color: "#e2e8f0", dashed: true, values: P.chart.map((d) => srOf(tot([d], stage, accts))) });
    return {
      cur,
      prev,
      sr: srOf(cur),
      psr: srOf(prev),
      cc: acctSr(P.cur, "CC"),
      pcc: acctSr(P.prev, "CC"),
      casa: acctSr(P.cur, "CASA"),
      pcasa: acctSr(P.prev, "CASA"),
      rows,
      lines,
      bars: P.chart.map((d) => tot([d], stage, accts).c),
    };
  }, [P, tot, stage, acct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Section 3: failure codes of the selected stage.
  const codes = useMemo(() => {
    if (!P || !day) return [];
    const m = new Map();
    const dayAtt = new Map(P.chart.map((d) => [d, tot([d], stage, accts).c]));
    for (const r of base) {
      if (r.stage !== stage || r.status !== "FAILURE" || !accts.includes(r.acct)) continue;
      let o = m.get(r.code);
      if (!o) m.set(r.code, (o = { code: r.code, cur: 0, prev: 0, cc: 0, casa: 0, byDay: new Map() }));
      if (P.curSet.has(r.ts)) {
        o.cur += r.c;
        if (r.acct === "CC") o.cc += r.c;
        if (r.acct === "CASA") o.casa += r.c;
      } else if (P.prevSet.has(r.ts)) o.prev += r.c;
      o.byDay.set(r.ts, (o.byDay.get(r.ts) || 0) + r.c);
    }
    return [...m.values()]
      .filter((o) => o.cur || o.prev)
      .map((o) => ({
        ...o,
        id: o.code,
        share: pct(o.cur, day.cur.c),
        ofFail: pct(o.cur, day.cur.f),
        pshare: pct(o.prev, day.prev.c),
        trend: trendOf(o.cur, o.prev),
        daily: P.chart.map((d) => pct(o.byDay.get(d) || 0, dayAtt.get(d))),
        // APD day view: the 7 newest days (D-1 first) and D-1 vs the median of the 13 days before it.
        ...(() => {
          const at = (n) => toDay(toMs(P.to) - n * DAY);
          const d7 = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`d${i}`, o.byDay.get(at(i)) || 0]));
          const med = median(Array.from({ length: 13 }, (_, i) => o.byDay.get(at(i + 1)) || 0));
          return { ...d7, med13: med, vsMed: med ? (100 * ((o.byDay.get(P.to) || 0) - med)) / med : null };
        })(),
      }))
      .sort((a, b) => b.cur - a.cur || b.prev - a.prev);
  }, [P, day, base, tot, stage, acct]); // eslint-disable-line react-hooks/exhaustive-deps
  const code = codePick && codes.some((c) => c.code === codePick) ? codePick : codes[0]?.code || null;
  // NPCI / bank description, then the app's customer message from the error-code sheet (response_mapper).
  const descOf = (c) => {
    const i = codeInfo?.[c];
    return i ? [i.npci, i.bank, i.app && `app: “${i.app}”`].filter(Boolean).join(" · ") : "";
  };
  const partyOf = (c) => codeInfo?.[c]?.party || "";
  const needle = q.trim().toLowerCase();
  const codesShown = needle ? codes.filter((r) => `${r.code} ${descOf(r.code)} ${partyOf(r.code)}`.toLowerCase().includes(needle)) : codes.slice(0, codeTop);
  const [codeView, setCodeView] = useState("trend"); // trend: sparkline · days: 7 day columns + 13-day median

  // Section 4 splits kept out of /state (payer handle, payee bank, handle × bank): fetched for the picked stage × code.
  const [odRows, setOdRows] = useState({ key: "", rows: [], loading: false });
  const onDemand = MANDATE_ON_DEMAND.includes(dim);
  useEffect(() => {
    if (!onDemand || !code) return undefined;
    const key = `${dim}|${stage}|${code}|${cached?.finishedAt || 0}|${asOf || ""}`;
    if (odRows.key === key) return undefined;
    let live = true;
    setOdRows({ key, rows: [], loading: true });
    api(`/rows?product=mandates&query=daily&dim=${dim}&stage=${stage}&code=${encodeURIComponent(code)}${asOf ? `&to=${asOf}` : ""}`)
      .then((d) => live && setOdRows({ key, rows: d.rows || [], loading: false }))
      .catch(() => live && setOdRows({ key, rows: [], loading: false }));
    return () => {
      live = false;
    };
  }, [onDemand, dim, stage, code, cached?.finishedAt, asOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // Section 4: the selected code — daily share per payer account + payer bank / payee handle split.
  const focus = useMemo(() => {
    if (!P || !code) return null;
    const byKey = new Map();
    for (const r of base) if (r.stage === stage && r.status === "FAILURE" && r.code === code) byKey.set(`${r.ts}|${r.acct}`, (byKey.get(`${r.ts}|${r.acct}`) || 0) + r.c);
    const fails = (d, as) => as.reduce((a, x) => a + (byKey.get(`${d}|${x}`) || 0), 0);
    const shown = MANDATE_ACCTS.filter((a) => accts.includes(a) && P.chart.some((d) => fails(d, [a])));
    const lines = shown.map((a) => ({ name: `${ACCT_LABEL[a]} share`, color: ACCT_COLOR[a], values: P.chart.map((d) => pct(fails(d, [a]), tot([d], stage, [a]).c)) }));
    const src = onDemand ? odRows.rows : cached?.rows || [];
    const split = src.filter((r) => r.dim === dim && inPurpose(r) && r.stage === stage && r.code === code && accts.includes(r.acct));
    const days = [...new Set((onDemand ? src : (cached?.rows || []).filter((r) => r.dim === dim)).map((r) => r.ts))].sort().reverse();
    const m = new Map();
    for (const r of split) {
      let o = m.get(r.k);
      if (!o) m.set(r.k, (o = { id: r.k, k: r.k, total: 0 }));
      o[r.ts] = (o[r.ts] || 0) + r.c;
      o.total += r.c;
    }
    const all = [...m.values()].reduce((a, o) => a + o.total, 0);
    const rows = [...m.values()].map((o) => ({ ...o, share: pct(o.total, all) })).sort((a, b) => (a.k === "Other") - (b.k === "Other") || b.total - a.total);
    return { lines, bars: P.chart.map((d) => fails(d, accts)), days, rows };
  }, [P, code, base, cached, stage, dim, tot, acct, purpose, onDemand, odRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Section 4b: what is driving the selected code on D-1 (Spikes method), and which leg responded.
  const drive = useMemo(() => {
    if (!P || !code) return null;
    const d1 = P.cur[P.cur.length - 1];
    const keep = (r) => r.stage === stage && inPurpose(r) && accts.includes(r.acct);
    // Which leg carries the response code: D-1, else the newest 7 days with data.
    const sideBy = new Map(); // ts → side → n
    for (const r of cached?.rows || []) {
      if (r.dim !== "SIDE" || r.code !== code || !keep(r)) continue;
      if (!sideBy.has(r.ts)) sideBy.set(r.ts, new Map());
      sideBy.get(r.ts).set(r.k, (sideBy.get(r.ts).get(r.k) || 0) + r.c);
    }
    const sideOf = (days) => {
      const m = new Map();
      for (const d of days) for (const [k, n] of sideBy.get(d) || []) m.set(k, (m.get(k) || 0) + n);
      const t = [...m.values()].reduce((a, n) => a + n, 0);
      return t ? [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, share: pct(n, t) })) : null;
    };
    const sideDays = [...sideBy.keys()].sort();
    const side = sideOf([d1]) || sideOf(sideDays.slice(-7));
    const sideOnD1 = !!sideOf([d1]);
    const payeeLed = (side?.find((o) => o.k === "PAYEE")?.share || 0) > 50;
    const failDim = payeeLed ? "HANDLE" : "BANK";
    const attDim = payeeLed ? "PAYEE" : "PAYER_BANK";
    const F = new Map(); // key → ts → failures
    const splitDays = new Set(); // days the code has a split at all
    const att = new Map(); // `${ts}|${key}` → attempts
    for (const r of cached?.rows || []) {
      if (!keep(r)) continue;
      if (r.dim === failDim && r.code === code && r.status === "FAILURE") {
        splitDays.add(r.ts);
        if (!F.has(r.k)) F.set(r.k, new Map());
        F.get(r.k).set(r.ts, (F.get(r.k).get(r.ts) || 0) + r.c);
      } else if (r.dim === attDim) att.set(`${r.ts}|${r.k}`, (att.get(`${r.ts}|${r.k}`) || 0) + r.c);
    }
    const other = F.get("Other") || new Map();
    const prior = Array.from({ length: DRIVE_NORMAL_DAYS }, (_, i) => toDay(toMs(d1) - (i + 1) * DAY));
    // A day where this key is missing but Other has failures is unknown (it fell out of the top 10),
    // not zero; a day with no split for the code at all is unknown too.
    const normal = (k, h) => {
      const v = [];
      for (const d of prior) {
        const a = att.get(`${d}|${k}`);
        if (!a || !splitDays.has(d)) continue;
        if (h.has(d)) v.push(h.get(d) / a);
        else if (!other.get(d)) v.push(0);
      }
      return v.length >= DRIVE_MIN_KNOWN ? medianOf(v) : null;
    };
    const res = [];
    for (const [k, h] of F) {
      if (k === "Other" || k === "(unknown)") continue;
      const n = h.get(d1) || 0;
      const a = att.get(`${d1}|${k}`);
      if (!a) continue;
      const base = normal(k, h);
      const rate = n / a;
      res.push({ id: k, k, n, att: a, rate, base, extra: base == null ? null : (rate - base) * a });
    }
    const pos = res.filter((r) => r.extra > 0).sort((a, b) => b.extra - a.extra);
    const total = pos.reduce((a, r) => a + r.extra, 0);
    const rows = [];
    let cum = 0;
    for (const r of pos) {
      if (total && cum >= DRIVE_CUM * total) break;
      if (r.extra < DRIVE_MIN_EXTRA) break;
      rows.push(r);
      cum += r.extra;
    }
    const spread = !rows.length;
    const shown = spread ? res.filter((r) => r.n > 0).sort((a, b) => b.n - a.n).slice(0, DRIVE_ROWS) : rows.slice(0, DRIVE_ROWS);
    const tot = spread ? shown.reduce((a, r) => a + Math.max(0, r.extra || 0), 0) || 1 : total;
    return { d1, side, sideOnD1, payeeLed, hasSplit: splitDays.has(d1), spread, rows: shown.map((r) => ({ ...r, shareExtra: pct(Math.max(0, r.extra || 0), tot) })) };
  }, [P, code, cached, stage, acct, purpose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Takeaway: D-1 (last day of the range) vs the average of the days before it.
  const take = useMemo(() => {
    if (!P) return null;
    const d1 = P.cur[P.cur.length - 1];
    const days = [...new Set(base.map((r) => r.ts))].sort().filter((d) => d < d1);
    const prior = days.slice(-MANDATE_TAKEAWAY_DAYS);
    const y = tot([d1], stage, accts);
    if (!y.c) return null;
    const fails = new Map();
    for (const r of base) if (r.ts === d1 && r.stage === stage && r.status === "FAILURE" && accts.includes(r.acct)) fails.set(r.code, (fails.get(r.code) || 0) + r.c);
    const [top, topN] = [...fails.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const sr = srOf(y);
    const avg = prior.length ? srOf(tot(prior, stage, accts)) : null;
    return { d1, prior, n: prior.length, c: y.c, sr, avg, dpp: sr != null && avg != null ? sr - avg : null, top, topN, topShare: pct(topN, y.f) };
  }, [P, base, tot, stage, acct]); // eslint-disable-line react-hooks/exhaustive-deps

  // Failures by payer bank × code (dim BANK: newest 14 days, codes with ≥ 50 failures a day, top 10
  // banks each) and SR by payer bank (dim PAYER_BANK) for the selected stage — feeds the top banks
  // per code (section 3), top codes per bank (section 5) and the "why" of SR alerts (section 2).
  const drivers = useMemo(() => {
    const fail = new Map(); // ts → code → bank → n
    const bankSr = new Map(); // ts → bank → { c, s }
    const bankDays = new Set();
    for (const r of cached?.rows || []) {
      if (r.stage !== stage || !inPurpose(r) || !accts.includes(r.acct)) continue;
      if (r.dim === "BANK" && r.status === "FAILURE") {
        bankDays.add(r.ts);
        let byCode = fail.get(r.ts);
        if (!byCode) fail.set(r.ts, (byCode = new Map()));
        let byBank = byCode.get(r.code);
        if (!byBank) byCode.set(r.code, (byBank = new Map()));
        byBank.set(r.k, (byBank.get(r.k) || 0) + r.c);
      } else if (r.dim === "PAYER_BANK") {
        let byBank = bankSr.get(r.ts);
        if (!byBank) bankSr.set(r.ts, (byBank = new Map()));
        let o = byBank.get(r.k);
        if (!o) byBank.set(r.k, (o = { c: 0, s: 0 }));
        o.c += r.c;
        if (r.status === "SUCCESS") o.s += r.c;
      }
    }
    // code → bank → n, and bank → code → n, over days
    const pairs = (days) => {
      const byCode = new Map();
      const byBank = new Map();
      for (const d of days)
        for (const [c, banks] of fail.get(d) || [])
          for (const [b, n] of banks) {
            if (b === "Other") continue;
            if (!byCode.has(c)) byCode.set(c, new Map());
            byCode.get(c).set(b, (byCode.get(c).get(b) || 0) + n);
            if (!byBank.has(b)) byBank.set(b, new Map());
            byBank.get(b).set(c, (byBank.get(b).get(c) || 0) + n);
          }
      return { byCode, byBank };
    };
    const top = (m) => [...(m || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, MANDATE_TOP_DRIVERS).map(([k, n]) => ({ k, n }));
    const cur = pairs(P?.cur || []);
    return {
      covered: (P?.cur || []).filter((d) => bankDays.has(d)).length,
      banksOf: (c) => top(cur.byCode.get(c)),
      codesOf: (b) => top(cur.byBank.get(b)),
      // Why day d is low vs base days: codes whose share of attempts rose most (excess failures)
      // and payer banks whose SR fell most (excess failures = day attempts × SR drop).
      why: (d, baseDays) => {
        const att = (days) => tot(days, stage, accts).c;
        const codeFails = (days) => {
          const m = new Map();
          for (const r of base) if (days.includes(r.ts) && r.stage === stage && r.status === "FAILURE" && accts.includes(r.acct)) m.set(r.code, (m.get(r.code) || 0) + r.c);
          return m;
        };
        const dAtt = att([d]);
        const bAtt = att(baseDays);
        const dF = codeFails([d]);
        const bF = codeFails(baseDays);
        const codes = [...dF.entries()]
          .map(([c, n]) => {
            const rate = pct(n, dAtt);
            const bRate = pct(bF.get(c) || 0, bAtt) || 0;
            return { k: c, n, rate, dpp: rate - bRate, excess: n - (dAtt * bRate) / 100 };
          })
          .filter((o) => o.excess > 0)
          .sort((a, b) => b.excess - a.excess)
          .slice(0, MANDATE_TOP_DRIVERS);
        const sumBank = (days) => {
          const m = new Map();
          for (const day of days)
            for (const [b, o] of bankSr.get(day) || []) {
              const x = m.get(b) || { c: 0, s: 0 };
              m.set(b, { c: x.c + o.c, s: x.s + o.s });
            }
          return m;
        };
        const bB = sumBank(baseDays);
        const banks = [...sumBank([d]).entries()]
          .filter(([b]) => b !== "Other" && bB.get(b)?.c)
          .map(([b, o]) => {
            const sr = pct(o.s, o.c);
            const bsr = pct(bB.get(b).s, bB.get(b).c);
            return { k: b, c: o.c, sr, bsr, excess: (o.c * (bsr - sr)) / 100 };
          })
          .filter((o) => o.excess > 0)
          .sort((a, b) => b.excess - a.excess)
          .slice(0, MANDATE_TOP_DRIVERS);
        return { codes, banks };
      },
    };
  }, [cached, base, P, tot, stage, acct, purpose]); // eslint-disable-line react-hooks/exhaustive-deps
  const priorDays = (d) => [...new Set(base.map((r) => r.ts))].sort().filter((x) => x < d).slice(-MANDATE_TAKEAWAY_DAYS);
  const whyDetail = (d, baseDays) => {
    const w = drivers.why(d, baseDays);
    const pp = (v) => fmtSigned(v, " pp", 2);
    const out = [];
    if (w.codes.length) out.push(`Why · codes up: ${w.codes.map((o) => `${o.k}${descOf(o.k) ? ` (${descOf(o.k).split(" · ").pop()})` : ""} ${fmtNum(o.n)}, ${pp(o.dpp)} of attempts, ~${fmtNum(Math.round(o.excess))} extra`).join(" · ")}`);
    if (w.banks.length) out.push(`Why · payer banks down: ${w.banks.map((o) => `${o.k} SR ${fmtPct(o.sr, 2)} vs ${fmtPct(o.bsr, 2)} (${pp(o.sr - o.bsr)}, ~${fmtNum(Math.round(o.excess))} extra failures)`).join(" · ")}`);
    if (!out.length) out.push("Why · no single code or payer bank stands out vs the baseline.");
    return out;
  };

  // Section 5: the selected stage split by mode / payee MCC / payer bank / payee handle.
  const split = useMemo(() => {
    if (!P) return [];
    const byMode = splitDim === "MODE";
    const m = new Map(); // k → ts → { c, s }
    for (const r of cached?.rows || []) {
      if (r.dim !== (byMode ? "ALL" : splitDim) || r.stage !== stage || !inPurpose(r) || !accts.includes(r.acct)) continue;
      // v4 split rows carry the mode too, so the Mode filter applies to every split except Mode itself.
      if (!byMode && mode !== "all" && (r.mode || "NA") !== mode) continue;
      const k = byMode ? r.mode || "NA" : r.k;
      let byDay = m.get(k);
      if (!byDay) m.set(k, (byDay = new Map()));
      let o = byDay.get(r.ts);
      if (!o) byDay.set(r.ts, (o = { c: 0, s: 0, f: 0 }));
      o.c += r.c;
      if (r.status === "SUCCESS") o.s += r.c;
      else if (r.status === "FAILURE") o.f += r.c;
    }
    const sum = (byDay, days) => days.reduce((a, d) => { const o = byDay.get(d); if (o) { a.c += o.c; a.s += o.s; a.f += o.f; } return a; }, { c: 0, s: 0, f: 0 });
    const rows = [...m.entries()].map(([k, byDay]) => {
      const cur = sum(byDay, P.cur);
      const prev = sum(byDay, P.prev);
      const sr = pct(cur.s, cur.c);
      const psr = pct(prev.s, prev.c);
      return { id: k, k, byDay, c: cur.c, f: cur.c - cur.s, ff: cur.f, pc: prev.c, sr, psr, dpp: sr != null && psr != null ? sr - psr : null, daily: P.chart.map((d) => { const o = byDay.get(d); return o ? pct(o.s, o.c) : null; }) };
    }).filter((r) => r.c || r.pc);
    const all = rows.reduce((a, r) => a + r.c, 0);
    return rows.map((r) => ({ ...r, share: pct(r.c, all) })).sort((a, b) => (a.k === "Other") - (b.k === "Other") || b.c - a.c).slice(0, splitTop);
  }, [P, cached, splitDim, splitTop, stage, acct, purpose]); // eslint-disable-line react-hooks/exhaustive-deps
  const pickRow = splitPick && splitPick.dim === splitDim ? split.find((r) => r.k === splitPick.k) : null;
  const [splitQ, setSplitQ] = useState("");
  const [splitView, setSplitView] = useState("period"); // period · days (APD: D-1 … D-14 columns + 13-day median)
  const [splitMeasure, setSplitMeasure] = useState("SR");
  const splitShown = splitQ.trim() ? split.filter((r) => splitKeyLabel(splitDim, r.k).toLowerCase().includes(splitQ.trim().toLowerCase())) : split;
  const dayLines = day && pickRow ? [...day.lines, { name: splitKeyLabel(splitDim, pickRow.k), color: "#fbbf24", values: pickRow.daily }] : day?.lines;

  // Alerts per section (thresholds: MANDATE_ALERT_*).
  const alerts = useMemo(() => {
    const out = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    const pp = (v) => fmtSigned(v, " pp", 2);
    for (const r of stages) {
      const level = r.c >= MANDATE_ALERT_MIN && dropLevel(r.dpp);
      if (level) out[1].push({ level, text: `${r.label} SR ${fmtPct(r.sr, 2)} vs ${fmtPct(r.psr, 2)} previous (${pp(r.dpp)}) on ${fmtNum(r.c)} attempts.` });
      for (const [a, v, n] of [["CC", r.cc, tot(P?.cur || [], r.id, ["CC"])], ["CASA", r.casa, tot(P?.cur || [], r.id, ["CASA"])]]) {
        if (!accts.includes(a) || n.c < MANDATE_ALERT_MIN) continue;
        const pv = srOf(tot(P?.prev || [], r.id, [a]));
        const l = dropLevel(v != null && pv != null ? v - pv : null);
        if (l) out[1].push({ level: l, text: `${r.label} ${a} SR ${fmtPct(v, 2)} vs ${fmtPct(pv, 2)} previous (${pp(v - pv)}).` });
      }
    }
    if (take && take.c >= MANDATE_ALERT_MIN) {
      const level = dropLevel(take.dpp);
      if (level) out[2].push({ level, text: `${stageLabel} SR on ${fmtDay(take.d1)} was ${fmtPct(take.sr, 2)}, ${pp(take.dpp)} vs the ${take.n}-day average ${fmtPct(take.avg, 2)}.`, detail: whyDetail(take.d1, take.prior) });
    }
    if (day) {
      for (const r of day.rows) {
        if (r._total || r.c < MANDATE_ALERT_MIN || r.sr == null || day.sr == null) continue;
        const level = dropLevel(r.sr - day.sr);
        if (level) out[2].push({ level, text: `${fmtDay(r.d)}: SR ${fmtPct(r.sr, 2)}, ${pp(r.sr - day.sr)} vs the period's ${fmtPct(day.sr, 2)}.`, detail: whyDetail(r.d, priorDays(r.d)) });
      }
    }
    for (const r of codes) {
      if (r.cur < MANDATE_ALERT_MIN_FAIL) continue;
      const rise = r.share != null ? r.share - (r.pshare || 0) : null;
      const level = rise == null ? null : rise >= MANDATE_ALERT_SHARE_PP.critical ? "critical" : rise >= MANDATE_ALERT_SHARE_PP.warning ? "warning" : r.trend.kind === "new" ? "warning" : null;
      if (level) out[3].push({ level, text: `${r.code}${descOf(r.code) ? ` (${descOf(r.code)})` : ""}: ${fmtNum(r.cur)} failures, ${fmtPct(r.share, 2)} of attempts vs ${fmtPct(r.pshare, 2)} previous${r.trend.kind === "new" ? " — new code" : ` (${pp(rise)})`}.` });
    }
    if (focus?.days.length > 1) {
      const [latest, ...older] = focus.days;
      for (const r of focus.rows) {
        if (r.k === "Other") continue;
        const now = r[latest] || 0;
        const avg = older.reduce((a, d) => a + (r[d] || 0), 0) / older.length;
        // Keys near the top-10 cut-off drop into Other on some days; their zeros are not a baseline.
        if (now < MANDATE_ALERT_MIN_FAIL / 2 || older.filter((d) => r[d]).length < older.length * 0.75) continue;
        const x = avg ? now / avg : Infinity;
        const level = x >= MANDATE_ALERT_SPIKE.critical ? "critical" : x >= MANDATE_ALERT_SPIKE.warning ? "warning" : null;
        if (level) out[4].push({ level, text: `${code} at ${r.k}: ${fmtNum(now)} failures on ${fmtDay(latest)} vs ${fmtNum(Math.round(avg))} a day before (${avg ? `${x.toFixed(1)}×` : "new"}).` });
      }
    }
    for (const r of split) {
      if (r.k === "Other" || r.c < MANDATE_ALERT_MIN) continue;
      const level = dropLevel(r.dpp);
      if (level) out[5].push({ level, text: `${splitKeyLabel(splitDim, r.k)}: SR ${fmtPct(r.sr, 2)} vs ${fmtPct(r.psr, 2)} previous (${pp(r.dpp)}) on ${fmtNum(r.c)} attempts.` });
    }
    return out;
  }, [stages, take, day, codes, focus, split, code, splitDim, stageLabel, P, tot, acct, drivers]); // eslint-disable-line react-hooks/exhaustive-deps
  const alertTotal = Object.values(alerts).flat();

  const srTd = (v, ref) => <b style={{ color: srTone(v, ref) }}>{fmtPct(v, 2)}</b>;
  const stageCols = [
    { key: "label", label: "Stage", align: "left", render: (r) => <span>{r.id === stage && <span style={{ color: C.accent }}>● </span>}{r.label}</span>, text: (r) => r.label },
    { key: "c", label: "Attempts", title: curLabel, render: (r) => fmtNum(r.c) },
    { key: "cChg", label: "vs Prev", title: `Attempts vs ${prevLabel}`, render: (r) => fmtSigned(r.cChg, "%", 0) },
    { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
    { key: "sr", label: "SR", title: curLabel, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp), fontWeight: Math.abs(r.dpp || 0) >= 1 ? 700 : 400 }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "cc", label: "CC SR", render: (r) => fmtPct(r.cc, 2) },
    { key: "casa", label: "CASA SR", render: (r) => fmtPct(r.casa, 2) },
    { key: "gap", label: "CASA − CC", title: "CASA SR minus CC SR, percentage points", render: (r) => fmtSigned(r.gap, " pp", 2) },
    { key: "daily", label: "Daily SR", title: `${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={ppToneOf(r.dpp) === C.text2 ? "#94a3b8" : ppToneOf(r.dpp)} curFrom={curFrom} />, text: () => "" },
  ];
  const dayCols = [
    { key: "d", label: "Date", align: "left", render: (r) => (r._total ? "Total" : fmtDay(r.d)), text: (r) => (r._total ? "Total" : r.d) },
    { key: "c", label: "Attempts", render: (r) => fmtNum(r.c) },
    { key: "s", label: "Success", render: (r) => fmtNum(r.s) },
    { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
    { key: "o", label: "Pending", render: (r) => fmtNum(r.o) },
    { key: "sr", label: "SR", render: (r) => (r._total ? <b>{fmtPct(r.sr, 2)}</b> : srTd(r.sr, day?.sr)), text: (r) => fmtPct(r.sr, 2) },
    { key: "ccN", label: "CC attempts", render: (r) => fmtNum(r.ccN) },
    { key: "cc", label: "CC SR", render: (r) => (r._total ? fmtPct(r.cc, 2) : srTd(r.cc, day?.cc)), text: (r) => fmtPct(r.cc, 2) },
    { key: "casaN", label: "CASA attempts", render: (r) => fmtNum(r.casaN) },
    { key: "casa", label: "CASA SR", render: (r) => (r._total ? fmtPct(r.casa, 2) : srTd(r.casa, day?.casa)), text: (r) => fmtPct(r.casa, 2) },
  ];
  const codeCols = [
    {
      key: "code",
      label: "Code · description",
      align: "left",
      wrap: true,
      render: (r) => (
        <div style={{ minWidth: 220, maxWidth: 380 }}>
          {r.code === code && <span style={{ color: C.accent }}>● </span>}
          <code style={{ fontSize: 12, fontWeight: 700 }}>{r.code}</code>
          {descOf(r.code) && <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.35 }}>{descOf(r.code)}</div>}
        </div>
      ),
      text: (r) => `${r.code} ${descOf(r.code)}`,
    },
    {
      key: "party",
      label: "Party",
      align: "left",
      title: "Which side the code points to (APD rules) · TD = technical decline, BD = business decline",
      sortValue: (r) => partyOf(r.code),
      render: (r) => {
        const i = codeInfo?.[r.code];
        return (
          <span title={i?.partyWhy || ""} style={{ fontSize: 11 }}>
            {i?.party || "—"}
            {i?.type && <span style={{ marginLeft: 4, padding: "0 4px", borderRadius: 4, border: `1px solid ${C.border}`, color: i.type === "TD" ? C.warn : C.text2 }}>{i.type}</span>}
          </span>
        );
      },
      text: (r) => `${partyOf(r.code)}${codeInfo?.[r.code]?.type ? ` (${codeInfo[r.code].type})` : ""}`,
    },
    { key: "cur", label: "Failed", title: curLabel, render: (r) => <b>{fmtNum(r.cur)}</b>, text: (r) => String(r.cur) },
    { key: "share", label: "% of attempts", title: `Failures ÷ ${stageLabel} attempts, ${curLabel}`, render: (r) => fmtPct(r.share, 2) },
    { key: "pshare", label: "Prev %", title: prevLabel, render: (r) => fmtPct(r.pshare, 2) },
    { key: "ofFail", label: "% of failures", render: (r) => fmtPct(r.ofFail) },
    {
      key: "banks",
      label: `Top ${MANDATE_TOP_DRIVERS} payer banks`,
      align: "left",
      wrap: true,
      title: `Payer banks with the most failures of this code, ${curLabel} (from the per-code bank split: newest 14 days, days with ≥ 50 failures of the code)`,
      render: (r) => {
        const b = drivers.banksOf(r.code);
        return b.length ? (
          <div style={{ minWidth: 170, fontSize: 11, lineHeight: 1.4 }}>
            {b.map((o) => (
              <div key={o.k}>
                <code>{o.k}</code> {fmtNum(o.n)} <span style={{ color: C.muted }}>({fmtPct(pct(o.n, r.cur))})</span>
              </div>
            ))}
          </div>
        ) : (
          <span style={{ color: C.muted, fontSize: 11 }}>—</span>
        );
      },
      text: (r) => drivers.banksOf(r.code).map((o) => `${o.k} ${o.n}`).join("; "),
    },
    { key: "trend", label: "vs Prev", title: `Failed count vs ${prevLabel}; ±${TREND_PCT}% flagged`, render: (r) => <TrendBadge t={r.trend} />, text: (r) => (r.trend.kind === "new" ? "NEW" : fmtSigned(r.trend.pct, "%", 0)) },
    ...(codeView === "days" && P
      ? [
          ...Array.from({ length: 7 }, (_, i) => {
            const d = toDay(toMs(P.to) - i * DAY);
            return { key: `d${i}`, label: i === 0 ? `${fmtDay(d)} (D-1)` : fmtDay(d), title: `Failures on ${d}`, render: (r) => <span style={{ fontWeight: i === 0 ? 700 : 400 }}>{fmtNum(r[`d${i}`])}</span>, text: (r) => String(r[`d${i}`]) };
          }),
          { key: "med13", label: "13-day median", title: "Median daily failures over the 13 days before the latest day", render: (r) => fmtNum(r.med13) },
          {
            key: "vsMed",
            label: "Latest vs median",
            render: (r) => <span style={{ color: ppToneOf(r.vsMed == null ? null : -r.vsMed), fontWeight: Math.abs(r.vsMed || 0) >= 50 ? 700 : 400 }}>{r.vsMed == null ? (r.d0 ? "NEW" : "—") : fmtSigned(r.vsMed, "%", 0)}</span>,
            text: (r) => (r.vsMed == null ? "" : fmtSigned(r.vsMed, "%", 0)),
          },
        ]
      : [{ key: "daily", label: "Daily % of attempts", noSort: true, title: `${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="% of attempts" unit="pct" upIsBad color={r.trend.kind === "up" || r.trend.kind === "new" ? C.bad : r.trend.kind === "down" ? C.good : "#94a3b8"} curFrom={curFrom} />, text: () => "" }]),
    ...(acct === "all"
      ? [
          { key: "cc", label: "CC", title: `CC failures, ${curLabel}`, render: (r) => fmtNum(r.cc) },
          { key: "casa", label: "CASA", title: `CASA failures, ${curLabel}`, render: (r) => fmtNum(r.casa) },
        ]
      : []),
  ];
  const splitDimLabel = MANDATE_SPLITS.find(([k]) => k === splitDim)?.[1] || splitDim;
  const srSplitCols = [
    { key: "k", label: splitDimLabel, align: "left", render: (r) => <span>{pickRow?.k === r.k && <span style={{ color: "#fbbf24" }}>● </span>}<code style={{ fontSize: 12 }}>{splitKeyLabel(splitDim, r.k)}</code></span>, text: (r) => splitKeyLabel(splitDim, r.k) },
    { key: "c", label: "Attempts", title: curLabel, render: (r) => fmtNum(r.c) },
    { key: "share", label: "Share", title: `Share of ${stageLabel} attempts, ${curLabel}`, render: (r) => fmtPct(r.share) },
    { key: "f", label: "Not success", render: (r) => fmtNum(r.f) },
    { key: "sr", label: "SR", title: curLabel, render: (r) => srTd(r.sr, day?.sr), text: (r) => fmtPct(r.sr, 2) },
    { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr, 2) },
    { key: "dpp", label: "Δ pp", render: (r) => <span style={{ color: ppToneOf(r.dpp), fontWeight: Math.abs(r.dpp || 0) >= 1 ? 700 : 400 }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    ...(splitView === "days" && P
      ? (() => {
          const at = (n) => toDay(toMs(P.to) - n * DAY);
          const val = (r, d) => {
            const o = r.byDay.get(d);
            if (!o) return null;
            return splitMeasure === "SR" ? pct(o.s, o.c) : splitMeasure === "ATT" ? o.c : splitMeasure === "SUC" ? o.s : o.c - o.s;
          };
          const fmt = (v) => (splitMeasure === "SR" ? fmtPct(v, 2) : fmtNum(v));
          const med = (r) => median(Array.from({ length: 13 }, (_, i) => val(r, at(i + 1))));
          return [
            ...Array.from({ length: 14 }, (_, i) => ({
              key: `d${i}`,
              label: i === 0 ? `${fmtDay(at(0))} (D-1)` : `D-${i + 1}`,
              title: at(i),
              sortValue: (r) => val(r, at(i)),
              render: (r) => {
                const v = val(r, at(i));
                const m = med(r);
                const low = splitMeasure === "SR" && i === 0 && v != null && m != null && v < m - LOW_SR_PP;
                return <span style={{ color: low ? C.bad : C.text, fontWeight: i === 0 || low ? 700 : 400 }}>{fmt(v)}</span>;
              },
              text: (r) => (val(r, at(i)) == null ? "" : String(val(r, at(i)))),
            })),
            { key: "med13", label: "13-day median", title: "Median of the 13 days before D-1", sortValue: med, render: (r) => fmt(med(r)), text: (r) => String(med(r) ?? "") },
            {
              key: "vsMed",
              label: "D-1 vs median",
              sortValue: (r) => (val(r, at(0)) == null || med(r) == null ? null : val(r, at(0)) - med(r)),
              render: (r) => {
                const v = val(r, at(0));
                const m = med(r);
                if (v == null || m == null) return "—";
                return splitMeasure === "SR" ? <span style={{ color: ppToneOf(v - m) }}>{fmtSigned(v - m, " pp", 2)}</span> : <span style={{ color: ppToneOf(m ? -((v - m) / m) : null) }}>{fmtSigned(m ? (100 * (v - m)) / m : null, "%", 0)}</span>;
              },
              text: () => "",
            },
          ];
        })()
      : [{ key: "daily", label: "Daily SR", noSort: true, title: `${prevLabel} → ${curLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={ppToneOf(r.dpp) === C.text2 ? "#94a3b8" : ppToneOf(r.dpp)} curFrom={curFrom} />, text: () => "" }]),
    ...(splitDim === "PAYER_BANK"
      ? [
          {
            key: "codes",
            label: `Top ${MANDATE_TOP_DRIVERS} failure codes`,
            align: "left",
            wrap: true,
            title: `This bank's most frequent failure codes, ${curLabel}; % = share of the bank's failed attempts (from the per-code bank split: newest 14 days, codes with ≥ 50 failures a day where the bank is in that code's top 10)`,
            render: (r) => {
              const c = r.k === "Other" ? [] : drivers.codesOf(r.k);
              return c.length ? (
                <div style={{ minWidth: 200, fontSize: 11, lineHeight: 1.4 }}>
                  {c.map((o) => (
                    <div key={o.k} title={descOf(o.k)}>
                      <code style={{ fontWeight: 700 }}>{o.k}</code> {fmtNum(o.n)} <span style={{ color: C.muted }}>({fmtPct(pct(o.n, r.ff))})</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ color: C.muted, fontSize: 11 }}>—</span>
              );
            },
            text: (r) => (r.k === "Other" ? "" : drivers.codesOf(r.k).map((o) => `${o.k} ${o.n}`).join("; ")),
          },
        ]
      : []),
  ];
  const splitCols = focus
    ? [
        { key: "k", label: dim === "BANK" ? "Payer bank" : "Payee handle", align: "left", render: (r) => <code style={{ fontSize: 12 }}>{r.k}</code>, text: (r) => r.k },
        ...focus.days.map((d, i) => ({ key: d, label: i === 0 ? `${fmtDay(d)} (latest)` : fmtDay(d), render: (r) => (i === 0 ? <b>{fmtNum(r[d] || 0)}</b> : fmtNum(r[d] || 0)), text: (r) => String(r[d] || 0) })),
        { key: "total", label: `${focus.days.length}d total`, render: (r) => fmtNum(r.total) },
        { key: "share", label: "Share", title: "Share of this code's failures in the split days", render: (r) => fmtPct(r.share) },
      ]
    : [];

  const purposeOpts = [...purposes.map((p) => [p, PURPOSE_LABEL[p] || p]), ["all", "All"]];
  const pp = (a, b, dp = 2) => (a != null && b != null ? `${fmtSigned(a - b, " pp", dp)} vs prev` : "vs prev —");
  const filters = (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
      <Pills label="Purpose" value={purpose} options={purposeOpts.length > 1 ? purposeOpts : [["14", PURPOSE_LABEL[14]], ["all", "All"]]} onChange={setPurpose} />
      <Pills label="Payer account" value={acct} options={[["all", "All"], ...MANDATE_ACCTS.map((a) => [a, ACCT_LABEL[a]])]} onChange={setAcct} />
      <Pills label="Mode" value={mode} options={[["all", "All"], ...MANDATE_MODES]} onChange={setMode} />
      <Pills
        label="Stage"
        value={stage}
        options={MANDATE_STAGES.map((s) => [s.id, s.label])}
        onChange={(s) => {
          setStage(s);
          setCodePick(null);
          setSplitPick(null);
        }}
      />
    </div>
  );
  const takeaway = take && (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, padding: "12px 16px", fontSize: 14, lineHeight: 1.5, color: C.text }}>
      <b>{stageLabel}</b> SR (purpose {purpose === "all" ? "all" : PURPOSE_LABEL[purpose] || purpose}, {acctLabel}, {modeLabel}) on <b>{fmtDay(take.d1)}</b> was <b>{fmtPct(take.sr, 2)}</b> on {fmtNum(take.c)} attempts
      {take.avg != null ? (
        <>
          , against the {take.n}-day average of <b>{fmtPct(take.avg, 2)}</b> (<span style={{ color: ppToneOf(take.dpp), fontWeight: 700 }}>{fmtSigned(take.dpp, " pp", 2)}</span>)
        </>
      ) : null}
      .{take.top && (
        <>
          {" "}Biggest failure code: <code style={{ fontWeight: 700 }}>{take.top}</code> ({fmtNum(take.topN)}, {fmtPct(take.topShare)} of failures){descOf(take.top) ? ` · ${descOf(take.top)}` : ""}.
        </>
      )}
    </div>
  );

  return (
    <>
      {filters}
      {takeaway}
      {alertTotal.length > 0 && (
        <div style={{ background: C.card, border: `1px solid ${alertTotal.some((a) => a.level === "critical") ? ALERT_COLOR.critical : ALERT_COLOR.warning}`, borderRadius: 10, marginBottom: 16, padding: "10px 16px", fontSize: 13, color: C.text, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center" }}>
          <b>Alerts</b>
          <AlertCount alerts={alertTotal} />
          <span style={{ color: C.muted, fontSize: 12 }}>
            {Object.entries(alerts).filter(([, a]) => a.length).map(([n, a]) => `§${n}: ${a.length}`).join(" · ")} — SR down ≥ {MANDATE_ALERT_PP.warning} pp warning / ≥ {MANDATE_ALERT_PP.critical} pp critical; code share up ≥ {MANDATE_ALERT_SHARE_PP.warning} / {MANDATE_ALERT_SHARE_PP.critical} pp; split failures ≥ {MANDATE_ALERT_SPIKE.warning}× / {MANDATE_ALERT_SPIKE.critical}× their average.
          </span>
        </div>
      )}
      <Section
        n={1}
        alerts={alerts[1]}
        title="Success rate by mandate stage"
        desc={`Purpose ${purpose === "all" ? "all" : purpose} · ${acctLabel} · current ${curLabel} vs previous ${prevLabel}. SR = successful ÷ all attempts. Mode: ${modeLabel}. Golden mandate unit (= Automatic Payments Dashboard): Paytm-app UMNs (UMN handle paytm / ptaxis / pthdfc / ptsbi / ptyes); Create / Revoke / Pause / Unpause once per UMN per day, executions once per UMN + execution number per day; latest status. CC = payer account on a credit card, CASA = savings / current. Click a stage to drill in.`}
        {...panel}
        {...tableSql("01_daily_sr.sql")}
        cols={stageCols}
        rows={stages.map((r) => ({ ...r, _active: r.id === stage, _onClick: () => {
          setStage(r.id);
          setCodePick(null);
        } }))}
      />
      <Section
        n={2}
        alerts={alerts[2]}
        title={`${stageLabel} success rate, day on day`}
        desc={`Daily SR by payer account (${acctLabel}, ${modeLabel}); bars = attempts. Red = day SR more than ${LOW_SR_PP} pp below the period SR. Click a row in section 5 to add it here as a yellow line.`}
        {...panel}
        {...tableSql("01_daily_sr.sql")}
        tableToggle
        kpis={
          day && (
            <>
              <Kpi label="Attempts" value={fmtNum(day.cur.c)} sub={`${fmtSigned(chg(day.cur.c, day.prev.c), "%")} vs prev`} />
              <Kpi label="Success rate" value={fmtPct(day.sr, 2)} sub={pp(day.sr, day.psr)} color={day.psr != null && day.sr < day.psr - 0.5 ? C.bad : undefined} />
              <Kpi label="Failed" value={fmtNum(day.cur.f)} sub={`${fmtSigned(chg(day.cur.f, day.prev.f), "%")} vs prev`} />
              <Kpi label="CC SR" value={fmtPct(day.cc, 2)} sub={pp(day.cc, day.pcc)} color={ACCT_COLOR.CC} />
              <Kpi label="CASA SR" value={fmtPct(day.casa, 2)} sub={pp(day.casa, day.pcasa)} color={ACCT_COLOR.CASA} />
            </>
          )
        }
        chart={day && P && <TrendChart days={P.chart} lines={dayLines} bars={{ name: "Attempts", values: day.bars }} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        cols={dayCols}
        rows={day && day.cur.c + day.prev.c ? day.rows : []}
      />
      <Section
        n={3}
        alerts={alerts[3]}
        title={`${stageLabel} failure codes`}
        desc={`Code = NPCI response code, else the app code; description from docs/UPI_Error_Response_Code_Reference.md. % of attempts = failures ÷ ${stageLabel} attempts (${acctLabel}). ${needle ? "" : `Top ${codeTop} by failures; search to see the rest.`} Top payer banks come from the per-code bank split (newest 14 days, codes with ≥ 50 failures a day)${drivers.covered < (P?.cur.length || 0) ? ` — it covers ${drivers.covered} of the ${P.cur.length} days in range` : ""}. Click a code for its trend and where it fails.`}
        {...panel}
        {...tableSql("05_failure_codes.sql")}
        controls={
          <>
            <Pills label="Show" value={codeTop} options={MANDATE_CODE_TOPS.map((t) => [t, `Top ${t}`])} onChange={setCodeTop} />
            <Pills label="Columns" value={codeView} options={[["trend", "Trend"], ["days", "Days + median"]]} onChange={setCodeView} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a code or its description…" style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: "5px 9px", width: 260 }} />
          </>
        }
        cols={codeCols}
        rows={codesShown.map((r) => ({ ...r, _active: r.code === code, _onClick: () => setCodePick(r.code) }))}
        tableMaxHeight={560}
        emptyText={cached ? "No failures for this stage in the selected period." : undefined}
      />
      <Section
        n={4}
        alerts={alerts[4]}
        title={code ? `${code} · ${stageLabel} — trend and where it fails` : "Where the code fails"}
        desc={`Lines = the code's failures ÷ ${stageLabel} attempts per day, per payer account; bars = failures. Table = non-success units by ${(FAIL_SPLIT_LABEL[dim] || dim).toLowerCase()} for the newest ${focus?.days.length || 15} days — kept only for codes with at least 20 that day; top 20 a day ranked across all payer accounts, the rest as Other.${dim === "HANDLE_X_BANK" ? " Key = payee handle | payee bank (the Spikes dashboard deep dive)." : ""}`}
        {...panel}
        {...tableSql("06_failure_code_drilldown.sql")}
        controls={<Pills label="Split by" value={dim} options={MANDATE_FAIL_SPLITS} onChange={setDim} />}
        chart={focus && P && <TrendChart days={P.chart} lines={focus.lines} bars={{ name: "Failures", values: focus.bars }} curFrom={curFrom} yFmt={(v) => fmtPct(v, 2)} />}
        cols={splitCols}
        rows={focus?.rows.length ? focus.rows : focus ? [{ id: "__none", k: "no split kept for this code (under 20 a day, or older than 15 days)", total: 0, share: null }] : []}
        emptyText={cached ? "Pick a failure code in section 3." : undefined}
      />
      <Section
        n="4b"
        title={code && drive ? `What is driving ${code} · ${stageLabel} on ${fmtDay(drive.d1)}` : "What is driving the code"}
        desc={`Spikes dashboard method. ${drive?.payeeLed ? "Most of this code's responses come from the merchant's side, so it is split by payee handle" : "Split by payer bank"} (purpose ${purpose === "all" ? "all" : purpose}, ${acctLabel}). Rate = the code's failures ÷ that ${drive?.payeeLed ? "handle" : "bank"}'s own ${stageLabel} attempts; normal = median daily rate over the ${DRIVE_NORMAL_DAYS} days before (at least ${DRIVE_MIN_KNOWN} known days — a day it fell into Other is unknown, not zero); extra = (rate − normal) × attempts. Shown: the ones adding ${DRIVE_CUM * 100}% of the extra (up to ${DRIVE_ROWS}, each ≥ ${DRIVE_MIN_EXTRA}); if none stands out, the top ${DRIVE_ROWS} by failures. No payee handle × beneficiary bank deep dive: mandate payee legs carry no bank code.`}
        {...panel}
        {...tableSql("06_failure_code_drilldown.sql")}
        note={
          drive && (
            <span>
              {codeInfo?.[code] && (
                <span style={{ display: "block", marginBottom: 4 }}>
                  <code style={{ fontWeight: 700 }}>{code}</code>
                  {codeInfo[code].type && <span style={{ marginLeft: 6, padding: "0 5px", borderRadius: 4, border: `1px solid ${C.border}` }}>{codeInfo[code].type === "TD" ? "TD · technical decline" : "BD · business decline"}</span>}
                  {codeInfo[code].party && (
                    <span style={{ marginLeft: 6 }}>
                      <b>Party:</b> {codeInfo[code].party} — <span style={{ color: C.text2 }}>{codeInfo[code].partyWhy}</span>
                    </span>
                  )}
                </span>
              )}
              <b>Response seen on</b>{drive.sideOnD1 ? "" : " (newest 7 days with data)"}:{" "}
              {drive.side ? drive.side.map((o) => `${SIDE_LABEL[o.k] || o.k} ${fmtPct(o.share, 0)}`).join(" · ") : "not available yet — the response-leg split arrives with the next refresh"}
              {drive.spread && drive.rows.length ? " · No single bank or handle stands out; showing the top by failures." : ""}
            </span>
          )
        }
        cols={[
          { key: "k", label: drive?.payeeLed ? "Payee handle" : "Payer bank", align: "left", render: (r) => <code style={{ fontSize: 12, fontWeight: 700 }}>{r.k}</code>, text: (r) => r.k },
          { key: "n", label: `Failed · ${drive ? fmtDay(drive.d1) : "D-1"}`, render: (r) => fmtNum(r.n) },
          { key: "att", label: "Attempts", render: (r) => fmtNum(r.att) },
          { key: "rate", label: "Rate", render: (r) => <b>{fmtPct(r.rate * 100, 2)}</b>, text: (r) => fmtPct(r.rate * 100, 2) },
          { key: "base", label: "Normal rate", title: `Median daily rate, ${DRIVE_NORMAL_DAYS} days before`, render: (r) => fmtPct(r.base == null ? null : r.base * 100, 2) },
          { key: "extra", label: "Extra failures", render: (r) => <span style={{ color: r.extra > 0 ? C.bad : C.text2, fontWeight: r.extra > 0 ? 700 : 400 }}>{r.extra == null ? "—" : fmtNum(Math.round(Math.max(0, r.extra)))}</span>, text: (r) => (r.extra == null ? "" : String(Math.round(Math.max(0, r.extra)))) },
          { key: "shareExtra", label: "Share of extra", render: (r) => fmtPct(r.shareExtra) },
        ]}
        rows={drive?.rows || []}
        emptyText={!cached ? undefined : !code ? "Pick a failure code in section 3." : drive && !drive.hasSplit ? `No ${drive.payeeLed ? "payee handle" : "payer bank"} split for ${code} on ${fmtDay(drive.d1)} — it is kept for codes with ≥ 50 failures that day, newest 15 days.` : "Nothing stands out for this code."}
      />
      <Section
        n={5}
        alerts={alerts[5]}
        title={`${stageLabel} success rate by ${splitDim === "MODE" ? "mode" : splitDimLabel}`}
        desc={`Purpose ${purpose === "all" ? "all" : purpose} · ${acctLabel} · current ${curLabel} vs previous ${prevLabel}. ${splitDim === "MODE" ? "Mode = extended_info initiationMode; the Mode filter above is not applied here." : `Top keys by attempts each day (payer bank / MCC 40, payee bank 30, payer handle 20, payee handle 60), the rest as Other; the Mode filter applies.`} Top ${splitTop} rows.${splitDim === "PAYER_BANK" ? ` Top failure codes per bank come from the per-code bank split (newest 14 days; a bank shows a code where it is in that code's top 10 banks)${drivers.covered < (P?.cur.length || 0) ? `, covering ${drivers.covered} of the ${P.cur.length} days in range` : ""}.` : ""} Click a row to add it as a line in section 2.`}
        {...panel}
        {...(splitDim === "MODE" ? tableSql("02_transactions_by_mode.sql") : splitDim === "MCC" ? tableSql("03_sr_by_mcc.sql") : splitDim === "PAYER_BANK" ? tableSql("04_sr_by_payer_bank.sql") : {})}
        controls={
          <>
            <Pills label="Split by" value={splitDim} options={MANDATE_SPLITS} onChange={(d) => { setSplitDim(d); setSplitPick(null); }} />
            <Pills label="Show" value={splitTop} options={MANDATE_SPLIT_TOPS.map((t) => [t, `Top ${t}`])} onChange={setSplitTop} />
            <Pills label="Columns" value={splitView} options={[["period", "Period"], ["days", "D-1 … D-14"]]} onChange={setSplitView} />
            {splitView === "days" && <Pills label="Measure" value={splitMeasure} options={[["SR", "SR"], ["ATT", "Attempts"], ["SUC", "Success"], ["FAIL", "Not success"]]} onChange={setSplitMeasure} />}
            <input type="search" value={splitQ} onChange={(e) => setSplitQ(e.target.value)} placeholder="Search…" aria-label="Search rows" style={{ background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "3px 8px", fontSize: 12, width: 140 }} />
          </>
        }
        cols={srSplitCols}
        rows={splitShown.map((r) => ({ ...r, _active: pickRow?.k === r.k, _onClick: () => setSplitPick(pickRow?.k === r.k ? null : { dim: splitDim, k: r.k }) }))}
        tableMaxHeight={560}
        emptyText={cached ? (splitDim === "MODE" ? "No attempts for this stage in the selected period." : "No split rows yet — refresh to fetch MCC / bank / handle data.") : undefined}
      />
    </>
  );
}

/**
 * Range picker: n days ending on the anchor day (latest, or the As-of day) vs the n days before.
 * Presets 1–15 (live cache), 30 / 60 / 90 and MTD (read from the saved days), Custom from–to (sets As-of = to).
 */
const LONG_RANGES = [30, 60, 90];
function RangeBar({ value, presets, anchor, kind, onPick, saved }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const mtdN = anchor ? Number(anchor.slice(8, 10)) : 1;
  const apply = () => {
    if (!from || !to || from > to) return;
    const n = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    onPick(Math.min(n, 366), "custom", to);
    setOpen(false);
  };
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>Range</span>
      {presets.map((n) => (
        <button key={n} type="button" onClick={() => onPick(n, "n")} style={pill(kind === "n" && value === n)}>
          {n === 1 ? "1 day" : `${n} days`}
        </button>
      ))}
      {LONG_RANGES.map((n) => (
        <button key={n} type="button" onClick={() => onPick(n, "n")} style={pill(kind === "n" && value === n)} title="Read from the saved days (backfilled history)">
          {n} days
        </button>
      ))}
      <button type="button" onClick={() => onPick(mtdN, "mtd")} style={pill(kind === "mtd")} title={anchor ? `1st of the month – ${fmtDay(anchor)}, vs the ${mtdN} days before` : "Month to date"}>
        MTD
      </button>
      <button type="button" onClick={() => setOpen((o) => !o)} style={pill(kind === "custom")} title="Any from – to within the saved days">
        {kind === "custom" ? `${fmtDay(toDay(toMs(anchor) - (value - 1) * DAY))} – ${fmtDay(anchor)}` : "Custom…"}
      </button>
      {open && (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
          <input type="date" value={from} min={saved?.first || undefined} max={saved?.last || undefined} onChange={(e) => setFrom(e.target.value)} style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", fontSize: 12 }} aria-label="From" />
          –
          <input type="date" value={to} min={from || saved?.first || undefined} max={saved?.last || undefined} onChange={(e) => setTo(e.target.value)} style={{ background: "transparent", color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", fontSize: 12 }} aria-label="To" />
          <button type="button" onClick={apply} disabled={!from || !to || from > to} style={{ ...btn(true), padding: "2px 8px" }}>
            Apply
          </button>
        </span>
      )}
    </div>
  );
}

/** "As of" picker: show a tab as it stood on an earlier saved day (day files are kept, see backend dayStore.js). */
function AsOfPicker({ asOf, saved, onChange }) {
  const first = saved?.first;
  const last = saved?.last;
  const title = first ? `Saved days for this tab: ${fmtDay(first)} ${first.slice(0, 4)} – ${fmtDay(last)} ${last.slice(0, 4)}. Pick a day to see every section as of that day (read-only).` : "No saved days yet for this tab";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, border: `1px solid ${asOf ? "#6366f1" : "#334155"}`, borderRadius: 6, padding: "2px 8px" }} title={title}>
      <span style={{ color: C.muted }}>As of</span>
      <input
        type="date"
        value={asOf || last || ""}
        min={first || undefined}
        max={last || undefined}
        disabled={!first}
        onChange={(e) => onChange(e.target.value && e.target.value !== last ? e.target.value : null)}
        style={{ background: "transparent", color: C.text, border: "none", colorScheme: "dark", fontSize: 12 }}
        aria-label="Show this tab as of a saved day"
      />
      {asOf ? (
        <button type="button" onClick={() => onChange(null)} style={{ background: "none", border: "none", color: "#a5b4fc", cursor: "pointer", fontSize: 12, padding: 0 }}>
          Latest
        </button>
      ) : (
        <span style={{ color: C.muted }}>(latest)</span>
      )}
    </div>
  );
}

export default function ProductDashboard() {
  // Deep link: #product?tab=iccw (any id from PRODUCTS).
  const tabFromHash = () => {
    const q = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const t = q.get("tab");
    return PRODUCTS.some((p) => p.id === t) ? t : null;
  };
  // As-of view: #product?tab=mandates&asof=2026-10-31 shows the saved days up to that day (read-only).
  const asOfFromHash = () => {
    const v = new URLSearchParams(window.location.hash.split("?")[1] || "").get("asof");
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const [product, setProductState] = useState(() => tabFromHash() || "international");
  const [asOf, setAsOfState] = useState(asOfFromHash);
  const writeHash = (id, d) => {
    if (window.location.hash.split("?")[0] === "#product") window.history.replaceState(null, "", `#product?tab=${id}${d ? `&asof=${d}` : ""}`);
  };
  const setProduct = useCallback(
    (id) => {
      setProductState(id);
      writeHash(id, asOf);
    },
    [asOf],
  );
  const setAsOf = useCallback(
    (d) => {
      setAsOfState(d || null);
      writeHash(product, d || null);
    },
    [product],
  );
  useEffect(() => {
    const onHash = () => {
      const t = window.location.hash.split("?")[0] === "#product" && tabFromHash();
      if (t) setProductState(t);
      if (window.location.hash.split("?")[0] === "#product") setAsOfState(asOfFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [moneyRange, setMoneyRange] = useState(MONEY_DEFAULT_RANGE);
  const [handleSel, setHandleSel] = useState("all");
  const [sql, setSql] = useState(null);
  const [bankPick, setBankPick] = useState(null); // null = default top 5
  const [codePick, setCodePick] = useState(null);
  const [countryPick, setCountryPick] = useState(null);

  const load = useCallback(async () => {
    try {
      setState(await api(`/state?product=${product}`));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [product]);

  useEffect(() => {
    load();
  }, [load]);

  // Range: n days per period. kind "n" (preset), "mtd", "custom" (custom also sets As-of = its end day).
  const [rangeKind, setRangeKind] = useState("n");
  const effRange = product === "international" ? range : moneyRange;
  const anchorDay = asOf || state?.saved?.last || null;
  const pickRange = (n, kind, to) => {
    setRangeKind(kind);
    if (product === "international") setRange(n);
    else setMoneyRange(n);
    if (kind === "custom") setAsOf(to);
  };
  useEffect(() => {
    if (!asOf && rangeKind === "custom") setRangeKind("n"); // back to latest: a custom range no longer applies
  }, [asOf, rangeKind]);
  // Saved-day view: an As-of day, or a range longer than the live 30 days (current + previous period).
  const longRange = 2 * effRange > 30;
  const fetchTo = asOf || (longRange ? state?.saved?.last : null);
  const liveStamp = Object.values(state?.cache || {})
    .map((c) => c?.finishedAt || 0)
    .join(",");
  const [asOfData, setAsOfData] = useState(null);
  useEffect(() => {
    if (!fetchTo) {
      setAsOfData(null);
      return undefined;
    }
    let live = true;
    const key = `${product}|${fetchTo}|${longRange ? effRange : 0}`;
    setAsOfData((d) => (d?.key === key ? d : { loading: true, key, product }));
    api(`/asof?product=${product}&to=${fetchTo}${longRange ? `&range=${effRange}` : ""}`)
      .then((d) => live && setAsOfData({ ...d, key }))
      .catch((e) => live && (setAsOfData(null), setError(e.message)));
    return () => {
      live = false;
    };
  }, [fetchTo, product, longRange, effRange, liveStamp]);

  // Poll while a run is in flight.
  useEffect(() => {
    if (!state?.running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [state?.running, load]);

  // query: one panel's query (or list); omitted = every query of the product. days: extend a
  // daily query's cached coverage to the last `days` days (UPI Lite trend filters).
  const refresh = async (query, days) => {
    if (asOf) setAsOf(null); // a run always updates the latest data
    try {
      await api("/run", { method: "POST", body: JSON.stringify({ product, query, days }) });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const stopRun = async (query) => {
    try {
      await api("/stop", { method: "POST", body: JSON.stringify({ product, query }) });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  // table (optional): { path, params, note } — the APD per-table query (backend/reference/apd-sql), filled for this view,
  // shown above the per-day pipeline SQL that fills the cache.
  const showSql = async (query, table) => {
    try {
      const qs = [].concat(query);
      const parts = await Promise.all(qs.map((q) => api(`/sql?product=${product}&query=${q}`)));
      let text = parts.map((p) => (qs.length > 1 ? `-- ${p.query}\n${p.sql}` : p.sql)).join("\n\n");
      if (table?.path) {
        const t = await api(`/apd-sql?path=${encodeURIComponent(table.path)}`);
        let filled = t.sql;
        for (const [k, v] of Object.entries(table.params || {})) filled = filled.replaceAll(`{${k}}`, v);
        text = `-- ═══ Table query for this view (${table.path}${table.note ? ` · ${table.note}` : ""}) ═══\n${filled}\n\n-- ═══ Pipeline query that fills the cache, one day at a time ═══\n${text}`;
      }
      setSql({ query: qs.join(" + "), sql: text });
    } catch (e) {
      setError(e.message);
    }
  };

  // view = what the tabs read: the live state, or the as-of snapshot (no jobs: nothing runs on past data).
  const view = fetchTo ? (asOfData?.product === product && !asOfData?.loading ? asOfData : null) : state;
  const cache = useMemo(() => view?.cache || {}, [view]);
  const jobs = useMemo(() => (asOf ? {} : state?.jobs || {}), [asOf, state]);
  const saved = state?.saved;
  const pick = useCallback((q) => (cache[q]?.rows || []).filter((r) => handleSel === "all" || r.handle === handleSel), [cache, handleSel]);
  const act = useMemo(() => pick("activation"), [pick]);
  const txns = useMemo(() => pick("txns"), [pick]);
  const errs = useMemo(() => pick("errors"), [pick]);
  const ctry = useMemo(() => pick("countries"), [pick]);

  // Period: current = last `range` days ending at the latest day with data; previous = the N before.
  const P = useMemo(() => {
    let last = "";
    let first = "";
    for (const q of ["activation", "txns", "errors", "countries"]) {
      for (const r of cache[q]?.rows || []) {
        if (r.ts > last) last = r.ts;
        if (!first || r.ts < first) first = r.ts;
      }
    }
    if (!last) return null;
    const win = cache.activation?.window || cache.txns?.window;
    const all = daysBetween(win?.fromDate && win.fromDate < first ? win.fromDate : first, toDay(toMs(last) + DAY));
    const cur = all.slice(-range);
    const prev = all.slice(-2 * range, -range);
    return { cur, prev, chart: [...prev, ...cur], curSet: new Set(cur), prevSet: new Set(prev), from: cur[0], to: cur[cur.length - 1] };
  }, [cache, range]);

  // ── Section 1: activation by day × PSP ──
  const s1 = useMemo(() => {
    if (!P) return null;
    const byDayH = sumBy(act, (r) => `${r.ts}|${r.handle}`, ["attempts", "activated"]);
    const byDay = sumBy(act, (r) => r.ts, ["attempts", "activated"]);
    const byH = sumBy(act.filter((r) => P.curSet.has(r.ts)), (r) => r.handle, ["attempts", "activated"]);
    const handles = HANDLES.filter((h) => byH.get(h)?.attempts);
    const g = (m, k) => m.get(k) || { attempts: 0, activated: 0 };
    const tot = (set) => [...set].reduce((a, d) => ({ attempts: a.attempts + g(byDay, d).attempts, activated: a.activated + g(byDay, d).activated }), { attempts: 0, activated: 0 });
    const cur = tot(P.curSet);
    const prev = tot(P.prevSet);
    const curSr = pct(cur.activated, cur.attempts);
    const rows = [...P.cur].reverse().map((d) => ({ id: d, d, per: Object.fromEntries(handles.map((h) => [h, g(byDayH, `${d}|${h}`)])), all: g(byDay, d) }));
    rows.push({ id: "__total", d: "Total", _total: true, per: Object.fromEntries(handles.map((h) => [h, g(byH, h)])), all: cur });
    const lines = [
      ...handles.map((h) => ({ name: h.toUpperCase(), color: HANDLE_COLOR[h], values: P.chart.map((d) => pct(g(byDayH, `${d}|${h}`).activated, g(byDayH, `${d}|${h}`).attempts)) })),
      { name: "Overall", color: "#e2e8f0", dashed: true, values: P.chart.map((d) => pct(g(byDay, d).activated, g(byDay, d).attempts)) },
    ];
    return { handles, rows, cur, prev, curSr, prevSr: pct(prev.activated, prev.attempts), lines, attempts: P.chart.map((d) => g(byDay, d).attempts) };
  }, [act, P]);

  // ── Section 2: activation by bank (top 15 in the current period) ──
  const s2 = useMemo(() => {
    if (!P) return null;
    const curRows = act.filter((r) => P.curSet.has(r.ts));
    const rank = [...sumBy(curRows, (r) => r.bank, ["attempts"]).entries()].sort((a, b) => b[1].attempts - a[1].attempts);
    const top = new Set(rank.slice(0, TOP_BANKS).map(([b]) => b));
    const bankOf = (r) => (top.has(r.bank) ? r.bank : "Others");
    const cur = sumBy(curRows, bankOf, ["attempts", "activated"]);
    const prev = sumBy(act.filter((r) => P.prevSet.has(r.ts)), bankOf, ["attempts", "activated"]);
    const byDay = sumBy(act, (r) => `${r.ts}|${bankOf(r)}`, ["attempts", "activated"]);
    const allCur = [...cur.values()].reduce((a, v) => ({ attempts: a.attempts + v.attempts, activated: a.activated + v.activated }), { attempts: 0, activated: 0 });
    const allPrev = [...prev.values()].reduce((a, v) => ({ attempts: a.attempts + v.attempts, activated: a.activated + v.activated }), { attempts: 0, activated: 0 });
    const overall = pct(allCur.activated, allCur.attempts);
    const order = [...rank.slice(0, TOP_BANKS).map(([b]) => b), ...(cur.has("Others") ? ["Others"] : [])];
    const srOf = (b, d) => {
      const v = byDay.get(`${d}|${b}`);
      return v ? pct(v.activated, v.attempts) : null;
    };
    const items = order.map((b) => {
      const c = cur.get(b) || { attempts: 0, activated: 0 };
      const p = prev.get(b) || { attempts: 0, activated: 0 };
      const sr = pct(c.activated, c.attempts);
      const psr = pct(p.activated, p.attempts);
      return { id: b, bank: b, ...c, sr, psr, dpp: sr != null && psr != null ? sr - psr : null, share: pct(c.attempts, allCur.attempts), daily: P.chart.map((d) => srOf(b, d)) };
    });
    const srs = items.filter((i) => i.bank !== "Others" && i.sr != null).map((i) => i.sr);
    const best = srs.length ? Math.max(...srs) : null;
    const worst = srs.length ? Math.min(...srs) : null;
    return { items, overall, prevOverall: pct(allPrev.activated, allPrev.attempts), allCur, best, worst, srOf };
  }, [act, P]);

  // ── Section 3: txns by day ──
  const s3 = useMemo(() => {
    if (!P) return null;
    const byDay = new Map();
    for (const r of txns) {
      let o = byDay.get(r.ts);
      if (!o) byDay.set(r.ts, (o = { c: 0, s: 0, f: 0, dm: 0, gmv: 0, amt: 0 }));
      o.c += r.c;
      o.amt += r.amt;
      if (r.status === "SUCCESS") {
        o.s += r.c;
        o.gmv += r.amt;
      } else if (r.status === "DEEMED") o.dm += r.c;
      else o.f += r.c;
    }
    const z = { c: 0, s: 0, f: 0, dm: 0, gmv: 0, amt: 0 };
    const g = (d) => byDay.get(d) || z;
    const add = (days) => days.reduce((a, d) => Object.fromEntries(Object.keys(z).map((k) => [k, a[k] + g(d)[k]])), { ...z });
    const cur = add(P.cur);
    const prev = add(P.prev);
    const curSr = pct(cur.s, cur.c);
    const rows = [...P.cur].reverse().map((d) => ({ id: d, d, ...g(d), sr: pct(g(d).s, g(d).c) }));
    rows.push({ id: "__total", d: "Total", _total: true, ...cur, sr: curSr });
    return {
      rows,
      cur,
      prev,
      curSr,
      prevSr: pct(prev.s, prev.c),
      sr: P.chart.map((d) => pct(g(d).s, g(d).c)),
      count: P.chart.map((d) => g(d).c),
    };
  }, [txns, P]);

  // NPCI FRM rule / EFRM model (U16-xxxxx, M16-xxxxx, from the backend's codeInfo) wins over the static meaning.
  const codeInfo = view?.codeInfo;
  const meaningOf = useCallback((code) => codeInfo?.[code]?.frm || CODE_MEANING[code] || "", [codeInfo]);

  // ── Section 4: top error codes ──
  const s4 = useMemo(() => {
    if (!P) return null;
    const cur = errs.filter((r) => P.curSet.has(r.ts));
    const prevRows = errs.filter((r) => P.prevSet.has(r.ts));
    const total = cur.reduce((a, r) => a + r.c, 0);
    const prevTotal = prevRows.reduce((a, r) => a + r.c, 0);
    const byCode = sumBy(cur, (r) => r.code, ["c", "amt"]);
    const prevBy = sumBy(prevRows, (r) => r.code, ["c"]);
    const daily = sumBy(errs, (r) => `${r.ts}|${r.code}`, ["c"]);
    const banks = sumBy(cur, (r) => `${r.code}|${r.bank}`, ["c"]);
    const psps = sumBy(cur, (r) => `${r.code}|${r.handle}`, ["c"]);
    const apps = sumBy(cur, (r) => `${r.code}|${r.app || ""}`, ["c"]);
    const ranked = [...byCode.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, TOP_ERRORS);
    const items = ranked.map(([code, v]) => {
      const p = prevBy.get(code)?.c || 0;
      const topOf = (m, prefix, k = 5) =>
        [...m.entries()]
          .filter(([key]) => key.startsWith(`${code}|`))
          .map(([key, o]) => [key.slice(code.length + 1), o.c])
          .sort((a, b) => b[1] - a[1])
          .slice(0, k);
      const appCodes = topOf(apps, code, 3).filter(([a]) => a && a !== code);
      return {
        id: code,
        code,
        meaning: meaningOf(code),
        appCodes,
        c: v.c,
        amt: v.amt,
        share: pct(v.c, total),
        prev: p,
        prevShare: pct(p, prevTotal),
        trend: trendOf(v.c, p),
        banks: topOf(banks, code),
        psps: topOf(psps, code, 4),
        daily: P.chart.map((d) => daily.get(`${d}|${code}`)?.c || 0),
      };
    });
    const rising = items.filter((i) => i.trend.kind === "up" || i.trend.kind === "new");
    const falling = items.filter((i) => i.trend.kind === "down");
    return { items, total, prevTotal, rising, falling };
  }, [errs, P, meaningOf]);

  // Sections 5 and 6 use fixed periods anchored on the latest data day Y (as in the
  // reference queries): Yesterday = Y, D-2 = Y-1, L7D = Y-6 … Y (7 days incl. Y).
  const Q = useMemo(() => {
    if (!P) return null;
    const y = P.to;
    const l7 = Array.from({ length: 7 }, (_, i) => toDay(toMs(y) - (6 - i) * DAY));
    return { y, d2: toDay(toMs(y) - DAY), l7, l7Set: new Set(l7) };
  }, [P]);

  // ── Section 5: txn SR by country ──
  const s5 = useMemo(() => {
    if (!P || !Q) return null;
    const by = (keep) => sumBy(ctry.filter(keep), (r) => r.country, ["total", "succ", "term"]);
    const y = by((r) => r.ts === Q.y);
    const d2 = by((r) => r.ts === Q.d2);
    const l7 = by((r) => Q.l7Set.has(r.ts));
    const daily = sumBy(ctry, (r) => `${r.ts}|${r.country}`, ["succ", "term"]);
    const z = { total: 0, succ: 0, term: 0 };
    const all = (m) => [...m.values()].reduce((a, v) => ({ total: a.total + v.total, succ: a.succ + v.succ, term: a.term + v.term }), { ...z });
    const row = (id, yv, dv, lv, extra = {}) => {
      const ysr = pct(yv.succ, yv.term);
      const lsr = pct(lv.succ, lv.term);
      return { id, y: yv.total, d2: dv.total, l7avg: lv.total / 7, ysr, d2sr: pct(dv.succ, dv.term), l7sr: lsr, dpp: ysr != null && lsr != null ? ysr - lsr : null, ...extra };
    };
    const countries = [...new Set([...y.keys(), ...d2.keys(), ...l7.keys()])].sort((a, b) => (y.get(b)?.total || 0) - (y.get(a)?.total || 0) || (l7.get(b)?.total || 0) - (l7.get(a)?.total || 0) || a.localeCompare(b));
    const items = countries.map((c) =>
      row(c, y.get(c) || z, d2.get(c) || z, l7.get(c) || z, {
        country: c,
        daily: P.chart.map((d) => {
          const v = daily.get(`${d}|${c}`);
          return v ? pct(v.succ, v.term) : null;
        }),
      }),
    );
    const total = row("__total", all(y), all(d2), all(l7), { _total: true });
    return { items, total, srOf: (c, d) => (daily.get(`${d}|${c}`) ? pct(daily.get(`${d}|${c}`).succ, daily.get(`${d}|${c}`).term) : null) };
  }, [ctry, P, Q]);

  // ── Section 6: failures by app_resp_code (top 50 by yesterday) ──
  const s6 = useMemo(() => {
    if (!P || !Q) return null;
    const fails = errs.filter((r) => r.status === "FAILURE" && r.app && String(r.app).trim());
    const codeOf = (r) => String(r.app).trim();
    const y = sumBy(fails.filter((r) => r.ts === Q.y), codeOf, ["c"]);
    const d2 = sumBy(fails.filter((r) => r.ts === Q.d2), codeOf, ["c"]);
    const l7 = sumBy(fails.filter((r) => Q.l7Set.has(r.ts)), codeOf, ["c"]);
    const daily = sumBy(fails, (r) => `${r.ts}|${codeOf(r)}`, ["c"]);
    const g = (m, k) => m.get(k)?.c || 0;
    const items = [...new Set([...y.keys(), ...d2.keys(), ...l7.keys()])]
      .map((code) => {
        const yc = g(y, code);
        const l7avg = g(l7, code) / 7;
        return {
          id: code,
          code,
          meaning: meaningOf(code),
          y: yc,
          d2: g(d2, code),
          l7avg,
          vsL7: trendOf(yc, l7avg),
          vsD2: trendOf(yc, g(d2, code)),
          daily: P.chart.map((d) => g(daily, `${d}|${code}`)),
        };
      })
      .sort((a, b) => b.y - a.y || a.code.localeCompare(b.code))
      .slice(0, TOP_APP_CODES);
    const sumM = (m) => [...m.values()].reduce((a, v) => a + v.c, 0);
    const yt = sumM(y);
    const lt = sumM(l7) / 7;
    const total = { id: "__total", _total: true, code: "All failures", meaning: "", y: yt, d2: sumM(d2), l7avg: lt, vsL7: trendOf(yt, lt), vsD2: trendOf(yt, sumM(d2)), daily: [] };
    return { items, total };
  }, [errs, P, Q, meaningOf]);

  // Chart selections default to the top 5; reset when the range / handle changes the ranking.
  useEffect(() => {
    setBankPick(null);
    setCodePick(null);
    setCountryPick(null);
  }, [range, handleSel, product]);
  const toggle = (sel, setSel, defaults, id) => {
    const base = sel || defaults;
    setSel(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  if (!state && !error) return <div style={{ minHeight: "calc(100vh - 40px)", background: C.bg, color: C.muted, padding: 24 }}>Loading…</div>;

  const handleLabel = handleSel === "all" ? "PTYES + PTAXIS + PTSBI + PTHDFC" : handleSel.toUpperCase();
  const periodLabel = P ? (P.cur.length === 1 ? fmtDay(P.from) : `${fmtDay(P.from)} – ${fmtDay(P.to)}`) : "—";
  const prevLabel = P && P.prev.length ? (P.prev.length === 1 ? fmtDay(P.prev[0]) : `${fmtDay(P.prev[0])} – ${fmtDay(P.prev[P.prev.length - 1])}`) : "—";
  const curFrom = P ? P.prev.length : 0;
  const lowSr = (v, ref) => v != null && ref != null && v < ref - LOW_SR_PP;
  const ppTone = (v) => (v == null || Math.abs(v) < 0.05 ? C.text2 : v > 0 ? C.good : C.bad);
  const srCell = (v, ref, extra = {}) => (
    <span style={{ color: lowSr(v, ref) ? C.bad : extra.best ? C.good : C.text, fontWeight: lowSr(v, ref) || extra.best ? 700 : 400 }}>{fmtPct(v)}</span>
  );

  // Section 1 table
  const s1Cols = s1
    ? [
        { key: "d", label: "Date", align: "left", render: (r) => (r._total ? "Total" : fmtDay(r.d)), text: (r) => (r._total ? "Total" : r.d) },
        ...s1.handles.flatMap((h) => [
          { key: `${h}-a`, label: `${h} Att / Done`, render: (r) => `${fmtNum(r.per[h].attempts)} / ${fmtNum(r.per[h].activated)}` },
          { key: `${h}-sr`, label: `${h} SR`, render: (r) => srCell(pct(r.per[h].activated, r.per[h].attempts), s1.curSr), text: (r) => fmtPct(pct(r.per[h].activated, r.per[h].attempts)) },
        ]),
        ...(s1.handles.length > 1 ? [{ key: "all-a", label: "Total Att / Done", render: (r) => `${fmtNum(r.all.attempts)} / ${fmtNum(r.all.activated)}` }] : []),
        { key: "all-sr", label: "Activation SR", render: (r) => <b>{srCell(pct(r.all.activated, r.all.attempts), r._total ? null : s1.curSr)}</b>, text: (r) => fmtPct(pct(r.all.activated, r.all.attempts)) },
      ]
    : [];

  // Section 2 table
  const bankDefault = s2 ? s2.items.filter((i) => i.bank !== "Others").slice(0, 5).map((i) => i.bank) : [];
  const bankSel = bankPick || bankDefault;
  const showDayCols = P && P.cur.length > 1 && P.cur.length <= 7;
  const s2Cols = s2
    ? [
        { key: "bank", label: "Bank", align: "left", render: (r) => (r._total ? "Overall" : <span>{bankSel.includes(r.bank) && <span style={{ color: SERIES[bankSel.indexOf(r.bank) % SERIES.length] }}>● </span>}{r.bank}</span>), text: (r) => (r._total ? "Overall" : r.bank) },
        { key: "att", label: "Attempts", render: (r) => fmtNum(r.attempts) },
        { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
        { key: "act", label: "Activated", render: (r) => fmtNum(r.activated) },
        { key: "sr", label: "SR", title: periodLabel, render: (r) => srCell(r.sr, r._total ? null : s2.overall, { best: !r._total && r.bank !== "Others" && r.sr === s2.best }), text: (r) => fmtPct(r.sr) },
        { key: "psr", label: "Prev SR", title: prevLabel, render: (r) => fmtPct(r.psr) },
        { key: "dpp", label: "Δ pp", title: "SR change vs previous period, percentage points", render: (r) => <span style={{ color: ppTone(r.dpp), fontWeight: Math.abs(r.dpp || 0) >= 2 ? 700 : 400 }}>{fmtSigned(r.dpp, " pp")}</span>, text: (r) => fmtSigned(r.dpp, " pp") },
        ...(showDayCols ? P.cur.map((d) => ({ key: d, label: fmtDay(d), render: (r) => (r._total ? "" : srCell(s2.srOf(r.bank, d), s2.overall)), text: (r) => (r._total ? "" : fmtPct(s2.srOf(r.bank, d))) })) : []),
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={ppTone(r.dpp) === C.text2 ? "#94a3b8" : ppTone(r.dpp)} curFrom={curFrom} />), text: () => "" },
      ]
    : [];
  const s2Rows = s2
    ? [
        ...s2.items.map((i) => ({ ...i, _active: bankSel.includes(i.bank), _onClick: () => toggle(bankPick, setBankPick, bankDefault, i.bank) })),
        { id: "__total", _total: true, ...s2.allCur, share: 100, sr: s2.overall, psr: s2.prevOverall, dpp: s2.overall != null && s2.prevOverall != null ? s2.overall - s2.prevOverall : null },
      ]
    : [];

  // Section 3 table
  const s3Cols = s3
    ? [
        { key: "d", label: "Date", align: "left", render: (r) => (r._total ? "Total" : fmtDay(r.d)), text: (r) => (r._total ? "Total" : r.d) },
        { key: "c", label: "Txns", render: (r) => fmtNum(r.c) },
        { key: "s", label: "Success", render: (r) => fmtNum(r.s) },
        { key: "f", label: "Failed", render: (r) => fmtNum(r.f) },
        { key: "dm", label: "Deemed", render: (r) => fmtNum(r.dm) },
        { key: "gmv", label: "GMV ₹", title: "Sum of amount on successful txns", render: (r) => fmtInr(r.gmv) },
        { key: "ats", label: "Avg ticket", render: (r) => fmtInr(r.s ? r.gmv / r.s : null) },
        { key: "sr", label: "Txn SR", render: (r) => <b>{srCell(r.sr, r._total ? null : s3.curSr)}</b>, text: (r) => fmtPct(r.sr) },
      ]
    : [];

  // Section 4 table
  const codeDefault = s4 ? s4.items.slice(0, 5).map((i) => i.code) : [];
  const codeSel = codePick || codeDefault;
  const s4Cols = s4
    ? [
        { key: "code", label: "Code", align: "left", render: (r) => <span>{codeSel.includes(r.code) && <span style={{ color: SERIES[codeSel.indexOf(r.code) % SERIES.length] }}>● </span>}<code style={{ fontSize: 12 }}>{r.code}</code></span>, text: (r) => r.code },
        {
          key: "meaning",
          label: "Meaning",
          align: "left",
          wrap: true,
          render: (r) => (
            <span style={{ fontSize: 12, color: C.text2, display: "inline-block", minWidth: 220, maxWidth: 360 }}>
              {r.meaning || "—"}
              {r.appCodes.length > 0 && <span style={{ color: C.muted }}> · app {r.appCodes.map(([a, c]) => `${a} (${fmtNum(c)})`).join(", ")}</span>}
            </span>
          ),
          text: (r) => r.meaning,
        },
        { key: "c", label: "Failed", title: periodLabel, render: (r) => fmtNum(r.c) },
        { key: "share", label: "% of non-success", render: (r) => fmtPct(r.share) },
        { key: "prev", label: "Prev", title: prevLabel, render: (r) => fmtNum(r.prev) },
        { key: "trend", label: "vs Prev", title: `Failed count vs previous period (${prevLabel}); ±${TREND_PCT}% flagged`, render: (r) => <TrendBadge t={r.trend} />, text: (r) => (r.trend.kind === "new" ? "NEW" : fmtSigned(r.trend.pct, "%", 0)) },
        { key: "daily", label: "Daily", title: `Daily failures, ${prevLabel} → ${periodLabel}`, render: (r) => <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="Failures" unit="count" upIsBad color={r.trend.kind === "up" || r.trend.kind === "new" ? C.bad : r.trend.kind === "down" ? C.good : "#94a3b8"} curFrom={curFrom} />, text: () => "" },
        { key: "banks", label: "Top payer banks", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{r.banks.map(([b, c]) => `${b} ${fmtNum(c)}`).join(", ")}</span>, text: (r) => r.banks.map(([b, c]) => `${b} ${c}`).join(", ") },
        ...(handleSel === "all"
          ? [{ key: "psps", label: "PSP split", align: "left", render: (r) => <span style={{ fontSize: 12 }}>{r.psps.map(([h, c]) => `${h} ${fmtPct(pct(c, r.c), 0)}`).join(", ")}</span>, text: (r) => r.psps.map(([h, c]) => `${h} ${fmtPct(pct(c, r.c), 0)}`).join(", ") }]
          : []),
      ]
    : [];
  const s4Rows = s4 ? s4.items.map((i) => ({ ...i, _active: codeSel.includes(i.code), _onClick: () => toggle(codePick, setCodePick, codeDefault, i.code) })) : [];

  // Section 5 table
  const countryLabel = (c) => (COUNTRY_NAME[c] ? `${COUNTRY_NAME[c]} (${c})` : c);
  const countryDefault = s5 ? s5.items.filter((i) => i.country !== "UNKNOWN").slice(0, TOP_COUNTRIES_CHART).map((i) => i.country) : [];
  const countrySel = countryPick || countryDefault;
  const qy = Q ? fmtDay(Q.y) : "—";
  const qd2 = Q ? fmtDay(Q.d2) : "—";
  const ql7 = Q ? `${fmtDay(Q.l7[0])} – ${fmtDay(Q.l7[6])}` : "—";
  const s5Cols = s5
    ? [
        {
          key: "country",
          label: "Country",
          align: "left",
          render: (r) => (r._total ? "All countries" : <span>{countrySel.includes(r.country) && <span style={{ color: SERIES[countrySel.indexOf(r.country) % SERIES.length] }}>● </span>}{countryLabel(r.country)}</span>),
          text: (r) => (r._total ? "All countries" : r.country),
        },
        { key: "y", label: "Yesterday Txns", title: qy, render: (r) => fmtNum(r.y) },
        { key: "d2", label: "D-2 Txns", title: qd2, render: (r) => fmtNum(r.d2) },
        { key: "l7avg", label: "L7D Avg / Day", title: ql7, render: (r) => fmtNum(r.l7avg) },
        { key: "ysr", label: "Yesterday SR", title: qy, render: (r) => <b>{srCell(r.ysr, r._total ? null : s5.total.ysr)}</b>, text: (r) => fmtPct(r.ysr, 2) },
        { key: "d2sr", label: "D-2 SR", title: qd2, render: (r) => fmtPct(r.d2sr) },
        { key: "l7sr", label: "L7D SR", title: `Pooled SR over ${ql7}`, render: (r) => fmtPct(r.l7sr) },
        { key: "dpp", label: "vs L7D", title: "Yesterday SR − L7D SR, percentage points", render: (r) => <span style={{ color: ppTone(r.dpp), fontWeight: Math.abs(r.dpp || 0) >= 2 ? 700 : 400 }}>{fmtSigned(r.dpp, " pp")}</span>, text: (r) => fmtSigned(r.dpp, " pp") },
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="SR" unit="pct" color={ppTone(r.dpp) === C.text2 ? "#94a3b8" : ppTone(r.dpp)} curFrom={curFrom} />), text: () => "" },
      ]
    : [];
  const s5Rows = s5 ? [...s5.items.map((i) => ({ ...i, _active: countrySel.includes(i.country), _onClick: () => toggle(countryPick, setCountryPick, countryDefault, i.country) })), s5.total] : [];

  // Section 6 table
  const s6Cols = s6
    ? [
        { key: "code", label: "App Resp Code", align: "left", render: (r) => (r._total ? "All failures" : <code style={{ fontSize: 12 }}>{r.code}</code>), text: (r) => r.code },
        { key: "meaning", label: "Meaning", align: "left", wrap: true, render: (r) => <span style={{ fontSize: 12, color: C.text2, display: "inline-block", minWidth: 180, maxWidth: 340 }}>{r._total ? "" : r.meaning || "—"}</span>, text: (r) => r.meaning },
        { key: "y", label: "Yesterday", title: qy, render: (r) => fmtNum(r.y) },
        { key: "d2", label: "D-2", title: qd2, render: (r) => fmtNum(r.d2) },
        { key: "l7avg", label: "L7D Avg / Day", title: ql7, render: (r) => (r.l7avg ? r.l7avg.toFixed(1) : "0") },
        { key: "vsL7", label: "vs L7D Avg", title: `Yesterday vs L7D daily average; ±${TREND_PCT}% flagged`, render: (r) => <TrendBadge t={r.vsL7} />, text: (r) => (r.vsL7.kind === "new" ? "NEW" : fmtSigned(r.vsL7.pct, "%", 0)) },
        { key: "vsD2", label: "vs D-2", title: `Yesterday vs D-2; ±${TREND_PCT}% flagged`, render: (r) => <TrendBadge t={r.vsD2} />, text: (r) => (r.vsD2.kind === "new" ? "NEW" : fmtSigned(r.vsD2.pct, "%", 0)) },
        { key: "daily", label: "Daily", title: `Daily failures, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} days={P.chart} name={rowName(r)} metric="Failures" unit="count" upIsBad color={r.vsL7.kind === "up" || r.vsL7.kind === "new" ? C.bad : r.vsL7.kind === "down" ? C.good : "#94a3b8"} curFrom={curFrom} />), text: () => "" },
      ]
    : [];
  const s6Rows = s6 ? [...s6.items, s6.total] : [];

  const kpiDelta = (cur, prev, unit = " pp") => (cur != null && prev != null ? `${fmtSigned(cur - prev, unit)} vs prev` : "vs prev —");

  return (
    <div style={{ minHeight: "calc(100vh - 40px)", background: C.bg, color: C.text, fontFamily: "'Segoe UI', sans-serif", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Product Wise</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            {product === "plugin"
              ? "UPI Plugin · @yesnext handle · daily since launch, today included · source PTYBL Redash (PMS, live)"
              : product === "refunds"
              ? "UPI Refunds · refund_info · every day since the 1st of last month (for MTD / LMTD), sliced by the range picker · source PTYBL Redash (Refund MySQL, live)"
              : product === "payouts"
              ? "Payouts · external_txn_info · every day since the 1st of last month (for MTD / LMTD), sliced by the range picker · source PTYBL Redash (Refund MySQL, live)"
              : product === "mandates"
              ? "Mandates · Paytm-app UMNs (paytm / ptaxis / pthdfc / ptsbi / ptyes), one per UMN per day · last 30 complete days, sliced by the range picker · SR by stage, payer account (CC / CASA), mode, payee MCC, payer / payee bank and handle; where each code fails (incl. payee handle × bank); top merchants · source Trino (switch txn_info + txn_participants) · older days kept in data/product/_apd-history"
              : product === "cccasa"
              ? "CC vs CASA · P2M payments (VPA2MERCHANT pay + collect) by payer account: credit card vs savings / current · last 30 complete days, sliced by the range picker · SR day on day, failure codes · source Trino (switch txn_info + txn_participants), same query as the Automatic Payments Dashboard's CC vs CASA tab (P2M part); Autopay CC vs CASA is in Mandates"
              : product === "interop"
              ? "Interop · mandate portability: Update payee VPA, Update MIC, Port-In (purpose BC IN_PORT) and Port-Out (purpose BC UPDATE onto another app) · every day since 23 Dec 2025, sliced by the days picker · distinct UMNs by payer bank, source / destination app, Paytm handle, failure code · source Trino (upi_activities_data_snapshot_v3, switch txn_info + txn_participants), same SQL as the Automatic Payments Dashboard; first fill from its saved days"
              : product === "iccw"
              ? "ICCW · UPI cash withdrawal at ATM / BC points (payee MCC 6013, purpose 12 / 13) · Paytm payer handles · last 30 complete days, sliced by the range picker · SR by purpose, acquirer, remitter bank, Paytm handle, amount, hour; failure codes and where they fail · source Trino (switch txn_info + txn_participants), first fill from the Automatic Payments Dashboard cache"
              : product === "lite"
              ? "UPI Lite · all PSPs · last 30 complete days by default (each section's Trend filter fetches up to 120) + daily snapshots · source Trino (team_product summaries, switch txn_info, tpap_pms / switch / ups snapshots)"
              : `${PRODUCTS.find((p) => p.id === product)?.label.replace(/^\S+\s/, "")} · ${handleLabel} · current ${periodLabel} vs previous ${prevLabel} · source Trino (tpap_pms / switch snapshots)`}
          </div>
        </div>
        <AsOfPicker asOf={asOf} saved={saved} onChange={setAsOf} />
        <a
          href="/#history?dashboard=product"
          target="_blank"
          rel="noopener noreferrer"
          title="Open run history (query, output, insights) in a new tab"
          style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          🕘 History ↗
        </a>
        <a
          href={`${API}/error-sheet`}
          title="Download the error-code sheet: TPAP Redash upi_config.response_mapper (response constant, app message per code), refreshed daily"
          style={{ fontSize: 12, fontWeight: 600, color: "#93c5fd", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          ⬇ Error-code sheet
        </a>
        {state?.running && (
          <button type="button" onClick={() => stopRun()} style={{ ...btn(false), borderColor: C.bad, color: C.bad }} title="Stop every running query of this product (keeps the last results)">
            ■ Stop all
          </button>
        )}
        <button
          type="button"
          onClick={() => refresh()}
          style={btn(true)}
          disabled={state?.jobs && Object.values(state.jobs).every((j) => j.status === "running")}
          title="Run every query of this product (ones already running are left alone)"
        >
          {state?.running ? "Running… · ↻ rest" : "↻ Refresh all"}
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 4 }}>
          {PRODUCTS.map((p) => (
            <button key={p.id} type="button" disabled={p.soon} onClick={() => setProduct(p.id)} title={p.soon ? "Coming soon" : undefined} style={{ ...pill(product === p.id), opacity: p.soon ? 0.45 : 1, cursor: p.soon ? "not-allowed" : "pointer" }}>
              {p.label}
              {p.soon && " · soon"}
            </button>
          ))}
        </div>
        {(product === "refunds" || product === "payouts" || product === "mandates" || product === "iccw" || product === "cccasa") && (
          <RangeBar value={moneyRange} presets={MONEY_RANGES} anchor={anchorDay} kind={rangeKind} saved={saved} onPick={pickRange} />
        )}
        {product === "international" && (
          <>
            <RangeBar value={range} presets={RANGES.map((r) => r.n)} anchor={anchorDay} kind={rangeKind} saved={saved} onPick={pickRange} />
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>PSP</span>
              {["all", ...HANDLES].map((h) => (
                <button key={h} type="button" onClick={() => setHandleSel(h)} style={pill(handleSel === h)}>
                  {h === "all" ? "All 4" : h.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ background: "#2a1215", border: `1px solid ${C.bad}`, color: "#fecaca", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      {asOf && (
        <div style={{ background: "#1e1b4b", border: "1px solid #6366f1", color: "#c7d2fe", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>
            🕘 Viewing saved data <b>as of {fmtDay(asOf)} {asOf.slice(0, 4)}</b> — read-only, every section anchors on this day.{" "}
            {asOfData?.loading
              ? "Loading…"
              : !Object.keys(cache).length
              ? "No saved days for this tab up to that date."
              : longRange && product === "mandates"
              ? "Long range: bank / MCC / handle splits are summed per 7-day block."
              : saved?.first && asOf < saved.first
              ? `Saved days for this tab start on ${fmtDay(saved.first)}.`
              : ""}
          </span>
          <button type="button" onClick={() => setAsOf(null)} style={{ ...btn(true), padding: "3px 10px" }}>
            Back to latest
          </button>
        </div>
      )}
      {!asOf && longRange && (
        <div style={{ fontSize: 12, color: "#c7d2fe", marginBottom: 8 }}>
          {effRange}-day range: read from the saved days (backfilled history), current {effRange} days vs the {effRange} before.
          {product === "mandates" ? " Bank / MCC / handle splits are summed per 7-day block; where-it-fails splits cover the newest 15 days." : ""}
          {asOfData?.loading ? " Loading…" : ""}
        </div>
      )}
      {state && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          {product === "plugin"
            ? `Opening this tab only reads cached results (every day since launch, today so far). Backend auto-refreshes ${state.schedule?.join(" & ")}; click Refresh for the latest.`
            : product === "refunds" || product === "payouts"
            ? `Opening this tab only reads cached results. Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST, one day per query; days older than 2 days are reused from cache, so a refresh only re-queries the newest days.`
            : product === "mandates"
            ? `Opening this tab only reads cached results. Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST, one Trino query per day; days older than 2 days are reused from cache, so a refresh only re-queries the newest days. A first fill loads 3 days at a time, newest first (~1 min per chunk); the tab updates as each chunk lands.`
            : product === "cccasa"
            ? `Opening this tab only reads cached results. Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST, one Trino query per day; days already saved are kept, the last 2 days are re-pulled.`
            : product === "interop"
            ? `Opening this tab only reads cached results. Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST, one Trino query per day; days already saved are kept, the last 2 days are re-pulled (late status updates).`
            : product === "iccw"
            ? `Opening this tab only reads cached results. Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST, one Trino query per day; days older than 2 days are reused from cache, so a refresh only re-queries the newest days.`
            : product === "lite"
            ? `Opening this tab only reads cached results. Backend auto-refreshes the last 30 days daily at ${state.schedule?.join(" & ")} IST (older days fetched via a section's Trend filter are kept); each run also adds a snapshot to sections 1 and 8. Section 10 runs only from its own panel.`
            : `Opening this tab only reads cached results (last 30 complete days). Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST. Click a bank / error row to add or remove it from the chart.`}
        </div>
      )}

      {product === "plugin" && <PluginView cached={cache.daily} job={jobs.daily} asOf={asOf} onShowSql={() => showSql("daily")} />}
      {product === "refunds" && <RefundsView cached={cache.daily} job={jobs.daily} range={moneyRange} codeInfo={view?.codeInfo} onShowSql={() => showSql("daily")} onRun={() => refresh("daily")} onStop={() => stopRun("daily")} />}
      {product === "mandates" && (
        <>
          <MandatesView cached={cache.daily} job={jobs.daily} range={moneyRange} asOf={asOf} codeInfo={view?.codeInfo} onShowSql={(t) => showSql("daily", t)} onRun={() => refresh("daily")} onStop={() => stopRun("daily")} />
          <TopMerchants cached={cache.payees} job={jobs.payees} onShowSql={(t) => showSql("payees", t)} onRun={() => refresh("payees")} onStop={() => stopRun("payees")} />
          <CodeWatch cached={cache.codewatch} job={jobs.codewatch} onShowSql={(t) => showSql("codewatch", t)} onRun={() => refresh("codewatch")} onStop={() => stopRun("codewatch")} />
        </>
      )}
      {product === "cccasa" && <CcCasaView cached={cache.p2m} job={jobs.p2m} range={moneyRange} codeInfo={view?.codeInfo} onShowSql={(t) => showSql("p2m", t)} onRun={() => refresh("p2m")} onStop={() => stopRun("p2m")} />}
      {product === "interop" && <InteropView cache={cache} jobs={jobs} codeInfo={view?.codeInfo} onShowSql={showSql} onRun={(q) => refresh(q)} onStop={(q) => stopRun(q)} />}
      {product === "iccw" && <IccwView cached={cache.daily} job={jobs.daily} range={moneyRange} codeInfo={view?.codeInfo} onShowSql={() => showSql("daily")} onRun={() => refresh("daily")} onStop={() => stopRun("daily")} />}
      {product === "payouts" && <PayoutsView cached={cache.daily} job={jobs.daily} range={moneyRange} codeInfo={view?.codeInfo} onShowSql={() => showSql("daily")} onRun={() => refresh("daily")} onStop={() => stopRun("daily")} />}
      {product === "lite" && <LiteView cache={cache} jobs={jobs} onShowSql={showSql} onRun={(q, days) => refresh(q, days)} onStop={(q) => stopRun(q)} />}
      {product === "international" && (
        <>
          <Section
            n={1}
            title="Activation by day & PSP"
            desc="UPI International activation (account_activation_snapshot_v3, service INTERNATIONAL) by Paytm TPAP handle. SR = ACTIVE / attempts. Red = day SR more than 5 pp below the period SR."
            job={jobs.activation}
            cached={cache.activation}
            onShowSql={() => showSql("activation")}
            kpis={
              s1 && (
                <>
                  <Kpi label="Attempts" value={fmtNum(s1.cur.attempts)} sub={`${fmtSigned(chg(s1.cur.attempts, s1.prev.attempts), "%")} vs prev`} />
                  <Kpi label="Activated" value={fmtNum(s1.cur.activated)} sub={`${fmtSigned(chg(s1.cur.activated, s1.prev.activated), "%")} vs prev`} />
                  <Kpi label="Activation SR" value={fmtPct(s1.curSr)} sub={kpiDelta(s1.curSr, s1.prevSr)} color={s1.prevSr != null && s1.curSr < s1.prevSr - 1 ? C.bad : undefined} />
            </>
          )
        }
        chart={s1 && P && <TrendChart days={P.chart} lines={s1.lines} bars={{ name: "Attempts", values: s1.attempts }} curFrom={curFrom} />}
        cols={s1Cols}
        rows={s1?.rows || []}
      />

      <Section
        n={2}
        title={`Activation by bank (top ${TOP_BANKS})`}
        desc="Remitter bank (account_provider_ifsc) ranked by attempts in the current period; the rest roll into Others. Δ pp vs the previous period; green = best SR, red = more than 5 pp below overall."
        job={jobs.activation}
        cached={cache.activation}
        onShowSql={() => showSql("activation")}
        chart={
          s2 &&
          P && (
            <TrendChart
              days={P.chart}
              lines={[
                ...bankSel.map((b, i) => ({ name: b, color: SERIES[i % SERIES.length], values: P.chart.map((d) => s2.srOf(b, d)) })),
                { name: "Overall", color: "#e2e8f0", dashed: true, values: s1 ? s1.lines[s1.lines.length - 1].values : [] },
              ]}
              curFrom={curFrom}
            />
          )
        }
        cols={s2Cols}
        rows={s2Rows}
      />

      <Section
        n={3}
        title="Daily txns pattern"
        desc="UPI International (txn_mode UPI_GLOBAL) txns on Paytm TPAP handles. GMV = successful amount. Red = day SR more than 5 pp below the period SR."
        job={jobs.txns}
        cached={cache.txns}
        onShowSql={() => showSql("txns")}
        kpis={
          s3 && (
            <>
              <Kpi label="Txns" value={fmtNum(s3.cur.c)} sub={`${fmtSigned(chg(s3.cur.c, s3.prev.c), "%")} vs prev`} />
              <Kpi label="Success" value={fmtNum(s3.cur.s)} sub={`${fmtSigned(chg(s3.cur.s, s3.prev.s), "%")} vs prev`} />
              <Kpi label="GMV" value={fmtInr(s3.cur.gmv)} sub={`${fmtSigned(chg(s3.cur.gmv, s3.prev.gmv), "%")} vs prev`} />
              <Kpi label="Txn SR" value={fmtPct(s3.curSr)} sub={kpiDelta(s3.curSr, s3.prevSr)} color={s3.prevSr != null && s3.curSr < s3.prevSr - 1 ? C.bad : undefined} />
            </>
          )
        }
        chart={s3 && P && <TrendChart days={P.chart} lines={[{ name: "Txn SR", color: "#34d399", values: s3.sr }]} bars={{ name: "Txns", values: s3.count }} curFrom={curFrom} />}
        cols={s3Cols}
        rows={s3?.rows || []}
      />

      <Section
        n={4}
        title={`Top ${TOP_ERRORS} error codes · remitter bank & PSP`}
        desc={`Non-successful UPI International txns by code (npci_resp_code, else app_resp_code), with payer bank (txn_participants PAYER) and PSP. ▲ red = up ≥ ${TREND_PCT}% vs previous period, ▼ green = down ≥ ${TREND_PCT}%, NEW = absent before.`}
        job={jobs.errors}
        cached={cache.errors}
        onShowSql={() => showSql("errors")}
        kpis={
          s4 && (
            <>
              <Kpi label="Non-success txns" value={fmtNum(s4.total)} sub={`${fmtSigned(chg(s4.total, s4.prevTotal), "%")} vs prev`} color={chg(s4.total, s4.prevTotal) >= TREND_PCT ? C.bad : undefined} />
              <Kpi label="Rising codes" value={s4.rising.length} color={s4.rising.length ? C.bad : undefined} sub={`of top ${s4.items.length}`} />
              <Kpi label="Falling codes" value={s4.falling.length} color={s4.falling.length ? C.good : undefined} sub={`of top ${s4.items.length}`} />
            </>
          )
        }
        note={
          s4 &&
          (s4.rising.length > 0 || s4.falling.length > 0) && (
            <>
              {s4.rising.length > 0 && (
                <div>
                  <b style={{ color: C.bad }}>▲ Increasing:</b> {s4.rising.map((i) => `${i.code} (${i.trend.kind === "new" ? "new" : fmtSigned(i.trend.pct, "%", 0)}, ${fmtNum(i.c)})`).join(" · ")}
                </div>
              )}
              {s4.falling.length > 0 && (
                <div style={{ marginTop: 3 }}>
                  <b style={{ color: C.good }}>▼ Decreasing:</b> {s4.falling.map((i) => `${i.code} (${fmtSigned(i.trend.pct, "%", 0)}, ${fmtNum(i.c)})`).join(" · ")}
                </div>
              )}
            </>
          )
        }
        chart={
          s4 &&
          P && (
            <TrendChart
              days={P.chart}
              lines={codeSel.map((code, i) => ({ name: code, color: SERIES[i % SERIES.length], values: s4.items.find((x) => x.code === code)?.daily || [] }))}
              yFmt={(v) => (v == null ? "—" : fmtNum(v))}
              curFrom={curFrom}
            />
          )
        }
        cols={s4Cols}
        rows={s4Rows}
      />

      <Section
        n={5}
        title="Txn SR country wise"
        desc={`UPI International txns by merchant country (extended_info.countryCode). SR = (SUCCESS + DEEMED) / (SUCCESS + FAILURE + DEEMED + PENDING). Fixed periods: Yesterday ${qy}, D-2 ${qd2}, L7D ${ql7} — the range picker only changes the chart and the Trend column.`}
        job={jobs.countries}
        cached={cache.countries}
        onShowSql={() => showSql("countries")}
        kpis={
          s5 && (
            <>
              <Kpi label="Countries yesterday" value={s5.items.filter((i) => i.y > 0).length} />
              <Kpi label="Yesterday SR" value={fmtPct(s5.total.ysr, 2)} sub={`${fmtSigned(s5.total.dpp, " pp")} vs L7D`} color={s5.total.dpp != null && s5.total.dpp < -1 ? C.bad : undefined} />
              <Kpi label="Top country" value={s5.items[0] ? countryLabel(s5.items[0].country) : "—"} sub={s5.items[0] && s5.total.y ? `${fmtPct(pct(s5.items[0].y, s5.total.y))} of yesterday's txns` : undefined} />
            </>
          )
        }
        chart={
          s5 &&
          P && (
            <TrendChart
              days={P.chart}
              lines={countrySel.map((c, i) => ({ name: countryLabel(c), color: SERIES[i % SERIES.length], values: P.chart.map((d) => s5.srOf(c, d)) }))}
              curFrom={curFrom}
            />
          )
        }
        cols={s5Cols}
        rows={s5Rows}
      />

      <Section
        n={6}
        title={`Error code wise count (top ${TOP_APP_CODES})`}
        desc={`FAILURE txns by app_resp_code (blank codes excluded), ranked by yesterday's count. Fixed periods: Yesterday ${qy}, D-2 ${qd2}, L7D ${ql7}. ▲ red = up ≥ ${TREND_PCT}%, ▼ green = down ≥ ${TREND_PCT}%.`}
        job={jobs.errors}
        cached={cache.errors}
        onShowSql={() => showSql("errors")}
        kpis={
          s6 && (
            <>
              <Kpi label="Failures yesterday" value={fmtNum(s6.total.y)} sub={`${fmtSigned(s6.total.vsL7.pct, "%", 0)} vs L7D avg`} color={s6.total.vsL7.kind === "up" ? C.bad : undefined} />
              <Kpi label="Codes up vs L7D" value={s6.items.filter((i) => i.vsL7.kind === "up" || i.vsL7.kind === "new").length} color={C.bad} />
              <Kpi label="Codes down vs L7D" value={s6.items.filter((i) => i.vsL7.kind === "down").length} color={C.good} />
            </>
          )
        }
        cols={s6Cols}
        rows={s6Rows}
      />
      <IntlDeepDive cache={cache} jobs={jobs} P={P} handleSel={handleSel} codeInfo={view?.codeInfo} notes={view?.notes} onShowSql={showSql} onRun={(q) => refresh(q)} onStop={(q) => stopRun(q)} />
      <IntlExplore cached={cache.txn_detail} job={jobs.txn_detail} P={P} handleSel={handleSel} codeInfo={view?.codeInfo} onShowSql={() => showSql("txn_detail")} onRun={() => refresh("txn_detail")} onStop={() => stopRun("txn_detail")} />
        </>
      )}

      {sql && (
        <div
          onClick={() => setSql(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(900px, 92vw)", maxHeight: "80vh", overflow: "auto", padding: 16 }}
          >
            <div style={{ display: "flex", marginBottom: 8 }}>
              <div style={{ flex: 1, fontWeight: 700 }}>SQL · {sql.query}</div>
              <button type="button" style={btn(false)} onClick={() => setSql(null)}>
                Close
              </button>
            </div>
            <pre style={{ margin: 0, fontSize: 12, color: C.text2, whiteSpace: "pre-wrap" }}>{sql.sql}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
