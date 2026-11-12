// NPCI Spec Search — keyword search over the Markdown conversions of NPCI documents in docs/.
//
// Sources (one folder each, produced from the NPCI PDFs):
//   tsd       docs/npci-tsd/        UPI API & Technical Specification Document V1.0
//   circular  docs/npci-circular/   UPI Consolidated Circular V1.0
//   errcodes  docs/npci-error-codes/ UPI Error and Response Codes V2.9 (code tables also feed an
//                                    exact-code lookup: "U16" → its definition rows)
//   notices   docs/npci-notices/    NPCI non-compliance notices + internal responsibility analysis (no PDF)
//   frm       docs/npci-frm/        NPCI FRM (EFRM) rules — one section per U16-<rule no.> decline code, plus
//                                    EFRM M16 models — one per M16-<risk score> (NPCI sheet: MOM-<score>); rule
//                                    data from frm-rules.json / m16-rules.json feeds the exact-code lookup (no PDF)
//
// Each part file is split into sections at its headings; sections keep their heading path and the
// PDF pages from the `<!-- p.N -->` markers. The index is BM25 over section text (heading terms
// boosted), held in memory and rebuilt when any .md file changes.
//
// Routes (all under /api/spec):
//   GET /sources                       → indexed sources + section counts
//   GET /search?q=&source=&limit=      → ranked sections with snippets
//   GET /context?q=&k=&source=&format= → cited excerpts as injected into LLM prompts (format=text for plain)
//   GET /section?id=                   → full Markdown of one section (+ prev/next ids)
//   GET /img/:source/:name             → diagram PNG referenced by a section
//   GET /pdf/:source                   → source PDF (client appends #page=N)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frmMeta, frmRule } from "./frmRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, "..", "docs");

const SOURCES = [
  {
    id: "tsd",
    label: "UPI TSD V1.0",
    dir: path.join(DOCS_DIR, "npci-tsd"),
    pdf: path.join(DOCS_DIR, "UPI -Consolidated-TSD(Technical Specification Document)_ V1.0_Draft_27 Oct 2026.pdf"),
  },
  {
    id: "circular",
    label: "Consolidated Circular V1.0",
    dir: path.join(DOCS_DIR, "npci-circular"),
    pdf: path.join(DOCS_DIR, "UPI Consolidated Circular_Version 1.0.pdf"),
  },
  {
    id: "errcodes",
    label: "Error & Response Codes V2.9",
    dir: path.join(DOCS_DIR, "npci-error-codes"),
    pdf: path.join(DOCS_DIR, "UPI_Error_and_Response_Codes_2_9.pdf"),
  },
  {
    id: "notices",
    label: "NPCI Notices",
    dir: path.join(DOCS_DIR, "npci-notices"),
    pdf: null,
  },
  {
    id: "frm",
    label: "NPCI FRM Rules",
    dir: path.join(DOCS_DIR, "npci-frm"),
    pdf: null,
  },
];
const DOC_TITLE = {
  tsd: "NPCI UPI TSD V1.0",
  circular: "NPCI UPI Consolidated Circular V1.0",
  errcodes: "NPCI UPI Error and Response Codes V2.9",
  notices: "NPCI Notice (internal note)",
  get frm() {
    return frmMeta()?.title || "NPCI FRM rules";
  },
};
// FRM sections cite their own sheet: U16 rules or M16 models (files m16-*.md).
const docTitleOf = (source, file) => (source === "frm" && /^m16-/.test(file || "") ? frmMeta("M16")?.title || "NPCI EFRM M16 models" : DOC_TITLE[source]);
// Sources whose codes the exact-code lookup returns.
const CODE_SOURCES = new Set(["errcodes", "frm"]);
const FRM_HEADING_RE = /^([UM]16-\d{5}) · /;
const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

const MAX_LIMIT = 50;
const HEADING_BOOST = 3;
const K1 = 1.2;
const B = 0.75;

