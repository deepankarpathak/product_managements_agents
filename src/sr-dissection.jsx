// SR Dissection — Jarvis ranks every UPI failure code by the SR it cost on a day, splits it across
// bank / app version / amount …, and writes an AI summary per code. Reads finished reports via
// /api/jarvis/srdissect/* (new days are analysed in Jarvis itself — it needs a Trino sign-in there).
import { Fragment, useEffect, useMemo, useState } from "react";
import { C, JARVIS_URL, api, fmtNum, fmtDay, Page, Card, Btn, ErrorNote, inputStyle, th, td } from "./pm-ui.jsx";

const TREND_COLOR = { spike: C.bad, up: C.warn, new: C.warn, down: C.good, steady: C.muted };

export default function SrDissection() {
  const [runs, setRuns] = useState([]);
  const [date, setDate] = useState("");
  const [report, setReport] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [cls, setCls] = useState("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);

  useEffect(() => {
    api("/api/jarvis/srdissect/runs")
      .then((d) => {
        const r = [...(d.runs || [])].sort().reverse();
        setRuns(r);
        setDate((cur) => cur || r[0] || "");
      })
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!date) return;
    setBusy(true);
    setOpen(null);
    api(`/api/jarvis/srdissect/report/${date}`)
      .then((d) => {
        setReport(d);
        setErr("");
      })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false));
  }, [date]);

  const classes = useMemo(() => [...new Set((report?.rows || []).map((r) => r.class).filter(Boolean))], [report]);
  const rows = (report?.rows || []).filter(
    (r) => (cls === "all" || r.class === cls) && (!q || `${r.code} ${r.meaning} ${r.owner} ${r.top_finding}`.toLowerCase().includes(q.toLowerCase()))
  );
  const totalPts = (report?.rows || []).reduce((s, r) => s + (Number(r.sr_points) || 0), 0);
  const ourSide = (report?.rows || []).filter((r) => r.our_side).reduce((s, r) => s + (Number(r.sr_points) || 0), 0);

  return (
    <Page
      title="SR dissection"
      subtitle="Every UPI failure code ranked by the success-rate points it cost, with the dimension that explains it and an AI summary · source: Jarvis SR Dissection (TPAP)"
      actions={
        <>
          {report?.htmlUrl && <Btn onClick={() => window.open(report.htmlUrl, "_blank", "noopener")}>Full report ↗</Btn>}
          <Btn onClick={() => window.open(`${JARVIS_URL}/?tab=sr-dissect`, "_blank", "noopener")}>Analyse a new day in Jarvis ↗</Btn>
        </>
      }
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: C.text2 }}>Day</span>
        {runs.map((d) => (
          <Btn key={d} primary={d === date} onClick={() => setDate(d)} style={{ padding: "4px 10px" }}>
            {fmtDay(d)}
          </Btn>
        ))}
        <span style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter code, bank, owner…" style={{ ...inputStyle, width: 220 }} />
      </div>
      <ErrorNote>{err}</ErrorNote>
      {busy && <div style={{ color: C.muted, fontSize: 12 }}>Loading report…</div>}
      {report && !busy && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Card>
              <div style={{ fontSize: 11, color: C.text2 }}>SR points lost</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{totalPts.toFixed(2)} pp</div>
              <div style={{ fontSize: 11, color: C.muted }}>{report.rows.length} failure codes</div>
            </Card>
            <Card>
              <div style={{ fontSize: 11, color: C.text2 }}>On our side</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: ourSide ? C.warn : C.good }}>{ourSide.toFixed(2)} pp</div>
              <div style={{ fontSize: 11, color: C.muted }}>codes flagged Paytm-fixable</div>
            </Card>
            {report.rows.slice(0, 2).map((r) => (
              <Card key={r.code}>
                <div style={{ fontSize: 11, color: C.text2 }}>#{r.rank} {r.code}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{Number(r.sr_points).toFixed(2)} pp</div>
                <div style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.meaning}</div>
              </Card>
            ))}
          </div>

          <Card
            title={`Failure codes · ${fmtDay(report.date)}`}
            right={
              <span style={{ display: "inline-flex", gap: 6 }}>
                {["all", ...classes].map((c) => (
                  <Btn key={c} primary={cls === c} onClick={() => setCls(c)} style={{ padding: "3px 9px", fontSize: 11 }}>
                    {c === "all" ? "All" : c}
                  </Btn>
                ))}
              </span>
            }
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>#</th>
                    <th style={th}>Code</th>
                    <th style={th}>Meaning</th>
                    <th style={th}>Owner</th>
                    <th style={{ ...th, textAlign: "right" }}>Failures</th>
                    <th style={{ ...th, textAlign: "right" }}>SR pts</th>
                    <th style={{ ...th, textAlign: "right" }}>/10k · T-1 · T-7</th>
                    <th style={th}>Trend</th>
                    <th style={th}>Top finding</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Fragment key={r.code}>
                      <tr onClick={() => setOpen(open === r.code ? null : r.code)} style={{ cursor: "pointer", background: open === r.code ? C.card2 : "transparent" }}>
                        <td style={{ ...td, color: C.muted }}>{r.rank}</td>
                        <td style={{ ...td, fontFamily: "monospace", whiteSpace: "nowrap" }}>
                          {open === r.code ? "▾ " : "▸ "}
                          {r.code}
                        </td>
                        <td style={td}>{r.meaning}</td>
                        <td style={{ ...td, color: C.text2 }}>{r.owner}</td>
                        <td style={{ ...td, textAlign: "right" }}>{fmtNum(r.failures)}</td>
                        <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{Number(r.sr_points).toFixed(3)}</td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", color: C.text2 }}>
                          {Number(r.per_10k).toFixed(1)} · {Number(r.per_10k_t1).toFixed(1)} · {Number(r.per_10k_t7).toFixed(1)}
                        </td>
                        <td style={{ ...td, color: TREND_COLOR[r.trend] || C.text2 }}>{r.trend}</td>
                        <td style={{ ...td, color: C.text2 }}>{r.top_finding}</td>
                      </tr>
                      {open === r.code && (
                        <tr>
                          <td colSpan={9} style={{ ...td, background: C.card2 }}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, padding: "4px 0" }}>
                              <div>
                                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Business view</div>
                                {r.ai_business}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Technical view</div>
                                {r.ai_technical}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>Next step</div>
                                <span style={{ color: "#bfdbfe" }}>{r.ai_next_step}</span>
                              </div>
                            </div>
                            {(r.similar_values || r.deepest_drill) && (
                              <div style={{ marginTop: 8, fontSize: 12, color: C.text2 }}>
                                {r.deepest_drill && (
                                  <div>
                                    <b>Deepest drill:</b> {r.deepest_drill}
                                  </div>
                                )}
                                {r.similar_values && (
                                  <div>
                                    <b>Also over-indexed:</b> {r.similar_values}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </Page>
  );
}
