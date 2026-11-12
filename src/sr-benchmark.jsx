// Success-Rate Agent — cross-PSP acquiring benchmark: flags error codes where Paytm is a stable
// outlier vs PhonePe / GPay on the same acquiring path (Prometheus, 5 samples ~2 min).
// Runs via /api/jarvis/sragent/benchmark; the last run is kept on the backend for the Today page.
import { useEffect, useState } from "react";
import { C, JARVIS_URL, api, fmtNum, fmtAgo, Page, Card, Btn, ErrorNote, th, td } from "./pm-ui.jsx";

const VERDICT = {
  "subject-outlier": { label: "Paytm outlier", color: C.bad },
  comparable: { label: "comparable", color: C.text2 },
  "peer-worse": { label: "peers worse", color: C.good },
  "bank-mix-artifact": { label: "bank-mix artifact", color: C.warn },
  "merchant-mix-artifact": { label: "merchant-mix artifact", color: C.warn },
  "too-few-events": { label: "too few events", color: C.muted },
};
const SIDE = { "payer-leg": "payer leg", beneficiary: "beneficiary", internal: "internal" };
const PEER_NAME = { paytm: "Paytm", phonepe: "PhonePe", gpay: "GPay" };

export default function SrBenchmark() {
  const [last, setLast] = useState(null);
  const [instance, setInstance] = useState("tsp");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api("/api/jarvis/sragent/last").then(setLast).catch(() => {});
  }, []);

  useEffect(() => {
    if (!busy) return undefined;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      setLast(await api("/api/jarvis/sragent/benchmark", { method: "POST", body: JSON.stringify({ instance, bank_control: true }) }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const r = last?.result;
  const findings = (r?.all_findings || [])
    .filter((f) => showAll || f.verdict !== "too-few-events")
    .sort((a, b) => (b.excess_per_10k || 0) - (a.excess_per_10k || 0));
  const cohorts = r ? [r.subject, ...(r.peers || [])] : [];

  return (
    <Page
      title="Success-rate benchmark"
      subtitle="Paytm vs PhonePe / GPay on the same acquiring path (we are payee, P2M) · flags error codes where Paytm is a stable outlier after bank controls · source: Jarvis Success-Rate Agent"
      actions={
        <>
          <Btn onClick={() => window.open(`${JARVIS_URL}/?tab=sr-agent`, "_blank", "noopener")}>Open in Jarvis ↗</Btn>
          {["tsp", "tpap"].map((i) => (
            <Btn key={i} primary={instance === i} disabled={busy} onClick={() => setInstance(i)}>
              {i.toUpperCase()}
            </Btn>
          ))}
          <Btn primary disabled={busy} onClick={run}>
            {busy ? `Running… ${elapsed}s` : "▶ Run benchmark"}
          </Btn>
        </>
      }
    >
      {busy && <div style={{ fontSize: 12, color: C.text2, marginBottom: 10 }}>Takes 5 samples 20 s apart — usually about 2 minutes. You can switch pages; the result is saved.</div>}
      <ErrorNote>{err}</ErrorNote>
      {!r && !busy && <Card>No benchmark run yet. Click Run benchmark.</Card>}
      {r && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 12, color: C.muted }}>
            Last run {fmtAgo(last.ranAt)} · {String(r.instance || "").toUpperCase()} · {r.samples} samples · {r.population}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
            {cohorts.map((c) => {
              const v = r.volumes?.[c];
              const isUs = c === r.subject;
              return (
                <Card key={c} style={isUs ? { borderColor: "#1e3a5f" } : undefined}>
                  <div style={{ fontSize: 11, color: C.text2 }}>{PEER_NAME[c] || c} SR</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{v?.sr_pct != null ? `${v.sr_pct.toFixed(2)}%` : "—"}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {fmtNum(v?.total)} txns · {fmtNum(v?.failure)} failed
                  </div>
                </Card>
              );
            })}
            <Card>
              <div style={{ fontSize: 11, color: C.text2 }}>Actionable codes</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: r.actionable?.length ? C.bad : C.good }}>{r.actionable?.length || 0}</div>
              <div style={{ fontSize: 11, color: C.muted }}>sanity {r.population_check?.passed ? "passed" : "failed"} · {r.population_check?.blended_sr}% vs board {r.population_check?.reference_sr}%</div>
            </Card>
          </div>

          {r.actionable?.length > 0 && (
            <Card title="Actionable — Paytm is a stable outlier">
              {r.actionable.map((a, i) => (
                <div key={i} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                  <b style={{ fontFamily: "monospace" }}>{a.code}</b> · {SIDE[a.side] || a.side} · {a.median_ratio ?? a.ratio}x peers · +{a.median_excess_per_10k ?? a.excess_per_10k}/10k
                  {a.note && <div style={{ color: C.text2 }}>{a.note}</div>}
                </div>
              ))}
            </Card>
          )}

          <Card
            title="Findings by error code"
            right={
              <label style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> include low-volume codes
              </label>
            }
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Code</th>
                    <th style={th}>Side</th>
                    <th style={th}>Verdict</th>
                    <th style={{ ...th, textAlign: "right" }}>Paytm /10k</th>
                    <th style={{ ...th, textAlign: "right" }}>Peers /10k</th>
                    <th style={{ ...th, textAlign: "right" }}>Ratio</th>
                    <th style={{ ...th, textAlign: "right" }}>Banks confirming</th>
                    <th style={th}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((f, i) => {
                    const v = VERDICT[f.verdict] || { label: f.verdict, color: C.text2 };
                    return (
                      <tr key={`${f.code}-${f.side}-${i}`}>
                        <td style={{ ...td, fontFamily: "monospace" }}>{f.code}</td>
                        <td style={{ ...td, color: C.text2 }}>{SIDE[f.side] || f.side}</td>
                        <td style={{ ...td, color: v.color }}>{v.label}</td>
                        <td style={{ ...td, textAlign: "right" }}>{f.subject_per_10k}</td>
                        <td style={{ ...td, textAlign: "right" }}>{f.peer_per_10k}</td>
                        <td style={{ ...td, textAlign: "right", fontWeight: 600, color: f.ratio >= 2 ? C.warn : C.text }}>{f.ratio}x</td>
                        <td style={{ ...td, textAlign: "right" }}>{f.banks_checked ? `${f.banks_confirming}/${f.banks_checked}` : "—"}</td>
                        <td style={{ ...td, color: C.text2 }}>{f.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          {r.report_text && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 12, color: C.text2 }}>Full text report</summary>
              <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, overflow: "auto", color: C.text2 }}>{r.report_text}</pre>
            </details>
          )}
        </div>
      )}
    </Page>
  );
}
