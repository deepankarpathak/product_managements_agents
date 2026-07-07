import fs from "node:fs/promises";
import path from "node:path";
import { PROTOTYPES_ROOT } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let entries;
  try {
    entries = await fs.readdir(PROTOTYPES_ROOT, { withFileTypes: true });
  } catch {
    return Response.json({ prototypes: [] });
  }

  const protos = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.html?$/i.test(e.name)) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(path.join(PROTOTYPES_ROOT, e.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
    protos.push({ name: e.name, size, mtime });
  }
  protos.sort((a, b) => b.mtime - a.mtime);
  return Response.json({ prototypes: protos });
}
