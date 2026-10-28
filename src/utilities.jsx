import { useEffect, useMemo, useRef, useState } from "react";
import { getBedrockModelTierForRequest, getLlmDisabledForRequest, getLlmProviderForRequest, getLlmRoutingExtras } from "./ConnectorsStatus.jsx";

// Utilities — ad-hoc lookup tools. Talks to backend /api/utils/*.
// Each tool runs on demand (nothing runs on page open): Trino lookups, PRD / BRD / UAT
// generators (/api/utils/skills/run, saved to History), UMN lookup (/api/utils/skills/umn),
// merchant details by MID / VPA (/api/utils/merchant) and NPCI Spec Search over the TSD +
// Consolidated Circular Markdown (/api/spec/*; bookmark as #utilities?spec=<query>).

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

// ─── 2 · Skills: PRD / BRD / UAT generators (saved to History) ──────────────

const field = { background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 13 };
const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16 };

/** Board from a Jira key / browse URL: TSP → finmate, TPAP → mypaytm. */
function jiraBoard(v) {
  const s = String(v || "").trim();
  const key = (s.match(/\b([A-Z][A-Z0-9]+)-\d+\b/i) || [])[1]?.toUpperCase();
  const host = (s.match(/https?:\/\/([a-z0-9-]+)\.atlassian\.net/i) || [])[1]?.toLowerCase();
  if (!s) return null;
  if (!key) return { ok: false, text: "Enter a key like TSP-3356 or a browse URL" };
  const site = host || (key === "TPAP" ? "mypaytm" : key === "TSP" ? "finmate" : null);
  return { ok: true, text: `${key} board${site ? ` · ${site}.atlassian.net` : ""}` };
}

const SKILL_CARDS = [
  { skill: "prd", title: "PRD Generator", hint: "14-section PRD from the Jira ticket + your notes" },
  { skill: "brd", title: "BRD Generator", hint: "Small (10 sections) or Full (24 sections, NPCI review)" },
  { skill: "uat", title: "UAT Generator", hint: "UAT signoff from ticket, acceptance criteria, comments + readable attachments" },
];

function downloadMd(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function SkillCard({ skill, title, hint }) {
  const [jira, setJira] = useState(() => lsGet(`skill:${skill}:jira`, ""));
  const [notes, setNotes] = useState("");
  const [brdMode, setBrdMode] = useState(() => lsGet("skill:brd:mode", "full"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const board = jiraBoard(jira);

  const run = async () => {
    if (busy) return;
    if (!jira.trim() && !notes.trim()) return setErr("Enter a Jira ID / URL or some notes");
    if (board && !board.ok) return setErr(board.text);
    lsSet(`skill:${skill}:jira`, jira.trim());
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await api("/skills/run", { method: "POST", body: {
            skill,
            jira: jira.trim(),
            notes: notes.trim(),
            brdMode,
            llm: { llmProvider: getLlmProviderForRequest(), llmDisabled: getLlmDisabledForRequest(), bedrockModelTier: getBedrockModelTierForRequest(), ...getLlmRoutingExtras() },
          },
        }));
    } catch (e) {
      setErr(`${e.message} — the failed run is in History too.`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 10, marginBottom: 0, minWidth: 0 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{title}</h3>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{hint}</div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <input value={jira} onChange={(e) => setJira(e.target.value)} placeholder="TSP-3356 · TPAP-4961 · or browse URL" aria-label={`${title} Jira ID`} style={field} />
        {board && <div style={{ fontSize: 11, color: board.ok ? "#86efac" : "#fca5a5", marginTop: -4 }}>{board.text}</div>}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional) — extra context, constraints, test results…" aria-label={`${title} notes`} rows={4} style={{ ...field, resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {skill === "brd" && (
            <div role="radiogroup" aria-label="BRD size" style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
              {["small", "full"].map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={brdMode === m}
                  onClick={() => {
                    setBrdMode(m);
                    lsSet("skill:brd:mode", m);
                  }}
                  style={{ padding: "5px 12px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer", background: brdMode === m ? C.accent : C.card2, color: brdMode === m ? "#111" : C.text2 }}
                >
                  {m === "small" ? "Small" : "Full"}
                </button>
              ))}
            </div>
          )}
          <button type="submit" style={{ ...btn("primary"), marginLeft: "auto" }} disabled={busy}>
            {busy ? "Running… (1–3 min)" : "▶ Run"}
          </button>
        </div>
      </form>
      {err && <div style={{ color: "#fca5a5", fontSize: 12 }}>{err}</div>}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 11, color: C.muted }}>
            <span style={{ flex: "1 1 auto", minWidth: 0 }}>
              {result.jira ? `${result.jira.id} · ${result.jira.status}` : "Notes only"} · {(result.ms / 1000).toFixed(0)}s · {result.llmProvider}
              {skill === "uat" && result.attachmentsRead ? ` · ${result.attachmentsRead} attachment(s) read` : ""}
            </span>
            <button type="button" style={btn()} onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" style={btn()} onClick={() => downloadMd(`${skill.toUpperCase()}-${result.jira?.id || "notes"}.md`, result.markdown)}>
              .md
            </button>
            <a href={`#history?dashboard=skills`} style={{ ...btn(), textDecoration: "none" }}>
              History ↗
            </a>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12, color: "#cbd5e1", background: "#020617", border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, maxHeight: 480, overflow: "auto", margin: 0 }}>
            {result.markdown}
          </pre>
        </div>
      )}
    </section>
  );
}

