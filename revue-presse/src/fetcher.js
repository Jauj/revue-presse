// ============================================================
// fetcher.js — Récupération RSS multi-stratégies + extraction articles
// Stratégies : direct | jina_html | telegram_embed
// ============================================================

import { SOURCES, ANTI_PAYWALL_HEADERS, ALT_HEADERS_FACEBOOK } from './sources.js';

// ============================================================
// Parseurs RSS/Atom
// ============================================================

/**
 * Parse un flux RSS/Atom standard
 */
export function parseRSS(xmlString) {
  const items = [];
  const clean = xmlString.replace(/xmlns[:\w]*="[^"]*"/g, '');
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(clean)) !== null) {
    const block = match[1];
    const item = {};

    const titleMatch = block.match(/<title(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    if (titleMatch) item.title = titleMatch[1].trim();

    const linkMatch = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i)
      || block.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);
    if (linkMatch) item.link = linkMatch[1].trim();

    const descMatch = block.match(/<(?:description|summary)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:description|summary)>/i);
    if (descMatch) item.description = descMatch[1].trim();

    // Content : gère <content>, <content:encoded>, <content type="html">
    const contentMatch = block.match(/<content(?::\w+)?(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content(?::\w+)?>/i);
    if (contentMatch) item.fullContent = contentMatch[1].trim();

    // Si pas de fullContent mais description longue, l'utiliser
    if (!item.fullContent && item.description && item.description.split(/\s+/).length > 50) {
      item.fullContent = item.description;
    }

    const dateMatch = block.match(/<(?:pubDate|published|updated|dc:date)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:pubDate|published|updated|dc:date)>/i);
    if (dateMatch) item.pubDate = dateMatch[1].trim();

    const authorMatch = block.match(/<(?:author|dc:creator)(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:author|dc:creator)>/i);
    if (authorMatch) item.author = authorMatch[1].trim().replace(/<[^>]*>/g, '');

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

// ============================================================
// Parseurs spécialisés
// ============================================================

/**
 * Parse le HTML retourné par r.jina.ai pour Les Échos
 * Extrait les liens et titres des articles depuis le HTML parsé
 */
function parseJinaHTML(html, source) {
  const items = [];
  // Pattern : <h3><a href="URL">TITRE</a></h3> ou <a href="URL">TITRE</a>
  // jina retourne un HTML simplifié avec les liens
  const linkRegex = /<a[^>]+href="(https:\/\/www\.lesechos\.fr\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  const seen = new Set();

  // Extraire d'abord les liens avec le pattern h3 > a (plus fiable)
  const h3Regex = /<h3><a[^>]+href="(https:\/\/www\.lesechos\.fr\/[^"]+)"[^>]*>([^<]+)<\/a><\/h3>/gi;
  while ((m = h3Regex.exec(html)) !== null) {
    const url = m[1];
    const title = m[2].trim();
    if (title.length > 15 && !seen.has(url)) {
      seen.add(url);
      items.push({ title, link: url, description: '', pubDate: new Date().toUTCString() });
    }
  }

  // Puis les autres liens si pas assez
  if (items.length < 5) {
    while ((m = linkRegex.exec(html)) !== null) {
      const url = m[1];
      const title = m[2].trim();
      if (title.length > 20 && !seen.has(url) && !url.includes('/rss/') && !url.includes('/newsletter')) {
        seen.add(url);
        items.push({ title, link: url, description: '', pubDate: new Date().toUTCString() });
      }
    }
  }

  return items.slice(0, 20); // max 20 articles
}

/**
 * Parse la page embed Telegram (t.me/s/channel)
 * Extrait les messages du channel comme articles
 */
function parseTelegramEmbed(html, source) {
  const items = [];

  // Découper en blocs de messages (chaque message est un div widget)
  // Approche robuste : split par le séparateur de message
  const messageBlocks = html.split(/<div class="tgme_widget_message\b/);
  // Le premier élément est avant le premier message (header), l'ignorer
  for (let i = 1; i < messageBlocks.length; i++) {
    const block = messageBlocks[i];

    // Extraire le texte du message
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div/);
    if (!textMatch) {
      // Essayer un pattern plus simple (dernier message de la page)
      const textMatch2 = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!textMatch2) continue;
      var rawText = textMatch2[1];
    } else {
      var rawText = textMatch[1];
    }

    // Extraire le lien du message
    const linkMatch = block.match(/<a class="tgme_widget_message_date"[^>]*href="([^"]+)"/);

    let text = rawText.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<[^>]*>/g, '').trim();
    text = text.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

    if (text.length > 50) {
      const beforeMatch = (linkMatch?.[1] || '').match(/before=(\d+)/);
      const link = beforeMatch
        ? `https://t.me/revolution_permanente/${beforeMatch[1]}`
        : `https://t.me/s/revolution_permanente`;

      items.push({
        title: text.substring(0, 120).trim(),
        link,
        description: text.substring(0, 500),
        fullContent: text,
        pubDate: new Date().toUTCString(),
      });
    }
  }

  return items.slice(0, 20);
}

