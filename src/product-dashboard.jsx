import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Product Wise dashboard — per-product health for Paytm TPAP handles
// (PTYES, PTAXIS, PTSBI, PTHDFC). UPI International, UPI Plugin (@yesnext, see
// PluginView) and UPI Lite (all PSPs, see LiteView); Mandates later.
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
  { id: "mandates", label: "🔁 Mandates", soon: true },
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
function Table({ cols, rows, maxHeight }) {
  return (
    <div style={{ overflowX: "auto", ...(maxHeight ? { maxHeight, overflowY: "auto" } : {}) }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ ...th, textAlign: c.align || "right", ...(maxHeight ? { position: "sticky", top: 0, zIndex: 1 } : {}) }} title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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

function Spark({ values, color, curFrom = 0 }) {
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

function Section({ n, title, desc, job, cached, kpis, chart, cols, rows, note, onShowSql, tableMaxHeight }) {
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
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{desc}</div>
        </div>
        <JobBadge job={job} cached={cached} />
        <button type="button" onClick={copy} style={btn(false)} disabled={!rows.length}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onShowSql} style={btn(false)}>
          SQL
        </button>
      </div>
      {job?.status === "error" && (
        <div style={{ padding: "8px 16px", color: C.bad, fontSize: 12, borderBottom: `1px solid ${C.border}` }}>Last run failed: {job.error}</div>
      )}
      {rows.length ? (
        <>
          {kpis && <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "12px 16px 0" }}>{kpis}</div>}
          {note && <div style={{ padding: "10px 16px 0", fontSize: 12, color: C.text2 }}>{note}</div>}
          {chart}
          <Table cols={cols} rows={rows} maxHeight={tableMaxHeight} />
        </>
      ) : (
        <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>
          {job?.status === "running" ? "Running on Trino…" : "No data yet — click Refresh."}
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

function PluginView({ cached, job, onShowSql }) {
  const [trend, setTrend] = useState(30);
  const rows = useMemo(() => cached?.rows || [], [cached]);
  // IST today; the cache window's toDate is tomorrow when data was fetched.
  const today = toDay(toMs(toDay(Date.now() + 330 * 60000)));
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
// Daily queries (trend, codes, mandate) cover the last 120 complete days; the trend filter
// picks how many of those the charts and tables show. Snapshot queries (accounts, autopay,
// shield) hold one row set per daily run (asOf = run date), so KPIs compare against the
// previous run. Yesterday = latest day in the data, D-2 = the day before.

const LITE_TRENDS = [4, 7, 15, 30, 60, 90, 120];
const LITE_DEFAULT_TREND = 30;
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
      return { id: k, key: k, c: v.txn_init, share, y: at(k, y), ys, d2s: shareAt(k, d2), dpp: ys != null && share != null ? ys - share : null, daily: days.map((d) => shareAt(k, d)) };
    });
  return { items, total, success: { share: pct(byKey.get("SUCCESS")?.txn_init || 0, total), ys: shareAt("SUCCESS", y) } };
}

