// Utilities — small ad-hoc lookup tools, each a single on-demand Trino query.
//
// Routes (all under /api/utils):
//   POST /handle-finder   { term } → top payee VPAs (last 3 days) containing `term`

import { runTrino } from "./trinoClient.js";

const TIMEOUT_MS = 15 * 60 * 1000;

const HANDLE_FINDER_SQL = `SELECT vpa, max(name) name, max(mcc) mcc, max(bank_code) bank_code, count(*) txns
FROM hive.switch.txn_participants_snapshot_v3
WHERE dl_last_updated >= CURRENT_DATE - INTERVAL '3' DAY
  AND participant_type='PAYEE' AND lower(vpa) LIKE '%{{term}}%'
GROUP BY vpa ORDER BY txns DESC LIMIT 50`;

// Value is spliced into a LIKE literal, so allow VPA characters only (no quotes / %).
const TERM_RE = /^[a-z0-9._@-]{2,64}$/;

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
}
