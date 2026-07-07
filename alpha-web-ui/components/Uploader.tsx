"use client";

import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  UploadCloud,
  Loader2,
  CheckCircle2,
  X,
  File as FileIcon,
} from "lucide-react";

type Node = { name: string; path: string; type: "dir" | "file" };

function DirNode({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: Node;
  depth: number;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const [children, setChildren] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (children) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/tree?path=${encodeURIComponent(node.path)}`);
      const d = await r.json();
      setChildren((d.nodes || []).filter((n: Node) => n.type === "dir"));
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const active = selected === node.path;
  return (
    <div>
      <div
        style={{ paddingLeft: depth * 14 + 6 }}
        className={`flex items-center gap-1 rounded-md py-1 pr-2 ${
          active ? "bg-brand-100" : "hover:bg-ink-100"
        }`}
      >
        <button
          onClick={() => setOpen((o) => !o)}
          className="grid size-4 place-items-center text-ink-400"
        >
          <ChevronRight
            size={13}
            className={`transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>
        <button
          onClick={() => onSelect(node.path)}
          className="flex flex-1 items-center gap-1.5 text-left text-sm"
        >
          {open ? (
            <FolderOpen size={15} className="text-brand-500" />
          ) : (
            <Folder size={15} className="text-brand-500" />
          )}
          <span className={active ? "font-semibold text-brand-800" : "text-ink-700"}>
            {node.name}
          </span>
        </button>
      </div>
      {open && (
        <div>
          {loading && (
            <div style={{ paddingLeft: (depth + 1) * 14 + 20 }} className="py-1">
              <Loader2 size={12} className="animate-spin text-ink-300" />
            </div>
          )}
          {children?.map((c) => (
            <DirNode
              key={c.path}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Uploader() {
  const [dest, setDest] = useState("raw");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list)]);
    setResult(null);
    setError(null);
  };

  const removeFile = (i: number) =>
    setFiles((f) => f.filter((_, idx) => idx !== i));

  const upload = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.append("dest", dest);
    files.forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok || d.error) setError(d.error || "Upload failed");
      else {
        setResult(d.message);
        setFiles([]);
      }
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-ink-900">
          Upload raw source files
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          New files are added under{" "}
          <code className="rounded bg-ink-100 px-1 text-xs">raw/</code> — never
          overwriting existing sources. After uploading, ask in chat to compile
          them into the wiki.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* destination picker */}
        <div className="rounded-2xl border border-ink-200 bg-white p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
            1 · Choose destination
          </div>
          <div className="mb-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
            <span className="text-ink-400">Saving to:</span>{" "}
            <span className="font-mono font-semibold">{dest}/</span>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-100 p-1">
            <DirNode
              node={{ name: "raw", path: "raw", type: "dir" }}
              depth={0}
              selected={dest}
              onSelect={setDest}
            />
          </div>
        </div>

        {/* dropzone */}
        <div className="rounded-2xl border border-ink-200 bg-white p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">
            2 · Add files
          </div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            className={`grid cursor-pointer place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
              dragOver
                ? "border-brand-400 bg-brand-50"
                : "border-ink-200 hover:border-brand-300 hover:bg-ink-50"
            }`}
          >
            <UploadCloud size={28} className="text-brand-400" />
            <div className="text-sm text-ink-600">
              Drag & drop, or{" "}
              <span className="font-semibold text-brand-600">browse</span>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
            />
          </div>

          {files.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg bg-ink-50 px-2.5 py-1.5 text-xs"
                >
                  <FileIcon size={13} className="text-ink-400" />
                  <span className="truncate text-ink-700">{f.name}</span>
                  <span className="ml-auto text-ink-300">
                    {(f.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    onClick={() => removeFile(i)}
                    className="text-ink-400 hover:text-rose-500"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={upload}
          disabled={files.length === 0 || busy}
          className="flex items-center gap-2 rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <UploadCloud size={15} />
          )}
          Upload {files.length > 0 ? `${files.length} file(s)` : ""}
        </button>
        {result && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600">
            <CheckCircle2 size={15} /> {result}
          </span>
        )}
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>
    </div>
  );
}
