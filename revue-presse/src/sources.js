// ============================================================
// sources.js — Configuration des flux RSS et règles par site
// ============================================================

export const SOURCES = [
  // === PRESSE NATIONALE FR ===
  {
    name: 'Le Monde',
    url: 'https://www.lemonde.fr/rss/une.xml',
    lang: 'fr',
    category: 'presse_nationale',
    // Le Monde sert parfois le contenu tronqué → forcer le fetch
    forceFullFetch: true,
    // Bloquer les cookies de compteur métré
    clearCookies: true,
  },
  {
    name: 'Le Figaro',
    url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml',
    lang: 'fr',
    category: 'presse_nationale',
    forceFullFetch: true,
  },
  {
    name: 'Les Échos',
    url: 'https://syndication.lesechos.fr/rss/rss_une.xml',
    lang: 'fr',
    category: 'economie',
    forceFullFetch: true,
  },
  {
    name: 'Libération',
    url: 'https://www.liberation.fr/rss/',
    lang: 'fr',
    category: 'presse_nationale',
  },
  {
    name: 'La Croix',
    url: 'https://www.la-croix.com/rss/une.xml',
    lang: 'fr',
    category: 'presse_nationale',
  },
  {
    name: 'France Info',
    url: 'https://www.francetvinfo.fr/titres.rss',
    lang: 'fr',
    category: 'audiovisuel',
  },
  {
    name: 'France Inter',
    url: 'https://www.radiofrance.fr/franceinter/podcasts/rss',
    lang: 'fr',
    category: 'audiovisuel',
  },
  {
    name: 'Mediapart',
    url: 'https://www.mediapart.fr/articles/feed',
    lang: 'fr',
    category: 'presse_numerique',
  },

  // === ECONOMIE & TECH ===
  {
    name: 'La Tribune',
    url: 'https://www.latribune.fr/rss/rubriques/economie.html',
    lang: 'fr',
    category: 'economie',
  },
  {
    name: 'JDN (Journal du Net)',
    url: 'https://www.journaldunet.com/rss/',
    lang: 'fr',
    category: 'tech',
  },
  {
    name: 'Silicon',
    url: 'https://www.silicon.fr/feed',
    lang: 'fr',
    category: 'tech',
  },

  // === INTERNATIONAL FR ===
  {
    name: 'Courrier International',
    url: 'https://www.courrierinternational.com/feed',
    lang: 'fr',
    category: 'international',
  },
  {
    name: 'RFI (Radio France Internationale)',
    url: 'https://www.rfi.fr/fr/rss',
    lang: 'fr',
    category: 'international',
  },
  {
    name: 'Euronews (FR)',
    url: 'https://www.euronews.com/rss?format=mrss&lang=fr',
    lang: 'fr',
    category: 'international',
  },

  // === ANGLOPHONE (poches internationales) ===
  {
    name: 'Reuters',
    url: 'https://feeds.reuters.com/reuters/topNews',
    lang: 'en',
    category: 'international_en',
  },
  {
    name: 'BBC News',
    url: 'http://feeds.bbci.co.uk/news/rss.xml',
    lang: 'en',
    category: 'international_en',
  },
  {
    name: 'The Guardian',
    url: 'https://www.theguardian.com/world/rss',
    lang: 'en',
    category: 'international_en',
  },
];

// Catégories pour le prompt IA (groupement thématique)
export const CATEGORIES = {
  presse_nationale: 'Presse nationale française',
  economie: 'Économie & Business',
  tech: 'Technologie & Numérique',
  audiovisuel: 'Médias audiovisuels',
  presse_numerique: 'Presse numérique & Enquêtes',
  international: 'Presse internationale (français)',
  international_en: 'Presse anglophone',
};

// Headers anti-paywall inspirés de BPC (Bypass Paywalls Clean)
// Ces headers font croire au serveur que la requête vient de Googlebot
export const ANTI_PAYWALL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Referer': 'https://www.google.com/',
  'X-Forwarded-For': '66.249.66.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
  // Ne jamais envoyer de cookies (contournement des compteurs métrés)
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

// Sites qui nécessitent le fallback r.jina.ai
export const JINA_FALLBACK_SITES = [
  'mediapart.fr',
  'lemonde.fr',
  'lefigaro.fr',
];

// Fallback via archive.org pour les sites très protégés
export const ARCHIVE_FALLBACK_SITES = [
  'les echos',
  'lesechos.fr',
];