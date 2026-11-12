// Ask TSP / TPAP logs — chat over Kibana. The backend (/api/kibana/ask, SSE) lets the LLM query the
// logs with a few tools (count, top values, trend, sample lines) and streams each step here.
// Engine: local Claude Code CLI (logged-in user, default) or the app's LLM routing (Connector Settings,
// publish-defaults-v1) — picked per browser. Conversation + recent questions are
// kept per side in this browser's localStorage.
import { useEffect, useRef, useState } from "react";
import { C, api, Card, Btn, ErrorNote, inputStyle, Markdown } from "./pm-ui.jsx";
import { API_BASE } from "./config.js";

const TRY = {
  tsp: ["Top errors in the last 24h by service", "Mandate execute failures by NPCI code today", "Which switch cluster logs the most errors?", "Any spike in timeouts in the last 3 days?"],
  tpap: ["Top errors in the last 24h by service", "Which PSP gateway (Axis / Yes / SBI / HDFC) logs the most failures today?", "Collect-request failures by error code in the last 6h", "Any spike in timeouts in the last 3 days?"],
};
const RECENT_MAX = 8;
const ENGINE_KEY = "pm-console-kibana-ask-engine";
const CONVO_MAX = 20;
const key = (side, what) => `pm-console-kibana-ask-${what}-${side}`;

const readJson = (k, fb) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fb;
  } catch {
    return fb;
  }
};
const writeJson = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
};

/** Connector Settings → LLM routing fields /api/generate understands. */
function llmRouting() {
  const d = readJson("publish-defaults-v1", {});
  const out = {};
  for (const k of ["llmProvider", "llmDisabled", "foundryModelsEnabled", "bedrockModelTier", "openaiModel"]) if (d[k] != null && d[k] !== "") out[k] = d[k];
  return out;
}

const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—");
const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });

