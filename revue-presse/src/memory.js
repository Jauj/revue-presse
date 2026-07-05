// ============================================================
// memory.js — Système de mémoire éditoriale avec distillation
// 5 couches :
//   1. Épisodique   : souvenir quotidien (TTL 30j)
//   2. Sémantique   : thèmes récurrents avec poids (TTL 365j)
//   3. Narratives   : fil rouge inter-jours, récits en cours (TTL 90j)
//   4. Distillée    : connaissances consolidées par IA (TTL 365j)
//   5. Éditoriale   : préférences apprises (TTL 365j)
//
// Processus de "rêve" (distillation) :
//   - Journalier (léger) : mise à jour narratives
//   - Hebdomadaire (vendredi, profond) : consolidation IA mensuelle
//   - Manuel : via /trigger/dream
//
// Inspiré de : forge-agent-memory, RecMem, claude-second-brain,
//              opendream, anchor-memory
// Stockage : KV Cloudflare (gratuit, <1000 writes/jour)
// ============================================================

import { callAI } from './ai.js';

// === Clés KV ===
const MEM_PREFIX = 'memory:';

// ============================================================
// COUCHE 1 — MÉMOIRE ÉPISODIQUE (un souvenir par jour)
// KV: memory:day:2026-07-01  (TTL 30j)
// ============================================================

export async function saveDailyMemory(env, date, reviewContent, articles) {
  const dateStr = date.toISOString().split('T')[0];
  const key = `${MEM_PREFIX}day:${dateStr}`;

  const themes = extractThemesFromReview(reviewContent);
  const sources = [...new Set(articles.map(a => a.sourceName))];
  const keyFacts = extractKeyFacts(reviewContent);
  const actors = extractActors(reviewContent);
  const entities = extractEntities(reviewContent);

  const memory = {
    date: dateStr,
    themes,
    sources,
    keyFacts,
    actors,
    entities,
    articleCount: articles.length,
    sourceCount: sources.length,
    wordEstimate: reviewContent.split(/\s+/).length,
    createdAt: new Date().toISOString(),
  };

  await env.CACHE.put(key, JSON.stringify(memory), { expirationTtl: 30 * 24 * 3600 });

  // Mettre à jour l'index des jours
  await updateDayIndex(env, dateStr);

  return memory;
}

// ============================================================
// COUCHE 2 — MÉMOIRE SÉMANTIQUE (thèmes récurrents)
// KV: memory:themes  (TTL 365j)
// ============================================================

export async function updateSemanticMemory(env, dailyMemory) {
  const key = `${MEM_PREFIX}themes`;
  const raw = await env.CACHE.get(key);
  let semantic = raw ? JSON.parse(raw) : { themes: {}, lastUpdated: null, totalDays: 0 };

  for (const theme of dailyMemory.themes) {
    const normalized = normalizeTheme(theme);
    if (!semantic.themes[normalized]) {
      semantic.themes[normalized] = {
        name: theme,
        count: 0,
        firstSeen: dailyMemory.date,
        lastSeen: dailyMemory.date,
        relatedSources: [],
        relatedFacts: [],
        days: [],
      };
    }
    semantic.themes[normalized].count++;
    semantic.themes[normalized].lastSeen = dailyMemory.date;
    if (!semantic.themes[normalized].days.includes(dailyMemory.date)) {
      semantic.themes[normalized].days.push(dailyMemory.date);
    }

    const existing = new Set(semantic.themes[normalized].relatedSources);
    for (const s of dailyMemory.sources) existing.add(s);
    semantic.themes[normalized].relatedSources = [...existing].slice(0, 10);

    for (const fact of dailyMemory.keyFacts.slice(0, 2)) {
      if (!semantic.themes[normalized].relatedFacts.includes(fact)) {
        semantic.themes[normalized].relatedFacts.push(fact);
      }
    }
    semantic.themes[normalized].relatedFacts =
      semantic.themes[normalized].relatedFacts.slice(-5);
  }

  semantic.totalDays++;
  semantic.lastUpdated = new Date().toISOString();

  await env.CACHE.put(key, JSON.stringify(semantic), { expirationTtl: 365 * 24 * 3600 });
  return semantic;
}

// ============================================================
// COUCHE 3 — NARRATIVES (fil rouge inter-jours)
// KV: memory:narratives  (TTL 90j)
// Détecte les récits qui traversent plusieurs jours
// ============================================================

