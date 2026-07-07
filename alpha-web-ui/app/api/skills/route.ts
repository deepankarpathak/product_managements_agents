import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Skill = { name: string; description: string };

/**
 * Read the project's slash commands from .claude/commands/*.md so the UI can
 * render quick-action chips. The first non-empty, non-heading line (or the
 * heading text itself) is used as the description.
 */
export async function GET() {
  const dir = path.join(REPO_ROOT, ".claude", "commands");
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return Response.json({ skills: [] });
  }

  const skills: Skill[] = [];
  for (const f of files.sort()) {
    const name = f.replace(/\.md$/, "");
    let description = "";
    try {
      const text = await fs.readFile(path.join(dir, f), "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        // Skip a leading "# /name" heading; grab the first real prose line.
        const stripped = t.replace(/^#+\s*/, "").replace(/^\/?[\w-]+\s*[—-]?\s*/, "");
        if (stripped.length > 12) {
          description = stripped;
          break;
        }
      }
    } catch {
      /* ignore */
    }
    skills.push({ name, description });
  }

  return Response.json({ skills });
}
