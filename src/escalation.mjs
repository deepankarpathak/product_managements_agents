// Escalation scoring + email drafting for the Unified SR Dashboard. Pure functions over
// buildBreakdown() rows (src/breakdown-math.mjs) — no JSX, no fetch, so node can test it.
//
// Score (0–100) for a row whose SR fell below its L7D baseline:
//   severity      30 × min(1, |Δ SR vs L7D| / 3pp)
//   impact        25 × min(1, |hit on overall SR| / 0.5pp)
//   lost txns     15 × min(1, lost / 50,000)
//   persistence   +10 if D-1 was already ≥1pp below L7D, +5 more if D-2 too
//   attribution   15 × min(1, lead counterparty code's share of the row's failures / 50%)
// A row whose top codes are all customer-side (funds, PIN, limits) or NPCI policy caps has
// nobody to escalate to: capped at 25 ("No action").
// Bands: ≥70 P1 escalate now · 50–69 P2 escalate · 30–49 watch · <30 no action.
//
// Duration gate (applyDuration): a day-level drop can be one bad half hour. 15-min buckets
// from raw txns compare the row's SR with the overall SR in the same bucket (cancels the
// time-of-day curve). A bucket is degraded when that gap is ≥1pp worse than the row's L7D
// gap. Shorter than 60 consecutive minutes → transient: capped at 49 (Watch), never escalated.
//
// Who owns a code (first segment of app_resp_code): U30 debit failed → payer (remitter) bank;
// U31 credit failed → payee (beneficiary) bank; U16 risk rules → NPCI; U09 / U28 / U29
// (auth-details timeout, PSP unavailable, address resolution) → payee PSP; INT-* / blank →
// internal (Paytm TPAP). Anything else → NPCI to route. The UI lets you change the recipient.

import { addDays } from "./breakdown-math.mjs";

const CUSTOMER_SIDE = /INSUFFICIENT|MPIN|\bPIN\b|LIMIT|EXCEED|SUCCESSFUL_P2P|COOLING|EXPIRED/i;
// NPCI policy caps — working as designed, not a fault anyone can fix.
// U16-00972: P2P payee 50 txns / 24h cap · U16-01128 / 01129: weekday / weekend credit-card small-merchant limit.
const POLICY = new Set(["U16-00972", "U16-01128", "U16-01129"]);

export const PARTIES = {
  payer_bank: { label: "Payer (remitter) bank", to: "Payer bank UPI operations / NPCI UPI operations" },
  payee_psp: { label: "Payee PSP", to: "Payee PSP UPI operations / NPCI UPI operations" },
  payee_bank: { label: "Payee (beneficiary) bank", to: "Beneficiary bank UPI operations / NPCI UPI operations" },
  npci: { label: "NPCI", to: "NPCI UPI operations" },
  internal: { label: "Internal (Paytm TPAP)", to: "Paytm TPAP engineering on-call" },
};

const KIND_ROLE = { bank: "payer bank", psp: "payee PSP", instrument: "payer instrument", flow: "flow" };

export function codeSide(code, descr) {
  if (POLICY.has(code)) return "policy";
  if (CUSTOMER_SIDE.test(descr || "")) return "customer";
  return "actionable";
}

export function codeOwner(code) {
  const c = String(code || "");
  if (!c || c === "(blank)" || /^INT/i.test(c)) return "internal";
  const p = c.split("-")[0].toUpperCase();
  if (p === "U30") return "payer_bank";
  if (p === "U31") return "payee_bank";
  if (p === "U16") return "npci";
  if (["U09", "U28", "U29"].includes(p)) return "payee_psp";
  return "npci";
}

const clamp = (x) => Math.max(0, Math.min(1, x || 0));

export function bandOf(score) {
  if (score >= 70) return { id: "P1", label: "P1 · Escalate now", color: "#ef4444" };
  if (score >= 50) return { id: "P2", label: "P2 · Escalate", color: "#f97316" };
  if (score >= 30) return { id: "watch", label: "Watch", color: "#fab219" };
  return { id: "none", label: "No action", color: "#64748b" };
}

/**
 * row: one buildBreakdown() row (metric "sr"); kind: its tab; descr: { code → NPCI text };
 * days: buildBreakdown().days. Returns null when the row did not fall.
 */
