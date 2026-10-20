import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildBreakdown, pickYday } from "./breakdown-math.mjs";
import { SR_KINDS } from "./sr-shared.jsx";
import { PARTIES, SUSTAINED_MIN, analyzeDuration, applyDuration, buildEscalationEmail, scoreAll, scoreRow } from "./escalation.mjs";
import { PSP_ORDER, handlesForGroup } from "./unified-psp.mjs";

// Unified SR Dashboard — A · extra filters, J · raw-txn drill-down & sample transactions,
// K · Escalation candidates.
// Backend: /api/udash/drill/* (backend/unifiedDrill.js). Queries run as jobs (the shared
// Trino queue can hold them for minutes); the page polls /job/:id.

const API = "/api/udash/drill";

const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#f59e0b",
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#fab219",
  info: "#38bdf8",
};

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// /meta is static per backend start: fetch once per page for every card.
let metaPromise = null;
function useMeta() {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    metaPromise ||= api("/meta").catch((e) => {
      metaPromise = null;
      throw e;
    });
    metaPromise.then(setMeta).catch(() => {});
  }, []);
  return meta;
}

/** Global page filters (payer handle, flow) as drill filters. */
export function globalFilters(handleSel, flowSel) {
  const u = {};
  if (handleSel === "tpap") u.payer_psp = { values: ["ptyes", "ptaxis", "ptsbi", "pthdfc"] };
  else if (handleSel !== "all") u.payer_psp = { values: [handleSel] };
  if (flowSel !== "ALL") u.flow = { values: [flowSel] };
  return u;
}

const pct = (n, d) => (d > 0 ? (n * 100) / d : null);
const fmtPct = (v) => (v == null ? "—" : `${v.toFixed(2)}%`);
const fmtPp = (v, dp = 2) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)} pp`);
const fmtNum = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));
const fmtDur = (ms) => {
  const s = Math.round((ms || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const btn = (variant) => ({
  padding: "5px 12px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${variant === "primary" ? C.accent : C.border}`,
  background: variant === "primary" ? C.accent : C.card2,
  color: variant === "primary" ? "#111" : C.text,
  whiteSpace: "nowrap",
});
const input = {
  background: C.card2,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
};
const th = {
  padding: "7px 10px",
  textAlign: "right",
  fontSize: 11,
  fontWeight: 600,
  color: C.text2,
  textTransform: "uppercase",
  borderBottom: `1px solid ${C.border}`,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  background: C.card,
};
const td = {
  padding: "6px 10px",
  textAlign: "right",
  fontSize: 12.5,
  borderBottom: `1px solid ${C.border}`,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

/** Start a backend job and poll it. Returns [state, start]. */
function useJob() {
  const [st, setSt] = useState(null); // { status, rows?, error?, startedAt, window? }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback(async (path, body) => {
    clearTimeout(timer.current);
    setSt({ status: "running", startedAt: Date.now(), state: "submitting" });
    try {
      const { jobId, window } = await api(path, { method: "POST", body });
      const poll = async () => {
        try {
          const j = await api(`/job/${jobId}`);
          setSt({ ...j, window });
          if (j.status === "running") timer.current = setTimeout(poll, 2000);
        } catch (e) {
          setSt({ status: "failed", error: e.message });
        }
      };
      poll();
    } catch (e) {
      setSt({ status: "failed", error: e.message });
    }
  }, []);
  return [st, start];
}

