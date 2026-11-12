// Ask TSP / TPAP logs — plain-English questions over Kibana, answered by an LLM that queries the
// logs itself (counts, top values, trends, sample lines) through a small tool set, then explains.
//
// LLM engine: the local Claude Code CLI by default (claude -p, the logged-in user's Claude — no API
// key), falling back to this backend's own /api/generate (Connector Settings routing, same as the
// PRD / BRD / UAT agents). Override with KIBANA_ASK_ENGINE=claude-cli|app or per request `engine`.
// Tool calls use a provider-neutral JSON protocol (one JSON object per model turn), so any
// text model works — no native tool-use API needed.
//
// Routes:
//   GET  /api/kibana/ask/meta?side=tsp|tpap → log window (oldest → newest day), index families
//   POST /api/kibana/ask  { side, question, history: [{ q, a }], llm } → SSE:
//        status {message} · step {i, tool, args, why, summary, ms, error?} · answer {text, provider, model, steps}
//        · error {message}

import { SIDES, INDEX_RE, kibanaEs, serviceOf } from "./kibanaLogs.js";
import { claudeCliModel, claudeCliPath, openClaudeSession } from "./claudeCli.js";

const MAX_STEPS = 10;
const RESULT_CHARS = 5000;
const META_TTL_MS = 30 * 60 * 1000;
const TIME_RE = /^(now(-\d{1,4}[mhd])?(\/[mhd])?|\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?(Z|[+-]\d{2}:?\d{2})?)$/;
const INTERVAL_RE = /^\d{1,3}[mhd]$/;
// Friendly names for aggregatable fields (all text fields carry a .keyword sub-field, ≤256 chars).
const FIELD_ALIAS = {
  service: "_index",
  index: "_index",
  level: "log.level.keyword",
  logger: "log.loggerName.keyword",
  host: "host.name.keyword",
  pod: "host.name.keyword",
  url: "contextMap.url.keyword",
  message: "log.message.keyword",
  thread: "log.thread.keyword",
};

// ─── Log window + index families (per side, cached) ──────────────────────────

const metaCache = {};
async function sideMeta(side) {
  const c = metaCache[side.id];
  if (c && Date.now() - c.at < META_TTL_MS) return c.data;
  const rows = await kibanaEs(side, `_cat/indices/${side.allIndices}?format=json&h=index,docs.count`, null, undefined, "GET");
  const fam = new Map();
  const days = new Set();
  for (const r of rows || []) {
    const m = String(r.index).match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (!m) continue;
    days.add(`${m[1]}-${m[2]}-${m[3]}`);
    const f = serviceOf(r.index);
    const e = fam.get(f) || { family: f, docs: 0, days: 0 };
    e.docs += Number(r["docs.count"]) || 0;
    e.days += 1;
    fam.set(f, e);
  }
  const sorted = [...days].sort();
  const data = {
    side: side.id,
    label: side.label,
    from: sorted[0] || null,
    to: sorted[sorted.length - 1] || null,
    families: [...fam.values()].sort((a, b) => b.docs - a.docs),
  };
  metaCache[side.id] = { at: Date.now(), data };
  return data;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

function baseQuery(args, side) {
  const from = String(args.from || "now-24h").trim();
  const to = String(args.to || "now").trim();
  if (!TIME_RE.test(from) || !TIME_RE.test(to)) throw new Error(`from/to must be like now-24h, now or an ISO date (got ${from} / ${to})`);
  const index = String(args.index || side.allIndices)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = index.filter((s) => !INDEX_RE.test(s));
  if (bad.length || !index.length) throw new Error(`Not a valid index pattern: ${bad[0] || "(empty)"}`);
  const q = String(args.query ?? "").trim();
  const filter = [{ range: { "@timestamp": { gte: from, lte: to } } }];
  if (q && q !== "*") filter.push({ query_string: { query: q.slice(0, 1000), default_field: "log.message", lenient: true, allow_leading_wildcard: false, analyze_wildcard: true } });
  return { index: index.join(","), from, to, q: q || "*", query: { bool: { filter } } };
}

const esPath = (index) => `${index}/_search?ignore_unavailable=true&allow_no_indices=true`;
const resolveField = (f) => {
  const s = String(f || "").trim();
  if (!s) throw new Error("field is required");
  if (FIELD_ALIAS[s.toLowerCase()]) return FIELD_ALIAS[s.toLowerCase()];
  if (!/^[A-Za-z0-9_.@-]{1,80}$/.test(s)) throw new Error(`Not a valid field: ${s}`);
  return s === "_index" || s.endsWith(".keyword") ? s : `${s}.keyword`;
};
const byServiceAgg = { terms: { field: "_index", size: 300 } };
const foldServices = (buckets, top = 15) => {
  const m = {};
  for (const b of buckets || []) m[serviceOf(b.key)] = (m[serviceOf(b.key)] || 0) + b.doc_count;
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([service, count]) => ({ service, count }));
};
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

