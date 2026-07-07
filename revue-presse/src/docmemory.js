// ============================================================
// docmemory.js — Mémoire documentaire épistémique scientifique
// Pour une organisation politique : bulletins, rapports, textes,
// manifestes, communiqués, analyses internes
//
// Architecture :
//   D1       → documents, claims, relations, journal épistémique
//   Vectorize→ recherche sémantique (optionnel, fallback D1)
//   R2       → fichiers originaux PDF/docx (optionnel)
//   KV       → index et état de l'ingestion
//
// Approche scientifique :
//   - Confirmations, invalidations, ajustements, incertitudes
//   - Traçabilité complète des sources et évolutions
//   - Rétro-références et prospective à partir des tendances
//
// Dégradation gracieuse : si env.DB absent, toutes les fonctions
// retournent null/empty mais ne cassent pas le pipeline existant.
// ============================================================

import { callAI } from './ai.js';

// === Vérification de disponibilité D1 ===
function dbAvailable(env) {
  return !!env.DB;
}

function vectorizeAvailable(env) {
  return !!(env.VECTORIZE && env.AI);
}

// ============================================================
// UTILITAIRES
// ============================================================

function generateId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

function normalizeTopic(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-zàâéèêëïîôùûüÿçœæ0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 60);
}

function now() {
  return new Date().toISOString();
}

/**
 * Découpe un texte en chunks structurels
 * Respecte les paragraphes et sections (## Titre, **Gras**)
 */
