import { retrieveWiki } from "../../../lib/retrieval.js";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const { query } = await request.json();
    const results = await retrieveWiki(query);
    return Response.json({ ok: true, query, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
