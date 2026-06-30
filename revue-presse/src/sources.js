// ============================================================
// sources.js — Configuration des 18 flux RSS avec stratégies
// Chaque source a sa propre config de fetch (headers, proxy, parser)
// ============================================================

export const SOURCES = [
  // === LE MONDE (flux rss_full — contenu complet inclus) ===
  {
    name: 'Le Monde – Campus',
    url: 'https://www.lemonde.fr/campus/rss_full.xml',
    lang: 'fr',
    category: 'presse_nationale',
    hasFullContent: true,
    fetchStrategy: 'direct', // fetch RSS directement
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 15000,
  },
  {
    name: 'Le Monde – Politique',
    url: 'https://www.lemonde.fr/politique/rss_full.xml',
    lang: 'fr',
    category: 'presse_nationale',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 15000,
  },
  {
    name: 'Le Monde – Économie',
    url: 'https://www.lemonde.fr/economie/rss_full.xml',
    lang: 'fr',
    category: 'economie',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 15000,
  },
  {
    name: 'Le Monde – International',
    url: 'https://www.lemonde.fr/international/rss_full.xml',
    lang: 'fr',
    category: 'international',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 15000,
  },

  // === LES ÉCHOS (403 direct → via r.jina.ai proxy) ===
  {
    name: 'Les Échos – Économie',
    url: 'https://services.lesechos.fr/rss/les-echos-economie.xml',
    lang: 'fr',
    category: 'economie',
    fetchStrategy: 'jina_html', // r.jina.ai récupère le HTML parsé
    jinaUrl: 'https://r.jina.ai/https://services.lesechos.fr/rss/les-echos-economie.xml',
    timeout: 25000,
  },
  {
    name: 'Les Échos – Monde',
    url: 'https://services.lesechos.fr/rss/les-echos-monde.xml',
    lang: 'fr',
    category: 'international',
    fetchStrategy: 'jina_html',
    jinaUrl: 'https://r.jina.ai/https://services.lesechos.fr/rss/les-echos-monde.xml',
    timeout: 25000,
  },
  {
    name: 'Les Échos – Politique',
    url: 'https://services.lesechos.fr/rss/les-echos-politique.xml',
    lang: 'fr',
    category: 'presse_nationale',
    fetchStrategy: 'jina_html',
    jinaUrl: 'https://r.jina.ai/https://services.lesechos.fr/rss/les-echos-politique.xml',
    timeout: 25000,
  },

  // === MEDIAPART (via Mastodon RSS — Googlebot UA requis) ===
  {
    name: 'Mediapart',
    url: 'https://mediapart.social/@mediapart.rss',
    lang: 'fr',
    category: 'presse_numerique',
    fetchStrategy: 'direct',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept': 'application/rss+xml, application/xml, text/xml, text/html',
    },
    timeout: 20000,
  },

  // === CEPII (lettres économiques) ===
  {
    name: 'CEPII',
    url: 'https://www.cepii.fr/CEPII/rss/RSSLettre.asp',
    lang: 'fr',
    category: 'economie',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 20000,
  },

  // === BLOGS ÉCONOMIQUES & ANALYSE ===
  {
    name: 'The Next Recession',
    url: 'https://thenextrecession.wordpress.com/feed/',
    lang: 'en',
    category: 'blogs_economie',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 20000,
  },

  // === GAUCHE & MOUVEMENTS SOCIAUX ===
  {
    name: 'Groupe Marxiste Internationaliste',
    url: 'https://groupemarxiste.info/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 25000, // lent (~6s)
  },
  {
    name: 'NPA (Nouveau Parti Anticapitaliste)',
    url: 'https://npa-revolutionnaires.org/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, text/xml, */*',
    },
    timeout: 30000, // timeout initial était trop court
  },
  {
    name: 'POI (Parti Ouvrier Indépendant)',
    url: 'https://partiouvrierindependant-poi.fr/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 20000,
  },
  {
    name: 'Marxiste.org',
    url: 'https://marxiste.org/?format=feed&type=rss',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 20000,
  },
  {
    name: 'Parti des Travailleurs',
    url: 'https://parti-des-travailleurs.fr/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
    fetchStrategy: 'direct',
    headers: { 'User-Agent': 'Googlebot', 'Accept': 'application/rss+xml' },
    timeout: 20000,
  },

  // === RÉVOLUTION PERMANENTE (Telegram → page embed t.me/s/) ===
  {
    name: 'Révolution Permanente',
    url: 'https://t.me/s/revolution_permanente',
    lang: 'fr',
    category: 'gauche',
    fetchStrategy: 'telegram_embed', // parse le HTML de la preview Telegram
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept': 'text/html',
    },
    timeout: 20000,
  },
];

// Catégories pour le prompt IA (groupement thématique)
export const CATEGORIES = {
  presse_nationale: 'Presse nationale française',
  economie: 'Économie & Politique économique',
  international: 'International',
  presse_numerique: 'Presse numérique & Enquêtes',
  blogs_economie: 'Blogs économiques & Analyse',
  gauche: 'Gauche & Mouvements sociaux',
};

// Headers anti-paywall inspirés de BPC (Bypass Paywalls Clean)
export const ANTI_PAYWALL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Referer': 'https://www.google.com/',
  'X-Forwarded-For': '66.249.66.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Cookie': '',
};

// Headers alternatifs pour les sites qui bloquent Googlebot
export const ALT_HEADERS_FACEBOOK = {
  'User-Agent': 'Mozilla/5.0 (compatible; FacebookBot/1.0; +http://www.facebook.com/externalhit_uatext.php)',
  'Referer': 'https://www.facebook.com/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  'Cookie': '',
};