// ============================================================
// news-apis.js — Fetch parallèle depuis 8+ APIs de news
// Currents API, GNews, Guardian, NYT, Mediastack, NewsData, NewsAPI, Noozra
// Chaque source retourne un format normalisé : { title, url, description, source, lang, category, pubDate }
// ============================================================

/**
 * Fetch toutes les APIs de news en parallèle
 * @param {Object} env - Environment CF Workers (contient les clés API)
 * @param {Object} opts - { maxPerSource, daysBack, lang }
 * @returns {Array} - Articles normalisés
 */
export async function fetchAllNewsAPIs(env, { maxPerSource = 10, daysBack = 2 } = {}) {
  // v3.2 : Réduit à 8 sources (4 EN retirées pour économiser les sous-requêtes)
  // Guardian et NYT fournissent déjà du contenu EN
  const fetchers = [
    { name: 'CurrentsAPI', fn: () => fetchCurrents(env, { max: maxPerSource, lang: 'fr' }) },
    { name: 'GNews', fn: () => fetchGNews(env, { max: maxPerSource, lang: 'fr' }) },
    { name: 'Guardian', fn: () => fetchGuardian(env, { max: maxPerSource }) },
    { name: 'NYT', fn: () => fetchNYT(env, { max: maxPerSource }) },
    { name: 'Mediastack', fn: () => fetchMediastack(env, { max: maxPerSource, lang: 'fr' }) },
    { name: 'NewsData', fn: () => fetchNewsData(env, { max: maxPerSource, lang: 'fr' }) },
    { name: 'NewsAPI', fn: () => fetchNewsAPI(env, { max: maxPerSource, lang: 'fr', daysBack, query: 'France économie politique' }) },
    { name: 'Noozra', fn: () => fetchNoozra(env, { max: maxPerSource }) },
  ];

  // Lancer TOUT en parallèle (Promise.allSettled pour tolérance aux pannes)
  const results = await Promise.allSettled(
    fetchers.map(async ({ name, fn }) => {
      try {
        const articles = await fn();
        return { source: name, articles, count: articles.length };
      } catch (err) {
        return { source: name, articles: [], count: 0, error: err.message };
      }
    })
  );

  const allArticles = [];
  const sourceStatus = {};

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { source, articles, count, error } = result.value;
      sourceStatus[source] = error ? { ok: false, error, count: 0 } : { ok: true, count };
      allArticles.push(...articles);
    }
  }

  return { articles: allArticles, sourceStatus };
}

// ============================================================
// Format normalisé
// ============================================================
function normalize(title, url, description, sourceName, lang, category, pubDate) {
  return {
    title: (title || '').trim(),
    link: (url || '').trim(),
    description: (description || '').replace(/<[^>]*>/g, '').trim().substring(0, 500),
    sourceName,
    sourceLang: lang || 'fr',
    sourceCategory: category || 'news_api',
    pubDate: pubDate || new Date().toUTCString(),
    fetchStrategy: 'news_api',
    hasFullContent: false,
  };
}

// ============================================================
// Currents API — FR (gratuit, 200 req/jour)
// ============================================================
async function fetchCurrents(env, { max = 10, lang = 'fr' } = {}) {
  if (!env.CURRENTS_API_KEY) return [];

  const resp = await fetch(
    `https://api.currentsapi.services/v1/latest-news?apiKey=${env.CURRENTS_API_KEY}&language=${lang}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!resp.ok) throw new Error(`Currents HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.news || []).slice(0, max).map(a =>
    normalize(a.title, a.url, a.description, `Currents/${a.author || 'Unknown'}`, lang, 'actualites', a.published)
  );
}

// ============================================================
// GNews — FR + EN (gratuit, 100 req/jour)
// ============================================================
async function fetchGNews(env, { max = 10, lang = 'fr', query } = {}) {
  if (!env.GNEWS_API_KEY) return [];

  let endpoint = `https://gnews.io/api/v4/top-headlines`;
  const params = new URLSearchParams({
    lang,
    max: String(max),
    apikey: env.GNEWS_API_KEY,
  });
  if (lang === 'fr') params.set('country', 'fr');
  if (lang === 'en') params.set('country', 'us');
  if (query) { endpoint = `https://gnews.io/api/v4/search`; params.set('q', query); }

  const resp = await fetch(`${endpoint}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`GNews HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.articles || []).map(a =>
    normalize(a.title, a.url, a.description, `GNews/${a.source?.name || 'Unknown'}`, lang, 'actualites', a.publishedAt)
  );
}

