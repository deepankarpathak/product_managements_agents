import { googleClients, googleErrorResponse } from "@/lib/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List/search Drive, or fetch one file's metadata.
 *   GET ?id=<fileId>                          → file metadata
 *   GET ?q=name contains 'budget'&limit=25    → matching files
 * Shared Drives are included.
 */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const { drive } = googleClients();
    const id = u.searchParams.get("id");

    if (id) {
      const meta = await drive.files.get({
        fileId: id,
        fields: "id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink",
        supportsAllDrives: true,
      });
      return Response.json({ file: meta.data });
    }

    const q = u.searchParams.get("q") || undefined;
    const limit = Math.min(Number(u.searchParams.get("limit") || "25"), 100);
    const r = await drive.files.list({
      q,
      pageSize: limit,
      fields:
        "files(id,name,mimeType,modifiedTime,size,webViewLink),nextPageToken",
      orderBy: "modifiedTime desc",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    return Response.json({
      files: r.data.files || [],
      nextPageToken: r.data.nextPageToken,
    });
  } catch (e) {
    return googleErrorResponse(e);
  }
}
