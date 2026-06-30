// ============================================================
// sources.js — Configuration des flux RSS et règles par site
// ============================================================

export const SOURCES = [
  // === LE MONDE (flux full — contenu complet inclus) ===
  {
    name: 'Le Monde – Campus',
    url: 'https://www.lemonde.fr/campus/rss_full.xml',
    lang: 'fr',
    category: 'presse_nationale',
    hasFullContent: true,
  },
  {
    name: 'Le Monde – Politique',
    url: 'https://www.lemonde.fr/politique/rss_full.xml',
    lang: 'fr',
    category: 'presse_nationale',
    hasFullContent: true,
  },
  {
    name: 'Le Monde – Économie',
    url: 'https://www.lemonde.fr/economie/rss_full.xml',
    lang: 'fr',
    category: 'economie',
    hasFullContent: true,
  },
  {
    name: 'Le Monde – International',
    url: 'https://www.lemonde.fr/international/rss_full.xml',
    lang: 'fr',
    category: 'international',
    hasFullContent: true,
  },

  // === LES ÉCHOS (flux thématiques) ===
  {
    name: 'Les Échos – Économie',
    url: 'https://services.lesechos.fr/rss/les-echos-economie.xml',
    lang: 'fr',
    category: 'economie',
    forceFullFetch: true,
  },
  {
    name: 'Les Échos – Monde',
    url: 'https://services.lesechos.fr/rss/les-echos-monde.xml',
    lang: 'fr',
    category: 'international',
    forceFullFetch: true,
  },
  {
    name: 'Les Échos – Politique',
    url: 'https://services.lesechos.fr/rss/les-echos-politique.xml',
    lang: 'fr',
    category: 'presse_nationale',
    forceFullFetch: true,
  },

  // === MEDIAPART (via Mastodon) ===
  {
    name: 'Mediapart',
    url: 'https://mediapart.social/@mediapart.rss',
    lang: 'fr',
    category: 'presse_numerique',
    // Mastodon RSS : les liens pointent vers mediapart.fr
    forceFullFetch: true,
  },

  // === CEPII (lettres économiques) ===
  {
    name: 'CEPII',
    url: 'https://www.cepii.fr/CEPII/rss/RSSLettre.asp',
    lang: 'fr',
    category: 'economie',
    hasFullContent: true,
  },

  // === BLOGS ÉCONOMIQUES & ANALYSE ===
  {
    name: 'The Next Recession',
    url: 'https://thenextrecession.wordpress.com/feed/',
    lang: 'en',
    category: 'blogs_economie',
    hasFullContent: true,
  },

  // === GAUCHE & MOUVEMENTS SOCIAUX ===
  {
    name: 'Groupe Marxiste Internationaliste',
    url: 'https://groupemarxiste.info/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
  },
  {
    name: 'NPA (Nouveau Parti Anticapitaliste)',
    url: 'https://npa-revolutionnaires.org/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
  },
  {
    name: 'POI (Parti Ouvrier Indépendant)',
    url: 'https://partiouvrierindependant-poi.fr/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
  },
  {
    name: 'Marxiste.org',
    url: 'https://marxiste.org/?format=feed&type=rss',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
  },
  {
    name: 'Parti des Travailleurs',
    url: 'https://parti-des-travailleurs.fr/feed/',
    lang: 'fr',
    category: 'gauche',
    hasFullContent: true,
  },

  // === RÉVOLUTION PERMANENTE (Telegram → via RSSHub bridge) ===
  {
    name: 'Révolution Permanente',
    url: 'https://r.jina.ai/https://rsshub.app/telegram/channel/revolution_permanente',
    lang: 'fr',
    category: 'gauche',
    // Le channel Telegram passe par RSSHub puis r.jina.ai pour le contenu
    isBridge: true,
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