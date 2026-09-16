import { neon } from "@neondatabase/serverless";
import { WorkflowEntrypoint } from "cloudflare:workers";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-esg-knowledge-layer": "SHADOW"
    }
  });
}

function db(env: any) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL_NOT_CONFIGURED");
  return neon(env.DATABASE_URL);
}

async function evidenceFor(env: any, pageId: string) {
  const sql = db(env);
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

async function retrieveWiki(env: any, query: string, limit = 8) {
  const sql = db(env);
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

  const merged = new Map<string, any>();
  for (const row of [...exact, ...lexical]) {
    const current = merged.get(row.page_id);
    if (!current || Number(row.score) > Number(current.score)) merged.set(row.page_id, row);
  }

  const rows = [...merged.values()]
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, limit);

  return Promise.all(rows.map(async (row) => ({
    ...row,
    evidence: await evidenceFor(env, row.page_id)
  })));
}

function compactEvidence(results: any[]) {
  return results.flatMap((page) => page.evidence.map((e: any) => ({
    page_id: page.page_id,
    page_title: page.title,
    source_id: e.source_id,
    source_locator: e.source_locator,
    source_authority: e.authority,
    locator: e.locator,
    content_sha256: e.content_sha256,
    relation_type: e.relation_type
  })));
}

function retrievalAnswer(results: any[]): string {
  if (!results.length) return "현재 Shadow Wiki에서 이 질문을 뒷받침할 근거를 찾지 못했습니다.";
  const blocks = results.slice(0, 4).map((r) => {
    const refs = r.evidence
      .map((e: any) => `${e.source_id}${e.locator ? ` · ${JSON.stringify(e.locator)}` : ""}`)
      .join(" / ");
    return `### ${r.page_id} · ${r.title}\n${r.body_md}\n\n근거: ${refs || "연결 근거 없음"}`;
  });
  return [
    "현재 Cloudflare P0는 **근거조회(retrieval-only) 모드**입니다. 아래 내용은 Shadow Wiki에 저장된 페이지와 Source lineage를 그대로 반환한 것이며 공식 확정 답변이 아닙니다.",
    ...blocks
  ].join("\n\n");
}

async function logQuery(env: any, query: string, results: any[], answer: string) {
  try {
    const sql = db(env);
    await sql`
      INSERT INTO shadow_wiki.query_runs(query_text, retrieval, answer_text, citations, model_info)
      VALUES (
        ${query},
        ${JSON.stringify(results.map(({ page_id, title, score, status }) => ({ page_id, title, score, status })))}::jsonb,
        ${answer},
        ${JSON.stringify(compactEvidence(results))}::jsonb,
        ${JSON.stringify({ mode: "retrieval-only-p0", runtime: "cloudflare-workers" })}::jsonb
      )
    `;
  } catch (error) {
    console.error("query log failed", error);
  }
}

async function status(env: any): Promise<Response> {
  try {
    const sql = db(env);
    const rows = await sql`
      SELECT
        (SELECT count(*)::int FROM shadow_wiki.source_documents WHERE status='active') AS sources,
        (SELECT count(*)::int FROM shadow_wiki.wiki_pages WHERE status <> 'SUPERSEDED') AS pages,
        (SELECT count(*)::int FROM shadow_wiki.contradictions WHERE status='open') AS open_contradictions
    `;
    return json({ ok: true, layer: "SHADOW", runtime: "cloudflare-workers", ...rows[0] });
  } catch (error) {
    console.error("status failed", error);
    return json({ ok: false, layer: "SHADOW", runtime: "cloudflare-workers", error: "DATABASE_NOT_CONNECTED" }, 503);
  }
}

async function search(request: Request, env: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const query = String(body.query || "").trim();
    if (!query) return json({ ok: false, error: "QUERY_REQUIRED" }, 400);
    const results = await retrieveWiki(env, query);
    return json({ ok: true, query, results });
  } catch (error) {
    console.error("search failed", error);
    return json({ ok: false, error: "SEARCH_FAILED" }, 500);
  }
}

async function ask(request: Request, env: any): Promise<Response> {
  try {
    const body = await request.json() as any;
    const question = String(body.question || "").trim();
    if (!question) return json({ ok: false, error: "QUESTION_REQUIRED" }, 400);
    const results = await retrieveWiki(env, question);
    const answer = retrievalAnswer(results);
    await logQuery(env, question, results, answer);
    return json({
      ok: true,
      mode: "retrieval-only-p0",
      answer,
      evidence: compactEvidence(results),
      pages: results.map(({ page_id, title, status, review_state, score }) => ({
        page_id, title, status, review_state, score
      })),
      insufficient: results.length === 0
    });
  } catch (error) {
    console.error("ask failed", error);
    return json({ ok: false, error: "ASK_FAILED" }, 500);
  }
}

async function startWorkflow(request: Request, env: any): Promise<Response> {
  const body = await request.json().catch(() => ({})) as any;
  const sourceId = String(body.sourceId || "KSSB-S2-2026");
  const instance = await env.INGEST_WORKFLOW.create({ params: { sourceId } });
  return json({ ok: true, instanceId: instance.id, sourceId, status: "started" }, 202);
}

async function workflowStatus(url: URL, env: any): Promise<Response> {
  const id = url.searchParams.get("id");
  if (!id) return json({ ok: false, error: "INSTANCE_ID_REQUIRED" }, 400);
  const instance = await env.INGEST_WORKFLOW.get(id);
  return json({ ok: true, instanceId: id, workflow: await instance.status() });
}

