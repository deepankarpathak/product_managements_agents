// Kibana Logs — search TSP / TPAP Kibana for a txn identifier (no LLM).
//
// Both Kibanas are reachable over VPN without auth; queries go through Kibana's console proxy
// (POST /api/console/proxy?path=<index>/_search) as Elasticsearch DSL. Identifiers are matched as
// phrases (multi_match, type=phrase) so a value like abc@ptyes or a 35-char txn id matches exactly.
//
// Routes:
//   GET  /api/kibana/meta    → sides (TSP / TPAP), service presets, reachability + version
//   POST /api/kibana/search  { side, by, values, index, allIndices, range | from+to, extra, size,
//                              order, allFields } → total, per-service counts, log lines, Discover link

export const SIDES = {
  tsp: {
    id: "tsp",
    label: "TSP",
    host: "kibana.paytmybl.com",
    url: (process.env.KIBANA_TSP_URL || "https://kibana.paytmybl.com").replace(/\/+$/, ""),
    allIndices: "prod-paytmybl-*",
    presets: [
      { label: "Switch", index: "prod-paytmybl-tsp-switchc*" },
      { label: "Switch exchange", index: "prod-paytmybl-tsp-switchc*_exchange-*" },
      { label: "Router", index: "prod-paytmybl-tsp-router-*" },
      { label: "PMS", index: "prod-paytmybl-tsp-pms-*" },
      { label: "Txn BFF", index: "prod-paytmybl-transactional-bff-*" },
      { label: "Transactional UAP", index: "prod-paytmybl-tsp-transactional-uap-*" },
      { label: "Consumers", index: "prod-paytmybl-tsp-consumersc*" },
      { label: "Jobs", index: "prod-paytmybl-tsp-jobsc*" },
      { label: "Mandate", index: "prod-paytmybl-mandate-*" },
      { label: "Refund", index: "prod-paytmybl-tsp-refund*" },
      { label: "Recon", index: "prod-paytmybl-tsp-recon-*,prod-paytmybl-tsp-stream-recon-*,prod-paytmybl-tsp-transactional-recon-*" },
      { label: "Compliance", index: "prod-paytmybl-tsp-compliance-*" },
      { label: "HSM", index: "prod-paytmybl-tsp-hsm-read-*" },
      { label: "Onboarding", index: "prod-paytmybl-tsp-onboarding-*" },
    ],
  },
  tpap: {
    id: "tpap",
    label: "TPAP",
    host: "tpapprod-logging-elk.paytm.com",
    url: (process.env.KIBANA_TPAP_URL || "https://tpapprod-logging-elk.paytm.com").replace(/\/+$/, ""),
    allIndices: "prod-*",
    presets: [
      { label: "Switch", index: "prod-tpap-switch-*" },
      { label: "Transactional switch", index: "prod-tpap-transactional-switch-*" },
      { label: "PMS", index: "prod-tpap-pms-*" },
      { label: "Proxy", index: "prod-tpap-proxy-*" },
      { label: "Txn BFF", index: "prod-tpap-transactional-bff-*,prod-tpap-txn-bff-aggregator-*" },
      { label: "GWTS OCIL (Yes)", index: "prod-tpap-gwts-ocil-*,prod-mandate-tpap-gwts-ocil-switch-yes-*" },
      { label: "GWTS Juspay (Axis)", index: "prod-tpap-gwts-juspay-axis-pms-*,prod-tpap_gwts_juspay-axis-*" },
      { label: "GWTS Mindgate (SBI/HDFC)", index: "prod-tpap_gwts_mindgate-*" },
      { label: "Mandate jobs", index: "prod-tpap-mandate-jobs-*" },
      { label: "Consumers mandate", index: "prod-tpap-consumers-mandate-*" },
      { label: "Consumers", index: "prod-tpap-transactional-consumers-*,prod-tpap-consumers-set1-switch-*" },
      { label: "HSS", index: "prod-tpap-hss-*" },
      { label: "Stream recon", index: "prod-tpap-stream-recon-*" },
      { label: "Compliance", index: "prod-tpap-compliance-*" },
      { label: "UPI gateway", index: "prod-upi-t-gateway-*" },
    ],
  },
};