function LiteView({ cache, jobs, onShowSql }) {
  const [trend, setTrend] = useState(LITE_DEFAULT_TREND);
  const [errScope, setErrScope] = useState("all");
  const [typePick, setTypePick] = useState(null);
  const [codePick, setCodePick] = useState(null);
  const [catPick, setCatPick] = useState(null);
  useEffect(() => {
    setTypePick(null);
    setCodePick(null);
    setCatPick(null);
  }, [trend, errScope]);
  const toggle = (sel, setSel, defaults, id) => {
    const base = sel || defaults;
    setSel(base.includes(id) ? base.filter((x) => x !== id) : [...base, id]);
  };

  const trendRows = useMemo(() => cache.trend?.rows || [], [cache]);
  const codeRows = useMemo(() => (cache.codes?.rows || []).filter((r) => errScope === "all" || r.lite), [cache, errScope]);
  const mandRows = useMemo(() => cache.mandate?.rows || [], [cache]);

  // Trend days: the last `trend` days ending on the latest day present in the daily data.
  const allDays = useMemo(() => {
    let first = "";
    let last = "";
    for (const q of ["trend", "codes", "mandate"]) {
      for (const r of cache[q]?.rows || []) {
        if (r.ts > last) last = r.ts;
        if (!first || r.ts < first) first = r.ts;
      }
    }
    if (!last) return [];
    const win = cache.trend?.window || cache.codes?.window || cache.mandate?.window;
    return daysBetween(win?.fromDate && win.fromDate < first ? win.fromDate : first, toDay(toMs(last) + DAY));
  }, [cache]);
  const days = useMemo(() => allDays.slice(-trend), [allDays, trend]);
  const yd = days[days.length - 1];
  const d2d = days[days.length - 2];
  const span = days.length ? `${fmtDay(days[0])} – ${fmtDay(yd)}` : "—";

  // ── Sections 2–6: per-day metrics from the summary table ──
  const daily = useMemo(() => {
    const z = { act: 0, actM: 0, top: 0, topM: 0, dereg: 0, liteS: 0, liteI: 0, s: 0, i: 0 };
    const m = new Map();
    for (const r of trendRows) {
      let o = m.get(r.ts);
      if (!o) m.set(r.ts, (o = { ...z }));
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
    const g = (d) => m.get(d) || z;
    const tot = days.reduce((a, d) => Object.fromEntries(Object.keys(z).map((k) => [k, a[k] + g(d)[k]])), { ...z });
    const series = (f) => days.map((d) => f(g(d)));
    return { g, tot, series };
  }, [trendRows, days]);
  const { g } = daily;
  const T = daily.tot;
  const Y = g(yd);
  const D2 = g(d2d);
  const vsD2 = (a, b) => `${fmtSigned(chg(a, b), "%", 0)} vs D-2`;
  const ppVs = (a, b, what) => (a != null && b != null ? `${fmtSigned(a - b, " pp")} vs ${what}` : undefined);
  const dayRows = (f) => [...days].reverse().map((d) => ({ id: d, d, ...f(g(d)) }));
  const dateCol = { key: "d", label: "Date", align: "left", render: (r) => (r._total ? `Range (${days.length}d)` : fmtDay(r.d)), text: (r) => (r._total ? "Range" : r.d) };
  const countFmt = (v) => (v == null ? "—" : fmtNum(v));

  // ── Section 1 / 9 / 11: snapshots ──
  const accSnaps = useMemo(() => snapshotsOf(cache.accounts?.rows || []), [cache]);
  const apSnaps = useMemo(() => snapshotsOf(cache.autopay?.rows || []), [cache]);
  const shSnaps = useMemo(() => snapshotsOf(cache.shield?.rows || []), [cache]);
  const lastOf = (s, k = 1) => s[s.length - k]?.rows || [];
  const accNow = lastOf(accSnaps)[0];
  const accPrev = lastOf(accSnaps, 2)[0];
  const apNow = lastOf(apSnaps)[0];
  const apPrev = lastOf(apSnaps, 2)[0];
  const shTotal = (rows) => rows.find((r) => r.split === "TOTAL");
  const shNow = shTotal(lastOf(shSnaps));
  const shPrev = shTotal(lastOf(shSnaps, 2));
  const snapDelta = (a, b, what = "prev run") => (a != null && b != null ? `${fmtSigned(a - b, "", 0)} (${fmtSigned(chg(a, b), "%")}) vs ${what}` : "first snapshot");
  const snapDesc = (s) => (s.length ? `Snapshot as of run ${fmtDay(s[s.length - 1].asOf)} (data up to the day before).` : "");

  // ── Sections 7 / 8: error type and app code share ──
  const types = useMemo(() => shareBreakdown(codeRows, (r) => r.error_type, days, Infinity), [codeRows, days]);
  const codes = useMemo(() => shareBreakdown(codeRows, (r) => r.code, days, LITE_TOP_CODES), [codeRows, days]);
  const typeDefault = types.items.slice(0, LITE_CHART_TOP).map((i) => i.key);
  const typeSel = typePick || typeDefault;
  const codeDefault = codes.items.slice(0, LITE_CHART_TOP).map((i) => i.key);
  const codeSel = codePick || codeDefault;
  const shareCols = (label, sel) => [
    { key: "key", label, align: "left", render: (r) => <span>{sel.includes(r.key) && <span style={{ color: SERIES[sel.indexOf(r.key) % SERIES.length] }}>● </span>}<code style={{ fontSize: 12 }}>{r.key}</code></span>, text: (r) => r.key },
    { key: "c", label: "Txns (range)", title: span, render: (r) => fmtNum(r.c) },
    { key: "share", label: "% of txns (range)", title: span, render: (r) => fmtPct(r.share, 2) },
    { key: "y", label: "Yesterday", title: fmtDay(yd), render: (r) => fmtNum(r.y) },
    { key: "ys", label: "Yesterday %", title: fmtDay(yd), render: (r) => <b>{fmtPct(r.ys, 2)}</b>, text: (r) => fmtPct(r.ys, 2) },
    { key: "d2s", label: "D-2 %", title: fmtDay(d2d), render: (r) => fmtPct(r.d2s, 2) },
    { key: "dpp", label: "vs range", title: "Yesterday % − range %, percentage points", render: (r) => <span style={{ color: r.dpp > 0.05 ? C.bad : r.dpp < -0.05 ? C.good : C.text2 }}>{fmtSigned(r.dpp, " pp", 2)}</span>, text: (r) => fmtSigned(r.dpp, " pp", 2) },
    { key: "daily", label: "Trend", title: `Daily % of txns, ${span}`, render: (r) => <Spark values={r.daily} color={r.dpp > 0.05 ? C.bad : r.dpp < -0.05 ? C.good : "#94a3b8"} />, text: () => "" },
  ];
  const shareChart = (bd, sel) => (
    <TrendChart
      days={days}
      lines={sel.map((k, i) => ({ name: k, color: SERIES[i % SERIES.length], values: bd.items.find((x) => x.key === k)?.daily || days.map(() => null) }))}
      yFmt={(v) => fmtPct(v, 2)}
    />
  );
  const scopePills = (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>Rows</span>
      {[
        ["all", "All summary rows"],
        ["lite", "UPI_LITE payer only"],
      ].map(([k, l]) => (
        <button key={k} type="button" onClick={() => setErrScope(k)} style={pill(errScope === k)}>
          {l}
        </button>
      ))}
    </div>
  );

  // ── Section 10: mandate creation SR by autopay category ──
  const mand = useMemo(() => {
    const daySet = new Set(days);
    const inRange = mandRows.filter((r) => daySet.has(r.ts));
    const byCat = sumBy(inRange, (r) => r.category, ["success", "txn_init"]);
    const byCatDay = sumBy(inRange, (r) => `${r.category}|${r.ts}`, ["success", "txn_init"]);
    const byDay = sumBy(inRange, (r) => r.ts, ["success", "txn_init"]);
    const srAt = (c, d) => {
      const v = byCatDay.get(`${c}|${d}`);
      return v ? pct(v.success, v.txn_init) : null;
    };
    const daySr = (d) => (byDay.get(d) ? pct(byDay.get(d).success, byDay.get(d).txn_init) : null);
    const z = { success: 0, txn_init: 0 };
    const items = [...byCat.entries()]
      .sort((a, b) => b[1].txn_init - a[1].txn_init)
      .map(([c, v]) => {
        const sr = pct(v.success, v.txn_init);
        const yv = byCatDay.get(`${c}|${yd}`) || z;
        const ysr = pct(yv.success, yv.txn_init);
        return { id: c, cat: c, ...v, sr, ys: yv.success, ysr, d2sr: srAt(c, d2d), dpp: ysr != null && sr != null ? ysr - sr : null, daily: days.map((d) => srAt(c, d)) };
      });
    const all = [...byCat.values()].reduce((a, v) => ({ success: a.success + v.success, txn_init: a.txn_init + v.txn_init }), { ...z });
    const yAll = byDay.get(yd) || z;
    const total = { id: "__total", _total: true, cat: "All categories", ...all, sr: pct(all.success, all.txn_init), ys: yAll.success, ysr: pct(yAll.success, yAll.txn_init), d2sr: daySr(d2d), dpp: null };
    total.dpp = total.ysr != null && total.sr != null ? total.ysr - total.sr : null;
    return { items, total, srAt, daySr, success: days.map((d) => byDay.get(d)?.success || 0) };
  }, [mandRows, days, yd, d2d]);
  const catDefault = mand.items.slice(0, LITE_CHART_TOP).map((i) => i.cat);
  const catSel = catPick || catDefault;

  const has = (q) => (cache[q]?.rows || []).length > 0;
  const trendSection = { job: jobs.trend, cached: cache.trend, onShowSql: () => onShowSql("trend"), tableMaxHeight: 420 };

  return (
    <>
      <Section
        n={1}
        title="UPI Lite active account count"
        desc={`Distinct LRNs on ACTIVE Lite accounts (lite_account_snapshot_v3) joined to their PMS user. ${snapDesc(accSnaps)} Each daily run adds a snapshot; the table lists them.`}
        job={jobs.accounts}
        cached={cache.accounts}
        onShowSql={() => onShowSql("accounts")}
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

      <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>Trend</span>
        {LITE_TRENDS.map((n) => (
          <button key={n} type="button" onClick={() => setTrend(n)} style={pill(trend === n)}>
            {n} days
          </button>
        ))}
        <span style={{ fontSize: 11, color: C.muted, marginLeft: 8 }}>{span} · Yesterday = {fmtDay(yd)}</span>
      </div>

      <Section
        n={2}
        title="UPILite Activation & Recharge (DOD)"
        desc="Successful txns per day from team_product.upi_lite_summary. Activation = create_mandate_and_activation + manual_activation; Recurring top-ups = manual_recurring_topup + recurring_mandate_execution."
        {...trendSection}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Activations yesterday" value={fmtNum(Y.act)} sub={vsD2(Y.act, D2.act)} color={C.accent} />
              <Kpi label="Top-ups yesterday" value={fmtNum(Y.top)} sub={vsD2(Y.top, D2.top)} />
              <Kpi label={`Activations · ${days.length}d`} value={fmtNum(T.act)} sub={`${fmtNum(T.act / (days.length || 1))} / day`} />
              <Kpi label={`Top-ups · ${days.length}d`} value={fmtNum(T.top)} sub={`${fmtNum(T.top / (days.length || 1))} / day`} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={days}
              lines={[
                { name: "UPI Lite Activation", color: SERIES[0], values: daily.series((o) => o.act) },
                { name: "Recurring Top ups", color: SERIES[1], values: daily.series((o) => o.top) },
              ]}
              yFmt={countFmt}
            />
          )
        }
        cols={[
          dateCol,
          { key: "act", label: "UPI Lite Activation", render: (r) => fmtNum(r.act) },
          { key: "top", label: "Recurring Top ups", render: (r) => fmtNum(r.top) },
        ]}
        rows={has("trend") ? [...dayRows((o) => ({ act: o.act, top: o.top })), { id: "__total", _total: true, act: T.act, top: T.top }] : []}
      />

      <Section
        n={3}
        title="UPILite Activation & Recharge through Mandate (DOD)"
        desc="Activation through mandate = create_mandate_and_activation / all activations. Recharge through mandate = recurring_mandate_execution / all recurring top-ups. Range values are pooled (sum ÷ sum)."
        {...trendSection}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Activation via mandate · yday" value={fmtPct(pct(Y.actM, Y.act))} sub={ppVs(pct(Y.actM, Y.act), pct(T.actM, T.act), `${days.length}d`)} color={C.accent} />
              <Kpi label="Recharge via mandate · yday" value={fmtPct(pct(Y.topM, Y.top))} sub={ppVs(pct(Y.topM, Y.top), pct(T.topM, T.top), `${days.length}d`)} />
              <Kpi label={`Activation via mandate · ${days.length}d`} value={fmtPct(pct(T.actM, T.act))} sub={`${fmtNum(T.actM)} of ${fmtNum(T.act)}`} />
              <Kpi label={`Recharge via mandate · ${days.length}d`} value={fmtPct(pct(T.topM, T.top))} sub={`${fmtNum(T.topM)} of ${fmtNum(T.top)}`} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={days}
              lines={[
                { name: "UPILite Activation through mandate", color: SERIES[0], values: daily.series((o) => pct(o.actM, o.act)) },
                { name: "UPILite recharge through mandate", color: SERIES[1], values: daily.series((o) => pct(o.topM, o.top)) },
              ]}
            />
          )
        }
        cols={[
          dateCol,
          { key: "actM", label: "Mandate activations", render: (r) => fmtNum(r.actM) },
          { key: "act", label: "All activations", render: (r) => fmtNum(r.act) },
          { key: "actP", label: "Activation via mandate", render: (r) => <b>{fmtPct(pct(r.actM, r.act))}</b>, text: (r) => fmtPct(pct(r.actM, r.act)) },
          { key: "topM", label: "Mandate recharges", render: (r) => fmtNum(r.topM) },
          { key: "top", label: "All top-ups", render: (r) => fmtNum(r.top) },
          { key: "topP", label: "Recharge via mandate", render: (r) => <b>{fmtPct(pct(r.topM, r.top))}</b>, text: (r) => fmtPct(pct(r.topM, r.top)) },
        ]}
        rows={has("trend") ? [...dayRows((o) => ({ act: o.act, actM: o.actM, top: o.top, topM: o.topM })), { id: "__total", _total: true, act: T.act, actM: T.actM, top: T.top, topM: T.topM }] : []}
      />

      <Section
        n={4}
        title="Deregister UPILite (DOD)"
        desc={`Successful '${LITE_DEREGISTER}' txns per day (upi_lite_recharge_txns).`}
        {...trendSection}
        kpis={
          has("trend") && (
            <>
              <Kpi label="Deregistered yesterday" value={fmtNum(Y.dereg)} sub={vsD2(Y.dereg, D2.dereg)} color={chg(Y.dereg, D2.dereg) >= TREND_PCT ? C.bad : undefined} />
              <Kpi label={`Deregistered · ${days.length}d`} value={fmtNum(T.dereg)} sub={`${fmtNum(T.dereg / (days.length || 1))} / day`} />
              <Kpi label="Deregister per activation" value={fmtPct(pct(T.dereg, T.act))} sub={`${days.length}d, deregistrations ÷ activations`} />
            </>
          )
        }
        chart={has("trend") && <TrendChart days={days} lines={[{ name: "Deregister UPI Lite", color: SERIES[6], values: daily.series((o) => o.dereg) }]} yFmt={countFmt} />}
        cols={[dateCol, { key: "dereg", label: "Deregister UPI Lite", render: (r) => fmtNum(r.dereg) }]}
        rows={has("trend") ? [...dayRows((o) => ({ dereg: o.dereg })), { id: "__total", _total: true, dereg: T.dereg }] : []}
      />

      <Section
        n={5}
        title="UPI Lite transaction share"
        desc="UPILite txns = successful txns with payer_instrument UPI_LITE. Share = UPILite txns / all successful txns in upi_lite_summary."
        {...trendSection}
        kpis={
          has("trend") && (
            <>
              <Kpi label="UPILite txns yesterday" value={fmtNum(Y.liteS)} sub={vsD2(Y.liteS, D2.liteS)} color={C.accent} />
              <Kpi label="Share yesterday" value={fmtPct(pct(Y.liteS, Y.s), 2)} sub={ppVs(pct(Y.liteS, Y.s), pct(T.liteS, T.s), `${days.length}d`)} />
              <Kpi label={`UPILite txns · ${days.length}d`} value={fmtNum(T.liteS)} sub={`${fmtNum(T.liteS / (days.length || 1))} / day`} />
              <Kpi label={`Share · ${days.length}d`} value={fmtPct(pct(T.liteS, T.s), 2)} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={days}
              lines={[{ name: "Share of total transactions", color: SERIES[0], values: daily.series((o) => pct(o.liteS, o.s)) }]}
              bars={{ name: "UPILite Txns", values: daily.series((o) => o.liteS) }}
              yFmt={(v) => fmtPct(v, 2)}
            />
          )
        }
        cols={[
          dateCol,
          { key: "liteS", label: "UPILite Txns", render: (r) => fmtNum(r.liteS) },
          { key: "s", label: "All successful txns", render: (r) => fmtNum(r.s) },
          { key: "share", label: "Share of total", render: (r) => <b>{fmtPct(pct(r.liteS, r.s), 2)}</b>, text: (r) => fmtPct(pct(r.liteS, r.s), 2) },
        ]}
        rows={has("trend") ? [...dayRows((o) => ({ liteS: o.liteS, s: o.s })), { id: "__total", _total: true, liteS: T.liteS, s: T.s }] : []}
      />

      <Section
        n={6}
        title="UPI Lite Success Rate"
        desc="UPILite SR = success / txn_init for payer_instrument UPI_LITE. Overall SR = success / txn_init across upi_lite_summary. Red = day UPILite SR more than 5 pp below the range SR."
        {...trendSection}
        kpis={
          has("trend") && (
            <>
              <Kpi label="UPILite SR yesterday" value={fmtPct(pct(Y.liteS, Y.liteI), 2)} sub={ppVs(pct(Y.liteS, Y.liteI), pct(T.liteS, T.liteI), `${days.length}d`)} color={C.accent} />
              <Kpi label="Overall SR yesterday" value={fmtPct(pct(Y.s, Y.i), 2)} sub={ppVs(pct(Y.s, Y.i), pct(T.s, T.i), `${days.length}d`)} />
              <Kpi label={`UPILite SR · ${days.length}d`} value={fmtPct(pct(T.liteS, T.liteI), 2)} sub={ppVs(pct(T.liteS, T.liteI), pct(T.s, T.i), "overall")} />
            </>
          )
        }
        chart={
          has("trend") && (
            <TrendChart
              days={days}
              lines={[
                { name: "UPILite SR %", color: SERIES[1], values: daily.series((o) => pct(o.liteS, o.liteI)) },
                { name: "Overall SR %", color: "#e2e8f0", dashed: true, values: daily.series((o) => pct(o.s, o.i)) },
              ]}
              yFmt={(v) => fmtPct(v, 2)}
            />
          )
        }
        cols={[
          dateCol,
          { key: "liteI", label: "UPILite init", render: (r) => fmtNum(r.liteI) },
          { key: "liteS", label: "UPILite success", render: (r) => fmtNum(r.liteS) },
          {
            key: "liteSr",
            label: "UPILite SR %",
            render: (r) => {
              const v = pct(r.liteS, r.liteI);
              const low = !r._total && v != null && v < pct(T.liteS, T.liteI) - LOW_SR_PP;
              return <b style={{ color: low ? C.bad : C.text }}>{fmtPct(v, 2)}</b>;
            },
            text: (r) => fmtPct(pct(r.liteS, r.liteI), 2),
          },
          { key: "i", label: "All init", render: (r) => fmtNum(r.i) },
          { key: "sr", label: "Overall SR %", render: (r) => fmtPct(pct(r.s, r.i), 2) },
        ]}
        rows={has("trend") ? [...dayRows((o) => ({ liteS: o.liteS, liteI: o.liteI, s: o.s, i: o.i })), { id: "__total", _total: true, liteS: T.liteS, liteI: T.liteI, s: T.s, i: T.i }] : []}
      />

      <Section
        n={7}
        title="UPI Lite error type"
        desc={`txn_init by error_type as a % of the day's txn_init (successful rows count as SUCCESS, shown as a KPI). Click a row to add or remove it from the chart. ▲ red = yesterday's share above the range share.`}
        job={jobs.codes}
        cached={cache.codes}
        onShowSql={() => onShowSql("codes")}
        kpis={
          has("codes") && (
            <>
              <Kpi label="SUCCESS share yesterday" value={fmtPct(types.success.ys, 2)} sub={ppVs(types.success.ys, types.success.share, `${days.length}d`)} color={C.good} />
              <Kpi label="Top error type" value={types.items[0]?.key || "—"} sub={types.items[0] ? `${fmtPct(types.items[0].share, 2)} of txns · ${days.length}d` : undefined} />
              <Kpi label="Types up yesterday" value={types.items.filter((i) => i.dpp > 0.05).length} color={C.bad} sub="share above range" />
            </>
          )
        }
        note={scopePills}
        chart={has("codes") && shareChart(types, typeSel)}
        cols={shareCols("Error type", typeSel)}
        rows={types.items.map((i) => ({ ...i, _active: typeSel.includes(i.key), _onClick: () => toggle(typePick, setTypePick, typeDefault, i.key) }))}
        tableMaxHeight={420}
      />

      <Section
        n={8}
        title={`UPI Lite error codes (top ${LITE_TOP_CODES})`}
        desc={`txn_init by app_resp_code as a % of the day's txn_init, ranked by range volume (SUCCESS excluded). Row filter shared with section 7.`}
        job={jobs.codes}
        cached={cache.codes}
        onShowSql={() => onShowSql("codes")}
        kpis={
          has("codes") && (
            <>
              <Kpi label="Top error code" value={codes.items[0]?.key || "—"} sub={codes.items[0] ? `${fmtPct(codes.items[0].share, 2)} of txns · ${days.length}d` : undefined} />
              <Kpi label="Codes up yesterday" value={codes.items.filter((i) => i.dpp > 0.05).length} color={C.bad} sub={`of top ${codes.items.length}`} />
              <Kpi label="Codes down yesterday" value={codes.items.filter((i) => i.dpp < -0.05).length} color={C.good} sub={`of top ${codes.items.length}`} />
            </>
          )
        }
        note={scopePills}
        chart={has("codes") && shareChart(codes, codeSel)}
        cols={shareCols("App resp code", codeSel)}
        rows={codes.items.map((i) => ({ ...i, _active: codeSel.includes(i.key), _onClick: () => toggle(codePick, setCodePick, codeDefault, i.key) }))}
        tableMaxHeight={420}
      />

      <Section
        n={9}
        title="UPI Lite Autopay"
        desc={`Active Lite autopay = distinct UMNs with mandate_status ACTIVE and an LRN (standing_instructions_snapshot_v3). Revoked = customers with a Lite REVOKE; never re-enabled = no CREATE after their first revoke. ${snapDesc(apSnaps)}`}
        job={jobs.autopay}
        cached={cache.autopay}
        onShowSql={() => onShowSql("autopay")}
        kpis={
          apNow && (
            <>
              <Kpi label="Active Lite Autopay" value={fmtNum(apNow.active)} sub={snapDelta(apNow.active, apPrev?.active)} color={C.accent} />
              <Kpi label="Users who revoked Lite autopay" value={fmtNum(apNow.revoked)} sub={snapDelta(apNow.revoked, apPrev?.revoked)} />
              <Kpi label="Revoked, never re-enabled" value={fmtNum(apNow.never_again)} sub={`${fmtPct(pct(apNow.never_again, apNow.revoked))} of revoked users`} color={C.bad} />
            </>
          )
        }
        cols={[
          { key: "asOf", label: "Snapshot (run date)", align: "left", render: (r) => fmtDay(r.asOf), text: (r) => r.asOf },
          { key: "active", label: "Active Lite Autopay", render: (r) => <b>{fmtNum(r.active)}</b>, text: (r) => String(r.active) },
          { key: "revoked", label: "Users who revoked", render: (r) => fmtNum(r.revoked) },
          { key: "never", label: "Revoked, never re-enabled", render: (r) => fmtNum(r.never_again) },
          { key: "neverP", label: "% never re-enabled", render: (r) => fmtPct(pct(r.never_again, r.revoked)) },
        ]}
        rows={[...apSnaps].reverse().map((s) => ({ id: s.asOf, asOf: s.asOf, ...s.rows[0] }))}
        tableMaxHeight={300}
      />

      <Section
        n={10}
        title="UPI Lite Mandate Creation success rate"
        desc="team_product.lite_autopay_txns by autopay_category. SR = success / txn_init; range SR is pooled. Click a category to add or remove it from the chart."
        job={jobs.mandate}
        cached={cache.mandate}
        onShowSql={() => onShowSql("mandate")}
        kpis={
          has("mandate") && (
            <>
              <Kpi label="Success txns yesterday" value={fmtNum(mand.total.ys)} color={C.accent} />
              <Kpi label="SR yesterday" value={fmtPct(mand.total.ysr, 2)} sub={ppVs(mand.total.ysr, mand.total.sr, `${days.length}d`)} />
              <Kpi label={`Success txns · ${days.length}d`} value={fmtNum(mand.total.success)} sub={`SR ${fmtPct(mand.total.sr, 2)}`} />
            </>
          )
        }
        chart={
          has("mandate") && (
            <TrendChart
              days={days}
              lines={[
                ...catSel.map((c, i) => ({ name: c, color: SERIES[i % SERIES.length], values: days.map((d) => mand.srAt(c, d)) })),
                { name: "Overall", color: "#e2e8f0", dashed: true, values: days.map((d) => mand.daySr(d)) },
              ]}
              bars={{ name: "Success txns", values: mand.success }}
              yFmt={(v) => fmtPct(v, 2)}
            />
          )
        }
        cols={[
          { key: "cat", label: "Autopay category", align: "left", render: (r) => (r._total ? r.cat : <span>{catSel.includes(r.cat) && <span style={{ color: SERIES[catSel.indexOf(r.cat) % SERIES.length] }}>● </span>}{r.cat}</span>), text: (r) => r.cat },
          { key: "success", label: "Success txns", title: span, render: (r) => fmtNum(r.success) },
          { key: "txn_init", label: "Initiated", title: span, render: (r) => fmtNum(r.txn_init) },
          { key: "sr", label: "SR %", title: span, render: (r) => <b>{fmtPct(r.sr, 2)}</b>, text: (r) => fmtPct(r.sr, 2) },
          { key: "ys", label: "Yesterday success", title: fmtDay(yd), render: (r) => fmtNum(r.ys) },
          { key: "ysr", label: "Yesterday SR", title: fmtDay(yd), render: (r) => fmtPct(r.ysr, 2) },
          { key: "d2sr", label: "D-2 SR", title: fmtDay(d2d), render: (r) => fmtPct(r.d2sr, 2) },
          { key: "dpp", label: "vs range", title: "Yesterday SR − range SR, percentage points", render: (r) => <span style={{ color: r.dpp == null || Math.abs(r.dpp) < 0.05 ? C.text2 : r.dpp > 0 ? C.good : C.bad }}>{fmtSigned(r.dpp, " pp")}</span>, text: (r) => fmtSigned(r.dpp, " pp") },
          { key: "daily", label: "Trend", title: `Daily SR, ${span}`, render: (r) => (r._total ? "" : <Spark values={r.daily} color="#94a3b8" />), text: () => "" },
        ]}
        rows={has("mandate") ? [...mand.items.map((i) => ({ ...i, _active: catSel.includes(i.cat), _onClick: () => toggle(catPick, setCatPick, catDefault, i.cat) })), mand.total] : []}
      />

      <Section
        n={11}
        title="UPI Lite users with Security Shield"
        desc={`Users with an ACTIVE Lite account (latest status), by PSP, against their latest Security Shield preference (ups preference 44). ${snapDesc(shSnaps)}`}
        job={jobs.shield}
        cached={cache.shield}
        onShowSql={() => onShowSql("shield")}
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
          { key: "users", label: "Active Lite users", render: (r) => fmtNum(r.users) },
          { key: "enabled", label: "Shield enabled", render: (r) => fmtNum(r.enabled) },
          { key: "enP", label: "Enabled %", render: (r) => <b>{fmtPct(pct(r.enabled, r.users), 2)}</b>, text: (r) => fmtPct(pct(r.enabled, r.users), 2) },
          { key: "not", label: "Not enabled", render: (r) => fmtNum(r.not_enabled) },
          { key: "nopref", label: "No preference record", render: (r) => fmtNum(r.no_pref) },
          { key: "nocust", label: "No customer id", render: (r) => fmtNum(r.no_cust) },
        ]}
        rows={lastOf(shSnaps)
          .map((r) => ({ ...r, id: r.split, _total: r.split === "TOTAL" }))
          .sort((a, b) => (LITE_SPLITS.indexOf(a.split) + 1 || 99) - (LITE_SPLITS.indexOf(b.split) + 1 || 99))}
      />
    </>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

