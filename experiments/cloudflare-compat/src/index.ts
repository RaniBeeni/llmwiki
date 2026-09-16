import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as mammoth from "mammoth";

const PDF_FIXTURE_B64 = "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDkxNjAxMjMwMyswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDkxNjAxMjMwMyswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTQ2Cj4+CnN0cmVhbQpHYXBRaDBFPUYsMFVcSDNUXHBOWVReUUtrP3RjPklQLDtXI1UxXjIzaWhQRU1fP0NXNEtJU2k8IVs3YCNPQl9xdW4pLlMkIm8lciNlPXNVb11dPCVHT09XOCY5bmVaW0tiLGdlUkxDPS1oIzUtNCVKOixFci4zUloxWGUtUCdWK19tLlpxKGVEdWZxQFQtTjp+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDczMSAwMDAwMCBuIAowMDAwMDAwNzkwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDllZGZiOWZmYzQzNWE2MDJiMGU0YTllMzZkZTY5YTkxPjw5ZWRmYjlmZmM0MzVhNjAyYjBlNGE5ZTM2ZGU2OWE5MT5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTAyNgolJUVPRgo=";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
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
  return pages.join("\n\n");
}

async function probePdf(): Promise<Response> {
  const bytes = Uint8Array.from(Buffer.from(PDF_FIXTURE_B64, "base64"));
  const text = await extractPdf(bytes);
  return Response.json({
    ok: text.includes("KSSB Governance Test") && text.includes("GOV-1.1"),
    bytes: bytes.length,
    sha256: sha256(bytes),
    text
  });
}

async function probeMammoth(): Promise<Response> {
  const api = typeof mammoth.extractRawText === "function";
  return Response.json({ ok: api, extractRawText: typeof mammoth.extractRawText });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        runtime: "cloudflare-workerd",
        crypto: sha256(new TextEncoder().encode("llmwiki")).slice(0, 12)
      });
    }
    if (url.pathname === "/probe/pdf") return probePdf();
    if (url.pathname === "/probe/mammoth") return probeMammoth();
    return new Response("not found", { status: 404 });
  }
};
