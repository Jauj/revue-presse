// ============================================================
// ai.js — Chain of Thought multi-étapes (Mixture-of-Agents)
// Providers : Mistral → Gemini → Workers AI (cascade fallback)
// ============================================================

const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ============================================================
// PROMPTS — Format Éditorial Analytique + Chain of Thought
// ============================================================

const BASE_SYSTEM = `Tu es un rédacteur en chef avec 20 ans d'expérience en revue de presse francophone et internationale, spécialisé dans l'analyse éditoriale de fond.

## RÈGLES RÉDACTIONNELLES (obligatoires)
1. **Ton analytique et engagé** : chaque éditorial est une analyse de fond, pas un résumé factuel. Tu croises les sources, tu identifies les dynamiques politiques, économiques et sociales.
2. **Citations entre guillemets** : ouvre chaque éditorial par une citation exacte d'un article source, entre guillemets français « \u00a0» et attribuée avec la source et (id="N").
3. **Paragraphes développés** : 3-5 phrases par paragraphe minimum. Chaque paragraphe développe UNE idée complète avec contexte, analyse et implications.
4. **Attribution systématique** : chaque fait est attribué. Référence les articles par (id="N") dans le corps du texte.
5. **Datage systématique** :
   - Date de publication de la source quand disponible
   - Date de l'événement rapporté (si différente de la date de publication)
   - Exemple : «\u00a0Le 28 juin, le Sénat a publié...\u00a0» (Le Monde, 30 juin) (id="12")
6. **Chiffres précis** : "3,2 millions" jamais "des millions"
7. **Voix active** : "Le gouvernement a annoncé" jamais "Une annonce a été faite"
8. **Connecteurs analytiques** : utilise "Cette séquence révèle", "La question n'est plus X mais Y", "Cette logique s'inscrit dans", "Plus largement", "En attendant".

## GESTION DU BILINGUE FR/EN
- La revue est entièrement rédigée en français
- Les titres d'articles originaux restent dans leur langue (FR ou EN)
- Les sources anglophones sont résumées en français : "Selon Bloomberg..."`;

// ============================================================
// ÉTAPE 1 : EXTRACTION — Structurer les faits clés de chaque article
// ============================================================
const STAGE1_PROMPT = `${BASE_SYSTEM}

## TAACHE MISSION — ÉTAPE 1 (EXTRACTION)
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

## TAACHE MISSION — ÉTAPE 2 (THÉMATISATION)
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

## TAACHE MISSION — ÉTAPE 3 (RÉDACTION ÉDITORIALE)
Tu es le **Rédacteur en Chef**. Tu reçois le regroupement thématique (étape 2) ET les articles originaux.
Tu rédiges une revue de presse éditoriale analytique COMPLÈTE.

## FORMAT DE SORTIE OBLIGATOIRE

**Sommaire**

    [Titre de l'éditorial 1]
    [Titre de l'éditorial 2]
    [...]

**1. [Titre éditorial 1 : sous-titre incisif]**
«\u00a0[Citation exacte d'un article, entre guillemets]\u00a0» — [Source] (id="N"). [Phrase de contexte qui situe l'événement avec SA DATE].

[Paragraphe d'analyse 1 : 3-5 phrases développant le contexte, les enjeux, les acteurs. Croise au moins 2 sources. Date l'événement rapporté.]

[Paragraphe d'analyse 2 : 3-5 phrases d'analyse plus profonde — implications, comparaisons historiques, dynamiques structurelles.]

[Optionnel] Pour aller plus loin : [Élargissement du sujet avec une source supplémentaire (id="N").]

---
Sources

    «\u00a0[Titre exact de l'article]\u00a0» — [Nom de la source] — [URL] (id="N")
    «\u00a0[Titre exact]\u00a0» — [Source] — [URL] (id="N")

🔍 Approfondir ce sujet

**2. [Titre éditorial 2]**
[Même format complet]

[...répéter pour chaque thème, max 9 éditoriaux...]

**Points de tension**

    1. **[Question ouverte 1]**
    [2-3 phrases d'analyse avec sources citées.]
    2. **[Question ouverte 2]**
    [2-3 phrases]
    [...max 5 points de tension...]

**À surveiller**

    1. **[Événement à suivre avec sa date si connue]**
    [1-2 phrases : pourquoi c'est important et quoi attendre]
    [...max 6 items...]

## RÈGLES STRICTES
- Maximum 9 éditoriaux thématiques
- Chaque éditorial : 2-3 paragraphes d'analyse développée (3-5 phrases chacun)
- Ouvrir CHAQUE éditorial par une citation exacte entre guillemets «\u00a0...\u00a0» attribuée (source + id)
- Référencer les sources par (id="N") dans le corps du texte
- Dater SYSTEMATIQUEMENT : date de l'événement rapporté + date de publication de la source
- Section Sources à la fin de chaque éditorial avec titre exact, nom source, URL, (id="N")
- Ne RIEN inventer en dehors des articles fournis`;

