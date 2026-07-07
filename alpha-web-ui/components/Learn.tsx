"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Bookmark,
  BookmarkCheck,
  ChevronUp,
  ChevronDown,
  ExternalLink,
  Shuffle,
  Sparkles,
  Lightbulb,
  TrendingUp,
  Cog,
  Globe,
  AlertTriangle,
  Lock,
  Layers,
} from "lucide-react";

type LearnBlock = { label: string; points: string[] };

type LearnCard = {
  id: string;
  title: string;
  category: string;
  group: string;
  accent: string;
  source: string;
  tags: string[];
  internal: boolean;
  deck: string;
  stat: string | null;
  blocks: LearnBlock[];
  takeaway: LearnBlock | null;
};

// Per-block icon by label, for quick visual scanning.
function blockIcon(label: string) {
  if (label === "How it works") return Cog;
  if (label === "In the wild") return Globe;
  if (label === "The catch") return AlertTriangle;
  return Layers;
}

// Accent -> gradient + label color. Hand-tuned to stay readable with white text.
const ACCENTS: Record<string, { from: string; to: string }> = {
  ocean: { from: "#0a3d5e", to: "#00a3e0" },
  ember: { from: "#7a1020", to: "#e12e3a" },
  teal: { from: "#0a4a47", to: "#11998e" },
  grape: { from: "#3a1a5e", to: "#8e44ad" },
  indigo: { from: "#1a2a6c", to: "#4361ee" },
  amber: { from: "#7a4a05", to: "#ffa905" },
  slate: { from: "#1e293b", to: "#475569" },
  forest: { from: "#0c3a1e", to: "#158939" },
  violet: { from: "#2d1b69", to: "#7c3aed" },
};

const GROUPS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "insights", label: "Insights" },
  { id: "product", label: "Product" },
  { id: "frameworks", label: "Frameworks" },
];

const SAVED_KEY = "upi.learn.saved";

