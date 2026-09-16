import { db } from "../../../lib/db.js";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sql = db();
    const [counts] = await sql`
      SELECT
        (SELECT count(*)::int FROM shadow_wiki.source_documents WHERE status='active') AS sources,
        (SELECT count(*)::int FROM shadow_wiki.wiki_pages WHERE status <> 'SUPERSEDED') AS pages,
        (SELECT count(*)::int FROM shadow_wiki.contradictions WHERE status='open') AS open_contradictions
    `;
    return Response.json({ ok: true, layer: "SHADOW", ...counts });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