const ID_TYPES = {
  txn: { label: "Txn ID / UMN / RRN" },
  customer: { label: "Customer ID" },
  mobile: { label: "Mobile No" },
  payer: { label: "Payer VPA" },
  payee: { label: "Payee VPA" },
  mid: { label: "PG MID" },
};

const RANGES = { "15m": 15, "1h": 60, "4h": 240, "12h": 720, "24h": 1440, "3d": 4320, "7d": 10080 };
const SIZES = [50, 100, 200, 500, 1000];
const MAX_VALUES = 20;
const REQ_TIMEOUT_MS = 120_000;
// Identifiers: txn ids (PTM… / PAYTM…), 12-digit RRNs, UMNs (x@psp), customer ids, VPAs, MIDs.
const VALUE_RE = /^[A-Za-z0-9@._:\-]{3,128}$/;
// Index patterns only — no system (.) or exclusion (-) patterns, no path tricks.
export const INDEX_RE = /^[a-z0-9*][a-z0-9*_.\-]{0,120}$/;
// Text fields the identifier is matched in by default (lenient: missing fields are ignored).
const DEFAULT_FIELDS = ["log.message", "message", "contextMap.*"];

export async function kibanaEs(side, path, body, signal, method = "POST") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQ_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${side.url}/api/console/proxy?path=${encodeURIComponent(path)}&method=${method}`, {
      method: "POST",
      headers: { "kbn-xsrf": "true", "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok || data.error) {
      const reason = data?.error?.root_cause?.[0]?.reason || data?.error?.reason || data?.message || (typeof data.error === "string" ? data.error : "") || `HTTP ${res.status}`;
      throw new Error(`${side.label} Kibana: ${reason}`);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(signal?.aborted ? "Search cancelled" : `${side.label} Kibana timed out after ${REQ_TIMEOUT_MS / 1000}s — narrow the time range or service`);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(e.message)) throw new Error(`${side.label} Kibana (${side.host}) not reachable — are you on VPN?`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Identifier values → phrases to match. Mobile numbers are searched with and without the 91 prefix. */
function expandValues(by, values) {
  if (by === "mobile") {
    return values.flatMap((v) => {
      const d = v.replace(/\D/g, "");
      const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
      if (!/^[6-9]\d{9}$/.test(ten)) throw new Error(`Not a valid mobile number: ${v}`);
      return [ten, `91${ten}`];
    });
  }
  const bad = values.filter((v) => !VALUE_RE.test(v));
  if (bad.length) throw new Error(`Not a valid ${ID_TYPES[by].label}: ${bad.slice(0, 3).join(", ")}`);
  if ((by === "payer" || by === "payee") && values.some((v) => !v.includes("@"))) throw new Error("A VPA must contain @ (e.g. name@ptyes)");
  return values;
}

/** Which side of the txn a VPA sits on in this log line (XML Payer/Payee addr, JSON payerVpa…). */
function vpaRole(message, vpas) {
  if (!message || !vpas.length) return null;
  const m = String(message);
  const roles = new Set();
  for (const v of vpas) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`<(?:\\w+:)?Payer\\b[^>]*addr=["']${esc}["']|payer_?(?:vpa|va|addr(?:ess)?)["']?\\s*[:=]\\s*["']?${esc}`, "i").test(m)) roles.add("payer");
    if (new RegExp(`<(?:\\w+:)?Payee\\b[^>]*addr=["']${esc}["']|payee_?(?:vpa|va|addr(?:ess)?)["']?\\s*[:=]\\s*["']?${esc}`, "i").test(m)) roles.add("payee");
  }
  return roles.size ? [...roles] : null;
}

/** Strip the date suffix so index names group by service (prod-tpap-pms-2026.11.11 → prod-tpap-pms). */
export const serviceOf = (index) => String(index || "").replace(/^\.ds-/, "").replace(/-?\d{4}\.\d{2}\.\d{2}(-\d+)?$/, "");

