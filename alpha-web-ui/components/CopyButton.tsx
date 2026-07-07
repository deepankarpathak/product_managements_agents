"use client";

import { Copy, Check } from "lucide-react";
import { useState } from "react";

/**
 * Small copy-to-clipboard button. `text` can be a string or a getter (so the
 * value is computed lazily at click time — e.g. reading a table's DOM as TSV).
 */
export default function CopyButton({
  text,
  label,
  className = "",
  size = 14,
}: {
  text: string | (() => string);
  label?: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const value = typeof text === "function" ? text() : text;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* noop */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : label || "Copy"}
      className={className}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