export async function updateNarratives(env, dailyMemory) {
  const key = `${MEM_PREFIX}narratives`;
  const raw = await env.CACHE.get(key);
  let narratives = raw ? JSON.parse(raw) : { active: [], archived: [], lastUpdated: null };

  const todayThemes = dailyMemory.themes.map(t => t.toLowerCase());
  let touchedNarratives = [];

  // 1. Essayer de rattacher les thèmes du jour à des narratives existantes
  for (const narrative of narratives.active) {
    let matched = false;
    for (const theme of todayThemes) {
      const similarity = computeThemeSimilarity(theme, narrative.title.toLowerCase());
      if (similarity > 0.4) {
        // Mettre à jour la narrative
        narrative.lastSeen = dailyMemory.date;
        narrative.dayCount = (narrative.dayCount || 1) + 1;
        narrative.days = narrative.days || [];
        if (!narrative.days.includes(dailyMemory.date)) {
          narrative.days.push(dailyMemory.date);
        }
        // Ajouter les nouveaux faits
        for (const fact of dailyMemory.keyFacts.slice(0, 2)) {
          if (!narrative.facts.some(f => f.fact === fact)) {
            narrative.facts.push({ fact, date: dailyMemory.date });
          }
        }
        // Ajouter les sources
        const existingSources = new Set(narrative.sources || []);
        for (const s of dailyMemory.sources) existingSources.add(s);
        narrative.sources = [...existingSources];
        // Dernière évolution
        narrative.lastEvolution = dailyMemory.themes[0] || '';
        matched = true;
        touchedNarratives.push(narrative.id);
        break;
      }
    }
  }

  // 2. Créer de nouvelles narratives pour les thèmes non rattachés
  for (const theme of dailyMemory.themes.slice(0, 3)) {
    const themeLower = theme.toLowerCase();
    const alreadyTracked = touchedNarratives.some(id => {
      const n = narratives.active.find(a => a.id === id);
      return n && computeThemeSimilarity(themeLower, n.title.toLowerCase()) > 0.5;
    });
    if (!alreadyTracked) {
      narratives.active.push({
        id: `nar_${dailyMemory.date}_${normalizeTheme(theme).substring(0, 20)}`,
        title: theme,
        firstSeen: dailyMemory.date,
        lastSeen: dailyMemory.date,
        dayCount: 1,
        days: [dailyMemory.date],
        facts: dailyMemory.keyFacts.slice(0, 2).map(f => ({ fact: f, date: dailyMemory.date })),
        sources: dailyMemory.sources.slice(0, 5),
        lastEvolution: theme,
        status: 'active',
      });
    }
  }

  // 3. Archiver les narratives inactives (>7 jours sans update)
  narratives.active = narratives.active.filter(n => {
    const daysSince = daysBetween(n.lastSeen, dailyMemory.date);
    if (daysSince > 7 && n.dayCount < 3) return false; // supprimer les éphémères
    if (daysSince > 14) {
      n.status = 'archived';
      n.archivedAt = dailyMemory.date;
      narratives.archived = narratives.archived || [];
      narratives.archived.push(n);
      return false;
    }
    return true;
  });

  // Garder max 10 narratives actives (les plus récentes)
  narratives.active.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  narratives.active = narratives.active.slice(0, 10);

  // Garder max 20 narratives archivées
  if (narratives.archived) {
    narratives.archived = narratives.archived.slice(-20);
  }

  narratives.lastUpdated = new Date().toISOString();

  await env.CACHE.put(key, JSON.stringify(narratives), { expirationTtl: 90 * 24 * 3600 });
  return narratives;
}

// ============================================================
// COUCHE 4 — MÉMOIRE DISTILLÉE (connaissances consolidées par IA)
// KV: memory:distilled:2026-07  (TTL 365j)
// "Le rêve" : l'IA analyse N jours de mémoires et produit
// un résumé compact de connaissances de haut niveau
// ============================================================

/**
 * Processus de rêve complet (distillation IA)
 * Lit les mémoires des derniers N jours et produit des insights
 */
export async function dreamDistill(env, daysBack = 14, force = false) {
  const today = new Date();
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const distilledKey = `${MEM_PREFIX}distilled:${monthKey}`;

  // Vérifier si on a déjà distillé récemment (pas plus d'une fois par 3 jours)
  if (!force) {
    const lastDreamRaw = await env.CACHE.get(`${MEM_PREFIX}last_dream`);
    if (lastDreamRaw) {
      const lastDream = JSON.parse(lastDreamRaw);
      const daysSinceDream = daysBetween(lastDream.date, today.toISOString().split('T')[0]);
      if (daysSinceDream < 3) {
        return { skipped: true, reason: `Dernier rêve il y a ${daysSinceDream}j (min 3)`, lastDream };
      }
    }
  }

  // 1. Collecter les mémoires épisodiques via day_index (optimisation KV)
  const dailyMemories = [];
  const indexRaw = await env.CACHE.get(`${MEM_PREFIX}day_index`);
  if (indexRaw) {
    const index = JSON.parse(indexRaw);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const recentDays = (index.days || []).filter(d => d <= today.toISOString().split('T')[0] && d >= cutoffStr);
    for (const dateStr of recentDays) {
      const raw = await env.CACHE.get(`${MEM_PREFIX}day:${dateStr}`);
      if (raw) dailyMemories.push(JSON.parse(raw));
    }
  } else {
    // Fallback : lecture séquentielle si pas d'index
    for (let i = 1; i <= daysBack; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const raw = await env.CACHE.get(`${MEM_PREFIX}day:${dateStr}`);
      if (raw) dailyMemories.push(JSON.parse(raw));
    }
  }

  if (dailyMemories.length < 3) {
    return { skipped: true, reason: `Seulement ${dailyMemories.length} mémoires (min 3)`, hasEnough: false };
  }

  // 2. Collecter les narratives
  const narrativesRaw = await env.CACHE.get(`${MEM_PREFIX}narratives`);
  const narratives = narrativesRaw ? JSON.parse(narrativesRaw) : null;

  // 3. Construire le matériel de rêve (compact)
  const dreamMaterial = buildDreamMaterial(dailyMemories, narratives);

  // 4. Appel IA de distillation
  const startTime = Date.now();
  let distilled = null;
  try {
    distilled = await callAIDream(env, dreamMaterial);
  } catch (err) {
    console.error(`Rêve IA échoué: ${err.message}`);
    // Fallback : distillation rule-based
    distilled = ruleBasedDistillation(dailyMemories, narratives);
  }
  const dreamDuration = Date.now() - startTime;

  // 5. Stocker la distillation mensuelle
  const distilledData = {
    month: monthKey,
    date: today.toISOString().split('T')[0],
    daysAnalyzed: dailyMemories.length,
    dreamDurationMs: dreamDuration,
    aiPowered: !!distilled.aiGenerated,
    ...distilled,
  };

  await env.CACHE.put(distilledKey, JSON.stringify(distilledData), { expirationTtl: 365 * 24 * 3600 });

  // 6. Mettre à jour la mémoire éditoriale
  await updateEditorialMemory(env, dailyMemories, distilled);

  // 7. Enregistrer le dernier rêve
  await env.CACHE.put(`${MEM_PREFIX}last_dream`, JSON.stringify({
    date: today.toISOString().split('T')[0],
    type: dailyMemories.length >= 7 ? 'deep' : 'light',
    duration: dreamDuration,
    daysAnalyzed: dailyMemories.length,
    monthKey,
  }), { expirationTtl: 30 * 24 * 3600 });

  // 8. Nettoyer les vieilles mémoires épisodiques (au-delà de 14 jours)
  await pruneOldMemories(env, 14);

  return {
    success: true,
    daysAnalyzed: dailyMemories.length,
    dreamDurationMs: dreamDuration,
    monthKey,
    distilledThemes: distilled.patterns?.length || 0,
    narrativeCount: narratives?.active?.length || 0,
  };
}

