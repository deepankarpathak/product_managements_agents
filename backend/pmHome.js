// PM Console home + Jarvis (ai-tools.finmate.tech) integrations — /api/home/*, /api/jarvis/*
//
// Jarvis agents used here (all proxied server-side so the browser never talks to Jarvis directly):
//   HSS Traffic Distribution  GET  /hss-dashboard?source=tpap_production   (open)
//   SR Dissection             GET  /sr-dissect/v1/{meta,runs,report/<date>.csv}  (open; .html for the full report)
//   Success-Rate Agent        GET  /sr-agent/v1/meta, POST /sr-agent/v1/benchmark  (open, ~2 min per run)
//   Lumina                    GET  /lumina/wiki/summary, POST /lumina/query/stream (SSE)  (open)
//   Txn Lifecycle Tracer      POST /txn-trace/v1/trace  (needs X-RCA-Auth password — passed through from the browser)
//
// Base URL: JARVIS_URL (default https://ai-tools.finmate.tech).
//
// HSS: every fetch is snapshotted once per IST day under data/hss-snapshots/ so the home page can
// flag weight changes vs the previous snapshot.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const JARVIS = () => (process.env.JARVIS_URL || "https://ai-tools.finmate.tech").replace(/\/+$/, "");
const HSS_TTL_MS = 5 * 60 * 1000;
const META_TTL_MS = 10 * 60 * 1000;
const TZ_OFFSET_MIN = 330;

const istDay = (ms = Date.now()) => new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

