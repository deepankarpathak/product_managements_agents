"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize,
  RefreshCw,
  ExternalLink,
  Send,
  ImagePlus,
  ImageUp,
  X,
  Loader2,
  Sparkles,
  Plus,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  FileCode2,
} from "lucide-react";
import DeployButton from "./DeployButton";

type Proto = { name: string; size: number; mtime: number };
type RefImg = { name: string; absPath: string; url: string };

// Prototypes are wide, viewport-filling design canvases (sidebar + centered
// device frames), so they only render correctly at full size — the only mode.
const DEVICES = [
  { id: "full", label: "Full", icon: Maximize },
] as const;

const MODELS = [
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.8" },
  { id: "haiku", label: "Haiku 4.5" },
];

type LogItem = { kind: string; text: string };

export default function DesignStudio() {
  const [protos, setProtos] = useState<Proto[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [device, setDevice] = useState<string>("full");
  const [reloadKey, setReloadKey] = useState(0);
  const [model, setModel] = useState("sonnet");
  const [showModels, setShowModels] = useState(false);

  const [instruction, setInstruction] = useState("");
  const [images, setImages] = useState<RefImg[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogItem[]>([]);
  const [creatingName, setCreatingName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async (selectName?: string) => {
    try {
      const r = await fetch("/api/prototype/list");
      const d = await r.json();
      const list: Proto[] = d.prototypes || [];
      setProtos(list);
      if (selectName) setSelected(selectName);
      else if (!selected && list.length) setSelected(list[0].name);
    } catch {
      setProtos([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const previewName = creatingName || selected;
  const iframeSrc = previewName
    ? `/api/prototype/view?name=${encodeURIComponent(previewName)}&v=${reloadKey}`
    : "";

  const addImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/design/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (d.files) setImages((prev) => [...prev, ...d.files]);
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  };

  const startNew = () => {
    const name = window.prompt(
      "New prototype file name (e.g. send-money.html):",
      "new-screen.html"
    );
    if (!name) return;
    const clean = /\.html?$/i.test(name) ? name : `${name}.html`;
    setCreatingName(clean);
    setLog([
      {
        kind: "status",
        text: `New prototype "${clean}" — describe the screen and/or add a reference screenshot, then Generate.`,
      },
    ]);
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  // Shared core: stream a design request and apply it.
  const runDesign = async (opts: {
    name: string;
    message: string;
    create: boolean;
    imagePaths: string[];
  }) => {
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          message: opts.message,
          model,
          create: opts.create,
          images: opts.imagePaths,
        }),
        signal: ac.signal,
      });
      if (!res.body) throw new Error("No stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          handleEvent(evt, opts.create, opts.name);
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError")
        setLog((l) => [...l, { kind: "error", text: err?.message || "Failed" }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const message = instruction.trim();
    if (!message || busy) return;
    const isCreate = !!creatingName;
    const name = creatingName || selected;
    if (!name) return;
    setLog((l) => [
      ...l,
      { kind: "user", text: message },
      { kind: "status", text: "Starting…" },
    ]);
    setInstruction("");
    await runDesign({
      name,
      message,
      create: isCreate,
      imagePaths: images.map((i) => i.absPath),
    });
  };

  // Direct flow: drop a screenshot → it replaces the current screen (no typing).
  const replaceWithScreenshot = async (files: FileList | null) => {
    if (busy || !files) return;
    const file = Array.from(files).find((f) => f.type.startsWith("image/"));
    if (replaceRef.current) replaceRef.current.value = "";
    if (!file) return;
    const name = creatingName || selected;
    if (!name) {
      setLog((l) => [
        ...l,
        { kind: "error", text: "Select or create a prototype first." },
      ]);
      return;
    }
    if (
      !window.confirm(
        `Replace the current screen with this screenshot?\nThis rewrites ${name} to match the image.`
      )
    )
      return;

    setBusy(true);
    setLog((l) => [
      ...l,
      { kind: "user", text: `Replace this screen with “${file.name}”` },
      { kind: "status", text: "Uploading screenshot…" },
    ]);

    let absPath = "";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/design/upload", { method: "POST", body: fd });
      const d = await r.json();
      absPath = d.files?.[0]?.absPath || "";
      if (!absPath) throw new Error(d.error || "upload failed");
      setImages((prev) => [...prev, ...(d.files || [])]);
    } catch (e: any) {
      setLog((l) => [
        ...l,
        { kind: "error", text: `Screenshot upload failed: ${e?.message || ""}` },
      ]);
      setBusy(false);
      return;
    }

    await runDesign({
      name,
      create: true, // build the screen fresh from the screenshot
      imagePaths: [absPath],
      message:
        "Recreate this screenshot as a complete, faithful, self-contained HTML screen that REPLACES the current screen entirely. Match the layout, spacing, colors, typography, and components as closely as possible. Make it polished, responsive, and pixel-faithful to the reference.",
    });
  };

  const handleEvent = (evt: any, isCreate: boolean, name: string) => {
    switch (evt.kind) {
      case "status":
        setLog((l) => [...l, { kind: "status", text: evt.text }]);
        break;
      case "tool":
        setLog((l) => [
          ...l,
          { kind: "tool", text: `Reading ${evt.name === "Read" ? "reference" : evt.name}…` },
        ]);
        break;
      case "updated":
        setLog((l) => [...l, { kind: "updated", text: "Prototype updated ✓" }]);
        setReloadKey((k) => k + 1);
        if (isCreate) {
          setCreatingName(null);
          loadList(name);
        }
        break;
      case "reply":
        setLog((l) => [...l, { kind: "reply", text: evt.text }]);
        break;
      case "error":
        setLog((l) => [...l, { kind: "error", text: evt.message }]);
        break;
      case "rate_limit":
        if (evt.info?.utilization >= 0.75)
          setLog((l) => [
            ...l,
            {
              kind: "status",
              text: `Usage at ${Math.round(evt.info.utilization * 100)}% of limit.`,
            },
          ]);
        break;
    }
  };

  return (
    <div className="flex h-full">
      {/* Preview */}
      <div className="flex min-w-0 flex-1 flex-col bg-ink-100">
        {/* toolbar */}
        <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-4 py-2">
          {/* prototype selector */}
          <div className="flex items-center gap-1.5">
            <FileCode2 size={15} className="text-ink-400" />
            <select
              value={creatingName ? "" : selected}
              disabled={!!creatingName}
              onChange={(e) => setSelected(e.target.value)}
              className="max-w-[200px] rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-ink-700 outline-none focus:border-brand-400 disabled:opacity-50"
            >
              {creatingName && <option value="">{creatingName} (new)</option>}
              {protos.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              onClick={startNew}
              title="New prototype"
              className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600"
            >
              <Plus size={15} />
            </button>
          </div>

          {/* Replace current screen directly from a screenshot */}
          <button
            onClick={() => replaceRef.current?.click()}
            disabled={busy || (!selected && !creatingName)}
            title="Upload a screenshot to replace the current screen"
            className="ml-1 flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ImageUp size={14} />
            Replace with screenshot
          </button>
          <input
            ref={replaceRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => replaceWithScreenshot(e.target.files)}
          />

          {/* device toggle */}
          <div className="ml-2 flex items-center gap-0.5 rounded-lg bg-ink-100 p-0.5">
            {DEVICES.map((d) => {
              const Icon = d.icon;
              return (
                <button
                  key={d.id}
                  onClick={() => setDevice(d.id)}
                  title={d.label}
                  className={`grid size-7 place-items-center rounded-md transition ${
                    device === d.id
                      ? "bg-white text-brand-600 shadow-sm"
                      : "text-ink-400 hover:text-ink-600"
                  }`}
                >
                  <Icon size={15} />
                </button>
              );
            })}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {previewName && (
              <DeployButton
                source="prototype"
                name={previewName}
                displayName={previewName}
              />
            )}
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload"
              className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-600"
            >
              <RefreshCw size={14} />
            </button>
            {previewName && (
              <a
                href={iframeSrc}
                target="_blank"
                rel="noreferrer"
                title="Open in new tab"
                className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-ink-600"
              >
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        </div>

        {/* stage */}
        <div className="grid flex-1 place-items-center overflow-hidden p-6">
          {iframeSrc ? (
            <iframe
              key={reloadKey}
              src={iframeSrc}
              className="h-full w-full rounded-xl border border-ink-200 bg-white shadow-sm"
            />
          ) : (
            <div className="text-sm text-ink-400">
              No prototype selected. Click + to create one.
            </div>
          )}
        </div>
      </div>

      {/* Chat panel */}
      <div className="flex w-[360px] shrink-0 flex-col border-l border-ink-200 bg-white">
        <div className="flex items-center gap-2 border-b border-ink-200 px-4 py-3">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-fuchsia-400 to-purple-600 text-white">
            <Sparkles size={15} />
          </span>
          <div>
            <div className="text-sm font-semibold text-ink-900">
              Design Studio
            </div>
            <div className="text-[11px] text-ink-400">
              Edit by chat · local Claude · no API key
            </div>
          </div>
        </div>

        {/* log */}
        <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto p-3">
          {log.length === 0 && (
            <div className="px-1 pt-2 text-xs leading-relaxed text-ink-400">
              Describe a change in plain English — e.g.{" "}
              <span className="text-ink-600">
                “make the primary button bigger and blue”
              </span>{" "}
              — or drop a screenshot and ask to match it. Click{" "}
              <Plus size={11} className="inline" /> to build a new screen from a
              screenshot.
            </div>
          )}
          {log.map((item, i) => (
            <LogRow key={i} item={item} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 px-1 text-xs text-brand-600">
              <Loader2 size={13} className="animate-spin" /> Working…
            </div>
          )}
        </div>

        {/* image thumbnails */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-ink-100 p-2">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt=""
                  className="size-12 rounded-lg border border-ink-200 object-cover"
                />
                <button
                  onClick={() =>
                    setImages((prev) => prev.filter((_, idx) => idx !== i))
                  }
                  className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-ink-800 text-white opacity-0 transition group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
            {uploading && (
              <div className="grid size-12 place-items-center rounded-lg border border-dashed border-ink-200">
                <Loader2 size={14} className="animate-spin text-ink-300" />
              </div>
            )}
          </div>
        )}

        {/* composer */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addImages(e.dataTransfer.files);
          }}
          className={`border-t p-3 ${dragOver ? "bg-brand-50" : "border-ink-200"}`}
        >
          <div className="flex items-end gap-2 rounded-xl border border-ink-200 bg-white p-1.5 focus-within:border-brand-400">
            <button
              onClick={() => fileRef.current?.click()}
              title="Add screenshot"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100 hover:text-brand-600"
            >
              <ImagePlus size={17} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => addImages(e.target.files)}
            />
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={
                creatingName ? "Describe the new screen…" : "Describe a change…"
              }
              className="max-h-32 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-ink-300"
            />
            {busy ? (
              <button
                onClick={stop}
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-ink-800 text-white"
              >
                <Loader2 size={14} className="animate-spin" />
              </button>
            ) : (
              <button
                onClick={send}
                disabled={!instruction.trim()}
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-500 text-white transition hover:bg-brand-600 disabled:opacity-40"
              >
                <Send size={15} />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1">
            <span className="text-[10px] text-ink-400">
              {creatingName ? "Generate new screen" : "Edits the live file"}
            </span>
            <div className="relative">
              <button
                onClick={() => setShowModels((s) => !s)}
                className="flex items-center gap-0.5 text-[10px] font-semibold text-ink-500 hover:text-ink-700"
              >
                {MODELS.find((m) => m.id === model)?.label}
                <ChevronDown size={11} />
              </button>
              {showModels && (
                <div className="absolute bottom-5 right-0 z-10 w-32 overflow-hidden rounded-lg border border-ink-200 bg-white shadow-lg">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        setModel(m.id);
                        setShowModels(false);
                      }}
                      className={`block w-full px-3 py-1.5 text-left text-[11px] hover:bg-ink-50 ${
                        model === m.id ? "bg-brand-50 font-semibold" : ""
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LogRow({ item }: { item: LogItem }) {
  if (item.kind === "user")
    return (
      <div className="ml-auto w-fit max-w-[90%] rounded-xl rounded-tr-sm bg-brand-500 px-3 py-1.5 text-xs text-white">
        {item.text}
      </div>
    );
  if (item.kind === "updated")
    return (
      <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-700">
        <CheckCircle2 size={13} /> {item.text}
      </div>
    );
  if (item.kind === "error")
    return (
      <div className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        <span className="whitespace-pre-wrap">{item.text}</span>
      </div>
    );
  if (item.kind === "reply")
    return (
      <div className="rounded-lg bg-ink-50 px-2.5 py-1.5 text-xs text-ink-700 whitespace-pre-wrap">
        {item.text}
      </div>
    );
  if (item.kind === "tool")
    return (
      <div className="px-1 text-[11px] italic text-ink-400">{item.text}</div>
    );
  return <div className="px-1 text-[11px] text-ink-400">{item.text}</div>;
}
