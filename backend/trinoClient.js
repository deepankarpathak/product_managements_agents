// Shared Trino (DWH) and Redash clients for every dashboard backend: Unified SR, Success Rate
// Snippet, Product Wise, Utilities and the UPI Plugin funnel. Moved out of the retired Morning
// Dashboard (morningDashboard.js) unchanged.
//
// runTrino: one Trino service account is shared by every dashboard, the Utilities tab and the
// Analyst Agent, so all callers in this process go through one concurrency cap
// (MDASH_TRINO_MAX_CONCURRENT, default 3) and resubmit on "Too many queued queries". Each query
// runs on the primary account (TRINO_SERVICE_*) and falls back once to TRINO_BACKUP_* if rejected.
// runRedashOnce / runRedashWithEnv: one SQL on a Redash instance (env pair URL + key).

// ─── Trino executor ──────────────────────────────────────────────────────────

// TRINO_SERVICE_USER / _PASSWORD is the primary account; TRINO_BACKUP_USER / _PASSWORD (optional)
// is tried when the primary is rejected (bad credentials, access denied, queue full).
export function trinoEnv(account = "primary") {
  const backup = account === "backup";
  return {
    url: (process.env.TRINO_API_URL || "").replace(/\/+$/, ""),
    user: (backup ? process.env.TRINO_BACKUP_USER : process.env.TRINO_SERVICE_USER) || "",
    password: (backup ? process.env.TRINO_BACKUP_PASSWORD : process.env.TRINO_SERVICE_PASSWORD) || "",
    source: process.env.TRINO_SOURCE || "morning-dashboard",
    catalog: process.env.TRINO_CATALOG || "",
    schema: process.env.TRINO_SCHEMA || "",
    executeAs: process.env.TRINO_EXECUTE_AS_USER || "",
    impersonation: String(process.env.TRINO_IMPERSONATION || "true").toLowerCase() !== "false",
  };
}

function trinoHeaders(env) {
  const h = {
    Authorization: `Basic ${Buffer.from(`${env.user}:${env.password}`).toString("base64")}`,
    "Content-Type": "text/plain; charset=utf-8",
    "X-Trino-Source": env.source,
  };
  // Mirror Query_Agent: X-Trino-User always set; impersonate only when enabled.
  if (env.impersonation && env.executeAs && env.executeAs !== env.user) {
    h["X-Trino-User"] = env.executeAs;
    h["X-Trino-Original-User"] = env.user;
  } else {
    h["X-Trino-User"] = env.user;
  }
  if (env.catalog) h["X-Trino-Catalog"] = env.catalog.trim().toLowerCase();
  if (env.schema) h["X-Trino-Schema"] = env.schema;
  return h;
}

export async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

// One Trino service account is shared by every dashboard, the Utilities tab and the
// Analyst Agent, and its resource group allows only a few queued queries. Cap how many
// this backend runs at once (MDASH_TRINO_MAX_CONCURRENT, default 3) and, if Trino still
// answers "Too many queued queries", wait and resubmit instead of failing the run.
const TRINO_MAX = Math.max(1, Number(process.env.MDASH_TRINO_MAX_CONCURRENT) || 3);
let trinoActive = 0;
const trinoWaiters = [];

function acquireTrino(signal) {
  if (trinoActive < TRINO_MAX) {
    trinoActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const w = { resolve };
    trinoWaiters.push(w);
    signal?.addEventListener(
      "abort",
      () => {
        const i = trinoWaiters.indexOf(w);
        if (i >= 0) trinoWaiters.splice(i, 1);
        reject(signal.reason || new Error("aborted"));
      },
      { once: true }
    );
  });
}

function releaseTrino() {
  const next = trinoWaiters.shift();
  if (next) next.resolve(); // hand the slot over
  else trinoActive -= 1;
}

const isQueueFull = (err) => /too many queued queries/i.test(err?.message || "");
// Errors the backup account may not hit: wrong/expired credentials, missing grants, a full queue.
const isAccountError = (err) =>
  isQueueFull(err) || /invalid credentials|access denied|unauthorized|HTTP 401|HTTP 403/i.test(err?.message || "");
const hasBackup = () => Boolean(process.env.TRINO_BACKUP_USER && process.env.TRINO_BACKUP_PASSWORD);

// Primary account first; on an account-level rejection, the same SQL once more on the backup.
async function runTrinoWithBackup(sql, opts) {
  try {
    return await runTrinoOnce(sql, opts);
  } catch (err) {
    if (!hasBackup() || !isAccountError(err) || opts.signal?.aborted) throw err;
    console.warn(`[trino] ${trinoEnv().user} rejected (${err.message.slice(0, 120)}) — retrying as backup ${trinoEnv("backup").user}`);
    opts.onProgress?.({ state: "primary Trino account rejected — retrying on backup account" });
    return await runTrinoOnce(sql, { ...opts, account: "backup" });
  }
}

export async function runTrino(sql, opts = {}) {
  const { signal, onProgress, timeoutMs = 600000 } = opts;
  const deadline = Date.now() + timeoutMs;
  onProgress?.({ state: "waiting for a Trino slot" });
  await acquireTrino(signal);
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runTrinoWithBackup(sql, { ...opts, timeoutMs: Math.max(30000, deadline - Date.now()) });
      } catch (err) {
        // Queue full is transient: keep resubmitting (15s, 30s, … capped at 60s) until the run's own timeout.
        const wait = Math.min(60000, attempt * 15000);
        if (!isQueueFull(err) || signal?.aborted || Date.now() + wait > deadline) throw err;
        onProgress?.({ state: `Trino queue full — resubmitting in ${wait / 1000}s (try ${attempt + 1})` });
        await sleep(wait, signal);
      }
    }
  } finally {
    releaseTrino();
  }
}

