import express from "express";
import { createServer as _netCreateServer } from "net";
import { spawn as _spawnProc } from "child_process";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import https from "https";
import fs from "fs";
import path from "path";
import os from "os";
import * as XLSX from "xlsx";
import { fileURLToPath } from "url";
import multer from "multer";
import mammoth from "mammoth";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import { extractTextFromPDF, extractTextFromPDFBuffer } from "./pdfParser.js";
import FormData from "form-data";
import { retrieve as ragRetrieve } from "./rag/retrieve.js";
import { buildDocsKnowledgeContext } from "./docsKnowledge.js";
import {
  converseBedrock,
  isBedrockConfigured,
  runBedrockReadinessProbe,
  rerunBedrockReadinessProbe,
  bedrockHealth,
  resolveBedrockModelId,
} from "./bedrockClient.js";
import { recordAgentDayUsage, getDailySummary } from "./llmUsageStore.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  markdownToEmailHtml,
  markdownToJiraAdf,
  markdownToSlackPayload,
  markdownToTelegramChunks,
} from "./shareMarkdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from backend/ or repo root (for cloud, env vars are often set by platform)
dotenv.config({ path: path.join(__dirname, ".env"), quiet: true });
dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const PORT = Number(process.env.PORT) || 5000;
const NODE_ENV = process.env.NODE_ENV || "development";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PRD_OUTPUT_DIR = path.join(__dirname, "prd-output");
const AGENT_EXPORT_DIR = path.join(__dirname, "agent-exports");
const SECTION_TITLES = {
  problem: "Problem Statement",
  objective: "Objective",
  scope: "Scope of Work",
  current_arch: "Current Architecture",
  proposed_arch: "Proposed Architecture",
  timeout: "Timeout / Idempotency / Retry",
  additional: "Additional Requirements",
  fund_loss: "Fund Loss & Monitoring",
  rollout: "Rollout Plan",
  backward: "Backward Compatibility",
  references: "Reference Documents",
  uat: "UAT Acceptance Cases",
  npci_musts: "NPCI-Mandated MUSTs",
  appendix: "Appendix (Ops / Compliance)",
};
const SECTION_ORDER = [
  "problem", "objective", "scope", "current_arch", "proposed_arch",
  "timeout", "additional", "fund_loss", "rollout", "backward",
  "references", "uat", "npci_musts", "appendix",
];

// Optional: load reference PDF if present (do not block server start)
let pdfText = "";
try {
  const pdfPath = path.join(__dirname, "..", "docs", "International_Inward_Remittance_TSD.pdf");
  if (fs.existsSync(pdfPath)) {
    pdfText = await extractTextFromPDF(pdfPath);
    console.log("[PDF] Loaded reference doc, length:", pdfText.length);
  }
} catch (err) {
  console.warn("[PDF] Reference PDF not loaded (optional):", err.message);
}

const LLM_URL = process.env.LLM_URL || "https://tfy.internal.ap-south-1.production.apps.pai.mypaytm.com/api/llm/messages";
const LLM_MODEL = process.env.LLM_MODEL;
const LLM_API_KEY = process.env.LLM_KEY_API || process.env.LLM_API_KEY;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SCORE_MODEL = process.env.SCORE_MODEL || "gpt-4o";
/** Default model when routing mode is OpenAI (override with Connector `openaiModel` or request `model`). */
const OPENAI_ROUTING_MODEL =
  process.env.OPENAI_ROUTING_MODEL || process.env.OPENAI_MODEL || SCORE_MODEL || "gpt-4o-mini";
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();

// ── Google Sheets OAuth (plain HTTP, no googleapis package) ──────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/google-auth/callback";
const GOOGLE_TOKEN_FILE = path.join(__dirname, ".google_token.json");

function loadGoogleToken() {
  try { return JSON.parse(fs.readFileSync(GOOGLE_TOKEN_FILE, "utf8")); } catch { return null; }
}
function saveGoogleToken(t) {
  try { fs.writeFileSync(GOOGLE_TOKEN_FILE, JSON.stringify(t, null, 2)); } catch {}
}

async function getGoogleAccessToken() {
  const token = loadGoogleToken();
  if (!token?.refresh_token) return null;
  const now = Date.now() / 1000;
  if (token.access_token && token.expiry_date && token.expiry_date > now + 60) return token.access_token;
  // Refresh
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: token.refresh_token, grant_type: "refresh_token",
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) return null;
  const updated = { ...token, access_token: d.access_token, expiry_date: now + (d.expires_in || 3600) };
  saveGoogleToken(updated);
  return d.access_token;
}

/** Cached LLM probes for Connectors (startup + optional refresh). */
const llmProviderHealth = {
  foundry: { configured: false, ok: null, error: null, at: null },
  openai: { configured: false, ok: null, error: null, at: null },
  gemini: { configured: false, ok: null, error: null, at: null },
  anthropic: { configured: false, ok: null, error: null, at: null },
};

/**
 * Lightweight in-memory usage stats (last 24h) for UI.
 * Note: resets on server restart; intended for local/dev observability.
 */
const LLM_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const llmUsageEvents = [];
function recordLlmUsageEvent(evt) {
  const now = Date.now();
  llmUsageEvents.push({ ...evt, at: now });
  // prune
  const cutoff = now - LLM_USAGE_WINDOW_MS;
  while (llmUsageEvents.length && llmUsageEvents[0].at < cutoff) {
    llmUsageEvents.shift();
  }
}
const FOUNDRY_MODELS_JSON = path.join(__dirname, "..", "config", "foundry-models.json");
function loadFoundryModelsConfig() {
  try {
    const raw = fs.readFileSync(FOUNDRY_MODELS_JSON, "utf8");
    return JSON.parse(raw);
  } catch {
    return { models: [] };
  }
}

/** OpenAI / Foundry style usage + Bedrock Converse usage */
function pickUsageTokensFromPayload(obj) {
  if (!obj || typeof obj !== "object") return { promptTokens: 0, completionTokens: 0 };
  const u = obj.usage || obj.usage_metadata;
  if (u && typeof u === "object") {
    const pt = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? u.inputTokens;
    const ct = u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? u.outputTokens;
    if (pt != null || ct != null) {
      return { promptTokens: Number(pt) || 0, completionTokens: Number(ct) || 0 };
    }
  }
  const bu = obj.usage;
  if (bu && typeof bu === "object") {
    const pt = bu.inputTokens ?? bu.input_tokens;
    const ct = bu.outputTokens ?? bu.output_tokens;
    if (pt != null || ct != null) {
      return { promptTokens: Number(pt) || 0, completionTokens: Number(ct) || 0 };
    }
  }
  return { promptTokens: 0, completionTokens: 0 };
}

function buildLlmUsageSummary() {
  const cutoff = Date.now() - LLM_USAGE_WINDOW_MS;
  const recent = llmUsageEvents.filter((e) => e.at >= cutoff);
  const by = {};
  for (const e of recent) {
    const k = e.provider || "unknown";
    const cur = by[k] || {
      calls24h: 0,
      ok24h: 0,
      err24h: 0,
      lastOkAt: null,
      lastErrAt: null,
      lastErr: null,
      p50ms: null,
      p95ms: null,
    };
    cur.calls24h += 1;
    if (e.ok) {
      cur.ok24h += 1;
      cur.lastOkAt = e.at;
    } else {
      cur.err24h += 1;
      cur.lastErrAt = e.at;
      cur.lastErr = e.error || cur.lastErr;
    }
    by[k] = cur;
  }
  // percentiles
  for (const [k, cur] of Object.entries(by)) {
    const ms = recent.filter((e) => e.provider === k && typeof e.ms === "number").map((e) => e.ms).sort((a, b) => a - b);
    if (!ms.length) continue;
    const p = (q) => ms[Math.min(ms.length - 1, Math.floor(q * (ms.length - 1)))];
    cur.p50ms = p(0.5);
    cur.p95ms = p(0.95);
  }
  return by;
}

const PROBE_TIMEOUT_MS = 20000;

async function probeFoundryLlm() {
  llmProviderHealth.foundry.configured = !!(LLM_API_KEY && LLM_URL);
  if (!LLM_API_KEY || !LLM_URL) {
    llmProviderHealth.foundry.ok = false;
    llmProviderHealth.foundry.error = "LLM_KEY_API / LLM_API_KEY or LLM_URL not set";
    llmProviderHealth.foundry.at = Date.now();
    return;
  }
  const requestBody = {
    model: LLM_MODEL || SCORE_MODEL || "gpt-4o",
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  };
  const doCall = (authMode) =>
    fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authMode === "x-api-key" ? { "x-api-key": LLM_API_KEY } : { Authorization: `Bearer ${LLM_API_KEY}` }),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  try {
    let response = await doCall("x-api-key");
    if (response.status === 401) response = await doCall("bearer");
    const responseText = await response.text();
    if (!response.ok) {
      llmProviderHealth.foundry.ok = false;
      llmProviderHealth.foundry.error = `HTTP ${response.status}: ${responseText.slice(0, 200).replace(/\s+/g, " ")}`;
      llmProviderHealth.foundry.at = Date.now();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      llmProviderHealth.foundry.ok = false;
      llmProviderHealth.foundry.error = "Invalid JSON from gateway";
      llmProviderHealth.foundry.at = Date.now();
      return;
    }
    const text = extractAssistantTextFromLlmPayload(parsed).trim();
    if (!text) {
      llmProviderHealth.foundry.ok = false;
      llmProviderHealth.foundry.error = "Gateway returned empty assistant text";
      llmProviderHealth.foundry.at = Date.now();
      return;
    }
    llmProviderHealth.foundry.ok = true;
    llmProviderHealth.foundry.error = null;
    llmProviderHealth.foundry.at = Date.now();
  } catch (e) {
    llmProviderHealth.foundry.ok = false;
    llmProviderHealth.foundry.error = e?.message || String(e);
    llmProviderHealth.foundry.at = Date.now();
  }
}

async function probeOpenAiLlm() {
  llmProviderHealth.openai.configured = !!OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    llmProviderHealth.openai.ok = false;
    llmProviderHealth.openai.error = "OPENAI_API_KEY not set";
    llmProviderHealth.openai.at = Date.now();
    return;
  }
  try {
    const r = await fetch("https://api.openai.com/v1/models?limit=1", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${r.status}`;
      llmProviderHealth.openai.ok = false;
      llmProviderHealth.openai.error = String(msg).slice(0, 300);
      llmProviderHealth.openai.at = Date.now();
      return;
    }
    llmProviderHealth.openai.ok = true;
    llmProviderHealth.openai.error = null;
    llmProviderHealth.openai.at = Date.now();
  } catch (e) {
    llmProviderHealth.openai.ok = false;
    llmProviderHealth.openai.error = e?.message || String(e);
    llmProviderHealth.openai.at = Date.now();
  }
}

async function probeGeminiLlm() {
  llmProviderHealth.gemini.configured = !!GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    llmProviderHealth.gemini.ok = false;
    llmProviderHealth.gemini.error = "GEMINI_API_KEY or GOOGLE_API_KEY not set (Gemini not wired for /api/generate)";
    llmProviderHealth.gemini.at = Date.now();
    return;
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "Say OK" }] }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 200);
      llmProviderHealth.gemini.ok = false;
      llmProviderHealth.gemini.error = `HTTP ${r.status}: ${msg}`;
      llmProviderHealth.gemini.at = Date.now();
      return;
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p?.text || "").join("") : "";
    if (!String(text).trim()) {
      llmProviderHealth.gemini.ok = false;
      llmProviderHealth.gemini.error = "Empty response from Gemini API";
      llmProviderHealth.gemini.at = Date.now();
      return;
    }
    llmProviderHealth.gemini.ok = true;
    llmProviderHealth.gemini.error = null;
    llmProviderHealth.gemini.at = Date.now();
  } catch (e) {
    llmProviderHealth.gemini.ok = false;
    llmProviderHealth.gemini.error = e?.message || String(e);
    llmProviderHealth.gemini.at = Date.now();
  }
}

function buildLlmProvidersPayload() {
  const usage = buildLlmUsageSummary();
  const bedrock = {
    id: "bedrock",
    label: "AWS Bedrock",
    configured: isBedrockConfigured(),
    ok: bedrockHealth.ok,
    error: bedrockHealth.error,
    at: bedrockHealth.at,
    usage24h: usage.bedrock || usage.aws || null,
  };
  const foundry = {
    id: "foundry",
    label: "Foundry",
    configured: llmProviderHealth.foundry.configured,
    ok: llmProviderHealth.foundry.ok,
    error: llmProviderHealth.foundry.error,
    at: llmProviderHealth.foundry.at,
    usage24h: usage.foundry || null,
  };
  const openai = {
    id: "openai",
    label: "OpenAI",
    configured: llmProviderHealth.openai.configured,
    ok: llmProviderHealth.openai.ok,
    error: llmProviderHealth.openai.error,
    at: llmProviderHealth.openai.at,
    usage24h: usage.openai || null,
  };
  const gemini = {
    id: "gemini",
    label: "Gemini",
    configured: llmProviderHealth.gemini.configured,
    ok: llmProviderHealth.gemini.ok,
    error: llmProviderHealth.gemini.error,
    at: llmProviderHealth.gemini.at,
    usage24h: usage.gemini || null,
  };
  const anthropicHealth = {
    id: "anthropic",
    label: "Anthropic",
    configured: llmProviderHealth.anthropic.configured,
    ok: llmProviderHealth.anthropic.ok,
    error: llmProviderHealth.anthropic.error,
    at: llmProviderHealth.anthropic.at,
    usage24h: usage.anthropic || null,
  };
  return [bedrock, foundry, openai, gemini, anthropicHealth];
}

async function probeAnthropicLlm() {
  const key = process.env.ANTHROPIC_API_KEY || "";
  llmProviderHealth.anthropic.configured = !!key;
  if (!key) {
    llmProviderHealth.anthropic.ok = false;
    llmProviderHealth.anthropic.error = "ANTHROPIC_API_KEY not set — add to .env or export in shell before starting backend";
    llmProviderHealth.anthropic.at = Date.now();
    return;
  }
  try {
    const anthropicProbe = new Anthropic({ apiKey: key });
    const r = await anthropicProbe.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
    });
    const text = r.content?.[0]?.text?.trim() || "";
    if (!text) {
      llmProviderHealth.anthropic.ok = false;
      llmProviderHealth.anthropic.error = "Empty response from Anthropic API";
      llmProviderHealth.anthropic.at = Date.now();
      return;
    }
    llmProviderHealth.anthropic.ok = true;
    llmProviderHealth.anthropic.error = null;
    llmProviderHealth.anthropic.at = Date.now();
  } catch (e) {
    llmProviderHealth.anthropic.ok = false;
    llmProviderHealth.anthropic.error = e?.message || String(e);
    llmProviderHealth.anthropic.at = Date.now();
  }
}

async function runNonBedrockLlmProbes() {
  await Promise.all([probeFoundryLlm(), probeOpenAiLlm(), probeGeminiLlm(), probeAnthropicLlm()]);
}

function scoreFoundryBaseUrl() {
  return String(process.env.SCORE_LLM_URL || LLM_URL || "").trim().replace(/\/$/, "");
}

function scoreFoundryModel() {
  return String(process.env.SCORE_LLM_MODEL || LLM_MODEL || SCORE_MODEL).trim() || "gpt-4o";
}

/** Extract assistant text from OpenAI chat, Anthropic-style, or wrapped shapes. */
function extractAssistantTextFromLlmPayload(parsed) {
  if (parsed == null) return "";
  if (typeof parsed === "string") return parsed;
  const c0 = parsed.choices?.[0];
  if (c0?.message?.content != null) return String(c0.message.content);
  if (c0?.text != null) return String(c0.text);
  const inner = parsed.data ?? parsed;
  const c1 = inner?.choices?.[0];
  if (c1?.message?.content != null) return String(c1.message.content);
  const blocks = inner?.content;
  if (Array.isArray(blocks)) {
    return blocks
      .map((b) => (typeof b === "string" ? b : b?.text != null ? String(b.text) : ""))
      .filter(Boolean)
      .join("");
  }
  if (inner?.output_text != null) return String(inner.output_text);
  return "";
}

function parseScoreJsonFromModelOutput(raw) {
  const s = String(raw || "")
    .replace(/```json?\s*|\s*```/g, "")
    .trim();
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return { score: 0, maxScore: 10, rationale: "Could not parse score from model." };
  }
  let score = Number(obj.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.round(Math.min(10, Math.max(0, score)) * 100) / 100;
  const rationale = String(obj.rationale || "").trim() || "Could not parse score rationale from model.";
  return { score, maxScore: 10, rationale };
}

const JIRA_URL = (process.env.JIRA_URL || "").replace(/\/$/, "");
/** Second Atlassian site (e.g. TPAP on mypaytm). Same JIRA_EMAIL / JIRA_TOKEN as primary unless you add overrides later. */
const JIRA_URL_2 = (process.env.JIRA_URL_2 || process.env.JIRA_URL_SECONDARY || process.env.JIRA_URL_TPAP || "").replace(/\/$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_TOKEN = process.env.JIRA_TOKEN || process.env.JIRA_API_TOKEN || "";
/** Project keys that live on JIRA_URL_2 (comma-separated). Used when creating/fetching by key only. */
const JIRA_SECONDARY_PROJECT_KEYS = new Set(
  String(process.env.JIRA_SECONDARY_PROJECT_KEYS || "TPAP,PCO,TPG")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

function jiraAuthHeader() {
  return "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
}

function normalizeJiraBaseUrl(u) {
  return String(u || "")
    .trim()
    .replace(/\/$/, "");
}

function listConfiguredJiraBases() {
  const out = [];
  if (JIRA_URL) {
    out.push({
      id: "primary",
      base: JIRA_URL,
      label: process.env.JIRA_SITE_LABEL_PRIMARY || "Primary (finmate)",
    });
  }
  if (JIRA_URL_2) {
    out.push({
      id: "secondary",
      base: JIRA_URL_2,
      label: process.env.JIRA_SITE_LABEL_SECONDARY || "TPAP (mypaytm)",
    });
  }
  return out;
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Extract issue key + optional Atlassian host from pasted URL or plain key. */
function parseJiraIssueRequestParam(rawParam) {
  const s = safeDecodeURIComponent(String(rawParam || "").trim());
  let explicitBase = null;
  let issueKey = "";

  const selectedM = s.match(/[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/i);
  if (selectedM) {
    issueKey = selectedM[1].toUpperCase();
    const hostM = s.match(/https?:\/\/([a-z0-9.-]+\.atlassian\.net)/i);
    if (hostM) explicitBase = normalizeJiraBaseUrl(`https://${hostM[1]}`);
    return { issueKey, explicitBase };
  }

  const hostKeyM = s.match(/https?:\/\/([a-z0-9.-]+\.atlassian\.net).*?([A-Z][A-Z0-9]+-\d+)/i);
  if (hostKeyM) {
    explicitBase = normalizeJiraBaseUrl(`https://${hostKeyM[1]}`);
    issueKey = hostKeyM[2].toUpperCase();
    return { issueKey, explicitBase };
  }

  const keyOnly = s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  if (keyOnly) {
    issueKey = keyOnly[1].toUpperCase();
    return { issueKey, explicitBase: null };
  }

  const upper = s.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(upper)) return { issueKey: upper, explicitBase: null };
  return { issueKey: "", explicitBase: null };
}

