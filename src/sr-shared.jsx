import { Fragment, useMemo, useState } from "react";
import BreakdownTable from "./breakdown-table.jsx";
import { NO_PICK, Picker, applyPick, toPick, useStored } from "./table-pickers.jsx";
import { ALERT_RULES, buildBreakdown, buildDeclines, computeAlerts, pickYday } from "./breakdown-math.mjs";

// Shared SR dashboard pieces built on the breakdown section (Unified SR Dashboard; moved here
// from the retired Morning Dashboard):
//   SrKpiStrip / MorningKpiStrip  overall SR / Δ vs L7D / rate-vs-mix / lost txns / alerts + refresh status
//   BreakdownBody                 impact-ranked BreakdownTable (PSP / bank / instrument / flow)
//   DeclinesBody                  decline codes: NPCI description, ₹ amount, share, D-1..D-3, LW, Δ %
//   SR_KINDS / MORNING_KINDS      the breakdown tabs
// Data: results.breakdown (Looker, 10 complete days) and results.declines (raw txns, ₹ per code).

export const MORNING_KINDS = [
  { id: "psp", label: "Payee PSP" },
  { id: "bank", label: "Payer bank" },
  { id: "instrument", label: "Instrument" },
  { id: "flow", label: "Flow (P2P / P2M)" },
];
const KIND_IDS = MORNING_KINDS.map((k) => k.id);

const C = {
  bg: "#0b1220",
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
  info: "#38bdf8",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "—");
