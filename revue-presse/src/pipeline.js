// ============================================================
// pipeline.js — 8 phases du traitement CoT v3
// FETCH → FILTER → EXTRACT → THEME → DRAFT → REVIEW → SYNTHESIS → DELIVER
// FETCH parallélise RSS + 7 News APIs
// ============================================================

import { fetchAllFeeds, fetchFullArticle } from './fetcher.js';
import { fetchAllNewsAPIs } from './news-apis.js';
import { filterAndSelect } from './filter.js';
import { extractTextFromHTML, isPaywallPage } from './extractor.js';
import { stage1_extract, stage2_theme, stage3_draft, stage4_review, stage5_synthesis } from './ai.js';
import { webSearchMultiLang } from './searcher.js';
import { buildEmailHTML, buildSubject, sendEmail } from './email.js';

// Clés KV pour le bus inter-phases
const KV_RAW_ARTICLES = 'pipeline:raw_articles';      // après FETCH (brut, non dédupliqué)
const KV_ARTICLES = 'pipeline:articles';               // après FILTER (sélectionnés, extraits)
const KV_EXTRACTION = 'pipeline:stage1_extraction';
const KV_THEMES = 'pipeline:stage2_themes';
const KV_DRAFT = 'pipeline:stage3_draft';
const KV_REVIEW = 'pipeline:stage4_review';
const KV_SYNTHESIS = 'pipeline:stage5_synthesis';
const KV_REVIEW_FINAL = 'pipeline:review_final';
const KV_STATUS = 'pipeline:status';
const KV_ERRORS = 'pipeline:errors';

function statusKey(phase) { return `pipeline:phase_${phase}_status`; }

