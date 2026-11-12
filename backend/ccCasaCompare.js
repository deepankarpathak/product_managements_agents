// CC vs CASA · before / after a pivot day (APD "RCC prioritisation": trino/cc_casa_codes/analyze.py) — from the
// saved Product Wise day files, no query of its own:
//   Autopay = mandates/daily dim ALL, purpose 14 (golden mandate unit chosen for Mandates, @paytm UMNs included)
//   P2M     = cccasa/p2m (VPA2MERCHANT pay + collect, one per txn)
// buildCompare() → JSON for the CC vs CASA tab; workbook() → the same as an .xlsx (About, Pre vs Post SR, Code movers,
// All codes, Daily SR, DoD top codes).
import XLSX from "xlsx";

const STAGES = { CREATE: "Create", EXEC1: "1st execution", EXECR: "Recurring execution", REVOKE: "Revoke", PAUSE: "Pause", UNPAUSE: "Unpause", PAY: "P2M pay" };
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const pct = (n, d) => (d > 0 ? (100 * n) / d : null);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

/** rows: [{ ts, scope, stage, acct, status, code, c }] (acct CC / CASA only). */
function unify(readRange, from, to) {
  const out = [];
  for (const r of readRange("mandates/daily", from, to).rows) {
    if (r.dim !== "ALL" || r.purpose !== "14" || (r.acct !== "CC" && r.acct !== "CASA")) continue;
    out.push({ ts: r.ts, scope: "Autopay", stage: r.stage, acct: r.acct, status: r.status, code: r.status === "SUCCESS" ? null : r.code || r.status, c: r.c });
  }
  for (const r of readRange("cccasa/p2m", from, to).rows) {
    if (r.acct !== "CC" && r.acct !== "CASA") continue;
    out.push({ ts: r.ts, scope: "P2M", stage: "PAY", acct: r.acct, status: r.status, code: r.status === "SUCCESS" ? null : r.code, c: r.c });
  }
  return out;
}