// Hidden until an LLM provider works again (Bedrock / Foundry / OpenAI / Anthropic all failing).
// Flip to true to bring the PRD / BRD / UAT cards back — backend routes stay live.
const SHOW_DOC_GENERATORS = false;

function SkillGenerators() {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>2 · Document Generators</h2>
        <span style={{ fontSize: 11, color: C.muted }}>TSP (finmate) + TPAP (mypaytm) Jira · every run saved to History</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        {SKILL_CARDS.map((c) => (
          <SkillCard key={c.skill} {...c} />
        ))}
      </div>
    </div>
  );
}

// ─── 3 · UMN Lookup (not saved to History) ──────────────────────────────────

const TXN_COLUMNS = [
  { key: "updated_on", label: "Updated", align: "left" },
  { key: "type", label: "Type", align: "left" },
  { key: "category", label: "Category", align: "left" },
  { key: "amount", label: "Amount", render: (r) => (r.amount == null ? "—" : `₹${Number(r.amount).toLocaleString("en-IN")}`) },
  { key: "status", label: "Status", align: "left" },
  { key: "npci_resp_code", label: "NPCI code", align: "left", render: (r) => (r.npci_resp_code ? `${r.npci_resp_code}${r.npci_resp_label ? ` — ${r.npci_resp_label}` : ""}` : "—") },
  { key: "rrn", label: "RRN", align: "left" },
  { key: "txn_id", label: "TXN ID", align: "left" },
];

const dash = (v) => (v == null || v === "" ? "—" : String(v));

function KV({ rows }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "6px 14px", fontSize: 12, padding: 10, background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <div style={{ color: C.muted, fontSize: 11 }}>{k}</div>
          <div style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dash(v)}>
            {dash(v)}
          </div>
        </div>
      ))}
    </div>
  );
}

const STATUS_COLOR = { ACTIVE: "#86efac", PAUSED: "#fcd34d", REVOKED: "#fca5a5", EXPIRED: "#fca5a5", FAILED: "#fca5a5" };

function UmnResult({ r }) {
  if (!r.found) {
    return (
      <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}>
        <b>{r.umn}</b> <span style={{ color: "#fca5a5" }}>— UMN not found on any Switch cluster</span>
      </div>
    );
  }
  const m = r.mandate;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <b style={{ fontSize: 13, wordBreak: "break-all" }}>{r.umn}</b>
        <span style={{ fontSize: 12, fontWeight: 700, color: STATUS_COLOR[m.mandate_status] || C.text2 }}>{dash(m.mandate_status)}</span>
        <span style={{ fontSize: 11, color: C.muted }}>Redash DS {r.dataSourceId}</span>
      </div>
      {r.notes.length > 0 && <div style={{ fontSize: 12, color: "#fcd34d" }}>{r.notes.join(" · ")}</div>}
      <KV
        rows={[
          ["Revocable", m.revocable === "Y" ? "Yes" : m.revocable === "N" ? "No" : m.revocable],
          ["Created", m.mandate_created_on],
          ["Last updated", m.mandate_updated_on],
          ["Last success debit", m.last_success_debit_date || "No execution recorded"],
          ["Last debit amount", m.last_success_debit_amount != null ? `₹${m.last_success_debit_amount}` : null],
          ["Last exec resp code", m.last_execution_resp_code ? `${m.last_execution_resp_code}${r.lastExecutionRespLabel ? ` — ${r.lastExecutionRespLabel}` : ""}` : null],
          ["Payer VPA", m.payer_vpa],
          ["Payer name", m.payer_name],
          ["Payer bank / handle", [m.payer_bank_code, m.payer_handle].filter(Boolean).join(" / ")],
          ["Payee VPA", m.payee_vpa],
          ["Payee name", m.payee_name],
          ["Payee bank / handle", [m.payee_bank_code, m.payee_handle].filter(Boolean).join(" / ")],
          ["Payee MCC", m.payee_mcc],
        ]}
      />
      <Table columns={TXN_COLUMNS} rows={r.txns} empty="No transaction history found" />
    </div>
  );
}