// Rison (Kibana URL state) string literal.
const rison = (s) => `'${String(s).replace(/!/g, "!!").replace(/'/g, "!'")}'`;

const dataViewCache = {};
async function dataViews(side) {
  const c = dataViewCache[side.id];
  if (c && Date.now() - c.at < 60 * 60 * 1000) return c.list;
  try {
    const res = await fetch(`${side.url}/api/saved_objects/_find?type=index-pattern&per_page=500&fields=title`, { signal: AbortSignal.timeout(15_000) });
    const d = await res.json();
    const list = (d.saved_objects || []).map((o) => ({ id: o.id, title: o.attributes?.title }));
    dataViewCache[side.id] = { at: Date.now(), list };
    return list;
  } catch {
    return c?.list || [];
  }
}

async function discoverUrl(side, index, phrases, fromIso, toIso, extra) {
  const views = await dataViews(side);
  const want = index.split(",").map((s) => s.trim()).sort().join(",");
  const view = views.find((v) => v.title && v.title.split(",").map((s) => s.trim()).sort().join(",") === want);
  const kql = [phrases.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(" or "), extra ? `(${extra})` : ""].filter(Boolean).join(" and ");
  const g = `(time:(from:${rison(fromIso)},to:${rison(toIso)}))`;
  const a = `(${view ? `index:${rison(view.id)},` : ""}query:(language:kuery,query:${rison(kql)}))`;
  return { url: `${side.url}/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`, dataView: view?.title || null };
}

