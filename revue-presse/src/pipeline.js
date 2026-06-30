// ============================================================
// pipeline.js — Orchestration des 3 phases du traitement
// Phase 1 (FETCH) → KV → Phase 2 (ANALYZE) → KV → Phase 3 (DELIVER)
// ============================================================

import { fetchAllFeeds, fetchFullArticle } from './fetcher.js';
import { extractTextFromHTML, isPaywallPage, extractMetadata } from './extractor.js';
import { generatePressReview } from './ai.js';
import { buildEmailHTML, buildSubject, sendEmail } from './email.js';

const KV_KEY_ARTICLES = 'pipeline:articles';
const KV_KEY_REVIEW = 'pipeline:review';
const KV_KEY_STATUS = 'pipeline:status';
const KV_KEY_ERRORS = 'pipeline:errors';

// ============================================================
// PHASE 1 — FETCH : Récupérer RSS + extraire les articles complets
// ============================================================
export async function phaseFetch(env, eventTime) {
  const status = { phase: 'fetch', startedAt: eventTime.toISOString() };
  const errors = [];

  try {
    // 1. Récupérer tous les flux RSS
    const maxArticles = parseInt(env.MAX_ARTICLES) || 25;
    const maxWords = parseInt(env.MAX_WORDS_PER_ARTICLE) || 1500;

    status.step = 'rss_fetch';
    const feedResult = await fetchAllFeeds(maxArticles * 2); // En demander plus car certains échoueront

    status.foundInFeeds = feedResult.totalFound;
    errors.push(...feedResult.errors);

    // 2. Pour chaque article, récupérer le texte complet
    status.step = 'article_extraction';
    const processedArticles = [];

    for (const article of feedResult.articles) {
      // Si le RSS contient déjà le texte complet (flux "full" ou blogs WordPress), l'utiliser
      // hasFullContent = true → le flux RSS inclut le texte intégral
      // Sinon, vérifier si le contenu est assez long (>100 mots)
      let extractedText = '';

      if (article.fullContent && article.fullContent.split(/\s+/).length > 80) {
        // Nettoyer le HTML du contenu RSS
        extractedText = article.fullContent
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, maxWords * 8);
        article.extractionMethod = 'rss_full';
      }

      // Sinon, fetcher l'article complet (uniquement si nécessaire — économise le CPU)
      if (!extractedText || extractedText.split(/\s+/).length < 80) {
        const result = await fetchFullArticle(article.link, article.hasFullContent);

        if (result.success) {
          if (result.isMarkdown) {
            // r.jina.ai retourne du Markdown → utiliser directement
            extractedText = result.text;
            article.extractionMethod = result.method;
          } else if (result.html) {
            // Extraire le texte du HTML
            const extraction = extractTextFromHTML(result.html, maxWords);
            extractedText = extraction.text;
            article.extractionMethod = result.method;

            // Vérifier si c'est une page de paywall
            if (isPaywallPage(extractedText)) {
              article.extractionMethod += '+paywall_detected';
            }
          }
        }
      }

      if (extractedText && extractedText.split(/\s+/).length > 30) {
        article.extractedText = extractedText;
        article.extractedWords = extractedText.split(/\s+/).length;
        processedArticles.push(article);
      }

      // Respecter la limite d'articles
      if (processedArticles.length >= maxArticles) break;
    }

    // 3. Stocker dans KV pour la Phase 2
    status.step = 'kv_store';
    await env.CACHE.put(KV_KEY_ARTICLES, JSON.stringify({
      date: eventTime.toISOString(),
      articles: processedArticles,
      meta: {
        total: processedArticles.length,
        sources: [...new Set(processedArticles.map(a => a.sourceName))],
        errors: errors,
      },
    }), { expirationTtl: 3600 }); // Expire dans 1h

    status.success = true;
    status.articlesExtracted = processedArticles.length;
    status.sourcesUsed = [...new Set(processedArticles.map(a => a.sourceName))];

  } catch (err) {
    status.success = false;
    status.error = err.message;
    errors.push(`Phase FETCH: ${err.message}`);
  }

  // Stocker le statut
  await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });
  await env.CACHE.put(KV_KEY_ERRORS, JSON.stringify(errors), { expirationTtl: 86400 });

  return status;
}