const TOOLS = {
  async list_services(side) {
    const m = await sideMeta(side);
    return { window: `${m.from} → ${m.to}`, services: m.families.slice(0, 80).map((f) => `${f.family}-* (${f.docs} docs)`) };
  },

  async count(side, args, signal) {
    const b = baseQuery(args, side);
    const d = await kibanaEs(side, esPath(b.index), { size: 0, track_total_hits: true, timeout: "90s", query: b.query, aggs: { svc: byServiceAgg } }, signal);
    return { query: b.q, index: b.index, from: b.from, to: b.to, total: d.hits?.total?.value ?? 0, byService: foldServices(d.aggregations?.svc?.buckets), timedOut: !!d.timed_out };
  },

  async top_values(side, args, signal) {
    const b = baseQuery(args, side);
    const field = resolveField(args.field);
    const size = Math.min(Math.max(Number(args.size) || 10, 1), 30);
    const d = await kibanaEs(side, esPath(b.index), { size: 0, track_total_hits: true, timeout: "90s", query: b.query, aggs: { top: { terms: { field, size: field === "_index" ? 300 : size } } } }, signal);
    const buckets = d.aggregations?.top?.buckets || [];
    const values = field === "_index" ? foldServices(buckets, size).map((x) => ({ value: x.service, count: x.count })) : buckets.map((x) => ({ value: clip(String(x.key), 300), count: x.doc_count }));
    const covered = buckets.reduce((s, x) => s + x.doc_count, 0) + (d.aggregations?.top?.sum_other_doc_count || 0);
    return { query: b.q, field, from: b.from, to: b.to, total: d.hits?.total?.value ?? 0, values, note: covered < (d.hits?.total?.value ?? 0) ? "some matching lines lack this field (or exceed 256 chars for message)" : undefined };
  },

  async trend(side, args, signal) {
    const b = baseQuery(args, side);
    const interval = INTERVAL_RE.test(String(args.interval || "")) ? args.interval : "1h";
    const split = String(args.split_by || "").toLowerCase();
    const aggs = { t: { date_histogram: { field: "@timestamp", fixed_interval: interval, time_zone: "Asia/Kolkata", min_doc_count: 0 } } };
    if (split) aggs.t.aggs = { s: { terms: { field: resolveField(split), size: split === "service" ? 50 : 5 } } };
    const d = await kibanaEs(side, esPath(b.index), { size: 0, track_total_hits: true, timeout: "90s", query: b.query, aggs }, signal);
    let buckets = (d.aggregations?.t?.buckets || []).map((x) => {
      const row = { t: x.key_as_string?.slice(0, 16).replace("T", " "), count: x.doc_count };
      if (split) {
        const parts = split === "service" ? foldServices(x.s?.buckets, 5).map((y) => [y.service, y.count]) : (x.s?.buckets || []).map((y) => [clip(String(y.key), 80), y.doc_count]);
        if (parts.length) row.split = Object.fromEntries(parts);
      }
      return row;
    });
    const dropped = buckets.length > 120 ? buckets.length - 120 : 0;
    if (dropped) buckets = buckets.slice(-120);
    return { query: b.q, interval, from: b.from, to: b.to, timezone: "IST", total: d.hits?.total?.value ?? 0, buckets, note: dropped ? `oldest ${dropped} buckets omitted — use a coarser interval` : undefined };
  },

  async sample(side, args, signal) {
    const b = baseQuery(args, side);
    const size = Math.min(Math.max(Number(args.size) || 5, 1), 20);
    const order = args.order === "asc" ? "asc" : "desc";
    const d = await kibanaEs(
      side,
      esPath(b.index),
      { size, track_total_hits: true, timeout: "90s", sort: [{ "@timestamp": order }], _source: ["@timestamp", "log.message", "message", "log.level", "fields.type", "contextMap.seq-no"], query: b.query },
      signal
    );
    return {
      query: b.q,
      from: b.from,
      to: b.to,
      total: d.hits?.total?.value ?? 0,
      lines: (d.hits?.hits || []).map((h) => {
        const s = h._source || {};
        return { ts: s["@timestamp"], service: s.fields?.type || serviceOf(h._index), level: s.log?.level, seqNo: s.contextMap?.["seq-no"], message: clip(String(s.log?.message ?? s.message ?? ""), 600) };
      }),
    };
  },
};

