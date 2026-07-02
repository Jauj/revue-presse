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

  // 5. Sélection avec diversité des sources
  //    Round-robin pondéré : on remplit en garantissant qu'aucune source
  //    ne domine trop, tout en respectant le score
  const selected = [];
  const sourceCounts = {};

  // Premier passage : prendre le meilleur de chaque source (diversité max)
  const bestPerSource = new Map();
  for (const article of scored) {
    const src = article.sourceName;
    if (!bestPerSource.has(src)) {
      bestPerSource.has(src); // just checking
      bestPerSource.set(src, article);
    }
  }
  // Ajouter les meilleurs de chaque source (triés par score)
  const diversityOrder = [...bestPerSource.values()].sort((a, b) => b._score - a._score);
  for (const article of diversityOrder) {
    if (selected.length >= maxArticles) break;
    selected.push(article);
    sourceCounts[article.sourceName] = 1;
  }

  // Deuxième passage : remplir les places restantes par score, avec maxPerSource
  for (const article of scored) {
    if (selected.length >= maxArticles) break;
    const src = article.sourceName;
    if ((sourceCounts[src] || 0) >= maxPerSource) continue;
    if (selected.includes(article)) continue; // déjà pris dans le 1er passage
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    selected.push(article);
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

  // === Contenu textuel ===
  const text = article.extractedText || article.description || article.fullContent || '';
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 500) score += 25;      // Article complet = très valorisé
  else if (wordCount > 300) score += 20;
  else if (wordCount > 100) score += 10;
  else if (wordCount > 50) score += 5;

  // === Source / stratégie de fetch ===
  if (article.fetchStrategy === 'direct' || article.fetchStrategy === 'telegram_embed') {
    score += 15;  // RSS direct = fiable, contenu riche
  }
  if (article.fetchStrategy === 'jina_html') score += 10;
  if (article.fetchStrategy === 'news_api') {
    // Les news APIs n'ont souvent qu'un snippet — pénalité modérée
    score -= 5;
    // Mais bonus si la description est longue (signe d'un bon résumé)
    if (wordCount > 50) score += 5;
  }

  // === Bonus source premium ===
  const premiumSources = ['Le Monde', 'Les Échos', 'Mediapart', 'NYT', 'Guardian', 'CEPII'];
  if (premiumSources.some(s => article.sourceName.includes(s))) score += 10;

  // === Bonus diversité linguistique ===
  if (article.sourceLang === 'en') score += 5; // Sources anglophones = valeur ajoutée

  // === Récence ===
  if (article.pubDate) {
    const age = Date.now() - new Date(article.pubDate).getTime();
    if (age < 43200000) score += 15;       // < 12h = très frais
    else if (age < 86400000) score += 10;  // < 24h
    else if (age < 172800000) score += 5;  // < 48h
    else score -= 10;                       // > 48h = potentiellement périmé
  }

  // === Diversité catégorie ===
  const diverseCategories = ['economie', 'international', 'presse_nationale'];
  if (diverseCategories.includes(article.sourceCategory)) score += 5;

  // === Pénalités ===
  // Titres trop génériques (pas des vrais articles)
  const genericWords = ['newsletter', 'podcast', 'abonnez', 'inscription', 's\'abonner'];
  if (genericWords.some(w => article.title.toLowerCase().includes(w))) score -= 30;

  // Titres tout en majuscules (souvent des alertes/breaking news non substantielles)
  if (article.title === article.title.toUpperCase() && article.title.length > 20) score -= 5;

  return Math.max(0, Math.min(100, score));
}