const PAGE_RE = /^<!-- p\.(\d+) -->$/;
const HEADING_RE = /^(#{2,6}) (.+)$/;
const IMG_NAME_RE = /^p\d{3}-\d+\.png$/;

const tokenize = (s) => String(s || "").toLowerCase().match(/[a-z0-9_]{2,}/g) || [];

// Markdown → plain text for indexing and snippets (tables flattened, markers dropped).
function plain(md) {
  return md
    .replace(/<!-- p\.\d+ -->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^```\w*$/gm, " ")
    .replace(/^\|?[-| ]+\|$/gm, " ")
    .replace(/^> /gm, " ")
    .replace(/[|*`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Split one part file into sections. The part header (title, nav, contents) ends at the first `---`.
function parseFile(source, file, raw) {
  const lines = raw.split("\n");
  const part = (lines[0] || "").replace(/^# /, "").trim();
  // Text before the first page marker sits on the part's first page (from the header blurb).
  const firstPage = Number((/PDF pages (\d+)/.exec(lines.slice(0, 4).join(" ")) || [])[1]) || null;
  let start = lines.indexOf("---");
  start = start < 0 ? 1 : start + 1;
  let end = lines.lastIndexOf("---");
  if (end <= start) end = lines.length;

  const sections = [];
  const stack = []; // [{level, heading}]
  let page = firstPage;
  let cur = null;
  // A page marker belongs to whatever follows it: held back until the next content line, so a
  // marker directly before a heading opens the new section instead of trailing the old one.
  let pendingPage = false;
  const flush = () => {
    if (!cur) return;
    const md = cur.lines.join("\n").trim();
    const body = cur.lines.filter((l) => l.trim() && !PAGE_RE.test(l) && !HEADING_RE.test(l));
    if (body.length) sections.push({ ...cur, md, lines: undefined });
  };
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const pm = PAGE_RE.exec(line);
    if (pm) {
      page = Number(pm[1]);
      pendingPage = true;
      continue;
    }
    const hm = HEADING_RE.exec(line);
    if (hm) {
      pendingPage = false;
      flush();
      const level = hm[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const heading = hm[2].trim();
      cur = {
        source: source.id,
        file,
        part,
        heading,
        level,
        path: stack.map((s) => s.heading),
        page,
        pageTo: page,
        lines: [`<!-- p.${page} -->`, line],
      };
      stack.push({ level, heading });
      continue;
    }
    if (!cur) {
      // text before the first heading in a part (e.g. a page carried over from the previous part)
      cur = { source: source.id, file, part, heading: part, level: 2, path: [], page, pageTo: page, lines: [`<!-- p.${page} -->`] };
      pendingPage = false;
    }
    if (pendingPage && line.trim()) {
      cur.lines.push(`<!-- p.${page} -->`);
      cur.pageTo = page;
      pendingPage = false;
    }
    cur.lines.push(line);
  }
  flush();
  return sections;
}

function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".md") && n !== "README.md" && n !== "00-code-index.md")
      .sort();
  } catch {
    return [];
  }
}

// Cheap change detection: names + mtimes of every indexed file.
function fingerprint() {
  return SOURCES.map((s) =>
    listFiles(s.dir)
      .map((f) => {
        try {
          return `${f}:${fs.statSync(path.join(s.dir, f)).mtimeMs}`;
        } catch {
          return f;
        }
      })
      .join(",")
  ).join("|");
}

function buildIndex() {
  const sections = [];
  for (const source of SOURCES) {
    for (const file of listFiles(source.dir)) {
      const raw = fs.readFileSync(path.join(source.dir, file), "utf8");
      sections.push(...parseFile(source, file, raw));
    }
  }
  const postings = new Map(); // term → Map(sectionIdx → weighted tf)
  let totalLen = 0;
  sections.forEach((s, idx) => {
    s.id = `${s.source}:${s.file.replace(/\.md$/, "")}:${idx}`;
    s.text = plain(s.md);
    const headTerms = tokenize([s.heading, ...s.path].join(" "));
    const bodyTerms = tokenize(s.text);
    s.len = bodyTerms.length + headTerms.length * HEADING_BOOST;
    totalLen += s.len;
    const add = (t, w) => {
      let m = postings.get(t);
      if (!m) postings.set(t, (m = new Map()));
      m.set(idx, (m.get(idx) || 0) + w);
    };
    for (const t of bodyTerms) add(t, 1);
    for (const t of headTerms) add(t, HEADING_BOOST);
  });
  const byId = new Map(sections.map((s, i) => [s.id, i]));
  return { sections, postings, byId, avgLen: totalLen / Math.max(1, sections.length), terms: [...postings.keys()], codes: buildCodeMap(sections) };
}

