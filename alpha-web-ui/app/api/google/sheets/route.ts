import { googleClients, googleErrorResponse } from "@/lib/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read a spreadsheet.
 *   GET ?id=<spreadsheetId>&range=Sheet1!A1:Z1000   → values
 *   GET ?id=<spreadsheetId>&meta=1                   → title + tab list
 */
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id");
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const { sheets } = googleClients();

    if (u.searchParams.get("meta")) {
      const m = await sheets.spreadsheets.get({
        spreadsheetId: id,
        fields: "properties.title,sheets.properties(title,sheetId,gridProperties)",
      });
      return Response.json({
        title: m.data.properties?.title,
        sheets: (m.data.sheets || []).map((s) => s.properties),
      });
    }

    const range = u.searchParams.get("range") || "A1:Z1000";
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId: id,
      range,
    });
    return Response.json({ range: r.data.range, values: r.data.values || [] });
  } catch (e) {
    return googleErrorResponse(e);
  }
}

/**
 * Write to a spreadsheet. Body: { action, ... }
 *   create   { title, tabs?: string[] }
 *   append   { id, range, values: any[][], raw? }
 *   update   { id, range, values: any[][], raw? }
 *   addSheet { id, title }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { sheets } = googleClients();
    const valueInputOption = body.raw ? "RAW" : "USER_ENTERED";

    if (body.action === "create") {
      const r = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: body.title || "Untitled" },
          sheets: (body.tabs as string[] | undefined)?.map((t) => ({
            properties: { title: t },
          })),
        },
      });
      return Response.json({
        spreadsheetId: r.data.spreadsheetId,
        url: r.data.spreadsheetUrl,
      });
    }

    const id: string | undefined = body.id;
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });

    if (body.action === "append") {
      const r = await sheets.spreadsheets.values.append({
        spreadsheetId: id,
        range: body.range || "A1",
        valueInputOption,
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: body.values },
      });
      return Response.json({ updates: r.data.updates });
    }

    if (body.action === "update") {
      const r = await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: body.range,
        valueInputOption,
        requestBody: { values: body.values },
      });
      return Response.json({
        updatedRange: r.data.updatedRange,
        updatedCells: r.data.updatedCells,
      });
    }

    if (body.action === "addSheet") {
      const r = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: {
          requests: [{ addSheet: { properties: { title: body.title } } }],
        },
      });
      return Response.json({ replies: r.data.replies });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return googleErrorResponse(e);
  }
}
