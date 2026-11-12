// Kibana Logs — search TSP (kibana.paytmybl.com) or TPAP (tpapprod-logging-elk) Kibana for a
// txn id / UMN / RRN, customer id, mobile number, payer / payee VPA or PG MID. Direct over VPN via
// the backend (/api/kibana/*), no LLM. Search history is kept in this browser's localStorage.
import { useEffect, useMemo, useRef, useState } from "react";
import { C, api, fmtNum, Page, Card, Btn, ErrorNote, inputStyle } from "./pm-ui.jsx";
import { API_BASE } from "./config.js";
import KibanaAsk from "./kibana-ask.jsx";

const HISTORY_KEY = "pm-console-kibana-history";
const TAB_KEY = "pm-console-kibana-tab";
const TABS = [
  { id: "search", label: "🔎 Search logs" },
  { id: "ask-tsp", label: "💬 Ask TSP logs" },
  { id: "ask-tpap", label: "💬 Ask TPAP logs" },
];
const FORM_KEY = "pm-console-kibana-form";
const HISTORY_MAX = 50;

const ID_TYPES = [
  { id: "txn", label: "Txn ID / UMN / RRN", field: "Txn ID / UMN / RRN", ph: "e.g. PTM8a1b… or 631512345678 or abc123@ptyes (UMN)" },
  { id: "customer", label: "Customer ID", field: "Customer ID(s)", ph: "e.g. 1234567890" },
  { id: "mobile", label: "Mobile No", field: "Mobile number(s) — 91 prefix optional", ph: "e.g. 9876543210" },
  { id: "payer", label: "Payer VPA", field: "Payer VPA(s)", ph: "e.g. 9876543210@ptyes" },
  { id: "payee", label: "Payee VPA", field: "Payee VPA(s)", ph: "e.g. paytmqr1abc@ptys" },
  { id: "mid", label: "PG MID", field: "PG MID(s)", ph: "e.g. ABCDEF12345678901234" },
];
const ID_BY = Object.fromEntries(ID_TYPES.map((t) => [t.id, t]));
const RANGES = [
  ["15m", "Last 15 minutes"],
  ["1h", "Last 1 hour"],
  ["4h", "Last 4 hours"],
  ["12h", "Last 12 hours"],
  ["24h", "Last 24 hours"],
  ["3d", "Last 3 days"],
  ["7d", "Last 7 days"],
  ["custom", "Custom range…"],
];
const RANGE_LABEL = Object.fromEntries(RANGES);
const SIZES = [50, 100, 200, 500, 1000];
const LEVEL_COLOR = { ERROR: C.bad, FATAL: C.bad, WARN: C.warn, WARNING: C.warn, INFO: C.text2, DEBUG: C.muted, TRACE: C.muted };
const ERRORISH = /\b(ERROR|FAIL(?:URE|ED)?|EXCEPTION|TIMEOUT|DECLINED?)\b/i;

const DEFAULT_FORM = { side: "tsp", by: "txn", values: "", index: "", allIndices: true, range: "24h", from: "", to: "", extra: "", size: 200, order: "asc", allFields: false };

const readJson = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, v) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked — history just won't persist */
  }
};

