import { useCallback, useEffect, useMemo, useState } from "react";
import BreakdownTable from "./breakdown-table.jsx";

// Success Rate Snippet — P2M day-level snapshot for Paytm TPAP payer handles
// (PTYES, PTAXIS, PTSBI, PTHDFC). Mirrors Superset dashboard 575.
// Backend /api/srsnippet/* returns raw daily counts per (day, payer handle, dimension);
// every metric below is computed here so the handle filter needs no re-query.
//
// Periods (all relative to Y = latest complete day in the data):
//   Yesterday  = Y            Day Before = Y-1
//   L7D        = Y-7 … Y-1    (the 7 days before Yesterday; "vs L7D" compares Y against it)
//   MTD        = 1st of Y's month … Y
//   LMTD       = 1st of previous month … same day-of-month (clamped to month end)

const API = "/api/srsnippet";
const HANDLES = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
const ERROR_TOP_N = 15;
const PSP_ORDER = ["PhonePe", "Google Pay", "Paytm", "Others"];

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
};

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
const addDays = (d, n) => toDay(toMs(d) + n * DAY);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : "—");

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const chg = (a, b) => (a != null && b > 0 ? ((a - b) * 100) / b : null);
const diff = (a, b) => (a != null && b != null ? a - b : null);
const fmtPct = (v, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtSigned = (v, unit, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtTime = (ms) =>
  ms ? new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Period boundaries from the latest data day. */
function periods(yday) {
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

const inRange = (d, a, b) => d >= a && d <= b;

/** Aggregate rows into { [dim]: { y, db, l7, mtd, lmtd } } of {total, success} plus a "__ALL__" total. */
function aggregate(rows, P, handleSel) {
  const out = {};
  const bump = (dim, key, r) => {
    const o = (out[dim] ||= { y: z(), db: z(), l7: z(), mtd: z(), lmtd: z() });
    o[key].total += r.total;
    o[key].success += r.success;
  };
  for (const r of rows) {
    if (handleSel !== "all" && r.handle !== handleSel) continue;
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
const z = () => ({ total: 0, success: 0 });

// ─── section builders ────────────────────────────────────────────────────────

function srRows(agg, order) {
  const sr = (x) => pct(x.success, x.total);
  return order.map((dim) => {
    const a = agg[dim] || { y: z(), db: z(), l7: z(), mtd: z(), lmtd: z() };
    const y = sr(a.y);
    const l7 = sr(a.l7);
    const mtd = sr(a.mtd);
    const lmtd = sr(a.lmtd);
    return {
      dim,
      vol: a.y.total,
      cells: [y, sr(a.db), diff(y, l7), mtd, lmtd, diff(mtd, lmtd), l7],
    };
  });
}

function successRows(agg, order) {
  return order.map((dim) => {
    const a = agg[dim] || { y: z(), db: z(), l7: z(), mtd: z(), lmtd: z() };
    const l7avg = a.l7.success / 7;
    return {
      dim,
      vol: a.y.total,
      cells: [a.y.success, a.db.success, chg(a.y.success, l7avg), a.mtd.success, a.lmtd.success, chg(a.mtd.success, a.lmtd.success), l7avg],
    };
  });
}

function errorRows(agg) {
  const fails = (x) => x.total - x.success;
  const codes = Object.keys(agg).filter((k) => k !== "__ALL__");
  const tot = { y: 0, db: 0, mtd: 0, lmtd: 0 };
  for (const c of codes) for (const k of Object.keys(tot)) tot[k] += fails(agg[c][k]);
  const ranked = codes
    .map((code) => {
      const a = agg[code];
      const f = { y: fails(a.y), db: fails(a.db), mtd: fails(a.mtd), lmtd: fails(a.lmtd) };
      return { code, f };
    })
    .filter((r) => r.f.y > 0 || r.f.mtd > 0)
    .sort((a, b) => b.f.y - a.f.y || b.f.mtd - a.f.mtd)
    .slice(0, ERROR_TOP_N);
  const rows = ranked.map(({ code, f }) => ({
    dim: code,
    cells: [f.y, pct(f.y, tot.y), f.mtd, f.lmtd, pct(f.mtd, tot.mtd), pct(f.lmtd, tot.lmtd), chg(f.mtd, f.lmtd), chg(f.y, f.db)],
  }));
  const total = {
    dim: "All failures",
    cells: [tot.y, 100, tot.mtd, tot.lmtd, 100, 100, chg(tot.mtd, tot.lmtd), chg(tot.y, tot.db)],
  };
  return { rows, total };
}

// ─── UI bits ─────────────────────────────────────────────────────────────────

const tone = (v, goodWhenUp) => {
  if (v == null || Math.abs(v) < 0.005) return C.text2;
  return (v > 0) === goodWhenUp ? C.good : C.bad;
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

/** cols: [{ label, title, fmt, tone?: boolean (goodWhenUp) }] */
function Table({ firstCol, cols, rows, total }) {
  const renderRow = (r, isTotal) => (
    <tr key={r.dim} style={isTotal ? { background: C.card2, fontWeight: 700 } : undefined}>
      <td style={{ ...td, textAlign: "left", color: C.text, fontWeight: isTotal ? 700 : 600 }}>{r.dim}</td>
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
  return (
    <div style={{ overflowX: "auto" }}>
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
  );
}

function toTsv(firstCol, cols, rows, total) {
  const lines = [[firstCol, ...cols.map((c) => c.label)].join("\t")];
  for (const r of [...rows, ...(total ? [total] : [])]) lines.push([r.dim, ...r.cells.map((v, i) => cols[i].fmt(v))].join("\t"));
  return lines.join("\n");
}

function Section({ n, title, desc, job, cached, firstCol, cols, rows, total, onShowSql }) {
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
        <Table firstCol={firstCol} cols={cols} rows={rows} total={total} />
      ) : (
        <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>
          {job?.status === "running" ? "Running on Trino…" : "No data yet — click Refresh."}
        </div>
      )}
    </div>
  );
}

function JobBadge({ job, cached }) {
  if (job?.status === "running")
    return <span style={{ fontSize: 11, color: C.warn, whiteSpace: "nowrap" }}>● running · {fmtDur(Date.now() - job.startedAt)}</span>;
  if (!cached) return null;
  return (
    <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }} title={`Query took ${fmtDur(cached.durationMs)}`}>
      updated {fmtTime(cached.finishedAt)}
    </span>
  );
}

const btn = (primary) => ({
  padding: "6px 12px",
  borderRadius: 6,
  border: `1px solid ${primary ? C.accent : C.border}`,
  background: primary ? C.accent : "transparent",
  color: primary ? "#04261a" : C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
});

// ─── main ────────────────────────────────────────────────────────────────────

export default function SrSnippet() {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [handleSel, setHandleSel] = useState("all");
  const [sql, setSql] = useState(null);

  const load = useCallback(async () => {
    try {
      setState(await api("/state"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

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
      await api("/run", { method: "POST" });
      await load();
    } catch (e) {
      setError(e.message);
    }
  };

  const showSql = async (section) => {
    try {
      const r = await api(`/sql?section=${section}`);
      setSql(r);
    } catch (e) {
      setError(e.message);
    }
  };

  const cache = state?.cache || {};
  const jobs = state?.jobs || {};

  // Y = latest day present in the data (Looker table can lag a day).
  const yday = useMemo(() => {
    let max = "";
    for (const s of ["breakdown", "psp", "instrument", "errors"]) for (const r of cache[s]?.rows || []) if (r.ts > max) max = r.ts;
    return max || null;
  }, [cache]);
  const P = useMemo(() => (yday ? periods(yday) : null), [yday]);

  const pspAgg = useMemo(() => (P ? aggregate(cache.psp?.rows || [], P, handleSel) : {}), [cache.psp, P, handleSel]);
  const instAgg = useMemo(() => (P ? aggregate(cache.instrument?.rows || [], P, handleSel) : {}), [cache.instrument, P, handleSel]);
  const errAgg = useMemo(() => (P ? aggregate(cache.errors?.rows || [], P, handleSel) : {}), [cache.errors, P, handleSel]);

  const pspOrder = useMemo(() => {
    const extra = Object.keys(pspAgg).filter((k) => k !== "__ALL__" && !PSP_ORDER.includes(k));
    return [...PSP_ORDER.filter((k) => pspAgg[k]), ...extra];
  }, [pspAgg]);
  const instOrder = useMemo(
    () =>
      Object.keys(instAgg)
        .filter((k) => k !== "__ALL__")
        .sort((a, b) => instAgg[b].mtd.total - instAgg[a].mtd.total),
    [instAgg],
  );

  const withTotal = (rows) => {
    const t = rows.find((r) => r.dim === "__ALL__");
    return { rows: rows.filter((r) => r.dim !== "__ALL__"), total: t ? { ...t, dim: "Overall" } : null };
  };
  const s1 = withTotal(P ? srRows(pspAgg, [...pspOrder, "__ALL__"]) : []);
  const s3 = withTotal(P ? successRows(pspAgg, [...pspOrder, "__ALL__"]) : []);
  const s4 = withTotal(P ? srRows(instAgg, [...instOrder, "__ALL__"]) : []);
  const s2 = P ? errorRows(errAgg) : { rows: [], total: null };

  const per = P
    ? {
        y: fmtDay(P.yday),
        db: fmtDay(P.dbefore),
        l7: `${fmtDay(P.l7From)} – ${fmtDay(P.l7To)}`,
        mtd: `${fmtDay(P.mtdFrom)} – ${fmtDay(P.mtdTo)}`,
        lmtd: `${fmtDay(P.lmtdFrom)} – ${fmtDay(P.lmtdTo)}`,
      }
    : {};

  const srCols = [
    { label: "Yesterday", title: per.y, fmt: (v) => fmtPct(v) },
    { label: "Day Before", title: per.db, fmt: (v) => fmtPct(v) },
    { label: "vs L7D", title: `Yesterday SR − L7D SR (${per.l7}), percentage points`, fmt: (v) => fmtSigned(v, " pp"), tone: true },
    { label: "MTD", title: per.mtd, fmt: (v) => fmtPct(v) },
    { label: "LMTD", title: per.lmtd, fmt: (v) => fmtPct(v) },
    { label: "MTD Δ%", title: "MTD SR − LMTD SR, percentage points", fmt: (v) => fmtSigned(v, " pp"), tone: true },
    { label: "Last 7D Avg", title: `SR over ${per.l7}`, fmt: (v) => fmtPct(v) },
  ];
  const cntCols = [
    { label: "Yesterday", title: per.y, fmt: fmtNum },
    { label: "Day Before", title: per.db, fmt: fmtNum },
    { label: "vs L7D", title: `Yesterday vs L7D daily average (${per.l7}), % change`, fmt: (v) => fmtSigned(v, "%"), tone: true },
    { label: "MTD", title: per.mtd, fmt: fmtNum },
    { label: "LMTD", title: per.lmtd, fmt: fmtNum },
    { label: "MTD Δ%", title: "MTD vs LMTD, % change", fmt: (v) => fmtSigned(v, "%"), tone: true },
    { label: "Last 7D Avg", title: `Daily average over ${per.l7}`, fmt: fmtNum },
  ];
  const errCols = [
    { label: "Yesterday Failures", title: per.y, fmt: fmtNum },
    { label: "Yesterday Contrib%", title: "Share of all failures yesterday", fmt: (v) => fmtPct(v) },
    { label: "MTD Failures", title: per.mtd, fmt: fmtNum },
    { label: "LMTD Failures", title: per.lmtd, fmt: fmtNum },
    { label: "MTD Contrib%", title: "Share of all MTD failures", fmt: (v) => fmtPct(v) },
    { label: "LMTD Contrib%", title: "Share of all LMTD failures", fmt: (v) => fmtPct(v) },
    { label: "MTD Δ%", title: "MTD failures vs LMTD failures, % change", fmt: (v) => fmtSigned(v, "%", 1), tone: false },
    { label: "Yday Δ%", title: "Yesterday failures vs Day Before failures, % change", fmt: (v) => fmtSigned(v, "%", 1), tone: false },
  ];

  const handleLabel = handleSel === "all" ? "PTYES + PTAXIS + PTSBI + PTHDFC" : handleSel.toUpperCase();

  return (
    <div style={{ minHeight: "calc(100vh - 40px)", background: C.bg, color: C.text, fontFamily: "'Segoe UI', sans-serif", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Success Rate Snippet</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
            P2M · payer {handleLabel} · Yesterday = {per.y || "—"} · MTD {per.mtd || "—"} vs LMTD {per.lmtd || "—"} · source
            team_product.LOOKER_TPAP_Txns_V3 (Trino)
          </div>
        </div>
        <a
          href="/#history?dashboard=srsnippet"
          target="_blank"
          rel="noopener noreferrer"
          title="Open run history (query, output, insights) in a new tab"
          style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          🕘 History ↗
        </a>
        <div style={{ display: "flex", gap: 4 }}>
          {["all", ...HANDLES].map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHandleSel(h)}
              style={{
                ...btn(false),
                borderColor: handleSel === h ? C.accent : C.border,
                color: handleSel === h ? C.accent : C.text2,
              }}
            >
              {h === "all" ? "All 4" : h.toUpperCase()}
            </button>
          ))}
        </div>
        <button type="button" onClick={refresh} style={btn(true)} disabled={state?.running}>
          {state?.running ? "Running…" : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#2a1215", border: `1px solid ${C.bad}`, color: "#fecaca", padding: "8px 12px", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}
      {state && (
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
          Opening this tab only reads cached results. Backend auto-refreshes daily at {state.schedule?.join(" & ")} IST.
        </div>
      )}

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, marginBottom: 16, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>1 · P2M SR Breakdown — impact ranked</div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
              Yesterday vs D-1/D-2/D-3, same weekday last week and L7D average, by payee PSP / payer bank / payer instrument. Rows sorted by
              contribution to the overall SR change; WARN/CRIT when the SR drop and its impact both cross threshold.
            </div>
          </div>
          {jobs.breakdown?.status === "error" && <span style={{ fontSize: 11, color: C.bad }}>last run failed</span>}
          <JobBadge job={jobs.breakdown} cached={cache.breakdown} />
          <button type="button" onClick={() => showSql("breakdown")} style={btn(false)}>
            SQL
          </button>
        </div>
        {jobs.breakdown?.status === "running" && !cache.breakdown ? (
          <div style={{ padding: 24, color: C.muted, fontSize: 13, textAlign: "center" }}>Running on Trino…</div>
        ) : (
          <BreakdownTable rows={cache.breakdown?.rows || []} yday={cache.breakdown?.rows?.length ? yday : null} handleSel={handleSel} fileTag="sr-breakdown" />
        )}
      </div>

      <Section
        n={2}
        title="P2M Payee PSP Wise SR%"
        desc="SR% for P2M where payer is a Paytm TPAP handle, by payee PSP: PhonePe (ybl, axl, ibl), Google Pay (okbizaxis, okbizicici, okpayaxis), Paytm (pty, ptybl, ptys, paytm), Others."
        job={jobs.psp}
        cached={cache.psp}
        firstCol="PSP"
        cols={srCols}
        {...s1}
        onShowSql={() => showSql("psp")}
      />
      <Section
        n={3}
        title={`P2M Top ${ERROR_TOP_N} Errors And Contribution %`}
        desc="Top error codes (app_resp_code) by yesterday's failures and their share of all failures — which codes increased / decreased."
        job={jobs.errors}
        cached={cache.errors}
        firstCol="Error Code"
        cols={errCols}
        {...s2}
        onShowSql={() => showSql("errors")}
      />
      <Section
        n={4}
        title="P2M Payee PSP Wise Success Txns"
        desc="Successful P2M txn count by payee PSP (same PSP grouping as section 2)."
        job={jobs.psp}
        cached={cache.psp}
        firstCol="PSP"
        cols={cntCols}
        {...s3}
        onShowSql={() => showSql("psp")}
      />
      <Section
        n={5}
        title="P2M Payer Instrument Wise SR%"
        desc="SR% by payer instrument for P2M — payer-side health. Sorted by MTD volume."
        job={jobs.instrument}
        cached={cache.instrument}
        firstCol="Instrument"
        cols={srCols}
        {...s4}
        onShowSql={() => showSql("instrument")}
      />

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
              <div style={{ flex: 1, fontWeight: 700 }}>SQL · {sql.section}</div>
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