// ============================================================
// COUCHE 5 — MÉMOIRE ÉDITORIALE (préférences apprises)
// KV: memory:editorial  (TTL 365j)
// Apprend quels patterns fonctionnent bien
// ============================================================

async function updateEditorialMemory(env, dailyMemories, distilled) {
  const key = `${MEM_PREFIX}editorial`;
  const raw = await env.CACHE.get(key);
  let editorial = raw ? JSON.parse(raw) : {
    sourcePatterns: {},
    topicBalance: {},
    avgArticleCount: 0,
    avgThemesPerDay: 0,
    totalReviews: 0,
    preferences: [],
    lastUpdated: null,
  };

  // Statistiques glissantes
  editorial.totalReviews++;
  const recentCounts = dailyMemories.slice(-7).map(m => m.articleCount);
  editorial.avgArticleCount = Math.round(recentCounts.reduce((a, b) => a + b, 0) / recentCounts.length);
  const recentThemes = dailyMemories.slice(-7).map(m => m.themes.length);
  editorial.avgThemesPerDay = Math.round(recentThemes.reduce((a, b) => a + b, 0) / recentThemes.length);

  // Patterns par source
  for (const mem of dailyMemories) {
    for (const source of mem.sources) {
      if (!editorial.sourcePatterns[source]) {
        editorial.sourcePatterns[source] = { appearances: 0, themesContributed: [] };
      }
      editorial.sourcePatterns[source].appearances++;
      for (const theme of mem.themes.slice(0, 2)) {
        const existing = new Set(editorial.sourcePatterns[source].themesContributed);
        existing.add(theme);
        editorial.sourcePatterns[source].themesContributed = [...existing].slice(0, 10);
      }
    }
  }

  // Préférences apprises (depuis la distillation IA)
  if (distilled.insights) {
    for (const insight of distilled.insights.slice(0, 5)) {
      if (!editorial.preferences.some(p => p.insight === insight)) {
        editorial.preferences.push({
          insight,
          learnedFrom: dailyMemories[dailyMemories.length - 1]?.date,
          createdAt: new Date().toISOString(),
        });
      }
    }
    editorial.preferences = editorial.preferences.slice(-10);
  }

  editorial.lastUpdated = new Date().toISOString();
  await env.CACHE.put(key, JSON.stringify(editorial), { expirationTtl: 365 * 24 * 3600 });
  return editorial;
}

// ============================================================
// LECTURE — Construire le contexte mémoire pour injection CoT
// ============================================================

