import { googleClients, googleErrorResponse } from "@/lib/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether Google is connected, and as whom. */
export async function GET() {
  try {
    const { drive } = googleClients();
    const r = await drive.about.get({
      fields: "user(displayName,emailAddress)",
    });
    return Response.json({ connected: true, user: r.data.user });
  } catch (e) {
    return googleErrorResponse(e);
  }
}
