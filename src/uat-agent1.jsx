import { useState, useRef, useEffect } from "react";
import { API_BASE, sendCompletionNotify } from "./config.js";
import ShareAndScore from "./ShareAndScore.jsx";
import { syncPublishDefaultJiraKey, loadPublishDefaults, syncPublishJiraSiteFromIssue, getLlmProviderForRequest, getLlmDisabledForRequest, getBedrockModelTierForRequest, getLlmRoutingExtras } from "./ConnectorsStatus.jsx";
import { exportAgentOutput } from "./agentExport.js";
import { buildShareSubjectLine } from "./shareSubject.js";
import AgentDomainMultiSelect from "./AgentDomainMultiSelect.jsx";
import { AGENT_DOMAIN_ENTRIES, domainIdsFromLabels, sanitizeDomainIds } from "./agentDomainCatalog.js";
import JiraConnectorFetchSummary from "./JiraConnectorFetchSummary.jsx";

// ── Google Font ───────────────────────────────────────────────────────────────
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap";
document.head.appendChild(fontLink);

const css = `
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #0B1120; }
  ::-webkit-scrollbar-thumb { background: #1E293B; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #334155; }
  @keyframes fadeSlideIn { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  @keyframes shimmer { 0% { background-position: -200% center; } 100% { background-position: 200% center; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes discoverPulse { 0%,100% { box-shadow: 0 0 0 0 #e8b84b22; } 50% { box-shadow: 0 0 0 8px #e8b84b00; } }
  .fade-in { animation: fadeSlideIn 0.35s ease forwards; }
  .sentinel-glow { box-shadow: 0 0 0 1px #e8b84b22, 0 4px 24px #e8b84b18; }
  .hover-lift:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(232,184,75,0.15); }
  textarea:focus, input:focus { border-color: #e8b84b88 !important; box-shadow: 0 0 0 3px #e8b84b12; }
  .discovery-pulse { animation: discoverPulse 2s ease-in-out infinite; }
`;
const styleEl = document.createElement("style");
styleEl.textContent = css;
document.head.appendChild(styleEl);

