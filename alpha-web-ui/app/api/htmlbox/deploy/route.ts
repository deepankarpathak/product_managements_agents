import { runHtmlbox, htmlboxErrorResponse } from "@/lib/htmlbox";
import { safeResolveChart, safeResolvePrototype } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Publish a generated HTML file to HTMLBox and return its shareable link.
 * Body: { source: "chart" | "prototype", name, displayName?, days? }
 * The path is resolved through the repo's safe resolvers — no arbitrary paths.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }

  const { source, name } = body;
  if (!name || (source !== "chart" && source !== "prototype")) {
    return Response.json(
      { error: "source ('chart'|'prototype') and name are required" },
      { status: 400 }
    );
  }

  let abs: string;
  try {
    abs = source === "chart" ? safeResolveChart(name) : safeResolvePrototype(name);
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 400 });
  }

  const args = ["publish", abs, "--json"];
  if (body.displayName) args.push("--name", String(body.displayName));
  if (body.days) args.push("--days", String(Number(body.days)));

  const r = await runHtmlbox(args);
  if (r.code !== 0) return htmlboxErrorResponse(r);

  try {
    const data = JSON.parse(r.out.trim().split("\n").pop() || "{}");
    return Response.json({
      url: data.url,
      slug: data.slug,
      name: data.name,
      expiresAt: data.expiresAt,
      expiryDays: data.expiryDays,
    });
  } catch {
    return Response.json(
      { error: "Could not parse htmlbox output", raw: r.out.slice(0, 600) },
      { status: 500 }
    );
  }
}