async function runTrinoOnce(sql, { signal, timeoutMs = 600000, onProgress, account = "primary" }) {
  const env = trinoEnv(account);
  const missing = ["url", "user", "password"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`Trino not configured (TRINO_API_URL / TRINO_SERVICE_USER / TRINO_SERVICE_PASSWORD)`);
  const headers = trinoHeaders(env);
  const deadline = Date.now() + timeoutMs;
  let res = await fetch(`${env.url}/v1/statement`, { method: "POST", headers, body: sql, signal });
  let payload = await readJson(res);
  if (!res.ok) throw new Error(payload.error?.message || `Trino HTTP ${res.status}`);
  let columns = payload.columns || [];
  const data = [...(payload.data || [])];
  let nextUri = payload.nextUri;
  const queryId = payload.id;
  onProgress?.({ remoteId: queryId, state: payload.stats?.state });
  try {
    while (nextUri) {
      if (payload.error) break;
      if (Date.now() > deadline) throw new Error(`Trino query exceeded ${Math.round(timeoutMs / 1000)}s timeout`);
      res = await fetch(nextUri, { headers, signal });
      payload = await readJson(res);
      if (!res.ok) throw new Error(payload.error?.message || `Trino HTTP ${res.status}`);
      if (!columns.length && payload.columns) columns = payload.columns;
      if (payload.data) data.push(...payload.data);
      onProgress?.({
        remoteId: queryId,
        state: payload.stats?.state,
        progress: payload.stats?.progressPercentage,
      });
      nextUri = payload.nextUri;
    }
  } catch (err) {
    // Abort / timeout: tell the coordinator to kill it, don't leave it burning DWH.
    if (nextUri) fetch(nextUri, { method: "DELETE", headers }).catch(() => {});
    throw err;
  }
  if (payload.error) throw new Error(payload.error.message || "Trino query failed");
  const names = columns.map((c) => c.name);
  return data.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

// ─── Redash executor ─────────────────────────────────────────────────────────

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason || new Error("aborted"));
      },
      { once: true }
    );
  });

/**
 * Run one SQL on a Redash instance chosen by an env pair (URL + key always read from
 * the same pair). Used by Product Wise for sources outside the morning-dashboard config.
 */
export function runRedashWithEnv(urlVar, keyVar, dataSourceId, sql, { signal, timeoutMs = 15 * 60 * 1000 } = {}) {
  const env = { url: String(process.env[urlVar] || "").trim().replace(/\/+$/, ""), key: process.env[keyVar] || "" };
  if (!env.url || !env.key) return Promise.reject(new Error(`Redash not configured (set ${urlVar} + ${keyVar} in .env)`));
  return runRedashOnce(env, dataSourceId, sql, { signal, timeoutMs });
}

export async function runRedashOnce(env, dataSourceId, sql, { signal, timeoutMs }) {
  if (!env.url || !env.key) throw new Error("Redash not configured (set PTYES_REDASH_URL + PTYES_REDASH_API_KEY in .env)");
  const headers = { Authorization: `Key ${env.key}`, "Content-Type": "application/json" };
  const deadline = Date.now() + timeoutMs;
  let res = await fetch(`${env.url}/api/query_results`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data_source_id: dataSourceId, query: sql, max_age: 0 }),
    signal,
  });
  let payload = await readJson(res);
  if (!res.ok) throw new Error(payload.message || payload.error?.message || `Redash HTTP ${res.status}`);
  if (process.env.MDASH_DEBUG) console.log("[mdash:redash]", dataSourceId, JSON.stringify(payload).slice(0, 200), sql.slice(0, 120).replace(/\s+/g, " "));
  let resultId = payload.query_result?.id;
  let direct = payload.query_result;
  const jobId = payload.job?.id;
  try {
    while (!direct && !resultId) {
      if (Date.now() > deadline) throw new Error(`Redash query exceeded ${Math.round(timeoutMs / 1000)}s timeout`);
      await sleep(1500, signal);
      res = await fetch(`${env.url}/api/jobs/${jobId}`, { headers, signal });
      payload = await readJson(res);
      const job = payload.job || {};
      if (process.env.MDASH_DEBUG) console.log("[mdash:redash] job", jobId, job.status, job.error || "");
      if (job.status === 3) resultId = job.query_result_id;
      else if (job.status === 4) throw new Error(job.error || "Redash job failed");
      else if (job.status === 5) throw new Error("Redash job cancelled");
    }
  } catch (err) {
    if (jobId) fetch(`${env.url}/api/jobs/${jobId}`, { method: "DELETE", headers }).catch(() => {});
    throw err;
  }
  if (!direct) {
    res = await fetch(`${env.url}/api/query_results/${resultId}`, { headers, signal });
    payload = await readJson(res);
    if (!res.ok) throw new Error(`Redash result fetch HTTP ${res.status}`);
    direct = payload.query_result;
  }
  return direct?.data?.rows || [];
}
