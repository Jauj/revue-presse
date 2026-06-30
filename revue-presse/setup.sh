#!/bin/bash
# ============================================================
# setup.sh — Installation et déploiement de la Revue de Presse
# Prérequis : Node.js 18+, compte Cloudflare
# ============================================================

set -e

echo "═══════════════════════════════════════════════════════════"
echo "  REVUE DE PRESSE — Installation & Déploiement"
echo "  Cloudflare Workers — 100% Gratuit"
echo "═══════════════════════════════════════════════════════════"
echo ""

# === COULEURS ===
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# === 1. Vérifier les prérequis ===
echo -e "${BLUE}[1/6]${NC} Vérification des prérequis..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}Node.js n'est pas installé.${NC} Installez-le via https://nodejs.org/"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}npm n'est pas installé.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Node.js $(node --version)${NC}"
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# === 2. Installer les dépendances ===
echo ""
echo -e "${BLUE}[2/6]${NC} Installation des dépendances..."
npm install
echo -e "${GREEN}✓ Dépendances installées${NC}"

# === 3. Vérifier l'authentification Cloudflare ===
echo ""
echo -e "${BLUE}[3/6]${NC} Vérification de l'authentification Cloudflare..."

if ! npx wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}! Vous n'êtes pas connecté à Cloudflare.${NC}"
    echo ""
    echo "  2 options :"
    echo "  a) Lancer : npx wrangler login  (ouvre le navigateur)"
    echo "  b) Configurer : CLOUDFLARE_API_TOKEN=votre_token"
    echo ""
    echo -e "${YELLOW}Si vous avez un API Token, relancez ce script avec :${NC}"
    echo "  CLOUDFLARE_API_TOKEN=xxx bash setup.sh"
    echo ""
    
    if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
        read -p "Voulez-vous vous connecter via le navigateur ? (o/n) " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Oo]$ ]]; then
            npx wrangler login
        else
            echo -e "${RED}Arrêt. Configurez votre token Cloudflare et relancez.${NC}"
            exit 1
        fi
    fi
fi

echo -e "${GREEN}✓ Connecté à Cloudflare${NC}"

# === 4. Créer le namespace KV ===
echo ""
echo -e "${BLUE}[4/6]${NC} Création du namespace KV..."

# Vérifier si le KV existe déjà
KV_ID=$(npx wrangler kv:namespace list --json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 2>/dev/null || true)

if [ -z "$KV_ID" ]; then
    echo "  Création d'un nouveau namespace KV..."
    KV_OUTPUT=$(npx wrangler kv:namespace create CACHE 2>&1)
    KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+')
    echo -e "${GREEN}✓ Namespace KV créé${NC}"
else
    echo -e "${GREEN}✓ Namespace KV existant trouvé${NC}"
fi

# Mettre à jour wrangler.toml avec le bon KV ID
if [ -n "$KV_ID" ]; then
    sed -i "s/YOUR_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml
    echo -e "${GREEN}✓ wrangler.toml mis à jour avec KV ID: $KV_ID${NC}"
fi

# === 5. Configurer les secrets ===
echo ""
echo -e "${BLUE}[5/6]${NC} Configuration des clés API..."

# Resend API Key
if [ -n "$RESEND_API_KEY" ]; then
    echo "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY
    echo -e "${GREEN}✓ RESEND_API_KEY configurée${NC}"
else
    echo -e "${YELLOW}! RESEND_API_KEY non fournie${NC}"
    echo "  → Obtenez-en une gratuite sur https://resend.com/signup"
    echo "  → Puis relancez : RESEND_API_KEY=xxx bash setup.sh"
fi

# Groq API Key
if [ -n "$GROQ_API_KEY" ]; then
    echo "$GROQ_API_KEY" | npx wrangler secret put GROQ_API_KEY
    echo -e "${GREEN}✓ GROQ_API_KEY configurée${NC}"
else
    echo -e "${YELLOW}! GROQ_API_KEY non fournie${NC}"
    echo "  → Obtenez-en une gratuite sur https://console.groq.com/keys"
    echo "  → Puis relancez : GROQ_API_KEY=xxx bash setup.sh"
fi

# Mistral API Key (optionnel)
if [ -n "$MISTRAL_API_KEY" ]; then
    echo "$MISTRAL_API_KEY" | npx wrangler secret put MISTRAL_API_KEY
    echo -e "${GREEN}✓ MISTRAL_API_KEY configurée (fallback)${NC}"
fi

# === 6. Déployer ===
echo ""
echo -e "${BLUE}[6/6]${NC} Déploiement sur Cloudflare Workers..."

npx wrangler deploy

echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "${GREEN}  DÉPLOIEMENT TERMINÉ${NC}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Prochaines étapes :"
echo ""
echo "  1. Configurer votre email dans le dashboard Cloudflare :"
echo "     Workers → revue-presse → Settings → Variables"
echo "     DESTINATION_EMAIL = votre@email.com"
echo ""
echo "  2. Tester manuellement :"
echo "     curl -X POST https://revue-presse.votre-subdomain.workers.dev/trigger/all"
echo ""
echo "  3. La revue de presse sera envoyée automatiquement"
echo "     du lundi au vendredi à 7h00 (heure de Paris)"
echo ""
echo "  4. Vérifier le statut :"
echo "     curl https://revue-presse.votre-subdomain.workers.dev/"
echo ""