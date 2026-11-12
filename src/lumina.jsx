// Lumina — Q&A over NPCI UPI circulars, UPI concepts and team docs (Jarvis knowledge base),
// streamed via /api/jarvis/lumina/ask. Conversation is kept per browser tab (not persisted).
import { useEffect, useRef, useState } from "react";
import { C, JARVIS_URL, api, streamSse, Page, Card, Btn, inputStyle, Markdown, fmtDay } from "./pm-ui.jsx";

const SUGGESTIONS = ["What is the UPI Lite per-transaction limit?", "Explain the UDIR dispute flow and TATs", "Which circular sets the P2P payee cap (U16)?", "Latest NPCI rules on AutoPay mandates"];

export default function Lumina({ request }) {
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const ctl = useRef(null);
  const asked = useRef("");
  const endRef = useRef(null);

  useEffect(() => {
    api("/api/jarvis/lumina/summary").then(setSummary).catch(() => {});
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const ask = async (text) => {
    const question = String(text || "").trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: question }, { role: "assistant", text: "", statuses: [], streaming: true }]);
    const patch = (fn) => setMsgs((m) => m.map((x, i) => (i === m.length - 1 ? fn(x) : x)));
    ctl.current = new AbortController();
    try {
      await streamSse(
        "/api/jarvis/lumina/ask",
        { question },
        {
          signal: ctl.current.signal,
          onStatus: (s) => patch((x) => ({ ...x, statuses: [...x.statuses, typeof s === "string" ? s : JSON.stringify(s)] })),
          onResult: (r) => patch((x) => ({ ...x, text: typeof r === "string" ? r : r.answer || JSON.stringify(r), streaming: false })),
          onError: (e) => patch((x) => ({ ...x, text: `Error: ${e}`, streaming: false })),
        }
      );
      patch((x) => (x.streaming ? { ...x, streaming: false, text: x.text || "No answer returned." } : x));
    } catch (e) {
      patch((x) => ({ ...x, streaming: false, text: e.name === "AbortError" ? x.text || "Stopped." : `Error: ${e.message}` }));
    } finally {
      ctl.current = null;
      setBusy(false);
    }
  };

  // A question handed over from the Today page ({ text, id } — id changes per hand-over).
  useEffect(() => {
    if (request?.text && request.id !== asked.current) {
      asked.current = request.id;
      ask(request.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const recent = (summary?.circulars?.items || [])
    .slice()
    .sort((a, b) => String(b.date_issued).localeCompare(String(a.date_issued)))
    .slice(0, 8);

  return (
    <Page
      title="Lumina"
      subtitle={`Ask about NPCI UPI circulars, dispute flows, limits and team docs · ${summary ? `${summary.counts?.circulars ?? 0} circulars, ${summary.counts?.concepts ?? 0} concepts indexed` : "Jarvis knowledge base"}`}
      actions={<Btn onClick={() => window.open(`${JARVIS_URL}/?tab=lumina`, "_blank", "noopener")}>Open in Jarvis ↗</Btn>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 280px", gap: 12, alignItems: "start" }}>
        <Card style={{ display: "flex", flexDirection: "column", minHeight: 420 }}>
          <div style={{ flex: 1, display: "grid", gap: 12, alignContent: "start", marginBottom: 12 }}>
            {!msgs.length && (
              <div style={{ color: C.text2, fontSize: 13 }}>
                Try:
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {SUGGESTIONS.map((s) => (
                    <Btn key={s} onClick={() => ask(s)}>
                      {s}
                    </Btn>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} style={{ justifySelf: "end", maxWidth: "80%", background: "rgba(96,165,250,.12)", border: "1px solid #1e3a5f", borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
                  {m.text}
                </div>
              ) : (
                <div key={i} style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px" }}>
                  {m.streaming && (
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {m.statuses.length ? m.statuses[m.statuses.length - 1] : "Thinking…"}
                    </div>
                  )}
                  {m.text && <Markdown text={m.text} />}
                </div>
              )
            )}
            <div ref={endRef} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(q);
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about NPCI regulations, UPI flows, circulars…" style={{ ...inputStyle, flex: 1 }} />
            {busy ? (
              <Btn onClick={() => ctl.current?.abort()}>Stop</Btn>
            ) : (
              <Btn primary type="submit" disabled={!q.trim()}>
                Ask
              </Btn>
            )}
          </form>
        </Card>
        <Card title="Recent circulars">
          {recent.map((c) => (
            <div key={c.wiki_page} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}`, cursor: "pointer" }} onClick={() => ask(`Summarise ${c.circular_number} and what it means for a TPAP`)} title="Ask Lumina to summarise">
              <div style={{ fontSize: 11, color: C.muted }}>{fmtDay(c.date_issued)}</div>
              <div style={{ fontSize: 12 }}>{String(c.title || c.circular_number).replace(/^NPCI:[^—]*—\s*/, "")}</div>
            </div>
          ))}
        </Card>
      </div>
    </Page>
  );
}
