import { getLearnCards } from "@/lib/learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the full mini-lesson card feed extracted from the wiki.
 * Cards are cached in-process for a minute (see lib/learn.ts), so this
 * stays cheap on repeat fetches but picks up wiki edits automatically.
 */
export async function GET() {
  try {
    const cards = getLearnCards();
    return Response.json({ count: cards.length, cards });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "Failed to build learn feed" },
      { status: 500 }
    );
  }
}
