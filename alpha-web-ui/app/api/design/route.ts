import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT, safeResolvePrototype } from "@/lib/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const ALLOWED_MODELS = new Set(["opus", "sonnet", "haiku"]);

// PODS CSS custom properties — real Paytm palette and spacing tokens.
// Claude should use var(--token-name) instead of raw hex/px.
const PODS_CSS = `
  /* PODS surface */
  --surface-level-1: #ffffff;
  --surface-level-3: #fafafa;
  --surface-level-4: #f5f5f5;

  /* PODS text */
  --text-neutral-strong: #282828;
  --text-neutral-moderate: #414244;
  --text-neutral-medium: #7e7e7e;
  --text-neutral-weak: #cacaca;
  --text-neutral-inverse: #ffffff;
  --text-primary-strong: #004299;
  --text-primary-medium: #1576db;
  --text-positive-strong: #158939;
  --text-negative-strong: #e12e3a;
  --text-notice-strong: #ffa905;

  /* PODS background */
  --background-primary-strong: #004299;
  --background-primary-medium: #1576db;
  --background-primary-weak: #dfedff;
  --background-positive-strong: #158939;
  --background-positive-weak: #dbf0e2;
  --background-negative-strong: #e12e3a;
  --background-negative-weak: #ffd1d1;
  --background-notice-strong: #ffa905;
  --background-notice-weak: #fff2cc;
  --background-neutral-inverse: #ffffff;

  /* PODS border */
  --border-neutral-weak: #ebebeb;
  --border-neutral-medium: #7e7e7e;
  --border-primary-medium: #1576db;

  /* PODS icon */
  --icon-primary-medium: #1576db;
  --icon-neutral-strong: #282828;
  --icon-neutral-medium: #7e7e7e;

  /* PODS brand */
  --brand-primary: #00b8f5;

  /* PODS spacing (gap scale) */
  --gap-m: 4px;
  --gap-l: 6px;
  --gap-xl: 8px;
  --gap-2xl: 12px;
  --gap-3xl: 16px;
  --gap-4xl: 24px;
  --gap-5xl: 32px;

  /* PODS radius */
  --radius-m: 8px;
  --radius-l: 12px;
  --radius-xl: 16px;
  --radius-2xl: 20px;
  --radius-3xl: 24px;
  --radius-max: 64px;

  /* PODS page gutter */
  --page-gutter: 12px;
`;

const SKELETON = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>New Prototype</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
:root {${PODS_CSS}}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--surface-level-4);
  color: var(--text-neutral-strong);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 20px;
}
.phone-frame {
  width: 390px;
  min-height: 844px;
  margin: 0 auto;
  background: var(--surface-level-4);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.pods-card {
  background: var(--surface-level-1);
  border-radius: var(--radius-3xl);
  padding: var(--gap-3xl);
}
.btn-primary {
  background: var(--background-primary-medium);
  color: var(--text-neutral-inverse);
  border: none;
  border-radius: var(--radius-max);
  padding: 14px 24px;
  font-size: 16px;
  font-weight: 600;
  width: 100%;
  cursor: pointer;
}
.btn-outline {
  background: transparent;
  color: var(--text-primary-medium);
  border: 1.5px solid var(--border-primary-medium);
  border-radius: var(--radius-max);
  padding: 14px 24px;
  font-size: 16px;
  font-weight: 600;
  width: 100%;
  cursor: pointer;
}
</style>
</head>
<body>
<div class="phone-frame"></div>
</body>
</html>`;

// Lazy-load the PODS layout distillation once per server lifetime.
let _podsCtxCache: string | null = null;
async function getPodsContext(): Promise<string> {
  if (_podsCtxCache !== null) return _podsCtxCache;
  try {
    const p = path.join(REPO_ROOT, "design-context", "pods", "layout-distilled.md");
    _podsCtxCache = await fs.readFile(p, "utf8");
  } catch {
    _podsCtxCache = "";
  }
  return _podsCtxCache;
}

function buildPrompt(opts: {
  html: string;
  message: string;
  images: string[];
  create: boolean;
  podsCtx: string;
}): string {
  const { html, message, images, create, podsCtx } = opts;
  const imgBlock = images.length
    ? `\nReference screenshot(s) are saved at these absolute paths. Use the Read tool to VIEW each image before you design, and match its layout, spacing, colors, and components closely:\n${images
        .map((p) => `- ${p}`)
        .join("\n")}\n`
    : "";

  const intent = create
    ? `Build a complete, polished, self-contained HTML prototype for the Paytm UPI app based on the instruction and any reference screenshots.`
    : `Apply ONLY the requested change to the existing prototype and nothing else. Preserve all existing structure, styling, and interactivity.`;

  const designCtx = podsCtx
    ? `\n## Paytm PODS Design System Rules\n${podsCtx}\n`
    : "";

  return `You are an expert UI engineer and product designer for the Paytm UPI app.
${designCtx}
${intent}

CRITICAL STYLING RULES:
- The SKELETON already has PODS CSS custom properties in :root. Use var(--token-name) for ALL colors, spacing, and radius — never raw hex or px values.
- Key tokens: var(--background-primary-medium)=#1576db (Paytm blue CTA), var(--surface-level-1)=#ffffff (card bg), var(--surface-level-4)=#f5f5f5 (page wash), var(--text-neutral-strong)=#282828 (body text).
- Phone frame: wrap all content in <div class="phone-frame"> (390px wide).
- Cards: use class="pods-card" (white, 24px radius, 16px padding).
- CTAs: one primary <button class="btn-primary">, secondary as btn-outline.
- Use Tailwind utilities for flex/grid layout where helpful.
${imgBlock}
Return the COMPLETE final HTML inside a single \`\`\`html ... \`\`\` code fence, with NO prose outside the fence.
If the instruction is a question rather than a design change, answer briefly in plain text instead (no fence).

Current HTML:
\`\`\`html
${html}
\`\`\`

Instruction: ${message}`;
}

