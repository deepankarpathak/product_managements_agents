// Shared bits for the PM Console pages (Today, HSS, SR Dissection, SR Benchmark, Lumina, Txn Tracer).
import { API_BASE } from "./config.js";

export const C = {
  bg: "#0b1220",
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#60a5fa",
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#fab219",
};
export const PSP_COLOR = { ptyes: "#60a5fa", ptaxis: "#f472b6", pthdfc: "#fbbf24", ptsbi: "#34d399" };
export const JARVIS_URL = "https://ai-tools.finmate.tech";

export async function api(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/** POST to an SSE endpoint (Lumina) and dispatch `status` / `result` / `error` events. */
export async function streamSse(path, body, { onStatus, onResult, onError, signal }) {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (block) => {
    let ev = "message";
    let data = "";
    for (const line of block.split("\n")) {
      const l = line.replace(/\r$/, "");
      if (l.startsWith("event:")) ev = l.slice(6).trim();
      else if (l.startsWith("data:")) data = l.slice(5).trim();
    }
    if (!data) return;
    try {
      const d = JSON.parse(data);
      if (ev === "status") onStatus?.(d.message || d);
      else if (ev === "result") onResult?.(d.data ?? d);
      else if (ev === "error") onError?.(d.message || d);
    } catch {
      /* partial / non-JSON keepalive */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    parts.forEach(handle);
  }
  if (buf.trim()) handle(buf);
}

export const fmtNum = (n) => (n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-IN"));
export const fmtCompact = (n) => {
  if (n == null) return "—";
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  return fmtNum(n);
};
export const fmtAgo = (ms) => {
  if (!ms) return "—";
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
export const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");

export function Page({ title, subtitle, actions, children }) {
  return (
    <div style={{ minHeight: "calc(100vh - 40px)", background: C.bg, color: C.text, fontFamily: "'Segoe UI', sans-serif", padding: "16px 20px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{title}</h1>
          {subtitle && <div style={{ color: C.text2, fontSize: 12, marginTop: 4 }}>{subtitle}</div>}
        </div>
        {actions && <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, right, children, style }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", minWidth: 0, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{title}</div>
          {right && <div style={{ fontSize: 11, color: C.muted }}>{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Btn({ children, primary, ...props }) {
  return (
    <button
      type="button"
      {...props}
      style={{
        padding: "6px 12px",
        borderRadius: 6,
        border: `1px solid ${primary ? C.accent : C.border}`,
        background: primary ? "rgba(96,165,250,.15)" : "transparent",
        color: props.disabled ? C.muted : primary ? "#bfdbfe" : C.text,
        fontSize: 12,
        fontWeight: 600,
        cursor: props.disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
        ...(props.style || {}),
      }}
    >
      {children}
    </button>
  );
}

export const inputStyle = {
  background: C.card2,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontSize: 13,
  padding: "7px 10px",
  outline: "none",
  minWidth: 0,
};

export function ErrorNote({ children }) {
  if (!children) return null;
  return <div style={{ color: "#fecaca", background: "rgba(239,68,68,.08)", border: "1px solid #7f1d1d", borderRadius: 6, padding: "8px 10px", fontSize: 12 }}>{children}</div>;
}

/** Stacked share bar for a PSP mix like { ptyes: 82, ptaxis: 12, ... }. */
export function MixBar({ mix, psps, height = 8 }) {
  const total = psps.reduce((s, p) => s + (Number(mix?.[p.id]) || 0), 0) || 1;
  return (
    <div style={{ display: "flex", height, borderRadius: 4, overflow: "hidden", background: C.card2 }}>
      {psps.map((p) => {
        const v = Number(mix?.[p.id]) || 0;
        return v > 0 ? <div key={p.id} title={`${p.label} ${v}%`} style={{ width: `${(100 * v) / total}%`, background: PSP_COLOR[p.id] || C.muted }} /> : null;
      })}
    </div>
  );
}

export function PspLegend({ psps }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: C.text2 }}>
      {psps.map((p) => (
        <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: PSP_COLOR[p.id] || C.muted }} />
          {p.label}
        </span>
      ))}
    </div>
  );
}

/** Tiny Markdown renderer for Lumina answers: headings, bullets, bold, inline code, links. */
export function Markdown({ text }) {
  const inline = (s, key) => {
    const parts = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    let i = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith("**")) parts.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
      else if (t.startsWith("`")) parts.push(<code key={`${key}-${i++}`} style={{ background: C.card2, padding: "0 4px", borderRadius: 3 }}>{t.slice(1, -1)}</code>);
      else {
        const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
        parts.push(<span key={`${key}-${i++}`} style={{ color: C.accent }} title={href}>{label}</span>);
      }
      last = m.index + t.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };
  const lines = String(text || "").split("\n");
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      {lines.map((l, i) => {
        const h = l.match(/^(#{1,4})\s+(.*)/);
        if (h) return <div key={i} style={{ fontWeight: 700, fontSize: h[1].length <= 2 ? 15 : 13, margin: "8px 0 4px" }}>{inline(h[2], i)}</div>;
        const b = l.match(/^\s*[-*]\s+(.*)/);
        if (b) return <div key={i} style={{ paddingLeft: 14, position: "relative" }}><span style={{ position: "absolute", left: 2, color: C.muted }}>•</span>{inline(b[1], i)}</div>;
        if (!l.trim()) return <div key={i} style={{ height: 6 }} />;
        return <div key={i}>{inline(l, i)}</div>;
      })}
    </div>
  );
}

export const th = { textAlign: "left", padding: "6px 8px", color: C.muted, fontWeight: 600, fontSize: 11, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap" };
export const td = { padding: "6px 8px", borderBottom: `1px solid ${C.border}`, fontSize: 12, verticalAlign: "top" };

const cellText = (v) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Table for an array of flat-ish objects whose shape isn't known up front (Jarvis payloads). */
export function AutoTable({ rows, max = 200, columns }) {
  if (!Array.isArray(rows) || !rows.length) return <div style={{ fontSize: 12, color: C.muted }}>None.</div>;
  if (typeof rows[0] !== "object") return <div style={{ fontSize: 12 }}>{rows.map(cellText).join(", ")}</div>;
  const cols = columns || [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))].slice(0, 10);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={th}>
                {c.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} style={{ ...td, maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis" }} title={cellText(r?.[c])}>
                  {cellText(r?.[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Showing {max} of {rows.length}.</div>}
    </div>
  );
}

export function RawJson({ value, label = "Raw response" }) {
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: C.text2 }}>{label}</summary>
      <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, maxHeight: 420, overflow: "auto", color: C.text2 }}>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
