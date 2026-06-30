// ============================================================
// email.js — Construction et envoi de l'email via Resend
// ============================================================

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Génère l'email HTML de la revue de presse
 */
export function buildEmailHTML(review, articles, date) {
  const dateStr = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Paris',
  });

  const articleCount = articles.length;
  const sourceCount = [...new Set(articles.map(a => a.sourceName))].length;

  // Convertir le Markdown de l'IA en HTML
  const reviewHTML = markdownToHTML(review);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 680px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
    .container { background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #ffffff; padding: 30px 30px 25px; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
    .header .date { margin: 8px 0 0; font-size: 14px; opacity: 0.85; }
    .header .stats { margin-top: 12px; display: flex; gap: 20px; font-size: 13px; opacity: 0.9; }
    .header .stats span { display: inline-flex; align-items: center; gap: 5px; }
    .content { padding: 25px 30px 30px; }
    .content h2 { color: #1a1a2e; font-size: 18px; margin: 25px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #e94560; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { color: #0f3460; font-size: 15px; margin: 18px 0 8px; }
    .content p { margin: 8px 0; font-size: 14px; color: #333; }
    .content ul { margin: 8px 0; padding-left: 20px; }
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
      <div class="date">${dateStr}</div>
      <div class="stats">
        <span>${articleCount} articles</span>
        <span>${sourceCount} sources</span>
      </div>
    </div>
    <div class="content">
      ${reviewHTML}
    </div>
    <div class="footer">
      Revue de Presse automatique — Cloudflare Workers — ${dateStr}
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Convertit le Markdown simplifié en HTML
 * Gère : titres, listes, gras, italique, liens, traits horizontaux
 */
function markdownToHTML(md) {
  if (!md) return '<p>Aucun contenu généré.</p>';

  let html = md;

  // Échapper le HTML existant sauf nos balises
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Traits horizontaux
  html = html.replace(/^---$/gm, '<hr>');

  // Titres
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Listes à puces
  html = html.replace(/^• (.+)$/gm, '<li>$1</li>');
  html = html.replace(/^(\-|\*) (.+)$/gm, '<li>$2</li>');
  // Wrapper les <li> consécutifs dans des <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Gras et italique
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Liens Markdown
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Paragraphes : les lignes restantes deviennent des <p>
  html = html.replace(/^(?!<[a-z]|$)(.+)$/gm, '<p>$1</p>');

  // Nettoyer les <p> vides
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

/**
 * Envoie l'email via Resend
 */
export async function sendEmail(env, subject, htmlContent) {
  const apiKey = env.RESEND_API_KEY;
  const to = env.DESTINATION_EMAIL;

  if (!apiKey) {
    throw new Error('RESEND_API_KEY non configurée');
  }
  if (!to) {
    throw new Error('DESTINATION_EMAIL non configuré');
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Revue de Presse <onboarding@resend.dev>',
      to: [to],
      subject,
      html: htmlContent,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Resend HTTP ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Génère le sujet de l'email
 */
export function buildSubject(date) {
  const dateStr = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return `Revue de Presse — ${dateStr}`;
}