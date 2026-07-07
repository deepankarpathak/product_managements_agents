import { jira, jiraErrorResponse } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?project=KEY            → boards for the project
 * GET ?board=ID&sprints=1     → active/future sprints for a board
 */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const board = u.searchParams.get("board");
    if (board && u.searchParams.get("sprints")) {
      const r = await jira<any>(
        `/rest/agile/1.0/board/${encodeURIComponent(
          board
        )}/sprint?state=active,future&maxResults=50`
      );
      const sprints = (r.values || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        state: s.state,
      }));
      return Response.json({ sprints });
    }

    const project = u.searchParams.get("project");
    if (!project)
      return Response.json({ error: "project is required" }, { status: 400 });
    const r = await jira<any>(
      `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(
        project
      )}&maxResults=50`
    );
    const boards = (r.values || []).map((b: any) => ({
      id: b.id,
      name: b.name,
      type: b.type,
    }));
    return Response.json({ boards });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
