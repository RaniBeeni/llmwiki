import { db } from "./db.js";

async function evidenceFor(pageId) {
  const sql = db();
  return sql`
    SELECT
      wps.page_id,
      sd.source_id,
      sd.authority,
      sd.source_system,
      sd.source_locator,
      sv.version_label,
      sv.content_sha256,
      sc.locator,
      wps.relation_type
    FROM shadow_wiki.wiki_page_sources wps
    JOIN shadow_wiki.source_versions sv ON sv.id = wps.source_version_id
    JOIN shadow_wiki.source_documents sd ON sd.source_id = sv.source_id
    LEFT JOIN shadow_wiki.source_chunks sc ON sc.id = wps.source_chunk_id
    WHERE wps.page_id = ${pageId}
    ORDER BY sd.source_id, sc.id
  `;
}

export async function retrieveWiki(query, limit = 8) {
  const sql = db();
  const term = String(query || "").trim();
  if (!term) return [];

  const exact = await sql`
    SELECT page_id, page_type, title, status, review_state, body_md, metadata, 100::float AS score
    FROM shadow_wiki.wiki_pages
    WHERE page_id = ${term}
    LIMIT 1
  `;

  const lexical = await sql`
    SELECT
      page_id,
      page_type,
      title,
      status,
      review_state,
      body_md,
      metadata,
      ts_rank(search_vector, plainto_tsquery('simple', ${term}))::float AS score
    FROM shadow_wiki.wiki_pages
    WHERE search_vector @@ plainto_tsquery('simple', ${term})
    ORDER BY score DESC, page_id
    LIMIT ${limit}
  `;

  const merged = new Map();
  for (const row of [...exact, ...lexical]) {
    const current = merged.get(row.page_id);
    if (!current || Number(row.score) > Number(current.score)) merged.set(row.page_id, row);
  }

  const rows = [...merged.values()]
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, limit);

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      evidence: await evidenceFor(row.page_id),
    }))
  );
}
