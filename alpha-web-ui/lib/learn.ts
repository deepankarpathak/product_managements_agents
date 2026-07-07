import path from "node:path";
import fs from "node:fs";
import { REPO_ROOT } from "./repo";

/**
 * Learn feed: turn structured wiki markdown into dense, complete "micro-lesson"
 * cards for the TikTok-style learning surface.
 *
 * Extraction is FAITHFUL — every line on a card is pulled verbatim from the
 * source page (only markdown syntax is stripped, tables are flattened to
 * "label: value" points). Nothing is paraphrased or invented, in keeping with
 * the wiki's anti-hallucination rules. Each card links back to its source page.
 *
 * A card is built as a real lesson:
 *   - deck      : the opening "what it is" paragraph (full, not truncated)
 *   - stat      : a highlighted headline number for memorability
 *   - blocks    : labelled substance — How it works / In the wild / The catch
 *   - takeaway  : the "For Paytm UPI" application
 */

export type LearnBlock = { label: string; points: string[] };

export type LearnCard = {
  id: string;
  title: string;
  category: string;
  group: string;
  accent: string;
  source: string;
  tags: string[];
  internal: boolean;
  deck: string;
  stat: string | null;
  blocks: LearnBlock[];
  takeaway: LearnBlock | null;
};

const WIKI = path.join(REPO_ROOT, "wiki");

const DIRS: Record<string, { label: string; group: string; accent: string }> = {
  opportunities: { label: "Opportunity", group: "insights", accent: "ocean" },
  gaps: { label: "Gap", group: "insights", accent: "ember" },
  "state-of-union": { label: "State of Union", group: "insights", accent: "teal" },
  themes: { label: "Theme", group: "insights", accent: "grape" },
  features: { label: "Feature", group: "product", accent: "indigo" },
  journeys: { label: "Journey", group: "product", accent: "amber" },
  apps: { label: "Competitor", group: "product", accent: "slate" },
  loops: { label: "Growth Loop", group: "product", accent: "forest" },
  frameworks: { label: "Framework", group: "frameworks", accent: "violet" },
};

type Role = "deck" | "how" | "evidence" | "catch" | "takeaway" | "skip" | "extra";

// Heading (lowercased) -> role. Drives how each section is used on the card.
const ROLE: Record<string, Role> = {
  // structural noise — never shown
  "cross-references": "skip",
  "related pages": "skip",
  evidence: "skip",
  sources: "skip",
  source: "skip",
  "linked gaps and features": "skip",
  "linked opportunities": "skip",
  "linked gaps": "skip",
  "behavioral frameworks": "skip",

  // deck — the "what it is" summary
  "tl;dr": "deck",
  opportunity: "deck",
  gap: "deck",
  question: "deck",
  loop: "deck",
  positioning: "deck",
  "current view (dated)": "deck",
  "current view (as of 2026-05)": "deck",
  framework: "deck",
  "paytm position": "deck",

  // how it works
  "mechanism (why)": "how",
  "trigger → action → reward": "how",
  "growth anatomy": "how",
  "the framework in 4 steps": "how",
  "the framework in 5 steps": "how",
  "how it works": "how",
  spec: "how",
  "diagnostic questions / checklist": "how",
  "the adjacent user defined": "how",

  // in the wild — concrete examples, scale, numbers, competitor specifics
  scale: "evidence",
  "key feature implementations": "evidence",
  "instagram 2016 playbook": "evidence",
  "key virality loops": "evidence",
  "virality loops (from catalogue)": "evidence",
  "competitor implementations": "evidence",
  adoption: "evidence",
  "canonical examples": "evidence",
  "cross-app comparison": "evidence",
  "competitor benchmarking summary": "evidence",
  "competitor feature benchmarking (from matrix)": "evidence",
  "1. headline scorecard": "evidence",
  "headline scorecard": "evidence",
  outcomes: "evidence",

  // the catch — limits, risks, what's missing
  "where it doesn't transfer": "catch",
  "known gaps": "catch",
  "open uncertainties": "catch",
  blockers: "catch",
  "regulatory constraints": "catch",
  "why it died": "catch",

  // takeaway — application to Paytm / UPI
  "upi relevance / applicability": "takeaway",
  "adaptation to upi": "takeaway",
  "upi application": "takeaway",
  "applicability to upi-native products": "takeaway",
  "applicability to upi": "takeaway",
  "where it applies in upi": "takeaway",
  "recommended mvp": "takeaway",
  "decisions / actions": "takeaway",
  "why now": "takeaway",
  "key takeaway for india": "takeaway",
  "falsifiable bet": "takeaway",
  "job to be done": "takeaway",
  "open opportunities": "takeaway",
};