function chunkText(text, maxWordsPerChunk = 800) {
  const chunks = [];
  let currentSection = '';
  let currentChunk = '';
  let currentWords = 0;

  const lines = text.split('\n');
  for (const line of lines) {
    // Détecter les titres de section
    const sectionMatch = line.match(/^(#{1,3}\s+.+|\*\*[^*]{3,60}\*\*)\s*$/);
    if (sectionMatch) {
      // Sauvegarder le chunk en cours s'il a du contenu
      if (currentChunk.trim()) {
        chunks.push({
          content: currentChunk.trim(),
          section: currentSection,
        });
        currentChunk = '';
        currentWords = 0;
      }
      currentSection = sectionMatch[1].replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
      currentChunk += line + '\n';
      continue;
    }

    const lineWords = line.split(/\s+/).filter(w => w.length > 0).length;

    // Si ajouter cette ligne dépasse la limite et qu'on a déjà du contenu
    if (currentWords + lineWords > maxWordsPerChunk && currentWords > 100) {
      chunks.push({
        content: currentChunk.trim(),
        section: currentSection,
      });
      // Garder la section mais vider le contenu
      currentChunk = currentSection ? `**${currentSection}** (suite)\n` : '';
      currentWords = 0;
    }

    currentChunk += line + '\n';
    currentWords += lineWords;
  }

  // Dernier chunk
  if (currentChunk.trim()) {
    chunks.push({
      content: currentChunk.trim(),
      section: currentSection,
    });
  }

  return chunks;
}

// ============================================================
// INGESTION — Ajouter un document dans la mémoire
// ============================================================

/**
 * Ingestion d'un document par contenu texte
 * POST /memory/ingest → { title, content, doc_type, date, url?, org_name?, author? }
 */
export async function ingestDocument(env, {
  title,
  content,
  doc_type = 'texte_politique',
  date = null,
  url = null,
  org_name = '',
  author = '',
}) {
  if (!dbAvailable(env)) {
    return { error: 'D1 non configuré. Exécuter setup-infrastructure.sh d\'abord.' };
  }
  if (!title || !content) {
    return { error: 'title et content sont requis.' };
  }
  if (content.trim().length < 50) {
    return { error: 'Le contenu doit faire au moins 50 caractères.' };
  }

  const docId = generateId('doc');
  const docDate = date || new Date().toISOString().split('T')[0];
  const wordCount = content.split(/\s+/).length;
  const timestamp = now();

  try {
    // 1. Créer l'entrée document
    await env.DB.prepare(`
      INSERT INTO documents (id, title, doc_type, source_url, org_name, doc_date, author, status, word_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)
    `).bind(docId, title, doc_type, url || null, org_name, docDate, author, wordCount, timestamp, timestamp).run();

    // 2. Chunking structurel
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}_${String(i).padStart(3, '0')}`;
      await env.DB.prepare(`
        INSERT INTO doc_chunks (id, document_id, content, section, chunk_index, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(chunkId, docId, chunks[i].content, chunks[i].section, i, timestamp).run();
    }

    // 3. Mettre à jour le document
    await env.DB.prepare(`
      UPDATE documents SET chunk_count = ?, updated_at = ? WHERE id = ?
    `).bind(chunks.length, timestamp, docId).run();

    // 4. Indexer dans Vectorize (si disponible)
    if (vectorizeAvailable(env)) {
      await indexChunksInVectorize(env, docId, chunks, doc_type);
    }

    // 5. Extraire les claims via IA (non bloquant pour la réponse)
    // On le fait de façon synchrone ici car c'est le coeur du système
    const extractionResult = await extractClaimsFromDocument(env, docId, content, doc_type);

    // 6. Mettre à jour le statut
    const finalStatus = extractionResult.error ? 'error' : 'extracted';
    const finalClaims = extractionResult.claims?.length || 0;
    await env.DB.prepare(`
      UPDATE documents SET status = ?, claim_count = ?, updated_at = ? WHERE id = ?
    `).bind(finalStatus, finalClaims, now(), docId).run();

    return {
      success: true,
      document_id: docId,
      title,
      doc_type,
      word_count: wordCount,
      chunk_count: chunks.length,
      claims_extracted: finalClaims,
      status: finalStatus,
      provider: extractionResult.provider,
    };
  } catch (err) {
    // Marquer le document en erreur
    try {
      await env.DB.prepare(`
        UPDATE documents SET status = 'error', updated_at = ? WHERE id = ?
      `).bind(now(), docId).run();
    } catch (_) {}

    return { error: err.message, document_id: docId };
  }
}

/**
 * Ingestion depuis une URL (fetch du contenu)
 * POST /memory/ingest/url → { url, title?, doc_type?, date?, org_name? }
 */
export async function ingestFromURL(env, {
  url,
  title = null,
  doc_type = 'texte_politique',
  date = null,
  org_name = '',
}) {
  if (!dbAvailable(env)) {
    return { error: 'D1 non configuré.' };
  }
  if (!url) {
    return { error: 'url est requise.' };
  }

  try {
    // Fetch avec timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RevuePresse-Bot/4.0' },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { error: `Fetch échoué: HTTP ${response.status}` };
    }

    const contentType = response.headers.get('content-type') || '';
    let content = '';

    if (contentType.includes('text/html') || contentType.includes('text/plain')) {
      content = await response.text();
      // Nettoyage basique du HTML
      content = content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else if (contentType.includes('application/pdf') || url.endsWith('.pdf')) {
      return {
        error: 'PDF non supporté directement. Extraire le texte et utiliser /memory/ingest avec le contenu.',
        hint: 'Utiliser un outil comme pdftotext, ou copier-coller le texte.',
      };
    } else {
      content = await response.text();
    }

    if (content.length < 100) {
      return { error: `Contenu trop court (${content.length} chars) après extraction depuis ${url}` };
    }

    // Utiliser le title du HTML si non fourni
    if (!title) {
      const titleMatch = content.match(/<title[^>]*>(.*?)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : url.split('/').pop() || 'Document sans titre';
    }

    return await ingestDocument(env, {
      title,
      content,
      doc_type,
      date,
      url,
      org_name,
    });
  } catch (err) {
    return { error: `Erreur lors du fetch: ${err.message}` };
  }
}

// ============================================================
// EXTRACTION IA — Extraction des claims depuis un document
// ============================================================

const CLAIM_EXTRACTION_SYSTEM = `Tu es un analyste de documents politiques qui extrait des "claims" (assertions) avec une rigueur scientifique épistémique.

## TA MISSION
Analyse le document et extrais TOUTES les assertions substantielles (positions, faits, analyses, engagements, critiques, hypothèses, objectifs). Ne pas extraire les formules de politesse ou les généralités vides.

## TYPES D'ASSERTIONS
- **position** : prise de position officielle de l'organisation ("Nous soutenons...", "Notre position est...")
- **fait** : affirmation factuelle vérifiable, avec chiffres, dates, noms ("Le chômage a augmenté de 2.3%")
- **analyse** : interprétation, argumentation, lien de causalité ("Cette politique mène à...")
- **engagement** : action demandée, promesse, revendication ("Nous demandons la suppression de...")
- **critique** : opposition, rejet, dénonciation ("Nous condamnons...", "Cette mesure est inacceptable")
- **hypothese** : projection, spéculation, scénario ("Il est probable que...", "Si cette tendance se poursuit...")
- **objectif** : but déclaré, cible, horizon ("D'ici 2027, nous visons...")

## POSTURES
- **pour** : soutient activement
- **contre** : s'oppose activement
- **nuance** : apporte des réserves ou des précisions
- **neutre** : descriptive, sans prise de position
- **critique** : émet un jugement négatif
- **ambivalent** : mélange de soutien et de réserve

## CONFIANCE ÉPISTÉMIQUE (0.0-1.0)
- 0.9-1.0 : fait vérifiable avec source/chiffre cité dans le texte
- 0.7-0.8 : argument solide étayé par des données ou un raisonnement rigoureux
- 0.5-0.6 : raisonnement logique cohérent mais sans preuve directe
- 0.3-0.4 : opinion informée, spéculation raisonnable
- 0.0-0.2 : affirmation non étayée, pure déclaration

## RÈGLES
- Conserver le TEXTE EXACT de l'assertion (pas de paraphrase)
- Une assertion = une idée complète avec son argument principal
- Ne pas décomposer une argumentation en micro-assertions artificielles
- Chaque claim doit avoir un THÈME principal unique
- Si un chiffre ou une date est mentionné, le type doit être "fait" sauf s'il sert d'argument dans une "analyse"
- Les promesses et revendications sont des "engagement"
- Les doutes et projections sont des "hypothese"

## FORMAT DE RÉPONSE
JSON STRICT, pas de markdown, pas de commentaires :
{
  "claims": [
    {
      "claim_text": "texte exact de l'assertion",
      "claim_type": "position|fait|analyse|engagement|critique|hypothese|objectif",
      "topic": "thème principal en 2-4 mots",
      "stance": "pour|contre|nuance|neutre|critique|ambivalent",
      "confidence": 0.75,
      "evidence_summary": "résumé des preuves invoquées dans le texte",
      "temporal_start": "YYYY-MM-DD ou null",
      "temporal_end": "YYYY-MM-DD ou null"
    }
  ]
}

Maximum 25 claims. Extrais les assertions les plus substantielles.`;

async function extractClaimsFromDocument(env, documentId, content, docType) {
  try {
    // Tronquer le contenu pour rester dans les limites du contexte
    const maxChars = 25000; // ~6000 mots
    const truncatedContent = content.length > maxChars
      ? content.substring(0, maxChars) + '\n\n[... document tronqué ...]'
      : content;

    const userPrompt = `Voici un ${docType} à analyser. Extrais les assertions substantielles :\n\n---\n${truncatedContent}\n---\n\nProduis le JSON des claims.`;

    const result = await callAI(env, CLAIM_EXTRACTION_SYSTEM, userPrompt, false, 'extraction');
    let jsonStr = result.trim();

    // Parser JSON robuste
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
    }

    const parsed = JSON.parse(jsonStr);
    const claims = parsed.claims || [];

    if (claims.length === 0) {
      return { claims: [], provider: 'unknown', warning: 'Aucune claim extraite' };
    }

    // Stocker les claims en D1
    const timestamp = now();
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      const claimId = generateId('claim');
      const topicNorm = normalizeTopic(c.topic || 'sans_theme');

      await env.DB.prepare(`
        INSERT INTO claims (id, document_id, claim_text, claim_type, topic, stance, epistemic_status, confidence, evidence_summary, temporal_start, temporal_end, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)
      `).bind(
        claimId, documentId,
        c.claim_text?.substring(0, 2000) || '',
        c.claim_type || 'position',
        c.topic?.substring(0, 100) || 'sans_theme',
        c.stance || 'neutre',
        Math.min(1.0, Math.max(0.0, c.confidence || 0.5)),
        c.evidence_summary?.substring(0, 500) || '',
        c.temporal_start || null,
        c.temporal_end || null,
        timestamp, timestamp,
      ).run();

      // Index thématique
      await env.DB.prepare(`
        INSERT INTO topic_index (id, topic, topic_normalized, claim_id, document_id, claim_type, epistemic_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)
      `).bind(
        generateId('tpi'),
        c.topic?.substring(0, 100) || 'sans_theme',
        topicNorm,
        claimId, documentId,
        c.claim_type || 'position',
        timestamp,
      ).run();
    }

    // 6. Cross-référence avec les claims existants (détecter contradictions, supports, etc.)
    await crossReferenceNewClaims(env, claims, documentId);

    return { claims, provider: 'ai', count: claims.length };
  } catch (err) {
    console.error(`[DocMemory] Extraction IA échouée pour ${documentId}: ${err.message}`);
    return { claims: [], error: err.message };
  }
}

