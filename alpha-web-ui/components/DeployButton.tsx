"use client";

import { useState } from "react";
import { Share2, Loader2, ExternalLink, Copy, Check, AlertTriangle } from "lucide-react";

/**
 * Publishes an HTML artifact to HTMLBox (Paytm's internal host) and surfaces
 * the shareable link. `source` selects the repo resolver: a Dashboards chart
 * or a Design Studio prototype.
 */
export default function DeployButton({
  source,
  name,
  displayName,
  className,
}: {
  source: "chart" | "prototype";
  name: string;
  displayName?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const deploy = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/htmlbox/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, name, displayName }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Deploy failed");
      setUrl(d.url);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (url) {
    return (
      <div className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
        >
          {url.replace(/^https?:\/\//, "")} <ExternalLink size={12} />
        </a>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(url).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title="Copy link"
          className="text-emerald-600 hover:text-emerald-800"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={deploy}
        disabled={busy}
        title="Publish to a shareable Paytm link (HTMLBox)"
        className={
          className ||
          "inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs font-medium text-ink-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
        }
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Share2 size={14} />
        )}
        {busy ? "Publishing…" : "Deploy & share"}
      </button>
      {err && (
        <span
          title={err}
          className="inline-flex items-center gap-1 text-[11px] text-rose-600"
        >
          <AlertTriangle size={12} /> {err.slice(0, 60)}
        </span>
      )}
    </div>
  );
}
