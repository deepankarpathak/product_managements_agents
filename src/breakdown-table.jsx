import { useEffect, useMemo, useState } from "react";
import { ALERT_RULES, buildBreakdown } from "./breakdown-math.mjs";

// BreakdownTable — impact-ranked SR triage table (one dimension at a time).
// Shared by SR Snippet and Morning Dashboard. All math lives in breakdown-math.mjs
// (also used by the backend for alerts), see that file for column definitions.

export const BREAKDOWN_KINDS = [
  { id: "psp", label: "Payee PSP" },
  { id: "bank", label: "Payer bank" },
  { id: "instrument", label: "Payer instrument" },
];

const METRICS = [
  { id: "sr", label: "SR" },
  { id: "success", label: "Success" },
  { id: "failure", label: "Failure" },
  { id: "total", label: "Overall txns" },
];

const C = {
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#34d399",
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#fab219",
  rowWarn: "rgba(250,178,25,0.07)",
  rowCrit: "rgba(239,68,68,0.10)",
};

// ─── formatting ──────────────────────────────────────────────────────────────

const fmtPct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtSigned = (v, unit, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** Per-row numbers for a focused decline code: latest day, Δ vs D-1 / L7D avg, daily trend. */
function focusStats(r, code, days) {
  const byDay = r.codeByDay[code] || {};
  const at = (d) => byDay[d] || 0;
  const now = at(days.now);
  const d1 = at(days.d1);
  const l7 = days.trend.slice(-8, -1).reduce((s, d) => s + at(d), 0) / 7;
  const focusTrend = days.trend.map(at);
  return {
    focus: now,
    focusD1Δ: d1 > 0 ? ((now - d1) * 100) / d1 : null,
    focusAvgΔ: l7 > 0 ? ((now - l7) * 100) / l7 : null,
    focusTrend,
    focusMax: Math.max(...focusTrend),
  };
}

// SR / success / volume deltas are good when up; failure deltas are good when down.
const toneOf = (v, goodWhenUp, eps = 0.005) => {
  if (v == null || Math.abs(v) < eps) return C.text2;
  return (v > 0) === goodWhenUp ? C.good : C.bad;
};

// ─── UI ──────────────────────────────────────────────────────────────────────

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
  zIndex: 1,
  cursor: "pointer",
  userSelect: "none",
};
const td = {
  padding: "7px 10px",
  textAlign: "right",
  fontSize: 13,
  borderBottom: `1px solid ${C.border}`,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  verticalAlign: "top",
};
const stickyLeft = { position: "sticky", left: 0, textAlign: "left", zIndex: 2 };

const pill = (active) => ({
  padding: "5px 11px",
  borderRadius: 6,
  border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? "rgba(52,211,153,0.12)" : "transparent",
  color: active ? C.accent : C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
});

function Badge({ level }) {
  if (!level) return null;
  const crit = level === "CRIT";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 6px",
        borderRadius: 4,
        background: crit ? C.bad : C.warn,
        color: crit ? "#fff" : "#2a1a00",
        letterSpacing: 0.4,
      }}
    >
      {level}
    </span>
  );
}

function Kpi({ label, value, sub: subText, color, title }) {
  return (
    <div title={title} style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", minWidth: 130 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text, fontVariantNumeric: "tabular-nums", marginTop: 2 }}>{value}</div>
      {subText && <div style={{ fontSize: 11, color: C.text2, marginTop: 1 }}>{subText}</div>}
    </div>
  );
}

/** Daily failures for one code, oldest → newest. Last point = latest day. */
function Spark({ values, color = C.warn, w = 96, h = 26 }) {
  const max = Math.max(1, ...values.map((v) => v || 0));
  const step = values.length > 1 ? (w - 4) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [2 + i * step, h - 2 - ((v || 0) / max) * (h - 4)]);
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} style={{ display: "block", marginLeft: "auto" }}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={2.5} fill={color} />}
    </svg>
  );
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * rows: breakdown cache rows. yday: latest complete day. handleSel: "all" | handle.
 * header: optional node rendered at the right of the toolbar (job badge, SQL button…).
 */