// ============================================================
// CROSS-RÉFÉRENCE — Comparer nouvelles claims avec existantes
// ============================================================

const CROSSREF_SYSTEM = `Tu es un analyste épistémique scientifique. Tu compares de nouvelles assertions (extraites d'un document) avec des assertions existantes d'une organisation politique.

## TA MISSION
Pour chaque nouvelle assertion, vérifie si elle est en relation avec une assertion existante. Identifie les relations signifiantes uniquement (pas les trivialités).

## TYPES DE RELATION
- **supports** : la nouvelle claim confirme/appuie l'existante (même position renforcée par de nouvelles preuves)
- **contradicts** : la nouvelle claim contredit l'existante (position opposée ou fait incompatible)
- **elaborates** : la nouvelle claim développe/précise l'existante (même idée mais plus détaillée)
- **qualifies** : la nouvelle claim nuance l'existante (ajoute des réserves ou des conditions)
- **supersedes** : la nouvelle claim remplace l'existante (position mise à jour, chiffre révisé)
- **contextualizes** : la nouvelle claim met l'existante en contexte (sans la modifier)
- **evolves_from** : la nouvelle claim est une évolution de l'existante (inflexion, changement progressif)

## IMPACT ÉPISTÉMIQUE
Pour chaque relation, détermine l'impact sur le statut de l'assertion existante :
- Si "supports" avec preuves solides → **confirmed**
- Si "supports" avec preuves faibles → **no_change**
- Si "contradicts" de manière claire → **invalidated** ou **under_review**
- Si "contradicts" partiel → **weakened** ou **uncertain**
- Si "supersedes" → l'existante devient **superseded**
- Si "elaborates" ou "qualifies" → **no_change** (ajouter une note)
- Si "evolves_from" → **under_review** (nécessite analyse plus poussée)

## FORMAT DE RÉPONSE
JSON STRICT :
{
  "relations": [
    {
      "new_claim_index": 0,
      "existing_claim_id": "claim_xxx",
      "relation_type": "supports|contradicts|elaborates|qualifies|supersedes|contextualizes|evolves_from",
      "epistemic_impact": "confirmed|weakened|invalidated|under_review|superseded|uncertain|no_change",
      "explanation": "explication brève de la relation et de son impact"
    }
  ]
}

Identifie uniquement les relations SIGNIFICANTES (pas les correspondances triviales). Maximum 15 relations.`;

