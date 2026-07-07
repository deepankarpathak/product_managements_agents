"use client";

import {
  Brain,
  MessageSquare,
  Database,
  BookOpen,
  UploadCloud,
  Palette,
  BarChart3,
  Code2,
  FileText,
  Microscope,
  Users,
  ShieldCheck,
  Scale,
  Layers,
  Search,
  Figma,
  HardDrive,
  Ticket,
  Mail,
  Calendar,
  MessageCircle,
  Network,
  AlertTriangle,
  Lightbulb,
  GitBranch,
  Sparkles,
} from "lucide-react";

type Tab =
  | "overview"
  | "chat"
  | "query"
  | "jira"
  | "dashboards"
  | "wiki"
  | "raw"
  | "upload"
  | "design";

const SURFACES: {
  icon: any;
  title: string;
  desc: string;
  tab?: Tab;
}[] = [
  {
    icon: MessageSquare,
    title: "Ask",
    desc: "Chat with the full knowledge base. Streams the answer plus every tool call live — answered like a five-year UPI veteran.",
    tab: "chat",
  },
  {
    icon: BarChart3,
    title: "Dashboards",
    desc: "Every chart and dashboard we've built — funnels, A/B readouts, trends — rendered in one gallery.",
    tab: "dashboards",
  },
  {
    icon: BookOpen,
    title: "Wiki",
    desc: "Browse the synthesized knowledge layer: apps, features, gaps, journeys, opportunities, regulations.",
    tab: "wiki",
  },
  {
    icon: Database,
    title: "Raw data",
    desc: "Read the immutable source files — circulars, briefs, CSVs, reviews — exactly as ingested.",
    tab: "raw",
  },
  {
    icon: UploadCloud,
    title: "Upload",
    desc: "Drop new source files into raw/ from the browser, then ask to compile them into the wiki.",
    tab: "upload",
  },
  {
    icon: Palette,
    title: "Design Studio",
    desc: "Edit live HTML prototypes by chat, in device frames. Upload a screenshot and it matches the design.",
    tab: "design",
  },
];

const AGENTS: {
  icon: any;
  title: string;
  desc: string;
  group: string;
  tab?: Tab;
}[] = [
  // Analysis & data
  {
    icon: Code2,
    title: "Query agent",
    desc: "Writes production-ready Trino SQL from a plain-English question, reuses golden queries, and runs it.",
    group: "Analysis & data",
    tab: "query",
  },
  {
    icon: BarChart3,
    title: "Dashboard agent",
    desc: "Analyzes CSV/PDF/image data and generates a self-contained HTML dashboard.",
    group: "Analysis & data",
  },
  {
    icon: Microscope,
    title: "Live analysis",
    desc: "Crystallizes a finished SQL/funnel/cohort/A-B study into a durable wiki page.",
    group: "Analysis & data",
  },
  {
    icon: Users,
    title: "Simulate",
    desc: "Role-plays how UPI personas experience a feature or flow, grounded in real evidence.",
    group: "Analysis & data",
  },
  {
    icon: MessageCircle,
    title: "User pain",
    desc: "Surfaces user evidence for a pain point from reviews, support, and the wiki.",
    group: "Analysis & data",
  },
  // Product & strategy
  {
    icon: FileText,
    title: "PRD generator",
    desc: "Produces a grounded, production-grade PRD for a feature, flow, or experiment.",
    group: "Product & strategy",
  },
  {
    icon: Search,
    title: "Knowledge research",
    desc: "Searches and synthesizes the KB for competitors, gaps, and opportunities.",
    group: "Product & strategy",
  },
  {
    icon: Lightbulb,
    title: "Decision log",
    desc: "Captures a product decision with its rationale into durable memory.",
    group: "Product & strategy",
  },
  {
    icon: Users,
    title: "Stakeholder",
    desc: "Records stakeholder context, positions, and concerns for later recall.",
    group: "Product & strategy",
  },
  // Compliance & design
  {
    icon: Scale,
    title: "Circular agent",
    desc: "Searches, quotes, and interprets NPCI/UPI operating circulars in strict-accuracy mode.",
    group: "Compliance & design",
  },
  {
    icon: Layers,
    title: "Wiki compiler",
    desc: "Builds/refreshes the wiki/ layer from raw/, updating INDEX and entity graph.",
    group: "Compliance & design",
  },
  {
    icon: Figma,
    title: "Figma review",
    desc: "Reviews screens through a PM lens — flow, missing states, PODS3 design-system compliance.",
    group: "Compliance & design",
  },
  {
    icon: Sparkles,
    title: "UI design",
    desc: "Edits live prototypes in plain English using local Claude — no API key.",
    group: "Compliance & design",
  },
  // Ops & comms
  {
    icon: Ticket,
    title: "Jira agent",
    desc: "Drafts, creates, searches, comments on, and transitions Jira issues per SOP.",
    group: "Ops & comms",
    tab: "jira",
  },
  {
    icon: AlertTriangle,
    title: "Incident capture",
    desc: "Captures incident/debugging context into memory for faster recovery next time.",
    group: "Ops & comms",
  },
  {
    icon: GitBranch,
    title: "Handoff",
    desc: "Crystallizes the session into an episodic memory page for clean continuity.",
    group: "Ops & comms",
  },
  {
    icon: Mail,
    title: "Gmail",
    desc: "Searches, reads, drafts, labels, and summarizes email.",
    group: "Ops & comms",
  },
  {
    icon: Calendar,
    title: "Calendar",
    desc: "Finds free slots, checks schedules, and manages meetings.",
    group: "Ops & comms",
  },
];

