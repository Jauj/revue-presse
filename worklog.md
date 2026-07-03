---
Task ID: 1
Agent: main
Task: Phase 1+2+3 — Refonte éditoriale + deep-dive + recherche web + bypass paywall

Work Log:
- Rewritten ai.js prompts: EDITORIAL_SYSTEM (Canard Enchaîné style), STAGE1-5 with editorial scoring, adaptive number, analytic-interpretive tone, integrated citations (Solution B), sommaire
- Rewritten email.js: parseEditorialMarkdown() parser, editorial HTML template with sommaire, citation styling, sources blocks, deep-dive links
- Added deep-dive system: GET /deep-dive endpoint with ctx.waitUntil, runDeepDive() pipeline function, buildDeepDiveEmailHTML()
- Created searcher.js: DuckDuckGo Lite search (primary), SearXNG public instances (fallback), multilingual search, result content fetching
- Created paywall.js: multi-strategy bypass (GoogleBot, FacebookBot, browser, Archive.org, Google Cache, 12ft.io, Jina), per-domain strategy optimization, paywall content detection
- Modified pipeline.js: research loop in COT2 (parseResearchNeeds + executeResearchLoop), paywall bypass in FETCH, 4-minute cron gaps
- Updated wrangler.toml: cron schedule 0/4/8/12/16, PUBLIC_URL placeholder
- Updated index.js: PHASE_MAP 4-min gaps, /deep-dive route

Stage Summary:
- Deployed v3 (cf0a50f9) with all 3 phases
- Phase 1: Editorial format with sommaire, citations, adaptive count — TESTED (email sent)
- Phase 2: Deep-dive endpoint — DEPLOYED (needs PUBLIC_URL activation)
- Phase 3: DDG search + paywall bypass — DEPLOYED (cron test pending)
- Files: ai.js, email.js, pipeline.js, index.js, wrangler.toml (modified), searcher.js, paywall.js (new)
