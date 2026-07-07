"use client";

import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import CopyButton from "./CopyButton";

/**
 * A GFM table wrapped in a rounded, horizontally-scrollable card with a copy
 * button that exports the table as TSV (pastes cleanly into Sheets/Excel).
 */
function MdTable({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const toTSV = () => {
    const t = ref.current;
    if (!t) return "";
    return Array.from(t.rows)
      .map((r) =>
        Array.from(r.cells)
          .map((c) => (c.innerText || "").replace(/\s+/g, " ").trim())
          .join("\t")
      )
      .join("\n");
  };
  return (
    <div className="md-table-wrap">
      <CopyButton text={toTSV} className="md-table-copy" label="Copy" />
      <div className="md-table-scroll">
        <table ref={ref}>{children}</table>
      </div>
    </div>
  );
}

/** A fenced code block with a hover copy button. */
function MdPre({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <div className="md-pre-wrap">
      <CopyButton
        text={() => ref.current?.innerText || ""}
        className="md-pre-copy"
      />
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** True for links that should open externally rather than navigate in-app. */
function isExternal(href: string) {
  return /^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith("//");
}

/**
 * Resolve a relative markdown link (e.g. ../features/x.md) against the repo path
 * of the page it appears on (e.g. wiki/frameworks/delta-4.md) → wiki/features/x.md.
 * Anchors/queries are stripped. Returns null if there's nothing to resolve.
 */
function resolveRepoPath(base: string, href: string): string | null {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return null;
  const baseDir = base.includes("/")
    ? base.slice(0, base.lastIndexOf("/"))
    : "";
  const parts = clean.startsWith("/")
    ? clean.slice(1).split("/")
    : (baseDir ? baseDir.split("/") : []).concat(clean.split("/"));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/") || null;
}

export default function Markdown({
  children,
  linkBase,
  onNavigate,
}: {
  children: string;
  /** Repo path of the page being rendered, used to resolve relative links. */
  linkBase?: string;
  /** Open an internal repo link inside the host (e.g. the file browser). */
  onNavigate?: (repoPath: string) => void;
}) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ node, ...props }) => {
            const href = (props.href as string) || "";
            // Internal relative link + a host that can navigate → open in-app.
            if (
              onNavigate &&
              linkBase &&
              href &&
              !isExternal(href) &&
              !href.startsWith("#")
            ) {
              const target = resolveRepoPath(linkBase, href);
              if (target) {
                return (
                  <a
                    {...props}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(target);
                    }}
                  />
                );
              }
            }
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          },
          table: ({ node, ...props }) => <MdTable {...props} />,
          pre: ({ node, ...props }) => <MdPre {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
