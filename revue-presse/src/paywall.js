// ============================================================
// paywall.js — Contournement de paywalls multi-stratégies
// Ordre de priorité optimisé pour les médias français
// Inspiré de : magnolia1234/bypass-paywalls-clean
// ============================================================

import { extractTextFromHTML as extractText } from './extractor.js';

// --- Headers de contournement ---

const GOOGLEBOT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Referer': 'https://www.google.com/',
  'X-Forwarded-For': '66.249.66.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

const FACEBOOK_BOT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FacebookBot/1.0; +http://www.facebook.com/externalhit_uatext.php)',
  'Referer': 'https://www.facebook.com/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

// --- Mapping domaine → stratégie optimale ---

const DOMAIN_STRATEGIES = {
  // Le Monde : GoogleBot fonctionne, sinon FacebookBot
  'lemonde.fr': ['googlebot', 'facebook', 'archive'],
  'lemonde': ['googlebot', 'facebook', 'archive'],

  // Les Échos : FacebookBot parfois, GoogleBot
  'lesechos.fr': ['facebook', 'googlebot', 'archive'],
  'lesechos': ['facebook', 'googlebot', 'archive'],

  // Mediapart : HTML direct fonctionne souvent
  'mediapart.fr': ['browser', 'googlebot', 'archive'],
  'mediapart': ['browser', 'googlebot', 'archive'],

  // Le Figaro
  'lefigaro.fr': ['googlebot', 'facebook', 'archive'],
  'lefigaro': ['googlebot', 'facebook', 'archive'],

  // Le Parisien
  'leparisien.fr': ['googlebot', 'facebook', 'archive'],

  // Libération
  'liberation.fr': ['googlebot', 'browser', 'archive'],

  // Courrier International
  'courrierinternational.com': ['browser', 'googlebot', 'archive'],

  // Alternatives Économiques
  'alternatives-economiques.fr': ['googlebot', 'browser', 'archive'],
};

// --- Fonctions de fetch par stratégie ---

async function fetchWithHeaders(url, headers) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function fetchArchive(url) {
  // Wayback Machine : dernière version archivée
  const archiveUrl = `https://web.archive.org/web/2024/${url}`;
  const response = await fetch(archiveUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!response.ok) {
    // Essayer sans la date (redirection auto vers la dernière version)
    const archiveUrl2 = `https://web.archive.org/web/${url}`;
    const resp2 = await fetch(archiveUrl2, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Accept': 'text/html' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!resp2.ok) throw new Error(`Archive HTTP ${resp2.status}`);
    return await resp2.text();
  }
  return await response.text();
}

async function fetchGoogleCache(url) {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
  const response = await fetch(cacheUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`Google Cache HTTP ${response.status}`);
  return await response.text();
}

async function fetchJina(url) {
  // Jina Reader — nécessite un budget limité
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
    },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`Jina HTTP ${response.status}`);
  const text = await response.text();
  // Jina retourne du texte avec des headers — nettoyer
  const lines = text.split('\n');
  const contentStart = lines.findIndex(l => l.startsWith('#')) || 0;
  return lines.slice(contentStart).join('\n');
}

