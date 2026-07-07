"use client";

import { useState } from "react";
import {
  ChevronRight,
  Terminal,
  FileText,
  Search,
  Globe,
  Database,
  Sparkles,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

export type ToolCall = {
  id: string;
  name: string;
  input: any;
  result?: string;
  isError?: boolean;
  done: boolean;
};

function iconFor(name: string) {
  const n = name.toLowerCase();
  if (n === "bash") return Terminal;
  if (n === "read" || n === "write" || n === "edit") return FileText;
  if (n === "grep" || n === "glob") return Search;
  if (n.includes("web")) return Globe;
  if (n.includes("trino") || n.includes("sql") || n.includes("query"))
    return Database;
  if (n === "skill" || n === "task") return Sparkles;
  return Wrench;
}

function summarize(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const n = name.toLowerCase();
  if (n === "bash") return input.command || "";
  if (n === "read" || n === "write" || n === "edit")
    return input.file_path || input.path || "";
  if (n === "grep" || n === "glob")
    return input.pattern || input.query || "";
  if (n === "skill") return input.command || input.skill || "";
  if (n === "task") return input.description || "";
  if (n.includes("web")) return input.url || input.query || "";
  const firstStr = Object.values(input).find((v) => typeof v === "string");
  return (firstStr as string) || JSON.stringify(input).slice(0, 120);
}

export default function ToolCard({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = iconFor(tool.name);
  const summary = summarize(tool.name, tool.input);

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-ink-200 bg-white/70 shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-ink-50"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-ink-400 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-50 text-brand-600">
          <Icon size={14} />
        </span>
        <span className="text-sm font-semibold text-ink-700">{tool.name}</span>
        {summary && (
          <span className="truncate font-mono text-xs text-ink-400">
            {summary}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {!tool.done ? (
            <Loader2 size={14} className="animate-spin text-brand-500" />
          ) : tool.isError ? (
            <XCircle size={14} className="text-rose-500" />
          ) : (
            <CheckCircle2 size={14} className="text-emerald-500" />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-100 bg-ink-50/60 px-3 py-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
            Input
          </div>
          <pre className="mb-2 max-h-48 overflow-auto rounded-lg bg-ink-900 p-2.5 font-mono text-[11px] leading-relaxed text-ink-100">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
          {tool.done && tool.result !== undefined && (
            <>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                Result
              </div>
              <pre
                className={`max-h-64 overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed ${
                  tool.isError
                    ? "bg-rose-50 text-rose-700"
                    : "bg-white text-ink-700"
                }`}
              >
                {tool.result || "(no output)"}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
