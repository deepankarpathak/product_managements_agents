// HSS Traffic Distribution — live PSP mix for tpap-hss (HSS_WEIGHT_* in upi_config.application_properties),
// via Jarvis /hss-dashboard (proxied at /api/jarvis/hss). Daily snapshots on the backend flag weight changes.
import { useCallback, useEffect, useMemo, useState } from "react";
import { C, PSP_COLOR, JARVIS_URL, api, fmtAgo, Page, Card, Btn, ErrorNote, MixBar, PspLegend, th, td } from "./pm-ui.jsx";

const sameMix = (a, b, psps) => psps.every((p) => (a?.[p.id] ?? 0) === (b?.[p.id] ?? 0));

export default function HssTraffic() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [acct, setAcct] = useState("all");

  const load = useCallback(async (refresh) => {
    setBusy(true);
    try {
      setData(await api(`/api/jarvis/hss${refresh ? "?refresh=1" : ""}`));
      setErr("");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    load(false);
  }, [load]);

  const psps = data?.psps || [];
  const accounts = useMemo(() => [...new Set((data?.traffic || []).map((t) => t.accountType))], [data]);
  const rows = (data?.traffic || []).filter((t) => acct === "all" || t.accountType === acct);
  const offDoc = (data?.traffic || []).filter((t) => !sameMix(t.live, t.documented, psps));

  return (
    <Page
      title="HSS traffic distribution"
      subtitle={
        <>
          Handle Selection Service PSP mix · live from TPAP Redash <code>upi_config.application_properties</code> via Jarvis · fetched {fmtAgo(data?.fetchedAt)}
        </>
      }
      actions={
        <>
          <Btn onClick={() => window.open(`${JARVIS_URL}/?tab=hss-dashboard`, "_blank", "noopener")}>Open in Jarvis ↗</Btn>
          <Btn primary disabled={busy} onClick={() => load(true)}>
            {busy ? "Loading…" : "↻ Refresh from DB"}
          </Btn>
        </>
      }
    >
      <ErrorNote>{err}</ErrorNote>
      {data && (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {psps.map((p) => {
              const w = data.globalWeights?.[p.id];
              return (
                <Card key={p.id} style={{ borderTop: `3px solid ${PSP_COLOR[p.id]}` }}>
                  <div style={{ fontSize: 11, color: C.text2 }}>{p.label} · global</div>
                  <div style={{ fontSize: 24, fontWeight: 700 }}>{w?.value ?? "—"}%</div>
                  <div style={{ fontSize: 11, color: C.muted }}>updated {w?.updatedOn ? w.updatedOn.slice(0, 10) : "—"}</div>
                </Card>
              );
            })}
            <Card>
              <div style={{ fontSize: 11, color: C.text2 }}>Routes live ≠ documented</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: offDoc.length ? C.warn : C.good }}>{offDoc.length}</div>
              <div style={{ fontSize: 11, color: C.muted }}>filter drift on {data.driftCount ?? 0} routes</div>
            </Card>
          </div>

          <Card title="Changes since last snapshot" right={data.comparedTo ? `vs ${data.comparedTo}` : "first snapshot today — changes show from tomorrow"}>
            {data.changes?.length ? (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Route</th>
                    <th style={th}>PSP</th>
                    <th style={th}>From</th>
                    <th style={th}>To</th>
                  </tr>
                </thead>
                <tbody>
                  {data.changes.map((c, i) => (
                    <tr key={i}>
                      <td style={td}>{c.route}</td>
                      <td style={td}>{c.psp}</td>
                      <td style={td}>{c.from ?? "—"}%</td>
                      <td style={{ ...td, color: C.warn, fontWeight: 600 }}>{c.to ?? "—"}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ fontSize: 12, color: C.muted }}>No weight changes.</div>
            )}
          </Card>

          <Card
            title="Traffic mix by route"
            right={
              <span style={{ display: "inline-flex", gap: 6 }}>
                {["all", ...accounts].map((a) => (
                  <Btn key={a} primary={acct === a} onClick={() => setAcct(a)} style={{ padding: "3px 9px", fontSize: 11 }}>
                    {a === "all" ? "All" : a}
                  </Btn>
                ))}
              </span>
            }
          >
            <div style={{ marginBottom: 8 }}>
              <PspLegend psps={psps} />
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 110 }}>Account</th>
                  <th style={{ ...th, width: 90 }}>Txn type</th>
                  <th style={{ ...th, width: 120 }}>Amount</th>
                  <th style={th}>Live mix</th>
                  {psps.map((p) => (
                    <th key={p.id} style={{ ...th, width: 62, textAlign: "right" }}>
                      {p.label}
                    </th>
                  ))}
                  <th style={{ ...th, width: 90 }}>Vs doc</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const same = sameMix(t.live, t.documented, psps);
                  return (
                    <tr key={t.id}>
                      <td style={td}>{t.accountType}</td>
                      <td style={td}>{t.txnType}</td>
                      <td style={{ ...td, color: C.text2 }}>{t.amount === "na" ? "All amounts" : t.amount}</td>
                      <td style={{ ...td, verticalAlign: "middle" }}>
                        <MixBar mix={t.live} psps={psps} height={10} />
                      </td>
                      {psps.map((p) => (
                        <td key={p.id} style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {t.live?.[p.id] ?? "—"}%
                        </td>
                      ))}
                      <td style={{ ...td, color: same ? C.muted : C.warn }} title={same ? "" : `Documented: ${psps.map((p) => `${p.label} ${t.documented?.[p.id] ?? 0}%`).join(", ")}`}>
                        {same ? "matches" : "differs"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
            <Card title="ONUS rules (documented)">
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={th}>Bank</th>
                    <th style={th}>Account</th>
                    <th style={th}>Txn type</th>
                    <th style={th}>Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.onus?.documented || []).map((o, i) => (
                    <tr key={i}>
                      <td style={td}>{o.bank}</td>
                      <td style={td}>{o.accountType}</td>
                      <td style={td}>{o.txnType}</td>
                      <td style={{ ...td, color: o.enabled === "yes" ? C.good : C.bad }}>{o.enabled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Feature filters">
              {(data.features || []).map((f) => (
                <div key={f.id} style={{ padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {f.name} <span style={{ color: C.muted, fontWeight: 400 }}>· {f.pipeline}</span>
                  </div>
                  <div style={{ fontSize: 12, color: C.text2 }}>{f.description}</div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
