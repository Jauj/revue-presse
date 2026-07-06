// ============================================================
// index.js — Point d'entrée Cloudflare Worker v3.5.0
// Pipeline résilient : CoT complet → fallback rapide → règles
// Providers : Groq → Gemini → Mistral → Workers AI
// Garantie d'email quotidien même si tous les providers IA échouent
// ============================================================

import {
  phaseFetch, phaseFilter, phaseExtract, phaseTheme, phaseDraft,
  phaseReview, phaseSynthesis, phaseDeliver, phaseFastFallback,
  backgroundMemorySave, getStatus,
} from './pipeline.js';
import { getMemoryStats, dreamDistill } from './memory.js';
import { testProviders } from './ai.js';

const VERSION = '3.5.0';

// ============================================================
// CRON SCHEDULER — Pipeline résilient avec fallbacks en cascade
// Stratégie : CoT complet → si échec → fast review → si échec → règles
// La mémoire est sauvegardée en arrière-plan (ctx.waitUntil)
// ============================================================
export default {
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Pipeline v${VERSION} démarré à ${event.scheduledTime}`);
    const results = { version: VERSION, mode: 'cot' };
    const eventTime = new Date(event.scheduledTime);

    // === ÉTAPE 1 : Fetch (critique — sans articles, rien à faire) ===
    results.fetch = await runPhase('fetch', env, eventTime);
    if (!results.fetch.success) {
      console.error(`[Cron] FETCH échoué, pipeline arrêté: ${results.fetch.error}`);
      return results;
    }

    // === ÉTAPE 2 : Filter (critique — sélectionne les articles) ===
    results.filter = await runPhase('filter', env, eventTime);
    if (!results.filter.success) {
      console.error(`[Cron] FILTER échoué, pipeline arrêté: ${results.filter.error}`);
      return results;
    }

    // === ÉTAPES 3-7 : Pipeline CoT avec fallback ===
    // Chaque phase est tentée. Si extraction échoue → bascule en mode rapide.
    results.extract = await safeRunPhaseWithRetry('extract', env, eventTime);

    if (!results.extract?.success) {
      // Le CoT échoue dès l'extraction → fallback rapide garanti
      console.warn('[Cron] Extraction échouée, bascule en mode FAST FALLBACK');
      results.mode = 'fast';
      results.fastFallback = await runPhase('fast_fallback', env, eventTime);

      if (results.fastFallback?.success) {
        results.deliver = await safeRunPhaseWithRetry('deliver', env, eventTime);
      }

      // Mémoire en arrière-plan (non bloquant)
      ctx.waitUntil(backgroundMemorySave(env, eventTime));
      logPipelineResult(results);
      return results;
    }

    // CoT continue : theme → draft → review → synthesis
    results.theme = await safeRunPhaseWithRetry('theme', env, eventTime);
    results.draft = await safeRunPhaseWithRetry('draft', env, eventTime);
    results.review = await safeRunPhaseWithRetry('review', env, eventTime);
    results.synthesis = await safeRunPhaseWithRetry('synthesis', env, eventTime);

    // Si synthesis a échoué mais draft existe → utiliser le draft comme final
    if (!results.synthesis?.success && results.draft?.success) {
      console.warn('[Cron] Synthesis échouée, utilisation du draft comme revue finale');
      try {
        const draftRaw = await env.CACHE.get('pipeline:stage3_draft');
        if (draftRaw) {
          const { content, provider } = JSON.parse(draftRaw);
          await env.CACHE.put('pipeline:review_final', JSON.stringify({
            date: eventTime.toISOString(),
            content, provider,
            cotStages: ['extraction', 'theming', 'drafting', 'synthesis_skipped'],
            isDraftUsed: true,
          }), { expirationTtl: 7200 });
          results.synthesis = { success: true, provider, usedDraft: true, outputLength: content.length };
        }
      } catch (e) {
        console.error(`[Cron] Draft recovery échoué: ${e.message}`);
      }
    }

    // Si toujours pas de revue finale → dernier recours fast fallback
    if (!results.synthesis?.success) {
      console.warn('[Cron] Pipeline CoT entièrement échoué, FAST FALLBACK');
      results.mode = 'fast';
      results.fastFallback = await runPhase('fast_fallback', env, eventTime);
    }

    // === ÉTAPE 8 : Deliver (tentative, avec retry) ===
    results.deliver = await safeRunPhaseWithRetry('deliver', env, eventTime);

    // Si deliver a échoué et qu'on a un fast fallback → re-essayer
    if (!results.deliver?.success && results.fastFallback?.success) {
      console.warn('[Cron] Deliver échoué après CoT, retry avec fast fallback');
      // Le fast fallback a déjà stocké dans review_final, re-deliver
      results.deliver = await safeRunPhaseWithRetry('deliver', env, eventTime);
    }

    // Mémoire en arrière-plan (non bloquant — ne retarde pas le retour)
    ctx.waitUntil(backgroundMemorySave(env, eventTime));

    logPipelineResult(results);
    return results;
  },

  // ============================================================
  // HTTP HANDLER — Routes API
  // ============================================================
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
      // === Routes GET ===
      if (path === '/' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify({ service: 'Revue de Presse CoT', version: VERSION, ...status }), { headers: cors });
      }

      if (path === '/status' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify(status), { headers: cors });
      }

      // GET /test/providers — Diagnostic des providers IA
      if (path === '/test/providers' && request.method === 'GET') {
        const results = await testProviders(env);
        return new Response(JSON.stringify({ version: VERSION, providers: results }), { headers: cors });
      }

      if (path === '/test/apis' && request.method === 'GET') {
        const { fetchAllNewsAPIs } = await import('./news-apis.js');
        const result = await fetchAllNewsAPIs(env, { maxPerSource: 3 });
        return new Response(JSON.stringify({
          totalArticles: result.articles.length,
          sourceStatus: result.sourceStatus,
          sources: [...new Set(result.articles.map(a => a.sourceName))],
        }), { headers: cors });
      }

      if (path === '/memory/stats' && request.method === 'GET') {
        const stats = await getMemoryStats(env);
        return new Response(JSON.stringify({ version: VERSION, memory: stats }), { headers: cors });
      }

      if (path === '/test/search' && request.method === 'GET') {
        const query = url.searchParams.get('q') || 'actualités France économie';
        const { webSearch } = await import('./searcher.js');
        const single = await webSearch(query, { numResults: 3, lang: 'fr', env });
        return new Response(JSON.stringify({
          query,
          unified: { source: single.source, count: single.results.length, error: single.error },
        }), { headers: cors });
      }

      // === Routes POST — Pipeline ===
      if (path === '/trigger/all' && request.method === 'POST') {
        const results = { version: VERSION, mode: 'cot' };
        results.fetch = await runPhase('fetch', env, new Date());
        if (!results.fetch.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'fetch', ...results }), { status: 500, headers: cors });
        }
        results.filter = await runPhase('filter', env, new Date());
        if (!results.filter.success) {
          return new Response(JSON.stringify({ triggered: 'all', stoppedAt: 'filter', ...results }), { status: 500, headers: cors });
        }

        // CoT phases with individual error handling
        results.extract = await safeRunPhase('extract', env);
        if (!results.extract?.success) {
          results.mode = 'fast';
          results.fastFallback = await runPhase('fast_fallback', env, new Date());
          results.deliver = await safeRunPhase('deliver', env);
          return new Response(JSON.stringify({ triggered: 'all', ...results }), { headers: cors });
        }

        results.theme = await safeRunPhase('theme', env);
        results.draft = await safeRunPhase('draft', env);
        results.review = await safeRunPhase('review', env);
        results.synthesis = await safeRunPhase('synthesis', env);
        results.deliver = await safeRunPhase('deliver', env);

        return new Response(JSON.stringify({ triggered: 'all', ...results }), { headers: cors });
      }

      // POST /trigger/<phase>
      const triggerMatch = path.match(/^\/trigger\/(\w+)$/);
      if (triggerMatch && request.method === 'POST') {
        const phaseName = triggerMatch[1];
        const result = await runPhase(phaseName, env, new Date());
        return new Response(JSON.stringify({ triggered: phaseName, version: VERSION, ...result }), { headers: cors });
      }

      // POST /trigger/dream
      if (path === '/trigger/dream' && request.method === 'POST') {
        const result = await dreamDistill(env, 14, true);
        return new Response(JSON.stringify({ triggered: 'dream', version: VERSION, ...result }), { headers: cors });
      }

      // POST /feedback
      if (path === '/feedback' && request.method === 'POST') {
        const body = await request.json();
        const { date, type, comment } = body;
        if (!date || !type) {
          return new Response(JSON.stringify({ error: 'Paramètres manquants: date, type requis' }), { status: 400, headers: cors });
        }
        const feedbackKey = `memory:feedback:${date}`;
        const existing = await env.CACHE.get(feedbackKey);
        const feedbacks = existing ? JSON.parse(existing) : [];
        feedbacks.push({ type, comment: comment || '', createdAt: new Date().toISOString() });
        await env.CACHE.put(feedbackKey, JSON.stringify(feedbacks), { expirationTtl: 365 * 24 * 3600 });
        return new Response(JSON.stringify({ ok: true, feedbackCount: feedbacks.length }), { headers: cors });
      }

      // 404
      return new Response(JSON.stringify({
        error: 'Route non trouvée',
        version: VERSION,
        routes: {
          'GET /': 'Statut global',
          'GET /status': 'Statut détaillé CoT',
          'GET /test/providers': 'Diagnostic providers IA',
          'POST /trigger/fetch': 'Phase 1 — RSS + News APIs',
          'POST /trigger/filter': 'Phase 2 — Dédup + scoring',
          'POST /trigger/extract': 'Phase 3 — Extraction IA',
          'POST /trigger/theme': 'Phase 4 — Thématisation IA',
          'POST /trigger/draft': 'Phase 5 — Rédaction + Web search',
          'POST /trigger/review': 'Phase 6 — Revue critique IA',
          'POST /trigger/synthesis': 'Phase 7 — Synthèse EIC',
          'POST /trigger/deliver': 'Phase 8 — Envoi email',
          'POST /trigger/fast_fallback': 'Mode dégradé (1 appel IA)',
          'POST /trigger/all': 'Pipeline complet (avec fallback auto)',
          'GET /memory/stats': 'Statistiques mémoire',
          'POST /trigger/dream': 'Distillation IA',
          'POST /feedback': 'Feedback {date, type, comment}',
        },
      }), { status: 404, headers: cors });

    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message,
        version: VERSION,
      }), { status: 500, headers: cors });
    }
  },
};

// ============================================================
// Phase runner avec retry (1 retry après échec)
// ============================================================
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
    case 'fast_fallback': return phaseFastFallback(env, eventTime);
    case 'dream': return dreamDistill(env, 14, true);
    default: return { success: false, error: `Phase inconnue: ${name}` };
  }
}

/** Exécute une phase sans propager l'erreur */
async function safeRunPhase(name, env) {
  try {
    return await runPhase(name, env, new Date());
  } catch (err) {
    console.error(`[safeRunPhase] ${name}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Exécute une phase avec 1 retry automatique après échec
 * Utile pour les phases critiques (deliver) ou capricieuses (extract)
 */
async function safeRunPhaseWithRetry(name, env, eventTime) {
  try {
    const result = await runPhase(name, env, eventTime);
    return result;
  } catch (err) {
    console.warn(`[Retry] ${name} 1er essai échoué: ${err.message}, retry...`);
    try {
      const retry = await runPhase(name, env, eventTime);
      retry._retried = true;
      return retry;
    } catch (retryErr) {
      console.error(`[Retry] ${name} 2e essai échoué: ${retryErr.message}`);
      return { success: false, error: `${err.message} | retry: ${retryErr.message}` };
    }
  }
}

/** Log formaté du résultat du pipeline */
function logPipelineResult(results) {
  const mode = results.mode || 'cot';
  const emailSent = results.deliver?.success;
  const provider = results.deliver?.provider || results.fastFallback?.provider || 'none';
  console.log(`[Cron] Pipeline terminé — mode=${mode} email=${emailSent} provider=${provider}`);
  if (!emailSent) {
    console.error(`[Cron] ⚠️ AUCUN EMAIL ENVOYÉ — vérifier les logs`);
  }
}