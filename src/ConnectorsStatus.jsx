import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config.js";
import {
  AGENT_LOCAL_STORAGE_KEYS,
  applyAgentLocalStorageImport,
  downloadAgentBackupJson,
} from "./agentStorageBackup.js";

const PUBLISH_DEFAULTS_KEY = "publish-defaults-v1";
const PUBLISH_DEFAULTS_EMPTY = {
  jiraKey: "",
  telegramChatId: "",
  emailTo: "",
  /** Short JIRA project key for JIRA Agent default (e.g. TSP). */
  jiraDefaultProjectKey: "",
  /** Email, display name, or Atlassian accountId — sent as Dev Assignee on create. */
  jiraDevAssignee: "",
  /** auto | primary | secondary — default Atlassian site for fetch / create / Share when the issue key has no URL. */
  jiraWriteSite: "auto",
  /** openai | foundry — which backend Share & Score uses for Get score */
  scoreProvider: "openai",
  /**
   * auto | aws | openai | foundry | off — routing for agent generation calls.
   * auto = Bedrock → Foundry → OpenAI fallback.
   */
  llmProvider: "auto",
  /** Allow disabling individual providers even when mode is auto. */
  llmDisabled: { aws: false, foundry: false, openai: false },
  /** Optional override for OpenAI chat model when routing uses OpenAI (empty = server default). */
  openaiModel: "",
  /**
   * Per–Foundry-model enable (key = id from /api/foundry-models). Omitted / empty = all enabled.
   * @type {Record<string, boolean> | undefined}
   */
  foundryModelsEnabled: undefined,
  /** sonnet | opus | haiku — Bedrock model family when LLM provider is AWS (maps to inference profile IDs on the server). */
  bedrockModelTier: "sonnet",
};
function loadPublishDefaults() {
  try {
    const raw = localStorage.getItem(PUBLISH_DEFAULTS_KEY);
    if (!raw) return { ...PUBLISH_DEFAULTS_EMPTY };
    const parsed = JSON.parse(raw);
    return {
      ...PUBLISH_DEFAULTS_EMPTY,
      ...parsed,
      llmDisabled: { ...PUBLISH_DEFAULTS_EMPTY.llmDisabled, ...(parsed.llmDisabled || {}) },
    };
  } catch {
    return { ...PUBLISH_DEFAULTS_EMPTY };
  }
}
function savePublishDefaults(d) {
  try {
    localStorage.setItem(PUBLISH_DEFAULTS_KEY, JSON.stringify(d));
    window.dispatchEvent(new CustomEvent("publish-defaults-changed", { detail: d }));
  } catch {}
}

/** Sync default JIRA issue key (Connectors → Publish) from agent connector field or fetched key. */
export function syncPublishDefaultJiraKey(keyOrText) {
  const raw = (keyOrText || "").trim();
  if (!raw) return;
  const m = raw.match(/\b([A-Z][A-Z0-9]*-\d+)\b/i);
  const key = m ? m[1].toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) return;
  const cur = loadPublishDefaults();
  savePublishDefaults({ ...cur, jiraKey: key });
}

/** After JIRA fetch — remember which site the issue lives on for Share / creates. */
export function syncPublishJiraSiteFromIssue(d) {
  if (!d?.jiraSite) return;
  if (d.jiraSite !== "secondary" && d.jiraSite !== "primary") return;
  const cur = loadPublishDefaults();
  savePublishDefaults({ ...cur, jiraWriteSite: d.jiraSite });
}

/** Current LLM routing for /api/generate (browser default from Connectors). */
export function getLlmProviderForRequest() {
  const d = loadPublishDefaults();
  const v = String(d.llmProvider || "auto").toLowerCase();
  if (v === "foundry") return "foundry";
  if (v === "openai") return "openai";
  if (v === "aws") return "aws";
  if (v === "anthropic") return "anthropic";
  if (v === "off") return "off";
  return "auto";
}

export function getLlmDisabledForRequest() {
  const d = loadPublishDefaults();
  const x = d?.llmDisabled;
  return {
    aws: Boolean(x?.aws),
    foundry: Boolean(x?.foundry),
    openai: Boolean(x?.openai),
  };
}

