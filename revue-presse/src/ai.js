// ============================================================
// ai.js — Appels IA avec gestion du quota et fallbacks
// Providers : Groq (préféré) → Mistral → Workers AI (dernier recours)
// Prompts optimisés : Smart Brevity (Axios) + Chain of Density
// ============================================================

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

// ============================================================
// SYSTEM PROMPT — Rédacteur en chef avec méthode Smart Brevity
// Basé sur : Axios HQ, Feedly, methodology French "revue de presse",
// Chain of Density (Adams et al. 2023), AP Style
// ============================================================
const SYSTEM_PROMPT = `Tu es un rédacteur en chef expérimenté avec 20 ans de pratique en revue de presse francophone et internationale. Tu combines la rigueur analytique d'un éditeur Reuters avec la lisibilité du style "Smart Brevity" d'Axios.

## IDENTITÉ & MISSION
Tu produis une revue de presse quotidienne de haute qualité pour des lecteurs exigeants. Tu ne te contentes pas de résumer : tu synthétises, tu compares les sources, tu identifies les tendances et les contradictions.

## RÈGLES RÉDACTIONNELLES (obligatoires)
1. **Pyramide inversée** : l'information la plus importante d'abord dans chaque section
2. **Voix active UNIQUEMENT** : zéro passif ("Le gouvernement a annoncé" jamais "Une annonce a été faite")
3. **Phrases courtes** : 15-18 mots en moyenne, jamais plus de 25
4. **Paragraphes ultra-courts** : 1-3 phrases maximum
5. **Attribution systématique** : chaque fait est attribué ("Selon Le Monde...", "D'après Les Échos...")
6. **Chiffres précis** : "3,2 millions" jamais "des millions"
7. **Zéro éditorialisation** : pas d'adjectifs valorisants ("historique", "controversé", "choquant") sauf entre guillemets et attribués
8. **Bold Axiom** : chaque section thématique s'ouvre par une insight clé en GRAS (2-5 mots)

## GESTION DU BILINGUE FR/EN
- La revue est entièrement rédigée en français
- Les titres d'articles originaux restent dans leur langue (FR ou EN)
- Les citations directes conservent leur langue d'origine avec traduction si nécessaire
- Les noms propres, sigles et organisations restent en original
- Les sources anglophones sont résumées en français : "Selon Bloomberg..."

## STRUCTURE DE SORTIE (Markdown)

📌 **L'ESSENTIEL DU JOUR**
[3-5 lignes, chacune = 1 information clé avec source. Format : **Bold insight** — explication (Source)]

---

📰 **ANALYSE THÉMATIQUE**

**[THÈME 1]** (ex: Politique européenne, Crise énergétique, Mouvements sociaux...)
**[Bold Axiom 2-5 mots] :** [1 phrase synthèse inter-sources]
- [Point clé 1, avec source]
- [Point clé 2, avec source]
- [Point clé 3, avec source]
⚠️ **Divergence :** [Si sources contradictoires — expliciter avec attribution]
*Pourquoi c'est important :* [1 phrase de signification]
**Articles :** "[Titre]" — *Source* | "[Titre]" — *Source*

**[THÈME 2]**
[Même format]

---

🔍 **TENDANCES & PERSPECTIVES**
- [Tendance 1 : description courte + sources]
- [Tendance 2 : description courte + sources]
- [Angle manquant dans la couverture : [perspective non représentée]]

---

📊 **CHIFFRES CLÉS**
[Liste des données chiffrées marquantes avec source]

---

🔮 **À SURVEILLER**
- [Événement/story à suivre 1 — pourquoi et quoi attendre]
- [Événement/story à suivre 2]

---
*[Méta : X articles — Sources : liste]*
*[Diversité : évaluation brève de la représentativité des sources]*`;

// ============================================================
// PROMPT UTILITAIRE : Extraction structurée pré-traitement
// Inspiré de Feedly Two-Tier + Chain of Density
// ============================================================
const EXTRACTION_PROMPT = `Pour chaque article ci-dessous, extrais une fiche synthétique structurée au format :

---
**SOURCE :** [nom du média]
**DATE :** [date]
**LANGUE :** [FR/EN]
**TITRE :** [titre original]
**ÉVÉNEMENT CLÉ :** [1 phrase — ce qui s'est passé]
**DONNÉES CLÉS :** [chiffres, pourcentages, figures mentionnés]
**CITATION CLÉ :** [citation la plus significative avec attribution]
**ACTEURS :** [personnes, organisations, pays cités]
**ENJEUX :** [1 phrase — pourquoi c'est important]
---`;

