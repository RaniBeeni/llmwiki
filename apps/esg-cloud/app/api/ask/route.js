import { generateText } from "ai";
import { db } from "../../../lib/db.js";
import { retrieveWiki } from "../../../lib/retrieval.js";

export const runtime = "nodejs";
export const maxDuration = 60;

function compactEvidence(results) {
  return results.flatMap((page) =>
    page.evidence.map((e) => ({
      page_id: page.page_id,
      page_title: page.title,
      source_id: e.source_id,
      source_locator: e.source_locator,
      source_authority: e.authority,
      locator: e.locator,
      content_sha256: e.content_sha256,
    }))
  );
}

export async function POST(request) {
  try {
    const { question } = await request.json();
    const q = String(question || "").trim();
    if (!q) return Response.json({ ok: false, error: "질문을 입력하세요." }, { status: 400 });

    const results = await retrieveWiki(q);
    const evidence = compactEvidence(results);

    if (results.length === 0) {
      return Response.json({
        ok: true,
        answer: "현재 Shadow Wiki에서 이 질문을 뒷받침할 근거를 찾지 못했습니다.",
        evidence: [],
        pages: [],
        insufficient: true,
      });
    }

    const context = results
      .map((r) => [
        `PAGE_ID: ${r.page_id}`,
        `TITLE: ${r.title}`,
        `STATUS: ${r.status}`,
        `REVIEW_STATE: ${r.review_state}`,
        r.body_md,
        `EVIDENCE: ${JSON.stringify(r.evidence)}`,
      ].join("\n"))
      .join("\n\n---\n\n");

    const model = process.env.LLMWIKI_MODEL || "openai/gpt-5.4";
    const { text } = await generateText({
      model,
      system: [
        "You are the ESG Shadow Knowledge Assistant.",
        "Answer only from the supplied Shadow Wiki context.",
        "Do not promote SHADOW content to official/final/approved status.",
        "If context is insufficient or ambiguous, say so explicitly.",
        "Preserve the distinction between Source Fact and project decision.",
        "For material claims, cite PAGE_ID and source locator in square brackets.",
        "Never claim that the Wiki overrides Google Drive originals, official Neon requirements, or Notion project decisions.",
        "Respond in Korean unless the user asks otherwise."
      ].join(" "),
      prompt: `QUESTION:\n${q}\n\nSHADOW WIKI CONTEXT:\n${context}`,
    });

    const sql = db();
    await sql`
      INSERT INTO shadow_wiki.query_runs(query_text, retrieval, answer_text, citations, model_info)
      VALUES (
        ${q},
        ${JSON.stringify(results.map(({ page_id, title, score, status }) => ({ page_id, title, score, status })))}::jsonb,
        ${text},
        ${JSON.stringify(evidence)}::jsonb,
        ${JSON.stringify({ model, gateway: "vercel-ai-gateway" })}::jsonb
      )
    `;

    return Response.json({
      ok: true,
      answer: text,
      evidence,
      pages: results.map(({ page_id, title, status, review_state, score }) => ({
        page_id, title, status, review_state, score,
      })),
      insufficient: false,
      model,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
