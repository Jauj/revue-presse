// ============================================================
// searcher.js — Recherche web multi-source pour enrichir la revue
// Cascade : NewsAPI → DDG HTML POST → SearXNG → Brave (optional)
// ============================================================

const NEWSAPI_ENDPOINT = 'https://newsapi.org/v2/everything';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const SEARXNG_INSTANCES = [
  'https://searx.be/search',
  'https://search.sapti.me/search',
  'https://searx.tiekoetter.com/search',
  'https://search.mdosch.de/search',
  'https://searx.work/search',
  'https://search.bus-hit.me/search',
];
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// ============================================================
// NewsAPI — Primary (gratuit, 100 req/jour)
// ============================================================
export async function searchNewsAPI(query, { numResults = 5, lang = 'fr', daysBack = 2, env } = {}) {
  if (!env.NEWSAPI_KEY) return { results: [], source: 'newsapi', error: 'Pas de clé' };

  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const params = new URLSearchParams({
    q: query,
    from,
    sortBy: 'publishedAt',
    pageSize: String(numResults),
    language: lang === 'en' ? 'en' : 'fr',
  });

  try {
    const resp = await fetch(`${NEWSAPI_ENDPOINT}?${params}`, {
      headers: {
        'X-Api-Key': env.NEWSAPI_KEY,
        'User-Agent': 'RevueDePresse/2.1 (cloudflare-worker)',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { results: [], source: 'newsapi', error: `HTTP ${resp.status}: ${errText}` };
    }

    const data = await resp.json();
    const articles = (data.articles || [])
      .filter(a => a.url && !a.url.includes('removed.com'))
      .map(a => ({
        title: a.title || '',
        url: a.url.replace(/[?&]utm_[^&]*/gi, ''),
        snippet: (a.description || '').substring(0, 300),
        source: a.source?.name || 'NewsAPI',
        date: a.publishedAt,
      }));

    return { results: articles.slice(0, numResults), source: 'newsapi' };
  } catch (err) {
    return { results: [], source: 'newsapi', error: err.message };
  }
}

// ============================================================
// DuckDuckGo HTML POST — Secondary (pas de JS requis)
// ============================================================
export async function searchDDGHTML(query, { numResults = 5, lang = 'fr' } = {}) {
  try {
    const body = new URLSearchParams({ q: query, kl: lang === 'en' ? 'us-en' : 'fr-fr' });

    const resp = await fetch(DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': lang === 'en' ? 'en-US,en;q=0.9' : 'fr-FR,fr;q=0.9,en;q=0.8',
        'Referer': 'https://duckduckgo.com/',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      return { results: [], source: 'ddg-html', error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    const results = [];

    // Parser le HTML DDG — chercher les résultats organiques
    // Les pubs ont des URLs commençant par //duckduckgo.com/y.js? — les ignorer
    const resultBlocks = html.split(/<div class="result[^"]*"/);
    for (const block of resultBlocks.slice(1)) {
      try {
        // Extraire le lien et titre
        const linkMatch = block.match(/<a rel="nofollow" class="result__a" href="([^"]+)"/);
        const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

        if (linkMatch) {
          let url = linkMatch[1];

          // Ignorer les liens publicitaires
          if (url.includes('/y.js?') || url.includes('ad_domain') || url.includes('ad_provider')) continue;

          // DDG encode les URLs de redirection
          if (url.includes('uddg=')) {
            try {
              const fullUrl = url.startsWith('//') ? 'https:' + url : url;
              const parsed = new URL(fullUrl);
              const uddg = parsed.searchParams.get('uddg');
              if (uddg) url = decodeURIComponent(uddg);
            } catch (e) { /* garder l'URL originale */ }
          }

          // S'assurer qu'on a une URL absolue
          if (url.startsWith('//')) url = 'https:' + url;
          if (!url.startsWith('http')) continue;

          results.push({
            title: extractText(block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] || ''),
            url,
            snippet: extractText(snippetMatch?.[1] || ''),
            source: 'DuckDuckGo',
          });

          if (results.length >= numResults) break;
        }
      } catch (e) { /* skip bad block */ }
    }

    return { results, source: 'ddg-html' };
  } catch (err) {
    return { results: [], source: 'ddg-html', error: err.message };
  }
}

// ============================================================
// SearXNG — Tertiary (instances publiques, JSON)
// ============================================================
export async function searchSearXNG(query, { numResults = 5, lang = 'fr' } = {}) {
  const errors = [];

  for (const instance of SEARXNG_INSTANCES) {
    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        language: lang === 'en' ? 'en' : 'fr',
      });

      const resp = await fetch(`${instance}?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) continue;

      const data = await resp.json();
      const results = (data.results || [])
        .filter(r => r.url && !r.url.includes('removed.com'))
        .slice(0, numResults)
        .map(r => ({
          title: r.title || '',
          url: r.url.replace(/[?&]utm_[^&]*/gi, ''),
          snippet: (r.content || '').substring(0, 300),
          source: r.engine || 'SearXNG',
        }));

      if (results.length > 0) {
        return { results, source: `searxng (${instance.split('//')[1].split('/')[0]})` };
      }
    } catch (err) {
      errors.push(`${instance}: ${err.message}`);
      continue;
    }
  }

  return { results: [], source: 'searxng', error: errors.join('; ') };
}

// ============================================================
// Brave Search — Quaternary (optionnel, nécessite BRAVE_API_KEY)
// ============================================================
export async function searchBrave(query, { numResults = 5, lang = 'fr', env } = {}) {
  if (!env.BRAVE_API_KEY) return { results: [], source: 'brave', error: 'Pas de clé' };

  try {
    const params = new URLSearchParams({
      q: query,
      count: String(numResults),
      search_lang: lang === 'en' ? 'en' : 'fr',
    });

    const resp = await fetch(`${BRAVE_ENDPOINT}?${params}`, {
      headers: {
        'X-Subscription-Token': env.BRAVE_API_KEY,
        'Accept': 'application/json',
        'User-Agent': 'RevueDePresse/2.1 (cloudflare-worker)',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return { results: [], source: 'brave', error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const results = (data.web?.results || [])
      .map(r => ({
        title: r.title || '',
        url: r.url,
        snippet: (r.description || '').substring(0, 300),
        source: 'Brave',
      }));

    return { results: results.slice(0, numResults), source: 'brave' };
  } catch (err) {
    return { results: [], source: 'brave', error: err.message };
  }
}

// ============================================================
// Recherche unifiée — Cascade
// ============================================================
export async function webSearch(query, { numResults = 5, lang = 'fr', env } = {}) {
  // 1. NewsAPI (gratuit, fiable)
  const newsapi = await searchNewsAPI(query, { numResults, lang, daysBack: 2, env });
  if (newsapi.results.length > 0) return newsapi;

  // 2. DuckDuckGo HTML POST
  const ddg = await searchDDGHTML(query, { numResults, lang });
  if (ddg.results.length > 0) return ddg;

  // 3. SearXNG (instances publiques)
  const searxng = await searchSearXNG(query, { numResults, lang });
  if (searxng.results.length > 0) return searxng;

  // 4. Brave (si clé disponible)
  const brave = await searchBrave(query, { numResults, lang, env });
  if (brave.results.length > 0) return brave;

  // Retourner le dernier résultat (qui contient l'erreur)
  return brave;
}

// ============================================================
// Recherche multilingue — FR + EN, dédup par URL
// ============================================================
export async function webSearchMultiLang(baseQuery, languages = ['fr', 'en'], perLang = 3, env) {
  const allResults = [];
  const seenUrls = new Set();

  for (const lang of languages) {
    const query = lang === 'en' ? `${baseQuery} news today` : baseQuery;
    const result = await webSearch(query, { numResults: perLang, lang, env });

    if (result.results.length > 0) {
      console.log(`[webSearchMultiLang] ${lang}: ${result.results.length} résultats via ${result.source}`);
    }
    if (result.error && result.results.length === 0) {
      console.log(`[webSearchMultiLang] ${lang}: 0 résultats (${result.error})`);
    }

    for (const item of result.results) {
      const cleanUrl = item.url.split('?')[0].split('#')[0];
      if (!seenUrls.has(cleanUrl)) {
        seenUrls.add(cleanUrl);
        allResults.push(item);
      }
    }
  }

  return allResults;
}

// ============================================================
// Extraire le texte d'une URL (pour fetcher les articles trouvés)
// ============================================================
export async function fetchSearchResultContent(url, maxWords = 500) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { text: '', error: `HTTP ${resp.status}` };

    const html = await resp.text();
    const text = extractTextFromHTML(html);
    const words = text.split(/\s+/).slice(0, maxWords).join(' ');
    return { text: words };
  } catch (err) {
    return { text: '', error: err.message };
  }
}

// ============================================================
// Utilitaires HTML→texte (léger, pas de dépendance)
// ============================================================
export function extractTextFromHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractText(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}