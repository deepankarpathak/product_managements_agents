import fs from "node:fs/promises";
import { safeResolvePrototype } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serve a prototype's raw HTML for the studio iframe. */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") || "";
  let abs: string;
  try {
    abs = safeResolvePrototype(name);
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }
  let html: string;
  try {
    html = await fs.readFile(abs, "utf8");
  } catch {
    return new Response("Prototype not found", { status: 404 });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