function JobLine({ job, now }) {
  if (!job) return null;
  if (job.status === "running")
    return (
      <span style={{ fontSize: 11, color: C.info }}>
        ⟳ running {fmtDur(now - job.startedAt)} · {job.state || ""}
      </span>
    );
  if (job.status === "failed") return <span style={{ fontSize: 11, color: C.bad }}>✕ {job.error}</span>;
  return (
    <span style={{ fontSize: 11, color: C.muted }}>
      ✓ {fmtNum(job.rows?.length)} rows · {fmtDur((job.finishedAt || 0) - job.startedAt)}
      {job.window ? ` · ${job.window.from.slice(0, 16)} → ${job.window.to.slice(0, 16)} IST` : ""}
    </span>
  );
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ─── filters ─────────────────────────────────────────────────────────────────

const GROUP = "group:";

/** UI filters → backend filters for one engine. Returns { filters, dropped: [labels] }. */
export function toBackendFilters(ui, fields, engine, pspMode) {
  const out = {};
  const dropped = [];
  for (const [id, spec] of Object.entries(ui)) {
    if (!spec?.values?.length) continue;
    const f = fields.find((x) => x.id === id);
    if (!f) continue;
    if (!f[engine]) {
      dropped.push(f.label);
      continue;
    }
    if (id === "payee_handle" && spec.values.some((v) => v.startsWith(GROUP))) {
      const groups = spec.values.filter((v) => v.startsWith(GROUP)).map((v) => handlesForGroup(v.slice(GROUP.length), pspMode));
      const plain = spec.values.filter((v) => !v.startsWith(GROUP));
      if (groups.some((g) => g.exclude) && (groups.length > 1 || plain.length)) throw new Error("Pick a catch-all PSP group (Others) on its own");
      if (groups.some((g) => g.exclude)) {
        if (spec.exclude) throw new Error("Excluding the catch-all PSP group is not supported — include the named groups instead");
        out[id] = { values: groups[0].values, exclude: true };
      } else {
        out[id] = {
          values: [...new Set([...groups.flatMap((g) => g.values), ...plain.map((v) => v.toLowerCase())])],
          exclude: Boolean(spec.exclude),
        };
      }
      continue;
    }
    out[id] = { values: spec.values, exclude: Boolean(spec.exclude) };
  }
  return { filters: out, dropped };
}

function FilterBar({ fields, engine, ui, setUi, options, pspMode, bankNames }) {
  const [field, setField] = useState("payer_bank");
  const [val, setVal] = useState("");
  const f = fields.find((x) => x.id === field);
  const suggestions = useMemo(() => {
    const vals = (options?.values?.[field] || []).map((o) => o.v);
    if (field === "payee_handle") return [...PSP_ORDER[pspMode].map((g) => `${GROUP}${g}`), ...vals];
    return vals;
  }, [options, field, pspMode]);
  const add = () => {
    const v = val.trim();
    if (!v) return;
    setUi((u) => ({
      ...u,
      [field]: {
        values: [...new Set([...(u[field]?.values || []), v])],
        exclude: u[field]?.exclude || false,
      },
    }));
    setVal("");
  };
  const label = (id, v) => {
    if (v.startsWith(GROUP)) return `${v.slice(GROUP.length)} (group)`;
    if ((id === "payer_bank" || id === "payee_bank") && bankNames[v]) return `${v} · ${bankNames[v]}`;
    return v;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        <select style={input} value={field} onChange={(e) => setField(e.target.value)} aria-label="Filter field">
          {fields.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
              {!x[engine] ? ` (${engine === "looker" ? "raw only" : "day-level only"})` : ""}
            </option>
          ))}
        </select>
        <input
          style={{ ...input, width: 220 }}
          list={`udash-drill-${field}`}
          value={val}
          placeholder={field === "payee_handle" ? "group or handle, e.g. GooglePay / ybl" : field.endsWith("bank") ? "IFSC prefix, e.g. SBIN" : "value"}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <datalist id={`udash-drill-${field}`}>
          {suggestions.slice(0, 300).map((v) => (
            <option key={v} value={v}>
              {label(field, v)}
            </option>
          ))}
        </datalist>
        <button type="button" style={btn()} onClick={add}>
          + Add
        </button>
        {!f?.[engine] && (
          <span style={{ fontSize: 11, color: C.warn }}>
            {f?.label} is not on the {engine === "looker" ? "day-level" : "raw-txn"} engine — ignored there
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {Object.entries(ui)
          .filter(([, s]) => s?.values?.length)
          .map(([id, s]) => {
            const fx = fields.find((x) => x.id === id);
            const off = !fx?.[engine];
            return (
              <span
                key={id}
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "center",
                  fontSize: 12,
                  border: `1px solid ${off ? C.border : "#1e3a5f"}`,
                  background: off ? "transparent" : "#0c1a2e",
                  color: off ? C.muted : C.text,
                  borderRadius: 999,
                  padding: "2px 4px 2px 10px",
                }}
              >
                <button
                  type="button"
                  title="Toggle include / exclude"
                  onClick={() =>
                    setUi((u) => ({
                      ...u,
                      [id]: { ...u[id], exclude: !u[id].exclude },
                    }))
                  }
                  style={{
                    border: "none",
                    background: "transparent",
                    color: s.exclude ? C.bad : C.good,
                    cursor: "pointer",
                    fontWeight: 700,
                    padding: 0,
                  }}
                >
                  {s.exclude ? "≠" : "="}
                </button>
                <b>{fx?.label || id}</b> {s.values.map((v) => label(id, v)).join(", ")}
                <button
                  type="button"
                  onClick={() => setUi((u) => ({ ...u, [id]: undefined }))}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: C.muted,
                    cursor: "pointer",
                  }}
                  aria-label="Remove filter"
                >
                  ✕
                </button>
              </span>
            );
          })}
      </div>
    </div>
  );
}

// ─── sample CSV ──────────────────────────────────────────────────────────────

const CSV_COLS = [
  ["Txn ID", "txn_id"],
  ["RRN", "rrn"],
  ["Timestamp (IST)", "created_on"],
  ["Order Amount", "amount"],
  ["Status", "status"],
  ["Response code", "app_resp_code"],
  ["NPCI code", "npci_resp_code"],
  ["Payer PSP", "payer_psp"],
  ["Payer handle", "payer_handle"],
  ["Payer bank", "payer_bank"],
  ["Payer bank name", "payer_bank_name"],
  ["Payee handle", "payee_handle"],
  ["Payee bank", "payee_bank"],
  ["Payee bank name", "payee_bank_name"],
  ["Category", "category"],
  ["Initiation mode", "initiation_mode"],
];

