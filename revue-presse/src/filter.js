// ============================================================
// filter.js — Déduplication, scoring et sélection d'articles
// Après la collecte multi-sources (RSS + News APIs), ce module
// sélectionne les meilleurs articles pour le pipeline IA
// ============================================================

/**
 * Filtre et sélectionne les meilleurs articles
 * @param {Array} articles - Tous les articles (RSS + News APIs)
 * @param {Object} opts - { maxArticles, minWords, maxPerSource }
 * @returns {Object} - { selected, stats }
 */
export function filterAndSelect(articles, { maxArticles = 50, minWords = 20, maxPerSource = 8 } = {}) {
  // 1. Nettoyage : supprimer les articles sans titre ou trop courts
  const cleaned = articles.filter(a => {
    if (!a.title || a.title.length < 15) return false;
    const text = a.extractedText || a.description || a.fullContent || '';
    if (text.split(/\s+/).length < minWords) return false;
    return true;
  });

  // 2. Déduplication par similarité de titre
  const deduped = deduplicateByTitle(cleaned);

  // 3. Scoring
  const scored = deduped.map(a => ({ ...a, _score: scoreArticle(a) }));

  // 4. Trier par score décroissant
  scored.sort((a, b) => b._score - a._score);

  // 5. Limiter par source (pas plus de maxPerSource par source)
  const selected = [];
  const sourceCounts = {};

  for (const article of scored) {
    const src = article.sourceName;
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    if (sourceCounts[src] > maxPerSource) continue;
    selected.push(article);
    if (selected.length >= maxArticles) break;
  }

  // Stats
  const stats = {
    input: articles.length,
    afterClean: cleaned.length,
    afterDedup: deduped.length,
    selected: selected.length,
    sources: [...new Set(selected.map(a => a.sourceName))],
    avgScore: selected.length > 0
      ? (selected.reduce((s, a) => s + a._score, 0) / selected.length).toFixed(1)
      : 0,
  };

  // Retirer le _score des articles finaux
  const final = selected.map(({ _score, ...rest }) => rest);

  return { selected: final, stats };
}

// ============================================================
// Déduplication par similarité de titre
// ============================================================
function deduplicateByTitle(articles) {
  const seen = [];
  const result = [];

  for (const article of articles) {
    const title = normalizeTitle(article.title);
    let isDuplicate = false;

    for (const seenTitle of seen) {
      if (titleSimilarity(title, seenTitle) > 0.6) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.push(title);
      result.push(article);
    }
  }

  return result;
}

/**
 * Normalise un titre pour comparaison
 */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôùûüÿçœæ\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Similarité Jaccard entre deux titres normalisés
 */
function titleSimilarity(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2));
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ============================================================
// Scoring d'un article
// ============================================================
function scoreArticle(article) {
  let score = 50; // base

  // Bonus contenu complet
  const text = article.extractedText || article.description || article.fullContent || '';
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 300) score += 20;
  else if (wordCount > 100) score += 10;
  else if (wordCount > 50) score += 5;

  // Bonus source RSS (contenu plus fiable que les APIs)
  if (article.fetchStrategy === 'direct' || article.fetchStrategy === 'telegram_embed') {
    score += 15;
  }
  // Bonus source jina (contenu full)
  if (article.fetchStrategy === 'jina_html') score += 10;
  // Légèrement moins pour les news APIs (juste des titres/snippets)
  if (article.fetchStrategy === 'news_api') score -= 5;

  // Bonus source premium
  const premiumSources = ['Le Monde', 'Les Échos', 'Mediapart', 'NYT', 'Guardian'];
  if (premiumSources.some(s => article.sourceName.includes(s))) score += 10;

  // Bonus récence (articles d'aujourd'hui)
  if (article.pubDate) {
    const age = Date.now() - new Date(article.pubDate).getTime();
    if (age < 86400000) score += 10;      // < 24h
    else if (age < 172800000) score += 5;  // < 48h
  }

  // Bonus diversité catégorie
  const diverseCategories = ['economie', 'international', 'presse_nationale'];
  if (diverseCategories.includes(article.sourceCategory)) score += 5;

  // Pénalité titres trop génériques
  const genericWords = ['newsletter', 'podcast', 'abonnez', 'inscription'];
  if (genericWords.some(w => article.title.toLowerCase().includes(w))) score -= 30;

  return Math.max(0, Math.min(100, score));
}