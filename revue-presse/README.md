# Revue de Presse — Cloudflare Worker

> Système automatisé de revue de presse francophone et internationale, propulsé par une chaîne de pensée IA (Chain of Thought) à 5 étapes sur Cloudflare Workers.

**URL de production :** [https://revue-presse.jeanneaj.workers.dev](https://revue-presse.jeanneaj.workers.dev)
**GitHub :** [https://github.com/Jauj/revue-presse](https://github.com/Jauj/revue-presse)
**Auteur :** [@Jauj](https://github.com/Jauj)

---

## Table des matières

- [Architecture](#-architecture)
- [Pipeline 8 phases](#-pipeline-8-phases)
- [Sources](#-sources)
- [Historique des versions](#-historique-des-versions)
  - [v3.2.0 — Correction critique "Too many subrequests"](#v320--correction-critique-too-many-subrequests-2026-07-02)
  - [v3.1.0 — Audit complet du code (25+ optimisations)](#v310--audit-complet-du-code-25-optimisations-2026-07-02)
  - [v3.0 — Refonte CoT multi-étapes](#v30--refonte-cot-multi-étapes-2026-06-30)
  - [v2.x — Versions intermédiaires](#v2x--versions-intermédiaires-2026-06-30)
  - [v1.0 — Version initiale](#v10--version-initiale-2026-06-30)
- [Budget de sous-requêtes](#-budget-de-sous-requêtes)
- [Configuration](#-configuration)
- [Routes API](#-routes-api)
- [Variables d'environnement](#-variables-denvironnement)
- [Déploiement](#-déploiement)
- [Propositions et axes d'amélioration](#-propositions-et-axes-damélioration)
- [Licence](#-licence)

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLOUDFLARE WORKER                      │
│                                                          │
│  ┌─────────┐   ┌─────────┐   ┌──────────┐               │
│  │  Cron    │──▶│  HTTP   │──▶│  KV Bus  │               │
│  │ (6h L-V) │   │ Handler │   │ (inter-  │               │
│  └─────────┘   └─────────┘   │  phases) │               │
│                               └──────────┘               │
│  ┌────────────────────────────────────────────────────┐  │
│  │              8-PHASE PIPELINE                       │  │
│  │                                                     │  │
│  │  FETCH ─▶ FILTER ─▶ EXTRACT ─▶ THEME ─▶ DRAFT       │  │
│  │    ▲                                     │          │  │
│  │    │         REVIEW ◀── SYNTHESIS ◀───────┘          │  │
│  │    │              │                                  │  │
│  │    │          DELIVER (email)                         │  │
│  │    │              │                                  │  │
│  │    └──────────────┘                                  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │  RSS Feeds   │  │  News APIs   │  │  AI Cascade   │   │
│  │  (16 flux)   │  │  (8 sources) │  │  Mistral      │   │
│  │              │  │              │  │  → Gemini     │   │
│  │              │  │              │  │  → Workers AI │   │
│  └──────────────┘  └──────────────┘  └───────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Technologies

| Composant | Technologie |
|---|---|
| Runtime | Cloudflare Workers (V8 isolates) |
| Stockage | Cloudflare KV (bus inter-phases) |
| IA primaire | Mistral Large (via API OpenAI-compatible) |
| IA fallback 1 | Google Gemini 2.0 Flash |
| IA fallback 2 | Workers AI (Llama 3.3 70B) |
| Email | Resend (SMTP-as-a-service) |
| Recherche web | DuckDuckGo HTML / NewsAPI / SearXNG / Brave |
| Extraction | Regex-based (pas de dépendance) |

---

## ⚙ Pipeline 8 phases

Chaque phase lit/écrit dans le KV pour transmettre son résultat à la suivante :

| # | Phase | Rôle | Sous-requêtes |
|---|---|---|---|
| 1 | **FETCH** | Collecte RSS (16 flux) + News APIs (8 sources) en parallèle | ~24 |
| 2 | **FILTER** | Dédup Jaccard, scoring multi-critères, sélection top 50 | 0 |
| 3 | **EXTRACT** | IA : extraction des faits structurés par article | 1-3 |
| 4 | **THEME** | IA : thématisation, classement, identification de contradictions | 1-3 |
| 5 | **DRAFT** | Recherche web complémentaire + IA : rédaction Smart Brevity | 2-5 |
| 6 | **REVIEW** | IA : revue critique (auto-évaluation) | 1-3 |
| 7 | **SYNTHESIS** | IA : intégration des corrections → version finale | 1-3 |
| 8 | **DELIVER** | Construction email HTML + envoi via Resend | 1 |
| | **TOTAL** | | **~31-42** |

### Chaîne de pensée IA (CoT)

Le pipeline IA suit un pattern **Mixture-of-Agents** en 5 étapes séquentielles :

```
Étape 1 (EXTRACT) : Rédacteur Extracteur → fiches structurées XML
         │
         ▼
Étape 2 (THEME)   : Rédacteur Thématicien → regroupement thématique
         │
         ▼
Étape 3 (DRAFT)   : Rédacteur de Contenu → brouillon Smart Brevity
         │
         ▼
Étape 4 (REVIEW)  : Chef de Rédaction Critique → rapport de correction
         │
         ▼
Étape 5 (SYNTHESIS): Éditeur en Chef → VERSION FINALE
```

Chaque étape reçoit le contexte accumulé des étapes précédentes plus les articles sources.

### Cascade IA

```
Mistral Large ──▶ (si erreur) ──▶ Gemini 2.0 Flash ──▶ (si erreur) ──▶ Workers AI (Llama 3.3 70B)
```

La bascule se déclenche sur : erreur HTTP, réponse vide (<50 chars), timeout (120s).

---

## 📡 Sources

### Flux RSS (16 sources)

| Source | Catégorie | Stratégie | Contenu complet |
|---|---|---|---|
| Le Monde – International | international | direct (rss_full) | ✅ |
| Le Monde – Politique | presse_nationale | direct (rss_full) | ✅ |
| Le Monde – Économie | economie | direct (rss_full) | ✅ |
| Le Monde – Campus | presse_nationale | direct (rss_full) | ✅ |
| Les Échos – Économie | economie | jina_html | ❌ |
| Les Échos – Monde | international | jina_html | ❌ |
| Les Échos – Politique | presse_nationale | jina_html | ❌ |
| Mediapart | presse_numerique | direct (Mastodon RSS) | ✅ |
| CEPII | economie | direct | ✅ |
| The Next Recession | blogs_economie | direct | ✅ |
| Groupe Marxiste Internationaliste | gauche | direct | ✅ |
| NPA | gauche | direct | ✅ |
| POI | gauche | direct | ✅ |
| Marxiste.org | gauche | direct | ✅ |
| Parti des Travailleurs | gauche | direct | ✅ |
| Révolution Permanente | gauche | telegram_embed | ✅ |

### News APIs (8 sources, v3.2)

| Source | Langue | Quota |
|---|---|---|
| CurrentsAPI | FR | 200 req/jour |
| GNews | FR | 100 req/jour |
| The Guardian | EN | 5000 req/jour |
| New York Times | EN | 500 req/jour |
| Mediastack | FR | 100 req/mois |
| NewsData.io | FR | 200 req/jour |
| NewsAPI.org | FR | 100 req/jour |
| Noozra | EN | 100 req/jour |

> **Note v3.2** : 4 sources EN doublonnes (GNews-EN, NYT-World, NewsAPI-EN, Noozra-World) ont été retirées. Guardian et NYT fournissent déjà du contenu anglophone.

---

## 📋 Historique des versions

### v3.2.0 — Correction critique "Too many subrequests" (2026-07-02)

**Problème** : Le plan gratuit Cloudflare Workers limite à **50 sous-requêtes** par invocation. Le pipeline v3.1 consommait **~80-110 sous-requêtes**, provoquant l'erreur fatale `Too many subrequests by single Worker invocation` dès la phase EXTRACT.

**Racine** : La phase FILTER appelait `fetchFullArticle()` pour chaque article RSS (jusqu'à 60 articles × 3 tentatives anti-paywall = 180 fetchs potentiels). Cumulé avec FETCH (~29), le plafond était dépassé avant même l'appel IA.

**Corrections appliquées :**

| Fichier | Modification | Sous-requêtes économisées |
|---|---|---|
| `pipeline.js` | **Suppression totale de `fetchFullArticle`** dans FILTER. Le contenu RSS (`fullContent` ou `description`) est utilisé tel quel. | -40 à -60 |
| `pipeline.js` | EXTRACT : forçage à 1 seul appel IA (plus de parallélisation par catégorie) | -1 à -3 |
| `pipeline.js` | DRAFT : 1 recherche web au lieu de 3 | -2 à -4 |
| `ai.js` | Suppression des retry dans `callOpenAI()` (la cascade fallback Mistral→Gemini→WorkersAI gère déjà les pannes) | -2 à -4 |
| `ai.js` | SYNTHESIS : 1 seul appel IA (suppression du 2e appel de "polissage final") | -1 à -3 |
| `ai.js` | Timeout réduit de 240s à 120s pour Mistral et Gemini | — |
| `ai.js` | `max_tokens` réduit de 16000 à 12000 (Mistral/Gemini) | — |
| `news-apis.js` | Réduction de 12 à 8 sources (retrait des 4 doublons EN) | -4 |
| `searcher.js` | `webSearch()` : cascade **séquentielle** au lieu de 3 en parallèle | -2 par recherche |
| `searcher.js` | `searchSearXNG()` : 1 seule instance testée au lieu de 6 | -5 |

**Budget final : ~31-42 sous-requêtes** (contre ~80-110).

**Impacts connus :**
- L'IA reçoit des descriptions RSS (~100-300 mots) au lieu de textes complets (~1000+ mots). La qualité de l'extraction des faits est légèrement réduite pour les articles sans `rss_full`.
- Le polissage final en 2 passes est supprimé — la synthèse se fait en 1 appel.
- SearXNG ne tente plus plusieurs instances en cascade.

**Recommandation** : Pour retrouver le comportement v3.1 (extraction texte complète, 2 appels de synthèse, parallélisme), passer au **Workers Paid ($5/mois)** qui offre 1000 sous-requêtes et 30s CPU.

---

### v3.1.0 — Audit complet du code (25+ optimisations) (2026-07-02)

Audit complet du code par review statique. **25+ modifications** appliquées à travers 10 fichiers, incluant **6 corrections de bugs critiques**.

#### Bugs critiques corrigés

| # | Fichier | Bug | Correction |
|---|---|---|---|
| 1 | `src/ai.js` | 4 fautes de frappe dans les prompts : `"TAQUE"` au lieu de `"TAACHE"` | Remplacement dans STAGE1, STAGE2, STAGE3, STAGE5 |
| 2 | `src/ai.js` | Injection XML possible : les titres/articles contenant `<` ou `&` cassaient le parsing | Ajout de `escapeXML()` pour sanitize tous les champs XML dans `buildArticlesXML()` |
| 3 | `src/searcher.js` | Import cassé : `extractTextFromHTML` importé de `./pipeline.js` au lieu de `./extractor.js` | Correction de l'import |
| 4 | `src/pipeline.js` | Double lecture KV dans `phaseSynthesis` : `KV_ARTICLES` lu 2 fois | Suppression de la lecture en doublon |
| 5 | `src/news-apis.js` | Mediastack URL en `http://` (devrait être `https://`) | Correction vers `https://api.mediastack.com/v1/news` |
| 6 | `src/extractor.js` | Code mort : `HTMLRewriter` importé mais jamais utilisé (incompatible Workers sans `compatibility_flags`) | Suppression complète, remplacement par extraction regex |

#### Optimisations du pipeline

| # | Fichier | Optimisation |
|---|---|---|
| 1 | `pipeline.js` | Recherche web dans DRAFT : parallélisation via `Promise.allSettled` (3 requêtes simultanées) |
| 2 | `pipeline.js` | Extraction texte dans FILTER : batch de 5 concurrents au lieu de séquentiel |
| 3 | `pipeline.js` | Mise à jour des imports email : ajout de `buildEmailText` et `buildSubject` |
| 4 | `ai.js` | Retry automatique (2 tentatives) sur HTTP 429 (rate limit) et 5xx dans `callOpenAI()` |
| 5 | `ai.js` | `max_tokens` augmenté : 8000→16000 (Mistral/Gemini), 6000→8000 (Workers AI) |
| 6 | `ai.js` | Détection des réponses vides/courtes (<50 chars) → déclenche le fallback provider suivant |
| 7 | `searcher.js` | Cascade web search : passage de séquentiel à **parallèle** (NewsAPI + DDG + SearXNG en course, premier gagnant via `Promise.race`) |
| 8 | `searcher.js` | Timeout global de 12s sur la cascade de recherche |
| 9 | `searcher.js` | Ajout de `decodeEntities()` pour décoder les entités HTML dans les snippets DDG |
| 10 | `searcher.js` | Brave Search comme dernier recours (fallback optionnel) |

#### Optimisations de l'extraction et du filtrage

| # | Fichier | Optimisation |
|---|---|---|
| 1 | `extractor.js` | Réécriture complète : extraction regex (remplacement du code mort HTMLRewriter) |
| 2 | `extractor.js` | Ajout extraction JSON-LD `articleBody` avec support `@graph` |
| 3 | `extractor.js` | Ajout de `extractMetadata()` pour les titres/descriptions Open Graph |
| 4 | `extractor.js` | Décodage des entités HTML dans `stripTags()` (`&nbsp;`, `&amp;`, `&laquo;`, `&mdash;`, etc.) |
| 5 | `extractor.js` | Troncature à la frontière de phrase (et non au milieu d'un mot) |
| 6 | `filter.js` | Réécriture complète du scoring : système à points multi-critères (50-100) |
| 7 | `filter.js` | Sélection en 2 passes : diversité par source d'abord, puis score |
| 8 | `filter.js` | Plafond `maxPerSource=8` pour éviter la domination d'une source |
| 9 | `filter.js` | Nouveaux critères : EN +5, >500 mots +25, <12h +15, >48h -10, premium +10, titre générique -30 |

#### Optimisations de l'email et du fetch

| # | Fichier | Optimisation |
|---|---|---|
| 1 | `email.js` | Réécriture complète : `markdownToHTML()` robuste avec préservation des émojis |
| 2 | `email.js` | Support `***bold italic***` en plus de `**bold**` et `*italic*` |
| 3 | `email.js` | Sanitisation HTML : protection des balises safe, échappement du reste |
| 4 | `email.js` | Ajout de `buildEmailText()` pour la version plaintext (meilleure délivrabilité) |
| 5 | `email.js` | Ajout de `buildSubject()` qui extrait le 1er thème du contenu |
| 6 | `email.js` | Envoi multipart HTML+text via Resend |
| 7 | `fetcher.js` | 4e niveau anti-paywall : headers Facebookbot (`ALT_HEADERS_FACEBOOK`) |
| 8 | `fetcher.js` | Import de la constante `ALT_HEADERS_FACEBOOK` depuis `sources.js` |

#### Divers

| # | Fichier | Optimisation |
|---|---|---|
| 1 | `news-apis.js` | Requête EN diversifiée : `"Europe economy politics"` au lieu de traduction littérale |
| 2 | `index.js` | Retrait de `err.stack` des réponses HTTP (sécurité) |
| 3 | `index.js` | Ajout de `safeRunPhase()` pour les phases tardives tolérantes aux erreurs |
| 4 | `index.js` | Ajout de la route `GET /test/apis` |
| 5 | `.gitignore` | Ajout du pattern `*research.json` |
| 6 | `package.json` | Version bump → 3.1.0 |

---

### v3.0 — Refonte CoT multi-étapes (2026-06-30)

Refonte majeure : passage d'un génération mono-appel à un pipeline Chain of Thought en 5 étapes IA.

**Nouvelles fonctionnalités :**
- Pipeline 8 phases (FETCH → FILTER → EXTRACT → THEME → DRAFT → REVIEW → SYNTHESIS → DELIVER)
- Chaîne de pensée IA (CoT) avec 5 étapes spécialisées (Extracteur → Thématicien → Rédacteur → Critique → Éditeur en Chef)
- Cascade IA Mistral → Gemini → Workers AI
- Format éditorial "Smart Brevity" inspiré d'Axios
- 16 flux RSS avec stratégies multi-sources (direct, jina_html, telegram_embed)
- 12 News APIs (FR + EN)
- Recherche web complémentaire dans la phase DRAFT
- Filtre anti-paywall à 4 niveaux (Googlebot, Jina, Facebookbot)
- Scoring multi-critères des articles
- Déduplication par similarité Jaccard
- Email multipart HTML+text via Resend

---

### v2.x — Versions intermédiaires (2026-06-30)

Itérations rapides pendant le développement initial :
- Ajout progressif des sources RSS
- Mise en place du KV comme bus inter-phases
- Premiers tests de l'API Resend
- Configuration des clés API

---

### v1.0 — Version initiale (2026-06-30)

- Première version déployée sur Cloudflare Workers
- Pipeline basique en 3 phases (fetch → generate → send)
- Quelques flux RSS
- Génération IA mono-appel
- Commit initial : `cdca6a4`

---

## 📊 Budget de sous-requêtes

Le plan gratuit Cloudflare Workers limite à **50 sous-requêtes** (`fetch()`) par invocation. Chaque `fetch()` compte, y compris les appels API, RSS, et KV.

### Budget v3.2.0 (plan gratuit compatible)

| Phase | Sous-requêtes | Détail |
|---|---|---|
| FETCH | ~24 | 16 RSS + 8 News APIs (NYT = 2 appels internes) |
| FILTER | 0 | Utilise le contenu RSS tel quel (pas de `fetchFullArticle`) |
| EXTRACT | 1-3 | 1 appel IA (cascade Mistral→Gemini→WorkersAI si erreur) |
| THEME | 1-3 | 1 appel IA |
| DRAFT | 2-5 | 1 recherche web séquentielle (1-4 fetchs) + 1 appel IA |
| REVIEW | 1-3 | 1 appel IA |
| SYNTHESIS | 1-3 | 1 appel IA |
| DELIVER | 1 | 1 appel Resend |
| **TOTAL** | **~31-42** | ✅ Sous la limite de 50 |

### Budget v3.1.0 (nécessitait le plan payant)

| Phase | Sous-requêtes | Détail |
|---|---|---|
| FETCH | ~29 | 16 RSS + 12 News APIs |
| FILTER | ~40-80 | `fetchFullArticle` pour chaque article RSS (jusqu'à 3 tentatives anti-paywall) |
| EXTRACT | 1-6 | 1-2 appels IA parallèles + cascade |
| THEME | 1-3 | 1 appel IA |
| DRAFT | 4-10 | 3 recherches web parallèles + 1 appel IA |
| REVIEW | 1-3 | 1 appel IA |
| SYNTHESIS | 2-6 | 2 appels IA séquentiels + cascade |
| DELIVER | 1 | 1 appel Resend |
| **TOTAL** | **~79-137** | ❌ Hors limite gratuite (50), OK sur payant (1000) |

---

## ⚙ Configuration

### `wrangler.toml`

```toml
name = "revue-presse"
main = "src/index.js"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["0 6 * * 1-5"]  # Lundi-Vendredi à 6h (Europe/Paris)

[[kv_namespaces]]
binding = "CACHE"
id = "ef1ef185628f45d9bc6f9d5c209b0efe"

[vars]
DESTINATION_EMAIL = "ferrierjonas@gmail.com"
TIMEZONE = "Europe/Paris"
MAX_ARTICLES = "50"
MAX_WORDS_PER_ARTICLE = "1500"
AI_PROVIDER = "auto"
PUBLIC_URL = "https://revue-presse.jeanneaj.workers.dev"

[ai]
binding = "AI"
```

### Secrets (via `wrangler secret put`)

| Secret | Usage | Service |
|---|---|---|
| `MISTRAL_API_KEY` | IA primaire | Mistral AI |
| `GEMINI_API_KEY` | IA fallback 1 | Google Gemini |
| `RESEND_API_KEY` | Envoi email | Resend |
| `CURRENTS_API_KEY` | News API | Currents API |
| `GNEWS_API_KEY` | News API | GNews |
| `GUARDIAN_API_KEY` | News API | The Guardian |
| `NYT_API_KEY` | News API | NYT |
| `MEDIASTACK_API_KEY` | News API | Mediastack |
| `NEWSDATA_API_KEY` | News API | NewsData.io |
| `NEWSAPI_KEY` | News API + Recherche web | NewsAPI.org |
| `NOOZRA_API_KEY` | News API (optionnel) | Noozra |
| `BRAVE_API_KEY` | Recherche web (optionnel) | Brave Search |

---

## 🛣 Routes API

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/` | Statut global (version + dernier FETCH) |
| `GET` | `/status` | Statut détaillé de chaque phase CoT |
| `POST` | `/trigger/fetch` | Phase 1 — RSS + News APIs |
| `POST` | `/trigger/filter` | Phase 2 — Dédup + scoring |
| `POST` | `/trigger/extract` | Phase 3 — Extraction IA |
| `POST` | `/trigger/theme` | Phase 4 — Thématisation IA |
| `POST` | `/trigger/draft` | Phase 5 — Rédaction + Web search |
| `POST` | `/trigger/review` | Phase 6 — Revue critique IA |
| `POST` | `/trigger/synthesis` | Phase 7 — Synthèse EIC |
| `POST` | `/trigger/deliver` | Phase 8 — Envoi email |
| `POST` | `/trigger/all` | Pipeline complet (test manuel) |
| `GET` | `/test/search?q=...` | Test recherche web |
| `GET` | `/test/apis` | Test News APIs |

---

## 🔑 Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `DESTINATION_EMAIL` | — | Email de destination (obligatoire) |
| `TIMEZONE` | `Europe/Paris` | Fuseau horaire pour les dates |
| `MAX_ARTICLES` | `50` | Nombre max d'articles sélectionnés |
| `MAX_WORDS_PER_ARTICLE` | `1500` | Troncature du texte par article |
| `AI_PROVIDER` | `auto` | `auto` (cascade), `mistral`, `gemini`, `workersai` |
| `PUBLIC_URL` | — | URL publique du worker |

---

## 🚀 Déploiement

```bash
# Installer les dépendances
npm install

# Déployer sur Cloudflare Workers
CLOUDFLARE_API_TOKEN=xxx npx wrangler deploy

# Configurer les secrets
npx wrangler secret put MISTRAL_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put RESEND_API_KEY
# ... etc

# Tester manuellement
curl -X POST https://revue-presse.jeanneaj.workers.dev/trigger/all

# Voir les logs en temps réel
npx wrangler tail
```

---

## 💡 Propositions et axes d'amélioration

### Priorité haute

- [ ] **Vérifier l'email Resend** : L'expéditeur actuel `onboarding@resend.dev` est un domaine de test. Pour la production, ajouter un domaine personnalisé dans Resend (ex: `revue@ton-domaine.com`). Vérifier aussi que `ferrierjonas@gmail.com` est bien vérifié dans le dashboard Resend.
- [ ] **Workers Paid ($5/mois)** : Nécessaire pour le cron fiable (CPU 30s vs 10ms free), 1000 sous-requêtes (vs 50), et temps d'exécution étendu (15 min vs quelques secondes).
- [ ] **Restaurer l'extraction texte dans FILTER** : Sur le plan payant, ré-intégrer `fetchFullArticle` pour que l'IA reçoive du texte complet (qualité bien supérieure).

### Priorité moyenne

- [ ] **Phase 5 (DRAFT) à 2 appels IA** : Le design original prévoyait 2 appels : un pour le plan éditorial, un pour la rédaction. Simplifié à 1 appel pour les sous-requêtes. À restaurer sur plan payant.
- [ ] **Thématisation parallèle** : Diviser les articles en 3 groupes thématiques et lancer l'extraction en parallèle (3 appels IA simultanés). Actuellement séquentiel.
- [ ] **Domaine email personnalisé** : Configurer un domaine dans Resend pour utiliser `revue-presse@domaine.com` au lieu de `onboarding@resend.dev`.
- [ ] **Gestion des erreurs cron** : Si le cron échoue, envoyer une notification (email ou webhook) au lieu de échouer silencieusement.
- [ ] **Tests unitaires** : Ajouter des tests pour `filter.js` (scoring, dédup), `extractor.js` (extraction HTML), `email.js` (markdown→HTML).

### Priorité basse / Nice-to-have

- [ ] **Queue-based pipeline** : Utiliser Cloudflare Queues pour découper le pipeline en invocations séparées (chaque phase = 1 invocation avec son propre budget de sous-requêtes). Permettrait de revenir au comportement v3.1 même sur le plan gratuit.
- [ ] **Cache RSS** : Mettre en cache les flux RSS dans KV (TTL 30 min) pour éviter de les re-fetcher si le pipeline est relancé rapidement.
- [ ] **Webhook de notification** : Envoyer un webhook Slack/Discord quand la revue est envoyée (ou en cas d'erreur).
- [ ] **Désabonnement** : Ajouter un lien de désabonnement dans l'email (conformité CNIL).
- [ ] **Stats de lecture** : Intégrer Resend analytics ou UTM tags pour suivre les clics.
- [ ] **Sources RSS additionnelles** : Ajouter Courrier International, Le Figaro, Libération, AFP, Reuters FR.
- [ ] **Mode "weekend"** : Le samedi, générer une revue hebdomadaire "best-of" de la semaine au lieu du format quotidien.
- [ ] **Interface web** : Page HTML qui affiche la dernière revue en ligne (en plus de l'email).
- [ ] **iCal / Google Calendar** : Générer un calendrier des événements mentionnés dans la revue.
- [ ] **Support PDF** : Générer une version PDF de la revue en plus du HTML.
- [ ] **Multilingue** : Option pour générer la revue en anglais, espagnol, etc.

### Problèmes connus

| Problème | Statut | Note |
|---|---|---|
| Les Échos RSS retourne 429 | En cours | Via Jina proxy, souvent rate-limited |
| Révolution Permanente (Telegram) | Fonctionnel | Parsing HTML instable, peut cesser de fonctionner |
| `onboarding@resend.dev` | Limité | Ne peut envoyer qu'aux emails vérifiés dans Resend |
| Plan gratuit CPU 10ms | Bloquant | Le pipeline complet dépasse largement 10ms CPU |
| SearXNG instances publiques | Instable | 1 seule instance testée en v3.2, peut tomber |

---

## 📁 Structure des fichiers

```
revue-presse/
├── src/
│   ├── index.js          # Point d'entrée Worker + routes HTTP + handler cron
│   ├── pipeline.js       # Orchestration des 8 phases + utilitaires KV
│   ├── ai.js             # Appels IA (Mistral/Gemini/WorkersAI) + 5 prompts CoT
│   ├── fetcher.js        # Fetch RSS + parsing + extraction anti-paywall
│   ├── sources.js        # Configuration des 16 flux RSS + headers
│   ├── filter.js         # Dédup Jaccard + scoring multi-critères
│   ├── extractor.js      # Extraction texte depuis HTML (regex, JSON-LD)
│   ├── news-apis.js      # 8 News APIs (Currents, GNews, Guardian, NYT, etc.)
│   ├── searcher.js       # Recherche web (DDG, NewsAPI, SearXNG, Brave)
│   └── email.js          # Construction email HTML + envoi Resend
├── wrangler.toml         # Configuration Cloudflare Worker
├── package.json
├── .gitignore
└── README.md
```

---

## 📄 Licence

Projet privé — Tous droits réservés.