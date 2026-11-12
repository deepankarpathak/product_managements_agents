// Error-code sheet (ported from the Automatic Payments Dashboard "Error-code sheet" button, 11 Nov 2026).
// = an export of TPAP Redash data source 3, upi_config.response_mapper: one row per (resp_code, type) with
// response_constant, resp_msg (the app's customer message), title, updated_on …
//
//   backend/data/error-code-mapping.csv   the sheet; first seeded from third_party/apd_installer/…/error_code_mapping.csv,
//                                         then re-pulled from Redash once a day (old file kept if the pull fails)
//   GET /api/product/error-sheet          download the CSV          GET /api/product/error-sheet/info   rows, updated, source
//
// appMessage(code) → { constant, app } per code: the APP row first, then NPCI, then any other type; latest updated_on
// wins within a type (same rule as the APD's error_map.py). U16 / M16 risk codes are not mapped from here — their
// NPCI FRM rule text (frmRules.js) stays the description.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runRedashWithEnv } from "./trinoClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, "reference", "error_code_mapping.seed.csv"); // copy of the APD upi_alpha_ref sheet
const DS = Number(process.env.ERROR_SHEET_REDASH_DS) || 3;
const REFRESH_MS = 24 * 3600 * 1000;
const TYPE_RANK = { APP: 0, NPCI: 1 };

let FILE = null;
let byCode = null;
let loadedMtime = 0;

/** RFC 4180 CSV → array of arrays. */
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
const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function load() {
  if (!FILE) return {};
  let st;
  try {
    st = fs.statSync(FILE);
  } catch {
    return (byCode = {});
  }
  if (byCode && st.mtimeMs === loadedMtime) return byCode;
  const [head, ...rows] = parseCsv(fs.readFileSync(FILE, "utf8"));
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const best = {};
  for (const r of rows) {
    const code = (r[ix.resp_code] || "").trim();
    if (!code) continue;
    const rank = TYPE_RANK[r[ix.type]] ?? 2;
    const when = r[ix.updated_on] || "";
    const cur = best[code];
    if (!cur || rank < cur.rank || (rank === cur.rank && when > cur.when)) {
      best[code] = { rank, when, constant: r[ix.response_constant] || "", app: (r[ix.resp_msg] || "").trim(), title: (r[ix.title] || "").trim() };
    }
  }
  loadedMtime = st.mtimeMs;
  return (byCode = best);
}

/** { constant, app } for an app / NPCI response code, or null. U16 / M16 → null (FRM text wins). */
export function appMessage(code) {
  const c = String(code || "").replace(/^UPI-/, "");
  if (!c || /^(U16|M16|MOM)/.test(c)) return null;
  const m = load()[c];
  return m ? { constant: m.constant, app: m.app || m.title } : null;
}

async function refresh() {
  const rows = await runRedashWithEnv("PTYES_REDASH_URL", "PTYES_REDASH_API_KEY", DS, "SELECT * FROM response_mapper ORDER BY id", { timeoutMs: 10 * 60 * 1000 });
  if (!rows?.length) throw new Error("response_mapper returned no rows");
  const cols = Object.keys(rows[0]);
  const text = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FILE);
  return rows.length;
}

export function registerErrorSheet(app, { dataDir }) {
  FILE = path.join(dataDir, "error-code-mapping.csv");
  if (!fs.existsSync(FILE) && fs.existsSync(SEED)) fs.copyFileSync(SEED, FILE);
  let lastPull = { at: null, ok: null, rows: null, error: null };
  const pull = async () => {
    try {
      const n = await refresh();
      lastPull = { at: Date.now(), ok: true, rows: n, error: null };
      console.log(`[error-sheet] response_mapper refreshed: ${n} rows`);
    } catch (e) {
      lastPull = { at: Date.now(), ok: false, rows: null, error: e.message };
      console.warn(`[error-sheet] refresh failed, keeping the old sheet: ${e.message}`);
    }
  };
  const stale = () => {
    try {
      return Date.now() - fs.statSync(FILE).mtimeMs > REFRESH_MS;
    } catch {
      return true;
    }
  };
  setTimeout(() => stale() && pull(), 90e3).unref?.();
  setInterval(() => stale() && pull(), 3600e3).unref?.();

  app.get("/api/product/error-sheet", (req, res) => {
    if (!fs.existsSync(FILE)) return res.status(404).json({ success: false, error: "error-code sheet not available yet" });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="error_code_mapping.csv"`);
    fs.createReadStream(FILE).pipe(res);
  });
  app.get("/api/product/error-sheet/info", (req, res) => {
    let st = null;
    try {
      st = fs.statSync(FILE);
    } catch {
      /* none */
    }
    res.json({ success: true, file: path.relative(path.join(__dirname, ".."), FILE), updatedAt: st?.mtime || null, codes: Object.keys(load()).length, source: `TPAP Redash ds ${DS} · upi_config.response_mapper`, lastPull });
  });
  app.post("/api/product/error-sheet/refresh", async (req, res) => {
    await pull();
    res.json({ success: lastPull.ok, ...lastPull });
  });
}
