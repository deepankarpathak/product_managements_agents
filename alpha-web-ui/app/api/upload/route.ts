import fs from "node:fs/promises";
import path from "node:path";
import { safeResolveUploadDir, fileExists } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Upload one or more files into a chosen folder under raw/.
 * Add-only: refuses to overwrite an existing file (honors "never edit raw/").
 *
 * multipart/form-data fields:
 *   dest  — destination folder, e.g. "raw/internal/uploads" or "internal/foo"
 *   file  — one or more files
 */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const dest = (form.get("dest") || "").toString().trim();
  if (!dest) {
    return Response.json({ error: "Missing destination folder" }, { status: 400 });
  }

  let absDir: string;
  try {
    absDir = safeResolveUploadDir(dest);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: "No files provided" }, { status: 400 });
  }

  try {
    await fs.mkdir(absDir, { recursive: true });
  } catch (e: any) {
    return Response.json({ error: `Cannot create folder: ${e.message}` }, { status: 500 });
  }

  const written: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    // Sanitize filename — strip any path components.
    const safeName = path.basename(file.name).replace(/[/\\]/g, "_");
    if (!safeName) continue;
    const target = path.join(absDir, safeName);

    if (fileExists(target)) {
      skipped.push(safeName);
      continue;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(target, new Uint8Array(buf));
    written.push(path.relative(absDir, target) || safeName);
  }

  return Response.json({
    ok: true,
    dest,
    written,
    skipped,
    message:
      `Saved ${written.length} file(s) to ${dest}.` +
      (skipped.length ? ` Skipped ${skipped.length} (already exist).` : ""),
  });
}
