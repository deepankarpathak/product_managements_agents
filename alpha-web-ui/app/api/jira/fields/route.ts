import { jira, jiraErrorResponse } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The full create-field schema for a project + issue type — required flags and
 * allowed values included. GET ?project=KEY&issueType=ID
 */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const project = u.searchParams.get("project");
    const issueType = u.searchParams.get("issueType");
    if (!project || !issueType)
      return Response.json(
        { error: "project and issueType are required" },
        { status: 400 }
      );

    const r = await jira<any>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(
        project
      )}/issuetypes/${encodeURIComponent(issueType)}?maxResults=200`
    );

    const fields = (r.fields || r.values || []).map((f: any) => ({
      fieldId: f.fieldId,
      name: f.name,
      required: !!f.required,
      // schema type drives which input the form renders
      type: f.schema?.type,
      items: f.schema?.items,
      custom: f.schema?.custom,
      hasDefault: f.hasDefaultValue,
      allowedValues: (f.allowedValues || []).map((a: any) => ({
        id: a.id,
        // selects expose the label under different keys depending on field
        label: a.value ?? a.name ?? a.label ?? a.key ?? a.id,
      })),
    }));

    return Response.json({ fields });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