// ============================================================
// Fetch principal
// ============================================================

/**
 * Fetch un flux selon sa stratégie
 */
async function fetchSource(source) {
  const strategy = source.fetchStrategy || 'direct';
  const timeout = source.timeout || 20000;
  const headers = source.headers || {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  };

  let response;
  let text;

  switch (strategy) {
    case 'jina_html': {
      // Les Échos : 403 direct → r.jina.ai proxy
      const jinaUrl = source.jinaUrl || `https://r.jina.ai/${source.url}`;
      response = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/html', 'X-Return-Format': 'html' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      return parseJinaHTML(text, source);
    }

    case 'telegram_embed': {
      // Révolution Permanente : page embed Telegram
      response = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      return parseTelegramEmbed(text, source);
    }

    case 'direct':
    default: {
      // Fetch RSS standard
      response = await fetch(source.url, {
        headers,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();

      // Vérifier que c'est bien du XML
      if (!text.includes('<') || text.includes('<HTML') || text.includes('<html')) {
        throw new Error('Réponse HTML au lieu de XML');
      }

      return parseRSS(text);
    }
  }
}

/**
 * Récupère tous les flux RSS configurés avec retry
 */
export async function fetchAllFeeds(maxArticles) {
  const allArticles = [];
  const errors = [];
  const sourceStatus = {};

  // Séparer les sources jina_html (rate limitées) des sources directes
  const jinaSources = SOURCES.filter(s => s.fetchStrategy === 'jina_html');
  const otherSources = SOURCES.filter(s => s.fetchStrategy !== 'jina_html');

  // Lancer les sources directes en batch de 4
  const batchSize = 4;

  // Phase 1 : sources directes en parallèle
  for (let i = 0; i < otherSources.length; i += batchSize) {
    const batch = otherSources.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (source) => {
        // Retry : 2 tentatives avec backoff
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const items = await fetchSource(source);
            sourceStatus[source.name] = { ok: true, count: items.length };

            return items.map((item) => ({
              ...item,
              sourceName: source.name,
              sourceCategory: source.category,
              sourceLang: source.lang,
              hasFullContent: source.hasFullContent || !!item.fullContent,
              fetchStrategy: source.fetchStrategy || 'direct',
            }));
          } catch (err) {
            if (attempt === 2) {
              sourceStatus[source.name] = { ok: false, error: err.message };
              throw new Error(`${source.name}: ${err.message}`);
            }
            // Attendre 2s avant le retry
            await new Promise(r => setTimeout(r, 2000));
          }
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

  // Phase 2 : sources jina_html séquentiellement (pour éviter le rate limit 429)
  for (const source of jinaSources) {
    try {
      const items = await fetchSource(source);
      sourceStatus[source.name] = { ok: true, count: items.length };
      allArticles.push(...items.map(item => ({
        ...item,
        sourceName: source.name,
        sourceCategory: source.category,
        sourceLang: source.lang,
        hasFullContent: false,
        fetchStrategy: source.fetchStrategy,
      })));
      // Attendre 1s entre chaque requête jina
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      sourceStatus[source.name] = { ok: false, error: err.message };
      errors.push(err.message);
    }
  }

  // Trier par date (plus récent d'abord)
  allArticles.sort((a, b) => {
    const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
    const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
    return dateB - dateA;
  });

  // Limiter le nombre d'articles
  const limited = allArticles.slice(0, maxArticles || 30);

  return { articles: limited, totalFound: allArticles.length, errors, sourceStatus };
}

/**
 * Fetch un article complet avec stratégie anti-paywall
 * 4 niveaux : RSS full → r.jina.ai → Googlebot → Facebookbot
 */
export async function fetchFullArticle(url, hasFullContent = false) {
  // === Si la source RSS a du contenu complet, essayer Googlebot d'abord ===
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

  // === Stratégie principale : r.jina.ai (retourne du markdown propre) ===
  try {
    const resp = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
      signal: AbortSignal.timeout(20000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.length > 200) {
        return { text, method: 'jina', isMarkdown: true, success: true };
      }
    }
  } catch (e) { /* skip */ }

  // === Googlebot direct ===
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

  // === Facebookbot (dernier recours pour certains paywalls) ===
  try {
    const resp = await fetch(url, {
      headers: { ...ALT_HEADERS_FACEBOOK },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const html = await resp.text();
      if (html.length > 500) {
        return { html, method: 'facebookbot', isMarkdown: false, success: true };
      }
    }
  } catch (e) { /* skip */ }

  return { text: null, method: 'failed', success: false };
}