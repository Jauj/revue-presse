// ============================================================
// ai.js — Chain of Thought multi-étapes (Mixture-of-Agents)
// Inspiré de badgiovi/news-editor-agent : Extraction → Thématisation
// → Rédaction → Revue critique → Synthèse EIC
// Providers : Gemini (gratuit, étapes 1-3) → Mistral (qualité, 4-5)
// ============================================================

const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ============================================================
// PROMPTS — Système Smart Brevity + Chain of Density
// ============================================================

const BASE_SYSTEM = `Tu es un rédacteur en chef avec 20 ans d'expérience en revue de presse francophone et internationale. Tu combines la rigueur analytique d'un éditeur Reuters avec la lisibilité du style "Smart Brevity" d'Axios.

## RÈGLES RÉDACTIONNELLES (obligatoires)
1. **Pyramide inversée** : l'information la plus importante d'abord
2. **Voix active UNIQUEMENT** : "Le gouvernement a annoncé" jamais "Une annonce a été faite"
3. **Phrases courtes** : 15-18 mots en moyenne, jamais plus de 25
4. **Paragraphes ultra-courts** : 1-3 phrases maximum
5. **Attribution systématique** : chaque fait est attribué ("Selon Le Monde...", "D'après Les Échos...")
6. **Chiffres précis** : "3,2 millions" jamais "des millions"
7. **Zéro éditorialisation** : pas d'adjectifs valorisants sauf entre guillemets et attribués
8. **Bold Axiom** : chaque section thématique s'ouvre par une insight clé en GRAS (2-5 mots)

## GESTION DU BILINGUE FR/EN
- La revue est entièrement rédigée en français
- Les titres d'articles originaux restent dans leur langue (FR ou EN)
- Les sources anglophones sont résumées en français : "Selon Bloomberg..."`;

// ============================================================
// ÉTAPE 1 : EXTRACTION — Structurer les faits clés de chaque article
// ============================================================
const STAGE1_PROMPT = `${BASE_SYSTEM}

## TAQUE MISSION — ÉTAPE 1 (EXTRACTION)
Tu es le **Rédacteur Extracteur**. Tu reçois un ensemble d'articles bruts. Pour CHAQUE article, tu extrais :
1. L'événement clé (1 phrase, voix active)
2. Les données chiffrées mentionnées
3. Les acteurs principaux (personnes, organisations, pays)
4. L'enjeu (pourquoi c'est important, 1 phrase)
5. Le niveau d'importance : CRITIQUE / ÉLEVÉ / MODÉRÉ / FAIBLE

## FORMAT DE SORTIE
Pour chaque article, produis EXACTEMENT ce format :
<fact id="N">
<event>[1 phrase événement clé]</event>
<figures>[données chiffrées ou "aucune"]</figures>
<actors>[liste acteurs]</actors>
<significance>[1 phrase pourquoi c'est important]</significance>
<importance>[CRITIQUE|ÉLEVÉ|MODÉRÉ|FAIBLE]</importance>
<theme_proposal>[thématique proposée en 2-3 mots]</theme_proposal>
</fact>

IMPORTANT : Traite TOUS les articles. Ne rien inventer hors des articles fournis.`;

// ============================================================
// ÉTAPE 2 : THÉMATISATION — Grouper, classer, identifier contradictions
// ============================================================
const STAGE2_PROMPT = `${BASE_SYSTEM}

## TAQUE MISSION — ÉTAPE 2 (THÉMATISATION)
Tu es le **Rédacteur Thématicien**. Tu reçois des fiches structurées d'articles (résultat de l'étape 1).
Tu dois :
1. Regrouper les articles par **thème principal** (max 6 thèmes)
2. Pour chaque thème, classer les articles par importance
3. Identifier les **contradictions** entre sources (si deux sources disent le contraire)
4. Identifier les **angles manquants** dans la couverture
5. Produire une hiérarchie des thèmes (le plus important en premier)

## FORMAT DE SORTIE
<themes>
<theme id="1" priority="1">
<name>[Nom du thème en 3-5 mots]</name>
<axiom>[Insight clé en GRAS, 2-5 mots qui résument le thème]</axiom>
<summary>[2-3 phrases de synthèse inter-sources]</summary>
<articles>[IDs des articles dans ce thème, séparés par virgule]</articles>
<significance>[Pourquoi ce thème domine l'actualité du jour]</significance>
</theme>
[...répéter pour chaque thème...]
</themes>

<divergences>
[Si des sources se contredisent, les expliciter ici avec attribution]
[Si aucune divergence : "Aucune divergence significative identifiée"]
</divergences>

<missing_angles>
[Perspectives ou angles non couverts par les sources]
</missing_angles>`;