async function streamAsk(body, { onEvent, signal }) {
  const res = await fetch(`${API_BASE}/api/kibana/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (block) => {
    let ev = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) ev = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      onEvent(ev, JSON.parse(data));
    } catch {
      /* partial */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    parts.forEach(handle);
  }
  if (buf.trim()) handle(buf);
}

function Steps({ steps, open, onToggle, running }) {
  if (!steps.length) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <button type="button" onClick={onToggle} style={{ border: "none", background: "none", color: C.text2, fontSize: 12, cursor: "pointer", padding: 0 }}>
        {open ? "▾" : "▸"} ⚙ {steps.length} step(s){running ? " …" : ""}
      </button>
      {open && (
        <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
          {steps.map((s) => (
            <div key={s.i} style={{ fontSize: 11.5, borderLeft: `2px solid ${s.error ? C.bad : s.running ? C.warn : C.border}`, paddingLeft: 8 }}>
              <div>
                <span style={{ color: C.muted }}>{s.i}.</span> <strong style={{ fontFamily: "monospace" }}>{s.tool}</strong>
                {s.why && <span style={{ color: C.text2 }}> — {s.why}</span>}
                <span style={{ color: s.error ? "#fecaca" : C.muted }}>{s.running ? " · running…" : s.error ? ` · ${s.error}` : ` · ${s.summary || ""} · ${((s.ms || 0) / 1000).toFixed(1)}s`}</span>
              </div>
              {Object.keys(s.args || {}).length > 0 && <div style={{ fontFamily: "monospace", color: C.muted, wordBreak: "break-all" }}>{JSON.stringify(s.args)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function KibanaAsk({ side, label }) {
  const [meta, setMeta] = useState(null);
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState(() => readJson(key(side, "convo"), []));
  const [recent, setRecent] = useState(() => readJson(key(side, "recent"), []));
  const [engine, setEngine] = useState(() => readJson(ENGINE_KEY, "auto"));
  useEffect(() => writeJson(ENGINE_KEY, engine), [engine]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [openSteps, setOpenSteps] = useState(() => new Set());
  const ctl = useRef(null);
  const endRef = useRef(null);

  useEffect(() => {
    api(`/api/kibana/ask/meta?side=${side}`)
      .then(setMeta)
      .catch((e) => setErr(e.message));
  }, [side]);
  useEffect(() => writeJson(key(side, "convo"), turns.filter((t) => t.a).slice(-CONVO_MAX)), [turns, side]);
  useEffect(() => writeJson(key(side, "recent"), recent), [recent, side]);

  const patchLast = (fn) => setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? fn(t) : t)));

  const ask = async (text = q) => {
    const question = String(text).trim();
    if (!question || busy) return;
    const history = turns.filter((t) => t.a).map((t) => ({ q: t.q, a: t.a }));
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setErr("");
    setStatus("Starting…");
    setQ("");
    setRecent((r) => [{ q: question, at: Date.now() }, ...r.filter((x) => x.q !== question)].slice(0, RECENT_MAX));
    setTurns((ts) => [...ts, { q: question, steps: [], a: "", at: Date.now() }]);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    const t0 = Date.now();
    try {
      await streamAsk(
        { side, question, history, llm: llmRouting(), engine: engine === "auto" ? undefined : engine },
        {
          signal: c.signal,
          onEvent: (ev, d) => {
            if (ev === "status") setStatus(d.message);
            else if (ev === "step")
              patchLast((t) => {
                const steps = t.steps.filter((s) => s.i !== d.i);
                return { ...t, steps: [...steps, d].sort((a, b) => a.i - b.i) };
              });
            else if (ev === "answer") patchLast((t) => ({ ...t, a: d.text, provider: d.provider, model: d.model, ms: Date.now() - t0 }));
            else if (ev === "error") patchLast((t) => ({ ...t, error: d.message }));
          },
        }
      );
    } catch (e) {
      if (e.name !== "AbortError") patchLast((t) => ({ ...t, error: e.message }));
      else patchLast((t) => ({ ...t, error: "Stopped." }));
    } finally {
      setBusy(false);
      setStatus("");
      ctl.current = null;
    }
  };

  const stop = () => ctl.current?.abort();
  const reset = () => {
    stop();
    setTurns([]);
    setOpenSteps(new Set());
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card>
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
          Ask anything about the <strong>{label}</strong> logs in plain English. The agent queries Kibana for you — counts, top values, trends and a few example lines — over the full window Kibana still holds, then explains it. Keep chatting to dig deeper.
        </div>
        <div style={{ fontSize: 12, color: C.text2, margin: "8px 0 10px" }}>
          📅 {label} logs available:{" "}
          <strong style={{ color: C.text }}>{meta ? `${fmtDay(meta.from)} – ${fmtDay(meta.to)}` : "…"}</strong>
          {meta && ` (${meta.services} production index patterns)`}. Questions are answered within this window.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: C.muted }}>Try:</span>
          {TRY[side].map((t) => (
            <button key={t} type="button" disabled={busy} onClick={() => ask(t)} style={{ padding: "4px 10px", borderRadius: 999, border: `1px solid ${C.border}`, background: "transparent", color: C.text2, fontSize: 11.5, cursor: busy ? "default" : "pointer" }}>
              {t}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            rows={3}
            placeholder="e.g. What are the most common errors in the last 24 hours, and which services do they come from?"
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.5 }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 11, color: C.muted }}>Enter to send · Shift+Enter for a new line ·</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)} title="Which LLM answers" style={{ ...inputStyle, fontSize: 11, padding: "3px 6px" }}>
              <option value="auto">Auto ({meta?.engine === "app" ? "app LLM routing" : `Claude CLI${meta?.cliModel ? ` · ${meta.cliModel}` : ""}`})</option>
              <option value="claude-cli">Claude CLI (your Claude Code login)</option>
              <option value="app">App LLM routing (Connector Settings)</option>
            </select>
            <Btn primary type="submit" disabled={busy || !q.trim()} style={{ marginLeft: "auto", padding: "8px 18px", fontSize: 13 }}>
              💬 Ask {label} logs
            </Btn>
          </div>
        </form>
        {recent.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 10 }}>
            <span style={{ fontSize: 11, color: C.muted }}>Recent:</span>
            {recent.map((r) => (
              <button key={r.q} type="button" title={r.q} onClick={() => setQ(r.q)} style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "4px 10px", borderRadius: 999, border: `1px solid ${C.border}`, background: "transparent", color: C.text2, fontSize: 11.5, cursor: "pointer" }}>
                {r.q} <span style={{ color: C.muted }}>{fmtDate(r.at)}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <ErrorNote>{err}</ErrorNote>

      {turns.length > 0 && (
        <Card
          title="Conversation"
          right={
            <span style={{ display: "inline-flex", gap: 8 }}>
              {busy && (
                <Btn onClick={stop} style={{ color: "#fca5a5" }}>
                  Stop
                </Btn>
              )}
              <Btn onClick={reset}>+ New conversation</Btn>
            </span>
          }
        >
          <div style={{ display: "grid", gap: 14 }}>
            {turns.map((t, idx) => {
              const last = idx === turns.length - 1;
              const stepsOpen = openSteps.has(idx) || (last && busy);
              return (
                <div key={t.at} style={{ display: "grid", gap: 8 }}>
                  <div style={{ justifySelf: "end", maxWidth: "80%", background: "rgba(96,165,250,.12)", border: `1px solid rgba(96,165,250,.35)`, borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>{t.q}</div>
                  <div style={{ maxWidth: "92%", background: C.card2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "10px 14px" }}>
                    <Steps
                      steps={t.steps || []}
                      running={last && busy}
                      open={stepsOpen}
                      onToggle={() =>
                        setOpenSteps((s) => {
                          const n = new Set(s);
                          n.has(idx) ? n.delete(idx) : n.add(idx);
                          return n;
                        })
                      }
                    />
                    {t.a ? (
                      <>
                        <Markdown text={t.a} />
                        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 8 }}>
                          {[t.provider && `via ${t.provider === "claude-cli" ? "Claude CLI" : t.provider}${t.model ? ` · ${t.model}` : ""}`, t.ms && `${(t.ms / 1000).toFixed(1)}s`].filter(Boolean).join(" · ")}
                          <button type="button" onClick={() => navigator.clipboard?.writeText(t.a)} style={{ marginLeft: 10, border: "none", background: "none", color: C.accent, cursor: "pointer", fontSize: 10.5, padding: 0 }}>
                            copy
                          </button>
                        </div>
                      </>
                    ) : t.error ? (
                      <div style={{ color: "#fecaca", fontSize: 12.5 }}>{t.error}</div>
                    ) : (
                      <div style={{ color: C.text2, fontSize: 12.5 }}>{last && busy ? status || "Thinking…" : "No answer."}</div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </Card>
      )}
    </div>
  );
}