const ROLE_LABEL: Record<string, string> = {
  how: "How it works",
  evidence: "In the wild",
  catch: "The catch",
};

// Priority order when picking the deck paragraph.
const DECK_ORDER = [
  "tl;dr",
  "opportunity",
  "gap",
  "question",
  "loop",
  "positioning",
  "current view (dated)",
  "current view (as of 2026-05)",
  "framework",
  "paytm position",
];

type Section = { heading: string; lines: string[]; internal: boolean };

function splitFrontmatter(raw: string): { fm: string; body: string } {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const nl = raw.indexOf("\n", end + 1);
      return { fm: raw.slice(3, end), body: raw.slice(nl + 1) };
    }
  }
  return { fm: "", body: raw };
}

function parseFrontmatter(fm: string): { title?: string; tags: string[] } {
  const out: { title?: string; tags: string[] } = { tags: [] };
  let inTags = false;
  for (const line of fm.split("\n")) {
    const tagItem = line.match(/^\s*-\s+(.+)$/);
    if (inTags && tagItem) {
      out.tags.push(tagItem[1].trim());
      continue;
    }
    inTags = false;
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "title" && val) out.title = val.replace(/^["']|["']$/g, "").trim();
    if (key === "tags" && val === "") inTags = true;
  }
  return out;
}

function toSections(body: string): { h1?: string; sections: Section[] } {
  let h1: string | undefined;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let internal = false;
  for (const line of body.split("\n")) {
    if (/<!--\s*INTERNAL\s*-->/i.test(line)) {
      internal = true;
      continue;
    }
    if (/<!--\s*\/INTERNAL\s*-->/i.test(line)) {
      internal = false;
      continue;
    }
    if (/^<!--/.test(line.trim())) continue; // drop other HTML comments
    const h1m = line.match(/^#\s+(.+)$/);
    const h2m = line.match(/^#{2,3}\s+(.+)$/);
    if (h1m) {
      h1 = h1m[1].trim();
      continue;
    }
    if (h2m) {
      cur = { heading: h2m[1].trim(), lines: [], internal: false };
      sections.push(cur);
      continue;
    }
    if (!cur) cur = { heading: "", lines: [], internal: false };
    if (sections[sections.length - 1] !== cur) sections.push(cur);
    cur.lines.push(line);
    if (internal && line.trim()) cur.internal = true;
  }
  return { h1, sections };
}

/** Decode literal \uXXXX escape sequences that appear in some YAML titles. */
function decodeEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}

/** Strip markdown decoration to plain prose. */
function clean(s: string): string {
  return decodeEscapes(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_{1,2}([^_]+)_{1,2}/g, "$1")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBullet(line: string): boolean {
  return /^\s*([-*]|\d+\.)\s+/.test(line);
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const stop = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("! ")
  );
  if (stop > max * 0.55) return slice.slice(0, stop + 1).trim();
  const sp = slice.lastIndexOf(" ");
  return (sp > 0 ? slice.slice(0, sp) : slice).trim() + "…";
}

/** First prose paragraph of a section (skips bullets/tables/headings). */
function firstParagraph(sec: Section, max: number): string {
  const buf: string[] = [];
  for (const raw of sec.lines) {
    const t = raw.trim();
    if (!t) {
      if (buf.length) break;
      continue;
    }
    if (t.startsWith("#") || t.startsWith("|") || isBullet(t)) {
      if (buf.length) break;
      continue;
    }
    buf.push(t);
  }
  return cap(clean(buf.join(" ")), max);
}

/** Flatten a markdown table (raw lines incl. pipes) into "label: value" points. */
function tableRows(rows: string[]): string[] {
  const out: string[] = [];
  const cells = (r: string) =>
    r
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => clean(c));
  let started = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].trim();
    if (/^\|?[\s:|-]+\|?$/.test(r) && r.includes("-")) {
      started = true; // separator row — data follows
      continue;
    }
    if (!started) continue; // header row (before separator)
    const c = cells(r).filter((x) => x.length);
    if (c.length < 2) {
      if (c.length === 1 && c[0].length >= 12) out.push(c[0]);
      continue;
    }
    out.push(`${c[0]}: ${c.slice(1).join(" — ")}`);
  }
  return out;
}

