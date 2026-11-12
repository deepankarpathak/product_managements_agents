// Decline-code descriptions at serve time (Unified SR /api/udash*, drill).
//
// The switch query's `description` column is blank for many codes (U29-ZI, U31-Z7, S96, S97, U30-FP,
// INT-xxxx app codes, U16-<rule> not in the FRM sheet …). withCodeDescr(payload) =
//   1. withFrmDescr — NPCI FRM rule / EFRM model text on U16-xxxxx / M16-xxxxx
//   2. any code row still without `descr` gets one from describeCode (productDashboard.js):
//      NPCI Error Codes index (UPI code · bank response code), error-code sheet (app constant + message),
//      or a plain "not in …" note so the cell never stays empty.
// Rows of other kinds ("flow", "bank", "psp" …) keep `descr` blank on purpose — the code there is a sub-split.

import { withFrmDescr, frmMeta } from "./frmRules.js";
import { describeCode } from "./productDashboard.js";

const LONG_TAIL_RE = /long tail|^\(?(other|blank|null|none)\)?$/i;

const codeKeyOf = (o) => {
  if (o.kind && o.kind !== "code") return null;
  const c = [o.kind === "code" ? o.dim : null, o.code, o.k].find((v) => typeof v === "string" && v.trim());
  return c && !LONG_TAIL_RE.test(c.trim()) ? c.trim() : null;
};

const cache = new Map();

/** One-line description for a decline code ("" only when nothing at all is known). */
export function codeDescrText(code) {
  if (cache.has(code)) return cache.get(code);
  const d = describeCode(code);
  const strip = (s, head) => String(s || "").replace(new RegExp(`^${head}\\s+`), "");
  const parts = String(code).replace(/^UPI-/, "").split(/[-|]/);
  let text = "";
  if (d?.frm) text = d.frm;
  else if (d && (d.npci || d.bank)) {
    const npci = strip(d.npci, parts[0]);
    const bank = d.bank ? strip(d.bank, parts[parts.length - 1]) : "";
    text = [npci, bank && `${parts[parts.length - 1]}: ${bank}`].filter(Boolean).join(" · ");
    if (d.app && !bank) text += ` · App: ${d.app}`;
  } else if (d?.app || d?.constant) {
    text = [d.constant, d.app].filter(Boolean).join(" — ");
  }
  if (!d?.frm && /^[UM]16-\d{5}$/i.test(parts.slice(0, 2).join("-"))) {
    const fam = parts[0].toUpperCase();
    const m = frmMeta(fam);
    text = `${text || "RISK THRESHOLD EXCEEDED"} · rule ${parts[1]} not in NPCI ${fam === "M16" ? "EFRM M16" : "FRM"} sheet${m?.month ? ` (${m.month})` : ""}`;
  }
  if (!text && /^INT-\d+$/i.test(code)) text = "Paytm internal (app / TPAP) code · not in error-code sheet";
  if (cache.size > 5000) cache.clear();
  cache.set(code, text);
  return text;
}

/** Deep copy-on-write fill of blank `descr` on code rows (after the FRM pass). */
export function withCodeDescr(value) {
  const walk = (v) => {
    if (Array.isArray(v)) {
      let out = null;
      for (let i = 0; i < v.length; i++) {
        const n = walk(v[i]);
        if (n !== v[i]) (out ||= v.slice())[i] = n;
      }
      return out || v;
    }
    if (!v || typeof v !== "object") return v;
    let out = null;
    for (const k of Object.keys(v)) {
      const n = walk(v[k]);
      if (n !== v[k]) (out ||= { ...v })[k] = n;
    }
    if ("descr" in v && !String(v.descr || "").trim()) {
      const c = codeKeyOf(v);
      const d = c && codeDescrText(c);
      if (d) (out ||= { ...v }).descr = d;
    }
    return out || v;
  };
  return walk(withFrmDescr(value));
}
