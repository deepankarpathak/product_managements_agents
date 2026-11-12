// Txn Lifecycle Tracer — trace a UPI txn end to end from a txn id or RRN (DB row, per-leg latency,
// failure reason) via Jarvis /txn-trace (proxied at /api/jarvis/txn/*). Jarvis asks for a team
// password; it is kept only in this browser's localStorage and forwarded per request.
import { useEffect, useRef, useState } from "react";
import { C, JARVIS_URL, api, fmtNum, Page, Card, Btn, ErrorNote, inputStyle, AutoTable, RawJson } from "./pm-ui.jsx";

const AUTH_KEY = "pm-console-txn-trace-auth";
const STATUS_COLOR = { SUCCESS: C.good, FAILURE: C.bad, PENDING: C.warn, DEEMED: C.warn };

const readAuth = () => {
  try {
    return localStorage.getItem(AUTH_KEY) || "";
  } catch {
    return "";
  }
};

export default function TxnTracer({ request }) {
  const [auth, setAuth] = useState(readAuth);
  const [authOk, setAuthOk] = useState(false);
  const [pw, setPw] = useState("");
  const [id, setId] = useState(request?.text || "");
  const handed = useRef(null);
  const [date, setDate] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!auth) return;
    api("/api/jarvis/txn/auth", { headers: { "X-RCA-Auth": auth } })
      .then(() => setAuthOk(true))
      .catch(() => setAuthOk(false));
  }, [auth]);


  const signIn = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      await api("/api/jarvis/txn/auth", { headers: { "X-RCA-Auth": pw } });
      try {
        localStorage.setItem(AUTH_KEY, pw);
      } catch {
        /* storage blocked — works for this session only */
      }
      setAuth(pw);
      setAuthOk(true);
      setPw("");
    } catch {
      setErr("Wrong password. Use the Txn Tracer password from Jarvis.");
    }
  };

  const trace = async (e, override) => {
    e?.preventDefault();
    const ident = String(override ?? id).trim();
    if (!ident) return;
    setBusy(true);
    setErr("");
    setResult(null);
    try {
      setResult(await api("/api/jarvis/txn/trace", { method: "POST", headers: { "X-RCA-Auth": auth }, body: JSON.stringify({ identifier: ident, date: date || undefined }) }));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  // An id handed over from the Today page ({ text, id }) is traced as soon as the tracer is signed in.
  useEffect(() => {
    if (!authOk || !request?.text || handed.current === request.id) return;
    handed.current = request.id;
    setId(request.text);
    trace(null, request.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authOk, request]);

  const r = result || {};
  const status = String(r.final_status || r.status || "").toUpperCase();
  const legs = r.legs || r.phases || [];

  return (
    <Page
      title="Txn lifecycle tracer"
      subtitle="Trace a UPI transaction end to end from a txn id or RRN: DB row, per-leg latency, failure reason · source: Jarvis Txn Tracer (no LLM)"
      actions={<Btn onClick={() => window.open(`${JARVIS_URL}/?tab=txn-trace`, "_blank", "noopener")}>Open in Jarvis ↗</Btn>}
    >
      {!authOk ? (
        <Card title="Sign in to the tracer" style={{ maxWidth: 460 }}>
          <form onSubmit={signIn} style={{ display: "flex", gap: 8 }}>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Txn Tracer password" style={{ ...inputStyle, flex: 1 }} autoComplete="current-password" />
            <Btn primary type="submit" disabled={!pw}>
              Sign in
            </Btn>
          </form>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>Same password as the Jarvis tracer. Saved only in this browser.</div>
          <div style={{ marginTop: 8 }}>
            <ErrorNote>{err}</ErrorNote>
          </div>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <form onSubmit={trace} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Txn id (PTM…) or 12-digit RRN" style={{ ...inputStyle, flex: "2 1 320px", fontFamily: "monospace" }} />
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Optional — narrows the search" style={{ ...inputStyle, flex: "0 0 150px", colorScheme: "dark" }} />
              <Btn primary type="submit" disabled={busy || !id.trim()}>
                {busy ? "Tracing…" : "Trace"}
              </Btn>
              <Btn
                onClick={() => {
                  try {
                    localStorage.removeItem(AUTH_KEY);
                  } catch {
                    /* ignore */
                  }
                  setAuth("");
                  setAuthOk(false);
                }}
              >
                Sign out
              </Btn>
            </form>
          </Card>
          <ErrorNote>{err}</ErrorNote>
          {result && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                <Card>
                  <div style={{ fontSize: 11, color: C.text2 }}>Final status</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: STATUS_COLOR[status] || C.text }}>{status || "—"}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{r.reason || r.message || ""}</div>
                </Card>
                <Card>
                  <div style={{ fontSize: 11, color: C.text2 }}>Txn id / RRN</div>
                  <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all" }}>{r.txn_id || "—"}</div>
                  <div style={{ fontSize: 12, fontFamily: "monospace" }}>{r.rrn || "—"}</div>
                </Card>
                <Card>
                  <div style={{ fontSize: 11, color: C.text2 }}>Total time</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{r.total_duration_ms != null ? `${fmtNum(r.total_duration_ms)} ms` : "—"}</div>
                  <div style={{ fontSize: 11, color: C.muted }}>{r.responsibility || ""}</div>
                </Card>
                <Card>
                  <div style={{ fontSize: 11, color: C.text2 }}>Payer → payee</div>
                  <div style={{ fontSize: 12 }}>{r.payer_handle || "—"}</div>
                  <div style={{ fontSize: 12 }}>→ {r.payee_handle || "—"}</div>
                </Card>
              </div>
              {Array.isArray(r.warnings) && r.warnings.length > 0 && (
                <ErrorNote>
                  {r.warnings.map((w, i) => (
                    <div key={i}>{typeof w === "string" ? w : JSON.stringify(w)}</div>
                  ))}
                </ErrorNote>
              )}
              {legs.length > 0 && (
                <Card title="Legs and latency">
                  <AutoTable rows={legs} />
                </Card>
              )}
              {Array.isArray(r.participants) && r.participants.length > 0 && (
                <Card title="Participants">
                  <AutoTable rows={r.participants} />
                </Card>
              )}
              {Array.isArray(r.transitions) && r.transitions.length > 0 && (
                <Card title="Status transitions">
                  <AutoTable rows={r.transitions} />
                </Card>
              )}
              {r.tpap_row && (
                <Card title="TPAP DB row">
                  <AutoTable rows={[r.tpap_row]} />
                </Card>
              )}
              <RawJson value={result} />
            </>
          )}
        </div>
      )}
    </Page>
  );
}
