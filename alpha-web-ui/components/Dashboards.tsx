"use client";

import { useEffect, useState } from "react";
import DeployButton from "./DeployButton";
import {
  BarChart3,
  FileCode2,
  Image as ImageIcon,
  Table,
  FileText,
  X,
  Loader2,
  ExternalLink,
  Download,
} from "lucide-react";

type Item = {
  name: string;
  kind: "image" | "html" | "csv" | "markdown" | "other";
  ext: string;
  size: number;
  mtime: number;
  url: string;
};

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(ms: number) {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

function kindIcon(kind: Item["kind"]) {
  if (kind === "image") return ImageIcon;
  if (kind === "html") return FileCode2;
  if (kind === "csv") return Table;
  if (kind === "markdown") return FileText;
  return BarChart3;
}

function prettyName(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Dashboards() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [dir, setDir] = useState("");
  const [open, setOpen] = useState<Item | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/dashboards")
      .then((r) => r.json())
      .then((d) => {
        setItems(d.items || []);
        setAvailable(d.available !== false);
        setDir(d.dir || "");
      })
      .catch(() => {
        setItems([]);
        setAvailable(false);
      });
  }, []);

  const openItem = async (it: Item) => {
    setOpen(it);
    setTextContent(null);
    if (it.kind === "csv" || it.kind === "markdown") {
      try {
        const r = await fetch(
          `/api/dashboards?name=${encodeURIComponent(it.name)}&text=1`
        );
        const d = await r.json();
        setTextContent(d.content || "");
      } catch {
        setTextContent("(could not load)");
      }
    }
  };

  if (items === null)
    return (
      <div className="grid h-full place-items-center">
        <Loader2 size={18} className="animate-spin text-ink-300" />
      </div>
    );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-ink-900">Dashboards & charts</h2>
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
            {items.length}
          </span>
        </div>
        <p className="mb-6 text-sm text-ink-400">
          Everything we've built, from{" "}
          <code className="rounded bg-ink-100 px-1 text-xs">
            {dir || "~/Documents/Claude_Charts"}
          </code>
          . Click a card to open it full-size.
        </p>

        {!available || items.length === 0 ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-ink-200 py-16 text-center text-sm text-ink-400">
            <BarChart3 size={28} className="mb-2 text-ink-300" />
            No dashboards found yet.
            <span className="text-xs">
              Charts you build are saved to ~/Documents/Claude_Charts and appear
              here.
            </span>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((it) => {
              const Icon = kindIcon(it.kind);
              return (
                <button
                  key={it.name}
                  onClick={() => openItem(it)}
                  className="group overflow-hidden rounded-2xl border border-ink-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
                >
                  <div className="grid h-44 place-items-center overflow-hidden border-b border-ink-100 bg-ink-50">
                    {it.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={it.url}
                        alt={it.name}
                        className="h-full w-full object-cover object-top transition group-hover:scale-[1.02]"
                      />
                    ) : it.kind === "html" ? (
                      <iframe
                        src={it.url}
                        title={it.name}
                        className="pointer-events-none h-[352px] w-[125%] origin-top-left scale-[0.8] border-0 bg-white"
                      />
                    ) : (
                      <Icon size={34} className="text-ink-300" />
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} className="shrink-0 text-brand-500" />
                      <span className="truncate text-sm font-semibold text-ink-800">
                        {prettyName(it.name)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-400">
                      <span className="uppercase">{it.ext.replace(".", "")}</span>
                      <span>·</span>
                      <span>{fmtSize(it.size)}</span>
                      <span>·</span>
                      <span>{fmtDate(it.mtime)}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Lightbox / viewer */}
      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink-900/70 p-4 backdrop-blur-sm"
          onClick={() => setOpen(null)}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-ink-200 px-4 py-2.5">
              <span className="text-sm font-semibold text-ink-800">
                {prettyName(open.name)}
              </span>
              <span className="font-mono text-[11px] text-ink-400">{open.name}</span>
              <div className="ml-auto flex items-center gap-2">
                {open.kind === "html" && (
                  <DeployButton
                    source="chart"
                    name={open.name}
                    displayName={prettyName(open.name)}
                  />
                )}
                <a
                  href={open.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in new tab"
                  className="grid size-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600"
                >
                  <ExternalLink size={15} />
                </a>
                <a
                  href={open.url}
                  download={open.name}
                  title="Download"
                  className="grid size-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600"
                >
                  <Download size={15} />
                </a>
                <button
                  onClick={() => setOpen(null)}
                  className="grid size-8 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-700"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-ink-50">
              {open.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={open.url} alt={open.name} className="mx-auto" />
              ) : open.kind === "html" ? (
                <iframe
                  src={open.url}
                  title={open.name}
                  className="h-[80vh] w-full border-0 bg-white"
                />
              ) : textContent === null ? (
                <div className="grid h-40 place-items-center">
                  <Loader2 size={16} className="animate-spin text-ink-300" />
                </div>
              ) : open.kind === "csv" ? (
                <CsvView content={textContent} />
              ) : (
                <pre className="whitespace-pre-wrap p-5 font-mono text-xs text-ink-700">
                  {textContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CsvView({ content }: { content: string }) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .slice(0, 500)
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
      out.push(cur);
      return out;
    });
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto p-4">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="sticky top-0 border border-ink-200 bg-ink-100 px-2 py-1.5 text-left font-semibold text-ink-700"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className={i % 2 ? "bg-white" : "bg-ink-50"}>
              {r.map((c, j) => (
                <td key={j} className="border border-ink-200 px-2 py-1 text-ink-600">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
