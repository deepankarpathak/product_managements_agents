"use client";

import { useEffect, useRef, useState } from "react";
import {
  Send,
  Square,
  Plus,
  User,
  Brain,
  ChevronDown,
  AlertTriangle,
  Loader2,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
} from "lucide-react";
import Markdown from "./Markdown";
import ToolCard, { ToolCall } from "./ToolCard";
import CopyButton from "./CopyButton";

type Part =
  | { type: "text"; text: string }
  | { type: "tool"; tool: ToolCall };

type Message =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      parts: Part[];
      thinking: string;
      done: boolean;
      cost?: number;
      error?: string;
    };

// One stored conversation. Persisted per-agent in localStorage (per-browser),
// so different users on a shared deployment never see each other's chats.
type Conversation = {
  id: string;
  title: string;
  sessionId: string; // claude session UUID for --resume
  messages: Message[];
  turns: number;
  updatedAt: number;
};

type Skill = { name: string; description: string };

// A Chat surface can be specialized into a dedicated agent. When `command` is
// set, the first turn of a session is prefixed with that slash command so the
// matching skill (e.g. /query, /jira) loads its full workflow — the skill
// context then persists across follow-up turns in the same resumed session.
export type AgentUi = {
  command?: string; // slash-command/skill to route through; omit for general chat
  icon: any;
  heading: string;
  blurb: string;
  placeholder: string;
  starters: string[];
  note: string;
};

type RateLimit = {
  utilization?: number;
  rateLimitType?: string;
  status?: string;
};

const MODELS = [
  { id: "opus", label: "Opus 4.8", hint: "Deepest reasoning" },
  { id: "sonnet", label: "Sonnet 4.6", hint: "Fast & capable" },
  { id: "haiku", label: "Haiku 4.5", hint: "Quick lookups" },
];

const GENERAL_AGENT: AgentUi = {
  icon: Brain,
  heading: "Ask the UPI Alpha knowledge base",
  blurb:
    "Backed by the full wiki, raw sources, trino, and every skill — answered with the specificity of a five-year UPI veteran at Paytm.",
  placeholder: "Ask anything about UPI, the wiki, or run a /skill…",
  note: "Runs your local Claude Code with full repo access · no API key · answers grounded in the UPI Alpha wiki",
  starters: [
    "What is UPI Circle and how is Paytm positioned on it?",
    "Summarise the latest NPCI circular on transaction limits.",
    "P2P success rate by category for the last 7 days.",
    "What are the top user pain points in the onboarding flow?",
  ],
};

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function newConversation(): Conversation {
  return {
    id: uuid(),
    title: "New chat",
    sessionId: uuid(),
    messages: [],
    turns: 0,
    updatedAt: Date.now(),
  };
}

