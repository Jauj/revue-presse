// ============================================================
// extractor.js — Extraction du texte depuis le HTML
// Stratégie : <article> > <main> > [role=article] > JSON-LD > body nettoyé
// Regex-only (pas de HTMLRewriter — plus léger et fiable dans CF Workers)
// ============================================================

/**
 * Extrait le texte propre d'un article HTML
 * Stratégie : <article> > <main> > [role=article] > JSON-LD > <body> nettoyé
 */
export function extractTextFromHTML(html, maxWords = 1500) {
  let bestContent = '';
  let bestSelector = 'none';

  // --- Stratégie 1 : Extraire depuis <article> ---
  const articleContent = extractElement(html, 'article');
  if (articleContent.length > bestContent.length) {
    bestContent = articleContent;
    bestSelector = 'article';
  }

  // --- Stratégie 2 : Extraire depuis <main> ---
  const mainContent = extractElement(html, 'main');
  if (mainContent.length > bestContent.length) {
    bestContent = mainContent;
    bestSelector = 'main';
  }

  // --- Stratégie 3 : Extraire depuis [role="article"] ---
  const roleContent = extractByAttr(html, 'role', 'article');
  if (roleContent.length > bestContent.length) {
    bestContent = roleContent;
    bestSelector = 'role=article';
  }

  // --- Stratégie 4 : JSON-LD articleBody (très fiable pour les articles structurés) ---
  if (bestContent.length < 500) {
    const jsonLdBody = extractJSONLDBody(html);
    if (jsonLdBody.length > bestContent.length) {
      bestContent = jsonLdBody;
      bestSelector = 'json-ld';
    }
  }

  // --- Stratégie 5 : Body complet nettoyé (fallback) ---
  if (bestContent.length < 300) {
    const bodyContent = extractBody(html);
    if (bodyContent.length > bestContent.length) {
      bestContent = bodyContent;
      bestSelector = 'body';
    }
  }

  // Nettoyage final
  let text = cleanText(bestContent);

  // Tronquer à maxWords
  if (maxWords) {
    text = truncateToWords(text, maxWords);
  }

  return {
    text,
    length: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    selector: bestSelector,
  };
}

/**
 * Extrait le contenu d'une balise spécifique via regex
 */
function extractElement(html, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = html.match(regex);
  if (match) {
    return stripTags(match[1]);
  }
  return '';
}

/**
 * Extrait le contenu d'un élément par attribut (ex: role="article")
 */
function extractByAttr(html, attrName, attrValue) {
  const regex = new RegExp(`<[^>]+\\s${attrName}=["']${attrValue}["'][^>]*>([\\s\\S]*?)</[^>]+>`, 'i');
  const match = html.match(regex);
  if (match) {
    return stripTags(match[1]);
  }
  return '';
}

/**
 * Extrait le articleBody depuis un script JSON-LD (très fiable)
 */
function extractJSONLDBody(html) {
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      // Chercher articleBody directement ou dans un tableau @graph
      const candidates = Array.isArray(data) ? data : [data];
      for (const item of candidates) {
        if (item.articleBody && item.articleBody.length > 200) {
          return item.articleBody;
        }
        // Parfois imbriqué dans @graph
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          for (const graphItem of item['@graph']) {
            if (graphItem.articleBody && graphItem.articleBody.length > 200) {
              return graphItem.articleBody;
            }
          }
        }
      }
    } catch (e) {
      // Ignorer les erreurs de parsing JSON-LD
    }
  }
  return '';
}

/**
 * Extrait le body et supprime les éléments non-article
 */
function extractBody(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return stripTags(html);

  let body = bodyMatch[1];

  // Supprimer les éléments non désirés via regex (léger)
  const removePatterns = [
    /<script[\s\S]*?<\/script>/gi,
    /<style[\s\S]*?<\/style>/gi,
    /<nav[\s\S]*?<\/nav>/gi,
    /<footer[\s\S]*?<\/footer>/gi,
    /<header[\s\S]*?<\/header>/gi,
    /<aside[\s\S]*?<\/aside>/gi,
    /<noscript[\s\S]*?<\/noscript>/gi,
    /<form[\s\S]*?<\/form>/gi,
    /<svg[\s\S]*?<\/svg>/gi,
    /<!--[\s\S]*?-->/g,
    /<[^>]*class="[^"]*(?:share|social|newsletter|popup|banner|ad-|advert|cookie|consent|paywall|subscription|premium|related|comments)[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
  ];

  for (const pattern of removePatterns) {
    body = body.replace(pattern, '');
  }

  return stripTags(body);
}

/**
 * Supprime toutes les balises HTML et décode les entités
 */
function stripTags(html) {
  return html
    // Supprimer les balises
    .replace(/<[^>]*>/g, ' ')
    // Décoder les entités HTML courantes
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&#\d+;/g, '')
    // Nettoyer les espaces multiples
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n');
}

/**
 * Nettoyage final du texte extrait
 */
function cleanText(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      // Filtrer les lignes trop courtes (fragments de navigation)
      if (line.length < 30) return false;
      // Filtrer les lignes qui ressemblent à du CSS/JS résiduel
      if (line.match(/^\{|\}$|function|var |let |const |\.css|\.js|onclick|display:/)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * Tronque le texte à N mots, à la frontière de phrase la plus proche
 */
function truncateToWords(text, maxWords) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;

  let truncated = words.slice(0, maxWords).join(' ');
  // Couper à la dernière phrase complète
  const lastSentence = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclam = truncated.lastIndexOf('!');
  const lastPunct = Math.max(lastSentence, lastQuestion, lastExclam);

  if (lastPunct > maxWords * 3) { // Au moins 1/3 du texte
    truncated = truncated.substring(0, lastPunct + 1);
  }

  return truncated;
}

/**
 * Vérifie si un texte semble être du contenu d'article valide
 * (et non une page de paywall, d'inscription, etc.)
 */
export function isPaywallPage(text) {
  if (!text || text.length < 200) return true;
  const paywallIndicators = [
    /vous.*(?:abonn|inscriv|souscri)/i,
    /cet article est (?:réservé|protégé|payant)/i,
    /pour lire la suite.*(?:abonn)/i,
    /subscribe to continue/i,
    /register to read/i,
    /pour continuer la lecture/i,
    /article (?:réservé aux|en accès restreint)/i,
  ];

  const firstLines = text.substring(0, 500);
  return paywallIndicators.some(pattern => pattern.test(firstLines));
}

/**
 * Extrait les métadonnées d'un article (titre, description) depuis le HTML
 */
export function extractMetadata(html) {
  const meta = {};

  // Open Graph title
  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (ogTitle) meta.title = ogTitle[1];

  // Open Graph description
  const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  if (ogDesc) meta.description = ogDesc[1];

  // JSON-LD article
  const jsonLd = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLd) {
    try {
      const data = JSON.parse(jsonLd[1]);
      if (data.articleBody) meta.articleBody = data.articleBody;
      if (data.description) meta.description = meta.description || data.description;
      if (data.headline) meta.title = meta.title || data.headline;
    } catch (e) {
      // Ignorer les erreurs de parsing JSON-LD
    }
  }

  return meta;
}