export async function searchKibana(params, signal) {
  const side = SIDES[params.side];
  if (!side) throw new Error("side must be tsp or tpap");
  const by = ID_TYPES[params.by] ? params.by : "txn";
  // Mobile numbers may be typed with spaces (+91 98765 43210), so only newline / comma / ; separate them.
  const sep = by === "mobile" ? /[\n,;]+/ : /[\s,;]+/;
  const raw = Array.isArray(params.values) ? params.values : String(params.values || "").split(sep);
  const values = [...new Set(raw.map((v) => String(v).trim().replace(/^['"]|['"]$/g, "")).filter(Boolean))];
  if (!values.length) throw new Error(`Enter at least one ${ID_TYPES[by].label}`);
  if (values.length > MAX_VALUES) throw new Error(`Up to ${MAX_VALUES} values per search`);
  const phrases = expandValues(by, values);

  const index = params.allIndices
    ? side.allIndices
    : String(params.index || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(",");
  if (!index) throw new Error("Pick a service (index pattern) or tick all indices");
  const badIdx = index.split(",").filter((s) => !INDEX_RE.test(s));
  if (badIdx.length) throw new Error(`Not a valid index pattern: ${badIdx[0]}`);

  let fromIso;
  let toIso;
  if (params.from || params.to) {
    const f = new Date(params.from);
    const t = params.to ? new Date(params.to) : new Date();
    if (Number.isNaN(+f) || Number.isNaN(+t) || f >= t) throw new Error("Custom range: pick a valid from / to");
    fromIso = f.toISOString();
    toIso = t.toISOString();
  } else {
    const mins = RANGES[params.range] || RANGES["24h"];
    toIso = new Date().toISOString();
    fromIso = new Date(Date.now() - mins * 60_000).toISOString();
  }
  const size = SIZES.includes(Number(params.size)) ? Number(params.size) : 200;
  const order = params.order === "desc" ? "desc" : "asc";
  const extra = String(params.extra || "").trim().slice(0, 500);
  const fields = params.allFields ? ["*"] : DEFAULT_FIELDS;

  const filter = [
    { range: { "@timestamp": { gte: fromIso, lte: toIso, format: "strict_date_optional_time" } } },
    { bool: { minimum_should_match: 1, should: phrases.map((p) => ({ multi_match: { query: p, type: "phrase", fields, lenient: true } })) } },
  ];
  if (extra) filter.push({ query_string: { query: extra, default_field: "log.message", lenient: true, allow_leading_wildcard: false, analyze_wildcard: true } });

  const body = {
    size,
    track_total_hits: true,
    timeout: "90s",
    sort: [{ "@timestamp": { order, unmapped_type: "date" } }],
    _source: { excludes: ["agent", "ecs", "input", "log.offset", "kubernetes.labels"] },
    query: { bool: { filter } },
    aggs: {
      byIndex: { terms: { field: "_index", size: 200 } },
      first: { min: { field: "@timestamp" } },
      last: { max: { field: "@timestamp" } },
    },
  };

  const startedAt = Date.now();
  const [d, discover] = await Promise.all([
    kibanaEs(side, `${index}/_search?ignore_unavailable=true&allow_no_indices=true`, body, signal),
    discoverUrl(side, index, phrases, fromIso, toIso, extra),
  ]);

  const vpas = by === "payer" || by === "payee" ? values : [];
  const hits = (d.hits?.hits || []).map((h) => {
    const s = h._source || {};
    const message = s.log?.message ?? s.message ?? "";
    return {
      id: h._id,
      ts: s["@timestamp"],
      index: h._index,
      service: s.fields?.type || serviceOf(h._index),
      level: s.log?.level || s.level || null,
      logger: s.log?.loggerName || null,
      thread: s.log?.thread || null,
      host: s.host?.name || null,
      seqNo: s.contextMap?.["seq-no"] || null,
      requestId: s.contextMap?.["request-id"] || null,
      url: s.contextMap?.url || s.contextMap?.API_REQUEST_URI || null,
      message: typeof message === "string" ? message : JSON.stringify(message),
      roles: vpaRole(message, vpas),
      source: params.allFields || !message ? s : undefined,
    };
  });

  const svc = {};
  for (const b of d.aggregations?.byIndex?.buckets || []) {
    const k = serviceOf(b.key);
    svc[k] = (svc[k] || 0) + b.doc_count;
  }

  return {
    side: side.id,
    sideLabel: side.label,
    host: side.host,
    by,
    byLabel: ID_TYPES[by].label,
    values,
    phrases,
    index,
    from: fromIso,
    to: toIso,
    size,
    order,
    extra,
    total: d.hits?.total?.value ?? hits.length,
    totalRelation: d.hits?.total?.relation || "eq",
    firstTs: d.aggregations?.first?.value_as_string || null,
    lastTs: d.aggregations?.last?.value_as_string || null,
    byService: Object.entries(svc)
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count),
    timedOut: !!d.timed_out,
    shards: d._shards ? { total: d._shards.total, failed: d._shards.failed } : null,
    tookMs: d.took,
    ms: Date.now() - startedAt,
    discoverUrl: discover.url,
    dataView: discover.dataView,
    hits,
    query: body,
  };
}

async function sideStatus(side) {
  try {
    const res = await fetch(`${side.url}/api/status`, { signal: AbortSignal.timeout(8_000) });
    const d = await res.json();
    const st = d.status?.overall;
    return { ok: res.ok, version: d.version?.number || null, state: st?.level || st?.state || null };
  } catch (e) {
    return { ok: false, error: /fetch failed|abort|timeout/i.test(e.message) ? "not reachable (VPN?)" : e.message };
  }
}

export function registerKibanaLogs(app) {
  const abortOnClose = (res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  app.get("/api/kibana/meta", async (_req, res) => {
    const sides = await Promise.all(
      Object.values(SIDES).map(async (s) => ({ id: s.id, label: s.label, host: s.host, url: s.url, allIndices: s.allIndices, presets: s.presets, status: await sideStatus(s) }))
    );
    res.json({ sides, idTypes: Object.entries(ID_TYPES).map(([id, t]) => ({ id, label: t.label })), ranges: Object.keys(RANGES), sizes: SIZES, maxValues: MAX_VALUES });
  });

  app.post("/api/kibana/search", async (req, res) => {
    try {
      const out = await searchKibana(req.body || {}, abortOnClose(res));
      console.log(`[kibana] ${out.sideLabel} ${out.by} ×${out.values.length} ${out.index} → ${out.total} hits in ${out.ms}ms`);
      res.json(out);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message });
    }
  });
}
