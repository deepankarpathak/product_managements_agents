// One-off (re-runnable) import of the Automatic Payments Dashboard's history into Product Wise storage, so nothing is
// lost when the vendored APD (third_party/apd_installer) is retired. Every APD per-day / per-month cache CSV becomes
// one gzipped JSON entry, unchanged (same columns, same rows):
//
//   backend/data/product/_apd-history/<dataset>/days/<YYYY-MM-DD | YYYY-MM>.json.gz   { source, cols, rows: [[…]] }
//   backend/data/product/_apd-history/manifest.json                                    datasets, first / last key, counts
//
// These are kept day-wise for later use (History views, back-fills); the live Product Wise tabs don't read them yet.
// A file is re-imported only when its source CSV is newer than the entry. Usage: node backend/scripts/import-apd-history.mjs
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APD = path.resolve(HERE, "../../third_party/apd_installer/home");
const AP = path.join(APD, "upi_spike_dashboard/automatic_payments");
const OUT = path.resolve(HERE, "../data/product/_apd-history");

const DATASETS = [
  ["mandate", path.join(AP, "cache/mandate"), "Mandate board: day × stage × purpose (+ALL) × mode (+ALL) × dim (TOTAL, PAYER_BANK, PAYEE_BANK, MCC, CODE, PAYER_HANDLE, PAYEE_HANDLE) → att, suc. Golden unit, Paytm UMN handles"],
  ["cc_mandate", path.join(AP, "cache/cc_mandate"), "CC Autopay board: same as mandate, credit-card mandates only"],
  ["drill", path.join(AP, "cache/drill_all"), "Mandate failure drill-down: day × stage × purpose × mode × code × dim (SIDE, PAYER_BANK, PAYER_HANDLE, PAYEE_BANK, PAYEE_HANDLE, HANDLE_X_BANK) → n"],
  ["cc_drill", path.join(AP, "cache/cc_drill"), "CC Autopay failure drill-down"],
  ["payee", path.join(AP, "cache/payee"), "Top merchants: successful purpose-14 Creates per payee VPA / name × CC flag (every UMN on the switch)"],
  ["cccasa", path.join(APD, "trino/cc_casa_codes/cache"), "CC vs CASA: day × scope (Autopay / P2M) × stage × account × code → txns"],
  ["cccasa_split", path.join(APD, "trino/cc_casa_codes/cache_split"), "CC vs CASA: failures by payer bank / payee handle per code"],
  ["cccasa_dims", path.join(APD, "trino/cc_casa_codes/cache_dims"), "CC vs CASA: SR by payer bank / mode / MCC"],
  ["code_watch", path.join(AP, "code_watch/cache"), "Code watch (UM8-ZM, UM8-Z6, UO8) by mandate type — one file per month"],
  ["interop_days", path.join(AP, "interop/cache/days"), "Interop (Update VPA / Update MIC / Port-in / Purpose BC): day × status × class × purpose × split"],
  ["interop_months", path.join(AP, "interop/cache/months"), "Interop distinct UMNs per month"],
  ["ports", path.join(AP, "interop/cache/ports"), "Port-in / port-out cohort: one row per ported mandate (UMNs, executions, GMV, state) — per month"],
  ["port_out", path.join(AP, "interop/cache/port_out"), "Port-out by day: status × bank × app × handle × code — per month"],
  ["iccw", path.join(AP, "iccw/cache"), "ICCW: day × purpose × dim → att, suc, fail, amt, suc_amt, users"],
];
// Single APD files covering many days: split per day on a date column (first 10 chars).
const SPLIT_FILES = [
  ["upi_global_txns", path.join(AP, "upi_global/data/txns.csv"), "ts", "UPI Global: one row per UPI_GLOBAL txn (handles, banks, codes, amounts, country, app — no VPA / name / account / device / location)"],
  ["upi_global_act_fail", path.join(AP, "upi_global/data/activation_fail.csv"), "d", "UPI Global: activations not completed (day × PSP × bank × new user × reason × step)"],
];

/** RFC 4180 CSV → array of arrays (quoted fields may hold commas, quotes and newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// Keep what earlier imports recorded for datasets this run cannot find (e.g. APD folder renamed or removed).
let previous = {};
try {
  previous = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8")).datasets || {};
} catch {
  /* first import */
}
const manifest = { importedAt: new Date().toISOString(), source: APD, datasets: { ...previous } };
let wrote = 0;
let skipped = 0;
for (const [name, dir, about] of DATASETS) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}(-\d{2})?\.csv$/.test(f)).sort();
  } catch {
    console.warn(`skip ${name}: ${dir} not found`);
    continue;
  }
  const outDir = path.join(OUT, name, "days");
  fs.mkdirSync(outDir, { recursive: true });
  let rowsTotal = 0;
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(outDir, f.replace(/\.csv$/, ".json.gz"));
    const [head, ...rows] = parseCsv(fs.readFileSync(src, "utf8"));
    rowsTotal += rows.length;
    if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) {
      skipped++;
      continue;
    }
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ source: path.relative(path.resolve(HERE, "../.."), src), cols: head, rows })));
    fs.renameSync(tmp, dst);
    wrote++;
  }
  manifest.datasets[name] = { about, entries: files.length, first: files[0]?.slice(0, -4) || null, last: files[files.length - 1]?.slice(0, -4) || null, rows: rowsTotal };
  console.log(`${name.padEnd(15)} ${String(files.length).padStart(4)} entries  ${manifest.datasets[name].first} … ${manifest.datasets[name].last}  ${rowsTotal.toLocaleString("en-IN")} rows`);
}
for (const [name, file, dateCol, about] of SPLIT_FILES) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    console.warn(`skip ${name}: ${file} not found`);
    continue;
  }
  const [head, ...rows] = parseCsv(text);
  const di = head.indexOf(dateCol);
  if (di < 0) {
    console.warn(`skip ${name}: no ${dateCol} column`);
    continue;
  }
  const byDay = new Map();
  for (const r of rows) {
    const d = String(r[di] || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const outDir = path.join(OUT, name, "days");
  fs.mkdirSync(outDir, { recursive: true });
  const days = [...byDay.keys()].sort();
  for (const d of days) {
    const dst = path.join(outDir, `${d}.json.gz`);
    const tmp = `${dst}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ source: path.relative(path.resolve(HERE, "../.."), file), cols: head, rows: byDay.get(d) })));
    fs.renameSync(tmp, dst);
    wrote++;
  }
  // Days imported earlier (the APD file keeps a rolling window) stay on disk.
  const all = fs.readdirSync(outDir).filter((f) => f.endsWith(".json.gz")).map((f) => f.slice(0, 10)).sort();
  manifest.datasets[name] = { about, entries: all.length, first: all[0] || null, last: all[all.length - 1] || null, rows: (previous[name]?.rows || 0) + rows.length };
  console.log(`${name.padEnd(15)} ${String(all.length).padStart(4)} days     ${all[0]} … ${all[all.length - 1]}  (+${rows.length.toLocaleString("en-IN")} rows this run)`);
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${wrote}, unchanged ${skipped} → ${OUT}`);
