import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// History — every Morning Dashboard / Success Rate Snippet query run (manual + scheduled),
// read from backend /api/history/*. The list loads only light index entries for the
// chosen date range (default: last 3 days); an item's full output is fetched on click.
// Records live as Markdown in Query_Agent/AnaylsisAgent_output/history/YYYY-MM-DD/.

const API = "/api/history";

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#f59e0b",
};

// Status chips: colour + icon + label (never colour alone).
const STATUS = {
  Done: { color: "#22c55e", icon: "✓" },
  Progress: { color: "#38bdf8", icon: "⟳" },
  Planned: { color: "#94a3b8", icon: "◷" },
  Stopped: { color: "#fab219", icon: "■" },
  Failed: { color: "#ef4444", icon: "✕" },
};
const ACTIVE = new Set(["Progress", "Planned"]);

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { "Content-Type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Today's date in IST as YYYY-MM-DD, shifted by n days. */
function istDay(n = 0) {
  return new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);
}
const fmtStamp = (ms) =>
  ms
    ? new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

/** Dashboard pre-selected from the URL: #history?dashboard=morning */
function dashboardFromHash() {
  const m = /[?&]dashboard=([a-z]+)/.exec(window.location.hash || "");
  return m ? m[1] : "all";
}

const btn = (variant) => ({
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${variant === "primary" ? C.accent : C.border}`,
  background: variant === "primary" ? C.accent : C.card2,
  color: variant === "primary" ? "#111" : C.text,
});
const input = { background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 8px", fontSize: 12, colorScheme: "dark" };

function StatusChip({ status }) {
  const st = STATUS[status] || STATUS.Planned;
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: 11, fontWeight: 600, color: st.color, border: `1px solid ${st.color}55`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
      <span aria-hidden>{st.icon}</span>
      {status}
    </span>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.text2, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function List({ items, empty }) {
  if (!items || !items.length) return <div style={{ fontSize: 13, color: C.muted }}>{empty}</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: C.text, lineHeight: 1.55 }}>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function OutTable({ t }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 4 }}>{t.title}</div>
      <div style={{ overflow: "auto", maxHeight: 320, border: `1px solid ${C.border}`, borderRadius: 6 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr>
              {t.columns.map((c, i) => (
                <th key={i} style={{ position: "sticky", top: 0, background: C.card2, color: C.text2, textAlign: i ? "right" : "left", padding: "6px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                {r.map((v, j) => (
                  <td key={j} style={{ padding: "5px 10px", textAlign: j ? "right" : "left", color: C.text, whiteSpace: "nowrap" }}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Detail({ id, onRerun }) {
  const [item, setItem] = useState(null);
  const [err, setErr] = useState(null);
  const [showMd, setShowMd] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [rerunMsg, setRerunMsg] = useState(null);

  const load = useCallback(() => {
    api(`/item/${id}`)
      .then((d) => {
        setItem(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [id]);

  useEffect(() => {
    setItem(null);
    setRerunMsg(null);
    setShowMd(false);
    load();
  }, [load]);

  // Follow a run that is still going.
  const status = item?.record?.status;
  useEffect(() => {
    if (!ACTIVE.has(status)) return undefined;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [status, load]);

  if (err) return <div style={{ color: "#fecaca", fontSize: 13 }}>Could not load this item: {err}</div>;
  if (!item) return <div style={{ color: C.muted, fontSize: 13 }}>Loading output…</div>;
  const r = item.record;
  const a = r.analysis || {};

  const rerun = async () => {
    setRerunMsg({ busy: true, text: "Starting…" });
    try {
      const d = await api(`/rerun/${r.id}`, { method: "POST" });
      setRerunMsg({ ok: true, text: `Re-run started: ${d.started}. It will appear at the top of the list.` });
      onRerun();
    } catch (e) {
      setRerunMsg({ ok: false, text: e.message });
    }
  };

  const meta = [
    ["Dashboard", r.dashboardName],
    ["Section", r.sectionTitle],
    ["Trigger", r.trigger === "schedule" ? "Auto (schedule)" : "Manual"],
    ["Created", fmtStamp(r.createdAt)],
    ["Updated", fmtStamp(r.updatedAt)],
    ["Window", r.window ? `${r.window.from} → ${r.window.to}` : r.durationLabel || "—"],
    ["Engine", r.engine || "—"],
    ["Attempt", r.attempt ?? "—"],
    ["Run time", r.elapsedMs != null ? `${Math.round(r.elapsedMs / 1000)} s` : "—"],
    ["Rows", r.rowCount ?? "—"],
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 10 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Task name</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{r.taskName || r.subject}</div>
        </div>
        <StatusChip status={r.status} />
        <button type="button" style={btn("primary")} onClick={rerun} disabled={rerunMsg?.busy}>
          ⟳ Re-run (Refresh)
        </button>
        <button type="button" style={btn()} onClick={() => setShowMd((v) => !v)}>
          {showMd ? "Formatted view" : "View .md"}
        </button>
      </div>
      {rerunMsg && <div style={{ fontSize: 12, marginBottom: 10, color: rerunMsg.ok === false ? "#fecaca" : "#86efac" }}>{rerunMsg.text}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "6px 14px", fontSize: 12, marginBottom: 14, padding: 10, background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        {meta.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={{ color: C.muted, fontSize: 11 }}>{k}</div>
            <div style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis" }} title={String(v)}>
              {v}
            </div>
          </div>
        ))}
      </div>

      {showMd ? (
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#cbd5e1", background: "#020617", border: `1px solid ${C.border}`, borderRadius: 6, padding: 12, maxHeight: 640, overflow: "auto" }}>
          {item.markdown || "(Markdown not written yet)"}
        </pre>
      ) : (
        <>
          <Section title="Task summary">
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{a.summary || (ACTIVE.has(r.status) ? `Run is ${r.status.toLowerCase()} — output appears when it finishes.` : "—")}</div>
          </Section>
          <Section title="Action required">
            <List items={a.actions} empty={r.status === "Failed" ? "Query failed — see the error under Other details, then re-run." : "None."} />
          </Section>
          <Section title="Next steps">
            <List items={a.nextSteps} empty="—" />
          </Section>
          <Section title="What stands out">
            <List items={a.standouts} empty="—" />
          </Section>
          <Section title="Other details">
            {r.error && (
              <div role="alert" style={{ background: "#450a0a", border: "1px solid #7f1d1d", color: "#fecaca", borderRadius: 6, padding: "8px 10px", fontSize: 12, marginBottom: 10, wordBreak: "break-word" }}>
                <b>Error:</b> {r.error}
              </div>
            )}
            {(a.tables || []).map((t, i) => (
              <OutTable key={i} t={t} />
            ))}
            {r.sql && (
              <>
                <button type="button" style={{ ...btn(), marginBottom: 6 }} onClick={() => setShowSql((v) => !v)}>
                  {showSql ? "Hide query" : "Show query"}
                </button>
                {showSql && (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#cbd5e1", background: "#020617", border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, maxHeight: 300, overflow: "auto" }}>{r.sql}</pre>
                )}
              </>
            )}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8, wordBreak: "break-all" }}>File: {item.file}</div>
          </Section>
        </>
      )}
    </div>
  );
}

export default function DashboardHistory({ active = true }) {
  const [dashboard, setDashboard] = useState(dashboardFromHash);
  const [from, setFrom] = useState(() => istDay(-2));
  const [to, setTo] = useState(() => istDay(0));
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const reqId = useRef(0);

  const load = useCallback(() => {
    const my = ++reqId.current;
    setLoading(true);
    api(`/list?dashboard=${dashboard}&from=${from}&to=${to}`)
      .then((d) => {
        if (my !== reqId.current) return;
        setData(d);
        setErr(null);
      })
      .catch((e) => my === reqId.current && setErr(e.message))
      .finally(() => my === reqId.current && setLoading(false));
  }, [dashboard, from, to]);

  // Reload when filters change or when the tab is shown again.
  useEffect(() => {
    if (active) load();
  }, [active, load]);

  const items = useMemo(() => (data?.items || []).filter((e) => statusFilter === "all" || e.status === statusFilter), [data, statusFilter]);
  const anyActive = items.some((e) => ACTIVE.has(e.status));
  useEffect(() => {
    if (!active || !anyActive) return undefined;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [active, anyActive, load]);

  const counts = useMemo(() => {
    const c = {};
    for (const e of data?.items || []) c[e.status] = (c[e.status] || 0) + 1;
    return c;
  }, [data]);

  return (
    <div style={{ minHeight: "100%", background: C.bg, color: C.text, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header style={{ position: "sticky", top: 0, zIndex: 20, background: `${C.bg}f2`, borderBottom: `1px solid ${C.border}`, padding: "10px 16px", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>🕘 History</h1>
        <span style={{ fontSize: 11, color: C.muted }}>Dashboard query runs — manual and auto</span>
        <div style={{ marginLeft: "auto", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 12, color: C.text2 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Dashboard
            <select style={input} value={dashboard} onChange={(e) => setDashboard(e.target.value)}>
              <option value="all">All dashboards</option>
              <option value="morning">Morning Dashboard</option>
              <option value="srsnippet">Success Rate Snippet</option>
              <option value="product">Product Wise</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            Start
            <input type="date" style={input} value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            End
            <input type="date" style={input} value={to} min={from} max={istDay(0)} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </label>
          <button
            type="button"
            style={btn()}
            onClick={() => {
              setFrom(istDay(-2));
              setTo(istDay(0));
            }}
          >
            Last 3 days
          </button>
          <button type="button" style={btn()} onClick={load} disabled={loading}>
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </header>

      <main style={{ padding: 16, maxWidth: 1500, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 460px), 1fr))", gap: 16, alignItems: "start" }}>
        <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {items.length} task{items.length === 1 ? "" : "s"}
            </span>
            <span style={{ fontSize: 11, color: C.muted }}>
              {from} → {to} (IST)
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 4, flexWrap: "wrap" }}>
              {["all", "Done", "Progress", "Planned", "Stopped", "Failed"].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  style={{ ...btn(), padding: "3px 8px", fontSize: 11, background: statusFilter === s ? "#1e3a5f" : C.card2, color: statusFilter === s ? "#fff" : C.text2 }}
                >
                  {s === "all" ? "All" : s}
                  {s !== "all" && counts[s] ? ` ${counts[s]}` : ""}
                </button>
              ))}
            </div>
          </div>
          {err && <div style={{ color: "#fecaca", fontSize: 12, marginBottom: 8 }}>{err}</div>}
          <div style={{ maxHeight: "calc(100vh - 220px)", overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Task subject", "Timestamp (IST)", "Status"].map((h, i) => (
                    <th key={h} style={{ position: "sticky", top: 0, background: C.card2, color: C.text2, textAlign: i === 0 ? "left" : i === 2 ? "center" : "left", padding: "7px 10px", borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!items.length && (
                  <tr>
                    <td colSpan={3} style={{ padding: 18, textAlign: "center", color: C.muted }}>
                      {loading ? "Loading…" : "No runs in this range. Runs are recorded from now on — refresh a dashboard section to create one."}
                    </td>
                  </tr>
                )}
                {items.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e.id)}
                    tabIndex={0}
                    onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && setSelected(e.id)}
                    style={{ cursor: "pointer", borderBottom: `1px solid ${C.border}`, background: selected === e.id ? "#1e3a5f55" : "transparent" }}
                  >
                    <td style={{ padding: "7px 10px", minWidth: 220 }}>
                      <div style={{ color: C.text, fontWeight: 600 }}>{e.subject}</div>
                      <div style={{ color: C.muted, fontSize: 11 }}>
                        {e.dashboardName} · {e.trigger === "schedule" ? "Auto" : "Manual"}
                        {e.summary ? ` · ${e.summary.length > 90 ? `${e.summary.slice(0, 90)}…` : e.summary}` : ""}
                      </div>
                    </td>
                    <td style={{ padding: "7px 10px", whiteSpace: "nowrap", color: C.text2 }}>{fmtStamp(e.createdAt)}</td>
                    <td style={{ padding: "7px 10px", textAlign: "center" }}>
                      <StatusChip status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.root && <div style={{ fontSize: 11, color: C.muted, marginTop: 8, wordBreak: "break-all" }}>Saved as Markdown in {data.root}</div>}
        </section>

        <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, minWidth: 0, position: "sticky", top: 64 }}>
          {selected ? <Detail key={selected} id={selected} onRerun={() => setTimeout(load, 1500)} /> : <div style={{ fontSize: 13, color: C.muted }}>Select a task to see its output, insights and Re-run.</div>}
        </section>
      </main>
    </div>
  );
}