const summarize = (tool, r) => {
  if (tool === "list_services") return `${r.services.length} services · ${r.window}`;
  if (tool === "count") return `${r.total.toLocaleString("en-IN")} lines${r.byService[0] ? ` · top ${r.byService[0].service}` : ""}`;
  if (tool === "top_values") return `${r.values.length} values of ${r.field} over ${r.total.toLocaleString("en-IN")} lines`;
  if (tool === "trend") return `${r.buckets.length} × ${r.interval} buckets · ${r.total.toLocaleString("en-IN")} lines`;
  if (tool === "sample") return `${r.lines.length} of ${r.total.toLocaleString("en-IN")} lines`;
  return "";
};

// ─── Prompt ─────────────────────────────────────────────────────────────────

function systemPrompt(side, meta) {
  const nowIst = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  const fams = meta.families.map((f) => f.family).join(", ");
  return `You answer questions about the ${side.label} production logs (${side.label === "TSP" ? "Paytm UPI switch on Yes Bank / PTYBL — the TSP side" : "Paytm UPI TPAP app side — PSP gateways, PMS, BFF, proxy"}) by querying Kibana (Elasticsearch ${side.host}) with tools, then explaining the result to a payments product manager.

Now: ${nowIst} IST. Logs available: ${meta.from} → ${meta.to} (daily indices, ~3 days retention). Never claim anything outside this window.

INDEX FAMILIES (each is <family>-YYYY.MM.DD; query with <family>-* or a wildcard; default is all: ${side.allIndices}):
${fams}
Suffix _access = HTTP access logs, _exchange = request/response payload logs, no suffix = application logs.

DOCUMENT FIELDS: @timestamp, log.message (the log line, full-text), log.level (INFO/WARN/ERROR), log.loggerName (Java class), fields.type (service), host.name (pod), contextMap.seq-no (txn / request id), contextMap.url. NPCI XML messages appear inside log.message (e.g. ReqPay, RespPay, ReqMandate, errCode="U30", result="FAILURE").

TOOLS (args in JSON; "query" is Lucene query_string over log.message — phrases in double quotes, AND/OR/NOT, field:value e.g. log.level:ERROR, fields.type:x; "*" = everything; from/to like "now-24h", "now-3d", "now" or ISO; "index" optional comma-separated patterns):
- list_services {} → index families with doc counts
- count {query, index?, from?, to?} → total matching lines + split by service
- top_values {query, field, index?, from?, to?, size?} → most common values. field: service | level | logger | host | url | message (exact short messages ≤256 chars) | any field path (.keyword added)
- trend {query, interval ("15m","1h","1d"), split_by? (service|level|logger|host), index?, from?, to?} → time buckets in IST
- sample {query, size (≤20), order ("desc" newest | "asc" oldest), index?, from?, to?} → example log lines

PROTOCOL — reply with EXACTLY ONE JSON object and nothing else, either:
{"action":"tool","tool":"<name>","args":{...},"why":"<one short line>"}
or, when you have enough evidence:
{"action":"answer","text":"<markdown answer>"}

RULES:
- Always ground the answer in tool results from this conversation — never guess counts. At most ${MAX_STEPS} tool calls per question; prefer one targeted aggregation over many samples.
- Narrow with index patterns when the question names a service (switch, PMS, proxy, mandate…); all indices over long windows can be slow.
- If a count is 0, say so plainly and suggest where else it may appear (other side: ${side.id === "tsp" ? "TPAP" : "TSP"}, other service, other wording) — try one reasonable variant first.
- Answer format: lead with the direct answer in one bold sentence (the number / the finding). Then short bullet points with the key numbers, services, time pattern and 1–3 example lines or txn ids as \`code\`. Mention the query and window you used in one final line. No markdown tables, no headings above level 3. Keep it under 250 words.
- Times you report are IST.`;
}

