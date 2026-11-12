// Today — PM Console home: one summary of every dashboard. One call (/api/home/summary), built in the backend
// from the other dashboards' caches (no query of its own): Unified SR (TPAP) daily SR / volume + WARN / CRIT
// rows, Acquiring SR (TSP) headline + last-3h SR drops, Transaction breakup by segment (backend/txnBreakup.js cache), Product Wise headline per product, HSS mix + weight
// changes, latest SR Dissection top codes, last Success-Rate benchmark, and data freshness of each source.
// Ask boxes hand off to the Lumina / Txn Tracer pages via onNavigate(page, request).
import { useCallback, useEffect, useState } from "react";
import { C, api, fmtCompact, fmtAgo, fmtDay, Card, Btn, ErrorNote, MixBar, PspLegend, inputStyle } from "./pm-ui.jsx";
import { Zoomable } from "./trend-zoom.jsx";

const TREND_COLOR = { spike: C.bad, up: C.warn, new: C.warn, down: C.good, steady: C.muted };
const PEER_NAME = { paytm: "Paytm", phonepe: "PhonePe", gpay: "GPay" };

const greeting = () => {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

function Kpi({ label, value, sub, subColor, onClick }) {
  return (
    <div onClick={onClick} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 12px", cursor: onClick ? "pointer" : "default", minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.text2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, whiteSpace: "nowrap" }}>{value}</div>
      <div style={{ fontSize: 11, color: subColor || C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
    </div>
  );
}

function Sparkline({ values, width = 220, height = 44 }) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pts = values.map((x, i) => `${(i / (values.length - 1)) * width},${height - 4 - ((x - min) / span) * (height - 8)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", height }}>
      <polyline points={pts} fill="none" stroke={C.accent} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function AskBox({ placeholder, button, onSubmit, mono }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          onSubmit(v.trim());
          setV("");
        }
      }}
      style={{ display: "flex", gap: 6 }}
    >
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} style={{ ...inputStyle, flex: 1, fontFamily: mono ? "monospace" : undefined }} />
      <Btn primary type="submit" disabled={!v.trim()}>
        {button}
      </Btn>
    </form>
  );
}

const ROW = { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, padding: "5px 0", borderTop: `1px solid ${C.border}` };

const fmtInr = (v) => (v == null ? "—" : v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : `₹${Math.round(v).toLocaleString("en-IN")}`);
const fmtVal = (v, kind) => (v == null ? "—" : kind === "sr" ? `${v.toFixed(2)}%` : kind === "inr" ? fmtInr(v) : fmtCompact(v));
// SR deltas in pp (red below −0.3 pp), count deltas in % (red below −10%).
const fmtDelta = (d, kind) => (d == null ? "" : kind === "sr" ? `${d >= 0 ? "+" : ""}${d.toFixed(2)} pp` : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`);
const deltaColor = (d, kind) => (d == null ? C.muted : d < (kind === "sr" ? -0.3 : -10) ? C.bad : d > (kind === "sr" ? 0.3 : 10) ? C.good : C.muted);
const LEVEL_COLOR = { CRIT: C.bad, WARN: C.warn };
const ACQ_FLOW_LABEL = { ppsl_v2: "PPSL Intent V2", ppsl_dqr: "PPSL DQR", ocl_dqr: "OCL DQR", collect: "Collect", p2m_other: "P2M other", acq4: "Acquiring 4" };
const hm = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const openProduct = (id) => {
  window.location.hash = `#product?tab=${id}`;
};

/** One product headline: value on its latest day vs the 7 days before, a 14-day line, extras. */
function ProductTile({ p }) {
  return (
    <div onClick={() => openProduct(p.id)} style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 11px", cursor: "pointer", minWidth: 0 }} title={`Open Product Wise → ${p.title}`}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, color: C.text2 }}>
        <b style={{ color: C.text }}>{p.title}</b>
        <span>{p.running ? "refreshing…" : p.day ? fmtDay(p.day) : "no data"}</span>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{p.label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 19, fontWeight: 700 }}>{fmtVal(p.value, p.kind)}</span>
        <span style={{ fontSize: 11, color: deltaColor(p.delta, p.kind) }} title="vs average of the 7 days before">
          {fmtDelta(p.delta, p.kind)}
        </span>
      </div>
      {p.series?.length > 1 &&
        (p.seriesDays?.length === p.series.length ? (
          <Zoomable
            block
            spec={() => ({
              title: `${p.title} · ${p.label}`,
              subtitle: "Product Wise",
              days: p.seriesDays,
              lines: [{ name: p.label, color: C.accent, values: p.series }],
              fmt: (v) => fmtVal(v, p.kind),
              unit: p.kind === "sr" ? "pct" : "count",
            })}
          >
            <Sparkline values={p.series} height={26} />
          </Zoomable>
        ) : (
          <Sparkline values={p.series} height={26} />
        ))}
      {(p.extra || []).map((e) => (
        <div key={e.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text2 }}>
          <span>{e.label}</span>
          <span>
            {fmtVal(e.value, e.kind)} <span style={{ color: deltaColor(e.delta, e.kind) }}>{fmtDelta(e.delta, e.kind)}</span>
          </span>
        </div>
      ))}
      {p.error && <div style={{ fontSize: 10, color: C.bad, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.error}>last refresh failed</div>}
    </div>
  );
}

const SEG_COLOR = { P2M: "#60a5fa", P2P: "#34d399", Lite: "#fbbf24", "Mandate executions": "#f472b6", "ICCW (cash withdrawal)": "#a78bfa", International: "#fb923c" };

/** Zoom spec for Transaction breakup: one segment (or Total when seg is null) with Count / GMV, plus all segments overlaid. */
function tbZoom(tb, seg) {
  const days = tb.seriesDays || [];
  if (!days.length) return null;
  const sum = (key) => days.map((_, i) => tb.segments.reduce((a, r) => a + (r[key]?.[i] || 0), 0));
  const one = (key) => (seg ? tb.segments.find((r) => r.segment === seg)?.[key] || [] : sum(key));
  const name = seg || "Total";
  const color = seg ? SEG_COLOR[seg] || C.accent : C.accent;
  const all = (key) => tb.segments.map((r) => ({ name: r.segment, color: SEG_COLOR[r.segment] || C.muted, values: r[key] || [] }));
  const cnt = { fmt: (v) => fmtCompact(v), unit: "count" };
  const gmv = { fmt: (v) => fmtInr(v), unit: "count" };
  const base = { title: `Transaction breakup · ${name}`, subtitle: "Successful txns", days };
  return {
    ...base,
    lines: [{ name: "Success txns", color, values: one("series") }],
    ...cnt,
    variants: [
      { id: "count", label: "Count", spec: { ...base, lines: [{ name: "Success txns", color, values: one("series") }], ...cnt } },
      { id: "gmv", label: "GMV", spec: { ...base, lines: [{ name: "GMV", color, values: one("gmvSeries") }], ...gmv } },
      { id: "allc", label: "All segments · Count", spec: { ...base, title: "Transaction breakup · all segments", lines: all("series"), ...cnt } },
      { id: "allg", label: "All segments · GMV", spec: { ...base, title: "Transaction breakup · all segments", lines: all("gmvSeries"), ...gmv } },
    ],
  };
}

/** Transaction breakup: successful Paytm TPAP txns per segment on the latest cached day, vs avg of the 7 days before. */
function TxnBreakupCard({ tb, error, onReload }) {
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/txnbreakup/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } catch {
      /* state shows on reload */
    }
    setTimeout(() => {
      setBusy(false);
      onReload();
    }, 1500);
  };
  const cell = { padding: "5px 6px", fontSize: 12, borderTop: `1px solid ${C.border}`, fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap" };
  const head = { ...cell, borderTop: "none", fontSize: 11, color: C.muted, fontWeight: 600 };
  const dl = (d) => <span style={{ color: deltaColor(d, "count"), fontSize: 11, marginLeft: 4 }}>{fmtDelta(d, "count")}</span>;
  return (
    <Card
      title="Transaction breakup"
      right={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <span>{tb?.day ? `${fmtDay(tb.day)} · success · vs ${tb.comparedDays}d avg` : ""}</span>
          <Btn disabled={busy || !!tb?.running} onClick={refresh}>
            {tb?.running ? `querying ${fmtDay(tb.running)}…` : busy ? "…" : "↻"}
          </Btn>
        </span>
      }
    >
      {!tb && <div style={{ fontSize: 12, color: C.muted }}>{error || "Loading…"}</div>}
      {tb && !tb.segments.length && <div style={{ fontSize: 12, color: C.muted }}>{tb.running ? `First run — querying ${fmtDay(tb.running)} on Trino (a few minutes)…` : "No data yet."}</div>}
      {tb?.segments.length > 0 && (
        <>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 8 }} title="Share of GMV">
            {tb.segments.map((r) => (
              <div key={r.segment} style={{ width: `${r.gmvShare || 0}%`, background: SEG_COLOR[r.segment] || C.muted }} title={`${r.segment} ${r.gmvShare?.toFixed(1)}% of GMV`} />
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: "left" }}>Segment</th>
                <th style={head}>Success txns</th>
                <th style={head}>% txns</th>
                <th style={head}>GMV</th>
                <th style={head}>% GMV</th>
                <th style={{ ...head, width: 90 }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {tb.segments.map((r) => (
                <tr key={r.segment}>
                  <td style={{ ...cell, textAlign: "left" }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: SEG_COLOR[r.segment] || C.muted, marginRight: 6 }} />
                    {r.segment}
                  </td>
                  <td style={cell}>
                    {fmtCompact(r.count)}
                    {dl(r.countDelta)}
                  </td>
                  <td style={{ ...cell, color: C.text2 }}>{r.countShare?.toFixed(1)}%</td>
                  <td style={cell}>
                    {fmtInr(r.gmv)}
                    {dl(r.gmvDelta)}
                  </td>
                  <td style={{ ...cell, color: C.text2 }}>{r.gmvShare?.toFixed(1)}%</td>
                  <td style={cell}>
                    {r.series?.length > 1 && (
                      <Zoomable block spec={() => tbZoom(tb, r.segment)}>
                        <Sparkline values={r.series} width={90} height={20} />
                      </Zoomable>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ ...cell, textAlign: "left", fontWeight: 700 }}>Total</td>
                <td style={{ ...cell, fontWeight: 700 }}>
                  {fmtCompact(tb.total.count)}
                  {dl(tb.total.countDelta)}
                </td>
                <td style={cell} />
                <td style={{ ...cell, fontWeight: 700 }}>
                  {fmtInr(tb.total.gmv)}
                  {dl(tb.total.gmvDelta)}
                </td>
                <td style={cell} />
                <td style={cell}>
                  {tb.segments[0]?.series?.length > 1 && (
                    <Zoomable block spec={() => tbZoom(tb, null)}>
                      <Sparkline values={tb.segments[0].series.map((_, i) => tb.segments.reduce((a, r) => a + (r.series[i] || 0), 0))} width={90} height={20} />
                    </Zoomable>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </>
      )}
      {tb?.error && <div style={{ fontSize: 11, color: C.bad, marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={tb.error}>last query failed: {tb.error}</div>}
      {tb && !tb.error && tb.missing?.length > 0 && tb.segments.length > 0 && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{tb.running ? `Backfilling ${fmtDay(tb.running)} · ${tb.missing.length} day(s) left` : `${tb.missing.length} day(s) not cached yet`}</div>}
    </Card>
  );
}

export default function PmHome({ onNavigate, active }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setData(await api("/api/home/summary"));
      setErr("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  // Reload whenever Today is shown again (cheap: backend caches every block).
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const days = data?.sr?.ok ? data.sr.data.days : [];
  const last = days[days.length - 1];
  const prev = days[days.length - 2];
  const srDelta = last && prev ? last.sr - prev.sr : null;
  const volDelta = last && prev && prev.total ? (100 * (last.total - prev.total)) / prev.total : null;
  const hss = data?.hss?.ok ? data.hss.data : null;
  const dis = data?.dissection?.ok ? data.dissection.data : null;
  const sa = data?.srAgent;
  const lostPts = dis?.lostPts ?? 0;
  const us = sa?.volumes?.[sa.subject];
  const bestPeer = sa ? (sa.peers || []).map((p) => ({ p, sr: sa.volumes?.[p]?.sr_pct })).sort((a, b) => (b.sr ?? 0) - (a.sr ?? 0))[0] : null;
  const alerts = data?.srAlerts?.ok ? data.srAlerts.data : null;
  const crit = (alerts?.alerts || []).filter((a) => a.level === "CRIT").length;
  const products = data?.products?.ok ? data.products.data : [];
  const acq = data?.acq?.ok ? data.acq.data : null;
  const apd = data?.apd?.ok && data.apd.data?.active !== false ? data.apd.data : null; // off / folder missing: no APD line
  const tb = data?.txnBreakup?.ok ? data.txnBreakup.data : null;
  // Freshness: only what needs attention — failed / stale Unified SR sections, failed product refreshes, APD, acq collector.
  const STALE_MS = 36 * 3600e3;
  const issues = [
    ...(data?.srHealth?.ok ? data.srHealth.data : [])
      .filter((s) => s.status === "failed" || (s.auto !== false && s.ranAt && Date.now() - s.ranAt > STALE_MS))
      .map((s) => ({ where: "Unified SR", what: `${s.title}: ${s.status === "failed" ? `failed${s.error ? ` (${s.error.slice(0, 80)})` : ""}` : `last run ${fmtAgo(s.ranAt)}`}`, page: "srdash" })),
    ...products.filter((p) => p.error).map((p) => ({ where: "Product Wise", what: `${p.title}: ${p.error.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)}`, product: p.id })),
    ...(apd?.lastRun?.steps || []).filter((st) => st.status === "failed").map((st) => ({ where: "Automatic Payments", what: `${st.name} failed in the ${apd.lastRun.startedAt} refresh`, page: "autopay" })),
    ...(acq?.paused ? [{ where: "Acquiring SR", what: "collector paused", page: "acqsr" }] : []),
    ...["sr", "srAlerts", "products", "acq", "apd", "txnBreakup", "hss", "dissection"].filter((k) => data?.[k] && !data[k].ok).map((k) => ({ where: "Today", what: `${k}: ${data[k].error}` })),
  ];

  return (
    <div style={{ minHeight: "calc(100vh - 40px)", background: C.bg, color: C.text, fontFamily: "'Segoe UI', sans-serif", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{greeting()}</h1>
        <span style={{ fontSize: 12, color: C.text2 }}>
          {new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })} · SR data {fmtAgo(data?.sr?.data?.ranAt)}
        </span>
        <span style={{ flex: 1 }} />
        <Btn disabled={busy} onClick={load}>
          {busy ? "Loading…" : "↻ Refresh"}
        </Btn>
      </div>
      <ErrorNote>{err}</ErrorNote>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Kpi
          label={`TPAP SR · ${last ? fmtDay(last.day) : "—"}`}
          value={last?.sr != null ? `${last.sr.toFixed(2)}%` : "—"}
          sub={srDelta != null ? `${srDelta >= 0 ? "+" : ""}${srDelta.toFixed(2)} pp vs T-1` : data?.sr?.error || "no Unified SR run yet"}
          subColor={srDelta == null ? C.muted : srDelta < -0.1 ? C.bad : srDelta > 0.1 ? C.good : C.muted}
          onClick={() => onNavigate("srdash")}
        />
        <Kpi
          label="Txn volume"
          value={last ? fmtCompact(last.total) : "—"}
          sub={volDelta != null ? `${volDelta >= 0 ? "+" : ""}${volDelta.toFixed(1)}% vs T-1` : ""}
          subColor={volDelta == null ? C.muted : volDelta < -5 ? C.bad : volDelta > 0 ? C.good : C.muted}
          onClick={() => onNavigate("srdash")}
        />
        <Kpi
          label={`TSP SR (acquiring P2M) · ${acq?.latest ? fmtDay(acq.latest.day) : "—"}`}
          value={acq?.latest?.sr != null ? `${acq.latest.sr.toFixed(2)}%` : "—"}
          sub={acq?.delta != null ? `${fmtDelta(acq.delta, "sr")} vs 7-day avg` : data?.acq?.error || "no complete day yet"}
          subColor={deltaColor(acq?.delta, "sr")}
          onClick={() => onNavigate("acqsr")}
        />
        <Kpi
          label={`TPAP SR alerts · ${alerts?.day ? fmtDay(alerts.day) : "—"}`}
          value={alerts ? alerts.alerts.length : "—"}
          sub={alerts ? (alerts.alerts.length ? `${crit} CRIT · ${alerts.alerts.length - crit} WARN` : "no WARN / CRIT rows") : data?.srAlerts?.error || ""}
          subColor={crit ? C.bad : alerts?.alerts.length ? C.warn : C.good}
          onClick={() => onNavigate("srdash")}
        />
        <Kpi
          label={`SR lost to failures · ${dis ? fmtDay(dis.date) : ""}`}
          value={dis ? `${lostPts.toFixed(2)} pp` : "—"}
          sub={dis ? `${dis.hotCount} codes rising / spiking` : data?.dissection?.error || ""}
          subColor={dis?.hotCount ? C.warn : C.muted}
          onClick={() => onNavigate("srdissect")}
        />
        <Kpi
          label="Paytm vs best peer (P2M)"
          value={us?.sr_pct != null ? `${us.sr_pct.toFixed(2)}%` : "—"}
          sub={bestPeer ? `${PEER_NAME[bestPeer.p] || bestPeer.p} ${bestPeer.sr?.toFixed(2)}% · ${fmtAgo(sa.ranAt)}` : "run the benchmark"}
          subColor={us && bestPeer && us.sr_pct < bestPeer.sr ? C.warn : C.muted}
          onClick={() => onNavigate("srbench")}
        />
        <Kpi
          label="HSS · PTYES share"
          value={hss?.globalWeights?.ptyes?.value != null ? `${hss.globalWeights.ptyes.value}%` : "—"}
          sub={hss ? (hss.changes?.length ? `${hss.changes.length} weight changes` : "no weight changes") : data?.hss?.error || ""}
          subColor={hss?.changes?.length ? C.warn : C.muted}
          onClick={() => onNavigate("hss")}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.65fr) minmax(280px, 1fr)", gap: 12, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 12 }}>
          <Card title="Products" right={<span style={{ cursor: "pointer", color: C.accent }} onClick={() => onNavigate("product")}>Product Wise →</span>}>
            {!products.length && <div style={{ fontSize: 12, color: C.muted }}>{data?.products?.error || "Loading…"}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
              {products.map((p) => (
                <ProductTile key={p.id} p={p} />
              ))}
            </div>
          </Card>

          <TxnBreakupCard tb={tb} error={data?.txnBreakup?.error} onReload={load} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
            <Card title="TPAP SR alerts" right={<span style={{ cursor: "pointer", color: C.accent }} onClick={() => onNavigate("srdash")}>Unified SR{alerts?.day ? ` · ${fmtDay(alerts.day)}` : ""} →</span>}>
              {!alerts && <div style={{ fontSize: 12, color: C.muted }}>{data?.srAlerts?.error || "Loading…"}</div>}
              {alerts && !alerts.alerts.length && <div style={{ fontSize: 12, color: C.good }}>No WARN / CRIT rows vs L7D.</div>}
              {(alerts?.alerts || []).slice(0, 6).map((a) => (
                <div key={`${a.kind}|${a.dim}`} style={ROW} title={a.codes.join(", ")}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <b style={{ color: LEVEL_COLOR[a.level] }}>{a.level}</b> <span style={{ color: C.text2 }}>{a.kind}</span> {a.name || a.dim}
                    {a.codes.length > 0 && <span style={{ color: C.muted }}> · {a.codes.join(", ")}</span>}
                  </span>
                  <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                    {a.srNow?.toFixed(2)}% <span style={{ color: C.bad }}>{fmtDelta(a.dsr, "sr")}</span>
                  </span>
                </div>
              ))}
            </Card>
            <Card title="TSP SR drops · last 3 h" right={<span style={{ cursor: "pointer", color: C.accent }} onClick={() => onNavigate("acqsr")}>Acquiring SR →</span>}>
              {!acq && <div style={{ fontSize: 12, color: C.muted }}>{data?.acq?.error || "Loading…"}</div>}
              {acq && !acq.incidents.length && <div style={{ fontSize: 12, color: C.good }}>No SR drops in the last 3 hours.</div>}
              {(acq?.incidents || []).slice(0, 6).map((i) => (
                <div key={`${i.flow}|${i.from}`} style={ROW} title={i.codes.join(", ")}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {hm(i.from)}–{hm(i.to)} · <b>{ACQ_FLOW_LABEL[i.flow] || i.flow}</b>
                    {i.codes.length > 0 && <span style={{ color: C.muted }}> · {i.codes.join(", ")}</span>}
                  </span>
                  <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                    {i.sr?.toFixed(2)}% <span style={{ color: C.bad }}>−{i.dropPp?.toFixed(2)} pp</span>
                  </span>
                </div>
              ))}
              {acq?.today && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Today so far ({fmtDay(acq.today.day)}): {acq.today.sr?.toFixed(2)}% on {fmtCompact(acq.today.t)} txns</div>}
            </Card>
          </div>

          <Card title="Failure codes to watch" right={dis ? <span style={{ cursor: "pointer", color: C.accent }} onClick={() => onNavigate("srdissect")}>SR dissection · {fmtDay(dis.date)} →</span> : null}>
            {!dis && <div style={{ fontSize: 12, color: C.muted }}>{data?.dissection?.error || "Loading…"}</div>}
            {(dis?.top || []).map((r) => (
              <div key={r.code} style={ROW} title={r.ai_business}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <b style={{ fontFamily: "monospace" }}>{r.code}</b> <span style={{ color: C.text2 }}>· {r.meaning}</span>
                </span>
                <span style={{ display: "inline-flex", gap: 10, flexShrink: 0 }}>
                  <span style={{ color: TREND_COLOR[r.trend] || C.muted }}>{r.trend}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 58, textAlign: "right" }}>{Number(r.sr_points).toFixed(2)} pp</span>
                </span>
              </div>
            ))}
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            <Card title="SR trend" right={`${days.length} days · Unified SR`}>
              {days.length ? (
                <>
                  <Zoomable
                    block
                    spec={() => {
                      const base = { title: "TPAP SR · Unified SR", days: days.map((d) => d.day) };
                      const sr = { ...base, lines: [{ name: "SR", color: C.accent, values: days.map((d) => d.sr) }], fmt: (v) => (v == null ? "—" : `${v.toFixed(2)}%`), unit: "pct" };
                      const vol = { ...base, lines: [{ name: "Txns", color: "#34d399", values: days.map((d) => d.total ?? null) }], fmt: (v) => fmtCompact(v), unit: "count" };
                      return { ...sr, variants: [{ id: "sr", label: "SR", spec: sr }, { id: "vol", label: "Txns", spec: vol }] };
                    }}
                  >
                    <Sparkline values={days.map((d) => d.sr)} />
                  </Zoomable>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginTop: 4 }}>
                    <span>{fmtDay(days[0].day)}</span>
                    <span>
                      min {Math.min(...days.map((d) => d.sr)).toFixed(2)}% · max {Math.max(...days.map((d) => d.sr)).toFixed(2)}%
                    </span>
                    <span>{fmtDay(last.day)}</span>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.muted }}>{data?.sr?.error || "Run Unified SR to populate."}</div>
              )}
            </Card>
            <Card title="HSS traffic mix" right={<span style={{ cursor: "pointer", color: C.accent }} onClick={() => onNavigate("hss")}>details →</span>}>
              {hss ? (
                <>
                  <MixBar mix={Object.fromEntries(Object.entries(hss.globalWeights || {}).map(([k, v]) => [k, v.value]))} psps={hss.psps} height={12} />
                  <div style={{ margin: "8px 0" }}>
                    <PspLegend psps={hss.psps.map((p) => ({ ...p, label: `${p.label} ${hss.globalWeights?.[p.id]?.value ?? "—"}%` }))} />
                  </div>
                  {(hss.changes || []).slice(0, 3).map((c, i) => (
                    <div key={i} style={{ fontSize: 11, color: C.warn }}>
                      {c.route} · {c.psp}: {c.from}% → {c.to}%
                    </div>
                  ))}
                  {!hss.changes?.length && <div style={{ fontSize: 11, color: C.muted }}>{hss.comparedTo ? `No changes since ${hss.comparedTo}` : "Change tracking starts from today's snapshot"}</div>}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.muted }}>{data?.hss?.error || "Loading…"}</div>
              )}
            </Card>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <Card title="Data freshness" right={issues.length ? `${issues.length} to check` : "all fresh"}>
            {!data && <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>}
            {data && !issues.length && <div style={{ fontSize: 12, color: C.good }}>Every dashboard refreshed on schedule.</div>}
            {issues.slice(0, 8).map((x, i) => (
              <div key={i} style={{ ...ROW, cursor: x.page || x.product ? "pointer" : "default" }} onClick={() => (x.product ? openProduct(x.product) : x.page && onNavigate(x.page))}>
                <span style={{ color: C.warn, flexShrink: 0 }}>{x.where}</span>
                <span style={{ color: C.text2, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.what}>
                  {x.what}
                </span>
              </div>
            ))}
            {apd && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                Automatic Payments: {apd.running ? "refreshing now" : apd.lastRun ? `last refresh ${apd.lastRun.startedAt} · ${apd.lastRun.status}` : "not run yet"}
              </div>
            )}
          </Card>
          <Card title="Ask Lumina" right="NPCI circulars · UPI rules">
            <AskBox placeholder="e.g. UDIR TAT for U16 disputes" button="Ask" onSubmit={(text) => onNavigate("lumina", { text, id: Date.now() })} />
          </Card>
          <Card title="Trace a transaction" right="txn id or RRN">
            <AskBox placeholder="PTM… or 12-digit RRN" button="Trace" mono onSubmit={(text) => onNavigate("txntrace", { text, id: Date.now() })} />
          </Card>
          <Card title="Benchmark vs peers" right={sa ? fmtAgo(sa.ranAt) : null}>
            {sa ? (
              <>
                {[sa.subject, ...(sa.peers || [])].map((p) => (
                  <div key={p} style={ROW}>
                    <span style={{ fontWeight: p === sa.subject ? 700 : 400 }}>{PEER_NAME[p] || p}</span>
                    <span>{sa.volumes?.[p]?.sr_pct?.toFixed(2)}%</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: sa.actionable.length ? C.bad : C.good, marginTop: 6 }}>
                  {sa.actionable.length ? `${sa.actionable.length} actionable codes where Paytm is an outlier` : "No codes where Paytm is a stable outlier"}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: C.muted }}>Not run yet.</div>
            )}
            <div style={{ marginTop: 8 }}>
              <Btn onClick={() => onNavigate("srbench")}>Open benchmark</Btn>
            </div>
          </Card>
          <Card title="Quick actions">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Btn onClick={() => onNavigate("prd")}>New PRD</Btn>
              <Btn onClick={() => onNavigate("brd")}>New BRD</Btn>
              <Btn onClick={() => onNavigate("uat")}>UAT cases</Btn>
              <Btn onClick={() => onNavigate("jira")}>Jira ticket</Btn>
              <Btn onClick={() => onNavigate("analyst")}>Ask Analyst</Btn>
              <Btn onClick={() => onNavigate("utilities")}>Fetch UMN</Btn>
              <Btn onClick={() => onNavigate("product")}>Product Wise</Btn>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
