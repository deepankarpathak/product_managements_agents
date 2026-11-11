import { lazy, Suspense, useEffect, useState } from "react";
import { useApdConfig } from "./apd-toggle.jsx";
import ConnectorsStatus from "./ConnectorsStatus.jsx";
import BackendWarningBanner from "./BackendWarningBanner.jsx";

// Each page is its own chunk: only the pages you open are downloaded and parsed.
const PRDAgent = lazy(() => import("./prd-agent-v7.jsx"));
const TestSentinel = lazy(() => import("./uat-agent1.jsx"));
const BRDAgent = lazy(() => import("./brd-agent.jsx"));
const JiraAgent = lazy(() => import("./jira-agent.jsx"));
const AnalystAgentTab = lazy(() => import("./analyst-agent.jsx"));
const AlphaAgent = lazy(() => import("./alpha-agent.jsx"));
const UnifiedSrDashboard = lazy(() => import("./sr-unified-dashboard.jsx"));
const ProductDashboard = lazy(() => import("./product-dashboard.jsx"));
const AutoPayments = lazy(() => import("./autopay.jsx"));
const Utilities = lazy(() => import("./utilities.jsx"));
const DashboardHistory = lazy(() => import("./dashboard-history.jsx"));
const PmHome = lazy(() => import("./pm-home.jsx"));
const HssTraffic = lazy(() => import("./hss-traffic.jsx"));
const SrDissection = lazy(() => import("./sr-dissection.jsx"));
const SrBenchmark = lazy(() => import("./sr-benchmark.jsx"));
const AcquiringSr = lazy(() => import("./sr-acquiring.jsx"));
const Lumina = lazy(() => import("./lumina.jsx"));
const TxnTracer = lazy(() => import("./txn-tracer.jsx"));
const KibanaLogs = lazy(() => import("./kibana-logs.jsx"));

const APP_TITLE = "PM Console";

// heavy: iframes and large dashboards. Only the HEAVY_KEEP most recently used heavy pages stay
// mounted after you leave them; the rest unmount (dashboards reload from the backend cache).
// Agent pages are light forms and stay mounted once visited so drafts survive switching.
const HEAVY_KEEP = 2;

