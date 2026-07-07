/**
 * MCP server: prd-agent-tools
 * Exposes all 6 agents as Claude tools callable from Claude Desktop / CLI.
 * Requires backend running on localhost:5000 and Analyst on localhost:3040.
 *
 * Tools:
 *   generate_prd       — PRD Agent
 *   generate_uat       — UAT Agent (TestSentinel)
 *   generate_brd       — BRD Agent
 *   alpha_chat         — Alpha Agent (UPI intelligence)
 *   analyst_query      — Analyst Agent (SQL / data queries via Trino)
 *   jira_get_issue     — Fetch a Jira issue by ID
 *   jira_create_issue  — Create a new Jira issue
 *   jira_create_with_subtasks — Create Jira issue + subtasks in one shot
 *   score_document     — Score a PRD/UAT/BRD document for quality
 *   share_to_slack     — Post document to Slack
 *   share_to_jira      — Add document as Jira comment
 *   share_via_email    — Send document via email
 *   export_docx        — Convert markdown to .docx and save locally
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import net from "node:net";

const BACKEND  = process.env.PRD_AGENT_BACKEND_URL?.trim()  || "http://localhost:5000";
const ANALYST  = process.env.PRD_AGENT_ANALYST_URL?.trim()  || "http://localhost:3040";
const LLM_PROVIDER = process.env.PRD_AGENT_LLM_PROVIDER?.trim() || "auto";

// ── helpers ──────────────────────────────────────────────────────────────────

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(1500);
    s.on("connect", () => done(true));
    s.on("error",   () => done(false));
    s.on("timeout", () => done(false));
  });
}

function ok(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ── system prompts (same as frontend agents) ──────────────────────────────────

const PRD_SYSTEM = `You are a senior product manager and technical architect specializing in UPI payment systems, NPCI regulations, and fintech infrastructure. You generate detailed, technically accurate PRD sections for UPI Switch features.
CRITICAL RULES:
- Return ONLY a valid JSON object — no markdown fences, no preamble, no explanation
- Keep each field value under 1200 characters to avoid truncation
- Use plain text with newlines (\\n) inside JSON strings — never actual line breaks inside a JSON string value
- Be concise but technically precise`;

const BRD_SYSTEM = `You are a senior BRD specialist for UPI/payment switch systems at a major Indian fintech. Generate a comprehensive, production-grade BRD in the following exact 24-section format. Use markdown with ## for section headers. Use markdown tables (| col | col |) for structured data. Be exhaustive — engineering teams must be able to implement from this BRD without further clarification.

SECTIONS TO INCLUDE:
## 1. Document Metadata
Table: Feature Name, Domain, Date, Version, Author, Status, JIRA ID

## 2. Executive Summary
3-4 sentences: what it does, why needed, what changes in system.

## 3. Regulatory / Compliance Reference
Table: Reference | Description | Circular ID | Deadline

## 4. Problem Statement
Bullet list of current problems.

## 5. Objective
Bullet list of goals.

## 6. Scope
In Scope bullets. Out of Scope bullets.

## 7. Terminology
Table: Term | Meaning

## 8. System Architecture Overview
Components involved, their roles.

## 9. Transaction Lifecycle
Numbered step-by-step flow.

## 10. Current Flow (AS-IS)
Describe current behavior with flow arrows.

## 11. Proposed Flow (TO-BE)
New behavior with step-by-step validation logic.

## 12. Business Rules
Table: Rule ID | Rule Description

## 13. API Behaviour
Table: API Name | Current Behaviour | New Behaviour | Parameters Affected

## 14. Error Code Mapping
Table: Scenario | Error Code | Source | Message

## 15. Edge Case Handling
Table: Scenario | Current Behaviour | Expected Behaviour

## 16. Reconciliation Impact
Whether debit/credit/settlement/recon entries occur.

## 17. Risk Assessment
Table: Risk | Likelihood | Impact | Mitigation

## 18. Monitoring & Metrics
Metrics to track. Alerts to configure.

## 19. Configuration Management
Table: Config Key | Purpose | Default Value | Type

## 20. UAT Test Scenarios
Table: Test ID | Scenario | Input | Expected Output

## 21. Rollout Strategy
Phased rollout plan.

## 22. Rollback Plan
How to revert if issues arise.

## 23. Success Metrics
Measurable success criteria.

## 24. Failure Scenario Matrix
Table: Failure Point | System Behaviour | Customer Impact | Recovery Action

Be thorough. Tables should have 4-8 rows minimum. This BRD will be reviewed by NPCI compliance teams.`;

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

Rules: never invent counts; use markdown tables only; start with "# UAT Status".`;

// ── server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "prd-agent-tools",
  version: "1.0.0",
});

// ── PRD Agent ─────────────────────────────────────────────────────────────────

server.tool(
  "generate_prd",
  `PRD Agent — generates a Product Requirements Document for UPI/fintech features.
Calls the backend at ${BACKEND}/api/generate using the PRD system prompt.
Returns a structured JSON with sections: problem, objective, scope, current_arch, proposed_arch, timeout, additional, fund_loss, rollout, backward, references, uat, npci_musts, appendix.
The backend enriches context with RAG docs from the /docs folder.`,
  {
    requirement: z.string().min(20).describe("Full feature requirement — what needs to be built and why. Include domain context (Switch/TPAP/NPCI etc.)"),
    sections: z.array(z.enum(["problem","objective","scope","current_arch","proposed_arch","timeout","additional","fund_loss","rollout","backward","references","uat","npci_musts","appendix"])).optional().describe("Specific sections to generate. Omit to generate all."),
    llmProvider: z.enum(["auto","aws","openai","foundry"]).optional().describe("LLM provider override. Default: auto"),
  },
  async ({ requirement, sections, llmProvider }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running. Start it: npm run start:backend in prd-agent/");

    const allSections = sections || ["problem","objective","scope","current_arch","proposed_arch","timeout","additional","fund_loss","rollout","backward","references","uat","npci_musts","appendix"];
    const fields = allSections.map(k => `"${k}": "..."`).join(",\n  ");
    const userPrompt = `Generate ONLY these PRD sections:\n\nREQUIREMENT:\n${requirement}\n\nReturn JSON with exactly:\n{\n  ${fields}\n}\n\nUse \\n for line breaks. Keep each value under 3000 chars. Be thorough — do NOT truncate. Return ONLY the JSON object.`;

    const { status, data } = await post(`${BACKEND}/api/generate`, {
      messages: [{ role: "user", content: userPrompt }],
      system: PRD_SYSTEM,
      agent: "prd",
      llmProvider: llmProvider || LLM_PROVIDER,
      max_tokens: 8000,
    });

    if (status !== 200) return err(`Backend error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── UAT Agent ─────────────────────────────────────────────────────────────────

server.tool(
  "generate_uat",
  `UAT Agent (TestSentinel) — generates a UAT Signoff document for fintech/UPI features.
Accepts PRD text or feature description plus test cases. Returns structured markdown UAT document.`,
  {
    featureName: z.string().describe("Name of the feature being tested"),
    jiraId: z.string().optional().describe("Jira ticket ID e.g. UPI-1234"),
    prdOrDescription: z.string().min(20).describe("PRD content or feature description to test against"),
    testCases: z.string().optional().describe("List of test cases / test results in any format"),
    objective: z.string().optional().describe("UAT objective — if omitted, auto-derived"),
    scope: z.array(z.string()).optional().describe("Domain scope list e.g. ['UPI Switch', 'NPCI', 'TPAP']"),
    llmProvider: z.enum(["auto","aws","openai","foundry"]).optional(),
  },
  async ({ featureName, jiraId, prdOrDescription, testCases, objective, scope, llmProvider }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running. Start it: npm run start:backend in prd-agent/");

    const scopeList = scope?.join(", ") || "UPI Switch, NPCI, TPAP, PSP";
    const userPrompt = [
      `Feature Name: ${featureName}`,
      jiraId ? `JIRA ID: ${jiraId}` : "",
      objective ? `Objective: ${objective}` : "",
      `Domain Scope: ${scopeList}`,
      `\n--- FEATURE / PRD CONTEXT ---\n${prdOrDescription}`,
      testCases ? `\n--- TEST CASES / RESULTS ---\n${testCases}` : "",
    ].filter(Boolean).join("\n");

    const { status, data } = await post(`${BACKEND}/api/generate`, {
      messages: [{ role: "user", content: userPrompt }],
      system: UAT_SYSTEM,
      agent: "uat",
      llmProvider: llmProvider || LLM_PROVIDER,
      max_tokens: 8000,
    });

    if (status !== 200) return err(`Backend error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── BRD Agent ─────────────────────────────────────────────────────────────────

server.tool(
  "generate_brd",
  `BRD Agent — generates a comprehensive 24-section Business Requirements Document for UPI/payment features.
Returns full markdown BRD suitable for NPCI compliance review.`,
  {
    requirement: z.string().min(20).describe("Full feature requirement with domain context"),
    jiraId: z.string().optional().describe("Jira ticket ID"),
    author: z.string().optional().describe("Document author name"),
    llmProvider: z.enum(["auto","aws","openai","foundry"]).optional(),
  },
  async ({ requirement, jiraId, author, llmProvider }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running. Start it: npm run start:backend in prd-agent/");

    const userPrompt = [
      `Generate a complete BRD for this requirement:`,
      `\n${requirement}`,
      jiraId ? `\nJIRA ID: ${jiraId}` : "",
      author ? `\nAuthor: ${author}` : "",
    ].filter(Boolean).join("\n");

    const { status, data } = await post(`${BACKEND}/api/generate`, {
      messages: [{ role: "user", content: userPrompt }],
      system: BRD_SYSTEM,
      agent: "brd",
      llmProvider: llmProvider || LLM_PROVIDER,
      max_tokens: 8000,
    });

    if (status !== 200) return err(`Backend error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── Alpha Agent ───────────────────────────────────────────────────────────────

server.tool(
  "alpha_chat",
  `Alpha Agent — UPI Intelligence assistant with access to the UPI Alpha knowledge base.
Covers: 282 feature teardowns, 66 competitor app profiles, 279+ SQL query references, live schema.
Use for UPI strategy questions, competitor analysis, product gaps, Paytm-specific insights.`,
  {
    message: z.string().min(3).describe("Your question or message to Alpha Agent"),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
    })).optional().describe("Conversation history for multi-turn chat"),
    llmProvider: z.enum(["auto","aws","openai","foundry"]).optional(),
  },
  async ({ message, history, llmProvider }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running. Start it: npm run start:backend in prd-agent/");

    const { status, data } = await post(`${BACKEND}/api/alpha/chat`, {
      message,
      history: history || [],
      llmProvider: llmProvider || LLM_PROVIDER,
    });

    if (status !== 200) return err(`Alpha Agent error ${status}: ${JSON.stringify(data)}`);
    if (!data.success) return err(`Alpha Agent failed: ${data.error}`);

    return ok({
      reply: data.reply,
      filesUsed: data.filesUsed || [],
      llmProvider: data.llmProvider,
      ms: data.ms,
    });
  }
);

// ── Analyst Agent ─────────────────────────────────────────────────────────────

server.tool(
  "analyst_query",
  `Analyst Agent — natural language to SQL query pipeline backed by Trino.
Converts your question to a query plan then to SQL, executes on Trino, returns results.
Use for data analysis, metrics lookups, UPI transaction queries.`,
  {
    prompt: z.string().min(5).describe("Natural language question about data, e.g. 'Show me UPI success rate by bank for last 7 days'"),
    llmProvider: z.enum(["auto","aws","openai","foundry"]).optional(),
    history: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      prompt: z.string(),
    })).optional().describe("Prior conversation turns for follow-up questions"),
  },
  async ({ prompt, llmProvider, history }) => {
    const up = await portOpen(3040);
    if (!up) return err("Analyst Agent not running. Start it: npm run dev:analyst in prd-agent/");

    const { status, data } = await post(`${ANALYST}/api/generate`, {
      prompt,
      llmProvider: llmProvider || LLM_PROVIDER,
      history: history || [],
      agent: "analyst",
    });

    if (status !== 200) return err(`Analyst error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── JIRA Tools ────────────────────────────────────────────────────────────────

server.tool(
  "jira_get_issue",
  "Fetch a Jira issue by ID. Returns summary, description, status, assignee, comments, attachments, and linked sub-tasks.",
  {
    issueId: z.string().describe("Jira issue ID e.g. UPI-1234 or PAYTM-5678"),
    jiraSite: z.string().optional().describe("Jira base URL override e.g. https://company.atlassian.net"),
  },
  async ({ issueId, jiraSite }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const url = jiraSite
      ? `${BACKEND}/api/jira-issue/${encodeURIComponent(issueId)}?jiraUrl=${encodeURIComponent(jiraSite)}`
      : `${BACKEND}/api/jira-issue/${encodeURIComponent(issueId)}`;

    const { status, data } = await get(url);
    if (status !== 200) return err(`Jira fetch error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

server.tool(
  "jira_create_issue",
  "Create a new Jira issue (Story, Task, Bug, Epic, Sub-task, etc.).",
  {
    projectKey: z.string().describe("Jira project key e.g. UPI, PAYTM, SWITCH"),
    summary: z.string().describe("Issue title / summary"),
    description: z.string().optional().describe("Issue description in markdown or ADF"),
    issueType: z.string().optional().default("Story").describe("Issue type: Story, Task, Bug, Epic, Sub-task"),
    priority: z.string().optional().describe("Priority: Highest, High, Medium, Low, Lowest"),
    assignee: z.string().optional().describe("Assignee email or account ID"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
    epicLink: z.string().optional().describe("Epic issue key to link to"),
    jiraSite: z.string().optional().describe("Jira base URL override"),
  },
  async ({ projectKey, summary, description, issueType, priority, assignee, labels, epicLink, jiraSite }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/jira/create`, {
      projectKey,
      summary,
      description,
      issueType: issueType || "Story",
      priority,
      assignee,
      labels,
      epicLink,
      jiraSite,
    });

    if (status !== 200 && status !== 201) return err(`Jira create error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

server.tool(
  "jira_create_with_subtasks",
  "Create a Jira parent issue with multiple sub-tasks in one shot. Useful for creating Epic + Stories or Story + Sub-tasks.",
  {
    projectKey: z.string().describe("Jira project key"),
    parentSummary: z.string().describe("Parent issue title"),
    parentDescription: z.string().optional().describe("Parent issue description"),
    parentIssueType: z.string().optional().default("Story").describe("Parent issue type"),
    subtasks: z.array(z.object({
      summary: z.string(),
      description: z.string().optional(),
      assignee: z.string().optional(),
    })).describe("List of sub-tasks to create under the parent"),
    jiraSite: z.string().optional(),
  },
  async ({ projectKey, parentSummary, parentDescription, parentIssueType, subtasks, jiraSite }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/jira/create-with-subtasks`, {
      projectKey,
      parent: {
        summary: parentSummary,
        description: parentDescription,
        issueType: parentIssueType || "Story",
      },
      subtasks,
      jiraSite,
    });

    if (status !== 200 && status !== 201) return err(`Jira error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── Score Document ────────────────────────────────────────────────────────────

server.tool(
  "score_document",
  "Score a PRD, UAT, or BRD document for quality. Returns a score (0-100) and per-section feedback.",
  {
    document: z.string().min(100).describe("The document content to score (markdown or plain text)"),
    agentType: z.enum(["prd","uat","brd"]).describe("Type of document being scored"),
    title: z.string().optional().describe("Document title for context"),
  },
  async ({ document, agentType, title }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/score`, {
      prd: document,
      agentType,
      title,
    });

    if (status !== 200) return err(`Score error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── Share Tools ───────────────────────────────────────────────────────────────

server.tool(
  "share_to_slack",
  "Post a document (PRD/UAT/BRD) to a Slack channel via the configured Slack webhook.",
  {
    content: z.string().describe("Document content in markdown"),
    title: z.string().describe("Document title shown in Slack"),
    agentType: z.enum(["prd","uat","brd","alpha"]).optional().describe("Agent type for formatting"),
  },
  async ({ content, title, agentType }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/share/slack`, {
      markdown: content,
      title,
      agentType,
    });

    if (status !== 200) return err(`Slack share error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

server.tool(
  "share_to_jira",
  "Add document content as a comment on an existing Jira issue.",
  {
    issueId: z.string().describe("Jira issue ID to comment on"),
    content: z.string().describe("Document content in markdown"),
    jiraSite: z.string().optional().describe("Jira base URL override"),
  },
  async ({ issueId, content, jiraSite }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/share/jira`, {
      issueId,
      markdown: content,
      jiraUrl: jiraSite,
    });

    if (status !== 200) return err(`Jira share error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

server.tool(
  "share_via_email",
  "Send a document via email using the configured SMTP settings.",
  {
    to: z.string().email().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    content: z.string().describe("Document content in markdown — will be converted to HTML email"),
  },
  async ({ to, subject, content }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/share/email`, {
      to,
      subject,
      markdown: content,
    });

    if (status !== 200) return err(`Email error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── Export DOCX ───────────────────────────────────────────────────────────────

server.tool(
  "export_docx",
  "Convert a markdown document (PRD/UAT/BRD) to a .docx file. Returns the file path where it was saved on the server.",
  {
    content: z.string().describe("Markdown content to convert"),
    filename: z.string().optional().describe("Output filename without extension e.g. 'prd-upi-feature'"),
  },
  async ({ content, filename }) => {
    const up = await portOpen(5000);
    if (!up) return err("Backend not running.");

    const { status, data } = await post(`${BACKEND}/api/export-docx`, {
      markdown: content,
      filename: filename || `export-${Date.now()}`,
    });

    if (status !== 200) return err(`Export error ${status}: ${JSON.stringify(data)}`);
    return ok(data);
  }
);

// ── Health check ──────────────────────────────────────────────────────────────

server.tool(
  "check_agents_health",
  "Check whether the backend (port 5000) and Analyst Agent (port 3040) are running.",
  {},
  async () => {
    const [backend, analyst] = await Promise.all([portOpen(5000), portOpen(3040)]);
    return ok({
      backend:  { url: BACKEND,  port: 5000, running: backend },
      analyst:  { url: ANALYST,  port: 3040, running: analyst },
      llmProvider: LLM_PROVIDER,
      tip: backend ? null : "Run: npm run dev  (or: npm run start:backend) from prd-agent/",
    });
  }
);

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
