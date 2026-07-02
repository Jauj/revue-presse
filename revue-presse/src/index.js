// ============================================================
// index.js — Point d'entrée Cloudflare Worker v3.1
// 8 phases CoT : FETCH → FILTER → EXTRACT → THEME → DRAFT →
//   REVIEW → SYNTHESIS → DELIVER
// ============================================================

import {
  phaseFetch, phaseFilter, phaseExtract, phaseTheme, phaseDraft,
  phaseReview, phaseSynthesis, phaseDeliver, getStatus,
} from './pipeline.js';

const VERSION = '3.1.0';

// Mapping minute cron → phase (8 phases espacées de 3 min)
const PHASE_MAP = {
  0: 'fetch',
  3: 'filter',
  6: 'extract',
  9: 'theme',
  12: 'draft',
  15: 'review',
  18: 'synthesis',
  21: 'deliver',
};

export default {
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

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' },
      });
    }

    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

    try {
      if (path === '/' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify({ service: 'Revue de Presse CoT', version: VERSION, ...status }), { headers: cors });
      }

      if (path === '/status' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify(status), { headers: cors });
      }

      // POST /trigger/all → Pipeline séquentiel complet
      if (path === '/trigger/all' && request.method === 'POST') {
        const results = {};

        results.fetch = await runPhase('fetch', env, new Date());
        if (!results.fetch.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'fetch', ...results }), { status: 500, headers: cors });
        }

        results.filter = await runPhase('filter', env, new Date());
        if (!results.filter.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'filter', ...results }), { status: 500, headers: cors });
        }

        results.extract = await runPhase('extract', env, new Date());
        if (!results.extract.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'extract', ...results }), { status: 500, headers: cors });
        }

        // Les phases suivantes sont tolérantes : on continue même si une échoue
        results.theme = await safeRunPhase('theme', env);
        results.draft = await safeRunPhase('draft', env);
        results.review = await safeRunPhase('review', env);
        results.synthesis = await safeRunPhase('synthesis', env);
        results.deliver = await safeRunPhase('deliver', env);

        return new Response(JSON.stringify({ triggered: 'all', version: VERSION, ...results }), { headers: cors });
      }

      // POST /trigger/<phase>
      const triggerMatch = path.match(/^\/trigger\/(\w+)$/);
      if (triggerMatch && request.method === 'POST') {
        const phaseName = triggerMatch[1];
        const result = await runPhase(phaseName, env, new Date());
        return new Response(JSON.stringify({ triggered: phaseName, version: VERSION, ...result }), { headers: cors });
      }

      // GET /test/search?q=...
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
          ddg: { count: r2.results.length, source: r2.source, error: r2.error },
          searxng: { count: r3.results.length, source: r3.source, error: r3.error },
          brave: { count: r4.results.length, source: r4.source, error: r4.error },
          unified: { source: single.source, count: single.results.length, error: single.error },
          sample: single.results.slice(0, 2).map(r => ({ title: r.title?.substring(0, 80), url: r.url?.substring(0, 100) })),
        }), { headers: cors });
      }

      // GET /test/apis — Test toutes les News APIs
      if (path === '/test/apis' && request.method === 'GET') {
        const { fetchAllNewsAPIs } = await import('./news-apis.js');
        const result = await fetchAllNewsAPIs(env, { maxPerSource: 3 });
        return new Response(JSON.stringify({
          totalArticles: result.articles.length,
          sourceStatus: result.sourceStatus,
          sources: [...new Set(result.articles.map(a => a.sourceName))],
        }), { headers: cors });
      }

      return new Response(JSON.stringify({
        error: 'Route non trouvée',
        version: VERSION,
        routes: {
          'GET /': 'Statut global',
          'GET /status': 'Statut détaillé CoT',
          'POST /trigger/fetch': 'Phase 1 — RSS + News APIs (parallèle)',
          'POST /trigger/filter': 'Phase 2 — Dédup + scoring',
          'POST /trigger/extract': 'Phase 3 — Extraction IA (parallèle)',
          'POST /trigger/theme': 'Phase 4 — Thématisation IA',
          'POST /trigger/draft': 'Phase 5 — Rédaction + Web search',
          'POST /trigger/review': 'Phase 6 — Revue critique IA',
          'POST /trigger/synthesis': 'Phase 7 — Synthèse EIC',
          'POST /trigger/deliver': 'Phase 8 — Envoi email',
          'POST /trigger/all': 'Pipeline complet (test)',
          'GET /test/search?q=...': 'Test recherche web',
          'GET /test/apis': 'Test News APIs',
        },
      }), { status: 404, headers: cors });

    } catch (err) {
      // Ne jamais exposer le stack en production
      return new Response(JSON.stringify({
        error: err.message,
        version: VERSION,
      }), { status: 500, headers: cors });
    }
  },
};

async function runPhase(name, env, eventTime) {
  switch (name) {
    case 'fetch': return phaseFetch(env, eventTime);
    case 'filter': return phaseFilter(env, eventTime);
    case 'extract': return phaseExtract(env, eventTime);
    case 'theme': return phaseTheme(env, eventTime);
    case 'draft': return phaseDraft(env, eventTime);
    case 'review': return phaseReview(env, eventTime);
    case 'synthesis': return phaseSynthesis(env, eventTime);
    case 'deliver': return phaseDeliver(env, eventTime);
    default: return { success: false, error: `Phase inconnue: ${name}` };
  }
}

/** Exécute une phase sans propager l'erreur (pour /trigger/all) */
async function safeRunPhase(name, env) {
  try {
    return await runPhase(name, env, new Date());
  } catch (err) {
    console.error(`[safeRunPhase] ${name}: ${err.message}`);
    return { success: false, error: err.message };
  }
}