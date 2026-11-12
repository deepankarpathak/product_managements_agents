// Related tools strip (Phase A, 11 Nov 2026): small cards linking the Jarvis-backed tool pages from the dashboards
// they explain — SR Dissection + HSS traffic on Unified SR (TPAP), SR vs Peers on Acquiring SR (TSP). Reads the
// Today summary (/api/home/summary: backend caches only, no query); each card opens its full page.
import { useEffect, useState } from "react";
import { C, api, fmtAgo, fmtDay } from "./pm-ui.jsx";

const PEER_NAME = { paytm: "Paytm", phonepe: "PhonePe", gpay: "GPay" };
const open = (hash) => {
  window.location.hash = hash;
};

function Tile({ title, hash, children }) {
  return (
    <div
      onClick={() => open(hash)}
      title={`Open ${title}`}
      style={{ flex: "1 1 220px", minWidth: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.text2 }}>
        <b style={{ color: C.text }}>{title}</b>
        <span style={{ color: C.accent }}>open →</span>
      </div>
      <div style={{ fontSize: 12, marginTop: 3, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</div>
    </div>
  );
}

/** show: any of "dissection", "hss", "srbench". */
export default function RelatedTools({ show = [], active = true }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    api("/api/home/summary")
      .then((x) => live && setD(x))
      .catch(() => live && setD({}));
    return () => {
      live = false;
    };
  }, [active]);
  const dis = d?.dissection?.ok ? d.dissection.data : null;
  const hss = d?.hss?.ok ? d.hss.data : null;
  const sa = d?.srAgent;
  const best = sa ? (sa.peers || []).map((p) => ({ p, sr: sa.volumes?.[p]?.sr_pct })).sort((a, b) => (b.sr ?? 0) - (a.sr ?? 0))[0] : null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
      {show.includes("dissection") && (
        <Tile title="SR Dissection" hash="#srdissect">
          {!d ? "Loading…" : dis ? `${fmtDay(dis.date)} · ${Number(dis.lostPts).toFixed(2)} pp lost to failures · ${dis.hotCount} codes rising / spiking` : d.dissection?.error || "no report yet"}
        </Tile>
      )}
      {show.includes("hss") && (
        <Tile title="HSS traffic" hash="#hss">
          {!d
            ? "Loading…"
            : hss
              ? `${Object.entries(hss.globalWeights || {})
                  .map(([k, v]) => `${k.toUpperCase()} ${v.value}%`)
                  .join(" · ")}${hss.changes?.length ? ` · ${hss.changes.length} weight changes` : ""}`
              : d.hss?.error || "unavailable"}
        </Tile>
      )}
      {show.includes("srbench") && (
        <Tile title="SR vs Peers" hash="#srbench">
          {!d
            ? "Loading…"
            : sa
              ? `Paytm ${sa.volumes?.[sa.subject]?.sr_pct?.toFixed(2) ?? "—"}% vs ${PEER_NAME[best?.p] || best?.p || "peers"} ${best?.sr?.toFixed(2) ?? "—"}% · ${sa.actionable?.length || 0} actionable codes · ${fmtAgo(sa.ranAt)}`
              : "not run yet — open to run the benchmark"}
        </Tile>
      )}
    </div>
  );
}
