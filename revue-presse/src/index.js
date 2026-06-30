// ============================================================
// index.js — Point d'entrée Cloudflare Worker
// Gère les Cron Triggers (3 phases) + endpoints HTTP (test/dashboard)
// ============================================================

import { phaseFetch, phaseAnalyze, phaseDeliver, getStatus } from './pipeline.js';

export default {
  // ============================================================
  // CRON TRIGGER — Routage vers la bonne phase
  // ============================================================
  async scheduled(event, env, ctx) {
    const cron = event.cron; // ex: "0 6 * * 1-5"

    // Déterminer la phase à partir du cron
    // "0 6 * * 1-5" → Phase 1 (minute 0)
    // "2 6 * * 1-5" → Phase 2 (minute 2)
    // "4 6 * * 1-5" → Phase 3 (minute 4)
    const minute = parseInt(cron.split(' ')[0]);

    let result;

    if (minute === 0) {
      // === PHASE 1 : FETCH ===
      console.log('[Phase 1] Démarrage de la récupération RSS + extraction articles...');
      result = await phaseFetch(env, new Date(event.scheduledTime));
      console.log('[Phase 1] Terminé:', JSON.stringify(result));

    } else if (minute === 2) {
      // === PHASE 2 : ANALYZE ===
      console.log('[Phase 2] Démarrage de l\'analyse IA...');
      result = await phaseAnalyze(env, new Date(event.scheduledTime));
      console.log('[Phase 2] Terminé:', JSON.stringify(result));

    } else if (minute === 4) {
      // === PHASE 3 : DELIVER ===
      console.log('[Phase 3] Démarrage de l\'envoi email...');
      result = await phaseDeliver(env, new Date(event.scheduledTime));
      console.log('[Phase 3] Terminé:', JSON.stringify(result));

    } else {
      console.log(`Cron inconnu: ${cron}`);
      result = { error: 'Cron trigger non reconnu', cron };
    }

    return result;
  },

  // ============================================================
  // HTTP HANDLER — Endpoints de test et de monitoring
  // ============================================================
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS pour les requêtes depuis le dashboard
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    try {
      // === GET / → Statut du pipeline ===
      if (path === '/' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify({
          service: 'Revue de Presse',
          version: '1.0.0',
          ...status,
        }), { headers: corsHeaders });
      }

      // === GET /status → Dernier statut ===
      if (path === '/status' && request.method === 'GET') {
        const status = await getStatus(env);
        return new Response(JSON.stringify(status), { headers: corsHeaders });
      }

      // === POST /trigger/fetch → Déclencher manuellement la Phase 1 ===
      if (path === '/trigger/fetch' && request.method === 'POST') {
        const result = await phaseFetch(env, new Date());
        return new Response(JSON.stringify({
          triggered: 'phase_fetch',
          ...result,
        }), { headers: corsHeaders });
      }

      // === POST /trigger/analyze → Déclencher manuellement la Phase 2 ===
      if (path === '/trigger/analyze' && request.method === 'POST') {
        const result = await phaseAnalyze(env, new Date());
        return new Response(JSON.stringify({
          triggered: 'phase_analyze',
          ...result,
        }), { headers: corsHeaders });
      }

      // === POST /trigger/deliver → Déclencher manuellement la Phase 3 ===
      if (path === '/trigger/deliver' && request.method === 'POST') {
        const result = await phaseDeliver(env, new Date());
        return new Response(JSON.stringify({
          triggered: 'phase_deliver',
          ...result,
        }), { headers: corsHeaders });
      }

      // === POST /trigger/all → Pipeline complet (pour les tests manuels) ===
      if (path === '/trigger/all' && request.method === 'POST') {
        const results = {};

        // Phase 1
        results.phase1 = await phaseFetch(env, new Date());
        if (!results.phase1.success) {
          return new Response(JSON.stringify({
            triggered: 'all',
            stoppedAt: 'phase1',
            ...results,
          }), { status: 500, headers: corsHeaders });
        }

        // Phase 2
        results.phase2 = await phaseAnalyze(env, new Date());
        if (!results.phase2.success) {
          return new Response(JSON.stringify({
            triggered: 'all',
            stoppedAt: 'phase2',
            ...results,
          }), { status: 500, headers: corsHeaders });
        }

        // Phase 3
        results.phase3 = await phaseDeliver(env, new Date());

        return new Response(JSON.stringify({
          triggered: 'all',
          ...results,
        }), { headers: corsHeaders });
      }

      // === Route inconnue ===
      return new Response(JSON.stringify({
        error: 'Route non trouvée',
        available_routes: {
          'GET /': 'Statut du service',
          'GET /status': 'Dernier statut du pipeline',
          'POST /trigger/fetch': 'Déclencher Phase 1 (récupération)',
          'POST /trigger/analyze': 'Déclencher Phase 2 (analyse IA)',
          'POST /trigger/deliver': 'Déclencher Phase 3 (envoi email)',
          'POST /trigger/all': 'Pipeline complet (test)',
        },
      }), { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message,
        stack: err.stack,
      }), { status: 500, headers: corsHeaders });
    }
  },
};