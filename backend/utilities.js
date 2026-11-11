// Utilities — small ad-hoc lookup tools, each a single on-demand Trino query.
//
// Routes (all under /api/utils):
//   POST /handle-finder   { term } → top payee VPAs (last 3 days) containing `term`
//   POST /merchant        { by: mid|vpa, values: [..] } → merchant_details + linked VPAs per input
//                         (PMS DB on the PTYBL Redash)
//   POST /error-codes     { codes: [..] } → response_code_translator (app_code / npci_code match) +
//                         response_mapper rows (upi_config on the TPAP Redash)
//                         + NPCI error-code / FRM knowledge-base entries per code

import { errorCodeEntries } from "./specSearch.js";
import { runRedashWithEnv, runTrino } from "./trinoClient.js";

const TIMEOUT_MS = 15 * 60 * 1000;

const HANDLE_FINDER_SQL = `SELECT vpa, max(name) name, max(mcc) mcc, max(bank_code) bank_code, count(*) txns
FROM hive.switch.txn_participants_snapshot_v3
WHERE dl_last_updated >= CURRENT_DATE - INTERVAL '3' DAY
  AND participant_type='PAYEE' AND lower(vpa) LIKE '%{{term}}%'
GROUP BY vpa ORDER BY txns DESC LIMIT 50`;

// Value is spliced into a LIKE literal, so allow VPA characters only (no quotes / %).
const TERM_RE = /^[a-z0-9._@-]{2,64}$/;

// ─── Merchant details (PMS on the PTYBL Redash) ──────────────────────────────

const PMS_DS_ID = Number(process.env.PMS_REDASH_DATA_SOURCE_ID) || 17;
const MAX_MERCHANT_INPUTS = 25;
// Inputs are spliced into SQL literals — no quotes / spaces allowed.
const MERCHANT_INPUT_RE = {
  mid: /^[A-Za-z0-9_-]{3,64}$/,
  vpa: /^[A-Za-z0-9._-]{2,128}@[A-Za-z0-9.]{2,32}$/,
};
const sqlList = (xs) => xs.map((x) => `'${x}'`).join(", ");
// Input → user_id resolution is inlined as a derived table, so merchant + VPA rows come back
// in a single Redash round (both statements run in parallel).
const resolveSql = (by, values) =>
  by === "mid"
    ? `SELECT mid AS input, user_id FROM merchant_details WHERE mid IN (${sqlList(values)})`
    : `SELECT vpa AS input, user_id FROM user_vpa WHERE vpa IN (${sqlList(values)})`;
const MERCHANT_SQL = {
  // Display name lives on the PMS `user` row (user.id = merchant_details.user_id).
  merchants: (by, values) => `SELECT x.input, usr.name AS merchant_name, m.*
FROM (${resolveSql(by, values)}) x
JOIN merchant_details m ON m.user_id = x.user_id
LEFT JOIN \`user\` usr ON usr.id = m.user_id`,
  vpas: (by, values) => `SELECT x.input, u.*
FROM (${resolveSql(by, values)}) x
JOIN user_vpa u ON u.user_id = x.user_id
ORDER BY u.is_default DESC, u.created_on`,
};

async function lookupMerchants(by, values, signal) {
  const run = (sql) => runRedashWithEnv("MDASH_REDASH_URL", "MDASH_REDASH_API_KEY", PMS_DS_ID, sql, { signal, timeoutMs: 120000 });
  const sql = [MERCHANT_SQL.merchants(by, values), MERCHANT_SQL.vpas(by, values)];
  const [merchants, vpas] = await Promise.all(sql.map(run));
  // A MID always has its merchant row and a VPA always has its user_vpa row, so an input
  // missing from both result sets is not in PMS.
  const byInput = new Map(); // lower(input) → { userIds, merchants, vpas }
  const slot = (input) => {
    const k = String(input).toLowerCase();
    if (!byInput.has(k)) byInput.set(k, { userIds: new Set(), merchants: [], vpas: [] });
    return byInput.get(k);
  };
  for (const { input, ...m } of merchants) {
    const e = slot(input);
    e.userIds.add(Number(m.user_id));
    e.merchants.push(m);
  }
  for (const { input, ...v } of vpas) {
    const e = slot(input);
    e.userIds.add(Number(v.user_id));
    e.vpas.push(v);
  }
  const results = values.map((input) => {
    const e = byInput.get(input.toLowerCase());
    if (!e) return { input, found: false };
    return { input, found: true, userIds: [...e.userIds], merchants: e.merchants, vpas: e.vpas };
  });
  return { results, sql: sql.join(";\n\n") };
}

// ─── Error definition (TPAP Redash upi_config.response_mapper + NPCI knowledge base) ──

const UPI_CONFIG_DS_ID = Number(process.env.UPI_CONFIG_REDASH_DATA_SOURCE_ID) || 3;
const MAX_ERROR_CODES = 50;
// Codes are spliced into SQL literals — no quotes / spaces allowed.
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
// Lookup follows the three questions a code raises:
//   "Which code does this become in NPCI / switch / PG?"     → response_code_translator (app_code = code)
//   "What does the user see for this code?"                   → response_mapper (resp_code = code)
//   "What does an NPCI code mean, and what does the user see?" → translator first (npci_code = code → app_codes),
//                                                                then response_mapper for those app_codes
const TRANSLATOR_SQL = (codes) => `SELECT * FROM response_code_translator
WHERE app_code IN (${sqlList(codes)}) OR npci_code IN (${sqlList(codes)})
ORDER BY app_code, npci_code, id LIMIT 500`;
const RESP_MAPPER_SQL = (codes) => `SELECT * FROM response_mapper
WHERE resp_code IN (${sqlList(codes)})
ORDER BY resp_code, type, id LIMIT 1000`;

