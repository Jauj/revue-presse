// ============================================================
// email.js — Construction et envoi de l'email via Resend
// Markdown → HTML robuste avec support émojis, sections Smart Brevity
// ============================================================

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Génère l'email HTML de la revue de presse
 */
export function buildEmailHTML(review, articles, date, provider) {
  const dateStr = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Paris',
  });
  const dateISO = date.toISOString().split('T')[0];
  const articleCount = articles.length;
  const sourceCount = [...new Set(articles.map(a => a.sourceName))].length;

  // Compter les éditoriaux (sections numérotées "1.", "2.", etc.)
  const editorialMatches = review.match(/^\*\*\d+\./gm) || [];
  const editorialCount = editorialMatches.length || Math.ceil(articleCount / 4);

  // Convertir le Markdown de l'IA en HTML
  const reviewHTML = markdownToHTML(review);

  const providerLabel = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : 'IA';
  const providerBadge = `<div class="provider-badge">Modèle : ${providerLabel}</div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.7; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
    .container { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #ffffff; padding: 30px 30px 25px; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .header .subtitle { margin: 6px 0 0; font-size: 15px; font-style: italic; opacity: 0.8; letter-spacing: 0.3px; }
    .header .date { margin: 8px 0 0; font-size: 14px; opacity: 0.85; }
    .header .stats { margin-top: 12px; display: flex; gap: 20px; font-size: 13px; opacity: 0.9; }
    .header .stats span { display: inline-flex; align-items: center; gap: 5px; }
    .content { padding: 25px 30px 30px; }
    .content h2 { color: #1a1a2e; font-size: 17px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e94560; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { color: #0f3460; font-size: 16px; margin: 22px 0 10px; font-weight: 600; }
    .content h4 { color: #333; font-size: 14px; margin: 14px 0 6px; }
    .content p { margin: 10px 0; font-size: 14px; color: #333; }
    .content ul, .content ol { margin: 8px 0; padding-left: 22px; }
    .content li { margin: 6px 0; font-size: 14px; color: #333; }
    .content strong { color: #1a1a2e; }
    .content em { color: #666; font-size: 13px; }
    .content hr { border: none; border-top: 1px solid #eee; margin: 25px 0; }
    .content a { color: #e94560; text-decoration: none; }
    .content a:hover { text-decoration: underline; }
    .provider-badge { display: inline-block; background: #f0f0f0; color: #666; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-top: 15px; }
    .fallback-notice { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px 16px; margin: 20px 0; font-size: 13px; color: #856404; border-radius: 0 4px 4px 0; }
    .footer { background: #f8f9fa; padding: 15px 30px; text-align: center; font-size: 12px; color: #999; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Revue de Presse</h1>
      <div class="subtitle">Éditorial analytique</div>
      <div class="date">${dateStr}</div>
      <div class="stats">
        <span>${editorialCount} éditoriaux</span>
        <span>${articleCount} articles</span>
        <span>${sourceCount} sources</span>
      </div>
    </div>
    <div class="content">
      ${reviewHTML}
      ${providerBadge}
    </div>
    <div class="footer">
      Revue de Presse éditoriale — Cloudflare Workers — ${dateStr}
      <br><span style="font-size:11px;color:#bbb">
        <a href="https://revue-presse.jeanneaj.workers.dev/feedback" style="color:#bbb">Ce contenu vous est-il utile ?</a>
      </span>
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Génère la version plaintext pour l'email (accessibilité + preview)
 */
export function buildEmailText(review, articles, date) {
  const dateStr = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Paris',
  });

  let text = `REVUE DE PRESSE — ${dateStr.toUpperCase()}\n`;
  text += `${'='.repeat(50)}\n\n`;

  // Nettoyer le markdown : supprimer les émojis et formatter pour texte pur
  const cleaned = review
    .replace(/[📌📰🔍📊🔮⚠️]/g, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^---$/gm, '─'.repeat(50))
    .replace(/^#{1,4}\s/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n');

  text += cleaned.trim();
  text += `\n\n${'─'.repeat(50)}\n`;
  text += `Sources : ${[...new Set(articles.map(a => a.sourceName))].join(', ')}\n`;

  return text;
}

/**
 * Convertit le Markdown simplifié en HTML
 * Gère : titres, listes, gras, italique, liens, traits horizontaux, émojis
 * IMPORTANT : on n'échappe PAS le HTML en entrée car l'IA ne produit pas de HTML,
 * seulement du markdown avec de possibles entités
 */
function markdownToHTML(md) {
  if (!md) return '<p>Aucun contenu généré.</p>';

  let html = md;

  // Traits horizontaux (avant les titres pour éviter les conflits)
  html = html.replace(/^---$/gm, '<hr>');

  // Titres markdown (h4 avant h3 avant h2 avant h1)
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Listes à puces — d'abord marquer chaque item
  // Supporte : • , - , * en début de ligne
  html = html.replace(/^[•\-\*] (.+)$/gm, '\x00LI\x00$1\x00/LI\x00');

  // Wrapper les <li> consécutifs dans des <ul>
  html = html.replace(/((?:\x00LI\x00.*?\x00\/LI\x00\n?)+)/g, (match) => {
    return '<ul>' + match.replace(/\x00LI\x00/g, '<li>').replace(/\x00\/LI\x00/g, '</li>') + '</ul>';
  });

  // Gras et italique (ordre important : *** > ** > *)
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Liens Markdown
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Échapper le HTML potentiellement dangereux DANS les paragraphes
  // mais pas les balises qu'on vient de générer
  // Stratégie : protéger nos balises, échapper le reste, restaurer
  const safeTags = [];
  html = html.replace(/<(\/?(?:h[1-6]|ul|ol|li|p|strong|em|a|hr|br)\b[^>]*)>/gi, (match) => {
    safeTags.push(match);
    return `\x00TAG${safeTags.length - 1}\x00`;
  });

  // Échapper < et & dans le texte brut restant
  html = html.replace(/&/g, '&amp;');
  html = html.replace(/</g, '&lt;');
  html = html.replace(/>/g, '&gt;');

  // Restaurer nos balises
  html = html.replace(/\x00TAG(\d+)\x00/g, (_, idx) => safeTags[parseInt(idx)]);

  // Paragraphes : les lignes restantes deviennent des <p>
  // Ne pas wrapper les lignes vides ou celles commençant par une balise
  html = html.replace(/^(?!<[a-z\x00]|$)(.+)$/gm, '<p>$1</p>');

  // Nettoyer les <p> vides et les <p> autour de balises block
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:h[1-6]|ul|ol|hr))/g, '$1');
  html = html.replace(/(<\/(?:h[1-6]|ul|ol)>)\s*<\/p>/g, '$1');

  return html;
}

/**
 * Génère le sujet de l'email avec un aperçu du contenu principal
 */
export function buildSubject(date, reviewContent) {
  const dateStr = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  // Essayer d'extraire le premier thème clé du contenu
  let topic = '';
  if (reviewContent) {
    // Chercher le premier élément après "L'ESSENTIEL DU JOUR" ou après un h2
    const essentialsMatch = reviewContent.match(/L'ESSENTIEL DU JOUR[\s\S]*?\n\n[\s\S]*?(.+?)(?:\n|$)/);
    if (essentialsMatch) {
      // Prendre la première ligne de contenu substantiel
      topic = essentialsMatch[1].replace(/[**📌—]/g, '').trim().substring(0, 80);
    }
  }

  if (topic && topic.length > 10) {
    return `Revue de Presse — ${dateStr} — ${topic}`;
  }
  return `Revue de Presse — ${dateStr}`;
}

/**
 * Envoie l'email via Resend
 */
export async function sendEmail(env, subject, htmlContent, textContent) {
  const apiKey = env.RESEND_API_KEY;
  const to = env.DESTINATION_EMAIL;

  if (!apiKey) {
    throw new Error('RESEND_API_KEY non configurée');
  }
  if (!to) {
    throw new Error('DESTINATION_EMAIL non configuré');
  }

  const payload = {
    from: 'Revue de Presse <onboarding@resend.dev>',
    to: [to],
    subject,
    html: htmlContent,
  };

  // Ajouter la version texte si disponible (meilleure délivrabilité)
  if (textContent) {
    payload.text = textContent;
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend HTTP ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return data;
}