// render(active, ctx): ctx = { navigate(page, request), request } — request is a hand-over from Today
// (a Lumina question or a txn id to trace).
const PAGES = [
  { group: "", id: "today", hash: "#today", icon: "⌂", label: "Today", accent: "#f59e0b", render: (active, ctx) => <PmHome active={active} onNavigate={ctx.navigate} /> },
  { group: "Monitor", id: "srdash", hash: "#srdash", icon: "◎", label: "Unified SR", accent: "#60a5fa", heavy: true, render: () => <UnifiedSrDashboard /> },
  { group: "Monitor", id: "acqsr", hash: "#acqsr", icon: "⇲", label: "Acquiring SR", accent: "#2dd4bf", render: (active) => <AcquiringSr active={active} /> },
  { group: "Monitor", id: "srdissect", hash: "#srdissect", icon: "⧉", label: "SR Dissection", accent: "#f87171", heavy: true, render: () => <SrDissection /> },
  { group: "Monitor", id: "srbench", hash: "#srbench", icon: "⚖", label: "SR vs Peers", accent: "#facc15", render: () => <SrBenchmark /> },
  { group: "Monitor", id: "product", hash: "#product", icon: "▦", label: "Product Wise", accent: "#fb923c", heavy: true, render: () => <ProductDashboard /> },
  { group: "Monitor", id: "autopay", hash: "#autopay", icon: "↻", label: "Automatic Payments", accent: "#a3e635", heavy: true, render: (active) => <AutoPayments active={active} /> },
  { group: "Monitor", id: "hss", hash: "#hss", icon: "⇆", label: "HSS Traffic", accent: "#38bdf8", render: () => <HssTraffic /> },
  { group: "Monitor", id: "history", hash: "#history", icon: "🕘", label: "History", accent: "#f472b6", heavy: true, render: (active) => <DashboardHistory active={active} /> },
  { group: "Create", id: "prd", hash: "#prd", icon: "📄", label: "PRD Agent", accent: "#f59e0b", render: () => <PRDAgent /> },
  { group: "Create", id: "brd", hash: "#brd", icon: "📋", label: "BRD Agent", accent: "#7c6fff", render: () => <BRDAgent /> },
  { group: "Create", id: "uat", hash: "#uat", icon: "✓", label: "UAT Agent", accent: "#e8b84b", render: () => <TestSentinel /> },
  { group: "Create", id: "jira", hash: "#jira", icon: "🎫", label: "JIRA Agent", accent: "#38bdf8", render: () => <JiraAgent /> },
  { group: "Ask", id: "lumina", hash: "#lumina", icon: "✦", label: "Lumina", accent: "#a78bfa", render: (active, ctx) => <Lumina request={ctx.request} /> },
  { group: "Ask", id: "analyst", hash: "#analyst", icon: "⌕", label: "Analyst Agent", accent: "#22d3ee", heavy: true, render: () => <AnalystAgentTab /> },
  { group: "Ask", id: "alpha", hash: "#alpha", icon: "α", label: "Alpha Agent", accent: "#10b981", heavy: true, render: () => <AlphaAgent /> },
  { group: "Tools", id: "txntrace", hash: "#txntrace", icon: "⌖", label: "Txn Tracer", accent: "#f472b6", render: (active, ctx) => <TxnTracer request={ctx.request} /> },
  { group: "Tools", id: "kibana", hash: "#kibana", icon: "🔎", label: "Kibana Logs", accent: "#fbbf24", render: (active, ctx) => <KibanaLogs request={ctx.request} /> },
  { group: "Tools", id: "utilities", hash: "#utilities", icon: "🛠", label: "Utilities", accent: "#a78bfa", render: () => <Utilities /> },
];
const GROUPS = ["", "Monitor", "Create", "Ask", "Tools"];
const PAGE_BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));

// Bookmarkable: every page has a hash (e.g. http://localhost:3000/#product).
// #history?dashboard=unified|srsnippet opens History pre-filtered.
// #morning (retired Morning Dashboard) now opens the Unified SR Dashboard.
// #srsnippet (SR Snippet, merged into Unified SR as its P2M view on 11 Nov 2026) → #srdash?view=p2m.
const LEGACY_HASH = { "#srsnippet": "#srdash?view=p2m" };
const redirectLegacyHash = () => {
  const to = LEGACY_HASH[window.location.hash.split("?")[0]];
  if (to) window.history.replaceState(null, "", to);
};
const HASH_TABS = { "#morning": "srdash", ...Object.fromEntries(PAGES.map((p) => [p.hash, p.id])) };
const DEFAULT_TAB = "today";
const tabFromHash = () => {
  redirectLegacyHash();
  return HASH_TABS[window.location.hash.split("?")[0]] || null;
};

const SIDEBAR_KEY = "pm-console-sidebar-collapsed";
const readCollapsed = () => {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
};

