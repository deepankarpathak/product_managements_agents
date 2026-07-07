import fs from "node:fs/promises";
import path from "node:path";
import { safeResolveBrowse, isBinaryExt, isImageExt } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

const TEXT_MAX = 1_500_000; // ~1.5 MB cap on inline text

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rel = url.searchParams.get("path") || "";
  const raw = url.searchParams.get("raw") === "1";

  let abs: string;
  try {
    abs = safeResolveBrowse(rel);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 });
  }
  if (stat.isDirectory()) {
    return Response.json({ error: "Path is a directory" }, { status: 400 });
  }

  const ext = path.extname(abs).toLowerCase();

  // Raw byte serving (images, pdfs) for <img>/<embed> tags.
  if (raw) {
    const data = await fs.readFile(abs);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  if (isImageExt(ext)) {
    return Response.json({
      type: "image",
      path: rel,
      ext,
      size: stat.size,
      url: `/api/file?path=${encodeURIComponent(rel)}&raw=1`,
    });
  }

  if (isBinaryExt(ext)) {
    return Response.json({
      type: "binary",
      path: rel,
      ext,
      size: stat.size,
      url: `/api/file?path=${encodeURIComponent(rel)}&raw=1`,
    });
  }

  if (stat.size > TEXT_MAX) {
    return Response.json({
      type: "toolarge",
      path: rel,
      ext,
      size: stat.size,
    });
  }

  const content = await fs.readFile(abs, "utf8");
  const kind =
    ext === ".md" || ext === ".markdown"
      ? "markdown"
      : ext === ".csv"
        ? "csv"
        : "text";

  return Response.json({ type: kind, path: rel, ext, size: stat.size, content });
}
