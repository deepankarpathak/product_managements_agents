import { jira, jiraErrorResponse } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Assignable users for a project. GET ?project=KEY&query=na */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const project = u.searchParams.get("project");
    const query = u.searchParams.get("query") || "";
    if (!project)
      return Response.json({ error: "project is required" }, { status: 400 });
    const r = await jira<any[]>(
      `/rest/api/3/user/assignable/search?project=${encodeURIComponent(
        project
      )}&query=${encodeURIComponent(query)}&maxResults=20`
    );
    const users = (r || []).map((p: any) => ({
      accountId: p.accountId,
      displayName: p.displayName,
      email: p.emailAddress,
    }));
    return Response.json({ users });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
