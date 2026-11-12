// NPCI FRM rules — U16-<rule no.> and M16-<risk score> decline codes → rule / model name + description.
//
// Data (docs/npci-frm/), re-read when a file changes, so a new month's import needs no backend restart:
//   frm-rules.json  U16 EFRM rules   (scripts/frm-rules-import.py)
//   m16-rules.json  M16 EFRM models  (scripts/frm-m16-import.py); NPCI's sheet writes M16-01278 as MOM-01278
//
//   frmRule("U16-00972")  → { code, family, rules: [{ rule, desc, … }], descr } (null when not an FRM code)
//   frmRule("MOM-01278")  → same as frmRule("M16-01278")
//   frmDescr("U16-00972") → "GLOBAL_P2P_PAYEE_CAP_UPI_VI_PROFILE_ — P2P credit … capped at 50 …"
//   withFrmDescr(payload) → payload with `descr` replaced on every { code | dim | k, descr } object

import fs from "node:fs";

const FILES = {
  U16: new URL("../docs/npci-frm/frm-rules.json", import.meta.url),
  M16: new URL("../docs/npci-frm/m16-rules.json", import.meta.url),
};
const FRM_CODE_RE = /^[UM]16-\d{5}$/;

const caches = {};

function loadFamily(family) {
  const file = FILES[family];
  const cache = caches[family] || { mtimeMs: -1, data: null };
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return (caches[family] = { mtimeMs: 0, data: null });
  }
  if (mtimeMs === cache.mtimeMs) return cache;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`[frm] ${family} rules not loaded: ${err.message}`);
  }
  return (caches[family] = { mtimeMs, data });
}

let merged = { key: "", byCode: new Map() };

function load() {
  const fams = Object.keys(FILES).map((f) => [f, loadFamily(f)]);
  const key = fams.map(([, c]) => c.mtimeMs).join("|");
  if (key === merged.key) return merged;
  const byCode = new Map();
  for (const [family, { data }] of fams) {
    for (const r of data?.rules || []) {
      const list = byCode.get(r.code) || [];
      list.push({ ...r, family });
      byCode.set(r.code, list);
    }
  }
  return (merged = { key, byCode });
}

/** Source meta for one family ("U16" default, "M16"): { title, month, source, count } (null when missing). */
export function frmMeta(family = "U16") {
  const { data } = loadFamily(family);
  return data ? { title: data.title, month: data.month, source: data.source, count: data.count } : null;
}

/** Every rule of one family, in sheet order. */
export function frmRules(family = "U16") {
  return loadFamily(family).data?.rules || [];
}

// Codes shared by several rules (e.g. U16-00100 whitelists) join their names; the description is
// the first rule's (flattened to one line — M16 explanations are multi-line lists).
function describe(rules) {
  const names = [...new Set(rules.map((r) => r.rule))];
  return `${names.join(" / ")} — ${String(rules[0].desc).replace(/\s*\n\s*/g, " ")}`;
}

/** Normalises "UPI-U16-00972" / "u16-00972" / "M16-01278|..." / "MOM-01278" to the FRM code, or null. */
export function frmCodeOf(code) {
  const m = /\b([UM]16|MOM)-(\d{5})\b/i.exec(String(code || ""));
  if (!m) return null;
  const fam = m[1].toUpperCase();
  return `${fam === "MOM" ? "M16" : fam}-${m[2]}`;
}

export function frmRule(code) {
  const c = frmCodeOf(code);
  const rules = c && load().byCode.get(c);
  return rules ? { code: c, family: rules[0].family, rules, descr: describe(rules) } : null;
}

export function frmDescr(code) {
  return frmRule(code)?.descr || "";
}

// Row objects carry the code as `code`, `dim` (kind "code" rows) or `k` (aggregated spikes).
// Other kinds ("flow", "bank") keep `descr` blank on purpose — the code there is a sub-split.
const codeKeyOf = (o) => (o.kind && o.kind !== "code" ? null : [o.dim, o.k, o.code].find((v) => typeof v === "string" && FRM_CODE_RE.test(v)));

/** Deep copy-on-write: only objects that change (and their parents) are copied; cached results stay untouched. */
export function withFrmDescr(value) {
  if (!load().byCode.size) return value;
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
    if ("descr" in v) {
      const d = frmDescr(codeKeyOf(v));
      if (d && d !== v.descr) (out ||= { ...v }).descr = d;
    }
    return out || v;
  };
  return walk(value);
}