// Error-code tables: rows whose first cell is a code → { CODE: [{ source, desc, tdbd, section, page, id }] }.
// FRM rule sections (heading "U16-00972 · RULE_NAME" / "M16-01278 · Model") add one entry per rule;
// M16 models are also found by NPCI's sheet code (MOM-01278).
const CODE_CELL_RE = /^[A-Z0-9]{1,6}(?:-[A-Z0-9]+)?$/;
function buildCodeMap(sections) {
  const map = new Map();
  for (const s of sections) {
    const fm = s.source === "frm" && FRM_HEADING_RE.exec(s.heading);
    if (fm) {
      const rule = frmRule(fm[1])?.rules.find((r) => s.heading.endsWith(` · ${r.rule}`));
      if (!rule) continue;
      const entry = { source: "frm", code: fm[1], desc: `${rule.rule} — ${String(rule.desc).replace(/\s*\n\s*/g, " ")}`, tdbd: "BD", section: frmMeta(rule.family)?.title || DOC_TITLE.frm, page: s.page, id: s.id };
      for (const key of new Set([fm[1], rule.sheetCode].filter(Boolean))) {
        const list = map.get(key) || [];
        list.push(entry);
        map.set(key, list);
      }
      continue;
    }
    if (s.source !== "errcodes") continue;
    let page = s.page;
    for (const line of s.md.split("\n")) {
      const pm = PAGE_RE.exec(line);
      if (pm) page = Number(pm[1]);
      if (!line.startsWith("| ") || line.startsWith("|---")) continue;
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
      if (!CODE_CELL_RE.test(cells[0]) || !cells[1] || /^[A-Z]{3,}$/.test(cells[0]) && !/\d/.test(cells[0]) && cells[0].length > 4) continue;
      const tdbd = [...cells.slice(2)].reverse().find((c) => /^(TD|BD|-|TD\/BD)$/.test(c)) || "";
      const list = map.get(cells[0]) || [];
      list.push({ source: "errcodes", code: cells[0], desc: cells[1].replace(/\\\|/g, "|"), tdbd, section: s.heading, page, id: s.id });
      map.set(cells[0], list);
    }
  }
  return map;
}

// Codes named in a query. Codes with a digit (U16, Z9, B3) match anywhere; letters-only codes (ZM, XB)
// must be written in caps; pure numbers (00, 59) only when the query is about codes or is just the code.
function lookupCodes(q, ix) {
  const raw = String(q || "");
  const codeTalk = /\b(codes?|error|errcode|resp ?code|response|decline[ds]?|reason|means?|meaning|what is|what does)\b/i.test(raw);
  const found = [];
  const seen = new Set();
  for (const m of raw.matchAll(/\b[A-Za-z0-9]{1,6}(?:-[A-Za-z0-9]+)?\b/g)) {
    const tok = m[0];
    const up = tok.toUpperCase();
    if (seen.has(up) || !ix.codes.has(up)) continue;
    const digits = /\d/.test(up);
    const letters = /[A-Z]/.test(up);
    const ok = digits && letters ? true : letters ? tok === up && (codeTalk || raw.trim() === tok) : codeTalk || raw.trim() === tok;
    if (!ok) continue;
    seen.add(up);
    // An FRM code (U16-00972, M16-01278 / MOM-01278) also brings its base response code (U16, M16) first.
    const code = ix.codes.get(up)[0]?.code || up;
    const base = code.includes("-") ? code.split("-")[0] : null;
    if (base && !seen.has(base) && ix.codes.has(base)) {
      seen.add(base);
      found.push({ code: base, entries: ix.codes.get(base).filter((e) => e.source === "errcodes").slice(0, 2) });
    }
    found.push({ code: up, entries: ix.codes.get(up) });
    if (found.length >= 12) break;
  }
  return found;
}

/** Knowledge-base entries for one exact code (NPCI error-code tables + FRM rules / M16 models); [] when unknown. */
export function errorCodeEntries(code) {
  return getIndex().codes.get(String(code || "").trim().toUpperCase()) || [];
}

let index = null;
let indexFp = null;
function getIndex() {
  const fp = fingerprint();
  if (!index || fp !== indexFp) {
    const t0 = Date.now();
    index = buildIndex();
    indexFp = fp;
    console.log(`[spec] indexed ${index.sections.length} sections in ${Date.now() - t0}ms`);
  }
  return index;
}

