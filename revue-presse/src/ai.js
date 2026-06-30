// ============================================================
// ai.js — Appels IA avec gestion du quota et fallbacks
// Providers : Groq (préféré) → Mistral → Workers AI (dernier recours)
// ============================================================

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';

/**
 * Prompt système pour la revue de presse
 */
const SYSTEM_PROMPT = `Tu es un journaliste analyste expérimenté, spécialisé dans la veille presse francophone et internationale.

Ta mission : produire une revue de presse quotidienne de haute qualité, structurée et insightée.

RÈGLES STRICTES :
1. Résume chaque article en 2-3 phrases maximum
2. Regroupe les articles par THÈME (pas par source)
3. Identifie les TENDANCES et les LIENS entre les articles
4. Mets en évidence les informations les plus importantes
5. Sois neutre et factuel — pas d'opinion personnelle
6. Utilise un français soutenu mais accessible
7. Si un article est en anglais, résume-le en français

FORMAT DE SORTIE (obligatoire) :

📌 GRANDS TITRES DU JOUR
[Liste des 3-5 informations les plus marquantes, chacune en 1 ligne]

---

📰 ANALYSE THÉMATIQUE

**[THÈME 1]** (ex: Politique française, Économie, Technologie, International, etc.)
• **Titre article** (*Source*) : Résumé en 2-3 phrases
• **Titre article** (*Source*) : Résumé en 2-3 phrases

**[THÈME 2]**
• **Titre article** (*Source*) : Résumé en 2-3 phrases

[... continuer par thème ...]

---

🔍 POINTS CLÉS & TENDANCES
[Analyse transversale de 3-5 points : corrélations entre articles, évolutions notables, contradictions entre sources, enjeux sous-jacents]

---

📊 CHIFFRES CLÉS
[Si des chiffres marquants sont mentionnés dans les articles, les lister ici]`;

/**
 * Appelle un provider IA avec fallback automatique
 */
export async function generatePressReview(articles, env) {
  const provider = env.AI_PROVIDER || 'groq';

  // Construire le contenu utilisateur à partir des articles
  const userContent = buildUserPrompt(articles);

  // Essayer chaque provider dans l'ordre
  const providers = getProviders(env, provider);

  for (const p of providers) {
    try {
      let result;
      if (p.name === 'WorkersAI') {
        // Workers AI utilise env.AI.run(), pas un endpoint HTTP
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
      // Passer au provider suivant
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
 * Construit le prompt utilisateur à partir des articles extraits
 */
function buildUserPrompt(articles) {
  let prompt = `Voici les articles collectés ce matin. Produis une revue de presse complète.\n\n`;
  prompt += `--- DÉBUT DES ARTICLES ---\n\n`;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    prompt += `ARTICLE ${i + 1}:\n`;
    prompt += `Source: ${a.sourceName} (${a.sourceCategory})\n`;
    prompt += `Titre: ${a.title}\n`;
    if (a.author) prompt += `Auteur: ${a.author}\n`;
    if (a.pubDate) prompt += `Date: ${a.pubDate}\n`;
    prompt += `Contenu:\n${a.extractedText || a.description || '(contenu non disponible)'}\n\n`;
    prompt += `---\n\n`;
  }

  prompt += `--- FIN DES ARTICLES ---\n\n`;
  prompt += `Rappel : Produis la revue de presse en suivant le format exact demandé dans tes instructions système.`;

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
      temperature: 0.3,
      max_tokens: 6000,
    }),
    signal: AbortSignal.timeout(60000), // 60s timeout
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
  // Workers AI utilise le binding env.AI
  if (!env.AI) {
    throw new Error('Workers AI binding non configuré');
  }

  const combined = `${systemPrompt}\n\n${userPrompt}`;

  const response = await env.AI.run(
    '@cf/meta/llama-3.1-8b-instruct', // Modèle léger pour économiser les neurons
    {
      prompt: combined,
      max_tokens: 4000,
      temperature: 0.3,
    }
  );

  return response.response;
}

/**
 * Retourne la liste ordonnée des providers à essayer
 */
function getProviders(env, preferred) {
  const providers = [];

  // Provider préféré
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
      endpoint: null, // Géré séparément
      model: '@cf/meta/llama-3.1-8b-instruct',
      apiKey: null,
    });
  }

  // Ajouter les autres comme fallback
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

  // Workers AI en dernier recours
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
 */
function generateRuleBasedReview(articles) {
  const lines = [];
  lines.push('📌 GRANDS TITRES DU JOUR\n');

  // Prendre les 5 premiers articles comme "grands titres"
  const headlines = articles.slice(0, 5);
  for (const a of headlines) {
    lines.push(`• ${a.title} (*${a.sourceName}*)`);
  }

  lines.push('\n---\n');
  lines.push('📰 ARTICLES DU JOUR\n');

  // Grouper par catégorie
  const grouped = {};
  for (const a of articles) {
    const cat = a.sourceCategory || 'Autre';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(a);
  }

  for (const [cat, items] of Object.entries(grouped)) {
    lines.push(`\n**${cat}**`);
    for (const a of items) {
      lines.push(`• **${a.title}** (*${a.sourceName}*)`);
      if (a.description) {
        // Tronquer la description à 200 chars
        const desc = a.description.replace(/<[^>]*>/g, '').substring(0, 200);
        lines.push(`  ${desc}...`);
      }
      if (a.link) lines.push(`  [Lire l'article](${a.link})`);
    }
  }

  lines.push('\n---\n');
  lines.push('⚠️ *Cette revue de presse a été générée en mode dégradé (IA indisponible). Les résumés sont des extraits des descriptions RSS.*');

  return lines.join('\n');
}

/**
 * Surcharge de callAI pour gérer Workers AI comme un provider normal
 * (utilisé dans la boucle de fallback)
 */
export { callWorkersAI };