/**
 * kinds: tabs to show (default PSP / bank / instrument). showKpis: KPI strip on top.
 * labelOf(kind, dim): optional display name (e.g. IFSC prefix → bank name).
 * onCodeClick(code): decline-code click (default: focus this table on that code).
 * focusCode: show which rows drive this code (adds count + trend columns, filters, sorts by it).
 * Typing an exact code in the filter box focuses on it the same way.
 */
export default function BreakdownTable({
  rows,
  yday,
  handleSel = "all",
  header = null,
  fileTag = "breakdown",
  kinds = BREAKDOWN_KINDS,
  showKpis = true,
  labelOf = null,
  onCodeClick = null,
  focusCode = null,
  onClearFocus = null,
  // Optional: make row names clickable — onDimClick(kind, dim). Overall is never clickable.
  onDimClick = null,
}) {
  const [kind, setKind] = useState(kinds[0].id);
  const [metric, setMetric] = useState("sr");
  const [filter, setFilter] = useState("");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [sort, setSort] = useState({ key: "impact", dir: 1 });

  // Row + alert counts for every tab (cheap: SR metric, same rows).
  const perKind = useMemo(() => {
    if (!yday) return {};
    return Object.fromEntries(
      kinds.map((k) => {
        const b = buildBreakdown(rows, { kind: k.id, handleSel, yday, metric });
        return [k.id, b];
      }),
    );
  }, [rows, yday, handleSel, metric, kinds]);

  const cur = perKind[kind];
  // An exact decline code in the filter box acts like a code click: focus mode.
  const typedCode = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !cur) return null;
    for (const r of [cur.overall, ...cur.rows]) for (const c of Object.keys(r.codeByDay)) if (c.toLowerCase() === q) return c;
    return null;
  }, [filter, cur]);
  const focus = focusCode || typedCode;
  const clearFocus = focusCode ? onClearFocus : typedCode ? () => setFilter("") : null;
  // A new focus code re-sorts by that code's failures.
  useEffect(() => {
    setSort(focus ? { key: "focus", dir: -1 } : { key: "impact", dir: 1 });
  }, [focus]);
  const nameOf = (dim) => (labelOf ? labelOf(kind, dim) : null);
  const isSr = metric === "sr";
  const fmtVal = isSr ? fmtPct : fmtNum;
  const dUnit = isSr ? "pp" : "%";
  const goodUp = metric !== "failure";

  const visible = useMemo(() => {
    if (!cur) return [];
    const q = typedCode ? "" : filter.trim().toLowerCase();
    const list = cur.rows
      .map((r) => (focus ? { ...r, ...focusStats(r, focus, cur.days) } : r))
      .filter((r) => !focus || r.focus > 0 || r.focusTrend.some((v) => v > 0))
      .filter((r) => (!alertsOnly || r.alert) && (!q || r.dim.toLowerCase().includes(q) || (nameOf(r.dim) || "").toLowerCase().includes(q) || r.top.some(([c]) => c.toLowerCase().includes(q))));
    const val = (r) => (sort.key === "dim" ? r.dim : r[sort.key]);
    return list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, filter, alertsOnly, sort, focus, typedCode, labelOf, kind]);

  if (!yday || !cur) {
    return <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>No breakdown data yet — click Refresh.</div>;
  }

  const { days, overall } = cur;
  const dayCols = [
    { key: "d1", label: "D-1", day: days.d1 },
    { key: "d2", label: "D-2", day: days.d2 },
    { key: "d3", label: "D-3", day: days.d3 },
    { key: "lw", label: "LW", day: days.lw, hint: "same weekday last week" },
  ];
  const mLabel = METRICS.find((m) => m.id === metric).label;

  const cols = [
    { key: "now", label: `${mLabel} now`, title: `${mLabel} on ${fmtDay(days.now)}` },
    ...dayCols.map((c) => ({
      key: `${c.key}Δ`,
      label: c.label,
      title: `${mLabel} on ${fmtDay(c.day)}${c.hint ? ` (${c.hint})` : ""}; below: now − that day (${dUnit})`,
      sub: `${isSr ? "SR" : mLabel} · Δ now`,
    })),
    { key: "dsr", label: "Δ SR vs avg", title: "SR now − SR over the 7 days before (L7D), pp" },
    { key: "volΔ", label: "Vol Δ vs avg", title: "Volume now vs L7D daily average, %" },
    { key: "lost", label: "Lost txns", title: "max(0, SR_L7D − SR now) × volume now — failures above normal" },
    { key: "impact", label: "Overall impact", title: "Volume now × (SR now − SR_L7D) ÷ total volume now. Contribution to overall SR change (pp)." },
    ...(focus
      ? [
          { key: "focus", label: `${focus} fails`, title: `Failures with ${focus} on ${fmtDay(days.now)}; below: share of the row's failures` },
          { key: "focusD1Δ", label: `${focus} vs D-1`, title: `${focus} failures now vs ${fmtDay(days.d1)}, %; below: vs L7D daily average` },
          { key: "focusMax", label: `${focus} trend`, title: `${focus} failures per day, ${fmtDay(days.trend[0])} → ${fmtDay(days.now)} (hover for daily counts)` },
        ]
      : []),
  ];

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "dim" ? 1 : key === "impact" || key === "dsr" ? 1 : -1 }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const exportCsv = () => {
    const head = [
      "Dimension",
      `${mLabel} now`,
      ...dayCols.flatMap((c) => [`${c.label} (${c.day})`, `${c.label} Δ now (${dUnit})`]),
      "Δ SR vs avg (pp)",
      "Vol Δ vs avg (%)",
      "Lost txns",
      "Overall impact (pp)",
      ...(focus ? days.trend.map((d) => `${focus} ${d}`) : []),
      "Top decline codes",
      "Alert",
    ];
    const line = (r) =>
      [
        nameOf(r.dim) ? `${r.dim} (${nameOf(r.dim)})` : r.dim,
        r.now?.toFixed(isSr ? 2 : 0),
        ...dayCols.flatMap((c) => [r[c.key]?.toFixed(isSr ? 2 : 0), r[`${c.key}Δ`]?.toFixed(2)]),
        r.dsr?.toFixed(2),
        r.volΔ?.toFixed(1),
        r.lost != null ? Math.round(r.lost) : "",
        r.impact?.toFixed(3),
        ...(focus ? focusStats(r, focus, days).focusTrend : []),
        r.top.map(([c, n]) => `${c} ${n}`).join(" · "),
        r.alert || "",
      ]
        .map(csvCell)
        .join(",");
    const csv = [head.map(csvCell).join(","), ...visible.map(line), line(overall)].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `${fileTag}-${kind}-${metric}-${days.now}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const alerts = Object.fromEntries(Object.entries(perKind).map(([k, b]) => [k, b.rows.filter((r) => r.alert).length]));
  const critCount = cur.rows.filter((r) => r.alert === "CRIT").length;
  const warnCount = cur.rows.filter((r) => r.alert === "WARN").length;

  const renderRow = (r0, isOverall) => {
    const r = isOverall && focus ? { ...r0, ...focusStats(r0, focus, days) } : r0;
    const bg = isOverall ? C.card2 : r.alert === "CRIT" ? C.rowCrit : r.alert === "WARN" ? C.rowWarn : undefined;
    const stickyBg = isOverall ? C.card2 : C.card;
    return (
      <tr key={isOverall ? "__overall__" : r.dim} style={{ background: bg, fontWeight: isOverall ? 700 : 400 }}>
        <td
          style={{
            ...td,
            ...stickyLeft,
            background: bg ? `linear-gradient(${bg}, ${bg}), ${stickyBg}` : stickyBg,
            color: C.text,
            fontWeight: 600,
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={r.dim}
        >
          {onDimClick && !isOverall ? (
            <span
              role="button"
              tabIndex={0}
              onClick={() => onDimClick(kind, r.dim)}
              onKeyDown={(e) => e.key === "Enter" && onDimClick(kind, r.dim)}
              style={{ cursor: "pointer", textDecoration: "underline dotted", textUnderlineOffset: 3 }}
              title={`Show ${r.dim}'s decline codes in B`}
            >
              {r.dim}
            </span>
          ) : (
            r.dim
          )}
          {isOverall && (filter.trim() || focus || alertsOnly) && (
            <span style={{ fontSize: 11, color: C.text2, fontWeight: 400 }} title="Overall is not filtered: SR, lost txns and impact cover every row and every code">
              {" "}
              · all rows, unfiltered
            </span>
          )}
          {nameOf(r.dim) && <span style={{ fontSize: 11, color: C.text2, fontWeight: 400 }}> · {nameOf(r.dim)}</span>}
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{fmtNum(r.vol)} txns</div>
        </td>
        <td style={{ ...td, color: C.text, fontWeight: 700 }}>{fmtVal(r.now)}</td>
        {dayCols.map((c) => {
          const d = r[`${c.key}Δ`];
          return (
            <td key={c.key} style={td}>
              <div style={{ color: C.text }}>{fmtVal(r[c.key])}</div>
              <div style={{ fontSize: 11, color: toneOf(d, goodUp) }}>{fmtSigned(d, dUnit)}</div>
            </td>
          );
        })}
        <td style={{ ...td, color: toneOf(r.dsr, true), fontWeight: 600 }}>{fmtSigned(r.dsr, "pp")}</td>
        <td style={{ ...td, color: C.text2 }}>{fmtSigned(r.volΔ, "%", 1)}</td>
        <td style={{ ...td, color: r.lost > 0 ? C.text : C.muted }}>{r.lost > 0.5 ? fmtNum(r.lost) : "—"}</td>
        <td style={{ ...td, color: toneOf(r.impact, true, 0.0005), fontWeight: 600 }}>{fmtSigned(r.impact, "pp", 3)}</td>
        {focus && (
          <>
            <td style={{ ...td, color: C.warn, fontWeight: 600 }}>
              {fmtNum(r.focus)}
              {r.failures > 0 && <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{((r.focus * 100) / r.failures).toFixed(1)}% of row fails</div>}
            </td>
            <td style={{ ...td, color: toneOf(r.focusD1Δ, false, 0.05), fontWeight: 600 }}>
              {fmtSigned(r.focusD1Δ, "%", 1)}
              <div style={{ fontSize: 11, color: toneOf(r.focusAvgΔ, false, 0.05), fontWeight: 400 }}>{fmtSigned(r.focusAvgΔ, "%", 1)} vs avg</div>
            </td>
            <td
              style={td}
              title={days.trend.map((d, i) => `${fmtDay(d)}: ${fmtNum(r.focusTrend[i])}${r.totalByDay[d] ? ` (${((r.focusTrend[i] * 100) / r.totalByDay[d]).toFixed(2)}% of txns)` : ""}`).join("\n")}
            >
              <Spark values={r.focusTrend} />
            </td>
          </>
        )}
        <td style={{ ...td, textAlign: "left", fontSize: 12, color: C.text2 }}>
          {r.top.length ? (
            r.top.map(([code, n], i) => (
              <span key={code}>
                {i > 0 && <span style={{ color: C.muted }}> · </span>}
                <span
                  style={{ color: C.text, cursor: "pointer", textDecoration: "underline dotted" }}
                  title={onCodeClick ? `Show ${code} in the decline-code table` : `Show every row with ${code} failures and its daily trend`}
                  onClick={() => (onCodeClick ? onCodeClick(code) : setFilter(code))}
                >
                  {code}
                </span>{" "}
                {fmtNum(n)}
              </span>
            ))
          ) : (
            <span style={{ color: C.muted }}>—</span>
          )}
        </td>
        <td style={{ ...td, textAlign: "center" }}>
          <Badge level={r.alert} />
        </td>
      </tr>
    );
  };

  return (
    <div>
      {/* KPI strip */}
      {showKpis && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
          <Kpi label={`Overall SR · ${fmtDay(days.now)}`} value={fmtPct(overall.srNow)} sub={`${fmtNum(overall.vol)} txns`} />
          <Kpi label="Δ vs L7D" value={fmtSigned(overall.dsr, "pp")} color={toneOf(overall.dsr, true)} title="Overall SR now − overall SR over L7D" />
          <Kpi
            label="Rate vs mix"
            value={`${fmtSigned(overall.rate, "pp")} / ${fmtSigned(overall.mix, "pp")}`}
            sub="rows got worse / traffic shifted"
            title="Rate = Σ row impact (SR changed within rows). Mix = remainder (volume shifted between rows with different SR)."
          />
          <Kpi label="Lost txns" value={fmtNum(overall.lost)} sub="vs L7D SR, all rows" />
          <Kpi
            label="Alerts"
            value={
              <span>
                <span style={{ color: critCount ? C.bad : C.muted }}>{critCount} CRIT</span>
                <span style={{ color: C.muted }}> · </span>
                <span style={{ color: warnCount ? C.warn : C.muted }}>{warnCount} WARN</span>
              </span>
            }
            title={ALERT_RULES.map((r) => `${r.level}: Δ SR ≤ ${r.dsr}pp AND impact ≤ ${r.impact}pp`).join("\n")}
          />
        </div>
      )}

      {/* toolbar */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "10px 16px", borderBottom: `1px solid ${C.border}` }}>
        {kinds.map((k) => (
          <button key={k.id} type="button" style={pill(kind === k.id)} onClick={() => setKind(k.id)}>
            {k.label}
            <span style={{ marginLeft: 6, fontSize: 10, color: C.muted }}>{perKind[k.id]?.rows.length ?? 0}</span>
            {alerts[k.id] > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: C.warn }}>⚠{alerts[k.id]}</span>}
          </button>
        ))}
        <span style={{ width: 1, height: 20, background: C.border, margin: "0 6px" }} />
        {METRICS.map((m) => (
          <button key={m.id} type="button" style={pill(metric === m.id)} onClick={() => setMetric(m.id)}>
            {m.label}
          </button>
        ))}
        {focus && (
          <span style={{ ...pill(true), borderColor: C.warn, color: C.warn, background: "rgba(250,178,25,0.10)", cursor: "default" }}>
            Drivers of {focus}
            {clearFocus && (
              <span style={{ marginLeft: 6, cursor: "pointer" }} onClick={clearFocus} title="Clear">
                ✕
              </span>
            )}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter name / code…"
          style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: "5px 9px", width: 170 }}
        />
        <label style={{ fontSize: 12, color: C.text2, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={alertsOnly} onChange={(e) => setAlertsOnly(e.target.checked)} />
          Alerts only
        </label>
        <button type="button" style={pill(false)} onClick={exportCsv} title="Download visible rows as CSV (opens in Excel)">
          ⬇ Excel
        </button>
        {header}
      </div>

      {/* table */}
      <div style={{ overflow: "auto", maxHeight: 560 }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ ...th, ...stickyLeft, zIndex: 3 }} onClick={() => toggleSort("dim")}>
                {kinds.find((k) => k.id === kind)?.label}
                {arrow("dim")}
              </th>
              {cols.map((c) => (
                <th key={c.key} style={th} title={c.title} onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {arrow(c.key)}
                  {c.sub && <div style={{ fontSize: 9, color: C.muted, fontWeight: 500, textTransform: "none" }}>{c.sub}</div>}
                </th>
              ))}
              <th style={{ ...th, textAlign: "left", cursor: "default" }} title={`Top failure codes on ${fmtDay(days.now)} (click a code to filter)`}>
                Top decline codes
              </th>
              <th style={{ ...th, cursor: "default" }} />
            </tr>
          </thead>
          <tbody>
            {visible.length ? (
              visible.map((r) => renderRow(r, false))
            ) : (
              <tr>
                <td colSpan={cols.length + 3} style={{ ...td, textAlign: "center", color: C.muted, padding: 20 }}>
                  {focus ? `No ${kinds.find((k) => k.id === kind)?.label} row has ${focus} failures.` : alertsOnly ? "No alerts 🎉" : "No rows match the filter."}
                </td>
              </tr>
            )}
            {renderRow(overall, true)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