async function fetch12ft(url) {
  const proxyUrl = `https://12ft.io/proxy?q=${encodeURIComponent(url)}`;
  const response = await fetch(proxyUrl, {
    headers: {
      'User-Agent': BROWSER_HEADERS['User-Agent'],
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`12ft HTTP ${response.status}`);
  return await response.text();
}

// --- Mapping nom stratégie → fonction ---

const STRATEGY_FNS = {
  googlebot: (url) => fetchWithHeaders(url, GOOGLEBOT_HEADERS),
  facebook: (url) => fetchWithHeaders(url, FACEBOOK_BOT_HEADERS),
  browser: (url) => fetchWithHeaders(url, BROWSER_HEADERS),
  archive: (url) => fetchArchive(url),
  googlecache: (url) => fetchGoogleCache(url),
  jina: (url) => fetchJina(url),
  '12ft': (url) => fetch12ft(url),
};

// --- API principale ---

/**
 * Tente de récupérer le contenu d'un article en contournant le paywall.
 * Essaie les stratégies dans l'ordre, retourne le premier résultat suffisant.
 *
 * @param {string} url - URL de l'article
 * @param {object} env - Environment Cloudflare (pour Jina API key si dispo)
 * @param {object} options - { maxWords: 1500, skipJina: false, preferStrategies: [] }
 * @returns {{ text: string, method: string, words: number } | null}
 */
export async function fetchWithBypass(url, env, options = {}) {
  const { maxWords = 1500, skipJina = false } = options;

  // Déterminer l'ordre des stratégies pour ce domaine
  const domain = (() => {
    try { return new URL(url).hostname.replace('www.', ''); } catch { return ''; }
  })();

  // Trouver la stratégie optimale pour ce domaine
  let strategyOrder = ['googlebot', 'facebook', 'browser', 'archive', 'googlecache'];
  if (!skipJina) strategyOrder.push('jina');

  // Vérifier si un mapping spécifique existe
  for (const [pattern, strategies] of Object.entries(DOMAIN_STRATEGIES)) {
    if (domain.includes(pattern)) {
      // Compléter avec les stratégies non listées
      const specific = strategies.filter(s => !strategyOrder.includes(s));
      const rest = strategyOrder.filter(s => !strategies.includes(s));
      strategyOrder = [...specific, ...rest];
      break;
    }
  }

  // Vérifier le budget Jina
  if (skipJina || !env.JINA_API_KEY) {
    strategyOrder = strategyOrder.filter(s => s !== 'jina');
  }

  // Limiter Jina en position tardive
  if (strategyOrder.includes('jina')) {
    strategyOrder = strategyOrder.filter(s => s !== 'jina');
    strategyOrder.push('jina');
  }

  for (const strategyName of strategyOrder) {
    const fn = STRATEGY_FNS[strategyName];
    if (!fn) continue;

    try {
      const startTime = Date.now();
      let rawContent;

      if (strategyName === 'jina') {
        // Jina retourne du texte brut directement
        rawContent = await fn(url);
      } else {
        // Les autres retournent du HTML à parser
        const html = await fn(url);
        rawContent = extractText(html);
      }

      const elapsed = Date.now() - startTime;
      const words = rawContent.split(/\s+/).filter(w => w.length > 0).length;

      // Filtrer le contenu trop court ou les pages de paywall
      if (words < 100) continue;
      if (isPaywallContent(rawContent)) continue;

      const text = rawContent.split(/\s+/).slice(0, maxWords).join(' ');

      console.log(`Bypass [${strategyName}] ${domain}: ${words} mots en ${elapsed}ms`);
      return { text, method: strategyName, words: Math.min(words, maxWords) };

    } catch (e) {
      console.log(`Bypass [${strategyName}] ${domain}: ${e.message}`);
      continue;
    }
  }

  return null;
}

/**
 * Enrichit un article avec du contenu via bypass paywall
 * Ne réessaie pas si l'article a déjà assez de contenu
 *
 * @param {object} article - Article avec .link et .extractedText
 * @param {object} env - Environment
 * @param {number} thresholdWords - Seuil en dessous duquel on tente le bypass
 * @returns {boolean} true si l'article a été enrichi
 */
export async function enrichArticle(article, env, thresholdWords = 300) {
  if (!article.link) return false;

  const currentWords = (article.extractedText || '').split(/\s+/).length;
  if (currentWords >= thresholdWords) return false;

  const result = await fetchWithBypass(article.link, env, {
    maxWords: parseInt(env.MAX_WORDS_PER_ARTICLE) || 1500,
  });

  if (result && result.words > currentWords) {
    article.extractedText = result.text;
    article.extractedWords = result.words;
    article.extractionMethod = `bypass_${result.method}`;
    return true;
  }

  return false;
}

/**
 * Détecte si le contenu est une page de paywall et non l'article réel
 */
function isPaywallContent(text) {
  const paywallIndicators = [
    'pour accéder à ce contenu',
    'réservé aux abonnés',
    'cet article est réservé',
    'vous devez être abonné',
    'subscribe to continue reading',
    'subscription required',
    'paywall',
    's\'abonner pour continuer',
    'abonnez-vous pour lire',
    'accès réservé aux abonnés',
  ];

  const lowerText = text.toLowerCase().substring(0, 2000);
  let matchCount = 0;
  for (const indicator of paywallIndicators) {
    if (lowerText.includes(indicator)) matchCount++;
  }

  // Si 2+ indicateurs dans les 2000 premiers caractères, c'est probablement un paywall
  return matchCount >= 2;
}

/**
 * Vérifie si une URL est potentiellement derrière un paywall
 * (pour décider s'il faut tenter le bypass)
 */
export function isLikelyPaywalled(url) {
  const paywallDomains = [
    'lemonde.fr', 'lesechos.fr', 'lefigaro.fr', 'leparisien.fr',
    'liberation.fr', 'courrierinternational.com', 'alternatives-economiques.fr',
    'latribune.fr', 'lesoir.be', 'lalib.be',
    'ft.com', 'economist.com', 'nytimes.com', 'washingtonpost.com',
    'wsj.com', 'bloomberg.com', 'theatlantic.com',
  ];

  try {
    const domain = new URL(url).hostname.replace('www.', '');
    return paywallDomains.some(d => domain.includes(d));
  } catch {
    return false;
  }
}