// Query terms that have no exact posting expand to indexed terms they prefix (e.g. "mandat" → mandate).
function expandTerms(ix, qTerms) {
  const out = [];
  for (const t of qTerms) {
    if (ix.postings.has(t)) out.push([t, 1]);
    else if (t.length >= 3) {
      for (const term of ix.terms) if (term.startsWith(t)) out.push([term, 0.6]);
    }
  }
  return out;
}

function snippetFor(text, terms, size = 260) {
  const lower = text.toLowerCase();
  let best = 0;
  let bestHits = -1;
  const positions = [];
  for (const t of terms) {
    let i = lower.indexOf(t);
    while (i >= 0 && positions.length < 400) {
      positions.push(i);
      i = lower.indexOf(t, i + t.length);
    }
  }
  for (const p of positions) {
    const from = Math.max(0, p - 60);
    const win = lower.slice(from, from + size);
    const hits = terms.reduce((n, t) => n + (win.includes(t) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = from;
    }
  }
  const s = text.slice(best, best + size).trim();
  return (best > 0 ? "… " : "") + s + (best + size < text.length ? " …" : "");
}

// Dropped from queries only: long agent prompts are full of these and they match every section.
const STOPWORDS = new Set(
  "the and for with that this from are was were will shall should can may must not but all any each its into our your their have has had been being which who whom what when where how also than then them they there these those such per via etc use used using".split(" ")
);

function search(q, source, limit) {
  const ix = getIndex();
  const qTerms = [...new Set(tokenize(q))].filter((t) => !STOPWORDS.has(t));
  if (!qTerms.length) return { results: [], total: 0, terms: [], codes: [] };
  const expanded = expandTerms(ix, qTerms);
  const N = ix.sections.length;
  const scores = new Map();
  for (const [term, weight] of expanded) {
    const post = ix.postings.get(term);
    const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
    for (const [idx, tf] of post) {
      const s = ix.sections[idx];
      if (source && s.source !== source) continue;
      const len = Math.min(Math.max(s.len, ix.avgLen * 0.3), ix.avgLen * 3); // clamp: tiny stubs and 20-page specs both stay comparable
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * (len / ix.avgLen)));
      scores.set(idx, (scores.get(idx) || 0) + weight * idf * norm);
    }
  }
  // Phrase checks compare token streams, so "balance enquiry" matches "Balance-Enquiry".
  // Skipped for long (prompt-sized) queries, where a phrase can never match and costs a pass per section.
  const phrase = qTerms.length <= 12 ? tokenize(q).join(" ") : null;
  const multi = qTerms.length > 1;
  const ranked = [...scores.entries()].map(([idx, score]) => {
    const s = ix.sections[idx];
    const head = tokenize(s.heading.replace(/^[\d.]+\s*/, "")).join(" ");
    // every query term present, phrase match and heading match lift precise hits above long sections
    const lowerText = s.text.toLowerCase();
    const covered = qTerms.filter((t) => lowerText.includes(t) || head.includes(t)).length;
    let boost = 1 + (covered / qTerms.length) * 0.5;
    if (phrase) {
      if (multi && tokenize(s.text).join(" ").includes(phrase)) boost *= 1.6;
      if (head.includes(phrase)) boost *= 2;
      // "ReqPay" → prefer the section titled exactly that (e.g. 6.2.1 ReqPay) over variants
      if (head === phrase) boost *= 1.5 + 0.25 * Math.max(0, 4 - s.path.length); // shallower = base definition
    }
    return [idx, score * boost];
  });
  ranked.sort((a, b) => b[1] - a[1]);
  const hlTerms = [...new Set(expanded.map(([t]) => t))].slice(0, 30);
  // Distinctive query terms (rare across sections) — retrieval uses these to gate relevance.
  const rareTerms = expanded.filter(([t]) => ix.postings.get(t).size <= N * 0.08).map(([t]) => t);
  const results = ranked.slice(0, limit).map(([idx, score]) => {
    const s = ix.sections[idx];
    return {
      rare: rareTerms.filter((t) => ix.postings.get(t).has(idx)),
      id: s.id,
      source: s.source,
      sourceLabel: SOURCE_BY_ID[s.source].label,
      file: s.file,
      part: s.part,
      heading: s.heading,
      path: s.path,
      page: s.page,
      pageTo: s.pageTo,
      snippet: snippetFor(s.text.startsWith(s.heading) ? s.text.slice(s.heading.length).trim() : s.text, hlTerms),
      score: Math.round(score * 100) / 100,
    };
  });
  return { results, total: ranked.length, terms: hlTerms, codes: source && !CODE_SOURCES.has(source) ? [] : lookupCodes(q, ix).map((h) => (source ? { ...h, entries: h.entries.filter((e) => e.source === source) } : h)).filter((h) => h.entries.length) };
}

