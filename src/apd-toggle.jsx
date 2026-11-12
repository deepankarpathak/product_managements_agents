// On / off switch for the Automatic Payments Dashboard (APD, #autopay). Backend: GET|POST /api/apd/config.
// Off — or the APD folder missing / renamed under third_party/apd_installer — hides the sidebar entry and
// Today's APD line and stops its refresh. Every board now lives in Product Wise, which does not depend on it.
import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./config.js";

const EVENT = "apd-config-changed";

/** { enabled, installed, active } — null while loading. Re-reads when any switch changes it. */
export function useApdConfig() {
  const [cfg, setCfg] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/apd/config`);
      const d = await r.json();
      if (d.ok) setCfg(d);
    } catch {
      /* backend down: keep the last value */
    }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(EVENT, load);
    return () => window.removeEventListener(EVENT, load);
  }, [load]);
  return cfg;
}

export async function setApdEnabled(enabled) {
  const r = await fetch(`${API_BASE}/api/apd/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "could not save");
  window.dispatchEvent(new Event(EVENT));
  return d;
}

/** Switch + one-line status. compact: just the switch and label. */
export function ApdToggle({ compact = false }) {
  const cfg = useApdConfig();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!cfg) return null;
  const flip = async () => {
    setBusy(true);
    setErr("");
    try {
      await setApdEnabled(!cfg.enabled);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };
  const on = cfg.enabled;
  const status = !cfg.installed
    ? "APD folder not found — treated as off"
    : on
      ? "On: sidebar entry, daily 10:15 IST refresh, Today freshness line"
      : "Off: hidden from the sidebar, no refresh (Product Wise has every board)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12 }}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={flip}
        disabled={busy}
        title={on ? "Turn the Automatic Payments Dashboard off" : "Turn the Automatic Payments Dashboard on"}
        style={{ width: 38, height: 20, borderRadius: 999, border: "none", padding: 2, cursor: busy ? "wait" : "pointer", background: on ? "#22c55e" : "#475569", display: "flex", justifyContent: on ? "flex-end" : "flex-start" }}
      >
        <span style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", display: "block" }} />
      </button>
      <span style={{ fontWeight: 600, color: "#e2e8f0" }}>Automatic Payments Dashboard {on ? "on" : "off"}</span>
      {!compact && <span style={{ color: cfg.installed ? "#94a3b8" : "#fbbf24" }}>{status}</span>}
      {err && <span style={{ color: "#f87171" }}>{err}</span>}
    </div>
  );
}
