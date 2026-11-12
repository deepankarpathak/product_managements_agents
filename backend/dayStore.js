// Per-day storage for dashboard caches (Unified SR, Product Wise; Acquiring SR has its own in acqCollector.js).
//
// A "payload" is what a dashboard caches for one section / query: plain fields (window, ranAt, …) plus one or
// more row sets — `rows` and, for Unified SR, `views[<key>]`. Instead of one big JSON file rewritten on every
// save, a payload lives in a folder:
//
//   <dir>/meta.json             the plain fields + which row sets exist + which days they cover
//   <dir>/days/YYYY-MM-DD.json  { "<rowset>": [rows of that day], … }  (row day = first 10 chars of row.ts)
//   <dir>/days/YYYY-MM-DD.json.gz  same, gzipped once the day is older than GZIP_AFTER_DAYS
//
// Rows without a YYYY-MM-DD ts (snapshots, intraday payloads without ts) stay inline in meta.json.
// Saving writes only the day files whose content changed; days outside the payload are left on disk
// (history: they are never deleted, only gzipped), and loading reads only the days listed in meta.json.
// Writes are atomic with a unique temp name, so two backend processes can't trip over one .tmp file.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";

export const GZIP_AFTER_DAYS = 35;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Row day: row.ts, or element 0 of a tuple row (Unified SR breakdown codes are [ts, handle, …] tuples).
const dayOf = (r) => {
  const t = Array.isArray(r) ? r[0] : r?.ts;
  const ts = typeof t === "string" ? t.slice(0, 10) : "";
  return DAY_RE.test(ts) ? ts : null;
};
const hash = (s) => crypto.createHash("sha1").update(s).digest("hex");

/** Atomic write (unique temp file + rename). Returns false when the file already holds exactly this text. */
export function writeFileAtomic(file, text, { skipSame = false } = {}) {
  if (skipSame) {
    try {
      if (fs.readFileSync(file, "utf8") === text) return false;
    } catch {
      /* missing → write */
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

export function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, JSON.stringify(value));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readDay(daysDir, day) {
  try {
    return JSON.parse(fs.readFileSync(path.join(daysDir, `${day}.json`), "utf8"));
  } catch {
    try {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(daysDir, `${day}.json.gz`))).toString("utf8"));
    } catch {
      return null;
    }
  }
}

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const daysAgo = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

/** Rowsets of a payload: [name, rows] — "rows" and "views:<key>" (each views value that is an array of rows). */
function rowsetsOf(payload) {
  const out = [];
  if (Array.isArray(payload.rows)) out.push(["rows", payload.rows]);
  if (payload.views && typeof payload.views === "object") {
    for (const [k, v] of Object.entries(payload.views)) if (Array.isArray(v)) out.push([`views:${k}`, v]);
  }
  return out;
}

/**
 * One payload folder. Keeps a hash per day file in memory so an unchanged day is not even serialised to disk again.
 * save(payload) / load() / clear().
 */
