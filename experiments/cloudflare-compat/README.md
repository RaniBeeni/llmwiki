# Cloudflare Compatibility P0

No Cloudflare account resources are created by this experiment.

It verifies in the actual local `workerd` runtime used by Wrangler that:

1. `node:crypto` and `node:buffer` work.
2. `pdfjs-dist@4.10.38` bundles and extracts text from an in-memory PDF.
3. `mammoth@1.12.0` bundles and exposes its buffer/ArrayBuffer extraction API.
4. The Worker can be bundled by `wrangler deploy --dry-run`.

## Architectural decision under test

The VS Code/file-system shell is **not** moved to Cloudflare.

Reusable pure ESG logic (`esg-policy`, `esg-chunk`, `esg-query`, semantic lint rules)
is intended to be ported to a Cloud service.

Persistent file operations in `esg-shadow.ts` and `esg-source-manifest.ts` are replaced by:
- R2 for derived ingest cache/snapshots
- separate Shadow Neon for page/version/lineage/control records

The Worker virtual filesystem is ephemeral and must never be used as the Wiki persistence layer.