async function crossReferenceNewClaims(env, newClaims, documentId) {
  if (!dbAvailable(env)) return;

  try {
    // Récupérer les claims existants actifs (pas invalidated/superseded)
    const { results: existingClaims } = await env.DB.prepare(`
      SELECT id, claim_text, claim_type, topic, stance, epistemic_status, confidence
      FROM claims
      WHERE epistemic_status NOT IN ('invalidated', 'superseded')
        AND document_id != ?
      ORDER BY updated_at DESC
      LIMIT 30
    `).bind(documentId).all();

    if (existingClaims.length === 0) return;

    // Construire le prompt de cross-référence
    const existingText = existingClaims.map((c, i) =>
      `[${i}] id=${c.id} | type=${c.claim_type} | topic=${c.topic} | status=${c.epistemic_status} | "${c.claim_text.substring(0, 200)}"`
    ).join('\n');

    const newText = newClaims.map((c, i) =>
      `[N${i}] type=${c.claim_type} | topic=${c.topic} | stance=${c.stance} | "${c.claim_text?.substring(0, 200)}"`
    ).join('\n');

    const userPrompt = `## Assertions existantes de l'organisation\n${existingText}\n\n## Nouvelles assertions extraites\n${newText}\n\nIdentifie les relations significatives. Produis le JSON.`;

    const result = await callAI(env, CROSSREF_SYSTEM, userPrompt, false, 'review');
    let jsonStr = result.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
    }

    const parsed = JSON.parse(jsonStr);
    const relations = parsed.relations || [];

    if (relations.length === 0) return;

    // Appliquer les relations
    const timestamp = now();
    for (const rel of relations) {
      if (rel.new_claim_index >= newClaims.length) continue;
      const existingClaim = existingClaims.find(c => c.id === rel.existing_claim_id);
      if (!existingClaim) continue;

      // Créer la relation (bidirectionnelle)
      const relId1 = generateId('rel');
      await env.DB.prepare(`
        INSERT INTO claim_relations (id, from_claim_id, to_claim_id, relation_type, evidence, auto_detected, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).bind(relId1, `new_${rel.new_claim_index}`, rel.existing_claim_id, rel.relation_type, rel.explanation?.substring(0, 300) || '', timestamp).run();

      // Appliquer l'impact épistémique si significatif
      if (rel.epistemic_impact && rel.epistemic_impact !== 'no_change') {
        await env.DB.prepare(`
          UPDATE claims SET epistemic_status = ?, updated_at = ? WHERE id = ?
        `).bind(rel.epistemic_impact, timestamp, rel.existing_claim_id).run();

        // Mettre à jour l'index thématique
        await env.DB.prepare(`
          UPDATE topic_index SET epistemic_status = ? WHERE claim_id = ?
        `).bind(rel.epistemic_impact, rel.existing_claim_id).run();

        // Ajouter une entrée au journal d'analyse
        const journalId = generateId('aj');
        await env.DB.prepare(`
          INSERT INTO analysis_journal (id, claim_id, journal_type, content, evidence_sources, trigger_source, created_at)
          VALUES (?, ?, ?, ?, ?, 'cross_reference', ?)
        `).bind(
          journalId,
          rel.existing_claim_id,
          rel.epistemic_impact === 'confirmed' ? 'confirmation' :
          rel.epistemic_impact === 'invalidated' ? 'invalidation' :
          rel.epistemic_impact === 'weakened' ? 'adjustment' :
          rel.epistemic_impact === 'uncertain' ? 'uncertainty_detected' :
          rel.epistemic_impact === 'superseded' ? 'invalidation' : 'adjustment',
          `${rel.relation_type}: ${rel.explanation || 'relation détectée lors de l\'ingestion d\'un nouveau document'}`,
          JSON.stringify([{ document_id: documentId, new_claim_index: rel.new_claim_index }]),
          timestamp,
        ).run();
      }
    }

    console.log(`[DocMemory] Cross-référence: ${relations.length} relations détectées`);
  } catch (err) {
    console.warn(`[DocMemory] Cross-référence échouée (non bloquante): ${err.message}`);
  }
}

// ============================================================
// CONTEXTE POUR LE PIPELINE — Claims pertinents pour les thèmes du jour
// ============================================================

/**
 * Construit le contexte mémoire documentaire pour les thèmes d'aujourd'hui.
 * Appelé par le pipeline (phaseDraft) pour injecter les positions de l'org.
 */
export async function getDocMemoryContext(env, todayThemes, maxClaims = 8) {
  if (!dbAvailable(env)) return null;

  try {
    const timestamp = now();
    const activeStatuses = ['proposed', 'confirmed', 'under_review', 'weakened', 'uncertain'];

    // Pour chaque thème, chercher des claims correspondants
    const allMatchingClaims = [];
    const seenClaimIds = new Set();

    for (const theme of todayThemes.slice(0, 6)) {
      const topicNorm = `%${normalizeTopic(theme)}%`;

      // Recherche D1 par topic
      const { results: claims } = await env.DB.prepare(`
        SELECT c.claim_text, c.claim_type, c.topic, c.stance, c.epistemic_status, c.confidence,
               c.evidence_summary, c.temporal_start, d.title as doc_title, d.doc_date
        FROM claims c
        JOIN documents d ON c.document_id = d.id
        WHERE c.topic LIKE ? OR c.claim_text LIKE ?
          AND c.epistemic_status IN (${activeStatuses.map(() => '?').join(',')})
        ORDER BY
          CASE c.epistemic_status
            WHEN 'confirmed' THEN 1
            WHEN 'proposed' THEN 2
            WHEN 'under_review' THEN 3
            WHEN 'uncertain' THEN 4
            WHEN 'weakened' THEN 5
            ELSE 6
          END,
          c.confidence DESC
        LIMIT 3
      `).bind(topicNorm, topicNorm, ...activeStatuses).all();

      for (const claim of claims) {
        if (!seenClaimIds.has(claim.claim_text?.substring(0, 80))) {
          seenClaimIds.add(claim.claim_text?.substring(0, 80));
          allMatchingClaims.push(claim);
        }
      }
    }

    if (allMatchingClaims.length === 0) return null;

    // Trouver les contradictions récentes (journal des derniers 30 jours)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { results: recentEvents } = await env.DB.prepare(`
      SELECT aj.journal_type, aj.content, aj.trigger_source,
             c.claim_text, c.topic, c.epistemic_status
      FROM analysis_journal aj
      JOIN claims c ON aj.claim_id = c.id
      WHERE aj.created_at > ?
        AND aj.journal_type IN ('invalidation', 'contradiction_new', 'uncertainty_detected')
      ORDER BY aj.created_at DESC
      LIMIT 5
    `).bind(thirtyDaysAgo).all();

    // Trouver les rétro-références vers les revues passées
    const retroRefs = await findRetroReferences(env, todayThemes, 3);

    return buildDocMemoryContextString(allMatchingClaims.slice(0, maxClaims), recentEvents, retroRefs);
  } catch (err) {
    console.warn(`[DocMemory] getDocMemoryContext échoué: ${err.message}`);
    return null;
  }
}

/**
 * Trouve des revues de presse passées qui couvraient les mêmes thèmes
 * pour créer des rétro-références
 */
async function findRetroReferences(env, themes, limit = 3) {
  const refs = [];

  try {
    // Chercher dans l'index D1 des revues de presse
    if (dbAvailable(env)) {
      const { results: priEntries } = await env.DB.prepare(`
        SELECT date, themes FROM press_review_index
        ORDER BY date DESC
        LIMIT 14
      `).all();

      for (const entry of priEntries) {
        if (refs.length >= limit) break;
        try {
          const entryThemes = JSON.parse(entry.themes || '[]');
          const overlap = themes.some(t => {
            const tNorm = normalizeTopic(t);
            return entryThemes.some(et => normalizeTopic(et).includes(tNorm) || tNorm.includes(normalizeTopic(et)));
          });

          if (overlap) {
            refs.push({ date: entry.date, themes: entryThemes.slice(0, 3) });
          }
        } catch (_) {}
      }
    }

    // Compléter avec les mémoires KV si pas assez de résultats
    if (refs.length < limit) {
      const indexRaw = await env.CACHE.get('memory:day_index');
      if (indexRaw) {
        const index = JSON.parse(indexRaw);
        const today = new Date().toISOString().split('T')[0];
        const recentDays = (index.days || [])
          .filter(d => d < today)
          .slice(-14)
          .reverse();

        for (const dateStr of recentDays) {
          if (refs.length >= limit) break;
          const raw = await env.CACHE.get(`memory:day:${dateStr}`);
          if (!raw) continue;
          const mem = JSON.parse(raw);
          const overlap = themes.some(t => {
            const tNorm = normalizeTopic(t);
            return mem.themes.some(mt => normalizeTopic(mt).includes(tNorm) || tNorm.includes(normalizeTopic(mt)));
          });
          if (overlap) {
            refs.push({ date: dateStr, themes: mem.themes.slice(0, 3), source: 'kv' });
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[DocMemory] findRetroReferences échoué: ${err.message}`);
  }

  return refs;
}

