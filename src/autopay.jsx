// Automatic Payments (#autopay) — Phase 1 embed of the APD (third_party/apd_installer).
// The APD page is served by the backend at /api/apd/page/automatic_payments/ and refreshed by
// backend/apdRunner.js (daily from 10:15 IST). Deep links: #autopay?board=iccw&code=UM3 — the query is
// passed to the APD page as-is (board, stage, purpose, mode, date, from, to, code ...).
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE } from "./config.js";
import { C, Btn, api, fmtDay, fmtAgo } from "./pm-ui.jsx";
import { ApdToggle, useApdConfig } from "./apd-toggle.jsx";

const BOARDS = [
  { id: "mandate", label: "Mandate" },
  { id: "cc", label: "CC Autopay" },
  { id: "cccasa", label: "CC vs CASA" },
  { id: "interop", label: "Interop" },
  { id: "upiglobal", label: "UPI Global" },
];
// Boards moved to native tabs (Phase 2): the APD page still has them, the strip links out instead.
const MOVED = [{ id: "iccw", label: "ICCW", href: "#product?tab=iccw", where: "Product Wise" }];
const FRESH_KEY = { mandate: "mandate", cc: "cc", cccasa: "cccasa", interop: "interop", upiglobal: "upiglobal" };

const hashQuery = () => {
  const h = window.location.hash;
  const i = h.indexOf("?");
  return new URLSearchParams(i >= 0 ? h.slice(i + 1) : "");
};

function freshLabel(b) {
  if (!b) return "—";
  if (b.through) return `through ${fmtDay(b.through)}`;
  if (b.updatedAt) return `updated ${fmtAgo(new Date(b.updatedAt).getTime())}`;
  return "no data";
}

const pill = (active) => ({
  padding: "5px 12px",
  borderRadius: 999,
  border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? "rgba(96,165,250,.15)" : "transparent",
  color: active ? C.text : C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
});

// Where each APD board lives now (Product Wise), for the "turned off" page.
const NOW_IN = [
  ["Mandate", "#product?tab=mandates", "Mandates §1–5 (+ long ranges, codes with party, medians)"],
  ["CC Autopay", "#product?tab=mandates", "Mandates with Payer account = CC"],
  ["CC vs CASA", "#product?tab=cccasa", "CC vs CASA tab (Autopay + P2M, before / after, Excel)"],
  ["Top merchants", "#product?tab=mandates", "Mandates §6"],
  ["Code watch", "#product?tab=mandates", "Mandates §7"],
  ["Interop", "#product?tab=interop", "Interop tab"],
  ["UPI Global", "#product?tab=international", "UPI International"],
  ["ICCW", "#product?tab=iccw", "ICCW tab"],
];