export async function getMemoryContext(env, maxDays = 7) {
  const today = new Date();
  const dailyMemories = [];
  const themesRaw = await env.CACHE.get(`${MEM_PREFIX}themes`);
  const semantic = themesRaw ? JSON.parse(themesRaw) : null;
  const narrativesRaw = await env.CACHE.get(`${MEM_PREFIX}narratives`);
  const narratives = narrativesRaw ? JSON.parse(narrativesRaw) : null;
  const editorialRaw = await env.CACHE.get(`${MEM_PREFIX}editorial`);
  const editorial = editorialRaw ? JSON.parse(editorialRaw) : null;

  // Dernière distillation
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const lastMonthKey = today.getMonth() === 0
    ? `${today.getFullYear() - 1}-12`
    : `${today.getFullYear()}-${String(today.getMonth()).padStart(2, '0')}`;
  const distilledRaw = await env.CACHE.get(`${MEM_PREFIX}distilled:${monthKey}`)
    || await env.CACHE.get(`${MEM_PREFIX}distilled:${lastMonthKey}`);
  const distilled = distilledRaw ? JSON.parse(distilledRaw) : null;

  // Lire les derniers jours de mémoire épisodique via day_index
  const indexRaw = await env.CACHE.get(`${MEM_PREFIX}day_index`);
  if (indexRaw) {
    const index = JSON.parse(indexRaw);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - maxDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const recentDays = (index.days || []).filter(d => d <= todayStr && d >= cutoffStr);
    for (const dateStr of recentDays) {
      const raw = await env.CACHE.get(`${MEM_PREFIX}day:${dateStr}`);
      if (raw) dailyMemories.push(JSON.parse(raw));
    }
  } else {
    for (let i = 1; i <= maxDays; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const raw = await env.CACHE.get(`${MEM_PREFIX}day:${dateStr}`);
      if (raw) dailyMemories.push(JSON.parse(raw));
    }
  }

  if (dailyMemories.length === 0 && !semantic && !distilled) {
    return null;
  }

  return buildRichContextString(dailyMemories, semantic, narratives, distilled, editorial);
}

// ============================================================
// NETTOYAGE — Supprimer les anciennes mémoires
// ============================================================

export async function pruneOldMemories(env, keepDays = 14) {
  const today = new Date();
  let pruned = 0;

  for (let i = keepDays + 1; i <= 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const key = `${MEM_PREFIX}day:${dateStr}`;
    const existing = await env.CACHE.get(key);
    if (existing) {
      await env.CACHE.delete(key);
      pruned++;
    }
  }

  return pruned;
}

// ============================================================
// STATISTIQUES — Pour le endpoint /memory
// ============================================================

export async function getMemoryStats(env) {
  const today = new Date();
  const stats = {
    totalDailyMemories: 0,
    semanticThemes: 0,
    activeNarratives: 0,
    hasDistillation: false,
    hasEditorial: false,
    lastDream: null,
    topThemes: [],
    activeNarrativeTitles: [],
  };

  // Compter les mémoires quotidiennes via day_index (optimisation KV)
  const indexRaw = await env.CACHE.get(`${MEM_PREFIX}day_index`);
  if (indexRaw) {
    const index = JSON.parse(indexRaw);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    stats.totalDailyMemories = (index.days || []).filter(d => d <= todayStr && d >= cutoffStr).length;
  } else {
    for (let i = 0; i <= 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      const raw = await env.CACHE.get(`${MEM_PREFIX}day:${dateStr}`);
      if (raw) stats.totalDailyMemories++;
    }
  }

  // Thèmes sémantiques
  const themesRaw = await env.CACHE.get(`${MEM_PREFIX}themes`);
  if (themesRaw) {
    const semantic = JSON.parse(themesRaw);
    stats.semanticThemes = Object.keys(semantic.themes).length;
    stats.totalDays = semantic.totalDays;
    stats.topThemes = Object.entries(semantic.themes)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([k, v]) => ({ theme: v.name, count: v.count, lastSeen: v.lastSeen, days: v.days?.length || 0 }));
  }

  // Narratives
  const narrativesRaw = await env.CACHE.get(`${MEM_PREFIX}narratives`);
  if (narrativesRaw) {
    const narratives = JSON.parse(narrativesRaw);
    stats.activeNarratives = narratives.active?.length || 0;
    stats.activeNarrativeTitles = (narratives.active || []).slice(0, 5).map(n => ({
      title: n.title, days: n.dayCount, lastSeen: n.lastSeen,
    }));
  }

  // Distillation
  const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const distilledRaw = await env.CACHE.get(`${MEM_PREFIX}distilled:${monthKey}`);
  if (distilledRaw) {
    stats.hasDistillation = true;
    const d = JSON.parse(distilledRaw);
    stats.distillationInfo = { month: d.month, daysAnalyzed: d.daysAnalyzed, aiPowered: d.aiPowered };
  }

  // Éditorial
  const editorialRaw = await env.CACHE.get(`${MEM_PREFIX}editorial`);
  if (editorialRaw) {
    stats.hasEditorial = true;
    const e = JSON.parse(editorialRaw);
    stats.editorialInfo = { totalReviews: e.totalReviews, avgArticles: e.avgArticleCount, preferences: e.preferences?.length || 0 };
  }

  // Dernier rêve
  const lastDreamRaw = await env.CACHE.get(`${MEM_PREFIX}last_dream`);
  if (lastDreamRaw) stats.lastDream = JSON.parse(lastDreamRaw);

  return stats;
}

// ============================================================
// FONCTIONS INTERNES — Construction du matériel de rêve
// ============================================================