function buildDocMemoryContextString(claims, recentEvents, retroRefs) {
  let ctx = '\n## MÉMOIRE DOCUMENTAIRE (positions et analyses de l\'organisation)\n\n';

  // 1. Claims pertinents
  if (claims.length > 0) {
    ctx += '### Positions et analyses documentées sur les thèmes du jour\n';
    ctx += 'Ces assertions sont extraites des documents de l\'organisation. Utilise-les pour contextualiser l\'actualité.\n\n';

    for (const c of claims) {
      const statusIcon = {
        confirmed: '[CONFIRMÉ]',
        proposed: '[PROPOSÉ]',
        under_review: '[EN EXAMEN]',
        weakened: '[AFFAIBLI]',
        uncertain: '[INCERTAIN]',
      }[c.epistemic_status] || '';

      const stanceLabel = {
        pour: '[POUR]', contre: '[CONTRE]', nuance: '[NUANCÉ]',
        neutre: '', critique: '[CRITIQUE]', ambivalent: '[AMBIGU]',
      }[c.stance] || '';

      ctx += `- ${statusIcon}${stanceLabel} **${c.topic}** (${c.claim_type}) : `;
      ctx += `"${c.claim_text.substring(0, 250)}${c.claim_text.length > 250 ? '...' : ''}"`;
      if (c.doc_title) ctx += ` — *${c.doc_title}*`;
      if (c.doc_date) ctx += ` (${c.doc_date})`;
      ctx += '\n';
    }
    ctx += '\n';
  }

  // 2. Événements épistémiques récents (contradictions, invalidations)
  if (recentEvents?.length > 0) {
    ctx += '### Évolutions épistémiques récentes (30 derniers jours)\n';
    ctx += 'Ces éléments ont vu leur statut évoluer récemment. Reste prudent dans leur utilisation.\n\n';
    for (const evt of recentEvents) {
      const typeLabel = {
        invalidation: 'Invalidation',
        contradiction_new: 'Contradiction détectée',
        uncertainty_detected: 'Incertitude',
      }[evt.journal_type] || evt.journal_type;

      ctx += `- [${typeLabel}] **${evt.topic}** : ${evt.content.substring(0, 150)}\n`;
    }
    ctx += '\n';
  }

  // 3. Rétro-références vers les revues passées
  if (retroRefs?.length > 0) {
    ctx += '### Rétro-références (analyses précédentes sur ces thèmes)\n';
    ctx += 'Ces thèmes ont été couverts dans des revues précédentes. Situe l\'évolution.\n\n';
    for (const ref of retroRefs) {
      const themesStr = ref.themes.slice(0, 2).join(', ');
      ctx += `- **${ref.date}** : ${themesStr}`;
      if (ref.source) ctx += ` [${ref.source}]`;
      ctx += '\n';
    }
    ctx += '\n';
  }

  // Instructions d'utilisation
  ctx += '### Instructions mémoire documentaire\n';
  ctx += '- Si l\'actualité du jour CONFIRME une position documentée, mentionne-le avec la source\n';
  ctx += '- Si l\'actualité CONTREDIT une position, signale-le avec prudence et nuance\n';
  ctx += '- Les claims [EN EXAMEN] ou [INCERTAIN] nécessitent une mention prudente\n';
  ctx += '- Les claims [AFFAIBLI] doivent être présentées avec réserve\n';
  ctx += '- Pour les rétro-références, indique si la situation a évolué depuis la date mentionnée\n';
  ctx += '- Ne répète PAS les positions documentées mot pour mot ; intègre-les dans l\'analyse\n';
  ctx += '- En cas de contradiction entre actualité et documentation, ne prends pas parti mais signale l\'écart\n';

  return ctx;
}

// ============================================================
// CROSS-RÉFÉRENCE AVEC LA REVUE DE PRESSE QUOTIDIENNE
// Appelé après la synthèse pour mettre à jour les statuts épistémiques
// ============================================================

/**
 * Compare le contenu de la revue de presse du jour avec les claims existants.
 * Détecte : confirmations, invalidations, nouveaux éléments.
 */
