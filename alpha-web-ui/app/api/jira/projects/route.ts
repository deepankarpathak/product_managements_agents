import { jira, jiraErrorResponse } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All projects the user can create in. GET ?query= to filter. */
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get("query") || "";
    const r = await jira<any>(
      `/rest/api/3/project/search?maxResults=100&orderBy=key${
        q ? `&query=${encodeURIComponent(q)}` : ""
      }`
    );
    const projects = (r.values || []).map((p: any) => ({
      id: p.id,
      key: p.key,
      name: p.name,
    }));
    return Response.json({ projects });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
