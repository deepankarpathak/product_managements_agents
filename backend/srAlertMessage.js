// SR alert text, structured with Barbara Minto's pyramid principle. Two parts:
//   buildSrAlertHeadline → governing thought (title + answer + ask in one sentence).
//                          Used for the History record.
//   buildSrAlertDetail   → one block per issue with the same MECE supports
//                          (Drop → Cause → Impact → Ask), then rule + source.
//   buildSrAlertSlack    → one-line title + detail blocks. Posted to Slack.
//   buildSrAllClearSlack → the daily digest on a day with no WARN / CRIT: overall SR vs L7D and
//                          the three biggest drops below the alert bar, so a quiet day still posts.
// Pure templating over computeAlerts() output (src/breakdown-math.mjs) — no LLM.

import { buildBreakdown } from "../src/breakdown-math.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const fmtDayLong = (d) => `${fmtDay(d)} ${d.slice(0, 4)}`;
const pct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const pp = (v, dp = 2) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}pp`);
const num = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const lakh = (v) => (v == null ? "—" : v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : num(v));
const descrText = (s) => String(s || "").replace(/^DF_/, "").replace(/_/g, " ").toLowerCase();

const KIND = { bank: "payer bank", psp: "payee PSP", instrument: "payer instrument", flow: "flow" };

// Codes whose NPCI description points at the customer (funds, PIN, limits, velocity rules),
// not at a bank / PSP system. These never drive an escalation ask.
const CUSTOMER_SIDE = /INSUFFICIENT|MPIN|\bPIN\b|LIMIT|EXCEED|SUCCESSFUL_P2P|COOLING|EXPIRED/i;
export const isCustomerSide = (c) => CUSTOMER_SIDE.test(c.descr || "");

/** Who should act, and the one-line ask. */
function askFor(a, name) {
  const lead = a.codes.find((c) => !isCustomerSide(c));
  if (!lead) {
    return { escalate: false, text: `No ${KIND[a.kind]} fault visible — top codes are customer-side. Monitor; no NPCI escalation.` };
  }
  const spike = lead.d1 != null ? ` (${lakh(lead.n)} vs ${lakh(lead.d1)} the day before)` : ` (${lakh(lead.n)} fails)`;
  if (a.kind === "bank") return { escalate: true, lead, text: `NPCI → ${name}: explain ${lead.code} ${descrText(lead.descr) || "declines"} on ${fmtDay(a.day)}${spike}.` };
  if (a.kind === "psp") return { escalate: true, lead, text: `NPCI → payee PSP ${a.dim}: explain ${lead.code} ${descrText(lead.descr) || "declines"} on ${fmtDay(a.day)}${spike}.` };
  return { escalate: false, lead, text: `Internal check — not one counterparty; see the payer-bank / PSP tabs for ${lead.code}.` };
}

function trendLine(a) {
  const t = a.trend || {};
  const series = `D-3 ${pct(t.d3)} · D-2 ${pct(t.d2)} · D-1 ${pct(t.d1)} · LW ${pct(t.lw)}`;
  const ongoing = t.d1 != null && a.srL7 != null && t.d1 <= a.srL7 - 1;
  return ongoing ? `Ongoing — already low on D-1. ${series}` : `New on ${fmtDay(a.day)} — prior days normal. ${series}`;
}

function prepare(alerts, day, bankName) {
  return alerts.map((a) => {
    const nm = a.kind === "bank" && bankName(a.dim) ? `${bankName(a.dim)} (${a.dim})` : a.dim;
    const x = { ...a, day, name: nm };
    return { ...x, ask: askFor(x, nm) };
  });
}

/** Plain text: { title, text } — e.g. "UPI SR alert · 14 Oct 2026 — raise with NPCI" + one sentence. */
export function buildSrAlertHeadline(alerts, { day, bankName = () => null }) {
  const items = prepare(alerts, day, bankName);
  const crit = items.filter((a) => a.level === "CRIT").length;
  const escalate = items.filter((a) => a.ask.escalate);

  // 1 · Governing thought: answer + ask, one sentence.
  let governing;
  if (items.length === 1) {
    const a = items[0];
    const cause = a.ask.lead ? `driven by ${a.ask.lead.code} (${descrText(a.ask.lead.descr) || "no description"})` : "driven by customer-side declines";
    governing =
      `${a.name} SR fell ${Math.abs(a.dsr).toFixed(2)}pp to ${pct(a.srNow)} on ${fmtDay(day)} (L7D ${pct(a.srL7)}), ${cause} — ~${lakh(a.lost)} txns lost. ` +
      (a.ask.escalate ? `Raise with NPCI.` : `No escalation needed.`);
  } else {
    const worst = items
      .slice(0, 3)
      .map((a) => `${a.name} ${pp(a.dsr)}`)
      .join(", ");
    const bankLost = items.filter((a) => a.kind === "bank").reduce((s, a) => s + (a.lost || 0), 0);
    governing =
      `${items.length} SR issues on ${fmtDay(day)} (${worst}${items.length > 3 ? ", …" : ""}); ~${lakh(bankLost || items[0].lost)} txns lost. ` +
      (escalate.length ? `${escalate.length} ${escalate.length === 1 ? "needs" : "need"} NPCI escalation: ${escalate.map((a) => a.name).join(", ")}.` : `None point at a bank / PSP fault — monitor.`);
  }

  return { title: `UPI SR alert · ${fmtDayLong(day)} — ${escalate.length ? "raise with NPCI" : "monitor"}`, text: governing, crit };
}

/** Slack mrkdwn: numbered issue blocks + rule line. */
export function buildSrAlertDetail(alerts, { day, bankName = () => null, maxBlocks = 5 }) {
  const items = prepare(alerts, day, bankName);
  const lines = [];

  // 2 · One block per issue: Drop → Cause → Impact → Ask.
  items.slice(0, maxBlocks).forEach((a, i) => {
    const [lead, ...rest] = a.codes;
    const cause = lead
      ? `${lead.code} "${descrText(lead.descr) || "no description"}" — ${num(lead.n)} fails, ${lead.share?.toFixed(1)}% of ${a.dim} failures` +
        (lead.d1 != null ? ` (D-1: ${num(lead.d1)})` : "") +
        (rest.length ? `. Also ${rest.map((c) => `${c.code} ${descrText(c.descr) || ""} ${num(c.n)}${isCustomerSide(c) ? " (customer-side)" : ""}`).join(" · ")}` : "")
      : "No failure-code detail for this row.";
    lines.push(
      `*${i + 1} · ${a.level} · ${a.name} · ${KIND[a.kind] || a.kind}*`,
      `• *Drop:* ${pct(a.srNow)} vs ${pct(a.srL7)} L7D (${pp(a.dsr)}). ${trendLine(a)}`,
      `• *Cause:* ${cause}`,
      `• *Impact:* ~${num(a.lost)} txns lost · ${pp(a.impact, 3)} on overall SR (${pct(a.overallSrNow)}) · ${lakh(a.vol)} txns at ${a.dim}`,
      `• *Ask:* ${a.ask.text}`,
      "",
    );
  });
  if (items.length > maxBlocks) lines.push(`_+${items.length - maxBlocks} more in History › SR alerts per day_`, "");

  // 3 · Rule + source.
  lines.push(
    "_Rule: WARN = SR ≥1pp below L7D and ≥0.1pp hit to overall SR · CRIT = ≥3pp and ≥0.3pp · Source: Looker day table, all payer handles · Unified SR Dashboard › A · SR Breakdown_",
  );
  return lines.join("\n");
}

/** Full Slack post: one-line title, then the detail blocks. */
export function buildSrAlertSlack(alerts, opts) {
  const { title, crit } = buildSrAlertHeadline(alerts, opts);
  return `${crit ? ":rotating_light:" : ":warning:"} *${title}*\n\n${buildSrAlertDetail(alerts, opts)}`;
}

/** Slack mrkdwn for a day with no WARN / CRIT. rows: breakdown rows (Morning scope). */
export function buildSrAllClearSlack(rows, { day, bankName = () => null, kinds = ["psp", "bank", "instrument", "flow"] }) {
  const per = kinds.map((kind) => [kind, buildBreakdown(rows, { kind, yday: day })]);
  const overall = per.find(([k]) => k === "bank")?.[1].overall || per[0]?.[1].overall;
  const drops = per
    .flatMap(([kind, b]) => b.rows.filter((r) => r.dsr != null && r.dsr < 0 && r.impact != null).map((r) => ({ ...r, kind })))
    .sort((a, b) => a.impact - b.impact)
    .slice(0, 3);
  const nameOf = (r) => (r.kind === "bank" && bankName(r.dim) ? `${bankName(r.dim)} (${r.dim})` : r.dim);
  const lines = [
    `:white_check_mark: *UPI SR · ${fmtDayLong(day)} — all clear, no WARN / CRIT*`,
    `Overall SR ${pct(overall?.srNow)} vs ${pct(overall?.srL7)} L7D (${pp(overall?.dsr)}) on ${lakh(overall?.vol)} txns.`,
  ];
  if (drops.length) {
    lines.push("Biggest drops (below the alert bar):");
    drops.forEach((r) => lines.push(`• ${KIND[r.kind] || r.kind} ${nameOf(r)}: ${pct(r.srNow)} (${pp(r.dsr)} vs L7D), impact ${pp(r.impact, 3)}, ~${num(r.lost)} txns lost`));
  }
  lines.push("_Rule: WARN = SR ≥1pp below L7D and ≥0.1pp hit to overall SR · CRIT = ≥3pp and ≥0.3pp · Source: Looker day table, all payer handles · Unified SR Dashboard › A_");
  return lines.join("\n");
}