function deriveTitle(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

export default function Chat({ agent }: { agent?: AgentUi }) {
  const cfg = agent ?? GENERAL_AGENT;
  const storeKey = `upi.chats.${cfg.command || "general"}`;

  const [chats, setChats] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [input, setInput] = useState("");
  const [model, setModel] = useState("opus");
  const [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showChats, setShowChats] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [rateLimit, setRateLimit] = useState<RateLimit | null>(null);

  const loadedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const active = chats.find((c) => c.id === activeId);
  const messages = active?.messages ?? [];

  // Load this agent's saved conversations once (client-only).
  useEffect(() => {
    let initial: Conversation[] = [];
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) initial = JSON.parse(raw);
    } catch {
      /* ignore corrupt store */
    }
    if (!Array.isArray(initial) || initial.length === 0) {
      initial = [newConversation()];
    }
    setChats(initial);
    setActiveId(initial[0].id);
    loadedRef.current = true;
  }, [storeKey]);

  // Persist after load. Debounced so token-by-token streaming updates coalesce
  // into ~one write rather than serializing the whole list on every delta.
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storeKey, JSON.stringify(chats));
      } catch {
        /* quota / disabled storage — non-fatal */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [chats, storeKey]);

  useEffect(() => {
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(d.skills || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 220) + "px";
  };

  // ── Conversation management ────────────────────────────────────
  const updateChat = (id: string, fn: (c: Conversation) => Conversation) =>
    setChats((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  const patchMessages = (id: string, fn: (m: Message[]) => Message[]) =>
    updateChat(id, (c) => ({
      ...c,
      messages: fn(c.messages),
      updatedAt: Date.now(),
    }));

  // Mutate the trailing assistant message of a specific chat immutably. `fn`
  // mutates `next`, so `next` and every part it touches must be a *fresh* copy —
  // never an object shared with the input state. Otherwise React strict mode's
  // double-invoked updater applies the same delta twice and garbles the text.
  const patchAssistant = (
    id: string,
    fn: (a: Extract<Message, { role: "assistant" }>) => void
  ) =>
    patchMessages(id, (msgs) => {
      const copy = [...msgs];
      const last = copy[copy.length - 1];
      if (last && last.role === "assistant") {
        const next = {
          ...last,
          parts: last.parts.map((p) =>
            p.type === "text" ? { ...p } : { ...p, tool: { ...p.tool } }
          ),
        } as Extract<Message, { role: "assistant" }>;
        fn(next);
        copy[copy.length - 1] = next;
      }
      return copy;
    });

  const newChat = () => {
    abortRef.current?.abort();
    const c = newConversation();
    setChats((cs) => [c, ...cs]);
    setActiveId(c.id);
    setInput("");
    setRateLimit(null);
    setShowChats(false);
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const selectChat = (id: string) => {
    setActiveId(id);
    setShowChats(false);
    setRenamingId(null);
  };

  const deleteChat = (id: string) => {
    if (id === activeId) abortRef.current?.abort();
    const remaining = chats.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const c = newConversation();
      setChats([c]);
      setActiveId(c.id);
    } else {
      setChats(remaining);
      if (id === activeId) setActiveId(remaining[0].id);
    }
    if (renamingId === id) setRenamingId(null);
  };

  const startRename = (c: Conversation) => {
    setRenamingId(c.id);
    setRenameText(c.title);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const title = renameText.trim();
    updateChat(renamingId, (c) => ({ ...c, title: title || "Untitled" }));
    setRenamingId(null);
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  // ── Sending ────────────────────────────────────────────────────
  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    const chatId = activeId;
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return;

    const resume = chat.turns > 0;
    const sessionId = chat.sessionId;

    // Route the first turn of an agent chat through its slash command so the
    // skill loads. Bubble shows raw text; only the payload is prefixed.
    const payload =
      cfg.command && !resume && !text.startsWith("/")
        ? `/${cfg.command} ${text}`
        : text;

    updateChat(chatId, (c) => ({
      ...c,
      turns: c.turns + 1,
      title:
        c.turns === 0 && (c.title === "New chat" || !c.title.trim())
          ? deriveTitle(text)
          : c.title,
      messages: [
        ...c.messages,
        { role: "user", text },
        { role: "assistant", parts: [], thinking: "", done: false },
      ],
      updatedAt: Date.now(),
    }));

    setInput("");
    setBusy(true);
    if (taRef.current) taRef.current.style.height = "auto";

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: payload, sessionId, model, resume }),
        signal: ac.signal,
      });

      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleEvent(chatId, evt);
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        patchAssistant(chatId, (a) => {
          a.error = err?.message || "Request failed";
          a.done = true;
        });
      }
    } finally {
      setBusy(false);
      patchAssistant(chatId, (a) => {
        a.done = true;
      });
    }
  };

  const handleEvent = (chatId: string, evt: any) => {
    switch (evt.kind) {
      case "session":
        if (evt.session_id)
          updateChat(chatId, (c) => ({ ...c, sessionId: evt.session_id }));
        break;
      case "text":
        patchAssistant(chatId, (a) => {
          const last = a.parts[a.parts.length - 1];
          if (last && last.type === "text") last.text += evt.text;
          else a.parts.push({ type: "text", text: evt.text });
        });
        break;
      case "thinking":
        patchAssistant(chatId, (a) => {
          a.thinking += evt.text;
        });
        break;
      case "tool_use":
        patchAssistant(chatId, (a) => {
          a.parts.push({
            type: "tool",
            tool: { id: evt.id, name: evt.name, input: evt.input, done: false },
          });
        });
        break;
      case "tool_result":
        patchAssistant(chatId, (a) => {
          for (const p of a.parts) {
            if (p.type === "tool" && p.tool.id === evt.tool_use_id) {
              p.tool = {
                ...p.tool,
                result: evt.text,
                isError: evt.is_error,
                done: true,
              };
            }
          }
        });
        break;
      case "rate_limit":
        setRateLimit(evt.info || null);
        break;
      case "result":
        patchAssistant(chatId, (a) => {
          a.cost = evt.cost_usd;
          a.done = true;
        });
        break;
      case "error":
        patchAssistant(chatId, (a) => {
          a.error = evt.message;
          a.done = true;
        });
        break;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const insertSkill = (name: string) => {
    setInput((i) => (i ? i : `/${name} `));
    setShowSkills(false);
    taRef.current?.focus();
  };

  const utilPct = rateLimit?.utilization
    ? Math.round(rateLimit.utilization * 100)
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* Chat switcher — list is hidden until the dropdown is opened */}
      <div className="flex items-center gap-1.5 border-b border-ink-200 bg-white/70 px-4 py-2 backdrop-blur">
        <div className="relative">
          <button
            onClick={() => setShowChats((s) => !s)}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-ink-700 transition hover:bg-ink-100"
            title="Your chats"
          >
            <MessageSquare size={14} className="text-ink-400" />
            <span className="max-w-[220px] truncate">
              {active?.title || "New chat"}
            </span>
            <ChevronDown size={13} className="text-ink-400" />
          </button>

          {showChats && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowChats(false)}
              />
              <div className="absolute left-0 top-full z-20 mt-1 w-80 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl">
                <button
                  onClick={newChat}
                  className="flex w-full items-center gap-2 border-b border-ink-100 px-3 py-2.5 text-left text-sm font-semibold text-brand-600 transition hover:bg-brand-50"
                >
                  <Plus size={15} /> New chat
                </button>
                <div className="max-h-72 overflow-y-auto py-1">
                  {chats.map((c) => {
                    const isActive = c.id === activeId;
                    const isRenaming = renamingId === c.id;
                    return (
                      <div
                        key={c.id}
                        className={`group flex items-center gap-1 px-1.5 ${
                          isActive ? "bg-brand-50" : ""
                        }`}
                      >
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameText}
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            onBlur={commitRename}
                            className="my-0.5 flex-1 rounded-md border border-brand-300 px-2 py-1 text-sm outline-none"
                          />
                        ) : (
                          <button
                            onClick={() => selectChat(c.id)}
                            className="flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 transition hover:bg-ink-100"
                            title={c.title}
                          >
                            {c.title}
                          </button>
                        )}
                        {isRenaming ? (
                          <button
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={commitRename}
                            title="Save"
                            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-emerald-600"
                          >
                            <Check size={14} />
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => startRename(c)}
                              title="Rename"
                              className="grid size-7 shrink-0 place-items-center rounded-md text-ink-400 opacity-0 transition hover:bg-ink-100 hover:text-brand-600 group-hover:opacity-100"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={() => deleteChat(c.id)}
                              title="Delete"
                              className="grid size-7 shrink-0 place-items-center rounded-md text-ink-400 opacity-0 transition hover:bg-ink-100 hover:text-rose-600 group-hover:opacity-100"
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <button
          onClick={newChat}
          title="New chat"
          className="grid size-7 place-items-center rounded-lg text-ink-400 transition hover:bg-ink-100 hover:text-brand-600"
        >
          <Plus size={16} />
        </button>

        <span className="ml-auto text-[11px] text-ink-400">
          {chats.length} chat{chats.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Rate-limit banner */}
      {utilPct !== null && utilPct >= 75 && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-1.5 text-xs text-amber-800">
          <AlertTriangle size={13} />
          <span>
            Claude usage at <strong>{utilPct}%</strong> of the{" "}
            {rateLimit?.rateLimitType?.replace("_", "-")} limit. Prefer Sonnet /
            Haiku for routine lookups.
          </span>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6">
          {messages.length === 0 ? (
            <Empty cfg={cfg} onPick={(q) => send(q)} />
          ) : (
            messages.map((m, i) => <MessageView key={i} m={m} />)
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-ink-200 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-3xl px-5 py-3">
          {/* skill chips popover */}
          {showSkills && (
            <div className="mb-2 max-h-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-2 shadow-lg">
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {skills.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => insertSkill(s.name)}
                    title={s.description}
                    className="rounded-lg border border-ink-100 px-2.5 py-1.5 text-left text-xs transition hover:border-brand-300 hover:bg-brand-50"
                  >
                    <span className="font-semibold text-brand-700">
                      /{s.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-end gap-2 rounded-2xl border border-ink-200 bg-white p-2 shadow-sm focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-100">
            <button
              onClick={newChat}
              title="New chat"
              className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-400 transition hover:bg-ink-100 hover:text-ink-600"
            >
              <Plus size={18} />
            </button>
            <button
              onClick={() => setShowSkills((s) => !s)}
              title="Skills"
              className={`grid h-9 shrink-0 place-items-center gap-1 rounded-xl px-2.5 text-xs font-semibold transition ${
                showSkills
                  ? "bg-brand-100 text-brand-700"
                  : "text-ink-400 hover:bg-ink-100 hover:text-ink-600"
              }`}
            >
              Skills
            </button>
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow();
              }}
              onKeyDown={onKey}
              rows={1}
              placeholder={cfg.placeholder}
              className="max-h-[220px] flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-ink-300"
            />

            {/* model picker */}
            <div className="relative shrink-0">
              <button
                onClick={() => setShowModels((s) => !s)}
                className="flex h-9 items-center gap-1 rounded-xl px-2.5 text-xs font-semibold text-ink-500 transition hover:bg-ink-100"
              >
                {MODELS.find((x) => x.id === model)?.label}
                <ChevronDown size={13} />
              </button>
              {showModels && (
                <div className="absolute bottom-11 right-0 z-10 w-44 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
                  {MODELS.map((x) => (
                    <button
                      key={x.id}
                      onClick={() => {
                        setModel(x.id);
                        setShowModels(false);
                      }}
                      className={`block w-full px-3 py-2 text-left text-xs transition hover:bg-ink-50 ${
                        model === x.id ? "bg-brand-50" : ""
                      }`}
                    >
                      <div className="font-semibold text-ink-700">
                        {x.label}
                      </div>
                      <div className="text-ink-400">{x.hint}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {busy ? (
              <button
                onClick={stop}
                title="Stop"
                className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink-800 text-white transition hover:bg-ink-900"
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={!input.trim()}
                title="Send"
                className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-500 text-white transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-center text-[11px] text-ink-400">
            {cfg.note}
          </p>
        </div>
      </div>
    </div>
  );
}

function Empty({
  cfg,
  onPick,
}: {
  cfg: AgentUi;
  onPick: (q: string) => void;
}) {
  const Icon = cfg.icon;
  return (
    <div className="flex flex-col items-center pt-10 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg shadow-brand-200">
        <Icon size={26} />
      </div>
      <h2 className="text-xl font-semibold text-ink-900">{cfg.heading}</h2>
      <p className="mt-1.5 max-w-md text-sm text-ink-500">{cfg.blurb}</p>
      <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {cfg.starters.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="rounded-xl border border-ink-200 bg-white px-4 py-3 text-left text-sm text-ink-600 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-ink-800"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageView({ m }: { m: Message }) {
  if (m.role === "user") {
    return (
      <div className="mb-5 flex justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-brand-500 px-4 py-2.5 text-sm text-white shadow-sm">
          <div className="whitespace-pre-wrap">{m.text}</div>
        </div>
        <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink-200 text-ink-600">
          <User size={15} />
        </div>
      </div>
    );
  }

  const streaming = !m.done;
  const hasContent = m.parts.length > 0 || m.thinking || m.error;

  // Full assistant text (all text parts) for the copy-output button.
  const fullText = m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("")
    .trim();

  return (
    <div className="mb-6 flex gap-3">
      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white">
        <Brain size={15} />
      </div>
      <div className="min-w-0 flex-1">
        {m.thinking && (
          <details className="mb-2 rounded-xl border border-ink-100 bg-ink-50/60 px-3 py-2 text-xs text-ink-500">
            <summary className="cursor-pointer font-semibold text-ink-400">
              Thinking
            </summary>
            <div className="mt-1.5 whitespace-pre-wrap">{m.thinking}</div>
          </details>
        )}

        {m.parts.map((p, i) =>
          p.type === "text" ? (
            <Markdown key={i}>{p.text}</Markdown>
          ) : (
            <ToolCard key={i} tool={p.tool} />
          )
        )}

        {streaming && !hasContent && (
          <div className="flex items-center gap-2 py-1 text-sm text-ink-400">
            <Loader2 size={14} className="animate-spin" />
            Working…
          </div>
        )}
        {streaming && hasContent && <span className="stream-caret" />}

        {m.error && (
          <div className="mt-2 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap">{m.error}</span>
          </div>
        )}

        {m.done && (fullText || m.cost !== undefined) && (
          <div className="mt-2 flex items-center gap-2">
            {fullText && (
              <CopyButton
                text={fullText}
                label="Copy"
                size={13}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-[11px] font-medium text-ink-500 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600"
              />
            )}
            {m.cost !== undefined && (
              <span className="text-[11px] text-ink-300">
                ${m.cost.toFixed(4)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