// ============================================================
// ÉTAPE 4 : REVUE CRITIQUE — Auto-évaluation rigoureuse
// ============================================================
const STAGE4_PROMPT = `Tu es un **Chef de Rédaction Critique** (Peer Reviewer). Tu reçois une revue de presse éditoriale rédigée et les articles sources.
Tu dois l'évaluer avec la plus grande rigueur et produire un rapport de correction.

## CRITÈRES D'ÉVALUATION
1. **Exactitude factuelle** : Chaque fait mentionné existe-t-il dans les articles sources ?
2. **Attribution** : Chaque affirmation est-elle attribuée à une source avec (id="N") ?
3. **Datage** : Chaque fait et chaque source sont-ils datés ? (date événement + date publication source)
4. **Citations** : Chaque éditorial s'ouvre-t-il par une citation exacte entre guillemets « ... » ?
5. **Complétude** : Des articles importants ont-ils été omis ?
6. **Divergences** : Les contradictions entre sources sont-elles bien signalées ?
7. **Qualité éditoriale** : Les éditoriaux sont-ils des analyses de fond développées (pas des bullet points) ?
8. **Format** : Sommaire, éditoriaux numérotés, Sources par éditorial, Points de tension, À surveiller ?
9. **Équilibre** : La diversité des sources est-elle respectée ?

## FORMAT DE SORTIE (rapport structuré)
<review>
<score_global>[1-10]</score_global>
<problemes_faits>
[numéroté : chaque fait non vérifiable ou inventé]
</problemes_faits>
<problemes_datage>
[numéroté : chaque fait ou source non daté]
</problemes_datage>
<problemes_attribution>
[numéroté : chaque affirmation non attribuée ou (id) manquant]
</problemes_attribution>
<problemes_citations>
[numéroté : éditoriaux sans citation d'ouverture ou citation inexacte]
</problemes_citations>
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

## TAACHE MISSION — ÉTAPE 5 (SYNTHÈSE EDITOR-IN-CHIEF)
Tu es l'**Éditeur en Chef**. Tu as entre les mains :
- Un brouillon de revue de presse éditoriale
- Un rapport de relecture critique

Tu produis la **VERSION FINALE** de la revue en intégrant TOUTES les corrections du rapport critique.
C'est cette version qui sera envoyée par email à des lecteurs exigeants.

## CONSIGNES
1. Corriger TOUS les problèmes factuels signalés
2. Ajouter les articles omis identifiés
3. Appliquer TOUTES les améliorations rédactionnelles
4. Conserver le FORMAT ÉDITORIAL ANALYTIQUE EXACT (Sommaire, éditoriaux numérotés, Sources, Points de tension, À surveiller)
5. Si le rapport note un score < 7, réécrire les sections faibles
6. Vérifier que CHAQUE fait est daté (date événement + date source)
7. Vérifier que CHAQUE citation est exacte et entre guillemets «\u00a0...\u00a0»
8. Vérifier que les (id="N") correspondent aux bons articles
9. Ne RIEN inventer qui ne soit dans les articles sources
10. La version finale doit être IMPÉCATABLE

## FORMAT DE SORTIE IDENTIQUE à l'Étape 3
Sommaire → Éditoriaux numérotés avec citations, analyse développée, Sources → Points de tension → À surveiller

RAPPEL DES RÈGLES DE DATAGE :
- Toujours préciser la date de l'événement : «\u00a0Le 28 juin, le Sénat a publié...\u00a0»
- Toujours préciser la date de la source quand elle est disponible : (Le Monde, 30 juin)
- Format combiné : (id="N") avec date source entre parenthèses après le nom`;