function buildDreamMaterial(dailyMemories, narratives) {
  let material = `## MATÉRIEL DE RÊVE — ${dailyMemories.length} jours de mémoires\n\n`;

  // Résumé chronologique compact
  material += '### Chronologie (du plus ancien au plus récent)\n';
  for (const mem of dailyMemories) {
    const themesStr = mem.themes.slice(0, 3).join(' | ');
    material += `- ${mem.date}: ${themesStr} (${mem.articleCount} articles, ${mem.sourceCount} sources)\n`;
  }

  // Thèmes avec fréquence
  const themeFreq = {};
  for (const mem of dailyMemories) {
    for (const t of mem.themes) {
      const norm = normalizeTheme(t);
      themeFreq[norm] = (themeFreq[norm] || 0) + 1;
    }
  }
  const frequent = Object.entries(themeFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  material += '\n### Thèmes par fréquence\n';
  for (const [key, count] of frequent) {
    const bar = '█'.repeat(Math.min(count, 10));
    material += `- ${key.replace(/_/g, ' ')} : ${bar} (${count}/${dailyMemories.length} jours)\n`;
  }

  // Sources les plus présentes
  const sourceFreq = {};
  for (const mem of dailyMemories) {
    for (const s of mem.sources) {
      sourceFreq[s] = (sourceFreq[s] || 0) + 1;
    }
  }
  const topSources = Object.entries(sourceFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  material += '\n### Sources les plus citées\n';
  for (const [source, count] of topSources) {
    material += `- ${source} : présente ${count}/${dailyMemories.length} jours\n`;
  }

  // Faits clés par jour
  material += '\n### Faits marquants par jour\n';
  for (const mem of dailyMemories.slice(-5)) {
    material += `\n**${mem.date}**\n`;
    for (const fact of mem.keyFacts.slice(0, 3)) {
      material += `  - ${fact}\n`;
    }
  }

  // Narratives actives
  if (narratives?.active?.length > 0) {
    material += '\n### Narratives en cours\n';
    for (const nar of narratives.active.slice(0, 5)) {
      material += `- **${nar.title}** : ${nar.dayCount} jours, dernier le ${nar.lastSeen}\n`;
      if (nar.facts?.length > 0) {
        material += `  Évolution: ${nar.facts[nar.facts.length - 1].fact}\n`;
      }
    }
  }

  // Acteurs récurrents
  const actorFreq = {};
  for (const mem of dailyMemories) {
    if (mem.actors) {
      for (const a of mem.actors) {
        actorFreq[a] = (actorFreq[a] || 0) + 1;
      }
    }
  }
  const topActors = Object.entries(actorFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  if (topActors.length > 0) {
    material += '\n### Acteurs récurrents\n';
    for (const [actor, count] of topActors) {
      material += `- ${actor} : ${count} mentions\n`;
    }
  }

  return material;
}

// ============================================================
// FONCTIONS INTERNES — Appel IA de rêve
// ============================================================

const DREAM_PROMPT = `Tu es un système de "rêve" pour une revue de presse automatique. Tu analyses ${'${days}'} jours de mémoires éditoriales pour en extraire des connaissances de haut niveau.

## TA MISSION
Produis un JSON STRICT avec cette structure exacte (pas de markdown, pas de commentaires) :
{
  "patterns": [
    {"type": "recurring", "theme": "nom du thème", "frequency": "X/N jours", "trend": "rising|stable|declining", "note": "explication courte"}
  ],
  "narratives": [
    {"title": "titre du récit", "arc": "description de l'évolution sur la période", "key_moments": ["moment 1", "moment 2"], "status": "active|peaked|resolved"}
  ],
  "insights": [
    "insight 1 : observation profonde sur les tendances",
    "insight 2 : corrélation inattendue entre sujets"
  ],
  "source_dynamics": [
    {"source": "nom source", "role": "leader/follower/specialized", "notes": "comment cette source se comporte"}
  ],
  "blind_spots": [
    "angle ou sujet rarement couvert"
  ],
  "macro_trends": [
    {"trend": "nom de la tendance macro", "description": "explication", "timescale": "court/moyen/long terme"}
  ]
}

## RÈGLES
- Réponse JSON UNIQUEMENT, pas de texte avant ou après
- Sois précis et factuel, basé uniquement sur les données fournies
- Les insights doivent être non-évidents (pas juste "le thème X est fréquent")
- Identifie les corrélations et les évolutions, pas juste les occurrences
- Maximum 6 patterns, 4 narratives, 5 insights, 5 source_dynamics, 3 blind_spots, 4 macro_trends`;

async function callAIDream(env, dreamMaterial) {
  const userPrompt = `Voici le matériel de rêve : ${dreamMaterial}\n\nProduis le JSON de distillation.`;

  try {
    const result = await callAI(env, DREAM_PROMPT, userPrompt, false);
    // Parser le JSON de la réponse
    let jsonStr = result.trim();
    // Enlever les blocs code markdown si présents
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    // Enlever les lignes qui ne sont pas du JSON
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
    }

    const parsed = JSON.parse(jsonStr);
    return {
      ...parsed,
      aiGenerated: true,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Dream AI parse error: ${err.message}`);
    throw err;
  }
}

// ============================================================
// FONCTIONS INTERNES — Distillation rule-based (fallback)
// ============================================================

function ruleBasedDistillation(dailyMemories, narratives) {
  // Patterns récurrents
  const themeFreq = {};
  for (const mem of dailyMemories) {
    for (const t of mem.themes) {
      const norm = normalizeTheme(t);
      themeFreq[norm] = (themeFreq[norm] || 0) + 1;
    }
  }

  const patterns = Object.entries(themeFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({
      type: 'recurring',
      theme: key.replace(/_/g, ' '),
      frequency: `${count}/${dailyMemories.length} jours`,
      trend: count > dailyMemories.length * 0.5 ? 'stable' : 'emerging',
      note: `Présent ${count} jours sur ${dailyMemories.length}`,
    }));

  // Narratives depuis la mémoire narratives
  const narList = (narratives?.active || []).slice(0, 4).map(n => ({
    title: n.title,
    arc: `${n.dayCount} jours d'évolution`,
    key_moments: n.facts?.slice(-2).map(f => f.fact) || [],
    status: n.dayCount >= 5 ? 'peaked' : 'active',
  }));

  // Source dynamics
  const sourceFreq = {};
  for (const mem of dailyMemories) {
    for (const s of mem.sources) {
      sourceFreq[s] = (sourceFreq[s] || 0) + 1;
    }
  }
  const sourceDynamics = Object.entries(sourceFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({
      source,
      role: count > dailyMemories.length * 0.7 ? 'leader' : 'contributor',
      notes: `Présent ${count} jours`,
    }));

  return {
    patterns,
    narratives: narList,
    insights: [],
    source_dynamics: sourceDynamics,
    blind_spots: [],
    macro_trends: [],
    aiGenerated: false,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================
// FONCTIONS INTERNES — Construction du contexte riche pour CoT
// ============================================================

function buildRichContextString(dailyMemories, semantic, narratives, distilled, editorial) {
  let context = '## CONTEXTE MÉMOIRE (mémoire éditoriale long terme)\n\n';

  // 1. Narratives actives (priorité haute — fil rouge)
  if (narratives?.active?.length > 0) {
    context += '### Récits en cours (narratives)\n';
    context += 'Ces histoires traversent plusieurs jours. Situe l\'actualité du jour par rapport à ces récits :\n\n';
    for (const nar of narratives.active.slice(0, 4)) {
      const statusIcon = nar.dayCount >= 5 ? '🔴' : nar.dayCount >= 3 ? '🟡' : '🟢';
      context += `${statusIcon} **${nar.title}** (${nar.dayCount} jours, dernier: ${nar.lastSeen})\n`;
      if (nar.facts?.length > 0) {
        const lastFact = nar.facts[nar.facts.length - 1];
        context += `  Dernière évolution: ${lastFact.fact}\n`;
      }
    }
    context += '\n';
  }

  // 2. Connaissances distillées (insights de haut niveau)
  if (distilled) {
    if (distilled.insights?.length > 0) {
      context += '### Connaissances consolidées (rêve)\n';
      context += 'Patterns identifiés par analyse croisée des jours précédents :\n\n';
      for (const insight of distilled.insights.slice(0, 4)) {
        context += `- 💡 ${insight}\n`;
      }
      context += '\n';
    }

    if (distilled.macro_trends?.length > 0) {
      context += '### Tendances macro\n';
      for (const trend of distilled.macro_trends.slice(0, 3)) {
        context += `- 📈 **${trend.trend}** : ${trend.description}\n`;
      }
      context += '\n';
    }

    if (distilled.blind_spots?.length > 0) {
      context += '### Angles morts détectés\n';
      for (const bs of distilled.blind_spots.slice(0, 2)) {
        context += `- ⚠️ ${bs}\n`;
      }
      context += '\n';
    }
  }

  // 3. Thèmes sémantiques récurrents
  if (semantic && Object.keys(semantic.themes).length > 0) {
    context += '### Thèmes récurrents\n';
    const sorted = Object.entries(semantic.themes)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 6);

    for (const [key, data] of sorted) {
      const trend = data.count > 5 ? 'récurrent' : data.count > 2 ? 'émergent' : 'nouveau';
      const trendIcon = data.count > 5 ? '🔴' : data.count > 2 ? '🟡' : '🟢';
      context += `${trendIcon} **${data.name}** (${data.count}j, ${trend})\n`;
    }
    context += '\n';
  }

  // 4. Mémoire épisodique récente (derniers 3 jours, compact)
  if (dailyMemories.length > 0) {
    context += '### Revues récentes (derniers jours)\n';
    for (const mem of dailyMemories.slice(0, 3)) {
      const themesStr = mem.themes.slice(0, 3).join(', ') || 'sans thème';
      context += `- **${mem.date}** : ${themesStr} (${mem.articleCount} articles)\n`;
    }
    context += '\n';
  }

  // 5. Préférences éditoriales apprises
  if (editorial?.preferences?.length > 0) {
    context += '### Préférences apprises\n';
    for (const pref of editorial.preferences.slice(0, 3)) {
      context += `- 📝 ${pref.insight}\n`;
    }
    context += '\n';
  }

  // Instructions pour l'IA
  context += '### Instructions d\'utilisation de la mémoire\n';
  context += '- Si un sujet fait partie d\'une NARRATIVE en cours, situe l\'évolution dans le récit\n';
  context += '- Mentionne les TENDANCES MACRO quand l\'actualité du jour s\'inscrit dans ce cadre\n';
  context += '- Pour les thèmes RÉCURRENTS, indique si c\'est une continuité ou un changement\n';
  context += '- Si l\'actualité touche un ANGLE MORT identifié, accorde-lui une attention particulière\n';
  context += '- Ne répète PAS les informations déjà détaillées les jours précédents sauf évolution significative\n';
  context += '- Les CONNAISSANCES CONSOLIDÉES sont des patterns fiables — utilise-les pour enrichir l\'analyse\n';

  return context;
}

// ============================================================
// FONCTIONS INTERNES — Extraction depuis le texte de revue
// ============================================================

function extractThemesFromReview(reviewText) {
  const themes = [];
  const nonThemes = new Set([
    "L'ESSENTIEL DU JOUR", "ANALYSE THÉMATIQUE", "TENDANCES",
    "CHIFFRES CLÉS", "À SURVEILLER", "ESSENTIEL", "TENDANCES & PERSPECTIVES",
    "SOMMAIRE", "POINTS DE TENSION", "SOURCES", "POUR ALLER PLUS LOIN",
    "APPROFONDIR", "NOTE FINALE",
  ]);

  // Format éditorial : **1. Titre éditorial** ou **1. Titre : sous-titre**
  const editorialRegex = /^\*\*(\d+)\.[\s]+(.+?)(?:\s*[:：]\s*(.+?))?\*\*$/gm;
  let match;
  while ((match = editorialRegex.exec(reviewText)) !== null) {
    const title = match[2].trim();
    if (title.length > 5 && !nonThemes.has(title.toUpperCase())) {
      themes.push(title);
    }
  }

  // Format Smart Brevity legacy : **THÈME 1** suivi de :
  const sectionRegex = /\*\*([^*\d]{3,40})\*\*\s*[:：]/g;
  while ((match = sectionRegex.exec(reviewText)) !== null) {
    const theme = match[1].trim();
    if (!nonThemes.has(theme.toUpperCase()) && !themes.includes(theme)) {
      themes.push(theme);
    }
  }

  // Format axiom legacy : **Bold Axiom :**
  const axiomRegex = /\*\*([^*]{2,25})\s*[:：]\*\*/g;
  while ((match = axiomRegex.exec(reviewText)) !== null) {
    const axiom = match[1].trim();
    if (axiom.length > 3 && axiom.length < 25 && !nonThemes.has(axiom.toUpperCase()) && !themes.includes(axiom)) {
      themes.push(axiom);
    }
  }

  return [...new Set(themes)].slice(0, 12);
}

function extractKeyFacts(reviewText) {
  const facts = [];
  const seen = new Set();

  // 1. Lignes à puces substantielles (30-250 chars)
  const bulletRegex = /^-\s+(.{30,250})$/gm;
  let match;
  while ((match = bulletRegex.exec(reviewText)) !== null) {
    const fact = match[1].trim();
    // Exclure les lignes qui sont juste des titres de sections ou des liens
    if (!fact.startsWith('**') && !fact.startsWith('http') && !seen.has(fact.substring(0, 50))) {
      facts.push(fact);
      seen.add(fact.substring(0, 50));
    }
  }

  // 2. Phrases avec des chiffres précis dans les paragraphes (signal de faits durs)
  const numberRegex = /[^.!?]*(?:\d{2,}|\d+\s*(?:millions?|milliards?|%|morts?|blessés?|personnes|jours|ans))[^.!?]*[.!?]/gi;
  while ((match = numberRegex.exec(reviewText)) !== null) {
    const fact = match[0].trim();
    if (fact.length > 30 && fact.length < 250 && !seen.has(fact.substring(0, 50))) {
      facts.push(fact);
      seen.add(fact.substring(0, 50));
    }
  }

  return [...new Set(facts)].slice(0, 15);
}

function extractActors(reviewText) {
  const actors = new Set();
  let match;

  // 1. Noms propres en gras (2+ mots commençant par majuscule)
  const boldNameRegex = /\*\*([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇÆŒ][a-zàâéèêëîïôùûüçæœ]+(?:\s+[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇÆŒ][a-zàâéèêëîïôùûüçæœ]+){0,3})\*\*/g;
  while ((match = boldNameRegex.exec(reviewText)) !== null) {
    const name = match[1].trim();
    // Exclure les titres de sections (commençant par un chiffre ou trop longs)
    if (!/^\d/.test(name) && name.length < 40 && name.split(/\s+/).length >= 2) {
      actors.add(name);
    }
  }

  // 2. Après « Selon », « D'après »
  const selonRegex = /(?:Selon|D'après)\s+([^,.]{2,40})/gi;
  while ((match = selonRegex.exec(reviewText)) !== null) {
    const name = match[1].trim();
    // Garder si ça ressemble à un nom propre (majuscule au début)
    if (/^[A-ZÀÂÉÈÊËÎÏÔÙÛÜÇÆŒ]/.test(name) && name.length > 2) {
      actors.add(name);
    }
  }

  // 3. Noms propres entre guillemets suivis d'une source
  const quoteActorRegex = /«\s*[^»]{10,200}\s*»\s*[—–-]\s*([A-ZÀÂÉÈÊËÎÏÔÙÛÜÇÆŒ][a-zàâéèêëîïôùûüçæœ\s]{2,35})/g;
  while ((match = quoteActorRegex.exec(reviewText)) !== null) {
    actors.add(match[1].trim());
  }

  // 4. Liste élargie de figures connues (pattern flexible)
  const knownFigures = [
    'Macron', 'Barnier', 'Le Pen', 'Mélenchon', 'Scholz', 'Trump', 'Biden',
    'Xi', 'Poutine', 'Starmer', 'Lula', 'Milei', 'Zelensky', 'Netanyahu',
    'Mitsotakis', 'Maréchal', 'Darmanin', 'Attal', 'Borne', 'Castex',
    'Von der Leyen', 'Blinken', 'Lavrov', 'Khamenei', 'Modi', 'Meloni',
  ];
  for (const figure of knownFigures) {
    if (reviewText.includes(figure)) actors.add(figure);
  }

  return [...actors].slice(0, 15);
}

// ============================================================
// FONCTIONS INTERNES — Extraction d'entités (pays, orgs, lieux)
// ============================================================

function extractEntities(reviewText) {
  const entities = { countries: new Set(), organizations: new Set(), places: new Set() };

  // Pays (liste des principaux pays cités dans une revue de presse francophone)
  const countries = [
    'France', 'États-Unis', 'USA', 'Chine', 'Russie', 'Ukraine', 'Allemagne',
    'Royaume-Uni', 'Grèce', 'Espagne', 'Italie', 'Argentine', 'Brésil', 'Venezuela',
    'Iran', 'Israël', 'Palestine', 'Gaza', 'Cisjordanie', 'Liban', 'Syrie',
    'Turquie', 'Inde', 'Japon', 'Corée', 'Maroc', 'Sénégal', 'Algérie',
    'Tunisie', 'Mozambique', 'Pologne', 'Hongrie', 'Roumanie', 'Tchéquie',
    'Moldavie', 'Géorgie', 'Arménie', 'Azerbaïdjan', 'Mali', 'Niger', 'Tchad',
    'Sahel', 'Kanaky', 'Nouvelle-Calédonie', 'Taïwan', 'Colombie', 'Mexique',
    'Cuba', 'Haïti', 'RD Congo', 'RDC', 'Égypte', 'Arabie Saoudite',
  ];
  for (const c of countries) {
    if (reviewText.includes(c)) entities.countries.add(c);
  }

  // Organisations
  const orgs = [
    'UE', 'Union européenne', 'OTAN', 'ONU', 'FMI', 'Banque mondiale',
    'Banque centrale', 'BCE', 'Fed', 'G7', 'G20', 'OCI',
    'Parlement européen', 'Commission européenne', 'Conseil européen',
    'Assemblée nationale', 'Sénat', 'Conseil constitutionnel',
    'Cour internationale de justice', 'CIJ', 'CPI', 'Cour pénale',
    'Amnesty International', 'Human Rights Watch', 'MSF', 'Croix-Rouge',
    'TotalEnergies', 'EDF', 'Airbus', 'LVMH',
    'Front national', 'Rassemblement national', 'RN', 'LFI',
    'France Insoumise', 'EELV', 'Nupes', 'Nouvelle-Démocratie',
    'Union européenne', 'Hamas', 'Hezbollah', 'OTAN',
  ];
  for (const o of orgs) {
    if (reviewText.includes(o)) entities.organizations.add(o);
  }

  return {
    countries: [...entities.countries].slice(0, 10),
    organizations: [...entities.organizations].slice(0, 10),
    places: [...entities.places].slice(0, 5),
  };
}

/**
 * Stocke le score de qualité d'une revue (issu du STAGE4)
 * KV: memory:quality:YYYY-MM-DD  (TTL 90j)
 */
export async function saveQualityScore(env, dateStr, score, reviewContent) {
  const key = `${MEM_PREFIX}quality:${dateStr}`;
  await env.CACHE.put(key, JSON.stringify({
    date: dateStr,
    score,
    wordCount: reviewContent.split(/\s+/).length,
    themesCount: (reviewContent.match(/^\*\*\d+\./gm) || []).length,
    hasPointsDeTension: reviewContent.includes('Points de tension'),
    hasSurveiller: reviewContent.includes('À surveiller'),
    createdAt: new Date().toISOString(),
  }), { expirationTtl: 90 * 24 * 3600 });
}

/**
 * Met à jour l'index des jours avec mémoires (optimisation KV)
 * KV: memory:day_index  (TTL 365j)
 */
async function updateDayIndex(env, dateStr) {
  const key = `${MEM_PREFIX}day_index`;
  const raw = await env.CACHE.get(key);
  let index = raw ? JSON.parse(raw) : { days: [] };
  if (!index.days.includes(dateStr)) {
    index.days.push(dateStr);
    index.days.sort();
    // Garder max 60 jours
    index.days = index.days.slice(-60);
    await env.CACHE.put(key, JSON.stringify(index), { expirationTtl: 365 * 24 * 3600 });
  }
  return index;
}

function normalizeTheme(theme) {
  return theme
    .toLowerCase()
    .replace(/[^a-zàâéèêëïîôùûüÿçœæ0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50);
}

function computeThemeSimilarity(a, b) {
  const wordsA = new Set(a.split(/[\s_]+/));
  const wordsB = new Set(b.split(/[\s_]+/));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

function daysBetween(dateStr1, dateStr2) {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  return Math.round(Math.abs(d2 - d1) / (24 * 3600 * 1000));
}