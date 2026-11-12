// Skills — Utilities-tab front ends for the Claude skills (prd-generator, brd-generator,
// uat-generator, fetch-umn). Generation reuses the backend's own /api/jira-issue and
// /api/generate routes over loopback, so Jira site routing (TSP on JIRA_URL, TPAP on
// JIRA_URL_2) and LLM provider fallback behave exactly like the PRD / BRD / UAT tabs.
//
// Routes (all under /api/utils/skills):
//   POST /run   { skill: prd|brd|uat, jira, notes, brdMode: small|full } → generated markdown
//                                                                         (saved to History)
//   POST /umn   { umns: [..] } → mandate + participants + last txns per UMN (not saved)

import { runRedashWithEnv } from "./trinoClient.js";

const LOOPBACK = () => `http://127.0.0.1:${Number(process.env.PORT) || 5000}`;

// ─── Prompts (same section layouts as prd-agent-tools / the skills) ──────────

const PRD_SECTIONS = [
  "Problem Statement",
  "Objective",
  "Scope (In / Out)",
  "Current Architecture",
  "Proposed Architecture",
  "Timeout & Retry Handling",
  "Additional Requirements",
  "Fund Loss Risk & Mitigation",
  "Rollout Plan",
  "Backward Compatibility",
  "References",
  "UAT Scenarios",
  "NPCI Must-haves",
  "Appendix",
];

const PRD_SYSTEM = `You are a senior product manager and technical architect specializing in UPI payment systems, NPCI regulations, and fintech infrastructure. You write detailed, technically accurate PRDs for UPI Switch / TPAP features.
Output markdown only (no preamble). Start with "# PRD: <feature name>", then a metadata table (Feature, JIRA ID, Domain, Status, Date), then these sections as "## N. <title>" in order:
${PRD_SECTIONS.map((s, i) => `${i + 1}. ${s}`).join("\n")}
Use markdown tables for structured data. Be technically precise; flag assumptions explicitly under the Appendix.`;

const BRD_FULL = `## 1. Document Metadata — table: Feature Name, Domain, Date, Version, Author, Status, JIRA ID
## 2. Executive Summary — 3-4 sentences
## 3. Regulatory / Compliance Reference — table: Reference | Description | Circular ID | Deadline
## 4. Problem Statement
## 5. Objective
## 6. Scope — In Scope / Out of Scope
## 7. Terminology — table: Term | Meaning
## 8. System Architecture Overview
## 9. Transaction Lifecycle — numbered flow
## 10. Current Flow (AS-IS)
## 11. Proposed Flow (TO-BE)
## 12. Business Rules — table: Rule ID | Rule Description
## 13. API Behaviour — table: API Name | Current Behaviour | New Behaviour | Parameters Affected
## 14. Error Code Mapping — table: Scenario | Error Code | Source | Message
## 15. Edge Case Handling — table: Scenario | Current Behaviour | Expected Behaviour
## 16. Reconciliation Impact
## 17. Risk Assessment — table: Risk | Likelihood | Impact | Mitigation
## 18. Monitoring & Metrics
## 19. Configuration Management — table: Config Key | Purpose | Default Value | Type
## 20. UAT Test Scenarios — table: Test ID | Scenario | Input | Expected Output
## 21. Rollout Strategy
## 22. Rollback Plan
## 23. Success Metrics
## 24. Failure Scenario Matrix — table: Failure Point | System Behaviour | Customer Impact | Recovery Action
Tables should have 4-8 rows minimum. This BRD will be reviewed by NPCI compliance teams.`;

const BRD_SMALL = `## 1. Document Metadata — table: Feature Name, Domain, Date, Author, Status, JIRA ID
## 2. Executive Summary — 3-4 sentences
## 3. Problem Statement & Objective
## 4. Scope — In Scope / Out of Scope
## 5. Proposed Flow (TO-BE) — numbered steps
## 6. Business Rules — table: Rule ID | Rule Description
## 7. Error Code Mapping — table: Scenario | Error Code | Message
## 8. Risk Assessment — table: Risk | Impact | Mitigation
## 9. UAT Test Scenarios — table: Test ID | Scenario | Expected Output
## 10. Rollout & Rollback
Keep it compact: 3-5 rows per table, no filler.`;

const brdSystem = (mode) => `You are a senior BRD specialist for UPI/payment switch systems at a major Indian fintech. Generate a ${mode === "small" ? "compact" : "comprehensive, production-grade"} BRD in markdown with exactly these sections (## headers, markdown tables):

${mode === "small" ? BRD_SMALL : BRD_FULL}

Output markdown only, starting with "# BRD: <feature name>".`;