const INTEGRATIONS: { icon: any; title: string; desc: string }[] = [
  { icon: Database, title: "Trino", desc: "Live SQL against the Paytm data lake via run_trino_query.py." },
  { icon: Figma, title: "Figma", desc: "Pulls screens/nodes for PM-lens design review." },
  { icon: HardDrive, title: "Google Drive", desc: "Reads gDocs / Sheets / Slides referenced in the KB." },
  { icon: Ticket, title: "Jira / Atlassian", desc: "Issue create, search, comment, transition." },
  { icon: Mail, title: "Gmail", desc: "Email search, drafting, and summaries." },
  { icon: Calendar, title: "Google Calendar", desc: "Scheduling and availability." },
  { icon: MessageCircle, title: "Voice of Customer", desc: "Customer feedback feed via the VoC MCP server." },
  { icon: Network, title: "Hybrid retrieval", desc: "BM25 + vector + entity-graph search across the wiki." },
];

const GROUPS = ["Analysis & data", "Product & strategy", "Compliance & design", "Ops & comms"];

export default function Overview({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <div className="mb-5 grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-xl shadow-brand-200">
            <Brain size={32} />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-ink-900">
            UPI Alpha — Product Intelligence
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-500">
            A proprietary context layer for the Paytm UPI & consumer product
            team. Ask anything and it answers with the specificity of a five-year
            UPI veteran — grounded in NPCI circulars, internal briefs, live Trino
            data, competitor research, and user evidence. It runs your{" "}
            <strong className="text-ink-700">local Claude Code</strong> with full
            repo access — <strong className="text-ink-700">no API key</strong>.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button
              onClick={() => onNavigate("chat")}
              className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600"
            >
              Start asking →
            </button>
            <button
              onClick={() => onNavigate("dashboards")}
              className="rounded-xl border border-ink-200 bg-white px-5 py-2.5 text-sm font-semibold text-ink-700 transition hover:border-brand-300 hover:bg-brand-50"
            >
              View dashboards
            </button>
          </div>
        </div>

        {/* Surfaces */}
        <Section title="The app" sub="Six surfaces, one knowledge base">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACES.map((s) => (
              <Card
                key={s.title}
                icon={s.icon}
                title={s.title}
                desc={s.desc}
                onClick={s.tab ? () => onNavigate(s.tab!) : undefined}
              />
            ))}
          </div>
        </Section>

        {/* Agents & skills */}
        <Section
          title="Agents & skills"
          sub="Query and Jira have dedicated tabs; the rest you invoke from the Ask tab with /commands"
        >
          {GROUPS.map((g) => (
            <div key={g} className="mb-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-600">
                {g}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {AGENTS.filter((a) => a.group === g).map((a) => (
                  <Card
                    key={a.title}
                    icon={a.icon}
                    title={a.title}
                    desc={a.desc}
                    onClick={a.tab ? () => onNavigate(a.tab!) : undefined}
                  />
                ))}
              </div>
            </div>
          ))}
        </Section>

        {/* Integrations */}
        <Section title="Integrations" sub="Live connections the agents can use">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {INTEGRATIONS.map((i) => (
              <div
                key={i.title}
                className="rounded-xl border border-ink-200 bg-white p-3.5"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="grid size-7 place-items-center rounded-lg bg-ink-100 text-ink-600">
                    <i.icon size={15} />
                  </span>
                  <span className="text-sm font-semibold text-ink-800">
                    {i.title}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-ink-500">{i.desc}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* How it works */}
        <Section title="How it works" sub="">
          <div className="rounded-2xl border border-ink-200 bg-gradient-to-br from-ink-900 to-ink-800 p-6 text-ink-100">
            <div className="flex items-start gap-3">
              <ShieldCheck size={20} className="mt-0.5 shrink-0 text-brand-300" />
              <p className="text-sm leading-relaxed text-ink-200">
                Every question spawns your local <strong>claude</strong> CLI with
                its working directory set to the UPI Alpha repo — so CLAUDE.md,
                all skills, MCP servers, Trino, Figma, and the wiki/raw sources
                load exactly as they do in your terminal. It uses your existing
                Claude Code login, so there's no API key to manage and nothing
                leaves your machine beyond the model calls you already make.
              </p>
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-ink-900">{title}</h2>
      {sub && <p className="mb-4 mt-0.5 text-sm text-ink-400">{sub}</p>}
      {!sub && <div className="mb-4" />}
      {children}
    </section>
  );
}

function Card({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: any;
  title: string;
  desc: string;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={`flex flex-col rounded-xl border border-ink-200 bg-white p-4 text-left transition ${
        onClick ? "cursor-pointer hover:border-brand-300 hover:shadow-sm" : ""
      }`}
    >
      <span className="mb-2 grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-600">
        <Icon size={18} />
      </span>
      <span className="text-sm font-semibold text-ink-800">{title}</span>
      <span className="mt-1 text-xs leading-relaxed text-ink-500">{desc}</span>
    </Comp>
  );
}