// ============================================================
// ÉTAPE 3 : RÉDACTION — Rédiger les sections Smart Brevity
// ============================================================
const STAGE3_PROMPT = `${BASE_SYSTEM}

## TAQUE MISSION — ÉTAPE 3 (RÉDACTION)
Tu es le **Rédacteur de Contenu**. Tu reçois le regroupement thématique (étape 2) ET les articles originaux.
Tu rédiges la revue de presse COMPLÈTE en suivant ce format PRECIS :

📌 **L'ESSENTIEL DU JOUR**
[3-5 lignes, chaque ligne = 1 information clé avec source. Format : **Bold insight** — explication (Source)]

---

📰 **ANALYSE THÉMATIQUE**

**[THÈME 1]**
**[Bold Axiom 2-5 mots] :** [1 phrase synthèse inter-sources]
- [Point clé 1, avec source]
- [Point clé 2, avec source]
- [Point clé 3, avec source]
⚠️ **Divergence :** [Si sources contradictoires — expliciter]
*Pourquoi c'est important :* [1 phrase]
**Articles :** "[Titre]" — *Source* | "[Titre]" — *Source*

**[THÈME 2]**
[Même format]

---

🔍 **TENDANCES & PERSPECTIVES**
- [Tendance 1 avec sources]
- [Tendance 2 avec sources]
- Angle manquant : [perspective non représentée]

---

📊 **CHIFFRES CLÉS**
[Liste des données chiffrées marquantes avec source]

---

🔮 **À SURVEILLER**
- [Événement à suivre 1 — pourquoi et quoi attendre]
- [Événement à suivre 2]

RÈGLES : Maximum 6 thèmes. Chaque point attribué à sa source. Aucune invention.`;

// ============================================================
// ÉTAPE 4 : REVUE CRITIQUE — Auto-évaluation rigoureuse
// ============================================================
const STAGE4_PROMPT = `Tu es un **Chef de Rédaction Critique** (Peer Reviewer). Tu reçois une revue de presse rédigée et les articles sources.
Tu dois l'évaluer avec la plus grande rigueur et produire un rapport de correction.

## CRITÈRES D'ÉVALUATION
1. **Exactitude factuelle** : Chaque fait mentionné existe-t-il dans les articles sources ?
2. **Attribution** : Chaque affirmation est-elle attribuée à une source ?
3. **Complétude** : Des articles importants ont-ils été omis ?
4. **Divergences** : Les contradictions entre sources sont-elles bien signalées ?
5. **Qualité Smart Brevity** : Les sections sont-elles concises, actives, bien structurées ?
6. **Équilibre** : La diversité des sources est-elle respectée ?

## FORMAT DE SORTIE (rapport structuré)
<review>
<score_global>[1-10]</score_global>
<problemes_faits>
[numéroté : chaque fait non vérifiable ou inventé]
</problemes_faits>
<problemes_attribution>
[numéroté : chaque affirmation non attribuée]
</problemes_attribution>
<articles_omis>
[numéroté : articles importants non traités, avec titre et source]
</articles_omis>
<ameliorations_redactionnelles>
[suggestions concrètes pour améliorer chaque section]
</ameliorations_redactionnelles>
<revision_prioritaire>
[1-3 changements les plus importants à faire AVANT publication]
</revision_prioritaire>
</review>`;

// ============================================================
// ÉTAPE 5 : SYNTHÈSE EIC — Production finale intégrant la revue
// ============================================================
const STAGE5_PROMPT = `${BASE_SYSTEM}

## TAQUE MISSION — ÉTAPE 5 (SYNTHÈSE EDITOR-IN-CHIEF)
Tu es l'**Éditeur en Chef**. Tu as entre les mains :
- Un brouillon de revue de presse
- Un rapport de relecture critique

Tu produis la **VERSION FINALE** de la revue en intégrant TOUTES les corrections du rapport critique.
C'est cette version qui sera envoyée par email à des lecteurs exigeants.

## CONSIGNES
1. Corriger TOUS les problèmes factuels signalés
2. Ajouter les articles omis identifiés
3. Appliquer TOUTES les améliorations rédactionnelles
4. Conserver le format Smart Brevity EXACT
5. Si le rapport note un score < 7, réécrire les sections faibles
6. Ne RIEN inventer qui ne soit dans les articles sources
7. La version finale doit être IMPÉCATABLE

## FORMAT DE SORTIE IDENTIQUE à l'Étape 3
📌 **L'ESSENTIEL DU JOUR**
[...format complet Smart Brevity...]
📰 **ANALYSE THÉMATIQUE** [...]
🔍 **TENDANCES** [...]
📊 **CHIFFRES CLÉS** [...]
🔮 **À SURVEILLER** [...]`;

