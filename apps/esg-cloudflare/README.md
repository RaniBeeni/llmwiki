# ESG LLM Wiki · Cloudflare P0 Shadow

Cloudflare-first browser pilot for `CORP-ESG-001`.

## Authority boundary

This service is a **SHADOW** knowledge layer. It does not replace or automatically write back to:
- Google Drive original files
- the official External Requirement Backbone in the existing ESG Neon project
- Notion project state or decisions

The service reads from the physically separate Neon project `corp-esg-llmwiki-shadow` using the restricted `llmwiki_app` role. That role intentionally has `SELECT / INSERT / UPDATE` but no `DELETE` permission on `shadow_wiki`.

## P0 platform

- Cloudflare Workers: web/API runtime
- Cloudflare Workflows: durable ingest orchestration smoke path
- Cloudflare R2: derived cache only (`authority = derived-cache`)
- Cloudflare Access: required before enabling database-backed live use
- Separate Shadow Neon: Wiki pages, versions, lineage, control records

## P0 routes

- `GET /` browser UI
- `GET /health` runtime/config health without touching the database
- `GET /api/status` Shadow DB counts
- `POST /api/search` `{ "query": "GOV-1.2" }`
- `POST /api/ask` `{ "question": "GOV-1.2" }`
- `POST /api/workflow/start` optional `{ "sourceId": "KSSB-S2-2026" }`
- `GET /api/workflow/status?id=<instance-id>`

## Intentional P0 limitation

`/api/ask` is **retrieval-only**. It returns Shadow Wiki content and Source lineage without a generative model. LLM generation is connected only after the first remote Workers + Access + Workflow Gate passes, through a provider adapter rather than being coupled to the runtime.

## Secrets

Never commit `DATABASE_URL`. Configure it as a Cloudflare Worker secret after Access protection is in place.

## Cloudflare Git deployment

Production builds are connected from Cloudflare Workers Builds to branch `cloudflare-p0-shadow` with root directory `/apps/esg-cloudflare/`. The deploy command is `npx wrangler deploy`; no separate build command is required for this P0.