// ============================================================
// PROMPT UTILITAIRE : Construire les articles XML — 500 mots
// ============================================================

/** Échappe les caractères XML dangereux pour éviter de casser le parsing */
function escapeXML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDateForAI(dateStr) {
  if (!dateStr) return 'date inconnue';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  } catch { return dateStr; }
}

function buildArticlesXML(articles) {
  let xml = `<articles count="${articles.length}">\n`;
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const text = a.extractedText || a.description || '(indisponible)';
    const excerpt = text.split(/\s+/).slice(0, 500).join(' ');
    xml += `<article id="${i + 1}">\n`;
    xml += `<source>${escapeXML(a.sourceName)}</source>\n`;
    xml += `<lang>${escapeXML(a.sourceLang || 'fr')}</lang>\n`;
    xml += `<category>${escapeXML(a.sourceCategory || 'autre')}</category>\n`;
    xml += `<title>${escapeXML(a.title)}</title>\n`;
    xml += `<pub_date>${escapeXML(formatDateForAI(a.pubDate))}</pub_date>\n`;
    xml += `<content>\n${escapeXML(excerpt)}\n</content>\n`;
    if (a.link) xml += `<url>${escapeXML(a.link)}</url>\n`;
    xml += `</article>\n\n`;
  }
  xml += `</articles>`;
  return xml;
}

// ============================================================
// Appels API — Cascade fallback Mistral → Gemini → Workers AI
// ============================================================

/** Appel IA format OpenAI (Mistral) — timeout 120s, pas de retry (cascade fallback) */
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
      max_tokens: 12000,
      top_p: 0.9,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()).choices[0].message.content;
}

/** Appel Gemini (API native) — timeout 120s */
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
      generationConfig: { temperature: 0.2, maxOutputTokens: 12000, topP: 0.9 },
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
      const r = await env.AI.run(model, { prompt, max_tokens: 8000, temperature: 0.2 });
      const text = r.response || '';
      if (text.length > 100) return text;
    } catch (e) { /* skip */ }
  }
  throw new Error('Workers AI: tous modèles échoués');
}

/**
 * Appel IA avec cascade fallback complète
 * Essaye chaque provider dans l'ordre, passe au suivant en cas d'erreur
 * Les erreurs de contenu vide (pas de texte retourné) déclenchent aussi le fallback
 */
export async function callAI(env, systemPrompt, userPrompt, preferHighQuality = false) {
  const providers = [];

  if (env.MISTRAL_API_KEY) {
    providers.push({ type: 'mistral', model: 'mistral-large-latest', key: env.MISTRAL_API_KEY });
  }
  if (env.GEMINI_API_KEY) {
    providers.push({ type: 'gemini', model: 'gemini-2.0-flash', key: env.GEMINI_API_KEY });
  }
  providers.push({ type: 'workersai' });

  const errors = [];

  for (const provider of providers) {
    try {
      let result;
      if (provider.type === 'mistral') {
        result = await callOpenAI(MISTRAL_ENDPOINT, provider.model, provider.key, systemPrompt, userPrompt);
      } else if (provider.type === 'gemini') {
        result = await callGemini(provider.key, systemPrompt, userPrompt);
      } else {
        result = await callWorkersAI(env, `${systemPrompt}\n\n${userPrompt}`);
      }

      // Vérifier que le contenu est substantiel
      if (!result || result.trim().length < 50) {
        const errMsg = `${provider.type}: réponse vide ou trop courte (${(result || '').length} chars)`;
        errors.push(errMsg);
        console.warn(`[callAI] ${errMsg}`);
        continue;
      }

      console.log(`[callAI] Succès avec ${provider.type}${provider.model ? '/' + provider.model : ''} (${result.length} chars)`);
      return { content: result, provider: provider.type };
    } catch (err) {
      const errMsg = `${provider.type}: ${err.message}`;
      errors.push(errMsg);
      console.error(`[callAI] Échec ${provider.type}: ${err.message}`);
      continue;
    }
  }

  throw new Error(`Tous les providers IA ont échoué: ${errors.join(' | ')}`);
}