/** force: score a row even if it did not fall (one-click escalation from F); leadCode: escalate that code. */
export function scoreRow(row, { kind, descr = {}, days, force = false, leadCode = null }) {
  if (!force && (row.dsr == null || row.dsr >= 0 || row.impact == null || row.impact >= 0)) return null;
  const l7 = Array.from({ length: 7 }, (_, i) => addDays(days.now, -7 + i));
  const codes = Object.entries(row.codeFails || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, n]) => {
      const byDay = row.codeByDay?.[code] || {};
      const l7avg = l7.reduce((s, d) => s + (byDay[d] || 0), 0) / 7;
      const d = descr[code] || "";
      return { code, n, d1: row.codeFailsD1?.[code] ?? null, l7avg, share: row.failures > 0 ? (n * 100) / row.failures : null, descr: d, side: codeSide(code, d), owner: codeOwner(code) };
    });
  // An explicit code (TD watch / spike click) leads even when it is not in the row's top 5.
  let lead = codes.find((c) => c.side === "actionable") || null;
  if (leadCode) {
    lead = codes.find((c) => c.code === leadCode) || null;
    if (!lead) {
      const byDay = row.codeByDay?.[leadCode] || {};
      const n = row.codeFails?.[leadCode] || byDay[days.now] || 0;
      const d = descr[leadCode] || "";
      lead = {
        code: leadCode,
        n,
        d1: row.codeFailsD1?.[leadCode] ?? null,
        l7avg: l7.reduce((s2, x) => s2 + (byDay[x] || 0), 0) / 7,
        share: row.failures > 0 ? (n * 100) / row.failures : null,
        descr: d,
        side: codeSide(leadCode, d),
        owner: codeOwner(leadCode),
      };
      codes.unshift(lead);
    }
  }
  const parts = {
    severity: 30 * clamp(-row.dsr / 3),
    impact: 25 * clamp(-row.impact / 0.5),
    lost: 15 * clamp((row.lost || 0) / 50000),
    persistence: (row.d1 != null && row.srL7 != null && row.d1 <= row.srL7 - 1 ? 10 : 0) + (row.d2 != null && row.srL7 != null && row.d2 <= row.srL7 - 1 ? 5 : 0),
    attribution: lead ? 15 * clamp((lead.share || 0) / 50) : 0,
  };
  let score = Object.values(parts).reduce((a, b) => a + b, 0);
  if (!lead) score = Math.min(score, 25);
  score = Math.round(score);
  // Recipient: the lead code's owner; a bank / PSP row names the counterparty.
  const party = lead ? lead.owner : "internal";
  return {
    kind,
    dim: row.dim,
    score,
    band: bandOf(score),
    parts,
    party,
    lead,
    codes,
    srNow: row.srNow,
    srL7: row.srL7,
    dsr: row.dsr,
    impact: row.impact,
    lost: row.lost,
    vol: row.vol,
    failures: row.failures,
    volΔ: row.volΔ,
    trend: { d1: row.d1, d2: row.d2, d3: row.d3, lw: row.lw },
    alert: row.alert,
  };
}

