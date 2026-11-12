// Trend zoom — click any small trendline to see it large with one point per day and a daily table.
// Shared by Today (pm-home.jsx), Unified SR / SR Snippet breakdown (breakdown-table.jsx) and Product Wise (product-dashboard.jsx).
//
// <Zoomable spec={() => spec}>{small sparkline}</Zoomable> makes its child clickable; the spec is built only on click.
// spec = {
//   title, subtitle?,
//   days: ["YYYY-MM-DD", …],                        oldest → newest
//   lines: [{ name, color, values: [num|null, …] }], same length as days
//   fmt: (v) => string,                               value format (table + tooltip)
//   axisFmt?: (v) => string,                          y-axis format (default fmt)
//   unit?: "pct" | "count",                           "pct" → deltas in pp, otherwise in %
//   upIsBad?: boolean,                                colour of deltas (failures up = red)
//   curFrom?: number,                                 index where the current period starts (earlier days shaded)
//   variants?: [{ id, label, spec }],                 extra views (e.g. Count / GMV / All segments)
// }
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const Z = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  grid: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#60a5fa",
  good: "#22c55e",
  bad: "#ef4444",
};

const dayLabel = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
const dayLong = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—");
const mean = (a) => {
  const v = a.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

/** Δ of v vs base: pp for % metrics, % otherwise. */
const delta = (v, base, unit) => (v == null || base == null ? null : unit === "pct" ? v - base : base ? (100 * (v - base)) / base : null);
const fmtDelta = (d, unit) => (d == null ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(unit === "pct" ? 2 : 1)}${unit === "pct" ? " pp" : "%"}`);
const deltaColor = (d, unit, upIsBad) => {
  if (d == null) return Z.muted;
  const lim = unit === "pct" ? 0.3 : 5;
  if (Math.abs(d) < lim) return Z.text2;
  return (d > 0) !== !!upIsBad ? Z.good : Z.bad;
};

export function Zoomable({ spec, children, block = false, title = "Click to zoom — daily values" }) {
  const [open, setOpen] = useState(null);
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          const s = typeof spec === "function" ? spec() : spec;
          if (s?.days?.length) setOpen(s);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            const s = typeof spec === "function" ? spec() : spec;
            if (s?.days?.length) setOpen(s);
          }
        }}
        style={{ cursor: "zoom-in", display: block ? "block" : "inline-block", verticalAlign: "middle" }}
      >
        {children}
      </span>
      {open && <TrendZoom spec={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function TrendZoom({ spec: base, onClose }) {
  const [variantId, setVariantId] = useState(base.variants?.[0]?.id || null);
  const spec = (variantId && base.variants?.find((v) => v.id === variantId)?.spec) || base;
  const [hidden, setHidden] = useState(() => new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const { days, unit, upIsBad } = spec;
  const fmt = spec.fmt || ((v) => (v == null ? "—" : String(v)));
  const lines = spec.lines.filter((l) => !hidden.has(l.name));
  const single = spec.lines.length === 1 ? spec.lines[0] : null;

  // Reference: previous-period average when a current period is marked, else the window average.
  const curFrom = spec.curFrom > 0 ? spec.curFrom : 0;
  const refAvg = single ? mean(curFrom ? single.values.slice(0, curFrom) : single.values) : null;
  const refLabel = curFrom ? "prev-period avg" : `${days.length}-day avg`;

  const csv = () => {
    const head = ["Date", ...spec.lines.map((l) => l.name)];
    const rows = days.map((d, i) => [d, ...spec.lines.map((l) => (l.values[i] == null ? "" : l.values[i]))]);
    return [head, ...rows].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(csv());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const btn = (active) => ({
    background: active ? Z.accent : "transparent",
    color: active ? "#0b1220" : Z.text2,
    border: `1px solid ${active ? Z.accent : Z.border}`,
    borderRadius: 6,
    padding: "3px 9px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  });

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,0.72)", zIndex: 10000, display: "grid", placeItems: "center", padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={spec.title}
        style={{
          background: Z.card,
          border: `1px solid ${Z.border}`,
          borderRadius: 12,
          width: "min(760px, 100%)",
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          padding: 16,
          color: Z.text,
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{spec.title}</div>
            <div style={{ fontSize: 11, color: Z.muted, marginTop: 2 }}>
              {spec.subtitle ? `${spec.subtitle} · ` : ""}
              {dayLabel(days[0])} → {dayLabel(days[days.length - 1])} · {days.length} days
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={copy} style={btn(false)} title="Copy daily values as CSV">
              {copied ? "Copied" : "Copy CSV"}
            </button>
            <button type="button" onClick={onClose} style={btn(false)} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        {base.variants?.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {base.variants.map((v) => (
              <button key={v.id} type="button" onClick={() => setVariantId(v.id)} style={btn(v.id === variantId)}>
                {v.label}
              </button>
            ))}
          </div>
        )}

        {spec.lines.length > 1 && (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
            {spec.lines.map((l) => (
              <button
                key={l.name}
                type="button"
                onClick={() =>
                  setHidden((h) => {
                    const n = new Set(h);
                    n.has(l.name) ? n.delete(l.name) : n.add(l.name);
                    return n;
                  })
                }
                title="Show / hide"
                style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11, color: hidden.has(l.name) ? Z.muted : Z.text2, textDecoration: hidden.has(l.name) ? "line-through" : "none" }}
              >
                <span style={{ width: 14, height: 3, borderRadius: 2, background: l.color, opacity: hidden.has(l.name) ? 0.3 : 1 }} />
                {l.name}
              </button>
            ))}
          </div>
        )}

        <ZoomChart days={days} lines={lines} fmt={fmt} axisFmt={spec.axisFmt || fmt} curFrom={curFrom} refAvg={refAvg} refLabel={refLabel} />

        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr>
                <th style={th("left")}>Date</th>
                {single ? (
                  <>
                    <th style={th()}>{single.name}</th>
                    <th style={th()}>Δ vs prev day</th>
                    <th style={th()} title="Average of the 7 days before">Δ vs 7d avg</th>
                  </>
                ) : (
                  spec.lines.map((l) => (
                    <th key={l.name} style={th()}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: l.color, marginRight: 5 }} />
                      {l.name}
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {days
                .map((d, i) => ({ d, i }))
                .reverse()
                .map(({ d, i }) => {
                  const prevPeriod = curFrom && i < curFrom;
                  if (single) {
                    const v = single.values[i];
                    const dPrev = delta(v, i > 0 ? single.values[i - 1] : null, unit);
                    const dAvg = delta(v, mean(single.values.slice(Math.max(0, i - 7), i)), unit);
                    return (
                      <tr key={d} style={{ opacity: prevPeriod ? 0.7 : 1 }}>
                        <td style={tdc("left")}>{dayLong(d)}</td>
                        <td style={{ ...tdc(), fontWeight: i === days.length - 1 ? 700 : 400 }}>{fmt(v)}</td>
                        <td style={{ ...tdc(), color: deltaColor(dPrev, unit, upIsBad) }}>{fmtDelta(dPrev, unit)}</td>
                        <td style={{ ...tdc(), color: deltaColor(dAvg, unit, upIsBad) }}>{i === 0 ? "—" : fmtDelta(dAvg, unit)}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={d} style={{ opacity: prevPeriod ? 0.7 : 1 }}>
                      <td style={tdc("left")}>{dayLong(d)}</td>
                      {spec.lines.map((l) => (
                        <td key={l.name} style={tdc()}>
                          {fmt(l.values[i])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 10, color: Z.muted, marginTop: 8 }}>Esc or click outside to close.{curFrom ? " Shaded / dimmed = previous period." : ""}</div>
      </div>
    </div>,
    document.body,
  );
}

const th = (align = "right") => ({ textAlign: align, padding: "6px 8px", color: Z.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${Z.border}`, whiteSpace: "nowrap" });
const tdc = (align = "right") => ({ textAlign: align, padding: "5px 8px", borderBottom: `1px solid ${Z.border}`, whiteSpace: "nowrap" });

