import { useMemo, useRef, useState } from "react";

// Utilities — ad-hoc lookup tools. Talks to backend /api/utils/*.
// Each tool runs one Trino query on demand (nothing runs on page open).

const API = "/api/utils";

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#a78bfa",
};

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
    const v = localStorage.getItem(`utils:${k}`);
    return v == null ? fb : JSON.parse(v);
  } catch {
    return fb;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(`utils:${k}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const btn = (variant = "default") => ({
  padding: "6px 14px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${variant === "primary" ? C.accent : variant === "danger" ? "#7f1d1d" : C.border}`,
  background: variant === "primary" ? C.accent : variant === "danger" ? "#450a0a" : C.card2,
  color: variant === "primary" ? "#111" : variant === "danger" ? "#fecaca" : C.text,
});

function Table({ columns, rows, empty }) {
  const [sort, setSort] = useState(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.dir === "asc" ? 1 : -1);
    });
  }, [rows, sort]);
  const cell = { padding: "6px 10px", whiteSpace: "nowrap" };
  return (
    <div style={{ maxHeight: 560, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 6 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                style={{
                  ...cell,
                  position: "sticky",
                  top: 0,
                  background: C.card2,
                  color: C.text2,
                  fontWeight: 600,
                  textAlign: c.align || "right",
                  borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer",
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
            <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
              {columns.map((c) => (
                <td key={c.key} style={{ ...cell, textAlign: c.align || "right", color: C.text }}>
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

// ─── 1 · Handle Finder ───────────────────────────────────────────────────────

const HANDLE_FINDER_COLUMNS = [
  { key: "vpa", label: "VPA", align: "left" },
  { key: "name", label: "Name", align: "left" },
  { key: "mcc", label: "MCC", align: "left" },
  { key: "bank_code", label: "Bank", align: "left" },
  { key: "txns", label: "Txns", render: (r) => Number(r.txns).toLocaleString("en-IN") },
];

function HandleFinder() {
  const [term, setTerm] = useState(() => lsGet("handleFinder", "flipkart"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const abortRef = useRef(null);

  const search = async () => {
    const t = term.trim();
    if (!t || busy) return;
    lsSet("handleFinder", t);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api("/handle-finder", { method: "POST", body: { term: t }, signal: controller.signal }));
    } catch (e) {
      if (e.name !== "AbortError") setErr(e.message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <section style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>1 · Handle Finder</h2>
        <span style={{ fontSize: 11, color: C.muted }}>Top 50 payee VPAs containing the value · last 3 days · Trino</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="e.g. flipkart"
          aria-label="VPA search value"
          style={{ background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13, minWidth: 260 }}
        />
        <button type="submit" style={btn("primary")} disabled={busy || !term.trim()}>
          {busy ? "Running…" : "Search"}
        </button>
        {busy && (
          <button type="button" style={btn("danger")} onClick={() => abortRef.current?.abort()}>
            ■ Stop
          </button>
        )}
        {result && !busy && (
          <span style={{ fontSize: 11, color: C.muted }}>
            {result.rows.length} rows for “{result.term}” · {(result.ms / 1000).toFixed(1)}s
          </span>
        )}
        {result && (
          <button type="button" style={{ ...btn(), marginLeft: "auto" }} onClick={() => setShowSql((s) => !s)}>
            {showSql ? "Hide SQL" : "Show SQL"}
          </button>
        )}
      </form>
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>{err}</div>}
      {showSql && result && (
        <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.text2, overflowX: "auto", marginBottom: 12 }}>
          {result.sql}
        </pre>
      )}
      {result && <Table columns={HANDLE_FINDER_COLUMNS} rows={result.rows} empty={`No payee VPAs containing “${result.term}”`} />}
    </section>
  );
}

export default function Utilities() {
  return (
    <div style={{ minHeight: "100%", background: C.bg, color: C.text, fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 10, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>🛠 Utilities</h1>
        <span style={{ fontSize: 11, color: C.muted }}>Ad-hoc lookups · run on demand</span>
      </header>
      <main style={{ padding: 16, maxWidth: 1400, margin: "0 auto" }}>
        <HandleFinder />
      </main>
    </div>
  );
}