// ── Constants ─────────────────────────────────────────────────────────────────
const MODELS = [
  { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4.6", provider: "Anthropic", color: "#e8b84b" },
  { id: "claude-opus-4-20250514",   label: "Claude Opus 4.6",   provider: "Anthropic", color: "#d4823a" },
  { id: "gpt-4o",                   label: "GPT-4o",            provider: "OpenAI",    color: "#10a37f" },
  { id: "gemini-1.5-pro",           label: "Gemini 1.5 Pro",    provider: "Google",    color: "#4285f4" },
  { id: "deepseek-chat",            label: "DeepSeek Chat",     provider: "DeepSeek",  color: "#7c3aed" },
];

// ── System Prompts ────────────────────────────────────────────────────────────
const buildSystemPrompt = (domains, objective, feedbackNote) => {
  const scopeList = domains.length > 0 ? domains.map(d => `${d.full} (${d.label})`).join(", ") : "All Services";
  const objSection = objective ? `\nCONFIRMED OBJECTIVE OF TESTING:\n${objective}\n` : "";
  const fbSection = feedbackNote ? `\nUSER FEEDBACK TO INCORPORATE:\n${feedbackNote}\n` : "";
  return `You are TestSentinel — an expert UAT Signoff Agent for fintech, UPI, and payment systems.
${objSection}${fbSection}
DOMAIN SCOPE: ${scopeList}. Constrain ALL analysis strictly to these domains.

Generate a professional UAT Signoff with EXACTLY these sections in this order:

## 1️⃣ Introduction
A table with ONLY these fields (no others):
| Field | Value |
| Feature Name | [from input] |
| JIRA ID | [from input] |
| Fix Version | [from input or N/A] |
| Reporter | [from input or N/A] |
| Assignee | [from input or N/A] |
| Labels | [from input or N/A] |
| UAT Scope | ${scopeList} |

## 2️⃣ Objective
${objective ? `Use this confirmed objective: ${objective}` : "Derive from inputs. Describe what was validated in 2-3 sentences."}

## 3️⃣ + 4️⃣ Scope Definition
**MERGED SECTION** (scope table + test execution summary + counts below)

First, a Scope table:
| In Scope | Out of Scope |
List all relevant in-scope items including:
- End-to-End Transaction Flow Validation
- Negative & Edge Case Coverage
- Fund Loss Risk Validation
- Reconciliation Integrity Validation
- NPCI Compliance Validation
- Feature Flag & Configuration Safety
- [domain-specific items from test cases]

Then, Test Execution Summary table:
| QA Test Case ID | Scenario | Result | Remarks |
List every test case with its ID. For Result column: use the EXACT QA_status from input test cases — map "Not Started" or "Not Executed" → Not Executed, "Pass"/"Passed" → PASS, "Fail"/"Failed" → FAIL, "Blocked" → BLOCKED. NEVER infer or assume a result.

Then counts summary:
| Category | Count |
| Total Test Cases | X |
| Passed | X |
| Failed | X |
| Blocked | X |
| Not Executed | X |
Derive counts from the actual QA_status values. Do NOT invent counts.

## 5️⃣ UAT Acceptance Criteria
Table with columns: UAT Scenario | QA Test Case ID | Result | Remarks
Extract ALL test cases from input. Use the QA_status field from each test case as the Result. Never infer PASS/FAIL — only use status explicitly stated in the input. If QA_status is "Not Started", mark Result as "Not Executed".

## 6️⃣ Defect / Gap Summary
Severity counts table, then gap details table: Gap ID | Description | Severity | Impact | Recommendation

## 7️⃣ Discrepancy Analysis
CRITICAL: Compare UAT acceptance criteria/scenarios against QA/Dev test cases provided.
Table: | AC Item | UAT Scenario | QA Test Case ID | Covered? | Gap Severity | Recommendation |
- Mark "Not Covered" for any AC item that has NO corresponding QA test case
- Raise HIGH severity discrepancy if fund-loss or risk-critical AC not covered
- If no QA test cases were provided, note: "QA test cases not provided — discrepancy analysis skipped."

## 8️⃣ Risk Assessment
Table: Risk Area | Impact | Status

## 9️⃣ Production Readiness Checklist
Table: Validation Item | Status (use ✅ ⚠️ ❌). Only mark ✅ for items explicitly confirmed in input. Mark ⚠️ for items partially confirmed or unclear. Mark ❌ for items not tested or failing. Do NOT assume ✅ without evidence.

## 🔟 UAT Final Decision
State ONLY: ✅ PASS, ⚠️ PASS WITH CONDITIONS, or ❌ FAIL
Then 2-3 sentence justification. If any test cases are Not Executed, default to ⚠️ PASS WITH CONDITIONS unless all critical scenarios are confirmed passed. If discrepancies found, mention them.
DO NOT include Sign-off Pending, Prepared By, Date, or Next Review fields.

Rules: never invent counts or results; use the EXACT QA_status from input test cases; use "Insufficient data — please supply [X]" if status is missing; markdown tables only; professional tone; start with "# UAT Status". Keep wording compact to save tokens without omitting any required section.`;
};

const CLARIFY_SYSTEM = `You are TestSentinel, a UAT expert for fintech and UPI payment systems.

The user provided UAT inputs including JIRA ticket data, attachments, and existing test cases. Generate:
1. First: A draft "Objective" paragraph (2-3 sentences) based on their inputs
2. Then: 3-6 targeted clarifying questions to improve the signoff — focus ONLY on what is still unknown

Format your response as:

DRAFT_OBJECTIVE:
[your draft objective paragraph here]

QUESTIONS:
1. [question]
2. [question]
...

Be specific and concise. Do not ask about information that was already provided.`;

const DISCREPANCY_SYSTEM = `You are TestSentinel, a UAT validation expert.

Compare the UAT test scenarios against the QA/Dev test cases provided.
Generate a concise discrepancy report:

## Discrepancy Analysis

| AC / UAT Scenario | QA Test Case ID | QA Coverage | Gap? | Severity | Action Required |
|---|---|---|---|---|---|
[rows for each UAT scenario]

Then provide:
**Gap Count:** X critical, Y medium, Z low
**Verdict:** COMPLETE COVERAGE / PARTIAL COVERAGE / SIGNIFICANT GAPS

Be precise. Only raise genuine gaps where an acceptance criteria item has NO corresponding QA test case.`;

// ── History (persisted to localStorage) ─────────────────────────────────────
const UAT_HISTORY_KEY = "uat-sentinel-history-v1";
const UAT_HISTORY_MAX_DAYS = 60;

function uatEntryTimeMs(h) {
  if (!h?.ts) return NaN;
  const t = new Date(h.ts).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function filterUATHistoryByRetention(arr, maxDays = UAT_HISTORY_MAX_DAYS) {
  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  return (Array.isArray(arr) ? arr : []).filter((h) => {
    const t = uatEntryTimeMs(h);
    if (Number.isNaN(t)) return true;
    return t > cutoff;
  });
}

function nextUATHistoryId(arr) {
  const nums = (Array.isArray(arr) ? arr : []).map((h) => {
    const id = h?.id;
    return typeof id === "number" && !Number.isNaN(id) ? id : 0;
  });
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

function loadHistoryFromLS() {
  try {
    const raw = localStorage.getItem(UAT_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return filterUATHistoryByRetention(Array.isArray(arr) ? arr : []);
  } catch {
    return [];
  }
}
let _history = loadHistoryFromLS();
let _hid = nextUATHistoryId(_history);
function saveToHistory(entry) {
  const record = { id: _hid++, ...entry, ts: new Date().toISOString() };
  _history.unshift(record);
  _history = filterUATHistoryByRetention(_history);
  try {
    localStorage.setItem(UAT_HISTORY_KEY, JSON.stringify(_history.slice(0, 50)));
  } catch {}
  return record;
}
function getHistory() { return _history; }

function reloadUATHistoryModuleFromLS() {
  _history = loadHistoryFromLS();
  _hid = nextUATHistoryId(_history);
}

const UAT_FEEDBACK_MEM_KEY = "uat-feedback-memory-v1";
function loadUATFeedbackMemory() { try { return JSON.parse(localStorage.getItem(UAT_FEEDBACK_MEM_KEY) || "[]"); } catch { return []; } }
function saveUATFeedbackMemoryLS(m) { try { localStorage.setItem(UAT_FEEDBACK_MEM_KEY, JSON.stringify(m.slice(0, 20))); } catch {} }

// ── Utilities ─────────────────────────────────────────────────────────────────
async function readFiles(fileList) {
  const arr = Array.from(fileList || []);
  const contents = [];
  for (const f of arr) {
    const text = await f.text().catch(() => `[Binary file: ${f.name}]`);
    contents.push({ name: f.name, content: text.slice(0, 12000) });
  }
  return { files: arr, contents };
}

const MAX_CLARIFY_USER_CHARS = 100_000;
const MAX_GENERATE_USER_CHARS = 420_000;
const MAX_FEEDBACK_USER_CHARS = 420_000;

function truncateForLLM(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[TRUNCATED — input exceeded ${maxChars.toLocaleString()} characters (${s.length.toLocaleString()} total). Tail omitted.]`;
}

function formatInline(t) {
  return (t || "")
    .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#f1f5f9;font-weight:700">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em style="color:#94a3b8">$1</em>')
    .replace(/`(.*?)`/g, '<code style="background:#111827;padding:1px 6px;border-radius:3px;font-family:JetBrains Mono,monospace;color:#a78bfa;font-size:0.82em">$1</code>');
}

function MarkdownRenderer({ content }) {
  const lines = content.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("|") && i + 1 < lines.length && lines[i+1].match(/^\|[\s\-:|]+\|/)) {
      const headers = line.split("|").slice(1,-1).map(c=>c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i].split("|").slice(1,-1).map(c=>c.trim()));
        i++;
      }
      const isResultCol = (h) => ["result","status","covered?","gap?"].includes(h.toLowerCase());
      const colorResult = (v) => {
        if (!v) return v;
        const u = v.toUpperCase();
        if (u.includes("PASS") && !u.includes("FAIL")) return `<span style="color:#34d399;font-weight:700">${v}</span>`;
        if (u.includes("FAIL") || u==="NOT COVERED" || u.includes("❌")) return `<span style="color:#f87171;font-weight:700">${v}</span>`;
        if (u.includes("BLOCK") || u.includes("PARTIAL") || u.includes("⚠")) return `<span style="color:#fbbf24;font-weight:700">${v}</span>`;
        if (u.includes("COVERED") && !u.includes("NOT") || u.includes("✅")) return `<span style="color:#34d399">${v}</span>`;
        return formatInline(v);
      };
      result.push(`<div style="overflow-x:auto;margin:14px 0;border-radius:8px;overflow:hidden;border:1px solid #1e1e38">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;font-family:JetBrains Mono,monospace">
          <thead><tr>${headers.map(h=>`<th style="background:#111827;color:#e8b84b;padding:10px 14px;text-align:left;font-weight:600;white-space:nowrap;border-bottom:1px solid #1E293B;letter-spacing:0.04em;font-size:11px;text-transform:uppercase">${formatInline(h)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((r,ri)=>`<tr style="background:${ri%2?"#0D1626":"#0B1120"};transition:background 0.15s" onmouseover="this.style.background='#111827'" onmouseout="this.style.background='${ri%2?"#0D1626":"#0B1120"}'">${r.map((c,ci)=>`<td style="padding:9px 14px;border-bottom:1px solid #111827;color:#cbd5e1;vertical-align:top">${isResultCol(headers[ci]) ? colorResult(c) : formatInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div>`);
      continue;
    }
    if (line.match(/^# /)) result.push(`<h1 style="font-size:1.4em;color:#f8fafc;font-family:Syne,sans-serif;font-weight:800;border-bottom:2px solid #e8b84b;padding-bottom:10px;margin:0 0 20px;letter-spacing:-0.02em">${formatInline(line.slice(2))}</h1>`);
    else if (line.match(/^## /)) result.push(`<h2 style="font-size:1em;color:#e8b84b;font-family:Syne,sans-serif;font-weight:700;margin:22px 0 10px;padding:8px 14px;background:linear-gradient(90deg,#e8b84b12,transparent);border-left:3px solid #e8b84b;border-radius:0 6px 6px 0;letter-spacing:0.02em">${formatInline(line.slice(3))}</h2>`);
    else if (line.match(/^### /)) result.push(`<h3 style="font-size:0.9em;color:#cbd5e1;font-family:Syne,sans-serif;font-weight:700;margin:14px 0 6px;text-transform:uppercase;letter-spacing:0.06em">${formatInline(line.slice(4))}</h3>`);
    else if (line.match(/^---+$/)) result.push(`<hr style="border:none;border-top:1px solid #1E293B;margin:18px 0">`);
    else if (line.match(/^- /)) result.push(`<div style="display:flex;gap:8px;margin:3px 0;color:#94a3b8;font-size:13px"><span style="color:#e8b84b;margin-top:2px;flex-shrink:0">▸</span><span>${formatInline(line.slice(2))}</span></div>`);
    else if (line.trim() === "") result.push(`<div style="height:6px"></div>`);
    else result.push(`<p style="margin:4px 0;color:#94a3b8;line-height:1.75;font-size:13px;font-family:JetBrains Mono,monospace">${formatInline(line)}</p>`);
    i++;
  }
  return <div dangerouslySetInnerHTML={{ __html: result.join("") }} />;
}

// ── Shared UI atoms ───────────────────────────────────────────────────────────
const C = {
  bg: "#0B1120", surface: "#0D1626", elevated: "#111827", border: "#1E293B",
  gold: "#e8b84b", goldDim: "#e8b84b44", text: "#f1f5f9", muted: "#64748b", subtle: "#94a3b8",
  font: "Syne, sans-serif", mono: "JetBrains Mono, monospace",
};

function Tag({ children, color = C.gold }) {
  return <span style={{ background: color+"18", color, border:`1px solid ${color}33`, borderRadius:4, padding:"2px 9px", fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", whiteSpace:"nowrap", fontFamily:C.mono }}>{children}</span>;
}

function Btn({ children, variant="primary", onClick, disabled, style={}, size="md" }) {
  const pad = size==="sm" ? "7px 14px" : size==="lg" ? "14px 28px" : "10px 20px";
  const base = {
    border:"none", borderRadius:8, cursor: disabled?"not-allowed":"pointer",
    fontFamily:C.font, fontWeight:700, letterSpacing:"0.04em",
    transition:"all 0.2s", opacity: disabled?0.5:1,
    fontSize: size==="sm"?11:size==="lg"?15:13, padding:pad, ...style
  };
  const variants = {
    primary: { background:`linear-gradient(135deg, ${C.gold}, #f0cc6a)`, color:"#0a0a14", boxShadow:"0 2px 12px #e8b84b30" },
    ghost: { background:"transparent", color:C.subtle, border:`1px solid ${C.border}` },
    danger: { background:"#f8717118", color:"#f87171", border:"1px solid #f8717133" },
    outline: { background:"transparent", color:C.gold, border:`1px solid ${C.goldDim}` },
    teal: { background:"#0d9488", color:"#fff", boxShadow:"0 2px 12px #0d948830" },
  };
  return <button type="button" onClick={disabled?undefined:onClick} style={{...base,...variants[variant]}}>{children}</button>;
}

function Card({ children, style = {}, className = "", ...rest }) {
  return <div className={className} style={{ background:C.elevated, border:`1px solid ${C.border}`, borderRadius:12, ...style }} {...rest}>{children}</div>;
}

function SectionHeader({ icon, title, tag, tagColor }) {
  return (
    <div style={{ padding:"13px 20px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:10, background:C.surface }}>
      <span style={{ fontSize:17 }}>{icon}</span>
      <span style={{ fontWeight:700, fontSize:13, color:C.text, fontFamily:C.font }}>{title}</span>
      {tag && <Tag color={tagColor}>{tag}</Tag>}
    </div>
  );
}

function Toggle({ on, onChange, label, icon }) {
  return (
    <div onClick={()=>onChange(!on)} style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", userSelect:"none" }}>
      <div style={{ width:38, height:21, borderRadius:11, background: on?C.gold:"#1e1e38", border:`1px solid ${on?C.gold:C.border}`, position:"relative", transition:"all 0.2s", flexShrink:0 }}>
        <div style={{ position:"absolute", top:3, left: on?18:3, width:13, height:13, borderRadius:"50%", background: on?"#0a0a14":C.muted, transition:"left 0.2s" }} />
      </div>
      <span style={{ fontSize:12, color: on?C.text:C.muted, fontFamily:C.font }}>{icon} {label}</span>
    </div>
  );
}

function ModeTab({ modes, active, onChange }) {
  return (
    <div style={{ display:"inline-flex", background:C.surface, borderRadius:8, border:`1px solid ${C.border}`, overflow:"hidden", marginBottom:14 }}>
      {modes.map(m => (
        <button type="button" key={m.id} onClick={()=>onChange(m.id)} style={{
          background: active===m.id ? C.gold : "transparent",
          color: active===m.id ? "#0a0a14" : C.muted,
          border:"none", padding:"7px 18px", cursor:"pointer",
          fontSize:12, fontWeight:700, fontFamily:C.font,
          transition:"all 0.15s", display:"flex", alignItems:"center", gap:5
        }}>{m.icon} {m.label}</button>
      ))}
    </div>
  );
}

function FileChip({ file, onRemove }) {
  const ext = file.name.split(".").pop().toUpperCase();
  const colors = { PDF:"#f87171", DOCX:"#60a5fa", XLSX:"#34d399", XLS:"#34d399", TXT:C.muted, MD:"#a78bfa", CSV:C.gold };
  const c = colors[ext]||C.muted;
  return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:c+"15", border:`1px solid ${c}33`, borderRadius:6, padding:"4px 10px", fontSize:11 }}>
      <span style={{ background:c+"33", padding:"1px 5px", borderRadius:3, color:c, fontWeight:700, fontFamily:C.mono }}>{ext}</span>
      <span style={{ color:C.subtle, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontFamily:C.mono }}>{file.name}</span>
      <button type="button" onClick={onRemove} style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, padding:0, fontSize:15, lineHeight:1 }}>×</button>
    </div>
  );
}

function Dropzone({ fileRef, onDrop, onBrowse, files, onRemove, hint }) {
  const [drag, setDrag] = useState(false);
  return (
    <>
      <div onClick={onBrowse}
        onDragOver={e=>{e.preventDefault();setDrag(true);}}
        onDragLeave={()=>setDrag(false)}
        onDrop={e=>{e.preventDefault();setDrag(false);onDrop(e.dataTransfer.files);}}
        style={{ border:`2px dashed ${drag?C.gold:C.border}`, borderRadius:10, padding:"22px 16px", textAlign:"center", cursor:"pointer", background:drag?`${C.gold}08`:"transparent", transition:"all 0.2s" }}
      >
        <div style={{ fontSize:24, marginBottom:6 }}>📎</div>
        <div style={{ color:C.muted, fontSize:12, fontFamily:C.font }}>Drop files or <span style={{color:C.gold}}>click to browse</span></div>
        <div style={{ color:"#334155", fontSize:11, marginTop:3, fontFamily:C.mono }}>{hint||"PDF · DOCX · XLSX · TXT · CSV"}</div>
      </div>
      {files.length > 0 && <div style={{ marginTop:10, display:"flex", flexWrap:"wrap", gap:7 }}>{files.map((f,i)=><FileChip key={i} file={f} onRemove={()=>onRemove(i)}/>)}</div>}
    </>
  );
}

function ModelPicker({ selected, onChange }) {
  const [open, setOpen] = useState(false);
  const m = MODELS.find(x=>x.id===selected)||MODELS[0];
  return (
    <div style={{ position:"relative" }}>
      <button type="button" onClick={()=>setOpen(o=>!o)} style={{ background:C.elevated, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"7px 14px", cursor:"pointer", display:"flex", alignItems:"center", gap:8, fontSize:12, fontWeight:600, fontFamily:C.font }}>
        <span style={{ width:7, height:7, borderRadius:"50%", background:m.color, display:"inline-block", flexShrink:0 }}/>
        {m.label}
        <span style={{ opacity:0.4, fontSize:9 }}>▾</span>
      </button>
      {open && (
        <div style={{ position:"absolute", top:"110%", right:0, background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, zIndex:300, minWidth:220, boxShadow:"0 12px 40px rgba(0,0,0,0.7)", overflow:"hidden" }}>
          {MODELS.map(model=>(
            <div key={model.id} onClick={()=>{onChange(model.id);setOpen(false);}}
              style={{ padding:"10px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, borderBottom:`1px solid ${C.border}`, fontSize:12, background:selected===model.id?C.elevated:"transparent", color:C.text, transition:"background 0.1s" }}
              onMouseEnter={e=>e.currentTarget.style.background=C.elevated}
              onMouseLeave={e=>e.currentTarget.style.background=selected===model.id?C.elevated:"transparent"}
            >
              <span style={{ width:7, height:7, borderRadius:"50%", background:model.color, flexShrink:0 }}/>
              <div><div style={{ fontWeight:600, fontFamily:C.font }}>{model.label}</div><div style={{ fontSize:10, color:C.muted }}>{model.provider}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Spinner({ size=16 }) {
  return <div style={{ width:size, height:size, border:`2px solid ${C.border}`, borderTopColor:C.gold, borderRadius:"50%", animation:"spin 0.7s linear infinite", display:"inline-block", flexShrink:0 }}/>;
}

// ── Status badge helper ───────────────────────────────────────────────────────
function StatusBadge({ status, label }) {
  const cfg = {
    loading: { color:"#60a5fa", icon:"⏳" },
    ok: { color:"#34d399", icon:"✅" },
    warn: { color:"#fbbf24", icon:"⚠️" },
    error: { color:"#f87171", icon:"❌" },
    skip: { color:C.muted, icon:"⏭️" },
  }[status] || { color:C.muted, icon:"•" };
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, color:cfg.color, fontFamily:C.mono }}>
      {status==="loading" ? <Spinner size={12}/> : <span>{cfg.icon}</span>}
      {label}
    </span>
  );
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({ step, hasDiscovery }) {
  const steps = hasDiscovery
    ? ["Input", "Discovery", "Clarify", "Review", "Signoff"]
    : ["Input", "Clarify", "Review", "Signoff"];
  return (
    <div style={{ display:"flex", alignItems:"center", gap:0, marginBottom:28 }}>
      {steps.map((s,i)=>(
        <div key={i} style={{ display:"flex", alignItems:"center", flex: i<steps.length-1?1:"none" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
            <div style={{
              width:30, height:30, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
              background: step>i?C.gold:step===i?`${C.gold}22`:"#0D1626",
              border:`2px solid ${step>=i?C.gold:C.border}`,
              fontSize:12, fontWeight:700, color: step>i?"#0a0a14":step===i?C.gold:C.muted,
              transition:"all 0.3s", fontFamily:C.font
            }}>
              {step>i ? "✓" : i+1}
            </div>
            <span style={{ fontSize:10, color:step===i?C.gold:C.muted, whiteSpace:"nowrap", fontFamily:C.font, fontWeight:step===i?700:400 }}>{s}</span>
          </div>
          {i<steps.length-1 && <div style={{ flex:1, height:2, background:step>i?C.gold:C.border, margin:"0 6px 16px", transition:"background 0.3s" }}/>}
        </div>
      ))}
    </div>
  );
}

// ── Discovery Row ─────────────────────────────────────────────────────────────
function DiscoveryRow({ icon, label, status, detail }) {
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:10, padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
      <span style={{ fontSize:16, marginTop:1, flexShrink:0 }}>{icon}</span>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:12, color:C.text, fontWeight:600, fontFamily:C.font }}>{label}</div>
        {detail && <div style={{ fontSize:11, color:C.muted, fontFamily:C.mono, marginTop:2, lineHeight:1.5 }}>{detail}</div>}
      </div>
      <StatusBadge status={status} label={
        status==="ok" ? "Found" :
        status==="warn" ? "Partial" :
        status==="error" ? "Failed" :
        status==="skip" ? "Skipped" :
        status==="loading" ? "Fetching..." : "—"
      }/>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function TestSentinel() {
  const [view, setView] = useState("home");
  const [step, setStep] = useState(0);
  const [model, setModel] = useState(MODELS[0].id);
  const [webSearch, setWebSearch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Jira fetch
  const [jiraIssueKey, setJiraIssueKey] = useState("");
  const [jiraFetchLoading, setJiraFetchLoading] = useState(false);
  const [jiraFetchError, setJiraFetchError] = useState("");
  const [lastJiraPayload, setLastJiraPayload] = useState(null);

  // JIRA details (auto-populated or manual)
  const [jiraSubject, setJiraSubject] = useState("");
  const [jiraDesc, setJiraDesc] = useState("");
  const [jiraMode, setJiraMode] = useState("type");
  const [jiraFiles, setJiraFiles] = useState([]); const [jiraFC, setJiraFC] = useState([]);

  // Domain scope
  const [selectedDomains, setSelectedDomains] = useState(["switch"]);

  // Discovery state
  const [discovery, setDiscovery] = useState(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryLog, setDiscoveryLog] = useState([]);
  const [hasDiscovery, setHasDiscovery] = useState(false);

  // Gap answers (Step 1 – Discovery)
  const [gapAnswers, setGapAnswers] = useState("");
  const [gapMode, setGapMode] = useState("type");
  const [gapFiles, setGapFiles] = useState([]); const [gapFC, setGapFC] = useState([]);

  // Legacy input fields (kept for manual mode / additional context)
  const [testCases, setTestCases] = useState("");
  const [testMode, setTestMode] = useState("type");
  const [testFiles, setTestFiles] = useState([]); const [testFC, setTestFC] = useState([]);
  const [docsText, setDocsText] = useState("");
  const [docsMode, setDocsMode] = useState("type");
  const [docsFiles, setDocsFiles] = useState([]); const [docsFC, setDocsFC] = useState([]);

  // Clarify step
  const [clarifyRaw, setClarifyRaw] = useState("");
  const [draftObjective, setDraftObjective] = useState("");
  const [editedObjective, setEditedObjective] = useState("");
  const [clarifyAnswers, setClarifyAnswers] = useState("");

  // Result
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const [discrepancyResult, setDiscrepancyResult] = useState(null);
  const [discrepancyLoading, setDiscrepancyLoading] = useState(false);

  // Feedback
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackMode, setFeedbackMode] = useState("type");
  const [feedbackFiles, setFeedbackFiles] = useState([]); const [feedbackFC, setFeedbackFC] = useState([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackMemory, setFeedbackMemory] = useState(() => loadUATFeedbackMemory());

  const [autoPublishChannels, setAutoPublishChannels] = useState({ jira: false, telegram: false, email: false, slack: false });
  const [allowAutoPublish, setAllowAutoPublish] = useState(false);

  useEffect(() => { saveUATFeedbackMemoryLS(feedbackMemory); }, [feedbackMemory]);

  const [, setHistoryImportBump] = useState(0);

  // Local Drive file cleanup after UAT
  const [localDriveCleanupFiles, setLocalDriveCleanupFiles] = useState([]); // [{path, name, deleted}]
  const [cleanupConfirming, setCleanupConfirming] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState(null); // null | "deleted" | "kept" | "error"
  useEffect(() => {
    const onImport = () => {
      reloadUATHistoryModuleFromLS();
      setFeedbackMemory(loadUATFeedbackMemory());
      setHistoryImportBump((n) => n + 1);
    };
    window.addEventListener("agent-localstorage-imported", onImport);
    return () => window.removeEventListener("agent-localstorage-imported", onImport);
  }, []);

  const jiraRef = useRef(); const testRef = useRef(); const docsRef = useRef(); const fbRef = useRef(); const gapRef = useRef();
  const hasSentNotifyRef = useRef(false);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function parseJiraIssueKey(input) {
    const s = (input || "").trim();
    if (!s) return "";
    const keyMatch = s.match(/\b([A-Z][A-Z0-9]*-\d+)\b/i);
    if (keyMatch) return keyMatch[1].toUpperCase();
    try {
      const url = new URL(s.startsWith("http") ? s : "https://host/" + s);
      const segments = (url.pathname || "").split("/").filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && /^[A-Z0-9]+-\d+$/i.test(last)) return last.toUpperCase();
    } catch (_) {}
    return "";
  }

  const addFiles = async (fl, setF, setC) => {
    const { files, contents } = await readFiles(fl);
    setF(p=>[...p,...files]); setC(p=>[...p,...contents]);
  };
  const removeFile = (i, setF, setC) => { setF(p=>p.filter((_,j)=>j!==i)); setC(p=>p.filter((_,j)=>j!==i)); };

  // ── LLM call with fallback ────────────────────────────────────────────────
  const callClaude = async (systemPrompt, userMessage, maxTokens = 8000) => {
    const makeBody = (extra = {}) => JSON.stringify({
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      max_tokens: maxTokens,
      agent: "UAT",
      llmProvider: getLlmProviderForRequest(),
      llmDisabled: getLlmDisabledForRequest(),
      bedrockModelTier: getBedrockModelTierForRequest(),
      ...getLlmRoutingExtras(),
      ...extra,
    });
    const extractText = (data) => {
      const payload = data.data ?? data;
      const blocks = payload?.content;
      if (Array.isArray(blocks)) return blocks.filter(b=>b.type==="text").map(b=>b.text||"").join("\n");
      return String(payload?.text || payload?.output || payload?.result || "");
    };
    // Primary endpoint
    try {
      const res = await fetch(`${API_BASE}/api/generate`, { method:"POST", headers:{"Content-Type":"application/json"}, body: makeBody() });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = {}; }
      if (!res.ok || data.error) throw new Error(data.message || data.error?.message || `Primary failed: ${res.status}`);
      const out = extractText(data);
      if (out) return out;
      throw new Error("Empty response from primary endpoint");
    } catch (primaryErr) {
      console.warn("[UAT] Primary endpoint failed, trying /api/claude:", primaryErr.message);
      // Fallback to direct Claude endpoint
      try {
        const res2 = await fetch(`${API_BASE}/api/claude`, { method:"POST", headers:{"Content-Type":"application/json"}, body: makeBody() });
        const text2 = await res2.text();
        let data2; try { data2 = JSON.parse(text2); } catch { data2 = {}; }
        if (!res2.ok || data2.error) throw new Error(data2.message || data2.error?.message || `Fallback failed: ${res2.status}`);
        return extractText(data2) || "Generation completed (empty response).";
      } catch (fallbackErr) {
        throw new Error(`LLM unavailable. Primary: ${primaryErr.message}. Fallback: ${fallbackErr.message}. Try restarting services.`);
      }
    }
  };

  // ── JIRA fetch (pure data) ────────────────────────────────────────────────
  const handleFetchJiraUAT = async () => {
    const raw = jiraIssueKey.trim();
    const key = parseJiraIssueKey(raw);
    if (!key && !raw) { setJiraFetchError("Enter a JIRA issue key (e.g. TSP-1889) or paste a JIRA URL."); return; }
    setJiraFetchError("");
    setJiraFetchLoading(true);
    try {
      const defs = loadPublishDefaults();
      const site = defs.jiraWriteSite;
      const siteQs = site && site !== "auto" ? `?site=${encodeURIComponent(site)}` : "";
      const idParam = raw || key;
      const r = await fetch(`${API_BASE}/api/jira-issue/${encodeURIComponent(idParam)}${siteQs}`, { headers: { Accept: "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `JIRA error ${r.status}`);
      setLastJiraPayload(d);
      setJiraSubject(d.summary ? `${d.id} — ${d.summary}` : d.id || jiraIssueKey);
      const descParts = [
        d.description,
        d.acceptanceCriteria ? `Acceptance Criteria:\n${d.acceptanceCriteria}` : "",
        d.requirement ? `Requirement:\n${d.requirement}` : "",
        d.fundlossRisk ? `Fund Loss / Risk:\n${d.fundlossRisk}` : "",
      ].filter(Boolean);
      setJiraDesc(descParts.join("\n\n") || "(No description)");
      setJiraMode("type");
      syncPublishDefaultJiraKey(d.id || key);
      syncPublishJiraSiteFromIssue(d);
    } catch (e) {
      setJiraFetchError(e.message || "JIRA fetch failed");
    }
    setJiraFetchLoading(false);
  };

  // ── Discovery: fetch attachments + Drive links ────────────────────────────
  const handleRunDiscovery = async (jiraPayload) => {
    const payload = jiraPayload || lastJiraPayload;
    if (!payload) return;
    setDiscoveryLoading(true);
    setDiscoveryLog([]);
    const log = (msg) => setDiscoveryLog(prev => [...prev, msg]);

    const disc = {
      jiraFields: {
        id: payload.id,
        summary: payload.summary,
        reporter: payload.reporter,
        assignee: payload.assignee,
        fixVersions: payload.fixVersions,
        labels: payload.labels,
        status: payload.status,
        priority: payload.priority,
        components: payload.components,
        acceptanceCriteria: payload.acceptanceCriteria,
        requirement: payload.requirement || "",
        fundlossRisk: payload.fundlossRisk || "",
        comments: payload.comments,
      },
      attachmentResults: [],
      driveResults: [],
      testCasesFromSheets: "",
      existingQATestCases: payload.comments || "",
      gapsDetected: [],
    };

    // Extract attachments
    const attachItems = Array.isArray(payload.attachmentItems) ? payload.attachmentItems : [];
    log(`📎 Found ${attachItems.length} attachment(s)`);
    for (const att of attachItems) {
      const fname = att.filename || "file";
      const isDoc = /\.(pdf|docx|xlsx|xls|txt|csv|md)$/i.test(fname);
      if (!isDoc) {
        disc.attachmentResults.push({ filename: fname, status: "skip", text: "", chars: 0 });
        log(`⏭️ Skipped ${fname} (not a document)`);
        continue;
      }
      try {
        log(`⏳ Extracting ${fname}...`);
        const r = await fetch(`${API_BASE}/api/jira-attachment-text?${new URLSearchParams({ url: att.url, filename: fname })}`);
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) throw new Error(d.error || "Extraction failed");
        disc.attachmentResults.push({ filename: fname, status: "ok", text: d.text || "", chars: d.chars || (d.text||"").length });
        log(`✅ Extracted ${fname}: ${(d.chars||0).toLocaleString()} chars`);
      } catch (e) {
        disc.attachmentResults.push({ filename: fname, status: "error", text: "", chars: 0, error: e.message });
        log(`❌ Failed ${fname}: ${e.message}`);
      }
    }

    // Extract Google Drive links
    const driveLinks = Array.isArray(payload.driveLinks) ? payload.driveLinks : [];
    const sheetLinks = Array.isArray(payload.qaTestCaseSheetUrls) ? payload.qaTestCaseSheetUrls : [];
    const allDriveLinks = [...new Set([...driveLinks, ...sheetLinks])];
    log(`🔗 Found ${allDriveLinks.length} Google Drive link(s)`);

    const jiraKey = payload.id || "";
    for (const url of allDriveLinks) {
      try {
        log(`⏳ Fetching Drive link locally (tab: ${jiraKey || "auto"})...`);
        const params = { url };
        if (jiraKey) params.sheetTabName = jiraKey;
        const r = await fetch(`${API_BASE}/api/gdrive-fetch?${new URLSearchParams(params)}`);
        const d = await r.json().catch(() => ({}));
        if (d.localNotFound) {
          disc.driveResults.push({ url, status: "warn", text: null, error: d.message, hint: d.hint, type: d.type, localNotFound: true });
          log(`⚠️ ${d.message}`);
        } else if (d.requiresAuth || !d.text) {
          disc.driveResults.push({ url, status: "warn", text: null, error: d.error || "Requires login", type: d.type });
          log(`⚠️ Drive link requires auth — user must paste content`);
        } else {
          const src = d.source === "local" ? `local file (${d.filePath?.split("/").pop()})` : "remote";
          disc.driveResults.push({ url, status: "ok", text: d.text, chars: d.chars || d.text.length, type: d.type, source: d.source, filePath: d.filePath });
          disc.testCasesFromSheets += `\n\nGoogle ${d.type==="sheet"?"Sheets":"Docs"} content (${src}):\n${d.text}`;
          log(`✅ Drive content fetched from ${src}: ${(d.chars||0).toLocaleString()} chars`);
        }
      } catch (e) {
        disc.driveResults.push({ url, status: "error", text: null, error: e.message });
        log(`❌ Drive fetch error: ${e.message}`);
      }
    }

    // Detect gaps
    if (!disc.jiraFields.acceptanceCriteria) disc.gapsDetected.push("Acceptance Criteria not found in JIRA ticket");
    if (!disc.existingQATestCases) disc.gapsDetected.push("No QA test cases found in JIRA comments");
    if (disc.attachmentResults.filter(a=>a.status==="ok").length===0 && attachItems.length>0) disc.gapsDetected.push("Attachment extraction failed — upload docs manually");
    const localNotFoundResults = disc.driveResults.filter(d=>d.localNotFound);
    if (localNotFoundResults.length > 0) {
      const hint = localNotFoundResults[0]?.hint || "";
      disc.gapsDetected.push(`Test case sheet not in local Drive. ${hint ? "Save it as: " + hint : "Export the tab as CSV to your Google Drive."}`);
    } else if (disc.driveResults.some(d=>d.status==="warn" && !d.localNotFound)) {
      disc.gapsDetected.push("Some Google Drive sheets require login — paste content in gap answers");
    }
    if (disc.testCasesFromSheets === "" && allDriveLinks.length === 0) disc.gapsDetected.push("No test case sheet found — provide QA test results in gap answers");

    setDiscovery(disc);
    setHasDiscovery(true);
    setDiscoveryLoading(false);
    log(`✅ Discovery complete`);
  };

  // ── Fetch + Discover (Step 0 → Step 1): always fresh-fetches then runs discovery ──
  const handleFetchAndDiscover = async () => {
    const raw = jiraIssueKey.trim();
    if (!raw) {
      setJiraFetchError("Enter a JIRA issue key (e.g. TSP-4452) to auto-discover.");
      return;
    }
    setJiraFetchError("");
    setJiraFetchLoading(true);
    let payload = null;
    try {
      const key = parseJiraIssueKey(raw);
      const defs = loadPublishDefaults();
      const site = defs.jiraWriteSite;
      const siteQs = site && site !== "auto" ? `?site=${encodeURIComponent(site)}` : "";
      const r = await fetch(`${API_BASE}/api/jira-issue/${encodeURIComponent(raw)}${siteQs}`, { headers: { Accept: "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `JIRA error ${r.status}`);
      payload = d;
      setLastJiraPayload(d);
      setJiraSubject(d.summary ? `${d.id} — ${d.summary}` : d.id || raw);
      const descParts = [
        d.description,
        d.acceptanceCriteria ? `Acceptance Criteria:\n${d.acceptanceCriteria}` : "",
        d.requirement ? `Requirement:\n${d.requirement}` : "",
        d.fundlossRisk ? `Fund Loss / Risk:\n${d.fundlossRisk}` : "",
      ].filter(Boolean);
      setJiraDesc(descParts.join("\n\n") || "(No description)");
      syncPublishDefaultJiraKey(d.id || key);
      syncPublishJiraSiteFromIssue(d);
    } catch (e) {
      setJiraFetchError(e.message || "JIRA fetch failed");
      setJiraFetchLoading(false);
      return;
    }
    setJiraFetchLoading(false);
    // Run auto-discovery on fresh payload
    await handleRunDiscovery(payload);
    setStep(1);
  };

  // ── Step 1 → 2: Clarify ────────────────────────────────────────────────────
  const handleProceedToClarify = async () => {
    if (!hasInput() && !discovery) { setStatusMsg("Please provide at least one input."); return; }
    if (!selectedDomains.length) { setStatusMsg("Please select at least one domain."); return; }
    setLoading(true); setStatusMsg("Analyzing inputs & drafting objective...");
    try {
      const ctx = truncateForLLM(buildContext(), MAX_CLARIFY_USER_CHARS);
      const raw = await callClaude(CLARIFY_SYSTEM, ctx, 3500);
      setClarifyRaw(raw);
      const objMatch = raw.match(/DRAFT_OBJECTIVE:\s*([\s\S]*?)(?=QUESTIONS:|$)/i);
      const draft = objMatch ? objMatch[1].trim() : "";
      setDraftObjective(draft);
      setEditedObjective(draft);
      setStep(hasDiscovery ? 2 : 1);
      setStatusMsg("");
    } catch(e) { setStatusMsg("Error: "+e.message); }
    finally { setLoading(false); }
  };

  // ── Step 2 → 3: Review ────────────────────────────────────────────────────
  const handleProceedToReview = () => { setStep(hasDiscovery ? 3 : 2); };

  // ── Step 3 → Generate ─────────────────────────────────────────────────────
  const handleGenerate = async () => {
    setLoading(true); setStatusMsg("Generating UAT Signoff...");
    try {
      let userMsg = buildContext();
      if (clarifyAnswers.trim()) userMsg += `\nClarification Answers:\n${clarifyAnswers}\n`;
      if (feedbackMemory.length > 0) userMsg += `\nREMEMBERED FEEDBACK FROM PREVIOUS UATs (apply these improvements):\n${feedbackMemory.map(f => `- ${f}`).join("\n")}\n`;
      userMsg = truncateForLLM(userMsg, MAX_GENERATE_USER_CHARS);
      const domains = AGENT_DOMAIN_ENTRIES.filter((d) => selectedDomains.includes(d.id));
      const signoff = await callClaude(buildSystemPrompt(domains, editedObjective, ""), userMsg, 16384);
      const jiraKey = parseJiraIssueKey(jiraIssueKey) || parseJiraIssueKey(jiraSubject);
      const entry = saveToHistory({
        jira: jiraSubject||jiraFiles[0]?.name||"Unnamed",
        jiraKey,
        model: MODELS.find(m=>m.id===model)?.label||model,
        domains: domains.map((d) => d.label),
        selectedDomainIds: [...selectedDomains],
        objective: editedObjective,
        signoff
      });
      setResult({ signoff, id:entry.id, domains:entry.domains });
      setStep(hasDiscovery ? 4 : 3);
      setView("result");
      setStatusMsg("");
      // Track local Drive files used — offer cleanup after UAT
      if (discovery?.driveResults) {
        const localFiles = discovery.driveResults
          .filter(d => d.source === "local" && d.filePath)
          .map(d => ({ path: d.filePath, name: d.filePath.split("/").pop(), deleted: false }));
        if (localFiles.length > 0) {
          setLocalDriveCleanupFiles(localFiles);
          setCleanupStatus(null);
          setCleanupConfirming(false);
        }
      }
      // Background .md export
      void exportAgentOutput({
        agent: "UAT",
        jiraId: jiraKey || "NOJIRA",
        subject: jiraSubject || "UAT-Signoff",
        content: signoff,
        steps: [
          "Fetch JIRA ticket + auto-discover attachments & Drive links",
          "Extract text from attachments, fetch Google Sheets test cases",
          "Gap analysis + clarify + objective confirmation",
          "LLM: UAT signoff document with discrepancy analysis",
          "Save to UAT history",
        ],
        input: userMsg,
      });
      setAllowAutoPublish(true);
      if (!hasSentNotifyRef.current) {
        hasSentNotifyRef.current = true;
        await sendCompletionNotify({
          agentName: "UAT Agent",
          identifier: jiraSubject || jiraIssueKey || "UAT Signoff",
          notifySubject: buildShareSubjectLine("uat", jiraKey, jiraSubject || "UAT Signoff"),
        });
      }
    } catch(e) { setStatusMsg("Error: "+e.message); }
    finally { setLoading(false); }
  };

  // ── On-demand discrepancy analysis ────────────────────────────────────────
  const handleDiscrepancyAnalysis = async () => {
    if (!result?.signoff) return;
    setDiscrepancyLoading(true);
    try {
      const qaContext = [
        discovery?.existingQATestCases ? `JIRA Comments / QA Test Cases:\n${discovery.existingQATestCases}` : "",
        discovery?.testCasesFromSheets ? `Google Sheets Test Cases:\n${discovery.testCasesFromSheets}` : "",
        testCases ? `Additional Test Cases Pasted:\n${testCases}` : "",
      ].filter(Boolean).join("\n\n");

      const userMsg = `UAT Signoff:\n${result.signoff.slice(0, 8000)}\n\n---\n\nQA / Dev Test Cases:\n${qaContext || "No QA test cases provided."}`;
      const analysis = await callClaude(DISCREPANCY_SYSTEM, userMsg, 4000);
      setDiscrepancyResult(analysis);
    } catch(e) { setDiscrepancyResult(`Error: ${e.message}`); }
    finally { setDiscrepancyLoading(false); }
  };

  // ── Feedback → regenerate ─────────────────────────────────────────────────
  const handleFeedback = async () => {
    if (!feedbackText.trim() && feedbackFiles.length===0) return;
    setFeedbackLoading(true);
    try {
      let fbCtx = result.signoff+"\n\n---\nUSER FEEDBACK:\n";
      if (feedbackMode==="type") fbCtx += feedbackText;
      else feedbackFC.forEach(f=>{ fbCtx+=`[File: ${f.name}]\n${f.content}\n`; });
      fbCtx = truncateForLLM(fbCtx, MAX_FEEDBACK_USER_CHARS);
      const domains = AGENT_DOMAIN_ENTRIES.filter((d) => result.domains?.includes(d.label));
      const improved = await callClaude(buildSystemPrompt(domains, editedObjective, feedbackText||"(see attached feedback)"), fbCtx, 16384);
      const jiraKey = parseJiraIssueKey(jiraIssueKey) || parseJiraIssueKey(jiraSubject);
      const entry = saveToHistory({
        jira: (jiraSubject||"Feedback revision")+" (revised)",
        jiraKey,
        model: MODELS.find(m=>m.id===model)?.label||model,
        domains: result.domains||[],
        selectedDomainIds: [...selectedDomains],
        objective: editedObjective,
        signoff: improved
      });
      setResult({ signoff:improved, id:entry.id, domains:result.domains });
      setDiscrepancyResult(null); // reset discrepancy on revision
      void exportAgentOutput({
        agent: "UAT",
        jiraId: jiraKey || "NOJIRA",
        subject: (jiraSubject || "UAT-Signoff") + "-revised",
        content: improved,
        steps: ["Apply user feedback to prior signoff", "LLM: revised UAT signoff"],
        input: fbCtx,
      });
      const fbSummary = feedbackMode === "type" ? feedbackText.trim() : feedbackFC.map(f => `[${f.name}] ${f.content.slice(0, 100)}`).join("; ");
      if (fbSummary) setFeedbackMemory(prev => [...prev, fbSummary.slice(0, 200)].slice(-20));
      setFeedbackText(""); setFeedbackFiles([]); setFeedbackFC([]);
      setAllowAutoPublish(true);
      if (!hasSentNotifyRef.current) {
        hasSentNotifyRef.current = true;
        await sendCompletionNotify({
          agentName: "UAT Agent",
          identifier: (jiraSubject || jiraIssueKey || "UAT Signoff") + " (revised)",
          notifySubject: buildShareSubjectLine("uat", jiraKey, (jiraSubject || "UAT Signoff") + "-revised"),
        });
      }
    } catch(e) { console.error(e); }
    finally { setFeedbackLoading(false); }
  };

  // ── Build context ─────────────────────────────────────────────────────────
  const buildContext = () => {
    const doms = AGENT_DOMAIN_ENTRIES.filter((d) => selectedDomains.includes(d.id));
    const scope = doms.map(d=>d.full).join(", ")||"All Services";
    let ctx = `UAT Scope: ${scope}\n\n`;

    if (discovery?.jiraFields) {
      const f = discovery.jiraFields;
      ctx += `JIRA ID: ${f.id || ""}\n`;
      ctx += `Feature: ${f.summary || ""}\n`;
      if (f.reporter) ctx += `Reporter: ${f.reporter}\n`;
      if (f.assignee) ctx += `Assignee: ${f.assignee}\n`;
      if (f.fixVersions) ctx += `Fix Version: ${f.fixVersions}\n`;
      if (f.labels) ctx += `Labels: ${f.labels}\n`;
      if (f.components) ctx += `Components: ${f.components}\n`;
      if (f.status) ctx += `Status: ${f.status}\n`;
      if (f.priority) ctx += `Priority: ${f.priority}\n`;
      ctx += "\n";
    }

    if (jiraMode==="type") {
      if (jiraSubject) ctx += `JIRA Subject: ${jiraSubject}\n`;
      if (jiraDesc) ctx += `JIRA Description:\n${jiraDesc}\n\n`;
    } else {
      jiraFC.forEach(f=>{ ctx+=`JIRA File [${f.name}]:\n${f.content}\n\n`; });
    }

    // Extracted attachment text
    if (discovery?.attachmentResults) {
      const extracted = discovery.attachmentResults.filter(a=>a.status==="ok");
      extracted.forEach(a=>{
        ctx += `\n--- Attachment: ${a.filename} ---\n${a.text}\n`;
      });
    }

    // Google Sheets test cases
    if (discovery?.testCasesFromSheets) {
      ctx += `\n--- Google Sheets Test Cases ---\n${discovery.testCasesFromSheets}\n`;
    }

    // Existing QA test cases from JIRA comments
    if (discovery?.existingQATestCases) {
      ctx += `\n--- QA / Dev Test Cases (from JIRA comments) ---\n${discovery.existingQATestCases}\n`;
    }

    // Gap answers
    if (gapMode==="type" && gapAnswers.trim()) {
      ctx += `\n--- Gap Answers / Additional Context ---\n${gapAnswers}\n`;
    } else {
      gapFC.forEach(f=>{ ctx+=`Gap Doc [${f.name}]:\n${f.content}\n\n`; });
    }

    // Legacy test cases input
    if (testMode==="type") { if(testCases) ctx+=`Additional Test Cases:\n${testCases}\n\n`; }
    else testFC.forEach(f=>{ ctx+=`Test Cases File [${f.name}]:\n${f.content}\n\n`; });

    if (docsMode==="type") { if(docsText) ctx+=`Supporting Context:\n${docsText}\n\n`; }
    else docsFC.forEach(f=>{ ctx+=`Supporting Doc [${f.name}]:\n${f.content}\n\n`; });

    return ctx;
  };

  const hasInput = () => {
    if (jiraMode==="type" && (jiraSubject||jiraDesc)) return true;
    if (jiraMode==="upload" && jiraFiles.length>0) return true;
    if (testMode==="type" && testCases) return true;
    if (testMode==="upload" && testFiles.length>0) return true;
    if (docsMode==="type" && docsText) return true;
    if (docsMode==="upload" && docsFiles.length>0) return true;
    if (discovery) return true;
    return false;
  };

  const resetAll = () => {
    setStep(0); setJiraSubject(""); setJiraDesc(""); setJiraFiles([]); setJiraFC([]);
    setTestCases(""); setTestFiles([]); setTestFC([]); setDocsText(""); setDocsFiles([]); setDocsFC([]);
    setSelectedDomains(["switch"]); setClarifyRaw(""); setDraftObjective(""); setEditedObjective("");
    setClarifyAnswers(""); setResult(null); setStatusMsg(""); setFeedbackText(""); setFeedbackFiles([]); setFeedbackFC([]);
    setJiraMode("type"); setTestMode("type"); setDocsMode("type"); setFeedbackMode("type");
    setJiraIssueKey(""); setJiraFetchError(""); setLastJiraPayload(null);
    setDiscovery(null); setDiscoveryLoading(false); setDiscoveryLog([]); setHasDiscovery(false);
    setGapAnswers(""); setGapMode("type"); setGapFiles([]); setGapFC([]);
    setDiscrepancyResult(null); setDiscrepancyLoading(false);
    setAllowAutoPublish(false);
    setLocalDriveCleanupFiles([]); setCleanupStatus(null); setCleanupConfirming(false);
  };

  const INPUT_MODES = [{id:"type",icon:"⌨️",label:"Type / Paste"},{id:"upload",icon:"📎",label:"Upload File"}];
  const inp = { width:"100%", background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, color:C.text, padding:"10px 14px", fontSize:12, outline:"none", boxSizing:"border-box", fontFamily:C.mono, resize:"vertical", transition:"border 0.2s, box-shadow 0.2s" };
  const lbl = { display:"block", fontSize:10, fontWeight:700, color:C.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:7, fontFamily:C.font };

  // ── Step 0: Input view ───────────────────────────────────────────────────
  const renderStep0 = () => (
    <div className="fade-in" role="presentation" onKeyDown={(e)=>{ if (e.key==="Enter" && e.target.tagName!=="TEXTAREA") e.preventDefault(); }}>
      {/* JIRA Connector — Primary Input */}
      <Card style={{ marginBottom:16, border:`1px solid #60a5fa44` }}>
        <SectionHeader icon="🔵" title="JIRA Connector" tag="Auto-Discovery" tagColor="#60a5fa"/>
        <div style={{ padding:18 }}>
          <p style={{ fontSize:12, color:C.muted, margin:"0 0 14px", fontFamily:C.font, lineHeight:1.6 }}>
            Enter a JIRA ticket ID to auto-fetch the ticket, extract attachments (BRD/PRD), find Google Drive test case sheets, and surface gap questions.
          </p>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center", marginBottom:10 }}>
            <input
              type="text"
              placeholder="e.g. TSP-4452 or TPAP-1234 or paste JIRA URL"
              value={jiraIssueKey}
              onChange={(e)=>setJiraIssueKey(e.target.value)}
              onBlur={()=>{ const k = parseJiraIssueKey(jiraIssueKey); if (k) syncPublishDefaultJiraKey(k); }}
              onKeyDown={(e)=>{ if (e.key==="Enter") { e.preventDefault(); handleFetchJiraUAT(); } }}
              style={{ flex:1, minWidth:240, ...inp }}
            />
            <button type="button" onClick={handleFetchJiraUAT} disabled={jiraFetchLoading} style={{ padding:"9px 16px", borderRadius:8, fontSize:12, fontWeight:600, cursor: jiraFetchLoading?"wait":"pointer", border:"none", background:"#0052CC", color:"#fff", minWidth:80 }}>
              {jiraFetchLoading ? <Spinner size={13}/> : "↓ Fetch"}
            </button>
          </div>
          {jiraFetchError && <div style={{ marginTop:8, fontSize:11, color:"#f87171", fontFamily:C.mono }}>{jiraFetchError}</div>}
          {lastJiraPayload && (
            <div style={{ marginTop:12, padding:14, background:C.surface, borderRadius:8 }}>
              <JiraConnectorFetchSummary data={lastJiraPayload} />
              {lastJiraPayload.acceptanceCriteria && (
                <div style={{ marginTop:10, fontSize:11, color:C.muted, fontFamily:C.mono }}>
                  {(() => { const ac = String(lastJiraPayload.acceptanceCriteria); return (<><strong style={{color:C.text}}>AC Preview:</strong> {ac.slice(0,200)}{ac.length>200?"…":""}</>); })()}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Domain Scope */}
      <Card style={{ marginBottom:16 }}>
        <SectionHeader icon="🎯" title="UAT Domain Scope" tag="Required" tagColor="#f87171"/>
        <div style={{ padding:18 }}>
          <AgentDomainMultiSelect
            label="Domains"
            value={selectedDomains}
            onChange={setSelectedDomains}
            domains={AGENT_DOMAIN_ENTRIES}
            colors={{ surface: C.surface, elevated: C.elevated, border: C.border, text: C.text, muted: C.muted, accent: C.gold }}
          />
        </div>
      </Card>

      {/* Manual JIRA Details — shown if no Jira key or want to override */}
      <Card style={{ marginBottom:16 }}>
        <SectionHeader icon="📝" title="Manual Input (override / no JIRA)" tag="Optional" tagColor={C.muted}/>
        <div style={{ padding:18 }}>
          <ModeTab modes={INPUT_MODES} active={jiraMode} onChange={setJiraMode}/>
          {jiraMode==="type" ? (
            <>
              <div style={{ marginBottom:12 }}>
                <label style={lbl}>Feature Name / JIRA Subject</label>
                <input style={{...inp, resize:"none"}} placeholder="e.g. TSP-3516 — Silent Mobile Verification (SMV)" value={jiraSubject} onChange={e=>setJiraSubject(e.target.value)}/>
              </div>
              <label style={lbl}>Description & Acceptance Criteria</label>
              <textarea style={{...inp, minHeight:90}} placeholder="Paste full description, acceptance criteria..." value={jiraDesc} onChange={e=>setJiraDesc(e.target.value)}/>
            </>
          ) : (
            <><input ref={jiraRef} type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.md,.csv" style={{display:"none"}} onChange={e=>addFiles(e.target.files,setJiraFiles,setJiraFC)}/>
            <Dropzone fileRef={jiraRef} onDrop={fl=>addFiles(fl,setJiraFiles,setJiraFC)} onBrowse={()=>jiraRef.current.click()} files={jiraFiles} onRemove={i=>removeFile(i,setJiraFiles,setJiraFC)} hint="JIRA export, Word doc, or ticket details file"/></>
          )}
        </div>
      </Card>

      {/* Additional Context */}
      <Card style={{ marginBottom:16 }}>
        <SectionHeader icon="🧪" title="Additional Test Cases & Context" tag="Optional" tagColor="#34d399"/>
        <div style={{ padding:18 }}>
          <ModeTab modes={INPUT_MODES} active={testMode} onChange={setTestMode}/>
          {testMode==="type" ? (
            <>
              <label style={lbl}>Test Cases / Results / Logs</label>
              <textarea style={{...inp, minHeight:90}} placeholder={"TC_001 | SMV Device Binding | PASS\nTC_002 | Invalid OTP | FAIL"} value={testCases} onChange={e=>setTestCases(e.target.value)}/>
            </>
          ) : (
            <><input ref={testRef} type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.md,.csv" style={{display:"none"}} onChange={e=>addFiles(e.target.files,setTestFiles,setTestFC)}/>
            <Dropzone fileRef={testRef} onDrop={fl=>addFiles(fl,setTestFiles,setTestFC)} onBrowse={()=>testRef.current.click()} files={testFiles} onRemove={i=>removeFile(i,setTestFiles,setTestFC)} hint="Excel test plan, CSV results, PDF test report"/></>
          )}
          <div style={{ marginTop:14 }}>
            <ModeTab modes={INPUT_MODES} active={docsMode} onChange={setDocsMode}/>
            {docsMode==="type" ? (
              <>
                <label style={lbl}>Supporting Docs / NPCI Comms</label>
                <textarea style={{...inp, minHeight:70}} placeholder="NPCI circular refs, release notes, known issues..." value={docsText} onChange={e=>setDocsText(e.target.value)}/>
              </>
            ) : (
              <><input ref={docsRef} type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.md,.csv" style={{display:"none"}} onChange={e=>addFiles(e.target.files,setDocsFiles,setDocsFC)}/>
              <Dropzone fileRef={docsRef} onDrop={fl=>addFiles(fl,setDocsFiles,setDocsFC)} onBrowse={()=>docsRef.current.click()} files={docsFiles} onRemove={i=>removeFile(i,setDocsFiles,setDocsFC)} hint="NPCI documents, compliance specs, SRS"/></>
            )}
          </div>
        </div>
      </Card>

      {/* Options */}
      <Card style={{ padding:"16px 20px", marginBottom:16 }}>
        <div style={{ display:"flex", gap:28, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font }}>Options</span>
          <Toggle on={webSearch} onChange={setWebSearch} icon="🌐" label="Enable Web Search (NPCI / RBI docs)"/>
        </div>
        <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${C.border}` }}>
          <div style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:10 }}>After generation, auto-publish to</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:16 }}>
            {["jira","telegram","email","slack"].map((ch) => (
              <label key={ch} style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:12, color:C.text }}>
                <input type="checkbox" checked={!!autoPublishChannels[ch]} onChange={(e)=>setAutoPublishChannels((p)=>({ ...p, [ch]: e.target.checked }))} />
                {ch==="jira"&&"JIRA"}{ch==="telegram"&&"Telegram"}{ch==="email"&&"Email"}{ch==="slack"&&"Slack"}
              </label>
            ))}
          </div>
        </div>
      </Card>

      {statusMsg && <div style={{ background:"#f59e0b18", border:"1px solid #f59e0b44", borderRadius:8, padding:"10px 16px", marginBottom:14, fontSize:12, color:C.gold, fontFamily:C.mono }}>{statusMsg}</div>}

      <div style={{ display:"flex", gap:12 }}>
        {lastJiraPayload ? (
          <Btn style={{ flex:1 }} size="lg" onClick={handleFetchAndDiscover} disabled={discoveryLoading}>
            {discoveryLoading ? <><Spinner/> &nbsp;Discovering...</> : "🔍 Discover & Continue →"}
          </Btn>
        ) : (
          <Btn style={{ flex:1 }} size="lg" onClick={handleProceedToClarify} disabled={loading}>
            {loading ? <><Spinner/> &nbsp;Analyzing...</> : "Next: Clarify →"}
          </Btn>
        )}
        <Btn variant="ghost" onClick={()=>{resetAll();setView("home");}}>Cancel</Btn>
      </div>
    </div>
  );

  // ── Step 1: Discovery view ───────────────────────────────────────────────
  const renderStep1 = () => (
    <div className="fade-in">
      <Card style={{ marginBottom:16, border:`1px solid #60a5fa44` }}>
        <SectionHeader icon="🔬" title="Jira Intelligence — Discovery Results" tag={discovery ? "Complete" : "Running"} tagColor={discovery ? "#34d399" : "#60a5fa"}/>
        <div style={{ padding:18 }}>
          {discoveryLoading && (
            <div style={{ marginBottom:16 }}>
              <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:10 }}>
                <Spinner/>
                <span style={{ fontSize:12, color:C.gold, fontFamily:C.mono }}>Running auto-discovery...</span>
              </div>
              <div style={{ background:C.surface, borderRadius:8, padding:12, maxHeight:160, overflow:"auto" }}>
                {discoveryLog.map((l,i)=>(
                  <div key={i} style={{ fontSize:11, color:C.muted, fontFamily:C.mono, marginBottom:3 }}>{l}</div>
                ))}
              </div>
            </div>
          )}

          {discovery && (
            <>
              {/* JIRA Fields Summary */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:10 }}>📋 JIRA Ticket Summary</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:8 }}>
                  {[
                    { k:"ID", v:discovery.jiraFields.id },
                    { k:"Reporter", v:discovery.jiraFields.reporter },
                    { k:"Assignee", v:discovery.jiraFields.assignee },
                    { k:"Fix Version", v:discovery.jiraFields.fixVersions || "—" },
                    { k:"Labels", v:discovery.jiraFields.labels || "—" },
                    { k:"Status", v:discovery.jiraFields.status },
                    { k:"Priority", v:discovery.jiraFields.priority },
                    { k:"Components", v:discovery.jiraFields.components || "—" },
                  ].map(({k,v})=>(
                    <div key={k} style={{ background:C.surface, borderRadius:7, padding:"8px 12px" }}>
                      <div style={{ fontSize:9, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font }}>{k}</div>
                      <div style={{ fontSize:12, color:C.text, fontFamily:C.mono, marginTop:2 }}>{v || "—"}</div>
                    </div>
                  ))}
                </div>
                {discovery.jiraFields.acceptanceCriteria && (
                  <div style={{ marginTop:10, background:`${C.gold}08`, border:`1px solid ${C.gold}22`, borderRadius:8, padding:12 }}>
                    <div style={{ fontSize:10, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:6 }}>Acceptance Criteria Found</div>
                    <div style={{ fontSize:11, color:C.subtle, fontFamily:C.mono, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{(() => { const ac = String(discovery.jiraFields.acceptanceCriteria); return ac.slice(0,600) + (ac.length>600?"…":""); })()}</div>
                  </div>
                )}
              </div>

              {/* Attachment Results */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:8 }}>📎 Attachments</div>
                {discovery.attachmentResults.length === 0 ? (
                  <div style={{ fontSize:11, color:C.muted, fontFamily:C.mono }}>No attachments found in JIRA ticket.</div>
                ) : (
                  discovery.attachmentResults.map((a,i)=>(
                    <DiscoveryRow key={i}
                      icon={/pdf/i.test(a.filename)?"📄":/docx/i.test(a.filename)?"📝":"📎"}
                      label={a.filename}
                      status={a.status}
                      detail={a.status==="ok" ? `${a.chars.toLocaleString()} characters extracted` : a.status==="skip" ? "Not a document file — skipped" : a.error || ""}
                    />
                  ))
                )}
              </div>

              {/* Drive Link Results */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:8 }}>🔗 Google Drive / Sheets Links</div>
                {discovery.driveResults.length === 0 ? (
                  <div style={{ fontSize:11, color:C.muted, fontFamily:C.mono }}>No Google Drive links found in JIRA ticket.</div>
                ) : (
                  discovery.driveResults.map((d,i)=>(
                    <DiscoveryRow key={i}
                      icon={d.type==="sheet"?"📊":"📄"}
                      label={d.url.slice(0, 60) + (d.url.length > 60 ? "…" : "")}
                      status={d.status}
                      detail={d.status==="ok" ? `${(d.chars||0).toLocaleString()} characters fetched` : d.error || ""}
                    />
                  ))
                )}
              </div>

              {/* QA Test Cases from Comments */}
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:8 }}>💬 QA Test Cases (from JIRA Comments)</div>
                {discovery.existingQATestCases ? (
                  <div style={{ background:C.surface, borderRadius:8, padding:12, fontSize:11, color:C.muted, fontFamily:C.mono, maxHeight:120, overflow:"auto", lineHeight:1.6 }}>
                    {discovery.existingQATestCases.slice(0, 500)}{discovery.existingQATestCases.length>500?"…":""}
                  </div>
                ) : (
                  <div style={{ fontSize:11, color:"#fbbf24", fontFamily:C.mono }}>⚠️ No QA test cases found in JIRA comments.</div>
                )}
              </div>

              {/* Detected Gaps */}
              {discovery.gapsDetected.length > 0 && (
                <div style={{ background:"#f59e0b10", border:"1px solid #f59e0b33", borderRadius:8, padding:14, marginBottom:16 }}>
                  <div style={{ fontSize:11, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:8 }}>❓ Detected Gaps — Please Address Below</div>
                  {discovery.gapsDetected.map((g,i)=>(
                    <div key={i} style={{ display:"flex", gap:8, fontSize:11, color:C.subtle, fontFamily:C.mono, marginBottom:4 }}>
                      <span style={{ color:"#fbbf24" }}>▸</span> {g}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Gap Fill */}
      <Card style={{ marginBottom:16 }}>
        <SectionHeader icon="💬" title="Gap Answers & Additional Context" tag="Fill Missing Info" tagColor="#a78bfa"/>
        <div style={{ padding:18 }}>
          <p style={{ fontSize:12, color:C.muted, margin:"0 0 14px", fontFamily:C.font, lineHeight:1.7 }}>
            Provide any missing info: environment details, test results, QA test case IDs, Wiki links, or paste Google Sheet content if login was required.
          </p>
          <ModeTab modes={INPUT_MODES} active={gapMode} onChange={setGapMode}/>
          {gapMode==="type" ? (
            <>
              <label style={lbl}>Gap Answers / Context / Wiki URL / Pasted Sheet</label>
              <textarea style={{...inp, minHeight:120}} placeholder={"TC_001 PASS - Login flow verified\nTC_002 FAIL - OTP timeout bug #204\nEnvironment: UAT-1 | Build: v2.4.1\nhttps://wiki.internal/page/feature-spec"} value={gapAnswers} onChange={e=>setGapAnswers(e.target.value)}/>
            </>
          ) : (
            <><input ref={gapRef} type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.md,.csv" style={{display:"none"}} onChange={e=>addFiles(e.target.files,setGapFiles,setGapFC)}/>
            <Dropzone fileRef={gapRef} onDrop={fl=>addFiles(fl,setGapFiles,setGapFC)} onBrowse={()=>gapRef.current.click()} files={gapFiles} onRemove={i=>removeFile(i,setGapFiles,setGapFC)} hint="Test results, QA sheet export, Wiki export, BRD/PRD doc"/></>
          )}
        </div>
      </Card>

      <div style={{ display:"flex", gap:12 }}>
        <Btn style={{ flex:1 }} size="lg" onClick={handleProceedToClarify} disabled={loading || discoveryLoading}>
          {loading ? <><Spinner/> &nbsp;Analyzing...</> : "Next: Clarify & Set Objective →"}
        </Btn>
        <Btn variant="ghost" onClick={()=>setStep(0)}>← Back</Btn>
      </div>
    </div>
  );

  // ── Step 2 (or 1 if no discovery): Clarify + Objective ───────────────────
  const renderStepClarify = () => (
    <div className="fade-in">
      <Card style={{ marginBottom:16, border:`1px solid ${C.gold}44` }}>
        <SectionHeader icon="🎯" title="Objective" tag="Review & Edit" tagColor={C.gold}/>
        <div style={{ padding:18 }}>
          <p style={{ fontSize:12, color:C.muted, margin:"0 0 12px", fontFamily:C.font, lineHeight:1.7 }}>
            TestSentinel drafted the objective below. <strong style={{color:C.text}}>Edit freely</strong> — this defines scope for the signoff.
          </p>
          <textarea style={{...inp, minHeight:110, border:`1px solid ${C.gold}44`}} value={editedObjective} onChange={e=>setEditedObjective(e.target.value)} placeholder="Objective will appear here..."/>
          <div style={{ marginTop:8 }}>
            <Btn variant="outline" size="sm" onClick={()=>setEditedObjective(draftObjective)}>↺ Reset to Draft</Btn>
          </div>
        </div>
      </Card>

      {clarifyRaw && (() => {
        const qMatch = clarifyRaw.match(/QUESTIONS:\s*([\s\S]*)/i);
        const qs = qMatch ? qMatch[1].trim() : "";
        return qs ? (
          <Card style={{ marginBottom:16 }}>
            <SectionHeader icon="💬" title="Clarifying Questions" tag="Optional" tagColor="#94a3b8"/>
            <div style={{ padding:18 }}>
              <div style={{ background:C.surface, borderRadius:8, padding:16, marginBottom:14, fontSize:12, color:C.subtle, lineHeight:2, whiteSpace:"pre-wrap", fontFamily:C.mono, borderLeft:`3px solid ${C.gold}` }}>{qs}</div>
              <label style={lbl}>Your Answers (leave blank to skip)</label>
              <textarea style={{...inp, minHeight:90}} placeholder="Answer any questions to improve signoff quality..." value={clarifyAnswers} onChange={e=>setClarifyAnswers(e.target.value)}/>
            </div>
          </Card>
        ) : null;
      })()}

      <div style={{ display:"flex", gap:12 }}>
        <Btn style={{ flex:1 }} size="lg" onClick={handleProceedToReview}>
          Next: Review & Generate →
        </Btn>
        <Btn variant="ghost" onClick={()=>setStep(hasDiscovery ? 1 : 0)}>← Back</Btn>
      </div>
    </div>
  );

  // ── Step 3 (or 2): Review before generating ───────────────────────────────
  const renderStepReview = () => (
    <div className="fade-in">
      <Card style={{ marginBottom:16 }}>
        <SectionHeader icon="📋" title="Review Before Generating" tag="Final Check" tagColor={C.gold}/>
        <div style={{ padding:18 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:16 }}>
            {[
              { label:"Domains", value: AGENT_DOMAIN_ENTRIES.filter((d) => selectedDomains.includes(d.id)).map((d) => `${d.icon} ${d.label}`).join(", ")||"—" },
              { label:"JIRA", value: jiraSubject||(jiraFiles[0]?.name)||"From uploaded file" },
              { label:"Attachments Extracted", value: discovery ? `${discovery.attachmentResults.filter(a=>a.status==="ok").length} docs` : "—" },
              { label:"Drive Test Cases", value: discovery?.testCasesFromSheets ? "Found" : "—" },
              { label:"QA Comments", value: discovery?.existingQATestCases ? "Found" : "—" },
              { label:"Gap Answers", value: gapAnswers ? "Provided" : gapFiles.length > 0 ? `${gapFiles.length} file(s)` : "—" },
            ].map((r,i)=>(
              <div key={i} style={{ background:C.surface, borderRadius:8, padding:"12px 14px", border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font }}>{r.label}</div>
                <div style={{ fontSize:12, color:C.text, marginTop:5, fontFamily:C.mono, lineHeight:1.5 }}>{r.value}</div>
              </div>
            ))}
          </div>
          <div style={{ background:`${C.gold}08`, borderRadius:8, padding:"12px 16px", border:`1px solid ${C.gold}22` }}>
            <div style={{ fontSize:10, color:C.gold, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:C.font, marginBottom:6 }}>Confirmed Objective</div>
            <div style={{ fontSize:12, color:C.subtle, fontFamily:C.mono, lineHeight:1.7 }}>{editedObjective||"(No objective set)"}</div>
          </div>
        </div>
      </Card>

      {statusMsg && <div style={{ background:"#f59e0b18", border:"1px solid #f59e0b44", borderRadius:8, padding:"10px 16px", marginBottom:14, fontSize:12, color:C.gold, fontFamily:C.mono }}>{statusMsg}</div>}

      <div style={{ display:"flex", gap:12 }}>
        <Btn style={{ flex:1 }} size="lg" onClick={handleGenerate} disabled={loading}>
          {loading ? <><Spinner/> &nbsp;Generating Signoff...</> : "🚀 Generate UAT Signoff"}
        </Btn>
        <Btn variant="ghost" onClick={()=>setStep(hasDiscovery ? 2 : 1)}>← Back</Btn>
      </div>
    </div>
  );

  // ── Compute current logical step for StepBar ──────────────────────────────
  const getStepBarStep = () => {
    if (!hasDiscovery) {
      // No discovery: steps are 0=Input, 1=Clarify, 2=Review, 3=Signoff
      if (step === 0) return 0;
      if (step === 1) return 1; // clarify
      if (step === 2) return 2; // review
      if (step >= 3) return 3; // result
    } else {
      // With discovery: steps are 0=Input, 1=Discovery, 2=Clarify, 3=Review, 4=Signoff
      return step;
    }
    return step;
  };

  // ── Result view ────────────────────────────────────────────────────────────
  const ResultView = () => (
    <div className="fade-in">
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:22 }}>✅</span>
            <h2 style={{ margin:0, color:C.text, fontFamily:C.font, fontWeight:800, fontSize:"1.2em" }}>UAT Signoff Ready</h2>
            <Tag color="#34d399">Ref #{result?.id}</Tag>
          </div>
          <p style={{ margin:"4px 0 0", color:C.muted, fontSize:11, fontFamily:C.mono }}>{new Date().toLocaleString()}</p>
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <Btn variant="ghost" size="sm" onClick={()=>{navigator.clipboard.writeText(result?.signoff||"");setCopied(true);setTimeout(()=>setCopied(false),2000);}}>
            {copied?"✅ Copied":"📋 Copy Signoff"}
          </Btn>
          <Btn variant="outline" size="sm" onClick={()=>{resetAll();setView("new");}}>+ New Session</Btn>
        </div>
      </div>

      {/* Signoff document */}
      <Card style={{ padding:28, marginBottom:20 }}>
        {result?.signoff && <MarkdownRenderer content={result.signoff}/>}
      </Card>

      {/* Discrepancy Analysis */}
      <Card style={{ marginBottom:20, border:`1px solid #f87171${discrepancyResult?"88":"22"}` }}>
        <SectionHeader icon="🔍" title="Discrepancy Validation" tag={discrepancyResult ? "Analyzed" : "On Demand"} tagColor={discrepancyResult ? "#f87171" : C.muted}/>
        <div style={{ padding:18 }}>
          {!discrepancyResult ? (
            <>
              <p style={{ fontSize:12, color:C.muted, margin:"0 0 14px", fontFamily:C.font, lineHeight:1.7 }}>
                Compare UAT acceptance criteria against QA/Dev test cases from JIRA comments and Google Sheets. Raises discrepancy if any AC item is not covered.
              </p>
              <Btn variant="teal" onClick={handleDiscrepancyAnalysis} disabled={discrepancyLoading}>
                {discrepancyLoading ? <><Spinner/> &nbsp;Analyzing...</> : "🔍 Run Discrepancy Analysis"}
              </Btn>
            </>
          ) : (
            <>
              <div style={{ marginBottom:14 }}>
                <MarkdownRenderer content={discrepancyResult}/>
              </div>
              <Btn variant="ghost" size="sm" onClick={()=>setDiscrepancyResult(null)}>↺ Re-run Analysis</Btn>
            </>
          )}
        </div>
      </Card>

      {result?.signoff && (
        <ShareAndScore
          docType="uat"
          title={jiraSubject || "UAT Signoff"}
          jiraKey={parseJiraIssueKey(jiraIssueKey) || parseJiraIssueKey(jiraSubject) || ""}
          content={result.signoff}
          autoPublish={allowAutoPublish ? Object.keys(autoPublishChannels).filter((k) => autoPublishChannels[k]) : []}
        />
      )}

      {/* Local Drive cleanup */}
      {localDriveCleanupFiles.length > 0 && cleanupStatus === null && (
        <Card style={{ marginBottom:20, border:`1px solid #f59e0b66`, background:"#1a1200" }}>
          <div style={{ padding:"14px 18px" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#f59e0b", marginBottom:8 }}>🗂 Local Drive Files Used</div>
            {localDriveCleanupFiles.map((f,i) => (
              <div key={i} style={{ fontSize:11, color:"#fcd34d", fontFamily:"monospace", marginBottom:4 }}>📄 {f.name}</div>
            ))}
            {!cleanupConfirming ? (
              <div style={{ marginTop:12 }}>
                <p style={{ fontSize:11, color:"#d97706", margin:"0 0 10px", lineHeight:1.5 }}>
                  UAT complete. Delete {localDriveCleanupFiles.length === 1 ? "this file" : "these files"} from Google Drive?
                </p>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn size="sm" variant="ghost" style={{ borderColor:"#ef444466", color:"#ef4444" }}
                    onClick={() => setCleanupConfirming(true)}>
                    🗑 Yes, Delete
                  </Btn>
                  <Btn size="sm" variant="ghost" onClick={() => setCleanupStatus("kept")}>Keep it</Btn>
                </div>
              </div>
            ) : (
              <div style={{ marginTop:12, padding:"10px 14px", background:"#300", border:"1px solid #ef444466", borderRadius:8 }}>
                <p style={{ fontSize:12, fontWeight:700, color:"#ef4444", margin:"0 0 8px" }}>
                  ⚠️ Confirm permanent delete from Google Drive:
                </p>
                {localDriveCleanupFiles.map((f,i) => (
                  <div key={i} style={{ fontSize:11, color:"#fca5a5", fontFamily:"monospace", marginBottom:3 }}>
                    {f.path}
                  </div>
                ))}
                <p style={{ fontSize:11, color:"#fca5a5", margin:"8px 0 10px" }}>This cannot be undone.</p>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn size="sm" style={{ background:"#ef4444", color:"#fff", border:"none" }}
                    onClick={async () => {
                      try {
                        const r = await fetch(`${API_BASE}/api/local-drive-cleanup`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ files: localDriveCleanupFiles.map(f => f.path) }),
                        });
                        const d = await r.json().catch(() => ({}));
                        if (d.deleted?.length > 0) setCleanupStatus("deleted");
                        else setCleanupStatus("error");
                      } catch (e) {
                        setCleanupStatus("error");
                      }
                      setCleanupConfirming(false);
                    }}>
                    Confirm Delete
                  </Btn>
                  <Btn size="sm" variant="ghost" onClick={() => setCleanupConfirming(false)}>Cancel</Btn>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}
      {cleanupStatus === "deleted" && (
        <div style={{ marginBottom:16, padding:"10px 16px", background:"#052e16", border:"1px solid #16a34a55", borderRadius:9, fontSize:12, color:"#4ade80" }}>
          ✅ Local Drive file deleted successfully.
        </div>
      )}
      {cleanupStatus === "kept" && (
        <div style={{ marginBottom:16, padding:"10px 16px", background:"#0f172a", border:"1px solid #334155", borderRadius:9, fontSize:12, color:"#94a3b8" }}>
          📁 File kept in Google Drive.
        </div>
      )}
      {cleanupStatus === "error" && (
        <div style={{ marginBottom:16, padding:"10px 16px", background:"#300", border:"1px solid #ef444455", borderRadius:9, fontSize:12, color:"#fca5a5" }}>
          ❌ Delete failed — remove file manually from Google Drive.
        </div>
      )}

      {/* Feedback Section */}
      <Card style={{ marginBottom:20, border:`1px solid #a78bfa44` }}>
        <SectionHeader icon="💬" title="Improve This Signoff" tag="Feedback" tagColor="#a78bfa"/>
        <div style={{ padding:18 }}>
          <p style={{ fontSize:12, color:C.muted, margin:"0 0 14px", fontFamily:C.font, lineHeight:1.7 }}>
            Not satisfied? Provide feedback as text, upload an annotated file, or provide a Google Doc/Wiki link. TestSentinel will regenerate an improved version.
          </p>
          <ModeTab modes={INPUT_MODES} active={feedbackMode} onChange={setFeedbackMode}/>
          {feedbackMode==="type" ? (
            <>
              <label style={lbl}>Your Feedback / Additional Context URL</label>
              <textarea style={{...inp, minHeight:100}} placeholder={"e.g. 'TC_005 result should be FAIL — see bug #204. Add more fund-loss risk detail.'\nOr paste: https://wiki.internal/page/..."} value={feedbackText} onChange={e=>setFeedbackText(e.target.value)}/>
            </>
          ) : (
            <><input ref={fbRef} type="file" multiple accept=".pdf,.docx,.xlsx,.txt,.md,.csv" style={{display:"none"}} onChange={e=>addFiles(e.target.files,setFeedbackFiles,setFeedbackFC)}/>
            <Dropzone fileRef={fbRef} onDrop={fl=>addFiles(fl,setFeedbackFiles,setFeedbackFC)} onBrowse={()=>fbRef.current.click()} files={feedbackFiles} onRemove={i=>removeFile(i,setFeedbackFiles,setFeedbackFC)} hint="Annotated DOCX, PDF review comments, updated test results"/></>
          )}
          {feedbackMemory.length > 0 && (
            <div style={{ marginTop:12, padding:"10px 14px", background:"#052E16", border:"1px solid #16A34A22", borderRadius:9 }}>
              <div style={{ fontSize:11, color:"#16A34A", fontWeight:600, marginBottom:6 }}>🧠 REMEMBERED FEEDBACK ({feedbackMemory.length})</div>
              {feedbackMemory.map((f,i) => <div key={i} style={{ fontSize:11, color:"#4ADE80", marginBottom:2 }}>• {f.slice(0,120)}{f.length>120?"…":""}</div>)}
              <button type="button" onClick={()=>setFeedbackMemory([])} style={{ marginTop:6, background:"none", border:"1px solid #EF444433", borderRadius:7, padding:"3px 10px", color:"#EF4444", fontSize:10, cursor:"pointer" }}>Clear memory</button>
            </div>
          )}
          <div style={{ marginTop:14 }}>
            <Btn onClick={handleFeedback} disabled={feedbackLoading||(!feedbackText.trim()&&feedbackFiles.length===0)}>
              {feedbackLoading?<><Spinner/> &nbsp;Regenerating...</>:"🔄 Regenerate with Feedback"}
            </Btn>
          </div>
        </div>
      </Card>

      <div style={{ display:"flex", gap:12 }}>
        <Btn variant="ghost" onClick={()=>setView("history")}>📚 View History</Btn>
        <Btn variant="ghost" onClick={()=>setView("home")}>🏠 Home</Btn>
      </div>
    </div>
  );

  const renderNewSession = () => {
    const clarifyStep = hasDiscovery ? 2 : 1;
    const reviewStep = hasDiscovery ? 3 : 2;
    const resultStep = hasDiscovery ? 4 : 3;
    return (
      <div className="fade-in">
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24, flexWrap:"wrap", gap:12 }}>
          <div>
            <h2 style={{ margin:0, color:C.text, fontFamily:C.font, fontWeight:800, fontSize:"1.3em" }}>New UAT Session</h2>
            <p style={{ margin:"3px 0 0", color:C.muted, fontSize:11, fontFamily:C.mono }}>
              {lastJiraPayload ? "JIRA → Discover → Clarify → Generate" : "Fill inputs → Clarify → Generate Signoff"}
            </p>
          </div>
          <ModelPicker selected={model} onChange={setModel}/>
        </div>
        <StepBar step={getStepBarStep()} hasDiscovery={hasDiscovery}/>
        {step===0 && renderStep0()}
        {step===1 && hasDiscovery && renderStep1()}
        {step===clarifyStep && !result && renderStepClarify()}
        {step===reviewStep && !result && renderStepReview()}
      </div>
    );
  };

  // ── Home View ──────────────────────────────────────────────────────────────
  const HomeView = () => (
    <div className="fade-in">
      <div style={{ textAlign:"center", padding:"52px 0 40px", position:"relative" }}>
        <div style={{ fontSize:52, marginBottom:16, filter:"drop-shadow(0 0 24px #e8b84b44)" }}>🛡️</div>
        <h1 style={{ fontFamily:C.font, fontWeight:800, fontSize:"2.4em", margin:"0 0 8px", letterSpacing:"-0.03em", background:`linear-gradient(135deg, ${C.gold} 30%, #f8fafc)`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
          TestSentinel
        </h1>
        <p style={{ color:C.muted, fontSize:13, margin:"0 0 8px", fontFamily:C.mono }}>
          UAT Signoff Agent · JIRA Auto-Discovery · Attachment Extraction · Discrepancy Analysis
        </p>
        <p style={{ color:"#334155", fontSize:11, margin:"0 0 32px", fontFamily:C.mono }}>
          Enter JIRA ID → auto-fetch ticket + attachments + Google Sheets → generate UAT
        </p>
        <Btn size="lg" onClick={()=>{resetAll();setView("new");}}>
          ⚡ Start New UAT Session
        </Btn>
        {feedbackMemory.length > 0 && (
          <div style={{ marginTop:16, display:"inline-flex", alignItems:"center", gap:8, background:"#052E16", border:"1px solid #16A34A22", borderRadius:9, padding:"8px 14px" }}>
            <span style={{ fontSize:11, color:"#4ADE80", fontWeight:600 }}>🧠 {feedbackMemory.length} feedback item{feedbackMemory.length>1?"s":""} remembered</span>
            <button type="button" onClick={()=>setFeedbackMemory([])} style={{ background:"none", border:"1px solid #EF444433", borderRadius:6, padding:"2px 8px", color:"#EF4444", fontSize:10, cursor:"pointer" }}>Clear</button>
          </div>
        )}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginBottom:24 }}>
        {[
          { icon:"📋", label:"Sessions", value: getHistory().length||"—", sub:"total performed" },
          { icon:"📅", label:"Last 30 Days", value: getHistory().filter(h=>new Date(h.ts)>new Date(Date.now()-30*86400000)).length||"—", sub:"UATs completed" },
          { icon:"✅", label:"Quick Action", value:"New UAT", sub:"click to start", action:()=>{resetAll();setView("new");} },
        ].map((s,i)=>(
          <Card key={i} className="hover-lift" style={{ padding:20, textAlign:"center", cursor:s.action?"pointer":"default", transition:"all 0.2s", marginBottom:0 }} onClick={s.action}>
            <div style={{ fontSize:24, marginBottom:8 }}>{s.icon}</div>
            <div style={{ fontFamily:C.font, fontWeight:800, fontSize:"1.6em", color:C.gold, marginBottom:2 }}>{s.value}</div>
            <div style={{ fontSize:11, color:C.text, fontWeight:600, fontFamily:C.font }}>{s.label}</div>
            <div style={{ fontSize:10, color:C.muted, marginTop:2, fontFamily:C.mono }}>{s.sub}</div>
          </Card>
        ))}
      </div>

      {/* New capabilities highlight */}
      <Card style={{ marginBottom:18 }}>
        <SectionHeader icon="⚡" title="What's New — Enhanced UAT Flow" tagColor={C.gold}/>
        <div style={{ padding:18, display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(220px, 1fr))", gap:12 }}>
          {[
            { icon:"🔵", title:"JIRA Auto-Discovery", desc:"Fetch ticket + all fields (AC, fix version, labels, reporter, assignee)" },
            { icon:"📎", title:"Attachment Extraction", desc:"PDF/DOCX BRDs & PRDs auto-extracted from JIRA attachments" },
            { icon:"📊", title:"Google Drive Fetch", desc:"Test case sheets auto-read from Drive links in ticket body" },
            { icon:"❓", title:"Gap Analysis", desc:"Auto-detect missing data and surface targeted gap questions" },
            { icon:"🔍", title:"Discrepancy Analysis", desc:"Compare UAT scenarios vs QA test cases — raise coverage gaps" },
            { icon:"🔄", title:"Feedback Loop", desc:"Regenerate with feedback; memory persists improvements across sessions" },
          ].map((f,i)=>(
            <div key={i} style={{ background:C.surface, borderRadius:9, padding:14, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:18, marginBottom:6 }}>{f.icon}</div>
              <div style={{ fontWeight:700, color:C.text, fontSize:12, fontFamily:C.font }}>{f.title}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:4, fontFamily:C.mono, lineHeight:1.5 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ marginBottom:18 }}>
        <SectionHeader icon="🎯" title="Supported UAT Domains" />
        <div style={{ padding:18, display:"flex", flexWrap:"wrap", gap:8 }}>
          {AGENT_DOMAIN_ENTRIES.map((d) => (
            <div key={d.id} style={{ display:"flex", alignItems:"center", gap:6, background:`${d.color}12`, border:`1px solid ${d.color}22`, borderRadius:7, padding:"6px 12px" }}>
              <span>{d.icon}</span>
              <span style={{ fontSize:11, color:d.color, fontWeight:700, fontFamily:C.font }}>{d.label}</span>
              <span style={{ fontSize:10, color:C.muted, fontFamily:C.mono }}>{d.full}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );

  // ── History view ────────────────────────────────────────────────────────────
  const HistoryView = () => {
    const hist = getHistory();
    const now = Date.now();
    const groups = {
      "Today": hist.filter(h=>now-new Date(h.ts)<86400000),
      "This Week": hist.filter(h=>{ const d=now-new Date(h.ts); return d>=86400000&&d<7*86400000; }),
      "This Month": hist.filter(h=>{ const d=now-new Date(h.ts); return d>=7*86400000&&d<30*86400000; }),
    };
    return (
      <div className="fade-in">
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
          <div>
            <h2 style={{ margin:0, color:C.text, fontFamily:C.font, fontWeight:800 }}>UAT History</h2>
            <p style={{ margin:"3px 0 0", color:C.muted, fontSize:11, fontFamily:C.mono }}>Last 30 days · {hist.length} session{hist.length!==1?"s":""}</p>
          </div>
          <Btn onClick={()=>{resetAll();setView("new");}}>+ New Session</Btn>
        </div>
        {hist.length===0 ? (
          <Card style={{ textAlign:"center", padding:56 }}>
            <div style={{ fontSize:36, marginBottom:12 }}>📭</div>
            <div style={{ color:C.muted, fontSize:13, fontFamily:C.font }}>No UAT sessions yet.</div>
          </Card>
        ) : (
          Object.entries(groups).map(([groupName, items])=>
            items.length>0 ? (
              <div key={groupName} style={{ marginBottom:24 }}>
                <div style={{ fontSize:10, color:C.muted, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:C.font, marginBottom:10, paddingLeft:4 }}>{groupName}</div>
                {items.map(h=>(
                  <Card key={h.id} className="hover-lift" style={{ marginBottom:10, cursor:"pointer", transition:"all 0.2s" }}
                    onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.gold; }}
                    onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; }}
                    onClick={()=>{
                      if (!h.signoff || !String(h.signoff).trim()) return;
                      setAllowAutoPublish(false);
                      setJiraSubject(typeof h.jira === "string" ? h.jira : "");
                      if (h.jiraKey) setJiraIssueKey(String(h.jiraKey));
                      setEditedObjective(h.objective || "");
                      if (Array.isArray(h.selectedDomainIds) && h.selectedDomainIds.length) {
                        setSelectedDomains(sanitizeDomainIds(h.selectedDomainIds));
                      } else {
                        setSelectedDomains(domainIdsFromLabels(h.domains));
                      }
                      const resultStep = 3; // always show at result step in history
                      setStep(resultStep);
                      setResult({ signoff: h.signoff, id: h.id, domains: h.domains || [] });
                      setView("result");
                    }}
                  >
                    <div style={{ padding:"14px 18px", display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:12 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:700, color:C.text, marginBottom:8, fontSize:13, fontFamily:C.font }}>
                          #{h.id} — {h.jira}
                        </div>
                        <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
                          <Tag color={C.muted}>{h.model}</Tag>
                          {h.domains?.map((d) => {
                            const dom = AGENT_DOMAIN_ENTRIES.find((x) => x.label === d);
                            return <Tag key={d} color={dom?.color || C.muted}>{dom?.icon} {d}</Tag>;
                          })}
                        </div>
                        {h.objective && <div style={{ marginTop:8, fontSize:11, color:C.muted, fontFamily:C.mono, lineHeight:1.5 }}>Objective: {h.objective.slice(0,120)}{h.objective.length>120?"...":""}</div>}
                      </div>
                      <div style={{ color:C.muted, fontSize:10, flexShrink:0, fontFamily:C.mono, textAlign:"right" }}>
                        {new Date(h.ts).toLocaleDateString()}<br/>
                        {new Date(h.ts).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            ) : null
          )
        )}
      </div>
    );
  };

  // ── Layout ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background:C.bg, minHeight:"100vh", color:C.text }}>
      <nav style={{ background:C.surface, borderBottom:`1px solid ${C.border}`, padding:"13px 28px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, position:"sticky", top:0, zIndex:100, backdropFilter:"blur(10px)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, cursor:"pointer" }} onClick={()=>setView("home")}>
          <div style={{ width:34, height:34, background:`linear-gradient(135deg, ${C.gold}, #f0cc6a)`, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center", fontSize:17, flexShrink:0, boxShadow:`0 0 14px ${C.gold}44` }}>🛡️</div>
          <div>
            <div style={{ fontWeight:800, fontSize:15, color:C.text, letterSpacing:"-0.03em", fontFamily:C.font }}>TestSentinel</div>
            <div style={{ fontSize:9, color:C.muted, letterSpacing:"0.1em", textTransform:"uppercase", fontFamily:C.mono }}>UAT Signoff · Auto-Discovery</div>
          </div>
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {[
            { id:"home", label:"Home" },
            { id:"new", label:"New Session" },
            { id:"history", label:`History${getHistory().length?` (${getHistory().length})`:""}`},
          ].map(tab=>(
            <button type="button" key={tab.id} onClick={()=>{ if(tab.id==="new"){resetAll();} setView(tab.id); }} style={{
              background: view===tab.id?`${C.gold}22`:"transparent",
              color: view===tab.id?C.gold:C.muted,
              border: view===tab.id?`1px solid ${C.gold}44`:"1px solid transparent",
              borderRadius:7, padding:"6px 14px", cursor:"pointer",
              fontSize:12, fontWeight:view===tab.id?700:500, fontFamily:C.font, transition:"all 0.15s"
            }}>{tab.label}</button>
          ))}
        </div>
        <ModelPicker selected={model} onChange={setModel}/>
      </nav>

      <main style={{ maxWidth:960, margin:"0 auto", padding:"28px 20px" }}>
        {view==="home" && <HomeView/>}
        {view==="new" && renderNewSession()}
        {view==="result" && result && <ResultView/>}
        {view==="history" && <HistoryView/>}
      </main>

      <footer style={{ borderTop:`1px solid ${C.border}`, padding:"14px 28px", textAlign:"center", fontSize:10, color:"#334155", fontFamily:C.mono }}>
        TestSentinel · JIRA Auto-Discovery · Attachment Extraction · Discrepancy Analysis · <span style={{color:C.gold}}>Powered by Anthropic</span>
      </footer>
    </div>
  );
}
