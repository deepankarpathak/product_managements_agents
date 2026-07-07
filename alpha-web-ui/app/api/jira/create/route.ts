import { jira, jiraBaseUrl, jiraErrorResponse, markdownToAdf } from "@/lib/jira";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Create an issue. Body:
 *   { projectKey, issueTypeId, summary, descriptionMarkdown?, fields }
 * `fields` is already shaped for Jira by the form (e.g. priority:{id},
 * components:[{id}], customfield_x:{id} | [..] | "YYYY-MM-DD" | number).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { projectKey, issueTypeId, summary } = body;
    if (!projectKey || !issueTypeId || !summary) {
      return Response.json(
        { error: "projectKey, issueTypeId and summary are required" },
        { status: 400 }
      );
    }

    const fields: Record<string, any> = {
      ...(body.fields || {}),
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
    };
    if (body.descriptionMarkdown) {
      fields.description = markdownToAdf(body.descriptionMarkdown);
    }

    const r = await jira<any>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });

    return Response.json({
      key: r.key,
      id: r.id,
      url: `${jiraBaseUrl()}/browse/${r.key}`,
    });
  } catch (e) {
    return jiraErrorResponse(e);
  }
}