// ============================================================
// Guardian — EN (gratuit, 12 req/min, 5000/jour)
// ============================================================
async function fetchGuardian(env, { max = 10, query } = {}) {
  if (!env.GUARDIAN_API_KEY) return [];

  const params = new URLSearchParams({
    'api-key': env.GUARDIAN_API_KEY,
    'page-size': String(max),
    'show-fields': 'headline,trailText,byline',
    'order-by': 'newest',
  });
  if (query) params.set('q', query);
  else params.set('q', 'France OR Europe OR economy OR politics');

  const resp = await fetch(`https://content.guardianapis.com/search?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Guardian HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.response?.results || []).map(r =>
    normalize(
      r.webTitle,
      r.webUrl,
      r.fields?.trailText || '',
      `Guardian/${r.fields?.byline || 'Staff'}`,
      'en', 'international', r.webPublicationDate
    )
  );
}

// ============================================================
// NYT — EN (gratuit, 500 req/jour)
// ============================================================
async function fetchNYT(env, { max = 10, section } = {}) {
  if (!env.NYT_API_KEY) return [];

  const sections = section ? [section] : ['world', 'business', 'politics'];
  const allArticles = [];

  // Fetch 2 sections en parallèle
  const results = await Promise.allSettled(
    sections.slice(0, 2).map(async (sec) => {
      const resp = await fetch(
        `https://api.nytimes.com/svc/topstories/v2/${sec}.json?api-key=${env.NYT_API_KEY}`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!resp.ok) throw new Error(`NYT HTTP ${resp.status}`);
      return (await resp.json()).results || [];
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const r of result.value) {
        allArticles.push(
          normalize(
            r.title,
            r.url,
            r.abstract || '',
            `NYT/${r.byline || 'Staff'}`,
            'en', 'international', r.published_date
          )
        );
      }
    }
  }

  return allArticles.slice(0, max);
}

// ============================================================
// Mediastack — FR (gratuit, 100 req/mois)
// ============================================================
async function fetchMediastack(env, { max = 10, lang = 'fr' } = {}) {
  if (!env.MEDIASTACK_API_KEY) return [];

  const params = new URLSearchParams({
    access_key: env.MEDIASTACK_API_KEY,
    languages: lang,
    limit: String(max),
  });

  const resp = await fetch(`https://api.mediastack.com/v1/news?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`Mediastack HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.data || []).map(a =>
    normalize(a.title, a.url, a.description, `Mediastack/${a.source || 'Unknown'}`, lang, 'actualites', a.published_at)
  );
}

// ============================================================
// NewsData.io — FR (gratuit, 200 req/jour)
// ============================================================
async function fetchNewsData(env, { max = 10, lang = 'fr' } = {}) {
  if (!env.NEWSDATA_API_KEY) return [];

  const params = new URLSearchParams({
    apikey: env.NEWSDATA_API_KEY,
    language: lang,
    country: lang === 'fr' ? 'fr' : undefined,
  });

  const resp = await fetch(`https://newsdata.io/api/1/latest?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`NewsData HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.results || []).slice(0, max).map(r =>
    normalize(r.title, r.link, r.description || r.content, `NewsData/${r.source_id || 'Unknown'}`, lang, 'actualites', r.pubDate)
  );
}

// ============================================================
// NewsAPI.org — FR (gratuit, 100 req/jour, /everything endpoint)
// ============================================================
async function fetchNewsAPI(env, { max = 10, lang = 'fr', daysBack = 2, query } = {}) {
  if (!env.NEWSAPI_KEY) return [];

  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const params = new URLSearchParams({
    q: query || 'France OR Europe OR economy OR politique OR international',
    from,
    sortBy: 'publishedAt',
    pageSize: String(max),
    language: lang === 'en' ? 'en' : 'fr',
  });

  const resp = await fetch(`https://newsapi.org/v2/everything?${params}`, {
    headers: {
      'X-Api-Key': env.NEWSAPI_KEY,
      'User-Agent': 'RevueDePresse/3.0 (cloudflare-worker)',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`NewsAPI HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.articles || [])
    .filter(a => a.url && !a.url.includes('removed.com'))
    .map(a =>
      normalize(
        a.title, a.url.replace(/[?&]utm_[^&]*/gi, ''),
        a.description, `NewsAPI/${a.source?.name || 'Unknown'}`,
        lang, 'actualites', a.publishedAt
      )
    );
}

// ============================================================
// Noozra — EN (gratuit, 100 req/jour, pas de clé requise)
// ============================================================
async function fetchNoozra(env, { max = 10, category } = {}) {
  const params = new URLSearchParams({ limit: String(max) });
  if (category && category !== 'all') params.set('category', category);

  const headers = { 'Accept': 'application/json' };
  if (env.NOOZRA_API_KEY) headers['Authorization'] = `Bearer ${env.NOOZRA_API_KEY}`;

  const resp = await fetch(`https://noozra.com/api/articles?${params}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Noozra HTTP ${resp.status}`);
  const data = await resp.json();

  return (data.articles || []).slice(0, max).map(a =>
    normalize(
      a.headline || a.title, a.url,
      a.description || '', `Noozra/${a.source || 'Unknown'}`,
      'en', a.category || 'international', a.published_at
    )
  );
}