function resolveBasesForFetch(parsed, query) {
  const configured = listConfiguredJiraBases()
    .map((x) => x.base)
    .filter(Boolean);
  let site = String(query?.site || "").toLowerCase();
  if (!site || site === "auto") site = "";

  if (parsed.explicitBase) {
    const ex = normalizeJiraBaseUrl(parsed.explicitBase);
    const ordered = [ex];
    for (const b of configured) {
      if (b !== ex) ordered.push(b);
    }
    return [...new Set(ordered.filter(Boolean))];
  }

  let ordered;
  if (site === "secondary" && JIRA_URL_2) {
    ordered = [JIRA_URL_2, JIRA_URL].filter(Boolean);
  } else if (site === "primary" && JIRA_URL) {
    ordered = [JIRA_URL, JIRA_URL_2].filter(Boolean);
  } else {
    ordered = [JIRA_URL, JIRA_URL_2].filter(Boolean);
  }
  ordered = [...new Set(ordered.filter(Boolean))];

  const qBase = normalizeJiraBaseUrl(query?.jiraBase || query?.jiraBaseUrl || "");
  if (qBase && configured.includes(qBase)) {
    return [qBase, ...ordered.filter((b) => b !== qBase)];
  }
  return ordered.length ? ordered : configured;
}

/**
 * Base URL for create / comments / attachments.
 * body: { jiraSite?: 'primary'|'secondary', jiraBaseUrl?: string }
 */
function resolveJiraBaseForWrite(projectKey, body) {
  const pk = String(projectKey || "")
    .trim()
    .toUpperCase()
    .split(/-/)[0];
  const explicit = normalizeJiraBaseUrl(body?.jiraBaseUrl || body?.jiraBase || "");
  const configured = listConfiguredJiraBases().map((x) => x.base).filter(Boolean);
  if (explicit) {
    if (configured.includes(explicit)) return explicit;
    if (/^https:\/\/[a-z0-9.-]+\.atlassian\.net$/i.test(explicit)) {
      console.warn("[jira-write] using explicit jiraBaseUrl not listed in JIRA_URL / JIRA_URL_2:", explicit);
      return explicit;
    }
    throw new Error(`Invalid jiraBaseUrl. Use a configured site base or *.atlassian.net URL.`);
  }
  const site = String(body?.jiraSite || "").toLowerCase();
  if (site === "secondary") return JIRA_URL_2 || JIRA_URL;
  if (site === "primary") return JIRA_URL || JIRA_URL_2;
  // auto / empty / unknown
  if (pk && JIRA_SECONDARY_PROJECT_KEYS.has(pk)) return JIRA_URL_2 || JIRA_URL;
  return JIRA_URL || JIRA_URL_2;
}

function resolveJiraBaseFromIssueKey(issueKey, body) {
  const project = String(issueKey || "")
    .trim()
    .toUpperCase()
    .split(/-/)[0];
  return resolveJiraBaseForWrite(project, body || {});
}

/** User-picker custom field id for "Dev Assignee" (or set JIRA_DEV_ASSIGNEE_FIELD_ID= in .env to override). */
const JIRA_DEV_ASSIGNEE_FIELD_ID = String(process.env.JIRA_DEV_ASSIGNEE_FIELD_ID || "customfield_10236").trim();
/** Optional user-picker id for "QA Assignee" (set JIRA_QA_ASSIGNEE_FIELD_ID in .env). */
const JIRA_QA_ASSIGNEE_FIELD_ID = String(process.env.JIRA_QA_ASSIGNEE_FIELD_ID || "").trim();
/**
 * Multi-user picker fields expect an array: [{ id }]. Single-user picker: one object { id }.
 * @see https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post
 */
const JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT =
  String(process.env.JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT || "").toLowerCase() === "true";

// Optional defaults for specific custom fields used on parent + sub-JIRAs (e.g. Yes/No flags).
// Example in .env:
//   JIRA_CF_10377_DEFAULT=No
//   JIRA_CF_10378_DEFAULT=No
const JIRA_CF_10377_DEFAULT = String(process.env.JIRA_CF_10377_DEFAULT || "").trim();
const JIRA_CF_10378_DEFAULT = String(process.env.JIRA_CF_10378_DEFAULT || "").trim();

function jiraSelectOptionFromEnv(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  // If it looks like an id (digits), send { id } otherwise send { value }.
  if (/^\d+$/.test(v)) return { id: v };
  return { value: v };
}

if (JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT) {
  console.warn(
    "[jira] JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT=true — Dev Assignee is sent as a single object. If JIRA returns \"data was not an array\", remove this line from .env (multi-user fields need [{ id }])."
  );
}

function extractJiraText(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  try {
    return (doc.content || [])
      .map((block) => {
        if (block.type === "paragraph") return (block.content || []).map((n) => n.text || "").join("");
        if (block.type === "bulletList") return (block.content || []).map((li) => "• " + ((li.content?.[0]?.content || []).map((n) => n.text || "").join(""))).join("\n");
        if (block.type === "orderedList") return (block.content || []).map((li, i) => `${i + 1}. ` + ((li.content?.[0]?.content || []).map((n) => n.text || "").join(""))).join("\n");
        return "";
      })
      .filter(Boolean)
      .join("\n") || "";
  } catch {
    return "";
  }
}

/** Recursively extract all URLs from ADF doc — inlineCard nodes + link marks. */
function extractADFUrls(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach(n => extractADFUrls(n, out)); return out; }
  if (node.type === "inlineCard" && node.attrs?.url) out.push(node.attrs.url);
  if (node.type === "text" && Array.isArray(node.marks)) {
    node.marks.forEach(m => { if (m.type === "link" && m.attrs?.href) out.push(m.attrs.href); });
  }
  if (Array.isArray(node.content)) extractADFUrls(node.content, out);
  return out;
}

/** JIRA user picker / multi-user: display names joined. */
function jiraUserFieldDisplay(val) {
  if (val == null) return "";
  if (Array.isArray(val)) return val.map((v) => jiraUserFieldDisplay(v)).filter(Boolean).join(", ");
  if (typeof val === "object") {
    if (val.displayName) return String(val.displayName);
    if (val.name) return String(val.name);
    if (val.emailAddress) return String(val.emailAddress);
  }
  return "";
}

const GOOGLE_SHEETS_URL_RE = /https?:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+[^\s]*?/gi;

function extractGoogleSheetUrlsFromText(text) {
  const s = String(text || "");
  const found = s.match(GOOGLE_SHEETS_URL_RE) || [];
  const cleaned = [];
  const seen = new Set();
  for (let u of found) {
    u = u.replace(/[),.;]+$/, "");
    if (seen.has(u)) continue;
    seen.add(u);
    cleaned.push(u);
  }
  return cleaned;
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

/** Log each /api request (method, path, status, duration). Stdout goes to .claude/main-dev.log when using npm run dev. Disable with PRD_AGENT_HTTP_LOG=0. */
app.use((req, res, next) => {
  if (process.env.PRD_AGENT_HTTP_LOG === "0") {
    return next();
  }
  const url = req.originalUrl || req.url || "";
  if (!url.startsWith("/api")) {
    return next();
  }
  const started = Date.now();
  res.on("finish", () => {
    const pathOnly = url.split("?")[0];
    console.log(`[api] ${req.method} ${pathOnly} ${res.statusCode} +${Date.now() - started}ms`);
  });
  next();
});