const UAT_SYSTEM = `You are TestSentinel — an expert UAT Signoff Agent for fintech, UPI, and payment systems.

Generate a professional UAT Signoff with these sections in order:
## 1. Introduction — table with: Feature Name, JIRA ID, UAT Scope
## 2. Objective — 2-3 sentences describing what was validated
## 3+4. Scope Definition — Scope table (In Scope / Out of Scope), Test Execution Summary table, counts summary
## 5. UAT Acceptance Criteria — table: UAT Scenario | QA Test Case ID | Result | Remarks
## 6. Defect / Gap Summary — severity counts table, gap details table
## 7. Risk Assessment — table: Risk Area | Impact | Status
## 8. Production Readiness Checklist — table with ✅ ⚠️ ❌
## 9. UAT Final Decision — state ONLY: ✅ PASS, ⚠️ PASS WITH CONDITIONS, or ❌ FAIL, then justification

Rules: never invent counts — if test results are not in the input, mark them "Pending" and say so; use markdown tables only; start with "# UAT Status".`;

export const SKILLS = {
  prd: { label: "PRD Generator", maxTokens: 10000 },
  brd: { label: "BRD Generator", maxTokens: 12000 },
  uat: { label: "UAT Generator", maxTokens: 8000 },
};

// ─── Loopback helpers ────────────────────────────────────────────────────────

async function loopJson(path, init) {
  const res = await fetch(`${LOOPBACK()}${path}`, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok || data.success === false) throw new Error(data.message || (typeof data.error === "string" ? data.error : data.error?.message) || `HTTP ${res.status}`);
  return data;
}

/** Jira key / browse URL → issue (TSP → finmate, TPAP → mypaytm; URL host wins). */
const fetchJira = (jira) => loopJson(`/api/jira-issue/${encodeURIComponent(jira)}`);

async function attachmentTexts(issue, { max = 3, chars = 8000 } = {}) {
  const items = (issue.attachmentItems || []).filter((a) => /\.(pdf|docx|xlsx?|txt|csv|md)$/i.test(a.filename)).slice(0, max);
  const out = [];
  for (const a of items) {
    try {
      const d = await loopJson(`/api/jira-attachment-text?url=${encodeURIComponent(a.url)}&filename=${encodeURIComponent(a.filename)}`);
      if (d.text) out.push(`### Attachment: ${a.filename}\n${d.text.slice(0, chars)}`);
    } catch {
      /* unreadable attachment — skip */
    }
  }
  return out;
}

function issueContext(issue) {
  const rows = [
    ["JIRA ID", issue.id],
    ["Site", issue.jiraBaseUrl],
    ["Summary", issue.summary],
    ["Status", issue.status],
    ["Priority", issue.priority],
    ["Assignee / Dev / QA", [issue.assignee, issue.devAssignee, issue.qaAssignee].filter(Boolean).join(" / ")],
    ["Reporter", issue.reporter],
    ["Labels", issue.labels],
    ["Components", issue.components],
    ["Fix versions", issue.fixVersions],
    ["Fund-loss risk", issue.fundlossRisk],
  ].filter(([, v]) => v && !String(v).startsWith("[object"));
  return [
    rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
    issue.description && `\n--- DESCRIPTION ---\n${issue.description.slice(0, 15000)}`,
    issue.requirement && `\n--- REQUIREMENT ---\n${issue.requirement.slice(0, 6000)}`,
    issue.acceptanceCriteria && `\n--- ACCEPTANCE CRITERIA ---\n${issue.acceptanceCriteria.slice(0, 6000)}`,
    issue.comments && `\n--- RECENT COMMENTS ---\n${issue.comments.slice(0, 6000)}`,
    issue.qaTestCaseSheetUrls?.length && `\n--- QA TEST CASE SHEETS ---\n${issue.qaTestCaseSheetUrls.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(skill, { issue, notes, brdMode, attachments }) {
  const ctx = issue ? issueContext(issue) : "";
  const extra = notes ? `\n--- NOTES FROM USER (take priority over the ticket) ---\n${notes}` : "";
  const att = attachments?.length ? `\n--- ATTACHMENTS ---\n${attachments.join("\n\n")}` : "";
  if (skill === "prd") return { system: PRD_SYSTEM, user: `Write the PRD for this feature.\n\n${ctx}${extra}` };
  if (skill === "brd") return { system: brdSystem(brdMode), user: `Generate a ${brdMode === "small" ? "compact" : "complete"} BRD for this requirement.\n\n${ctx}${extra}` };
  return { system: UAT_SYSTEM, user: `Generate the UAT signoff for this ticket.\n\n${ctx}${att}${extra}` };
}

const textFromLlm = (data) => {
  const payload = data.data ?? data;
  const blocks = payload?.content;
  if (!Array.isArray(blocks)) throw new Error("Unexpected LLM response shape");
  return blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
};

// ─── UMN lookup (Switch DB on the PTYBL Redash) ──────────────────────────────

const UMN_URL_VAR = "MDASH_REDASH_URL";
const UMN_KEY_VAR = "MDASH_REDASH_API_KEY";
// switchv2_C1 holds standing_instructions today; the other clusters are checked for misses.
const UMN_DS_IDS = String(process.env.UMN_REDASH_DATA_SOURCE_IDS || "22,21,19,14")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter(Boolean);
// UMNs are spliced into SQL literals — hash@handle only, no quotes.
const UMN_RE = /^[A-Za-z0-9._-]{4,80}@[A-Za-z0-9.]{2,32}$/;
const MAX_UMNS = 25;

const RESP_CODES = { "00": "Success", U30: "Beneficiary bank offline", U16: "Risk threshold / limit exceeded", U69: "Request timed out", U91: "Bank not reachable", ZM: "Invalid MPIN", Z9: "System exception", BT: "Transaction blocked" };

const inList = (umns) => umns.map((u) => `'${u}'`).join(", ");
const UMN_SQL = {
  mandate: (umns) => `SELECT
  si.umn, si.mandate_status, si.revocable,
  si.created_on AS mandate_created_on, si.updated_on AS mandate_updated_on,
  payer.vpa AS payer_vpa, payer.name AS payer_name, payer.handle AS payer_handle, payer.bank_code AS payer_bank_code,
  payee.vpa AS payee_vpa, payee.name AS payee_name, payee.handle AS payee_handle, payee.bank_code AS payee_bank_code, payee.mcc AS payee_mcc,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastSuccessDebitDate'))   AS last_success_debit_date,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastSuccessDebitAmount')) AS last_success_debit_amount,
  JSON_UNQUOTE(JSON_EXTRACT(si.extended_info, '$.lastExecutionRespCode'))  AS last_execution_resp_code