export function downloadSampleCsv(rows, bankNames, fileName) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.map(([h]) => h).join(",")];
  for (const r of rows) {
    const x = {
      ...r,
      payer_bank_name: bankNames[r.payer_bank] || "",
      payee_bank_name: bankNames[r.payee_bank] || "",
    };
    lines.push(CSV_COLS.map(([, k]) => esc(x[k])).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function SampleButton({ fields, ui, pspMode, bankNames, window, day, tag, onDone }) {
  const [job, start] = useJob();
  const [limit, setLimit] = useState(500);
  const [failuresOnly, setFailuresOnly] = useState(true);
  const now = useNow(job?.status === "running");
  const done = useRef(null);
  useEffect(() => {
    if (job?.status === "done" && job.rows && done.current !== job.id) {
      done.current = job.id;
      downloadSampleCsv(job.rows, bankNames, `sample-txns-${tag || "drill"}-${(day || job.window?.from || "").slice(0, 10)}.csv`);
      onDone?.(job.rows.length);
    }
  }, [job, bankNames, tag, day, onDone]);
  const { filters, dropped, err } = useMemo(() => {
    try {
      return { ...toBackendFilters(ui, fields, "raw", pspMode), err: null };
    } catch (e) {
      return { filters: null, dropped: [], err: e.message };
    }
  }, [ui, fields, pspMode]);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      <button type="button" style={btn("primary")} disabled={job?.status === "running" || !filters} onClick={() => start("/sample", { filters, window, day, failuresOnly, limit })}>
        ⬇ Sample txns (CSV)
      </button>
      <select style={input} value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Sample size">
        {[100, 500, 1000, 5000].map((n) => (
          <option key={n} value={n}>
            {n} rows
          </option>
        ))}
      </select>
      <label
        style={{
          fontSize: 12,
          color: C.text2,
          display: "flex",
          gap: 4,
          alignItems: "center",
        }}
      >
        <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> failures only
      </label>
      <JobLine job={job} now={now} />
      {dropped.length > 0 && <span style={{ fontSize: 11, color: C.warn }}>raw txns ignore: {dropped.join(", ")}</span>}
      {err && <span style={{ fontSize: 11, color: C.bad }}>{err}</span>}
    </div>
  );
}

// ─── A · inline filters (re-query section A for any day-level slice) ─────────

/** Dropdown with search + checkboxes. options: [{ v, label?, n? }]. */
function MultiSelect({ label, options, value, onChange, exclude, onExclude, width = 260 }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const sel = new Set(value);
  const shown = options.filter((o) => !q || `${o.v} ${o.label || ""}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const toggle = (v) => onChange(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const active = value.length > 0;
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ ...btn(), padding: "4px 9px", borderColor: active ? C.info : C.border, color: active ? C.info : C.text2, fontWeight: active ? 700 : 500 }}
        title={active ? `${exclude ? "Excluding" : "Only"}: ${value.join(", ")}` : `Filter by ${label}`}
      >
        {label}
        {active ? ` ${exclude ? "≠" : "="} ${value.length === 1 ? value[0].replace(GROUP, "") : value.length}` : ""} ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            zIndex: 50,
            top: "calc(100% + 4px)",
            left: 0,
            width,
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.5)",
            padding: 8,
          }}
        >
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ ...input, flex: 1 }} />
            <button type="button" style={{ ...btn(), padding: "2px 8px", color: exclude ? C.bad : C.good }} onClick={() => onExclude(!exclude)} title="Include / exclude the ticked values">
              {exclude ? "Exclude" : "Include"}
            </button>
          </div>
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            {shown.map((o) => (
              <label key={o.v} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, padding: "3px 2px", color: C.text, cursor: "pointer" }}>
                <input type="checkbox" checked={sel.has(o.v)} onChange={() => toggle(o.v)} />
                <span style={{ flex: 1 }}>{o.label || o.v}</span>
                {o.n != null && <span style={{ color: C.muted, fontSize: 11 }}>{fmtNum(o.n)}</span>}
              </label>
            ))}
            {!shown.length && <div style={{ color: C.muted, fontSize: 12, padding: 4 }}>No values{options.length ? " match" : " loaded yet"}.</div>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
            <button type="button" style={{ ...btn(), padding: "2px 8px" }} onClick={() => onChange([])}>
              Clear
            </button>
            <button type="button" style={{ ...btn("primary"), padding: "2px 10px" }} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// Day-level fields A can be sliced by (the page header already filters payer handle and flow).
const A_FIELDS = [
  ["payee_handle", "Payee PSP"],
  ["payer_bank", "Payer bank"],
  ["category", "Sub-flow"],
  ["os", "OS"],
  ["instrument", "Instrument"],
  ["qr_type", "QR type"],
  ["code", "Code"],
];

/**
 * Inline filters for section A (rendered in the breakdown table's toolbar). Several fields at
 * once, multi-select each; Apply re-runs A's day-level query for the slice (one Trino query,
 * a few seconds when the queue is free). onRows({ rows, sig, label }) | onRows(null) to clear.
 */
export function BreakdownFilter({ cfg, pspMode, handleSel, flowSel, onRows, active, codeOptions = [] }) {
  const meta = useMeta();
  const [ui, setUi] = useState({});
  const [err, setErr] = useState(null);
  const [job, start] = useJob();
  const now = useNow(job?.status === "running");
  const [options, setOptions] = useState(null);
  const bankNames = useMemo(() => Object.fromEntries((cfg?.remitterBanks || []).map((b) => [b.code, b.name])), [cfg]);
  const runSig = useRef(null);
  useEffect(() => {
    api("/options")
      .then((o) => setOptions(o.options))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (job?.status === "done" && job.kind === "looker" && runSig.current) {
      onRows({ rows: job.rows, ...runSig.current });
      runSig.current = null;
    }
  }, [job, onRows]);

  const optionsFor = (id) => {
    const vals = options?.values?.[id] || [];
    if (id === "payee_handle") return [...PSP_ORDER[pspMode].map((g) => ({ v: `${GROUP}${g}`, label: `${g} (group)` })), ...vals.map((o) => ({ v: o.v, n: o.n }))];
    if (id === "payer_bank") return vals.map((o) => ({ v: o.v, n: o.n, label: bankNames[o.v] ? `${o.v} · ${bankNames[o.v]}` : o.v }));
    if (id === "code") return codeOptions.map((c) => ({ v: c.code, n: c.n, label: c.descr ? `${c.code} · ${c.descr}` : c.code }));
    return vals.map((o) => ({ v: o.v, n: o.n }));
  };
  const picked = Object.entries(ui).filter(([, s]) => s?.values?.length);
  const label = picked.map(([id, s]) => `${A_FIELDS.find((f) => f[0] === id)?.[1] || id} ${s.exclude ? "≠" : "="} ${s.values.map((v) => v.replace(GROUP, "")).join(", ")}`).join(" · ");
  const dirty = label !== (active?.label || "");

  const apply = () => {
    setErr(null);
    if (!picked.length) {
      onRows(null);
      return;
    }
    try {
      const { filters } = toBackendFilters({ ...ui, ...globalFilters(handleSel, flowSel) }, meta.fields, "looker", pspMode);
      runSig.current = { sig: `${handleSel}|${flowSel}|${pspMode}`, label };
      start("/run", { engine: "looker", filters, window: "10d" });
    } catch (e) {
      setErr(e.message);
    }
  };
  const clear = () => {
    setUi({});
    onRows(null);
  };
  if (!meta) return null;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <span style={{ width: 1, height: 20, background: C.border, margin: "0 2px" }} />
      {A_FIELDS.map(([id, name]) => (
        <MultiSelect
          key={id}
          label={name}
          options={optionsFor(id)}
          value={ui[id]?.values || []}
          exclude={Boolean(ui[id]?.exclude)}
          onChange={(values) => setUi((u) => ({ ...u, [id]: { values, exclude: u[id]?.exclude || false } }))}
          onExclude={(exclude) => setUi((u) => ({ ...u, [id]: { values: u[id]?.values || [], exclude } }))}
        />
      ))}
      <button type="button" style={btn(dirty && picked.length ? "primary" : undefined)} onClick={apply} disabled={job?.status === "running" || (!dirty && Boolean(active))}>
        {job?.status === "running" ? `⟳ ${fmtDur(now - job.startedAt)}` : "▶ Apply"}
      </button>
      {(active || picked.length > 0) && (
        <button type="button" style={btn()} onClick={clear} title="Back to the cached view (page filters only)">
          ✕ Clear
        </button>
      )}
      {job?.status === "running" && <span style={{ fontSize: 11, color: C.info }}>{job.state || "running"}</span>}
      {job?.status === "failed" && <span style={{ fontSize: 11, color: C.bad }}>✕ {job.error}</span>}
      {err && <span style={{ fontSize: 11, color: C.bad }}>{err}</span>}
    </span>
  );
}

// ─── J · drill-down ──────────────────────────────────────────────────────────

function RawTable({ rows, bankNames, groupBy }) {
  const data = useMemo(() => {
    const by = new Map();
    for (const r of rows) {
      const a = by.get(r.dim) || {
        dim: r.dim,
        total: 0,
        success: 0,
        codes: {},
      };
      a.total += r.total;
      a.success += r.success;
      if (r.code) a.codes[r.code] = (a.codes[r.code] || 0) + r.total - r.success;
      by.set(r.dim, a);
    }
    const all = [...by.values()].sort((a, b) => b.total - a.total);
    const tot = all.reduce((s, a) => ({ total: s.total + a.total, success: s.success + a.success }), { total: 0, success: 0 });
    return { all, tot };
  }, [rows]);
  const srAll = pct(data.tot.success, data.tot.total);
  return (
    <div
      style={{
        overflow: "auto",
        maxHeight: 480,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>{groupBy.replace(/_/g, " ")}</th>
            <th style={th}>Txns</th>
            <th style={th}>SR</th>
            <th style={th} title="SR − overall SR of the slice">
              vs slice
            </th>
            <th style={th}>Failures</th>
            <th style={{ ...th, textAlign: "left" }}>Top failure codes</th>
          </tr>
        </thead>
        <tbody>
          {data.all.map((a) => {
            const sr = pct(a.success, a.total);
            const top = Object.entries(a.codes)
              .sort((x, y) => y[1] - x[1])
              .slice(0, 3);
            return (
              <tr key={a.dim}>
                <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>
                  {a.dim}
                  {bankNames[a.dim] ? <span style={{ color: C.muted, fontWeight: 400 }}> · {bankNames[a.dim]}</span> : null}
                </td>
                <td style={td}>{fmtNum(a.total)}</td>
                <td style={td}>{fmtPct(sr)}</td>
                <td
                  style={{
                    ...td,
                    color: sr != null && srAll != null && sr < srAll - 1 ? C.bad : C.text2,
                  }}
                >
                  {fmtPp(sr != null && srAll != null ? sr - srAll : null)}
                </td>
                <td style={td}>{fmtNum(a.total - a.success)}</td>
                <td style={{ ...td, textAlign: "left", color: C.text2 }}>{top.map(([c, n]) => `${c} ${fmtNum(n)}`).join(" · ")}</td>
              </tr>
            );
          })}
          <tr style={{ background: C.card2, fontWeight: 700 }}>
            <td style={{ ...td, textAlign: "left" }}>Slice total</td>
            <td style={td}>{fmtNum(data.tot.total)}</td>
            <td style={td}>{fmtPct(srAll)}</td>
            <td style={td} />
            <td style={td}>{fmtNum(data.tot.total - data.tot.success)}</td>
            <td style={td} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function DrillCard({ cfg, pspMode, handleSel, flowSel }) {
  const meta = useMeta();
  const [options, setOptions] = useState(null);
  const engine = "raw";
  const [rawWindow, setRawWindow] = useState("yday");
  const [groupBy, setGroupBy] = useState("payer_bank");
  const [ui, setUi] = useState({});
  const [err, setErr] = useState(null);
  const [job, start] = useJob();
  const now = useNow(job?.status === "running");
  const bankNames = useMemo(() => Object.fromEntries((cfg?.remitterBanks || []).map((b) => [b.code, b.name])), [cfg]);

  // Filter values: one read on open; while the backend is still building them, re-read every 10s.
  const optTimer = useRef(null);
  const loadOptions = useCallback((refresh) => {
    clearTimeout(optTimer.current);
    api(`/options${refresh ? "?refresh=1" : ""}`)
      .then((o) => {
        setOptions(o.options);
        if (o.loading) optTimer.current = setTimeout(() => loadOptions(false), 10000);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadOptions(false);
    return () => clearTimeout(optTimer.current);
  }, [loadOptions]);

  // Seed from the page's global filters (editable afterwards).
  const seed = useCallback(() => {
    const g = globalFilters(handleSel, flowSel);
    if (g.flow && !["P2P", "P2M"].includes(flowSel)) delete g.flow; // raw txns have no LITE split
    setUi(g);
  }, [handleSel, flowSel]);
  useEffect(() => {
    seed();
  }, [seed]);

  const run = () => {
    setErr(null);
    try {
      const { filters } = toBackendFilters(ui, meta.fields, engine, pspMode);
      start("/run", { engine, filters, window: rawWindow, groupBy });
    } catch (e) {
      setErr(e.message);
    }
  };

  if (!meta) return <div style={{ color: C.muted, fontSize: 12 }}>{err || "Loading drill-down…"}</div>;
  const dropped = (() => {
    try {
      return toBackendFilters(ui, meta.fields, engine, pspMode).dropped;
    } catch {
      return [];
    }
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
        }}
      >
        <select style={input} value={rawWindow} onChange={(e) => setRawWindow(e.target.value)} aria-label="Window">
          {meta.windows.raw.map((w) => (
            <option key={w.key} value={w.key}>
              {w.label}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: C.text2 }}>Group by:</span>
        <select style={input} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="Group by">
          {meta.rawGroups.map((g) => (
            <option key={g} value={g}>
              {meta.fields.find((f) => f.id === g)?.label || g}
            </option>
          ))}
        </select>
        <button type="button" style={btn()} onClick={seed} title="Reset to the page's handle / flow filters">
          Reset filters
        </button>
        <button type="button" style={btn()} onClick={() => loadOptions(true)} title="Re-read distinct values for the pickers (one Trino query)">
          ↻ Filter values
          {options?.at ? ` · ${new Date(options.at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}` : ""}
        </button>
      </div>
      <FilterBar fields={meta.fields} engine={engine} ui={ui} setUi={setUi} options={options} pspMode={pspMode} bankNames={bankNames} />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          borderTop: `1px solid ${C.border}`,
          paddingTop: 10,
        }}
      >
        <button type="button" style={btn("primary")} onClick={run} disabled={job?.status === "running"}>
          ▶ Run drill-down
        </button>
        <JobLine job={job} now={now} />
        {dropped.length > 0 && <span style={{ fontSize: 11, color: C.warn }}>ignored on this engine: {dropped.join(", ")}</span>}
        {err && <span style={{ fontSize: 11, color: C.bad }}>{err}</span>}
        <span style={{ marginLeft: "auto" }} />
        <SampleButton fields={meta.fields} ui={ui} pspMode={pspMode} bankNames={bankNames} window={rawWindow} tag="drill" />
      </div>
      {job?.status === "done" && job.kind === "raw" && <RawTable rows={job.rows} bankNames={bankNames} groupBy={groupBy} />}
    </div>
  );
}

// ─── K · escalation candidates ───────────────────────────────────────────────

function DurationCell({ item, onCheck }) {
  const d = item.durState;
  const dur = item.duration;
  if (dur) {
    const l = dur.longest;
    return (
      <span style={{ color: dur.sustained ? C.bad : C.warn }} title={`${fmtMin(dur.degradedMin)} degraded in total; sustained = ≥${SUSTAINED_MIN} min in a row`}>
        {l ? `${dur.sustained ? "" : "transient · "}${fmtMin(l.min)} (${l.from}–${l.to})` : "no degraded 15-min bucket"}
      </span>
    );
  }
  if (d?.status === "na")
    return (
      <span style={{ color: C.muted }} title="Raw txns have no instrument / LITE split">
        n/a
      </span>
    );
  if (d?.status === "running") return <span style={{ color: C.info }}>checking… {d.state && d.state !== "FINISHED" ? d.state.toLowerCase() : ""}</span>;
  return (
    <span>
      {d?.status === "failed" && (
        <span style={{ color: C.bad }} title={d.error}>
          failed ·{" "}
        </span>
      )}
      <button type="button" style={{ ...btn(), padding: "2px 8px" }} onClick={onCheck} title="Run the 15-min SR check for this row (raw txns, one Trino query)">
        Check
      </button>
    </span>
  );
}

const KIND_LABEL = {
  psp: "Payee PSP",
  bank: "Payer bank",
  instrument: "Instrument",
  flow: "Flow",
};

function EmailModal({ item, onClose, ctx }) {
  const [party, setParty] = useState(item.party);
  const [sampleRows, setSampleRows] = useState(0);
  const [edited, setEdited] = useState(false);
  const draft = useMemo(() => buildEscalationEmail(item, { ...ctx, party, sampleRows }), [item, ctx, party, sampleRows]);
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (edited) return;
    setTo(draft.to);
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft, edited]);

  // Sample: the escalated slice on that day, the lead code's failures.
  const ui = useMemo(() => {
    const u = { ...ctx.baseFilters };
    if (item.kind === "bank") u.payer_bank = { values: [item.dim] };
    if (item.kind === "psp") u.payee_handle = { values: [`${GROUP}${item.dim}`] };
    if (item.kind === "flow" && ["P2P", "P2M"].includes(item.dim)) u.flow = { values: [item.dim] };
    if (item.lead) u.code = { values: [item.lead.code] };
    return u;
  }, [item, ctx.baseFilters]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`To: ${to}\n${cc ? `Cc: ${cc}\n` : ""}Subject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  const addr = (s) =>
    s
      .split(/[,;\s]+/)
      .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))
      .join(",");
  const mailto = `mailto:${addr(to)}?${new URLSearchParams({ ...(addr(cc) && { cc: addr(cc) }), subject, body }).toString().replace(/\+/g, "%20")}`;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.6)",
        zIndex: 3000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          width: "min(980px, 100%)",
          maxHeight: "92vh",
          overflow: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <b style={{ fontSize: 15 }}>Escalation email — {ctx.name}</b>
          <span style={{ fontSize: 12, fontWeight: 700, color: item.band.color }}>
            {item.score}/100 · {item.band.label}
          </span>
          <button type="button" style={{ ...btn(), marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          Minto pyramid: subject = governing thought · first paragraph = answer + ask · Situation / Complication / Question · three supports (what changed, why it is theirs, impact) · numbered ask ·
          evidence. Edit freely — nothing is sent from here.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "90px 1fr",
            gap: 8,
            alignItems: "center",
            fontSize: 12,
          }}
        >
          <span style={{ color: C.text2 }}>Recipient</span>
          <select
            style={input}
            value={party}
            onChange={(e) => {
              setParty(e.target.value);
              setEdited(false);
            }}
          >
            {Object.entries(PARTIES).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
                {k === item.party ? " (suggested)" : ""}
              </option>
            ))}
          </select>
          <span style={{ color: C.text2 }}>To</span>
          <input
            style={input}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setEdited(true);
            }}
            placeholder="addresses, comma-separated"
          />
          <span style={{ color: C.text2 }}>Cc</span>
          <input style={input} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="optional" />
          <span style={{ color: C.text2 }}>Subject</span>
          <input
            style={input}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setEdited(true);
            }}
          />
        </div>
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setEdited(true);
          }}
          style={{
            ...input,
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            minHeight: 380,
            lineHeight: 1.5,
          }}
        />
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          <button type="button" style={btn("primary")} onClick={copy}>
            {copied ? "Copied" : "Copy email"}
          </button>
          <a href={mailto} style={{ ...btn(), textDecoration: "none" }} title="Opens your mail app with this draft — attach the sample CSV there">
            ✉ Open in mail app
          </a>
          {edited && (
            <button type="button" style={btn()} onClick={() => setEdited(false)}>
              Regenerate draft
            </button>
          )}
          <span style={{ marginLeft: "auto" }} />
          <SampleButton fields={ctx.fields} ui={ui} pspMode={ctx.pspMode} bankNames={ctx.bankNames} day={item.days.now} tag={`${item.kind}-${item.dim}`} onDone={setSampleRows} />
        </div>
      </div>
    </div>
  );
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