app.post("/api/context/knowledge", async (req, res) => {
  try {
    const q = String(req.body?.q || req.body?.query || "").trim();
    if (!q) {
      return res.status(400).json({ success: false, error: "Missing q" });
    }
    const { text, filesUsed, error } = await buildDocsKnowledgeContext(q);
    res.json({ success: true, text: text || "", filesUsed: filesUsed || [], error: error || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const startedAt = Date.now();
    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    let incomingSystem = typeof req.body?.system === "string" ? req.body.system : null;
    const incomingMaxTokens = typeof req.body?.max_tokens === "number" ? req.body.max_tokens : 8000;
    const messages = incomingMessages?.length ? incomingMessages : [{ role: "user", content: req.body?.prompt || "Generate PRD" }];
    const rawUserContent = messages.find((m) => m.role === "user")?.content;
    const userText = (
      typeof rawUserContent === "string"
        ? rawUserContent
        : rawUserContent != null
          ? JSON.stringify(rawUserContent)
          : req.body?.prompt || ""
    ).slice(0, 4000);
    const skipPreface = req.body?.skipPreface === true;
    const skipRag = req.body?.skipRag === true;

    const prefaceRaw =
      typeof req.body?.prefaceContext === "string" ? req.body.prefaceContext.trim() : "";
    if (!skipPreface && prefaceRaw) {
      incomingSystem =
        (incomingSystem || "") +
        "\n\n[Context from prior sessions and /docs — use only when relevant]\n" +
        prefaceRaw.slice(0, 12000);
    }
    if (!skipRag) {
      const ragChunks = await ragRetrieve(userText, 5);
      if (ragChunks.length > 0) {
        const ragContext = "\n\n[Reference context from NPCI/UPI/PRD docs – use where relevant]\n" + ragChunks.join("\n\n");
        incomingSystem = (incomingSystem || "") + ragContext;
      }
    }

    const requested = String(req.body?.llmProvider || process.env.LLM_PROVIDER_DEFAULT || "aws").toLowerCase();
    if (requested === "off") {
      return res.status(423).json({
        success: false,
        error: "LLM_DISABLED",
        message: "LLM is turned off in Connector Settings.",
      });
    }
    const agent = String(req.body?.agent || "unknown").slice(0, 40);
    const llmDisabled = req.body?.llmDisabled && typeof req.body.llmDisabled === "object" ? req.body.llmDisabled : {};
    const disableAws = String(llmDisabled.aws || "").toLowerCase() === "true";
    const disableFoundry = String(llmDisabled.foundry || "").toLowerCase() === "true";
    const disableOpenai = String(llmDisabled.openai || "").toLowerCase() === "true";
    const llmMode =
      requested === "auto" || requested === "fallback"
        ? "auto"
        : requested === "foundry"
          ? "foundry"
          : requested === "openai"
            ? "openai"
            : requested === "anthropic"
              ? "anthropic"
              : "aws";
    const modelFromBody = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : null;
    const openaiModelFromConnectors =
      typeof req.body?.openaiModel === "string" && req.body.openaiModel.trim() ? req.body.openaiModel.trim() : null;
    const bedrockModelTier =
      typeof req.body?.bedrockModelTier === "string" && req.body.bedrockModelTier.trim()
        ? req.body.bedrockModelTier.trim()
        : null;

    function resolveFoundryModelsList() {
      const en = req.body?.foundryModelsEnabled;
      const cfg = loadFoundryModelsConfig();
      const list = [];
      for (const row of cfg.models || []) {
        if (!row || row.llmModel == null) continue;
        const id = String(row.id);
        const enabled = en == null || typeof en !== "object" ? true : en[id] !== false;
        if (!enabled) continue;
        const m = String(row.llmModel).trim();
        if (m) list.push(m);
      }
      if (list.length) return list;
      if (modelFromBody) return [modelFromBody];
      if (LLM_MODEL) return [LLM_MODEL];
      return [SCORE_MODEL || "gpt-4o"];
    }

    const tryAws = async () => {
      if (!isBedrockConfigured()) {
        const err = new Error(
          "AWS Bedrock is not configured. Set BEDROCK_INVOKE_URL + BEDROCK_API_KEY (or BED_LLM_KEY), or native Bedrock: BEDROCK_MODEL_ID, AWS_REGION, credentials / BEDROCK_USE_DEFAULT_CREDENTIALS. See .env.example."
        );
        err.code = "BEDROCK_NOT_CONFIGURED";
        throw err;
      }
      const label = modelFromBody || bedrockModelTier || "sonnet";
      console.log(
        `[${new Date().toISOString()}] [api/generate] provider=aws`,
        bedrockModelTier ? `tier=${bedrockModelTier}` : "tier(default)",
        modelFromBody ? `model(body)=${modelFromBody}` : ""
      );

      const BEDROCK_ABORT_MAX_RETRIES = 3;
      const BEDROCK_ABORT_RETRY_BASE_MS = 500;
      const isAbortError = (err) =>
        /the operation was aborted/i.test(err?.message || "") ||
        err?.name === "AbortError" ||
        err?.code === "ABORT_ERR";

      const resolvedModelId = resolveBedrockModelId({ modelFromBody: modelFromBody || undefined, bedrockModelTier });
      console.log(
        "[api/generate] bedrock resolved model:",
        resolvedModelId,
        modelFromBody ? `(body requested: ${modelFromBody})` : "(no body model)",
        bedrockModelTier ? `(tier: ${bedrockModelTier})` : ""
      );

      let attempt = 0;
      while (true) {
        try {
          const started = Date.now();
          const data = await converseBedrock({
            messages,
            system: incomingSystem || undefined,
            maxTokens: incomingMaxTokens,
            modelId: modelFromBody || undefined,
            bedrockModelTier,
          });
          const toks = {
            promptTokens: Number(data?.usage?.inputTokens) || 0,
            completionTokens: Number(data?.usage?.outputTokens) || 0,
          };
          recordLlmUsageEvent({ provider: "bedrock", ok: true, ms: Date.now() - started, agent, model: label, ...toks });
          try {
            recordAgentDayUsage({ agent, provider: "aws", model: String(label), ...toks });
          } catch (e) {
            void e;
          }
          return { provider: "aws", data, model: label, ...toks };
        } catch (err) {
          if (isAbortError(err) && attempt < BEDROCK_ABORT_MAX_RETRIES) {
            attempt++;
            const delay = BEDROCK_ABORT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
            console.warn(
              `[api/generate] bedrock abort on model=${resolvedModelId}. Retry ${attempt}/${BEDROCK_ABORT_MAX_RETRIES} in ${delay}ms...`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          recordLlmUsageEvent({ provider: "bedrock", ok: false, error: err.message || String(err), agent });
          console.error("[api/generate] bedrock error:", err.message || err);
          const e = new Error(err.message || String(err));
          e.code = "BEDROCK_ERROR";
          throw e;
        }
      }
    };

    const tryOpenAi = async () => {
      if (!OPENAI_API_KEY) {
        const err = new Error("Set OPENAI_API_KEY in .env for OpenAI routing.");
        err.code = "OPENAI_NOT_CONFIGURED";
        throw err;
      }
      const openaiModel = openaiModelFromConnectors || modelFromBody || OPENAI_ROUTING_MODEL;
      const oaMessages = [];
      if (incomingSystem) oaMessages.push({ role: "system", content: String(incomingSystem) });
      for (const m of messages) {
        const role = m.role === "assistant" ? "assistant" : "user";
        const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        oaMessages.push({ role, content: c });
      }
      const started = Date.now();
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: openaiModel,
          messages: oaMessages,
          max_tokens: Math.min(incomingMaxTokens, 16000),
          temperature: 0.1,
        }),
      });
      const responseText = await r.text();
      if (!r.ok) {
        recordLlmUsageEvent({ provider: "openai", ok: false, ms: Date.now() - started, error: responseText.slice(0, 400), agent });
        const err = new Error(responseText);
        err.code = "OPENAI_ERROR";
        err.httpStatus = r.status;
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (e) {
        const err = new Error("Invalid JSON from OpenAI.");
        err.code = "OPENAI_INVALID_JSON";
        throw err;
      }
      const textOut = String(parsed.choices?.[0]?.message?.content ?? "");
      const toks = pickUsageTokensFromPayload(parsed);
      recordLlmUsageEvent({ provider: "openai", ok: true, ms: Date.now() - started, agent, model: openaiModel, ...toks });
      try {
        recordAgentDayUsage({ agent, provider: "openai", model: String(openaiModel), ...toks });
      } catch (e) {
        void e;
      }
      const data = { content: [{ type: "text", text: textOut }] };
      return { provider: "openai", data, model: openaiModel, ...toks };
    };

    const tryFoundryOne = async (fm) => {
      const requestBody = {
        model: fm,
        max_tokens: incomingMaxTokens,
        ...(incomingSystem ? { system: incomingSystem } : {}),
        messages,
      };
      const doCall = (authMode) =>
        fetch(LLM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authMode === "x-api-key" ? { "x-api-key": LLM_API_KEY } : { Authorization: `Bearer ${LLM_API_KEY}` }),
          },
          body: JSON.stringify(requestBody),
        });
      const started = Date.now();
      let authMode = "x-api-key";
      let response = await doCall(authMode);
      if (response.status === 401) {
        authMode = "bearer";
        response = await doCall(authMode);
      }
      const responseText = await response.text();
      if (!response.ok) {
        recordLlmUsageEvent({ provider: "foundry", ok: false, ms: Date.now() - started, error: `HTTP ${response.status}: ${responseText.slice(0, 300)}`, agent, model: fm });
        const err = new Error(`Foundry model ${fm}: ${responseText.slice(0, 500)}`);
        err.code = "LLM_GATEWAY_ERROR";
        err.httpStatus = response.status;
        throw err;
      }
      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (err) {
        recordLlmUsageEvent({ provider: "foundry", ok: false, ms: Date.now() - started, error: "INVALID_JSON_FROM_LLM", agent, model: fm });
        const e = new Error("Invalid JSON from LLM gateway.");
        e.code = "INVALID_JSON_FROM_LLM";
        throw e;
      }
      const toks = pickUsageTokensFromPayload(parsed);
      recordLlmUsageEvent({ provider: "foundry", ok: true, ms: Date.now() - started, agent, model: fm, ...toks });
      try {
        recordAgentDayUsage({ agent, provider: "foundry", model: String(fm), ...toks });
      } catch (e) {
        void e;
      }
      console.log(`[${new Date().toISOString()}] [api/generate] provider=foundry model=` + fm);
      return { provider: "foundry", data: parsed, model: fm, ...toks };
    };

    const tryFoundry = async () => {
      if (!LLM_API_KEY) {
        const err = new Error("Set LLM_KEY_API (preferred) or LLM_API_KEY in .env for Foundry.");
        err.code = "MISSING_API_KEY";
        throw err;
      }
      const modelList = resolveFoundryModelsList();
      let lastErr = null;
      const failedModels = [];
      for (let i = 0; i < modelList.length; i++) {
        const fm = modelList[i];
        try {
          return await tryFoundryOne(fm);
        } catch (e) {
          lastErr = e;
          failedModels.push(fm);
          const remaining = modelList.length - i - 1;
          if (remaining > 0) {
            console.warn(
              `[api/generate] foundry model ${fm} failed (${e.message?.slice(0, 120)}). Falling back to next model (${remaining} left)...`
            );
          } else {
            console.error(
              `[api/generate] foundry all ${modelList.length} model(s) exhausted. Tried: [${failedModels.join(", ")}]. Last error: ${e.message?.slice(0, 200)}`
            );
          }
        }
      }
      const summary = failedModels.length > 1
        ? `Foundry: all ${failedModels.length} models failed. Tried: [${failedModels.join(", ")}]. Last error: ${lastErr?.message}`
        : lastErr?.message || "Foundry: no model succeeded.";
      const err = new Error(summary);
      err.code = lastErr?.code || "LLM_GATEWAY_ERROR";
      throw err;
    };

    const ANTHROPIC_API_KEY_GEN = process.env.ANTHROPIC_API_KEY || "";
    const tryAnthropic = async () => {
      if (!ANTHROPIC_API_KEY_GEN) {
        const err = new Error("Set ANTHROPIC_API_KEY in .env for Anthropic direct routing.");
        err.code = "ANTHROPIC_NOT_CONFIGURED";
        throw err;
      }
      const anthropicModel = modelFromBody || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY_GEN });
      const started = Date.now();
      const r = await anthropic.messages.create({
        model: anthropicModel,
        max_tokens: incomingMaxTokens,
        ...(incomingSystem ? { system: incomingSystem } : {}),
        messages,
      });
      const toks = { promptTokens: r.usage?.input_tokens || 0, completionTokens: r.usage?.output_tokens || 0 };
      recordLlmUsageEvent({ provider: "anthropic", ok: true, ms: Date.now() - started, agent, model: anthropicModel, ...toks });
      try { recordAgentDayUsage({ agent, provider: "anthropic", model: anthropicModel, ...toks }); } catch (e) { void e; }
      return { provider: "anthropic", data: r, model: anthropicModel, ...toks };
    };

    const order =
      llmMode === "auto"
        ? ["aws", "foundry", "openai", "anthropic"]
        : llmMode === "foundry"
          ? ["foundry"]
          : llmMode === "openai"
            ? ["openai"]
            : llmMode === "anthropic"
              ? ["anthropic"]
              : ["aws"];
    const tried = [];
    let lastErr = null;
    for (const p of order) {
      if (p === "aws" && disableAws) {
        tried.push("aws(disabled)");
        continue;
      }
      if (p === "openai" && disableOpenai) {
        tried.push("openai(disabled)");
        continue;
      }
      if (p === "foundry" && disableFoundry) {
        tried.push("foundry(disabled)");
        continue;
      }
      try {
        const result = p === "aws" ? await tryAws() : p === "openai" ? await tryOpenAi() : p === "anthropic" ? await tryAnthropic() : await tryFoundry();
        const llmModel = result.model || (result.provider === "aws" ? modelFromBody || bedrockModelTier || "default" : "default");
        console.log(`[${new Date().toISOString()}] [api/generate] ✓ provider=${result.provider} model=${llmModel} ms=${Date.now() - startedAt}`);
        return res.json({ success: true, data: result.data, llmProvider: result.provider, llmTried: tried, llmModel });
      } catch (e) {
        tried.push(p);
        lastErr = e;
      }
    }
    return res.status(503).json({
      success: false,
      error: lastErr?.code || "LLM_UNAVAILABLE",
      message: lastErr?.message || "No LLM backend available.",
      tried,
    });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.status(500).json({ success: false, error: "SERVER_EXCEPTION", message: error.message });
  }
});

app.post("/api/claude", async (req, res) => {
  try {
    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    const incomingSystem = typeof req.body?.system === "string" ? req.body.system : null;
    const incomingMaxTokens = typeof req.body?.max_tokens === "number" ? req.body.max_tokens : 4000;
    const messages = incomingMessages?.length ? incomingMessages : [{ role: "user", content: req.body?.prompt || "" }];
    const requestedProvider = String(req.body?.llmProvider || process.env.LLM_PROVIDER_DEFAULT || "aws").toLowerCase();
    const llmProvider = requestedProvider === "foundry" ? "foundry" : requestedProvider === "anthropic" ? "anthropic" : "aws";
    const modelFromBody = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : null;
    const bedrockModelTier =
      typeof req.body?.bedrockModelTier === "string" && req.body.bedrockModelTier.trim()
        ? req.body.bedrockModelTier.trim()
        : null;

    if (llmProvider === "anthropic") {
      const ANTHROPIC_API_KEY_CLAUDE = process.env.ANTHROPIC_API_KEY || "";
      if (!ANTHROPIC_API_KEY_CLAUDE) {
        return res.status(503).json({ error: { message: "ANTHROPIC_API_KEY not set." } });
      }
      const anthropicClaude = new Anthropic({ apiKey: ANTHROPIC_API_KEY_CLAUDE });
      const anthropicModel = modelFromBody || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
      console.log(`[${new Date().toISOString()}] [api/claude] provider=anthropic model=${anthropicModel}`);
      const r = await anthropicClaude.messages.create({
        model: anthropicModel,
        max_tokens: incomingMaxTokens,
        ...(incomingSystem ? { system: incomingSystem } : {}),
        messages,
      });
      return res.json(r);
    }

    if (llmProvider === "aws") {
      if (!isBedrockConfigured()) {
        const ANTHROPIC_API_KEY_CLAUDE = process.env.ANTHROPIC_API_KEY || "";
        if (ANTHROPIC_API_KEY_CLAUDE) {
          const anthropicClaude = new Anthropic({ apiKey: ANTHROPIC_API_KEY_CLAUDE });
          const anthropicModel = modelFromBody || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
          console.log(`[${new Date().toISOString()}] [api/claude] provider=anthropic(bedrock-fallback) model=${anthropicModel}`);
          const r = await anthropicClaude.messages.create({
            model: anthropicModel,
            max_tokens: incomingMaxTokens,
            ...(incomingSystem ? { system: incomingSystem } : {}),
            messages,
          });
          return res.json(r);
        }
        return res.status(503).json({
          error: { message: "AWS Bedrock not configured — see .env.example (HTTP gateway or native SDK vars)." },
        });
      }
      console.log(`[${new Date().toISOString()}] [api/claude] provider=aws`, bedrockModelTier ? `tier=${bedrockModelTier}` : "");
      const data = await converseBedrock({
        messages,
        system: incomingSystem || undefined,
        maxTokens: incomingMaxTokens,
        modelId: modelFromBody || undefined,
        bedrockModelTier,
      });
      return res.json(data);
    }

    if (!LLM_API_KEY) {
      const ANTHROPIC_API_KEY_CLAUDE = process.env.ANTHROPIC_API_KEY || "";
      if (ANTHROPIC_API_KEY_CLAUDE) {
        const anthropicClaude = new Anthropic({ apiKey: ANTHROPIC_API_KEY_CLAUDE });
        const anthropicModel = modelFromBody || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
        console.log(`[${new Date().toISOString()}] [api/claude] provider=anthropic(foundry-fallback) model=${anthropicModel}`);
        const r = await anthropicClaude.messages.create({
          model: anthropicModel,
          max_tokens: incomingMaxTokens,
          ...(incomingSystem ? { system: incomingSystem } : {}),
          messages,
        });
        return res.json(r);
      }
      return res.status(500).json({ error: { message: "Set LLM_KEY_API or LLM_API_KEY in .env for Foundry" } });
    }
    const requestBody = {
      model: modelFromBody || LLM_MODEL,
      max_tokens: incomingMaxTokens,
      ...(incomingSystem ? { system: incomingSystem } : {}),
      messages,
    };
    const doCall = (authMode) =>
      fetch(LLM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authMode === "x-api-key" ? { "x-api-key": LLM_API_KEY } : { Authorization: `Bearer ${LLM_API_KEY}` }),
        },
        body: JSON.stringify(requestBody),
      });
    let response = await doCall("x-api-key");
    if (response.status === 401) response = await doCall("bearer");
    const responseText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: { message: responseText } });
    }
    const parsed = JSON.parse(responseText);
    console.log(`[${new Date().toISOString()}] [api/claude] provider=foundry`);
    res.json(parsed);
  } catch (err) {
    console.error("BRD /api/claude error:", err);
    res.status(500).json({ error: { message: err.message } });
  }
});