function App() {
  const [activeTab, setActiveTab] = useState(() => tabFromHash() || DEFAULT_TAB);
  // Automatic Payments turned off (or its folder missing): no sidebar entry, unless you are on that page.
  const apdCfg = useApdConfig();
  const hidePage = (p) => p.id === "autopay" && apdCfg && !apdCfg.active && activeTab !== "autopay";
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Most recently used first. Pages mount on first visit; heavy ones are evicted past HEAVY_KEEP.
  const [recent, setRecent] = useState(() => [activeTab]);
  // Hand-overs from Today, keyed by page id: { lumina: { text, id }, txntrace: { text, id } }.
  const [requests, setRequests] = useState({});
  const navigate = (page, request) => {
    if (request) setRequests((r) => ({ ...r, [page]: request }));
    setActiveTab(page);
  };

  useEffect(() => {
    setRecent((r) => [activeTab, ...r.filter((t) => t !== activeTab)]);
    const page = PAGE_BY_ID[activeTab];
    document.title = `${page.label} · ${APP_TITLE}`;
    // Keep the hash in sync so the address bar is always bookmarkable (preserve ?query on same page).
    if (tabFromHash() !== activeTab) window.history.replaceState(null, "", page.hash);
  }, [activeTab]);

  useEffect(() => {
    const onHash = () => {
      const t = tabFromHash();
      if (t) setActiveTab(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      /* storage blocked — sidebar state just won't persist */
    }
  }, [collapsed]);

  const keepHeavy = new Set(recent.filter((t) => PAGE_BY_ID[t].heavy).slice(0, HEAVY_KEEP));
  const mounted = (p) => p.id === activeTab || (recent.includes(p.id) && (!p.heavy || keepHeavy.has(p.id)));

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Segoe UI', sans-serif" }}>
      {/* Top bar — sidebar toggle, title, connectors status (shared across all agents) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 12px",
          minHeight: 40,
          background: "#0f172a",
          borderBottom: "1px solid #1e293b",
          zIndex: 1000,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          style={{
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #1e293b",
            borderRadius: 6,
            background: "transparent",
            color: "#cbd5e1",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <img src={`${process.env.PUBLIC_URL}/favicon.svg`} alt="" width={22} height={22} />
        <span style={{ color: "#f8fafc", fontSize: 14, fontWeight: 600 }}>{APP_TITLE}</span>
        <span style={{ color: "#475569", fontSize: 13 }}>/</span>
        <span style={{ color: "#94a3b8", fontSize: 13 }}>{PAGE_BY_ID[activeTab].label}</span>
        <div style={{ marginLeft: "auto" }}>
          <ConnectorsStatus />
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left menu — collapses to icons */}
        <nav
          aria-label="Pages"
          style={{
            width: collapsed ? 56 : 196,
            flexShrink: 0,
            background: "#0f172a",
            borderRight: "1px solid #1e293b",
            padding: "8px 8px 16px",
            overflowY: "auto",
            overflowX: "hidden",
            transition: "width 0.15s ease",
          }}
        >
          {GROUPS.map((g) => (
            <div key={g}>
              {!g ? null : collapsed ? (
                <div style={{ height: 1, background: "#1e293b", margin: "8px 4px" }} />
              ) : (
                <div style={{ color: "#475569", fontSize: 11, fontWeight: 600, letterSpacing: 0.4, padding: "12px 10px 4px", textTransform: "uppercase" }}>{g}</div>
              )}
              {PAGES.filter((p) => p.group === g && !hidePage(p)).map((p) => {
                const on = p.id === activeTab;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveTab(p.id)}
                    title={collapsed ? p.label : undefined}
                    aria-current={on ? "page" : undefined}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      padding: "7px 10px",
                      margin: "1px 0",
                      border: "none",
                      borderLeft: on ? `2px solid ${p.accent}` : "2px solid transparent",
                      borderRadius: on ? 0 : 6,
                      background: on ? "#1e293b" : "transparent",
                      color: on ? "#f8fafc" : "#94a3b8",
                      fontSize: 13,
                      fontWeight: on ? 600 : 500,
                      cursor: "pointer",
                      textAlign: "left",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ width: 18, flexShrink: 0, textAlign: "center", color: on ? p.accent : "#64748b" }}>{p.icon}</span>
                    {!collapsed && <span>{p.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          <BackendWarningBanner />
          <Suspense fallback={<div style={{ padding: 24, color: "#64748b", fontSize: 13 }}>Loading…</div>}>
            {PAGES.filter(mounted).map((p) => (
              <div key={p.id} style={{ flex: 1, display: p.id === activeTab ? "block" : "none" }}>
                {p.render(p.id === activeTab, { navigate, request: requests[p.id] })}
              </div>
            ))}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default App;
