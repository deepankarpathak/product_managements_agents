import { spawn } from "node:child_process";
import { REPO_ROOT } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);

/**
 * Draft a Jira Description (markdown) with the local Claude, grounded in the
 * repo's wiki/SOP. One-shot (non-streaming): returns the description text.
 * Body: { summary, projectKey, issueType, notes?, model? }
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const summary = (body.summary || "").toString().trim();
  if (!summary) return Response.json({ error: "summary is required" }, { status: 400 });
  const model = ALLOWED_MODELS.has(body.model) ? body.model : "sonnet";

  const prompt = [
    "Write ONLY a Jira issue Description in GitHub-flavoured Markdown — no preamble, no surrounding commentary, output the description body only.",
    "Follow the Paytm Jira draft shape with these sections (omit a section only if truly not applicable):",
    "## Context / Why Now\n## Scope\n## Out Of Scope\n## Acceptance Criteria\n## Metrics / Guardrails\n## Risks / Rollback\n## Related",
    "Ground it in the UPI Alpha wiki/raw sources and the Paytm Jira SOP where relevant. Keep it tight and buildable. Mark unverified rationale as [unverified] rather than inventing it.",
    "",
    `Project: ${body.projectKey || "(unspecified)"}`,
    `Issue type: ${body.issueType || "(unspecified)"}`,
    `Summary: ${summary}`,
    body.notes ? `Author notes / context:\n${body.notes}` : "",
  ].join("\n");

  const args = [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    "--disallowedTools",
    "AskUserQuestion",
    "--model",
    model,
  ];

  return await new Promise<Response>((resolve) => {
    const child = spawn("claude", args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (e) =>
      resolve(Response.json({ error: `Failed to start claude: ${e.message}` }, { status: 500 }))
    );
    child.on("close", (code) => {
      if (code && code !== 0)
        return resolve(
          Response.json({ error: err.trim().slice(0, 800) || `claude exited ${code}` }, { status: 500 })
        );
      resolve(Response.json({ description: out.trim() }));
    });
    req.signal.addEventListener("abort", () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    });
  });
}
