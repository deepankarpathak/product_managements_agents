import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { mccName } from "./mcc-names.js";
import { bankHealth, bump, contribution } from "./bank-health.mjs";
import { DeclinesBody, SR_KINDS, SrKpiStrip } from "./sr-shared.jsx";
import BreakdownTable from "./breakdown-table.jsx";
import { buildBreakdown, pickYday } from "./breakdown-math.mjs";
import { PSP_MODES, PSP_ORDER, pspGroup, pspParent } from "./unified-psp.mjs";
import { PARTIES, scoreAll } from "./escalation.mjs";
import { BreakdownFilter, DrillCard, EscalationCard } from "./unified-drill.jsx";
import { NO_PICK, Picker, applyPick, toPick, useStored } from "./table-pickers.jsx";
import { ScoreTable, aggregate, errorCols, errorRows, lmtdDays, periodLabels, periods, scoreCols, scoreRows } from "./unified-scorecard.jsx";

// Unified SR Dashboard — Morning Dashboard + Success Rate Snippet merged (evaluation build;
// both old tabs keep running). Talks to backend /api/udash/*. Opening the page only reads
// cached results; queries run on Refresh or the backend schedule.
//
// Global Handle / Flow filters apply to every day-level (Looker) card without a re-query:
// breakdown and decline-code rows come from per-filter views (GET /view), the rest are
// filtered here. Intraday (raw txn) cards keep their own flow controls.

const API = "/api/udash";

const SECTION_TITLES = {
  breakdown: "A · SR Breakdown — impact ranked (PSP / bank / instrument / flow)",
  declines: "B · Decline Codes — ₹ amount (raw txns)",
  codes: "B · Decline Codes — NPCI description, ₹, D-1…D-3, MTD / LMTD contribution",
  dims: "C/G/H · Day-level SR — flow / payee PSP / instrument",
  raw: "C/D/E · Intraday SR, error codes and U09 (one raw-txn query)",
  bank: "F · Payer Bank SR (intraday, raw txns)",
  bankday: "F · Payer Bank SR (day-level, Looker)",
  bankrep: "F · Payer (Remitter) Bank Report",
  merchants: "G · P2M merchants & MCC (raw, daily)",
  share: "I · Txn Count / % Share Across Handles (DoD)",
};
// Default column sets (Columns picker can turn the rest back on; Excel export keeps everything).
const A_HIDDEN_COLS = ["d2Δ", "d3Δ", "lwΔ", "volΔ", "lost"];
const B_DAY_HIDDEN_COLS = ["d2", "d3"];
const B_CODES_HIDDEN_COLS = ["MTD Failures", "LMTD Failures", "Yday Δ%", "LMTD Fails/day"];

const SECTION_IDS = ["breakdown", "declines", "codes", "dims", "raw", "bank", "bankday", "bankrep", "share", "merchants"];
const INTRADAY_IDS = ["raw"];
// Refresh-status chips show the text before " · ": keep them distinct where a card has two sections.
const CHIP_TITLES = {
  ...SECTION_TITLES,
  declines: "B ₹ · Decline codes ₹ amount",
  codes: "B codes · Decline codes MTD / LMTD",
  dims: "C/G/H · Day-level flow / PSP / instrument",
  raw: "C/D/E · Intraday SR / error codes / U09",
  bankrep: "F report · Payer bank report",
  bank: "F intraday · Payer bank SR",
  bankday: "F day · Payer bank SR",
};

const HANDLE_LABEL = {
  all: "All + @paytm",
  tpap: "All 4 TPAP",
  ptyes: "PTYES",
  ptaxis: "PTAXIS",
  ptsbi: "PTSBI",
  pthdfc: "PTHDFC",
};
const TPAP = new Set(["ptyes", "ptaxis", "ptsbi", "pthdfc"]);
const inHandle = (h, sel) => sel === "all" || (sel === "tpap" ? TPAP.has(h) : h === sel);
const inFlow = (f, sel) => sel === "ALL" || f === sel;

// Per-section duration options come from the backend (/state.durationOptions):
// [{ key: "4h", kind: "intraday" }, { key: "3d", kind: "daily" }, …]. "daily" keys read the
// day-level Looker table; "intraday" keys read raw txns (Trino or Redash).
let DURATION_OPTS = {};
const labelFor = (d) => {
  if (d === "mtd") return "MTD + LMTD (since 1st of last month)";
  if (DURATION_LABELS[d]) return DURATION_LABELS[d];
  const m = /^(\d+)([mhd])$/.exec(d || "");
  if (!m) return d;
  const n = Number(m[1]);
  const unit = { m: "min", h: "hour", d: "day" }[m[2]];
  return `${n} ${unit}${n > 1 && m[2] !== "m" ? "s" : ""}`;
};
const durationLabels = (id) => (DURATION_OPTS[id] ? Object.fromEntries(DURATION_OPTS[id].map((o) => [o.key, labelFor(o.key)])) : DURATION_LABELS);
const kindOf = (id, key) => DURATION_OPTS[id]?.find((o) => o.key === key)?.kind || "intraday";
const hasKind = (id, kind) => (DURATION_OPTS[id] || [{ kind: "intraday" }]).some((o) => o.kind === kind);
const enginesFor = (id) => [...(hasKind(id, "daily") ? ["looker"] : []), ...(hasKind(id, "intraday") ? ["trino", "redash"] : [])];
const ENGINE_NAME = {
  looker: "Looker (daily)",
  trino: "Trino",
  redash: "Redash",
};
const DURATION_LABELS = {
  "15m": "15 min",
  "1h": "1 hour",
  "4h": "4 hours",
  "12h": "12 hours",
  "1d": "1 day",
  "2d": "2 days",
  "3d": "3 days",
  "4d": "4 days",
  "7d": "7 days",
};
const DURATION_MIN = {
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "12h": 720,
  "1d": 1440,
  "2d": 2880,
  "3d": 4320,
  "4d": 5760,
  "7d": 10080,
};
const ACTIVE = new Set(["queued", "running", "retry-wait"]);

// Dark-surface categorical palette (fixed order — colour follows entity, never rank).
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
// Increase = reds (light → deep), decrease = cool greys/blues.
const REDS = ["#fecaca", "#fca5a5", "#f87171", "#ef4444", "#dc2626", "#b91c1c"];
const COOLS = ["#94a3b8", "#7dd3fc", "#60a5fa", "#a5b4fc", "#67e8f9", "#cbd5e1"];

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#f59e0b",
  good: "#0ca30c",
  bad: "#d03b3b",
  warn: "#fab219",
  grid: "#1e293b",
};

// ─── utils ───────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const lsGet = (k, fb) => {
  try {
    const v = localStorage.getItem(`udash:${k}`);
    return v == null ? fb : JSON.parse(v);
  } catch {
    return fb;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(`udash:${k}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const fmtPct = (v, dp = 2) => (v == null || Number.isNaN(v) ? "—" : `${v.toFixed(dp)}%`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtCompact = (v) => {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Map a day 'YYYY-MM-DD' to its period key for day / week (Monday) / month grain. */
function periodKey(day, grain) {
  if (grain === "month") return day.slice(0, 7);
  if (grain === "week") {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return `W ${d.toISOString().slice(0, 10)}`;
  }
  return day;
}
const fmtPp = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)} pp`);
const fmtDur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtTime = (ms) =>
  ms
    ? new Date(ms).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function engineFor(duration, cfg, id) {
  if (kindOf(id, duration) === "daily") return "looker";
  return DURATION_MIN[duration] <= (cfg?.redashMaxMinutes ?? 240) ? "redash" : "trino";
}

/** Split buckets into earlier / recent halves for "what moved" comparisons. */
function halves(buckets) {
  const mid = Math.floor(buckets.length / 2);
  return {
    early: new Set(buckets.slice(0, mid)),
    recent: new Set(buckets.slice(mid)),
  };
}

// ─── data shaping ────────────────────────────────────────────────────────────

function shapeSr(rows, flowFilter) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const handles = [...new Set(rows.map((r) => r.handle))].sort();
  const mk = () => buckets.map(() => ({ t: 0, s: 0 }));
  const overall = { ALL: mk(), P2P: mk(), P2M: mk() };
  const byHandle = Object.fromEntries(handles.map((h) => [h, mk()]));
  const handleFlow = {}; // handle -> flow -> {t,s,et,es,rt,rs}
  const { early } = halves(buckets);
  for (const r of rows) {
    const i = idx.get(r.ts);
    for (const k of ["ALL", r.flow]) {
      if (!overall[k]) continue;
      overall[k][i].t += r.total;
      overall[k][i].s += r.success;
    }
    if (flowFilter === "ALL" || r.flow === flowFilter) {
      byHandle[r.handle][i].t += r.total;
      byHandle[r.handle][i].s += r.success;
    }
    for (const f of ["ALL", r.flow]) {
      const a = ((handleFlow[r.handle] ||= {})[f] ||= {
        t: 0,
        s: 0,
        et: 0,
        es: 0,
        rt: 0,
        rs: 0,
      });
      a.t += r.total;
      a.s += r.success;
      if (early.has(r.ts)) {
        a.et += r.total;
        a.es += r.success;
      } else {
        a.rt += r.total;
        a.rs += r.success;
      }
    }
  }
  return { buckets, handles, overall, byHandle, handleFlow };
}

function shapeErrors(rows, grouping, topN) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const total = buckets.map(() => 0);
  const fail = buckets.map(() => 0);
  const codes = new Map(); // code -> per-bucket counts
  for (const r of rows) {
    const i = idx.get(r.ts);
    total[i] += r.cnt;
    if (r.code === "__NONFAIL__") continue;
    fail[i] += r.cnt;
    const code = grouping === "prefix" ? String(r.code).split("-")[0] : r.code;
    if (!codes.has(code))
      codes.set(
        code,
        buckets.map(() => 0),
      );
    codes.get(code)[i] += r.cnt;
  }
  const { early, recent } = halves(buckets);
  const sumWhere = (arr, set) => arr.reduce((a, v, i) => (set.has(buckets[i]) ? a + v : a), 0);
  const tE = sumWhere(total, early);
  const tR = sumWhere(total, recent);
  const all = [...codes.entries()].map(([code, counts]) => {
    const n = counts.reduce((a, b) => a + b, 0);
    const e = pct(sumWhere(counts, early), tE);
    const r = pct(sumWhere(counts, recent), tR);
    const delta = e != null && r != null ? r - e : null;
    const rel = e ? ((r - e) / e) * 100 : null;
    return {
      code,
      counts,
      n,
      share: pct(
        n,
        total.reduce((a, b) => a + b, 0),
      ),
      early: e,
      recent: r,
      delta,
      rel,
    };
  });
  all.sort((a, b) => b.n - a.n);
  const top = all.slice(0, topN);
  // Colour: increases get red shades by size of rise; decreases get cool shades.
  const inc = top.filter((c) => (c.delta ?? 0) > 0).sort((a, b) => b.delta - a.delta);
  const dec = top.filter((c) => !((c.delta ?? 0) > 0));
  inc.forEach((c, i) => {
    const step = Math.min(REDS.length - 1, Math.round(((inc.length - 1 - i) / Math.max(1, inc.length - 1)) * (REDS.length - 1)));
    c.color = REDS[step];
    c.up = true;
  });
  dec.forEach((c, i) => {
    c.color = COOLS[i % COOLS.length];
    c.up = false;
  });
  return { buckets, total, fail, top, otherCount: all.length - top.length };
}

function shapeU09(rows) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const handles = [...new Set(rows.map((r) => r.handle))].sort();
  const mk = () => buckets.map(() => ({ t: 0, u: 0 }));
  const overall = mk();
  const byHandle = Object.fromEntries(handles.map((h) => [h, mk()]));
  for (const r of rows) {
    const i = idx.get(r.ts);
    overall[i].t += r.total;
    overall[i].u += r.u09;
    byHandle[r.handle][i].t += r.total;
    byHandle[r.handle][i].u += r.u09;
  }
  return { buckets, handles, overall, byHandle };
}

function shapeBank(rows, flowFilter, topN) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const { early } = halves(buckets);
  const banks = new Map();
  for (const r of rows) {
    let b = banks.get(r.bank);
    if (!b) {
      b = {
        bank: r.bank,
        ALL: { t: 0, s: 0 },
        P2P: { t: 0, s: 0 },
        P2M: { t: 0, s: 0 },
        et: 0,
        es: 0,
        rt: 0,
        rs: 0,
        series: buckets.map(() => ({ t: 0, s: 0 })),
      };
      banks.set(r.bank, b);
    }
    b.ALL.t += r.total;
    b.ALL.s += r.success;
    if (b[r.flow]) {
      b[r.flow].t += r.total;
      b[r.flow].s += r.success;
    }
    if (flowFilter === "ALL" || r.flow === flowFilter) {
      const p = b.series[idx.get(r.ts)];
      p.t += r.total;
      p.s += r.success;
      if (early.has(r.ts)) {
        b.et += r.total;
        b.es += r.success;
      } else {
        b.rt += r.total;
        b.rs += r.success;
      }
    }
  }
  const list = [...banks.values()].sort((a, b) => b.ALL.t - a.ALL.t);
  list.forEach((b) => {
    b.delta = b.et && b.rt ? pct(b.rs, b.rt) - pct(b.es, b.et) : null;
  });
  return { buckets, list, top: list.slice(0, topN) };
}

// ─── chart ───────────────────────────────────────────────────────────────────

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function tickLabel(ts, sameDay) {
  // ts = 'YYYY-MM-DD HH:mm' (intraday), 'YYYY-MM-DD' (day), 'W YYYY-MM-DD' (week), 'YYYY-MM' (month)
  if (ts.startsWith("W ")) return `wk ${ts.slice(10, 12)}/${ts.slice(7, 9)}`;
  if (ts.length === 7) return `${MONTHS[Number(ts.slice(5, 7)) - 1]} ${ts.slice(2, 4)}`;
  if (ts.length === 10) return `${ts.slice(8, 10)}/${ts.slice(5, 7)}`;
  return sameDay ? ts.slice(11) : `${ts.slice(8, 10)}/${ts.slice(5, 7)} ${ts.slice(11)}`;
}

// Page-wide incident notes (scope "all"); every LineChart draws them unless given its own marks.
const MarksCtx = createContext([]);

// ─── layout: collapse / dock / focus per card ────────────────────────────────
// mode per anchor: "open" (default) · "collapsed" (header + key numbers) · "docked" (only a chip in
// the dock rail). solo = one card shown alone. Saved in localStorage (udash:layout).
const LayoutCtx = createContext(null);
const LAYOUT_CARDS = [
  ["breakdown", "A · SR Breakdown"],
  ["declines", "B · Decline codes"],
  ["sr", "C · SR trend"],
  ["errors", "D · Error codes"],
  ["u09", "E · U09"],
  ["bank", "F · Payer bank"],
  ["psp", "G · Payee PSP"],
  ["instrument", "H · Instrument"],
  ["share", "I · Share"],
  ["drill", "J · Drill-down"],
  ["escalate", "K · Escalation"],
];
const onlyOpen = (open) => Object.fromEntries(LAYOUT_CARDS.filter(([a]) => !open.includes(a)).map(([a]) => [a, "docked"]));
const LAYOUT_PRESETS = {
  focus: { label: "Focus", modes: onlyOpen(["breakdown", "declines", "escalate"]) },
  bank: { label: "Bank triage", modes: onlyOpen(["breakdown", "declines", "bank", "escalate"]) },
  full: { label: "Full", modes: {} },
};
const presetOf = (layout) => Object.keys(LAYOUT_PRESETS).find((k) => JSON.stringify(LAYOUT_PRESETS[k].modes) === JSON.stringify(layout)) || "custom";

const iconBtn = { ...btnBase(), padding: "3px 8px", fontSize: 12 };
function btnBase() {
  return { background: "transparent", border: `1px solid #1e293b`, borderRadius: 6, color: "#94a3b8", cursor: "pointer", fontWeight: 600 };
}

/** Collapse / dock / focus buttons for a card header. */
function LayoutButtons({ anchor }) {
  const lay = useContext(LayoutCtx);
  if (!lay) return null;
  const mode = lay.mode(anchor);
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <button type="button" style={iconBtn} onClick={() => lay.set(anchor, mode === "collapsed" ? "open" : "collapsed")} title={mode === "collapsed" ? "Expand" : "Collapse to the header"}>
        {mode === "collapsed" ? "▸" : "▾"}
      </button>
      <button type="button" style={iconBtn} onClick={() => lay.set(anchor, "docked")} title="Dock — move to the side rail (click it there to bring it back)">
        📌
      </button>
      <button type="button" style={{ ...iconBtn, color: lay.solo === anchor ? "#34d399" : iconBtn.color }} onClick={() => lay.setSolo(lay.solo === anchor ? null : anchor)} title={lay.solo === anchor ? "Show all cards" : "Focus — show only this card"}>
        ⤢
      </button>
    </span>
  );
}