/** Score every falling row across kinds, best first. perKind: { kind → buildBreakdown() result }. */
export function scoreAll(perKind, descr) {
  const out = [];
  for (const [kind, b] of Object.entries(perKind)) {
    for (const r of b.rows) {
      const s = scoreRow(r, { kind, descr, days: b.days });
      if (s) out.push({ ...s, overallSrNow: b.overall.srNow, overallSrL7: b.overall.srL7, days: b.days });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.impact - b.impact);
}

// ─── duration gate ───────────────────────────────────────────────────────────

export const SUSTAINED_MIN = 60;
const BUCKET_MIN = 15;
const MIN_BUCKET_VOL = 30;

/**
 * rows: [{ series: "slice" | "all", ts: "HH:mm", total, success }] for one day.
 * baseGap = row SR − overall SR over L7D (pp). Returns the longest degraded run and its cost.
 */
export function analyzeDuration(rows, { baseGap }) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.ts] ||= { ts: r.ts, slice: { t: 0, s: 0 }, all: { t: 0, s: 0 } });
    const x = b[r.series === "slice" ? "slice" : "all"];
    x.t += Number(r.total) || 0;
    x.s += Number(r.success) || 0;
  }
  const buckets = Object.values(by).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let best = null;
  let cur = null;
  let degradedMin = 0;
  for (const b of buckets) {
    const srS = b.slice.t >= MIN_BUCKET_VOL ? (b.slice.s * 100) / b.slice.t : null;
    const srA = b.all.t > 0 ? (b.all.s * 100) / b.all.t : null;
    b.gap = srS != null && srA != null ? srS - srA : null;
    b.degraded = b.gap != null && baseGap != null && b.gap <= baseGap - 1;
    // Txns lost in the bucket vs the expected SR (overall SR in that bucket + normal gap).
    b.lost = b.degraded ? Math.max(0, ((srA + baseGap - srS) / 100) * b.slice.t) : 0;
    if (b.degraded) {
      degradedMin += BUCKET_MIN;
      cur = cur ? { ...cur, to: b.ts, min: cur.min + BUCKET_MIN, lost: cur.lost + b.lost } : { from: b.ts, to: b.ts, min: BUCKET_MIN, lost: b.lost };
      if (!best || cur.min > best.min) best = cur;
    } else {
      cur = null;
    }
  }
  const endOf = (hm) => {
    const [h, m] = hm.split(":").map(Number);
    const t = h * 60 + m + BUCKET_MIN;
    return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  };
  return {
    buckets,
    degradedMin,
    longest: best ? { ...best, to: endOf(best.to) } : null,
    sustained: Boolean(best && best.min >= SUSTAINED_MIN),
  };
}