export function buildCompare({ readRange, savedDays, describe, party, pivot, from, to }) {
  const days = [...new Set([...savedDays("mandates/daily"), ...savedDays("cccasa/p2m")])].sort();
  // Start where both scopes have saved days (P2M history starts 1 Sep, Autopay is backfilled further back).
  const firstOf = (name) => savedDays(name)[0] || "";
  const both = [firstOf("mandates/daily"), firstOf("cccasa/p2m")].sort().pop();
  const first = from || both || days[0];
  const last = to || days[days.length - 1];
  if (!first || !last) return { error: "no saved days" };
  const pv = pivot && pivot > first && pivot <= last ? pivot : "2026-10-07";
  const rows = unify(readRange, first, last);
  const periodOf = (ts) => (ts < pv ? "pre" : "post");
  const key = (...a) => a.join("|");

  // SR per scope × stage × acct × period, and failures per code
  const sr = new Map();
  const codes = new Map();
  const daily = new Map();
  for (const r of rows) {
    const p = periodOf(r.ts);
    const k = key(r.scope, r.stage, r.acct, p);
    const o = sr.get(k) || { att: 0, suc: 0 };
    o.att += r.c;
    if (r.status === "SUCCESS") o.suc += r.c;
    sr.set(k, o);
    const dk = key(r.ts, r.scope, r.stage, r.acct);
    const dd = daily.get(dk) || { att: 0, suc: 0 };
    dd.att += r.c;
    if (r.status === "SUCCESS") dd.suc += r.c;
    daily.set(dk, dd);
    if (r.code) {
      const ck = key(r.scope, r.stage, r.acct, r.code);
      const co = codes.get(ck) || { scope: r.scope, stage: r.stage, acct: r.acct, code: r.code, pre: 0, post: 0, byDay: {} };
      co[p] += r.c;
      co.byDay[r.ts] = (co.byDay[r.ts] || 0) + r.c;
      codes.set(ck, co);
    }
  }
  const nDays = (p) => days.filter((d) => d >= first && d <= last && (p === "pre" ? d < pv : d >= pv)).length;
  const preN = nDays("pre");
  const postN = nDays("post");
  const scopes = [...new Set(rows.map((r) => `${r.scope}|${r.stage}`))].sort((a, b) => (a.startsWith("Autopay") === b.startsWith("Autopay") ? Object.keys(STAGES).indexOf(a.split("|")[1]) - Object.keys(STAGES).indexOf(b.split("|")[1]) : a.startsWith("Autopay") ? -1 : 1));
  const get = (s, st, a, p) => sr.get(key(s, st, a, p)) || { att: 0, suc: 0 };
  const srTable = scopes.map((ss) => {
    const [scope, stage] = ss.split("|");
    const v = {};
    for (const a of ["CC", "CASA"]) for (const p of ["pre", "post"]) v[`${a}_${p}`] = get(scope, stage, a, p);
    const s = (a, p) => pct(v[`${a}_${p}`].suc, v[`${a}_${p}`].att);
    const gapPre = s("CC", "pre") != null && s("CASA", "pre") != null ? s("CC", "pre") - s("CASA", "pre") : null;
    const gapPost = s("CC", "post") != null && s("CASA", "post") != null ? s("CC", "post") - s("CASA", "post") : null;
    return {
      scope,
      stage: STAGES[stage] || stage,
      ccPreAtt: v.CC_pre.att, ccPreSr: r2(s("CC", "pre")), ccPostAtt: v.CC_post.att, ccPostSr: r2(s("CC", "post")),
      ccDpp: r2(s("CC", "post") != null && s("CC", "pre") != null ? s("CC", "post") - s("CC", "pre") : null),
      casaPreAtt: v.CASA_pre.att, casaPreSr: r2(s("CASA", "pre")), casaPostAtt: v.CASA_post.att, casaPostSr: r2(s("CASA", "post")),
      casaDpp: r2(s("CASA", "post") != null && s("CASA", "pre") != null ? s("CASA", "post") - s("CASA", "pre") : null),
      gapPre: r2(gapPre), gapPost: r2(gapPost), gapChange: r2(gapPre != null && gapPost != null ? gapPost - gapPre : null),
    };
  });
  // Code movers: failures as % of attempts of their scope × stage × acct, pre vs post
  const allCodes = [...codes.values()].map((c) => {
    const pa = get(c.scope, c.stage, c.acct, "pre").att;
    const qa = get(c.scope, c.stage, c.acct, "post").att;
    const i = describe(c.code) || {};
    const pt = party(c.code);
    return {
      scope: c.scope, stage: STAGES[c.stage] || c.stage, acct: c.acct, code: c.code,
      party: pt.party, description: [i.npci, i.bank].filter(Boolean).join(" · "), app: i.app || "", type: i.type || "",
      pre: c.pre, prePct: r2(pct(c.pre, pa)), post: c.post, postPct: r2(pct(c.post, qa)),
      dpp: r2((pct(c.post, qa) ?? 0) - (pct(c.pre, pa) ?? 0)),
      byDay: c.byDay,
    };
  });
  allCodes.sort((a, b) => b.post + b.pre - (a.post + a.pre));
  const movers = allCodes.filter((c) => c.pre + c.post >= 50).sort((a, b) => Math.abs(b.dpp) - Math.abs(a.dpp)).slice(0, 100);
  const dailyRows = [];
  for (const d of days.filter((x) => x >= first && x <= last))
    for (const ss of scopes) {
      const [scope, stage] = ss.split("|");
      const c = daily.get(key(d, scope, stage, "CC")) || { att: 0, suc: 0 };
      const k = daily.get(key(d, scope, stage, "CASA")) || { att: 0, suc: 0 };
      if (!c.att && !k.att) continue;
      dailyRows.push({ day: d, scope, stage: STAGES[stage] || stage, ccAtt: c.att, ccSr: r2(pct(c.suc, c.att)), casaAtt: k.att, casaSr: r2(pct(k.suc, k.att)), gap: r2(c.att && k.att ? pct(c.suc, c.att) - pct(k.suc, k.att) : null) });
    }
  // Day-on-day top codes: the newest 14 days, top 10 failure codes per scope × acct
  const dodDays = days.filter((x) => x <= last).slice(-14);
  const dod = [];
  for (const scope of ["Autopay", "P2M"])
    for (const acct of ["CC", "CASA"]) {
      const m = new Map();
      for (const c of allCodes) if (c.scope === scope && c.acct === acct) m.set(`${c.stage} · ${c.code}`, (m.get(`${c.stage} · ${c.code}`) || []).concat([c]));
      const ranked = [...m.entries()].map(([k, list]) => ({ k, total: dodDays.reduce((a, d) => a + list.reduce((x, c) => x + (c.byDay[d] || 0), 0), 0), list })).sort((a, b) => b.total - a.total).slice(0, 10);
      for (const r of ranked) dod.push({ scope, acct, code: r.k, ...Object.fromEntries(dodDays.map((d) => [d, r.list.reduce((x, c) => x + (c.byDay[d] || 0), 0)])) });
    }
  const lean = ({ byDay, ...c }) => c;
  return { pivot: pv, from: first, to: last, preDays: preN, postDays: postN, sr: srTable, movers: movers.map(lean), codes: allCodes.map(lean), daily: dailyRows.filter((r) => r.day >= first), dodDays, dod };
}