// ============================================================
// 5 ÉTAPES DU CHAIN OF THOUGHT
// ============================================================

/**
 * ÉTAPE 1 : Extraction des faits structurés
 */
export async function stage1_extract(articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `Extrais les faits clés de ces ${articles.length} articles :\n\n${xml}`;
  const result = await callAI(env, STAGE1_PROMPT, userPrompt, true);
  return { stage: 'extraction', content: result.content, provider: result.provider };
}

/**
 * ÉTAPE 2 : Thématisation et regroupement
 */
export async function stage2_theme(extraction, articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `Voici les fiches structurées extraites de ${articles.length} articles :\n\n${extraction}\n\n---\n\nArticles originaux pour référence :\n${xml}`;
  const result = await callAI(env, STAGE2_PROMPT, userPrompt, true);
  return { stage: 'theming', content: result.content, provider: result.provider };
}

/**
 * ÉTAPE 3 : Rédaction du brouillon Smart Brevity
 * (optionnellement enrichi par recherche web)
 */
export async function stage3_draft(themes, articles, env, webResearch = null) {
  const xml = buildArticlesXML(articles);

  let userPrompt = `Voici le regroupement thématique :\n\n${themes}\n\n---\n\nArticles originaux :\n${xml}`;

  // Ajouter les résultats de recherche web si disponibles
  if (webResearch && webResearch.length > 0) {
    userPrompt += `\n\n---\n\nRECHERCHE WEB COMPLÉMENTAIRE :\nLes articles ci-dessus proviennent principalement de sources francophones. `;
    userPrompt += `Voici des informations supplémentaires trouvées sur le web pour enrichir la revue :\n\n`;
    for (const item of webResearch) {
      userPrompt += `[${item.source || 'Web'}] ${item.title}\n`;
      userPrompt += `${(item.snippet || item.content || '').substring(0, 300)}\n\n`;
    }
  }

  const result = await callAI(env, STAGE3_PROMPT, userPrompt, true);
  return { stage: 'drafting', content: result.content, provider: result.provider };
}

/**
 * ÉTAPE 4 : Revue critique (auto-évaluation)
 */
export async function stage4_review(draft, articles, env) {
  const xml = buildArticlesXML(articles);
  const userPrompt = `REVUE À ÉVALUER :\n\n${draft}\n\n---\n\nARTICLES SOURCES :\n${xml}`;
  const result = await callAI(env, STAGE4_PROMPT, userPrompt, true);
  return { stage: 'review', content: result.content, provider: result.provider };
}

/**
 * ÉTAPE 5 : Synthèse EIC (version finale)
 * 1 seul appel IA (économie de sous-requêtes)
 */
export async function stage5_synthesis(draft, review, articles, env) {
  const xml = buildArticlesXML(articles);

  const prompt1 = `BROUILLON À AMÉLIORER :\n\n${draft}\n\n---\n\nRAPPORT DE REVUE CRITIQUE :\n\n${review}\n\n---\n\nARTICLES SOURCES :\n${xml}`;
  const synthesisResult = await callAI(env, STAGE5_PROMPT, prompt1, true);

  return { stage: 'synthesis', content: synthesisResult.content, provider: synthesisResult.provider };
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
 * Fonction legacy pour compatibilité
 */
export async function generatePressReview(articles, env) {
  const userPrompt = `Produis la revue de presse à partir des ${articles.length} articles ci-dessous. Traite-les tous.\n\n${buildArticlesXML(articles)}`;
  try {
    const result = await callAI(env, STAGE3_PROMPT, userPrompt, true);
    return { content: result.content, provider: result.provider, model: 'cot-single', success: true };
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