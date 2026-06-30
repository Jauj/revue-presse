// ============================================================
// fetcher.js — Récupération RSS + fetch articles avec anti-paywall
// ============================================================

import { SOURCES, ANTI_PAYWALL_HEADERS, ALT_HEADERS_FACEBOOK, JINA_FALLBACK_SITES } from './sources.js';

/**
 * Parse un flux RSS/Atom et retourne la liste des articles
 * Parseur XML léger (pas de dépendance externe)
 */
export function parseRSS(xmlString) {
  const items = [];

  // Normaliser les espaces de noms
  const clean = xmlString.replace(/xmlns[:\w]*="[^"]*"/g, '');

  // Matcher les items RSS ou entries Atom
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(clean)) !== null) {
    const block = match[1];
    const item = {};

    // Extraire titre
    const titleMatch = block.match(/<title(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    if (titleMatch) item.title = titleMatch[1].trim();

    // Extraire lien
    const linkMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i)
      || block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
    if (linkMatch) item.link = linkMatch[1].trim();

    // Extraire description/résumé
    const descMatch = block.match(/<(?:description|summary)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary)>/i);
    if (descMatch) item.description = descMatch[1].trim();

    // Extraire contenu plein (content:encoded)
    const contentMatch = block.match(/<content(?:\s[^>]*)?>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);
    if (contentMatch) item.fullContent = contentMatch[1].trim();

    // Extraire date de publication
    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:pubDate|published|updated|dc:date)>/i);
    if (dateMatch) item.pubDate = dateMatch[1].trim();

    // Extraire auteur
    const authorMatch = block.match(/<(?:author|dc:creator)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:author|dc:creator)>/i);
    if (authorMatch) item.author = authorMatch[1].trim().replace(/<[^>]*>/g, '');

    if (item.title && item.link) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Récupère tous les flux RSS configurés
 * Retourne un tableau d'articles avec leur source
 */
export async function fetchAllFeeds(maxArticles) {
  const allArticles = [];
  const errors = [];

  // Lancer les fetchs en parallèle (batch de 5 pour ne pas surcharger)
  const batchSize = 5;

  for (let i = 0; i < SOURCES.length; i += batchSize) {
    const batch = SOURCES.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (source) => {
        try {
          const response = await fetch(source.url, {
            headers: {
              'User-Agent': 'RevueDePresse/1.0 (RSS Aggregator)',
              'Accept': 'application/rss+xml, application/xml, text/xml',
            },
            signal: AbortSignal.timeout(15000), // 15s timeout
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const xml = await response.text();
          const items = parseRSS(xml);

          return items.map((item) => ({
            ...item,
            sourceName: source.name,
            sourceCategory: source.category,
            sourceLang: source.lang,
            forceFullFetch: source.forceFullFetch || false,
            clearCookies: source.clearCookies || false,
          }));
        } catch (err) {
          throw new Error(`${source.name}: ${err.message}`);
        }
      })
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') {
        allArticles.push(...results[j].value);
      } else {
        errors.push(results[j].reason.message);
      }
    }
  }

  // Trier par date (plus récent d'abord)
  allArticles.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
    const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
    return dateB - dateA;
  });

  // Limiter le nombre d'articles
  const limited = allArticles.slice(0, maxArticles || 25);

  return { articles: limited, totalFound: allArticles.length, errors };
}

/**
 * Fetch un article complet avec headers anti-paywall
 * Stratégie : Googlebot UA → Facebookbot UA → r.jina.ai
 */
export async function fetchFullArticle(url, sourceName = '') {
  let html = null;
  let method = 'none';

  // === Stratégie 1 : Headers Googlebot ===
  try {
    const resp = await fetch(url, {
      headers: { ...ANTI_PAYWALL_HEADERS },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      html = await resp.text();
      method = 'googlebot';
    }
  } catch (e) {
    // Passer à la stratégie suivante
  }

  // === Stratégie 2 : Headers Facebookbot (si le contenu semble tronqué) ===
  if (!html || html.length < 1000) {
    try {
      const resp = await fetch(url, {
        headers: { ...ALT_HEADERS_FACEBOOK },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const fbHtml = await resp.text();
        if (fbHtml.length > html?.length) {
          html = fbHtml;
          method = 'facebookbot';
        }
      }
    } catch (e) {
      // Passer à la stratégie suivante
    }
  }

  // === Stratégie 3 : Fallback r.jina.ai ===
  if (!html || html.length < 1000) {
    try {
      const resp = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
        headers: {
          'Accept': 'text/plain',
          'X-Return-Format': 'text',
        },
        signal: AbortSignal.timeout(20000),
      });
      if (resp.ok) {
        const jinaText = await resp.text();
        // r.jina.ai retourne du Markdown propre → marquer comme déjà extrait
        return {
          text: jinaText,
          method: 'jina',
          isMarkdown: true,
          success: true,
        };
      }
    } catch (e) {
      // Dernier recours
    }
  }

  if (!html) {
    return { text: null, method: 'failed', success: false };
  }

  return {
    html,
    method,
    isMarkdown: false,
    success: true,
  };
}