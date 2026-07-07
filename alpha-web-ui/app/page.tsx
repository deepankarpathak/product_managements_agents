"use client";

import { useEffect, useState } from "react";
import {
  Home as HomeIcon,
  MessageSquare,
  BarChart3,
  BookOpen,
  Database,
  UploadCloud,
  Palette,
  Brain,
  Code2,
  Ticket,
  GraduationCap,
} from "lucide-react";
import Chat, { AgentUi } from "@/components/Chat";
import FileBrowser from "@/components/FileBrowser";
import Uploader from "@/components/Uploader";
import DesignStudio from "@/components/DesignStudio";
import Overview from "@/components/Overview";
import Learn from "@/components/Learn";
import Dashboards from "@/components/Dashboards";
import ThemeToggle from "@/components/ThemeToggle";
import JiraStudio from "@/components/JiraStudio";

type Tab =
  | "overview"
  | "chat"
  | "query"
  | "jira"
  | "dashboards"
  | "learn"
  | "wiki"
  | "raw"
  | "upload"
  | "design";

const NAV: { id: Tab; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: HomeIcon },
  { id: "learn", label: "Learn", icon: GraduationCap },
  { id: "chat", label: "Ask", icon: MessageSquare },
  { id: "query", label: "Query", icon: Code2 },
  { id: "jira", label: "Jira", icon: Ticket },
  { id: "dashboards", label: "Dashboards", icon: BarChart3 },
  { id: "wiki", label: "Wiki", icon: BookOpen },
  { id: "raw", label: "Raw data", icon: Database },
  { id: "upload", label: "Upload", icon: UploadCloud },
  { id: "design", label: "Design", icon: Palette },
];

const QUERY_AGENT: AgentUi = {
  command: "query",
  icon: Code2,
  heading: "Query agent",
  blurb:
    "Ask a data question in plain English. It writes production-ready Trino SQL — reusing golden queries and applying the standard transaction filters — runs it, and returns the result with the SQL used.",
  placeholder: "e.g. P2P success rate by category for the last 7 days…",
  note: "Routes through the /query skill · live Trino against the Paytm data lake · returns the SQL it ran",
  starters: [
    "P2P success rate by category for the last 7 days.",
    "Daily distinct transacting users for the last 30 days.",
    "To Mobile suggested-without-tabs funnel for last week.",
    "Top 10 merchants by transaction volume yesterday.",
  ],
};

// Chat-backed tabs stay mounted once opened (toggled with CSS, not unmounted)
// so their conversation history survives switching to another tab and back.
const CHAT_TABS: Tab[] = ["chat", "query", "jira"];

export default function Home() {
  const [tab, setTab] = useState<Tab>("overview");
  // Chat tabs the user has opened at least once. We lazy-mount them on first
  // visit (avoids firing three identical /api/skills fetches on page load),
  // then keep them alive.
  const [openedChats, setOpenedChats] = useState<Set<Tab>>(new Set());

  // Deep-link a tab via ?tab=design (shareable URLs).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as Tab;
    if (t && NAV.some((n) => n.id === t)) setTab(t);
  }, []);

  // Once a chat tab is active, mark it mounted-for-good.
  useEffect(() => {
    if (CHAT_TABS.includes(tab)) {
      setOpenedChats((s) => (s.has(tab) ? s : new Set(s).add(tab)));
    }
  }, [tab]);

  // Keep the URL in sync when switching tabs.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url);
  }, [tab]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Nav rail */}
      <nav className="flex w-20 shrink-0 flex-col items-center gap-1 border-r border-ink-200 bg-ink-900 py-4">
        <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-lg">
          <Brain size={22} />
        </div>
        {NAV.map((n) => {
          const Icon = n.icon;
          const active = tab === n.id;
          return (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              className={`group flex w-16 flex-col items-center gap-1 rounded-xl py-2.5 text-[10px] font-medium transition ${
                active
                  ? "bg-white/10 text-white"
                  : "text-ink-400 hover:bg-white/5 hover:text-ink-200"
              }`}
            >
              <Icon
                size={20}
                className={active ? "text-brand-300" : ""}
              />
              {n.label}
            </button>
          );
        })}
        <div className="mt-auto flex flex-col items-center gap-1">
          <ThemeToggle />
          <div className="px-2 pt-1 text-center text-[9px] leading-tight text-ink-500">
            no API key
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-200 bg-white/80 px-5 py-3 backdrop-blur">
          <h1 className="text-sm font-semibold text-ink-900">
            UPI Alpha
            <span className="ml-2 font-normal text-ink-400">
              Product Intelligence
            </span>
          </h1>
          <span className="ml-auto rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600">
            Local Claude Code · full repo access
          </span>
        </header>

        <div className="min-h-0 flex-1">
          {tab === "overview" && <Overview onNavigate={setTab} />}

          {/* Chat tabs persist once opened — hidden, not unmounted, when inactive. */}
          {openedChats.has("chat") && (
            <div className={tab === "chat" ? "h-full" : "hidden"}>
              <Chat />
            </div>
          )}
          {openedChats.has("query") && (
            <div className={tab === "query" ? "h-full" : "hidden"}>
              <Chat agent={QUERY_AGENT} />
            </div>
          )}
          {openedChats.has("jira") && (
            <div className={tab === "jira" ? "h-full" : "hidden"}>
              <JiraStudio />
            </div>
          )}

          {tab === "learn" && <Learn />}
          {tab === "dashboards" && <Dashboards />}
          {tab === "wiki" && <FileBrowser root="wiki" />}
          {tab === "raw" && <FileBrowser root="raw" />}
          {tab === "upload" && <Uploader />}
          {tab === "design" && <DesignStudio />}
        </div>
      </main>
    </div>
  );
}