export function workbook(cmp) {
  const wb = XLSX.utils.book_new();
  const add = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) ws["!cols"] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  add("About", [
    ["CC vs CASA · before / after " + cmp.pivot],
    [`Pre = ${cmp.from} … ${addDays(cmp.pivot, -1)} (${cmp.preDays} days) · Post = ${cmp.pivot} … ${cmp.to} (${cmp.postDays} days)`],
    ["Autopay = purpose-14 mandates, golden mandate unit (Paytm-app UMNs incl. @paytm; Create / Revoke / Pause / Unpause once per UMN per day, executions once per UMN + execution number per day; latest status)."],
    ["P2M = switch VPA2MERCHANT pay + collect, not mandates; one attempt per txn, latest status."],
    ["CC = payer account on a credit card; CASA = savings / current. SR = successful ÷ all attempts. Code = NPCI code, else app code."],
    ["Party = which side the code points to (APD error_code_owner rules). Source: Product Wise saved days (PM Console)."],
    [`Generated ${new Date().toISOString()}`],
  ], [140]);
  add("Pre vs Post SR", [
    ["Scope", "Stage", "CC pre att", "CC pre SR %", "CC post att", "CC post SR %", "CC Δ pp", "CASA pre att", "CASA pre SR %", "CASA post att", "CASA post SR %", "CASA Δ pp", "Gap pre (CC−CASA) pp", "Gap post pp", "Gap change pp"],
    ...cmp.sr.map((r) => [r.scope, r.stage, r.ccPreAtt, r.ccPreSr, r.ccPostAtt, r.ccPostSr, r.ccDpp, r.casaPreAtt, r.casaPreSr, r.casaPostAtt, r.casaPostSr, r.casaDpp, r.gapPre, r.gapPost, r.gapChange]),
  ], [10, 20, 12, 10, 12, 10, 8, 12, 10, 12, 10, 8, 12, 10, 10]);
  const codeHead = ["Scope", "Stage", "Account", "Code", "Party", "TD / BD", "Description", "App message", "Pre failures", "Pre % of attempts", "Post failures", "Post % of attempts", "Δ pp"];
  const codeRow = (c) => [c.scope, c.stage, c.acct, c.code, c.party, c.type, c.description, c.app, c.pre, c.prePct, c.post, c.postPct, c.dpp];
  add("Code movers", [codeHead, ...cmp.movers.map(codeRow)], [10, 18, 8, 14, 18, 6, 60, 50, 10, 10, 10, 10, 8]);
  add("All codes", [codeHead, ...cmp.codes.map(codeRow)], [10, 18, 8, 14, 18, 6, 60, 50, 10, 10, 10, 10, 8]);
  add("Daily SR", [["Day", "Scope", "Stage", "CC attempts", "CC SR %", "CASA attempts", "CASA SR %", "Gap pp"], ...cmp.daily.map((r) => [r.day, r.scope, r.stage, r.ccAtt, r.ccSr, r.casaAtt, r.casaSr, r.gap])], [12, 10, 20, 12, 8, 14, 8, 8]);
  add("DoD top codes", [["Scope", "Account", "Stage · code", ...cmp.dodDays], ...cmp.dod.map((r) => [r.scope, r.acct, r.code, ...cmp.dodDays.map((d) => r[d])])], [10, 8, 34, ...cmp.dodDays.map(() => 10)]);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
