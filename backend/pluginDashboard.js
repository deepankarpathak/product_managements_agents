// UPI Plugin (@yesnext handle) onboarding funnel for the Product Wise dashboard.
//
// Source: live PMS MySQL on the PTYBL Redash (MDASH_REDASH_URL / MDASH_REDASH_API_KEY,
// data source "PMS"). Plugin users = user.scope_id = 10 AND source_channel_id = 79.
//
// `user` has ~740M rows and no index on scope_id / source_channel_id, so filtering it by
// channel without a created_on range times out. Instead:
//   1. Plugin users are discovered incrementally: scan `user` by created_on (indexed) in
//      month chunks from a persisted cursor up to now; ids are kept in a state file.
//   2. Accounts (+ account_cache via extended_info.tempAccRefId) and VPAs are fetched by
//      user_id IN (…) — indexed, so a full refresh of every plugin user is cheap.
//   3. Everything is bucketed by created_on day into one row per day.
//
// Metrics per day (definitions follow the reference query):
//   users         distinct scope_cust_id of plugin users created that day
//   accounts      accounts created that day by plugin users
//   vpas          distinct VPAs created that day by plugin users
//   mpin_total    accounts with account.mpin_set = 1          (SR base: accounts)
//   mpin_listing  account_cache.mpin_set = 1 — PIN set on the account-listing page
//                                                              (SR base: listing_base = accounts with a cache row)
//   mpin_post     account.mpin_set = 1 AND account_cache.mpin_set = 0 — PIN set after
//                 the account was added                       (SR base: post_base = cache rows with mpin_set = 0)

import fs from "fs";
import path from "path";
import { runRedashWithEnv } from "./trinoClient.js";

const URL_VAR = "MDASH_REDASH_URL";
const KEY_VAR = "MDASH_REDASH_API_KEY";
const DATA_SOURCE_ID = Number(process.env.PLUGIN_PMS_DATA_SOURCE_ID) || 17;
// First plugin user was created 2026-09-10 (no plugin users Mar–Aug 2026).
export const PLUGIN_START_DATE = process.env.PLUGIN_START_DATE || "2026-09-01";
const START_DATE = PLUGIN_START_DATE;
const SCAN_CHUNK_DAYS = 31;
// Stop the scan a little behind wall clock so in-flight inserts are not skipped.
const SCAN_LAG_MIN = 2;
const ID_BATCH = 500;
const TIMEOUT_MS = 15 * 60 * 1000;
const TZ_OFFSET_MIN = 330;

export const PLUGIN_HANDLE = "yesnext";

const USER_FILTER = "scope_id = 10 AND source_channel_id = 79";

export const PLUGIN_SQL = {
  users: `-- 1. plugin users, scanned by created_on in ${SCAN_CHUNK_DAYS}-day chunks from a saved cursor
SELECT id, scope_cust_id AS cid, DATE_FORMAT(created_on, '%Y-%m-%d') AS ts
FROM user
WHERE created_on >= '{{FROM}}' AND created_on < '{{TO}}'
  AND ${USER_FILTER}`,
  accounts: `-- 2. accounts of those users (batches of ${ID_BATCH} ids)
SELECT a.id, DATE_FORMAT(a.created_on, '%Y-%m-%d') AS ts, a.mpin_set, ac.id AS ac_id, ac.mpin_set AS ac_mpin_set
FROM account a
LEFT JOIN account_cache ac
  ON ac.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(a.extended_info, '$.tempAccRefId')) AS UNSIGNED)
WHERE a.user_id IN ({{USER_IDS}})`,
  vpas: `-- 3. VPAs of those users
SELECT v.vpa, DATE_FORMAT(v.created_on, '%Y-%m-%d') AS ts
FROM user_vpa v
WHERE v.user_id IN ({{USER_IDS}})`,
};