// ─── Model turn parsing ─────────────────────────────────────────────────────

/** First balanced {...} JSON object in the model's text (fences / prose around it tolerated). */
export function parseModelTurn(text) {
  const s = String(text || "").trim();
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1));
          if (o && (o.action === "tool" || o.action === "answer")) return o;
        } catch {
          /* try next brace */
        }
        break;
      }
    }
  }
  // No protocol object — treat the whole reply as the answer.
  return { action: "answer", text: s };
}

async function callLlm({ system, messages, llm, signal }) {
  const port = process.env.PORT || 5000;
  const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, agent: "kibana-ask", max_tokens: 1800, skipRag: true, ...llm }),
    signal,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.success === false) throw new Error(`LLM: ${d.message || d.error || `HTTP ${res.status}`}`);
  const blocks = (d.data ?? d)?.content;
  const text = Array.isArray(blocks) ? blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n") : String(blocks || "");
  if (!text.trim()) throw new Error("LLM returned an empty reply");
  return { text, provider: d.llmProvider || null, model: d.llmModel || null };
}

const llmRouting = (llm) => {
  const src = llm && typeof llm === "object" ? llm : {};
  const out = {};
  if (src.llmProvider) out.llmProvider = String(src.llmProvider).toLowerCase();
  for (const k of ["llmDisabled", "foundryModelsEnabled"]) if (src[k] && typeof src[k] === "object") out[k] = src[k];
  if (src.bedrockModelTier) out.bedrockModelTier = src.bedrockModelTier;
  if (src.openaiModel) out.openaiModel = src.openaiModel;
  return out;
};

// ─── LLM sessions ───────────────────────────────────────────────────────────
// A session takes one user turn at a time and remembers the conversation itself.
//   claude-cli: local Claude Code CLI (whoever is logged in on this machine) — one process per question
//   app:        this backend's /api/generate (Connector Settings routing, like PRD / BRD / UAT)

function appSession({ system, history, llm, signal }) {
  const messages = [];
  for (const t of history) {
    messages.push({ role: "user", content: t.q });
    messages.push({ role: "assistant", content: JSON.stringify({ action: "answer", text: t.a }) });
  }
  return {
    engine: "app",
    async send(text) {
      messages.push({ role: "user", content: text });
      const r = await callLlm({ system, messages, llm: llmRouting(llm), signal });
      messages.push({ role: "assistant", content: r.text });
      return r;
    },
    close() {},
  };
}

function cliSession({ system, history, signal }) {
  const s = openClaudeSession({ system, signal });
  let first = true;
  return {
    engine: "claude-cli",
    async send(text) {
      // Earlier turns of this conversation ride along in the first message of the new CLI session.
      let msg = text;
      if (first && history.length) {
        const prior = history.map((t) => `USER: ${t.q}\nYOU (answer): ${t.a}`).join("\n\n");
        msg = `Earlier in this conversation:\n\n${prior}\n\n---\nNew question: ${text}`;
      }
      first = false;
      const r = await s.send(msg);
      return { text: r.text, provider: "claude-cli", model: r.model };
    },
    close: () => s.close(),
  };
}

/** Which engine answers: request → KIBANA_ASK_ENGINE → claude-cli when the CLI is installed, else app. */
export function pickEngine(requested) {
  const want = String(requested || process.env.KIBANA_ASK_ENGINE || "auto").toLowerCase();
  if (want === "app") return "app";
  if (want === "claude-cli") return "claude-cli";
  return claudeCliPath() ? "claude-cli" : "app";
}

/**
 * Run one question. `emit(event, data)` streams progress. `makeSession` is injectable for tests.
 * history: earlier turns [{ q, a }] of this conversation (answers only — tool output is not replayed).
 */