/** Turn a section's body into discrete points (bullets, table rows, paragraphs). */
function sectionPoints(sec: Section, maxPoints: number, maxLen: number): string[] {
  const pts: string[] = [];
  const lines = sec.lines;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const t = clean(para.join(" "));
    if (t.length >= 16) pts.push(cap(t, maxLen));
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const t = lines[i].trim();
    if (!t) {
      flush();
      i++;
      continue;
    }
    if (t.startsWith("#")) break;
    if (t.startsWith("|")) {
      flush();
      const tbl: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) tbl.push(lines[i].trim()), i++;
      for (const row of tableRows(tbl)) if (row.length >= 8) pts.push(cap(row, maxLen));
      continue;
    }
    if (isBullet(t)) {
      flush();
      const x = clean(t);
      if (x.length >= 8) pts.push(cap(x, maxLen));
      i++;
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  // de-dupe, keep order
  const seen = new Set<string>();
  const uniq = pts.filter((p) => {
    const k = p.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return uniq.slice(0, maxPoints);
}

/** Pick the single most memorable stat sentence from candidate strings. */
function pickStat(cands: string[]): string | null {
  let best: string | null = null;
  let bestScore = 2;
  for (const c of cands) {
    if (!/\d/.test(c)) continue;
    let s = 0;
    if (/→|->/.test(c)) s += 4;
    if (/\b\d[\d,.]*\s?(M|MAU|B|bn|mn|million|billion|crore|lakh)\b/i.test(c)) s += 3;
    if (/%/.test(c)) s += 2;
    if (/[₹$]/.test(c)) s += 2;
    if (/k[\s-]?factor|k\s?=|k-?value/i.test(c)) s += 3;
    if (/\b\d+(\.\d+)?x\b/i.test(c)) s += 2;
    const len = c.length;
    if (len >= 24 && len <= 160) s += 2;
    else if (len > 200) s -= 3;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best ? cap(best, 200) : null;
}

function splitSentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+/).filter((x) => x.trim().length);
}

function buildCard(absPath: string, rel: string): LearnCard | null {
  const raw = fs.readFileSync(absPath, "utf8");
  const { fm, body } = splitFrontmatter(raw);
  const meta = parseFrontmatter(fm);
  const { h1, sections } = toSections(body);

  const parts = rel.split("/");
  const dir = parts[1];
  const cfg = DIRS[dir];
  if (!cfg) return null;

  let category = cfg.label;
  if (dir === "themes" && parts.length > 3) category = `Theme · ${parts[2]}`;

  const roleOf = (s: Section): Role => {
    if (!s.heading) return "skip";
    return ROLE[s.heading.toLowerCase()] ?? "extra";
  };

  let usedInternal = false;
  const markUsed = (s: Section) => {
    if (s.internal) usedInternal = true;
  };

  // ── Deck ──────────────────────────────────────────────────────────────
  const deckSecs = sections.filter((s) => roleOf(s) === "deck");
  let deckSec: Section | undefined;
  for (const name of DECK_ORDER) {
    deckSec = deckSecs.find((s) => s.heading.toLowerCase() === name && firstParagraph(s, 40));
    if (deckSec) break;
  }
  if (!deckSec) deckSec = deckSecs.find((s) => firstParagraph(s, 40));
  if (!deckSec) {
    // fall back to lead text or first usable section
    deckSec =
      sections.find((s) => s.heading === "" && firstParagraph(s, 20)) ||
      sections.find((s) => roleOf(s) !== "skip" && firstParagraph(s, 20));
  }
  let deck = deckSec ? firstParagraph(deckSec, 520) : "";
  if (deckSec) markUsed(deckSec);

  // ── Role blocks (merge all sections sharing a role) ───────────────────
  const collect = (role: Role, maxPoints: number, maxLen: number): string[] => {
    const out: string[] = [];
    for (const s of sections) {
      if (roleOf(s) !== role || s === deckSec) continue;
      const pts = sectionPoints(s, maxPoints, maxLen);
      if (pts.length) {
        markUsed(s);
        out.push(...pts);
      }
    }
    const seen = new Set<string>();
    return out
      .filter((p) => {
        const k = p.toLowerCase().slice(0, 60);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, maxPoints);
  };

  const blocks: LearnBlock[] = [];
  for (const role of ["how", "evidence", "catch"] as Role[]) {
    const points = collect(role, 5, 320);
    if (points.length) blocks.push({ label: ROLE_LABEL[role], points });
  }

  // Generic "extra" sections fill out the lesson if it's thin.
  if (blocks.length < 3) {
    for (const s of sections) {
      if (blocks.length >= 4) break;
      if (roleOf(s) !== "extra" || s === deckSec) continue;
      const points = sectionPoints(s, 4, 300);
      if (points.length >= 1) {
        markUsed(s);
        blocks.push({ label: s.heading, points });
      }
    }
  }

  // ── Takeaway (application to Paytm / UPI) ─────────────────────────────
  const takePts = collect("takeaway", 4, 300);
  const takeaway: LearnBlock | null = takePts.length
    ? { label: "For Paytm UPI", points: takePts }
    : null;

  // ── Stat highlight ────────────────────────────────────────────────────
  const statCands: string[] = [];
  if (deck) statCands.push(...splitSentences(deck));
  for (const b of blocks) statCands.push(...b.points);
  if (takeaway) statCands.push(...takeaway.points);
  const stat = pickStat(statCands);

  const title = decodeEscapes(meta.title || h1 || path.basename(rel, ".md"));

  // Need real substance to be worth a card.
  const bodyPoints = blocks.reduce((n, b) => n + b.points.length, 0) + (takeaway?.points.length || 0);
  if (!deck && bodyPoints === 0) return null;

  const tags = meta.tags
    .filter(
      (t) => !["upi", "india", "framework", "opportunity", "app", "loop"].includes(t.toLowerCase())
    )
    .slice(0, 4);

  return {
    id: rel.replace(/[^a-z0-9]+/gi, "-"),
    title,
    category,
    group: cfg.group,
    accent: cfg.accent,
    source: rel,
    tags,
    internal: usedInternal,
    deck,
    stat,
    blocks,
    takeaway,
  };
}

function walk(dir: string, acc: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".")) continue;
      walk(full, acc);
    } else if (e.isFile() && e.name.endsWith(".md")) acc.push(full);
  }
}

let CACHE: { cards: LearnCard[]; at: number } | null = null;
const TTL_MS = 60_000;

export function getLearnCards(): LearnCard[] {
  if (CACHE && Date.now() - CACHE.at < TTL_MS) return CACHE.cards;

  const cards: LearnCard[] = [];
  for (const dir of Object.keys(DIRS)) {
    const files: string[] = [];
    walk(path.join(WIKI, dir), files);
    for (const abs of files) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
      try {
        const card = buildCard(abs, rel);
        if (card) cards.push(card);
      } catch {
        /* skip unparseable pages */
      }
    }
  }

  cards.sort((a, b) => a.id.localeCompare(b.id));
  interleave(cards);

  CACHE = { cards, at: Date.now() };
  return cards;
}

/** Reorder so adjacent cards tend to come from different categories. */
function interleave(cards: LearnCard[]) {
  const buckets = new Map<string, LearnCard[]>();
  for (const c of cards) {
    if (!buckets.has(c.category)) buckets.set(c.category, []);
    buckets.get(c.category)!.push(c);
  }
  const queues = [...buckets.values()];
  const out: LearnCard[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  cards.length = 0;
  cards.push(...out);
}
