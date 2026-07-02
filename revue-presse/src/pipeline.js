// ============================================================
// pipeline.js — 7 phases du traitement CoT
// Phase 1 (FETCH) → 2 (EXTRACT) → 3 (THEME) → 4 (DRAFT) →
//   5 (REVIEW) → 6 (SYNTHESIS) → 7 (DELIVER)
// Chaque phase = 1 cron trigger espacé de 3 min
// ============================================================

import { fetchAllFeeds, fetchFullArticle } from './fetcher.js';
import { extractTextFromHTML, isPaywallPage } from './extractor.js';
import { stage1_extract, stage2_theme, stage3_draft, stage4_review, stage5_synthesis } from './ai.js';
import { webSearchMultiLang } from './searcher.js';
import { buildEmailHTML, buildSubject, sendEmail } from './email.js';

// Clés KV pour le bus inter-phases
const KV_ARTICLES = 'pipeline:articles';
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
// PHASE 1 — FETCH : Récupérer RSS + extraire les articles
// ============================================================
export async function phaseFetch(env, eventTime) {
  const status = { phase: 'fetch', startedAt: eventTime.toISOString(), step: 'init' };
  const errors = [];

  try {
    const maxArticles = parseInt(env.MAX_ARTICLES) || 30;
    const maxWords = parseInt(env.MAX_WORDS_PER_ARTICLE) || 1500;

    // 1. Fetch RSS
    status.step = 'rss_fetch';
    const feedResult = await fetchAllFeeds(maxArticles * 2);
    status.foundInFeeds = feedResult.totalFound;
    status.sourceStatus = feedResult.sourceStatus;
    errors.push(...feedResult.errors);

    // 2. Extraire le texte complet des articles
    status.step = 'article_extraction';
    const processed = [];

    for (const article of feedResult.articles) {
      let extractedText = '';

      // Si le RSS a déjà le contenu complet
      if (article.fullContent && article.fullContent.split(/\s+/).length > 80) {
        extractedText = article.fullContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, maxWords * 8);
        article.extractionMethod = 'rss_full';
      }

      // Sinon, fetcher l'article
      if (!extractedText || extractedText.split(/\s+/).length < 80) {
        const result = await fetchFullArticle(article.link, article.hasFullContent);
        if (result.success) {
          if (result.isMarkdown) {
            extractedText = result.text;
            article.extractionMethod = result.method;
          } else if (result.html) {
            const extraction = extractTextFromHTML(result.html, maxWords);
            extractedText = extraction.text;
            article.extractionMethod = result.method;
            if (isPaywallPage(extractedText)) article.extractionMethod += '+paywall';
          }
        }
      }

      if (extractedText && extractedText.split(/\s+/).length > 30) {
        article.extractedText = extractedText;
        article.extractedWords = extractedText.split(/\s+/).length;
        processed.push(article);
      }
      if (processed.length >= maxArticles) break;
    }

    // 3. Stocker dans KV
    status.step = 'kv_store';
    await env.CACHE.put(KV_ARTICLES, JSON.stringify({
      date: eventTime.toISOString(),
      articles: processed,
      meta: {
        total: processed.length,
        sources: [...new Set(processed.map(a => a.sourceName))],
        errors,
      },
    }), { expirationTtl: 7200 }); // 2h TTL (pipeline CoT est plus long)

    status.success = true;
    status.articlesExtracted = processed.length;
    status.sourcesUsed = [...new Set(processed.map(a => a.sourceName))];

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
// PHASE 2 — ÉTAPE 1 IA : Extraction des faits structurés
// ============================================================
export async function phaseExtract(env, eventTime) {
  const status = { phase: 'extract', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const raw = await env.CACHE.get(KV_ARTICLES);
    if (!raw) throw new Error('Aucun article en KV. Phase 1 exécutée ?');
    const { articles, meta } = JSON.parse(raw);
    if (!articles.length) throw new Error('0 article extrait.');

    status.step = 'ai_extract';
    status.articlesFound = articles.length;
    const result = await stage1_extract(articles, env);

    await env.CACHE.put(KV_EXTRACTION, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      meta,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;
    status.stages = { extract: { started: eventTime.toISOString(), finished: new Date().toISOString(), provider: result.provider, length: result.content.length } };

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('extract'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

// ============================================================
// PHASE 3 — ÉTAPE 2 IA : Thématisation
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
// PHASE 4 — ÉTAPE 3 IA : Rédaction du brouillon
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

    // Dédupliquer par URL
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
// PHASE 5 — ÉTAPE 4 IA : Revue critique
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
// PHASE 6 — ÉTAPE 5 IA : Synthèse EIC (2 appels espacés de 10s)
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

    // Stocker la revue finale
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
// PHASE 7 — DELIVER : Envoi email
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
    for (const key of [KV_ARTICLES, KV_EXTRACTION, KV_THEMES, KV_DRAFT, KV_REVIEW, KV_SYNTHESIS, KV_REVIEW_FINAL]) {
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

  // Collecter le statut de chaque phase CoT
  const phaseStatuses = {};
  for (const phase of ['extract', 'theme', 'draft', 'review', 'synthesis', 'deliver']) {
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

  // Extraire les noms de thèmes du XML
  const themeMatches = themesXML.matchAll(/<name>(.*?)<\/name>/g);
  for (const match of themeMatches) {
    const themeName = match[1].trim();
    if (themeName && themeName.length > 2) {
      queries.push(`${themeName} actualités`);
    }
  }

  // Extraire les "missing_angles" si présents
  const missingMatch = themesXML.match(/<missing_angles>([\s\S]*?)<\/missing_angles>/);
  if (missingMatch) {
    const angles = missingMatch[1].trim().split('\n').filter(l => l.trim().length > 5);
    for (const angle of angles.slice(0, 2)) {
      const clean = angle.replace(/<[^>]*>/g, '').trim();
      if (clean.length > 3) queries.push(clean);
    }
  }

  // Fallback si pas assez de thèmes
  if (queries.length < 2) {
    queries.push('actualités économie France', 'actualités politique internationale');
  }

  return queries.slice(0, 4);
}