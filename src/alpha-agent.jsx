/**
 * Alpha Agent — embeds the Next.js app in alpha-web-ui/ (UPI intelligence assistant).
 * Auto-starts the alpha service via /api/alpha/status if not already running.
 */
import { useEffect, useState, useCallback } from "react";

const DEFAULT_ALPHA_URL =
  (typeof process !== "undefined" &&
    process.env.REACT_APP_ALPHA_AGENT_URL &&
    String(process.env.REACT_APP_ALPHA_AGENT_URL).trim()) ||
  "http://localhost:3050";

const BACKEND_URL = "http://localhost:5000";
const POLL_INTERVAL = 3000;   // ms between readiness polls
const MAX_WAIT_MS   = 60000;  // give up after 60s

export default function AlphaAgent() {
  const src = DEFAULT_ALPHA_URL.replace(/\/+$/, "");

  // "checking" | "starting" | "ready" | "error"
  const [status, setStatus] = useState("checking");
  const [elapsed, setElapsed] = useState(0);
  const [startedAt] = useState(() => Date.now());

  const check = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND_URL}/api/alpha/status`, { cache: "no-store" });
      const data = await r.json();
      if (data.status === "running") {
        setStatus("ready");
      } else {
        const ms = Date.now() - startedAt;
        if (ms > MAX_WAIT_MS) {
          setStatus("error");
        } else {
          setStatus("starting");
          setElapsed(Math.round(ms / 1000));
        }
      }
    } catch {
      const ms = Date.now() - startedAt;
      if (ms > MAX_WAIT_MS) setStatus("error");
      else setStatus("starting");
    }
  }, [startedAt]);

  useEffect(() => {
    check();
    const id = setInterval(() => {
      if (status !== "ready" && status !== "error") check();
      else clearInterval(id);
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [check, status]);

  if (status === "ready") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: "calc(100vh - 40px)", background: "#0b1120" }}>
        <iframe
          title="Alpha Agent"
          src={src}
          style={{ flex: 1, border: "none", width: "100%", minHeight: 0, background: "#0b1120" }}
        />
      </div>
    );
  }

  const isError = status === "error";

  return (
    <div style={{
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "calc(100vh - 40px)",
      background: "#0b1120",
      color: "#e2e8f0",
      fontFamily: "system-ui, sans-serif",
      gap: 16,
    }}>
      {isError ? (
        <>
          <div style={{ fontSize: 36 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Alpha Agent failed to start</div>
          <div style={{ color: "#94a3b8", fontSize: 14 }}>
            Run <code style={{ background: "#1e293b", padding: "2px 6px", borderRadius: 4 }}>npm run dev:alpha</code> in terminal
          </div>
          <button
            onClick={() => { setStatus("checking"); }}
            style={{ marginTop: 8, padding: "8px 20px", background: "#3b82f6", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 14 }}
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <div style={{ width: 40, height: 40, border: "3px solid #3b82f6", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.9s linear infinite" }} />
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {status === "checking" ? "Checking Alpha Agent…" : "Starting Alpha Agent…"}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>
            {status === "starting" && elapsed > 5
              ? `Still starting… ${elapsed}s elapsed`
              : "This takes ~10 seconds on first launch"}
          </div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </>
      )}
    </div>
  );
}
