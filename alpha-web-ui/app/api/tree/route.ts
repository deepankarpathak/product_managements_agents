import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT, BROWSE_ROOTS, safeResolveBrowse } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Node = {
  name: string;
  path: string; // relative to REPO_ROOT, forward slashes
  type: "dir" | "file";
  size?: number;
};

const IGNORE = new Set([".DS_Store", ".git", "__pycache__"]);

/**
 * Lazy one-level directory listing. Pass ?path=wiki or ?path=raw/internal.
 * With no path, returns the two top-level roots (wiki, raw).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rel = url.searchParams.get("path") || "";

  // Root listing → expose the allowed browse roots.
  if (!rel) {
    const roots: Node[] = Object.keys(BROWSE_ROOTS).map((name) => ({
      name,
      path: name,
      type: "dir",
    }));
    return Response.json({ path: "", nodes: roots });
  }

  let abs: string;
  try {
    abs = safeResolveBrowse(rel);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (e: any) {
    return Response.json({ error: `Cannot read directory: ${e.message}` }, { status: 404 });
  }

  const nodes: Node[] = [];
  for (const ent of entries) {
    if (IGNORE.has(ent.name) || ent.name.startsWith(".")) continue;
    const childRel = path.posix.join(rel, ent.name);
    if (ent.isDirectory()) {
      nodes.push({ name: ent.name, path: childRel, type: "dir" });
    } else if (ent.isFile()) {
      let size: number | undefined;
      try {
        size = (await fs.stat(path.join(REPO_ROOT, childRel))).size;
      } catch {
        /* ignore */
      }
      nodes.push({ name: ent.name, path: childRel, type: "file", size });
    }
  }

  // Dirs first, then files, both alphabetical.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return Response.json({ path: rel, nodes });
}