function UmnLookup() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const abortRef = useRef(null);
  const umns = useMemo(() => [...new Set(text.split(/[\s,;]+/).map((u) => u.trim()).filter(Boolean))], [text]);

  const lookup = async () => {
    if (!umns.length || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api("/skills/umn", { method: "POST", body: { umns }, signal: controller.signal }));
    } catch (e) {
      if (e.name !== "AbortError") setErr(e.message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <section style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{SHOW_DOC_GENERATORS ? 3 : 2} · UMN Lookup</h2>
        <span style={{ fontSize: 11, color: C.muted }}>Mandate status, participants, last execution, last 10 txns · Switch DB (PTYBL Redash) · not saved to History</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start", marginBottom: 12 }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) lookup();
          }}
          placeholder={"One or more UMNs — newline, space or comma separated\n9b7cd4139d8d48f2b2635b26928a27c9@ptyes"}
          aria-label="UMNs"
          rows={3}
          style={{ ...field, flex: "1 1 360px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button type="submit" style={btn("primary")} disabled={busy || !umns.length}>
            {busy ? "Fetching…" : `Fetch${umns.length > 1 ? ` ${umns.length}` : ""}`}
          </button>
          {busy && (
            <button type="button" style={btn("danger")} onClick={() => abortRef.current?.abort()}>
              ■ Stop
            </button>
          )}
          {result && (
            <button type="button" style={btn()} onClick={() => setShowSql((s) => !s)}>
              {showSql ? "Hide SQL" : "Show SQL"}
            </button>
          )}
        </div>
      </form>
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>{err}</div>}
      {showSql && result && (
        <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.text2, overflowX: "auto", marginBottom: 12 }}>{result.sql}</pre>
      )}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, color: C.muted }}>
            {result.results.filter((r) => r.found).length}/{result.results.length} found · {(result.ms / 1000).toFixed(1)}s
          </div>
          {result.results.map((r) => (
            <UmnResult key={r.umn} r={r} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── 4 · Merchant Details (not saved to History) ────────────────────────────

const MERCHANT_COLUMNS = [
  { key: "mid", label: "MID", align: "left" },
  { key: "mcc", label: "MCC", align: "left" },
  { key: "user_id", label: "User ID", align: "left" },
  { key: "merchant_type", label: "Type", align: "left" },
  { key: "merchant_genre", label: "Genre", align: "left" },
  { key: "ownership_type", label: "Ownership", align: "left" },
  { key: "business_size", label: "Size", align: "left" },
  { key: "entity_name", label: "Entity", align: "left" },
  { key: "cluster", label: "Cluster", align: "left" },
  { key: "is_verified", label: "Verified", align: "left", render: (r) => (r.is_verified == null ? "—" : r.is_verified ? "Yes" : "No") },
  { key: "city", label: "City / State", align: "left", render: (r) => [r.city, r.state].filter(Boolean).join(", ") || "—" },
  { key: "updated_by", label: "Updated by", align: "left" },
  { key: "created_on", label: "Created", align: "left" },
  { key: "updated_on", label: "Updated", align: "left" },
];

const vpaType = (r) => {
  try {
    const x = typeof r.extended_info === "string" ? JSON.parse(r.extended_info) : r.extended_info;
    return [x?.VPA_TYPE, x?.["channel-code"]].filter(Boolean).join(" · ") || "—";
  } catch {
    return "—";
  }
};

const VPA_COLUMNS = [
  { key: "vpa", label: "VPA", align: "left" },
  { key: "status", label: "Status", align: "left", render: (r) => <span style={{ color: STATUS_COLOR[r.status] || C.text2, fontWeight: 600 }}>{dash(r.status)}</span> },
  { key: "is_default", label: "Default", align: "left", render: (r) => (r.is_default ? "Yes" : "No") },
  { key: "is_visible", label: "Visible", align: "left", render: (r) => (r.is_visible == null ? "—" : r.is_visible ? "Yes" : "No") },
  { key: "extended_info", label: "VPA type · channel", align: "left", render: vpaType },
  { key: "user_id", label: "User ID", align: "left" },
  { key: "created_on", label: "Created", align: "left" },
  { key: "updated_on", label: "Updated", align: "left" },
];

const MERCHANT_MODES = {
  mid: { label: "MID", placeholder: "One or more MIDs — newline, space or comma separated\nirctcu76043466862718" },
  vpa: { label: "VPA", placeholder: "One or more VPAs — newline, space or comma separated\npaytm-64646105@ptybl" },
};

function MerchantResult({ r, by }) {
  if (!r.found) {
    return (
      <div style={{ padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}>
        <b>{r.input}</b> <span style={{ color: "#fca5a5" }}>— {by.toUpperCase()} not found in PMS</span>
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
        <b style={{ fontSize: 13, wordBreak: "break-all" }}>{r.input}</b>
        <span style={{ fontSize: 11, color: C.muted }}>user_id {r.userIds.join(", ")}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text2 }}>Merchant details ({r.merchants.length})</div>
      <Table columns={MERCHANT_COLUMNS} rows={r.merchants} empty="No merchant_details row for this user" />
      <div style={{ fontSize: 12, fontWeight: 600, color: C.text2 }}>Linked VPAs ({r.vpas.length})</div>
      <Table columns={VPA_COLUMNS} rows={r.vpas} empty="No VPAs for this user" />
    </div>
  );
}

function MerchantLookup({ index }) {
  const [by, setBy] = useState(() => (lsGet("merchantBy", "mid") === "vpa" ? "vpa" : "mid"));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [showSql, setShowSql] = useState(false);
  const abortRef = useRef(null);
  const values = useMemo(() => [...new Set(text.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean))], [text]);

  const switchMode = (m) => {
    if (m === by || busy) return;
    setBy(m);
    lsSet("merchantBy", m);
    setErr(null);
  };

  const lookup = async () => {
    if (!values.length || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api("/merchant", { method: "POST", body: { by, values }, signal: controller.signal }));
    } catch (e) {
      if (e.name !== "AbortError") setErr(e.message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <section style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{index} · Merchant Details</h2>
        <span style={{ fontSize: 11, color: C.muted }}>merchant_details + linked user_vpa rows by MID or VPA · PMS DB (PTYBL Redash) · not saved to History</span>
      </div>
      <div role="tablist" aria-label="Look up by" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {Object.entries(MERCHANT_MODES).map(([k, m]) => (
          <button key={k} type="button" role="tab" aria-selected={by === k} style={btn(by === k ? "primary" : "default")} onClick={() => switchMode(k)} disabled={busy}>
            By {m.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookup();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start", marginBottom: 12 }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) lookup();
          }}
          placeholder={MERCHANT_MODES[by].placeholder}
          aria-label={`${MERCHANT_MODES[by].label}s`}
          rows={3}
          style={{ ...field, flex: "1 1 360px", resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button type="submit" style={btn("primary")} disabled={busy || !values.length}>
            {busy ? "Fetching…" : `Fetch${values.length > 1 ? ` ${values.length}` : ""}`}
          </button>
          {busy && (
            <button type="button" style={btn("danger")} onClick={() => abortRef.current?.abort()}>
              ■ Stop
            </button>
          )}
          {result && (
            <button type="button" style={btn()} onClick={() => setShowSql((s) => !s)}>
              {showSql ? "Hide SQL" : "Show SQL"}
            </button>
          )}
        </div>
      </form>
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>{err}</div>}
      {showSql && result && (
        <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.text2, overflowX: "auto", marginBottom: 12 }}>{result.sql}</pre>
      )}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 11, color: C.muted }}>
            By {result.by.toUpperCase()} · {result.results.filter((r) => r.found).length}/{result.results.length} found · {(result.ms / 1000).toFixed(1)}s
          </div>
          {result.results.map((r) => (
            <MerchantResult key={r.input} r={r} by={result.by} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── NPCI Spec Search (TSD + Consolidated Circular) ─────────────────────────

const SPEC_API = "/api/spec";
const SPEC_SOURCES = [
  { id: "", label: "All" },
  { id: "tsd", label: "TSD" },
  { id: "circular", label: "Circular" },
  { id: "errcodes", label: "Error codes" },
];
const SPEC_EXAMPLES = ["ReqPay", "U16", "Z9", "ReqMandate", "safety switch", "settlement cycle", "check transaction status", "UPI Circle", "P2PM MCC 7407"];
const SPEC_TINT = { tsd: "#38bdf8", circular: "#f59e0b", errcodes: "#f87171" };
const SPEC_TAG = { tsd: "TSD", circular: "Circular", errcodes: "Codes" };

async function specApi(pathAndQuery) {
  const res = await fetch(`${SPEC_API}${pathAndQuery}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wrap occurrences of `terms` in <mark>. */
function Highlight({ text, terms }) {
  if (!terms?.length || !text) return text || null;
  const re = new RegExp(`(${terms.map(escRe).join("|")})`, "gi");
  return String(text)
    .split(re)
    .map((part, i) =>
      i % 2 ? (
        <mark key={i} style={{ background: "#a78bfa44", color: C.text, borderRadius: 2, padding: "0 1px" }}>
          {part}
        </mark>
      ) : (
        part
      )
    );
}

/** Inline Markdown: **bold**, *italic*, `code`; everything else is text (highlighted). */
function Inline({ text, terms }) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Highlight key={k++} text={text.slice(last, m.index)} terms={terms} />);
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}><Highlight text={t.slice(2, -2)} terms={terms} /></strong>);
    else if (t.startsWith("`")) out.push(<code key={k++} style={{ background: C.card2, padding: "0 4px", borderRadius: 3, fontSize: "0.92em" }}>{t.slice(1, -1)}</code>);
    else out.push(<em key={k++} style={{ color: C.text2 }}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(<Highlight key={k++} text={text.slice(last)} terms={terms} />);
  return out;
}

const splitRow = (line) =>
  line
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

/**
 * Minimal block renderer for the converted NPCI Markdown: headings, paragraphs, lists, tables,
 * ```xml fences, images (served from /api/spec/img) and `<!-- p.N -->` page markers (PDF links).
 */
function SpecMarkdown({ md, source, terms }) {
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;
  let key = 0;
  const pdf = (p) => `${SPEC_API}/pdf/${source}#page=${p}`;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const page = /^<!-- p\.(\d+) -->$/.exec(line);
    if (page) {
      blocks.push(
        <div key={key++} style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px", color: C.muted, fontSize: 10 }}>
          <span style={{ flex: 1, borderTop: `1px dashed ${C.border}` }} />
          <a href={pdf(page[1])} target="_blank" rel="noreferrer" style={{ color: C.muted, textDecoration: "none" }} title="Open this page in the source PDF">
            PDF p.{page[1]} ↗
          </a>
        </div>
      );
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, lineHeight: 1.45, color: "#c4b5fd", overflowX: "auto", margin: "8px 0" }}>
          {body.join("\n")}
        </pre>
      );
      continue;
    }
    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      const size = { 1: 16, 2: 15, 3: 14, 4: 13, 5: 13, 6: 12 }[h[1].length];
      blocks.push(
        <div key={key++} style={{ fontSize: size, fontWeight: 700, margin: "12px 0 6px", color: C.text }}>
          <Highlight text={h[2]} terms={terms} />
        </div>
      );
      i++;
      continue;
    }
    const img = /^!\[([^\]]*)\]\(img\/([^)]+)\)$/.exec(line.trim());
    if (img) {
      blocks.push(
        <a key={key++} href={`${SPEC_API}/img/${source}/${img[2]}`} target="_blank" rel="noreferrer" style={{ display: "block", margin: "8px 0" }}>
          <img src={`${SPEC_API}/img/${source}/${img[2]}`} alt={img[1]} loading="lazy" style={{ maxWidth: "100%", background: "#fff", borderRadius: 6, border: `1px solid ${C.border}` }} />
        </a>
      );
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      const hc = splitRow(head);
      const tcell = { padding: "5px 8px", borderBottom: `1px solid ${C.border}`, verticalAlign: "top", textAlign: "left" };
      blocks.push(
        <div key={key++} style={{ overflowX: "auto", margin: "8px 0", border: `1px solid ${C.border}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>
            <thead>
              <tr>
                {hc.map((c, j) => (
                  <th key={j} style={{ ...tcell, background: C.card2, color: C.text2, fontWeight: 600 }}>
                    <Inline text={c} terms={terms} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>
                  {splitRow(r).map((c, j) => (
                    <td key={j} style={{ ...tcell, color: C.text }}>
                      <Inline text={c} terms={terms} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^- /.test(line)) {
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key++} style={{ margin: "6px 0", paddingLeft: 20 }}>
          {items.map((t, j) => (
            <li key={j} style={{ margin: "2px 0" }}>
              <Inline text={t} terms={terms} />
            </li>
          ))}
        </ul>
      );
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6} |\||```|- |<!-- p\.|!\[)/.test(lines[i])) para.push(lines[i++].replace(/^> /, ""));
    if (!para.length) para.push(lines[i++]);
    blocks.push(
      <p key={key++} style={{ margin: "6px 0", lineHeight: 1.55 }}>
        <Inline text={para.join(" ")} terms={terms} />
      </p>
    );
  }
  return <div style={{ fontSize: 12.5, color: C.text }}>{blocks}</div>;
}

const specPages = (r) => (r.page == null ? "" : r.pageTo && r.pageTo !== r.page ? `p.${r.page}–${r.pageTo}` : `p.${r.page}`);
const specHashQuery = () => {
  const m = /[?&]spec=([^&]*)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
};

// Prev / Next walk the document from the opened result without leaving it.
function SpecSection({ id, terms }) {
  const [cur, setCur] = useState(id);
  const [sec, setSec] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setSec(null);
    setErr(null);
    specApi(`/section?id=${encodeURIComponent(cur)}`)
      .then((d) => live && setSec(d))
      .catch((e) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [cur]);
  const onNavigate = setCur;
  if (err) return <div style={{ color: "#fca5a5", fontSize: 12, padding: 10 }}>{err}</div>;
  if (!sec) return <div style={{ color: C.muted, fontSize: 12, padding: 10 }}>Loading section…</div>;
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 12px 12px", background: "#0d1526" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C.muted }}>{cur === id ? sec.part : [sec.part, ...sec.path, sec.heading].join(" › ")}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" style={btn()} disabled={!sec.prevId} onClick={() => onNavigate(sec.prevId)}>
            ← Prev
          </button>
          <button type="button" style={btn()} disabled={!sec.nextId} onClick={() => onNavigate(sec.nextId)}>
            Next →
          </button>
          {sec.page != null && (
            <a href={`${SPEC_API}/pdf/${sec.source}#page=${sec.page}`} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: "none" }}>
              Open PDF {specPages(sec)} ↗
            </a>
          )}
        </span>
      </div>
      <div style={{ maxHeight: "70vh", overflow: "auto", paddingRight: 6 }}>
        <SpecMarkdown md={sec.markdown} source={sec.source} terms={terms} />
      </div>
    </div>
  );
}

function SpecSearch({ index }) {
  const [q, setQ] = useState(() => specHashQuery() ?? lsGet("specQ", ""));
  const [source, setSource] = useState(() => lsGet("specSource", ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [meta, setMeta] = useState(null);

  const run = async (query = q, src = source) => {
    const t = query.trim();
    if (!t) return;
    lsSet("specQ", t);
    lsSet("specSource", src);
    // bookmarkable without triggering the app's hash router (replaceState fires no hashchange)
    window.history.replaceState(null, "", `#utilities?spec=${encodeURIComponent(t)}`);
    setBusy(true);
    setErr(null);
    setOpenId(null);
    try {
      setResult(await specApi(`/search?limit=25&q=${encodeURIComponent(t)}${src ? `&source=${src}` : ""}`));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    specApi("/sources").then(setMeta).catch(() => {});
    if (specHashQuery()) run();
    // tabs stay mounted, so a new #utilities?spec=… link must re-run the search here
    const onHash = () => {
      const hq = specHashQuery();
      if (hq) {
        setQ(hq);
        run(hq);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (src) => {
    setSource(src);
    if (q.trim()) run(q, src);
  };

  return (
    <section style={card}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "baseline", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{index} · NPCI Spec Search</h2>
        <span style={{ fontSize: 11, color: C.muted }}>
          UPI TSD V1.0 + Consolidated Circular V1.0 + Error &amp; Response Codes V2.9
          {meta ? ` · ${meta.sources.reduce((n, s) => n + s.sections, 0)} sections` : ""} · API names, error codes, clauses
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. ReqPay, safety switch, settlement cycle"
          aria-label="Search NPCI specifications"
          style={{ ...field, flex: "1 1 320px" }}
        />
        <div style={{ display: "flex", border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden" }}>
          {SPEC_SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              style={{ padding: "6px 12px", fontSize: 12, border: "none", cursor: "pointer", background: source === s.id ? C.accent : C.card2, color: source === s.id ? "#111" : C.text2, fontWeight: 600 }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button type="submit" style={btn("primary")} disabled={busy || !q.trim()}>
          {busy ? "Searching…" : "Search"}
        </button>
        {result && !busy && (
          <span style={{ fontSize: 11, color: C.muted }}>
            {result.total} matching sections{result.total > result.results.length ? ` · top ${result.results.length}` : ""} · {result.ms}ms
          </span>
        )}
      </form>
      {!result && !busy && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {SPEC_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => {
                setQ(ex);
                run(ex);
              }}
              style={{ ...btn(), fontWeight: 500, color: C.text2 }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}
      {err && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 12 }}>{err}</div>}
      {result?.codes?.length > 0 && (
        <div style={{ border: `1px solid ${SPEC_TINT.errcodes}66`, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: SPEC_TINT.errcodes, padding: "6px 10px", background: C.card2 }}>
            Code definitions · NPCI UPI Error and Response Codes V2.9
          </div>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <tbody>
              {result.codes.flatMap((c) =>
                c.entries.map((e, j) => (
                  <tr key={`${c.code}-${j}`} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: "6px 10px", fontFamily: "ui-monospace, monospace", fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "top" }}>{e.code}</td>
                    <td style={{ padding: "6px 10px", color: C.text }}>{e.desc}</td>
                    <td style={{ padding: "6px 10px", color: e.tdbd === "BD" ? "#fbbf24" : e.tdbd === "TD" ? "#60a5fa" : C.muted, fontWeight: 600, whiteSpace: "nowrap" }} title={e.tdbd === "BD" ? "Business decline" : e.tdbd === "TD" ? "Technical decline" : ""}>
                      {e.tdbd || "—"}
                    </td>
                    <td style={{ padding: "6px 10px", color: C.muted, fontSize: 11 }}>{e.section}</td>
                    <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                      <a href={`${SPEC_API}/pdf/errcodes#page=${e.page}`} target="_blank" rel="noreferrer" style={{ color: C.text2, fontSize: 11 }}>
                        p.{e.page} ↗
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {result && result.results.length === 0 && <div style={{ color: C.muted, fontSize: 12 }}>No sections match “{result.q}”.</div>}
      {result && result.results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {result.results.map((r) => {
            const open = openId === r.id;
            return (
              <div key={r.id} style={{ border: `1px solid ${open ? C.accent : C.border}`, borderRadius: 8, background: C.card2, overflow: "hidden" }}>
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : r.id)}
                  aria-expanded={open}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", color: C.text, padding: "9px 12px", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 4, color: "#111", background: SPEC_TINT[r.source] }}>{SPEC_TAG[r.source]}</span>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>
                      <Highlight text={r.heading} terms={result.terms} />
                    </span>
                    <span style={{ fontSize: 11, color: C.muted, marginLeft: "auto" }}>
                      {specPages(r)} {open ? "▴" : "▾"}
                    </span>
                  </div>
                  {r.path.length > 0 && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{r.path.join(" › ")}</div>}
                  <div style={{ fontSize: 12, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
                    <Highlight text={r.snippet} terms={result.terms} />
                  </div>
                </button>
                {open && <SpecSection id={r.id} terms={result.terms} />}
              </div>
            );
          })}
        </div>
      )}
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
        {SHOW_DOC_GENERATORS && <SkillGenerators />}
        <UmnLookup />
        <MerchantLookup index={SHOW_DOC_GENERATORS ? 4 : 3} />
        <SpecSearch index={SHOW_DOC_GENERATORS ? 5 : 4} />
      </main>
    </div>
  );
}