export async function crossReferenceWithPressReview(env, reviewContent, themes, date) {
  if (!dbAvailable(env)) return { updated: 0 };

  try {
    const timestamp = now();
    // Récupérer les claims actifs sur les thèmes du jour
    const activeStatuses = ['proposed', 'confirmed', 'under_review', 'weakened', 'uncertain'];

    // Construire la requête pour chercher des claims pertinents
    const topicConditions = themes.slice(0, 5).map(() => 'c.topic LIKE ?').join(' OR ');
    if (!topicConditions) return { updated: 0 };

    const topicParams = themes.slice(0, 5).map(t => `%${normalizeTopic(t)}%`);
    const query = `
      SELECT c.id, c.claim_text, c.topic, c.epistemic_status, c.claim_type, c.confidence
      FROM claims c
      WHERE (${topicConditions})
        AND c.epistemic_status IN (${activeStatuses.map(() => '?').join(',')})
      ORDER BY c.updated_at DESC
      LIMIT 15
    `;

    const { results: relevantClaims } = await env.DB.prepare(query)
      .bind(...topicParams, ...activeStatuses)
      .all();

    if (relevantClaims.length === 0) return { updated: 0 };

    // Appel IA pour comparer la revue avec les claims
    const claimsText = relevantClaims.map(c =>
      `[${c.id}] (${c.epistemic_status}) ${c.topic}: "${c.claim_text.substring(0, 200)}"`
    ).join('\n');

    const crossRefPrompt = `Tu es un analyste épistémique. Compare cette revue de presse du jour avec les positions existantes de l'organisation.

## Positions existantes
${claimsText}

## Revue de presse du jour (extrait)
${reviewContent.substring(0, 8000)}

Pour chaque position existante, détermine si la revue de presse du jour :
- **confirme** la position (l'actualité va dans le même sens)
- **contredit** la position (l'actualité montre le contraire)
- **nuance** la position (l'actualité apporte des éléments nouveaux)
- **sans relation** (pas de lien direct)

Réponse JSON STRICT :
{
  "assessments": [
    {
      "claim_id": "claim_xxx",
      "assessment": "confirme|contredit|nuance|sans_relation",
      "evidence": "citation brève de la revue de presse pertinente",
      "epistemic_impact": "confirmed|weakened|invalidated|uncertain|no_change",
      "explanation": "explication en une phrase"
    }
  ]
}

Maximum 10 assessments. "sans_relation" = skip (ne pas inclure).`;

    const result = await callAI(env, crossRefPrompt, '', false, 'review');
    let jsonStr = result.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
    }

    const parsed = JSON.parse(jsonStr);
    const assessments = (parsed.assessments || []).filter(a => a.assessment !== 'sans_relation');
    let updatedCount = 0;

    for (const assessment of assessments) {
      if (assessment.epistemic_impact && assessment.epistemic_impact !== 'no_change') {
        await env.DB.prepare(`
          UPDATE claims SET epistemic_status = ?, updated_at = ? WHERE id = ?
        `).bind(assessment.epistemic_impact, timestamp, assessment.claim_id).run();

        await env.DB.prepare(`
          UPDATE topic_index SET epistemic_status = ? WHERE claim_id = ?
        `).bind(assessment.epistemic_impact, assessment.claim_id).run();

        // Journal
        await env.DB.prepare(`
          INSERT INTO analysis_journal (id, claim_id, journal_type, content, evidence_sources, trigger_source, created_at)
          VALUES (?, ?, ?, ?, ?, 'press_review', ?)
        `).bind(
          generateId('aj'),
          assessment.claim_id,
          assessment.epistemic_impact === 'confirmed' ? 'confirmation' :
          assessment.epistemic_impact === 'invalidated' ? 'invalidation' :
          assessment.epistemic_impact === 'weakened' ? 'adjustment' :
          assessment.epistemic_impact === 'uncertain' ? 'uncertainty_detected' : 'adjustment',
          `${assessment.assessment}: ${assessment.explanation || 'mise à jour suite à la revue de presse'}`,
          JSON.stringify([{ evidence: assessment.evidence?.substring(0, 200), date }]),
          timestamp,
        ).run();

        updatedCount++;
      }
    }

    // Indexer la revue de presse dans D1
    const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
    try {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO press_review_index (id, date, themes, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(`pri_${dateStr}`, dateStr, JSON.stringify(themes), timestamp).run();
    } catch (_) {}

    console.log(`[DocMemory] Cross-ref revue: ${updatedCount} claims mis à jour`);
    return { updated: updatedCount, assessed: assessments.length };
  } catch (err) {
    console.warn(`[DocMemory] crossReferenceWithPressReview échoué: ${err.message}`);
    return { updated: 0, error: err.message };
  }
}

// ============================================================
// PROSPECTIVE — Analyse des tendances à partir des claims
// ============================================================

/**
 * Génère une analyse prospective basée sur l'évolution des claims
 * Appelé pendant le dream/distillation
 */
