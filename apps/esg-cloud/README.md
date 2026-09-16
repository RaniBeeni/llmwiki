# ESG LLM Wiki Cloud P0

Cloud-first web pilot for `CORP-ESG-001`.

## Authority boundary

This application is a **SHADOW knowledge layer**. It never replaces or automatically writes back to:
- Google Drive originals
- the official External Requirement Backbone in Neon
- Notion project state/decisions

The application database is a physically separate Neon project.

## Required Vercel configuration

Set only server-side `DATABASE_URL` using the `llmwiki_app` role. That role intentionally has `SELECT / INSERT / UPDATE` but no `DELETE` permission on `shadow_wiki`.

AI generation uses the Vercel AI Gateway through the AI SDK. In Vercel production, prefer platform OIDC rather than storing an AI provider key. Override the model with `LLMWIKI_MODEL` if needed.

## P0 routes

- `GET /api/status`
- `POST /api/search` with `{ "query": "GOV-1.2" }`
- `POST /api/ask` with `{ "question": "..." }`

## P0 seed

The first source is KSSB S2 2026 Governance pages 6–7, represented by `KSSB-S2-2026`, with `GOV-1.1` and `GOV-1.2` as SHADOW canonical pages.