function ZoomChart({ days, lines, fmt, axisFmt, curFrom, refAvg, refLabel }) {
  const W = 720;
  const H = 260;
  const pad = { l: 64, r: 16, t: 14, b: 30 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);

  const vals = lines.flatMap((l) => l.values.filter((v) => v != null && !Number.isNaN(v)));
  if (refAvg != null) vals.push(refAvg);
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (hi === lo) {
    hi += Math.abs(hi) * 0.01 || 1;
    lo -= Math.abs(lo) * 0.01 || 1;
  }
  const padY = (hi - lo) * 0.08;
  lo -= padY;
  hi += padY;
  const n = days.length;
  const x = (i) => pad.l + (n > 1 ? (i * iw) / (n - 1) : iw / 2);
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * k) / 4);
  const labelEvery = Math.max(1, Math.ceil(n / 10));

  const onMove = (e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const path = (values) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v == null || Number.isNaN(v)) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const tipX = hover != null ? x(hover) : 0;
  return (
    <div style={{ position: "relative", marginTop: 10 }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {curFrom > 0 && <rect x={pad.l} y={pad.t} width={x(curFrom) - pad.l - (n > 1 ? iw / (n - 1) / 2 : 0)} height={ih} fill="#1e293b" opacity={0.55} />}
        {ticks.map((v, k) => (
          <g key={k}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={Z.grid} />
            <text x={pad.l - 8} y={y(v) + 4} fill={Z.muted} fontSize={10} textAnchor="end">
              {axisFmt(v)}
            </text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={d} x={x(i)} y={H - 10} fill={Z.muted} fontSize={10} textAnchor="middle">
              {dayLabel(d)}
            </text>
          ) : null,
        )}
        {refAvg != null && (
          <g>
            <line x1={pad.l} x2={pad.l + iw} y1={y(refAvg)} y2={y(refAvg)} stroke={Z.text2} strokeDasharray="4 4" opacity={0.7} />
            <text x={pad.l + iw - 2} y={y(refAvg) - 4} fill={Z.text2} fontSize={10} textAnchor="end">
              {refLabel} {fmt(refAvg)}
            </text>
          </g>
        )}
        {hover != null && <line x1={tipX} x2={tipX} y1={pad.t} y2={pad.t + ih} stroke={Z.text2} opacity={0.4} />}
        {lines.map((l) => (
          <g key={l.name}>
            <path d={path(l.values)} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" />
            {l.values.map((v, i) =>
              v == null || Number.isNaN(v) ? null : (
                <circle key={i} cx={x(i)} cy={y(v)} r={i === n - 1 || i === hover ? 4 : 2.6} fill={i === n - 1 ? l.color : Z.card} stroke={l.color} strokeWidth={1.6} />
              ),
            )}
          </g>
        ))}
      </svg>
      {hover != null && (
        <div
          style={{
            position: "absolute",
            top: 6,
            left: `${(tipX / W) * 100}%`,
            transform: tipX > W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            background: Z.card2,
            border: `1px solid ${Z.border}`,
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 1,
          }}
        >
          <div style={{ color: Z.text2, marginBottom: 3 }}>{dayLong(days[hover])}</div>
          {lines.map((l) => (
            <div key={l.name} style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <span style={{ color: l.color }}>{l.name}</span>
              <b>{fmt(l.values[hover])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