export class IngestWorkflow extends WorkflowEntrypoint<any, { sourceId: string }> {
  async run(event: any, step: any) {
    const sourceId = event.payload?.sourceId ?? event.params?.sourceId ?? "unknown";
    const cached = await step.do("shadow-cache-manifest", async () => {
      const key = `workflow/${event.instanceId}.json`;
      const payload = JSON.stringify({
        sourceId,
        status: "SHADOW",
        authority: "derived-cache",
        createdAt: new Date().toISOString()
      });
      await this.env.CACHE.put(key, payload, { httpMetadata: { contentType: "application/json" } });
      return { key, bytes: payload.length };
    });
    return { ok: true, sourceId, ...cached };
  }
}

const HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESG AI Knowledge · Shadow P0</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f4;color:#1e261f;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:980px;margin:auto;padding:50px 22px 80px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:800;color:#5b685d}h1{font-size:44px;letter-spacing:-.04em;margin:8px 0 12px}p{line-height:1.65}.badge{display:inline-block;padding:5px 9px;border-radius:999px;background:#e6efe4;color:#31543a;font-size:11px;font-weight:800}.card{background:white;border:1px solid #dde3da;border-radius:18px;padding:22px;margin:14px 0;box-shadow:0 8px 26px rgba(20,35,20,.04)}.row{display:flex;gap:10px}input{flex:1;padding:14px 15px;border:1px solid #cdd6ca;border-radius:12px;font-size:16px}button{border:0;border-radius:12px;background:#24402b;color:#fff;padding:0 18px;font-weight:700;cursor:pointer}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.chips button{background:#eef2ec;color:#334336;padding:8px 11px;font-size:12px}.answer{white-space:pre-wrap;line-height:1.7}.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.ev{border:1px solid #e1e6df;border-radius:12px;padding:13px;font-size:12px;overflow-wrap:anywhere}.muted{color:#6b746c;font-size:13px}.error{color:#8b2c2c}@media(max-width:680px){.hero,.row{flex-direction:column;align-items:stretch}h1{font-size:36px}button{padding:13px}}
</style></head><body><main>
<header class="hero"><div><span class="eyebrow">CORP-ESG-001 · CLOUDFLARE P0</span><h1>ESG AI Knowledge</h1><p>Google Drive·공식 Requirement DB·Notion을 대체하지 않는 <b>SHADOW</b> 지식층입니다.</p></div><div><span class="badge">SHADOW</span><p id="status" class="muted">상태 확인 중…</p></div></header>
<section class="card"><b>질문 / ID 검색</b><div class="row" style="margin-top:12px"><input id="q" value="GOV-1.2" placeholder="GOV-1.2 또는 KSSB 거버넌스 질문"><button id="ask">근거 찾기</button></div><div class="chips"><button data-q="GOV-1.1">GOV-1.1</button><button data-q="GOV-1.2">GOV-1.2</button><button data-q="경영진 역할">경영진 역할</button></div></section>
<section id="result" class="card"><p class="muted">Cloudflare 원격 배포 후 이 화면에서 Shadow Neon의 근거를 조회합니다.</p></section>
<footer class="muted">P0는 retrieval-only입니다. LLM 생성은 Cloudflare 원격/Access/Workflow Gate 통과 후 별도 Provider Adapter로 연결합니다.</footer>
</main><script>
const q=document.getElementById('q'),result=document.getElementById('result'),statusEl=document.getElementById('status');
async function status(){try{const r=await fetch('/api/status');const d=await r.json();statusEl.textContent=d.ok?`${d.pages} pages · ${d.sources} sources · ${d.open_contradictions} conflicts`:'DB 연결 대기';}catch{statusEl.textContent='상태 확인 실패'}}
async function ask(text=q.value){result.innerHTML='<p class="muted">근거 조회 중…</p>';try{const r=await fetch('/api/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:text})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'질의 실패');const ev=(d.evidence||[]).map(e=>`<div class="ev"><b>${e.page_id}</b><br>${e.source_id}<br>${e.source_locator||''}<br><code>${e.content_sha256||''}</code></div>`).join('');result.innerHTML=`<div class="badge">${d.mode}</div><div class="answer"><p>${escapeHtml(d.answer).replace(/\n/g,'<br>')}</p></div><h3>근거</h3><div class="evidence">${ev||'<span class="muted">근거 없음</span>'}</div>`;}catch(e){result.innerHTML=`<p class="error">${escapeHtml(e.message)}</p>`}}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
document.getElementById('ask').onclick=()=>ask();q.addEventListener('keydown',e=>{if(e.key==='Enter')ask()});document.querySelectorAll('[data-q]').forEach(b=>b.onclick=()=>{q.value=b.dataset.q;ask(b.dataset.q)});status();
</script></body></html>`;

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, layer: "SHADOW", runtime: "cloudflare-workers", databaseConfigured: Boolean(env.DATABASE_URL) });
    }
    if (url.pathname === "/api/status" && request.method === "GET") return status(env);
    if (url.pathname === "/api/search" && request.method === "POST") return search(request, env);
    if (url.pathname === "/api/ask" && request.method === "POST") return ask(request, env);
    if (url.pathname === "/api/workflow/start" && request.method === "POST") return startWorkflow(request, env);
    if (url.pathname === "/api/workflow/status" && request.method === "GET") return workflowStatus(url, env);
    return new Response("not found", { status: 404 });
  }
};