// ============================================================
// PHASE 2 — ANALYZE : Appel IA pour générer la revue de presse
// ============================================================
export async function phaseAnalyze(env, eventTime) {
  const status = { phase: 'analyze', startedAt: eventTime.toISOString() };

  try {
    // 1. Lire les articles depuis KV
    status.step = 'kv_read';
    const articlesData = await env.CACHE.get(KV_KEY_ARTICLES);

    if (!articlesData) {
      status.success = false;
      status.error = 'Aucun article trouvé en KV. La Phase 1 a-t-elle bien fonctionné ?';
      await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });
      return status;
    }

    const { articles, meta } = JSON.parse(articlesData);

    if (articles.length === 0) {
      status.success = false;
      status.error = '0 article extrait pendant la Phase 1.';
      await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });
      return status;
    }

    status.articlesFound = articles.length;

    // 2. Appeler l'IA
    status.step = 'ai_call';
    const result = await generatePressReview(articles, env);

    // 3. Stocker la revue dans KV
    status.step = 'kv_store_review';
    await env.CACHE.put(KV_KEY_REVIEW, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      model: result.model,
      isFallback: result.isFallback || false,
      meta,
    }), { expirationTtl: 3600 });

    status.success = true;
    status.provider = result.provider;
    status.model = result.model;
    status.isFallback = result.isFallback || false;
    status.reviewLength = result.content.length;
    if (result.lastError) status.aiError = result.lastError;
    if (result.allErrors) status.aiAllErrors = result.allErrors;

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });

  return status;
}

// ============================================================
// PHASE 3 — DELIVER : Envoyer la revue de presse par email
// ============================================================
export async function phaseDeliver(env, eventTime) {
  const status = { phase: 'deliver', startedAt: eventTime.toISOString() };

  try {
    // 1. Lire la revue depuis KV
    status.step = 'kv_read_review';
    const reviewData = await env.CACHE.get(KV_KEY_REVIEW);

    if (!reviewData) {
      status.success = false;
      status.error = 'Aucune revue trouvée en KV. La Phase 2 a-t-elle bien fonctionné ?';
      await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });
      return status;
    }

    const review = JSON.parse(reviewData);

    // 2. Lire les articles pour les stats
    const articlesData = await env.CACHE.get(KV_KEY_ARTICLES);
    const articles = articlesData ? JSON.parse(articlesData).articles : [];

    // 3. Construire l'email
    status.step = 'build_email';
    const date = new Date(eventTime);
    const subject = buildSubject(date);
    const htmlContent = buildEmailHTML(review.content, articles, date);

    // 4. Envoyer via Resend
    status.step = 'send_email';
    const sendResult = await sendEmail(env, subject, htmlContent);

    status.success = true;
    status.emailId = sendResult.id;
    status.provider = review.provider;
    status.subject = subject;

    // Nettoyer les données KV (elles ont expiré de toute façon)
    await env.CACHE.delete(KV_KEY_ARTICLES);
    await env.CACHE.delete(KV_KEY_REVIEW);

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(KV_KEY_STATUS, JSON.stringify(status), { expirationTtl: 86400 });

  return status;
}

// ============================================================
// UTILITAIRES : Lecture du statut (pour le dashboard HTTP)
// ============================================================
export async function getStatus(env) {
  const statusRaw = await env.CACHE.get(KV_KEY_STATUS);
  const errorsRaw = await env.CACHE.get(KV_KEY_ERRORS);

  return {
    status: statusRaw ? JSON.parse(statusRaw) : null,
    errors: errorsRaw ? JSON.parse(errorsRaw) : [],
    kvNamespace: !!env.CACHE,
  };
}