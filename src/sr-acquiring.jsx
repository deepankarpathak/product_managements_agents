// Acquiring SR page (#acqsr, own sidebar entry — kept out of Unified SR, which is heavy to load). Ports the PTYBL
// Redash dashboards 95 ("[Acquiring] SR Monitoring for DR": PPSL Intent V2, PPSL DQR, OCL DQR, Collect),
// 88, 91 and 69 from the switch clusters C2 / C3 / C6.
// All Redash work is a backend job queue (acqCollector.js), one query at a time; this page only reads stored
// results: Recent = SR by 10 / 30 / 60 min with SR-impact flags (GET /api/acq/recent), Daily = day-level
// SR / U09 / decline mix / stuck txns (GET /api/acq/daily), History = SR-impact timeline + job run history
// (GET /api/acq/history, /api/acq/runs). Query control = job status (GET /api/acq/status).
import { useCallback, useEffect, useMemo, useState } from "react";
import { C, api, fmtNum, fmtAgo, Page, Card, Btn, ErrorNote, th, td } from "./pm-ui.jsx";
import RelatedTools from "./related-tools.jsx";

const pct = (s, t) => (t ? (s / t) * 100 : null);
const fmtPct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const lsGet = (k, d) => {
  try {
    const v = localStorage.getItem(`acq.${k}`);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(`acq.${k}`, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

function Seg({ value, options, onChange }) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: value === v ? "#1e3a5f" : C.card2,
            color: value === v ? "#fff" : C.text2,
            fontWeight: value === v ? 600 : 400,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** rows → { [panel]: { minutes: [{ ts, success, total, pending, byCluster }], codes: [{ code, cnt }], success, total, pending, fail } } */
const TYPE_COLOR = { TD: "#ef4444", BD: "#f59e0b", "?": "#64748b" };
const TYPE_LABEL = { TD: "Technical (TD)", BD: "Business (BD)", "?": "Unclassified" };

/**
 * Failure codes grouped by NPCI code (U30, U29, U16, M16 …). Each group expands to its reasons
 * (bank response code / NPCI FRM rule / EFRM model). The mix bar splits failures into technical,
 * business and unclassified declines (a bare code such as U30 carries no reason, so no type).
 */
function CodeTable({ codes, codeInfo, attempts, max = 12, showMix = true }) {
  const [open, setOpen] = useState(() => new Set());
  const [all, setAll] = useState(false);
  if (!codes.length) return <div style={{ fontSize: 12, color: C.muted }}>No failure codes.</div>;
  const total = codes.reduce((s, c) => s + c.cnt, 0);
  const typeOf = (code) => codeInfo?.[code]?.type || "?";
  const mix = { TD: 0, BD: 0, "?": 0 };
  const groups = new Map();
  for (const c of codes) {
    const t = typeOf(c.code);
    mix[t] += c.cnt;
    const base = c.code.split(/[-|]/)[0];
    let g = groups.get(base);
    if (!g) groups.set(base, (g = { base, cnt: 0, subs: [], types: { TD: 0, BD: 0, "?": 0 } }));
    g.cnt += c.cnt;
    g.types[t] += c.cnt;
    g.subs.push(c);
  }
  const list = [...groups.values()].sort((x, y) => y.cnt - x.cnt);
  const shown = all ? list : list.slice(0, max);
  const top = list[0].cnt;
  const meaning = (g) => {
    const npci = g.subs.map((x) => codeInfo?.[x.code]?.npci).find(Boolean) || "";
    return npci.replace(new RegExp(`^${g.base}\\s*`), "");
  };
  const reason = (code) => {
    const i = codeInfo?.[code];
    if (!i) return "";
    return (i.frm || i.bank || "").replace(/^NPCI (EFRM model|FRM)\s*/, "");
  };
  const toggle = (k) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const pctOf = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {showMix && (
        <div>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: C.card2 }}>
            {["TD", "BD", "?"].map((k) =>
              mix[k] ? <div key={k} title={`${TYPE_LABEL[k]}: ${fmtNum(mix[k])}`} style={{ width: `${(mix[k] / total) * 100}%`, background: TYPE_COLOR[k] }} /> : null,
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11, marginTop: 4, color: C.text2 }}>
            {["TD", "BD", "?"].map((k) => (
              <span key={k}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: TYPE_COLOR[k], marginRight: 4 }} />
                {TYPE_LABEL[k]} <b style={{ color: C.text }}>{fmtNum(mix[k])}</b> ({pctOf(mix[k], total)})
              </span>
            ))}
            <span style={{ color: C.muted }}>
              {fmtNum(total)} failures{attempts ? ` · ${pctOf(total, attempts)} of attempts` : ""}
            </span>
          </div>
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 96 }} />
            <col />
            <col style={{ width: 84 }} />
            <col style={{ width: 64 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <th style={th}>Code</th>
              <th style={th}>Meaning / reason</th>
              <th style={{ ...th, textAlign: "right" }}>Failures</th>
              <th style={{ ...th, textAlign: "right" }}>% fails</th>
              <th style={{ ...th, textAlign: "right" }}>% attempts</th>
              <th style={th}>Type split</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => {
              const isOpen = open.has(g.base);
              const many = g.subs.length > 1 || g.subs[0].code !== g.base;
              return [
                <tr key={g.base} onClick={() => many && toggle(g.base)} style={{ cursor: many ? "pointer" : "default" }}>
                  <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>
                    {many ? (isOpen ? "▾ " : "▸ ") : "  "}
                    {g.base}
                  </td>
                  <td style={{ ...td, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={meaning(g)}>
                    {meaning(g) || "—"}
                    {many && <span style={{ color: C.muted }}> · {g.subs.length} reasons</span>}
                  </td>
                  <td style={num}>{fmtNum(g.cnt)}</td>
                  <td style={num}>{pctOf(g.cnt, total)}</td>
                  <td style={num}>{pctOf(g.cnt, attempts)}</td>
                  <td style={td}>
                    <div
                      style={{ display: "flex", height: 8, width: `${Math.max(6, (g.cnt / top) * 100)}%`, borderRadius: 3, overflow: "hidden" }}
                      title={["TD", "BD", "?"].map((k) => `${k} ${fmtNum(g.types[k])}`).join(" · ")}
                    >
                      {["TD", "BD", "?"].map((k) => (g.types[k] ? <div key={k} style={{ flex: g.types[k], background: TYPE_COLOR[k] }} /> : null))}
                    </div>
                  </td>
                </tr>,
                ...(isOpen
                  ? g.subs.map((x) => (
                      <tr key={`${g.base}|${x.code}`} style={{ background: C.card2 }}>
                        <td style={{ ...td, paddingLeft: 22, whiteSpace: "nowrap", color: TYPE_COLOR[typeOf(x.code)] }}>
                          {x.code === g.base ? "(no reason)" : x.code.slice(g.base.length + 1)}
                        </td>
                        <td style={{ ...td, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={reason(x.code)}>
                          {x.code === g.base ? "no remitter / beneficiary reason code on the txn" : reason(x.code) || "—"}
                        </td>
                        <td style={num}>{fmtNum(x.cnt)}</td>
                        <td style={num}>{pctOf(x.cnt, total)}</td>
                        <td style={num}>{pctOf(x.cnt, attempts)}</td>
                        <td style={{ ...td, fontSize: 11, color: TYPE_COLOR[typeOf(x.code)] }}>{TYPE_LABEL[typeOf(x.code)]}</td>
                      </tr>
                    ))
                  : []),
              ];
            })}
          </tbody>
        </table>
      </div>
      {list.length > max && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          style={{ justifySelf: "start", background: "none", border: "none", color: "#93c5fd", cursor: "pointer", fontSize: 11, padding: 0 }}
        >
          {all ? "Show top " + max : `Show all ${list.length} codes`}
        </button>
      )}
    </div>
  );
}

const FLOW_LABEL = {
  ppsl_v2: "PPSL Intent V2",
  ppsl_dqr: "PPSL DQR",
  ocl_dqr: "OCL DQR",
  collect: "Collect",
  p2m_other: "P2M other",
  p2p: "P2P",
  lite: "Lite",
  other: "Other",
};
const ACQ_FLOWS = ["ppsl_v2", "ppsl_dqr", "ocl_dqr", "collect", "p2m_other"];
const FLOW_SETS = [["acq", "Acquiring (P2M)", ACQ_FLOWS], ["all", "All txns", Object.keys(FLOW_LABEL)], ...Object.entries(FLOW_LABEL).map(([k, l]) => [k, l, [k]])];
const CLUSTER_IDS = ["C2", "C3", "C6"];
const SLOT_MIN_UI = 10;
const ZERO = () => ({ t: 0, s: 0, f: 0, p: 0, d: 0, u09: 0 });
const addInto = (a, b) => {
  for (const k of Object.keys(a)) a[k] += b[k] || 0;
  return a;
};

/** Sum a day's flow aggregates over the chosen clusters and flows. */
function sumDay(day, clusters, flows) {
  const out = ZERO();
  for (const cl of clusters) for (const f of flows) if (day.flows[`${cl}|${f}`]) addInto(out, day.flows[`${cl}|${f}`]);
  return out;
}
const sumFlow = (day, clusters, flow) => sumDay(day, clusters, [flow]);
const prevDayOf = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const fmtPp = (v) => (v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`);

function AlertStrip({ daily, onRunRouting, routingJob }) {
  const final = !!daily?.collector?.finalReread;
  const routingBusy = routingJob && ["queued", "running"].includes(routingJob.status);
  if (!daily) return null;
  const r = daily.routing || {};
  const yday = daily.days.find((d) => d.day < daily.days[0]?.day && !d.provisional) || daily.days[1];
  let pending = 0;
  let deemed = 0;
  if (yday) {
    for (const [k, n] of Object.entries(yday.stuck || {})) {
      const [st, , settle] = k.split("|");
      if (st === "PENDING") pending += n;
      else if (st === "DEEMED" && settle === "DEFERRED_SETTLEMENT") deemed += n;
    }
  }
  const chip = (key, label, value, bad, title) => (
    <span
      key={key}
      title={title}
      style={{ fontSize: 11, padding: "3px 8px", borderRadius: 999, border: `1px solid ${bad ? C.bad : C.border}`, color: bad ? C.bad : C.text2, background: C.card2 }}
    >
      {label}: <b style={{ color: bad ? C.bad : C.text }}>{value}</b>
    </span>
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span style={{ fontSize: 12, color: C.text2, fontWeight: 600 }}>Alerts</span>
      {yday &&
        chip(
          "pend",
          `Open after ${final ? "12h" : "20 min"} · PENDING ${yday.day}`,
          fmtNum(pending),
          final && pending > 10,
          final
            ? "PAY / LiteSync still PENDING 12h after creation (dashboard 69 alerts above 10)"
            : "PAY / LiteSync still PENDING at the 20-min settle read (slave-safe mode: no 12h re-read, so not comparable to dashboard 69's >12h alert)",
        )}
      {yday &&
        chip(
          "deem",
          `DEEMED deferred ${yday.day}`,
          fmtNum(deemed),
          final && deemed > 10,
          `DEEMED with DEFERRED_SETTLEMENT at the ${final ? "12h" : "20-min settle"} read${final ? " (dashboard 69 alerts above 10)" : ""}`,
        )}
      {(r.checks || []).map((c) =>
        chip(
          `${c.id}|${c.cluster}`,
          `${c.label} · ${c.cluster}`,
          c.error ? "error" : fmtNum(c.value),
          c.error || c.bad,
          c.error || `${c.rule}${c.prev != null ? ` · previous ${fmtNum(c.prev)}` : ""} — PPSL traffic belongs on C2`,
        ),
      )}
      {r.ppsl &&
        chip(
          "ppsl",
          "PPSL merchants off C2",
          fmtNum(r.ppsl.offC2),
          r.ppsl.bad,
          `PMS merchant_details by cluster: ${Object.entries(r.ppsl.byCluster)
            .map(([k, n]) => `${k} ${fmtNum(n)}`)
            .join(", ")} — should not grow`,
        )}
      <span style={{ fontSize: 11, color: C.muted }}>
        routing checked {r.at ? fmtAgo(r.at) : "—"}
        {routingBusy ? ` · ${routingJob.status}…` : ""}
      </span>
      <Btn onClick={onRunRouting} disabled={routingBusy} style={{ padding: "2px 8px", fontSize: 11 }}>
        Re-check
      </Btn>
      {r.error && <span style={{ fontSize: 11, color: C.bad }}>{r.error}</span>}
    </div>
  );
}

function CollectorStatus({ c }) {
  if (!c) return null;
  return (
    <div style={{ fontSize: 11, color: C.muted }}>
      {c.slotMin}-min slots, read {c.lagMin} min after they end and final at the {c.settleMin}-min re-read{c.finalReread ? ` (+ ${c.finalLagMin / 60}h re-read at night)` : ""} ·
      history builds forward from the first run{c.backfillDays ? ` (+ ${c.backfillDays}-day night backfill)` : ""}, kept {c.retentionDays || "all"} days
      {c.hotDays ? ` (older than ${c.hotDays} days gzipped to the archive, read on demand)` : ""} · covered{" "}
      {Object.entries(c.clusters || {})
        .map(([cl, x]) => `${cl} to ${x?.head || "—"}${x?.missing ? ` (${x.missing} slots for the night job)` : ""}`)
        .join(" · ")}
    </div>
  );
}

function DailyView({ daily, err }) {
  const [cluster, setCluster] = useState(() => lsGet("dCluster", "ALL"));
  const [set, setSet] = useState(() => lsGet("dFlows", "acq"));
  const [pick, setPick] = useState(null);
  useEffect(() => lsSet("dCluster", cluster), [cluster]);
  useEffect(() => lsSet("dFlows", set), [set]);

  const clusters = cluster === "ALL" ? CLUSTER_IDS : [cluster];
  const flows = (FLOW_SETS.find(([k]) => k === set) || FLOW_SETS[0])[2];
  const days = daily?.days || [];
  const perDay = (daily?.collector?.slotsPerDay || 144) * clusters.length;
  const rows = days.map((d) => ({ d, agg: sumDay(d, clusters, flows), cov: clusters.reduce((s, cl) => s + (d.slots[cl] || 0), 0) / perDay }));
  // Default detail day = T-1 (the newest day that is not today).
  const selDay = pick || days[1]?.day || days[0]?.day;
  const sel = days.find((d) => d.day === selDay);
  const prevSel = days[days.findIndex((d) => d.day === selDay) + 1];

  if (err) return <ErrorNote>{err}</ErrorNote>;
  if (!daily) return <div style={{ fontSize: 12, color: C.muted }}>Loading day-level data…</div>;

  const shownFlows = flows.length > 1 ? flows : [];
  // Decline mix of the selected day: codes are kept per flow, summed over clusters.
  const codeMap = new Map();
  if (sel) for (const f of flows) for (const c of sel.codes[f] || []) codeMap.set(c.code, (codeMap.get(c.code) || 0) + c.cnt);
  const codes = [...codeMap.entries()].map(([code, cnt]) => ({ code, cnt })).sort((a, b) => b.cnt - a.cnt);
  const selAgg = sel ? sumDay(sel, clusters, flows) : ZERO();
  const stuck = sel ? Object.entries(sel.stuck || {}).filter(([, n]) => n > 0) : [];

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.text2 }}>Cluster:</span>
        <Seg value={cluster} onChange={setCluster} options={[["ALL", "All"], ...CLUSTER_IDS.map((c) => [c, c])]} />
        <span style={{ fontSize: 12, color: C.text2 }}>Flows:</span>
        <select
          value={set}
          onChange={(e) => setSet(e.target.value)}
          style={{ background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12 }}
        >
          {FLOW_SETS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: C.muted }}>Click a day for its decline mix, stuck txns and hourly SR.</span>
      </div>
      <CollectorStatus c={daily.collector} />

      <Card title="Daily SR" right="txn_info by created_on (IST day) · SR = SUCCESS / all · U09 = FAILURE with app_resp_code U09*">
        {!rows.length ? (
          <div style={{ fontSize: 12, color: C.muted }}>
            No days collected yet — history builds forward from the first run (one more day each day, kept {daily.collector?.retentionDays} days).
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Day</th>
                  <th style={{ ...th, textAlign: "right" }}>Coverage</th>
                  <th style={{ ...th, textAlign: "right" }}>Total</th>
                  <th style={{ ...th, textAlign: "right" }}>SR</th>
                  <th style={{ ...th, textAlign: "right" }}>Δ vs prev</th>
                  <th style={{ ...th, textAlign: "right" }}>U09</th>
                  <th style={{ ...th, textAlign: "right" }}>U09 %</th>
                  <th style={{ ...th, textAlign: "right" }}>Pending</th>
                  <th style={{ ...th, textAlign: "right" }}>Deemed</th>
                  {shownFlows.map((f) => (
                    <th key={f} style={{ ...th, textAlign: "right" }}>
                      {FLOW_LABEL[f]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ d, agg, cov }, i) => {
                  const sr = pct(agg.s, agg.t);
                  const prev = rows[i + 1] && pct(rows[i + 1].agg.s, rows[i + 1].agg.t);
                  const delta = sr != null && prev != null ? sr - prev : null;
                  const partial = cov < 0.999;
                  return (
                    <tr key={d.day} onClick={() => setPick(d.day)} style={{ cursor: "pointer", background: d.day === selDay ? "#1e3a5f55" : undefined }}>
                      <td style={td}>
                        {d.day}
                        {daily.collector?.finalReread && d.provisional > 0 && (
                          <span style={{ fontSize: 10, color: C.warn }} title={`${d.provisional} slots not final yet (final after 12h)`}>
                            {" "}
                            provisional
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: partial ? C.warn : C.text2 }}>{(cov * 100).toFixed(0)}%</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtNum(agg.t)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtPct(sr)}</td>
                      <td style={{ ...td, textAlign: "right", color: delta == null ? C.muted : delta < -0.5 ? C.bad : delta > 0.5 ? C.good : C.text2 }}>{fmtPp(delta)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtNum(agg.u09)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{agg.t ? `${((agg.u09 / agg.t) * 100).toFixed(3)}%` : "—"}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtNum(agg.p)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtNum(agg.d)}</td>
                      {shownFlows.map((f) => {
                        const x = sumFlow(d, clusters, f);
                        return (
                          <td key={f} style={{ ...td, textAlign: "right", color: C.text2 }} title={`${fmtNum(x.s)} / ${fmtNum(x.t)}`}>
                            {x.t ? fmtPct(pct(x.s, x.t)) : "—"}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
          Coverage = 10-min slots read ÷ slots in the day (gaps are filled at night within a DB-time budget). Pending / Deemed = still open at the{" "}
          {daily.collector?.finalReread ? "12h re-read (stuck txns, as in Redash dashboard 69)" : "20-min settle read (slave-safe mode: no 12h re-read)"}.
        </div>
      </Card>

      {sel && (
        <Card title={`Decline mix · ${sel.day}`} right={`${FLOW_SETS.find(([k]) => k === set)?.[1]} · all clusters · click a code for its reasons`}>
          <CodeTable codes={codes} codeInfo={daily.codeInfo} attempts={selAgg.t} max={15} />
        </Card>
      )}

      {sel && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 14 }}>
          <Card title={`Hourly SR · ${sel.day}`} right={prevSel ? `vs ${prevSel.day} · all clusters` : "all clusters"}>
            <HourTable day={sel} prev={prevSel} prevDay={prevSel?.day || prevDayOf(sel.day)} flows={flows} />
          </Card>

          <Card title={`Stuck txns · ${sel.day}`} right="PENDING / DEEMED by type · settlement">
            {stuck.length ? (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={th}>Status</th>
                    <th style={th}>Type</th>
                    <th style={th}>Settlement</th>
                    <th style={{ ...th, textAlign: "right" }}>Txns</th>
                  </tr>
                </thead>
                <tbody>
                  {stuck
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, n]) => {
                      const [st, t, settle] = k.split("|");
                      return (
                        <tr key={k}>
                          <td style={td}>{st}</td>
                          <td style={td}>{t}</td>
                          <td style={td}>{settle}</td>
                          <td style={{ ...td, textAlign: "right" }}>{fmtNum(n)}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: 12, color: C.muted }}>None.</div>
            )}
            {daily.collector?.finalReread && sel.provisional > 0 && (
              <div style={{ fontSize: 11, color: C.warn, marginTop: 6 }}>{sel.provisional} slots are under 12h old — their PENDING counts will still resolve.</div>
            )}
          </Card>
        </div>
      )}

      <details style={{ fontSize: 12, color: C.text2 }}>
        <summary style={{ cursor: "pointer" }}>SQL (collector, per cluster per 10-min slot; routing checks)</summary>
        {Object.entries(daily.sql || {}).map(([k, q]) => (
          <div key={k} style={{ marginTop: 8 }}>
            <b>{k}</b>
            <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, overflowX: "auto", fontSize: 11 }}>{q}</pre>
          </div>
        ))}
        {(daily.routing?.sql?.checks || []).map((c) => (
          <div key={c.id} style={{ marginTop: 8 }}>
            <b>routing · {c.label}</b> (C3, C6)
            <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, overflowX: "auto", fontSize: 11 }}>{c.sql}</pre>
          </div>
        ))}
      </details>
    </div>
  );
}

// History builds forward (slave-safe mode); hours before the first run, or missed and not yet gap-filled, show as missing.
function HourTable({ day, prev, prevDay, flows }) {
  const hourSr = (d, h) => {
    const x = { t: 0, s: 0 };
    for (const f of flows) {
      const v = d?.hours?.[h]?.[f];
      if (v) {
        x.t += v.t;
        x.s += v.s;
      }
    }
    return x;
  };
  const hours = Object.keys(day.hours || {}).sort();
  if (!hours.length) return <div style={{ fontSize: 12, color: C.muted }}>No hours collected.</div>;
  const missing = hours.filter((h) => !hourSr(prev, h).t).length;
  return (
    <div style={{ maxHeight: 420, overflowY: "auto" }}>
      {missing > 0 && (
        <div style={{ fontSize: 11, color: C.warn, marginBottom: 6 }}>
          {prevDay}: {missing} of {hours.length} hours not collected — before collection started, or gaps waiting for the night run.
        </div>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={th}>Hour</th>
            <th style={{ ...th, textAlign: "right" }}>Txns</th>
            <th style={{ ...th, textAlign: "right" }}>SR</th>
            <th style={{ ...th, textAlign: "right" }}>Prev day</th>
            <th style={{ ...th, textAlign: "right" }}>Δ</th>
          </tr>
        </thead>
        <tbody>
          {hours.map((h) => {
            const a = hourSr(day, h);
            const b = hourSr(prev, h);
            const sa = pct(a.s, a.t);
            const sb = pct(b.s, b.t);
            const delta = sa != null && sb != null ? sa - sb : null;
            return (
              <tr key={h}>
                <td style={td}>{h}:00</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtNum(a.t)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtPct(sa)}</td>
                <td style={{ ...td, textAlign: "right", color: b.t ? C.text2 : C.muted, fontSize: b.t ? 12 : 10 }}>{b.t ? fmtPct(sb) : "not collected"}</td>
                <td style={{ ...td, textAlign: "right", color: delta == null ? C.muted : delta < -0.5 ? C.bad : delta > 0.5 ? C.good : C.text2 }}>{fmtPp(delta)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

// ─── query control (job queue, Unified SR style) ─────────────────────────────

const STATUS_POLL_BUSY_MS = 5000;
const STATUS_POLL_IDLE_MS = 30000;
const SOURCE_LABEL = { collector: "Slot reads", routing: "Routing checks", live: "Live (old)" };
const DS_LABEL = { 21: "C2", 19: "C3", 14: "C6", 17: "PMS" };
const ACTIVE_JOB = new Set(["queued", "running"]);
const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—");
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const ago = (ms) => {
  if (!ms) return "never";
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return fmtAgo(ms);
};

const JOB_STATUS = {
  idle: { label: "Not run", color: C.muted, icon: "○" },
  queued: { label: "Queued", color: C.text2, icon: "◷" },
  running: { label: "Running", color: "#38bdf8", icon: "⟳" },
  success: { label: "Done", color: C.good, icon: "✓" },
  failed: { label: "Failed", color: C.bad, icon: "✕" },
  cancelled: { label: "Stopped", color: C.warn, icon: "■" },
  "retry-wait": { label: "Retry queued", color: C.warn, icon: "↻" },
};

function JobChip({ job, now }) {
  const st = JOB_STATUS[job?.status || "idle"];
  let extra = "";
  if (job.status === "running" && job.startedAt) extra = ` · ${fmtDur(now - job.startedAt)}`;
  if (job.status === "retry-wait" && job.nextRetryAt) extra = ` · in ${fmtDur(Math.max(0, job.nextRetryAt - now))}${job.attempt ? ` (attempt ${job.attempt + 1})` : ""}`;
  if (job.status === "success" && job.elapsedMs != null) extra = ` · ${fmtDur(job.elapsedMs)}`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: st.color,
        border: `1px solid ${st.color}55`,
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{st.icon}</span>
      {st.label}
      {extra}
    </span>
  );
}

function QueryControl({ status, err, onAction }) {
  const [open, setOpen] = useState(() => lsGet("qcOpen", true));
  const [showQueries, setShowQueries] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => lsSet("qcOpen", open), [open]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!status) return <Card title="Query control">{err ? <ErrorNote>{err}</ErrorNote> : <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>}</Card>;
  const r = status.redash;
  const cov = status.coverage;
  const running = status.jobs.find((j) => j.status === "running");
  const queued = status.jobs.filter((j) => j.status === "queued").length;
  const waiting = status.jobs.filter((j) => j.status === "retry-wait").length;
  const failed = status.jobs.filter((j) => j.status === "failed").length;
  const state = !status.enabled
    ? ["Disabled (ACQ_COLLECTOR=false)", C.muted]
    : status.paused
      ? ["Stopped", C.bad]
      : status.holdReason
        ? [status.holdReason, C.warn]
        : running
          ? [`Running ${running.id}${queued ? ` · ${queued} queued` : ""}`, "#38bdf8"]
          : ["Idle — jobs start when due", C.good];
  const heads = Object.values(cov.clusters)
    .map((x) => x?.head)
    .filter(Boolean)
    .sort();
  const act = (action, body) => onAction(action, body);
  const stat = (label, value, sub) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.text2, marginTop: 1 }}>{sub}</div>}
    </div>
  );
  return (
    <Card
      title={
        <span>
          Query control (TSP Redash){" "}
          <span style={{ fontSize: 12, fontWeight: 600, color: state[1], marginLeft: 8 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: state[1], marginRight: 5 }} />
            {state[0]}
          </span>
          {(waiting > 0 || failed > 0) && (
            <span style={{ fontSize: 11, color: C.warn, marginLeft: 8 }}>
              {waiting ? `${waiting} retry queued` : ""}
              {waiting && failed ? " · " : ""}
              {failed ? `${failed} failed` : ""}
            </span>
          )}
        </span>
      }
      right={
        <span style={{ display: "inline-flex", gap: 6 }}>
          <Btn primary onClick={() => act("jobs/run", { ids: [] })} disabled={status.paused} title="Queue every job now (they still run one at a time)">
            ⟳ Refresh all
          </Btn>
          {status.paused ? (
            <Btn onClick={() => act("collector/resume")} title="Start the automatic queue again">
              ▶ Start sync
            </Btn>
          ) : (
            <Btn onClick={() => act("collector/pause")} title="Stop the running job, clear the queue and stop automatic runs (survives backend restarts)">
              ■ Stop all
            </Btn>
          )}
          <Btn onClick={() => setOpen((v) => !v)}>{open ? "Hide jobs" : "Show jobs"}</Btn>
        </span>
      }
    >
      {err && <ErrorNote>{err}</ErrorNote>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
        {stat("Data updated to", heads[0] ? `${heads[0].slice(11)} · ${heads[0].slice(5, 10)}` : "—", `slots read ${cov.lagMin} min after they end`)}
        {stat("Last slot read", ago(status.lastSlotAt), `${fmtNum(status.slotsRead)} slots since backend start`)}
        {stat(
          cov.nightPlan ? `Night fill → ${cov.nightPlan.fillTo || "holes"}` : "Night fill (holes only)",
          `${fmtNum(cov.night?.slots || 0)} slots · ${fmtNum(cov.night?.steps || 0)} steps`,
          cov.night?.slots
            ? `${cov.inNight ? "filling now" : `starts ${hhmm(cov.nextNightAt)}`} · ${cov.nightUsedMin}/${cov.nightBudgetMin} min DB used · C2 ${cov.night.byCluster.C2} · C3 ${cov.night.byCluster.C3} · C6 ${cov.night.byCluster.C6}`
            : "nothing missing",
        )}
        {cov.trickle?.on &&
          stat(
            `Day trickle → ${cov.trickle.plan.fillTo}`,
            `${fmtNum(cov.trickle.slots)} cluster-slots left`,
            `${cov.trickle.holdUntil ? `resting until ${hhmm(cov.trickle.holdUntil)}` : cov.inNight ? "paused — night job runs" : `every ${cov.trickle.plan.everyMin} min when idle`} · ${cov.trickle.usedMin}/${cov.trickle.plan.budgetMin} min DB today · ${SLOT_MIN_UI / cov.trickle.parts}-min pieces ≤${cov.trickle.maxSec}s`,
          )}
        {stat(
          "Redash queries today",
          r ? fmtNum(r.today) : "—",
          r ? `avg ${r.total ? (r.ms / r.total / 1000).toFixed(1) : "—"}s · ${fmtNum(r.errors)} failed since ${hhmm(r.since)}` : "",
        )}
        {stat("Queue", `${status.gate.inflight} running · ${status.queue.length} waiting`, `one Redash query at a time · checked every ${status.schedulerSec}s`)}
      </div>
      {open && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={th}>Job</th>
                <th style={th}>Status</th>
                <th style={th}>Trigger</th>
                <th style={th}>Last success</th>
                <th style={{ ...th, textAlign: "right" }}>Queries</th>
                <th style={{ ...th, textAlign: "right" }}>Slots</th>
                <th style={th}>Next</th>
                <th style={th}>Result</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {status.jobs.map((j) => (
                <tr key={j.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{j.id}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{j.label}</div>
                  </td>
                  <td style={td}>
                    <JobChip job={j} now={now} />
                    {j.status === "running" && j.current && <div style={{ fontSize: 11, color: C.text2, marginTop: 2 }}>reading {j.current}</div>}
                  </td>
                  <td style={{ ...td, color: C.text2 }}>{j.trigger || "—"}</td>
                  <td style={td}>{j.lastSuccessAt ? `${hhmm(j.lastSuccessAt)} · ${ago(j.lastSuccessAt)}` : "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{j.status === "idle" ? "—" : j.queries}</td>
                  <td style={{ ...td, textAlign: "right" }}>{j.status === "idle" ? "—" : j.slots}</td>
                  <td style={{ ...td, color: C.text2 }}>{status.paused ? "stopped" : j.nextDueAt ? (j.nextDueAt <= now ? "due" : hhmm(j.nextDueAt)) : "—"}</td>
                  <td style={{ ...td, maxWidth: 360, whiteSpace: "normal", color: j.error ? C.bad : C.text2, fontSize: 11 }}>{j.error || j.note || ""}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {(j.status === "retry-wait" || j.status === "failed") && (
                      <Btn onClick={() => act("jobs/retry", { id: j.id })} style={{ padding: "2px 8px", fontSize: 11, marginRight: 4 }}>
                        Retry now
                      </Btn>
                    )}
                    {ACTIVE_JOB.has(j.status) ? (
                      <Btn onClick={() => act("jobs/stop", { ids: [j.id] })} style={{ padding: "2px 8px", fontSize: 11 }}>
                        Stop
                      </Btn>
                    ) : (
                      <Btn onClick={() => act("jobs/run", { ids: [j.id] })} style={{ padding: "2px 8px", fontSize: 11 }} title="Run this job now (also while stopped)">
                        Refresh
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11, color: C.text2, marginTop: 8 }}>
            {r &&
              Object.entries(r.bySource).map(([k, b]) => (
                <span key={k}>
                  {SOURCE_LABEL[k] || k}: <b style={{ color: C.text }}>{fmtNum(b.count)}</b> queries · avg {(b.ms / b.count / 1000).toFixed(1)}s
                  {b.errors ? <span style={{ color: C.bad }}> · {b.errors} failed</span> : null}
                </span>
              ))}
            <button
              type="button"
              onClick={() => setShowQueries((v) => !v)}
              style={{ background: "none", border: "none", color: "#93c5fd", cursor: "pointer", fontSize: 11, padding: 0 }}
            >
              {showQueries ? "Hide" : "Show"} last 30 Redash queries
            </button>
          </div>
          {showQueries && r && (
            <table style={{ borderCollapse: "collapse", marginTop: 8, fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={th}>Time</th>
                  <th style={th}>Source</th>
                  <th style={th}>DB</th>
                  <th style={{ ...th, textAlign: "right" }}>Took</th>
                  <th style={th}>Result</th>
                  <th style={th}>Error</th>
                </tr>
              </thead>
              <tbody>
                {r.recent.map((q, i) => (
                  <tr key={i}>
                    <td style={td}>{new Date(q.at).toLocaleTimeString("en-IN", { hour12: false })}</td>
                    <td style={td}>{SOURCE_LABEL[q.source] || q.source}</td>
                    <td style={td}>{DS_LABEL[q.ds] || q.ds}</td>
                    <td style={{ ...td, textAlign: "right", color: q.ms > 20000 ? C.warn : C.text }} title="total · of which waiting for a free Redash worker">
                      {(q.ms / 1000).toFixed(1)}s{q.waitMs != null ? <span style={{ color: C.muted }}> · queue {(q.waitMs / 1000).toFixed(0)}s</span> : null}
                    </td>
                    <td style={{ ...td, color: q.ok ? C.good : C.bad }}>
                      {q.ok ? "ok" : "failed"}
                      {q.retried ? " (retried)" : ""}
                    </td>
                    <td style={{ ...td, color: C.text2, maxWidth: 420, whiteSpace: "normal" }}>{q.error || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
            Slave protection: jobs run one at a time and each query rests as long as it ran (≤ 50% of the time busy). Every query carries a MySQL time limit — the DB itself stops
            it after {cov.dbMaxSec}s ({cov.dbMaxNightSec}s at night) — and a query over {cov.slowSec}s rests the queue 10 min. In the day only hot data is read: each {cov.slotMin}
            -min slot {cov.lagMin} min after it ends (one query per cluster covers all four flows) and once more at {cov.settleMin} min; a slot not read within {cov.hotMaxMin} min
            is left for the night. Cold reads — the night job{cov.finalReread ? ", 12h final re-reads" : ""} and the PMS merchant scan — run only at night (
            {cov.nightWindow || "off"} IST
            {cov.inNight ? ", running now" : cov.nextNightAt ? `, next ${hhmm(cov.nextNightAt)}` : ""}).
            {cov.nightBudgetMin != null
              ? ` The night job reads C2, C3 and C6 in lockstep — the same 10-min slot on each (side by side: separate hosts, one query per host, resting half as long as each query ran) before the next one back, newest missing first${cov.nightPlan?.fillTo ? `, down to ${cov.nightPlan.fillTo}` : " (holes only)"} — in ${cov.slotMin / cov.nightParts}-min pieces, within ${cov.nightBudgetMin} min of DB time for all clusters together (used tonight: ${cov.nightUsedMin} min — ${Object.entries(
                  cov.nightUsedByCluster || {},
                )
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}).`
              : ""}
            {cov.finalsPending ? ` ${fmtNum(cov.finalsPending)} slots wait for their final re-read.` : ""} Page views never query Redash.
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── SR impact (Recent + History) ────────────────────────────────────────────

const PANEL_FLOWS = [
  ["ppsl_v2", "PPSL · UPI Intent V2"],
  ["ppsl_dqr", "PPSL · DQR flow"],
  ["ocl_dqr", "OCL · DQR flow"],
  ["collect", "Collect · VPA2MERCHANT"],
  ["acq4", "All 4 flows"],
];
const PANEL_LABEL = Object.fromEntries(PANEL_FLOWS);
const SEV = {
  2: { label: "CRITICAL", color: "#f87171", bg: "rgba(239,68,68,0.28)", strip: "#ef4444" },
  1: { label: "WARNING", color: "#fbbf24", bg: "rgba(245,158,11,0.22)", strip: "#f59e0b" },
  0: { label: "OK", color: C.text, bg: "transparent", strip: "#15803d" },
  "-1": { label: "low volume", color: C.muted, bg: "transparent", strip: "#334155" },
};
const stripColor = (sev) => (sev == null ? "#1e293b" : (SEV[sev] || SEV[0]).strip);

function SevBadge({ sev }) {
  if (sev < 1) return null;
  const s = SEV[sev];
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.5, color: s.color, border: `1px solid ${s.color}`, borderRadius: 4, padding: "1px 4px", marginLeft: 6 }}>
      {s.label}
    </span>
  );
}

function ImpactRule({ impact }) {
  if (!impact) return null;
  return (
    <span>
      Impacted = SR {impact.warnPp}pp (warning) / {impact.critPp}pp (critical) below usual, with ≥ {impact.minTxns} txns in the slot. Usual = median SR of the same flow at the same
      time of day (±30 min) over the previous 7 days; until 7 days are collected, the median of the previous 2 hours.
    </span>
  );
}

function IncidentList({ incidents, codeInfo, showDay, max = 50 }) {
  if (!incidents.length) return <div style={{ fontSize: 12, color: C.good }}>No SR impact in this period.</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {showDay && <th style={th}>Day</th>}
            <th style={th}>Time (IST)</th>
            <th style={th}>Flow</th>
            <th style={th}>Severity</th>
            <th style={{ ...th, textAlign: "right" }}>SR</th>
            <th style={{ ...th, textAlign: "right" }}>Usual</th>
            <th style={{ ...th, textAlign: "right" }}>Drop</th>
            <th style={{ ...th, textAlign: "right" }}>Worst 10 min</th>
            <th style={{ ...th, textAlign: "right" }}>Txns</th>
            <th style={{ ...th, textAlign: "right" }} title="Successes expected at the usual SR minus actual successes">
              Lost successes
            </th>
            <th style={th}>Top decline codes (those hours)</th>
          </tr>
        </thead>
        <tbody>
          {incidents.slice(0, max).map((i, k) => (
            <tr key={k} style={{ background: SEV[i.sev].bg }}>
              {showDay && <td style={td}>{new Date(i.from).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}</td>}
              <td style={{ ...td, fontWeight: 700 }}>
                {hhmm(i.from)}–{hhmm(i.to)} <span style={{ color: C.muted, fontWeight: 400 }}>({i.minutes} min)</span>
              </td>
              <td style={td}>{PANEL_LABEL[i.flow] || i.flow}</td>
              <td style={{ ...td, color: SEV[i.sev].color, fontWeight: 700 }}>{SEV[i.sev].label}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtPct(i.sr)}</td>
              <td style={{ ...td, textAlign: "right", color: C.text2 }}>{fmtPct(i.base)}</td>
              <td style={{ ...td, textAlign: "right", color: SEV[i.sev].color }}>{i.dropPp == null ? "—" : `−${i.dropPp.toFixed(2)}pp`}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtPct(i.worstSr)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(i.txns)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtNum(i.lostSuccess)}</td>
              <td style={{ ...td, fontSize: 11, color: C.text2 }}>
                {i.codes.map((c) => (
                  <span key={c.code} title={codeInfo?.[c.code]?.npci || codeInfo?.[c.code]?.bank || ""} style={{ marginRight: 8 }}>
                    <b style={{ color: C.text }}>{c.code}</b> {fmtNum(c.cnt)}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RECENT_POLL_MS = 60000;
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const UNTIL_OPTS = Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(2, "0")}:00`);
const ctlStyle = { background: C.card2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 8px", fontSize: 12, colorScheme: "dark" };

function RecentView({ active, dataRev }) {
  const [hours, setHours] = useState(() => lsGet("rHours", 3));
  const [bucket, setBucket] = useState(() => lsGet("rBucket", 10));
  const [cluster, setCluster] = useState(() => lsGet("rCluster", "ALL"));
  const [mode, setMode] = useState(() => lsGet("rMode", "live"));
  const [date, setDate] = useState(() => lsGet("rDate", istToday()));
  const [until, setUntil] = useState(() => lsGet("rUntil", "24:00"));
  const [codeFlow, setCodeFlow] = useState("acq4");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => lsSet("rHours", hours), [hours]);
  useEffect(() => lsSet("rBucket", bucket), [bucket]);
  useEffect(() => lsSet("rCluster", cluster), [cluster]);
  useEffect(() => lsSet("rMode", mode), [mode]);
  useEffect(() => lsSet("rDate", date), [date]);
  useEffect(() => lsSet("rUntil", until), [until]);
  const live = mode !== "date";
  const load = useCallback(async () => {
    try {
      const at = live ? "" : `&date=${date}&until=${until}`;
      setData(await api(`/api/acq/recent?hours=${hours}&bucket=${bucket}${cluster === "ALL" ? "" : `&cluster=${cluster}`}${at}`));
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
  }, [hours, bucket, cluster, live, date, until]);
  // Stored data only (no Redash call): reload when a job finished, and every minute while live.
  useEffect(() => {
    if (!active) return undefined;
    load();
    if (!live) return undefined;
    const t = setInterval(() => document.visibilityState === "visible" && load(), RECENT_POLL_MS);
    return () => clearInterval(t);
  }, [active, load, dataRev, live]);
  const winFrom = data?.buckets?.length ? data.buckets[data.buckets.length - 1].from : null;
  // IST day + time; a window end at midnight reads as 24:00 of the day before.
  const ist = (ms, end) => {
    const st = new Date(ms + 330 * 60000 - (end ? 1 : 0)).toISOString();
    const t = end && new Date(ms + 330 * 60000).toISOString().slice(11, 16) === "00:00" ? "24:00" : new Date(ms + 330 * 60000).toISOString().slice(11, 16);
    return { d: st.slice(0, 10), t };
  };
  const span = (a, b) => {
    const x = ist(a);
    const y = ist(b, true);
    return x.d === y.d ? `${x.d} ${x.t}–${y.t}` : `${x.d.slice(5)} ${x.t} → ${y.d.slice(5)} ${y.t}`;
  };
  const winLabel = live ? `last ${hours}h` : winFrom ? span(winFrom, data.dataTo) : date;
  const cb = data?.codesBasis;
  const codesLabel = cb?.kind === "hour" ? `${live ? `${hhmm(cb.from)}–${hhmm(cb.to)}` : span(cb.from, cb.to)} by hour, all clusters` : winLabel;

  const totals = useMemo(() => {
    const out = {};
    for (const [f] of PANEL_FLOWS) {
      const a = { t: 0, s: 0, f: 0, u09: 0, exp: 0, tb: 0 };
      for (const b of data?.buckets || []) {
        const x = b.flows[f];
        if (!x) continue;
        a.t += x.t;
        a.s += x.s;
        a.f += x.f;
        a.u09 += x.u09;
        if (x.base != null) {
          a.exp += (x.base / 100) * x.t;
          a.tb += x.t;
        }
      }
      out[f] = a;
    }
    return out;
  }, [data]);

  const latest = data?.buckets?.find((b) => !b.unsettled) || data?.buckets?.[0];
  const openIncidents = (data?.incidents || []).filter((i) => data && i.to >= data.dataTo - 20 * 60000);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <Seg
          value={mode}
          onChange={setMode}
          options={[
            ["live", "Live"],
            ["date", "Pick date"],
          ]}
        />
        {!live && (
          <>
            <input
              type="date"
              value={date}
              min={data?.days?.[0]}
              max={istToday()}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              style={ctlStyle}
              aria-label="Date (IST)"
            />
            <span style={{ fontSize: 12, color: C.text2 }}>until</span>
            <select value={until} onChange={(e) => setUntil(e.target.value)} style={ctlStyle} aria-label="Window ends at (IST)">
              {UNTIL_OPTS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </>
        )}
        <span style={{ fontSize: 12, color: C.text2 }}>Window:</span>
        <Seg value={hours} onChange={setHours} options={[1, 2, 3, 6, 12, 24].map((h) => [h, `${h}h`])} />
        <span style={{ fontSize: 12, color: C.text2 }}>SR by:</span>
        <Seg
          value={bucket}
          onChange={setBucket}
          options={[
            [10, "10 min"],
            [30, "30 min"],
            [60, "1 hour"],
          ]}
        />
        <span style={{ fontSize: 12, color: C.text2 }}>Cluster:</span>
        <Seg value={cluster} onChange={setCluster} options={[["ALL", "All"], ...CLUSTER_IDS.map((c) => [c, c])]} />
        <span style={{ fontSize: 11, color: C.muted }}>
          {live ? (data?.dataTo ? `data to ${hhmm(data.dataTo)} IST · ` : "") : `${winLabel} IST · stored days ${data?.days?.[0] || "—"} → ${data?.days?.at(-1) || "—"} · `}
          from stored slots · no Redash query on view
        </span>
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!data ? (
        <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>
      ) : !data.buckets.length ? (
        <div style={{ fontSize: 12, color: C.muted }}>
          {live ? "No slots read yet — the recent:* jobs fill this within a few minutes." : `No stored slots for ${date} before ${until} IST.`}
        </div>
      ) : (
        <>
          {openIncidents.length > 0 && (
            <div
              style={{
                border: `1px solid ${SEV[Math.max(...openIncidents.map((i) => i.sev))].strip}`,
                borderRadius: 8,
                padding: "10px 12px",
                background: SEV[Math.max(...openIncidents.map((i) => i.sev))].bg,
              }}
            >
              <b style={{ color: SEV[Math.max(...openIncidents.map((i) => i.sev))].color }}>⚠ SR impacted now</b>
              {openIncidents.map((i, k) => (
                <div key={k} style={{ fontSize: 12, marginTop: 4 }}>
                  <b>{PANEL_LABEL[i.flow]}</b> since {hhmm(i.from)} — {fmtPct(i.sr)} vs usual {fmtPct(i.base)} (−{i.dropPp.toFixed(2)}pp) · {fmtNum(i.txns)} txns · ≈{" "}
                  {fmtNum(i.lostSuccess)} lost successes
                  {i.codes.length ? ` · top codes ${i.codes.map((c) => c.code).join(", ")}` : ""}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
            {PANEL_FLOWS.map(([f, label]) => {
              const x = latest?.flows[f];
              const w = totals[f];
              const wsr = w.t ? (w.s / w.t) * 100 : null;
              const wbase = w.tb ? (w.exp / w.tb) * 100 : null;
              const sev = x?.sev ?? -1;
              return (
                <div key={f} style={{ background: C.card, border: `1px solid ${sev >= 1 ? SEV[sev].strip : C.border}`, borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, color: C.text2, fontWeight: 600 }}>
                    {label}
                    <SevBadge sev={sev} />
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: sev >= 1 ? SEV[sev].color : C.text }}>{fmtPct(x?.sr)}</div>
                  <div style={{ fontSize: 11, color: C.text2 }}>
                    {latest ? `${latest.label} slot` : ""} · usual {fmtPct(x?.base)} {x?.base != null && x?.sr != null ? `(${fmtPp(x.sr - x.base)})` : ""}
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {live ? `${hours}h` : "window"}: {fmtPct(wsr)} {wbase != null && wsr != null ? `(${fmtPp(wsr - wbase)})` : ""} · {fmtNum(w.t)} txns · U09 {fmtNum(w.u09)}
                  </div>
                </div>
              );
            })}
          </div>

          <Card
            title={`SR by ${bucket === 60 ? "hour" : `${bucket} min`} — ${winLabel}`}
            right={<span style={{ fontSize: 11, color: C.muted }}>newest first · ~ = not yet settled</span>}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={th}>Time (IST)</th>
                    {PANEL_FLOWS.map(([f, l]) => (
                      <th key={f} style={{ ...th, textAlign: "right" }}>
                        {l}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => {
                    const worst = Math.max(-1, ...Object.values(b.flows).map((x) => x.sev ?? -1));
                    return (
                      <tr key={b.from} style={{ borderLeft: `3px solid ${worst >= 1 ? SEV[worst].strip : "transparent"}` }}>
                        <td style={{ ...td, whiteSpace: "nowrap", fontWeight: worst >= 1 ? 700 : 400, color: worst >= 1 ? SEV[worst].color : C.text }}>
                          {b.label}–{hhmm(b.to)}
                          {b.unsettled ? " ~" : ""}
                          {b.partial ? <span style={{ color: C.muted, fontWeight: 400 }}> (so far)</span> : null}
                          {b.missing?.length ? (
                            <div style={{ fontSize: 10, color: C.warn, fontWeight: 400 }} title="These clusters have not read this time yet — totals are partial and not judged">
                              waiting for {b.missing.join(", ")}
                            </div>
                          ) : null}
                          <SevBadge sev={worst} />
                        </td>
                        {PANEL_FLOWS.map(([f]) => {
                          const x = b.flows[f];
                          if (!x)
                            return (
                              <td key={f} style={{ ...td, textAlign: "right", color: C.muted }}>
                                —
                              </td>
                            );
                          const s = SEV[x.sev] || SEV[0];
                          return (
                            <td
                              key={f}
                              style={{ ...td, textAlign: "right", background: x.sev >= 1 ? s.bg : "transparent" }}
                              title={`${fmtNum(x.s)} / ${fmtNum(x.t)} success · ${fmtNum(x.f)} failed · U09 ${fmtNum(x.u09)} · pending ${fmtNum(x.p)}${x.base != null ? ` · usual ${fmtPct(x.base)}` : ""}`}
                            >
                              <div style={{ fontWeight: 600, color: x.sev >= 1 ? s.color : x.sev === -1 ? C.muted : C.text }}>{fmtPct(x.sr)}</div>
                              <div style={{ fontSize: 10, color: C.muted }}>
                                {fmtNum(x.t)}
                                {x.base != null && x.sr != null ? ` · ${fmtPp(x.sr - x.base)}` : ""}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              SR = success / all txns created in the slot. Cell colour: amber warning, red critical. Grey = under {data.impact.minTxns} txns (not judged).{" "}
              <ImpactRule impact={data.impact} />
            </div>
          </Card>

          <Card title={`SR impact — ${winLabel}`}>
            <IncidentList incidents={data.incidents} codeInfo={data.codeInfo} />
          </Card>

          <Card title={`Decline codes — ${codesLabel}`} right={<Seg value={codeFlow} onChange={setCodeFlow} options={PANEL_FLOWS.map(([f, l]) => [f, l.replace(" · ", " ")])} />}>
            <CodeTable codes={data.codes[codeFlow] || []} codeInfo={data.codeInfo} attempts={totals[codeFlow]?.t} max={12} />
          </Card>
        </>
      )}
    </div>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────

function HistoryView({ active, dataRev }) {
  const [days, setDays] = useState(() => lsGet("hDays", 7));
  const [cluster, setCluster] = useState(() => lsGet("hCluster", "ALL"));
  const [sevMin, setSevMin] = useState(() => lsGet("hSev", 1));
  const [data, setData] = useState(null);
  const [runs, setRuns] = useState([]);
  const [err, setErr] = useState("");
  const [runFilter, setRunFilter] = useState("all");
  useEffect(() => lsSet("hDays", days), [days]);
  useEffect(() => lsSet("hCluster", cluster), [cluster]);
  useEffect(() => lsSet("hSev", sevMin), [sevMin]);
  const load = useCallback(async () => {
    try {
      const [h, r] = await Promise.all([api(`/api/acq/history?days=${days}${cluster === "ALL" ? "" : `&cluster=${cluster}`}`), api("/api/acq/runs?limit=300")]);
      setData(h);
      setRuns(r.runs);
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
  }, [days, cluster]);
  useEffect(() => {
    if (active) load();
  }, [active, load, dataRev]);

  const incidents = (data?.days || []).flatMap((d) => d.incidents).filter((i) => i.sev >= sevMin);
  const shownRuns = runs.filter((r) => runFilter === "all" || (runFilter === "problems" ? r.status !== "success" : r.id.startsWith(runFilter)));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.text2 }}>Days:</span>
        <Seg value={days} onChange={setDays} options={[3, 7, 14, 35, 60].map((d) => [d, `${d}`])} />
        <span style={{ fontSize: 12, color: C.text2 }}>Cluster:</span>
        <Seg value={cluster} onChange={setCluster} options={[["ALL", "All"], ...CLUSTER_IDS.map((c) => [c, c])]} />
        <span style={{ fontSize: 12, color: C.text2 }}>Show:</span>
        <Seg
          value={sevMin}
          onChange={setSevMin}
          options={[
            [1, "Warning + critical"],
            [2, "Critical only"],
          ]}
        />
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!data ? (
        <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>
      ) : (
        <>
          <Card title="SR impact timeline (10-min slots, IST)" right={<span style={{ fontSize: 11, color: C.muted }}>hover a cell for time</span>}>
            {data.days.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>No days collected yet.</div>}
            {data.days.map((d) => (
              <div key={d.day} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline", fontSize: 12 }}>
                  <b>{d.day}</b>
                  <span style={{ color: C.text2 }}>
                    4 flows SR {fmtPct(d.totals.acq4.sr)} · {fmtNum(d.totals.acq4.t)} txns
                  </span>
                  {d.critical > 0 && <span style={{ color: SEV[2].color, fontWeight: 700 }}>{d.critical} critical</span>}
                  {d.warning > 0 && <span style={{ color: SEV[1].color, fontWeight: 700 }}>{d.warning} warning</span>}
                  {d.impactedMin > 0 && <span style={{ color: C.text2 }}>{d.impactedMin} min impacted (any flow)</span>}
                  {!d.critical && !d.warning && <span style={{ color: C.good }}>no impact</span>}
                </div>
                {PANEL_FLOWS.map(([f, label]) => (
                  <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                    <span style={{ width: 150, flex: "0 0 150px", fontSize: 11, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                    <div style={{ display: "flex", flex: 1, minWidth: 0, height: 12, gap: 0 }}>
                      {d.strips[f].map((sev, k) => (
                        <div
                          key={k}
                          title={`${String(Math.floor(k / 6)).padStart(2, "0")}:${String((k % 6) * 10).padStart(2, "0")} · ${sev == null ? "not read" : (SEV[sev] || SEV[0]).label}`}
                          style={{ flex: 1, minWidth: 1, background: stripColor(sev), borderRight: k % 6 === 5 ? `1px solid ${C.bg}` : "none" }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  <span style={{ width: 150, flex: "0 0 150px" }} />
                  <div style={{ display: "flex", flex: 1, fontSize: 9, color: C.muted, justifyContent: "space-between" }}>
                    {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                      <span key={h}>{String(h).padStart(2, "0")}</span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, color: C.text2 }}>
              {[
                [2, "Critical"],
                [1, "Warning"],
                [0, "OK"],
                [-1, "Low volume"],
                [null, "Not read yet"],
              ].map(([s, l]) => (
                <span key={l}>
                  <span style={{ display: "inline-block", width: 10, height: 10, background: stripColor(s), marginRight: 4, verticalAlign: "middle" }} />
                  {l}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
              <ImpactRule impact={data.impact} />
            </div>
          </Card>

          <Card title={`Times SR was impacted — last ${days} days`} right={<span style={{ fontSize: 11, color: C.muted }}>{incidents.length} windows</span>}>
            <IncidentList incidents={incidents} codeInfo={data.codeInfo} showDay max={200} />
          </Card>

          <Card
            title="Run history (query jobs)"
            right={
              <Seg
                value={runFilter}
                onChange={setRunFilter}
                options={[
                  ["all", "All"],
                  ["problems", "Failed / stopped"],
                  ["recent", "Recent"],
                  ["night", "Night"],
                  ["routing", "Checks"],
                ]}
              />
            }
          >
            {shownRuns.length === 0 ? (
              <div style={{ fontSize: 12, color: C.muted }}>No runs yet.</div>
            ) : (
              <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={th}>Finished</th>
                      <th style={th}>Job</th>
                      <th style={th}>Trigger</th>
                      <th style={th}>Status</th>
                      <th style={{ ...th, textAlign: "right" }}>Took</th>
                      <th style={{ ...th, textAlign: "right" }}>Queries</th>
                      <th style={{ ...th, textAlign: "right" }}>Slots</th>
                      <th style={th}>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRuns.map((r, i) => (
                      <tr key={i}>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {new Date(r.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}
                        </td>
                        <td style={td}>{r.id}</td>
                        <td style={{ ...td, color: C.text2 }}>{r.trigger}</td>
                        <td style={{ ...td, color: (JOB_STATUS[r.status] || JOB_STATUS.idle).color, fontWeight: 600 }}>{(JOB_STATUS[r.status] || { label: r.status }).label}</td>
                        <td style={{ ...td, textAlign: "right" }}>{fmtDur(r.ms)}</td>
                        <td style={{ ...td, textAlign: "right" }}>{r.queries}</td>
                        <td style={{ ...td, textAlign: "right" }}>{r.slots}</td>
                        <td style={{ ...td, fontSize: 11, color: r.error ? C.bad : C.text2, maxWidth: 420, whiteSpace: "normal" }}>{r.error || r.note || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ─── page ────────────────────────────────────────────────────────────────────

const DAILY_REFRESH_MS = 15 * 60000;

// ── Daily SR pattern — SR by time of day (IST): today against the earlier days' min–max band and median.
const PATTERN_FLOWS = [
  ["acq4", "All 4 flows"],
  ["ppsl_v2", "PPSL Intent V2"],
  ["ppsl_dqr", "PPSL DQR"],
  ["ocl_dqr", "OCL DQR"],
  ["collect", "Collect"],
  ["p2m_other", "P2M other"],
  ["p2p", "P2P"],
];
const PATTERN_LABEL = Object.fromEntries(PATTERN_FLOWS);
const PAT_TODAY = C.accent;
const PAT_PAST = "#94a3b8";
const bucketHm = (b, bucketMin) => `${String(Math.floor((b * bucketMin) / 60)).padStart(2, "0")}:${String((b * bucketMin) % 60).padStart(2, "0")}`;
const ppText = (v) => (v == null ? "—" : `${v > 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}pp`);

function PatternChart({ data, flow }) {
  const [hover, setHover] = useState(null);
  const f = data.flows[flow];
  const n = 1440 / data.bucketMin;
  const W = 960;
  const H = 300;
  const M = { l: 44, r: 14, t: 14, b: 26 };
  const past = data.days.filter((d) => d !== data.today);
  const vals = [];
  for (const d of data.days) for (const x of f.lines[d] || []) if (x?.sr != null && x.t >= 50) vals.push(x.sr);
  for (const x of f.band) if (x) vals.push(x.min, x.max);
  if (!vals.length) return <div style={{ fontSize: 12, color: C.muted, padding: 12 }}>No settled data for this flow yet.</div>;
  const lo = Math.max(0, Math.floor(Math.min(...vals) - 0.5));
  const hi = Math.min(100, Math.ceil(Math.max(...vals) + 0.3));
  const x = (b) => M.l + ((b + 0.5) / n) * (W - M.l - M.r);
  const y = (v) => M.t + (1 - (v - lo) / (hi - lo || 1)) * (H - M.t - M.b);
  const path = (pts) => {
    let out = "";
    let pen = false;
    pts.forEach((p, b) => {
      if (p == null) return void (pen = false);
      out += `${pen ? "L" : "M"}${x(b).toFixed(1)},${y(p).toFixed(1)}`;
      pen = true;
    });
    return out;
  };
  const lineOf = (d) => (f.lines[d] || []).map((p) => (p && p.t >= 50 ? p.sr : null));
  // Band as one polygon per run of consecutive buckets.
  const bandPolys = [];
  let run = [];
  f.band.forEach((p, b) => {
    if (p) run.push([b, p]);
    if ((!p || b === n - 1) && run.length) {
      const top = run.map(([k, q]) => `${x(k).toFixed(1)},${y(q.max).toFixed(1)}`);
      const bot = run.map(([k, q]) => `${x(k).toFixed(1)},${y(q.min).toFixed(1)}`).reverse();
      bandPolys.push(`${top.join(" ")} ${bot.join(" ")}`);
      run = [];
    }
  });
  const step = hi - lo > 12 ? 5 : hi - lo > 5 ? 2 : hi - lo > 2 ? 1 : 0.5;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  const nightW = x(((data.hours.night[1] + 1) * 60) / data.bucketMin - 0.5) - M.l;
  const below = new Map(f.below.map((p) => [p.b, p]));
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const b = Math.floor(((px - M.l) / (W - M.l - M.r)) * n);
    setHover(b >= 0 && b < n ? b : null);
  };
  const today = f.lines[data.today] || [];
  const hb = hover != null ? { b: hover, today: today[hover], band: f.band[hover], past: past.map((d) => [d, f.lines[d]?.[hover]]) } : null;
  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`${PATTERN_LABEL[flow]} SR by time of day`}
      >
        <rect x={M.l} y={M.t} width={nightW} height={H - M.t - M.b} fill="#ffffff" opacity={0.035} />
        <text x={M.l + 6} y={M.t + 12} fontSize={11} fill={C.muted}>
          Night {String(data.hours.night[0]).padStart(2, "0")}:00–{String(data.hours.night[1] + 1).padStart(2, "0")}:00
        </text>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={C.border} strokeWidth={1} />
            <text x={M.l - 6} y={y(v) + 4} fontSize={11} fill={C.muted} textAnchor="end">
              {v % 1 ? v.toFixed(1) : v}%
            </text>
          </g>
        ))}
        {Array.from({ length: 9 }, (_, k) => k * 3).map((h) => (
          <text key={h} x={M.l + ((h * 60) / 1440) * (W - M.l - M.r)} y={H - 8} fontSize={11} fill={C.muted} textAnchor={h ? "middle" : "start"}>
            {String(h).padStart(2, "0")}:00
          </text>
        ))}
        {bandPolys.map((pts, k) => (
          <polygon key={k} points={pts} fill={PAT_PAST} opacity={0.16} />
        ))}
        {past.map((d) => (
          <path key={d} d={path(lineOf(d))} fill="none" stroke={PAT_PAST} strokeWidth={1} opacity={0.45} />
        ))}
        <path d={path(f.band.map((p) => p?.med ?? null))} fill="none" stroke={PAT_PAST} strokeWidth={1.5} strokeDasharray="4 3" />
        <path d={path(lineOf(data.today))} fill="none" stroke={PAT_TODAY} strokeWidth={2} strokeLinejoin="round" />
        {[...below.values()].map((p) => (
          <circle key={p.b} cx={x(p.b)} cy={y(p.sr)} r={4.5} fill={p.sev === 2 ? C.bad : C.warn} stroke={C.card} strokeWidth={2} />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} stroke={C.text2} strokeWidth={1} opacity={0.5} />}
        {hover != null && today[hover]?.sr != null && <circle cx={x(hover)} cy={y(today[hover].sr)} r={4} fill={PAT_TODAY} stroke={C.card} strokeWidth={2} />}
      </svg>
      {hb && (
        <div
          style={{
            position: "absolute",
            top: 8,
            [hover / n > 0.6 ? "left" : "right"]: 8,
            background: C.card2,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            color: C.text,
            pointerEvents: "none",
            minWidth: 190,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {bucketHm(hb.b, data.bucketMin)}–{bucketHm(hb.b + 1, data.bucketMin)} IST
          </div>
          <div>
            <span style={{ color: PAT_TODAY }}>━</span> Today {fmtPct(hb.today?.sr ?? null)}{" "}
            {hb.today ? <span style={{ color: C.muted }}>· {fmtNum(hb.today.t)} txns</span> : <span style={{ color: C.muted }}>· not settled</span>}
          </div>
          {hb.band && (
            <div style={{ color: C.text2 }}>
              Median {fmtPct(hb.band.med)} · range {hb.band.min.toFixed(2)}–{hb.band.max.toFixed(2)}% ({hb.band.n}d)
            </div>
          )}
          {hb.past.map(([d, p]) => (
            <div key={d} style={{ color: C.muted }}>
              {d.slice(5)} {fmtPct(p?.sr ?? null)}
              {p ? ` · ${fmtNum(p.t)}` : ""}
            </div>
          ))}
          {below.has(hb.b) && <div style={{ color: below.get(hb.b).sev === 2 ? C.bad : C.warn, marginTop: 4 }}>▼ {below.get(hb.b).gap.toFixed(1)}pp below median</div>}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11, color: C.text2, marginTop: 6 }}>
        <span>
          <span style={{ color: PAT_TODAY }}>━━</span> Today ({data.today.slice(5)})
        </span>
        <span>
          <span style={{ color: PAT_PAST, opacity: 0.6 }}>━━</span> Earlier days
        </span>
        <span>
          <span style={{ color: PAT_PAST }}>╍╍</span> Median of earlier days
        </span>
        <span>
          <span style={{ display: "inline-block", width: 14, height: 8, background: PAT_PAST, opacity: 0.3, verticalAlign: "middle" }} /> Min–max of earlier days
        </span>
        <span>
          <span style={{ color: C.warn }}>●</span> ≥{data.impact.warnPp}pp / <span style={{ color: C.bad }}>●</span> ≥{data.impact.critPp}pp below median
        </span>
      </div>
    </div>
  );
}

function PatternView({ active, dataRev }) {
  const [days, setDays] = useState(() => lsGet("pDays", 7));
  const [bucket, setBucket] = useState(() => lsGet("pBucket", 30));
  const [cluster, setCluster] = useState(() => lsGet("pCluster", "ALL"));
  const [flow, setFlow] = useState(() => lsGet("pFlow", "acq4"));
  const [showTable, setShowTable] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => lsSet("pDays", days), [days]);
  useEffect(() => lsSet("pBucket", bucket), [bucket]);
  useEffect(() => lsSet("pCluster", cluster), [cluster]);
  useEffect(() => lsSet("pFlow", flow), [flow]);
  const load = useCallback(async () => {
    try {
      setData(await api(`/api/acq/pattern?days=${days}&bucket=${bucket}${cluster === "ALL" ? "" : `&cluster=${cluster}`}`));
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
  }, [days, bucket, cluster]);
  useEffect(() => {
    if (active) load();
  }, [active, load, dataRev]);

  const f = data?.flows?.[flow];
  const at = (b) => (b == null ? "—" : bucketHm(b, data.bucketMin));
  const insights = useMemo(() => {
    if (!data) return [];
    const out = [];
    const rows = PATTERN_FLOWS.map(([k]) => [k, data.flows[k]?.summary]).filter(([, s]) => s && s.txns > 0);
    const dips = rows.filter(([, s]) => s.dipPp != null && s.dipPp >= 1).sort((a, b) => b[1].dipPp - a[1].dipPp);
    if (dips.length) out.push(`Night dip (00:00–06:00 vs 07:00–22:00): ${dips.map(([k, s]) => `${PATTERN_LABEL[k]} ${ppText(s.dipPp)}`).join(" · ")}.`);
    const up = rows.filter(([, s]) => s.dipPp != null && s.dipPp <= -1);
    if (up.length) out.push(`Better at night than by day: ${up.map(([k, s]) => `${PATTERN_LABEL[k]} ${ppText(s.dipPp)}`).join(" · ")}.`);
    const fs = data.flows[flow]?.summary;
    if (fs?.lowest)
      out.push(
        `${PATTERN_LABEL[flow]}: lowest SR at ${at(fs.lowest.b)} (${fmtPct(fs.lowest.sr)}), best at ${at(fs.highest.b)} (${fmtPct(fs.highest.sr)}), busiest at ${at(fs.peakVol?.b)}.`,
      );
    const below = rows.filter(([k]) => data.flows[k].below.length);
    if (below.length)
      out.push(`Today below the earlier-days median: ${below.map(([k]) => `${PATTERN_LABEL[k]} at ${data.flows[k].below.map((p) => at(p.b)).join(", ")}`).join(" · ")}.`);
    else if (data.bandDays) out.push("Today has no bucket ≥ " + data.impact.warnPp + "pp below the earlier-days median.");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, flow]);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
        <Seg value={flow} onChange={setFlow} options={PATTERN_FLOWS} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12, color: C.text2 }}>Days:</span>
        <Seg value={days} onChange={setDays} options={[3, 7, 14, 35, 60].map((d) => [d, `${d}`])} />
        <span style={{ fontSize: 12, color: C.text2 }}>Bucket:</span>
        <Seg value={bucket} onChange={setBucket} options={[10, 30, 60].map((b) => [b, `${b} min`])} />
        <span style={{ fontSize: 12, color: C.text2 }}>Cluster:</span>
        <Seg value={cluster} onChange={setCluster} options={[["ALL", "All"], ...CLUSTER_IDS.map((c) => [c, c])]} />
      </div>
      {err && <ErrorNote>{err}</ErrorNote>}
      {!data ? (
        <div style={{ fontSize: 12, color: C.muted }}>Loading…</div>
      ) : (
        <>
          {data.bandDays < 3 && (
            <div style={{ fontSize: 12, color: C.warn, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px" }}>
              Only {data.days.length} day{data.days.length === 1 ? "" : "s"} collected ({data.days.join(", ")}) — the earlier-days band and median firm up from 3+ full days. Night
              fills add the missing hours.
            </div>
          )}
          <Card
            title={`${PATTERN_LABEL[flow]} — SR by time of day (IST, ${data.bucketMin}-min buckets)`}
            right={<span style={{ fontSize: 11, color: C.muted }}>SR = success / all · settled slots on {data.clusters.join(" + ")} only · hover for values</span>}
          >
            <PatternChart data={data} flow={flow} />
            {insights.length > 0 && (
              <ul style={{ margin: "12px 0 0", paddingLeft: 18, fontSize: 12, color: C.text, display: "grid", gap: 4 }}>
                {insights.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </Card>
          <Card
            title="Night vs day, all flows"
            right={<span style={{ fontSize: 11, color: C.muted }}>click a row to chart it · volume-weighted over {data.days.length} day(s)</span>}
          >
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Flow", "Day SR 07–22", "Night SR 00–06", "Night dip", "Lowest SR at", "Best SR at", "Busiest at", "Today below band", "Txns"].map((h) => (
                      <th key={h} style={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PATTERN_FLOWS.map(([k, label]) => {
                    const s = data.flows[k]?.summary;
                    if (!s) return null;
                    const bl = data.flows[k].below;
                    return (
                      <tr key={k} onClick={() => setFlow(k)} style={{ cursor: "pointer", background: k === flow ? "#13233d" : undefined }}>
                        <td style={td}>{label}</td>
                        <td style={td}>{fmtPct(s.daySr)}</td>
                        <td style={td}>{fmtPct(s.nightSr)}</td>
                        <td style={{ ...td, color: s.dipPp >= 5 ? C.bad : s.dipPp >= 2 ? C.warn : C.text2 }}>
                          {s.dipPp >= 5 ? "▼▼ " : s.dipPp >= 2 ? "▼ " : ""}
                          {ppText(s.dipPp)}
                        </td>
                        <td style={td}>{s.lowest ? `${at(s.lowest.b)} · ${fmtPct(s.lowest.sr)}` : "—"}</td>
                        <td style={td}>{s.highest ? `${at(s.highest.b)} · ${fmtPct(s.highest.sr)}` : "—"}</td>
                        <td style={td}>{at(s.peakVol?.b)}</td>
                        <td style={{ ...td, color: bl.length ? C.warn : C.muted }}>{bl.length ? `${bl.length} bucket${bl.length > 1 ? "s" : ""}` : "none"}</td>
                        <td style={td}>{fmtNum(s.txns)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title={`${PATTERN_LABEL[flow]} — values`} right={<Btn onClick={() => setShowTable((v) => !v)}>{showTable ? "Hide table" : "Show table"}</Btn>}>
            {showTable && f && (
              <div style={{ overflowX: "auto", maxHeight: 420 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={th}>Time</th>
                      {data.days.map((d) => (
                        <th key={d} style={th}>
                          {d === data.today ? `Today ${d.slice(5)}` : d.slice(5)}
                        </th>
                      ))}
                      <th style={th}>Median</th>
                      <th style={th}>Min–max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.band.map((bd, b) => (
                      <tr key={b}>
                        <td style={td}>{at(b)}</td>
                        {data.days.map((d) => {
                          const p = f.lines[d]?.[b];
                          return (
                            <td key={d} style={td}>
                              {p ? `${fmtPct(p.sr)} · ${fmtNum(p.t)}` : "—"}
                            </td>
                          );
                        })}
                        <td style={td}>{bd ? fmtPct(bd.med) : "—"}</td>
                        <td style={td}>{bd ? `${bd.min.toFixed(2)}–${bd.max.toFixed(2)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default function AcquiringSr({ active = true }) {
  const [view, setView] = useState(() => {
    const v = lsGet("view", "recent");
    return ["recent", "pattern", "daily", "history"].includes(v) ? v : "recent";
  });
  const [daily, setDaily] = useState(null);
  const [dailyErr, setDailyErr] = useState("");
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState("");
  useEffect(() => lsSet("view", view), [view]);

  const loadDaily = useCallback(async () => {
    try {
      setDaily(await api("/api/acq/daily"));
      setDailyErr("");
    } catch (e) {
      setDailyErr(e.message);
    }
  }, []);
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api("/api/acq/status"));
      setStatusErr("");
    } catch (e) {
      setStatusErr(e.message);
    }
  }, []);

  // Status: backend-only (no Redash call); every 5 s while jobs run, else 30 s.
  const busy = !!status?.jobs?.some((j) => ACTIVE_JOB.has(j.status));
  useEffect(() => {
    if (!active) return undefined;
    loadStatus();
    const t = setInterval(() => document.visibilityState === "visible" && loadStatus(), busy ? STATUS_POLL_BUSY_MS : STATUS_POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [active, busy, loadStatus]);

  // A finished slot / check job bumps dataRev → views reload their stored data.
  const dataRev = useMemo(() => Math.max(0, ...(status?.jobs || []).filter((j) => j.slots > 0 || j.group === "Checks").map((j) => j.lastRunAt || 0)), [status]);
  useEffect(() => {
    if (!active) return undefined;
    loadDaily();
    const t = setInterval(() => document.visibilityState === "visible" && loadDaily(), DAILY_REFRESH_MS);
    return () => clearInterval(t);
  }, [active, loadDaily]);
  useEffect(() => {
    if (active && dataRev && (view === "daily" || daily)) loadDaily();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRev]);

  const action = async (path, body) => {
    try {
      setStatus(await api(`/api/acq/${path}`, { method: "POST", body: JSON.stringify(body || {}) }));
      setStatusErr("");
    } catch (e) {
      setStatusErr(e.message);
    }
  };

  return (
    <Page
      title="⇲ Acquiring SR (TSP)"
      subtitle="PPSL Intent V2 · PPSL DQR · OCL DQR · Collect — SR by 10 min, SR-impact history and a day view up to 60 days from the switch DB (clusters C2 / C3 / C6). Sources: Redash dashboards 95, 88, 91, 69."
    >
      <div style={{ display: "grid", gap: 14 }}>
        <RelatedTools show={["srbench"]} active={active} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <Seg
            value={view}
            onChange={setView}
            options={[
              ["recent", "Recent (1–24h · any date)"],
              ["pattern", "Daily SR pattern"],
              ["daily", "Daily (up to 60 days)"],
              ["history", "History"],
            ]}
          />
        </div>
        <QueryControl status={status} err={statusErr} onAction={action} />
        <AlertStrip daily={daily} onRunRouting={() => action("jobs/run", { ids: ["routing", "ppsl"] })} routingJob={status?.jobs?.find((j) => j.id === "routing")} />
        {view === "recent" ? (
          <RecentView active={active} dataRev={dataRev} />
        ) : view === "pattern" ? (
          <PatternView active={active} dataRev={dataRev} />
        ) : view === "history" ? (
          <HistoryView active={active} dataRev={dataRev} />
        ) : (
          <DailyView daily={daily} err={dailyErr} />
        )}
      </div>
    </Page>
  );
}
