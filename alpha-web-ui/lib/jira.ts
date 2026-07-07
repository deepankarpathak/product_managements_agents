import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Direct Jira Cloud REST access for the web-ui, using the token in the central
 * ~/Documents/.env.local (JIRA_URL / JIRA_EMAIL / JIRA_TOKEN). The hosted
 * Atlassian MCP is IP-blocked from outside the Paytm network, but the local
 * machine reaches Jira fine — so everything goes through REST here.
 */

const ENV_PATH =
  process.env.UPI_ENV_FILE ||
  path.join(os.homedir(), "Documents", ".env.local");

const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");

function creds() {
  loadEnv({ path: ENV_PATH, override: true });
  const url = unquote(process.env.JIRA_URL || "").replace(/\/$/, "");
  const email = unquote(process.env.JIRA_EMAIL || "");
  const token = unquote(process.env.JIRA_TOKEN || "");
  return { url, email, token };
}

export class JiraError extends Error {
  status?: number;
}

/** Authenticated Jira REST call. `path` starts with `/rest/...`. */
export async function jira<T = any>(
  apiPath: string,
  init?: RequestInit
): Promise<T> {
  const { url, email, token } = creds();
  if (!url || !email || !token) {
    const e = new JiraError(
      "Missing JIRA_URL / JIRA_EMAIL / JIRA_TOKEN in ~/Documents/.env.local"
    );
    e.status = 401;
    throw e;
  }
  const auth = Buffer.from(`${email}:${token}`).toString("base64");
  const res = await fetch(url + apiPath, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const body = await res.text();
  let data: any = null;
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = body;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object"
        ? data.errorMessages?.join("; ") ||
          Object.values(data.errors || {}).join("; ") ||
          data.message
        : null) ||
      (typeof data === "string" ? data : "") ||
      `Jira ${res.status}`;
    const e = new JiraError(msg);
    e.status = res.status;
    throw e;
  }
  return data as T;
}

export function jiraBaseUrl() {
  return creds().url;
}

/** Map a thrown error to a clean HTTP response for the routes. */
export function jiraErrorResponse(e: any): Response {
  const status = e instanceof JiraError && e.status ? e.status : 500;
  return Response.json(
    { error: e?.message || "Jira request failed", needsAuth: status === 401 },
    { status }
  );
}

/**
 * Minimal Markdown → Atlassian Document Format. Jira Cloud requires ADF for
 * rich-text fields (description, etc.). Handles headings, bullet/numbered
 * lists, blank-line paragraphs, and bold/italic/code inline marks — enough for
 * Claude-drafted descriptions to render cleanly.
 */
export function markdownToAdf(md: string) {
  const lines = (md || "").replace(/\r\n/g, "\n").split("\n");
  const content: any[] = [];
  let list: { type: string; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    content.push({
      type: list.type,
      content: list.items.map((t) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(t) }],
      })),
    });
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flushList();
      content.push({
        type: "heading",
        attrs: { level: Math.min(h[1].length, 6) },
        content: inline(h[2]),
      });
    } else if (bullet) {
      if (!list || list.type !== "bulletList") {
        flushList();
        list = { type: "bulletList", items: [] };
      }
      list.items.push(bullet[1]);
    } else if (ordered) {
      if (!list || list.type !== "orderedList") {
        flushList();
        list = { type: "orderedList", items: [] };
      }
      list.items.push(ordered[1]);
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      content.push({ type: "paragraph", content: inline(line) });
    }
  }
  flushList();
  if (content.length === 0)
    content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

/** Inline marks: **bold**, *italic*, `code`. */
function inline(text: string): any[] {
  const nodes: any[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last)
      nodes.push({ type: "text", text: text.slice(last, m.index) });
    if (m[2]) nodes.push({ type: "text", text: m[2], marks: [{ type: "strong" }] });
    else if (m[3]) nodes.push({ type: "text", text: m[3], marks: [{ type: "code" }] });
    else if (m[4]) nodes.push({ type: "text", text: m[4], marks: [{ type: "em" }] });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes.length ? nodes : [{ type: "text", text: text || " " }];
}
