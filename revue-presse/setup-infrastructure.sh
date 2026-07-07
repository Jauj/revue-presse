#!/bin/bash
# ============================================================
# setup-infrastructure.sh — Création des ressources Cloudflare
# pour la mémoire documentaire épistémique (v4.0)
#
# Prérequis : wrangler login effectué
# Tout est GRATUIT (plan Cloudflare Workers free)
#
# Exécution : bash setup-infrastructure.sh
# ============================================================

set -e

echo "=============================================="
echo "  Setup Infrastructure — Revue de Presse v4.0"
echo "  Mémoire documentaire épistémique scientifique"
echo "=============================================="
echo ""

# === 1. D1 Database ===
echo "📦 [1/5] Création de la base D1..."
D1_RESULT=$(npx wrangler d1 create revue-presse-db 2>&1)
echo "$D1_RESULT"

# Extraire l'ID de la base
D1_ID=$(echo "$D1_RESULT" | grep "database_id" | sed 's/.*"\([^"]*\)".*/\1/' || true)

if [ -z "$D1_ID" ]; then
  echo "⚠️  Impossible d'extraire l'ID D1. Vérifie la sortie ci-dessus."
  echo "   Copie l'ID manuellement dans wrangler.toml"
else
  echo "✅ D1 database créée : $D1_ID"

  # Mettre à jour wrangler.toml
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/<DATABASE_ID>/$D1_ID/" wrangler.toml
  else
    sed -i "s/<DATABASE_ID>/$D1_ID/" wrangler.toml
  fi
  echo "✅ wrangler.toml mis à jour avec l'ID D1"
fi

echo ""

# === 2. Appliquer le schéma SQL ===
if [ -n "$D1_ID" ]; then
  echo "📦 [2/5] Application du schéma SQL..."
  npx wrangler d1 execute revue-presse-db --file=./schema.sql --remote
  echo "✅ Schéma SQL appliqué"
else
  echo "⏭️  [2/5] Schéma SQL skipped (pas d'ID D1)"
fi

echo ""

# === 3. Vectorize Index (optionnel — recherche sémantique) ===
echo "📦 [3/5] Création de l'index Vectorize (recherche sémantique)..."
read -p "   Créer l'index Vectorize ? (recommandé, gratuit) [Y/n] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  VEC_RESULT=$(npx wrangler vectorize create revue-presse-memory --dimensions=384 --metric=cosine 2>&1)
  echo "$VEC_RESULT"

  VEC_ID=$(echo "$VEC_RESULT" | grep "index_id" | sed 's/.*"\([^"]*\)".*/\1/' || true)

  if [ -n "$VEC_ID" ]; then
    echo "✅ Vectorize créé : $VEC_ID"

    # Décommenter et mettre à jour les lignes Vectorize dans wrangler.toml
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/# \[\[vectorize\]\]/[[vectorize]]/" wrangler.toml
      sed -i '' "s/# binding = \"VECTORIZE\"/binding = \"VECTORIZE\"/" wrangler.toml
      sed -i '' "s/# index_name = \"revue-presse-memory\"/index_name = \"revue-presse-memory\"/" wrangler.toml
      sed -i '' "s/<INDEX_ID>/$VEC_ID/" wrangler.toml
    else
      sed -i "s/# \[\[vectorize\]\]/[[vectorize]]/" wrangler.toml
      sed -i "s/# binding = \"VECTORIZE\"/binding = \"VECTORIZE\"/" wrangler.toml
      sed -i "s/# index_name = \"revue-presse-memory\"/index_name = \"revue-presse-memory\"/" wrangler.toml
      sed -i "s/<INDEX_ID>/$VEC_ID/" wrangler.toml
    fi
    echo "✅ wrangler.toml mis à jour avec Vectorize"
  else
    echo "⚠️  Impossible d'extraire l'ID Vectorize. Le système fonctionnera en mode texte seul."
  fi
else
  echo "⏭️  [3/5] Vectorize skipped (recherche textuelle uniquement)"
fi

echo ""

# === 4. R2 Bucket (optionnel — stockage PDF) ===
echo "📦 [4/5] Création du bucket R2 (stockage fichiers)..."
read -p "   Créer le bucket R2 ? (utile si tu as des PDFs, gratuit) [Y/n] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Nn]$ ]]; then
  npx wrangler r2 bucket create revue-presse-docs 2>&1
  echo "✅ R2 bucket créé"

  # Décommenter les lignes R2 dans wrangler.toml
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/# \[\[r2_buckets\]\]/[[r2_buckets]]/" wrangler.toml
    sed -i '' "s/# binding = \"DOCS_BUCKET\"/binding = \"DOCS_BUCKET\"/" wrangler.toml
    sed -i '' "s/# bucket_name = \"revue-presse-docs\"/bucket_name = \"revue-presse-docs\"/" wrangler.toml
  else
    sed -i "s/# \[\[r2_buckets\]\]/[[r2_buckets]]/" wrangler.toml
    sed -i "s/# binding = \"DOCS_BUCKET\"/binding = \"DOCS_BUCKET\"/" wrangler.toml
    sed -i "s/# bucket_name = \"revue-presse-docs\"/bucket_name = \"revue-presse-docs\"/" wrangler.toml
  fi
  echo "✅ wrangler.toml mis à jour avec R2"
else
  echo "⏭️  [4/5] R2 skipped (pas de stockage fichiers)"
fi

echo ""

# === 5. Clé API Groq ===
echo "📦 [5/5] Configuration de la clé API Groq..."
if [ -n "$GROQ_API_KEY" ]; then
  echo "$GROQ_API_KEY" | npx wrangler secret put GROQ_API_KEY
  echo "✅ Clé Groq configurée (depuis la variable d'environnement)"
else
  echo "⚠️  Variable GROQ_API_KEY non définie."
  echo "   Utilise : GROQ_API_KEY=ta_cle bash setup-infrastructure.sh"
  echo "   Ou manuellement : echo 'ta_cle' | npx wrangler secret put GROQ_API_KEY"
fi

echo ""
echo "=============================================="
echo "  ✅ INFRASTRUCTURE PRÊTE !"
echo "=============================================="
echo ""
echo "Prochaines étapes :"
echo "  1. git add . && git commit -m 'v4.0: mémoire documentaire épistémique'"
echo "  2. git push origin main"
echo "  3. npx wrangler deploy"
echo ""
echo "Pour ingérer ton premier document :"
echo '  Invoke-RestMethod -Uri "https://revue-presse.jeanneaj.workers.dev/memory/ingest" -Method POST -ContentType "application/json" -Body (ConvertTo-Json @{title="Mon premier bulletin"; content="Le texte complet du bulletin..."; doc_type="bulletin"; date="2026-07-01"})'
echo ""
echo "Pour vérifier :"
echo "  GET /memory/doc-stats"
echo "  GET /memory/documents"
echo "  GET /memory/search?q=immigration"
echo "=============================================="