// ============================================================
// pipeline.js — 8 phases du traitement CoT v3
// FETCH → FILTER → EXTRACT → THEME → DRAFT → REVIEW → SYNTHESIS → DELIVER
// FETCH parallélise RSS + 7 News APIs
// ============================================================

import { fetchAllFeeds } from './fetcher.js';
import { fetchAllNewsAPIs } from './news-apis.js';
import { filterAndSelect } from './filter.js';
import { stage1_extract, stage2_theme, stage3_draft, stage4_review, stage5_synthesis, generateFastReview } from './ai.js';
import { webSearchMultiLang } from './searcher.js';
import { buildEmailHTML, buildEmailText, buildSubject, sendEmail } from './email.js';
import { saveDailyMemory, updateSemanticMemory, updateNarratives, getMemoryContext, dreamDistill, saveQualityScore } from './memory.js';
import { getDocMemoryContext, crossReferenceWithPressReview, generateProspective } from './docmemory.js';

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
// PHASE 2 — FILTER : Dédup, scoring
// NOTE : Plus d'extraction texte ici (trop de sous-requêtes).
// On utilise le contenu RSS (fullContent ou description) tel quel.
// ============================================================
export async function phaseFilter(env, eventTime) {
  const status = { phase: 'filter', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const raw = await env.CACHE.get(KV_RAW_ARTICLES);
    if (!raw) throw new Error('Aucun article brut en KV. Phase FETCH exécutée ?');

    const { articles: allRaw, meta } = JSON.parse(raw);
    status.rawCount = allRaw.length;

    // Préparer le texte extrait à partir du contenu RSS uniquement (0 sous-requête)
    status.step = 'rss_content_prepare';
    const maxWords = parseInt(env.MAX_WORDS_PER_ARTICLE) || 1500;
    let extracted = 0;

    for (const article of allRaw) {
      let text = '';

      // Utiliser le fullContent RSS si disponible et substantiel
      if (article.fullContent && article.fullContent.split(/\s+/).length > 30) {
        text = article.fullContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        article.extractionMethod = 'rss_full';
      }

      // Sinon utiliser la description
      if (!text && article.description) {
        text = article.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        article.extractionMethod = 'rss_description';
      }

      // Tronquer si trop long
      if (text) {
        const words = text.split(/\s+/);
        if (words.length > maxWords) {
          text = words.slice(0, maxWords).join(' ');
        }
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

    // === EXTRACTION : toujours un seul appel IA (économie de sous-requêtes) ===
    status.step = 'ai_extract';

    const extractionResult = await stage1_extract(articles, env);

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

    // === RECHERCHE WEB COMPLÉMENTAIRE (1 seule requête pour économiser les sous-requêtes) ===
    status.step = 'web_search';
    let webResearch = [];
    const searchQueries = generateSearchQueries(themes);

    // Lancer uniquement la 1ère requête de recherche
    const searchBatches = await Promise.allSettled([
      webSearchMultiLang(searchQueries[0], ['fr'], 3, env),
    ]);

    const seenUrls = new Set();
    for (const batch of searchBatches) {
      if (batch.status === 'fulfilled') {
        for (const r of batch.value) {
          const clean = r.url?.split('?')[0].split('#')[0];
          if (clean && !seenUrls.has(clean)) {
            seenUrls.add(clean);
            webResearch.push(r);
          }
        }
      }
    }

    status.research = { queries: searchQueries.slice(0, 1), found: webResearch.length, details: webResearch.map(r => ({ title: r.title?.substring(0, 60), source: r.source })) };
    console.log(`[Phase Draft] Recherche web: ${webResearch.length} résultats complémentaires`);

    // === MÉMOIRE : récupérer le contexte éditorial long terme ===
    status.step = 'memory_context';
    let memoryContext = null;
    try {
      memoryContext = await getMemoryContext(env, 7);
      if (memoryContext) {
        console.log(`[Phase Draft] Mémoire éditoriale injectée (${memoryContext.length} chars)`);
      }
    } catch (err) {
      console.warn(`[Phase Draft] Mémoire éditoriale indisponible: ${err.message}`);
    }

    // === MÉMOIRE DOCUMENTAIRE : récupérer les claims pertinents pour les thèmes du jour ===
    try {
      // Extraire les thèmes du XML de thématisation pour la recherche documentaire
      const themeNames = [];
      const themeMatches = themes.matchAll(/<name>(.*?)<\/name>/g);
      for (const match of themeMatches) {
        const name = match[1].trim();
        if (name.length > 2) themeNames.push(name);
      }

      if (themeNames.length > 0) {
        const docContext = await getDocMemoryContext(env, themeNames, 8);
        if (docContext) {
          console.log(`[Phase Draft] Mémoire documentaire injectée (${docContext.length} chars)`);
          if (memoryContext) {
            memoryContext += docContext;
          } else {
            memoryContext = docContext;
          }
        }
      }
    } catch (err) {
      console.warn(`[Phase Draft] Mémoire documentaire indisponible: ${err.message}`);
    }

    status.step = 'ai_draft';
    const result = await stage3_draft(themes, articles, env, webResearch, memoryContext);

    await env.CACHE.put(KV_DRAFT, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      research: status.research,
      memoryInjected: !!memoryContext,
    }), { expirationTtl: 7200 });

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;
    status.memoryInjected = !!memoryContext;

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
// PHASE 7 — ÉTAPE 5 IA : Synthèse EIC + sauvegarde mémoire
// ============================================================
export async function phaseSynthesis(env, eventTime) {
  const status = { phase: 'synthesis', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const draftRaw = await env.CACHE.get(KV_DRAFT);
    const reviewRaw = await env.CACHE.get(KV_REVIEW);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!draftRaw || !reviewRaw || !articlesRaw) throw new Error('Données manquantes en KV.');

    const { content: draft } = JSON.parse(draftRaw);
    const { content: review } = JSON.parse(reviewRaw);
    const { articles, meta } = JSON.parse(articlesRaw);

    status.step = 'ai_synthesis';
    const result = await stage5_synthesis(draft, review, articles, env);

    await env.CACHE.put(KV_REVIEW_FINAL, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      meta,
      cotStages: ['extraction', 'theming', 'drafting', 'review', 'synthesis'],
    }), { expirationTtl: 7200 });

    // === MÉMOIRE : sauvegarder la revue du jour ===
    status.step = 'memory_save';
    try {
      const dateStr = eventTime.toISOString().split('T')[0];
      const dailyMemory = await saveDailyMemory(env, eventTime, result.content, articles);
      await updateSemanticMemory(env, dailyMemory);
      await updateNarratives(env, dailyMemory);

      // Extraire le score qualité depuis la review (STAGE4)
      const scoreMatch = review.match(/<score_global>(\d+(?:\.\d+)?)<\/score_global>/);
      if (scoreMatch) {
        await saveQualityScore(env, dateStr, parseFloat(scoreMatch[1]), result.content);
      }

      // === MÉMOIRE DOCUMENTAIRE : cross-référence avec les claims existants ===
      try {
        const themeNames = [];
        const tmMatch = result.content.matchAll(/^\*\*(\d+)\.\s*(.+?)(?:\s*[:：]\s*(.+?))?\*\*$/gm);
        for (const match of tmMatch) {
          if (match[2].length > 3) themeNames.push(match[2]);
        }
        if (themeNames.length > 0) {
          const crossRefResult = await crossReferenceWithPressReview(env, result.content, themeNames, eventTime);
          status.docMemoryCrossRef = crossRefResult;
          console.log(`[Phase Synthesis] Cross-référence doc: ${crossRefResult.updated} claims mis à jour`);
        }
      } catch (docErr) {
        console.warn(`[Phase Synthesis] Cross-référence doc échouée (non bloquante): ${docErr.message}`);
      }

      status.memorySaved = true;
      status.memoryThemes = dailyMemory.themes.length;
      status.memoryActors = dailyMemory.actors.length;
      console.log(`[Phase Synthesis] Mémoire sauvegardée: ${dailyMemory.themes.length} thèmes, ${dailyMemory.actors.length} acteurs`);
    } catch (memErr) {
      console.warn(`[Phase Synthesis] Erreur mémoire (non bloquante): ${memErr.message}`);
      status.memorySaved = false;
      status.memoryError = memErr.message;
    }

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
    const subject = buildSubject(date, review.content);
    const htmlContent = buildEmailHTML(review.content, articles, date, review.provider);
    const textContent = buildEmailText(review.content, articles, date);

    status.step = 'send_email';
    const sendResult = await sendEmail(env, subject, htmlContent, textContent);

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
// PHASE FALLBACK — Mode rapide (1 appel IA) pour garantir l'email
// Se déclenche si le pipeline CoT échoue à l'extraction ou à la synthèse
// ============================================================
export async function phaseFastFallback(env, eventTime) {
  const status = { phase: 'fast_fallback', startedAt: eventTime.toISOString(), step: 'kv_read' };

  try {
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!articlesRaw) throw new Error('Aucun article en KV. Phase FILTER exécutée ?');

    const { articles, meta } = JSON.parse(articlesRaw);
    status.step = 'memory_context';

    // Essayer d'obtenir le contexte mémoire (non bloquant)
    let memoryContext = null;
    try {
      memoryContext = await getMemoryContext(env, 7);
    } catch (e) { /* non bloquant */ }

    status.step = 'ai_fast_review';
    const result = await generateFastReview(articles, env, memoryContext);

    // Stocker comme revue finale
    status.step = 'kv_store';
    await env.CACHE.put(KV_REVIEW_FINAL, JSON.stringify({
      date: eventTime.toISOString(),
      content: result.content,
      provider: result.provider,
      meta,
      cotStages: ['fast_fallback'],
      isFallback: result.isFallback || false,
    }), { expirationTtl: 7200 });

    // Sauvegarder mémoire (non bloquant, best-effort)
    try {
      const dateStr = eventTime.toISOString().split('T')[0];
      const dailyMemory = await saveDailyMemory(env, eventTime, result.content, articles);
      await updateSemanticMemory(env, dailyMemory);
      await updateNarratives(env, dailyMemory);
      status.memorySaved = true;
    } catch (e) {
      console.warn(`[FastFallback] Mémoire non sauvegardée: ${e.message}`);
    }

    status.success = true;
    status.provider = result.provider;
    status.outputLength = result.content.length;
    status.mode = result.mode || 'fast';

  } catch (err) {
    status.success = false;
    status.error = err.message;
  }

  await env.CACHE.put(statusKey('fast_fallback'), JSON.stringify(status), { expirationTtl: 86400 });
  return status;
}