async function jarvisJson(p, opts = {}) {
  const { timeout = 30000, ...rest } = opts;
  const r = await fetch(`${JARVIS()}${p}`, { signal: AbortSignal.timeout(timeout), ...rest });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((body && (typeof body.detail === "string" ? body.detail : body.error)) || `Jarvis HTTP ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas / newlines, BOM). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...rest] = rows.filter((r) => r.length > 1 || r[0]);
  if (!head) return [];
  const num = /^-?\d+(\.\d+)?$/;
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, num.test(r[i] ?? "") ? Number(r[i]) : r[i] ?? ""])));
}

/** Compact HSS view: global weights + per-route live mix (drops the raw property dump). */
function slimHss(d) {
  return {
    fetchedAt: Date.now(),
    source: d.source,
    psps: d.psps,
    globalWeights: d.globalWeights,
    traffic: (d.traffic || []).map((t) => ({
      id: t.id,
      txnType: t.txnType,
      accountType: t.accountType,
      amount: t.amount,
      live: t.live,
      documented: t.documented,
      status: t.status,
    })),
    features: (d.features || []).map((f) => ({ id: f.id, name: f.name, pipeline: f.pipeline, description: f.description })),
    onus: d.onus,
    driftCount: d.driftCount,
    inSyncCount: d.inSyncCount,
    propertyCount: d.propertyCount,
  };
}

/** Weight changes between two slim snapshots (global + per route). */
function diffHss(prev, cur) {
  if (!prev) return [];
  const out = [];
  for (const p of cur.psps || []) {
    const a = prev.globalWeights?.[p.id]?.value;
    const b = cur.globalWeights?.[p.id]?.value;
    if (a !== b) out.push({ route: "Global", psp: p.label, from: a ?? null, to: b ?? null });
  }
  const before = Object.fromEntries((prev.traffic || []).map((t) => [t.id, t]));
  for (const t of cur.traffic || []) {
    const o = before[t.id];
    if (!o) continue;
    for (const p of cur.psps || []) {
      const a = o.live?.[p.id];
      const b = t.live?.[p.id];
      if (a !== b) out.push({ route: `${t.accountType} · ${t.txnType}`, psp: p.label, from: a ?? null, to: b ?? null });
    }
  }
  return out;
}

export function registerPmHome(app, { dataDir, sources = {} }) {
  const snapDir = path.join(dataDir, "hss-snapshots");
  const srAgentFile = path.join(dataDir, "sragent-last.json");
  fs.mkdirSync(snapDir, { recursive: true });

  const cache = new Map(); // key -> { at, value }
  const cached = async (key, ttl, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    return value;
  };

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status && err.status < 600 ? err.status : 502).json({ error: err.message, detail: err.body?.detail });
    }
  };

  // ── HSS ────────────────────────────────────────────────────────────────────
  const prevSnapshot = (day) => {
    const files = fs.readdirSync(snapDir).filter((f) => f.endsWith(".json") && f.slice(0, 10) < day).sort();
    if (!files.length) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(snapDir, files[files.length - 1]), "utf8"));
    } catch {
      return null;
    }
  };

  const getHss = async (force) => {
    if (force) cache.delete("hss");
    return cached("hss", HSS_TTL_MS, async () => {
      const slim = slimHss(await jarvisJson("/hss-dashboard?source=tpap_production"));
      const day = istDay(slim.fetchedAt);
      const f = path.join(snapDir, `${day}.json`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(slim));
      const prev = prevSnapshot(day);
      return { ...slim, changes: diffHss(prev, slim), comparedTo: prev ? istDay(prev.fetchedAt) : null };
    });
  };
  app.get("/api/jarvis/hss", handle((req) => getHss(req.query.refresh === "1")));

  // ── SR Dissection ──────────────────────────────────────────────────────────
  app.get("/api/jarvis/srdissect/meta", handle(() => cached("sd-meta", META_TTL_MS, () => jarvisJson("/sr-dissect/v1/meta"))));
  app.get("/api/jarvis/srdissect/runs", handle(() => cached("sd-runs", META_TTL_MS, () => jarvisJson("/sr-dissect/v1/runs"))));
  const getDissection = (date) =>
    cached(`sd-report:${date}`, 6 * 3600 * 1000, async () => {
      const r = await fetch(`${JARVIS()}/sr-dissect/v1/report/${date}.csv`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) {
        const err = new Error(r.status === 404 ? "No SR Dissection report for that day" : `Jarvis HTTP ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const rows = parseCsv(await r.text());
      return { date, rows, htmlUrl: `${JARVIS()}/sr-dissect/v1/report/${date}.html` };
    });
  app.get(
    "/api/jarvis/srdissect/report/:date",
    handle((req) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) throw Object.assign(new Error("date must be YYYY-MM-DD"), { status: 400 });
      return getDissection(req.params.date);
    })
  );

  // ── Success-Rate Agent (cross-PSP benchmark) ──────────────────────────────
  app.get("/api/jarvis/sragent/meta", handle(() => cached("sa-meta", META_TTL_MS, () => jarvisJson("/sr-agent/v1/meta"))));
  app.get(
    "/api/jarvis/sragent/last",
    handle(() => {
      try {
        return JSON.parse(fs.readFileSync(srAgentFile, "utf8"));
      } catch {
        return null;
      }
    })
  );
  let benchmarkRun = null;
  app.post(
    "/api/jarvis/sragent/benchmark",
    handle(async (req) => {
      // One run at a time — a second click joins the in-flight run instead of starting another.
      if (!benchmarkRun) {
        const body = { instance: req.body?.instance || "tsp", bank_control: req.body?.bank_control ?? true };
        benchmarkRun = jarvisJson("/sr-agent/v1/benchmark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          timeout: 6 * 60 * 1000,
        })
          .then((result) => {
            const rec = { ranAt: Date.now(), params: body, result };
            fs.writeFileSync(srAgentFile, JSON.stringify(rec));
            return rec;
          })
          .finally(() => {
            benchmarkRun = null;
          });
      }
      return benchmarkRun;
    })
  );

  // ── Lumina (NPCI circulars / team knowledge) ──────────────────────────────
  app.get("/api/jarvis/lumina/summary", handle(() => cached("lumina-summary", META_TTL_MS, () => jarvisJson("/lumina/wiki/summary"))));
  app.post("/api/jarvis/lumina/ask", async (req, res) => {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "question is required" });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const r = await fetch(`${JARVIS()}/lumina/query/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!r.ok) return res.status(502).json({ error: `Lumina HTTP ${r.status}` });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      r.body.on("data", (chunk) => res.write(chunk));
      r.body.on("end", () => res.end());
      r.body.on("error", () => res.end());
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: err.message });
      else res.end();
    }
  });

  // ── Txn Lifecycle Tracer ──────────────────────────────────────────────────
  // Password comes from the browser (X-RCA-Auth, kept in the user's localStorage), never stored here.
  const tracerHeaders = (req) => ({ "X-RCA-Auth": String(req.get("X-RCA-Auth") || "") });
  app.get("/api/jarvis/txn/auth", handle((req) => jarvisJson("/txn-trace/v1/auth/check", { headers: tracerHeaders(req) })));
  app.post(
    "/api/jarvis/txn/trace",
    handle((req) => {
      const identifier = String(req.body?.identifier || "").trim();
      if (!identifier) throw Object.assign(new Error("Transaction id or RRN is required"), { status: 400 });
      return jarvisJson("/txn-trace/v1/trace", {
        method: "POST",
        headers: { ...tracerHeaders(req), "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, date: req.body?.date || undefined, tsp: req.body?.tsp || undefined }),
        timeout: 90000,
      });
    })
  );

  // ── Home summary ──────────────────────────────────────────────────────────
  // Daily overall SR / volume from the Unified SR breakdown cache (kind=bank rows summed per day),
  // plus HSS global mix + changes and the latest SR Dissection top codes. Each block fails independently.
  // Every block reads the other dashboards' caches in-process (sources from server.js) — Today runs no query.
  const srDaily = async () => {
    if (!sources.unified) throw new Error("Unified SR not registered");
    const d = sources.unified.view("breakdown", "tpap", "ALL");
    const byDay = new Map();
    for (const row of d.rows || []) {
      if (row.kind !== "bank") continue;
      const day = String(row.ts).slice(0, 10);
      const a = byDay.get(day) || { day, total: 0, success: 0 };
      a.total += Number(row.total) || 0;
      a.success += Number(row.success) || 0;
      byDay.set(day, a);
    }
    const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((x) => ({ ...x, sr: x.total ? (100 * x.success) / x.total : null }));
    return { ranAt: d.ranAt, days };
  };

  app.get(
    "/api/home/summary",
    handle(async () => {
      const settle = async (fn) => {
        try {
          return { ok: true, data: await fn() };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      };
      const [sr, hss, dissection, srAlerts, srHealth, products, acq, apd, txnBreakup] = await Promise.all([
        settle(srDaily),
        settle(() => getHss(false)),
        settle(async () => {
          const { runs } = await cached("sd-runs", META_TTL_MS, () => jarvisJson("/sr-dissect/v1/runs"));
          const latest = [...(runs || [])].sort().pop();
          if (!latest) return null;
          const rep = await getDissection(latest);
          // Biggest SR costs first, then anything spiking / rising / new further down the list.
          const moving = new Set(["spike", "up", "new"]);
          const top = rep.rows.slice(0, 5);
          const hot = rep.rows.slice(5).filter((r) => moving.has(r.trend)).slice(0, 5);
          return { date: latest, htmlUrl: rep.htmlUrl, top: [...top, ...hot], lostPts: rep.rows.reduce((s, r) => s + (Number(r.sr_points) || 0), 0), hotCount: rep.rows.filter((r) => moving.has(r.trend)).length };
        }),
        settle(() => sources.unified.alerts()),
        settle(() => sources.unified.health()),
        settle(() => sources.product.summary()),
        settle(() => sources.acq.summary()),
        settle(() => sources.apd.summary()),
        settle(() => sources.txnBreakup.summary()),
      ]);
      let srAgent = null;
      try {
        srAgent = JSON.parse(fs.readFileSync(srAgentFile, "utf8"));
      } catch {
        /* never run yet */
      }
      if (hss.ok) hss.data = { globalWeights: hss.data.globalWeights, psps: hss.data.psps, changes: hss.data.changes, comparedTo: hss.data.comparedTo, driftCount: hss.data.driftCount, fetchedAt: hss.data.fetchedAt };
      const sa = srAgent?.result;
      return {
        now: Date.now(),
        sr,
        srAlerts,
        srHealth,
        products,
        acq,
        apd,
        txnBreakup,
        hss,
        dissection,
        srAgent: sa ? { ranAt: srAgent.ranAt, instance: sa.instance, subject: sa.subject, peers: sa.peers, volumes: sa.volumes, actionable: sa.actionable || [] } : null,
      };
    })
  );
}