/** Extra fields for POST /api/generate (Foundry model toggles, OpenAI model override). */
export function getLlmRoutingExtras() {
  const d = loadPublishDefaults();
  const out = {};
  if (d.foundryModelsEnabled && typeof d.foundryModelsEnabled === "object") {
    out.foundryModelsEnabled = d.foundryModelsEnabled;
  }
  if (d.openaiModel && String(d.openaiModel).trim()) {
    out.openaiModel = String(d.openaiModel).trim();
  }
  return out;
}

/** Bedrock model tier for /api/generate when LLM provider is AWS. */
export function getBedrockModelTierForRequest() {
  const d = loadPublishDefaults();
  const t = String(d.bedrockModelTier || "sonnet").toLowerCase();
  if (t === "opus" || t === "haiku") return t;
  return "sonnet";
}

export { loadPublishDefaults, savePublishDefaults, PUBLISH_DEFAULTS_KEY, PUBLISH_DEFAULTS_EMPTY };

const CONNECTOR_LIST = [
  { id: "jira", label: "JIRA", icon: "J", color: "#0052CC", envHint: "JIRA_URL, JIRA_EMAIL, JIRA_TOKEN" },
  { id: "slack", label: "Slack", icon: "S", color: "#4A154B", envHint: "SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL" },
  { id: "whatsapp", label: "WhatsApp", icon: "W", color: "#25D366", envHint: "WHATSAPP_TOKEN, WHATSAPP_PHONE_ID" },
  { id: "email", label: "Email", icon: "E", color: "#EA4335", envHint: "EMAIL_SMTP_HOST or EMAIL_API_KEY" },
  { id: "telegram", label: "Telegram", icon: "T", color: "#0088CC", envHint: "TELEGRAM_BOT_TOKEN" },
];