/**
 * Appelle un provider IA avec fallback automatique
 * Architecture 2 couches :
 *   1) Appel unique IA avec prompt structuré (économie de tokens)
 *   2) Fallback basé sur des règles si tous les providers échouent
 */
export async function generatePressReview(articles, env) {
  const provider = env.AI_PROVIDER || 'groq';

  // Construire le contenu utilisateur structuré (XML tags pour efficacité tokens)
  const userContent = buildStructuredPrompt(articles);

  // Essayer chaque provider dans l'ordre
  const providers = getProviders(env, provider);

  for (const p of providers) {
    try {
      let result;
      if (p.name === 'WorkersAI') {
        result = await callWorkersAI(env, SYSTEM_PROMPT, userContent);
      } else {
        result = await callAI(p.endpoint, p.model, p.apiKey, SYSTEM_PROMPT, userContent);
      }
      return {
        content: result,
        provider: p.name,
        model: p.model,
        success: true,
      };
    } catch (err) {
      console.error(`Provider ${p.name} échoué: ${err.message}`);
    }
  }

  // Tous les providers ont échoué → fallback basé sur des règles
  return {
    content: generateRuleBasedReview(articles),
    provider: 'rule-based-fallback',
    model: 'none',
    success: true,
    isFallback: true,
  };
}

/**
 * Construit le prompt utilisateur structuré avec XML tags
 * Optimisation tokens : titre + extrait + métadonnées plutôt que texte intégral
 * Placer les articles les plus importants en premier et dernier ("lost in the middle")
 */
function buildStructuredPrompt(articles) {
  // Évaluer la longueur totale pour décider du format
  const totalWords = articles.reduce((sum, a) => {
    const text = a.extractedText || a.description || '';
    return sum + text.split(/\s+/).length;
  }, 0);

  let prompt = `## CONSIGNE\n`;
  prompt += `Produis la revue de presse à partir des ${articles.length} articles ci-dessous. `;
  prompt += `Les articles sont en français et en anglais. Traite-les tous.\n\n`;

  if (totalWords > 15000) {
    // Mode économie : extraits structurés pour économiser les tokens
    prompt += `MODE : Articles compressés (titres + extraits clés).\n\n`;
    prompt += `<articles>\n`;
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const text = a.extractedText || a.description || '(indisponible)';
      // Extraire les 800 premiers mots pour le mode compressé
      const excerpt = text.split(/\s+/).slice(0, 800).join(' ');
      prompt += `<article id="${i + 1}">\n`;
      prompt += `<source>${a.sourceName}</source>\n`;
      prompt += `<lang>${a.sourceLang || 'fr'}</lang>\n`;
      prompt += `<category>${a.sourceCategory || 'autre'}</category>\n`;
      prompt += `<title>${a.title}</title>\n`;
      if (a.author) prompt += `<author>${a.author}</author>\n`;
      prompt += `<content>\n${excerpt}\n</content>\n`;
      if (a.link) prompt += `<url>${a.link}</url>\n`;
      prompt += `</article>\n\n`;
    }
    prompt += `</articles>\n`;
  } else {
    // Mode complet : articles intégraux
    prompt += `MODE : Articles intégraux.\n\n`;
    prompt += `<articles>\n`;
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const text = a.extractedText || a.description || '(indisponible)';
      // Tronquer à 2000 mots max par article
      const truncated = text.split(/\s+/).slice(0, 2000).join(' ');
      prompt += `<article id="${i + 1}">\n`;
      prompt += `<source>${a.sourceName}</source>\n`;
      prompt += `<lang>${a.sourceLang || 'fr'}</lang>\n`;
      prompt += `<category>${a.sourceCategory || 'autre'}</category>\n`;
      prompt += `<title>${a.title}</title>\n`;
      if (a.author) prompt += `<author>${a.author}</author>\n`;
      prompt += `<content>\n${truncated}\n</content>\n`;
      if (a.link) prompt += `<url>${a.link}</url>\n`;
      prompt += `</article>\n\n`;
    }
    prompt += `</articles>\n`;
  }

  // Rappel des consignes clés (mise en avant pour éviter "lost in the middle")
  prompt += `\n## RAPPEL\n`;
  prompt += `- Groupe par THÈME (pas par source)\n`;
  prompt += `- Chaque thème : bold axiom + 2-3 points clés attribués + "Pourquoi c'est important"\n`;
  prompt += `- Section "Divergence" si les sources se contredisent\n`;
  prompt += `- Section "Tendances" avec angles manquants\n`;
  prompt += `- Section "À surveiller" (prochaines évolutions)\n`;
  prompt += `- Maximum 5-7 thèmes\n`;
  prompt += `- Résumé en français, titres originaux conservés\n`;

  return prompt;
}