const ALPHA_ROOT = process.env.ALPHA_ROOT;

app.post("/api/alpha/chat", async (req, res) => {
  const alphaStarted = Date.now();
  try {
    const message = String(req.body?.message || "").trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message) return res.status(400).json({ success: false, error: "message required" });

    const readSafe = async (p, maxChars = 0) => {
      try {
        const txt = await fs.promises.readFile(p, "utf8");
        return maxChars ? txt.slice(0, maxChars) : txt;
      } catch { return ""; }
    };

    const [soul, claudeMd, products, index] = await Promise.all([
      readSafe(`${ALPHA_ROOT}/SOUL.md`, 1500),
      readSafe(`${ALPHA_ROOT}/CLAUDE.md`, 1500),
      readSafe(`${ALPHA_ROOT}/PRODUCTS.md`, 1500),
      readSafe(`${ALPHA_ROOT}/INDEX.md`, 2000),
    ]);

    const wikiDir = `${ALPHA_ROOT}/wiki`;
    const filesUsed = [];
    let wikiContext = "";
    try {
      const tokens = message.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 3);
      // Step 1: collect filenames only (no I/O per file)
      async function walkMdNames(dir) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const results = [];
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) results.push(...(await walkMdNames(full)));
          else if (/\.md$/i.test(e.name)) results.push(full);
        }
        return results;
      }
      const allFiles = await walkMdNames(wikiDir);
      // Step 2: score by filename only (instant) → top 15 candidates
      const byName = allFiles.map(f => {
        const base = path.basename(f).toLowerCase();
        let s = 0;
        for (const t of tokens) if (base.includes(t)) s += t.length > 6 ? 5 : 2;
        return { f, s };
      }).sort((a, b) => b.s - a.s).slice(0, 15).map(x => x.f);
      // Step 3: read top 15 in parallel, score by content
      const reads = await Promise.all(byName.map(async f => {
        const txt = await readSafe(f, 5000);
        const lower = txt.toLowerCase();
        let score = 0;
        for (const t of tokens) if (lower.includes(t)) score += t.length > 6 ? 3 : 1;
        return { f, txt, score };
      }));
      const top4 = reads.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
      wikiContext = top4.map(x => `### ${path.relative(wikiDir, x.f)}\n${x.txt.slice(0, 2500)}`).join("\n\n---\n\n");
      filesUsed.push(...top4.map(x => path.relative(ALPHA_ROOT, x.f)));
    } catch (e) {
      console.warn("[api/alpha/chat] wiki search error:", e.message);
    }

    const systemPrompt = [
      "You are Alpha Agent — the embedded PM brain of the Paytm UPI product team.",
      soul ? `\n[SOUL]\n${soul}` : "",
      claudeMd ? `\n[OPERATING INSTRUCTIONS]\n${claudeMd}` : "",
      products ? `\n[PRODUCTS IN SCOPE]\n${products}` : "",
      index ? `\n[WIKI INDEX]\n${index}` : "",
      wikiContext ? `\n[RELEVANT WIKI CONTEXT]\n${wikiContext}` : "",
    ].filter(Boolean).join("\n");

    const messages = [
      ...history.filter(m => m.role && m.content).map(m => ({ role: m.role, content: String(m.content) })),
      { role: "user", content: message },
    ];

    const requested = String(req.body?.llmProvider || process.env.LLM_PROVIDER_DEFAULT || "aws").toLowerCase();
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
    let reply = "";
    let llmProvider = requested;

    if (requested === "anthropic" && ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const r = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 4000,
        system: systemPrompt,
        messages,
      });
      reply = r.content?.[0]?.text || "";
      llmProvider = "anthropic";
    } else if (requested !== "foundry" && requested !== "openai" && requested !== "anthropic" && isBedrockConfigured() && bedrockHealth.ok) {
      const data = await converseBedrock({ messages, system: systemPrompt, maxTokens: 4000 });
      reply = data?.content?.[0]?.text || JSON.stringify(data);
      llmProvider = "aws";
    } else if (requested === "openai" && OPENAI_API_KEY) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", max_tokens: 4000, messages: [{ role: "system", content: systemPrompt }, ...messages] }),
      });
      const j = await r.json();
      reply = j.choices?.[0]?.message?.content || JSON.stringify(j);
      llmProvider = "openai";
    } else if (LLM_API_KEY && LLM_URL) {
      const r = await fetch(LLM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": LLM_API_KEY },
        body: JSON.stringify({ model: LLM_MODEL, max_tokens: 4000, system: systemPrompt, messages }),
      });
      const j = await r.json();
      reply = j?.content?.[0]?.text || JSON.stringify(j);
      llmProvider = "foundry";
    } else if (ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      const r = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 4000,
        system: systemPrompt,
        messages,
      });
      reply = r.content?.[0]?.text || "";
      llmProvider = "anthropic";
    } else {
      return res.status(503).json({ success: false, error: "No LLM provider configured" });
    }

    const ms = Date.now() - alphaStarted;
    console.log(`[${new Date().toISOString()}] [alpha] ✓ provider=${llmProvider} ms=${ms} filesUsed=${filesUsed.length}`);
    return res.json({ success: true, reply, filesUsed, llmProvider, ms });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [alpha] ERROR:`, err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/config", (req, res) => {
  const sites = listConfiguredJiraBases();
  const foundryScoreUrl = scoreFoundryBaseUrl();
  res.json({
    anthropicConfigured: !!LLM_API_KEY || isBedrockConfigured(),
    llmBedrockConfigured: isBedrockConfigured(),
    llmFoundryConfigured: !!(LLM_API_KEY && LLM_URL),
    jiraConfigured: !!(JIRA_EMAIL && JIRA_TOKEN && sites.length > 0),
    jiraUrl: JIRA_URL || "",
    jiraUrl2: JIRA_URL_2 || "",
    jiraSites: sites,
    jiraSecondaryProjectKeys: [...JIRA_SECONDARY_PROJECT_KEYS],
    jiraEmail: JIRA_EMAIL || "",
    scoreOpenAiConfigured: !!OPENAI_API_KEY,
    scoreFoundryConfigured: !!(LLM_API_KEY && foundryScoreUrl),
  });
});

app.post("/api/export-docx", async (req, res) => {
  try {
    const prd = req.body?.prd;
    if (!prd || typeof prd !== "object") {
      return res.status(400).json({ success: false, error: "Missing or invalid prd in body" });
    }
    const title = prd.title || "UPI Switch PRD";
    const version = prd.version || "v1.0";
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeTitle = title.replace(/[^a-zA-Z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 60) || "PRD";
    const filename = `PRD-${safeTitle}-${dateStr}.docx`;
    const children = [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
      new Paragraph({ text: `Version: ${version}  |  Date: ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`, spacing: { after: 400 } }),
    ];
    for (const key of SECTION_ORDER) {
      const sectionTitle = SECTION_TITLES[key] || key;
      const content = prd[key];
      if (content != null && String(content).trim()) {
        children.push(new Paragraph({ text: sectionTitle, heading: HeadingLevel.HEADING_2 }));
        for (const line of String(content).split(/\n/)) {
          children.push(new Paragraph({ text: line.trim() || " ", spacing: { after: 120 } }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }
    }
    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    if (!fs.existsSync(PRD_OUTPUT_DIR)) {
      fs.mkdirSync(PRD_OUTPUT_DIR, { recursive: true });
    }
    const outPath = path.join(PRD_OUTPUT_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Export DOCX error:", err);
    res.status(500).json({ success: false, error: "EXPORT_ERROR", message: err.message });
  }
});

app.post("/api/extract-docx", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: "Missing file", message: "Upload a .docx file" });
    }
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    if (ext !== ".docx") {
      return res.status(400).json({ success: false, error: "Invalid type", message: "Only .docx files are supported" });
    }
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    res.json({ success: true, text: result.value || "" });
  } catch (err) {
    console.error("Extract DOCX error:", err);
    res.status(500).json({ success: false, error: "EXTRACT_ERROR", message: err.message });
  }
});

app.post("/api/extract-context-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, error: "Missing file" });
    }
    const ext = path.extname(req.file.originalname || "").toLowerCase();
    const name = req.file.originalname || "file";
    let text = "";
    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value || "";
    } else if (ext === ".pdf") {
      text = await extractTextFromPDFBuffer(req.file.buffer);
    } else if (ext === ".xlsx" || ext === ".xls") {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      const parts = [];
      for (const sn of wb.SheetNames || []) {
        const sheet = wb.Sheets[sn];
        if (sheet) parts.push(`--- Sheet: ${sn} ---\n${XLSX.utils.sheet_to_csv(sheet)}`);
      }
      text = parts.join("\n\n");
    } else if (ext === ".txt" || ext === ".csv" || ext === ".md") {
      text = req.file.buffer.toString("utf8");
    } else {
      return res.status(400).json({
        success: false,
        error: "Unsupported file type. Use .docx, .pdf, .xlsx, .xls, .txt, .csv, or .md",
      });
    }
    res.json({ success: true, text: String(text).slice(0, 200000), name });
  } catch (err) {
    console.error("extract-context-file:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/foundry-models", (req, res) => {
  try {
    const cfg = loadFoundryModelsConfig();
    res.json({ success: true, models: cfg.models || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/llm-usage-daily", (req, res) => {
  try {
    const daysBack = Math.min(31, Math.max(1, Number(req.query.days) || 8));
    const summary = getDailySummary(daysBack);
    res.json({ success: true, days: summary, inMemory24hByProvider: buildLlmUsageSummary() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Alpha agent health-check + auto-start

function isPortListening(port) {
  return new Promise((resolve) => {
    const s = _netCreateServer();
    s.once("error", () => resolve(true));   // EADDRINUSE → port in use → alive
    s.once("listening", () => { s.close(); resolve(false); });
    s.listen(port, "127.0.0.1");
  });
}

let _alphaStarting = false;

app.get("/api/alpha/status", async (req, res) => {
  try {
    const alive = await isPortListening(3050);
    if (!alive && !_alphaStarting) {
      _alphaStarting = true;
      const webUiDir = path.join(__dirname, "..", "alpha-web-ui");
      const child = _spawnProc("npm", ["run", "dev"], {
        cwd: webUiDir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      setTimeout(() => { _alphaStarting = false; }, 30000);
      return res.json({ status: "starting" });
    }
    res.json({ status: alive ? "running" : "starting" });
  } catch (e) {
    res.json({ status: "error", error: e.message });
  }
});

app.get("/api/connectors/status", (req, res) => {
  const sites = listConfiguredJiraBases();
  res.json({
    llmBedrockConfigured: isBedrockConfigured(),
    llmFoundryConfigured: !!(LLM_API_KEY && LLM_URL),
    llmOpenAiConfigured: !!OPENAI_API_KEY,
    llmAnthropicConfigured: llmProviderHealth.anthropic.configured,
    llmProviders: buildLlmProvidersPayload(),
    jira: !!(JIRA_EMAIL && JIRA_TOKEN && sites.length > 0),
    jiraSites: sites,
    jiraSecondaryProjectKeys: [...JIRA_SECONDARY_PROJECT_KEYS],
    slack: !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL),
    whatsapp: !!(process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_PHONE_ID),
    email: !!(process.env.EMAIL_SMTP_HOST || process.env.EMAIL_API_KEY),
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN),
  });
});

app.post("/api/connectors/llm-probes", async (req, res) => {
  try {
    await Promise.all([rerunBedrockReadinessProbe(), runNonBedrockLlmProbes()]);
    res.json({ success: true, llmProviders: buildLlmProvidersPayload() });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.get("/api/jira-test", async (req, res) => {
  const sites = listConfiguredJiraBases();
  if (!sites.length || !JIRA_EMAIL || !JIRA_TOKEN) {
    return res.status(400).json({ ok: false, error: "JIRA not configured. Set JIRA_URL, JIRA_EMAIL, JIRA_TOKEN in .env" });
  }
  try {
    const results = [];
    for (const s of sites) {
      const url = `${s.base}/rest/api/3/myself`;
      const r = await fetch(url, {
        headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      const label = s.label || s.id;
      if (r.ok) {
        const u = data?.displayName || data?.emailAddress || "OK";
        console.log(`[jira-test] OK ${label} (${s.base}) as ${u}`);
        results.push({ id: s.id, base: s.base, label, ok: true, user: u });
      } else {
        const msg = Array.isArray(data?.errorMessages) ? data.errorMessages.join("; ") : `HTTP ${r.status}`;
        console.error(`[jira-test] FAIL ${label} (${s.base}):`, msg);
        results.push({ id: s.id, base: s.base, label, ok: false, error: msg });
      }
    }
    const firstOk = results.find((x) => x.ok);
    return res.json({
      ok: results.some((x) => x.ok),
      user: firstOk?.user,
      sites: results,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

function jiraSiteLabelForBase(base) {
  const b = normalizeJiraBaseUrl(base);
  if (b && JIRA_URL_2 && b === normalizeJiraBaseUrl(JIRA_URL_2)) return "secondary";
  return "primary";
}

function formatJiraIssueApiResponse(d, jiraBaseUrl) {
  const f = d.fields || {};
  const commentList = f.comment?.comments || [];
  const comments = commentList
    .slice(-3)
    .map((c) => `[${c.author?.displayName}]: ${extractJiraText(c.body)}`)
    .join("\n");
  const allCommentsText = commentList.map((c) => extractJiraText(c.body)).join("\n");
  const statusName = f.status?.name || "";
  const inUat = /^in\s*uat$/i.test(String(statusName).trim());
  const haystackForSheets = [allCommentsText, extractJiraText(f.description)].filter(Boolean).join("\n");
  // Also extract URLs embedded as ADF inlineCard / link marks (not in plain text)
  const adfUrlsFromComments = commentList.flatMap(c => extractADFUrls(c.body));
  const adfUrlsFromDesc = extractADFUrls(f.description);
  const allAdfUrls = [...new Set([...adfUrlsFromComments, ...adfUrlsFromDesc])];
  const qaTestCaseSheetUrls = [
    ...extractGoogleSheetUrlsFromText(haystackForSheets),
    ...allAdfUrls.filter(u => /spreadsheets\/d\//i.test(u)),
  ].filter((u, i, a) => a.indexOf(u) === i);
  const GOOGLE_DRIVE_ALL_RE = /https?:\/\/(?:docs|drive)\.google\.com\/[^\s"'),.;<>]+/gi;
  const driveLinksRaw = [
    ...(haystackForSheets.match(GOOGLE_DRIVE_ALL_RE) || []).map(u => u.replace(/[),.;]+$/, "")),
    ...allAdfUrls.filter(u => /google\.com/i.test(u)),
  ];
  const driveLinks = [...new Set(driveLinksRaw)];

  const assigneeName = f.assignee?.displayName || "Unassigned";
  const devFromCf = JIRA_DEV_ASSIGNEE_FIELD_ID ? jiraUserFieldDisplay(f[JIRA_DEV_ASSIGNEE_FIELD_ID]) : "";
  const devAssignee = devFromCf || assigneeName;
  const qaAssignee = JIRA_QA_ASSIGNEE_FIELD_ID ? jiraUserFieldDisplay(f[JIRA_QA_ASSIGNEE_FIELD_ID]) : "";

  return {
    id: d.key,
    jiraBaseUrl: jiraBaseUrl || "",
    jiraSite: jiraSiteLabelForBase(jiraBaseUrl),
    summary: f.summary || "",
    description: extractJiraText(f.description),
    status: statusName,
    priority: f.priority?.name || "",
    assignee: assigneeName,
    devAssignee,
    qaAssignee: qaAssignee || "",
    reporter: f.reporter?.displayName || "",
    created: (f.created || "").split("T")[0] || "",
    updated: (f.updated || "").split("T")[0] || "",
    labels: (f.labels || []).join(", "),
    components: (f.components || []).map((c) => c.name).join(", "),
    fixVersions: (f.fixVersions || []).map((v) => v.name).join(", "),
    acceptanceCriteria: extractJiraText(f.customfield_10023 || f.customfield_10034 || ""),
    comments,
    qaTestCaseSheetUrls,
    driveLinks,
    requirement: f.customfield_10023 ? extractJiraText(f.customfield_10023) : "",
    fundlossRisk: f.customfield_10100 ? String(f.customfield_10100) : (f.customfield_10050 ? String(f.customfield_10050) : ""),
    attachments: (f.attachment || []).map((a) => a.filename).join(", "),
    attachmentItems: (f.attachment || [])
      .map((a) => ({
        filename: String(a.filename || "attachment").trim() || "attachment",
        url: String(a.content || a.url || "").trim(),
      }))
      .filter((x) => x.url),
  };
}

app.get("/api/jira-issue/:id", async (req, res) => {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return res.status(400).json({ error: "JIRA not configured. Set JIRA_EMAIL, JIRA_TOKEN in .env" });
  }
  const parsed = parseJiraIssueRequestParam(req.params.id);
  const issueKey = parsed.issueKey;
  if (!issueKey) return res.status(400).json({ error: "Missing JIRA issue key — paste a key (e.g. TPAP-123) or full browse URL." });

  const basesToTry = resolveBasesForFetch(parsed, req.query);
  if (!basesToTry.length) {
    return res.status(400).json({ error: "No JIRA site configured. Set JIRA_URL (and optionally JIRA_URL_2) in .env." });
  }

  const tryLog = [];
  try {
    for (const base of basesToTry) {
      const apiUrl = `${base}/rest/api/3/issue/${issueKey}`;
      console.log(`[jira-fetch] GET ${apiUrl}`);
      const r = await fetch(apiUrl, {
        headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
      });
      const rawText = await r.text();
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }
      if (r.ok) {
        console.log(`[jira-fetch] OK ${issueKey} from ${base}`);
        return res.json(formatJiraIssueApiResponse(data, base));
      }
      const msg =
        (Array.isArray(data?.errorMessages) && data.errorMessages[0]) ||
        data?.message ||
        data?.errorMessage ||
        r.statusText ||
        `HTTP ${r.status}`;
      console.error(`[jira-fetch] FAIL ${base} ${issueKey} status=${r.status}:`, msg);
      if (data && typeof data === "object" && Object.keys(data).length) {
        console.error(`[jira-fetch] response body (truncated):`, JSON.stringify(data).slice(0, 800));
      }
      tryLog.push({ base, status: r.status, message: String(msg) });
    }

    const last = tryLog[tryLog.length - 1];
    const summary =
      tryLog.length > 1
        ? `${last?.message || "Not found"} (tried ${tryLog.length} sites — see server log for details)`
        : last?.message || "Issue does not exist or you do not have permission to see it.";
    return res.status(404).json({
      error: summary,
      tried: tryLog,
      issueKey,
    });
  } catch (err) {
    console.error("[jira-fetch] exception:", err);
    res.status(500).json({ error: err.message });
  }
});

// Proxy-download a JIRA attachment and extract text (PDF / DOCX / plaintext)
app.get("/api/jira-attachment-text", async (req, res) => {
  const { url: rawUrl, filename } = req.query;
  if (!rawUrl) return res.status(400).json({ error: "url required" });
  if (!JIRA_EMAIL || !JIRA_TOKEN) return res.status(400).json({ error: "JIRA credentials not configured" });
  try {
    const r = await fetch(rawUrl, { headers: { Authorization: jiraAuthHeader(), Accept: "*/*" } });
    if (!r.ok) return res.status(r.status).json({ error: `Attachment fetch failed: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const fname = String(filename || rawUrl).toLowerCase();
    let text = "";
    if (fname.includes(".pdf")) {
      text = await extractTextFromPDFBuffer(buf);
    } else if (fname.includes(".docx")) {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value || "";
    } else if (fname.includes(".xlsx") || fname.includes(".xls")) {
      // xlsx → plain text via existing import
      const XLSX_mod = await import("xlsx");
      const wb = XLSX_mod.default.read(buf, { type: "buffer" });
      text = wb.SheetNames.map((n) => {
        const ws = wb.Sheets[n];
        return `Sheet: ${n}\n` + XLSX_mod.default.utils.sheet_to_csv(ws);
      }).join("\n\n");
    } else {
      text = buf.toString("utf-8");
    }
    return res.json({ text: text.slice(0, 30000), filename, chars: text.length });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Extraction failed" });
  }
});