export default function AutoPayments({ active = true }) {
  const apdCfg = useApdConfig();
  const [query, setQuery] = useState(() => hashQuery());
  const [state, setState] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

  const board = query.get("board") || "mandate";

  // Follow #autopay?… edits (bookmarks, back/forward).
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash.split("?")[0] === "#autopay") setQuery(hashQuery());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const load = useCallback(async () => {
    try {
      setState(await api("/api/apd/state"));
      setErr("");
    } catch (e) {
      setErr(`Backend not reachable: ${e.message}`);
    }
  }, []);

  // Poll faster while a refresh runs; reload the frame once a run finishes.
  const running = Boolean(state?.running);
  useEffect(() => {
    if (!active) return undefined;
    load();
    const t = setInterval(load, running ? 15000 : 120000);
    return () => clearInterval(t);
  }, [active, load, running]);
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (wasRunning && !running) setFrameKey((k) => k + 1);
    setWasRunning(running);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickBoard = (id) => {
    const q = new URLSearchParams();
    q.set("board", id);
    window.history.replaceState(null, "", `#autopay?${q.toString()}`);
    setQuery(q);
  };

  const src = useMemo(() => {
    // Same origin on purpose: dev goes through the CRA /api proxy (src/setupProxy.js), prod is served by Express.
    // A cross-origin frame (127.0.0.1:5000 inside localhost:3000) rendered blank.
    const base = state?.pageUrl || "/api/apd/page/automatic_payments/";
    const q = query.toString();
    return q ? `${base}?${q}` : base;
  }, [state?.pageUrl, query]);

  const run = async (force) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/apd/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) setErr(data.reason || data.error || `HTTP ${res.status}`);
      await load();
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api("/api/apd/stop", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const fresh = Object.fromEntries((state?.boards || []).map((b) => [b.id, b]));
  const lr = state?.lastRun;
  const failedSteps = (lr?.steps || []).filter((s) => s.status === "failed").map((s) => s.name);
  const setupIssues = [
    state && !state.installed && "APD files not found under third_party/apd_installer",
    state && !state.python?.ok && `Python packages missing for ${state.python?.path}: run  ${state.python?.path} -m pip install --user trino pandas openpyxl`,
    state && !state.credentials?.trino && "Trino credentials missing (TRINO_API_URL + TRINO_BACKUP_* or APD_TRINO_* in .env)",
    state && !state.credentials?.redash && "TPAP Redash key missing (PTYES_REDASH_API_KEY or APD_REDASH_API_KEY in .env)",
  ].filter(Boolean);

  if (apdCfg && !apdCfg.active) {
    return (
      <div style={{ flex: 1, minHeight: "100vh", background: C.bg, color: C.text, padding: 24 }}>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Automatic Payments</div>
        <div style={{ marginBottom: 16 }}>
          <ApdToggle />
        </div>
        <div style={{ fontSize: 13, color: C.text2, marginBottom: 12 }}>
          {apdCfg.installed ? "This dashboard is turned off." : `The APD folder was not found (${apdCfg.apdDir}).`} Every board now lives in Product Wise:
        </div>
        <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {NOW_IN.map(([b, href, where]) => (
              <tr key={b}>
                <td style={{ padding: "4px 16px 4px 0", fontWeight: 600 }}>{b}</td>
                <td style={{ padding: "4px 0" }}>
                  <a href={href} style={{ color: C.accent }}>
                    {where}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh", background: C.bg, color: C.text }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${C.border}`, background: C.card2 }}>
        <div style={{ fontWeight: 700, fontSize: 15, marginRight: 6 }}>Automatic Payments</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {BOARDS.map((b) => (
            <button key={b.id} style={pill(board === b.id)} onClick={() => pickBoard(b.id)} title={freshLabel(fresh[FRESH_KEY[b.id]])}>
              {b.label}
              <span style={{ marginLeft: 6, fontWeight: 400, color: C.muted, fontSize: 11 }}>{fresh[FRESH_KEY[b.id]]?.through ? fmtDay(fresh[FRESH_KEY[b.id]].through) : ""}</span>
            </button>
          ))}
          {MOVED.map((m) => (
            <a key={m.id} href={m.href} style={{ ...pill(false), textDecoration: "none", borderStyle: "dashed" }} title={`Moved to ${m.where}`}>
              {m.label} → {m.where}
            </a>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: C.text2, textAlign: "right", lineHeight: 1.4 }}>
          {running ? (
            <span style={{ color: C.warn }}>
              Refreshing since {new Date(state.running.startedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              {lr?.steps?.length ? ` · ${lr.steps[lr.steps.length - 1].name}` : ""} (~30–60 min)
            </span>
          ) : lr ? (
            <span style={{ color: lr.status === "failed" ? C.bad : C.text2 }}>
              Last refresh {lr.startedAt} · {lr.status}
              {failedSteps.length ? ` (failed: ${failedSteps.join(", ")})` : ""}
            </span>
          ) : (
            <span>No refresh run yet · daily from 10:15 IST</span>
          )}
        </div>
        {running ? (
          <Btn onClick={stop} disabled={busy}>Stop</Btn>
        ) : (
          <Btn primary onClick={() => run(true)} disabled={busy || setupIssues.length > 0} title="Pull missing days + D-1 for every board (Trino, VPN)">
            Refresh now
          </Btn>
        )}
        <Btn onClick={() => setFrameKey((k) => k + 1)} title="Reload the page (after a refresh)">Reload</Btn>
        <ApdToggle compact />
      </div>
      {(err || setupIssues.length > 0) && (
        <div style={{ padding: "8px 16px", fontSize: 12, color: C.warn, background: "rgba(250,178,25,.08)", borderBottom: `1px solid ${C.border}` }}>
          {[err, ...setupIssues].filter(Boolean).map((m) => (
            <div key={m}>⚠ {m}</div>
          ))}
        </div>
      )}
      <iframe key={`${frameKey}-${board}`} title="Automatic Payments Dashboard" src={src} style={{ flex: 1, border: "none", width: "100%", minHeight: "calc(100vh - 60px)", background: "#fff" }} />
    </div>
  );
}
