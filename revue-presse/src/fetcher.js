// ============================================================
// fetcher.js — Récupération RSS + fetch articles avec anti-paywall
// ============================================================

import { SOURCES, ANTI_PAYWALL_HEADERS, ALT_HEADERS_FACEBOOK } from './sources.js';

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

    // Extraire contenu Atom (contenu dans <content type="html">)
    const atomContent = block.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);
    if (atomContent && !item.fullContent) item.fullContent = atomContent[1].trim();

    // Mastodon : le texte est dans <content type="html">
    const mastodonContent = block.match(/<content[^>]*type="html"[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);
    if (mastodonContent) {
      item.fullContent = mastodonContent[1].trim();
      item.description = mastodonContent[1].replace(/<[^>]*>/g, ' ').trim().substring(0, 500);
    }

    // Extraire date de publication
    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:pubDate|published|updated|dc:date)>/i);
    if (dateMatch) item.pubDate = dateMatch[1].trim();

    // Extraire auteur
    const authorMatch = block.match(/<(?:author|dc:creator)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:author|dc:creator)>/i);
    if (authorMatch) item.author = authorMatch[1].trim().replace(/<[^>]*>/g, '');

    // Si pas de titre, essayer de générer un titre depuis le contenu
    if (!item.title && (item.fullContent || item.description)) {
      const rawText = (item.fullContent || item.description).replace(/<[^>]*>/g, '').trim();
      item.title = rawText.substring(0, 120).trim();
    }

    if (item.title && (item.link || item.fullContent)) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Parse un flux RSSHub bridge (Telegram, etc.)
 * Les flux RSSHub ont un format Atom standard mais nécessitent
 * un traitement spécifique pour les liens et le contenu
 */
function parseBridgeFeed(xmlString, source) {
  const items = parseRSS(xmlString);

  // Les flux Telegram ont parfois des liens vides ou vers t.me
  // On conserve les items même sans lien si du contenu est disponible
  return items.filter(item => {
    // Garder si on a un titre ou du contenu
    return (item.title && item.title.length > 10) ||
           (item.description && item.description.length > 30) ||
           (item.fullContent && item.fullContent.length > 30);
  }).map(item => {
    // Nettoyer les URLs Telegram si nécessaire
    if (item.link && item.link.includes('t.me/')) {
      item.link = item.link.replace(/\?utm_source.*$/, '');
    }
    return item;
  });
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
          let items;

          // Gestion des flux bridges (Telegram via RSSHub)
          if (source.isBridge) {
            items = parseBridgeFeed(xml, source);
          } else {
            items = parseRSS(xml);
          }

          return items.map((item) => ({
            ...item,
            sourceName: source.name,
            sourceCategory: source.category,
            sourceLang: source.lang,
            forceFullFetch: source.forceFullFetch || false,
            clearCookies: source.clearCookies || false,
            hasFullContent: source.hasFullContent || false,
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
 * VERSION OPTIMISÉE : stratégie unique pour économiser les sous-requêtes
 * - hasFullContent → Googlebot UA (une seule requête)
 * - Sinon → r.jina.ai directement (une seule requête, fiable)
 */
export async function fetchFullArticle(url, hasFullContent = false) {
  // === Si la source RSS a déjà du contenu, essayer Googlebot pour plus ===
  if (hasFullContent) {
    try {
      const resp = await fetch(url, {
        headers: { ...ANTI_PAYWALL_HEADERS },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const html = await resp.text();
        if (html.length > 500) {
          return { html, method: 'googlebot', isMarkdown: false, success: true };
        }
      }
    } catch (e) { /* skip */ }
  }

  // === Stratégie principale : r.jina.ai (1 seule requête, très fiable) ===
  try {
    const resp = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.length > 200) {
        return { text, method: 'jina', isMarkdown: true, success: true };
      }
    }
  } catch (e) { /* skip */ }

  // === Dernier recours : Googlebot direct ===
  try {
    const resp = await fetch(url, {
      headers: { ...ANTI_PAYWALL_HEADERS },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const html = await resp.text();
      if (html.length > 500) {
        return { html, method: 'googlebot', isMarkdown: false, success: true };
      }
    }
  } catch (e) { /* skip */ }

  return { text: null, method: 'failed', success: false };
}