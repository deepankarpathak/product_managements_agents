import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DESIGN_UPLOAD_ROOT,
  safeResolveDesignUpload,
  isImageExt,
} from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Upload design-reference screenshots. Returns names + absolute paths. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "No files provided" }, { status: 400 });
  }

  await fs.mkdir(DESIGN_UPLOAD_ROOT, { recursive: true });

  const saved = [];
  for (const file of files) {
    const ext = path.extname(file.name).toLowerCase();
    if (!isImageExt(ext)) continue;
    // Unique, sanitized name to avoid collisions.
    const base = path
      .basename(file.name, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 40);
    const name = `${base || "shot"}-${randomUUID().slice(0, 8)}${ext}`;
    const abs = path.join(DESIGN_UPLOAD_ROOT, name);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(abs, new Uint8Array(buf));
    saved.push({
      name,
      absPath: abs,
      url: `/api/design/upload?name=${encodeURIComponent(name)}`,
    });
  }

  if (saved.length === 0) {
    return Response.json(
      { error: "No valid image files (png/jpg/gif/webp)" },
      { status: 400 }
    );
  }
  return Response.json({ ok: true, files: saved });
}

/** Serve an uploaded screenshot for thumbnail preview. */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  let abs: string;
  try {
    abs = safeResolveDesignUpload(name);
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const ext = path.extname(abs).toLowerCase();
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