const fmtPct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtSigned = (v, unit, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`);
const fmtInr = (v) => {
  if (v == null) return "—";
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
};
const fmtClock = (ms) => (ms ? new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—");
const tone = (v, goodWhenUp, eps = 0.005) => (v == null || Math.abs(v) < eps ? C.text2 : (v > 0) === goodWhenUp ? C.good : C.bad);

/** Rows from the cached breakdown result + its latest complete day. */
export function useBreakdownData(result) {
  return useMemo(() => {
    const rows = (result?.rows || []).map((r) => ({ ...r, code: r.code || "", total: Number(r.total) || 0, success: Number(r.success) || 0 }));
    const yday = rows.length ? pickYday(rows, { kind: "bank" }) : null;
    return { rows, yday };
  }, [result]);
}

// ─── KPI strip + refresh status ──────────────────────────────────────────────

function Tile({ label, children, sub, title, wide, roomy }) {
  return (
    <div
      title={title}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: roomy ? "14px 18px" : "10px 14px",
        minWidth: wide ? 260 : roomy ? 190 : 150,
        flex: wide ? "1 1 260px" : "0 1 auto",
      }}
    >
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: roomy ? 6 : 3 }}>{children}</div>
      {sub && <div style={{ fontSize: 11, color: C.text2, marginTop: roomy ? 6 : 2, lineHeight: 1.45 }}>{sub}</div>}
    </div>
  );
}

// Plain-language definitions of the KPI tiles (shown on request, Unified dashboard).
const KPI_GLOSSARY = [
  [
    "Overall SR",
    "Successful ÷ attempted transactions on the latest complete day (day-level table), for the page's handle / flow filters. ▲ / ▼ compares it with the day before (D-1). L7D = the SR over the 7 days before that day.",
  ],
  ["Δ vs L7D", "Latest day's SR minus the L7D SR, in percentage points (pp). Green = better than the past week, red = worse."],
  [
    "ΔSR = rate + mix",
    "Splits Δ vs L7D in two. Rate: banks / PSPs / instruments themselves did better or worse (weighted by their volume). Mix: traffic moved between rows with different SR — e.g. more volume to a low-SR bank pulls overall SR down even if no bank changed. The headline uses payer banks; the line below shows the same split by each dimension.",
  ],
  ["Lost txns", "Transactions that would have succeeded if every payer bank had held its L7D SR: Σ max(0, SR L7D − SR now) × the bank's volume. Only banks that fell count."],
  ["Alerts", "Rows (PSP / bank / instrument / flow) breaching a rule — WARN: SR ≥1pp below L7D and ≥0.1pp hit on overall SR; CRIT: ≥3pp and ≥0.3pp. Click to jump to A."],
];

const ACTIVE = new Set(["queued", "running", "retry-wait"]);

/** Most recent scheduled slot (epoch ms) at or before now for a daily rule, else null. */
function lastSlotMs(rule, nowMs, tzMin = 330) {
  if (rule?.type !== "daily" || !rule.at?.length) return null;
  const tz = tzMin * 60000;
  const wall = nowMs + tz;
  const day = new Date(wall).toISOString().slice(0, 10);
  const hm = new Date(wall).toISOString().slice(11, 16);
  const slots = [...rule.at].sort();
  const passed = slots.filter((t) => t <= hm);
  const slotDay = passed.length ? day : new Date(wall - 86400000).toISOString().slice(0, 10);
  const slot = passed.length ? passed[passed.length - 1] : slots[slots.length - 1];
  return Date.parse(`${slotDay}T${slot}:00Z`) - tz;
}

/** Per-section freshness + overall progress for the current refresh batch. */
export function refreshStatus(state, sectionIds, nowMs) {
  const tzMin = state.config?.tzOffsetMinutes ?? 330;
  const items = sectionIds.map((id) => {
    const job = state.jobs?.[id] || {};
    const res = state.results?.[id];
    const sched = state.schedule?.[id];
    const slot = lastSlotMs(sched?.rule, nowMs, tzMin);
    const ranAt = res?.ranAt || 0;
    let st;
    if (job.status === "running") st = "running";
    else if (job.status === "queued") st = "queued";
    else if (job.status === "retry-wait") st = "retrying";
    else if (job.status === "failed") st = "failed";
    else if (!ranAt) st = "never";
    else if (slot && ranAt < slot) st = "stale";
    else st = "fresh";
    return { id, st, job, ranAt, slot, nextAt: sched?.nextAt || null };
  });
  const active = items.filter((i) => ACTIVE.has(i.job.status));
  let progress = null;
  if (active.length) {
    const batchStart = Math.min(...active.map((i) => i.job.queuedAt || i.job.startedAt || nowMs));
    const finished = items.filter((i) => !ACTIVE.has(i.job.status) && (i.job.finishedAt || 0) >= batchStart);
    const done = finished.length + active.reduce((s, i) => s + (i.job.status === "running" ? (i.job.progress || 0) / 100 : 0), 0);
    progress = { pct: (done * 100) / (finished.length + active.length), total: finished.length + active.length, finished: finished.length };
  }
  const count = (k) => items.filter((i) => i.st === k).length;
  const nextAuto =
    items
      .map((i) => i.nextAt)
      .filter((t) => t && t > nowMs)
      .sort((a, b) => a - b)[0] || null;
  return { items, progress, count, nextAuto, lastFresh: Math.max(0, ...items.map((i) => i.ranAt)) };
}

const ST = {
  fresh: { label: "updated", color: C.good, icon: "✓" },
  running: { label: "running", color: C.info, icon: "⟳" },
  queued: { label: "queued", color: C.text2, icon: "◷" },
  retrying: { label: "retrying", color: C.warn, icon: "↻" },
  failed: { label: "failed", color: C.bad, icon: "✕" },
  stale: { label: "not updated since last slot", color: C.warn, icon: "!" },
  never: { label: "never run", color: C.muted, icon: "○" },
};

/** explain: show the "What do these mean?" toggle and roomier tiles (Unified dashboard). */
export function MorningKpiStrip({ state, sectionIds, titles, now, onJump, onRefresh, explain = false }) {
  const { rows, yday } = useBreakdownData(state.results?.breakdown);
  const cfg = state.config || {};
  const [showHelp, setShowHelp] = useState(false);

  const kpi = useMemo(() => {
    if (!yday) return null;
    const per = Object.fromEntries(KIND_IDS.map((k) => [k, buildBreakdown(rows, { kind: k, yday })]));
    const alerts = computeAlerts(rows, { kinds: KIND_IDS, yday });
    return { per, overall: per.bank.overall, alerts };
  }, [rows, yday]);

  const rs = refreshStatus(state, sectionIds, now);
  const bad = rs.items.filter((i) => ["failed", "stale", "retrying", "never"].includes(i.st));

  return (
    <div style={{ marginBottom: explain ? 28 : 16 }}>
      {explain && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <b style={{ fontSize: 13, color: C.text }}>Overview · {fmtDay(yday)}</b>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.text2, borderRadius: 6, padding: "2px 10px", fontSize: 12, cursor: "pointer" }}
          >
            ⓘ {showHelp ? "Hide definitions" : "What do these mean?"}
          </button>
        </div>
      )}
      {explain && showHelp && (
        <div
          style={{
            background: C.card2,
            border: `1px solid ${C.border}`,
            borderRadius: 10,
            padding: "12px 16px",
            marginBottom: 12,
            display: "grid",
            gridTemplateColumns: "150px 1fr",
            gap: "8px 16px",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {KPI_GLOSSARY.map(([k, v]) => (
            <Fragment key={k}>
              <b style={{ color: C.text }}>{k}</b>
              <span style={{ color: C.text2 }}>{v}</span>
            </Fragment>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: explain ? 14 : 10 }}>
        {kpi ? (
          <>
            <Tile
              roomy={explain}
              label={`Overall SR · ${fmtDay(yday)}`}
              title={`Latest complete day's SR. vs D-1 (${fmtDay(kpi.per.bank.days.d1)}): ${fmtPct(kpi.overall.d1)}`}
              sub={
                <>
                  {kpi.overall.d1Δ != null && (
                    <div style={{ color: tone(kpi.overall.d1Δ, true), fontWeight: 600 }}>
                      {kpi.overall.d1Δ >= 0.005 ? "▲" : kpi.overall.d1Δ <= -0.005 ? "▼" : "▬"} {fmtSigned(kpi.overall.d1Δ, " pp")} vs {fmtDay(kpi.per.bank.days.d1)} ({fmtPct(kpi.overall.d1)})
                    </div>
                  )}
                  <div>
                    {fmtNum(kpi.overall.vol)} txns · L7D {fmtPct(kpi.overall.srL7)}
                  </div>
                </>
              }
            >
              {fmtPct(kpi.overall.srNow)}
            </Tile>
            <Tile roomy={explain} label="Δ vs L7D" sub="latest day's SR − SR over the 7 days before" title="Same-day-level Looker data, all payer handles">
              <span style={{ color: tone(kpi.overall.dsr, true) }}>{fmtSigned(kpi.overall.dsr, " pp")}</span>
            </Tile>
            <Tile
              wide
              roomy={explain}
              label="ΔSR = rate + mix"
              title={
                "Rate = Σ row impact: SR changed inside rows (banks/PSPs got worse or better).\n" +
                "Mix = remainder: volume shifted between rows with different SR.\n" +
                "Same ΔSR, split by each dimension."
              }
              sub={
                <span style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
                  {MORNING_KINDS.map((k) => (
                    <span key={k.id}>
                      {k.label.split(" (")[0]}: <b style={{ color: tone(kpi.per[k.id].overall.rate, true) }}>{fmtSigned(kpi.per[k.id].overall.rate, "")}</b> /{" "}
                      <b style={{ color: tone(kpi.per[k.id].overall.mix, true) }}>{fmtSigned(kpi.per[k.id].overall.mix, "")}</b>
                    </span>
                  ))}
                </span>
              }
            >
              <span style={{ color: tone(kpi.overall.dsr, true) }}>{fmtSigned(kpi.overall.dsr, "")}</span>
              <span style={{ fontSize: 14, color: C.text2 }}> = </span>
              <span style={{ color: tone(kpi.overall.rate, true) }}>{fmtSigned(kpi.overall.rate, "")}</span>
              <span style={{ fontSize: 12, color: C.muted }}> rate</span>
              <span style={{ fontSize: 14, color: C.text2 }}> + </span>
              <span style={{ color: tone(kpi.overall.mix, true) }}>{fmtSigned(kpi.overall.mix, "")}</span>
              <span style={{ fontSize: 12, color: C.muted }}> mix (bank, pp)</span>
            </Tile>
            <Tile roomy={explain} label="Lost txns" sub={explain ? "would have succeeded at each payer bank's L7D SR" : "Σ max(0, SR_L7D − SR now) × vol, by payer bank"}>
              {fmtNum(kpi.overall.lost)}
            </Tile>
            <Tile roomy={explain} label="Alerts" sub="across PSP / bank / instrument / flow" title={ALERT_RULES.map((r) => `${r.level}: Δ SR ≤ ${r.dsr}pp AND impact ≤ ${r.impact}pp`).join("\n")}>
              <span
                style={{ color: kpi.alerts.some((a) => a.level === "CRIT") ? C.bad : C.muted, cursor: kpi.alerts.length ? "pointer" : "default" }}
                onClick={() => kpi.alerts.length && onJump("breakdown")}
              >
                {kpi.alerts.filter((a) => a.level === "CRIT").length} CRIT
              </span>
              <span style={{ color: C.muted }}> · </span>
              <span
                style={{ color: kpi.alerts.some((a) => a.level === "WARN") ? C.warn : C.muted, cursor: kpi.alerts.length ? "pointer" : "default" }}
                onClick={() => kpi.alerts.length && onJump("breakdown")}
              >
                {kpi.alerts.filter((a) => a.level === "WARN").length} WARN
              </span>
            </Tile>
          </>
        ) : (
          <Tile wide label="Overview" sub="Runs with the breakdown section (A). Press Refresh on it, or Refresh all.">
            <span style={{ color: C.muted, fontSize: 14 }}>No breakdown data yet</span>
          </Tile>
        )}
      </div>

      {/* Refresh status */}
      <div style={{ marginTop: explain ? 14 : 10, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: explain ? "12px 18px" : "10px 14px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", fontSize: 12 }}>
          <b style={{ color: C.text }}>Refresh status</b>
          {rs.progress ? (
            <span style={{ color: C.info, fontWeight: 600 }}>
              ⟳ In progress · {rs.progress.pct.toFixed(0)}% ({rs.progress.finished}/{rs.progress.total} sections done)
            </span>
          ) : bad.length ? (
            <span style={{ color: C.warn, fontWeight: 600 }}>⚠ {bad.length} section(s) not up to date — press Refresh on them or Refresh all</span>
          ) : (
            <span style={{ color: C.good, fontWeight: 600 }}>✓ All sections updated</span>
          )}
          {["fresh", "running", "queued", "retrying", "failed", "stale", "never"]
            .filter((k) => rs.count(k))
            .map((k) => (
              <span key={k} style={{ color: ST[k].color }}>
                {ST[k].icon} {rs.count(k)} {ST[k].label}
              </span>
            ))}
          <span style={{ color: C.muted }}>
            last data {fmtClock(rs.lastFresh)} · next auto {fmtClock(rs.nextAuto)}
          </span>
          {bad.length > 0 && !rs.progress && (
            <button
              type="button"
              onClick={() => onRefresh(bad.map((i) => i.id))}
              style={{
                marginLeft: "auto",
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${C.accent}`,
                background: "transparent",
                color: C.accent,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              ⟳ Refresh {bad.length} out-of-date
            </button>
          )}
        </div>
        {rs.progress && (
          <div style={{ height: 4, background: C.card2, borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
            <div style={{ width: `${rs.progress.pct}%`, height: "100%", background: C.info, transition: "width .5s" }} />
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {rs.items.map((i) => (
            <span
              key={i.id}
              onClick={() => onJump(i.id)}
              title={`${titles[i.id]} — ${ST[i.st].label}${i.ranAt ? ` · data ${fmtClock(i.ranAt)}` : ""}${i.job.error ? ` · ${i.job.error}` : ""}`}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: `1px solid ${ST[i.st].color}55`,
                color: ST[i.st].color,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {ST[i.st].icon} {titles[i.id].split(" · ")[0]}
              {i.st === "running" && i.job.progress != null ? ` ${i.job.progress}%` : ""}
              {i.st === "fresh" || i.st === "stale" ? ` ${fmtClock(i.ranAt)}` : ""}
            </span>
          ))}
        </div>
        {cfg.schedule?.enabled === false && <div style={{ fontSize: 11, color: C.warn, marginTop: 6 }}>Auto-refresh is off — sections update only when you press Refresh.</div>}
      </div>
    </div>
  );
}

// ─── breakdown body ──────────────────────────────────────────────────────────

export function BreakdownBody({ result, cfg, focusCode, onCodeClick, onClearFocus }) {
  const { rows, yday } = useBreakdownData(result);
  const labelOf = useMemo(() => {
    const names = Object.fromEntries((cfg?.remitterBanks || []).map((b) => [b.code, b.name]));
    return (kind, dim) => (kind === "bank" ? names[dim] || null : null);
  }, [cfg]);
  if (!yday) return <div style={{ padding: 20, color: C.muted, fontSize: 13 }}>No data in the cached result.</div>;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ fontSize: 11, color: C.muted, padding: "8px 16px", borderBottom: `1px solid ${C.border}` }}>
        Latest complete day <b style={{ color: C.text2 }}>{fmtDay(yday)}</b> vs D-1…D-3, same weekday last week and L7D average · click a decline code to open it in section B
      </div>
      <BreakdownTable
        rows={rows}
        yday={yday}
        kinds={MORNING_KINDS}
        showKpis={false}
        labelOf={labelOf}
        fileTag="sr-breakdown"
        onCodeClick={onCodeClick}
        focusCode={focusCode}
        onClearFocus={onClearFocus}
      />
    </div>
  );
}

// ─── declines body ───────────────────────────────────────────────────────────

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
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** extraCol: optional { label, title, render(code), csv(code) } added after "Δ vs L7D avg" (Unified dashboard). */
// pickKey: turns on the Rows / Columns pickers (saved per key); defaultHiddenCols: column ids off by default.
export function DeclinesBody({ result, amountResult, focus, onFocus, onCodeClick, extraCol = null, pickKey = null, defaultHiddenCols = [] }) {
  const { rows, yday } = useBreakdownData(result);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState({ key: "now", dir: -1 });
  const [rowPick, setRowPick] = useStored(pickKey && `${pickKey}:rows`, NO_PICK);
  const [hiddenCols, setHiddenCols] = useStored(pickKey && `${pickKey}:cols`, defaultHiddenCols);
  const showCol = (id) => !pickKey || !hiddenCols.includes(id);

  const amtInfo = useMemo(() => {
    const am = {};
    const days = new Set();
    for (const r of amountResult?.rows || []) {
      days.add(r.ts);
      if (r.ts === yday) am[r.code] = (am[r.code] || 0) + (Number(r.amount) || 0);
    }
    return { amounts: days.has(yday) ? am : null, days: [...days] };
  }, [amountResult, yday]);

  const data = useMemo(() => (yday ? buildDeclines(rows, { yday, amounts: amtInfo.amounts }) : null), [rows, yday, amtInfo]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = (focus || q).trim().toLowerCase();
    const list = data.rows.filter((r) => !needle || r.code.toLowerCase() === needle || (!focus && (r.code.toLowerCase().includes(needle) || r.descr.toLowerCase().includes(needle))));
    return list.sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
    });
  }, [data, q, focus, sort]);

  if (!data) return <div style={{ padding: 20, color: C.muted, fontSize: 13 }}>No data in the cached breakdown result.</div>;
  const { days, total } = data;
  // Default rows = top 15 by failures today; the Rows picker adds / removes codes on top of that.
  const topIds = [...data.rows].sort((a, b) => b.now - a.now).slice(0, 15).map((r) => r.code);
  const picked = pickKey ? new Set(applyPick(topIds, rowPick)) : null;
  const shown = showAll || focus || q ? filtered : picked ? filtered.filter((r) => picked.has(r.code)) : filtered.slice(0, 15);
  const dayCols = [
    { key: "d1", label: "D-1", day: days.d1 },
    { key: "d2", label: "D-2", day: days.d2 },
    { key: "d3", label: "D-3", day: days.d3 },
    { key: "lw", label: "LW", day: days.lw },
  ];
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "code" ? 1 : -1 }));
  const arrow = (key) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const exportCsv = () => {
    const head = [
      "Code",
      "Description",
      `Failures ${days.now}`,
      "₹ amount",
      "Share %",
      ...dayCols.flatMap((c) => [`${c.label} (${c.day})`, `${c.label} Δ now %`]),
      "Δ vs L7D avg %",
      ...(extraCol ? [extraCol.label] : []),
    ];
    const line = (r) =>
      [
        r.code,
        r.descr,
        r.now,
        r.amount != null ? Math.round(r.amount) : "",
        r.share?.toFixed(2),
        ...dayCols.flatMap((c) => [r[c.key], r[`${c.key}Δ`]?.toFixed(1)]),
        r.vsAvg?.toFixed(1),
        ...(extraCol ? [extraCol.csv ? extraCol.csv(r.code) : ""] : []),
      ]
        .map(csvCell)
        .join(",");
    const csv = [head.map(csvCell).join(","), ...filtered.map(line), line(total)].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = `sr-declines-${days.now}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const renderRow = (r, isTotal) => {
    const focused = focus && r.code === focus;
    return (
      <tr key={isTotal ? "__total__" : r.code} style={{ background: isTotal ? C.card2 : focused ? "rgba(250,178,25,0.08)" : undefined, fontWeight: isTotal ? 700 : 400 }}>
        <td style={{ ...td, textAlign: "left", position: "sticky", left: 0, background: isTotal ? C.card2 : C.card, maxWidth: 320, whiteSpace: "normal" }}>
          {isTotal ? (
            <span style={{ color: C.text, fontWeight: 700 }}>{r.code}</span>
          ) : (
            <span
              style={{ color: C.text, fontWeight: 600, cursor: "pointer", textDecoration: "underline dotted" }}
              title="Show which banks / PSPs / instruments drive this code (section A)"
              onClick={() => onCodeClick(r.code)}
            >
              {r.code}
            </span>
          )}
          {r.descr && <div style={{ fontSize: 11, color: C.muted, fontWeight: 400, lineHeight: 1.35 }}>{r.descr.replace(/_/g, " ")}</div>}
        </td>
        {showCol("now") && <td style={{ ...td, color: C.text, fontWeight: 700 }}>{fmtNum(r.now)}</td>}
        {showCol("amount") && <td style={{ ...td, color: C.text2 }}>{fmtInr(r.amount)}</td>}
        {showCol("share") && <td style={{ ...td, color: C.text2 }}>{r.share == null ? "—" : `${r.share.toFixed(1)}%`}</td>}
        {dayCols.filter((c) => showCol(c.key)).map((c) => {
          const d = r[`${c.key}Δ`];
          return (
            <td key={c.key} style={td}>
              <div style={{ color: C.text }}>{fmtNum(r[c.key])}</div>
              <div style={{ fontSize: 11, color: tone(d, false, 0.05) }}>{fmtSigned(d, "%", 1)}</div>
            </td>
          );
        })}
        {showCol("vsAvg") && (
          <td style={{ ...td, color: tone(r.vsAvg, false, 0.05), fontWeight: 600 }}>
            {fmtSigned(r.vsAvg, "%", 1)}
            <div style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>{r.excess > 0 ? `+${fmtNum(r.excess)} vs avg` : `${fmtNum(r.excess)} vs avg`}</div>
          </td>
        )}
        {extraCol && showCol("extra") && <td style={{ ...td, textAlign: "left", whiteSpace: "normal", minWidth: 180 }}>{isTotal ? "" : extraCol.render(r.code)}</td>}
      </tr>
    );
  };

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 11, color: C.muted }}>
          Failures on <b style={{ color: C.text2 }}>{fmtDay(days.now)}</b> · Δ = now vs that day ·{" "}
          {amtInfo.amounts
            ? "₹ = failed txn value, Paytm payer handles (raw txns)"
            : amtInfo.days.length
              ? `₹ amount is for ${amtInfo.days.map(fmtDay).join(", ")} — refresh B`
              : "₹ amount: refresh section B"}
        </span>
        {focus && (
          <span style={{ ...pill(true), borderColor: C.warn, color: C.warn, background: "rgba(250,178,25,0.10)", cursor: "default" }}>
            {focus}
            <span style={{ marginLeft: 6, cursor: "pointer" }} onClick={() => onFocus(null)} title="Clear">
              ✕
            </span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (focus) onFocus(null);
          }}
          placeholder="Filter code / description…"
          style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: "5px 9px", width: 200 }}
        />
        {pickKey && (
          <>
            <Picker
              label="Rows"
              title="Add / remove decline codes (default: top 15 by failures; saved in this browser)"
              items={[...data.rows].sort((a, b) => b.now - a.now).map((r) => ({ id: r.code, sub: `${fmtNum(r.now)} fails · ${r.descr.replace(/_/g, " ")}` }))}
              visible={applyPick(topIds, rowPick).filter((id) => data.rows.some((r) => r.code === id))}
              onChange={(ids) => setRowPick(toPick(topIds, ids))}
              changed={rowPick.hidden.length + rowPick.added.length > 0}
              onReset={() => setRowPick(NO_PICK)}
              presets={[5, 10, 30].map((n) => ({ label: `Top ${n}`, ids: [...data.rows].sort((a, b) => b.now - a.now).slice(0, n).map((r) => r.code) })).concat([{ label: "Rising vs L7D", ids: data.rows.filter((r) => r.excess > 0 && r.vsAvg > 10).map((r) => r.code) }])}
            />
            <Picker
              label="Columns"
              title="Show / hide columns (Excel export keeps every column)"
              items={[
                { id: "now", label: "Failures" },
                { id: "amount", label: "Amount (₹)" },
                { id: "share", label: "Share" },
                ...dayCols.map((c) => ({ id: c.key, label: c.label })),
                { id: "vsAvg", label: "Δ vs L7D avg" },
                ...(extraCol ? [{ id: "extra", label: extraCol.label }] : []),
              ]}
              visible={["now", "amount", "share", ...dayCols.map((c) => c.key), "vsAvg", ...(extraCol ? ["extra"] : [])].filter(showCol)}
              onChange={(ids) => setHiddenCols(["now", "amount", "share", ...dayCols.map((c) => c.key), "vsAvg", "extra"].filter((k) => !ids.includes(k)))}
              changed={hiddenCols.join() !== defaultHiddenCols.join()}
              onReset={() => setHiddenCols(defaultHiddenCols)}
            />
          </>
        )}
        <button type="button" style={pill(false)} onClick={exportCsv} title="Download as CSV (opens in Excel)">
          ⬇ Excel
        </button>
      </div>
      <div style={{ overflow: "auto", maxHeight: 520 }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", left: 0, zIndex: 3 }} onClick={() => toggleSort("code")}>
                Code · NPCI description{arrow("code")}
              </th>
              {showCol("now") && (
                <th style={th} onClick={() => toggleSort("now")} title={`Failures on ${fmtDay(days.now)}`}>
                  Failures{arrow("now")}
                </th>
              )}
              {showCol("amount") && (
                <th style={th} onClick={() => toggleSort("amount")} title="₹ value of failed txns (raw txns, Paytm payer handles)">
                  Amount{arrow("amount")}
                </th>
              )}
              {showCol("share") && (
                <th style={th} onClick={() => toggleSort("share")} title="Share of all failures that day">
                  Share{arrow("share")}
                </th>
              )}
              {dayCols.filter((c) => showCol(c.key)).map((c) => (
                <th key={c.key} style={th} onClick={() => toggleSort(`${c.key}Δ`)} title={`${fmtDay(c.day)}${c.key === "lw" ? " (same weekday last week)" : ""}; below: now vs that day, %`}>
                  {c.label}
                  {arrow(`${c.key}Δ`)}
                  <div style={{ fontSize: 9, color: C.muted, fontWeight: 500, textTransform: "none" }}>count · Δ now</div>
                </th>
              ))}
              {showCol("vsAvg") && (
                <th style={th} onClick={() => toggleSort("vsAvg")} title="Now vs L7D daily average, %">
                  Δ vs L7D avg{arrow("vsAvg")}
                </th>
              )}
              {extraCol && showCol("extra") && (
                <th style={{ ...th, textAlign: "left", cursor: "default" }} title={extraCol.title}>
                  {extraCol.label}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.length ? (
              shown.map((r) => renderRow(r, false))
            ) : (
              <tr>
                <td colSpan={extraCol ? 10 : 9} style={{ ...td, textAlign: "center", color: C.muted, padding: 20 }}>
                  {focus ? `${focus} had no failures in this window.` : "No codes match the filter."}
                </td>
              </tr>
            )}
            {renderRow(total, true)}
          </tbody>
        </table>
      </div>
      {!showAll && !focus && !q && filtered.length > shown.length && (
        <div style={{ padding: "8px 16px", fontSize: 12 }}>
          <span style={{ color: C.accent, cursor: "pointer" }} onClick={() => setShowAll(true)}>
            Show all {filtered.length} codes
          </span>
        </div>
      )}
    </div>
  );
}

// Neutral names for the Unified SR Dashboard (the Morning-prefixed ones stay for the Morning tab).
export { MORNING_KINDS as SR_KINDS, MorningKpiStrip as SrKpiStrip };
