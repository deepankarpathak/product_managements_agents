// History — a durable log of every dashboard query run (manual + scheduled), written as
// Markdown for humans plus a JSON sidecar for the History tab.
//
// Layout under rootDir (Query_Agent/AnaylsisAgent_output/history):
//   YYYY-MM-DD/index.jsonl   one line per create/update (last line per id wins) — the
//                            History list reads only these, so listing stays fast
//   YYYY-MM-DD/<id>.md       human-readable record (task, summary, actions, SQL, output)
//   YYYY-MM-DD/<id>.json     same content, structured — loaded only when an item is opened
//
// Statuses: Planned (queued / waiting to retry) → Progress → Done | Stopped | Failed.
//
// Routes (all under /api/history):
//   GET  /list?dashboard=&from=YYYY-MM-DD&to=YYYY-MM-DD   index entries, newest first
//   GET  /item/:id                                        full record + markdown
//   POST /rerun/:id                                       re-run the same query

import fs from "fs";
import path from "path";

const TZ_OFFSET_MIN = 330;
const ID_RE = /^\d{8}-\d{6}-[a-z]+-[a-z0-9]+-[a-z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DASHBOARDS = {
  morning: "Morning Dashboard",
  srsnippet: "Success Rate Snippet",
  product: "Product Wise",
};

const pad2 = (n) => String(n).padStart(2, "0");
/** IST wall-clock parts for an epoch ms. */
function ist(ms) {
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  const day = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return { day, time, stamp: `${day} ${time} IST` };
}

const STATUS_FROM_EVENT = {
  queued: "Planned",
  "retry-wait": "Planned",
  running: "Progress",
  success: "Done",
  cancelled: "Stopped",
  failed: "Failed",
};

// ─── Markdown ────────────────────────────────────────────────────────────────

const mdEscape = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const mdTable = (t) =>
  [`**${t.title}**`, "", `| ${t.columns.map(mdEscape).join(" | ")} |`, `| ${t.columns.map(() => "---").join(" | ")} |`, ...t.rows.map((r) => `| ${r.map(mdEscape).join(" | ")} |`)].join("\n");
const bullets = (arr, empty) => (arr && arr.length ? arr.map((x) => `- ${x}`).join("\n") : `- ${empty}`);

function toMarkdown(rec) {
  const a = rec.analysis || {};
  const lines = [
    `# ${rec.subject}`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Dashboard | ${rec.dashboardName} |`,
    `| Section | ${mdEscape(rec.sectionTitle)} |`,
    `| Status | **${rec.status}** |`,
    `| Trigger | ${rec.trigger === "schedule" ? "Auto (schedule)" : rec.trigger === "retry" ? "Auto (retry)" : "Manual"} |`,
    `| Created | ${ist(rec.createdAt).stamp} |`,
    `| Updated | ${ist(rec.updatedAt).stamp} |`,
    `| Duration / window | ${mdEscape(rec.durationLabel || "—")}${rec.window ? ` · ${rec.window.from} → ${rec.window.to}` : ""} |`,
    `| Engine | ${rec.engine || "—"} |`,
    `| Attempt | ${rec.attempt ?? "—"} |`,
    `| Run time | ${rec.elapsedMs != null ? `${Math.round(rec.elapsedMs / 1000)} s` : "—"} |`,
    `| Rows | ${rec.rowCount ?? "—"} |`,
    `| ID | \`${rec.id}\` |`,
    "",
    `## Task name`,
    rec.taskName || rec.subject,
    "",
    `## Task summary`,
    a.summary || (rec.status === "Done" ? "—" : `Run is ${rec.status.toLowerCase()}.`),
    "",
    `## Action required`,
    bullets(a.actions, rec.status === "Failed" ? `Query failed — see error below; re-run or check connectivity.` : "None."),
    "",
    `## Next steps`,
    bullets(a.nextSteps, rec.status === "Failed" ? "Re-run from the History tab or the dashboard once the source is reachable." : "—"),
    "",
    `## What stands out`,
    bullets(a.standouts, "—"),
    "",
    `## Other details`,
  ];
  if (rec.error) lines.push("", `**Error:** ${mdEscape(rec.error)}`);
  for (const t of a.tables || []) lines.push("", mdTable(t));
  if (rec.sql) lines.push("", "**Query**", "", "```sql", rec.sql, "```");
  lines.push("");
  return lines.join("\n");
}

// ─── Store ───────────────────────────────────────────────────────────────────

export function createHistoryStore({ rootDir }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const live = new Map(); // id → record (kept until a terminal status is written)

  const dayDir = (day) => path.join(rootDir, day);
  const idDay = (id) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;

  function indexLine(rec) {
    const { id, dashboard, dashboardName, section, sectionTitle, subject, status, trigger, createdAt, updatedAt, durationLabel, engine } = rec;
    return JSON.stringify({ id, dashboard, dashboardName, section, sectionTitle, subject, status, trigger, createdAt, updatedAt, durationLabel, engine, summary: rec.analysis?.summary || rec.error || null });
  }

  function persist(rec) {
    const day = idDay(rec.id);
    const dir = dayDir(day);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${rec.id}.md`), toMarkdown(rec));
      fs.writeFileSync(path.join(dir, `${rec.id}.json`), JSON.stringify(rec));
      fs.appendFileSync(path.join(dir, "index.jsonl"), `${indexLine(rec)}\n`);
    } catch (err) {
      console.warn(`[history] could not write ${rec.id}: ${err.message}`);
    }
  }

  /** Start a record. meta: { dashboard, section, sectionTitle, subject, taskName, trigger, durationLabel, rerun } */
  function start(meta, event = "queued") {
    const now = Date.now();
    const { day, time } = ist(now);
    const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    const id = `${day.replace(/-/g, "")}-${time.replace(/:/g, "")}-${meta.dashboard}-${String(meta.section).toLowerCase().replace(/[^a-z0-9]/g, "")}-${rand}`;
    const rec = {
      ...meta,
      id,
      dashboardName: DASHBOARDS[meta.dashboard] || meta.dashboard,
      status: STATUS_FROM_EVENT[event] || "Planned",
      createdAt: now,
      updatedAt: now,
    };
    live.set(id, rec);
    persist(rec);
    return id;
  }

  /** Update a record. patch may carry event (queued|running|retry-wait|success|cancelled|failed). */
  function update(id, { event, ...patch } = {}) {
    if (!id) return;
    const rec = live.get(id) || readRecord(id);
    if (!rec) return;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    if (event) rec.status = STATUS_FROM_EVENT[event] || rec.status;
    persist(rec);
    if (["Done", "Stopped", "Failed"].includes(rec.status)) live.delete(id);
    else live.set(id, rec);
  }

  function readRecord(id) {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dayDir(idDay(id)), `${id}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  function list({ dashboard, from, to }) {
    const out = new Map();
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    for (let t = start; t <= end; t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      let text;
      try {
        text = fs.readFileSync(path.join(dayDir(day), "index.jsonl"), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (!dashboard || dashboard === "all" || e.dashboard === dashboard) out.set(e.id, e);
        } catch {
          /* skip a torn line */
        }
      }
    }
    // A record still "live" in this process is authoritative (e.g. Progress right now).
    for (const rec of live.values()) if (out.has(rec.id)) out.set(rec.id, JSON.parse(indexLine(rec)));
    return [...out.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  function get(id) {
    const rec = live.get(id) || readRecord(id);
    if (!rec) return null;
    let markdown = null;
    try {
      markdown = fs.readFileSync(path.join(dayDir(idDay(id)), `${id}.md`), "utf8");
    } catch {
      /* not written yet */
    }
    return { record: rec, markdown, file: path.join(dayDir(idDay(id)), `${id}.md`) };
  }

  // Runs that were Planned / in Progress when the backend last stopped will never
  // finish — close them so the History list doesn't show them as live forever.
  (function sweepOrphans() {
    const now = Date.now();
    const days = [0, 1, 2].map((n) => ist(now - n * 86400000).day);
    const latest = new Map();
    for (const day of days) {
      let text;
      try {
        text = fs.readFileSync(path.join(dayDir(day), "index.jsonl"), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        try {
          const e = line && JSON.parse(line);
          if (e) latest.set(e.id, e);
        } catch {
          /* torn line */
        }
      }
    }
    let n = 0;
    for (const e of latest.values()) {
      if (e.status !== "Planned" && e.status !== "Progress") continue;
      update(e.id, { event: "cancelled", error: "Backend restarted before this run finished" });
      n += 1;
    }
    if (n) console.log(`[history] closed ${n} unfinished run(s) from before the restart`);
  })();

  return { start, update, list, get, rootDir };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/** rerun: { [dashboard]: (record) => { started: string } } */
export function registerHistory(app, { history, rerun }) {
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
  const today = () => ist(Date.now()).day;
  const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  app.get(
    "/api/history/list",
    handle((req) => {
      const to = String(req.query.to || today());
      const from = String(req.query.from || shift(to, -2)); // default: 3-day rolling window
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error("from / to must be YYYY-MM-DD");
      if (from > to) throw new Error("Start date is after end date");
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) throw new Error("Pick a range of 92 days or less");
      const dashboard = String(req.query.dashboard || "all");
      return { from, to, dashboard, dashboards: DASHBOARDS, root: history.rootDir, items: history.list({ dashboard, from, to }) };
    })
  );

  app.get(
    "/api/history/item/:id",
    handle((req) => {
      const item = history.get(String(req.params.id));
      if (!item) throw new Error("History item not found");
      return item;
    })
  );

  app.post(
    "/api/history/rerun/:id",
    handle((req) => {
      const item = history.get(String(req.params.id));
      if (!item) throw new Error("History item not found");
      const fn = rerun[item.record.dashboard];
      if (!fn) throw new Error(`Re-run not supported for ${item.record.dashboard}`);
      return fn(item.record);
    })
  );
}