const pad2 = (n) => String(n).padStart(2, "0");
/** IST wall-clock "YYYY-MM-DD HH:MM:SS" for an epoch ms. */
function istStamp(ms) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
const stampMs = (s) => Date.parse(`${s.replace(" ", "T")}Z`) - TZ_OFFSET_MIN * 60000;

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s.startDate === START_DATE && Array.isArray(s.users)) return s;
  } catch {
    /* fresh */
  }
  return { startDate: START_DATE, cursor: `${START_DATE} 00:00:00`, users: [] };
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

const run = (sql) => runRedashWithEnv(URL_VAR, KEY_VAR, DATA_SOURCE_ID, sql, { timeoutMs: TIMEOUT_MS });

/**
 * Refresh the funnel. onProgress(note) reports scan progress. Returns daily rows:
 * { ts, handle, users, accounts, vpas, mpin_total, listing_base, mpin_listing, post_base, mpin_post }.
 */
export async function fetchPluginDaily({ stateFile, onProgress = () => {} }) {
  const state = readState(stateFile);
  const known = new Map(state.users.map((u) => [u.id, u]));

  // 1. Advance the user scan to (now − lag), persisting after every chunk so a long
  //    first backfill resumes where it stopped.
  const end = istStamp(Date.now() - SCAN_LAG_MIN * 60000);
  while (state.cursor < end) {
    const to = istStamp(Math.min(stampMs(state.cursor) + SCAN_CHUNK_DAYS * 86400000, stampMs(end)));
    onProgress(`scanning users ${state.cursor.slice(0, 10)} → ${to.slice(0, 10)}`);
    const rows = await run(PLUGIN_SQL.users.replace("{{FROM}}", state.cursor).replace("{{TO}}", to));
    for (const r of rows) known.set(Number(r.id), { id: Number(r.id), cid: r.cid == null ? `u${r.id}` : String(r.cid), ts: String(r.ts).slice(0, 10) });
    state.cursor = to;
    state.users = [...known.values()];
    writeState(stateFile, state);
  }

  // 2. Accounts + VPAs of every plugin user.
  const ids = state.users.map((u) => u.id);
  const accounts = [];
  const vpas = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const list = ids.slice(i, i + ID_BATCH).join(", ");
    onProgress(`accounts & VPAs ${Math.min(i + ID_BATCH, ids.length)} / ${ids.length} users`);
    const [a, v] = await Promise.all([run(PLUGIN_SQL.accounts.replace("{{USER_IDS}}", list)), run(PLUGIN_SQL.vpas.replace("{{USER_IDS}}", list))]);
    accounts.push(...a);
    vpas.push(...v);
  }

  // 3. Bucket by day.
  const days = new Map();
  const day = (ts) => {
    const k = String(ts).slice(0, 10);
    let o = days.get(k);
    if (!o) days.set(k, (o = { ts: k, handle: PLUGIN_HANDLE, users: new Set(), accounts: new Set(), vpas: new Set(), mpin_total: 0, listing_base: 0, mpin_listing: 0, post_base: 0, mpin_post: 0 }));
    return o;
  };
  for (const u of state.users) day(u.ts).users.add(u.cid);
  const seenAcc = new Set();
  for (const a of accounts) {
    if (seenAcc.has(a.id)) continue;
    seenAcc.add(a.id);
    const o = day(a.ts);
    o.accounts.add(a.id);
    const set = Number(a.mpin_set) === 1;
    if (set) o.mpin_total += 1;
    if (a.ac_id != null) {
      o.listing_base += 1;
      if (Number(a.ac_mpin_set) === 1) o.mpin_listing += 1;
      else if (Number(a.ac_mpin_set) === 0) {
        o.post_base += 1;
        if (set) o.mpin_post += 1;
      }
    }
  }
  for (const v of vpas) if (v.vpa) day(v.ts).vpas.add(v.vpa);

  return [...days.values()]
    .map((o) => ({ ...o, users: o.users.size, accounts: o.accounts.size, vpas: o.vpas.size }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}