export async function generateProspective(env, daysBack = 30) {
  if (!dbAvailable(env)) return null;

  try {
    // Récupérer les claims avec évolution récente
    const sinceDate = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();

    const { results: journalEntries } = await env.DB.prepare(`
      SELECT aj.journal_type, aj.content, aj.trigger_source, aj.created_at,
             c.topic, c.claim_type, c.epistemic_status, c.claim_text
      FROM analysis_journal aj
      JOIN claims c ON aj.claim_id = c.id
      WHERE aj.created_at > ?
      ORDER BY aj.created_at DESC
      LIMIT 40
    `).bind(sinceDate).all();

    if (journalEntries.length < 5) return null;

    // Grouper par thème
    const byTopic = {};
    for (const entry of journalEntries) {
      const topic = entry.topic || 'sans_theme';
      if (!byTopic[topic]) byTopic[topic] = [];
      byTopic[topic].push(entry);
    }

    // Demander à l'IA une analyse prospective
    const material = Object.entries(byTopic)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([topic, entries]) => {
        const events = entries.slice(0, 5).map(e =>
          `[${e.created_at?.split('T')[0]}] ${e.journal_type}: ${e.content.substring(0, 100)}`
        ).join('\n  ');
        return `**${topic}** (${entries.length} événements):\n  ${events}`;
      }).join('\n\n');

    const prospectivePrompt = `Tu es un analyste prospectif pour une organisation politique. À partir du journal d'évolution des positions et analyses, identifie les tendances et projette les évolutions probables.

## Journal des évolutions récentes
${material}

## TA MISSION
Produis une analyse prospective PRUDENTE (pas de certitudes, seulement des tendances et hypothèses). JSON STRICT :
{
  "trends": [
    {
      "topic": "thème",
      "direction": "renforcement|affaiblissement|inflexion|stabilité|émergence",
      "confidence": 0.7,
      "observation": "ce qui justifie cette tendance",
      "projection": "ce qu'on peut anticiper (avec prudence)",
      "horizon": "court terme (1-2 semaines)|moyen terme (1-3 mois)|long terme (3+ mois)"
    }
  ],
  "cross_theme_insights": [
    "interaction observée entre deux thèmes (ex: économique et social)"
  ],
  "warnings": [
    "signal d'alerte ou risque identifié"
  ]
}

Maximum 6 trends, 3 cross_theme_insights, 3 warnings. Sois PRUDENT : utilise "il semble", "tend à", "pourrait", "les indices suggèrent".`;

    const result = await callAI(env, prospectivePrompt, '', false, 'dream');
    let jsonStr = result.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace >= 0) jsonStr = jsonStr.substring(firstBrace);
    }

    return JSON.parse(jsonStr);
  } catch (err) {
    console.warn(`[DocMemory] generateProspective échoué: ${err.message}`);
    return null;
  }
}

// ============================================================
// RECHERCHE — Interroger la mémoire documentaire
// ============================================================

/**
 * Recherche sémantique (Vectorize) ou textuelle (D1) dans les claims
 */
