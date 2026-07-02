// ============================================================
// index.js — Point d'entrée Cloudflare Worker
// 7 phases CoT : FETCH → EXTRACT → THEME → DRAFT → REVIEW → SYNTHESIS → DELIVER
// + endpoints HTTP pour monitoring et tests
// ============================================================

import {
  phaseFetch, phaseExtract, phaseTheme, phaseDraft,
  phaseReview, phaseSynthesis, phaseDeliver, getStatus,
} from './pipeline.js';

// Mapping minute cron → phase
const PHASE_MAP = {
  0: 'fetch',
  3: 'extract',
  6: 'theme',
  9: 'draft',
  12: 'review',
  15: 'synthesis',
  18: 'deliver',
};

export default {
  // ============================================================
  // CRON TRIGGER — Routage vers la bonne phase
  // ============================================================
  async scheduled(event, env, ctx) {
    const minute = parseInt(event.cron.split(' ')[0]);
    const phase = PHASE_MAP[minute];

    if (!phase) {
      console.log(`Cron non reconnu (minute ${minute}): ${event.cron}`);
      return { error: 'Cron non reconnu', minute };
    }

    console.log(`[Phase ${phase}] Démarrage...`);
    const result = await runPhase(phase, env, new Date(event.scheduledTime));
    console.log(`[Phase ${phase}] Terminé:`, JSON.stringify(result));
    return result;
  },

  // ============================================================
  // HTTP HANDLER — Endpoints de test et monitoring
  // ============================================================
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' },
      });
    }

    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    try {
      // GET / → Statut global
      if (path === '/' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify({ service: 'Revue de Presse CoT', version: '2.1.0', ...status }), { headers: cors });
      }

      // GET /status → Statut détaillé par phase
      if (path === '/status' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify(status), { headers: cors });
      }

      // POST /trigger/all → Pipeline séquentiel complet (doit être AVANT le catch-all regex)
      if (path === '/trigger/all' && request.method === 'POST') {
        const results = {};

        results.fetch = await runPhase('fetch', env, new Date());
        if (!results.fetch.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'fetch', ...results }), { status: 500, headers: cors });
        }

        results.extract = await runPhase('extract', env, new Date());
        if (!results.extract.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'extract', ...results }), { status: 500, headers: cors });
        }

        results.theme = await runPhase('theme', env, new Date());
        results.draft = await runPhase('draft', env, new Date());
        results.review = await runPhase('review', env, new Date());
        results.synthesis = await runPhase('synthesis', env, new Date());
        results.deliver = await runPhase('deliver', env, new Date());

        return new Response(JSON.stringify({ triggered: 'all', ...results }), { headers: cors });
      }

      // POST /trigger/<phase> → Déclencher une phase manuellement
      const triggerMatch = path.match(/^\/trigger\/(\w+)$/);
      if (triggerMatch && request.method === 'POST') {
        const phaseName = triggerMatch[1];
        const result = await runPhase(phaseName, env, new Date());
        return new Response(JSON.stringify({ triggered: phaseName, ...result }), { headers: cors });
      }

      // GET /test/search?q=... — Test recherche web détaillé
      if (path === '/test/search' && request.method === 'GET') {
        const query = url.searchParams.get('q') || 'actualités France économie';
        const { searchNewsAPI, searchDDGHTML, searchSearXNG, searchBrave, webSearch, webSearchMultiLang } = await import('./searcher.js');

        const r1 = await searchNewsAPI(query, { numResults: 3, lang: 'fr', daysBack: 2, env });
        const r2 = await searchDDGHTML(query, { numResults: 3, lang: 'fr' });
        const r3 = await searchSearXNG(query, { numResults: 3, lang: 'fr' });
        const r4 = await searchBrave(query, { numResults: 3, lang: 'fr', env });
        const single = await webSearch(query, { numResults: 5, lang: 'fr', env });

        return new Response(JSON.stringify({
          query,
          newsapi: { count: r1.results.length, source: r1.source, error: r1.error },
          ddg: { count: r2.results.length, source: r2.source, error: r2.error, htmlLen: r2._htmlLen },
          searxng: { count: r3.results.length, source: r3.source, error: r3.error },
          brave: { count: r4.results.length, source: r4.source, error: r4.error },
          unified: { source: single.source, count: single.results.length, error: single.error },
          sample: single.results.slice(0, 2).map(r => ({ title: r.title?.substring(0, 80), url: r.url?.substring(0, 100) })),
        }), { headers: cors });
      }

      return new Response(JSON.stringify({
        error: 'Route non trouvée',
        routes: {
          'GET /': 'Statut global',
          'GET /status': 'Statut détaillé CoT',
          'POST /trigger/fetch': 'Phase 1 — Récupération RSS',
          'POST /trigger/extract': 'Phase 2 — Extraction IA',
          'POST /trigger/theme': 'Phase 3 — Thématisation IA',
          'POST /trigger/draft': 'Phase 4 — Rédaction IA + Recherche web',
          'POST /trigger/review': 'Phase 5 — Revue critique IA',
          'POST /trigger/synthesis': 'Phase 6 — Synthèse EIC (2 appels 10s)',
          'POST /trigger/deliver': 'Phase 7 — Envoi email',
          'POST /trigger/all': 'Pipeline complet (test, >5 min)',
          'GET /test/search?q=...': 'Test recherche web',
        },
      }), { status: 404, headers: cors });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500, headers: cors });
    }
  },
};

// ============================================================
// Routeur de phase
// ============================================================
async function runPhase(name, env, eventTime) {
  switch (name) {
    case 'fetch': return phaseFetch(env, eventTime);
    case 'extract': return phaseExtract(env, eventTime);
    case 'theme': return phaseTheme(env, eventTime);
    case 'draft': return phaseDraft(env, eventTime);
    case 'review': return phaseReview(env, eventTime);
    case 'synthesis': return phaseSynthesis(env, eventTime);
    case 'deliver': return phaseDeliver(env, eventTime);
    default: return { success: false, error: `Phase inconnue: ${name}` };
  }
}