/**
 * Sauvegarde la mémoire en arrière-plan (pour ctx.waitUntil)
 */
export async function backgroundMemorySave(env, eventTime) {
  try {
    const reviewRaw = await env.CACHE.get(KV_REVIEW_FINAL);
    const articlesRaw = await env.CACHE.get(KV_ARTICLES);
    if (!reviewRaw || !articlesRaw) return;

    const { content } = JSON.parse(reviewRaw);
    const { articles } = JSON.parse(articlesRaw);
    const dateStr = eventTime.toISOString().split('T')[0];

    const dailyMemory = await saveDailyMemory(env, eventTime, content, articles);
    await updateSemanticMemory(env, dailyMemory);
    await updateNarratives(env, dailyMemory);

    // Rêve le vendredi (ou cross-référence documentaire quotidien)
    const dayOfWeek = eventTime.getDay();
    if (dayOfWeek === 5) {
      // Dream avec mémoire documentaire intégrée
      const docContext = await getDocMemoryContext(env, dailyMemory.themes, 5);
      if (docContext) {
        console.log(`[BackgroundMemory] Mémoire doc disponible pour le rêve`);
      }
      // Prospective scientifique (si documents ingérés)
      const prospective = await generateProspective(env, 30);
      if (prospective) {
        console.log(`[BackgroundMemory] Prospective générée: ${prospective.trends?.length || 0} tendances`);
        // Stocker la prospective en KV pour injection dans le prochain rêve
        await env.CACHE.put('memory:prospective', JSON.stringify({
          ...prospective,
          generatedAt: new Date().toISOString(),
        }), { expirationTtl: 30 * 24 * 3600 });
      }
      await dreamDistill(env, 14, false);
    }
  } catch (err) {
    console.warn(`[BackgroundMemory] Erreur: ${err.message}`);
  }
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