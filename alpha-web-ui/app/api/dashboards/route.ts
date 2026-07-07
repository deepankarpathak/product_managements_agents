import fs from "node:fs/promises";
import path from "node:path";
import { CHARTS_ROOT, safeResolveChart } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

function kindFor(ext: string): "image" | "html" | "csv" | "markdown" | "other" {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return "image";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".csv") return "csv";
  if (ext === ".md") return "markdown";
  return "other";
}

/**
 * GET            → list dashboards/charts in ~/Documents/Claude_Charts.
 * GET ?name=&raw=1 → serve the raw file (image / html iframe).
 * GET ?name=&text=1 → return text content (csv/md) as JSON.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get("name");
  const raw = url.searchParams.get("raw") === "1";
  const text = url.searchParams.get("text") === "1";

  if (name) {
    let abs: string;
    try {
      abs = safeResolveChart(name);
    } catch (e: any) {
      return new Response(e.message, { status: 400 });
    }
    const ext = path.extname(abs).toLowerCase();
    if (text) {
      try {
        const content = await fs.readFile(abs, "utf8");
        return Response.json({ name, content: content.slice(0, 1_000_000) });
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }
    let data: Buffer;
    try {
      data = await fs.readFile(abs);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  // Listing
  let entries;
  try {
    entries = await fs.readdir(CHARTS_ROOT, { withFileTypes: true });
  } catch {
    return Response.json({ available: false, items: [] });
  }

  const items = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".")) continue;
    const ext = path.extname(e.name).toLowerCase();
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(path.join(CHARTS_ROOT, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
    items.push({
      name: e.name,
      kind: kindFor(ext),
      ext,
      size,
      mtime,
      url: `/api/dashboards?name=${encodeURIComponent(e.name)}&raw=1`,
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return Response.json({ available: true, dir: CHARTS_ROOT, items });
}
