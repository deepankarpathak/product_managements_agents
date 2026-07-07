"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  ChevronRight,
  Loader2,
  Download,
} from "lucide-react";
import Markdown from "./Markdown";

type Node = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
};

function fmtSize(n?: number) {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(name: string) {
  if (/\.(md|markdown|txt)$/i.test(name)) return FileText;
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name)) return ImageIcon;
  return FileIcon;
}

function TreeItem({
  node,
  depth,
  onOpenFile,
  activePath,
}: {
  node: Node;
  depth: number;
  onOpenFile: (path: string) => void;
  activePath: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (children === null) {
      setLoading(true);
      try {
        const r = await fetch(`/api/tree?path=${encodeURIComponent(node.path)}`);
        const d = await r.json();
        setChildren(d.nodes || []);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const pad = { paddingLeft: depth * 12 + 8 } as const;

  if (node.type === "dir") {
    const Icon = open ? FolderOpen : Folder;
    return (
      <div>
        <button
          onClick={toggle}
          style={pad}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-ink-700 transition hover:bg-ink-100"
        >
          <ChevronRight
            size={13}
            className={`shrink-0 text-ink-400 transition-transform ${open ? "rotate-90" : ""}`}
          />
          <Icon size={15} className="shrink-0 text-brand-500" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <div>
            {loading && (
              <div style={{ paddingLeft: (depth + 1) * 12 + 22 }} className="py-1">
                <Loader2 size={13} className="animate-spin text-ink-300" />
              </div>
            )}
            {children?.map((c) => (
              <TreeItem
                key={c.path}
                node={c}
                depth={depth + 1}
                onOpenFile={onOpenFile}
                activePath={activePath}
              />
            ))}
            {children && children.length === 0 && !loading && (
              <div
                style={{ paddingLeft: (depth + 1) * 12 + 22 }}
                className="py-1 text-xs text-ink-300"
              >
                empty
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const Icon = fileIcon(node.name);
  const active = activePath === node.path;
  return (
    <button
      onClick={() => onOpenFile(node.path)}
      style={pad}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition ${
        active
          ? "bg-brand-100 text-brand-800"
          : "text-ink-600 hover:bg-ink-100"
      }`}
    >
      <span className="w-[13px] shrink-0" />
      <Icon size={15} className="shrink-0 text-ink-400" />
      <span className="truncate">{node.name}</span>
      <span className="ml-auto shrink-0 pl-2 text-[10px] text-ink-300">
        {fmtSize(node.size)}
      </span>
    </button>
  );
}

type FileData =
  | { type: "markdown" | "text" | "csv"; content: string; path: string; ext: string }
  | { type: "image" | "binary"; url: string; path: string; ext: string; size: number }
  | { type: "toolarge"; path: string; size: number }
  | { type: "error"; error: string };

function CsvTable({ content }: { content: string }) {
  const rows = content
    .trim()
    .split(/\r?\n/)
    .slice(0, 500)
    .map((line) => {
      // naive CSV split (handles simple quoted cells)
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
  if (rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className="overflow-auto">
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
            <tr key={i} className={i % 2 ? "bg-ink-50" : ""}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className="border border-ink-200 px-2 py-1 text-ink-600"
                >
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

function Viewer({
  data,
  onNavigate,
}: {
  data: FileData;
  onNavigate: (path: string) => void;
}) {
  if (data.type === "error")
    return <div className="p-6 text-sm text-rose-600">{data.error}</div>;

  if (data.type === "toolarge")
    return (
      <div className="p-6 text-sm text-ink-500">
        File is {fmtSize(data.size)} — too large to preview inline.{" "}
        <a
          href={`/api/file?path=${encodeURIComponent(data.path)}&raw=1`}
          className="text-brand-600 underline"
          target="_blank"
          rel="noreferrer"
        >
          Download
        </a>
      </div>
    );

  if (data.type === "image")
    return (
      <div className="grid place-items-center p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={data.url}
          alt={data.path}
          className="max-h-full max-w-full rounded-lg border border-ink-200 shadow-sm"
        />
      </div>
    );

  if (data.type === "binary")
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-sm text-ink-500">
        <FileIcon size={40} className="text-ink-300" />
        <div>{data.path.split("/").pop()}</div>
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600"
        >
          <Download size={13} /> Open / Download ({fmtSize(data.size)})
        </a>
      </div>
    );

  if (data.type === "csv")
    return (
      <div className="p-5">
        <CsvTable content={data.content} />
      </div>
    );

  if (data.type === "markdown")
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Markdown linkBase={data.path} onNavigate={onNavigate}>
          {data.content}
        </Markdown>
      </div>
    );

  return (
    <pre className="whitespace-pre-wrap p-6 font-mono text-xs leading-relaxed text-ink-700">
      {"content" in data ? data.content : ""}
    </pre>
  );
}

export default function FileBrowser({ root }: { root: "wiki" | "raw" }) {
  const [tree, setTree] = useState<Node[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [data, setData] = useState<FileData | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    setTree(null);
    setActive(null);
    setData(null);
    fetch(`/api/tree?path=${encodeURIComponent(root)}`)
      .then((r) => r.json())
      .then((d) => setTree(d.nodes || []))
      .catch(() => setTree([]));
  }, [root]);

  const openFile = useCallback(async (path: string) => {
    setActive(path);
    setLoadingFile(true);
    setData(null);
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      if (d.error) setData({ type: "error", error: d.error });
      else setData(d);
    } catch (e: any) {
      setData({ type: "error", error: e?.message || "Failed to load file" });
    } finally {
      setLoadingFile(false);
    }
  }, []);

  return (
    <div className="flex h-full">
      {/* tree */}
      <div className="w-72 shrink-0 overflow-y-auto border-r border-ink-200 bg-white/60 p-2">
        <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          {root === "wiki" ? "Wiki — synthesized" : "Raw — source files"}
        </div>
        {tree === null ? (
          <div className="grid place-items-center py-10">
            <Loader2 size={16} className="animate-spin text-ink-300" />
          </div>
        ) : (
          tree.map((n) => (
            <TreeItem
              key={n.path}
              node={n}
              depth={0}
              onOpenFile={openFile}
              activePath={active}
            />
          ))
        )}
      </div>

      {/* viewer */}
      <div className="min-w-0 flex-1 overflow-y-auto bg-ink-50">
        {active && (
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-ink-200 bg-white/90 px-5 py-2 backdrop-blur">
            <FileText size={14} className="text-ink-400" />
            <span className="truncate font-mono text-xs text-ink-500">
              {active}
            </span>
            <a
              href={`/api/file?path=${encodeURIComponent(active)}&raw=1`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-ink-400 hover:text-brand-600"
              title="Open raw"
            >
              <Download size={14} />
            </a>
          </div>
        )}
        {loadingFile ? (
          <div className="grid h-full place-items-center">
            <Loader2 size={18} className="animate-spin text-ink-300" />
          </div>
        ) : data ? (
          <Viewer data={data} onNavigate={openFile} />
        ) : (
          <div className="grid h-full place-items-center text-sm text-ink-300">
            Select a file to view
          </div>
        )}
      </div>
    </div>
  );
}