function loadSaved(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export default function Learn() {
  const [cards, setCards] = useState<LearnCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState("all");
  const [savedOnly, setSavedOnly] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState(0);
  const [seed, setSeed] = useState(0); // bump to reshuffle

  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    setSaved(loadSaved());
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/learn")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) setError(d.error);
        else setCards(d.cards || []);
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Deterministic shuffle keyed by `seed` so "shuffle" reorders on demand.
  const filtered = useMemo(() => {
    let list = cards;
    if (group !== "all") list = list.filter((c) => c.group === group);
    if (savedOnly) list = list.filter((c) => saved.has(c.id));
    if (seed > 0) {
      list = [...list];
      let s = seed * 9301 + 49297;
      for (let i = list.length - 1; i > 0; i--) {
        s = (s * 9301 + 49297) % 233280;
        const j = Math.floor((s / 233280) * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    return list;
  }, [cards, group, savedOnly, saved, seed]);

  // Reset to top whenever the filtered set changes.
  useEffect(() => {
    setIndex(0);
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [group, savedOnly, seed]);

  // Track which card is in view.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.idx);
            if (!Number.isNaN(i)) setIndex(i);
          }
        }
      },
      { root, threshold: 0.6 }
    );
    cardRefs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [filtered]);

  const goTo = useCallback((i: number) => {
    const el = cardRefs.current[i];
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Keyboard nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        goTo(Math.min(index + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        goTo(Math.max(index - 1, 0));
      } else if (e.key.toLowerCase() === "s") {
        const c = filtered[index];
        if (c) toggleSave(c.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, filtered, goTo]);

  const toggleSave = (id: string) => {
    setSaved((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem(SAVED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  };

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-ink-400">
        <div className="flex flex-col items-center gap-3">
          <Sparkles className="animate-pulse text-brand-400" size={28} />
          <p className="text-sm">Building your learning feed from the wiki…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-rose-500">
        <p className="text-sm">Couldn’t build the feed: {error}</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-ink-900">
      {/* Top controls */}
      <div className="z-20 flex shrink-0 items-center gap-2 border-b border-white/10 bg-ink-900/90 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-1.5">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroup(g.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                group === g.id
                  ? "bg-brand-500 text-white"
                  : "bg-white/10 text-ink-300 hover:bg-white/15"
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setSavedOnly((v) => !v)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition ${
              savedOnly
                ? "bg-amber-400 text-ink-900"
                : "bg-white/10 text-ink-300 hover:bg-white/15"
            }`}
          >
            <Bookmark size={13} /> Saved ({saved.size})
          </button>
          <button
            onClick={() => setSeed((s) => s + 1)}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-ink-300 transition hover:bg-white/15"
          >
            <Shuffle size={13} /> Shuffle
          </button>
        </div>
      </div>

      {/* Feed */}
      {filtered.length === 0 ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-ink-400">
          <div className="flex flex-col items-center gap-3">
            <Lightbulb size={28} className="text-ink-500" />
            <p className="text-sm">
              {savedOnly
                ? "No saved cards yet. Tap the bookmark on a card to save it for later."
                : "No cards in this filter."}
            </p>
            {savedOnly && (
              <button
                onClick={() => setSavedOnly(false)}
                className="rounded-full bg-brand-500 px-4 py-1.5 text-xs font-medium text-white"
              >
                Back to all cards
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={scrollerRef}
          className="relative min-h-0 flex-1 snap-y snap-mandatory overflow-y-scroll scroll-smooth"
          style={{ scrollbarWidth: "none" }}
        >
          {filtered.map((c, i) => (
            <Card
              key={c.id}
              card={c}
              idx={i}
              total={filtered.length}
              saved={saved.has(c.id)}
              onSave={() => toggleSave(c.id)}
              registerRef={(el) => (cardRefs.current[i] = el)}
            />
          ))}
        </div>
      )}

      {/* Right rail nav */}
      {filtered.length > 0 && (
        <div className="pointer-events-none absolute bottom-6 right-4 z-20 flex flex-col items-center gap-2">
          <button
            onClick={() => goTo(Math.max(index - 1, 0))}
            disabled={index === 0}
            className="pointer-events-auto grid size-10 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-30"
            aria-label="Previous"
          >
            <ChevronUp size={20} />
          </button>
          <div className="rounded-full bg-black/40 px-2 py-1 text-center text-[11px] font-medium text-white backdrop-blur">
            {index + 1}
            <span className="text-white/50"> / {filtered.length}</span>
          </div>
          <button
            onClick={() => goTo(Math.min(index + 1, filtered.length - 1))}
            disabled={index >= filtered.length - 1}
            className="pointer-events-auto grid size-10 place-items-center rounded-full bg-white/15 text-white backdrop-blur transition hover:bg-white/25 disabled:opacity-30"
            aria-label="Next"
          >
            <ChevronDown size={20} />
          </button>
        </div>
      )}

      {/* Progress bar */}
      {filtered.length > 0 && (
        <div className="absolute left-0 top-[49px] z-20 h-0.5 w-full bg-white/10">
          <div
            className="h-full bg-brand-400 transition-all"
            style={{ width: `${((index + 1) / filtered.length) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Card({
  card,
  idx,
  total,
  saved,
  onSave,
  registerRef,
}: {
  card: LearnCard;
  idx: number;
  total: number;
  saved: boolean;
  onSave: () => void;
  registerRef: (el: HTMLElement | null) => void;
}) {
  const accent = ACCENTS[card.accent] || ACCENTS.ocean;
  return (
    <section
      ref={registerRef}
      data-idx={idx}
      className="relative flex h-full snap-start snap-always items-center justify-center overflow-hidden px-5 py-5"
      style={{
        background: `linear-gradient(160deg, ${accent.from} 0%, ${accent.to} 100%)`,
      }}
    >
      <div
        className="learn-scroll relative max-h-full w-full max-w-xl overflow-y-auto py-1 pr-1"
        style={{ scrollbarWidth: "none" }}
      >
        {/* Category + counter */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white backdrop-blur">
            {card.category}
          </span>
          {card.internal && (
            <span className="flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-900">
              <Lock size={10} /> Internal
            </span>
          )}
          <span className="text-[11px] font-medium text-white/60">
            {idx + 1} of {total}
          </span>
        </div>

        {/* Title */}
        <h2 className="text-balance text-2xl font-bold leading-tight text-white sm:text-[28px]">
          {card.title}
        </h2>

        {/* Deck */}
        {card.deck && (
          <p className="mt-3 text-[15px] leading-relaxed text-white/90">
            {card.deck}
          </p>
        )}

        {/* Stat highlight */}
        {card.stat && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/25 bg-white/10 px-3.5 py-3 backdrop-blur">
            <TrendingUp size={18} className="mt-0.5 shrink-0 text-white" />
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-white/60">
                By the numbers
              </div>
              <div className="text-sm font-medium leading-snug text-white">
                {card.stat}
              </div>
            </div>
          </div>
        )}

        {/* Content blocks */}
        {card.blocks.map((b, bi) => {
          const Icon = blockIcon(b.label);
          return (
            <div key={bi} className="mt-5">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/70">
                <Icon size={13} /> {b.label}
              </div>
              <ul className="space-y-2">
                {b.points.map((p, i) => (
                  <li
                    key={i}
                    className="flex gap-2.5 text-[13.5px] leading-snug text-white/90"
                  >
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-white/60" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {/* Takeaway: application to Paytm / UPI */}
        {card.takeaway && (
          <div className="mt-5 rounded-xl border border-white/25 bg-black/20 p-3.5 backdrop-blur">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/80">
              <Lightbulb size={13} /> {card.takeaway.label}
            </div>
            <ul className="space-y-2">
              {card.takeaway.points.map((p, i) => (
                <li
                  key={i}
                  className="flex gap-2.5 text-[13.5px] leading-snug text-white"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-white/70" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer: tags + actions */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {card.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] text-white/70"
            >
              #{t}
            </span>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onSave}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium backdrop-blur transition ${
                saved
                  ? "bg-amber-400 text-ink-900"
                  : "bg-white/15 text-white hover:bg-white/25"
              }`}
            >
              {saved ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
              {saved ? "Saved" : "Save"}
            </button>
            <a
              href={`/api/file?path=${encodeURIComponent(card.source)}&raw=1`}
              target="_blank"
              rel="noreferrer"
              title={card.source}
              className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium text-white backdrop-blur transition hover:bg-white/25"
            >
              <ExternalLink size={14} /> Source
            </a>
          </div>
        </div>
      </div>

      {/* Swipe hint on the very first card */}
      {idx === 0 && (
        <div className="pointer-events-none absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1 text-white/60">
          <ChevronDown size={20} className="animate-bounce" />
          <span className="text-[11px]">Swipe / scroll · ↑ ↓ keys · S to save</span>
        </div>
      )}
    </section>
  );
}