export default function ProductDashboard() {
  const [product, setProduct] = useState("international");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState(DEFAULT_RANGE);
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

  // Poll while a run is in flight.
  useEffect(() => {
    if (!state?.running) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [state?.running, load]);

  const refresh = async () => {
    try {
      await api("/run", { method: "POST", body: JSON.stringify({ product }) });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const showSql = async (query) => {
    try {
      setSql(await api(`/sql?product=${product}&query=${query}`));
    } catch (e) {
      setError(e.message);
    }
  };

  const cache = useMemo(() => state?.cache || {}, [state]);
  const jobs = state?.jobs || {};
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
        meaning: CODE_MEANING[code] || "",
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
  }, [errs, P]);

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
          meaning: CODE_MEANING[code] || "",
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
  }, [errs, P, Q]);

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
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} color={ppTone(r.dpp) === C.text2 ? "#94a3b8" : ppTone(r.dpp)} curFrom={curFrom} />), text: () => "" },
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
        { key: "daily", label: "Daily", title: `Daily failures, ${prevLabel} → ${periodLabel}`, render: (r) => <Spark values={r.daily} color={r.trend.kind === "up" || r.trend.kind === "new" ? C.bad : r.trend.kind === "down" ? C.good : "#94a3b8"} curFrom={curFrom} />, text: () => "" },
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
        { key: "trend", label: "Trend", title: `Daily SR, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} color={ppTone(r.dpp) === C.text2 ? "#94a3b8" : ppTone(r.dpp)} curFrom={curFrom} />), text: () => "" },
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
        { key: "daily", label: "Daily", title: `Daily failures, ${prevLabel} → ${periodLabel}`, render: (r) => (r._total ? "" : <Spark values={r.daily} color={r.vsL7.kind === "up" || r.vsL7.kind === "new" ? C.bad : r.vsL7.kind === "down" ? C.good : "#94a3b8"} curFrom={curFrom} />), text: () => "" },
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
              : product === "lite"
              ? "UPI Lite · all PSPs · last 120 complete days + daily snapshots · source Trino (team_product summaries, tpap_pms / switch / ups snapshots)"
              : `${PRODUCTS.find((p) => p.id === product)?.label.replace(/^\S+\s/, "")} · ${handleLabel} · current ${periodLabel} vs previous ${prevLabel} · source Trino (tpap_pms / switch snapshots)`}
          </div>
        </div>
        <a
          href="/#history?dashboard=product"
          target="_blank"
          rel="noopener noreferrer"
          title="Open run history (query, output, insights) in a new tab"
          style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          🕘 History ↗
        </a>
        <button type="button" onClick={refresh} style={btn(true)} disabled={state?.running}>
          {state?.running ? "Running…" : "↻ Refresh"}
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
        {product === "international" && (
          <>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.muted, marginRight: 4 }}>Range</span>
              {RANGES.map((r) => (
                <button key={r.n} type="button" onClick={() => setRange(r.n)} style={pill(range === r.n)}>
                  {r.label}
                </button>
              ))}
            </div>
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
      {state && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          {product === "plugin"
            ? `Opening this tab only reads cached results (every day since launch, today so far). Backend auto-refreshes ${state.schedule?.join(" & ")}; click Refresh for the latest.`
            : product === "lite"
            ? `Opening this tab only reads cached results (last 120 complete days). Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST; each run also adds a snapshot to sections 1, 9 and 11.`
            : `Opening this tab only reads cached results (last 30 complete days). Backend auto-refreshes daily at ${state.schedule?.join(" & ")} IST. Click a bank / error row to add or remove it from the chart.`}
        </div>
      )}

      {product === "plugin" && <PluginView cached={cache.daily} job={jobs.daily} onShowSql={() => showSql("daily")} />}
      {product === "lite" && <LiteView cache={cache} jobs={jobs} onShowSql={showSql} />}
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