// ── Google OAuth endpoints ────────────────────────────────────────────────────
app.get("/api/google-auth/url", (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "GOOGLE_CLIENT_ID not configured" });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get("/api/google-auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code",
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.refresh_token) throw new Error(d.error_description || "Token exchange failed — no refresh_token returned");
    saveGoogleToken({ ...d, expiry_date: Date.now() / 1000 + (d.expires_in || 3600) });
    res.send("<h2>✅ Google Sheets access authorised!</h2><p>You can close this tab. The UAT agent can now read private Google Sheets.</p>");
  } catch (e) {
    res.status(500).send(`<h2>❌ Auth failed: ${e.message}</h2>`);
  }
});

app.get("/api/google-auth/status", (req, res) => {
  const t = loadGoogleToken();
  res.json({ authorised: !!(t?.refresh_token), hasToken: !!t });
});

// Fetch Google Drive / Sheets content — uses OAuth for private sheets, falls back to public CSV export
app.get("/api/gdrive-fetch", async (req, res) => {
  const { url: rawUrl, sheetTabName } = req.query;
  if (!rawUrl) return res.status(400).json({ error: "url required" });
  try {
    const sheetsMatch = rawUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const docsMatch = rawUrl.match(/document\/d\/([a-zA-Z0-9-_]+)/);

    if (sheetsMatch) {
      const sheetId = sheetsMatch[1];

      // ── Local filesystem scan (Google Drive for Desktop) ──────────────────
      const gDriveLocal = process.env.GDRIVE_LOCAL_PATH ||
        path.join(os.homedir(), "Google Drive", "My Drive");
      if (sheetTabName && fs.existsSync(gDriveLocal)) {
        const candidates = [`${sheetTabName}.csv`, `${sheetTabName}.xlsx`, `${sheetTabName}.xls`];
        for (const cand of candidates) {
          const found = findFileInDir(gDriveLocal, cand);
          if (found) {
            const fileData = fs.readFileSync(found);
            let text;
            if (cand.endsWith(".csv")) {
              text = fileData.toString("utf8");
            } else {
              const wb = XLSX.read(fileData);
              const ws = wb.Sheets[wb.SheetNames[0]];
              text = XLSX.utils.sheet_to_csv(ws);
            }
            return res.json({
              text: text.slice(0, 50000), type: "sheet", tabName: sheetTabName,
              source: "local", filePath: found, chars: text.length,
            });
          }
        }
        // Not found locally — return instructions
        const targetPath = path.join(gDriveLocal, `${sheetTabName}.csv`);
        return res.json({
          text: null, type: "sheet", requiresAuth: false, localNotFound: true,
          localPath: gDriveLocal,
          message: `Test case sheet for "${sheetTabName}" not found locally. Export tab "${sheetTabName}" from Google Sheets as CSV and save to Google Drive as "${sheetTabName}.csv".`,
          hint: `Target path: ${targetPath}`,
        });
      }

      const accessToken = await getGoogleAccessToken();

      // ── Authenticated path: Sheets API v4 ──────────────────────────────────
      if (accessToken) {
        const authHeader = { Authorization: `Bearer ${accessToken}` };

        // Get sheet metadata to find tab by name or gid
        const metaR = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`, { headers: authHeader });
        if (!metaR.ok) {
          const errBody = await metaR.json().catch(() => ({}));
          throw new Error(errBody.error?.message || `Sheets API metadata failed: ${metaR.status}`);
        }
        const meta = await metaR.json();
        const sheets = meta.sheets || [];

        // Find target tab: by sheetTabName param, or gid from URL, or first sheet
        let targetSheet = null;
        if (sheetTabName) {
          targetSheet = sheets.find(s => s.properties?.title?.toLowerCase() === String(sheetTabName).toLowerCase());
        }
        if (!targetSheet) {
          const gidMatch = rawUrl.match(/[#?&]gid=(\d+)/);
          if (gidMatch) targetSheet = sheets.find(s => String(s.properties?.sheetId) === gidMatch[1]);
        }
        if (!targetSheet) targetSheet = sheets[0];

        if (!targetSheet) return res.json({ text: null, type: "sheet", error: "No matching tab found", sheets: sheets.map(s => s.properties?.title) });

        const tabName = targetSheet.properties.title;
        const valuesR = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}`,
          { headers: authHeader }
        );
        if (!valuesR.ok) {
          const errBody = await valuesR.json().catch(() => ({}));
          throw new Error(errBody.error?.message || `Sheets API values failed: ${valuesR.status}`);
        }
        const data = await valuesR.json();
        const rows = data.values || [];
        // Convert rows array to CSV-like text
        const text = rows.map(r => r.map(c => String(c).replace(/,/g, ";")).join(",")).join("\n");
        return res.json({ text: text.slice(0, 50000), type: "sheet", tabName, rowCount: rows.length, chars: text.length, authenticated: true });
      }

      // ── Public CSV export fallback ────────────────────────────────────────
      const gidMatch = rawUrl.match(/[#?&]gid=(\d+)/);
      const gidPart = gidMatch ? `&gid=${gidMatch[1]}` : "";
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv${gidPart}`;
      const r = await fetch(exportUrl, { headers: { Accept: "text/csv,*/*" }, redirect: "follow" });
      if (!r.ok) {
        return res.json({
          text: null, type: "sheet", requiresAuth: true,
          authUrl: GOOGLE_CLIENT_ID ? "/api/google-auth/url" : null,
          error: `Sheet requires Google login (${r.status}). Visit /api/google-auth/url to authorise.`,
        });
      }
      const text = await r.text();
      return res.json({ text: text.slice(0, 50000), type: "sheet", chars: text.length, authenticated: false });
    }

    if (docsMatch) {
      const docId = docsMatch[1];
      const accessToken = await getGoogleAccessToken();
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const r = await fetch(exportUrl, { headers: { Accept: "text/plain,*/*", ...headers }, redirect: "follow" });
      if (!r.ok) return res.json({ text: null, type: "doc", requiresAuth: true, error: `Doc fetch failed (${r.status})` });
      const text = await r.text();
      return res.json({ text: text.slice(0, 50000), type: "doc", chars: text.length });
    }

    return res.status(400).json({ error: "Unrecognised Google Drive URL format" });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Google Drive fetch failed" });
  }
});

// Delete local Drive files after UAT (explicit user confirmation required on frontend)
app.post("/api/local-drive-cleanup", async (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) return res.status(400).json({ error: "files array required" });
  const gDriveLocal = process.env.GDRIVE_LOCAL_PATH || path.join(os.homedir(), "Google Drive", "My Drive");
  const deleted = [], failed = [];
  for (const filePath of files) {
    const resolved = path.resolve(filePath);
    // Safety: only delete files inside the Drive folder
    if (!resolved.startsWith(path.resolve(gDriveLocal)) && !resolved.startsWith(path.resolve(path.join(os.homedir(), "My Drive")))) {
      failed.push({ path: filePath, reason: "Path outside Google Drive folder — refused" });
      continue;
    }
    try {
      fs.unlinkSync(resolved);
      deleted.push(filePath);
    } catch (e) {
      failed.push({ path: filePath, reason: e.message });
    }
  }
  res.json({ deleted, failed });
});

function findFileInDir(dir, filename, depth = 0) {
  if (depth > 5) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === filename.toLowerCase()) return full;
      if (ent.isDirectory()) {
        const found = findFileInDir(full, filename, depth + 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function looksLikeJiraAccountId(s) {
  const t = String(s || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/** Atlassian Cloud scoped account id, e.g. 712020:43e3961c-6f66-4321-8971-8e25d446eb56 */
function looksLikeJiraScopedAccountId(s) {
  const t = String(s || "").trim();
  return /^\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
}

/** Create issue / user fields: Atlassian samples use { id: "…" } (scoped or legacy id). */
function jiraUserFieldRef(accountIdOrId) {
  const id = String(accountIdOrId || "").trim();
  if (!id) return null;
  return { id };
}

/** Resolve email / display name → { id } for JIRA Cloud REST. */
async function jiraResolveUserPickerValue(query, jiraBase) {
  const base = normalizeJiraBaseUrl(jiraBase) || JIRA_URL;
  const q = String(query || "").trim();
  if (!q) return null;
  if (looksLikeJiraAccountId(q) || looksLikeJiraScopedAccountId(q)) return jiraUserFieldRef(q);
  const url = `${base}/rest/api/3/user/search?query=${encodeURIComponent(q)}&maxResults=10`;
  const r = await fetch(url, {
    headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
  });
  const users = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = Array.isArray(users?.errorMessages) ? users.errorMessages.join("; ") : `HTTP ${r.status}`;
    console.error(`[jira] user/search failed on ${base}:`, msg);
    throw new Error(`JIRA user search failed: ${msg}`);
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error(
      `No JIRA user found for "${q}". Use full email (e.g. Deepankar.pathak@finmate.tech), display name, or paste Atlassian accountId (UUID).`
    );
  }
  if (users.length > 1) {
    const brief = users
      .slice(0, 5)
      .map((u) => `${u.displayName || "?"} <${u.emailAddress || u.accountId}>`)
      .join(" | ");
    console.warn(`[jira] user search "${q}" returned ${users.length} matches; using first. Sample: ${brief}`);
  }
  return jiraUserFieldRef(users[0].accountId);
}

/**
 * Sets Dev Assignee (user picker) on create. Priority: request devAssignee → JIRA_DEV_ASSIGNEE_ACCOUNT_ID → JIRA_DEV_ASSIGNEE.
 * Omit all to skip (JIRA may still error if the field is required).
 */
async function resolveDevAssigneeFields(bodyDevAssignee, jiraBase) {
  if (!JIRA_DEV_ASSIGNEE_FIELD_ID) return {};

  const body = String(bodyDevAssignee || "").trim();
  const envAccount = String(process.env.JIRA_DEV_ASSIGNEE_ACCOUNT_ID || "").trim();
  const envQuery = String(process.env.JIRA_DEV_ASSIGNEE || "").trim();

  let picker = null;
  if (body) {
    picker =
      looksLikeJiraAccountId(body) || looksLikeJiraScopedAccountId(body)
        ? jiraUserFieldRef(body)
        : await jiraResolveUserPickerValue(body, jiraBase);
  } else if (envAccount) {
    picker =
      looksLikeJiraAccountId(envAccount) || looksLikeJiraScopedAccountId(envAccount)
        ? jiraUserFieldRef(envAccount)
        : await jiraResolveUserPickerValue(envAccount, jiraBase);
  } else if (envQuery) {
    picker =
      looksLikeJiraAccountId(envQuery) || looksLikeJiraScopedAccountId(envQuery)
        ? jiraUserFieldRef(envQuery)
        : await jiraResolveUserPickerValue(envQuery, jiraBase);
  }

  if (!picker?.id) return {};
  // Multi-user picker → must be [{ id }]. Single-user custom field → { id } only if env set.
  const fieldValue = JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT ? picker : [picker];
  return { [JIRA_DEV_ASSIGNEE_FIELD_ID]: fieldValue };
}

function normalizeJiraLabelStringsFromRequest(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\n]/) : [];
  const out = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
  return out.slice(0, 25);
}

/**
 * UI / API domain id → JIRA component name (shared catalog with frontend `agentDomainCatalog.js`).
 * Aliases: refund → Refunds (legacy id). Empty string = no component (e.g. HSS).
 */
function jiraComponentNamesFromDomainIds(domainIds) {
  const ids = (Array.isArray(domainIds) ? domainIds : []).map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
  if (!ids.length) return [];
  const idToComponent = {
    pms: "PMS",
    payout: "Payout",
    refunds: "Refunds",
    refund: "Refunds",
    mandates: "UPI_2.0_Man",
    switch: "Switch",
    compliance: "Compliance",
    reconciliation: "Recon",
    hms: "HMS",
    passbook: "Passbook",
    gateway: "Switch-GW",
    pps: "TPAP-Post-Payment",
    tpap_switch: "Switch",
    tpap_pms: "PMS",
    tpap_mandates: "UPI_2.0_Man",
    config_updates: "UPI",
    app_common: "UPI-H5",
    ios_app: "UPI",
    android_app: "UPI",
    h5_changes: "TPAP-H5",
    combination: "Combination",
    hss: "",
  };
  if (ids.includes("all")) {
    const names = new Set();
    Object.values(idToComponent).forEach((c) => {
      if (c) names.add(c);
    });
    return [...names];
  }
  const names = new Set();
  for (const id of ids) {
    const c = idToComponent[id];
    if (c) names.add(c);
  }
  return [...names];
}

function normalizeJiraComponentsInput(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [];
  const names = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) names.push(item.trim());
    else if (item && typeof item === "object" && item.name) names.push(String(item.name).trim());
  }
  return [...new Set(names)].filter(Boolean).slice(0, 20);
}

/**
 * Build Jira `fields.timetracking` from create body.
 * Accepts REST-style `timetracking: { originalEstimate, remainingEstimate }`, a string shorthand,
 * or legacy-style keys matching Jira error field ids: timetracking_originalestimate, timetracking_remainingestimate.
 */
function resolveTimetrackingFromBody(body, defaultEstimate = "1d") {
  const b = body && typeof body === "object" ? body : {};
  const def = String(defaultEstimate || "1d").trim() || "1d";
  const top = b.timetracking;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    const o = String(top.originalEstimate ?? top.original ?? def).trim() || def;
    const r = String(top.remainingEstimate ?? top.remaining ?? o).trim() || o;
    return { originalEstimate: o, remainingEstimate: r };
  }
  if (typeof top === "string" && top.trim()) {
    const v = top.trim();
    return { originalEstimate: v, remainingEstimate: v };
  }
  const fromOrig = b.timetracking_originalEstimate ?? b.timetracking_originalestimate;
  const fromRem = b.timetracking_remainingEstimate ?? b.timetracking_remainingestimate;
  const o = String(fromOrig || def).trim() || def;
  const r = String(fromRem || o).trim() || o;
  return { originalEstimate: o, remainingEstimate: r };
}

/** Merge timetracking + components for JIRA Agent creates (and compatible API clients). */
function applyJiraCreateAgentFields(fields, body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.skipTimetracking === true) return { ...fields };
  const out = { ...fields, timetracking: resolveTimetrackingFromBody(b, "1d") };
  const explicit = normalizeJiraComponentsInput(b.components);
  const domainIds = Array.isArray(b.domainIds) ? b.domainIds : Array.isArray(b.selectedDomains) ? b.selectedDomains : [];
  const fromDomain = jiraComponentNamesFromDomainIds(domainIds);
  const compNames = explicit.length ? explicit : fromDomain;
  if (compNames.length) out.components = compNames.map((name) => ({ name }));
  return out;
}

function mergeLabelsIntoJiraFields(fields, labelStrings) {
  const labels = normalizeJiraLabelStringsFromRequest(labelStrings);
  if (!labels.length) return fields;
  return { ...fields, labels };
}

function normalizeNotifyDomainLabels(body) {
  const n = body?.notifyDomainLabels;
  if (Array.isArray(n)) return n.map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  return [];
}

/** After JIRA Agent creates issue(s); uses same SMTP as Share / NOTIFY. */
async function sendJiraAgentCreatedEmail({ issueKeys, summary, domainLabels }) {
  const keys = (Array.isArray(issueKeys) ? issueKeys : []).map((k) => String(k || "").trim()).filter(Boolean);
  if (!keys.length) return;
  const to = String(process.env.JIRA_CREATE_NOTIFY_TO || process.env.NOTIFY_EMAIL || process.env.EMAIL_USER || "").trim();
  const hasSmtp = !!(process.env.EMAIL_SMTP_HOST || process.env.EMAIL_USER);
  if (!to || !hasSmtp) {
    console.log("[jira-create-mail] skipped (set JIRA_CREATE_NOTIFY_TO or NOTIFY_EMAIL, and EMAIL_* for SMTP)");
    return;
  }
  const greeting = String(process.env.JIRA_CREATE_GREETING_NAME || "Deepankar").trim() || "Deepankar";
  const sum = String(summary || "Ticket").trim().slice(0, 240);
  const subject = `${keys.join(", ")} - ${sum} Created`;
  const domainPart =
    Array.isArray(domainLabels) && domainLabels.length ? domainLabels.join(", ") : "the selected domain(s)";
  const idsLine = keys.join(", ");
  const html = `Hi ${greeting},<br/>JIRA has been created successfully for ${domainPart}.<br/> Please refer to ${idsLine}.`;
  const text = `Hi ${greeting},\n\nJIRA has been created successfully for ${domainPart}.\n\nPlease refer to ${idsLine}.`;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transportOpts = {
      host: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.EMAIL_SMTP_PORT) || 587,
      secure: process.env.EMAIL_SECURE === "true",
      auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD } : undefined,
    };
    const transporter = nodemailer.createTransport(transportOpts);
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@local",
      to,
      subject,
      text,
      html,
    });
    console.log("[jira-create-mail] sent:", subject.slice(0, 100));
  } catch (e) {
    console.error("[jira-create-mail] failed:", e.message);
  }
}

/** Safe logging of fields (avoid dumping huge ADF). */
function summarizeJiraFieldsForLog(fields) {
  const f = fields && typeof fields === "object" ? { ...fields } : {};
  if (f.description && typeof f.description === "object") {
    const raw = JSON.stringify(f.description);
    f.description = `<ADF, ${raw.length} chars>`;
  } else if (typeof f.description === "string") {
    f.description = `<string, ${f.description.length} chars>`;
  }
  return f;
}

function formatJiraApiError(data) {
  if (!data || typeof data !== "object") return "JIRA request failed";
  const msgs = data.errorMessages;
  if (Array.isArray(msgs) && msgs.length) return msgs.join("; ");
  const errs = data.errors;
  if (errs && typeof errs === "object") {
    const pairs = Object.entries(errs).map(([k, v]) => `${k}: ${v}`);
    if (pairs.length) return pairs.join("; ");
  }
  return data.message || "Bad Request";
}

function buildIssuetypeField({ issueTypeName, issueTypeId }) {
  const id =
    (issueTypeId && String(issueTypeId).trim()) ||
    (process.env.JIRA_ISSUE_TYPE_ID && String(process.env.JIRA_ISSUE_TYPE_ID).trim()) ||
    "";
  if (id) return { id };
  const name = String(issueTypeName || process.env.JIRA_DEFAULT_ISSUE_TYPE || "Task").trim() || "Task";
  return { name };
}

function buildSubtaskIssuetypeField({ issueTypeId, issueTypeName }) {
  const id =
    (issueTypeId && String(issueTypeId).trim()) ||
    (process.env.JIRA_SUBTASK_ISSUE_TYPE_ID && String(process.env.JIRA_SUBTASK_ISSUE_TYPE_ID).trim()) ||
    "";
  if (id) return { id };
  const name = String(issueTypeName || process.env.JIRA_SUBTASK_ISSUE_TYPE_NAME || "Sub-task").trim() || "Sub-task";
  return { name };
}

async function jiraCreateIssue(fields, logLabel, jiraBase) {
  const base = normalizeJiraBaseUrl(jiraBase) || JIRA_URL;
  const postUrl = `${base}/rest/api/3/issue`;
  if (logLabel) {
    console.log(`${logLabel} POST ${postUrl} fields:`, JSON.stringify(summarizeJiraFieldsForLog(fields), null, 2));
  }
  const r = await fetch(postUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: jiraAuthHeader(),
    },
    body: JSON.stringify({ fields }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (logLabel) {
      console.error(`${logLabel} JIRA ${base} response ${r.status}:`, JSON.stringify(data, null, 2));
    }
    const err = new Error(formatJiraApiError(data));
    err.status = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

/** JIRA sometimes rejects rich ADF; fall back to a single paragraph of plain text. */
function jiraMinimalDescriptionAdf(markdown) {
  const text = String(markdown || "")
    .replace(/\r/g, "")
    .replace(/\0/g, "")
    .slice(0, 32000);
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: text.trim() ? text : "(empty)" }] }],
  };
}

async function jiraCreateIssueWithMarkdownDescription(fieldsBase, markdown, logLabel, jiraBase) {
  const md = String(markdown || "");
  const adf = markdownToJiraAdf(md)?.body;
  const fields = { ...fieldsBase, ...(adf ? { description: adf } : {}) };
  try {
    return await jiraCreateIssue(fields, logLabel, jiraBase);
  } catch (e) {
    const m = String(e.message || "").toLowerCase();
    const errKeys = e.details?.errors ? Object.keys(e.details.errors).join(" ").toLowerCase() : "";
    const retry =
      fields.description &&
      (m.includes("description") ||
        m.includes("document") ||
        m.includes("adf") ||
        errKeys.includes("description"));
    if (retry) {
      return await jiraCreateIssue(
        {
          ...fieldsBase,
          description: jiraMinimalDescriptionAdf(md),
        },
        logLabel ? `${logLabel} (retry minimal description)` : undefined,
        jiraBase
      );
    }
    throw e;
  }
}

app.get("/api/jira/issue-types", async (req, res) => {
  const projectKey = String(req.query.projectKey || "").trim().toUpperCase();
  if (!projectKey) return res.status(400).json({ success: false, error: "Missing projectKey query" });
  if (!listConfiguredJiraBases().length || !JIRA_EMAIL || !JIRA_TOKEN) {
    return res.status(400).json({ success: false, error: "JIRA not configured in .env" });
  }
  try {
    const jiraBase = resolveJiraBaseForWrite(projectKey, {
      jiraSite: req.query.jiraSite,
      jiraBaseUrl: req.query.jiraBaseUrl,
    });
    const url = `${jiraBase}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes`;
    console.log(`[api/jira/issue-types] GET ${url}`);
    const r = await fetch(url, {
      headers: { Authorization: jiraAuthHeader(), Accept: "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[api/jira/issue-types] FAIL ${jiraBase}:`, formatJiraApiError(data));
      return res.status(r.status).json({ success: false, error: formatJiraApiError(data), jiraBaseUrl: jiraBase });
    }
    const proj = (data.projects || [])[0];
    const types = (proj?.issuetypes || []).map((t) => ({
      id: t.id,
      name: t.name,
      subtask: !!t.subtask,
    }));
    res.json({ success: true, projectKey, types, jiraBaseUrl: jiraBase });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/jira/create", async (req, res) => {
  const logP = "[api/jira/create]";
  try {
    const reqBody = req.body || {};
    const { projectKey, summary, description, issueType, issueTypeId, devAssignee, labels, jiraSite, jiraBaseUrl } = reqBody;
    let jiraBase;
    try {
      jiraBase = resolveJiraBaseForWrite(projectKey, { jiraSite, jiraBaseUrl });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    console.log(`${logP} JIRA base:`, jiraBase);
    console.log(
      `${logP} incoming body:`,
      JSON.stringify(
        {
          projectKey: projectKey || null,
          summary: summary ? String(summary).slice(0, 120) + (String(summary).length > 120 ? "…" : "") : null,
          description: `(markdown, ${String(description || "").length} chars)`,
          issueType: issueType || null,
          issueTypeId: issueTypeId || null,
          devAssignee: devAssignee || null,
          labels: Array.isArray(labels) ? labels : null,
          jiraSite: jiraSite || null,
          domainIds: Array.isArray(reqBody.domainIds) ? reqBody.domainIds : null,
          components: Array.isArray(reqBody.components) ? reqBody.components : null,
          timetracking: reqBody.timetracking || null,
        },
        null,
        2
      )
    );
    if (!projectKey || !summary || !description) {
      console.error("[api/jira/create] 400 validation:", {
        hasProjectKey: !!projectKey,
        hasSummary: !!summary,
        hasDescription: !!description,
      });
      return res.status(400).json({ success: false, error: "Missing projectKey, summary, or description" });
    }
    if (!jiraBase || !JIRA_EMAIL || !JIRA_TOKEN) {
      console.error("[api/jira/create] 400 JIRA credentials missing in env");
      return res.status(400).json({ success: false, error: "JIRA not configured in .env" });
    }
    const cleanProjectKey = String(projectKey).trim().toUpperCase();
    const cleanSummary = String(summary).trim().slice(0, 255);
    if (!cleanSummary) {
      console.error("[api/jira/create] 400 empty summary after trim");
      return res.status(400).json({ success: false, error: "Summary is empty — set Feature / Ticket Title or ensure the draft starts with # Title" });
    }
    let assigneeFields = {};
    try {
      assigneeFields = await resolveDevAssigneeFields(devAssignee, jiraBase);
    } catch (e) {
      console.error(`${logP} dev assignee resolution failed:`, e.message);
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    if (Object.keys(assigneeFields).length) {
      console.log(`${logP} resolved Dev Assignee (${JIRA_DEV_ASSIGNEE_FIELD_ID}):`, JSON.stringify(assigneeFields, null, 2));
    }
    const md = String(description);
    const fieldsBase = applyJiraCreateAgentFields(
      mergeLabelsIntoJiraFields(
        {
          project: { key: cleanProjectKey },
          summary: cleanSummary,
          issuetype: buildIssuetypeField({ issueTypeName: issueType, issueTypeId }),
          ...assigneeFields,
        },
        labels
      ),
      reqBody
    );
    const data = await jiraCreateIssueWithMarkdownDescription(fieldsBase, md, logP, jiraBase);
    const key = data.key || "";
    void sendJiraAgentCreatedEmail({
      issueKeys: key ? [key] : [],
      summary: cleanSummary,
      domainLabels: normalizeNotifyDomainLabels(reqBody),
    });
    res.json({
      success: true,
      key,
      id: data.id,
      self: data.self,
      browseUrl: key ? `${jiraBase}/browse/${key}` : "",
      jiraBaseUrl: jiraBase,
    });
  } catch (err) {
    const status = err.status && Number(err.status) >= 400 ? err.status : 500;
    const details = err.details && typeof err.details === "object" ? JSON.stringify(err.details) : "";
    console.error("[api/jira/create] failed:", status, err.message || err, details || "");
    res.status(status).json({ success: false, error: err.message || String(err) });
  }
});

app.post("/api/jira/attach", upload.array("files", 12), async (req, res) => {
  try {
    const issueKey = String(req.body.issueKey || "").trim().toUpperCase().replace(/\s/g, "");
    if (!issueKey || !req.files?.length) {
      return res.status(400).json({ success: false, error: "Missing issueKey or files" });
    }
    if (!listConfiguredJiraBases().length || !JIRA_EMAIL || !JIRA_TOKEN) {
      return res.status(400).json({ success: false, error: "JIRA not configured in .env" });
    }
    let jiraBase;
    try {
      jiraBase = resolveJiraBaseFromIssueKey(issueKey, {
        jiraSite: req.body.jiraSite,
        jiraBaseUrl: req.body.jiraBaseUrl,
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    const form = new FormData();
    for (const f of req.files) {
      form.append("file", f.buffer, {
        filename: f.originalname || "attachment",
        contentType: f.mimetype || "application/octet-stream",
      });
    }
    const url = `${jiraBase}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
    console.log(`[api/jira/attach] POST ${url}`);
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: jiraAuthHeader(),
        "X-Atlassian-Token": "no-check",
        ...form.getHeaders(),
      },
      body: form,
    });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : [];
    } catch {
      data = text;
    }
    if (!r.ok) {
      const errMsg =
        typeof data === "object" && data?.errorMessages?.[0] ? data.errorMessages[0] : String(text).slice(0, 400) || r.statusText;
      console.error(`[api/jira/attach] FAIL ${url}:`, errMsg);
      return res.status(r.status).json({
        success: false,
        error: errMsg,
      });
    }
    res.json({ success: true, attachments: Array.isArray(data) ? data : [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/jira/create-with-subtasks", async (req, res) => {
  const logP = "[api/jira/create-with-subtasks]";
  try {
    const reqBody = req.body || {};
    const { projectKey, parent, subtasks, devAssignee, labels, jiraSite, jiraBaseUrl } = reqBody;
    let jiraBase;
    try {
      jiraBase = resolveJiraBaseForWrite(projectKey, { jiraSite, jiraBaseUrl });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    console.log(`${logP} JIRA base:`, jiraBase);
    console.log(
      `${logP} incoming:`,
      JSON.stringify(
        {
          projectKey: projectKey || null,
          devAssignee: devAssignee || null,
          parentSummary: parent?.summary ? String(parent.summary).slice(0, 120) : null,
          parentDescriptionLen: String(parent?.description || "").length,
          subtaskCount: Array.isArray(subtasks) ? subtasks.length : 0,
          labels: Array.isArray(labels) ? labels : null,
          jiraSite: jiraSite || null,
          domainIds: Array.isArray(reqBody.domainIds) ? reqBody.domainIds : null,
          components: Array.isArray(reqBody.components) ? reqBody.components : null,
          timetracking: reqBody.timetracking || null,
        },
        null,
        2
      )
    );
    if (!projectKey || !parent?.summary || !parent?.description) {
      return res.status(400).json({ success: false, error: "Missing projectKey or parent.summary / parent.description" });
    }
    if (!jiraBase || !JIRA_EMAIL || !JIRA_TOKEN) {
      return res.status(400).json({ success: false, error: "JIRA not configured in .env" });
    }
    let assigneeFields = {};
    try {
      assigneeFields = await resolveDevAssigneeFields(devAssignee, jiraBase);
    } catch (e) {
      console.error(`${logP} dev assignee resolution failed:`, e.message);
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    const cleanProjectKey = String(projectKey).trim().toUpperCase();
    const parentSummary = String(parent.summary).trim().slice(0, 255);
    if (!parentSummary) return res.status(400).json({ success: false, error: "Parent summary is empty" });
    const parentMd = String(parent.description);
    let parentFieldsBase = applyJiraCreateAgentFields(
      mergeLabelsIntoJiraFields(
        {
          project: { key: cleanProjectKey },
          summary: parentSummary,
          issuetype: buildIssuetypeField({
            issueTypeName: parent.issueType,
            issueTypeId: parent.issueTypeId,
          }),
          ...assigneeFields,
        },
        labels
      ),
      reqBody
    );
    const cf10377Parent = jiraSelectOptionFromEnv(JIRA_CF_10377_DEFAULT);
    const cf10378Parent = jiraSelectOptionFromEnv(JIRA_CF_10378_DEFAULT);
    if (cf10377Parent) parentFieldsBase.customfield_10377 = cf10377Parent;
    if (cf10378Parent) parentFieldsBase.customfield_10378 = cf10378Parent;
    console.log(
      `${logP} parent CF defaults:`,
      JSON.stringify(
        {
          customfield_10377: parentFieldsBase.customfield_10377 || null,
          customfield_10378: parentFieldsBase.customfield_10378 || null,
        },
        null,
        2
      )
    );
    const createdParent = await jiraCreateIssueWithMarkdownDescription(parentFieldsBase, parentMd, `${logP} parent`, jiraBase);
    const parentKey = createdParent.key || "";
    const createdSubs = [];
    const list = Array.isArray(subtasks) ? subtasks : [];
    for (const st of list) {
      const sum = String(st?.summary || "").trim().slice(0, 255);
      if (!sum) continue;
      const bodyMd = String(st?.description || st?.body || "").trim() || sum;
      let subFieldsBase = applyJiraCreateAgentFields(
        mergeLabelsIntoJiraFields(
          {
            project: { key: cleanProjectKey },
            parent: { key: parentKey },
            summary: sum,
            issuetype: buildSubtaskIssuetypeField({
              issueTypeId: st.issueTypeId,
              issueTypeName: st.issueType,
            }),
            ...assigneeFields,
          },
          labels
        ),
        reqBody
      );
      const cf10377Sub = jiraSelectOptionFromEnv(JIRA_CF_10377_DEFAULT);
      const cf10378Sub = jiraSelectOptionFromEnv(JIRA_CF_10378_DEFAULT);
      if (cf10377Sub) subFieldsBase.customfield_10377 = cf10377Sub;
      if (cf10378Sub) subFieldsBase.customfield_10378 = cf10378Sub;
      console.log(
        `${logP} sub CF defaults for ${sum.slice(0, 80)}:`,
        JSON.stringify(
          {
            customfield_10377: subFieldsBase.customfield_10377 || null,
            customfield_10378: subFieldsBase.customfield_10378 || null,
          },
          null,
          2
        )
      );
      try {
        const subData = await jiraCreateIssueWithMarkdownDescription(subFieldsBase, bodyMd, `${logP} sub`, jiraBase);
        createdSubs.push({
          key: subData.key,
          browseUrl: subData.key ? `${jiraBase}/browse/${subData.key}` : "",
        });
      } catch (e) {
        console.error(`${logP} subtask create failed:`, e.message);
        createdSubs.push({ error: e.message || String(e) });
      }
    }
    const subKeys = createdSubs.map((s) => s.key).filter(Boolean);
    const allKeys = parentKey ? [parentKey, ...subKeys] : subKeys;
    void sendJiraAgentCreatedEmail({
      issueKeys: allKeys,
      summary: parentSummary,
      domainLabels: normalizeNotifyDomainLabels(reqBody),
    });
    res.json({
      success: true,
      parentKey,
      parentBrowseUrl: parentKey ? `${jiraBase}/browse/${parentKey}` : "",
      subtasks: createdSubs,
      jiraBaseUrl: jiraBase,
    });
  } catch (err) {
    const status = err.status && Number(err.status) >= 400 ? err.status : 500;
    const details = err.details && typeof err.details === "object" ? JSON.stringify(err.details) : "";
    console.error(`${logP} failed:`, status, err.message || err, details || "");
    res.status(status).json({ success: false, error: err.message || String(err) });
  }
});

// ── Share: JIRA comment, Telegram, Email ─────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
/** Corporate SSL inspection: set TELEGRAM_INSECURE_TLS=true in .env (dev only). */
const telegramHttpsAgent =
  process.env.TELEGRAM_INSECURE_TLS === "true"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

async function telegramApiSendMessage(chatId, textBody, parseMode) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: textBody,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
    ...(telegramHttpsAgent ? { agent: telegramHttpsAgent } : {}),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    data = {};
  }
  return { ok: r.ok, data };
}

app.post("/api/save-agent-output", (req, res) => {
  try {
    const { agent, jiraId, subject, content } = req.body || {};
    const text = String(content || "");
    if (!text.trim()) return res.status(400).json({ ok: false, error: "empty content" });
    if (!fs.existsSync(AGENT_EXPORT_DIR)) fs.mkdirSync(AGENT_EXPORT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = (s) =>
      String(s || "")
        .replace(/[/\\?%*:|"<>#\s]+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 100);
    const jid = safe((jiraId || "NOJIRA").toUpperCase().slice(0, 40));
    const ag = safe((agent || "DOC").toUpperCase());
    const subj = safe(subject || "output");
    const filename = `${jid}-${ag}-${subj}-${ts}.md`;
    fs.writeFileSync(path.join(AGENT_EXPORT_DIR, filename), text, "utf8");
    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/share/jira", async (req, res) => {
  try {
    const { issueKey, text, title, jiraSite, jiraBaseUrl } = req.body || {};
    if (!issueKey || !text) return res.status(400).json({ success: false, error: "Missing issueKey or text" });
    if (!listConfiguredJiraBases().length || !JIRA_EMAIL || !JIRA_TOKEN) {
      return res.status(400).json({ success: false, error: "JIRA not configured in .env" });
    }
    const key = String(issueKey).toUpperCase().replace(/\s/g, "");
    let jiraBase;
    try {
      jiraBase = resolveJiraBaseFromIssueKey(key, { jiraSite, jiraBaseUrl });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message || String(e) });
    }
    const md = title ? `## ${title}\n\n${text}` : String(text);
    const commentUrl = `${jiraBase}/rest/api/3/issue/${key}/comment`;
    console.log(`[api/share/jira] POST ${commentUrl}`);
    const r = await fetch(commentUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: jiraAuthHeader(),
      },
      body: JSON.stringify(markdownToJiraAdf(md)),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[api/share/jira] FAIL:`, data.errorMessages?.[0] || r.statusText, JSON.stringify(data).slice(0, 400));
      return res.status(r.status).json({ success: false, error: data.errorMessages?.[0] || r.statusText });
    }
    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function escapeTelegramHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

app.post("/api/share/telegram", async (req, res) => {
  try {
    const { chatId, text, title } = req.body || {};
    if (!chatId || !text) return res.status(400).json({ success: false, error: "Missing chatId or text" });
    if (!TELEGRAM_BOT_TOKEN) return res.status(400).json({ success: false, error: "TELEGRAM_BOT_TOKEN not set in .env" });
    const subjectPreview = title || (String(text).slice(0, 80) || "Telegram share");
    console.log("[api/share/telegram] sending", { chatId, subject: subjectPreview });
    let chunks = markdownToTelegramChunks(String(text));
    if (title) {
      const prefix = `<b>${escapeTelegramHtml(title)}</b>\n\n`;
      if (chunks.length) chunks[0] = prefix + chunks[0];
      else chunks = [prefix];
    }
    let lastId;
    for (const chunk of chunks) {
      const { ok, data } = await telegramApiSendMessage(chatId, chunk.slice(0, 4096), "HTML");
      if (!ok || !data.ok) {
        console.error("[api/share/telegram] Telegram API error:", data?.description || data?.message || "unknown");
        return res.status(400).json({ success: false, error: data.description || data.message || "Telegram API error" });
      }
      lastId = data.result?.message_id;
    }
    res.json({ success: true, message_id: lastId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

app.post("/api/share/slack", async (req, res) => {
  try {
    const { text, title, channel } = req.body || {};
    if (!text) return res.status(400).json({ success: false, error: "Missing text" });
    const webhookUrl = SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return res.status(400).json({ success: false, error: "SLACK_WEBHOOK_URL not set in .env" });
    const formatted = markdownToSlackPayload(title || "", String(text));
    const preview = String(title ? `${title}\n\n${text}` : text).slice(0, 500);
    const payload = { ...formatted, text: preview };
    if (channel) payload.channel = channel;
    console.log("[api/share/slack] sending", { channel: channel || "default", subject: title || preview.slice(0, 80) });
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.text();
      console.error("[api/share/slack] webhook failed:", r.status, String(err).slice(0, 400));
      return res.status(r.status).json({ success: false, error: err || "Slack webhook failed" });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/share/email", async (req, res) => {
  try {
    const { to, subject, text, title } = req.body || {};
    if (!to || !text) return res.status(400).json({ success: false, error: "Missing to or text" });
    const nodemailer = (await import("nodemailer")).default;
    const transportOpts = {
      host: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.EMAIL_SMTP_PORT) || 587,
      secure: process.env.EMAIL_SECURE === "true",
      auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD } : undefined,
    };
    const transporter = nodemailer.createTransport(transportOpts);
    const md = title ? `## ${title}\n\n${text}` : String(text);
    const bodyText = title ? `${title}\n\n${text}` : text;
    const bodyHtml = markdownToEmailHtml(md);
    console.log("[api/share/email] sending", {
      to,
      subject: subject || "AI Agents Output",
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@local",
      to,
      subject: subject || "AI Agents Output",
      text: bodyText,
      html: bodyHtml,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("[api/share/email] failed:", err.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Score (OpenAI or internal Foundry / LLM gateway) ─────────────────────────
app.post("/api/score", async (req, res) => {
  try {
    const { type, content, title, scoreProvider } = req.body || {};
    if (!type || !content) return res.status(400).json({ success: false, error: "Missing type (prd|uat|brd|jira) or content" });
    const provider = String(scoreProvider || "openai").toLowerCase() === "foundry" ? "foundry" : "openai";
    const docType =
      type === "uat" ? "UAT Signoff" : type === "brd" ? "BRD" : type === "jira" ? "JIRA ticket" : "PRD";
    const systemPrompt = `You are an expert reviewer. Score the following ${docType} document on a scale of 1-10 (10 = excellent). Consider: completeness, clarity, compliance with NPCI/UPI norms, structure, and actionability. Use a score with two decimal places when appropriate (e.g. 9.05). Respond with ONLY a JSON object: { "score": number, "maxScore": 10, "rationale": "2-4 sentence explanation" }. No other text.`;
    const userContent = (title ? `Document: ${title}\n\n` : "") + String(content).slice(0, 12000);
    const combinedUserMessage = `${systemPrompt}\n\n${userContent}`;

    if (provider === "openai") {
      if (!OPENAI_API_KEY) {
        return res.status(400).json({ success: false, error: "OPENAI_API_KEY not set in .env for OpenAI scoring" });
      }
      console.log("[api/score] provider=openai model=", SCORE_MODEL);
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: SCORE_MODEL,
          messages: [{ role: "user", content: combinedUserMessage }],
          max_tokens: 400,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = data?.error?.message || data?.message || `HTTP ${r.status}`;
        console.error("[api/score] OpenAI failed:", r.status, String(msg).slice(0, 400));
        return res.status(r.status || 500).json({ success: false, error: msg || "OpenAI error" });
      }
      if (data.error) return res.status(r.status || 500).json({ success: false, error: data.error.message || "OpenAI error" });
      const raw = data.choices?.[0]?.message?.content || "";
      const result = parseScoreJsonFromModelOutput(raw);
      return res.json({ success: true, scoreProvider: "openai", ...result });
    }

    // Foundry / internal LLM (same gateway style as /api/generate)
    if (!LLM_API_KEY) {
      return res.status(400).json({
        success: false,
        error: "Foundry scoring requires LLM_KEY_API or LLM_API_KEY in .env",
      });
    }
    const foundryUrl = scoreFoundryBaseUrl();
    if (!foundryUrl) {
      return res.status(400).json({
        success: false,
        error: "Set SCORE_LLM_URL or LLM_URL in .env for Foundry scoring",
      });
    }
    const foundryModel = scoreFoundryModel();
    const requestBody = {
      model: foundryModel,
      max_tokens: 400,
      messages: [{ role: "user", content: combinedUserMessage }],
    };
    const doFoundryCall = (authMode) =>
      fetch(foundryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authMode === "x-api-key" ? { "x-api-key": LLM_API_KEY } : { Authorization: `Bearer ${LLM_API_KEY}` }),
        },
        body: JSON.stringify(requestBody),
      });
    console.log("[api/score] provider=foundry url=", foundryUrl, "model=", foundryModel);
    let authMode = "x-api-key";
    let response = await doFoundryCall(authMode);
    if (response.status === 401) {
      authMode = "bearer";
      response = await doFoundryCall(authMode);
    }
    const responseText = await response.text();
    if (!response.ok) {
      console.error("[api/score] Foundry failed:", response.status, responseText.slice(0, 600));
      return res.status(response.status).json({
        success: false,
        error: `Foundry LLM error (${response.status}): ${responseText.slice(0, 200).replace(/\s+/g, " ")}`,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      console.error("[api/score] Foundry invalid JSON:", responseText.slice(0, 300));
      return res.status(500).json({ success: false, error: "Invalid JSON from Foundry scoring gateway" });
    }
    const root = parsed && typeof parsed === "object" && parsed.data != null ? parsed.data : parsed;
    const rawText = extractAssistantTextFromLlmPayload(root) || extractAssistantTextFromLlmPayload(parsed);
    if (!rawText.trim()) {
      console.error("[api/score] Foundry empty assistant text:", JSON.stringify(parsed).slice(0, 500));
      return res.status(500).json({ success: false, error: "Could not read model text from Foundry response" });
    }
    const result = parseScoreJsonFromModelOutput(rawText);
    return res.json({ success: true, scoreProvider: "foundry", ...result });
  } catch (err) {
    console.error("[api/score] exception:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Completion notification (Email + Slack/WhatsApp) ─────────────────────────
app.post("/api/notify/complete", async (req, res) => {
  try {
    const { agentName, identifier, notifySubject } = req.body || {};
    if (!agentName || !identifier) return res.status(400).json({ success: false, error: "Missing agentName or identifier" });
    const subject =
      notifySubject && String(notifySubject).trim()
        ? String(notifySubject).trim()
        : `${agentName} — ${identifier} is done`;
    const body = `${subject}\n\nGenerated at ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
    const results = [];
    console.log("[api/notify/complete] sending completion notification", { agentName, identifier, subject });

    // Email
    const emailTo = process.env.NOTIFY_EMAIL || process.env.EMAIL_USER || "";
    if (emailTo && (process.env.EMAIL_SMTP_HOST || process.env.EMAIL_USER)) {
      try {
        const nodemailer = (await import("nodemailer")).default;
        const transportOpts = {
          host: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
          port: Number(process.env.EMAIL_SMTP_PORT) || 587,
          secure: process.env.EMAIL_SECURE === "true",
          auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD } : undefined,
        };
        const transporter = nodemailer.createTransport(transportOpts);
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@local",
          to: emailTo,
          subject,
          text: body,
        });
        results.push("email:ok");
      } catch (e) {
        console.error("[api/notify/complete] email failed:", e.message || e);
        results.push("email:" + e.message);
      }
    }

    // Slack
    const slackUrl = process.env.SLACK_WEBHOOK_URL || "";
    if (slackUrl) {
      try {
        const r = await fetch(slackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: subject }),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error("[api/notify/complete] slack failed:", r.status, String(txt).slice(0, 300));
        }
        results.push(r.ok ? "slack:ok" : "slack:failed");
      } catch (e) {
        console.error("[api/notify/complete] slack exception:", e.message || e);
        results.push("slack:" + e.message);
      }
    }

    // WhatsApp (Meta Business API)
    const waToken = process.env.WHATSAPP_TOKEN || "";
    const waPhoneId = process.env.WHATSAPP_PHONE_ID || "";
    const waRecipient = process.env.WHATSAPP_NOTIFY_NUMBER || process.env.WHATSAPP_RECIPIENT || "";
    if (waToken && waPhoneId && waRecipient) {
      try {
        const r = await fetch(`https://graph.facebook.com/v18.0/${waPhoneId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${waToken}` },
          body: JSON.stringify({ messaging_product: "whatsapp", to: waRecipient, type: "text", text: { body: subject } }),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error("[api/notify/complete] whatsapp failed:", r.status, String(txt).slice(0, 300));
        }
        results.push(r.ok ? "whatsapp:ok" : "whatsapp:failed");
      } catch (e) {
        console.error("[api/notify/complete] whatsapp exception:", e.message || e);
        results.push("whatsapp:" + e.message);
      }
    }

    // Telegram
    if (TELEGRAM_BOT_TOKEN) {
      const tgChatId = process.env.TELEGRAM_NOTIFY_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
      if (tgChatId) {
        try {
          const { ok, data } = await telegramApiSendMessage(tgChatId, `<b>${escapeTelegramHtml(subject)}</b>`, "HTML");
          if (!ok || !data?.ok) {
            console.error(
              "[api/notify/complete] telegram failed:",
              data?.description || data?.message || "unknown error"
            );
          }
          results.push(ok && data.ok ? "telegram:ok" : "telegram:failed");
        } catch (e) {
          console.error("[api/notify/complete] telegram exception:", e.message || e);
          results.push("telegram:" + e.message);
        }
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Analyst Agent: optional Email / Slack / JIRA with full body (input + SQL + output) ──
app.post("/api/notify/analyst", async (req, res) => {
  try {
    const { subject, body: bodyRaw, channels = {}, jiraIssueKey, jiraSite, jiraBaseUrl } = req.body || {};
    const subj = String(subject || "Analyst Agent").trim().slice(0, 500);
    const text = String(bodyRaw || "").trim();
    if (!text) return res.status(400).json({ success: false, error: "body is required" });
    const wantsEmail = Boolean(channels.email);
    const wantsSlack = Boolean(channels.slack);
    const wantsJira = Boolean(channels.jira);
    if (!wantsEmail && !wantsSlack && !wantsJira) {
      return res.status(400).json({ success: false, error: "Select at least one channel (email, slack, jira)" });
    }
    if (wantsJira) {
      const key = String(jiraIssueKey || "").trim();
      if (!key) return res.status(400).json({ success: false, error: "jiraIssueKey is required when JIRA is selected" });
    }
    const results = [];
    const stamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const fullEmailBody = `${subj}\n\n${text}\n\n— ${stamp}`;

    if (wantsEmail) {
      const emailTo = process.env.NOTIFY_EMAIL || process.env.EMAIL_USER || "";
      if (!emailTo || !(process.env.EMAIL_SMTP_HOST || process.env.EMAIL_USER)) {
        results.push("email:skipped_not_configured");
      } else {
        try {
          const nodemailer = (await import("nodemailer")).default;
          const transportOpts = {
            host: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
            port: Number(process.env.EMAIL_SMTP_PORT) || 587,
            secure: process.env.EMAIL_SECURE === "true",
            auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS || process.env.EMAIL_PASSWORD } : undefined,
          };
          const transporter = nodemailer.createTransport(transportOpts);
          await transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@local",
            to: emailTo,
            subject: subj,
            text: fullEmailBody,
          });
          results.push("email:ok");
        } catch (e) {
          console.error("[api/notify/analyst] email failed:", e.message || e);
          results.push("email:" + (e.message || String(e)));
        }
      }
    }

    if (wantsSlack) {
      const slackUrl = process.env.SLACK_WEBHOOK_URL || "";
      if (!slackUrl) {
        results.push("slack:skipped_not_configured");
      } else {
        try {
          const slackBody = `*${subj.replace(/\*/g, "")}*\n\n${text}`;
          const chunkSize = 3500;
          let slackOk = true;
          for (let i = 0; i < slackBody.length; i += chunkSize) {
            const chunk = slackBody.slice(i, i + chunkSize);
            const r = await fetch(slackUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: chunk }),
            });
            if (!r.ok) {
              const txt = await r.text().catch(() => "");
              console.error("[api/notify/analyst] slack failed:", r.status, String(txt).slice(0, 300));
              slackOk = false;
              results.push("slack:failed");
              break;
            }
          }
          if (slackOk) results.push("slack:ok");
        } catch (e) {
          console.error("[api/notify/analyst] slack exception:", e.message || e);
          results.push("slack:" + (e.message || String(e)));
        }
      }
    }

    if (wantsJira) {
      const key = String(jiraIssueKey).toUpperCase().replace(/\s/g, "");
      if (!listConfiguredJiraBases().length || !JIRA_EMAIL || !JIRA_TOKEN) {
        results.push("jira:skipped_not_configured");
      } else {
        try {
          let jiraBase;
          try {
            jiraBase = resolveJiraBaseFromIssueKey(key, { jiraSite, jiraBaseUrl });
          } catch (e) {
            results.push("jira:" + (e.message || "resolve_failed"));
            jiraBase = null;
          }
          if (!jiraBase) {
            /* already pushed error */
          } else {
            const md = `## ${subj}\n\n${text}\n\n_${stamp}_`;
            const commentUrl = `${jiraBase}/rest/api/3/issue/${key}/comment`;
            const r = await fetch(commentUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: jiraAuthHeader(),
              },
              body: JSON.stringify(markdownToJiraAdf(md)),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
              console.error("[api/notify/analyst] jira failed:", data.errorMessages?.[0] || r.statusText);
              results.push("jira:failed");
            } else {
              results.push("jira:ok");
            }
          }
        } catch (e) {
          console.error("[api/notify/analyst] jira exception:", e.message || e);
          results.push("jira:" + (e.message || String(e)));
        }
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Production: serve frontend build from parent directory (single deploy)
const buildPath = path.join(__dirname, "..", "build");
if (NODE_ENV === "production" && fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(buildPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`AI agents backend (ai-agents-backend) running on port ${PORT} [${NODE_ENV}]`);
  void runBedrockReadinessProbe();
  void runNonBedrockLlmProbes();
});
