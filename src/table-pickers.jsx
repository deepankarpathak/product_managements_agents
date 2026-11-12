import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Row / column pickers for dashboard tables — a "More filters"-style popover with search,
// checkboxes and presets. Row choices are stored as { hidden, added } against the table's
// default rows, so a new day's top-N still flows in while your adds / removes stick.

const C = {
  card: "#111a2e",
  card2: "#0f172a",
  border: "#1e293b",
  text: "#e2e8f0",
  text2: "#94a3b8",
  muted: "#64748b",
  accent: "#34d399",
};

const pill = (active) => ({
  padding: "5px 11px",
  borderRadius: 6,
  border: `1px solid ${active ? C.accent : C.border}`,
  background: active ? "rgba(52,211,153,0.12)" : "transparent",
  color: active ? C.accent : C.text2,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
});
const mini = { ...pill(false), padding: "2px 8px", fontSize: 11 };
const PANEL_W = 340;
const GAP = 6;

/**
 * Viewport position for the panel: below the button (above when there is more room there),
 * aligned to whichever button edge keeps it inside the page's content area (not under the
 * app sidebar), with the list height fitted to the space available.
 */
function placePanel(btn) {
  const r = btn.getBoundingClientRect();
  const area = (btn.closest("main") || document.body).getBoundingClientRect();
  const minL = Math.max(8, area.left + 8);
  const maxR = Math.min(window.innerWidth - 8, area.right > minL + 200 ? area.right - 8 : window.innerWidth - 8);
  const width = Math.min(PANEL_W, maxR - minL);
  // Prefer opening rightwards from the button's left edge; else leftwards from its right edge.
  let left = r.left + width <= maxR ? r.left : r.right - width;
  left = Math.max(minL, Math.min(left, maxR - width));
  const below = window.innerHeight - r.bottom - GAP - 8;
  const above = r.top - GAP - 8;
  const up = below < 260 && above > below;
  const room = Math.max(160, up ? above : below);
  return up ? { left, width, bottom: window.innerHeight - r.top + GAP, maxH: room } : { left, width, top: r.bottom + GAP, maxH: room };
}

/** useState persisted in localStorage (tp:<key>); falls back silently when storage is blocked. */
export function useStored(key, fallback) {
  const read = () => {
    if (!key) return fallback;
    try {
      const v = localStorage.getItem(`tp:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  const [val, setVal] = useState(read);
  // A new key (e.g. another tab of the same table) loads its own value.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setVal(read()), [key]);
  const set = (next) =>
    setVal((old) => {
      const v = typeof next === "function" ? next(old) : next;
      try {
        if (key) localStorage.setItem(`tp:${key}`, JSON.stringify(v));
      } catch {
        /* storage blocked */
      }
      return v;
    });
  return [val, set];
}

export const NO_PICK = { hidden: [], added: [] };

/** Visible row ids = (defaults − hidden) ∪ added, in defaults order then added order. */
export function applyPick(defaults, pick = NO_PICK) {
  const hidden = new Set(pick.hidden);
  const base = defaults.filter((id) => !hidden.has(id));
  const seen = new Set(base);
  return [...base, ...pick.added.filter((id) => !seen.has(id))];
}

/** Picker selection → { hidden, added } relative to the defaults. */
export function toPick(defaults, ids) {
  const want = new Set(ids);
  const def = new Set(defaults);
  return { hidden: defaults.filter((id) => !want.has(id)), added: ids.filter((id) => !def.has(id)) };
}

/**
 * Popover checklist. items: [{ id, label, sub? }]; visible: ids currently shown;
 * onChange(ids); presets: [{ label, ids }]; onReset: back to the table's defaults.
 */
export function Picker({ label, items, visible, onChange, presets = [], onReset = null, title, changed = false }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  // Re-place on open, scroll (any scroller) and resize so the panel follows its button.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => btnRef.current && setPos(placePanel(btnRef.current));
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => !ref.current?.contains(e.target) && !panelRef.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const on = useMemo(() => new Set(visible), [visible]);
  const needle = q.trim().toLowerCase();
  const list = needle ? items.filter((i) => i.id.toLowerCase().includes(needle) || (i.label || "").toLowerCase().includes(needle) || (i.sub || "").toLowerCase().includes(needle)) : items;
  // Checked first, so what is on screen is easy to prune; the rest keeps the caller's order.
  const ordered = [...list.filter((i) => on.has(i.id)), ...list.filter((i) => !on.has(i.id))];
  const toggle = (id) => onChange(on.has(id) ? visible.filter((x) => x !== id) : [...visible, id]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button ref={btnRef} type="button" style={pill(open || changed)} onClick={() => setOpen((o) => !o)} title={title}>
        {label}
        <span style={{ marginLeft: 6, fontSize: 10, color: C.muted }}>
          {visible.length}/{items.length}
        </span>
        {changed && <span style={{ marginLeft: 4, color: C.accent }}>•</span>}
      </button>
      {open &&
        pos &&
        createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            bottom: pos.bottom,
            zIndex: 1000,
            width: pos.width,
            maxHeight: pos.maxH,
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
            background: C.card2,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,.5)",
            padding: 10,
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            style={{ width: "100%", boxSizing: "border-box", background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, fontSize: 12, padding: "5px 8px" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "8px 0" }}>
            <button type="button" style={mini} onClick={() => onChange(items.map((i) => i.id))}>
              All
            </button>
            <button type="button" style={mini} onClick={() => onChange([])}>
              None
            </button>
            {presets.map((p) => (
              <button key={p.label} type="button" style={mini} onClick={() => onChange(p.ids)}>
                {p.label}
              </button>
            ))}
            {onReset && (
              <button type="button" style={{ ...mini, marginLeft: "auto", color: C.accent }} onClick={onReset}>
                Reset
              </button>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 60, overflow: "auto" }}>
            {ordered.map((i) => (
              <label key={i.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 2px", fontSize: 12, color: C.text, cursor: "pointer" }}>
                <input type="checkbox" checked={on.has(i.id)} onChange={() => toggle(i.id)} style={{ marginTop: 2 }} />
                <span style={{ minWidth: 0 }}>
                  {i.label || i.id}
                  {i.sub && <span style={{ display: "block", fontSize: 11, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.sub}</span>}
                </span>
              </label>
            ))}
            {!ordered.length && <div style={{ fontSize: 12, color: C.muted, padding: 6 }}>No match.</div>}
          </div>
        </div>,
          document.body,
        )}
    </div>
  );
}