// ============================================================
// PHASE 1 — FETCH : Récupérer RSS + News APIs en parallèle
// ============================================================
export async function phaseFetch(env, eventTime) {
  const status = { phase: 'fetch', startedAt: eventTime.toISOString(), step: 'init', version: '3.0' };
  const errors = [];

  try {
    // === PARALLÈLE : RSS + News APIs ===
    status.step = 'parallel_fetch';

    const [feedResult, newsApiResult] = await Promise.allSettled([
      fetchAllFeeds(60),  // RSS : jusqu'à 60 candidats
      fetchAllNewsAPIs(env, { maxPerSource: 10, daysBack: 2 }),
    ]);

    // Traiter les résultats RSS
    let rssArticles = [];
    let rssSourceStatus = {};
    if (feedResult.status === 'fulfilled') {
      rssArticles = feedResult.value.articles;
      rssSourceStatus = feedResult.value.sourceStatus;
      errors.push(...(feedResult.value.errors || []));
      status.rssSources = Object.keys(rssSourceStatus).length;
      status.rssFound = rssArticles.length;
    } else {
      errors.push(`RSS fetch: ${feedResult.reason?.message}`);
    }

    // Traiter les résultats News APIs
    let apiArticles = [];
    let apiSourceStatus = {};
    if (newsApiResult.status === 'fulfilled') {
      apiArticles = newsApiResult.value.articles;
      apiSourceStatus = newsApiResult.value.sourceStatus;
      status.apiSources = Object.keys(apiSourceStatus).length;
      status.apiFound = apiArticles.length;
    } else {
      errors.push(`News APIs: ${newsApiResult.reason?.message}`);
    }

    // Combiner TOUT (les news APIs n'ont pas de texte complet)
    const allRaw = [...rssArticles, ...apiArticles];

    // Stocker en KV brut (pour la phase FILTER)
    status.step = 'kv_store';
    await env.CACHE.put(KV_RAW_ARTICLES, JSON.stringify({
      date: eventTime.toISOString(),
      articles: allRaw,
      meta: {
        total: allRaw.length,
        rssCount: rssArticles.length,
        apiCount: apiArticles.length,
        sources: [...new Set(allRaw.map(a => a.sourceName))],
        errors,
        rssSourceStatus,
        apiSourceStatus,
      },
    }), { expirationTtl: 7200 });

    status.success = true;
    status.totalRaw = allRaw.length;
    status.sourceStatus = { ...rssSourceStatus, ...apiSourceStatus };
    status.foundInFeeds = rssArticles.length;

  } catch (err) {
    status.success = false;
    status.error = err.message;
    errors.push(`Phase FETCH: ${err.message}`);
  }

  await env.CACHE.put(KV_STATUS, JSON.stringify(status), { expirationTtl: 86400 });
  await env.CACHE.put(KV_ERRORS, JSON.stringify(errors), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 2 — FILTER : Dédup, scoring, extraction texte
// ============================================================
export async function phaseFilter(env, eventTime) {
  const status = { phase: 'filter', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const raw = await env.CACHE.get(KV_RAW_ARTICLES);
    if (!raw) throw new Error('Aucun article brut en KV. Phase FETCH exécutée ?');

    const { articles: allRaw, meta } = JSON.parse(raw);
    status.rawCount = allRaw.length;

    // Extraire le texte complet pour les articles RSS (pas les news APIs)
    status.step = 'text_extraction';
    const maxWords = parseInt(env.MAX_WORDS_PER_ARTICLE) || 1500;
    let extracted = 0;

    for (const article of allRaw) {
      // Les articles des news APIs n'ont qu'un titre + description (pas de link utile)
      if (article.fetchStrategy === 'news_api') continue;

      let text = '';
      if (article.fullContent && article.fullContent.split(/\s+/).length > 80) {
        text = article.fullContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, maxWords * 8);
        article.extractionMethod = 'rss_full';
      }

      if (!text || text.split(/\s+/).length < 80) {
        try {
          const result = await fetchFullArticle(article.link, article.hasFullContent);
          if (result.success) {
            if (result.isMarkdown) {
              text = result.text;
            } else if (result.html) {
              const extraction = extractTextFromHTML(result.html, maxWords);
              text = extraction.text;
              if (isPaywallPage(text)) article.extractionMethod = 'paywall';
            }
            article.extractionMethod = article.extractionMethod || result.method;
          }
        } catch (e) { /* skip */ }
      }

      if (text && text.split(/\s+/).length > 30) {
        article.extractedText = text;
        article.extractedWords = text.split(/\s+/).length;
        extracted++;
      }
    }

    status.extracted = extracted;

    // Filtrer et sélectionner
    status.step = 'filter_select';
    const maxArticles = parseInt(env.MAX_ARTICLES) || 50;
    const { selected, stats } = filterAndSelect(allRaw, { maxArticles });

    // Stocker les articles sélectionnés
    status.step = 'kv_store';
    await env.CACHE.put(KV_ARTICLES, JSON.stringify({
      date: eventTime.toISOString(),
      articles: selected,
      meta: {
        ...meta,
        filterStats: stats,
        finalCount: selected.length,
      },
    }), { expirationTtl: 7200 });

    status.success = true;
    status.filterStats = stats;
    status.articlesSelected = selected.length;
    status.sourcesUsed = [...new Set(selected.map(a => a.sourceName))];

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('filter'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 3 — ÉTAPE 1 IA : Extraction des faits structurés
// ============================================================
export async function phaseExtract(env, eventTime) {
  const status = { phase: 'extract', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const raw = await env.CACHE.get(KV_ARTICLES);
    if (!raw) throw new Error('Aucun article en KV. Phase FILTER exécutée ?');
    const { articles, meta } = JSON.parse(raw);
    if (!articles.length) throw new Error('0 article sélectionné.');

    // === EXTRACTION PARALLÈLE par batch de catégorie ===
    status.step = 'parallel_extract';

    // Grouper par catégorie
    const batches = {};
    for (const a of articles) {
      const cat = a.sourceCategory || 'autre';
      if (!batches[cat]) batches[cat] = [];
      batches[cat].push(a);
    }

    // Si un seul batch ou trop petit, tout extraire en un appel
    const batchEntries = Object.entries(batches);
    let extractionResult;

    if (batchEntries.length <= 2 || articles.length <= 25) {
      // Un seul appel IA
      extractionResult = await stage1_extract(articles, env);
    } else {
      // Appels parallèles (max 3 concurrents)
      const batchKeys = Object.keys(batches);
      const mid = Math.ceil(batchKeys.length / 2);
      const batchA = batchKeys.slice(0, mid).flatMap(k => batches[k]);
      const batchB = batchKeys.slice(mid).flatMap(k => batches[k]);

      const [resultA, resultB] = await Promise.all([
        stage1_extract(batchA, env),
        stage1_extract(batchB, env),
      ]);

      // Fusionner les extractions
      extractionResult = {
        content: `<!-- Batch A (${batchA.length} articles) -->\n${resultA.content}\n\n<!-- Batch B (${batchB.length} articles) -->\n${resultB.content}`,
        provider: resultA.provider,
        parallel: true,
        batchA: { count: batchA.length, provider: resultA.provider },
        batchB: { count: batchB.length, provider: resultB.provider },
      };
    }

    await env.CACHE.put(KV_EXTRACTION, JSON.stringify({
      date: eventTime.toISOString(),
      content: extractionResult.content,
      provider: extractionResult.provider,
      meta,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = extractionResult.provider;
    status.outputLength = extractionResult.content.length;
    status.parallel = extractionResult.parallel || false;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('extract'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 4 — ÉTAPE 2 IA : Thématisation
// ============================================================
export async function phaseTheme(env, eventTime) {
  const status = { phase: 'theme', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const extractionRaw = await env.CACHE.get(KV_EXTRACTION);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!extractionRaw || !articlesRaw) throw new Error('Données manquantes en KV.');

    const extraction = JSON.parse(extractionRaw).content;
    const { articles } = JSON.parse(articlesRaw);

    status.step = 'ai_theme';
    const result = await stage2_theme(extraction, articles, env);

    await env.CACHE.put(KV_THEMES, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('theme'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 5 — ÉTAPE 3 IA : Rédaction du brouillon + Recherche web
// ============================================================
export async function phaseDraft(env, eventTime) {
  const status = { phase: 'draft', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const themesRaw = await env.CACHE.get(KV_THEMES);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!themesRaw || !articlesRaw) throw new Error('Données manquantes en KV.');

    const themes = JSON.parse(themesRaw).content;
    const { articles } = JSON.parse(articlesRaw);

    // === RECHERCHE WEB COMPLÉMENTAIRE ===
    status.step = 'web_search';
    let webResearch = [];
    const searchQueries = generateSearchQueries(themes);
    const allSearchResults = [];

    for (const query of searchQueries.slice(0, 3)) {
      const results = await webSearchMultiLang(query, ['fr', 'en'], 3, env);
      allSearchResults.push(...results);
    }

    const seenUrls = new Set();
    for (const r of allSearchResults) {
      const clean = r.url?.split('?')[0];
      if (!seenUrls.has(clean)) {
        seenUrls.add(clean);
        webResearch.push(r);
      }
    }

    status.research = { queries: searchQueries.slice(0, 3), found: webResearch.length, details: webResearch.map(r => ({ title: r.title?.substring(0, 60), source: r.source })) };
    console.log(`[Phase Draft] Recherche web: ${webResearch.length} résultats complémentaires`);

    status.step = 'ai_draft';
    const result = await stage3_draft(themes, articles, env, webResearch);

    await env.CACHE.put(KV_DRAFT, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      research: status.research,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('draft'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 6 — ÉTAPE 4 IA : Revue critique
// ============================================================
export async function phaseReview(env, eventTime) {
  const status = { phase: 'review', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const draftRaw = await env.CACHE.get(KV_DRAFT);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!draftRaw || !articlesRaw) throw new Error('Données manquantes en KV.');

    const draft = JSON.parse(draftRaw).content;
    const { articles } = JSON.parse(articlesRaw);

    status.step = 'ai_review';
    const result = await stage4_review(draft, articles, env);

    await env.CACHE.put(KV_REVIEW, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('review'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 7 — ÉTAPE 5 IA : Synthèse EIC (2 appels espacés de 3s)
// ============================================================
export async function phaseSynthesis(env, eventTime) {
  const status = { phase: 'synthesis', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const draftRaw = await env.CACHE.get(KV_DRAFT);
    const reviewRaw = await env.CACHE.get(KV_REVIEW);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!draftRaw || !reviewRaw || !articlesRaw) throw new Error('Données manquantes en KV.');

    const draft = JSON.parse(draftRaw).content;
    const review = JSON.parse(reviewRaw).content;
    const { articles } = JSON.parse(articlesRaw);

    status.step = 'ai_synthesis';
    const result = await stage5_synthesis(draft, review, articles, env);

    const articlesRaw2 = await env.CACHE.get(KV_ARTICLES);
    const meta = articlesRaw2 ? JSON.parse(articlesRaw2).meta : {};

    await env.CACHE.put(KV_REVIEW_FINAL, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      meta,
      cotStages: ['extraction', 'theming', 'drafting', 'review', 'synthesis'],
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('synthesis'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 8 — DELIVER : Envoi email
// ============================================================
export async function phaseDeliver(env, eventTime) {
  const status = { phase: 'deliver', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const reviewRaw = await env.CACHE.get(KV_REVIEW_FINAL);
    if (!reviewRaw) throw new Error('Aucune revue finale en KV. Pipeline CoT incomplet ?');

    const review = JSON.parse(reviewRaw);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    const articles = articlesRaw ? JSON.parse(articlesRaw).articles : [];

    status.step = 'build_email';
    const date = new Date(eventTime);
    const subject = buildSubject(date);
    const htmlContent = buildEmailHTML(review.content, articles, date);

    status.step = 'send_email';
    const sendResult = await sendEmail(env, subject, htmlContent);

    status.success = true;
    status.emailId = sendResult.id;
    status.provider = review.provider;
    status.cotStages = review.cotStages;
    status.subject = subject;

    // Nettoyer le KV
    for (const key of [KV_RAW_ARTICLES, KV_ARTICLES, KV_EXTRACTION, KV_THEMES, KV_DRAFT, KV_REVIEW, KV_SYNTHESIS, KV_REVIEW_FINAL]) {
      await env.CACHE.delete(key);
    }

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('deliver'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// UTILITAIRES
// ============================================================
export async function getStatus(env) {
  const statusRaw = await env.CACHE.get(KV_STATUS);
  const errorsRaw = await env.CACHE.get(KV_ERRORS);

  const phaseStatuses = {};
  for (const phase of ['filter', 'extract', 'theme', 'draft', 'review', 'synthesis', 'deliver']) {
    const raw = await env.CACHE.get(statusKey(phase));
    if (raw) phaseStatuses[phase] = JSON.parse(raw);
  }

  return {
    status: statusRaw ? JSON.parse(statusRaw) : null,
    errors: errorsRaw ? JSON.parse(errorsRaw) : [],
    cotPhases: phaseStatuses,
    kvNamespace: !!env.CACHE,
  };
}

// ============================================================
// Extraire des requêtes de recherche depuis les thèmes XML
// ============================================================
function generateSearchQueries(themesXML) {
  const queries = [];

  const themeMatches = themesXML.matchAll(/<name>(.*?)<\/name>/g);
  for (const match of themeMatches) {
    const themeName = match[1].trim();
    if (themeName && themeName.length > 2) {
      queries.push(`${themeName} actualités`);
    }
  }

  const missingMatch = themesXML.match(/<missing_angles>([\s\S]*?)<\/missing_angles>/);
  if (missingMatch) {
    const angles = missingMatch[1].trim().split('\n').filter(l => l.trim().length > 5);
    for (const angle of angles.slice(0, 2)) {
      const clean = angle.replace(/<[^>]*>/g, '').trim();
      if (clean.length > 3) queries.push(clean);
    }
  }

  if (queries.length < 2) {
    queries.push('actualités économie France', 'actualités politique internationale');
  }

  return queries.slice(0, 4);
}