FROM standing_instructions si
LEFT JOIN standing_instructions_participants payer ON payer.txn_id = si.txn_id AND payer.participant_type = 'PAYER'
LEFT JOIN standing_instructions_participants payee ON payee.txn_id = si.txn_id AND payee.participant_type = 'PAYEE'
WHERE si.umn IN (${inList(umns)})`,
  txns: (umns) => `SELECT umn, txn_id, rrn, category, type, amount, status, npci_resp_code, app_resp_code, npci_ts, updated_on
FROM txn_info WHERE umn IN (${inList(umns)})
ORDER BY updated_on DESC LIMIT ${10 * umns.length}`,
};

const nullish = (v) => v == null || v === "" || v === "null";

async function lookupUmns(umns, signal) {
  const run = (ds, sql) => runRedashWithEnv(UMN_URL_VAR, UMN_KEY_VAR, ds, sql, { signal, timeoutMs: 120000 });
  const found = new Map(); // umn → { ds, mandate }
  let pending = [...umns];
  for (const ds of UMN_DS_IDS) {
    if (!pending.length) break;
    const rows = await run(ds, UMN_SQL.mandate(pending));
    for (const r of rows) if (!found.has(r.umn)) found.set(r.umn, { ds, mandate: r });
    pending = pending.filter((u) => !found.has(u));
  }
  // Txn history from each cluster that owns at least one mandate.
  const byDs = new Map();
  for (const [umn, { ds }] of found) byDs.set(ds, [...(byDs.get(ds) || []), umn]);
  const txns = new Map();
  await Promise.all(
    [...byDs].map(async ([ds, list]) => {
      for (const t of await run(ds, UMN_SQL.txns(list))) {
        const arr = txns.get(t.umn) || [];
        if (arr.length < 10) arr.push(t);
        txns.set(t.umn, arr);
      }
    })
  );
  return umns.map((umn) => {
    const hit = found.get(umn);
    if (!hit) return { umn, found: false };
    const m = hit.mandate;
    const notes = [];
    if (nullish(m.mandate_status)) notes.push("mandate_status is NULL — data integrity issue");
    if (nullish(m.last_success_debit_date) && nullish(m.last_success_debit_amount)) notes.push("No successful execution recorded");
    for (const k of Object.keys(m)) if (m[k] === "null") m[k] = null;
    return {
      umn,
      found: true,
      dataSourceId: hit.ds,
      mandate: m,
      lastExecutionRespLabel: RESP_CODES[m.last_execution_resp_code] || null,
      txns: (txns.get(umn) || []).map((t) => ({ ...t, npci_resp_label: RESP_CODES[t.npci_resp_code] || null })),
      notes,
    };
  });
}

/** Connector-Settings LLM routing from the browser (same fields the PRD / BRD / UAT tabs send). */
function llmRouting(llm) {
  const src = llm && typeof llm === "object" ? llm : {};
  const out = { llmProvider: String(src.llmProvider || "auto").toLowerCase() };
  for (const k of ["llmDisabled", "foundryModelsEnabled"]) if (src[k] && typeof src[k] === "object") out[k] = src[k];
  for (const k of ["bedrockModelTier", "openaiModel"]) if (typeof src[k] === "string" && src[k].trim()) out[k] = src[k].trim();
  return out;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export function registerSkills(app, { history }) {
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  /** Generate one PRD / BRD / UAT; every run (success or failure) lands in History. */
  async function runSkill({ skill, jira, notes, brdMode, llm }, trigger = "manual") {
    const def = SKILLS[skill];
    if (!def) throw new Error("Unknown skill — use prd, brd or uat");
    jira = String(jira || "").trim();
    notes = String(notes || "").trim().slice(0, 20000);
    brdMode = brdMode === "small" ? "small" : "full";
    llm = llmRouting(llm);
    if (!jira && !notes) throw new Error("Enter a Jira ID / URL or some notes");

    const label = `${def.label}${skill === "brd" ? ` (${brdMode})` : ""}`;
    const id = history.start(
      {
        dashboard: "skills",
        section: skill,
        sectionTitle: label,
        subject: `${label} · ${jira || "notes only"}`,
        taskName: `${label} for ${jira || "notes"}`,
        trigger,
        durationLabel: jira || "notes only",
        engine: "llm",
        rerun: { skill, jira, notes, brdMode, llm },
      },
      "running"
    );
    const startedAt = Date.now();
    try {
      const issue = jira ? await fetchJira(jira) : null;
      const attachments = skill === "uat" && issue ? await attachmentTexts(issue) : [];
      const { system, user } = buildPrompt(skill, { issue, notes, brdMode, attachments });
      const gen = await loopJson("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: user }], system, agent: skill, max_tokens: def.maxTokens, ...llm }),
      });
      const markdown = textFromLlm(gen);
      if (!markdown) throw new Error("LLM returned empty output");
      const subject = `${label} · ${issue ? `${issue.id} — ${issue.summary}` : "notes only"}`;
      history.update(id, {
        event: "success",
        subject,
        elapsedMs: Date.now() - startedAt,
        engine: `${gen.llmProvider || "llm"}${gen.llmModel ? ` · ${gen.llmModel}` : ""}`,
        jira: issue ? { id: issue.id, summary: issue.summary, site: issue.jiraBaseUrl, status: issue.status } : null,
        notes: notes || null,
        output: markdown,
        analysis: {
          summary: `${label} generated for ${issue ? `${issue.id} (${issue.summary})` : "notes"} — ${markdown.length.toLocaleString("en-IN")} chars.`,
          actions: ["Review the draft, then publish from the PRD / BRD / UAT tab or copy it."],
        },
      });
      return { id, subject, markdown, jira: issue && { id: issue.id, summary: issue.summary, site: issue.jiraBaseUrl, status: issue.status }, llmProvider: gen.llmProvider, ms: Date.now() - startedAt, attachmentsRead: attachments.length };
    } catch (err) {
      history.update(id, { event: "failed", error: err.message, elapsedMs: Date.now() - startedAt });
      throw err;
    }
  }

  app.post("/api/utils/skills/run", handle((req) => runSkill(req.body || {})));

  app.post(
    "/api/utils/skills/umn",
    handle(async (req, res) => {
      const raw = Array.isArray(req.body?.umns) ? req.body.umns : String(req.body?.umns || "").split(/[\s,;]+/);
      const umns = [...new Set(raw.map((u) => String(u).trim()).filter(Boolean))];
      if (!umns.length) throw new Error("Enter at least one UMN");
      if (umns.length > MAX_UMNS) throw new Error(`Up to ${MAX_UMNS} UMNs per lookup`);
      const bad = umns.filter((u) => !UMN_RE.test(u));
      if (bad.length) throw new Error(`Not a valid UMN (expected <hash>@<handle>): ${bad.slice(0, 3).join(", ")}`);
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const startedAt = Date.now();
      const results = await lookupUmns(umns, controller.signal);
      return { results, ms: Date.now() - startedAt, sql: [UMN_SQL.mandate(umns), UMN_SQL.txns(umns)].join(";\n\n") };
    })
  );

  /** History re-run hook — runs in the background; the new record shows up in the list. */
  return {
    rerun: (rec) => {
      runSkill(rec.rerun || {}, "manual").catch(() => {});
      return { started: rec.sectionTitle || "skill run" };
    },
  };
}