/** Raw-txn slice for an escalation row, or null when raw txns cannot express it (instrument, LITE). */
function sliceOf(item) {
  if (item.kind === "bank") return { payer_bank: { values: [item.dim] } };
  if (item.kind === "psp") return { payee_handle: { values: [`${GROUP}${item.dim}`] } };
  if (item.kind === "flow" && ["P2P", "P2M"].includes(item.dim)) return { flow: { values: [item.dim] } };
  return null;
}

/**
 * 15-min duration checks per escalation row and day (backend /duration: all 4 TPAP handles,
 * all flows, cached on disk — page filters never re-run it). Returns [state by key, keyOf,
 * check(item)]. Rows scoring ≥ 50 are checked automatically, once.
 */
function useDurations(items, { fields, pspMode }) {
  const [st, setSt] = useState({}); // key -> { status, rows?, error? }
  const timers = useRef({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  const keyOf = useCallback((i) => `${i.kind}|${i.dim}|${i.days.now}|${i.kind === "psp" ? pspMode : ""}`, [pspMode]);
  const check = useCallback(
    async (item) => {
      const key = keyOf(item);
      const slice = sliceOf(item);
      if (!slice || !fields) {
        setSt((s) => ({ ...s, [key]: { status: "na" } }));
        return;
      }
      setSt((s) => ({ ...s, [key]: { status: "running" } }));
      try {
        const sl = toBackendFilters(slice, fields, "raw", pspMode).filters;
        const r = await api("/duration", {
          method: "POST",
          body: { slice: sl, day: item.days.now },
        });
        if (r.cached) {
          setSt((s) => ({ ...s, [key]: { status: "done", rows: r.rows } }));
          return;
        }
        const { jobId } = r;
        const poll = async () => {
          try {
            const j = await api(`/job/${jobId}`);
            if (j.status === "running") {
              setSt((s) => ({
                ...s,
                [key]: { status: "running", state: j.state },
              }));
              timers.current[key] = setTimeout(poll, 3000);
            } else setSt((s) => ({ ...s, [key]: j }));
          } catch (e) {
            setSt((s) => ({
              ...s,
              [key]: { status: "failed", error: e.message },
            }));
          }
        };
        poll();
      } catch (e) {
        setSt((s) => ({ ...s, [key]: { status: "failed", error: e.message } }));
      }
    },
    [keyOf, fields, pspMode],
  );
  // Auto-check the escalation-level rows (max 6), once each.
  useEffect(() => {
    if (!fields) return;
    items
      .filter((i) => i.score >= 50)
      .slice(0, 6)
      .forEach((i) => {
        if (!st[keyOf(i)]) check(i);
      });
  }, [items, fields, st, keyOf, check]);
  return [st, keyOf, check];
}

/** request: { kind, dim, code?, nonce } from another card (F) — opens the email draft for that row. */
export function EscalationCard({ breakdownRows, cfg, pspMode, handleSel, flowSel, scopeLabel, request = null }) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(null);
  const fields = useMeta()?.fields || null;
  const bankNames = useMemo(() => Object.fromEntries((cfg?.remitterBanks || []).map((b) => [b.code, b.name])), [cfg]);

  const {
    items: rawItems,
    yday,
    perKind,
    descr,
  } = useMemo(() => {
    const rows = breakdownRows || [];
    if (!rows.length) return { items: [], yday: null, perKind: {}, descr: {} };
    const y = pickYday(rows, { kind: "bank" });
    const d = Object.fromEntries(rows.filter((r) => r.kind === "code" && r.descr).map((r) => [r.dim, r.descr]));
    const pk = Object.fromEntries(SR_KINDS.map((k) => [k.id, buildBreakdown(rows, { kind: k.id, yday: y })]));
    return { items: scoreAll(pk, d), yday: y, perKind: pk, descr: d };
  }, [breakdownRows]);

  // One-click escalation from F: score that row even if it did not fall, lead with the clicked code.
  useEffect(() => {
    if (!request) return;
    const b = perKind[request.kind];
    const row = b?.rows.find((r) => r.dim === request.dim);
    if (!row) {
      setOpen({ missing: request });
      return;
    }
    const it = scoreRow(row, { kind: request.kind, descr, days: b.days, force: true, leadCode: request.code || null });
    if (it) setOpen({ ...it, overallSrNow: b.overall.srNow, overallSrL7: b.overall.srL7, days: b.days });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  const baseFilters = useMemo(() => {
    const u = globalFilters(handleSel, flowSel);
    if (u.flow && !["P2P", "P2M"].includes(flowSel)) delete u.flow; // raw txns have no LITE split
    return u;
  }, [handleSel, flowSel]);

  // Duration gate: < 60 min sustained → transient (capped at Watch).
  const [durSt, keyOf, checkDuration] = useDurations(rawItems, {
    fields,
    pspMode,
  });
  const items = useMemo(
    () =>
      rawItems
        .map((i) => {
          const d = durSt[keyOf(i)];
          const dur =
            d?.status === "done"
              ? analyzeDuration(d.rows, {
                  baseGap: i.srL7 != null && i.overallSrL7 != null ? i.srL7 - i.overallSrL7 : null,
                })
              : null;
          return { ...applyDuration(i, dur), baseScore: i.score, durState: d };
        })
        .sort((a, b) => b.score - a.score || a.impact - b.impact),
    [rawItems, durSt, keyOf],
  );

  if (!yday) return <div style={{ color: C.muted, fontSize: 12 }}>Needs section A&apos;s data.</div>;
  const shown = showAll ? items : items.filter((i) => i.score >= 30);
  const nameOf = (i) => (i.kind === "bank" && bankNames[i.dim] ? `${bankNames[i.dim]} (${i.dim})` : i.dim);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          fontSize: 12,
          color: C.text2,
        }}
      >
        <span>
          Every payee PSP / payer bank / instrument / flow row whose SR on <b>{yday}</b> fell below its L7D baseline, scored 0–100. Same rows and filters as section A ({scopeLabel}).
        </span>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show all drops ({items.length})
        </label>
      </div>
      <div style={{ fontSize: 11, color: C.muted }}>
        Score = severity 30 (Δ SR, 3pp = max) + impact 25 (hit on overall SR, 0.5pp = max) + lost txns 15 (0.5L = max) + persistence 15 (D-1 / D-2 also ≥1pp low) + attribution 15 (lead counterparty
        code&apos;s share of failures). Customer-side codes (funds, PIN, limits) and NPCI policy caps never count as attribution; rows with only those cap at 25. P1 ≥70 · P2 ≥50 · Watch ≥30. Duration
        gate: 15-min buckets on that day (all 4 TPAP handles, all flows; one check per row and day, kept across filter changes); the row&apos;s SR gap to overall SR must stay ≥1pp worse than its L7D
        gap for ≥{SUSTAINED_MIN} min in a row, else it is transient and capped at 49 (Watch). Rows scoring ≥50 are checked automatically, once.
      </div>
      {!shown.length ? (
        <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>
          Nothing worth escalating for {yday}
          {items.length ? ` — highest score ${items[0].score}/100 (${KIND_LABEL[items[0].kind]} ${nameOf(items[0])}).` : " — no row fell below its baseline."}
        </div>
      ) : (
        <div
          style={{
            overflow: "auto",
            maxHeight: 460,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Score", "Band", "Type", "Row", "SR now", "Δ vs L7D", "Impact", "Lost txns", "Lead code", "Duration (15-min)", "Suggested recipient", ""].map((h, i) => (
                  <th
                    key={h || i}
                    style={{
                      ...th,
                      textAlign: i < 4 || i >= 8 ? "left" : "right",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={`${i.kind}|${i.dim}`}>
                  <td
                    style={{
                      ...td,
                      textAlign: "left",
                      fontWeight: 700,
                      color: i.band.color,
                    }}
                    title={`${Object.entries(i.parts)
                      .map(([k, v]) => `${k} ${v.toFixed(1)}`)
                      .join(" · ")}${i.score !== i.baseScore ? ` · capped from ${i.baseScore} (transient)` : ""}`}
                  >
                    {i.score}
                    {i.score !== i.baseScore && <span style={{ color: C.muted, fontWeight: 400 }}> ({i.baseScore})</span>}
                  </td>
                  <td style={{ ...td, textAlign: "left", color: i.band.color }}>{i.band.label}</td>
                  <td style={{ ...td, textAlign: "left", color: C.text2 }}>{KIND_LABEL[i.kind]}</td>
                  <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{nameOf(i)}</td>
                  <td style={td}>{fmtPct(i.srNow)}</td>
                  <td style={{ ...td, color: C.bad }}>{fmtPp(i.dsr)}</td>
                  <td style={td}>{fmtPp(i.impact, 3)}</td>
                  <td style={td}>{fmtNum(i.lost)}</td>
                  <td style={{ ...td, textAlign: "left" }} title={i.lead?.descr || ""}>
                    {i.lead ? `${i.lead.code} · ${i.lead.share?.toFixed(0)}%` : <span style={{ color: C.muted }}>customer-side only</span>}
                  </td>
                  <td style={{ ...td, textAlign: "left" }}>
                    <DurationCell item={i} onCheck={() => checkDuration(i)} />
                  </td>
                  <td style={{ ...td, textAlign: "left", color: C.text2 }}>{PARTIES[i.party]?.label}</td>
                  <td style={{ ...td, textAlign: "left" }}>
                    <button type="button" style={btn(i.score >= 50 ? "primary" : undefined)} onClick={() => setOpen(i)}>
                      ✉ Draft email
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open?.missing && (
        <div style={{ padding: 10, color: C.warn, fontSize: 12 }}>
          {open.missing.dim} is not a row in section A for the current handle / flow filter — clear filters or pick it in A first.{" "}
          <button type="button" style={btn()} onClick={() => setOpen(null)}>
            OK
          </button>
        </div>
      )}
      {open && !open.missing && fields && (
        <EmailModal
          item={open}
          onClose={() => setOpen(null)}
          ctx={{
            name: nameOf(open),
            scope: scopeLabel,
            fields,
            pspMode,
            bankNames,
            baseFilters,
          }}
        />
      )}
    </div>
  );
}