export async function searchClaims(env, {
  query = null,
  topic = null,
  status = null,
  type = null,
  stance = null,
  limit = 10,
}) {
  if (!dbAvailable(env)) return { results: [], total: 0 };

  try {
    // Si Vectorize disponible et query fourni → recherche sémantique
    if (vectorizeAvailable(env) && query) {
      try {
        const embedding = await env.AI.run('@cf/baai/bge-small-en-v1.5', { text: query });
        const vectorResults = await env.VECTORIZE.query(embedding.data[0].embedding, {
          topK: Math.min(limit, 20),
          returnMetadata: true,
        });

        if (vectorResults.matches?.length > 0) {
          const claimIds = vectorResults.matches.map(m => m.id);
          const placeholders = claimIds.map(() => '?').join(',');
          const { results } = await env.DB.prepare(`
            SELECT c.*, d.title as doc_title, d.doc_date, d.doc_type
            FROM claims c
            JOIN documents d ON c.document_id = d.id
            WHERE c.id IN (${placeholders})
            ORDER BY c.updated_at DESC
          `).bind(...claimIds).all();

          return { results, total: results.length, method: 'semantic' };
        }
      } catch (e) {
        console.warn(`[DocMemory] Vectorize échoué, fallback D1: ${e.message}`);
      }
    }

    // Fallback : recherche D1 textuelle
    let sql = `
      SELECT c.*, d.title as doc_title, d.doc_date, d.doc_type
      FROM claims c
      JOIN documents d ON c.document_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (query) {
      sql += ' AND (c.claim_text LIKE ? OR c.topic LIKE ? OR c.evidence_summary LIKE ?)';
      const q = `%${query}%`;
      params.push(q, q, q);
    }
    if (topic) {
      sql += ' AND c.topic LIKE ?';
      params.push(`%${topic}%`);
    }
    if (status) {
      sql += ' AND c.epistemic_status = ?';
      params.push(status);
    }
    if (type) {
      sql += ' AND c.claim_type = ?';
      params.push(type);
    }
    if (stance) {
      sql += ' AND c.stance = ?';
      params.push(stance);
    }

    sql += ' ORDER BY c.updated_at DESC LIMIT ?';
    params.push(Math.min(limit, 50));

    const { results } = await env.DB.prepare(sql).bind(...params).all();
    return { results, total: results.length, method: 'textual' };
  } catch (err) {
    return { results: [], total: 0, error: err.message };
  }
}

/**
 * Liste les documents ingérés
 */
export async function listDocuments(env, { type = null, limit = 20, status = null } = {}) {
  if (!dbAvailable(env)) return { documents: [], total: 0 };

  try {
    let sql = 'SELECT * FROM documents WHERE 1=1';
    const params = [];

    if (type) {
      sql += ' AND doc_type = ?';
      params.push(type);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(limit, 100));

    const { results } = await env.DB.prepare(sql).bind(...params).all();

    // Compter le total
    const countSql = 'SELECT COUNT(*) as total FROM documents WHERE 1=1';
    const countParams = [];
    if (type) { /* we'll approximate */ }

    return { documents: results, total: results.length };
  } catch (err) {
    return { documents: [], total: 0, error: err.message };
  }
}

/**
 * Détail d'un document avec ses claims
 */
export async function getDocumentDetail(env, documentId) {
  if (!dbAvailable(env)) return null;

  try {
    const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(documentId).first();
    if (!doc) return null;

    const { results: claims } = await env.DB.prepare(
      'SELECT * FROM claims WHERE document_id = ? ORDER BY created_at'
    ).bind(documentId).all();

    const { results: relations } = await env.DB.prepare(`
      SELECT cr.*, c2.claim_text as target_text, c2.topic as target_topic
      FROM claim_relations cr
      JOIN claims c2 ON cr.to_claim_id = c2.id
      WHERE cr.from_claim_id IN (SELECT id FROM claims WHERE document_id = ?)
         OR cr.to_claim_id IN (SELECT id FROM claims WHERE document_id = ?)
    `).bind(documentId, documentId).all();

    return { document: doc, claims, relations };
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================
// ADMIN — Statistiques et gestion
// ============================================================

export async function getDocMemoryStats(env) {
  if (!dbAvailable(env)) {
    return { available: false, message: 'D1 non configuré' };
  }

  try {
    const docCount = await env.DB.prepare('SELECT COUNT(*) as c FROM documents').first();
    const claimCount = await env.DB.prepare('SELECT COUNT(*) as c FROM claims').first();
    const activeClaims = await env.DB.prepare(
      "SELECT COUNT(*) as c FROM claims WHERE epistemic_status NOT IN ('invalidated', 'superseded')"
    ).first();
    const relationCount = await env.DB.prepare('SELECT COUNT(*) as c FROM claim_relations').first();
    const journalCount = await env.DB.prepare('SELECT COUNT(*) as c FROM analysis_journal').first();

    // Distribution par statut épistémique
    const { results: statusDist } = await env.DB.prepare(`
      SELECT epistemic_status, COUNT(*) as count FROM claims GROUP BY epistemic_status ORDER BY count DESC
    `).all();

    // Distribution par type
    const { results: typeDist } = await env.DB.prepare(`
      SELECT claim_type, COUNT(*) as count FROM claims GROUP BY claim_type ORDER BY count DESC
    `).all();

    // Documents par type
    const { results: docTypes } = await env.DB.prepare(`
      SELECT doc_type, COUNT(*) as count FROM documents GROUP BY doc_type ORDER BY count DESC
    `).all();

    // Journal récent (dernières 10 entrées)
    const { results: recentJournal } = await env.DB.prepare(`
      SELECT aj.*, c.topic, c.claim_text
      FROM analysis_journal aj
      LEFT JOIN claims c ON aj.claim_id = c.id
      ORDER BY aj.created_at DESC
      LIMIT 10
    `).all();

    return {
      available: true,
      documents: docCount?.c || 0,
      claims: claimCount?.c || 0,
      activeClaims: activeClaims?.c || 0,
      relations: relationCount?.c || 0,
      journalEntries: journalCount?.c || 0,
      statusDistribution: statusDist,
      typeDistribution: typeDist,
      documentTypes: docTypes,
      recentJournal: recentJournal,
      vectorizeAvailable: vectorizeAvailable(env),
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Supprime un document et toutes ses dépendances (cascade)
 */
export async function deleteDocument(env, documentId) {
  if (!dbAvailable(env)) return { error: 'D1 non configuré' };

  try {
    // R2 cleanup
    if (env.DOCS_BUCKET) {
      const doc = await env.DB.prepare('SELECT r2_key FROM documents WHERE id = ?').bind(documentId).first();
      if (doc?.r2_key) {
        await env.DOCS_BUCKET.delete(doc.r2_key);
      }
    }

    await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(documentId).run();
    return { success: true, deleted: documentId };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Met à jour manuellement le statut épistémique d'un claim
 */
export async function updateClaimStatus(env, claimId, newStatus, reason = '') {
  if (!dbAvailable(env)) return { error: 'D1 non configuré' };

  const validStatuses = ['proposed', 'confirmed', 'weakened', 'invalidated', 'uncertain', 'superseded', 'under_review'];
  if (!validStatuses.includes(newStatus)) {
    return { error: `Statut invalide. Valeurs: ${validStatuses.join(', ')}` };
  }

  try {
    await env.DB.prepare(`
      UPDATE claims SET epistemic_status = ?, updated_at = ? WHERE id = ?
    `).bind(newStatus, now(), claimId).run();

    await env.DB.prepare(`
      UPDATE topic_index SET epistemic_status = ? WHERE claim_id = ?
    `).bind(newStatus, claimId).run();

    // Journal
    await env.DB.prepare(`
      INSERT INTO analysis_journal (id, claim_id, journal_type, content, trigger_source, created_at)
      VALUES (?, ?, 'adjustment', ?, 'manual', ?)
    `).bind(generateId('aj'), claimId, `Statut changé en "${newStatus}". ${reason}`, now()).run();

    return { success: true, claim_id: claimId, new_status: newStatus };
  } catch (err) {
    return { error: err.message };
  }
}

// ============================================================
// VECTORIZE — Indexation sémantique (optionnel)
// ============================================================

async function indexChunksInVectorize(env, docId, chunks, docType) {
  if (!vectorizeAvailable(env)) return;

  try {
    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${docId}_${String(i).padStart(3, '0')}`;
      try {
        const embedding = await env.AI.run('@cf/baai/bge-small-en-v1.5', {
          text: chunks[i].content.substring(0, 2000),
        });
        if (embedding.data?.[0]?.embedding) {
          vectors.push({
            id: chunkId,
            values: embedding.data[0].embedding,
            metadata: {
              document_id: docId,
              doc_type: docType,
              section: chunks[i].section?.substring(0, 100) || '',
              chunk_index: i,
            },
          });
        }
      } catch (e) {
        console.warn(`[DocMemory] Embedding échoué pour ${chunkId}: ${e.message}`);
      }
    }

    if (vectors.length > 0) {
      // Upsert par batch de 100
      for (let i = 0; i < vectors.length; i += 100) {
        const batch = vectors.slice(i, i + 100);
        await env.VECTORIZE.upsert(batch);
      }

      // Mettre à jour les chunk IDs vectorize
      for (const v of vectors) {
        await env.DB.prepare(
          'UPDATE doc_chunks SET vectorize_id = ? WHERE id = ?'
        ).bind(v.id, v.id).run();
      }

      console.log(`[DocMemory] ${vectors.length} chunks indexés dans Vectorize`);
    }
  } catch (err) {
    console.warn(`[DocMemory] Indexation Vectorize échouée (non bloquante): ${err.message}`);
  }
}