/**
 * Appelle l'API d'un provider LLM (format OpenAI-compatible)
 */
async function callAI(endpoint, model, apiKey, systemPrompt, userPrompt) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.25,
      max_tokens: 8000,
      top_p: 0.9,
    }),
    signal: AbortSignal.timeout(120000), // 120s timeout (revues longues)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Appelle Workers AI (Cloudflare natif) comme dernier recours
 */
async function callWorkersAI(env, systemPrompt, userPrompt) {
  if (!env.AI) {
    throw new Error('Workers AI binding non configuré');
  }

  const combined = `${systemPrompt}\n\n${userPrompt}`;

  const response = await env.AI.run(
    '@cf/meta/llama-3.1-8b-instruct',
    {
      prompt: combined,
      max_tokens: 4000,
      temperature: 0.25,
    }
  );

  return response.response;
}

/**
 * Retourne la liste ordonnée des providers à essayer
 */
function getProviders(env, preferred) {
  const providers = [];

  if (preferred === 'groq' && env.GROQ_API_KEY) {
    providers.push({
      name: 'Groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.3-70b-versatile',
      apiKey: env.GROQ_API_KEY,
    });
  } else if (preferred === 'mistral' && env.MISTRAL_API_KEY) {
    providers.push({
      name: 'Mistral',
      endpoint: MISTRAL_ENDPOINT,
      model: 'mistral-large-latest',
      apiKey: env.MISTRAL_API_KEY,
    });
  } else if (preferred === 'workersai') {
    providers.push({
      name: 'WorkersAI',
      endpoint: null,
      model: '@cf/meta/llama-3.1-8b-instruct',
      apiKey: null,
    });
  }

  // Fallbacks
  if (preferred !== 'mistral' && env.MISTRAL_API_KEY) {
    providers.push({
      name: 'Mistral',
      endpoint: MISTRAL_ENDPOINT,
      model: 'mistral-large-latest',
      apiKey: env.MISTRAL_API_KEY,
    });
  }

  if (preferred !== 'groq' && env.GROQ_API_KEY) {
    providers.push({
      name: 'Groq',
      endpoint: GROQ_ENDPOINT,
      model: 'llama-3.3-70b-versatile',
      apiKey: env.GROQ_API_KEY,
    });
  }

  if (preferred !== 'workersai') {
    providers.push({
      name: 'WorkersAI',
      endpoint: null,
      model: '@cf/meta/llama-3.1-8b-instruct',
      apiKey: null,
    });
  }

  return providers;
}

/**
 * Fallback basé sur des règles quand aucune IA n'est disponible
 * Produit une revue de presse structurée (moins riche mais fonctionnelle)
 * Format : Smart Brevity simplifié
 */
function generateRuleBasedReview(articles) {
  const lines = [];

  lines.push('📌 **L\'ESSENTIEL DU JOUR**\n');
  const headlines = articles.slice(0, 5);
  for (const a of headlines) {
    const desc = (a.description || '').replace(/<[^>]*>/g, '').substring(0, 120);
    lines.push(`**${a.title}** — *${a.sourceName}*${desc ? ` : ${desc}` : ''}`);
  }

  lines.push('\n---\n');
  lines.push('📰 **ANALYSE THÉMATIQUE**\n');

  // Grouper par catégorie
  const grouped = {};
  for (const a of articles) {
    const cat = a.sourceCategory || 'Autre';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(a);
  }

  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`**[${cat}]**`);
    for (const a of items) {
      const desc = (a.description || '').replace(/<[^>]*>/g, '').substring(0, 150);
      lines.push(`- **${a.title}** (*${a.sourceName}*): ${desc}...`);
      if (a.link) lines.push(`  [Lire](${a.link})`);
    }
    lines.push('');
  }

  lines.push('---\n');
  lines.push('⚠️ *Mode dégradé — IA indisponible. Les résumés sont des extraits RSS bruts.*');

  return lines.join('\n');
}