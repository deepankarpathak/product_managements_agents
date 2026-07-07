import { jira, jiraErrorResponse } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issue types creatable in a project. GET ?project=KEY */
export async function GET(req: Request) {
  try {
    const project = new URL(req.url).searchParams.get("project");
    if (!project)
      return Response.json({ error: "project is required" }, { status: 400 });
    const r = await jira<any>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(
        project
      )}/issuetypes?maxResults=200`
    );
    const issueTypes = (r.issueTypes || r.values || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      subtask: !!t.subtask,
      iconUrl: t.iconUrl,
    }));
    return Response.json({ issueTypes });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
