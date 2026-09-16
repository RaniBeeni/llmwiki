import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as mammoth from "mammoth";
import { neon } from "@neondatabase/serverless";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { structureAwareChunks } from "../../../packages/core/src/esg-chunk.ts";
import { rankEsgCandidates } from "../../../packages/core/src/esg-query.ts";
import { normalizeEsgFrontmatter } from "../../../packages/core/src/esg-policy.ts";
import { lintEsgPage } from "../../../packages/core/src/esg-lint.ts";

(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

const PDF_FIXTURE_B64 = "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDkxNjAxMjMwMyswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDkxNjAxMjMwMyswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTQ2Cj4+CnN0cmVhbQpHYXBRaDBFPUYsMFVcSDNUXHBOWVReUUtrP3RjPklQLDtXI1UxXjIzaWhQRU1fP0NXNEtJU2k8IVs3YCNPQl9xdW4pLlMkIm8lciNlPXNVb11dPCVHT09XOCY5bmVaW0tiLGdlUkxDPS1oIzUtNCVKOixFci4zUloxWGUtUCdWK19tLlpxKGVEdWZxQFQtTjp+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDczMSAwMDAwMCBuIAowMDAwMDAwNzkwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDllZGZiOWZmYzQzNWE2MDJiMGU0YTllMzZkZTY5YTkxPjw5ZWRmYjlmZmM0MzVhNjAyYjBlNGE5ZTM2ZGU2OWE5MT5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTAyNgolJUVPRgo=";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item: unknown): item is { str: string } =>
        typeof item === "object" && item !== null && "str" in item)
      .map((item: { str: string }) => item.str)
      .join(" ");
    pages.push(`[PAGE:${i}]\n${text}`);
  }
  return { text: pages.join("\n\n"), pages: doc.numPages };
}

async function probePdfBytes(source: Uint8Array, expectedPages?: number): Promise<Response> {
  // Hash BEFORE handing a copy to PDF.js. PDF.js may detach/consume its input buffer.
  const hash = sha256(source);
  const beforeBytes = source.byteLength;
  const parsed = await extractPdf(source.slice());
  const ok = parsed.text.includes("GOV-1.1") && (!expectedPages || parsed.pages === expectedPages);
  return Response.json({
    ok,
    beforeBytes,
    afterBytes: source.byteLength,
    sha256: hash,
    pages: parsed.pages,
    first: parsed.text.slice(0, 120),
    last: parsed.text.slice(-120)
  });
}

async function probeSmallPdf(): Promise<Response> {
  const bytes = Uint8Array.from(Buffer.from(PDF_FIXTURE_B64, "base64"));
  return probePdfBytes(bytes, 1);
}

async function probeMammoth(): Promise<Response> {
  return Response.json({ ok: typeof mammoth.extractRawText === "function" });
}

async function probeEsgCore(): Promise<Response> {
  const chunks = structureAwareChunks("[PAGE:1]\nGovernance\nGOV-1.1 oversight\n[PAGE:2]\nGOV-1.2 management");
  const ranked = rankEsgCandidates("GOV-1.2", [{
    path: "canonical-items/gov-1.2.md",
    title: "Management role",
    body: "management",
    id: "GOV-1.2",
    requirement_ids: ["GOV-1.2"]
  }]);
  const fm = normalizeEsgFrontmatter({
    type: "canonical-item",
    title: "GOV-1.2",
    review_state: "ai-compiled",
    source_refs: ["KSSB-S2-2026"],
    authority_scope: "external-standard",
    source_locator: "page 7"
  });
  const findings = lintEsgPage({
    frontmatter: { ...fm, access_classification: "PUBLIC" },
    body: "page 7; proposed mapping only"
  } as any);
  return Response.json({
    ok: chunks.length === 2 && ranked[0]?.score >= 1000 && fm.status === "shadow" && findings.filter(x => x.severity === "error").length === 0,
    chunks: chunks.length,
    exactIdScore: ranked[0]?.score ?? 0,
    status: fm.status,
    lintErrors: findings.filter(x => x.severity === "error").length
  });
}

async function probeR2(env: any): Promise<Response> {
  const key = `compat/${Date.now()}.txt`;
  await env.CACHE.put(key, "shadow-cache-ok");
  const value = await env.CACHE.get(key);
  const text = await value?.text();
  await env.CACHE.delete(key);
  return Response.json({ ok: text === "shadow-cache-ok", key, text });
}

async function probeWorkflow(env: any): Promise<Response> {
  const instance = await env.INGEST_WORKFLOW.create({ params: { sourceId: "KSSB-S2-2026" } });
  return Response.json({ ok: true, instanceId: instance.id });
}

async function workflowStatus(env: any, id: string): Promise<Response> {
  const instance = await env.INGEST_WORKFLOW.get(id);
  return Response.json(await instance.status());
}

export class CompatWorkflow extends WorkflowEntrypoint<any, { sourceId: string }> {
  async run(event: any, step: any) {
    const result = await step.do("hash-and-cache", async () => {
      const key = `workflow/${event.instanceId}.json`;
      const payload = JSON.stringify({ sourceId: event.payload?.sourceId ?? event.params?.sourceId ?? "unknown", status: "shadow" });
      await this.env.CACHE.put(key, payload);
      return { key, bytes: payload.length };
    });
    return { ok: true, ...result };
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        runtime: "cloudflare-workerd",
        crypto: sha256(new TextEncoder().encode("llmwiki")).slice(0, 12)
      });
    }
    if (url.pathname === "/probe/pdf") return probeSmallPdf();
    if (url.pathname === "/probe/pdf-post" && request.method === "POST") {
      return probePdfBytes(new Uint8Array(await request.arrayBuffer()), 165);
    }
    if (url.pathname === "/probe/mammoth") return probeMammoth();
    if (url.pathname === "/probe/esg") return probeEsgCore();
    if (url.pathname === "/probe/r2") return probeR2(env);
    if (url.pathname === "/probe/neon-driver") return Response.json({ ok: typeof neon === "function" });
    if (url.pathname === "/probe/workflow") {
      const id = url.searchParams.get("id");
      return id ? workflowStatus(env, id) : probeWorkflow(env);
    }
    return new Response("not found", { status: 404 });
  }
};