// Lines of a section worth quoting to an LLM: term hits with two lines of context, page markers
// rewritten as "(p.N)" cites, images dropped.
function excerpt(md, terms, maxLen) {
  const lines = md.split("\n").filter((l) => !/^!\[/.test(l));
  const flat = lines.map((l) => l.replace(/^<!-- p\.(\d+) -->$/, "(p.$1)"));
  if (flat.join("\n").length <= maxLen) return flat.join("\n").trim();
  const keep = new Set([0, 1, 2]);
  flat.forEach((l, i) => {
    const lower = l.toLowerCase();
    if (terms.some((t) => lower.includes(t))) for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < flat.length) keep.add(j);
  });
  let out = "";
  let prev = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = (prev >= 0 && i > prev + 1 ? "…\n" : "") + flat[i] + "\n";
    if (out.length + line.length > maxLen) break;
    out += line;
    prev = i;
  }
  return out.trim();
}

/**
 * Prompt context for LLM callers (agents, skills, Alpha): the most relevant NPCI TSD / Circular
 * sections as cited excerpts. Returns no chunks when nothing distinctive in `query` matches, so
 * unrelated prompts are left untouched.
 *
 * @param {string} query
 * @param {{ k?: number, maxChars?: number, perChunk?: number, source?: string }} [opts]
 * @returns {{ chunks: string[], refs: string[] }}
 */
// A prompt must mention UPI / NPCI domain vocabulary before spec context is added; generic words
// ("ticket", "header", "button") otherwise match spec text and pull in noise.
const DOMAIN_RE = new RegExp(
  [
    "\\b(upi|npci|vpa|psp|tpap|pspapp|remitter|beneficiary|payer|payee|mandate|autopay|umn|otm|nach|imps|aeps|rupay|cbdc|e-?rupi|udir|chargeback|tcc|ret|settlement|reconciliation|mcc|p2pm?|p2m|collect request|intent|qr code|upi lite|upi circle|reserve pay|tap ?& ?pay|123pay|hello! upi|multi-signatory|delegate|safety switch|debit ?pause|mapper|upi number|upi id|upi pin|mpin|credit line|ppi|cred block|common library|issuer bank|acquirer|balance enquiry|chk ?txn|check (txn|transaction) status|list ?account|response code|error code|refund|reversal|deemed|merchant|handle|interchange)\\b",
    "\\b(req|resp)[a-z]{3,}\\b", // ReqPay, RespAuthDetails, ReqValCust …
    "\\b[a-z]\\d{2}\\b", // response codes: U16, Z9, XB … (letter + 2 digits)
  ].join("|"),
  "i"
);