export function createPayloadStore(dir) {
  const daysDir = path.join(dir, "days");
  const metaFile = path.join(dir, "meta.json");
  const known = new Map(); // day -> sha1 of its JSON as last written / read

  function save(payload) {
    if (!payload) return clear();
    const byDay = new Map();
    const inline = {};
    const names = [];
    for (const [name, rows] of rowsetsOf(payload)) {
      names.push(name);
      const keep = [];
      for (const r of rows) {
        const d = dayOf(r);
        if (!d) {
          keep.push(r);
          continue;
        }
        let o = byDay.get(d);
        if (!o) byDay.set(d, (o = {}));
        (o[name] ||= []).push(r);
      }
      if (keep.length) inline[name] = keep;
    }
    let written = 0;
    for (const [d, sets] of byDay) {
      const text = JSON.stringify(sets);
      const h = hash(text);
      if (known.get(d) === h) continue;
      // Not seen by this process yet: compare with what is on disk (plain or gzipped) before writing.
      if (!known.has(d)) {
        const onDisk = readDay(daysDir, d);
        if (onDisk && hash(JSON.stringify(onDisk)) === h) {
          known.set(d, h);
          continue;
        }
      }
      writeFileAtomic(path.join(daysDir, `${d}.json`), text);
      written++;
      // A gzipped copy of this day is superseded by the fresh plain file.
      try {
        fs.unlinkSync(path.join(daysDir, `${d}.json.gz`));
      } catch {
        /* none */
      }
      known.set(d, h);
    }
    const { rows, views, ...rest } = payload;
    const viewKeys = views && typeof views === "object" ? Object.keys(views) : null;
    writeJsonAtomic(metaFile, { ...rest, _store: { v: 1, rowsets: names, viewKeys, days: [...byDay.keys()].sort(), inline } });
    gzipOld();
    return { days: byDay.size, written };
  }

  function load() {
    const meta = readJson(metaFile);
    if (!meta?._store) return null;
    const { _store: st, ...rest } = meta;
    const sets = Object.fromEntries(st.rowsets.map((n) => [n, [...(st.inline?.[n] || [])]]));
    for (const d of st.days) {
      const day = readDay(daysDir, d);
      if (!day) continue;
      known.set(d, hash(JSON.stringify(day)));
      for (const [n, rows] of Object.entries(day)) if (sets[n]) for (const r of rows) sets[n].push(r);
    }
    const out = { ...rest };
    if (sets.rows) out.rows = sets.rows;
    if (st.viewKeys) out.views = Object.fromEntries(st.viewKeys.map((k) => [k, sets[`views:${k}`] || []]));
    return out;
  }

  function clear() {
    try {
      fs.unlinkSync(metaFile);
    } catch {
      /* none */
    }
  }

  // Days older than GZIP_AFTER_DAYS are kept, gzipped (~8× smaller); loading reads either form.
  function gzipOld() {
    const cutoff = daysAgo(istToday(), GZIP_AFTER_DAYS);
    let files = [];
    try {
      files = fs.readdirSync(daysDir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m || m[1] >= cutoff) continue;
      const src = path.join(daysDir, f);
      try {
        writeFileAtomic(`${src}.gz`, zlib.gzipSync(fs.readFileSync(src)));
        fs.unlinkSync(src);
      } catch (e) {
        if (e.code !== "ENOENT") console.warn(`[dayStore] gzip ${src}: ${e.message}`); // ENOENT: another process gzipped it first
      }
    }
  }

  /** Days with a file on disk (plain or gzipped), sorted — also days outside the live payload. */
  function savedDays() {
    let files = [];
    try {
      files = fs.readdirSync(daysDir);
    } catch {
      return [];
    }
    return [...new Set(files.map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.json(?:\.gz)?$/)?.[1]).filter(Boolean))].sort();
  }

  /** Rows of one row set for the saved days from..to (inclusive), read from the day files. */
  function readRange(from, to, rowset = "rows") {
    const rows = [];
    const days = [];
    for (const d of savedDays()) {
      if (d < from || d > to) continue;
      const day = readDay(daysDir, d);
      if (!day?.[rowset]) continue;
      days.push(d);
      for (const r of day[rowset]) rows.push(r);
    }
    return { rows, days };
  }

  /**
   * Write rows into day files only (no meta.json): backfills of days outside the live payload. A day file that
   * exists is left alone unless overwrite. Returns the days written.
   */
  function writeDays(rows, { rowset = "rows", overwrite = false } = {}) {
    const byDay = new Map();
    for (const r of rows) {
      const d = dayOf(r);
      if (!d) continue;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const have = new Set(savedDays());
    const written = [];
    for (const [d, list] of [...byDay].sort()) {
      if (have.has(d) && !overwrite) continue;
      writeFileAtomic(path.join(daysDir, `${d}.json`), JSON.stringify({ [rowset]: list }));
      try {
        fs.unlinkSync(path.join(daysDir, `${d}.json.gz`));
      } catch {
        /* none */
      }
      known.set(d, hash(JSON.stringify({ [rowset]: list })));
      written.push(d);
    }
    gzipOld();
    return written;
  }

  return { dir, save, load, clear, savedDays, readRange, writeDays };
}

/**
 * A group of payload folders under one root, keyed by name (e.g. Unified SR section, "<product>/<query>").
 * migrateFrom: legacy single-file cache to split once — read by the caller and passed as { name: payload };
 * the legacy file is renamed to <file>.migrated-<day>.json, never deleted.
 */
export function createStoreGroup(root) {
  const stores = new Map();
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, createPayloadStore(path.join(root, ...name.split("/"))));
    return stores.get(name);
  };
  return {
    root,
    save: (name, payload) => storeOf(name).save(payload),
    load: (name) => storeOf(name).load(),
    clear: (name) => storeOf(name).clear(),
    savedDays: (name) => storeOf(name).savedDays(),
    readRange: (name, from, to, rowset) => storeOf(name).readRange(from, to, rowset),
    writeDays: (name, rows, opts) => storeOf(name).writeDays(rows, opts),
    /** Names (relative paths) of every saved payload under root. */
    list() {
      const out = [];
      const walk = (dir, rel) => {
        let ents = [];
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        if (ents.some((e) => e.isFile() && e.name === "meta.json")) out.push(rel);
        for (const e of ents) if (e.isDirectory() && e.name !== "days") walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      };
      walk(root, "");
      return out;
    },
  };
}

/** Rename a legacy cache file out of the way after its content has been saved to a store group. */
export function retireLegacy(file) {
  if (!fs.existsSync(file)) return null;
  // Never overwrite an earlier backup: add -2, -3 … when one with today's date exists.
  let to = file.replace(/\.json$/, `.migrated-${istToday()}.json`);
  for (let i = 2; fs.existsSync(to); i++) to = file.replace(/\.json$/, `.migrated-${istToday()}-${i}.json`);
  fs.renameSync(file, to);
  return to;
}
