import { spawn } from "node:child_process";

/**
 * Thin wrapper around the local `htmlbox` CLI (Paytm's internal HTML host).
 * The CLI handles auth (`htmlbox login`, browser flow) and publishing; we just
 * invoke it. Install: `npm install -g htmlbox-cli`.
 */
export function runHtmlbox(
  args: string[],
  timeoutMs = 60000
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("htmlbox", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }, timeoutMs);
    child.on("error", (e: any) =>
      resolve({ code: e?.code === "ENOENT" ? 127 : 1, out, err: e.message })
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** Classify a CLI failure so routes can guide the user. */
export function htmlboxErrorResponse(r: {
  code: number | null;
  out: string;
  err: string;
}): Response {
  const text = (r.err + r.out).toLowerCase();
  if (r.code === 127 || text.includes("command not found")) {
    return Response.json(
      {
        error:
          "HTMLBox CLI not installed. Run: npm install -g htmlbox-cli && htmlbox login",
        needsInstall: true,
      },
      { status: 503 }
    );
  }
  if (text.includes("not logged in") || text.includes("session expired")) {
    return Response.json(
      { error: "Not logged in to HTMLBox. Run: htmlbox login", needsAuth: true },
      { status: 401 }
    );
  }
  if (
    text.includes("permission_denied") ||
    text.includes("insufficient permissions") ||
    text.includes("403")
  ) {
    return Response.json(
      {
        error:
          "HTMLBox denied the publish (permission). Re-run `htmlbox login` to refresh your session; if it persists, your account may need publish access.",
        needsAuth: true,
      },
      { status: 403 }
    );
  }
  return Response.json(
    { error: (r.err || r.out || "htmlbox failed").trim().slice(0, 600) },
    { status: 500 }
  );
}