export async function askKibana({ side: sideId, question, history = [], llm, engine }, emit, signal, makeSession) {
  const side = SIDES[sideId];
  if (!side) throw new Error("side must be tsp or tpap");
  const q = String(question || "").trim();
  if (!q) throw new Error("Ask a question");
  emit("status", { message: `Reading ${side.label} log window…` });
  const meta = await sideMeta(side);
  const system = systemPrompt(side, meta);
  const hist = (Array.isArray(history) ? history : [])
    .filter((t) => t?.q && t?.a)
    .slice(-6)
    .map((t) => ({ q: String(t.q).slice(0, 2000), a: String(t.a).slice(0, 4000) }));

  const chosen = pickEngine(engine);
  const open = makeSession || ((eng) => (eng === "claude-cli" ? cliSession({ system, history: hist, signal }) : appSession({ system, history: hist, llm, signal })));
  let session = open(chosen);
  let next = q.slice(0, 4000);
  const steps = [];
  let used = { provider: null, model: null, engine: session.engine };
  try {
    for (let i = 0; i <= MAX_STEPS; i++) {
      if (signal?.aborted) throw new Error("Stopped");
      emit("status", { message: i ? `Reading results (step ${i})…` : `Planning the query (${session.engine === "claude-cli" ? "Claude CLI" : "app LLM"})…` });
      let reply;
      try {
        reply = await session.send(next);
      } catch (e) {
        // Claude CLI missing / not logged in on the very first turn → fall back to the app's LLM routing.
        if (i === 0 && session.engine === "claude-cli" && !makeSession && !signal?.aborted && !engine) {
          emit("status", { message: `Claude CLI unavailable (${e.message}) — using app LLM routing…` });
          session.close();
          session = appSession({ system, history: hist, llm, signal });
          reply = await session.send(next);
        } else throw e;
      }
      used = { provider: reply.provider, model: reply.model, engine: session.engine };
      const turn = parseModelTurn(reply.text);
      if (turn.action === "answer" || i === MAX_STEPS) {
        const text = turn.action === "answer" ? String(turn.text || "").trim() : "I hit the step limit before reaching a conclusion — try a narrower question (one service or a shorter window).";
        emit("answer", { text, ...used, steps: steps.length });
        return { text, steps, ...used };
      }
      const tool = String(turn.tool || "");
      const args = turn.args && typeof turn.args === "object" ? turn.args : {};
      const step = { i: steps.length + 1, tool, args, why: turn.why ? String(turn.why).slice(0, 200) : "" };
      emit("step", { ...step, running: true });
      const t0 = Date.now();
      let result;
      try {
        if (!TOOLS[tool]) throw new Error(`Unknown tool "${tool}". Use one of: ${Object.keys(TOOLS).join(", ")}`);
        result = await TOOLS[tool](side, args, signal);
        step.summary = summarize(tool, result);
      } catch (e) {
        if (signal?.aborted) throw new Error("Stopped");
        result = { error: e.message };
        step.error = e.message;
      }
      step.ms = Date.now() - t0;
      steps.push(step);
      emit("step", step);
      let body = JSON.stringify(result);
      if (body.length > RESULT_CHARS) body = `${body.slice(0, RESULT_CHARS)}… (truncated)`;
      next = `TOOL RESULT (${tool}, ${step.ms} ms): ${body}\n\nReply with the next JSON object (another tool call, or the answer).`;
    }
  } finally {
    session.close();
  }
  throw new Error("unreachable");
}

export function registerKibanaAsk(app) {
  app.get("/api/kibana/ask/meta", async (req, res) => {
    try {
      const side = SIDES[req.query.side];
      if (!side) throw new Error("side must be tsp or tpap");
      const m = await sideMeta(side);
      res.json({ side: m.side, label: m.label, from: m.from, to: m.to, services: m.families.length, engine: pickEngine(), cliModel: claudeCliPath() ? claudeCliModel() : null });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/kibana/ask", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const emit = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const t0 = Date.now();
    try {
      const out = await askKibana(req.body || {}, emit, controller.signal);
      console.log(`[kibana-ask] ${req.body?.side} ${out.steps.length} steps ${Date.now() - t0}ms via ${out.engine}/${out.model || out.provider || "?"}`);
    } catch (e) {
      emit("error", { message: e.message });
    } finally {
      res.end();
    }
  });
}
