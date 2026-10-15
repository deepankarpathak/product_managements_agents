import { useState } from "react";
import PRDAgent from "./prd-agent-v7.jsx";
import TestSentinel from "./uat-agent1.jsx";
import BRDAgent from "./brd-agent.jsx";
import JiraAgent from "./jira-agent.jsx";
import AnalystAgentTab from "./analyst-agent.jsx";
import AlphaAgent from "./alpha-agent.jsx";
import MorningDashboard from "./morning-dashboard.jsx";
import SrSnippet from "./sr-snippet.jsx";
import ProductDashboard from "./product-dashboard.jsx";
import Utilities from "./utilities.jsx";
import DashboardHistory from "./dashboard-history.jsx";
import ConnectorsStatus from "./ConnectorsStatus.jsx";
import BackendWarningBanner from "./BackendWarningBanner.jsx";

const TAB_PRD = "prd";
const TAB_UAT = "uat";
const TAB_BRD = "brd";
const TAB_JIRA = "jira";
const TAB_ANALYST = "analyst";
const TAB_ALPHA = "alpha";
const TAB_MORNING = "morning";
const TAB_SRSNIPPET = "srsnippet";
const TAB_PRODUCT = "product";
const TAB_UTILITIES = "utilities";
const TAB_HISTORY = "history";

// Bookmarkable: http://localhost:3000/#morning opens the Morning Dashboard,
// #srsnippet the Success Rate Snippet, #product the Product Wise dashboard, #utilities the Utilities dashboard.
// #history (optionally #history?dashboard=morning|srsnippet) opens the History tab.
const HASH_TABS = { "#morning": TAB_MORNING, "#srsnippet": TAB_SRSNIPPET, "#product": TAB_PRODUCT, "#utilities": TAB_UTILITIES, "#history": TAB_HISTORY };
const initialTab = () => HASH_TABS[window.location.hash.split("?")[0]] || TAB_PRD;

function App() {
  const [activeTab, setActiveTab] = useState(initialTab);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Agent switcher — runs PRD, UAT, and BRD agents in parallel (switch without losing state) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 0,
          padding: "0 16px",
          minHeight: 40,
          background: "#0f172a",
          borderBottom: "1px solid #1e293b",
          fontFamily: "'Segoe UI', sans-serif",
          zIndex: 1000,
        }}
      >
        <button
          type="button"
          onClick={() => setActiveTab(TAB_PRD)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_PRD ? "2px solid #f59e0b" : "2px solid transparent",
            background: activeTab === TAB_PRD ? "#1e293b" : "transparent",
            color: activeTab === TAB_PRD ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          PRD Agent
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(TAB_UAT)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_UAT ? "2px solid #e8b84b" : "2px solid transparent",
            background: activeTab === TAB_UAT ? "#1e293b" : "transparent",
            color: activeTab === TAB_UAT ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          UAT Agent
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(TAB_JIRA)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_JIRA ? "2px solid #38bdf8" : "2px solid transparent",
            background: activeTab === TAB_JIRA ? "#1e293b" : "transparent",
            color: activeTab === TAB_JIRA ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          JIRA Agent
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(TAB_BRD)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_BRD ? "2px solid #7c6fff" : "2px solid transparent",
            background: activeTab === TAB_BRD ? "#1e293b" : "transparent",
            color: activeTab === TAB_BRD ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          BRD Agent
        </button>
        <button
          type="button"
          onClick={() => setActiveTab(TAB_ANALYST)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_ANALYST ? "2px solid #22d3ee" : "2px solid transparent",
            background: activeTab === TAB_ANALYST ? "#1e293b" : "transparent",
            color: activeTab === TAB_ANALYST ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Analyst Agent
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_ALPHA)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_ALPHA ? "2px solid #10b981" : "2px solid transparent",
            background: activeTab === TAB_ALPHA ? "#1e293b" : "transparent",
            color: activeTab === TAB_ALPHA ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          α Alpha Agent
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_MORNING)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_MORNING ? "2px solid #fbbf24" : "2px solid transparent",
            background: activeTab === TAB_MORNING ? "#1e293b" : "transparent",
            color: activeTab === TAB_MORNING ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ☀ Morning Dashboard
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_SRSNIPPET)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_SRSNIPPET ? "2px solid #34d399" : "2px solid transparent",
            background: activeTab === TAB_SRSNIPPET ? "#1e293b" : "transparent",
            color: activeTab === TAB_SRSNIPPET ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          % Success Rate Snippet
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_PRODUCT)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_PRODUCT ? "2px solid #fb923c" : "2px solid transparent",
            background: activeTab === TAB_PRODUCT ? "#1e293b" : "transparent",
            color: activeTab === TAB_PRODUCT ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          ▦ Product Wise
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_UTILITIES)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_UTILITIES ? "2px solid #a78bfa" : "2px solid transparent",
            background: activeTab === TAB_UTILITIES ? "#1e293b" : "transparent",
            color: activeTab === TAB_UTILITIES ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          🛠 Utilities
        </button>

        <button
          type="button"
          onClick={() => setActiveTab(TAB_HISTORY)}
          style={{
            padding: "8px 20px",
            margin: 0,
            border: "none",
            borderBottom: activeTab === TAB_HISTORY ? "2px solid #f472b6" : "2px solid transparent",
            background: activeTab === TAB_HISTORY ? "#1e293b" : "transparent",
            color: activeTab === TAB_HISTORY ? "#f8fafc" : "#64748b",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          🕘 History
        </button>

        {/* Connectors status — shared across all agents */}
        <div style={{ marginLeft: "auto" }}>
          <ConnectorsStatus />
        </div>
      </div>

      <BackendWarningBanner />

      <div style={{ flex: 1, display: activeTab === TAB_PRD ? "block" : "none" }}>
        <PRDAgent />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_UAT ? "block" : "none" }}>
        <TestSentinel />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_BRD ? "block" : "none" }}>
        <BRDAgent />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_JIRA ? "block" : "none" }}>
        <JiraAgent />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_ANALYST ? "block" : "none" }}>
        <AnalystAgentTab />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_ALPHA ? "block" : "none" }}>
        <AlphaAgent />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_MORNING ? "block" : "none" }}>
        <MorningDashboard />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_SRSNIPPET ? "block" : "none" }}>
        <SrSnippet />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_PRODUCT ? "block" : "none" }}>
        <ProductDashboard />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_UTILITIES ? "block" : "none" }}>
        <Utilities />
      </div>
      <div style={{ flex: 1, display: activeTab === TAB_HISTORY ? "block" : "none" }}>
        <DashboardHistory active={activeTab === TAB_HISTORY} />
      </div>
    </div>
  );
}

export default App;