// ============================================================
// PROMPT UTILITAIRE : Construire les articles XML
// ============================================================
function buildArticlesXML(articles) {
  let xml = `<articles count="${articles.length}">\n`;
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const text = a.extractedText || a.description || '(indisponible)';
    const excerpt = text.split(/\s+/).slice(0, 400).join(' ');
    xml += `<article id="${i + 1}">\n`;
    xml += `<source>${a.sourceName}</source>\n`;
    xml += `<lang>${a.sourceLang || 'fr'}</lang>\n`;
    xml += `<category>${a.sourceCategory || 'autre'}</category>\n`;
    xml += `<title>${a.title}</title>\n`;
    xml += `<content>\n${excerpt}\n</content>\n`;
    if (a.link) xml += `<url>${a.link}</url>\n`;
    xml += `</article>\n\n`;
  }
  xml += `</articles>`;
  return xml;
}

// ============================================================
// Appels API
// ============================================================

/** Appel IA format OpenAI (Mistral) */
async function callOpenAI(endpoint, model, apiKey, systemPrompt, userPrompt) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 8000,
      top_p: 0.9,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()).choices[0].message.content;
}

/** Appel Gemini (API native) */
async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url = `${GEMINI_ENDPOINT}?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8000, topP: 0.9 },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/** Workers AI fallback */
async function callWorkersAI(env, prompt) {
  if (!env.AI) throw new Error('Workers AI non configuré');
  const models = ['@cf/meta/llama-3.3-70b-instruct', '@cf/meta/llama-3.1-8b-instruct'];
  for (const model of models) {
    try {
      const r = await env.AI.run(model, { prompt, max_tokens: 6000, temperature: 0.2 });
      if (r.response && r.response.length > 100) return r.response;
    } catch (e) { /* skip */ }
  }
  throw new Error('Workers AI: tous modèles échoués');
}

/** Choisir le meilleur provider disponible */
function getBestProvider(env, preferHighQuality = false) {
  // Haute qualité : Mistral > Gemini > Workers AI
  // Standard : Gemini (gratuit) > Mistral > Workers AI
  if (preferHighQuality) {
    if (env.MISTRAL_API_KEY) return { type: 'mistral', model: 'mistral-large-latest', key: env.MISTRAL_API_KEY };
    if (env.GEMINI_API_KEY) return { type: 'gemini', model: 'gemini-2.0-flash', key: env.GEMINI_API_KEY };
    return { type: 'workersai' };
  } else {
    if (env.GEMINI_API_KEY) return { type: 'gemini', model: 'gemini-2.0-flash', key: env.GEMINI_API_KEY };
    if (env.MISTRAL_API_KEY) return { type: 'mistral', model: 'mistral-large-latest', key: env.MISTRAL_API_KEY };
    return { type: 'workersai' };
  }
}

/** Appel IA unique avec fallback */
async function callAI(env, systemPrompt, userPrompt, preferHighQuality = false) {
  const provider = getBestProvider(env, preferHighQuality);

  try {
    if (provider.type === 'mistral') {
      return await callOpenAI(MISTRAL_ENDPOINT, provider.model, provider.key, systemPrompt, userPrompt);
    } else if (provider.type === 'gemini') {
      return await callGemini(provider.key, systemPrompt, userPrompt);
    } else {
      return await callWorkersAI(env, `${systemPrompt}\n\n${userPrompt}`);
    }
  } catch (err) {
    // Fallback vers le prochain provider
    console.error(`Provider ${provider.type} échoué: ${err.message}, tentative fallback...`);
    if (provider.type === 'gemini' && env.MISTRAL_API_KEY) {
      return await callOpenAI(MISTRAL_ENDPOINT, 'mistral-large-latest', env.MISTRAL_API_KEY, systemPrompt, userPrompt);
    }
    if (provider.type === 'mistral' && env.GEMINI_API_KEY) {
      return await callGemini(env.GEMINI_API_KEY, systemPrompt, userPrompt);
    }
    if (provider.type !== 'workersai') {
      return await callWorkersAI(env, `${systemPrompt}\n\n${userPrompt}`);
    }
    throw err;
  }
}

// ============================================================
// 5 ÉTAPES DU CHAIN OF THOUGHT
// ============================================================

/**
 * ÉTAPE 1 : Extraction des faits structurés
 * Gemini (gratuit) suffit pour cette tâche de structuration
 */
export async function stage1_extract(articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `Extrais les faits clés de ces ${articles.length} articles :\n\n${xml}`;
  const result = await callAI(env, STAGE1_PROMPT, userPrompt, false);
  return { stage: 'extraction', content: result, provider: getBestProvider(env).type };
}

/**
 * ÉTAPE 2 : Thématisation et regroupement
 */
export async function stage2_theme(extraction, articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `Voici les fiches structurées extraites de ${articles.length} articles :\n\n${extraction}\n\n---\n\nArticles originaux pour référence :\n${xml}`;
  const result = await callAI(env, STAGE2_PROMPT, userPrompt, false);
  return { stage: 'theming', content: result, provider: getBestProvider(env).type };
}

/**
 * ÉTAPE 3 : Rédaction du brouillon Smart Brevity
 */
export async function stage3_draft(themes, articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `Voici le regroupement thématique :\n\n${themes}\n\n---\n\nArticles originaux :\n${xml}`;
  const result = await callAI(env, STAGE3_PROMPT, userPrompt, true); // haute qualité pour la rédaction
  return { stage: 'drafting', content: result, provider: getBestProvider(env, true).type };
}

/**
 * ÉTAPE 4 : Revue critique (auto-évaluation)
 */
export async function stage4_review(draft, articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `REVUE À ÉVALUER :\n\n${draft}\n\n---\n\nARTICLES SOURCES :\n${xml}`;
  const result = await callAI(env, STAGE4_PROMPT, userPrompt, true);
  return { stage: 'review', content: result, provider: getBestProvider(env, true).type };
}

/**
 * ÉTAPE 5 : Synthèse EIC (version finale)
 * 2 appels séquentiels espacés de 10 secondes :
 *   - 1er appel : synthèse intégrant la revue
 *   - 2e appel : polissage final
 */
export async function stage5_synthesis(draft, review, articles, env) {
  const xml = buildArticlesXML(articles);

  // === Appel 1 : Synthèse intégrant la revue critique ===
  const prompt1 = `BROUILLON À AMÉLIORER :\n\n${draft}\n\n---\n\nRAPPORT DE REVUE CRITIQUE :\n\n${review}\n\n---\n\nARTICLES SOURCES :\n${xml}`;
  let synthesis = await callAI(env, STAGE5_PROMPT, prompt1, true);
  let provider = getBestProvider(env, true).type;

  // === Délai de 10 secondes entre les appels (Chain of Thought espacé) ===
  await new Promise(r => setTimeout(r, 10000));

  // === Appel 2 : Polissage final ===
  const polishPrompt = `Voici une revue de presse qui vient d'être révisée. Relis-la une dernière fois et produis la VERSION FINALE DÉFINITIVE.