function extractHtml(text: string): string | null {
  // Last fenced html block wins (the final, complete version).
  const re = /```html\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last ? last.trim() : null;
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const message: string = (body.message || "").toString().trim();
  if (!message) return new Response("Empty message", { status: 400 });

  const create = !!body.create;
  const model = ALLOWED_MODELS.has(body.model) ? body.model : "sonnet";
  const images: string[] = Array.isArray(body.images)
    ? body.images.filter((s: any) => typeof s === "string").slice(0, 6)
    : [];

  let absProto: string;
  try {
    absProto = safeResolvePrototype(body.name || "");
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }

  let currentHtml = SKELETON;
  if (!create) {
    try {
      currentHtml = await fs.readFile(absProto, "utf8");
    } catch {
      // editing a non-existent file → treat as create
    }
  }

  const podsCtx = await getPodsContext();
  const prompt = buildPrompt({ html: currentHtml, message, images, create, podsCtx });

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    // Headless: AskUserQuestion has no surface here and would be auto-dismissed.
    "--disallowedTools",
    "AskUserQuestion",
    "--model",
    model,
  ];

  const child = spawn("claude", args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const encoder = new TextEncoder();
  let finalText = "";
  let accAssistant = "";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (o: any) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
      };
      const close = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {}
        }
      };

      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "system" && evt.subtype === "init") {
            send({ kind: "status", text: "Designing…" });
          } else if (evt.type === "rate_limit_event") {
            send({ kind: "rate_limit", info: evt.rate_limit_info });
          } else if (evt.type === "assistant") {
            for (const b of evt.message?.content || []) {
              if (b.type === "tool_use")
                send({ kind: "tool", name: b.name });
              if (b.type === "text") accAssistant += b.text;
            }
          } else if (evt.type === "result") {
            finalText = evt.result || accAssistant;
          }
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (d: Buffer) => {
        stderrBuf += d.toString("utf8");
      });

      child.on("error", (err) => {
        send({ kind: "error", message: `Failed to start claude: ${err.message}` });
        close();
      });

      child.on("close", async (code) => {
        const source = finalText || accAssistant;
        const html = extractHtml(source);
        if (html) {
          try {
            await fs.writeFile(absProto, html, "utf8");
            send({ kind: "updated", message: "Prototype updated." });
          } catch (e: any) {
            send({ kind: "error", message: `Could not write prototype: ${e.message}` });
          }
        } else if (source.trim()) {
          // Claude answered conversationally rather than editing.
          send({ kind: "reply", text: source.trim().slice(0, 4000) });
        } else if (code && code !== 0) {
          send({ kind: "error", message: stderrBuf.trim().slice(0, 1500) || `claude exited ${code}` });
        } else {
          send({ kind: "error", message: "No HTML returned." });
        }
        send({ kind: "done" });
        close();
      });

      req.signal.addEventListener("abort", () => {
        try {
          child.kill("SIGTERM");
        } catch {}
        close();
      });
    },
    cancel() {
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