export function retrieveSpecContext(query, { k = 4, maxChars = 6000, perChunk = 1800, source = null } = {}) {
  const q = String(query || "").slice(0, 4000);
  if (!q.trim()) return { chunks: [], refs: [] };
  const ix = getIndex();
  const codeHits = source && !CODE_SOURCES.has(source) ? [] : lookupCodes(q, ix);
  if (!codeHits.length && !DOMAIN_RE.test(q)) return { chunks: [], refs: [] };
  const { results, terms } = search(q, source, k * 3);
  const qLen = tokenize(q).filter((t) => !STOPWORDS.has(t)).length;
  const minRare = qLen <= 4 ? 1 : 2;
  const top = results[0]?.score || 0;
  const picked = results.filter((r) => r.rare.length >= minRare && r.score >= top * 0.4).slice(0, k);
  const chunks = [];
  const refs = [];
  let total = 0;
  if (codeHits.length) {
    const where = (e) => (e.source === "frm" ? `${e.section}, sheet row ${e.page}` : `${e.section} (p.${e.page})`);
    const rows = codeHits.flatMap((h) => h.entries.map((e) => `| ${e.code} | ${e.desc} | ${e.tdbd || "—"} | ${where(e)} |`));
    const docs = [...new Set(codeHits.flatMap((h) => h.entries.map((e) => e.source)))];
    const docName = (d) => (d === "frm" ? [...new Set(codeHits.flatMap((h) => h.entries.filter((e) => e.source === d).map((e) => e.section)))].join(" + ") : DOC_TITLE[d]);
    const chunk = [`### ${docs.map(docName).join(" + ")} — code definitions`, "| Code | Description | TD/BD | Section (PDF page / sheet row) |", "|---|---|---|---|", ...rows]
      .join("\n")
      .slice(0, 2500);
    chunks.push(chunk);
    for (const d of docs) refs.push(`${docName(d)} — ${codeHits.filter((h) => h.entries.some((e) => e.source === d)).map((h) => h.code).join(", ")}`);
    total += chunk.length;
  }
  for (const r of picked) {
    const s = ix.sections[ix.byId.get(r.id)];
    const pages = r.pageTo && r.pageTo !== r.page ? `pp.${r.page}–${r.pageTo}` : `p.${r.page}`;
    const ref = `${docTitleOf(r.source, s.file)} — ${r.heading} (${pages})`;
    const head = `### ${ref}\nPath: ${[...r.path, r.heading].join(" › ")}\n`;
    const body = excerpt(s.md, [...new Set([...r.rare, ...terms])], Math.min(perChunk, maxChars - total - head.length));
    if (body.length < 80) break;
    chunks.push(head + body);
    refs.push(ref);
    total += head.length + body.length;
    if (total >= maxChars - 200) break;
  }
  return { chunks, refs };
}

export function registerSpecSearch(app) {
  app.get("/api/spec/sources", (_req, res) => {
    const ix = getIndex();
    res.json({
      sources: SOURCES.map((s) => ({
        id: s.id,
        label: s.label,
        sections: ix.sections.filter((x) => x.source === s.id).length,
        hasPdf: !!s.pdf && fs.existsSync(s.pdf),
      })),
    });
  });

  app.get("/api/spec/search", (req, res) => {
    const t0 = Date.now();
    const q = String(req.query.q || "").trim().slice(0, 200);
    const source = SOURCE_BY_ID[req.query.source] ? String(req.query.source) : null;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 20));
    if (!q) return res.status(400).json({ error: "Missing q" });
    try {
      res.json({ q, source, ...search(q, source, limit), ms: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Same excerpts the agents get in their system prompt — for skills / scripts / debugging.
  app.get("/api/spec/context", (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    const k = Math.min(8, Math.max(1, Number(req.query.k) || 4));
    const source = SOURCE_BY_ID[req.query.source] ? String(req.query.source) : null;
    const { chunks, refs } = retrieveSpecContext(q, { k, source });
    if (req.query.format === "text") return res.type("text/plain").send(chunks.join("\n\n---\n\n"));
    res.json({ q, refs, chunks });
  });

  app.get("/api/spec/section", (req, res) => {
    const ix = getIndex();
    const idx = ix.byId.get(String(req.query.id || ""));
    if (idx == null) return res.status(404).json({ error: "Section not found (index may have been rebuilt — search again)" });
    const s = ix.sections[idx];
    const sib = (i) => (ix.sections[i] && ix.sections[i].source === s.source ? ix.sections[i].id : null);
    res.json({
      id: s.id,
      source: s.source,
      sourceLabel: SOURCE_BY_ID[s.source].label,
      file: s.file,
      part: s.part,
      heading: s.heading,
      path: s.path,
      page: s.page,
      pageTo: s.pageTo,
      markdown: s.md,
      prevId: sib(idx - 1),
      nextId: sib(idx + 1),
    });
  });

  app.get("/api/spec/img/:source/:name", (req, res) => {
    const src = SOURCE_BY_ID[req.params.source];
    if (!src || !IMG_NAME_RE.test(req.params.name)) return res.status(404).end();
    res.sendFile(path.join(src.dir, "img", req.params.name), (err) => err && !res.headersSent && res.status(404).end());
  });

  app.get("/api/spec/pdf/:source", (req, res) => {
    const src = SOURCE_BY_ID[req.params.source];
    if (!src || !src.pdf) return res.status(404).end();
    res.type("application/pdf");
    res.sendFile(src.pdf, (err) => err && !res.headersSent && res.status(404).end());
  });
}