const fmtTs = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
  const t = d.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" });
  return `${day} ${t}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const fmtWhen = (ms) => new Date(ms).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pretty-print a message that is (or ends in) JSON; XML gets a newline between tags. */
function pretty(msg) {
  const s = String(msg || "");
  const i = s.search(/[{[]/);
  if (i >= 0) {
    try {
      const obj = JSON.parse(s.slice(i));
      return `${s.slice(0, i)}\n${JSON.stringify(obj, null, 2)}`;
    } catch {
      /* not JSON */
    }
  }
  if (/<\?xml|<\w+:\w+[\s>]/.test(s)) return s.replace(/>\s*</g, ">\n<");
  return s;
}

function Highlight({ text, re }) {
  if (!re || !text) return text || "";
  const parts = String(text).split(re);
  return parts.map((p, i) =>
    i % 2 ? (
      <mark key={i} style={{ background: "rgba(250,178,25,.28)", color: "#fde68a", borderRadius: 2, padding: "0 1px" }}>
        {p}
      </mark>
    ) : (
      p
    )
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", flexWrap: "wrap", border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            style={{
              padding: "7px 14px",
              border: "none",
              borderRight: `1px solid ${C.border}`,
              background: on ? "rgba(96,165,250,.18)" : "transparent",
              color: on ? "#bfdbfe" : C.text2,
              fontSize: 12,
              fontWeight: on ? 700 : 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const Label = ({ children, right }) => (
  <div style={{ display: "flex", alignItems: "center", fontSize: 11, color: C.text2, fontWeight: 600, marginBottom: 5 }}>
    <span style={{ flex: 1 }}>{children}</span>
    {right}
  </div>
);

const Chip = ({ on, children, onClick, title }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    style={{
      padding: "3px 10px",
      borderRadius: 999,
      border: `1px solid ${on ? C.accent : C.border}`,
      background: on ? "rgba(96,165,250,.15)" : "transparent",
      color: on ? "#bfdbfe" : C.text2,
      fontSize: 11,
      cursor: "pointer",
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </button>
);

function LogRow({ h, re, open, onToggle, onPivot }) {
  const lvl = String(h.level || "").toUpperCase();
  const msg = h.message || (h.source ? JSON.stringify(h.source) : "");
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", background: open ? "rgba(96,165,250,.06)" : undefined }}>
        <td style={{ padding: "5px 8px", borderBottom: `1px solid ${C.border}`, fontFamily: "monospace", fontSize: 11, color: C.text2, whiteSpace: "nowrap", verticalAlign: "top" }}>{fmtTs(h.ts)}</td>
        <td style={{ padding: "5px 8px", borderBottom: `1px solid ${C.border}`, fontSize: 11, color: C.text2, verticalAlign: "top", maxWidth: 210, wordBreak: "break-all" }}>
          {h.service}
          {h.roles && <div style={{ color: h.roles.includes("payer") ? "#93c5fd" : "#f9a8d4", fontSize: 10, fontWeight: 700 }}>as {h.roles.join(" + ")}</div>}
        </td>
        <td style={{ padding: "5px 8px", borderBottom: `1px solid ${C.border}`, fontSize: 10, fontWeight: 700, color: LEVEL_COLOR[lvl] || C.muted, verticalAlign: "top" }}>{lvl || "—"}</td>
        <td style={{ padding: "5px 8px", borderBottom: `1px solid ${C.border}`, fontFamily: "monospace", fontSize: 11.5, color: C.text, verticalAlign: "top", wordBreak: "break-all", whiteSpace: open ? "pre-wrap" : "normal" }}>
          {open ? <Highlight text={pretty(msg)} re={re} /> : <Highlight text={msg.length > 420 ? `${msg.slice(0, 420)} …` : msg} re={re} />}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ padding: "6px 8px 10px", borderBottom: `1px solid ${C.border}`, background: "rgba(96,165,250,.04)" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 11, color: C.text2 }}>
              {[
                ["index", h.index],
                ["logger", h.logger],
                ["thread", h.thread],
                ["host", h.host],
                ["url", h.url],
                ["request-id", h.requestId],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <span key={k}>
                    <span style={{ color: C.muted }}>{k}:</span> <span style={{ fontFamily: "monospace" }}>{v}</span>
                  </span>
                ))}
              {h.seqNo && (
                <span>
                  <span style={{ color: C.muted }}>seq-no:</span> <span style={{ fontFamily: "monospace" }}>{h.seqNo}</span>{" "}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPivot(h.seqNo);
                    }}
                    style={{ border: "none", background: "none", color: C.accent, cursor: "pointer", fontSize: 11, padding: 0 }}
                  >
                    search this seq-no →
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard?.writeText(msg);
                }}
                style={{ border: "none", background: "none", color: C.accent, cursor: "pointer", fontSize: 11, padding: 0 }}
              >
                copy message
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function KibanaLogs({ request }) {
  const [tab, setTab] = useState(() => readJson(TAB_KEY, "search"));
  const [askMounted, setAskMounted] = useState({});
  useEffect(() => {
    if (tab.startsWith("ask-")) setAskMounted((m) => ({ ...m, [tab.slice(4)]: true }));
  }, [tab]);
  useEffect(() => writeJson(TAB_KEY, tab), [tab]);
  const [meta, setMeta] = useState(null);
  const [form, setForm] = useState(() => ({ ...DEFAULT_FORM, ...readJson(FORM_KEY, {}), values: "" }));
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(() => readJson(HISTORY_KEY, []));
  const [histOpen, setHistOpen] = useState(true);
  const [histFilter, setHistFilter] = useState("");
  const [svcFilter, setSvcFilter] = useState(null);
  const [textFilter, setTextFilter] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [roleOnly, setRoleOnly] = useState(false);
  const [openRows, setOpenRows] = useState(() => new Set());
  const [elapsed, setElapsed] = useState(0);
  const ctl = useRef(null);
  const handed = useRef(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const side = meta?.sides?.find((s) => s.id === form.side);
  const idType = ID_BY[form.by] || ID_TYPES[0];

  useEffect(() => {
    api("/api/kibana/meta")
      .then(setMeta)
      .catch((e) => setErr(`Backend: ${e.message}`));
  }, []);

  // Remember the form (minus the identifiers) between visits.
  useEffect(() => {
    const { values, ...rest } = form;
    writeJson(FORM_KEY, rest);
  }, [form]);

  useEffect(() => writeJson(HISTORY_KEY, history), [history]);

  useEffect(() => {
    if (!busy) return undefined;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);

  const run = async (f = form) => {
    if (!f.values.trim()) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setBusy(true);
    setElapsed(0);
    setErr("");
    setResult(null);
    setSvcFilter(null);
    setTextFilter("");
    setErrorsOnly(false);
    setRoleOnly(false);
    setOpenRows(new Set());
    const body = { ...f, range: f.range === "custom" ? undefined : f.range, from: f.range === "custom" ? f.from : undefined, to: f.range === "custom" ? f.to || undefined : undefined };
    try {
      const res = await fetch(`${API_BASE}/api/kibana/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: c.signal });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setResult(d);
      const entry = { at: Date.now(), form: { ...f }, total: d.total, relation: d.totalRelation };
      setHistory((h) => [entry, ...h.filter((x) => JSON.stringify(x.form) !== JSON.stringify(f))].slice(0, HISTORY_MAX));
    } catch (e) {
      if (e.name !== "AbortError") setErr(e.message);
    } finally {
      if (ctl.current === c) {
        setBusy(false);
        ctl.current = null;
      }
    }
  };

  const stop = () => {
    ctl.current?.abort();
    ctl.current = null;
    setBusy(false);
    setErr("Search stopped.");
  };

  // A txn id handed over from another page ({ text, id }) prefills the box and runs on TSP+all indices.
  useEffect(() => {
    if (!request?.text || handed.current === request.id) return;
    handed.current = request.id;
    const f = { ...form, by: "txn", values: request.text, allIndices: true };
    setTab("search");
    setForm(f);
    run(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const pivot = (seq) => {
    const f = { ...form, by: "txn", values: seq };
    setForm(f);
    run(f);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  const re = useMemo(() => {
    const ps = (result?.phrases || []).filter(Boolean);
    return ps.length ? new RegExp(`(${ps.map(escRe).join("|")})`, "gi") : null;
  }, [result]);

  const shown = useMemo(() => {
    if (!result) return [];
    const tf = textFilter.trim().toLowerCase();
    return result.hits.filter(
      (h) =>
        (!svcFilter || h.service === svcFilter || h.index?.startsWith(svcFilter)) &&
        (!errorsOnly || /ERROR|FATAL|WARN/i.test(h.level || "") || ERRORISH.test(h.message || "")) &&
        (!roleOnly || h.roles?.includes(result.by)) &&
        (!tf || `${h.message} ${h.service} ${h.seqNo || ""} ${h.logger || ""}`.toLowerCase().includes(tf))
    );
  }, [result, svcFilter, textFilter, errorsOnly, roleOnly]);

  const histShown = useMemo(() => {
    const q = histFilter.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => JSON.stringify(h.form).toLowerCase().includes(q) || (h.form.side === "tsp" ? "tsp" : "tpap").includes(q));
  }, [history, histFilter]);

  const presets = side?.presets || [];
  const indexValue = form.allIndices ? side?.allIndices || "" : form.index;
  const shownServices = result ? new Set(result.hits.map((h) => h.service)) : null;

  return (
    <Page
      title="🔎 Kibana Logs"
      subtitle={tab === "search" ? "Search TSP or TPAP Kibana for a txn id / UMN / RRN, customer id, mobile number, payer / payee VPA or PG MID · direct over VPN, no AI cost" : "Ask the logs in plain English · the agent queries Kibana with counts, top values, trends and samples, then explains"}
      actions={
        <div style={{ display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: C.text2 }}>
          {(meta?.sides || []).map((s) => (
            <span key={s.id} title={s.status?.ok ? `${s.host} · Kibana ${s.status.version}` : s.status?.error} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: 9, background: s.status?.ok ? C.good : C.bad }} />
              Kibana {s.label}
            </span>
          ))}
        </div>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Seg options={TABS} value={tab} onChange={setTab} />
      </div>
      {/* Ask tabs stay mounted once opened so a running conversation survives switching tabs. */}
      <div style={{ display: tab === "ask-tsp" ? "block" : "none" }}>{(tab === "ask-tsp" || askMounted.tsp) && <KibanaAsk side="tsp" label="TSP" />}</div>
      <div style={{ display: tab === "ask-tpap" ? "block" : "none" }}>{(tab === "ask-tpap" || askMounted.tpap) && <KibanaAsk side="tpap" label="TPAP" />}</div>
      <div style={{ display: tab === "search" ? "grid" : "none", gap: 12 }}>
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run();
            }}
            style={{ display: "grid", gap: 14 }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Seg
                options={[
                  { id: "tsp", label: `TSP · ${meta?.sides?.find((s) => s.id === "tsp")?.host || "kibana.paytmybl.com"}` },
                  { id: "tpap", label: `TPAP · ${meta?.sides?.find((s) => s.id === "tpap")?.host?.split(".")[0] || "tpapprod-logging-elk"}` },
                ]}
                value={form.side}
                onChange={(id) => set({ side: id, index: "" })}
              />
              <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>{side?.status?.ok ? `Kibana ${side.status.version} · logs kept ~3 days` : side?.status?.error || ""}</span>
            </div>

            <div>
              <Label>Search by</Label>
              <Seg options={ID_TYPES} value={form.by} onChange={(id) => set({ by: id })} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
              <div>
                <Label>{idType.field} · one per line, up to 20</Label>
                <textarea
                  value={form.values}
                  onChange={(e) => set({ values: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      run();
                    }
                  }}
                  placeholder={idType.ph}
                  rows={3}
                  spellCheck={false}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontFamily: "monospace", resize: "vertical" }}
                />
                {(form.by === "payer" || form.by === "payee") && (
                  <div style={{ fontSize: 10.5, color: C.muted, marginTop: 4 }}>Matches every line mentioning the VPA; lines where it appears as {form.by} (XML Payer/Payee addr, payerVpa…) are tagged and can be filtered.</div>
                )}
              </div>
              <div>
                <Label
                  right={
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 500, cursor: "pointer" }}>
                      <input type="checkbox" checked={form.allIndices} onChange={(e) => set({ allIndices: e.target.checked })} /> all indices
                    </label>
                  }
                >
                  Service (index pattern — pick a preset or type, comma-separated)
                </Label>
                <input
                  value={indexValue}
                  disabled={form.allIndices}
                  onChange={(e) => set({ index: e.target.value })}
                  placeholder={presets[0]?.index || "prod-*"}
                  spellCheck={false}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontFamily: "monospace", opacity: form.allIndices ? 0.6 : 1 }}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  {presets.map((p) => (
                    <Chip key={p.label} on={!form.allIndices && form.index === p.index} title={p.index} onClick={() => set({ index: p.index, allIndices: false })}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
              <div>
                <Label>Time range</Label>
                <select value={form.range} onChange={(e) => set({ range: e.target.value })} style={{ ...inputStyle, width: "100%" }}>
                  {RANGES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <Label>Extra filter (optional, Lucene — e.g. "ReqMandate" OR ERROR)</Label>
                <input value={form.extra} onChange={(e) => set({ extra: e.target.value })} placeholder='e.g. "ReqPay" AND NOT "Ack"' spellCheck={false} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontFamily: "monospace" }} />
              </div>
              <div>
                <Label>Max rows</Label>
                <select value={form.size} onChange={(e) => set({ size: Number(e.target.value) })} style={{ ...inputStyle, width: "100%" }}>
                  {SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Order</Label>
                <select value={form.order} onChange={(e) => set({ order: e.target.value })} style={{ ...inputStyle, width: "100%" }}>
                  <option value="asc">Oldest first (trace)</option>
                  <option value="desc">Newest first</option>
                </select>
              </div>
            </div>

            {form.range === "custom" && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: C.text2 }}>
                From <input type="datetime-local" value={form.from} onChange={(e) => set({ from: e.target.value })} style={{ ...inputStyle, colorScheme: "dark" }} />
                to <input type="datetime-local" value={form.to} onChange={(e) => set({ to: e.target.value })} style={{ ...inputStyle, colorScheme: "dark" }} />
                <span style={{ color: C.muted }}>(your local time; empty “to” = now)</span>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.text2, cursor: "pointer" }}>
                <input type="checkbox" checked={form.allFields} onChange={(e) => set({ allFields: e.target.checked })} /> Search all fields (not only log.message / contextMap)
              </label>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                {busy && <span style={{ fontSize: 11, color: C.muted }}>Searching {side?.label} · {elapsed}s</span>}
                {busy && <Btn onClick={stop}>Stop</Btn>}
                <Btn primary type="submit" disabled={busy || !form.values.trim()} style={{ padding: "8px 18px", fontSize: 13 }}>
                  {busy ? "Searching…" : "🔎 Search logs"}
                </Btn>
              </div>
            </div>
          </form>
        </Card>

        <ErrorNote>{err}</ErrorNote>

        {result && (
          <Card
            title={
              <span>
                {fmtNum(result.total)}
                {result.totalRelation === "gte" ? "+" : ""} hits · {result.sideLabel} · {result.byLabel}
                <span style={{ color: C.muted, fontWeight: 400 }}>
                  {" "}
                  · showing {fmtNum(shown.length)} of {fmtNum(result.hits.length)} fetched
                </span>
              </span>
            }
            right={
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <span>{(result.ms / 1000).toFixed(1)}s</span>
                <Btn onClick={() => window.open(result.discoverUrl, "_blank", "noopener")} title={result.dataView ? `Data view: ${result.dataView}` : "Opens Discover with the same query (pick the data view there)"}>
                  Open in Kibana ↗
                </Btn>
                <Btn onClick={() => navigator.clipboard?.writeText(shown.map((h) => `${h.ts}\t${h.service}\t${h.level || ""}\t${h.message}`).join("\n"))}>Copy</Btn>
                <Btn onClick={() => download(`kibana-${result.side}-${result.values[0]}.log`, shown.map((h) => `${h.ts} [${h.service}] ${h.level || ""} ${h.message}`).join("\n"), "text/plain")}>.log</Btn>
                <Btn onClick={() => download(`kibana-${result.side}-${result.values[0]}.json`, JSON.stringify({ ...result, hits: shown }, null, 2), "application/json")}>.json</Btn>
              </span>
            }
          >
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10, fontFamily: "monospace", wordBreak: "break-all" }}>
              {result.index} · {fmtTs(result.from)} → {fmtTs(result.to)} IST
              {result.firstTs && ` · first hit ${fmtTs(result.firstTs)}, last ${fmtTs(result.lastTs)}`}
              {result.timedOut && <span style={{ color: C.warn }}> · Kibana timed out, results partial</span>}
              {result.shards?.failed > 0 && <span style={{ color: C.warn }}> · {result.shards.failed} shards failed</span>}
            </div>

            {result.total === 0 ? (
              <div style={{ fontSize: 13, color: C.text2, padding: "10px 0" }}>
                No log lines for {result.values.join(", ")} in this window. Try a longer range, all indices, the other side ({result.side === "tsp" ? "TPAP" : "TSP"}), or “Search all fields”.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  <Chip on={!svcFilter} onClick={() => setSvcFilter(null)}>
                    All services
                  </Chip>
                  {result.byService.map((s) => (
                    <Chip key={s.service} on={svcFilter === s.service} onClick={() => setSvcFilter(svcFilter === s.service ? null : s.service)} title={shownServices?.has(s.service) ? "" : "Not in the fetched rows — raise Max rows or pick this service"}>
                      {s.service} · {fmtNum(s.count)}
                    </Chip>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                  <input value={textFilter} onChange={(e) => setTextFilter(e.target.value)} placeholder="Filter these lines…" style={{ ...inputStyle, flex: "1 1 260px" }} />
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: C.text2, cursor: "pointer" }}>
                    <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> errors / failures only
                  </label>
                  {(result.by === "payer" || result.by === "payee") && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: C.text2, cursor: "pointer" }}>
                      <input type="checkbox" checked={roleOnly} onChange={(e) => setRoleOnly(e.target.checked)} /> only lines where VPA is {result.by} ({result.hits.filter((h) => h.roles?.includes(result.by)).length})
                    </label>
                  )}
                  <Btn onClick={() => setOpenRows(openRows.size ? new Set() : new Set(shown.map((h) => h.id)))}>{openRows.size ? "Collapse all" : "Expand all"}</Btn>
                </div>
                {result.total > result.hits.length && (
                  <div style={{ fontSize: 11, color: C.warn, marginBottom: 8 }}>
                    Fetched the {result.order === "asc" ? "oldest" : "newest"} {fmtNum(result.hits.length)} of {fmtNum(result.total)} lines — raise Max rows, narrow the service / time range, or add an extra filter.
                  </div>
                )}
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {["Time (IST)", "Service", "Level", "Message"].map((h) => (
                          <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((h) => (
                        <LogRow
                          key={h.id}
                          h={h}
                          re={re}
                          open={openRows.has(h.id)}
                          onPivot={pivot}
                          onToggle={() =>
                            setOpenRows((s) => {
                              const n = new Set(s);
                              n.has(h.id) ? n.delete(h.id) : n.add(h.id);
                              return n;
                            })
                          }
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </Card>
        )}

        <Card
          title={
            <span style={{ cursor: "pointer" }} onClick={() => setHistOpen((o) => !o)}>
              {histOpen ? "▾" : "▸"} 🕘 Search history <span style={{ color: C.muted, fontWeight: 400 }}>· {history.length} saved</span>
            </span>
          }
        >
          {histOpen && (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input value={histFilter} onChange={(e) => setHistFilter(e.target.value)} placeholder="Filter history — ID, service, filter, TSP/TPAP…" style={{ ...inputStyle, flex: 1 }} />
                <Btn onClick={() => setHistory([])} disabled={!history.length}>
                  Clear all
                </Btn>
              </div>
              {!histShown.length ? (
                <div style={{ fontSize: 12, color: C.muted, padding: "6px 0" }}>{history.length ? "No match." : "Searches you run appear here (kept in this browser)."}</div>
              ) : (
                <div style={{ display: "grid" }}>
                  {histShown.map((h) => {
                    const f = h.form;
                    const sideObj = meta?.sides?.find((s) => s.id === f.side);
                    return (
                      <div key={h.at} style={{ display: "grid", gridTemplateColumns: "110px 52px 140px minmax(0,1fr) 80px auto", gap: 10, alignItems: "center", padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                        <span style={{ fontFamily: "monospace", color: C.text2, fontSize: 11 }}>{fmtWhen(h.at)}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, border: `1px solid ${C.border}`, borderRadius: 4, textAlign: "center", padding: "2px 0" }}>{f.side.toUpperCase()}</span>
                        <span style={{ color: C.text2 }}>{ID_BY[f.by]?.label}</span>
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.values}>
                          <span style={{ fontFamily: "monospace" }}>{f.values.trim().split(/\n/).join(", ")}</span>
                          <span style={{ color: C.muted }}>
                            {" "}
                            · {f.allIndices ? sideObj?.allIndices || "all indices" : f.index} · {f.range === "custom" ? "custom" : RANGE_LABEL[f.range]}
                            {f.extra ? ` · ${f.extra}` : ""}
                          </span>
                        </span>
                        <span style={{ fontWeight: 600, textAlign: "right" }}>
                          {fmtNum(h.total)}
                          {h.relation === "gte" ? "+" : ""} hits
                        </span>
                        <span style={{ display: "flex", gap: 6 }}>
                          <Btn
                            primary
                            disabled={busy}
                            onClick={() => {
                              setForm(f);
                              run(f);
                            }}
                          >
                            ↻ Run again
                          </Btn>
                          <Btn onClick={() => setForm(f)}>Load</Btn>
                          <Btn onClick={() => setHistory((x) => x.filter((y) => y.at !== h.at))} title="Remove">
                            🗑
                          </Btn>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}
