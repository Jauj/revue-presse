-- ============================================================
-- Schema D1 — Mémoire documentaire épistémique scientifique
-- Pour une organisation politique : bulletins, rapports, textes,
-- manifestes, communiqués, analyses internes
--
-- Approche scientifique :
--   - Chaque assertion (claim) a un statut épistémique
--   - Confirmations, invalidations, ajustements, incertitudes
--   - Traçabilité complète des sources et de l'évolution
--   - Rétro-références et prospective
-- ============================================================

-- === DOCUMENTS ===
-- Chaque document ingéré (bulletin, rapport, texte politique...)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,                    -- doc_YYYY-MM-DD_slug
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'texte_politique',
  -- Types : bulletin, rapport, texte_politique, manifeste, communique,
  --         article_analyse, resolution, tribune, compte_rendu
  source_url TEXT,                        -- URL d'origine si applicable
  r2_key TEXT,                            -- Clé R2 du fichier original (PDF, docx)
  org_name TEXT DEFAULT '',               -- Nom de l'organisation
  doc_date TEXT,                          -- Date du document (pas la date d'ingestion)
  author TEXT DEFAULT '',                 -- Auteur(s) si connu
  metadata_json TEXT DEFAULT '{}',        -- Métadonnées flexibles (JSON)
  status TEXT DEFAULT 'processing',       -- processing | extracted | error
  chunk_count INTEGER DEFAULT 0,
  claim_count INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- === CHUNKS ===
-- Découpage structurel du document pour Vectorize et références
CREATE TABLE IF NOT EXISTS doc_chunks (
  id TEXT PRIMARY KEY,                    -- chunk_docID_NNN
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  section TEXT DEFAULT '',                -- Titre de section extrait
  chunk_index INTEGER NOT NULL,           -- Ordre dans le document
  vectorize_id TEXT,                      -- ID dans l'index Vectorize
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(document_id);

-- === CLAIMS (ASSERTIONS) ===
-- Coeur du système épistémique
-- Chaque claim = une assertion extraite d'un document
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,                    -- claim_NNN (auto-incrément logique)
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id TEXT REFERENCES doc_chunks(id) ON DELETE SET NULL,
  claim_text TEXT NOT NULL,               -- Texte exact de l'assertion
  claim_type TEXT NOT NULL DEFAULT 'position',
  -- Types :
  --   position     : prise de position officielle de l'organisation
  --   fait         : affirmation factuelle (chiffre, événement)
  --   analyse      : interprétation, argumentation, raisonnement
  --   engagement   : action demandée, promesse, revendication
  --   critique     : opposition, rejet, dénonciation
  --   hypothese    : projection, spéculation, scénario
  --   objectif     : but déclaré, cible, horizon

  topic TEXT NOT NULL DEFAULT '',         -- Thème principal (normalisé)
  stance TEXT DEFAULT 'neutre',
  -- Postures : pour, contre, nuance, neutre, critique, ambivalent

  epistemic_status TEXT DEFAULT 'proposed',
  -- Cycle de vie épistémique :
  --   proposed      : nouvellement extraite, non vérifiée
  --   confirmed     : confirmée par des preuves ultérieures
  --   weakened      : des preuves contraires ont affaibli la claim
  --   invalidated   : clairement contredite par de nouveaux faits
  --   uncertain     : preuves contradictoires, statut indéterminé
  --   superseded    : remplacée par une version plus récente
  --   under_review  : en cours d'examen approfondi

  confidence REAL DEFAULT 0.5,            -- 0.0-1.0, confiance épistémique
  --   0.9-1.0 : fait vérifiable avec source citée
  --   0.7-0.8 : argument étayé par des données
  --   0.5-0.6 : raisonnement logique sans preuve directe
  --   0.3-0.4 : opinion ou spéculation informée
  --   0.0-0.2 : affirmation non étayée

  evidence_summary TEXT DEFAULT '',       -- Résumé des preuves invoquées
  temporal_start TEXT,                    -- Début de validité (si mentionné)
  temporal_end TEXT,                      -- Fin de validité (si mentionné)
  superseded_by TEXT REFERENCES claims(id) ON DELETE SET NULL,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_topic ON claims(topic);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(epistemic_status);
CREATE INDEX IF NOT EXISTS idx_claims_type ON claims(claim_type);
CREATE INDEX IF NOT EXISTS idx_claims_doc ON claims(document_id);
CREATE INDEX IF NOT EXISTS idx_claims_stance ON claims(stance);

-- === CLAIM RELATIONS (GRAPHE DE CONNAISSANCES) ===
-- Relations entre assertions : support, contradiction, développement...
CREATE TABLE IF NOT EXISTS claim_relations (
  id TEXT PRIMARY KEY,
  from_claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  to_claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  -- Types de relation :
  --   supports        : la claim A confirme/appuie la claim B
  --   contradicts     : la claim A contredit la claim B
  --   elaborates      : la claim A développe/précise la claim B
  --   qualifies       : la claim A nuance la claim B
  --   supersedes      : la claim A remplace la claim B (plus récente)
  --   contextualizes  : la claim A met la claim B en contexte
  --   evolves_from    : la claim A est une évolution de la claim B
  --   parallels       : parallèle sans relation directe

  evidence TEXT DEFAULT '',               -- Explication de la relation
  auto_detected INTEGER DEFAULT 0,        -- 1 si détectée par IA, 0 si manuelle
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON claim_relations(from_claim_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON claim_relations(to_claim_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON claim_relations(relation_type);

-- === ANALYSIS JOURNAL (JOURNAL ÉPISTÉMIQUE) ===
-- Trace de toutes les évolutions, confirmations, contradictions
CREATE TABLE IF NOT EXISTS analysis_journal (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES claims(id) ON DELETE CASCADE,
  journal_type TEXT NOT NULL,
  -- Types :
  --   confirmation          : preuves ont confirmé la claim
  --   invalidation          : preuves ont invalidé la claim
  --   adjustment            : ajustement partiel de la claim
  --   uncertainty_detected  : preuves contradictoires détectées
  --   hypothesis_raised     : nouvelle hypothèse soulevée
  --   retrospective         : analyse a posteriori d'une évolution
  --   prospective           : projection/tendance anticipée
  --   contradiction_new     : nouvelle contradiction détectée
  --   synthesis             : synthèse de plusieurs éléments

  content TEXT NOT NULL,                  -- Description de l'événement
  evidence_sources TEXT DEFAULT '[]',     -- JSON array de références
  trigger_source TEXT DEFAULT '',
  -- Origine : press_review | new_document | dream | manual | cross_reference

  metadata_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_claim ON analysis_journal(claim_id);
CREATE INDEX IF NOT EXISTS idx_journal_type ON analysis_journal(journal_type);
CREATE INDEX IF NOT EXISTS idx_journal_date ON analysis_journal(created_at);
CREATE INDEX IF NOT EXISTS idx_journal_trigger ON analysis_journal(trigger_source);

-- === TOPIC INDEX ===
-- Index rapide pour la recherche thématique
CREATE TABLE IF NOT EXISTS topic_index (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  topic_normalized TEXT NOT NULL,         -- Version normalisée pour recherche
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  epistemic_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_normalized ON topic_index(topic_normalized);
CREATE INDEX IF NOT EXISTS idx_topic_doc ON topic_index(document_id);
CREATE INDEX IF NOT EXISTS idx_topic_status ON topic_index(epistemic_status);

-- === PRESS REVIEW INDEX ===
-- Index léger des revues de presse pour rétro-références
-- (les revues complètes restent en KV, ceci est un index de recherche)
CREATE TABLE IF NOT EXISTS press_review_index (
  id TEXT PRIMARY KEY,                    -- pri_YYYY-MM-DD
  date TEXT NOT NULL UNIQUE,
  themes TEXT DEFAULT '[]',               -- JSON array des thèmes du jour
  article_count INTEGER DEFAULT 0,
  source_count INTEGER DEFAULT 0,
  provider TEXT DEFAULT '',
  has_memory_context INTEGER DEFAULT 0,
  claim_crossrefs INTEGER DEFAULT 0,      -- Nombre de claims croisés ce jour
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pri_date ON press_review_index(date);