export default function ConnectorsStatus() {
  const [status, setStatus] = useState({
    jira: false,
    slack: false,
    whatsapp: false,
    email: false,
    telegram: false,
    llmBedrockConfigured: false,
    llmFoundryConfigured: false,
    llmOpenAiConfigured: false,
    llmAnthropicConfigured: false,
    llmProviders: [],
  });
  const [open, setOpen] = useState(false);
  const [jiraTestResult, setJiraTestResult] = useState("");
  const [jiraTestLoading, setJiraTestLoading] = useState(false);
  const [publishDefaults, setPublishDefaults] = useState(() => loadPublishDefaults());
  useEffect(() => {
    if (open) {
      setPublishDefaults(loadPublishDefaults());
      fetch(`${API_BASE}/api/llm-usage-daily?days=8`)
        .then((r) => r.json())
        .then((d) => {
          if (d.success) setLlmUsageDaily(d);
        })
        .catch(() => setLlmUsageDaily(null));
      fetch(`${API_BASE}/api/foundry-models`)
        .then((r) => r.json())
        .then((d) => {
          if (d.success && Array.isArray(d.models)) setFoundryModelRows(d.models);
        })
        .catch(() => setFoundryModelRows([]));
    }
  }, [open]);
  const [publishSaved, setPublishSaved] = useState(false);
  const [llmProbeLoading, setLlmProbeLoading] = useState(false);
  const [backendUnreachable, setBackendUnreachable] = useState(false);
  const [backupMsg, setBackupMsg] = useState("");
  const importFileRef = useRef(null);
  const [llmUsageDaily, setLlmUsageDaily] = useState(null);
  const [foundryModelRows, setFoundryModelRows] = useState([]);

  const fetchStatus = useCallback(() => {
    fetch(`${API_BASE}/api/connectors/status`)
      .then((r) => {
        setBackendUnreachable(!r.ok);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setStatus(data))
      .catch(() => {
        setBackendUnreachable(true);
      });
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const refreshLlmProbes = async () => {
    setLlmProbeLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/connectors/llm-probes`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (d.success && Array.isArray(d.llmProviders)) {
        setStatus((prev) => ({ ...prev, llmProviders: d.llmProviders }));
      } else {
        fetchStatus();
      }
    } catch {
      fetchStatus();
    }
    setLlmProbeLoading(false);
  };

  const testJira = async () => {
    setJiraTestLoading(true); setJiraTestResult("");
    try {
      const r = await fetch(`${API_BASE}/api/jira-test`);
      const d = await r.json();
      if (d.ok && Array.isArray(d.sites) && d.sites.length) {
        const lines = d.sites.map((s) => `${s.label || s.id}: ${s.ok ? `✓ ${s.user || "OK"}` : `✗ ${s.error || "fail"}`}`);
        setJiraTestResult(lines.join("\n"));
      } else if (d.ok) setJiraTestResult(`Connected as ${d.user}`);
      else setJiraTestResult(d.error || "Connection failed");
    } catch (e) { setJiraTestResult("Server error: " + e.message); }
    setJiraTestLoading(false);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
        style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "4px 10px", borderRadius: 10, background: "#0f172a", border: "1px solid #1e293b", cursor: "pointer" }}
        title="Open Connector Settings"
      >
        <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>Connectors</span>

          {/* This line is commented */}
  {/*
       <span style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 260 }}>
          {connectorNames}
        </span>
   
        <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 600 }}>{connectedCount} connected</span>
        <span style={{ fontSize: 10, color: "#64748b" }}>
          · {connectedCount}/{totalCount} · Click to enable others
        </span>

        */}
        
        <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "#93c5fd" }}>Know more →</span>
      </div>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9998 }} />
          <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 520, maxHeight: "80vh", overflow: "auto", background: "#0f172a", border: "1px solid #1e293b", borderRadius: 16, zIndex: 9999, padding: 28, fontFamily: "'Segoe UI', sans-serif", color: "#e2e8f0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Connector Settings</div>
              <button type="button" onClick={() => setOpen(false)} style={{ background: "#1e293b", border: "none", borderRadius: 8, width: 30, height: 30, color: "#94a3b8", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>x</button>
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 20, lineHeight: 1.6 }}>
              Connectors are configured via environment variables in your <code style={{ background: "#1e293b", padding: "2px 6px", borderRadius: 4, color: "#93c5fd" }}>.env</code> file. Restart the server after making changes.
            </div>

            {backendUnreachable ? (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderRadius: 10,
                  border: "1px solid #7f1d1d",
                  background: "rgba(69, 10, 10, 0.5)",
                  color: "#fecaca",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <strong style={{ color: "#fff" }}>Cannot reach API</strong> at{" "}
                <code style={{ color: "#fde68a" }}>{API_BASE || "(see REACT_APP_API_URL)"}</code>. Start the backend:{" "}
                <code style={{ color: "#a7f3d0" }}>npm run start:backend</code> or <code style={{ color: "#a7f3d0" }}>npm run dev</code>.
              </div>
            ) : null}

            <div style={{ marginBottom: 16, padding: 14, background: "#1e293b", borderRadius: 12, border: "1px solid #334155" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>
                PRD / UAT / BRD / JIRA — browser history
              </div>
              <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 10px", lineHeight: 1.5 }}>
                History is stored in <strong style={{ color: "#94a3b8" }}>localStorage</strong> for this site only.{" "}
                <code style={{ color: "#93c5fd" }}>localhost</code> and <code style={{ color: "#93c5fd" }}>127.0.0.1</code> are{" "}
                <strong>different</strong> — opening the app on a new URL looks like an empty history. Export from the old URL and import here to restore.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => {
                    setBackupMsg("");
                    try {
                      downloadAgentBackupJson();
                      setBackupMsg("Download started (JSON file).");
                    } catch (e) {
                      setBackupMsg(String(e?.message || e));
                    }
                  }}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: "1px solid #475569",
                    background: "#0f172a",
                    color: "#93c5fd",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Export history (download JSON)
                </button>
                <button
                  type="button"
                  onClick={() => importFileRef.current?.click()}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: "1px solid #475569",
                    background: "#0f172a",
                    color: "#a7f3d0",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Import history…
                </button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  onChange={async (ev) => {
                    const f = ev.target.files?.[0];
                    ev.target.value = "";
                    if (!f) return;
                    setBackupMsg("Reading…");
                    try {
                      const text = await f.text();
                      const data = JSON.parse(text);
                      const n = applyAgentLocalStorageImport(data);
                      setBackupMsg(`Imported ${n} key(s). Reloading…`);
                      try {
                        window.dispatchEvent(
                          new CustomEvent("agent-localstorage-imported", { detail: { keys: AGENT_LOCAL_STORAGE_KEYS } }),
                        );
                        window.dispatchEvent(new CustomEvent("publish-defaults-changed", { detail: loadPublishDefaults() }));
                      } catch {
                        /* ignore */
                      }
                      setTimeout(() => window.location.reload(), 400);
                    } catch (e) {
                      setBackupMsg(`Import failed: ${e?.message || e}`);
                    }
                  }}
                />
              </div>
              <p style={{ fontSize: 10, color: "#64748b", margin: "8px 0 0" }}>
                Keys: {AGENT_LOCAL_STORAGE_KEYS.join(", ")}
              </p>
              {backupMsg ? (
                <p style={{ fontSize: 11, color: "#a7f3d0", margin: "8px 0 0" }}>{backupMsg}</p>
              ) : null}
            </div>

            <div style={{ marginBottom: 16, padding: 14, background: "#1e293b", borderRadius: 12, border: "1px solid #334155" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>LLM backends (health)</div>
                <button
                  type="button"
                  onClick={() => refreshLlmProbes()}
                  disabled={llmProbeLoading}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "1px solid #475569",
                    background: "#0f172a",
                    color: llmProbeLoading ? "#64748b" : "#93c5fd",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: llmProbeLoading ? "default" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {llmProbeLoading ? "Checking…" : "Refresh probes"}
                </button>
              </div>
              <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 10px", lineHeight: 1.5 }}>
                Startup and on-demand checks: <strong style={{ color: "#94a3b8" }}>Bedrock</strong>,{" "}
                <strong style={{ color: "#94a3b8" }}>Foundry</strong>, <strong style={{ color: "#94a3b8" }}>OpenAI</strong> (Share &amp; Score),{" "}
                <strong style={{ color: "#94a3b8" }}>Gemini</strong> (optional),{" "}
                <strong style={{ color: "#c4b5fd" }}>Anthropic</strong> (set <code style={{ color: "#94a3b8" }}>ANTHROPIC_API_KEY</code> in .env or shell).
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(Array.isArray(status.llmProviders) ? status.llmProviders : []).map((p) => {
                  const configured = !!p.configured;
                  const pending = configured && p.ok === null;
                  const ok = p.ok === true;
                  const label = p.label || p.id;
                  const err = (p.error || "").trim();
                  let line = "";
                  if (!configured) line = "Not configured";
                  else if (pending) line = "Checking…";
                  else if (ok) line = "Working";
                  else line = err || "Not working";
                  return (
                    <div
                      key={p.id || label}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "#0f172a",
                        border: "1px solid #334155",
                        fontSize: 11,
                      }}
                    >
                      <span style={{ fontWeight: 600, color: "#e2e8f0", minWidth: 100 }}>{label}</span>
                      <span
                        style={{
                          flex: 1,
                          textAlign: "right",
                          color: !configured ? "#94a3b8" : pending ? "#94a3b8" : ok ? "#22c55e" : "#f87171",
                          wordBreak: "break-word",
                        }}
                      >
                        {line}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ marginBottom: 16, padding: 14, background: "#1e293b", borderRadius: 12, border: "1px solid #334155" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>LLM usage by agent (UTC day)</div>
              <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 8px", lineHeight: 1.45 }}>
                Calls and token counts per agent label (PRD, BRD, JIRA, UAT, ANALYST) are recorded on the server in <code style={{ color: "#94a3b8" }}>backend/data/llm-usage-daily.json</code>. OpenAI and Foundry return usage when the API includes it; Bedrock returns tokens from Converse when available.
              </p>
              {llmUsageDaily && llmUsageDaily.days ? (
                <div style={{ maxHeight: 220, overflow: "auto", fontSize: 10, color: "#cbd5e1", lineHeight: 1.5 }}>
                  {Object.keys(llmUsageDaily.days)
                    .sort()
                    .reverse()
                    .map((day) => {
                      const byAgent = llmUsageDaily.days[day] || {};
                      const parts = Object.keys(byAgent);
                      if (!parts.length) {
                        return (
                          <div key={day} style={{ marginBottom: 6, opacity: 0.6 }}>
                            {day}: (no data)
                          </div>
                        );
                      }
                      return (
                        <div key={day} style={{ marginBottom: 10 }}>
                          <div style={{ fontWeight: 700, color: "#fbbf24", marginBottom: 2 }}>{day}</div>
                          {parts.map((ag) => (
                            <div key={ag} style={{ marginLeft: 8, marginBottom: 4 }}>
                              <span style={{ color: "#93c5fd" }}>{ag}</span>
                              {Object.entries(byAgent[ag] || {}).map(([prov, rec]) => (
                                <span key={prov} style={{ marginLeft: 8 }}>
                                  {prov}: {rec.calls} calls, {rec.promptTokens} prompt + {rec.completionTokens} completion tok
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: "#64748b" }}>Open Connectors to load usage, or start the backend.</div>
              )}
            </div>

            <div style={{ marginBottom: 16, padding: 14, background: "#1e293b", borderRadius: 12, border: "1px solid #334155" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>LLM routing (all agents)</div>
              <p style={{ fontSize: 11, color: "#64748b", margin: "0 0 10px", lineHeight: 1.5 }}>
                <strong style={{ color: "#93c5fd" }}>Auto</strong> tries <strong>AWS Bedrock</strong>, then <strong>Foundry</strong>, then <strong>OpenAI</strong>, then <strong>Anthropic</strong> (skips any provider you disabled). Each agent sends an <code style={{ color: "#94a3b8" }}>agent</code> label for usage. Saved in this browser.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "auto" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: (String(publishDefaults.llmProvider || "auto") === "auto" ? "#f59e0b" : "#334155") + " 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "auto" ? "#f59e0b22" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "auto" ? "#fbbf24" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Auto (Bedrock → Foundry → OpenAI → Anthropic)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "aws" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: String(publishDefaults.llmProvider || "auto") === "aws" ? "#38bdf8 1px solid" : "#334155 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "aws" ? "#38bdf822" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "aws" ? "#7dd3fc" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Bedrock only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "openai" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: String(publishDefaults.llmProvider || "auto") === "openai" ? "#10b981 1px solid" : "#334155 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "openai" ? "#10b98122" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "openai" ? "#6ee7b7" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  OpenAI only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "foundry" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: String(publishDefaults.llmProvider || "auto") === "foundry" ? "#38bdf8 1px solid" : "#334155 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "foundry" ? "#38bdf822" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "foundry" ? "#7dd3fc" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Foundry only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "anthropic" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: String(publishDefaults.llmProvider || "auto") === "anthropic" ? "#a78bfa 1px solid" : "#334155 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "anthropic" ? "#a78bfa22" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "anthropic" ? "#c4b5fd" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Anthropic only
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...loadPublishDefaults(), llmProvider: "off" };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: String(publishDefaults.llmProvider || "auto") === "off" ? "#f87171 1px solid" : "#334155 1px solid",
                    background: String(publishDefaults.llmProvider || "auto") === "off" ? "#f8717122" : "#0f172a",
                    color: String(publishDefaults.llmProvider || "auto") === "off" ? "#fecaca" : "#94a3b8",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  LLM off
                </button>
                <span style={{ fontSize: 10, color: "#64748b", flex: "1 1 200px" }}>
                  Bedrock: {status.llmBedrockConfigured ? <span style={{ color: "#22c55e" }}>env OK</span> : <span style={{ color: "#f87171" }}>not linked</span>}
                  {" · "}
                  OpenAI: {status.llmOpenAiConfigured ? <span style={{ color: "#22c55e" }}>env OK</span> : <span style={{ color: "#f87171" }}>not linked</span>}
                  {" · "}
                  Foundry: {status.llmFoundryConfigured ? <span style={{ color: "#22c55e" }}>env OK</span> : <span style={{ color: "#f87171" }}>not linked</span>}
                  {" · "}
                  Anthropic: {status.llmAnthropicConfigured ? <span style={{ color: "#22c55e" }}>env OK</span> : <span style={{ color: "#f87171" }}>not linked</span>}
                </span>
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
                  <input
                    type="checkbox"
                    checked={!!publishDefaults.llmDisabled?.aws}
                    onChange={(e) => {
                      const next = { ...loadPublishDefaults(), llmDisabled: { ...(loadPublishDefaults().llmDisabled || {}), aws: e.target.checked } };
                      savePublishDefaults(next);
                      setPublishDefaults(next);
                    }}
                  />
                  Disable Bedrock
                </label>
                <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
                  <input
                    type="checkbox"
                    checked={!!publishDefaults.llmDisabled?.openai}
                    onChange={(e) => {
                      const next = { ...loadPublishDefaults(), llmDisabled: { ...(loadPublishDefaults().llmDisabled || {}), openai: e.target.checked } };
                      savePublishDefaults(next);
                      setPublishDefaults(next);
                    }}
                  />
                  Disable OpenAI
                </label>
                <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: 11, color: "#94a3b8" }}>
                  <input
                    type="checkbox"
                    checked={!!publishDefaults.llmDisabled?.foundry}
                    onChange={(e) => {
                      const next = { ...loadPublishDefaults(), llmDisabled: { ...(loadPublishDefaults().llmDisabled || {}), foundry: e.target.checked } };
                      savePublishDefaults(next);
                      setPublishDefaults(next);
                    }}
                  />
                  Disable Foundry
                </label>
              </div>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #334155" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", marginBottom: 4 }}>OpenAI model (optional)</div>
                <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 6px", lineHeight: 1.45 }}>
                  When routing uses OpenAI, this is sent as the chat model (otherwise server uses OPENAI_ROUTING_MODEL / OPENAI_MODEL).
                </p>
                <input
                  type="text"
                  value={publishDefaults.openaiModel || ""}
                  onChange={(e) => {
                    const next = { ...loadPublishDefaults(), openaiModel: e.target.value };
                    savePublishDefaults(next);
                    setPublishDefaults(next);
                  }}
                  placeholder="e.g. gpt-4o-mini"
                  style={{ width: "100%", maxWidth: 360, padding: "6px 10px", borderRadius: 8, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", fontSize: 12, fontFamily: "inherit" }}
                />
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #334155" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", marginBottom: 6 }}>Bedrock model (when AWS is selected)</div>
                <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 8px", lineHeight: 1.45 }}>
                  Chooses the on‑prem/gateway or native Bedrock model id for Sonnet, Opus, or Haiku. Saved in this browser.
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {[
                    { id: "sonnet", label: "Sonnet" },
                    { id: "opus", label: "Opus" },
                    { id: "haiku", label: "Haiku" },
                  ].map(({ id, label }) => {
                    const active = (publishDefaults.bedrockModelTier || "sonnet") === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          const next = { ...loadPublishDefaults(), bedrockModelTier: id };
                          savePublishDefaults(next);
                          setPublishDefaults(next);
                        }}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: active ? "#f59e0b 1px solid" : "#334155 1px solid",
                          background: active ? "#f59e0b22" : "#0f172a",
                          color: active ? "#fbbf24" : "#94a3b8",
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #334155" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#e2e8f0", marginBottom: 4 }}>Foundry models (LLM_MODEL per call)</div>
                <p style={{ fontSize: 10, color: "#64748b", margin: "0 0 8px", lineHeight: 1.45 }}>
                  When Foundry is used, requests are tried in list order; the first model that succeeds wins. If your catalog uses longer names than the defaults, edit <code style={{ color: "#94a3b8" }}>config/foundry-models.json</code> on the server.
                </p>
                <div style={{ maxHeight: 160, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {foundryModelRows.map((row) => {
                    const en = (publishDefaults.foundryModelsEnabled && typeof publishDefaults.foundryModelsEnabled === "object" ? publishDefaults.foundryModelsEnabled : {}) || {};
                    const on = en[String(row.id)] !== false;
                    return (
                      <label
                        key={row.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: "#94a3b8", cursor: "pointer" }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const cur = loadPublishDefaults();
                            const nextMap = { ...(cur.foundryModelsEnabled && typeof cur.foundryModelsEnabled === "object" ? cur.foundryModelsEnabled : {}) };
                            nextMap[String(row.id)] = e.target.checked;
                            const next = { ...cur, foundryModelsEnabled: nextMap };
                            savePublishDefaults(next);
                            setPublishDefaults(next);
                          }}
                        />
                        <span style={{ color: "#e2e8f0", fontFamily: "ui-monospace, monospace" }}>{row.llmModel}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            {CONNECTOR_LIST.map(({ id, label, icon, color, envHint }) => (
              <div key={id} style={{ background: "#1e293b", borderRadius: 12, padding: 16, marginBottom: 12, border: `1px solid ${status[id] ? `${color}44` : "#334155"}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: `${color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color }}>
                    {icon}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: status[id] ? "#22c55e" : "#f87171", background: status[id] ? "#22c55e18" : "#f8717118", padding: "3px 10px", borderRadius: 12 }}>
                    {status[id] ? "Linked" : "Not Linked"}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>
                  Required env vars: <code style={{ background: "#0f172a", padding: "2px 6px", borderRadius: 4, color: "#93c5fd" }}>{envHint}</code>
                </div>
                {id === "jira" && (
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                    <button type="button" onClick={testJira} disabled={jiraTestLoading || !status.jira} style={{ background: status.jira ? "#0052CC22" : "#1e293b", border: `1px solid ${status.jira ? "#0052CC66" : "#334155"}`, borderRadius: 8, padding: "6px 14px", color: status.jira ? "#0052CC" : "#64748b", fontSize: 11, fontWeight: 600, cursor: status.jira && !jiraTestLoading ? "pointer" : "not-allowed", fontFamily: "inherit" }}>
                      {jiraTestLoading ? "Testing..." : "Test Connection"}
                    </button>
                    {jiraTestResult && (
                      <span style={{ fontSize: 11, color: jiraTestResult.startsWith("Connected") ? "#22c55e" : "#f87171" }}>
                        {jiraTestResult}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}

            <div style={{ marginTop: 16, padding: 14, background: "#1e293b", borderRadius: 10, border: "1px solid #334155" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#f59e0b", marginBottom: 6 }}>Example .env configuration</div>
              <pre style={{ fontSize: 11, color: "#94a3b8", margin: 0, lineHeight: 1.8, fontFamily: "monospace", whiteSpace: "pre-wrap" }}>{`# JIRA
JIRA_URL=https://yourcompany.atlassian.net
# Second site (TPAP / mypaytm) — same email & token
# JIRA_URL_2=https://mypaytm.atlassian.net
# Projects that live on JIRA_URL_2 (comma-separated):
# JIRA_SECONDARY_PROJECT_KEYS=TPAP,PCO,TPG
JIRA_EMAIL=you@company.com
JIRA_TOKEN=ATATT3x...
# Optional — Dev Assignee custom field on create (see .env.example)
# JIRA_DEV_ASSIGNEE_FIELD_ID=customfield_10236
# JIRA_DEV_ASSIGNEE=you@company.com
# JIRA_DEV_ASSIGNEE_SINGLE_USER_OBJECT=true   # only if your field is single-user, not multi-user

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# WhatsApp (Meta Business API)
WHATSAPP_TOKEN=EAAx...
WHATSAPP_PHONE_ID=123456789

# Email (SMTP)
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_API_KEY=your-api-key

# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...`}</pre>
            </div>

            <div style={{ marginTop: 16, padding: 14, background: "#1e293b", borderRadius: 10, border: "1px solid #334155" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#22c55e", marginBottom: 8 }}>Default publish destinations</div>
              <p style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>Set these to use &quot;Publish&quot; on the final screen without typing each time (saved in browser).</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>Default JIRA issue key</label>
                  <input
                    type="text"
                    placeholder="e.g. TSP-1889"
                    value={publishDefaults.jiraKey}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, jiraKey: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>Default JIRA site (fetch / Share / agents)</label>
                  <select
                    value={["auto", "primary", "secondary"].includes(publishDefaults.jiraWriteSite) ? publishDefaults.jiraWriteSite : "auto"}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, jiraWriteSite: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  >
                    <option value="auto">Auto — use project key (TPAP, PCO, TPG → JIRA_URL_2) or try primary first on fetch</option>
                    <option value="primary">Always primary (JIRA_URL)</option>
                    <option value="secondary">Always secondary (JIRA_URL_2)</option>
                  </select>
                  <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>Paste a full browse URL anytime — the correct site is detected from the link.</div>
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>JIRA Agent — default project key</label>
                  <input
                    type="text"
                    placeholder="e.g. TSP (not the full project name)"
                    value={publishDefaults.jiraDefaultProjectKey || ""}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, jiraDefaultProjectKey: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>JIRA Agent — Dev assignee on create</label>
                  <input
                    type="text"
                    placeholder="Email, name, or Atlassian accountId (UUID)"
                    value={publishDefaults.jiraDevAssignee || ""}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, jiraDevAssignee: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>Default Telegram chat ID</label>
                  <input
                    type="text"
                    placeholder="e.g. -1001234567890"
                    value={publishDefaults.telegramChatId}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, telegramChatId: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 10, color: "#94a3b8", display: "block", marginBottom: 4 }}>Default email (to)</label>
                  <input
                    type="text"
                    placeholder="e.g. team@company.com"
                    value={publishDefaults.emailTo}
                    onChange={(e) => setPublishDefaults((p) => ({ ...p, emailTo: e.target.value }))}
                    style={{ width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#e2e8f0", fontSize: 12 }}
                  />
                </div>
                <button type="button" onClick={() => { savePublishDefaults(publishDefaults); setPublishSaved(true); setTimeout(() => setPublishSaved(false), 1500); }} style={{ alignSelf: "flex-start", background: "#22c55e", color: "#0f172a", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  {publishSaved ? "Saved" : "Save defaults"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
