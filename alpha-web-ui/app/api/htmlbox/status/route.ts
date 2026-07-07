import { runHtmlbox } from "@/lib/htmlbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Is the HTMLBox CLI installed, and is the user logged in? */
export async function GET() {
  const ver = await runHtmlbox(["--version"], 10000);
  if (ver.code === 127) {
    return Response.json({ installed: false, loggedIn: false });
  }
  const who = await runHtmlbox(["whoami"], 10000);
  const loggedIn =
    who.code === 0 && !/not logged in|expired/i.test(who.err + who.out);
  return Response.json({
    installed: true,
    version: ver.out.trim(),
    loggedIn,
    user: loggedIn ? who.out.trim() : null,
  });
}