/** Score after the duration gate. dur: analyzeDuration() result, or null (not checked yet). */
export function applyDuration(item, dur) {
  if (!dur) return { ...item, duration: null };
  if (dur.sustained) return { ...item, duration: dur };
  const score = Math.min(item.score, 49);
  const band = score >= 30 ? { id: "transient", label: "Watch · transient <1h", color: "#fab219" } : bandOf(score);
  return { ...item, score, band, duration: dur };
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

// ─── email (Barbara Minto pyramid) ───────────────────────────────────────────
// Subject = governing thought. Opening paragraph = the answer and the ask, first.
// Then a short Situation → Complication → Question, three MECE supports
// (what changed / why it points to you / impact), the numbered ask, the evidence.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : "—");
const pct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const pp = (v, dp = 2) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)} pp`);
const num = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const human = (s) =>
  String(s || "")
    .replace(/^DF_/, "")
    .replace(/_/g, " ")
    .toLowerCase();

/**
 * item: scoreAll() entry. ctx: { name (display name of dim), scope (e.g. "P2M · all 4 TPAP handles"),
 * party (override), sampleRows (count attached), sender }.
 */
export function buildEscalationEmail(item, ctx = {}) {
  const day = item.days.now;
  const party = ctx.party || item.party;
  const name = ctx.name || item.dim;
  const role = KIND_ROLE[item.kind] || item.kind;
  const lead = item.lead;
  const leadTxt = lead ? `${lead.code}${lead.descr ? ` (${human(lead.descr)})` : ""}` : "customer-side declines";
  const deadline = fmtDay(addDays(day, 2));
  const scope = ctx.scope || "Paytm UPI (TPAP) payer handles";
  const persistent = item.trend.d1 != null && item.srL7 != null && item.trend.d1 <= item.srL7 - 1;
  const spike = lead ? (lead.l7avg > 0 ? `${num(lead.n)} failures vs ${num(lead.l7avg)}/day over the previous 7 days` : `${num(lead.n)} failures`) : null;

  const subject = `[Action needed by ${deadline}] ${name}: UPI success rate down ${Math.abs(item.dsr).toFixed(2)} pp on ${fmtDay(day)} — ${lead ? `${lead.code} spike` : "declines"}`;

  const lines = [];
  lines.push(`Dear ${PARTIES[party]?.label || "team"},`, "");
  // Governing thought: answer + ask.
  lines.push(
    `UPI transactions where the ${role} is ${name} are failing more than normal: success rate was ${pct(item.srNow)} on ${fmtDay(day)} against ${pct(item.srL7)} over the previous 7 days (${pp(item.dsr)}), ` +
      `driven by ${leadTxt}${spike ? ` — ${spike}` : ""}. We request a root-cause analysis and a fix ETA by ${deadline}.`,
    "",
  );
  // SCQ.
  const dur = item.duration?.longest;
  lines.push(
    `Situation: ${name} normally completes ${pct(item.srL7)} of transactions from ${scope} (${num(item.vol)} on ${fmtDay(day)}).`,
    `Complication: ${persistent ? `the drop started before ${fmtDay(day)} and is continuing` : `the drop is new on ${fmtDay(day)}; the days before were normal`}${
      dur ? `; on ${fmtDay(day)} it lasted ${fmtMin(dur.min)} without a break (${dur.from}–${dur.to} IST)` : ""
    }, and it is not explained by customer-side declines.`,
    `Question: what changed on your side, and when will it be fixed?`,
    "",
  );
  // Key line — three MECE supports.
  const t = item.trend;
  lines.push("1. What changed");
  lines.push(`   • Success rate: D-3 ${pct(t.d3)} · D-2 ${pct(t.d2)} · D-1 ${pct(t.d1)} · ${fmtDay(day)} ${pct(item.srNow)} (same weekday last week ${pct(t.lw)}).`);
  if (item.volΔ != null) lines.push(`   • Volume: ${num(item.vol)} transactions, ${item.volΔ >= 0 ? "+" : ""}${item.volΔ.toFixed(1)}% vs the 7-day average — the drop is in the rate, not the mix.`);
  lines.push("", `2. Why we believe it sits with ${party === "npci" ? "NPCI" : `the ${(PARTIES[party]?.label || "counterparty").toLowerCase()}`}`);
  if (lead) {
    lines.push(
      `   • ${lead.code}${lead.descr ? ` "${human(lead.descr)}"` : ""} accounts for ${lead.share?.toFixed(1)}% of ${name}'s failures on ${fmtDay(day)}${lead.d1 != null ? ` (D-1: ${num(lead.d1)})` : ""}.`,
    );
    const others = item.codes.filter((c) => c !== lead).slice(0, 3);
    if (others.length)
      lines.push(
        `   • Other top codes: ${others.map((c) => `${c.code} ${num(c.n)}${c.side !== "actionable" ? ` (${c.side === "policy" ? "NPCI policy limit" : "customer-side"})` : ""}`).join(" · ")}.`,
      );
  }
  lines.push(
    `   • Overall success rate for ${scope} on ${fmtDay(day)} was ${pct(item.overallSrNow)}; ${name} alone moved it by ${pp(item.impact, 3)} while other ${role}s held, so the issue is specific to ${name}.`,
  );
  lines.push("", "3. Impact");
  lines.push(`   • About ${num(item.lost)} customer transactions failed on ${fmtDay(day)} that would have succeeded at the 7-day success rate.`);
  if (dur) lines.push(`   • ${fmtMin(item.duration.degradedMin)} of the day below normal; the longest stretch, ${dur.from}–${dur.to} IST, alone cost ~${num(dur.lost)} transactions.`);
  lines.push(`   • Internal severity score ${item.score}/100 (${item.band.label}).`);
  lines.push("", "Our request");
  lines.push(`   1. Root cause for the ${lead ? lead.code : "failure"} increase on ${fmtDay(day)}.`);
  lines.push(`   2. Fix or mitigation, with ETA, by ${deadline}.`);
  lines.push(`   3. Confirmation once resolved — we will monitor success rate for the following 3 days.`);
  lines.push("");
  lines.push(
    ctx.sampleRows
      ? `Evidence: ${num(ctx.sampleRows)} sample transactions attached (Txn ID, RRN, timestamp, amount, status, payer / payee handle and bank).`
      : "Evidence: sample transactions (Txn ID, RRN, timestamp, amount, status, payer / payee handle and bank) attached.",
  );
  lines.push("", "Regards,", ctx.sender || "[Your name]", "Paytm UPI (TPAP)");
  return { subject, body: lines.join("\n"), to: PARTIES[party]?.to || "" };
}