/** Right-hand rail listing docked cards with their key numbers; click to undock. */
function DockRail({ docked, summaries, onUndock, open, setOpen, top = 180 }) {
  if (!docked.length) return null;
  return (
    <aside
      style={{
        position: "fixed",
        right: 12,
        top,
        zIndex: 15,
        width: open ? 220 : "auto",
        maxHeight: `calc(100vh - ${top + 20}px)`,
        overflow: "auto",
        background: "#0c1626",
        border: `1px solid #1e293b`,
        borderRadius: 8,
        boxShadow: "0 6px 18px rgba(0,0,0,.4)",
        padding: open ? 8 : "6px 8px",
      }}
    >
      <button type="button" style={{ ...iconBtn, border: "none", width: "100%", textAlign: "left", color: "#e2e8f0" }} onClick={() => setOpen(!open)} title={open ? "Hide the rail" : "Show docked cards"}>
        📌 Docked {docked.length} {open ? "›" : "‹"}
      </button>
      {open &&
        docked.map(([a, label]) => (
          <div
            key={a}
            role="button"
            tabIndex={0}
            onClick={() => onUndock(a)}
            onKeyDown={(e) => e.key === "Enter" && onUndock(a)}
            title="Undock — put the card back on the page and jump to it"
            style={{ marginTop: 6, padding: "6px 8px", border: `1px solid #1e293b`, borderRadius: 6, cursor: "pointer", background: "#111a2e" }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{label}</div>
            {summaries[a] && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{summaries[a]}</div>}
          </div>
        ))}
    </aside>
  );
}

/** marks: optional annotations [{ date: "YYYY-MM-DD", end?, label }] drawn as dashed vertical lines on matching buckets. */
function LineChart({ title, buckets, series, yFormat = (v) => v.toFixed(1), height = 260, unit = "", initialHidden, marks: ownMarks }) {
  const ctxMarks = useContext(MarksCtx);
  const marks = ownMarks || ctxMarks;
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  // Series listed in initialHidden start toggled off (legend click shows them).
  const [hidden, setHidden] = useState(() => new Set(initialHidden || []));
  const visible = series.filter((s) => !hidden.has(s.key));
  const pad = { l: 56, r: visible.length <= 4 ? 70 : 16, t: 12, b: 28 };
  const iw = Math.max(10, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;

  const vals = visible.flatMap((s) => s.values.filter((v) => v != null && Number.isFinite(v)));
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  if (vals.length && Math.min(...vals) >= 0 && lo < 0) lo = 0;
  if (unit === "%" && vals.length && Math.max(...vals) <= 100 && hi > 100) hi = 100;
  const x = (i) => pad.l + (buckets.length <= 1 ? iw / 2 : (i * iw) / (buckets.length - 1));
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  const sameDay = buckets.length && buckets[0].slice(0, 10) === buckets[buckets.length - 1].slice(0, 10);
  const nX = Math.max(2, Math.min(8, Math.floor(iw / 90)));
  const xTicks = buckets.length <= nX ? buckets.map((_, i) => i) : Array.from({ length: nX }, (_, k) => Math.round((k * (buckets.length - 1)) / (nX - 1)));

  const path = (vals2) => {
    let d = "";
    let pen = false;
    vals2.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (!buckets.length) return;
    const i = Math.round(((px - pad.l) / iw) * (buckets.length - 1));
    setHover(Math.max(0, Math.min(buckets.length - 1, i)));
  };

  const toggle = (k) =>
    setHidden((h) => {
      const n = new Set(h);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  // Direct labels at line ends for ≤4 series, nudged apart.
  const endLabels = [];
  if (visible.length <= 4) {
    visible.forEach((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && (s.values[i] == null || !Number.isFinite(s.values[i]))) i--;
      if (i >= 0) endLabels.push({ s, yy: y(s.values[i]) });
    });
    endLabels.sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < endLabels.length; k++) if (endLabels[k].yy - endLabels[k - 1].yy < 13) endLabels[k].yy = endLabels[k - 1].yy + 13;
  }

  return (
    <div style={{ marginBottom: 14 }}>
      {title && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: C.text2,
            margin: "4px 0 6px",
          }}
        >
          {title}
        </div>
      )}
      {series.length > 1 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "4px 12px",
            marginBottom: 6,
          }}
        >
          {series.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              title="Show / hide"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: hidden.has(s.key) ? C.muted : C.text2,
                fontSize: 11,
                textDecoration: hidden.has(s.key) ? "line-through" : "none",
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 3,
                  borderRadius: 2,
                  background: s.color,
                  opacity: hidden.has(s.key) ? 0.3 : 1,
                }}
              />
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div ref={ref} style={{ position: "relative" }}>
        {!buckets.length ? (
          <div
            style={{
              height,
              display: "grid",
              placeItems: "center",
              color: C.muted,
              fontSize: 12,
            }}
          >
            No data in window
          </div>
        ) : (
          <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: "block" }}>
            {yTicks.map((v, i) => (
              <g key={i}>
                <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke={C.grid} strokeWidth={1} />
                <text x={pad.l - 8} y={y(v) + 4} fill={C.muted} fontSize={10} textAnchor="end">
                  {yFormat(v)}
                  {unit}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={height - 8} fill={C.muted} fontSize={10} textAnchor="middle">
                {tickLabel(buckets[i], sameDay)}
              </text>
            ))}
            {visible.map((s) => (
              <path key={s.key} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.width || 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {endLabels.map(({ s, yy }) => (
              <text key={s.key} x={pad.l + iw + 6} y={yy + 4} fill={C.text2} fontSize={10}>
                {s.label}
              </text>
            ))}
            {marks.map((m, mi) => {
              // A bucket matches when it falls in [date, end] (day "YYYY-MM-DD", intraday "YYYY-MM-DD HH:mm", week "W YYYY-MM-DD").
              const day = (b) => (b.startsWith("W ") ? b.slice(2) : b.slice(0, 10));
              const hit = buckets.map((b, i) => [day(b), i]).filter(([d]) => d.length === 10 && d >= m.date && d <= (m.end || m.date));
              if (!hit.length) return null;
              const i = hit[0][1];
              return (
                <g key={`m${mi}`}>
                  <line x1={x(i)} x2={x(i)} y1={pad.t} y2={pad.t + ih} stroke="#c084fc" strokeDasharray="4 3" strokeWidth={1.5} />
                  <text x={x(i) + 3} y={pad.t + 10 + (mi % 3) * 11} fill="#c084fc" fontSize={10}>
                    📝 {m.label.length > 28 ? `${m.label.slice(0, 28)}…` : m.label}
                  </text>
                </g>
              );
            })}
            {hover != null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={C.text2} strokeDasharray="3 3" />
                {visible.map((s) =>
                  s.values[hover] != null && Number.isFinite(s.values[hover]) ? (
                    <circle key={s.key} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke={C.card} strokeWidth={2} />
                  ) : null,
                )}
              </g>
            )}
          </svg>
        )}
        {hover != null && buckets.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 4,
              left: x(hover) > width / 2 ? x(hover) - 230 : x(hover) + 12,
              width: 218,
              background: "#020617ee",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 11,
              color: C.text,
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            <div style={{ color: C.text2, marginBottom: 4 }}>{buckets[hover]}</div>
            {[...visible]
              .sort((a, b) => (b.values[hover] ?? -Infinity) - (a.values[hover] ?? -Infinity))
              .map((s) => (
                <div
                  key={s.key}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: s.color,
                        flex: "none",
                      }}
                    />
                    {s.label}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {s.values[hover] == null ? "—" : `${yFormat(s.values[hover])}${unit}`}
                    {s.extra ? <span style={{ color: C.muted }}> {s.extra(hover)}</span> : null}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── table ───────────────────────────────────────────────────────────────────

function Table({ columns, rows, maxHeight = 360, empty = "No data" }) {
  const [sort, setSort] = useState(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const get = col?.sortValue || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * (sort.dir === "asc" ? 1 : -1);
    });
  }, [rows, sort, columns]);
  return (
    <div
      style={{
        maxHeight,
        overflow: "auto",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        marginBottom: 12,
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() =>
                  setSort((s) => ({
                    key: c.key,
                    dir: s?.key === c.key && s.dir === "desc" ? "asc" : "desc",
                  }))
                }
                style={{
                  position: "sticky",
                  top: 0,
                  background: C.card2,
                  color: C.text2,
                  fontWeight: 600,
                  textAlign: c.align || "right",
                  padding: "7px 10px",
                  borderBottom: `1px solid ${C.border}`,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === "desc" ? " ↓" : " ↑") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} style={{ padding: 16, textAlign: "center", color: C.muted }}>
                {empty}
              </td>
            </tr>
          )}
          {sorted.map((r, i) => (
            <tr key={r._key ?? i} style={{ borderBottom: `1px solid ${C.border}` }}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    padding: "6px 10px",
                    textAlign: c.align || "right",
                    color: C.text,
                    whiteSpace: "nowrap",
                    ...(c.style ? c.style(r) : {}),
                  }}
                >
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Red background for a worsening move; intensity scales with magnitude. */
const badCell = (badness, scale) => {
  if (badness == null || badness <= 0) return {};
  const a = Math.min(0.75, 0.12 + (badness / scale) * 0.6);
  return {
    background: `rgba(220, 38, 38, ${a.toFixed(2)})`,
    color: "#fff",
    fontWeight: 600,
  };
};
const goodText = (v) => (v != null && v < 0 ? { color: "#4ade80" } : {});

// ─── small UI bits ───────────────────────────────────────────────────────────

const btn = (variant = "default") => ({
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${variant === "primary" ? C.accent : variant === "danger" ? "#7f1d1d" : C.border}`,
  background: variant === "primary" ? C.accent : variant === "danger" ? "#450a0a" : C.card2,
  color: variant === "primary" ? "#111" : variant === "danger" ? "#fecaca" : C.text,
});
const selectStyle = {
  background: C.card2,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};

function Seg({ value, options, onChange }) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding: "4px 10px",
            fontSize: 12,
            border: "none",
            cursor: "pointer",
            background: value === v ? "#1e3a5f" : C.card2,
            color: value === v ? "#fff" : C.text2,
            fontWeight: value === v ? 600 : 400,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const STATUS_STYLE = {
  idle: { label: "Not run", color: C.muted, icon: "○" },
  queued: { label: "Queued", color: C.text2, icon: "◷" },
  running: { label: "Running", color: "#38bdf8", icon: "⟳" },
  success: { label: "Done", color: C.good, icon: "✓" },
  failed: { label: "Failed", color: C.bad, icon: "✕" },
  cancelled: { label: "Stopped", color: C.warn, icon: "■" },
  "retry-wait": { label: "Retry queued", color: C.warn, icon: "↻" },
};

function StatusChip({ job, now }) {
  const st = STATUS_STYLE[job?.status || "idle"];
  let extra = "";
  if (job?.status === "running" && job.startedAt) extra = ` · ${fmtDur(now - job.startedAt)}`;
  if (job?.status === "running" && job.progress != null) extra += ` · ${job.progress}%`;
  if (job?.status === "retry-wait" && job.nextRetryAt) extra = ` · in ${fmtDur(Math.max(0, job.nextRetryAt - now))} (attempt ${job.attempt + 1})`;
  if (job?.status === "success" && job.elapsedMs) extra = ` · ${fmtDur(job.elapsedMs)}`;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: st.color,
        border: `1px solid ${st.color}55`,
        borderRadius: 999,
        padding: "2px 8px",
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden>{st.icon}</span>
      {st.label}
      {extra}
    </span>
  );
}

const ENGINE_BADGE = {
  trino: {
    label: "Trino · DWH",
    title: "Trino (DWH raw txns)",
    bg: "#1e1b4b",
    fg: "#a5b4fc",
  },
  redash: {
    label: "Redash · live",
    title: "Redash (live switch DB)",
    bg: "#052e16",
    fg: "#86efac",
  },
  looker: {
    label: "Trino · Looker daily",
    title: "Trino — day-level Looker table (complete days)",
    bg: "#3b0764",
    fg: "#e9d5ff",
  },
};
const EngineBadge = ({ engine }) => {
  const b = ENGINE_BADGE[engine] || ENGINE_BADGE.trino;
  return (
    <span
      title={b.title}
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        padding: "2px 6px",
        borderRadius: 4,
        background: b.bg,
        color: b.fg,
        textTransform: "uppercase",
      }}
    >
      {b.label}
    </span>
  );
};

// ─── section card ────────────────────────────────────────────────────────────

function scheduleText(sched) {
  if (!sched) return null;
  if (sched.note) return sched.note;
  const r = sched.rule;
  const what = r?.type === "daily" ? `daily ${r.at.join(", ")}` : r?.type === "interval" ? `every ${r.everyMin} min` : "";
  const next = sched.nextAt
    ? new Date(sched.nextAt).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return `auto-refresh ${what}${next ? ` · next ${next}` : ""}`;
}

function SectionCard({ id, anchor = id, title, job, result, cfg, duration, setDuration, now, onRun, onStop, onRetryNow, children, controls, sched, noView = false, note }) {
  const [view, setView] = useState(() => lsGet(`view:${anchor}`, "chart"));
  const [showSql, setShowSql] = useState(false);
  const [sql, setSql] = useState(null);
  useEffect(() => lsSet(`view:${anchor}`, view), [anchor, view]);
  const active = ACTIVE.has(job?.status);
  const plannedEngine = engineFor(duration, cfg, id);
  const stale = result && result.duration !== duration;
  const lay = useContext(LayoutCtx);
  const mode = lay ? lay.mode(anchor) : "open";

  const toggleSql = async () => {
    const next = !showSql;
    setShowSql(next);
    if (next) {
      try {
        setSql(job?.sql && active ? { rendered: job.sql, engine: job.engine } : await api(`/sql?section=${id}&duration=${duration}`));
      } catch (e) {
        setSql({ rendered: `-- ${e.message}` });
      }
    }
  };

  if (mode === "docked" || (lay?.solo && lay.solo !== anchor)) return null;
  const collapsed = mode === "collapsed";

  return (
    <section
      id={`udash-${anchor}`}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: collapsed ? "10px 18px" : "16px 20px",
        marginBottom: collapsed ? 10 : 18,
        scrollMarginTop: 140,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          marginBottom: collapsed ? 0 : 12,
        }}
      >
        <LayoutButtons anchor={anchor} />
        <h2 style={{ margin: 0, fontSize: collapsed ? 14 : 16, color: C.text, fontWeight: 700, letterSpacing: 0.1 }}>{title || SECTION_TITLES[id]}</h2>
        {collapsed && lay?.summaries?.[anchor] && <span style={{ fontSize: 12, color: C.text2 }}>{lay.summaries[anchor]}</span>}
        <StatusChip job={job} now={now} />
        <EngineBadge engine={active ? job.engine : plannedEngine} />
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          {!collapsed && (
          <select value={duration} onChange={(e) => setDuration(e.target.value)} style={selectStyle} aria-label="Duration">
            {Object.entries(durationLabels(id)).map(([k, l]) => (
              <option key={k} value={k}>
                {k === "mtd" ? l : `Last ${l}`}
              </option>
            ))}
          </select>
          )}
          {!noView && !collapsed && (
            <Seg
              value={view}
              onChange={setView}
              options={[
                ["chart", "Trend"],
                ["table", "Table"],
              ]}
            />
          )}
          {!collapsed && (
            <button type="button" style={btn()} onClick={toggleSql}>
              {showSql ? "Hide SQL" : "SQL"}
            </button>
          )}
          {job?.status === "retry-wait" && (
            <button type="button" style={btn()} onClick={onRetryNow}>
              Retry now
            </button>
          )}
          {active ? (
            <button type="button" style={btn("danger")} onClick={onStop}>
              ■ Stop
            </button>
          ) : (
            <button type="button" style={btn("primary")} onClick={onRun}>
              ⟳ Refresh
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
      <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 18px",
          fontSize: 11,
          color: C.muted,
          marginBottom: 14,
          paddingBottom: 12,
          borderBottom: `1px solid ${C.border}`,
        }}
      >
        {result ? (
          <>
            <span>
              Data as of <b style={{ color: C.text2 }}>{fmtTime(result.ranAt)}</b>
            </span>
            <span>
              Window {result.window?.from?.slice(5, 16)} → {result.window?.to?.slice(5, 16)} IST · {result.window?.bucketMin >= 1440 ? "daily" : `${result.window?.bucketMin}-min buckets`}
            </span>
            <span>
              {result.engine} · {fmtDur(result.elapsedMs)} · {(result.rowCount ?? result.rows.length).toLocaleString()} rows
            </span>
            {note && <span style={{ color: C.text2 }}>{note}</span>}
            {(() => {
              // DWH tables lag (participants by hours) — flag when data stops short of the window.
              let last = result.rows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
              if (last.length === 10) last = `${last} 00:00`; // day-level rows
              const end = result.window?.to?.slice(0, 16);
              if (!last || !end) return null;
              const gapMin = (Date.parse(`${end.replace(" ", "T")}:00Z`) - Date.parse(`${last.replace(" ", "T")}:00Z`)) / 60000 - result.window.bucketMin;
              return gapMin >= result.window.bucketMin * 2 ? (
                <span style={{ color: C.warn }}>
                  ⚠ data ends at {last} — last ~{Math.round(gapMin / 60) || "<1"}h not yet in {result.engine === "trino" ? "DWH" : "source"}
                </span>
              ) : null;
            })()}
            {stale && (
              <span style={{ color: C.warn }}>
                ⚠ showing {labelFor(result.duration)} — refresh for {labelFor(duration)}
              </span>
            )}
          </>
        ) : (
          <span>No cached data — press Refresh.</span>
        )}
        {job?.status === "running" && job.state && (
          <span style={{ color: "#38bdf8" }}>
            {job.trigger === "schedule" ? "scheduled · " : ""}
            {job.state}
          </span>
        )}
        {scheduleText(sched) && <span title="Backend refresh schedule — uses this section's default duration">⏱ {scheduleText(sched)}</span>}
      </div>

      {job?.error && ["failed", "retry-wait", "cancelled"].includes(job.status) && (
        <div
          role="alert"
          style={{
            background: job.status === "cancelled" ? "#422006" : "#450a0a",
            border: `1px solid ${job.status === "cancelled" ? "#854d0e" : "#7f1d1d"}`,
            color: job.status === "cancelled" ? "#fde68a" : "#fecaca",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            marginBottom: 10,
            wordBreak: "break-word",
          }}
        >
          <b>{job.status === "cancelled" ? "Stopped" : `Attempt ${job.attempt} failed`}:</b> {job.error}
          {job.status === "failed" && " — retries exhausted; press Refresh to run again."}
        </div>
      )}

      {showSql && (
        <pre
          style={{
            background: "#020617",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 10,
            fontSize: 11,
            color: "#cbd5e1",
            maxHeight: 280,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {sql ? `-- engine: ${sql.engine || ""}${sql.note ? `\n-- ${sql.note}` : ""}\n${sql.rendered}` : "Loading…"}
        </pre>
      )}

      {controls && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "10px 14px",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          {controls}
        </div>
      )}

      {result ? children(view) : null}
      </>
      )}
    </section>
  );
}

// ─── section bodies ──────────────────────────────────────────────────────────

function SrBody({ result, view, flow }) {
  const d = useMemo(() => shapeSr(result.rows, flow), [result, flow]);
  const overallSeries = [
    {
      key: "ALL",
      label: "Overall",
      color: SERIES[0],
      width: 2.5,
      values: d.overall.ALL.map((p) => pct(p.s, p.t)),
      extra: (i) => `(${fmtNum(d.overall.ALL[i].t)})`,
    },
    {
      key: "P2P",
      label: "P2P",
      color: SERIES[1],
      values: d.overall.P2P.map((p) => pct(p.s, p.t)),
    },
    {
      key: "P2M",
      label: "P2M",
      color: SERIES[2],
      values: d.overall.P2M.map((p) => pct(p.s, p.t)),
    },
  ];
  const handleSeries = d.handles.map((h, i) => ({
    key: h,
    label: h.toUpperCase(),
    color: SERIES[i % SERIES.length],
    values: d.byHandle[h].map((p) => pct(p.s, p.t)),
    extra: (k) => `(${fmtNum(d.byHandle[h][k].t)})`,
  }));
  const yf = (v) => v.toFixed(1);

  if (view === "chart") {
    return (
      <>
        <LineChart title="Overall SR (all payer handles)" buckets={d.buckets} series={overallSeries} yFormat={yf} unit="%" />
        <LineChart title={`Payer-handle SR${flow !== "ALL" ? ` · ${flow}` : ""}`} buckets={d.buckets} series={handleSeries} yFormat={yf} unit="%" />
      </>
    );
  }
  const handleRows = d.handles.map((h) => {
    const f = d.handleFlow[h] || {};
    const A = f.ALL || {};
    const delta = A.et && A.rt ? pct(A.rs, A.rt) - pct(A.es, A.et) : null;
    return {
      _key: h,
      handle: h.toUpperCase(),
      vol: A.t,
      sr: pct(A.s, A.t),
      p2p: pct(f.P2P?.s, f.P2P?.t),
      p2pVol: f.P2P?.t,
      p2m: pct(f.P2M?.s, f.P2M?.t),
      p2mVol: f.P2M?.t,
      delta,
    };
  });
  const tot = d.overall;
  const sum = (arr) => arr.reduce((a, p) => ({ t: a.t + p.t, s: a.s + p.s }), { t: 0, s: 0 });
  const [A, P, M] = [sum(tot.ALL), sum(tot.P2P), sum(tot.P2M)];
  handleRows.push({
    _key: "__all",
    handle: "ALL",
    vol: A.t,
    sr: pct(A.s, A.t),
    p2p: pct(P.s, P.t),
    p2pVol: P.t,
    p2m: pct(M.s, M.t),
    p2mVol: M.t,
    delta: null,
  });
  const bucketRows = d.buckets
    .map((b, i) => ({
      _key: b,
      ts: b,
      vol: tot.ALL[i].t,
      sr: pct(tot.ALL[i].s, tot.ALL[i].t),
      p2p: pct(tot.P2P[i].s, tot.P2P[i].t),
      p2m: pct(tot.P2M[i].s, tot.P2M[i].t),
      ...Object.fromEntries(d.handles.map((h) => [`h_${h}`, pct(d.byHandle[h][i].s, d.byHandle[h][i].t)])),
    }))
    .reverse();
  return (
    <>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: C.text2,
          margin: "4px 0 6px",
        }}
      >
        Payer-handle summary (Δ = recent half vs earlier half of window)
      </div>
      <Table
        columns={[
          {
            key: "handle",
            label: "Payer handle",
            align: "left",
            render: (r) => <b>{r.handle}</b>,
          },
          { key: "vol", label: "Txns", render: (r) => fmtNum(r.vol) },
          { key: "sr", label: "SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P SR", render: (r) => fmtPct(r.p2p) },
          { key: "p2pVol", label: "P2P txns", render: (r) => fmtNum(r.p2pVol) },
          { key: "p2m", label: "P2M SR", render: (r) => fmtPct(r.p2m) },
          { key: "p2mVol", label: "P2M txns", render: (r) => fmtNum(r.p2mVol) },
          {
            key: "delta",
            label: "Δ SR",
            render: (r) => fmtPp(r.delta),
            style: (r) => ({
              ...badCell(r.delta == null ? null : -r.delta, 2),
              ...goodText(-r.delta),
            }),
          },
        ]}
        rows={handleRows}
      />
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: C.text2,
          margin: "4px 0 6px",
        }}
      >
        Per bucket (latest first)
      </div>
      <Table
        columns={[
          { key: "ts", label: "Bucket (IST)", align: "left" },
          { key: "vol", label: "Txns", render: (r) => fmtNum(r.vol) },
          { key: "sr", label: "Overall SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P", render: (r) => fmtPct(r.p2p) },
          { key: "p2m", label: "P2M", render: (r) => fmtPct(r.p2m) },
          ...d.handles.map((h) => ({
            key: `h_${h}`,
            label: h.toUpperCase(),
            render: (r) => fmtPct(r[`h_${h}`]),
          })),
        ]}
        rows={bucketRows}
      />
    </>
  );
}

/** hide: codes kept out of the top list (their txns still count in "% of all txns"). */
function ErrorsBody({ result, view, cfg, metric, topN, visibleN, column, pivot, hide = null }) {
  const n = topN || cfg.errorTopN;
  const hideKey = hide ? [...hide].join(",") : "";
  const d = useMemo(() => {
    const x = shapeErrors(result.rows, cfg.errorGrouping, n + (hide ? hide.size : 0));
    return hide ? { ...x, top: x.top.filter((c) => !hide.has(c.code)).slice(0, n) } : x;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, cfg.errorGrouping, n, hideKey]);
  const maxDelta = Math.max(0.01, ...d.top.map((c) => c.delta || 0));
  if (view === "chart") {
    const series = d.top.map((c) => ({
      key: c.code,
      label: `${c.up ? "▲" : "▼"} ${c.code}`,
      color: c.color,
      width: c.up ? 2.5 : 1.5,
      dash: c.up ? undefined : "4 3",
      values: c.counts.map((n, i) => (metric === "pct" ? pct(n, d.total[i]) : n)),
      extra: (i) => (metric === "pct" ? `(${fmtNum(c.counts[i])})` : `(${fmtPct(pct(c.counts[i], d.total[i]))})`),
    }));
    return (
      <>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
          <span style={{ color: REDS[4] }}>▲ Red shades</span> = share of txns rose (deeper red = bigger rise); <span style={{ color: COOLS[2] }}>▼ dashed</span> = fell or flat. Compared: recent half
          vs earlier half of window.
        </div>
        <LineChart
          title={`Top ${d.top.length} ${column || cfg.errorColumn} codes · ${metric === "pct" ? "% of all txns" : "count"}${visibleN && d.top.length > visibleN ? ` — top ${visibleN} shown, click legend for more` : ""}`}
          buckets={d.buckets}
          series={series}
          initialHidden={visibleN ? d.top.slice(visibleN).map((c) => c.code) : undefined}
          yFormat={metric === "pct" ? (v) => v.toFixed(2) : (v) => fmtNum(v)}
          unit={metric === "pct" ? "%" : ""}
          height={300}
        />
        <LineChart
          title="Overall failure rate"
          buckets={d.buckets}
          series={[
            {
              key: "f",
              label: "Failure %",
              color: SERIES[0],
              values: d.fail.map((f, i) => pct(f, d.total[i])),
            },
          ]}
          yFormat={(v) => v.toFixed(2)}
          unit="%"
          height={160}
        />
      </>
    );
  }
  return (
    <Table
      columns={[
        {
          key: "code",
          label: "Error code",
          align: "left",
          render: (r) => (
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: r.color,
                  marginRight: 6,
                }}
              />
              <b>{r.code}</b>
            </span>
          ),
        },
        { key: "n", label: "Failures", render: (r) => fmtNum(r.n) },
        { key: "share", label: "% of txns", render: (r) => fmtPct(r.share, 3) },
        {
          key: "early",
          label: "Earlier half",
          render: (r) => fmtPct(r.early, 3),
        },
        {
          key: "recent",
          label: "Recent half",
          render: (r) => fmtPct(r.recent, 3),
        },
        {
          key: "delta",
          label: "Δ share",
          render: (r) => (r.delta == null ? "—" : `${r.up ? "▲" : "▼"} ${r.delta > 0 ? "+" : ""}${r.delta.toFixed(3)} pp`),
          style: (r) => ({
            ...badCell(r.delta, maxDelta),
            ...goodText(r.delta),
          }),
        },
        {
          key: "rel",
          label: "Δ %",
          render: (r) => (r.rel == null ? "—" : `${r.rel > 0 ? "+" : ""}${r.rel.toFixed(1)}%`),
          style: (r) => ({ ...badCell(r.rel, 100), ...goodText(r.rel) }),
        },
        // Per-period breakdown (latest first) when the window has few enough periods.
        ...(pivot && d.buckets.length <= 16
          ? [...d.buckets].reverse().map((b) => {
              const i = d.buckets.indexOf(b);
              return {
                key: `p_${b}`,
                label: tickLabel(b, d.buckets[0].slice(0, 10) === d.buckets[d.buckets.length - 1].slice(0, 10)),
                render: (r) => (metric === "pct" ? fmtPct(pct(r.counts[i], d.total[i]), 3) : fmtNum(r.counts[i])),
                sortValue: (r) => r.counts[i],
              };
            })
          : []),
      ]}
      rows={d.top.map((c) => ({ ...c, _key: c.code }))}
      empty="No failures in window"
    />
  );
}

function U09Body({ result, view, metric, split }) {
  const d = useMemo(() => shapeU09(result.rows), [result]);
  const val = (p) => (metric === "pct" ? pct(p.u, p.t) : p.u);
  const yf = metric === "pct" ? (v) => v.toFixed(3) : (v) => fmtNum(v);
  if (view === "chart") {
    const series = [
      {
        key: "all",
        label: "All handles",
        color: SERIES[0],
        width: 2.5,
        values: d.overall.map(val),
        extra: (i) => (metric === "pct" ? `(${fmtNum(d.overall[i].u)})` : `(${fmtPct(pct(d.overall[i].u, d.overall[i].t), 3)})`),
      },
      ...(split
        ? d.handles.map((h, i) => ({
            key: h,
            label: h.toUpperCase(),
            color: SERIES[(i + 1) % SERIES.length],
            values: d.byHandle[h].map(val),
          }))
        : []),
    ];
    return <LineChart title={`U09 ${metric === "pct" ? "% of txns" : "count"}`} buckets={d.buckets} series={series} yFormat={yf} unit={metric === "pct" ? "%" : ""} height={280} />;
  }
  const rows = d.buckets
    .map((b, i) => ({
      _key: b,
      ts: b,
      t: d.overall[i].t,
      u: d.overall[i].u,
      p: pct(d.overall[i].u, d.overall[i].t),
      ...Object.fromEntries(d.handles.map((h) => [`h_${h}`, d.byHandle[h][i].u])),
    }))
    .reverse();
  const avg = rows.length ? rows.reduce((a, r) => a + (r.p || 0), 0) / rows.length : 0;
  return (
    <Table
      columns={[
        { key: "ts", label: "Bucket (IST)", align: "left" },
        { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
        { key: "u", label: "U09", render: (r) => fmtNum(r.u) },
        {
          key: "p",
          label: "U09 %",
          render: (r) => fmtPct(r.p, 3),
          style: (r) => badCell(r.p != null && avg ? r.p - avg * 1.2 : null, avg || 1),
        },
        ...d.handles.map((h) => ({
          key: `h_${h}`,
          label: `${h.toUpperCase()} U09`,
          render: (r) => fmtNum(r[`h_${h}`]),
        })),
      ]}
      rows={rows}
    />
  );
}

// 15 fixed colours for the remitter-bank watchlist: the 8 categorical slots, then 7
// extra hues. Colour follows the bank's position in the watchlist, never its rank.
const BANK_COLORS = [...SERIES, "#0ea5e9", "#f472b6", "#a3e635", "#fb923c", "#2dd4bf", "#c084fc", "#facc15"];

function BankBody({ result, view, cfg, flow }) {
  const [q, setQ] = useState("");
  const [showOthers, setShowOthers] = useState(false);
  const [chartAll, setChartAll] = useState(false);
  const d = useMemo(() => shapeBank(result.rows, flow, cfg.bankTopN), [result, flow, cfg.bankTopN]);
  const watch = cfg.remitterBanks || [];
  const byCode = useMemo(() => new Map(d.list.map((b) => [b.bank, b])), [d]);
  const nameOf = (code) => watch.find((w) => w.code === code)?.name;

  if (view === "chart") {
    const present = watch.filter((w) => byCode.has(w.code));
    const series = present.map((w) => {
      const b = byCode.get(w.code);
      return {
        key: w.code,
        label: `${w.code} · ${w.name}`,
        color: BANK_COLORS[watch.indexOf(w) % BANK_COLORS.length],
        values: b.series.map((p) => pct(p.s, p.t)),
        extra: (k) => `(${fmtCompact(b.series[k].t)})`,
      };
    });
    const missing = watch.filter((w) => !byCode.has(w.code));
    return (
      <>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <Seg
            value={chartAll ? "all" : "8"}
            onChange={(v) => setChartAll(v === "all")}
            options={[
              ["8", "First 8"],
              ["all", `All ${present.length}`],
            ]}
          />
          <span style={{ fontSize: 11, color: C.muted }}>Click a legend entry to show / hide a bank.</span>
          {missing.length > 0 && <span style={{ fontSize: 11, color: C.warn }}>⚠ no data in window: {missing.map((w) => w.code).join(", ")}</span>}
        </div>
        <LineChart
          key={chartAll ? "all" : "8"}
          title={`SR — remitter banks (watchlist)${flow !== "ALL" ? ` · ${flow}` : ""}`}
          buckets={d.buckets}
          series={series}
          initialHidden={chartAll ? undefined : series.slice(8).map((x) => x.key)}
          yFormat={(v) => v.toFixed(1)}
          unit="%"
          height={320}
        />
      </>
    );
  }

  const toRow = (b, code, pinned) =>
    b
      ? {
          _key: code,
          code,
          name: nameOf(code),
          pinned,
          vol: b.ALL.t,
          sr: pct(b.ALL.s, b.ALL.t),
          p2p: pct(b.P2P.s, b.P2P.t),
          p2pVol: b.P2P.t,
          p2m: pct(b.P2M.s, b.P2M.t),
          p2mVol: b.P2M.t,
          delta: b.delta,
        }
      : { _key: code, code, name: nameOf(code), pinned, missing: true };
  const watchCodes = new Set(watch.map((w) => w.code));
  const match = (r) => !q || r.code.includes(q.toUpperCase()) || (r.name || "").toLowerCase().includes(q.toLowerCase());
  const rows = [...watch.map((w) => toRow(byCode.get(w.code), w.code, true)), ...(showOthers ? d.list.filter((b) => !watchCodes.has(b.bank)).map((b) => toRow(b, b.bank, false)) : [])].filter(match);
  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter bank (code or name)" style={{ ...selectStyle, width: 220 }} />
        <label
          style={{
            fontSize: 12,
            color: C.text2,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <input type="checkbox" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} /> Also show other banks (
          {Math.max(0, d.list.length - watch.filter((w) => byCode.has(w.code)).length)})
        </label>
      </div>
      <Table
        maxHeight={520}
        columns={[
          {
            key: "code",
            label: "Remitter bank",
            align: "left",
            sortValue: (r) => r.name || r.code,
            render: (r) => (
              <span>
                {r.pinned && (
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      marginRight: 6,
                      background: BANK_COLORS[watch.findIndex((w) => w.code === r.code) % BANK_COLORS.length],
                    }}
                  />
                )}
                <b>{r.name || r.code}</b>
                {r.name && <span style={{ color: C.muted }}> · {r.code}</span>}
              </span>
            ),
          },
          {
            key: "vol",
            label: "Txns",
            render: (r) => (r.missing ? <span style={{ color: C.warn }}>no data in window</span> : fmtNum(r.vol)),
          },
          { key: "sr", label: "Overall SR", render: (r) => fmtPct(r.sr) },
          { key: "p2p", label: "P2P SR", render: (r) => fmtPct(r.p2p) },
          { key: "p2pVol", label: "P2P txns", render: (r) => fmtNum(r.p2pVol) },
          { key: "p2m", label: "P2M SR", render: (r) => fmtPct(r.p2m) },
          { key: "p2mVol", label: "P2M txns", render: (r) => fmtNum(r.p2mVol) },
          {
            key: "delta",
            label: `Δ SR${flow !== "ALL" ? ` (${flow})` : ""}`,
            render: (r) => fmtPp(r.delta),
            style: (r) => ({
              ...badCell(r.delta == null ? null : -r.delta, 3),
              ...goodText(-r.delta),
            }),
          },
        ]}
        rows={rows}
      />
    </>
  );
}

// ─── day-level sections (5–7) ────────────────────────────────────────────────

/** Section 5: wide rows {ts, ptyes, ptaxis, …} → per-handle count / share by day. */
/** what: the split being shared ("payer handle", "OS", …); used in chart titles. */
function ShareBody({ result, view, metric, what = "payer handle" }) {
  const d = useMemo(() => {
    const rows = [...result.rows].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== "ts" && rows.some((r) => Number(r[c]) > 0));
    // Fixed handle order so colours follow the handle, not its rank.
    const order = ["ptyes", "ptaxis", "pthdfc", "ptsbi", "paytm"];
    cols.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const days = rows.map((r) => r.ts);
    const totals = rows.map((r) => cols.reduce((a, c) => a + (Number(r[c]) || 0), 0));
    return { rows, cols, days, totals };
  }, [result]);
  const val = (r, i, c) => (metric === "share" ? pct(Number(r[c]) || 0, d.totals[i]) : Number(r[c]) || 0);
  if (view === "chart") {
    const series = d.cols.map((c, k) => ({
      key: c,
      label: c.toUpperCase(),
      color: SERIES[k % SERIES.length],
      values: d.rows.map((r, i) => val(r, i, c)),
      extra: (i) => (metric === "share" ? `(${fmtCompact(Number(d.rows[i][c]) || 0)})` : `(${fmtPct(pct(Number(d.rows[i][c]) || 0, d.totals[i]))})`),
    }));
    return (
      <>
        <LineChart
          title={metric === "share" ? `% share of Paytm txns by ${what}` : `Txn count by ${what}`}
          buckets={d.days}
          series={series}
          yFormat={metric === "share" ? (v) => v.toFixed(1) : fmtCompact}
          unit={metric === "share" ? "%" : ""}
          height={280}
        />
        {metric === "count" && (
          <LineChart title="Total txns (all handles)" buckets={d.days} series={[{ key: "t", label: "Total", color: SERIES[0], values: d.totals }]} yFormat={fmtCompact} height={150} />
        )}
      </>
    );
  }
  // Table: one row per day, DoD change; a fall in share / count is tinted red.
  const rows = d.rows
    .map((r, i) => {
      const o = {
        _key: r.ts,
        ts: r.ts,
        total: d.totals[i],
        totalDod: i ? pct(d.totals[i] - d.totals[i - 1], d.totals[i - 1]) : null,
      };
      for (const c of d.cols) {
        o[c] = val(r, i, c);
        const prev = i ? val(d.rows[i - 1], i - 1, c) : null;
        o[`${c}_d`] = prev == null ? null : metric === "share" ? o[c] - prev : pct(o[c] - prev, prev);
      }
      return o;
    })
    .reverse();
  const fmtV = metric === "share" ? (v) => fmtPct(v) : fmtNum;
  const fmtD = (v) => (v == null ? "" : metric === "share" ? ` (${v > 0 ? "+" : ""}${v.toFixed(2)} pp)` : ` (${v > 0 ? "+" : ""}${v.toFixed(1)}%)`);
  return (
    <Table
      columns={[
        { key: "ts", label: "Day", align: "left" },
        {
          key: "total",
          label: "Total txns",
          render: (r) => (
            <>
              {fmtNum(r.total)}
              <span style={{ color: C.muted }}>{r.totalDod == null ? "" : ` (${r.totalDod > 0 ? "+" : ""}${r.totalDod.toFixed(1)}%)`}</span>
            </>
          ),
        },
        ...d.cols.map((c) => ({
          key: c,
          label: `${c.toUpperCase()} ${metric === "share" ? "share" : "txns"} (DoD)`,
          render: (r) => (
            <>
              {fmtV(r[c])}
              <span style={{ opacity: 0.85 }}>{fmtD(r[`${c}_d`])}</span>
            </>
          ),
          style: (r) => badCell(r[`${c}_d`] == null ? null : -r[`${c}_d`], metric === "share" ? 1 : 10),
        })),
      ]}
      rows={rows}
    />
  );
}

/** Aggregate day rows into grain periods: key -> group -> {t, s, days:Set}. */
function rollup(rows, grain, groupOf) {
  const periods = new Map();
  for (const r of rows) {
    const g = groupOf(r);
    if (g == null) continue;
    const k = periodKey(r.ts, grain);
    if (!periods.has(k)) periods.set(k, { days: new Set(), groups: {} });
    const p = periods.get(k);
    p.days.add(r.ts);
    const a = (p.groups[g] ||= { t: 0, s: 0 });
    a.t += r.total;
    a.s += r.success;
  }
  const keys = [...periods.keys()].sort();
  return { keys, periods };
}

const GRAIN_NAME = { day: "DoD", week: "WoW", month: "MoM" };

/** groups: optional series list (e.g. sub-flows) instead of P2P / P2M (/ LITE). */
function FlowSrBody({ result, view, grain, lite, groups }) {
  const flows = groups || (lite ? ["P2P", "P2M", "LITE"] : ["P2P", "P2M"]);
  const { keys, periods } = useMemo(() => rollup(result.rows, grain, (r) => r.flow), [result, grain]);
  const sr = (k, f) => {
    const a = periods.get(k).groups[f];
    return a ? pct(a.s, a.t) : null;
  };
  if (view === "chart") {
    const series = flows.map((f, i) => ({
      key: f,
      label: f,
      color: SERIES[i],
      width: 2.5,
      values: keys.map((k) => sr(k, f)),
      extra: (j) => `(${fmtCompact(periods.get(keys[j]).groups[f]?.t || 0)})`,
    }));
    return <LineChart title={`Success rate by flow · ${grain}`} buckets={keys} series={series} yFormat={(v) => v.toFixed(2)} unit="%" height={280} />;
  }
  const expected = grain === "month" ? null : grain === "week" ? 7 : 1;
  const rows = keys
    .map((k, i) => {
      const o = { _key: k, k, days: periods.get(k).days.size };
      o.partial = expected ? o.days < expected : Number(k.slice(5, 7)) && o.days < new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 0)).getUTCDate();
      for (const f of flows) {
        o[f] = sr(k, f);
        o[`${f}_t`] = periods.get(k).groups[f]?.t;
        o[`${f}_d`] = i && o[f] != null && sr(keys[i - 1], f) != null ? o[f] - sr(keys[i - 1], f) : null;
      }
      return o;
    })
    .reverse();
  return (
    <Table
      columns={[
        {
          key: "k",
          label: grain === "month" ? "Month" : grain === "week" ? "Week of" : "Day",
          align: "left",
          render: (r) => (
            <>
              {r.k.replace(/^W /, "")}
              {r.partial ? (
                <span style={{ color: C.warn }} title="Incomplete period">
                  {" "}
                  · {r.days}d
                </span>
              ) : null}
            </>
          ),
        },
        ...flows.flatMap((f) => [
          { key: f, label: `${f} SR`, render: (r) => fmtPct(r[f]) },
          {
            key: `${f}_d`,
            label: `${f} ${GRAIN_NAME[grain]}`,
            render: (r) => fmtPp(r[`${f}_d`]),
            style: (r) => ({
              ...badCell(r[`${f}_d`] == null ? null : -r[`${f}_d`], 1),
              ...goodText(-r[`${f}_d`]),
            }),
          },
          {
            key: `${f}_t`,
            label: `${f} txns`,
            render: (r) => fmtNum(r[`${f}_t`]),
          },
        ]),
      ]}
      rows={rows}
    />
  );
}

const INSTRUMENT_ORDER = ["SAVINGS", "CURRENT", "CREDIT", "CREDITLINE", "Paytm Postpaid", "UPI_LITE", "Others"];

function InstrumentBody({ result, view, grain }) {
  const d = useMemo(() => {
    const found = [...new Set(result.rows.map((r) => r.instrument))];
    const instruments = [...INSTRUMENT_ORDER.filter((x) => found.includes(x)), ...found.filter((x) => !INSTRUMENT_ORDER.includes(x)).sort()];
    const byFlow = Object.fromEntries(
      ["P2P", "P2M"].map((f) => [
        f,
        rollup(
          result.rows.filter((r) => r.flow === f),
          grain,
          (r) => r.instrument,
        ),
      ]),
    );
    return { instruments, byFlow };
  }, [result, grain]);
  const color = (inst) => SERIES[d.instruments.indexOf(inst) % SERIES.length];
  if (view === "chart") {
    return (
      <>
        {["P2P", "P2M"].map((f) => {
          const { keys, periods } = d.byFlow[f];
          // Skip near-empty instruments for this flow (e.g. CREDIT on P2P) — noise, not signal.
          const vol = (inst) => keys.reduce((a, k) => a + (periods.get(k).groups[inst]?.t || 0), 0);
          const totalVol = d.instruments.reduce((a, inst) => a + vol(inst), 0);
          const series = d.instruments
            .filter((inst) => vol(inst) > totalVol * 0.0005)
            .map((inst) => ({
              key: inst,
              label: inst,
              color: color(inst),
              values: keys.map((k) => {
                const a = periods.get(k).groups[inst];
                return a ? pct(a.s, a.t) : null;
              }),
              extra: (j) => `(${fmtCompact(periods.get(keys[j]).groups[inst]?.t || 0)})`,
            }));
          return <LineChart key={f} title={`${f} — success rate by payer instrument · ${grain}`} buckets={keys} series={series} yFormat={(v) => v.toFixed(1)} unit="%" height={260} />;
        })}
      </>
    );
  }
  // Table: instrument × flow over the whole window, Δ = latest period vs previous.
  const rows = d.instruments.map((inst) => {
    const o = { _key: inst, inst };
    for (const f of ["P2P", "P2M"]) {
      const { keys, periods } = d.byFlow[f];
      let t = 0;
      let sc = 0;
      keys.forEach((k) => {
        const a = periods.get(k).groups[inst];
        if (a) {
          t += a.t;
          sc += a.s;
        }
      });
      const at = (k) => (k && periods.get(k).groups[inst] ? pct(periods.get(k).groups[inst].s, periods.get(k).groups[inst].t) : null);
      const last = at(keys[keys.length - 1]);
      const prev = at(keys[keys.length - 2]);
      o[f] = t ? pct(sc, t) : null;
      o[`${f}_t`] = t || null;
      o[`${f}_last`] = last;
      o[`${f}_d`] = last != null && prev != null ? last - prev : null;
    }
    return o;
  });
  return (
    <Table
      columns={[
        {
          key: "inst",
          label: "Payer instrument",
          align: "left",
          render: (r) => (
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: color(r.inst),
                  marginRight: 6,
                }}
              />
              <b>{r.inst}</b>
            </span>
          ),
        },
        ...["P2P", "P2M"].flatMap((f) => [
          { key: f, label: `${f} SR (window)`, render: (r) => fmtPct(r[f]) },
          {
            key: `${f}_last`,
            label: `${f} SR latest ${grain}`,
            render: (r) => fmtPct(r[`${f}_last`]),
          },
          {
            key: `${f}_d`,
            label: `${f} ${GRAIN_NAME[grain]}`,
            render: (r) => fmtPp(r[`${f}_d`]),
            style: (r) => ({
              ...badCell(r[`${f}_d`] == null ? null : -r[`${f}_d`], 2),
              ...goodText(-r[`${f}_d`]),
            }),
          },
          {
            key: `${f}_t`,
            label: `${f} txns`,
            render: (r) => fmtNum(r[`${f}_t`]),
          },
        ]),
      ]}
      rows={rows}
    />
  );
}

/**
 * Sections 8 & 9: success rate per group (payee PSP / payer bank) over time.
 * Chart: top `chartN` groups by volume visible, rest toggle-able. Table: top `topN`
 * groups × periods pivot (latest first) with change vs previous period; drops tinted red.
 */
/** metric: "sr" (default) | "success" (successful txns) | "volume" (attempts) — chart and per-period cells. */
function GroupSrBody({ result, view, groupKey, groupLabel, topN = 25, chartN = 8, metric = "sr" }) {
  const val = (p) => (metric === "success" ? p.s : metric === "volume" ? p.t : pct(p.s, p.t));
  const isSr = metric === "sr";
  const mLabel = { sr: "SR", success: "Successful txns", volume: "Txns" }[metric];
  const d = useMemo(() => {
    const buckets = [...new Set(result.rows.map((r) => r.ts))].sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const groups = new Map();
    for (const r of result.rows) {
      const g = r[groupKey] ?? "(none)";
      if (!groups.has(g))
        groups.set(g, {
          g,
          t: 0,
          s: 0,
          series: buckets.map(() => ({ t: 0, s: 0 })),
        });
      const a = groups.get(g);
      a.t += r.total;
      a.s += r.success;
      const p = a.series[idx.get(r.ts)];
      p.t += r.total;
      p.s += r.success;
    }
    const all = [...groups.values()].sort((a, b) => b.t - a.t);
    const overall = buckets.map((_, i) => all.reduce((acc, a) => ({ t: acc.t + a.series[i].t, s: acc.s + a.series[i].s }), { t: 0, s: 0 }));
    return { buckets, top: all.slice(0, topN), count: all.length, overall };
  }, [result, groupKey, topN]);
  const sameDay = d.buckets.length && d.buckets[0].slice(0, 10) === d.buckets[d.buckets.length - 1].slice(0, 10);

  if (view === "chart") {
    const series = [
      {
        key: "__all",
        label: "Overall",
        color: "#e2e8f0",
        width: 2.5,
        dash: "5 3",
        values: d.overall.map(val),
        extra: (i) => `(${fmtCompact(d.overall[i].t)})`,
      },
      ...d.top.map((a, i) => ({
        key: a.g,
        label: a.g,
        color: SERIES[i % SERIES.length],
        values: a.series.map(val),
        extra: (k) => (isSr ? `(${fmtCompact(a.series[k].t)})` : `(${fmtPct(pct(a.series[k].s, a.series[k].t))})`),
      })),
    ].filter((x) => isSr || x.key !== "__all"); // a total line would dwarf the groups on count metrics
    return (
      <LineChart
        title={`${mLabel} by ${groupLabel} — top ${Math.min(chartN, d.top.length)} by volume shown${d.top.length > chartN ? `, ${d.top.length - chartN} more in legend` : ""}`}
        buckets={d.buckets}
        series={series}
        initialHidden={d.top.slice(chartN).map((a) => a.g)}
        yFormat={isSr ? (v) => v.toFixed(1) : fmtCompact}
        unit={isSr ? "%" : ""}
        height={320}
      />
    );
  }
  const periods = d.buckets.length <= 16 ? [...d.buckets].reverse() : d.buckets.slice(-16).reverse();
  const L = d.buckets.length;
  const rows = d.top.map((a) => {
    const last = L ? pct(a.series[L - 1].s, a.series[L - 1].t) : null;
    const prev = L > 1 ? pct(a.series[L - 2].s, a.series[L - 2].t) : null;
    return {
      _key: a.g,
      g: a.g,
      t: a.t,
      sr: pct(a.s, a.t),
      delta: last != null && prev != null ? last - prev : null,
      a,
    };
  });
  return (
    <>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Top {d.top.length} of {d.count} {groupLabel}s by volume · Δ = latest period vs previous · red cell = SR fell vs previous period
      </div>
      <Table
        maxHeight={480}
        columns={[
          {
            key: "g",
            label: groupLabel,
            align: "left",
            render: (r) => <b>{r.g}</b>,
          },
          { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
          { key: "sr", label: "SR (window)", render: (r) => fmtPct(r.sr) },
          {
            key: "delta",
            label: "Δ latest",
            render: (r) => fmtPp(r.delta),
            style: (r) => ({
              ...badCell(r.delta == null ? null : -r.delta, 2),
              ...goodText(-r.delta),
            }),
          },
          ...periods.map((b) => {
            const i = d.buckets.indexOf(b);
            const at = (r, k) => (k >= 0 && r.a.series[k].t ? val(r.a.series[k]) : null);
            return {
              key: `p_${b}`,
              label: tickLabel(b, sameDay),
              render: (r) => (isSr ? fmtPct(at(r, i)) : fmtNum(at(r, i))),
              sortValue: (r) => at(r, i),
              style: (r) => {
                const cur = at(r, i);
                const prv = at(r, i - 1);
                if (cur == null || prv == null) return {};
                // SR: red when it fell > 0.25pp; counts: red when down > 5% vs the previous period.
                return isSr ? badCell(prv - cur - 0.25, 3) : badCell(prv > 0 ? ((prv - cur) / prv) * 100 - 5 : null, 20);
              },
            };
          }),
        ]}
        rows={rows}
      />
    </>
  );
}

// ─── config page ─────────────────────────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: C.text2,
      }}
    >
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: C.muted }}>{hint}</span>}
    </label>
  );
}

function Panel({ title, children, actions }) {
  return (
    <section
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 15, color: C.text }}>{title}</h2>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {actions}
        </div>
      </div>
      {children}
    </section>
  );
}

function ConfigPage({ state, now, durations, onRun, onStop, onRetryNow, reload }) {
  const cfg = state.config;
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(cfg)));
  const [msg, setMsg] = useState(null);
  const [conn, setConn] = useState(null);
  const [connBusy, setConnBusy] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [history, setHistory] = useState([]);
  const [qSec, setQSec] = useState("raw");
  const [qEngine, setQEngine] = useState("trino");
  const [qInfo, setQInfo] = useState(null);
  const [qEdit, setQEdit] = useState("");

  useEffect(() => setDraft(JSON.parse(JSON.stringify(cfg))), [cfg]);

  const loadHistory = useCallback(
    () =>
      api("/history")
        .then((r) => setHistory(r.history))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    loadHistory();
  }, [loadHistory, state.jobs]);

  const loadSql = useCallback(async () => {
    try {
      const engines = enginesFor(qSec);
      const eng = engines.includes(qEngine) ? qEngine : engines[0];
      const keys = (DURATION_OPTS[qSec] || []).filter((o) => o.kind === (eng === "looker" ? "daily" : "intraday")).map((o) => o.key);
      // Pick a sample window the engine would actually serve.
      const dur = eng === "redash" ? keys[0] : keys[keys.length - 1] || "";
      const info = await api(`/sql?section=${qSec}&duration=${dur}&engine=${eng}`);
      setQInfo(info);
      setQEdit(info.template);
    } catch (e) {
      setQInfo({ rendered: `-- ${e.message}` });
    }
  }, [qSec, qEngine]);
  useEffect(() => {
    loadSql();
  }, [loadSql, cfg]);

  const save = async (patch) => {
    setMsg(null);
    try {
      await api("/config", { method: "PUT", body: patch });
      setMsg({ ok: true, text: "Saved." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const testConn = async () => {
    setConnBusy(true);
    try {
      setConn(await api("/connectivity"));
    } catch (e) {
      setConn({ error: e.message });
    } finally {
      setConnBusy(false);
    }
  };
  const checkFresh = async () => {
    setFresh({ loading: true });
    try {
      setFresh(await api("/freshness"));
    } catch (e) {
      setFresh({ error: e.message });
    }
  };

  const set = (path, value) =>
    setDraft((d) => {
      const n = JSON.parse(JSON.stringify(d));
      const keys = path.split(".");
      let o = n;
      keys.slice(0, -1).forEach((k) => (o = o[k] ||= {}));
      o[keys[keys.length - 1]] = value;
      return n;
    });

  const input = { ...selectStyle, padding: "6px 8px" };
  const numField = (path, label, hint) => {
    const v = path.split(".").reduce((o, k) => o?.[k], draft);
    return (
      <Field label={label} hint={hint}>
        <input type="number" style={input} value={v ?? ""} onChange={(e) => set(path, e.target.value === "" ? "" : Number(e.target.value))} />
      </Field>
    );
  };

  const connRow = (name, c) =>
    c ? (
      <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
        <b style={{ color: c.ok ? C.good : C.bad }}>{c.ok ? "✓ Connected" : "✕ Not OK"}</b> · <b>{name}</b> {c.host ? `(${c.host})` : ""} · {c.latencyMs} ms
        {c.error && <div style={{ color: "#fecaca", marginTop: 2 }}>{c.error}</div>}
        {c.dataSources && (
          <div style={{ color: C.text2, marginTop: 2 }}>Data sources: {c.dataSources.map((d) => `${d.id} ${d.found ? `= ${d.name}${d.paused ? " (paused)" : ""}` : "(not found)"}`).join(", ")}</div>
        )}
      </div>
    ) : null;

  return (
    <div>
      <Panel
        title="Query control"
        actions={
          <>
            <button type="button" style={btn("primary")} onClick={() => onRun(SECTION_IDS)}>
              ⟳ Refresh all
            </button>
            <button type="button" style={btn("danger")} onClick={() => onStop(SECTION_IDS)}>
              ■ Stop all
            </button>
          </>
        }
      >
        <Table
          maxHeight={300}
          columns={[
            {
              key: "id",
              label: "Section",
              align: "left",
              render: (r) => SECTION_TITLES[r.id],
            },
            {
              key: "status",
              label: "Status",
              align: "left",
              render: (r) => <StatusChip job={r.job} now={now} />,
            },
            {
              key: "dur",
              label: "Duration",
              render: (r) => labelFor(r.job.duration || durations[r.id]),
            },
            {
              key: "eng",
              label: "Engine",
              render: (r) => r.job.engine || engineFor(durations[r.id], cfg, r.id),
            },
            {
              key: "att",
              label: "Attempt",
              render: (r) => r.job.attempt || "—",
            },
            {
              key: "last",
              label: "Last success",
              render: (r) => fmtTime(state.results[r.id]?.ranAt),
            },
            {
              key: "act",
              label: "",
              render: (r) => (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {r.job.status === "retry-wait" && (
                    <button type="button" style={btn()} onClick={() => onRetryNow(r.id)}>
                      Retry now
                    </button>
                  )}
                  {ACTIVE.has(r.job.status) ? (
                    <button type="button" style={btn("danger")} onClick={() => onStop([r.id])}>
                      Stop
                    </button>
                  ) : (
                    <button type="button" style={btn()} onClick={() => onRun([r.id])}>
                      Refresh
                    </button>
                  )}
                </span>
              ),
            },
          ]}
          rows={SECTION_IDS.map((id) => ({
            _key: id,
            id,
            job: state.jobs[id] || {},
          }))}
        />
        {SECTION_IDS.some((id) => state.jobs[id]?.error) && (
          <div style={{ fontSize: 12, color: "#fecaca" }}>
            {SECTION_IDS.filter((id) => state.jobs[id]?.error).map((id) => (
              <div key={id}>
                <b>{id}:</b> {state.jobs[id].error}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            style={btn()}
            onClick={async () => {
              if (window.confirm("Clear all cached dashboard results? Sections will be empty until refreshed.")) {
                await api("/cache/clear", { method: "POST" });
                reload();
              }
            }}
          >
            Clear cached results
          </button>
        </div>
      </Panel>

      <SchedulePanel cfg={cfg} schedule={state.schedule} reload={reload} />

      <Panel
        title="Connectivity"
        actions={
          <>
            <button type="button" style={btn()} onClick={testConn} disabled={connBusy}>
              {connBusy ? "Testing…" : "Test connections"}
            </button>
            <button type="button" style={btn()} onClick={checkFresh}>
              Check DWH freshness
            </button>
          </>
        }
      >
        {!conn && !fresh && <div style={{ fontSize: 12, color: C.muted }}>Not checked yet.</div>}
        {conn?.error && <div style={{ color: "#fecaca", fontSize: 12 }}>{conn.error}</div>}
        {connRow("Trino (DWH)", conn?.trino)}
        {connRow("Redash", conn?.redash)}
        {conn?.redash?.available && (
          <details style={{ fontSize: 11, color: C.text2 }}>
            <summary style={{ cursor: "pointer" }}>Available Redash data sources</summary>
            {conn.redash.available.map((d) => `${d.id}: ${d.name} (${d.type})`).join(" · ")}
          </details>
        )}
        {fresh && (
          <div style={{ fontSize: 12, color: C.text, marginTop: 8 }}>
            {fresh.loading ? (
              "Checking DWH freshness…"
            ) : fresh.error ? (
              <span style={{ color: "#fecaca" }}>{fresh.error}</span>
            ) : (
              <>
                DWH latest txn: <b>{fresh.trinoMaxCreatedOn || "none"}</b> · now (IST) {fresh.nowIst} — buckets after the latest txn will read low on Trino.
              </>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="Settings"
        actions={
          <>
            <button
              type="button"
              style={btn()}
              onClick={async () => {
                if (window.confirm("Reset all settings (including SQL overrides) to defaults?")) {
                  await api("/config/reset", { method: "POST" });
                  reload();
                }
              }}
            >
              Reset defaults
            </button>
            <button
              type="button"
              style={btn("primary")}
              onClick={() =>
                save({
                  ...draft,
                  remitterBanks:
                    typeof draft.remitterBanks === "string"
                      ? draft.remitterBanks
                          .split("\n")
                          .map((l) => l.trim())
                          .filter(Boolean)
                          .map((l) => {
                            const [code, ...rest] = l.split("=");
                            return {
                              code: code.trim().toUpperCase(),
                              name: rest.join("=").trim() || code.trim().toUpperCase(),
                            };
                          })
                      : draft.remitterBanks,
                  handles: (Array.isArray(draft.handles) ? draft.handles : String(draft.handles).split(",")).map((h) => h.trim().toLowerCase()).filter(Boolean),
                  redash: {
                    ...draft.redash,
                    dataSourceIds: (Array.isArray(draft.redash.dataSourceIds) ? draft.redash.dataSourceIds : String(draft.redash.dataSourceIds).split(","))
                      .map((n) => Number(String(n).trim()))
                      .filter((n) => n > 0),
                  },
                })
              }
            >
              Save settings
            </button>
          </>
        }
      >
        {msg && (
          <div
            style={{
              fontSize: 12,
              marginBottom: 10,
              color: msg.ok ? C.good : "#fecaca",
            }}
          >
            {msg.text}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
            gap: 14,
          }}
        >
          <Field label="Payer handles" hint="Comma-separated">
            <input style={input} value={Array.isArray(draft.handles) ? draft.handles.join(", ") : draft.handles} onChange={(e) => set("handles", e.target.value)} />
          </Field>
          <Field label="Default duration">
            <select style={input} value={draft.defaultDuration} onChange={(e) => set("defaultDuration", e.target.value)}>
              {Object.entries(DURATION_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {SECTION_IDS.map((id) => (
            <Field
              key={id}
              label={`${SECTION_TITLES[id]} — duration`}
              hint={hasKind(id, "daily") ? (hasKind(id, "intraday") ? "≤ 1 day: raw txns · > 1 day: Looker daily" : "Looker daily (Trino)") : "Blank = default duration"}
            >
              <select style={input} value={draft.sectionDurations?.[id] || ""} onChange={(e) => set(`sectionDurations.${id}`, e.target.value || undefined)}>
                <option value="">(default)</option>
                {Object.entries(durationLabels(id)).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {numField("redashMaxMinutes", "Redash up to (minutes)", "Windows ≤ this use Redash (live), longer use Trino")}
          {numField("maxParallel", "Parallel queries", "Sections run at once")}
          <Field label="Auto-retry failed queries" hint="Failed sections re-run one at a time from a queue">
            <select style={input} value={draft.autoRetry ? "1" : "0"} onChange={(e) => set("autoRetry", e.target.value === "1")}>
              <option value="1">On</option>
              <option value="0">Off</option>
            </select>
          </Field>
          {numField("maxRetries", "Max retries")}
          {numField("retryDelaySec", "Retry delay (s)")}
          {numField("trinoTimeoutSec", "Trino timeout (s)")}
          {numField("redashTimeoutSec", "Redash timeout per chunk (s)")}
          <Field label="Redash URL" hint="Blank = PTYES_REDASH_URL. API key comes from .env (never stored here)">
            <input style={input} value={draft.redash?.url || ""} placeholder="(from PTYES_REDASH_URL)" onChange={(e) => set("redash.url", e.target.value)} />
          </Field>
          <Field label="Redash data source IDs" hint="Comma-separated; results from all are summed (shards)">
            <input
              style={input}
              value={Array.isArray(draft.redash?.dataSourceIds) ? draft.redash.dataSourceIds.join(", ") : draft.redash?.dataSourceIds}
              onChange={(e) => set("redash.dataSourceIds", e.target.value)}
            />
          </Field>
          {numField("redash.chunkMinutes", "Redash chunk (min)", "Window split into chunks to stay under Redash timeouts")}
          {numField("redash.chunkParallel", "Redash chunks in parallel", "Keep low — live switch DB")}
          {numField("redashEndLagMinutes", "Redash end lag (min)", "Skip newest minutes so PENDING txns settle")}
          <Field label="Error code column">
            <select style={input} value={draft.errorColumn} onChange={(e) => set("errorColumn", e.target.value)}>
              <option value="app_resp_code">app_resp_code</option>
              <option value="npci_resp_code">npci_resp_code</option>
            </select>
          </Field>
          <Field label="Error code grouping" hint="Prefix: U30-Z9 → U30">
            <select style={input} value={draft.errorGrouping} onChange={(e) => set("errorGrouping", e.target.value)}>
              <option value="full">Full code</option>
              <option value="prefix">Prefix only</option>
            </select>
          </Field>
          {numField("errorTopN", "Top N error codes")}
          <Field label="U09 match (SQL LIKE)" hint="Matches app_resp_code or npci_resp_code">
            <input style={input} value={draft.u09Pattern} onChange={(e) => set("u09Pattern", e.target.value)} />
          </Field>
          {numField("bankTopN", "Banks in trend chart")}
          <Field label="Section 4 remitter banks" hint="One per line: IFSC prefix = name (e.g. SBIN = State Bank of India)">
            <textarea
              style={{
                ...input,
                minHeight: 150,
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 11,
              }}
              value={typeof draft.remitterBanks === "string" ? draft.remitterBanks : (draft.remitterBanks || []).map((b) => `${b.code} = ${b.name}`).join("\n")}
              onChange={(e) => set("remitterBanks", e.target.value)}
            />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: C.text2,
              marginBottom: 6,
            }}
          >
            Bucket size per duration (minutes)
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {Object.keys(DURATION_LABELS).map((k) => (
              <label
                key={k}
                style={{
                  fontSize: 11,
                  color: C.text2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                {DURATION_LABELS[k]}
                <input type="number" style={{ ...input, width: 70 }} value={draft.bucketMinutes?.[k] ?? ""} onChange={(e) => set(`bucketMinutes.${k}`, Number(e.target.value))} />
              </label>
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="Queries"
        actions={
          <>
            <select style={selectStyle} value={qSec} onChange={(e) => setQSec(e.target.value)}>
              {SECTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {SECTION_TITLES[id]}
                </option>
              ))}
            </select>
            {enginesFor(qSec).length === 1 ? (
              <span style={{ fontSize: 12, color: C.text2 }}>{ENGINE_NAME[enginesFor(qSec)[0]]} only</span>
            ) : (
              <Seg value={enginesFor(qSec).includes(qEngine) ? qEngine : enginesFor(qSec)[0]} onChange={setQEngine} options={enginesFor(qSec).map((e) => [e, ENGINE_NAME[e]])} />
            )}
          </>
        }
      >
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
          Template {qInfo?.overridden ? <b style={{ color: C.warn }}>(custom override)</b> : "(default)"}. Placeholders:{" "}
          {"{{FROM}} {{TO}} {{FROM_DATE}} {{FROM_PAD}} {{TO_PAD}} {{BUCKET}} {{HANDLES}} {{ERROR_COL}} {{U09_PATTERN}}"}
          {qInfo?.engine === "looker" ? " {{TO_DATE}} (exclusive)" : ""}
          {qInfo?.engine === "redash" ? " {{TI_ID_FROM}} {{TI_ID_TO}} {{TP_ID_FROM}} {{TP_ID_TO}}" : ""}. Output columns must stay the same.
        </div>
        <textarea
          value={qEdit}
          onChange={(e) => setQEdit(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%",
            minHeight: 260,
            background: "#020617",
            color: "#cbd5e1",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: 10,
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 11,
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 8,
            margin: "8px 0 12px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            style={btn("primary")}
            onClick={() =>
              save({
                sqlOverrides: {
                  ...(cfg.sqlOverrides || {}),
                  [qSec]: {
                    ...(cfg.sqlOverrides?.[qSec] || {}),
                    [qInfo?.engine || qEngine]: qEdit,
                  },
                },
              })
            }
          >
            Save override
          </button>
          <button
            type="button"
            style={btn()}
            onClick={() => {
              const next = JSON.parse(JSON.stringify(cfg.sqlOverrides || {}));
              if (next[qSec]) delete next[qSec][qInfo?.engine || qEngine];
              save({ sqlOverrides: next });
            }}
          >
            Reset to default
          </button>
        </div>
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: C.text2 }}>
            Rendered SQL ({qInfo?.duration} sample window
            {qInfo?.window ? `: ${qInfo.window.from} → ${qInfo.window.to}` : ""})
          </summary>
          <pre
            style={{
              background: "#020617",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: 10,
              fontSize: 11,
              color: "#cbd5e1",
              whiteSpace: "pre-wrap",
              maxHeight: 320,
              overflow: "auto",
            }}
          >
            {qInfo?.note ? `-- ${qInfo.note}\n` : ""}
            {qInfo?.rendered}
          </pre>
        </details>
      </Panel>

      <Panel
        title="Run history"
        actions={
          <button type="button" style={btn()} onClick={loadHistory}>
            Reload
          </button>
        }
      >
        <Table
          maxHeight={320}
          empty="No runs since backend start"
          columns={[
            {
              key: "at",
              label: "Finished",
              align: "left",
              render: (r) => fmtTime(r.at),
            },
            { key: "section", label: "Section", align: "left" },
            {
              key: "trigger",
              label: "Trigger",
              align: "left",
              render: (r) => r.trigger || "manual",
            },
            { key: "engine", label: "Engine", align: "left" },
            { key: "duration", label: "Duration", align: "left" },
            { key: "attempt", label: "Attempt" },
            {
              key: "status",
              label: "Status",
              align: "left",
              render: (r) => (
                <span
                  style={{
                    color: r.status === "success" ? C.good : r.status === "cancelled" ? C.warn : C.bad,
                  }}
                >
                  {r.status}
                </span>
              ),
            },
            {
              key: "elapsedMs",
              label: "Took",
              render: (r) => fmtDur(r.elapsedMs),
            },
            { key: "rows", label: "Rows", render: (r) => r.rows ?? "—" },
            {
              key: "error",
              label: "Error",
              align: "left",
              render: (r) => (
                <span title={r.error} style={{ color: "#fecaca" }}>
                  {r.error ? r.error.slice(0, 80) : ""}
                </span>
              ),
            },
          ]}
          rows={history.map((h, i) => ({ ...h, _key: i }))}
        />
      </Panel>
    </div>
  );
}

function SchedulePanel({ cfg, schedule, reload }) {
  const [draft, setDraft] = useState(() => JSON.parse(JSON.stringify(cfg.schedule || {})));
  const [msg, setMsg] = useState(null);
  useEffect(() => setDraft(JSON.parse(JSON.stringify(cfg.schedule || {}))), [cfg.schedule]);
  const input = { ...selectStyle, padding: "5px 8px" };
  const setRule = (id, patch) =>
    setDraft((d) => ({
      ...d,
      rules: {
        ...(d.rules || {}),
        [id]: { ...(d.rules?.[id] || {}), ...patch },
      },
    }));
  const save = async () => {
    setMsg(null);
    try {
      await api("/config", { method: "PUT", body: { schedule: draft } });
      setMsg({ ok: true, text: "Schedule saved." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  return (
    <Panel
      title="Refresh schedule"
      actions={
        <button type="button" style={btn("primary")} onClick={save}>
          Save schedule
        </button>
      }
    >
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
        Runs on the backend (IST) with each section&apos;s default duration — opening the page never runs a query. Redash windows are never scheduled. A manual run with another duration stays until
        the next slot / interval.
      </div>
      {msg && (
        <div
          style={{
            fontSize: 12,
            marginBottom: 8,
            color: msg.ok ? C.good : "#fecaca",
          }}
        >
          {msg.text}
        </div>
      )}
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
          fontSize: 12,
          color: C.text2,
        }}
      >
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={Boolean(draft.enabled)} onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} /> Enabled
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Interval runs between
          <input
            style={{ ...input, width: 64 }}
            value={draft.activeHours?.[0] || ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                activeHours: [e.target.value, d.activeHours?.[1] || "23:00"],
              }))
            }
          />
          and
          <input
            style={{ ...input, width: 64 }}
            value={draft.activeHours?.[1] || ""}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                activeHours: [d.activeHours?.[0] || "07:00", e.target.value],
              }))
            }
          />
        </label>
      </div>
      <Table
        maxHeight={420}
        columns={[
          {
            key: "id",
            label: "Section",
            align: "left",
            render: (r) => SECTION_TITLES[r.id],
          },
          {
            key: "type",
            label: "Rule",
            align: "left",
            render: (r) => (
              <select
                style={input}
                value={r.rule.type || "off"}
                onChange={(e) =>
                  setRule(
                    r.id,
                    e.target.value === "daily"
                      ? { type: "daily", at: r.rule.at || ["08:00"] }
                      : e.target.value === "interval"
                        ? { type: "interval", everyMin: r.rule.everyMin || 60 }
                        : { type: "off" },
                  )
                }
              >
                <option value="off">Manual only</option>
                <option value="daily">Daily at…</option>
                <option value="interval">Every N min</option>
              </select>
            ),
          },
          {
            key: "val",
            label: "Times / minutes",
            align: "left",
            render: (r) =>
              r.rule.type === "daily" ? (
                <input
                  style={{ ...input, width: 140 }}
                  value={(r.rule.at || []).join(", ")}
                  onChange={(e) =>
                    setRule(r.id, {
                      at: e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                />
              ) : r.rule.type === "interval" ? (
                <input type="number" style={{ ...input, width: 80 }} value={r.rule.everyMin ?? ""} onChange={(e) => setRule(r.id, { everyMin: Number(e.target.value) })} />
              ) : (
                <span style={{ color: C.muted }}>—</span>
              ),
          },
          {
            key: "next",
            label: "Status",
            align: "left",
            render: (r) => <span style={{ color: C.text2 }}>{scheduleText(schedule?.[r.id]) || "—"}</span>,
          },
        ]}
        rows={SECTION_IDS.map((id) => ({
          _key: id,
          id,
          rule: draft.rules?.[id] || { type: "off" },
        }))}
      />
    </Panel>
  );
}

// ─── unified extras: sub-flow, escalation summary, U09 by payee PSP, merchants ──

const SUBFLOW_ORDER = ["VPA2VPA", "VPA2ACCOUNT", "Paytm QR", "3P QR", "Intent", "ONUS", "P2M Collect", "Other P2M", "Lite Recurring top-up", "Lite Initial top-up"];
const subOrder = (names) => [...names].sort((a, b) => (SUBFLOW_ORDER.indexOf(a) + 1 || 99) - (SUBFLOW_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

/** Intraday P2P split by txn category (raw txns have no P2M sub-type). rows: { ts, cat, total, success }. */
function SubFlowIntraday({ rows }) {
  const d = useMemo(() => {
    const buckets = [...new Set(rows.map((r) => r.ts))].sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const cats = {};
    for (const r of rows) {
      const c = (cats[r.cat] ||= buckets.map(() => ({ t: 0, s: 0 })));
      c[idx.get(r.ts)].t += r.total;
      c[idx.get(r.ts)].s += r.success;
    }
    return { buckets, cats };
  }, [rows]);
  const names = subOrder(Object.keys(d.cats));
  if (!names.length) return null;
  const series = names.map((c, i) => ({
    key: c,
    label: c,
    color: SERIES[i % SERIES.length],
    width: 2,
    values: d.cats[c].map((p) => pct(p.s, p.t)),
    extra: (k) => `(${fmtCompact(d.cats[c][k].t)})`,
  }));
  const tot = names.map((c) => {
    const a = d.cats[c].reduce((x, p) => ({ t: x.t + p.t, s: x.s + p.s }), { t: 0, s: 0 });
    return { _key: c, c, t: a.t, sr: pct(a.s, a.t) };
  });
  return (
    <div style={{ marginTop: 12 }}>
      <LineChart title="P2P sub-flow SR (txn category) · intraday" buckets={d.buckets} series={series} yFormat={(v) => v.toFixed(1)} unit="%" height={220} />
      <Table
        maxHeight={160}
        columns={[
          { key: "c", label: "P2P sub-flow", align: "left", render: (r) => <b>{r.c}</b> },
          { key: "t", label: "Txns (window)", render: (r) => fmtNum(r.t) },
          { key: "sr", label: "SR (window)", render: (r) => fmtPct(r.sr) },
        ]}
        rows={tot}
      />
    </div>
  );
}

/** Docked "what needs escalating" panel. items: [{ key, title, detail, party, level }]. */
function DockedSummary({ title, items, empty, onOpen }) {
  const color = { P1: "#ef4444", P2: "#f97316", watch: "#fab219", info: "#38bdf8" };
  return (
    <div
      style={{
        position: "sticky",
        top: 128,
        zIndex: 4,
        background: "#0c1626",
        border: `1px solid ${items.length ? "#7c2d12" : C.border}`,
        borderRadius: 8,
        padding: "8px 12px",
        marginBottom: 10,
        boxShadow: "0 4px 12px rgba(0,0,0,.35)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, fontWeight: 700, color: C.text }}>
        📌 {title}
        <span style={{ fontWeight: 400, color: C.muted }}>{items.length ? `${items.length} to look at` : ""}</span>
        {onOpen && items.length > 0 && (
          <button type="button" style={{ ...btn(), marginLeft: "auto", padding: "2px 8px" }} onClick={onOpen}>
            Draft emails in K →
          </button>
        )}
      </div>
      {items.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
          {items.map((i) => (
            <div key={i.key} style={{ fontSize: 12, color: C.text2, display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: color[i.level] || C.text2, fontWeight: 700, minWidth: 64 }}>{i.levelLabel}</span>
              <b style={{ color: C.text }}>{i.title}</b>
              <span>{i.detail}</span>
              <span style={{ marginLeft: "auto", color: "#fde68a", whiteSpace: "nowrap" }}>→ {i.party}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{empty}</div>
      )}
    </div>
  );
}

// Who owns a Looker decline type (error_type_1). BD = customer-side: never escalated.
const TYPE_OWNER = {
  "TD Bank": "Payer / remitter bank",
  "RD - Bank": "Payer / remitter bank",
  "TD PSP": "Payee PSP",
  "RD NPCI": "NPCI",
  "TD - others": "NPCI",
  "RD Internal": "Internal (Paytm TPAP)",
};

/**
 * Codes whose share of txns rose in the recent half of the window, owned by a bank / PSP /
 * NPCI (technical or risk declines). rows: { ts, code, cnt } incl. __NONFAIL__; types: code → { etype, etype1 }.
 */
function risingCodes(rows, types, { minShare = 0.02, minDelta = 0.01 } = {}) {
  const buckets = [...new Set(rows.map((r) => r.ts))].sort();
  if (buckets.length < 2) return [];
  const mid = buckets[Math.floor(buckets.length / 2)];
  const tot = { e: 0, r: 0 };
  const by = {};
  for (const r of rows) {
    const h = r.ts < mid ? "e" : "r";
    tot[h] += r.cnt;
    if (r.code === "__NONFAIL__") continue;
    const a = (by[r.code] ||= { e: 0, r: 0 });
    a[h] += r.cnt;
  }
  return Object.entries(by)
    .map(([code, a]) => {
      const e = pct(a.e, tot.e);
      const rr = pct(a.r, tot.r);
      const t = types[code] || {};
      return { code, early: e, recent: rr, delta: rr != null && e != null ? rr - e : null, n: a.r, etype: t.etype || "", etype1: t.etype1 || "", owner: TYPE_OWNER[t.etype1] };
    })
    .filter((c) => c.owner && c.delta != null && c.delta >= minDelta && c.recent >= minShare)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 6);
}

/** U09 by payee PSP (from the payer-bank raw query). rows: { ts, psp, total, u09 }. */
/** Every payee handle on its own (ybl / ibl / axl, okaxis / okicici / …), top 15 by U09. flow: ALL | P2P | P2M. */
function U09PspBody({ result, view, metric, flow = "ALL" }) {
  const pspMode = "handle";
  const d = useMemo(() => {
    const rows = (result?.rows || []).filter((r) => r.grp === "psp" && (flow === "ALL" || r.flow === flow));
    const buckets = [...new Set(rows.map((r) => r.ts))].sort();
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const g = {};
    for (const r of rows) {
      const k = pspGroup(r.psp, pspMode);
      const a = (g[k] ||= { k, t: 0, u: 0, series: buckets.map(() => ({ t: 0, u: 0 })) });
      a.t += r.total;
      a.u += r.u09;
      a.series[idx.get(r.ts)].t += r.total;
      a.series[idx.get(r.ts)].u += r.u09;
    }
    return { buckets, list: Object.values(g).sort((a, b) => b.u - a.u) };
  }, [result, flow]);
  if (!d.list.length) return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>No payee-PSP U09 data yet — it comes from F&apos;s intraday payer-bank query (refresh F · Intraday).</div>;
  const val = (p) => (metric === "pct" ? pct(p.u, p.t) : p.u);
  if (view === "chart") {
    const top = d.list.slice(0, 15);
    return (
      <LineChart
        title={`U09 by payee PSP · ${metric === "pct" ? "% of txns to that PSP" : "count"} · top ${top.length} by U09`}
        buckets={d.buckets}
        series={top.map((a, i) => ({ key: a.k, label: pspParent(a.k) ? `${a.k} · ${pspParent(a.k)}` : a.k, color: BANK_COLORS[i % BANK_COLORS.length], values: a.series.map(val) }))}
        yFormat={metric === "pct" ? (v) => v.toFixed(2) : fmtCompact}
        unit={metric === "pct" ? "%" : ""}
        height={280}
      />
    );
  }
  return (
    <Table
      maxHeight={420}
      columns={[
        {
          key: "k",
          label: "Payee PSP (handle)",
          align: "left",
          render: (r) => (
            <span>
              <b>{r.k}</b>
              {pspParent(r.k) ? <span style={{ color: C.muted }}> · {pspParent(r.k)}</span> : null}
            </span>
          ),
        },
        { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
        { key: "u", label: "U09", render: (r) => fmtNum(r.u) },
        { key: "p", label: "U09 % of txns", render: (r) => fmtPct(r.p, 3) },
        { key: "s", label: "Share of all U09", render: (r) => fmtPct(r.s) },
      ]}
      rows={d.list.map((a) => ({
        _key: a.k,
        k: a.k,
        t: a.t,
        u: a.u,
        p: pct(a.u, a.t),
        s: pct(
          a.u,
          d.list.reduce((x, b) => x + b.u, 0),
        ),
      }))}
    />
  );
}


/**
 * Merchants & MCC (raw, yesterday vs the day before, P2M): SR by payee MCC, and the most
 * impacted merchants — lost txns = max(0, SR D-1 − SR yesterday) × yesterday's volume.
 */
function MerchantsBody({ result }) {
  const [what, setWhat] = useState("merchant");
  const d = useMemo(() => {
    const rows = result?.rows || [];
    const days = [...new Set(rows.map((r) => r.ts))].sort();
    const y = days[days.length - 1];
    const d1 = days[days.length - 2];
    const build = (grp, keyOf) => {
      const m = {};
      for (const r of rows) {
        if (r.grp !== grp) continue;
        if (grp === "mcc" && r.flow && r.flow !== "P2M") continue; // MCC view is P2M (P2P payees have no MCC)
        const k = keyOf(r);
        const a = (m[k] ||= { k, name: r.name, mcc: r.mcc, y: { t: 0, s: 0 }, d1: { t: 0, s: 0 } });
        const b = r.ts === y ? a.y : r.ts === d1 ? a.d1 : null;
        if (!b) continue;
        b.t += r.total;
        b.s += r.success;
        if (r.name && !a.name) a.name = r.name;
      }
      return Object.values(m)
        .filter((a) => a.y.t > 0)
        .map((a) => {
          const srY = pct(a.y.s, a.y.t);
          const srD1 = pct(a.d1.s, a.d1.t);
          const lost = srY != null && srD1 != null ? Math.max(0, ((srD1 - srY) / 100) * a.y.t) : null;
          return { _key: a.k, ...a, fails: a.y.t - a.y.s, srY, srD1, dsr: srY != null && srD1 != null ? srY - srD1 : null, lost };
        });
    };
    return {
      y,
      d1,
      mcc: build("mcc", (r) => r.mcc).sort((a, b) => b.fails - a.fails),
      merchant: build("merchant", (r) => r.vpa).sort((a, b) => (b.lost || 0) - (a.lost || 0) || b.fails - a.fails),
    };
  }, [result]);
  if (!result) return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>Merchant / MCC data runs daily at 13:15 (raw txns) — press Refresh on this card&apos;s section to run it now.</div>;
  const isM = what === "merchant";
  const rows = (isM ? d.merchant : d.mcc).slice(0, isM ? 50 : 25);
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>
          P2M merchants & MCC — {d.y} vs {d.d1}
        </b>
        <Seg
          value={what}
          onChange={setWhat}
          options={[
            ["merchant", "Top impacted merchants"],
            ["mcc", "By MCC"],
          ]}
        />
        <span style={{ fontSize: 11, color: C.muted }}>
          raw txns, all 4 TPAP handles · {isM ? "merchants with ≥20 failures that day, ranked by lost txns vs the day before" : "top 25 MCCs by failures"} · as of {fmtTime(result.ranAt)}
        </span>
      </div>
      <Table
        maxHeight={460}
        columns={[
          isM
            ? {
                key: "k",
                label: "Merchant (payee VPA)",
                align: "left",
                render: (r) => (
                  <span>
                    <b>{r.name || r.k}</b>
                    <div style={{ fontSize: 11, color: C.muted }}>
                      {r.k} · MCC {r.mcc}
                      {mccName(r.mcc) ? ` ${mccName(r.mcc)}` : ""}
                    </div>
                  </span>
                ),
              }
            : {
                key: "k",
                label: "MCC",
                align: "left",
                render: (r) => (
                  <span>
                    <b>{r.k}</b>
                    {mccName(r.k) ? <span style={{ color: C.muted }}> · {mccName(r.k)}</span> : null}
                  </span>
                ),
              },
          { key: "yt", label: "Txns", sortValue: (r) => r.y.t, render: (r) => fmtNum(r.y.t) },
          { key: "srY", label: "SR", render: (r) => fmtPct(r.srY) },
          { key: "srD1", label: "SR D-1", render: (r) => fmtPct(r.srD1) },
          { key: "dsr", label: "Δ SR", render: (r) => fmtPp(r.dsr), style: (r) => ({ ...badCell(r.dsr == null ? null : -r.dsr, 5), ...goodText(-r.dsr) }) },
          { key: "fails", label: "Failures", render: (r) => fmtNum(r.fails) },
          { key: "lost", label: "Lost txns vs D-1", render: (r) => (r.lost > 0.5 ? fmtNum(r.lost) : "—") },
        ]}
        rows={rows}
      />
    </div>
  );
}

// ─── F · payer (remitter) bank report ────────────────────────────────────────
// Section "bankrep" (Looker, since the 1st of last month). Contribution splits the overall SR
// change across banks exactly: c_i = w_now·SR_now − w_base·SR_base (w = share of attempts), so the
// bank contributions add up to the overall change. Same split inside a bank for its flows,
// handles, OS and instruments.

const HEALTH = {
  critical: { label: "Critical", color: "#ef4444", bg: "rgba(239,68,68,.14)" },
  watch: { label: "Watch", color: "#fab219", bg: "rgba(250,178,25,.12)" },
  stable: { label: "Stable", color: "#94a3b8", bg: "transparent" },
  improving: { label: "Improving", color: "#22c55e", bg: "rgba(34,197,94,.10)" },
};
const inRange = (ts, [a, b]) => ts >= a && ts <= b;
const nDays = ([a, b]) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

function HealthTag({ h, day1, streak }) {
  const x = HEALTH[h];
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: x.color, border: `1px solid ${x.color}66`, borderRadius: 999, padding: "1px 8px", background: x.bg }}>{x.label}</span>
      {day1 && (
        <span style={{ fontSize: 10, color: "#ef4444", marginLeft: 4 }} title="Critical-level drop, first day — becomes Critical if it repeats tomorrow">
          day 1 of critical
        </span>
      )}
      {streak > 1 && <span style={{ fontSize: 10, color: C.muted, marginLeft: 4 }}>{streak} days</span>}
    </span>
  );
}

// D: the two biggest customer-side codes (insufficient funds, wrong PIN) can be hidden from the trend.
const HIDE_CUSTOMER_CODES = new Set(["U30-Z9", "U30-ZM"]);

// Customer-side declines and NPCI policy caps: shown in spikes only on request (nothing to escalate).
const SPIKE_POLICY = new Set(["U16-00972", "U16-01128", "U16-01129"]);
const notEscalatable = (c) => c.ctype === "BD" || SPIKE_POLICY.has(c.code);

function BankReport({ result, cfg, handleSel, flowSel, pbankRows = [], live, onRunLive, onToggleLive, dwhLive, onRunDwh, onToggleDwh, onEscalate, notes = [] }) {
  const [showV1, setShowV1] = useState(false);
  const [spikeAll, setSpikeAll] = useState(false);
  const [compare, setCompare] = useState("yday"); // yday: yesterday vs L7D avg · mtd: MTD vs LMTD
  const [tab, setTab] = useState("score");
  const [healthSel, setHealthSel] = useState("all");
  const [bank, setBank] = useState(null);
  // The deep-dive renders above the tables: bring it into view when a bank is picked from a row below.
  useEffect(() => {
    if (bank) document.getElementById("udash-bankdeep")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [bank]);
  const [tdType, setTdType] = useState("TD");
  const [spikeCode, setSpikeCode] = useState(null);
  const [detail, setDetail] = useState({}); // bank -> { ranAt, rows }
  const nameOf = useCallback((b) => (cfg?.remitterBanks || []).find((x) => x.code === b)?.name || "", [cfg]);
  const rows = useMemo(() => result?.rows || [], [result]);

  const base = useMemo(() => rows.filter((r) => r.grp === "base"), [rows]);
  const yday = useMemo(() => base.reduce((m, r) => (r.ts > m ? r.ts : m), ""), [base]);
  const P = useMemo(() => (yday ? periods(yday) : null), [yday]);
  const win = useMemo(() => (!P ? null : compare === "yday" ? { now: [P.yday, P.yday], base: [P.l7From, P.l7To] } : { now: [P.mtdFrom, P.mtdTo], base: [P.lmtdFrom, P.lmtdTo] }), [P, compare]);
  const label = compare === "yday" ? { now: "Yesterday", base: "L7D" } : { now: "MTD", base: "LMTD" };
  const scoped = useMemo(() => base.filter((r) => inHandle(r.handle, handleSel) && inFlow(r.flow, flowSel)), [base, handleSel, flowSel]);

  // Bank scorecard — health v2 (noise-adjusted, persistent; see src/bank-health.mjs).
  const score = useMemo(() => {
    if (!win) return { rows: [], overall: null };
    const g = {};
    for (const r of scoped) {
      if (inRange(r.ts, win.now)) bump(g, r.bank, "now", r);
      if (inRange(r.ts, win.base)) bump(g, r.bank, "base", r);
    }
    const list = bankHealth(scoped, win, { compare });
    const tot = Object.values(g).reduce((a, x) => ({ nt: a.nt + x.now.t, ns: a.ns + x.now.s, bt: a.bt + x.base.t, bs: a.bs + x.base.s }), { nt: 0, ns: 0, bt: 0, bs: 0 });
    const srN = pct(tot.ns, tot.nt);
    const srB = pct(tot.bs, tot.bt);
    return {
      rows: list.sort((a, b) => a.contrib - b.contrib),
      overall: { srNow: srN, srBase: srB, dsr: srN != null && srB != null ? srN - srB : null, tNow: tot.nt, sum: list.reduce((a, r) => a + r.contrib, 0) },
    };
  }, [scoped, win, compare]);

  // Daily attempts per bank (all handles / flows) — denominator for the decline-type watch.
  const dayAtt = useMemo(() => {
    const m = {};
    for (const r of base) {
      const k = `${r.bank}|${r.ts}`;
      m[k] = (m[k] || 0) + r.total;
    }
    return m;
  }, [base]);

  // Deep-dive detail (OS / instrument / codes) for the selected bank.
  useEffect(() => {
    if (!bank || !result?.ranAt || detail[bank]?.ranAt === result.ranAt) return;
    fetch(`/api/udash/view?section=bankrep&bank=${encodeURIComponent(bank)}`)
      .then((r) => r.json())
      .then((v) => setDetail((d) => ({ ...d, [bank]: { ranAt: v.ranAt, rows: v.rows || [] } })))
      .catch(() => {});
  }, [bank, result, detail]);

  if (!result) return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>Bank report not run yet — press Refresh (one day-level query; daily at 07:15).</div>;
  if (!win) return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>No data in the cached result.</div>;

  const scopeNote = `${HANDLE_LABEL[handleSel]} · ${flowSel === "ALL" ? "all flows" : flowSel} · ${label.now} ${compare === "yday" ? P.yday : `${P.mtdFrom} → ${P.mtdTo}`} vs ${label.base} ${compare === "yday" ? `${P.l7From} → ${P.l7To}` : `${P.lmtdFrom} → ${P.lmtdTo}`}`;
  const perDay = (t) => t / nDays(win.now);
  const contribCell = (v) => ({ ...badCell(v == null ? null : -v * 30, 3), ...goodText(-v) });
  const counts = Object.fromEntries(Object.keys(HEALTH).map((h) => [h, score.rows.filter((r) => r.health === h).length]));
  const shown = score.rows.filter((r) => healthSel === "all" || r.health === healthSel);

  const bankTable = (list, max = 520) => (
    <Table
      maxHeight={max}
      columns={[
        {
          key: "k",
          label: "Payer bank",
          align: "left",
          sortValue: (r) => r.k,
          render: (r) => (
            <span role="button" tabIndex={0} onClick={() => setBank(r.k)} onKeyDown={(e) => e.key === "Enter" && setBank(r.k)} style={{ cursor: "pointer" }} title="Open the bank deep-dive">
              <b style={{ textDecoration: "underline dotted", textUnderlineOffset: 3 }}>{r.k}</b>
              {nameOf(r.k) ? <span style={{ color: C.muted }}> · {nameOf(r.k)}</span> : null}
            </span>
          ),
        },
        {
          key: "health",
          label: "Health",
          align: "left",
          sortValue: (r) => ["critical", "watch", "stable", "improving"].indexOf(r.health),
          render: (r) => (
            <span>
              <HealthTag h={r.health} day1={r.day1} streak={r.streak} />
              {showV1 && r.healthV1 !== r.health && <span style={{ fontSize: 10, color: C.muted, marginLeft: 4 }}>(plain: {HEALTH[r.healthV1].label})</span>}
            </span>
          ),
        },
        {
          key: "z",
          label: "z (vs normal swing)",
          render: (r) => <span title={r.sigma != null ? `normal swing σ = ${r.sigma.toFixed(2)}pp` : "too little history"}>{r.z == null ? "—" : r.z.toFixed(1)}</span>,
          style: (r) => (r.z != null && r.z <= -2 ? { color: "#ef4444", fontWeight: 700 } : {}),
        },
        { key: "tNow", label: `Txns / day (${label.now})`, render: (r) => fmtNum(perDay(r.tNow)) },
        { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
        { key: "srNow", label: `SR ${label.now}`, render: (r) => fmtPct(r.srNow) },
        { key: "srBase", label: `SR ${label.base}`, render: (r) => fmtPct(r.srBase) },
        { key: "dsr", label: "Δ SR", render: (r) => fmtPp(r.dsr), style: (r) => ({ ...badCell(r.dsr == null ? null : -r.dsr, 3), ...goodText(-r.dsr) }) },
        { key: "contrib", label: "Contribution", render: (r) => `${r.contrib > 0 ? "+" : ""}${r.contrib.toFixed(3)} pp`, style: (r) => contribCell(r.contrib) },
        { key: "fNow", label: `Failures / day`, render: (r) => fmtNum(perDay(r.fNow)) },
        {
          key: "esc",
          label: "",
          align: "left",
          sortValue: () => 0,
          render: (r) =>
            r.health === "critical" || r.health === "watch" ? (
              <button type="button" style={{ ...btn(), padding: "2px 8px" }} onClick={() => onEscalate?.({ dim: r.k })} title="Draft the escalation email in K for this bank">
                ✉ Escalate
              </button>
            ) : null,
        },
      ]}
      rows={list}
    />
  );

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            ["score", "Bank scorecard"],
            ["lead", "Leaderboard & trends"],
            ["td", "Decline-type watch"],
            ["spikes", "Error spikes × banks"],
            ["matrix", "Handle × bank"],
          ]}
        />
        <span style={{ fontSize: 12, color: C.text2 }}>Compare:</span>
        <Seg
          value={compare}
          onChange={setCompare}
          options={[
            ["yday", "Yesterday vs L7D"],
            ["mtd", "MTD vs LMTD"],
          ]}
        />
        <span style={{ fontSize: 11, color: C.muted }}>{scopeNote}</span>
      </div>
      <LiveBankCheck kind="dwh" live={dwhLive} cfg={cfg} nameOf={nameOf} onRun={onRunDwh} onToggle={onToggleDwh} onBank={setBank} />
      <LiveBankCheck live={live} cfg={cfg} nameOf={nameOf} onRun={onRunLive} onToggle={onToggleLive} onBank={setBank} />
      {score.overall && (
        <div style={{ fontSize: 12, color: C.text2, marginBottom: 8 }}>
          Overall SR <b style={{ color: C.text }}>{fmtPct(score.overall.srNow)}</b> vs {fmtPct(score.overall.srBase)} ({fmtPp(score.overall.dsr)}) · bank contributions add up to{" "}
          {score.overall.sum > 0 ? "+" : ""}
          {score.overall.sum.toFixed(3)} pp · click a bank for its deep-dive
        </div>
      )}

      {bank && (
        <div id="udash-bankdeep" style={{ scrollMarginTop: 150 }}>
        <BankDeepDive
          bank={bank}
          name={nameOf(bank)}
          onClose={() => setBank(null)}
          scoped={scoped}
          base={base}
          etype={rows.filter((r) => r.grp === "etype" && r.bank === bank)}
          detail={detail[bank]}
          win={win}
          label={label}
          pbankRows={pbankRows}
          named={new Set(score.rows.map((r) => r.k))}
          notes={notes.filter((n) => n.scope === bank || n.scope === "all")}
          onEscalate={onEscalate}
        />
        </div>
      )}

      {tab === "score" && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {[["all", `All ${score.rows.length}`], ...Object.entries(HEALTH).map(([h, x]) => [h, `${x.label} ${counts[h]}`])].map(([h, l]) => (
              <button
                key={h}
                type="button"
                onClick={() => setHealthSel(h)}
                style={{ ...btn(), padding: "3px 10px", borderColor: healthSel === h ? HEALTH[h]?.color || C.accent : C.border, color: HEALTH[h]?.color || C.text }}
              >
                {l}
              </button>
            ))}
          </div>
          {bankTable(shown)}
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span>
              Critical: contribution ≤ −0.03pp, or SR down ≥1pp on ≥1% of txns · Watch: contribution ≤ −0.01pp, or SR down ≥0.5pp · Improving: contribution ≥ +0.01pp. Each needs the drop to be beyond
              the bank&apos;s normal day-to-day swing (z ≤ −2, σ from its last 30 days); comparing yesterday, Critical also needs 2 days in a row unless the one-day hit is ≥0.10pp of overall SR.
            </span>
            <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" checked={showV1} onChange={(e) => setShowV1(e.target.checked)} /> show plain-threshold tag where it differs
            </label>
          </div>
        </>
      )}

      {tab === "lead" && <BankLeaderboard score={score} scoped={scoped} P={P} bankTable={bankTable} nameOf={nameOf} />}

      {tab === "td" && (
        <BankTypeWatch
          etype={rows.filter((r) => r.grp === "etype")}
          dayAtt={dayAtt}
          yday={yday}
          type={tdType}
          setType={setTdType}
          banks={score.rows.filter((r) => r.share >= 0.5).map((r) => r.k)}
          nameOf={nameOf}
          onBank={setBank}
          onEscalate={onEscalate}
        />
      )}

      {tab === "spikes" && (
        <BankSpikes
          spikes={result.extra?.spikes && { ...result.extra.spikes, codes: result.extra.spikes.codes.filter((c) => spikeAll || !notEscalatable(c)).slice(0, 12) }}
          hidden={result.extra?.spikes ? result.extra.spikes.codes.filter((c) => notEscalatable(c)).length : 0}
          spikeAll={spikeAll}
          setSpikeAll={setSpikeAll}
          code={spikeCode}
          setCode={setSpikeCode}
          nameOf={nameOf}
          onBank={setBank}
          onEscalate={onEscalate}
        />
      )}

      {tab === "matrix" && <HandleBankMatrix base={base} flowSel={flowSel} win={win} label={label} banks={score.rows.filter((r) => r.share >= 0.5).map((r) => r.k)} nameOf={nameOf} onBank={setBank} />}
    </div>
  );
}

/**
 * Payer-bank incident check. kind "live": section bankalert (Redash on the switch DB, failed txns
 * only, manual). kind "dwh": section bankdwh (Trino, latest 12h the DWH has, 10:00 / 22:00 + Slack).
 */
function LiveBankCheck({ live, cfg, nameOf, onRun, onToggle, onBank, kind = "live" }) {
  const dwh = kind === "dwh";
  const ex = live?.extra;
  const opt = (dwh ? cfg?.dwhBankAlert : cfg?.intradayBankAlert) || {};
  const on = Boolean(opt.enabled);
  const running = live?.running;
  const inc = ex?.incidents || [];
  const hm = (ts) => (ts ? ts.slice(11, 16) : "—");
  return (
    <div style={{ border: `1px solid ${inc.length ? "#7f1d1d" : C.border}`, borderRadius: 8, padding: "8px 12px", marginBottom: 10, background: "#0c1626" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
        <b>{dwh ? "🗄 DWH bank check · hourly" : "⚡ Live bank check"}</b>
        <span style={{ color: C.muted }}>
          {ex?.from ? `${fmtTime(live.ranAt)} · ${ex.checked} banks · ${ex.from.slice(5, 16)} → ${hm(ex.to)}+30m IST · took ${fmtDur(live.elapsedMs)}` : "not run yet"}
        </span>
        <span style={{ color: C.text2 }}>Run:</span>
        {dwh ? (
          <button type="button" style={{ ...btn(), padding: "2px 8px" }} onClick={() => onRun("12h")} disabled={running} title="Trino (DWH) — the latest 12 hours the DWH has">
            now
          </button>
        ) : (
          <>
            <button type="button" style={{ ...btn(), padding: "2px 8px" }} onClick={() => onRun("1h")} disabled={running} title="Live switch DB (Redash), failed txns only — last 60 min (~4 min)">
              last 1h
            </button>
            <button
              type="button"
              style={{ ...btn(), padding: "2px 8px" }}
              onClick={() => onRun("12h")}
              disabled={running}
              title="Live switch DB (Redash), failed txns only — last 12 hours (~60 min of live-DB load)"
            >
              last 12h
            </button>
          </>
        )}
        {running && <span style={{ color: C.info }}>⟳ {live.state || "running"}</span>}
        <button
          type="button"
          style={{ ...btn(), padding: "2px 8px", color: on ? "#86efac" : C.text2 }}
          onClick={onToggle}
          title={
            dwh
              ? "Hourly 07:00–23:30 IST on the DWH, each run over the latest 12h (no live-DB load); Slack post per new bank incident"
              : "10:00 and 22:00 IST on the live switch DB; Slack post per bank incident. Off by default."
          }
        >
          {dwh ? "Hourly" : "10:00 & 22:00"} + Slack: {on ? "On" : "Off"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
        {dwh
          ? `Trino over the latest 12 hours the DWH has${live?.window?.anchoredTo ? ` (data up to ${live.window.anchoredTo.slice(5, 16)} IST)` : ""} — exact attempts per bank, a few seconds, no live-DB load.`
          : "Joins the payer bank only for failed txns; a bank's attempts are estimated from its usual traffic share."}{" "}
        Incident = SR gap to overall ≥{opt.dropPp ?? 2}pp worse than normal for ≥60 min (two 30-min buckets in a row) costing ≥{opt.minLost ?? 200} txns.
      </div>
      {inc.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
          {inc.map((a) => (
            <div key={`${a.bank}${a.from}`} style={{ fontSize: 12, color: C.text2 }}>
              <span style={{ color: "#ef4444", fontWeight: 700 }}>INCIDENT</span>{" "}
              <b role="button" tabIndex={0} style={{ cursor: "pointer", color: C.text }} onClick={() => onBank(a.bank)} onKeyDown={(e) => e.key === "Enter" && onBank(a.bank)}>
                {a.bank}
                {nameOf(a.bank) ? ` · ${nameOf(a.bank)}` : ""}
              </b>{" "}
              {hm(a.from)}–{hm(a.to)}+30m ({a.minutes} min) · SR ~{a.sr.toFixed(1)}% · gap {a.worstGap.toFixed(2)}pp vs normal {a.baseGap.toFixed(2)}pp ({a.source}) · ~{fmtNum(a.lost)} txns lost ·{" "}
              {a.topCodes.map(([c, n]) => `${c} ${fmtNum(n)}`).join(", ")}
            </div>
          ))}
        </div>
      )}
      {ex?.from && !inc.length && <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>No bank below its normal band for 60+ minutes in this window.</div>}
      {ex?.posted?.length > 0 && <div style={{ fontSize: 11, color: C.muted }}>{ex.posted.join(" · ")}</div>}
    </div>
  );
}

/**
 * SR per payer bank × payer handle, now vs base. A cell is flagged when that handle's SR for the
 * bank fell ≥1pp AND ≥1pp more than the bank fell across handles AND ≥1pp more than the handle
 * fell across banks (≥ 5,000 txns now) — i.e. a sponsor-bank × remitter-bank issue, not mix.
 */
function HandleBankMatrix({ base, flowSel, win, label, banks, nameOf, onBank }) {
  const handles = ["ptyes", "ptaxis", "ptsbi", "pthdfc"];
  const A = {};
  const put = (k, w, r) => {
    const a = (A[k] ||= { now: { t: 0, s: 0 }, base: { t: 0, s: 0 } })[w];
    a.t += r.total;
    a.s += r.success;
  };
  for (const r of base) {
    if (!inFlow(r.flow, flowSel) || !handles.includes(r.handle)) continue;
    for (const w of ["now", "base"]) {
      if (!inRange(r.ts, win[w])) continue;
      put(`${r.bank}|${r.handle}`, w, r);
      put(`${r.bank}|*`, w, r);
      put(`*|${r.handle}`, w, r);
    }
  }
  const st = (k) => {
    const a = A[k];
    if (!a || a.now.t < 200) return null;
    const n = pct(a.now.s, a.now.t);
    const b = a.base.t >= 200 ? pct(a.base.s, a.base.t) : null;
    return { n, d: b != null ? n - b : null, t: a.now.t };
  };
  const flagged = (b, h) => {
    const c = st(`${b}|${h}`);
    const bk = st(`${b}|*`);
    const hd = st(`*|${h}`);
    return Boolean(c && bk && hd && c.d != null && bk.d != null && hd.d != null && c.t >= 5000 && c.d <= -1 && c.d - bk.d <= -1 && c.d - hd.d <= -1);
  };
  const nFlag = banks.reduce((n, b) => n + handles.filter((h) => flagged(b, h)).length, 0);
  return (
    <>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        SR {label.now} per payer bank × payer handle, Δ vs {label.base} below. Red = that handle&apos;s SR for the bank fell ≥1pp, and ≥1pp more than both the bank across all handles and the handle
        across all banks (≥5,000 txns) — a sponsor-bank × remitter-bank issue, not traffic mix. {nFlag} cell{nFlag === 1 ? "" : "s"} flagged. Flow filter applies; handle filter does not.
      </div>
      <div style={{ overflow: "auto", maxHeight: 520, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: "left" }}>Payer bank</th>
              <th style={thS}>All handles</th>
              {handles.map((h) => {
                const hd = st(`*|${h}`);
                return (
                  <th key={h} style={thS}>
                    {h.toUpperCase()}
                    <div style={{ fontSize: 10, fontWeight: 400 }}>{hd ? `${fmtPct(hd.n)} (${fmtPp(hd.d)})` : ""}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {banks.map((b) => {
              const all = st(`${b}|*`);
              return (
                <tr key={b}>
                  <td style={{ ...tdS, textAlign: "left" }}>
                    <span role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onBank(b)} onKeyDown={(e) => e.key === "Enter" && onBank(b)}>
                      <b>{b}</b>
                      {nameOf(b) ? <span style={{ color: C.muted }}> · {nameOf(b)}</span> : null}
                    </span>
                  </td>
                  <td style={tdS}>
                    {all ? fmtPct(all.n) : "—"}
                    <div style={{ fontSize: 10, color: C.muted }}>{fmtPp(all?.d)}</div>
                  </td>
                  {handles.map((h) => {
                    const c = st(`${b}|${h}`);
                    const red = flagged(b, h);
                    return (
                      <td key={h} style={{ ...tdS, ...(red ? { background: "rgba(239,68,68,.5)", color: "#fff", fontWeight: 700 } : {}) }}>
                        {c ? fmtPct(c.n) : "—"}
                        <div style={{ fontSize: 10, color: red ? "#fff" : C.muted }}>{fmtPp(c?.d)}</div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Banks the Looker table files under "Others", from yesterday's raw txns (payer IFSC prefix). */
function OthersSplit({ pbankRows, named }) {
  const days = [...new Set(pbankRows.map((r) => r.ts))].sort();
  const y = days[days.length - 1];
  const d1 = days[days.length - 2];
  const m = {};
  for (const r of pbankRows) {
    if (named.has(r.pbank) && r.pbank !== "Others") continue;
    const a = (m[r.pbank] ||= { y: { t: 0, s: 0 }, d1: { t: 0, s: 0 } });
    const w = r.ts === y ? a.y : r.ts === d1 ? a.d1 : null;
    if (!w) continue;
    w.t += Number(r.total) || 0;
    w.s += Number(r.success) || 0;
  }
  const rows = Object.entries(m)
    .filter(([, a]) => a.y.t > 0)
    .map(([k, a]) => {
      const sy = pct(a.y.s, a.y.t);
      const sd = pct(a.d1.s, a.d1.t);
      return { _key: k, k, t: a.y.t, sy, sd, d: sy != null && sd != null ? sy - sd : null, lost: sy != null && sd != null ? Math.max(0, ((sd - sy) / 100) * a.y.t) : null };
    })
    .sort((a, b) => b.t - a.t);
  const total = rows.reduce((a, r) => a + r.t, 0);
  if (!rows.length) return <div style={{ padding: 10, color: C.muted, fontSize: 12 }}>No raw payer-bank split yet — it comes with the daily merchants / MCC run (13:15).</div>;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "6px 0 4px" }}>
        Inside &quot;Others&quot; — {rows.length} banks by payer IFSC, {y} vs {d1} (raw txns, all 4 TPAP handles · {fmtNum(total)} txns)
      </div>
      <Table
        maxHeight={300}
        columns={[
          { key: "k", label: "IFSC prefix", align: "left", render: (r) => <b>{r.k}</b> },
          { key: "t", label: "Txns", render: (r) => fmtNum(r.t) },
          { key: "share", label: "Share of Others", sortValue: (r) => r.t, render: (r) => fmtPct(pct(r.t, total)) },
          { key: "sy", label: "SR", render: (r) => fmtPct(r.sy) },
          { key: "sd", label: "SR D-1", render: (r) => fmtPct(r.sd) },
          { key: "d", label: "Δ SR", render: (r) => fmtPp(r.d), style: (r) => ({ ...badCell(r.d == null ? null : -r.d, 3), ...goodText(-r.d) }) },
          { key: "lost", label: "Lost txns vs D-1", render: (r) => (r.lost > 0.5 ? fmtNum(r.lost) : "—") },
        ]}
        rows={rows}
      />
    </div>
  );
}

function BankLeaderboard({ score, scoped, P, bankTable }) {
  const big = score.rows.filter((r) => r.share >= 0.5);
  const drags = [...score.rows].sort((a, b) => a.contrib - b.contrib).slice(0, 5);
  const lifts = [...score.rows].sort((a, b) => b.contrib - a.contrib).slice(0, 5);
  const falls = [...big]
    .filter((r) => r.dsr != null)
    .sort((a, b) => a.dsr - b.dsr)
    .slice(0, 5);
  const lowest = [...big].sort((a, b) => (a.srNow ?? 101) - (b.srNow ?? 101)).slice(0, 5);
  // Daily SR, last 30 days: top 5 drags vs overall.
  const days = [...new Set(scoped.map((r) => r.ts))].sort().slice(-30);
  const idx = new Map(days.map((d, i) => [d, i]));
  const ser = (filter) => {
    const a = days.map(() => ({ t: 0, s: 0 }));
    for (const r of scoped) {
      const i = idx.get(r.ts);
      if (i == null || !filter(r)) continue;
      a[i].t += r.total;
      a[i].s += r.success;
    }
    return a.map((p) => pct(p.s, p.t));
  };
  const series = [
    { key: "__all", label: "Overall", color: "#e2e8f0", width: 2.5, dash: "5 3", values: ser(() => true) },
    ...drags.map((d, i) => ({ key: d.k, label: d.k, color: SERIES[i % SERIES.length], values: ser((r) => r.bank === d.k) })),
  ];
  const box = (title, list) => (
    <div style={{ flex: "1 1 420px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "6px 0" }}>{title}</div>
      {bankTable(list, 260)}
    </div>
  );
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {box("Biggest drags on overall SR", drags)}
        {box("Biggest lifts", lifts)}
        {box("Biggest SR falls (banks with ≥0.5% of txns)", falls)}
        {box("Lowest SR now (≥0.5% of txns)", lowest)}
      </div>
      <div style={{ marginTop: 12 }}>
        <LineChart title={`Daily SR — top 5 drags vs overall · last ${days.length} days (to ${P?.yday})`} buckets={days} series={series} yFormat={(v) => v.toFixed(1)} unit="%" height={280} />
      </div>
    </>
  );
}

/** Decline-type share of each bank's attempts, last 15 days, coloured vs the bank's 30-day median. */
function BankTypeWatch({ etype, dayAtt, yday, type, setType, banks, nameOf, onBank, onEscalate }) {
  const days15 = Array.from({ length: 15 }, (_, i) => new Date(Date.parse(`${yday}T00:00:00Z`) - (14 - i) * 86400000).toISOString().slice(0, 10));
  const days30 = Array.from({ length: 30 }, (_, i) => new Date(Date.parse(`${yday}T00:00:00Z`) - (29 - i) * 86400000).toISOString().slice(0, 10));
  const f = {};
  for (const r of etype) if (r.dim === type) f[`${r.bank}|${r.ts}`] = (f[`${r.bank}|${r.ts}`] || 0) + r.total - r.success;
  const share = (b, d) => (dayAtt[`${b}|${d}`] ? ((f[`${b}|${d}`] || 0) * 100) / dayAtt[`${b}|${d}`] : null);
  const rows = banks
    .map((b) => {
      const hist = days30
        .map((d) => share(b, d))
        .filter((v) => v != null)
        .sort((x, y) => x - y);
      const med = hist.length ? hist[Math.floor(hist.length / 2)] : null;
      const cells = days15.map((d) => share(b, d));
      const last = cells[cells.length - 1];
      return { b, med, cells, ratio: med ? (last ?? 0) / med : 0 };
    })
    .sort((x, y) => y.ratio - x.ratio);
  const cellStyle = (v, med) => {
    if (v == null || !med) return {};
    if (v >= 2 * med) return { background: "rgba(239,68,68,.55)", color: "#fff", fontWeight: 700 };
    if (v >= 1.5 * med) return { background: "rgba(250,178,25,.35)", color: "#fff" };
    return {};
  };
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <Seg
          value={type}
          onChange={setType}
          options={[
            ["TD", "TD (technical)"],
            ["RD", "RD (risk)"],
            ["BD", "BD (business)"],
          ]}
        />
        <span style={{ fontSize: 11, color: C.muted }}>
          {type} failures as % of the bank&apos;s attempts per day (all handles, all flows) · red ≥2×, amber ≥1.5× the bank&apos;s own 30-day median · banks with ≥0.5% of txns, sorted by latest day vs
          median. TD spikes (e.g. U30-XY CBS offline, U09 / U90 timeouts, S96) are worth escalating to the bank.
        </span>
      </div>
      <div style={{ overflow: "auto", maxHeight: 520, border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: "left", position: "sticky", left: 0, background: C.card, zIndex: 2 }}>Bank</th>
              <th style={thS}>30d median</th>
              {days15.map((d) => (
                <th key={d} style={thS}>
                  {d.slice(8, 10)}/{d.slice(5, 7)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.b}>
                <td style={{ ...tdS, textAlign: "left", position: "sticky", left: 0, background: C.card }}>
                  <span role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onBank(r.b)} onKeyDown={(e) => e.key === "Enter" && onBank(r.b)}>
                    <b>{r.b}</b>
                    {nameOf(r.b) ? <span style={{ color: C.muted }}> · {nameOf(r.b)}</span> : null}
                  </span>
                </td>
                <td style={tdS}>
                  {r.med == null ? "—" : `${r.med.toFixed(2)}%`}
                  {r.ratio >= 1.5 && type !== "BD" && (
                    <button type="button" style={{ ...btn(), padding: "1px 6px", marginLeft: 6 }} onClick={() => onEscalate?.({ dim: r.b })} title="Draft the escalation email in K">
                      ✉
                    </button>
                  )}
                </td>
                {r.cells.map((v, i) => (
                  <td key={i} style={{ ...tdS, ...cellStyle(v, r.med) }}>
                    {v == null ? "—" : v.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
const thS = { padding: "6px 8px", fontSize: 11, color: "#94a3b8", textAlign: "right", borderBottom: "1px solid #1e293b", whiteSpace: "nowrap", position: "sticky", top: 0, background: "#111a2e" };
const tdS = { padding: "5px 8px", fontSize: 12, textAlign: "right", borderBottom: "1px solid #1e293b", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

/** Error codes spiking this month / week / fortnight and the banks they hit (server-computed). */
function BankSpikes({ spikes, hidden = 0, spikeAll, setSpikeAll, code, setCode, nameOf, onBank, onEscalate }) {
  if (!spikes?.codes?.length) return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>No error code rose against its baseline.</div>;
  const sel = spikes.codes.find((c) => c.code === code) || spikes.codes[0];
  const fx = (x) => (x?.extra > 0 ? `+${fmtNum(x.extra)}` : "—");
  const ratioStyle = (now, base) =>
    base > 0 && now >= 2 * base ? { background: "rgba(239,68,68,.55)", color: "#fff", fontWeight: 700 } : base > 0 && now >= 1.5 * base ? { background: "rgba(250,178,25,.35)", color: "#fff" } : {};
  const P = spikes.periods;
  return (
    <>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Codes ranked by extra failures = Δ share of attempts × attempts now · monthly {P.mtd[0]}→{P.mtd[1]} vs {P.lmtd[0]}→{P.lmtd[1]} · weekly last 7 vs prior 7 · 14-day last 14 vs prior 14. A bank
        is affected when its share rose ≥0.05pp with ≥1,000 extra failures (monthly / 14-day) or ≥500 (weekly). All handles, all flows; this tab ignores Compare.
        <label style={{ marginLeft: 8, color: C.text2 }}>
          <input type="checkbox" checked={spikeAll} onChange={(e) => setSpikeAll(e.target.checked)} /> include customer-side (BD) and NPCI-policy codes{hidden ? ` (${hidden} hidden)` : ""}
        </label>
      </div>
      <Table
        maxHeight={300}
        columns={[
          {
            key: "code",
            label: "Spiking code",
            align: "left",
            render: (r) => (
              <span role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => setCode(r.code)} onKeyDown={(e) => e.key === "Enter" && setCode(r.code)}>
                <b style={{ color: r.code === sel.code ? "#38bdf8" : C.text }}>{r.code}</b>
                <span style={{ color: C.muted }}>
                  {" "}
                  {r.ctype ? `· ${r.ctype}` : ""} {r.descr ? `· ${String(r.descr).replace(/_/g, " ").slice(0, 60)}` : ""}
                </span>
              </span>
            ),
          },
          { key: "m", label: "Extra fails · MTD vs LMTD", sortValue: (r) => r.m.extra, render: (r) => fx(r.m) },
          { key: "w", label: "· last 7 vs prior 7", sortValue: (r) => r.w.extra, render: (r) => fx(r.w) },
          { key: "f", label: "· last 14 vs prior 14", sortValue: (r) => r.f.extra, render: (r) => fx(r.f) },
          { key: "banks", label: "Banks hit", sortValue: (r) => r.banks.length, render: (r) => r.banks.length },
        ]}
        rows={spikes.codes.map((c) => ({ ...c, _key: c.code }))}
      />
      <div style={{ fontSize: 12, fontWeight: 700, margin: "12px 0 6px" }}>{sel.code} × banks — share of the bank&apos;s attempts and failed txns per day (red ≥2×, amber ≥1.5× its LMTD share)</div>
      <Table
        maxHeight={360}
        columns={[
          {
            key: "bank",
            label: "Bank",
            align: "left",
            render: (r) => (
              <span role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onBank(r.bank)} onKeyDown={(e) => e.key === "Enter" && onBank(r.bank)}>
                <b>{r.bank}</b>
                {nameOf(r.bank) ? <span style={{ color: C.muted }}> · {nameOf(r.bank)}</span> : null}
              </span>
            ),
          },
          { key: "lmtdShare", label: "LMTD share", render: (r) => fmtPct(r.lmtdShare, 3) },
          { key: "mtdShare", label: "MTD share", render: (r) => fmtPct(r.mtdShare, 3), style: (r) => ratioStyle(r.mtdShare, r.lmtdShare) },
          { key: "l7Share", label: "Last 7 share", render: (r) => fmtPct(r.l7Share, 3), style: (r) => ratioStyle(r.l7Share, r.lmtdShare) },
          { key: "perday", label: "Fails / day LMTD → MTD", sortValue: (r) => r.mtdPerDay - r.lmtdPerDay, render: (r) => `${fmtNum(r.lmtdPerDay)} → ${fmtNum(r.mtdPerDay)}` },
          { key: "l7PerDay", label: "Fails / day last 7", render: (r) => fmtNum(r.l7PerDay) },
          { key: "extra", label: "Extra fails (MTD)", sortValue: (r) => r.m.extra, render: (r) => fx(r.m) },
          {
            key: "esc",
            label: "",
            sortValue: () => 0,
            render: (r) =>
              notEscalatable(sel) ? null : (
                <button
                  type="button"
                  style={{ ...btn(), padding: "2px 8px" }}
                  onClick={() => onEscalate?.({ dim: r.bank, code: sel.code })}
                  title={`Draft the escalation email in K: ${r.bank} · ${sel.code}`}
                >
                  ✉ Escalate
                </button>
              ),
          },
        ]}
        rows={sel.banks.map((b) => ({ ...b, _key: b.bank }))}
        empty="No single bank crosses the bar — the rise is spread thin."
      />
    </>
  );
}

/** One bank: headline, by flow / handle, failure split, error codes, OS, instrument. */
function BankDeepDive({ bank, name, onClose, scoped, base, etype, detail, win, label, pbankRows = [], named = new Set(), notes = [], onEscalate }) {
  const mine = scoped.filter((r) => r.bank === bank);
  const split = (keyOf) => {
    const g = {};
    for (const r of mine) {
      if (inRange(r.ts, win.now)) bump(g, keyOf(r), "now", r);
      if (inRange(r.ts, win.base)) bump(g, keyOf(r), "base", r);
    }
    return contribution(g).sort((a, b) => a.contrib - b.contrib);
  };
  const byFlow = split((r) => r.flow);
  const byHandle = split((r) => r.handle.toUpperCase());
  const hd = { now: { t: 0, s: 0 }, base: { t: 0, s: 0 } };
  for (const r of mine) {
    for (const w of ["now", "base"]) {
      if (!inRange(r.ts, win[w])) continue;
      hd[w].t += r.total;
      hd[w].s += r.success;
    }
  }
  const head = hd.now.t
    ? { srNow: pct(hd.now.s, hd.now.t), srBase: pct(hd.base.s, hd.base.t), tNow: hd.now.t, fNow: hd.now.t - hd.now.s, dsr: hd.base.t ? pct(hd.now.s, hd.now.t) - pct(hd.base.s, hd.base.t) : null }
    : null;
  // Denominator for failure split / codes / OS / instrument: the bank's attempts, all handles and flows.
  const att = { now: 0, base: 0 };
  for (const r of base) {
    if (r.bank !== bank) continue;
    if (inRange(r.ts, win.now)) att.now += r.total;
    if (inRange(r.ts, win.base)) att.base += r.total;
  }
  const failShare = (list, keyOf) => {
    const m = {};
    for (const r of list) {
      const k = keyOf(r);
      const o = (m[k] ||= { k, now: 0, base: 0, ctype: r.ctype, descr: r.descr });
      if (inRange(r.ts, win.now)) o.now += r.total - r.success;
      if (inRange(r.ts, win.base)) o.base += r.total - r.success;
    }
    return Object.values(m)
      .map((o) => {
        const sn = att.now ? (o.now * 100) / att.now : null;
        const sb = att.base ? (o.base * 100) / att.base : null;
        return { ...o, _key: o.k, sNow: sn, sBase: sb, d: sn != null && sb != null ? sn - sb : null };
      })
      .sort((a, b) => (b.d ?? 0) - (a.d ?? 0));
  };
  const types = failShare(etype, (r) => r.dim);
  const det = detail?.rows || [];
  const codes = failShare(
    det.filter((r) => r.grp === "code"),
    (r) => r.dim,
  ).slice(0, 25);
  const dsplit = (grp) => {
    const g = {};
    for (const r of det) {
      if (r.grp !== grp) continue;
      if (inRange(r.ts, win.now)) bump(g, r.dim, "now", r);
      if (inRange(r.ts, win.base)) bump(g, r.dim, "base", r);
    }
    return contribution(g).sort((a, b) => a.contrib - b.contrib);
  };
  const splitTable = (title, list, first) => (
    <div style={{ flex: "1 1 460px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "8px 0 4px" }}>{title}</div>
      <Table
        maxHeight={240}
        columns={[
          { key: "k", label: first, align: "left", render: (r) => <b>{r.k}</b> },
          { key: "share", label: "Share", render: (r) => fmtPct(r.share) },
          { key: "srNow", label: `SR ${label.now}`, render: (r) => fmtPct(r.srNow) },
          { key: "dsr", label: "Δ SR", render: (r) => fmtPp(r.dsr), style: (r) => ({ ...badCell(r.dsr == null ? null : -r.dsr, 3), ...goodText(-r.dsr) }) },
          {
            key: "contrib",
            label: "Contribution",
            render: (r) => `${r.contrib > 0 ? "+" : ""}${r.contrib.toFixed(3)} pp`,
            style: (r) => ({ ...badCell(-r.contrib * 10, 3), ...goodText(-r.contrib) }),
          },
        ]}
        rows={list}
      />
    </div>
  );
  const shareTable = (title, list, first) => (
    <div style={{ flex: "1 1 460px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, margin: "8px 0 4px" }}>{title}</div>
      <Table
        maxHeight={300}
        columns={[
          {
            key: "k",
            label: first,
            align: "left",
            render: (r) => (
              <span>
                <b>{r.k}</b>
                {r.ctype ? <span style={{ color: C.muted }}> · {r.ctype}</span> : null}
                {r.descr ? <div style={{ fontSize: 11, color: C.muted }}>{String(r.descr).replace(/_/g, " ").slice(0, 60)}</div> : null}
              </span>
            ),
          },
          { key: "sBase", label: `% of attempts ${label.base}`, render: (r) => fmtPct(r.sBase, 3) },
          { key: "sNow", label: `% ${label.now}`, render: (r) => fmtPct(r.sNow, 3) },
          { key: "d", label: "Δ (= SR cost)", render: (r) => fmtPp(r.d), style: (r) => ({ ...badCell(r.d, 0.5), ...goodText(r.d) }) },
        ]}
        rows={list}
      />
    </div>
  );
  return (
    <div style={{ border: "1px solid #1e3a5f", borderRadius: 10, padding: 12, marginBottom: 12, background: "#0c1626" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>
          {bank}
          {name ? ` · ${name}` : ""}
        </b>
        {head && (
          <span style={{ fontSize: 12, color: C.text2 }}>
            SR {fmtPct(head.srNow)} vs {fmtPct(head.srBase)} {label.base} ({fmtPp(head.dsr)}) · {fmtNum(head.tNow)} txns · {fmtNum(head.fNow)} failures
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>
          <InvestigateBrief bank={bank} name={name} label={label} win={win} head={head} byFlow={byFlow} byHandle={byHandle} types={types} codes={codes} notes={notes} />
        </span>
        <button
          type="button"
          style={btn("primary")}
          onClick={() => onEscalate?.({ dim: bank, code: codes.find((c) => (c.d ?? 0) > 0 && c.ctype !== "BD" && c.k !== "Other codes")?.k || null })}
          title="Draft the escalation email in K, led by this bank's biggest rising non-customer code"
        >
          ✉ Escalate
        </button>
        <button type="button" style={btn()} onClick={onClose}>
          ✕ Close
        </button>
      </div>
      {notes.length > 0 && (
        <div style={{ fontSize: 12, color: "#c084fc", margin: "4px 0" }}>
          {notes.map((n) => (
            <div key={n.id}>
              {n.kind === "investigation" ? "🔎" : "📝"} {n.date}
              {n.end && n.end !== n.date ? ` → ${n.end}` : ""} · {n.kind === "investigation" ? `[${n.status}${n.confidence ? ` · ${n.confidence}` : ""}${n.ticket ? ` · ${n.ticket}` : ""}] ` : ""}
              {n.label}
              {n.scope !== "all" ? ` (${n.scope})` : ""}
            </div>
          ))}
        </div>
      )}
      {bank === "Others" && <OthersSplit pbankRows={pbankRows} named={named} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {splitTable("By category (flow)", byFlow, "Flow")}
        {splitTable("By PSP handle", byHandle, "Payer handle")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {shareTable("Failure split (BD / TD / RD, share of attempts)", types, "Decline type")}
        {detail ? shareTable("Error codes (top 25 by rise)", codes, "Code") : <div style={{ padding: 12, color: C.muted, fontSize: 12 }}>Loading codes…</div>}
      </div>
      {detail && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {splitTable("By OS", dsplit("os"), "OS")}
          {splitTable("By instrument", dsplit("instrument"), "Instrument")}
        </div>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
        Flow / handle follow the page&apos;s handle and flow filters; failure split, codes, OS and instrument cover all handles and flows. Contribution splits this bank&apos;s SR change across its
        rows (sums to the bank&apos;s Δ SR). Code share = % of the bank&apos;s attempts, so a +0.10pp rise costs 0.10pp of SR.
      </div>
    </div>
  );
}

/**
 * 🔎 Investigate: writes the bank's current numbers as a brief into the Premium workspace
 * (premium/artifacts/briefs/), offers it for Claude chat (copy) and Claude Code (/investigate brief),
 * and records the verdict back as an investigation note on this bank.
 */
function InvestigateBrief({ bank, name, label, win, head, byFlow, byHandle, types, codes, notes }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const [v, setV] = useState({ status: "SUSPECTED", confidence: "MEDIUM", ticket: "", label: "" });
  const [saved, setSaved] = useState(false);

  const rowLine = (r) => `${r.k}: SR ${fmtPct(r.srNow)} vs ${fmtPct(r.srBase)} (${fmtPp(r.dsr)}), share ${fmtPct(r.share)}, contribution ${r.contrib > 0 ? "+" : ""}${r.contrib.toFixed(3)} pp`;
  const codeLine = (r) => `${r.k}${r.ctype ? ` (${r.ctype})` : ""}${r.descr ? ` ${String(r.descr).replace(/_/g, " ").slice(0, 50)}` : ""}: ${fmtPct(r.sBase, 3)} → ${fmtPct(r.sNow, 3)} of attempts (${fmtPp(r.d)})`;
  const build = () => ({
    scope: bank,
    title: `${bank}${name ? ` · ${name}` : ""} payer SR ${head ? `${fmtPp(head.dsr)} vs ${label.base}` : "investigation"}`,
    windowNow: win.now,
    windowBase: win.base,
    sections: [
      {
        heading: "Headline",
        lines: head
          ? [`${label.now} ${win.now[0]} → ${win.now[1]} vs ${label.base} ${win.base[0]} → ${win.base[1]}`, `SR ${fmtPct(head.srNow)} vs ${fmtPct(head.srBase)} (${fmtPp(head.dsr)})`, `${fmtNum(head.tNow)} txns, ${fmtNum(head.fNow)} failures`]
          : ["No attempts in the current window"],
      },
      { heading: "By flow (page's handle filter)", lines: byFlow.slice(0, 6).map(rowLine) },
      { heading: "By payer handle (page's flow filter)", lines: byHandle.slice(0, 6).map(rowLine) },
      { heading: "Failure type split (BD / TD / RD, % of attempts)", lines: types.slice(0, 6).map(codeLine) },
      { heading: "Error codes, top 10 by rise (% of attempts; a +0.10 pp rise costs 0.10 pp of SR)", lines: codes.slice(0, 10).map(codeLine) },
    ],
  });
  const create = async () => {
    setOpen(true);
    setBusy(true);
    setErr(null);
    setSaved(false);
    setBrief(null);
    try {
      const res = await fetch("/api/udash/brief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(build()) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setBrief(d);
      setV((x) => ({ ...x, label: "" }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const chatText = brief
    ? `Act as my PM analyst partner using the Premium /investigate method (signal mode, brief variant).\n\nBelow is a dashboard brief for payer bank ${bank}. Treat it as the observed signal, not the cause. Do this: (1) restate the signal in one line, (2) check the listed notes first for an existing explanation, (3) list 3-5 ranked root-cause hypotheses, each with the evidence it needs, what would falsify it, and a Trino SQL query I can run (raw switch.* tables need these filters: dl_last_updated partition, created_on window, business_type IS NULL, type IN ('PAY','COLLECT'), category IN ('VPA2VPA','VPA2ACCOUNT','VPA2MERCHANT'), psp_handle in scope; participants table: participant_type = 'PAYER'), (4) note that BD rises are customer-side and TD/RD rises are the ones to escalate. Do not claim a root cause without query results; I will paste results back.\n\n${brief.markdown}`
    : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chatText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("Copy failed: select the text in the box and copy it manually.");
    }
  };
  const save = async () => {
    setErr(null);
    try {
      const body = { kind: "investigation", date: win.now[0], scope: bank, status: v.status, confidence: v.confidence, ticket: v.ticket.trim() || null, briefId: brief?.id || null, label: v.label.trim() };
      const res = await fetch("/api/udash/annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setSaved(true);
      window.dispatchEvent(new Event("udash-notes-changed"));
    } catch (e) {
      setErr(e.message);
    }
  };
  const prior = notes.filter((n) => n.kind === "investigation");
  return (
    <>
      <button type="button" style={{ ...btn(), color: "#c084fc" }} onClick={create} title="Write a brief for this bank and investigate it in Claude Code or Claude chat">
        🔎 Investigate{prior.length ? ` (${prior.length})` : ""}
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(820px, 100%)", maxHeight: "88vh", overflow: "auto", padding: 16 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <b style={{ fontSize: 15 }}>
                🔎 Investigate {bank}
                {name ? ` · ${name}` : ""}
              </b>
              <button type="button" style={{ ...btn(), marginLeft: "auto" }} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            {busy && <div style={{ color: C.muted, fontSize: 12 }}>Writing brief…</div>}
            {err && <div style={{ color: C.bad, fontSize: 12, marginBottom: 6 }}>{err}</div>}
            {brief && (
              <>
                <div style={{ fontSize: 12, color: C.text2, marginBottom: 6 }}>
                  Brief <b>{brief.id}</b> saved to <code>{brief.path}</code>
                </div>
                <div style={{ fontSize: 12, marginBottom: 4 }}>
                  <b>Claude Code:</b> in a terminal run <code>cd ~/prd-agent/premium &amp;&amp; claude</code>, then type <code>/investigate brief {brief.id}</code> (or <code>/investigate brief latest</code>).
                </div>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <b>Claude chat:</b> click Copy, open a new chat, paste. Chat has no Trino access: it proposes hypotheses and SQL, you run the SQL and paste results back.
                </div>
                <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                  <button type="button" style={btn("primary")} onClick={copy}>
                    {copied ? "Copied ✓" : "Copy for Claude chat"}
                  </button>
                </div>
                <textarea readOnly value={chatText} style={{ ...selectStyle, width: "100%", height: 150, fontFamily: "monospace", fontSize: 11, boxSizing: "border-box" }} />
                <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 4px" }}>Record the verdict</div>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>Claude Code writes this itself at the end of /investigate. Use this form for chat investigations or to correct one. It shows on this bank&apos;s deep-dive and in 📝 Notes.</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <select style={selectStyle} value={v.status} onChange={(e) => setV((x) => ({ ...x, status: e.target.value }))} aria-label="Status">
                    {["CONFIRMED", "DISPROVED", "SUSPECTED", "OPEN", "CLOSED-NON-ISSUE"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <select style={selectStyle} value={v.confidence} onChange={(e) => setV((x) => ({ ...x, confidence: e.target.value }))} aria-label="Confidence">
                    {["HIGH", "MEDIUM", "LOW"].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <input style={{ ...selectStyle, width: 110 }} value={v.ticket} onChange={(e) => setV((x) => ({ ...x, ticket: e.target.value }))} placeholder="TPAP-1234" aria-label="Jira ticket (optional)" />
                  <input style={{ ...selectStyle, flex: 1, minWidth: 220 }} value={v.label} maxLength={120} onChange={(e) => setV((x) => ({ ...x, label: e.target.value }))} placeholder="One-line cause, e.g. CBS timeouts, TD rise on U30" aria-label="Cause" />
                  <button type="button" style={btn("primary")} onClick={save} disabled={!v.label.trim() || saved}>
                    {saved ? "Saved ✓" : "Save verdict"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** Incident notes (NPCI / bank downtime notices, festivals) — drawn on trend charts, listed in the bank deep-dive. */
function NotesManager({ notes, reload }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ date: "", end: "", scope: "all", label: "" });
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null);
    try {
      const res = await fetch("/api/udash/annotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, end: form.end || null }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setForm({ date: "", end: "", scope: "all", label: "" });
      reload();
    } catch (e) {
      setErr(e.message);
    }
  };
  const del = async (id) => {
    await fetch(`/api/udash/annotations/${id}`, { method: "DELETE" }).catch(() => {});
    reload();
  };
  return (
    <>
      <button type="button" style={{ ...btn(), color: "#c084fc" }} onClick={() => setOpen(true)} title="Incident notes shown on the trend charts">
        📝 Notes ({notes.length})
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, width: "min(760px, 100%)", maxHeight: "85vh", overflow: "auto", padding: 16 }}
          >
            <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
              <b style={{ fontSize: 15 }}>📝 Incident notes</b>
              <button type="button" style={{ ...btn(), marginLeft: "auto" }} onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
              NPCI / bank downtime notices, festivals, known incidents. Scope &quot;all&quot; marks every trend chart; a payer bank code (e.g. SBIN) shows in that bank&apos;s deep-dive.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 10 }}>
              <input type="date" style={selectStyle} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} aria-label="From" />
              <input type="date" style={selectStyle} value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} aria-label="To (optional)" />
              <input style={{ ...selectStyle, width: 90 }} value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))} placeholder="all / SBIN" aria-label="Scope" />
              <input
                style={{ ...selectStyle, flex: 1, minWidth: 200 }}
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="e.g. SBIN CBS downtime (NPCI circular)"
              />
              <button type="button" style={btn("primary")} onClick={save} disabled={!form.date || !form.label.trim()}>
                Add
              </button>
            </div>
            {err && <div style={{ color: C.bad, fontSize: 12, marginBottom: 6 }}>{err}</div>}
            <Table
              maxHeight={360}
              columns={[
                { key: "date", label: "Date", align: "left", render: (r) => `${r.date}${r.end && r.end !== r.date ? ` → ${r.end}` : ""}` },
                { key: "scope", label: "Scope", align: "left" },
                {
                  key: "label",
                  label: "Note",
                  align: "left",
                  render: (r) => (r.kind === "investigation" ? `🔎 [${r.status}${r.confidence ? ` · ${r.confidence}` : ""}${r.ticket ? ` · ${r.ticket}` : ""}] ${r.label}` : r.label),
                },
                {
                  key: "x",
                  label: "",
                  sortValue: () => 0,
                  render: (r) => (
                    <button type="button" style={{ ...btn(), padding: "1px 8px" }} onClick={() => del(r.id)}>
                      Delete
                    </button>
                  ),
                },
              ]}
              rows={[...notes].sort((a, b) => (a.date < b.date ? 1 : -1)).map((n) => ({ ...n, _key: n.id }))}
              empty="No notes yet."
            />
          </div>
        </div>
      )}
    </>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

// Which card each backend section lives in (page anchors).
const ANCHOR_OF = {
  breakdown: "breakdown",
  escalate: "escalate",
  declines: "declines",
  codes: "declines",
  raw: "sr",
  dims: "psp",
  bank: "bank",
  bankday: "bank",
  bankrep: "bank",
  share: "share",
  merchants: "psp",
};

/**
 * Payer banks the Looker table files under "Others" (section bankx: raw txns, per day × handle × flow
 * × bank, code "" = totals, else failures by code) → their own kind-"bank" rows in the breakdown, and
 * the same totals / per-code failures taken out of "Others". bx must already be filtered by handle / flow.
 */
function mergeBreakout(rows, bx) {
  // Nothing to merge into until the breakdown view has arrived (else A would show only these banks).
  if (!bx?.length || !rows?.length) return rows;
  const subT = {}; // ts → { t, s } to take out of Others
  const subC = {}; // ts|code → failures to take out of Others
  const add = [];
  const tot = {};
  for (const r of bx) {
    const t = Number(r.total) || 0;
    const sc = Number(r.success) || 0;
    if (!r.code) {
      const k = `${r.ts}|${r.bank}`;
      const a = (tot[k] ||= { ts: r.ts, bank: r.bank, t: 0, s: 0 });
      a.t += t;
      a.s += sc;
      const o = (subT[r.ts] ||= { t: 0, s: 0 });
      o.t += t;
      o.s += sc;
    } else {
      const f = t - sc;
      if (f <= 0) continue;
      add.push({ ts: r.ts, kind: "bank", dim: r.bank, code: r.code, descr: "", total: f, success: 0 });
      subC[`${r.ts}|${r.code}`] = (subC[`${r.ts}|${r.code}`] || 0) + f;
    }
  }
  for (const a of Object.values(tot)) add.push({ ts: a.ts, kind: "bank", dim: a.bank, code: "", descr: "", total: a.t, success: a.s });
  const named = new Set(add.map((r) => r.dim));
  const out = rows
    .filter((r) => !(r.kind === "bank" && named.has(r.dim))) // never double count if Looker ever names them
    .map((r) => {
      if (r.kind !== "bank" || r.dim !== "Others") return r;
      const total = Number(r.total) || 0;
      const success = Number(r.success) || 0;
      if (!r.code) {
        const x = subT[r.ts];
        return x ? { ...r, total: Math.max(0, total - x.t), success: Math.max(0, success - x.s) } : r;
      }
      const f = subC[`${r.ts}|${r.code}`];
      return f ? { ...r, total: success + Math.max(0, total - success - f) } : r;
    });
  return [...out, ...add];
}

/**
 * The merged raw section → the row shapes each intraday card's body expects.
 * tot rows: (ts, handle, flow, status, u09) · code rows: (ts, status, acode, ecode).
 */
function splitRaw(res, handleSel) {
  if (!res) return {};
  const tot = res.rows.filter((r) => r.grp === "tot" && inHandle(r.handle, handleSel));
  const code = res.rows.filter((r) => r.grp === "code");
  const sum = (rows, keyOf, valOf) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const key = JSON.stringify(k);
      const acc = m.get(key) || {
        ...k,
        ...Object.fromEntries(Object.keys(valOf(r)).map((x) => [x, 0])),
      };
      for (const [x, v] of Object.entries(valOf(r))) acc[x] += v;
      m.set(key, acc);
    }
    return [...m.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  };
  const cnt = (r) => Number(r.cnt) || 0;
  return {
    // Intraday P2P split by txn category (VPA2VPA / VPA2ACCOUNT); raw txns have no P2M sub-type.
    subP2P: sum(
      tot.filter((r) => r.flow === "P2P" && r.cat),
      (r) => ({ ts: r.ts, cat: r.cat }),
      (r) => ({ total: cnt(r), success: r.status === "SUCCESS" ? cnt(r) : 0 }),
    ),
    sr: {
      ...res,
      rows: sum(
        tot,
        (r) => ({ ts: r.ts, handle: r.handle, flow: r.flow }),
        (r) => ({
          total: cnt(r),
          success: r.status === "SUCCESS" ? cnt(r) : 0,
        }),
      ),
    },
    u09: {
      ...res,
      rows: sum(
        tot,
        (r) => ({ ts: r.ts, handle: r.handle, flow: r.flow }),
        (r) => ({ total: cnt(r), u09: Number(r.u09) === 1 ? cnt(r) : 0 }),
      ),
    },
    // FAILURE only: other statuses are the denominator (__NONFAIL__), as in the Morning Dashboard.
    errors: {
      ...res,
      rows: sum(
        code,
        (r) => ({
          ts: r.ts,
          code: r.status === "FAILURE" ? r.ecode || "(blank)" : "__NONFAIL__",
        }),
        (r) => ({ cnt: cnt(r) }),
      ),
    },
    // Every non-success status, bucketed by app_resp_code (falling back to the status).
    errbreak: {
      ...res,
      rows: sum(
        code,
        (r) => ({
          ts: r.ts,
          code: r.status === "SUCCESS" ? "__NONFAIL__" : r.acode || r.status,
        }),
        (r) => ({ cnt: cnt(r) }),
      ),
    },
  };
}
const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Card for on-demand tools (not a backend section: no schedule / duration). */
function ToolCard({ anchor, title, sub, children }) {
  const lay = useContext(LayoutCtx);
  const mode = lay ? lay.mode(anchor) : "open";
  if (mode === "docked" || (lay?.solo && lay.solo !== anchor)) return null;
  const collapsed = mode === "collapsed";
  return (
    <section
      id={`udash-${anchor}`}
      style={{
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        padding: collapsed ? "10px 18px" : "16px 20px",
        marginBottom: collapsed ? 10 : 18,
        scrollMarginTop: 140,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: collapsed ? 0 : 4 }}>
        <LayoutButtons anchor={anchor} />
        <h2 style={{ margin: 0, fontSize: collapsed ? 14 : 15, color: C.text, fontWeight: 700 }}>{title}</h2>
      </div>
      {!collapsed && sub && <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>{sub}</div>}
      {!collapsed && children}
    </section>
  );
}

function Hint({ children }) {
  return <div style={{ fontSize: 11, color: C.muted, margin: "2px 0 12px", lineHeight: 1.5 }}>{children}</div>;
}

export default function UnifiedSrDashboard() {
  const [state, setState] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [page, setPage] = useState("dash");
  const [now, setNow] = useState(Date.now());
  const [durOverrides, setDurOverrides] = useState(() => lsGet("durations", {}));
  // Global filters (day-level cards).
  const [handleSel, setHandleSel] = useState(() => lsGet("handle", "tpap"));
  const [flowSel, setFlowSel] = useState(() => lsGet("flow", "ALL"));
  const [pspMode, setPspMode] = useState(() => lsGet("pspMode", "detailed"));
  // Per-card modes.
  const [srMode, setSrMode] = useState(() => lsGet("srMode", "intraday"));
  const [srFlow, setSrFlow] = useState("ALL");
  const [flowGrain, setFlowGrain] = useState(() => lsGet("grain:flow", "week"));
  const [flowLite, setFlowLite] = useState(false);
  const [errDef, setErrDef] = useState(() => lsGet("errDef", "errors"));
  const [errMetric, setErrMetric] = useState("pct");
  const [u09Metric, setU09Metric] = useState("pct");
  const [u09By, setU09By] = useState("none"); // none | handle | psp
  const [trendBy, setTrendBy] = useState("flow"); // C trend: flow | sub-flow
  const [dType, setDType] = useState("all"); // D: all | TD | BD | RD | Others
  const [dView, setDView] = useState("codes"); // D: codes | decline types
  const [pspTop, setPspTop] = useState(true); // G: top 10 + rest
  const [shareBy, setShareBy] = useState("handle"); // I: handle | os | instrument | sub
  const [bankMode, setBankMode] = useState(() => lsGet("bankMode2", "bankrep"));
  // Card layout: { [anchor]: "collapsed" | "docked" } (absent = open), focus card, dock rail open.
  const [layout, setLayout] = useState(() => lsGet("layout", {}));
  const [solo, setSolo] = useState(null);
  const [railOpen, setRailOpen] = useState(() => lsGet("railOpen", true));
  useEffect(() => lsSet("layout", layout), [layout]);
  useEffect(() => lsSet("railOpen", railOpen), [railOpen]);
  // The dock rail (position: fixed) sits just below the sticky header, whose height changes with the
  // window width; track the header's bottom edge in the viewport.
  const [headerH, setHeaderH] = useState(170);
  const headerRO = useRef(null);
  const headerRef = useCallback((el) => {
    headerRO.current?.disconnect();
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeaderH(Math.round(el.getBoundingClientRect().bottom));
    measure();
    headerRO.current = new ResizeObserver(measure);
    headerRO.current.observe(el);
  }, []);
  const setMode = useCallback(
    (anchor, m) =>
      setLayout((o) => {
        const n = { ...o };
        if (m === "open") delete n[anchor];
        else n[anchor] = m;
        return n;
      }),
    [],
  );
  const [bankFlow, setBankFlow] = useState("ALL");
  const [bankChart, setBankChart] = useState("watch");
  const [shareMetric, setShareMetric] = useState("share");
  const [pspMetric, setPspMetric] = useState("sr");
  const [pspDays, setPspDays] = useState(15);
  const [instMetric, setInstMetric] = useState("sr");
  const [instGrain, setInstGrain] = useState(() => lsGet("grain:instrument", "day"));
  const [codesTop, setCodesTop] = useState(15);
  const [pivotDays, setPivotDays] = useState(7);
  const [pivotMetric, setPivotMetric] = useState("count");
  // Cross-links between A (breakdown) and B (decline codes).
  const [driverCode, setDriverCode] = useState(null);
  const [declineFocus, setDeclineFocus] = useState(null);
  // A · extra filters: a live day-level slice { rows, sig, label } that replaces A's cached view.
  const [aSlice, setASlice] = useState(null);
  // Incident notes + one-click escalation from F into K.
  const [notes, setNotes] = useState([]);
  const loadNotes = useCallback(() => {
    fetch("/api/udash/annotations")
      .then((r) => r.json())
      .then((d) => setNotes(d.annotations || []))
      .catch(() => {});
  }, []);
  useEffect(() => loadNotes(), [loadNotes]);
  // The investigation modal (inside the bank deep-dive) saves verdicts and asks the page to refetch.
  useEffect(() => {
    window.addEventListener("udash-notes-changed", loadNotes);
    return () => window.removeEventListener("udash-notes-changed", loadNotes);
  }, [loadNotes]);
  const [escReq, setEscReq] = useState(null);
  // B · codes for one payee PSP / payer bank: { kind: "psp" | "bank", dim } | null.
  const [bScope, setBScope] = useState(null);
  // B has its own payer-handle / flow filter (defaults: all 4 TPAP handles, both flows).
  const [bHandle, setBHandle] = useState("tpap");
  const [bFlow, setBFlow] = useState("ALL");
  const [bViews, setBViews] = useState({}); // { [section]: { key, ranAt, rows } } for B's key
  const [bTopBy, setBTopBy] = useState("rise"); // B top banks: rise (impact) | fails (volume)
  const [dHide, setDHide] = useState(false); // D: hide U30-Z9 / U30-ZM (customer-side) from the trend
  const [eWin, setEWin] = useState("intraday"); // E: intraday (raw) | 15d (day-level)
  const [eFlow, setEFlow] = useState("ALL"); // E: ALL | P2P | P2M
  // Per-filter rows for the view sections: { [section]: { key, ranAt, rows } }.
  const [views, setViews] = useState({});
  const viewsRef = useRef({});
  const resultsRef = useRef({});
  const skew = useRef(0);

  useEffect(() => lsSet("handle", handleSel), [handleSel]);
  useEffect(() => lsSet("flow", flowSel), [flowSel]);
  useEffect(() => lsSet("pspMode", pspMode), [pspMode]);
  useEffect(() => lsSet("srMode", srMode), [srMode]);
  useEffect(() => lsSet("errDef", errDef), [errDef]);
  useEffect(() => lsSet("bankMode2", bankMode), [bankMode]);
  useEffect(() => lsSet("grain:flow", flowGrain), [flowGrain]);
  useEffect(() => lsSet("grain:instrument", instGrain), [instGrain]);
  useEffect(() => lsSet("durations", durOverrides), [durOverrides]);

  const reload = useCallback(async () => {
    try {
      // Sections whose rows we already hold come back with rows: null.
      const have = Object.entries(resultsRef.current)
        .filter(([, r]) => r?.ranAt && r.rows?.length)
        .map(([k, r]) => `${k}:${r.ranAt}`)
        .join(",");
      const s = await api(`/state?have=${encodeURIComponent(have)}`);
      const merged = {};
      for (const [k, r] of Object.entries(s.results || {})) merged[k] = r.rows === null ? { ...r, rows: resultsRef.current[k]?.rows || [] } : r;
      resultsRef.current = merged;
      s.results = merged;
      skew.current = s.now - Date.now();
      if (s.durationOptions) DURATION_OPTS = s.durationOptions;
      setState(s);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e.message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const anyActive = state && [...SECTION_IDS, "bankalert", "bankdwh"].some((id) => ACTIVE.has(state.jobs[id]?.status));
  useEffect(() => {
    if (!anyActive) return undefined;
    const poll = setInterval(reload, 2000);
    const tick = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [anyActive, reload]);

  const scheduleOn = Boolean(state?.config?.schedule?.enabled);
  useEffect(() => {
    if (anyActive || !scheduleOn) return undefined;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") reload();
      setNow(Date.now() + skew.current);
    }, 60000);
    return () => clearInterval(poll);
  }, [anyActive, scheduleOn, reload]);

  // Fetch the breakdown / codes view for the current filters whenever either changes or a run lands.
  const bdRan = state?.results?.breakdown?.ranAt;
  const cdRan = state?.results?.codes?.ranAt;
  useEffect(() => {
    const key = `${handleSel}|${flowSel}`;
    const ctl = { dead: false };
    for (const [sec, ran] of [
      ["breakdown", bdRan],
      ["codes", cdRan],
    ]) {
      if (!ran) continue;
      const cur = viewsRef.current[sec];
      if (cur?.key === key && cur?.ranAt === ran) continue;
      api(`/view?section=${sec}&handle=${handleSel}&flow=${flowSel}`)
        .then((v) => {
          if (ctl.dead) return;
          viewsRef.current = { ...viewsRef.current, [sec]: v };
          setViews(viewsRef.current);
        })
        .catch(() => {});
    }
    return () => {
      ctl.dead = true;
    };
  }, [handleSel, flowSel, bdRan, cdRan]);

  const cfg = state?.config;
  const durations = useMemo(() => {
    if (!cfg) return {};
    const pick = (id) => {
      const valid = durationLabels(id);
      const d = [durOverrides[id], cfg.sectionDurations?.[id], cfg.defaultDuration].find((x) => x && valid[x]);
      return d || Object.keys(valid)[0];
    };
    return Object.fromEntries(SECTION_IDS.map((id) => [id, pick(id)]));
  }, [cfg, durOverrides]);

  // ── filtered results ──
  const R = useMemo(() => {
    if (!state) return {};
    const res = state.results;
    const key = `${handleSel}|${flowSel}`;
    const hf = (r) => inHandle(r.handle, handleSel) && inFlow(r.flow, flowSel);
    const viewOf = (sec) =>
      res[sec] && {
        ...res[sec],
        rows: views[sec]?.key === key && views[sec]?.ranAt === res[sec].ranAt ? views[sec].rows : [],
      };
    const withRows = (sec, f) => res[sec] && { ...res[sec], rows: f(res[sec].rows || []) };
    const dimRows = (kind) => (rows) => rows.filter((r) => r.kind === kind && hf(r));
    const wide = (rows) => {
      const by = {};
      for (const r of rows) {
        const o = (by[r.ts] ||= { ts: r.ts });
        o[r.dim] = (o[r.dim] || 0) + r.success;
      }
      return Object.values(by).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    };
    // Breakdown PSP rows carry raw payee-handle keys; group them per the PSP map (rows sum downstream).
    // A live slice from "More filters" wins while the page's handle / flow filters still match it.
    const slice = aSlice && aSlice.sig === `${handleSel}|${flowSel}|${pspMode}` ? aSlice : null;
    const bd = slice
      ? res.breakdown && {
          ...res.breakdown,
          rows: slice.rows,
          slice: slice.label,
        }
      : viewOf("breakdown");
    // Banks hidden in Looker's "Others" (JIOP, NESF, SURY, NSPB…) come from raw txns — not on a live slice.
    const bx = slice ? null : (res.bankx?.rows || []).filter((r) => inHandle(r.handle, handleSel) && inFlow(r.flow, flowSel));
    const breakdown = bd && {
      ...bd,
      rows: mergeBreakout(
        bd.rows.map((r) => (r.kind === "psp" ? { ...r, dim: pspGroup(r.dim, pspMode) } : r)),
        bx,
      ),
    };
    return {
      breakdown,
      codes: viewOf("codes"),
      declines: withRows("declines", (rows) => rows.filter(hf)),
      flowDay: withRows("dims", (rows) =>
        dimRows("flow")(rows).map((r) => ({
          ts: r.ts,
          kind: "flow",
          flow: r.dim,
          total: r.total,
          success: r.success,
        })),
      ),
      psp: withRows("dims", (rows) =>
        dimRows("psp")(rows).map((r) => ({
          ts: r.ts,
          psp: pspGroup(r.dim, pspMode),
          total: r.total,
          success: r.success,
        })),
      ),
      instrument: withRows("dims", (rows) =>
        dimRows("instrument")(rows).map((r) => ({
          ts: r.ts,
          flow: r.flow,
          instrument: r.dim,
          total: r.total,
          success: r.success,
        })),
      ),
      // Paytm Postpaid (CREDITLINE on SURY) — a subset of CREDITLINE, kept apart so totals don't double count.
      pp: withRows("dims", (rows) => dimRows("pp")(rows).map((r) => ({ ts: r.ts, flow: r.flow, instrument: "Paytm Postpaid", total: r.total, success: r.success }))),
      sub: withRows("dims", (rows) => dimRows("sub")(rows).map((r) => ({ ts: r.ts, flow: r.dim, total: r.total, success: r.success }))),
      // Share of successful txns per day by OS / instrument / sub-flow (wide rows for ShareBody).
      shareOs: withRows("dims", (rows) => wide(dimRows("os")(rows))),
      shareInstrument: withRows("dims", (rows) => wide(dimRows("instrument")(rows))),
      shareSub: withRows("dims", (rows) => wide(dimRows("sub")(rows))),
      merchants: res.merchants,
      bankrep: res.bankrep,
      bankday: withRows("bankday", (rows) => rows.filter((r) => inHandle(r.handle, handleSel))),
      ...splitRaw(res.raw, handleSel),
      // The intraday payer-bank query also carries U09 by payee PSP (grp "psp", card E).
      bank: withRows("bank", (rows) => rows.filter((r) => !r.grp || r.grp === "bank")),
      bankU09: res.bank,
      share: res.share,
    };
  }, [state, views, handleSel, flowSel, pspMode, aSlice]);

  // ── scorecards (G, H, B) — periods anchored on the latest complete day in dims ──
  const P = useMemo(() => {
    const rows = R.flowDay?.rows || [];
    const yday = rows.length ? pickYday(rows, { kind: "flow" }) : null;
    return yday ? periods(yday) : null;
  }, [R.flowDay]);
  const per = periodLabels(P);
  const score = useMemo(() => {
    if (!P) return null;
    const byMtd = (agg) => (a, b) => (agg[b]?.mtd.total || 0) - (agg[a]?.mtd.total || 0);
    const pspAll = aggregate(
      (R.psp?.rows || []).map((r) => ({ ...r, dim: r.psp })),
      P,
    );
    // Top 10 by MTD volume; the rest folded into one "All others" row (toggle shows every PSP).
    const top10 = new Set(
      Object.keys(pspAll)
        .filter((k) => k !== "__ALL__")
        .sort(byMtd(pspAll))
        .slice(0, 10),
    );
    const pspAgg = pspTop
      ? aggregate(
          (R.psp?.rows || []).map((r) => ({ ...r, dim: top10.has(r.psp) ? r.psp : "All others" })),
          P,
        )
      : pspAll;
    const pspKnown = PSP_ORDER[pspMode].filter((k) => pspAgg[k] && k !== "All others");
    const pspExtra = Object.keys(pspAgg)
      .filter((k) => k !== "__ALL__" && k !== "All others" && !PSP_ORDER[pspMode].includes(k))
      .sort(byMtd(pspAgg))
      .concat(pspAgg["All others"] ? ["All others"] : []);
    const instAgg = aggregate(
      (R.instrument?.rows || []).map((r) => ({ ...r, dim: r.instrument })),
      P,
    );
    const instOrder = Object.keys(instAgg)
      .filter((k) => k !== "__ALL__")
      .sort(byMtd(instAgg));

    return {
      psp: (() => {
        const sc = scoreRows(pspAgg, [...pspKnown, ...pspExtra], pspMetric);
        if (pspMode === "handle") sc.rows = sc.rows.map((r) => ({ ...r, title: pspParent(r.dim) }));
        return sc;
      })(),
      inst: (() => {
        const sc = scoreRows(instAgg, instOrder, instMetric);
        const pp = scoreRows(
          aggregate(
            (R.pp?.rows || []).map((r) => ({ ...r, dim: "Paytm Postpaid" })),
            P,
          ),
          ["Paytm Postpaid"],
          instMetric,
        ).rows[0];
        if (pp && pp.cells.some((c) => c != null && c !== 0)) {
          const at = sc.rows.findIndex((r) => r.dim === "CREDITLINE");
          sc.rows.splice(at >= 0 ? at + 1 : sc.rows.length, 0, { ...pp, dim: "↳ Paytm Postpaid", title: "CREDITLINE on SURY — part of CREDITLINE, not added to Overall" });
        }
        return sc;
      })(),
    };
  }, [P, R.psp, R.instrument, R.pp, pspMode, pspMetric, instMetric, pspTop]);

  // A rows (numbers normalised) + latest complete day; B rows for a payee PSP / payer bank scope.
  const aRows = useMemo(() => (R.breakdown?.rows || []).map((r) => ({ ...r, code: r.code || "", total: Number(r.total) || 0, success: Number(r.success) || 0 })), [R.breakdown]);
  const aYday = useMemo(() => (aRows.length ? pickYday(aRows, { kind: "bank" }) : null), [aRows]);
  // A · LMTD reference per kind / dim on the page's handle / flow (A itself only holds 10 days):
  // PSP / instrument / flow from dims, payer bank from the bank report (both span LMTD).
  // Not shown on a live "More filters" slice — the LMTD sources don't carry its extra filters.
  const aLmtd = useMemo(() => {
    if (!aYday || R.breakdown?.slice) return null;
    const PA = periods(aYday);
    const days = lmtdDays(PA);
    const byKind = {};
    const add = (kind, dim, r) => {
      if (r.ts < PA.lmtdFrom || r.ts > PA.lmtdTo) return;
      for (const d of [dim, "__ALL__"]) {
        const o = ((byKind[kind] ||= {})[d] ||= { total: 0, success: 0 });
        o.total += Number(r.total) || 0;
        o.success += Number(r.success) || 0;
      }
    };
    for (const r of R.psp?.rows || []) add("psp", r.psp, r);
    for (const r of R.instrument?.rows || []) add("instrument", r.instrument, r);
    for (const r of R.flowDay?.rows || []) add("flow", r.flow, r);
    for (const r of state?.results?.bankrep?.rows || []) if (r.grp === "base" && inHandle(r.handle, handleSel) && inFlow(r.flow, flowSel)) add("bank", r.bank, r);
    if (!Object.keys(byKind).length) return null;
    return { label: periodLabels(PA).lmtd, days, byKind };
  }, [aYday, R.breakdown, R.psp, R.instrument, R.flowDay, state, handleSel, flowSel]);
  const bankLabelOf = useCallback((kind, dim) => (kind === "bank" ? (cfg?.remitterBanks || []).find((b) => b.code === dim)?.name || null : null), [cfg]);
  // B · its own handle / flow views (the page's views are reused when the keys match).
  const bKey = `${bHandle}|${bFlow}`;
  const pageKey = `${handleSel}|${flowSel}`;
  useEffect(() => {
    if (bKey === pageKey || !state) return undefined;
    const ctl = { dead: false };
    for (const sec of ["breakdown", "codes"]) {
      const ran = state.results[sec]?.ranAt;
      if (!ran || (bViews[sec]?.key === bKey && bViews[sec]?.ranAt === ran)) continue;
      api(`/view?section=${sec}&handle=${bHandle}&flow=${bFlow}`)
        .then((v) => !ctl.dead && setBViews((o) => ({ ...o, [sec]: v })))
        .catch(() => {});
    }
    return () => {
      ctl.dead = true;
    };
  }, [bKey, pageKey, bHandle, bFlow, state, bViews]);
  const bView = useCallback(
    (sec) => {
      const ran = state?.results?.[sec]?.ranAt;
      const v = bKey === pageKey ? views[sec] : bViews[sec];
      return v && v.key === bKey && v.ranAt === ran ? v.rows : null;
    },
    [state, bKey, pageKey, views, bViews],
  );
  const bRows = useMemo(
    () =>
      mergeBreakout(
        (bView("breakdown") || []).map((r) => ({
          ...r,
          dim: r.kind === "psp" ? pspGroup(r.dim, pspMode) : r.dim,
          code: r.code || "",
          total: Number(r.total) || 0,
          success: Number(r.success) || 0,
        })),
        (state?.results?.bankx?.rows || []).filter((r) => inHandle(r.handle, bHandle) && inFlow(r.flow, bFlow)),
      ).map((r) => ({ ...r, total: Number(r.total) || 0, success: Number(r.success) || 0 })),
    [bView, pspMode, state, bHandle, bFlow],
  );
  const bYday = useMemo(() => (bRows.length ? pickYday(bRows, { kind: "bank" }) : null), [bRows]);
  const bCodes = useMemo(() => (bView("codes") || []).map((r) => ({ ...r, total: Number(r.total) || 0, success: Number(r.success) || 0 })), [bView]);
  // Day volume for B's handle / flow (denominator of the day pivot), from dims.
  const bFlowDay = useMemo(() => {
    const vol = {};
    for (const r of state?.results?.dims?.rows || []) if (r.kind === "flow" && inHandle(r.handle, bHandle) && inFlow(r.flow, bFlow)) vol[r.ts] = (vol[r.ts] || 0) + r.total;
    return vol;
  }, [state, bHandle, bFlow]);
  // B · top codes with Yesterday / MTD / LMTD contribution, on B's handle / flow.
  const [bCodePick, setBCodePick] = useStored("udash-B-codes:rows", NO_PICK);
  const [bCodeHide, setBCodeHide] = useStored("udash-B-codes:cols", B_CODES_HIDDEN_COLS);
  const bScoreCodes = useMemo(() => {
    if (!P) return null;
    const codeRows = bCodes.map((r) => ({ ...r, dim: r.code }));
    const descr = Object.fromEntries(codeRows.filter((r) => r.descr).map((r) => [r.code, r.descr]));
    return errorRows(aggregate(codeRows, P), codesTop, descr, "Other codes (long tail)", { lmtdDays: lmtdDays(P), pick: bCodePick });
  }, [P, bCodes, codesTop, bCodePick]);
  // Key numbers shown on collapsed cards and in the dock rail.
  const cardSummaries = useMemo(() => {
    const out = {};
    const pctOf = (x) => (x?.total > 0 ? `${((x.success * 100) / x.total).toFixed(2)}%` : "—");
    if (aYday) {
      const d = { total: 0, success: 0 };
      for (const r of aRows) {
        if (r.kind !== "flow" || r.code || r.ts !== aYday) continue;
        d.total += r.total;
        d.success += r.success;
      }
      const l = aLmtd?.byKind?.flow?.__ALL__;
      out.breakdown = `SR ${pctOf(d)} on ${aYday.slice(5)}${l ? ` · LMTD ${pctOf(l)}` : ""}`;
    }
    if (bScoreCodes?.total) {
      const top = bScoreCodes.rows[0];
      const dl = bScoreCodes.total.cells[9];
      out.declines = `${Math.round(bScoreCodes.total.cells[0]).toLocaleString("en-IN")} fails${dl != null ? ` (${dl > 0 ? "+" : ""}${dl.toFixed(1)}% vs LMTD/day)` : ""}${top ? ` · top ${top.dim}` : ""}`;
    }
    const src = { sr: "raw", errors: "raw", u09: "raw", bank: "bankrep", psp: "dims", instrument: "dims", share: "share" };
    for (const [a, sec] of Object.entries(src)) {
      const r = state?.results?.[sec];
      out[a] = r ? `data as of ${fmtTime(r.ranAt)}` : "not run";
    }
    return out;
  }, [aYday, aRows, aLmtd, bScoreCodes, state]);
  const bDeclines = useMemo(
    () => state?.results?.declines && { ...state.results.declines, rows: state.results.declines.rows.filter((r) => inHandle(r.handle, bHandle) && inFlow(r.flow, bFlow)) },
    [state, bHandle, bFlow],
  );
  // Top 3 payer banks by failures per code on B's latest day (from A's per-bank code detail).
  // Top 3 payer banks per code on B's latest day: by failures (volume) or by rise vs the bank's own
  // L7D daily average for that code (impact). Each entry: [bank, failures now, rise].
  const bTopBanks = useMemo(() => {
    if (!bYday) return {};
    const l7From = new Date(Date.parse(`${bYday}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
    const now = {};
    const l7 = {};
    for (const r of bRows) {
      if (r.kind !== "bank" || !r.code) continue;
      const k = `${r.code}|${r.dim}`;
      const f = r.total - r.success;
      if (r.ts === bYday) now[k] = (now[k] || 0) + f;
      else if (r.ts >= l7From && r.ts < bYday) l7[k] = (l7[k] || 0) + f;
    }
    const m = {};
    for (const [k, n] of Object.entries(now)) {
      const [code, bank] = k.split("|");
      (m[code] ||= []).push([bank, n, n - (l7[k] || 0) / 7]);
    }
    for (const code of Object.keys(m))
      m[code] =
        bTopBy === "rise"
          ? m[code]
              .filter((x) => x[2] > 0)
              .sort((a, b) => b[2] - a[2])
              .slice(0, 3)
          : m[code].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return m;
  }, [bRows, bYday, bTopBy]);
  const bDims = useMemo(() => {
    const vol = { psp: {}, bank: {} };
    for (const r of bRows) if (!r.code && vol[r.kind] && r.ts === bYday) vol[r.kind][r.dim] = (vol[r.kind][r.dim] || 0) + r.total;
    const order = (m) => Object.keys(m).sort((a, b) => m[b] - m[a]);
    return { psp: order(vol.psp), bank: order(vol.bank) };
  }, [bRows, bYday]);
  const codeOptions = useMemo(() => {
    const m = {};
    for (const r of aRows) if (r.kind === "code") m[r.dim] = { code: r.dim, n: (m[r.dim]?.n || 0) + r.total - r.success, descr: r.descr || m[r.dim]?.descr || "" };
    return Object.values(m).sort((a, b) => b.n - a.n);
  }, [aRows]);
  const bResult = useMemo(() => {
    if (!state?.results?.breakdown || !bRows.length) return null;
    const base = { ...state.results.breakdown, rows: bRows };
    if (!bScope) return base;
    const descr = Object.fromEntries(bRows.filter((r) => r.kind === "code" && r.descr).map((r) => [r.dim, r.descr]));
    const scoped = bRows
      .filter((r) => r.kind === bScope.kind && r.dim === bScope.dim && r.code)
      .map((r) => ({ ts: r.ts, kind: "code", dim: r.code, code: "", descr: descr[r.code] || "", total: r.total, success: r.success }));
    return { ...base, rows: [...bRows.filter((r) => r.kind === "bank" && !r.code), ...scoped] };
  }, [state, bScope, bRows]);

  // D · decline type per code (Looker error_type / error_type_1), used to filter, group and route.
  const codeTypes = useMemo(() => {
    const m = {};
    for (const r of R.codes?.rows || []) if (r.etype && !m[r.code]) m[r.code] = { etype: r.etype, etype1: r.etype1 || r.etype };
    return m;
  }, [R.codes]);
  const dResult = useMemo(() => {
    const res = errDef === "errors" ? R.errors : R.errbreak;
    if (!res) return res;
    const typeOf = (code) => codeTypes[code]?.etype || "Unclassified";
    const rows = res.rows
      .filter((r) => r.code === "__NONFAIL__" || dType === "all" || typeOf(r.code) === dType)
      .map((r) => (dView === "types" && r.code !== "__NONFAIL__" ? { ...r, code: codeTypes[r.code]?.etype1 || "Unclassified" } : r));
    return { ...res, rows };
  }, [R.errors, R.errbreak, errDef, dType, dView, codeTypes]);
  const dSummary = useMemo(() => {
    const res = errDef === "errors" ? R.errors : R.errbreak;
    return risingCodes(res?.rows || [], codeTypes).map((c) => ({
      key: c.code,
      level: c.delta >= 0.1 ? "P1" : c.delta >= 0.03 ? "P2" : "watch",
      levelLabel: c.delta >= 0.1 ? "Escalate" : c.delta >= 0.03 ? "Escalate" : "Watch",
      title: `${c.code} (${c.etype1})`,
      detail: `${fmtPct(c.early, 3)} → ${fmtPct(c.recent, 3)} of txns (${fmtPp(c.delta)}), ${fmtNum(c.n)} in the recent half`,
      party: c.owner,
    }));
  }, [R.errors, R.errbreak, errDef, codeTypes]);

  // G · payee PSPs worth escalating — section A's rows, same score as K (≥ 30).
  const gSummary = useMemo(() => {
    if (!aYday) return [];
    const descr = Object.fromEntries(codeOptions.map((c) => [c.code, c.descr]));
    return scoreAll({ psp: buildBreakdown(aRows, { kind: "psp", yday: aYday }) }, descr)
      .filter((i) => i.score >= 30)
      .slice(0, 5)
      .map((i) => ({
        key: i.dim,
        level: i.band.id,
        levelLabel: `${i.score} · ${i.band.id === "P1" || i.band.id === "P2" ? i.band.id : "Watch"}`,
        title: i.dim,
        detail: `SR ${fmtPct(i.srNow)} (${fmtPp(i.dsr)} vs L7D), ~${fmtNum(i.lost)} lost${i.lead ? ` · ${i.lead.code} ${i.lead.share?.toFixed(0)}% of failures` : ""}`,
        party: PARTIES[i.party]?.label || i.party,
      }));
  }, [aRows, aYday, codeOptions]);

  // E · last 15 complete days of U09 from the day-level query (dims: u09 = failures with app_resp_code U09*).
  const u09Day = useMemo(() => {
    const res = state?.results?.dims;
    const rows = res?.rows || [];
    const ready = rows.some((r) => r.u09 != null);
    const days = [...new Set(rows.map((r) => r.ts))].sort().slice(-15);
    const keep = new Set(days);
    const sel = rows.filter((r) => keep.has(r.ts) && inHandle(r.handle, handleSel));
    return {
      ready,
      flow: res && { ...res, rows: sel.filter((r) => r.kind === "flow").map((r) => ({ ts: r.ts, handle: r.handle, flow: r.dim, total: r.total, u09: Number(r.u09) || 0 })) },
      psp: res && { ...res, rows: sel.filter((r) => r.kind === "psp").map((r) => ({ grp: "psp", ts: r.ts, psp: r.dim, flow: r.flow, total: r.total, u09: Number(r.u09) || 0 })) },
    };
  }, [state, handleSel]);

  // B · day pivot (Morning section 10's 2–15-day mode): failures per code per day from the
  // codes view; the rest of the day's volume (dims, same filters) is the denominator.
  const codePivot = useMemo(() => {
    const codes = bCodes;
    const vol = bFlowDay;
    const days = [...new Set(codes.map((r) => r.ts))].sort().slice(-pivotDays);
    if (!days.length || !R.codes) return null;
    const keep = new Set(days);
    const fails = {};
    const rows = [];
    for (const r of codes) {
      if (!keep.has(r.ts)) continue;
      const f = r.total - r.success;
      if (f <= 0) continue;
      fails[r.ts] = (fails[r.ts] || 0) + f;
      rows.push({ ts: r.ts, code: r.code, cnt: f });
    }
    for (const d of days) rows.push({ ts: d, code: "__NONFAIL__", cnt: Math.max(0, (vol[d] || 0) - (fails[d] || 0)) });
    return { ...R.codes, rows, window: { ...R.codes.window, bucketMin: 1440 } };
  }, [R.codes, bCodes, bFlowDay, pivotDays]);

  const pspTrend = useMemo(() => {
    const rows = R.psp?.rows || [];
    const last = rows.reduce((m, r) => (r.ts > m ? r.ts : m), "");
    if (!last || pspDays === 0) return R.psp;
    const from = addDay(last, -(pspDays - 1));
    return R.psp && { ...R.psp, rows: rows.filter((r) => r.ts >= from) };
  }, [R.psp, pspDays]);

  const run = async (sections) => {
    try {
      await api("/run", { method: "POST", body: { sections, durations } });
    } catch (e) {
      alert(e.message);
    }
    setNow(Date.now() + skew.current);
    reload();
  };
  const stop = async (sections) => {
    await api("/stop", { method: "POST", body: { sections } }).catch((e) => alert(e.message));
    reload();
  };
  const retryNow = async (section) => {
    await api("/retry-now", { method: "POST", body: { section } }).catch((e) => alert(e.message));
    reload();
  };
  const toggleSchedule = async () => {
    await api("/config", {
      method: "PUT",
      body: { schedule: { enabled: !cfg.schedule?.enabled } },
    }).catch((e) => alert(e.message));
    reload();
  };
  const toggleAutoRetry = async () => {
    await api("/config", {
      method: "PUT",
      body: { autoRetry: !cfg.autoRetry },
    }).catch((e) => alert(e.message));
    reload();
  };
  const setAllDurations = (d) =>
    setDurOverrides((o) => ({
      ...o,
      ...Object.fromEntries(INTRADAY_IDS.map((id) => [id, d])),
    }));

  if (!state) {
    return (
      <div
        style={{
          minHeight: "100%",
          background: C.bg,
          color: C.text2,
          padding: 24,
          fontFamily: "'Segoe UI', sans-serif",
        }}
      >
        {loadErr ? (
          <div>
            Could not reach the dashboard backend: {loadErr}.{" "}
            <button type="button" style={btn()} onClick={reload}>
              Retry
            </button>
          </div>
        ) : (
          "Loading cached dashboard…"
        )}
      </div>
    );
  }

  // Undock / expand (and leave focus mode) before scrolling to a card.
  const jumpTo = (id) => {
    const anchor = ANCHOR_OF[id] || id;
    if (layout[anchor]) setMode(anchor, "open");
    if (solo && solo !== anchor) setSolo(null);
    setTimeout(() => document.getElementById(`udash-${anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const docked = LAYOUT_CARDS.filter(([a]) => layout[a] === "docked");
  const layoutCtx = { mode: (a) => layout[a] || "open", set: setMode, solo, setSolo, summaries: cardSummaries };
  const failedCount = SECTION_IDS.filter((id) => ["failed", "retry-wait"].includes(state.jobs[id]?.status)).length;
  const common = (id, result = R[id]) => ({
    id,
    job: state.jobs[id],
    result,
    cfg,
    duration: durations[id],
    setDuration: (d) => setDurOverrides((o) => ({ ...o, [id]: d })),
    now,
    onRun: () => run([id]),
    onStop: () => stop([id]),
    onRetryNow: () => retryNow(id),
    sched: state.schedule?.[id],
  });
  const filterNote = `${HANDLE_LABEL[handleSel]} · ${flowSel === "ALL" ? "all flows" : flowSel}`;
  const handleNote = handleSel === "tpap" || handleSel === "all" ? "all 4 TPAP handles" : HANDLE_LABEL[handleSel];
  const viewLoading = (sec) => state.results[sec]?.ranAt && !(R[sec]?.rows || []).length;
  const declinesJob = state.jobs.declines;

  return (
    <div
      style={{
        minHeight: "100%",
        background: C.bg,
        color: C.text,
        fontFamily: "'Segoe UI', system-ui, sans-serif",
      }}
    >
      <header
        ref={headerRef}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          background: `${C.bg}f2`,
          backdropFilter: "blur(6px)",
          borderBottom: `1px solid ${C.border}`,
          padding: "12px 32px",
          display: "flex",
          flexWrap: "wrap",
          gap: "10px 12px",
          alignItems: "center",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>◎ Unified SR Dashboard</h1>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: "#fde68a",
            border: "1px solid #854d0e",
            borderRadius: 4,
            padding: "2px 6px",
          }}
          title="Runs alongside the Morning Dashboard and Success Rate Snippet for comparison"
        >
          EVALUATION
        </span>
        <a
          href="/#history?dashboard=unified"
          target="_blank"
          rel="noopener noreferrer"
          title="Open run history (query, output, insights) and SR alerts in a new tab"
          style={{ fontSize: 12, fontWeight: 600, color: "#f9a8d4", textDecoration: "none", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px" }}
        >
          🕘 History ↗
        </a>
        <NotesManager notes={notes} reload={loadNotes} />
        <Seg
          value={page}
          onChange={setPage}
          options={[
            ["dash", "Dashboard"],
            ["config", "Configuration"],
          ]}
        />
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          {page === "dash" && (
            <select style={selectStyle} value="" onChange={(e) => e.target.value && setAllDurations(e.target.value)} aria-label="Set duration for intraday sections">
              <option value="">Set C / D / E to…</option>
              {Object.entries(DURATION_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  Last {l}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={toggleAutoRetry} title="Re-run failed queries automatically from a queue" style={{ ...btn(), color: cfg.autoRetry ? "#86efac" : C.text2 }}>
            Retry failed: {cfg.autoRetry ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={toggleSchedule}
            title="Backend refresh schedule (IST): raw-txn sections at 07:15, 10:45, 15:15, 19:45, 23:15; day-level Looker sections at 07:15, 10:45 and 12:15"
            style={{
              ...btn(),
              color: cfg.schedule?.enabled ? "#86efac" : C.text2,
            }}
          >
            Auto-refresh: {cfg.schedule?.enabled ? "On" : "Off"}
          </button>
          {failedCount > 0 && <span style={{ fontSize: 11, color: C.warn }}>{failedCount} failed/retrying</span>}
          <button type="button" style={btn("danger")} onClick={() => stop(SECTION_IDS)} disabled={!anyActive}>
            ■ Stop all
          </button>
          <button type="button" style={btn("primary")} onClick={() => run(SECTION_IDS)}>
            ⟳ Refresh all
          </button>
        </div>
        {page === "dash" && (
          <div
            style={{
              flexBasis: "100%",
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 12, color: C.text2 }}>Payer handle:</span>
            <Seg value={handleSel} onChange={setHandleSel} options={(state.handleOpts || Object.keys(HANDLE_LABEL)).map((h) => [h, HANDLE_LABEL[h] || h])} />
            <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
            <Seg value={flowSel} onChange={setFlowSel} options={(state.flowOpts || ["ALL", "P2P", "P2M", "LITE"]).map((f) => [f, f === "ALL" ? "All" : f])} />
            <span style={{ fontSize: 12, color: C.text2 }}>Payee PSP map:</span>
            <Seg value={pspMode} onChange={setPspMode} options={PSP_MODES} />
            <span style={{ fontSize: 12, color: C.text2 }}>Layout:</span>
            <Seg
              value={presetOf(layout)}
              onChange={(k) => {
                setLayout(LAYOUT_PRESETS[k].modes);
                setSolo(null);
              }}
              options={Object.entries(LAYOUT_PRESETS).map(([k, p]) => [k, p.label])}
            />
            {presetOf(layout) === "custom" && <span style={{ fontSize: 11, color: C.muted }}>custom</span>}
            <span style={{ fontSize: 11, color: C.muted }}>
              Filters apply to day-level cards (A, B, C trend, F day-level, G, H). Morning view = All + @paytm · All. Snippet view = All 4 TPAP · P2M · 4 groups.
            </span>
          </div>
        )}
      </header>

      <MarksCtx.Provider value={notes.filter((n) => n.scope === "all")}>
      <LayoutCtx.Provider value={layoutCtx}>
        {page === "dash" && <DockRail docked={docked} summaries={cardSummaries} onUndock={jumpTo} open={railOpen} setOpen={setRailOpen} top={headerH + 12} />}
        <main style={{ padding: `20px ${page === "dash" && docked.length && railOpen ? 248 : 32}px 48px 32px`, maxWidth: 1480, margin: "0 auto", lineHeight: 1.4 }}>
          {page === "config" ? (
            <ConfigPage state={state} now={now} durations={durations} onRun={run} onStop={stop} onRetryNow={retryNow} reload={reload} />
          ) : (
            <>
              {solo && (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, padding: "8px 12px", border: "1px solid #065f46", borderRadius: 8, background: "rgba(52,211,153,0.08)", fontSize: 12 }}>
                  <b>⤢ Focus: {LAYOUT_CARDS.find(([a]) => a === solo)?.[1]}</b>
                  <span style={{ color: C.muted }}>other cards hidden</span>
                  <button type="button" style={{ ...btn(), marginLeft: "auto" }} onClick={() => setSolo(null)}>
                    ← Show all cards
                  </button>
                </div>
              )}
              <SrKpiStrip
                state={{
                  ...state,
                  results: { ...state.results, breakdown: R.breakdown },
                }}
                sectionIds={SECTION_IDS}
                titles={CHIP_TITLES}
                now={now}
                onJump={jumpTo}
                explain
                onRefresh={run}
              />

              {/* A — Morning A + Snippet 1 */}
              <SectionCard {...common("breakdown")} noView note={R.breakdown?.slice ? `${filterNote} · ${R.breakdown.slice}` : filterNote}>
                {() =>
                  viewLoading("breakdown") && !R.breakdown?.slice ? (
                    <Hint>Loading view for {filterNote}…</Hint>
                  ) : (
                    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: C.muted, padding: "8px 16px", borderBottom: `1px solid ${C.border}` }}>
                        Latest complete day <b style={{ color: C.text2 }}>{aYday || "—"}</b> vs D-1…D-3, same weekday last week, L7D average
                        {aLmtd ? ` and LMTD (${aLmtd.label}, vol per day)` : ""} · click a payee PSP / payer bank to see its codes in B,
                        or a decline code to open it in B{R.breakdown?.slice && <span style={{ color: "#38bdf8" }}> · live slice: {R.breakdown.slice}</span>}
                      </div>
                      {aYday ? (
                        <BreakdownTable
                          rows={aRows}
                          yday={aYday}
                          kinds={SR_KINDS}
                          showKpis={false}
                          labelOf={bankLabelOf}
                          fileTag="unified-breakdown"
                          lmtd={aLmtd}
                          pickKey="udash-A"
                          defaultHiddenCols={A_HIDDEN_COLS}
                          onCodeClick={(code) => {
                            setBScope(null);
                            setDeclineFocus(code);
                            jumpTo("declines");
                          }}
                          focusCode={driverCode}
                          onClearFocus={() => setDriverCode(null)}
                          onDimClick={(kind, dim) => {
                            if (kind !== "psp" && kind !== "bank") return;
                            setBScope({ kind, dim });
                            jumpTo("declines");
                          }}
                          header={
                            <BreakdownFilter
                              cfg={cfg}
                              pspMode={pspMode}
                              handleSel={handleSel}
                              flowSel={flowSel}
                              onRows={setASlice}
                              active={R.breakdown?.slice ? { label: R.breakdown.slice } : null}
                              codeOptions={codeOptions}
                            />
                          }
                        />
                      ) : (
                        <Hint>No data in this slice.</Hint>
                      )}
                    </div>
                  )
                }
              </SectionCard>

              {/* B — Morning B + Snippet 3 (+ Morning 10 day-level) */}
              <SectionCard
                {...common("codes")}
                anchor="declines"
                title="B · Decline Codes — NPCI description, ₹, D-1…D-3, MTD / LMTD contribution"
                noView
                onRun={() => run(["declines", "codes"])}
                onStop={() => stop(["declines", "codes"])}
                note={`B: ${HANDLE_LABEL[bHandle]} · ${bFlow === "ALL" ? "both flows" : bFlow} · ₹ amounts ${declinesJob?.status === "running" ? "running…" : state.results.declines ? `as of ${fmtTime(state.results.declines.ranAt)}` : "not run"}${declinesJob?.status === "failed" ? " (last ₹ run failed)" : ""}`}
              >
                {() => (
                  <>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: C.text2 }}>Payer handle:</span>
                      <Seg
                        value={bHandle}
                        onChange={setBHandle}
                        options={[
                          ["tpap", "All"],
                          ["pthdfc", "PTHDFC"],
                          ["ptsbi", "PTSBI"],
                          ["ptaxis", "PTAXIS"],
                          ["ptyes", "PTYES"],
                        ]}
                      />
                      <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
                      <Seg
                        value={bFlow}
                        onChange={setBFlow}
                        options={[
                          ["ALL", "Both"],
                          ["P2P", "P2P"],
                          ["P2M", "P2M"],
                        ]}
                      />
                      <span style={{ fontSize: 12, color: C.text2 }}>Top banks:</span>
                      <Seg
                        value={bTopBy}
                        onChange={setBTopBy}
                        options={[
                          ["rise", "Most impacted"],
                          ["fails", "Most failures"],
                        ]}
                      />
                      <span style={{ fontSize: 12, color: C.text2 }}>Codes for:</span>
                      <select
                        style={selectStyle}
                        value={bScope?.kind === "psp" ? bScope.dim : ""}
                        onChange={(e) => setBScope(e.target.value ? { kind: "psp", dim: e.target.value } : null)}
                        aria-label="Payee PSP"
                      >
                        <option value="">Payee PSP — all</option>
                        {bDims.psp.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                      <select
                        style={selectStyle}
                        value={bScope?.kind === "bank" ? bScope.dim : ""}
                        onChange={(e) => setBScope(e.target.value ? { kind: "bank", dim: e.target.value } : null)}
                        aria-label="Payer bank"
                      >
                        <option value="">Payer bank — all</option>
                        {bDims.bank.map((d) => (
                          <option key={d} value={d}>
                            {bankLabelOf("bank", d) ? `${d} · ${bankLabelOf("bank", d)}` : d}
                          </option>
                        ))}
                      </select>
                      {bScope && (
                        <button type="button" style={btn()} onClick={() => setBScope(null)}>
                          ✕ {bScope.kind === "psp" ? "Payee PSP" : "Payer bank"} {bScope.dim}
                        </button>
                      )}
                      <span style={{ fontSize: 11, color: C.muted }}>
                        Payer PSP = the page&apos;s handle filter; payee bank is raw-txn only (J).
                        {bScope && " Scoped view covers each day's top failure codes for this row (A's per-row code detail); ₹ is shown for all rows only."}
                      </span>
                    </div>
                    <Hint>Day view (latest complete day vs D-1…D-3, LW, L7D) — failures from section A&apos;s 10-day data; ₹ from raw txns.</Hint>
                    <DeclinesBody
                      key={bScope ? `${bScope.kind}|${bScope.dim}` : "all"}
                      result={bResult || { rows: [] }}
                      amountResult={bScope ? null : bDeclines}
                      pickKey={bScope ? null : "udash-B-day"}
                      defaultHiddenCols={B_DAY_HIDDEN_COLS}
                      extraCol={{
                        label: bTopBy === "rise" ? "Top 3 impacted payer banks" : "Top 3 payer banks by failures",
                        title:
                          bTopBy === "rise"
                            ? "Banks whose failures for this code rose most on the latest day vs their own L7D daily average (only banks that rose). Based on A's per-bank code detail."
                            : "Payer banks with the most failures for this code on the latest day (volume — big banks rank high even when nothing changed).",
                        render: (code) =>
                          (bTopBanks[code] || []).map(([b, n, rise]) => (
                            <div key={b} style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                              <b>{b}</b>
                              {bankLabelOf("bank", b) ? <span style={{ color: C.muted }}> {bankLabelOf("bank", b)}</span> : null} ·{" "}
                              {bTopBy === "rise" ? (
                                <>
                                  <span style={{ color: "#f87171" }}>+{fmtNum(rise)}</span> vs L7D avg ({fmtNum(n)})
                                </>
                              ) : (
                                fmtNum(n)
                              )}
                            </div>
                          )),
                        csv: (code) => (bTopBanks[code] || []).map(([b, n, rise]) => (bTopBy === "rise" ? `${b} +${Math.round(rise)} (${n})` : `${b} ${n}`)).join("; "),
                      }}
                      focus={declineFocus}
                      onFocus={setDeclineFocus}
                      onCodeClick={(code) => {
                        setDriverCode(code);
                        jumpTo("breakdown");
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 10,
                        alignItems: "center",
                        margin: "16px 0 8px",
                      }}
                    >
                      <b style={{ fontSize: 13 }}>Top error codes and contribution % — Yesterday / MTD / LMTD · D vs LMTD</b>
                      <Seg
                        value={codesTop}
                        onChange={setCodesTop}
                        options={[
                          [15, "Top 15"],
                          [30, "Top 30"],
                          [60, "Top 60"],
                        ]}
                      />
                    </div>
                    {!bCodes.length ? (
                      <Hint>Loading view…</Hint>
                    ) : (
                      bScoreCodes && (
                        <ScoreTable
                          firstCol="Error code"
                          cols={errorCols(per, { dVsLmtd: true })}
                          rows={bScoreCodes.rows}
                          total={bScoreCodes.total}
                          hide={bCodeHide}
                          tools={
                            <>
                              <Picker
                                label="Rows"
                                title={`Add / remove error codes (default: top ${codesTop}; saved in this browser)`}
                                items={bScoreCodes.options}
                                visible={applyPick(bScoreCodes.defaults, bCodePick).filter((id) => bScoreCodes.options.some((o) => o.id === id))}
                                onChange={(ids) => setBCodePick(toPick(bScoreCodes.defaults, ids))}
                                changed={bCodePick.hidden.length + bCodePick.added.length > 0}
                                onReset={() => setBCodePick(NO_PICK)}
                                presets={[5, 10].map((n) => ({ label: `Top ${n}`, ids: bScoreCodes.options.slice(0, n).map((o) => o.id) }))}
                              />
                              <Picker
                                label="Columns"
                                title="Show / hide columns (Copy keeps only the shown columns)"
                                items={errorCols(per, { dVsLmtd: true }).map((c) => ({ id: c.label, sub: c.title }))}
                                visible={errorCols(per, { dVsLmtd: true }).map((c) => c.label).filter((l) => !bCodeHide.includes(l))}
                                onChange={(ids) => setBCodeHide(errorCols(per, { dVsLmtd: true }).map((c) => c.label).filter((l) => !ids.includes(l)))}
                                changed={bCodeHide.join() !== B_CODES_HIDDEN_COLS.join()}
                                onReset={() => setBCodeHide(B_CODES_HIDDEN_COLS)}
                              />
                            </>
                          }
                          caption={`${HANDLE_LABEL[bHandle]} · ${bFlow === "ALL" ? "P2P + P2M + LITE" : bFlow} · Yesterday ${per.y} · MTD ${per.mtd} vs LMTD ${per.lmtd}`}
                        />
                      )
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "16px 0 8px" }}>
                      <b style={{ fontSize: 13 }}>Error-wise breakup by day (was Morning section 10, day-level mode)</b>
                      <Seg
                        value={pivotDays}
                        onChange={setPivotDays}
                        options={[
                          [2, "2d"],
                          [3, "3d"],
                          [7, "7d"],
                          [15, "15d"],
                        ]}
                      />
                      <Seg
                        value={pivotMetric}
                        onChange={setPivotMetric}
                        options={[
                          ["count", "Count"],
                          ["pct", "% of txns"],
                        ]}
                      />
                    </div>
                    {codePivot ? <ErrorsBody result={codePivot} view="table" cfg={cfg} metric={pivotMetric} topN={30} visibleN={10} column="app_resp_code" pivot /> : <Hint>No code data yet.</Hint>}
                  </>
                )}
              </SectionCard>

              {/* C — Morning 1 (intraday) + Morning 6 (trend) */}
              <SectionCard
                {...common(srMode === "intraday" ? "raw" : "dims", srMode === "intraday" ? R.sr : R.flowDay)}
                anchor="sr"
                title={
                  srMode === "intraday"
                    ? "C · Success Rate — handle × flow (intraday, raw txns)"
                    : trendBy === "sub"
                      ? "C · Success Rate — by sub-flow (day-level trend)"
                      : "C · Success Rate — P2P vs P2M vs LITE (day-level trend)"
                }
                note={srMode === "intraday" ? `handle filter: ${HANDLE_LABEL[handleSel]}` : filterNote}
                controls={
                  <>
                    <Seg
                      value={srMode}
                      onChange={setSrMode}
                      options={[
                        ["intraday", "Intraday"],
                        ["trend", "Day / week / month"],
                      ]}
                    />
                    {srMode === "intraday" ? (
                      <>
                        <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
                        <Seg
                          value={srFlow}
                          onChange={setSrFlow}
                          options={[
                            ["ALL", "P2P + P2M"],
                            ["P2P", "P2P"],
                            ["P2M", "P2M"],
                          ]}
                        />
                      </>
                    ) : (
                      <>
                        <Seg
                          value={trendBy}
                          onChange={setTrendBy}
                          options={[
                            ["flow", "By flow"],
                            ["sub", "By sub-flow"],
                          ]}
                        />
                        <Seg
                          value={flowGrain}
                          onChange={setFlowGrain}
                          options={[
                            ["day", "Day"],
                            ["week", "Week"],
                            ["month", "Month"],
                          ]}
                        />
                        <label
                          style={{
                            fontSize: 12,
                            color: C.text2,
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <input type="checkbox" checked={flowLite} onChange={(e) => setFlowLite(e.target.checked)} /> Include LITE
                        </label>
                      </>
                    )}
                  </>
                }
              >
                {(view) => {
                  if (srMode !== "intraday") {
                    if (trendBy === "sub") {
                      const vol = {};
                      for (const r of R.sub?.rows || []) vol[r.flow] = (vol[r.flow] || 0) + r.total;
                      const groups = subOrder(Object.keys(vol).filter((k) => vol[k] > 0)).slice(0, 10);
                      return R.sub ? <FlowSrBody result={R.sub} view={view} grain={flowGrain} groups={groups} /> : null;
                    }
                    return <FlowSrBody result={R.flowDay} view={view} grain={flowGrain} lite={flowLite} />;
                  }
                  // Intraday: the flow filter applies to the whole card (lines, table, sub-flow split).
                  const rows = srFlow === "ALL" ? R.sr.rows : R.sr.rows.filter((r) => r.flow === srFlow);
                  return (
                    <>
                      <SrBody result={{ ...R.sr, rows }} view={view} flow={srFlow} />
                      {srFlow === "P2P" && <SubFlowIntraday rows={R.subP2P || []} />}
                      {srFlow === "P2M" && (
                        <Hint>P2M sub-flows (Paytm QR, 3P QR, Intent, ONUS, P2M Collect, Other P2M) exist only in the day-level table — switch to Day / week / month → By sub-flow.</Hint>
                      )}
                    </>
                  );
                }}
              </SectionCard>

              {/* D — Morning 2 + Morning 10 (intraday) */}
              <SectionCard
                {...common("raw", errDef === "errors" ? R.errors : R.errbreak)}
                anchor="errors"
                title={`D · Error Code Trend — ${errDef === "errors" ? "status = FAILURE only" : "every non-SUCCESS status (incl. pending / deemed)"}${dType !== "all" ? ` · ${dType} only` : ""}${dView === "types" ? " · by decline type" : ""}`}
                note={`${handleNote} · intraday, raw txns`}
                controls={
                  <>
                    <Seg
                      value={errDef}
                      onChange={setErrDef}
                      options={[
                        ["errors", "FAILURE only"],
                        ["errbreak", "All non-success"],
                      ]}
                    />
                    <Seg
                      value={dType}
                      onChange={setDType}
                      options={[
                        ["all", "All"],
                        ["TD", "TD"],
                        ["BD", "BD"],
                        ["RD", "RD"],
                      ]}
                    />
                    <label
                      style={{ fontSize: 12, color: C.text2, display: "flex", gap: 4, alignItems: "center" }}
                      title="Hide the two biggest customer-side codes from the trend (still counted in % of all txns)"
                    >
                      <input type="checkbox" checked={dHide} onChange={(e) => setDHide(e.target.checked)} /> hide U30-Z9, U30-ZM
                    </label>
                    <Seg
                      value={dView}
                      onChange={setDView}
                      options={[
                        ["codes", "Codes"],
                        ["types", "By decline type"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                    <Seg
                      value={errMetric}
                      onChange={setErrMetric}
                      options={[
                        ["pct", "% of txns"],
                        ["count", "Count"],
                      ]}
                    />
                  </>
                }
              >
                {(view) => (
                  <>
                    <DockedSummary
                      title="Escalation summary — codes rising in the recent half of the window"
                      items={dSummary}
                      empty="No bank / PSP / NPCI-owned code is rising — nothing to escalate. (BD codes are customer-side and never escalated.)"
                    />
                    {errDef === "errors" ? (
                      <ErrorsBody result={dResult} view={view} cfg={cfg} metric={errMetric} topN={15} hide={dHide ? HIDE_CUSTOMER_CODES : null} />
                    ) : (
                      <ErrorsBody result={dResult} view={view} cfg={cfg} metric={errMetric} topN={25} visibleN={10} column="app_resp_code" pivot hide={dHide ? HIDE_CUSTOMER_CODES : null} />
                    )}
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                      Decline type from the Looker table (error_type): TD = technical decline (bank / PSP), BD = business decline (customer: funds, PIN, limits), RD = risk decline (NPCI / bank /
                      internal). Codes not seen in the day-level table show as Unclassified.
                    </div>
                  </>
                )}
              </SectionCard>

              {/* E — Morning 3 */}
              <SectionCard
                {...common(eWin === "15d" ? "dims" : "raw", eWin === "15d" ? u09Day.flow : R.u09)}
                anchor="u09"
                title={`E · U09 Trend${eWin === "15d" ? " — last 15 days (day-level)" : " — intraday"}${eFlow !== "ALL" ? ` · ${eFlow}` : ""}`}
                note={`handle filter: ${HANDLE_LABEL[handleSel]}${eWin === "15d" ? " · U09 = app_resp_code U09* (day-level table)" : ""}`}
                controls={
                  <>
                    <Seg
                      value={eWin}
                      onChange={setEWin}
                      options={[
                        ["intraday", "Intraday"],
                        ["15d", "Last 15 days"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
                    <Seg
                      value={eFlow}
                      onChange={setEFlow}
                      options={[
                        ["ALL", "All"],
                        ["P2P", "P2P"],
                        ["P2M", "P2M"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                    <Seg
                      value={u09Metric}
                      onChange={setU09Metric}
                      options={[
                        ["pct", "% of txns"],
                        ["count", "Count"],
                      ]}
                    />
                    <label
                      style={{
                        fontSize: 12,
                        color: C.text2,
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                      }}
                    >
                      Split:
                      <Seg
                        value={u09By}
                        onChange={setU09By}
                        options={[
                          ["none", "None"],
                          ["handle", "By handle"],
                          ["psp", "By payee PSP"],
                        ]}
                      />
                    </label>
                  </>
                }
              >
                {(view) => {
                  const day = eWin === "15d";
                  if (day && !u09Day.ready) return <Hint>Day-level U09 arrives with the next run of the day-level query (dims, 07:15) — or press Refresh on this card.</Hint>;
                  if (u09By === "psp")
                    return (
                      <>
                        <Hint>
                          {day
                            ? "Day-level U09 failures by payee handle (Looker table), last 15 complete days, page handle filter."
                            : `Payee handle needs the payee participant row, so this split comes from F's intraday payer-bank query: window ${R.bankU09?.window ? `${R.bankU09.window.from?.slice(5, 16)} → ${R.bankU09.window.to?.slice(5, 16)}` : "—"}, all 4 TPAP handles.`}{" "}
                          PhonePe and Google Pay show per handle (sponsor bank).
                        </Hint>
                        <U09PspBody result={day ? u09Day.psp : R.bankU09} view={view} metric={u09Metric} flow={eFlow} />
                      </>
                    );
                  const res = day ? u09Day.flow : R.u09;
                  return <U09Body result={res && { ...res, rows: eFlow === "ALL" ? res.rows : res.rows.filter((r) => r.flow === eFlow) }} view={view} metric={u09Metric} split={u09By === "handle"} />;
                }}
              </SectionCard>

              {/* F — Morning 4 + Morning 9 */}
              <SectionCard
                {...common(bankMode)}
                anchor="bank"
                noView={bankMode === "bankrep"}
                title={
                  bankMode === "bank"
                    ? "F · Payer Bank SR — intraday (raw txns)"
                    : bankMode === "bankrep"
                      ? "F · Payer (Remitter) Bank Report — health, contribution, deep-dive"
                      : "F · Payer Bank SR — day-level (Looker)"
                }
                note={bankMode === "bank" ? "all 4 TPAP handles · DWH participants lag ~12h on Trino" : bankMode === "bankrep" ? filterNote : `handle filter: ${HANDLE_LABEL[handleSel]}`}
                controls={
                  <>
                    <Seg
                      value={bankMode}
                      onChange={setBankMode}
                      options={[
                        ["bankrep", "Bank report"],
                        ["bankday", "Day-level"],
                        ["bank", "Intraday"],
                      ]}
                    />
                    {bankMode !== "bankrep" && (
                      <>
                        <Seg
                          value={bankChart}
                          onChange={setBankChart}
                          options={[
                            ["watch", "Watchlist"],
                            ["top", "Top 25 by volume"],
                          ]}
                        />
                        <span style={{ fontSize: 12, color: C.text2 }}>Flow:</span>
                        <Seg
                          value={bankFlow}
                          onChange={setBankFlow}
                          options={[
                            ["ALL", "All"],
                            ["P2P", "P2P"],
                            ["P2M", "P2M"],
                          ]}
                        />
                      </>
                    )}
                  </>
                }
              >
                {(view) => {
                  if (bankMode === "bankrep")
                    return (
                      <BankReport
                        result={R.bankrep}
                        cfg={cfg}
                        handleSel={handleSel}
                        flowSel={flowSel}
                        pbankRows={(state.results.merchants?.rows || []).filter((r) => r.grp === "pbank")}
                        live={state.results.bankalert ? { ...state.results.bankalert, running: ACTIVE.has(state.jobs.bankalert?.status) } : { running: ACTIVE.has(state.jobs.bankalert?.status) }}
                        onRunLive={async (dur) => {
                          await api("/run", { method: "POST", body: { sections: ["bankalert"], durations: { bankalert: dur } } }).catch((e) => alert(e.message));
                          reload();
                        }}
                        onToggleLive={async () => {
                          const on = !cfg.intradayBankAlert?.enabled;
                          if (on && !window.confirm("Run the live payer-bank check at 10:00 and 22:00 IST (previous 12h, failed txns only) on the switch DB (Redash) and post incidents to Slack?"))
                            return;
                          await api("/config", { method: "PUT", body: { intradayBankAlert: { ...cfg.intradayBankAlert, enabled: on } } }).catch((e) => alert(e.message));
                          reload();
                        }}
                        dwhLive={
                          state.results.bankdwh
                            ? { ...state.results.bankdwh, running: ACTIVE.has(state.jobs.bankdwh?.status), state: state.jobs.bankdwh?.state }
                            : { running: ACTIVE.has(state.jobs.bankdwh?.status) }
                        }
                        onRunDwh={async () => {
                          await api("/run", { method: "POST", body: { sections: ["bankdwh"], durations: { bankdwh: "12h" } } }).catch((e) => alert(e.message));
                          reload();
                        }}
                        onToggleDwh={async () => {
                          await api("/config", { method: "PUT", body: { dwhBankAlert: { ...cfg.dwhBankAlert, enabled: !cfg.dwhBankAlert?.enabled } } }).catch((e) => alert(e.message));
                          reload();
                        }}
                        onEscalate={(x) => {
                          setEscReq({ kind: "bank", ...x, nonce: Date.now() });
                          jumpTo("escalate");
                        }}
                        notes={notes}
                      />
                    );
                  const res = bankMode === "bank" ? R.bank : R.bankday;
                  if (bankChart === "watch") return <BankBody result={res} view={view} cfg={cfg} flow={bankFlow} />;
                  const rows = bankFlow === "ALL" ? res.rows : res.rows.filter((r) => r.flow === bankFlow);
                  return <GroupSrBody result={{ ...res, rows }} view={view} groupKey="bank" groupLabel="payer bank" topN={25} chartN={8} />;
                }}
              </SectionCard>

              {/* G — Morning 8 + Snippet 2 + Snippet 4 */}
              <SectionCard
                {...common("dims", R.psp)}
                anchor="psp"
                title="G · Payee PSP — SR% / success txns / volume (top 10, scorecard + DoD trend, merchants)"
                note={filterNote}
                controls={
                  <>
                    <Seg
                      value={pspMetric}
                      onChange={setPspMetric}
                      options={[
                        ["sr", "SR%"],
                        ["success", "Success txns"],
                        ["volume", "Volume"],
                      ]}
                    />
                    <Seg
                      value={pspTop ? "top" : "all"}
                      onChange={(v) => setPspTop(v === "top")}
                      options={[
                        ["top", "Top 10"],
                        ["all", "All"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Trend:</span>
                    <Seg
                      value={pspDays}
                      onChange={setPspDays}
                      options={[
                        [7, "7d"],
                        [15, "15d"],
                        [30, "30d"],
                        [0, "All"],
                      ]}
                    />
                  </>
                }
              >
                {(view) => (
                  <>
                    <DockedSummary
                      title="Escalation summary — payee PSPs (latest complete day, section A rules)"
                      items={gSummary}
                      empty="No payee PSP is far enough below its L7D baseline to escalate (score < 30)."
                      onOpen={() => jumpTo("escalate")}
                    />
                    {view === "table" ? (
                      <>
                        {score && (
                          <ScoreTable
                            firstCol="Payee PSP"
                            cols={scoreCols(pspMetric, per)}
                            rows={score.psp.rows}
                            total={score.psp.total}
                            caption={`${filterNote} · ${PSP_MODES.find((m) => m[0] === pspMode)[1]}`}
                          />
                        )}
                        <div style={{ marginTop: 14 }}>
                          <GroupSrBody result={pspTrend} view="table" groupKey="psp" groupLabel="payee PSP" topN={pspTop ? 10 : 50} chartN={8} metric={pspMetric} />
                        </div>
                        <MerchantsBody result={R.merchants} />
                      </>
                    ) : (
                      <>
                        <GroupSrBody result={pspTrend} view="chart" groupKey="psp" groupLabel="payee PSP" topN={pspTop ? 10 : 50} chartN={8} metric={pspMetric} />
                        <MerchantsBody result={R.merchants} />
                      </>
                    )}
                  </>
                )}
              </SectionCard>

              {/* H — Morning 7 + Snippet 5 */}
              <SectionCard
                {...common("dims", R.instrument)}
                anchor="instrument"
                title="H · Payer Instrument SR (scorecard + day / week / month trend)"
                note={filterNote}
                controls={
                  <>
                    <Seg
                      value={instMetric}
                      onChange={setInstMetric}
                      options={[
                        ["sr", "SR%"],
                        ["success", "Success txns"],
                        ["volume", "Volume"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Grain:</span>
                    <Seg
                      value={instGrain}
                      onChange={setInstGrain}
                      options={[
                        ["day", "Day"],
                        ["week", "Week"],
                        ["month", "Month"],
                      ]}
                    />
                  </>
                }
              >
                {(view) =>
                  view === "table" ? (
                    <>
                      {score && <ScoreTable firstCol="Instrument" cols={scoreCols(instMetric, per)} rows={score.inst.rows} total={score.inst.total} caption={`${filterNote} · sorted by MTD volume`} />}
                      <div style={{ marginTop: 14 }}>
                        <InstrumentBody result={R.instrument && { ...R.instrument, rows: [...R.instrument.rows, ...(R.pp?.rows || [])] }} view="table" grain={instGrain} />
                      </div>
                    </>
                  ) : (
                    <InstrumentBody result={R.instrument && { ...R.instrument, rows: [...R.instrument.rows, ...(R.pp?.rows || [])] }} view="chart" grain={instGrain} />
                  )
                }
              </SectionCard>

              {/* I — Morning 5 */}
              <SectionCard
                {...common(shareBy === "handle" ? "share" : "dims", shareBy === "handle" ? R.share : shareBy === "os" ? R.shareOs : shareBy === "instrument" ? R.shareInstrument : R.shareSub)}
                anchor="share"
                title={`I · Txn share — ${{ handle: "payer handle (DTU / TPU table)", os: "OS (successful txns)", instrument: "payer instrument (successful txns)", sub: "sub-flow (successful txns)" }[shareBy]}`}
                note={shareBy === "handle" ? "all payer handles" : filterNote}
                controls={
                  <>
                    <Seg
                      value={shareBy}
                      onChange={setShareBy}
                      options={[
                        ["handle", "Handle"],
                        ["os", "OS"],
                        ["instrument", "Instrument"],
                        ["sub", "Sub-flow"],
                      ]}
                    />
                    <span style={{ fontSize: 12, color: C.text2 }}>Metric:</span>
                    <Seg
                      value={shareMetric}
                      onChange={setShareMetric}
                      options={[
                        ["share", "% Share"],
                        ["count", "Txn count"],
                      ]}
                    />
                  </>
                }
              >
                {(view) => {
                  const res = shareBy === "handle" ? R.share : shareBy === "os" ? R.shareOs : shareBy === "instrument" ? R.shareInstrument : R.shareSub;
                  const what = { handle: "payer handle", os: "OS", instrument: "payer instrument", sub: "sub-flow" }[shareBy];
                  return res ? <ShareBody key={shareBy} result={res} view={view} metric={shareMetric} what={what} /> : null;
                }}
              </SectionCard>
              {/* J — drill-down by any dimension + sample transactions */}
              <ToolCard
                anchor="drill"
                title="J · Raw-txn drill-down & sample transactions"
                sub="SR by payer bank, payee bank, payee PSP, category or flow from raw transactions — payee bank exists only there — plus the sample-transaction CSV. Day-level slices: use A's “More filters”. Runs on demand."
              >
                <DrillCard cfg={cfg} pspMode={pspMode} handleSel={handleSel} flowSel={flowSel} />
              </ToolCard>

              {/* K — escalation scoring + Minto email (on section A's rows) */}
              <ToolCard
                anchor="escalate"
                title="K · Escalation candidates — score, recipient, Minto email"
                sub="Scores section A's rows for the latest complete day; drafts the escalation email with sample transactions."
              >
                <EscalationCard breakdownRows={R.breakdown?.rows} cfg={cfg} pspMode={pspMode} handleSel={handleSel} flowSel={flowSel} scopeLabel={filterNote} request={escReq} />
              </ToolCard>
            </>
          )}
        </main>
      </LayoutCtx.Provider>
      </MarksCtx.Provider>
    </div>
  );
}