const upper = (v) => (v == null ? "" : String(v).toUpperCase());

async function lookupErrorCodes(codes, signal) {
  const run = (q) => runRedashWithEnv("PTYES_REDASH_URL", "PTYES_REDASH_API_KEY", UPI_CONFIG_DS_ID, q, { signal, timeoutMs: 120000 });
  const sql = [TRANSLATOR_SQL(codes)];
  let translator = [];
  let mapper = [];
  let tpapError = null;
  try {
    // 1 · translator first — it tells which app_codes an NPCI code lands on.
    translator = await run(sql[0]);
    const appCodesOfNpci = translator.filter((t) => codes.includes(upper(t.npci_code)) && t.app_code).map((t) => upper(t.app_code));
    // 2 · mapper for the searched codes + those app_codes.
    sql.push(RESP_MAPPER_SQL([...new Set([...codes, ...appCodesOfNpci])]));
    mapper = await run(sql[1]);
  } catch (err) {
    if (signal?.aborted) throw err;
    tpapError = err.message; // knowledge-base results are still useful without Redash
  }
  const mapperOf = (c) => mapper.filter((r) => upper(r.resp_code) === c);
  const results = codes.map((code) => {
    // An FRM code (U16-00972, M16-01278 / MOM-01278) also brings its base NPCI code (U16, M16).
    const own = errorCodeEntries(code);
    const kbCode = own[0]?.code || code;
    const base = kbCode.includes("-") ? kbCode.split("-")[0] : null;
    const kb = [...own, ...(base ? errorCodeEntries(base).filter((e) => e.source === "errcodes") : [])];
    const asApp = translator.filter((t) => upper(t.app_code) === code);
    const asNpci = translator.filter((t) => upper(t.npci_code) === code);
    const npciAppCodes = [...new Set(asNpci.map((t) => upper(t.app_code)).filter((c) => c && c !== code))];
    const isNpci = asNpci.length > 0 || kb.some((e) => e.source === "errcodes");
    return {
      code,
      found: asApp.length > 0 || asNpci.length > 0 || mapperOf(code).length > 0 || kb.length > 0,
      // Q1 · which code does this become in NPCI / switch / PG?
      becomes: asApp,
      // Q2 · what does the user see for this code?
      userSees: mapperOf(code),
      // Q3 · NPCI code → meaning (knowledge base) + app_codes it maps to + what the user sees for them
      npci: isNpci ? { meaning: kb, translator: asNpci, appCodes: npciAppCodes, userSees: npciAppCodes.flatMap(mapperOf) } : null,
      kb,
    };
  });
  return { results, sql: sql.join(";\n\n"), tpapError };
}

export function registerUtilities(app) {
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  /** Abort the Trino query if the browser disconnects (Stop / tab close). */
  const abortOnClose = (res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  app.post(
    "/api/utils/handle-finder",
    handle(async (req, res) => {
      const term = String(req.body?.term || "").trim().toLowerCase();
      if (!term) throw new Error("Enter a value to search");
      if (!TERM_RE.test(term)) throw new Error("Search value may only contain letters, digits, . _ @ - (2–64 chars)");
      const sql = HANDLE_FINDER_SQL.replace("{{term}}", term);
      const startedAt = Date.now();
      const rows = await runTrino(sql, { signal: abortOnClose(res), timeoutMs: TIMEOUT_MS });
      return { term, sql, rows, ms: Date.now() - startedAt };
    })
  );

  app.post(
    "/api/utils/merchant",
    handle(async (req, res) => {
      const by = req.body?.by === "vpa" ? "vpa" : "mid";
      const raw = Array.isArray(req.body?.values) ? req.body.values : String(req.body?.values || "").split(/[\s,;]+/);
      const values = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
      if (!values.length) throw new Error(`Enter at least one ${by.toUpperCase()}`);
      if (values.length > MAX_MERCHANT_INPUTS) throw new Error(`Up to ${MAX_MERCHANT_INPUTS} ${by.toUpperCase()}s per lookup`);
      const bad = values.filter((v) => !MERCHANT_INPUT_RE[by].test(v));
      if (bad.length) throw new Error(`Not a valid ${by.toUpperCase()}: ${bad.slice(0, 3).join(", ")}`);
      const startedAt = Date.now();
      const out = await lookupMerchants(by, values, abortOnClose(res));
      return { by, ...out, ms: Date.now() - startedAt };
    })
  );

  app.post(
    "/api/utils/error-codes",
    handle(async (req, res) => {
      const raw = Array.isArray(req.body?.codes) ? req.body.codes : String(req.body?.codes || "").split(/[\s,;]+/);
      const codes = [...new Set(raw.map((v) => String(v).trim().replace(/^'|'$/g, "").toUpperCase()).filter(Boolean))];
      if (!codes.length) throw new Error("Enter at least one error code");
      if (codes.length > MAX_ERROR_CODES) throw new Error(`Up to ${MAX_ERROR_CODES} codes per lookup`);
      const bad = codes.filter((c) => !ERROR_CODE_RE.test(c));
      if (bad.length) throw new Error(`Not a valid error code: ${bad.slice(0, 3).join(", ")}`);
      const startedAt = Date.now();
      const out = await lookupErrorCodes(codes, abortOnClose(res));
      return { ...out, ms: Date.now() - startedAt };
    })
  );
}