Corrige toute erreur résiduelle, améliore la fluidité, vérifie que chaque fait est attribué.

Revue révisée :
${synthesis}

Articles sources :
${xml}

Rappel du format attendu :
📌 L'ESSENTIEL DU JOUR
📰 ANALYSE THÉMATIQUE
🔍 TENDANCES & PERSPECTIVES
📊 CHIFFRES CLÉS
🔮 À SURVEILLER

IMPORTANT : C'est la version FINALE. Elle doit être parfaite.`;

  try {
    synthesis = await callAI(env, STAGE5_PROMPT, polishPrompt, true);
    provider = getBestProvider(env, true).type;
  } catch (e) {
    // Si le 2e appel échoue, garder le résultat du 1er
    console.error(`Polissage échoué, conservation du 1er jet: ${e.message}`);
  }

  return { stage: 'synthesis', content: synthesis, provider };
}

// ============================================================
// Fallback basé sur des règles
// ============================================================
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
    }
    lines.push('');
  }
  lines.push('---\n');
  lines.push('⚠️ *Mode dégradé — IA indisponible*');
  return lines.join('\n');
}

/**
 * Fonction legacy pour compatibilité (appelée si jamais le CoT n'est pas utilisé)
 */
export async function generatePressReview(articles, env) {
  const userPrompt = `Produis la revue de presse à partir des ${articles.length} articles ci-dessous. Traite-les tous.\n\n${buildArticlesXML(articles)}`;
  try {
    const content = await callAI(env, STAGE3_PROMPT, userPrompt, true);
    return { content, provider: getBestProvider(env, true).type, model: 'cot-single', success: true };
  } catch (err) {
    return {
      content: generateRuleBasedReview(articles),
      provider: 'rule-based-fallback',
      model: 'none',
      success: true,
      isFallback: true,
      lastError: err.message,
    };
  }
}