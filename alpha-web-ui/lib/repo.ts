import path from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * Absolute path to the UPI Alpha repo root.
 *
 * When `next dev` runs, cwd is the `web-ui/` folder, so the repo root is its
 * parent. Override with REPO_ROOT in .env.local if you run the server from
 * elsewhere. This is the directory the `claude` CLI is spawned in, so all
 * skills, CLAUDE.md, .mcp.json, trino, figma, wiki/ and raw/ resolve exactly
 * as they do in the terminal.
 */
export const REPO_ROOT = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(process.cwd(), "..");

/** Folders the file browser is allowed to read from. */
export const BROWSE_ROOTS: Record<string, string> = {
  wiki: path.join(REPO_ROOT, "wiki"),
  raw: path.join(REPO_ROOT, "raw"),
};

/** Folder uploads are confined to (add-only; never overwrites). */
export const UPLOAD_ROOT = path.join(REPO_ROOT, "raw");

/** The interactive design studio edits HTML prototypes here. */
export const PROTOTYPES_ROOT = path.join(REPO_ROOT, "prototypes");

/** Design reference screenshots land here (gitignored, off the KB). */
export const DESIGN_UPLOAD_ROOT = path.join(
  REPO_ROOT,
  "web-ui",
  ".design-uploads"
);

/**
 * Resolve a prototype file name (basename only, .html) to an absolute path
 * inside prototypes/. Rejects traversal and non-.html names.
 */
export function safeResolvePrototype(name: string): string {
  const base = path.basename((name || "").trim());
  if (!base || base !== name.trim() || !/\.html?$/i.test(base)) {
    throw new Error("Prototype must be a plain .html file name");
  }
  const abs = path.join(PROTOTYPES_ROOT, base);
  if (abs !== PROTOTYPES_ROOT && !abs.startsWith(PROTOTYPES_ROOT + path.sep)) {
    throw new Error("Prototype outside prototypes/");
  }
  return abs;
}

/**
 * Built dashboards/charts live here (resolved per-user, not hardcoded).
 * See the user preference: save all charts/dashboards to ~/Documents/Claude_Charts/.
 */
export const CHARTS_ROOT = path.join(os.homedir(), "Documents", "Claude_Charts");

/** Resolve a dashboard/chart file name (basename only), guarded to the charts dir. */
export function safeResolveChart(name: string): string {
  const base = path.basename((name || "").trim());
  const abs = path.join(CHARTS_ROOT, base);
  if (!abs.startsWith(CHARTS_ROOT + path.sep)) {
    throw new Error("Path outside charts directory");
  }
  return abs;
}

/** Resolve an uploaded design-reference image path, guarded to the upload dir. */
export function safeResolveDesignUpload(name: string): string {
  const base = path.basename((name || "").trim());
  const abs = path.join(DESIGN_UPLOAD_ROOT, base);
  if (!abs.startsWith(DESIGN_UPLOAD_ROOT + path.sep)) {
    throw new Error("Path outside design uploads");
  }
  return abs;
}

/**
 * Resolve a caller-supplied relative path (e.g. "wiki/apps/foo.md") to an
 * absolute path, guaranteeing it stays inside one of the allowed browse roots.
 * Throws on traversal attempts. Returns the absolute path.
 */
export function safeResolveBrowse(rel: string): string {
  const clean = (rel || "").replace(/^\/+/, "");
  const abs = path.resolve(REPO_ROOT, clean);
  const ok = Object.values(BROWSE_ROOTS).some(
    (root) => abs === root || abs.startsWith(root + path.sep)
  );
  if (!ok) {
    throw new Error("Path outside allowed roots (wiki/, raw/)");
  }
  return abs;
}

/**
 * Resolve an upload destination folder under raw/, guarding traversal.
 * Returns the absolute folder path.
 */
export function safeResolveUploadDir(relDir: string): string {
  const clean = (relDir || "").replace(/^\/+/, "").replace(/\/+$/, "");
  // Destination must be explicitly rooted at raw/ — no silent remapping.
  if (clean !== "raw" && !clean.startsWith("raw/")) {
    throw new Error("Upload destination must be inside raw/");
  }
  const abs = path.resolve(REPO_ROOT, clean);
  if (abs !== UPLOAD_ROOT && !abs.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error("Upload destination must be inside raw/");
  }
  return abs;
}

export function isBinaryExt(ext: string): boolean {
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".pdf", ".zip", ".xlsx", ".xls", ".docx", ".pptx", ".mp4",
    ".mov", ".mp3", ".wav", ".bin",
  ].includes(ext.toLowerCase());
}

export function isImageExt(ext: string): boolean {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"].includes(
    ext.toLowerCase()
  );
}

export function fileExists(abs: string): boolean {
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}
