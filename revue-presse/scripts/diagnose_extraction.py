#!/usr/bin/env python3
"""Test extraction article par article avec différentes stratégies gratuites"""
import urllib.request
import re
import ssl
import json

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# === HEADERS ===
GOOGLEBOT = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
}
GOOGLEBOT_REFERER = {
    **GOOGLEBOT,
    'Referer': 'https://www.google.com/',
    'X-Forwarded-For': '66.249.66.1',
}
FACEBOOKBOT = {
    'User-Agent': 'Mozilla/5.0 (compatible; FacebookBot/1.0; +http://www.facebook.com/externalhit_uatext.php)',
    'Referer': 'https://www.facebook.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}
BROWSER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
}

def fetch(url, headers=None, timeout=20):
    try:
        req = urllib.request.Request(url, headers=headers or BROWSER)
        resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        return resp.status, resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        return None, str(e)

def count_readable_words(html):
    text = re.sub(r'<[^>]*>', ' ', html)
    text = re.sub(r'&[a-z]+;', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return len(text.split()), text[:300]

def has_paywall(text):
    indicators = ['abonn', 'inscriv', 'souscri', 'réservé', 'payant', 'subscribe', 'pour lire la suite']
    first_500 = text[:500].lower()
    return any(ind in first_500 for ind in indicators)

def extract_article_content(html):
    """Extract main article content from HTML"""
    # Try <article> tag first
    article_m = re.search(r'<article[^>]*>([\s\S]*?)</article>', html, re.I)
    if article_m:
        words, _ = count_readable_words(article_m.group(1))
        if words > 100:
            return article_m.group(1), words
    
    # Try [role="article"]
    role_m = re.search(r'<[^>]+role=["\']article["\'][^>]*>([\s\S]*?)</[^>]+>', html, re.I)
    if role_m:
        words, _ = count_readable_words(role_m.group(1))
        if words > 100:
            return role_m.group(1), words
    
    # Try <main>
    main_m = re.search(r'<main[^>]*>([\s\S]*?)</main>', html, re.I)
    if main_m:
        words, _ = count_readable_words(main_m.group(1))
        if words > 100:
            return main_m.group(1), words
    
    # Fallback: body with cleanup
    body_m = re.search(r'<body[^>]*>([\s\S]*?)</body>', html, re.I)
    if body_m:
        body = body_m.group(1)
        # Remove non-article elements
        for pat in [r'<script[\s\S]*?</script>', r'<style[\s\S]*?</style>', r'<nav[\s\S]*?</nav>',
                     r'<footer[\s\S]*?</footer>', r'<header[\s\S]*?</header>', r'<aside[\s\S]*?</aside>']:
            body = re.sub(pat, '', body, flags=re.I)
        words, _ = count_readable_words(body)
        if words > 100:
            return body, words
    
    return html, 0

# === ARTICLES TO TEST ===
TEST_URLS = [
    # Le Monde
    {'site': 'Le Monde', 'url': 'https://www.lemonde.fr/economie/article/2026/07/01/brompton-bicycle-le-fabricant-londonien-du-velo-pliant-veut-s-installer-en-france_6712345_3234.html', 'paywall': True},
    {'site': 'Le Monde', 'url': 'https://www.lemonde.fr/international/article/2026/07/01/au-liban-la-communaute-chiite-entre-fierte-et-amenaces-apres-l-accord-de-ceasefire_6712258_3214.html', 'paywall': True},
    # Mediapart (original article from toot)
    {'site': 'Mediapart', 'url': 'https://www.mediapart.fr/journal/politique/010726/gouvernement-barnier-projet-budget-2025-premiere-decote-massive-depenses-publiques', 'paywall': True},
    # NPA
    {'site': 'NPA', 'url': 'https://npa-revolutionnaires.org/strasbourg-bas-rhin-des-centaines-de-places-disparues-dans-les-ecoles-maternelles-et-primaire/', 'paywall': False},
    # POI
    {'site': 'POI', 'url': 'https://partiouvrierindependant-poi.fr/2026/06/18/informations-ouvrieres-n914/', 'paywall': False},
    # Parti des Travailleurs
    {'site': 'Parti Travailleurs', 'url': 'https://parti-des-travailleurs.fr/2026/06/24/canicule-il-faut-durgence-reprendre-le-controle-public-de-leau/', 'paywall': False},
    # Les Echos (paywall)
    {'site': 'Les Echos', 'url': 'https://www.lesechos.fr/economie-france/social/budget-2025-le-gouvernement-veut-economiser-10-milliards-deuros-par-an-2148720', 'paywall': True},
]

# === FREE PROXY SERVICES TO TEST ===
PROXY_SERVICES = {
    'r.jina.ai (text)': lambda url: f'https://r.jina.ai/{url}',
    'r.jina.ai (reader)': lambda url: f'https://r.jina.ai/reader?url={url}',
    '12ft.io': lambda url: f'https://12ft.io/proxy?q={url}',
    'archive.org': lambda url: f'https://web.archive.org/web/2024/{url}',
}

print("=" * 90)
print("TEST EXTRACTION ARTICLE PAR ARTICLE")
print("=" * 90)

for article in TEST_URLS:
    print(f"\n{'='*90}")
    print(f"### {article['site']} | Paywall: {article['paywall']}")
    print(f"    URL: {article['url'][:80]}")
    print(f"{'─'*90}")
    
    # Strategy 1: Direct with Googlebot
    print(f"\n  [1] Googlebot UA:")
    status, html = fetch(article['url'], GOOGLEBOT, 15)
    if status:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
        if words > 50:
            _, preview = count_readable_words(content)
            print(f"      Preview: {preview[:200]}...")
    else:
        print(f"      ERREUR: {str(status)[:80]}")
    
    # Strategy 2: Googlebot + Referer
    print(f"\n  [2] Googlebot + Referer + X-Forwarded-For:")
    status, html = fetch(article['url'], GOOGLEBOT_REFERER, 15)
    if status:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
        if words > 50 and not pw:
            _, preview = count_readable_words(content)
            print(f"      Preview: {preview[:200]}...")
    else:
        print(f"      ERREUR: {str(status)[:80]}")
    
    # Strategy 3: Facebook Bot
    print(f"\n  [3] FacebookBot UA:")
    status, html = fetch(article['url'], FACEBOOKBOT, 15)
    if status:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
        if words > 50 and not pw:
            _, preview = count_readable_words(content)
            print(f"      Preview: {preview[:200]}...")
    else:
        print(f"      ERREUR: {str(status)[:80]}")
    
    # Strategy 4: Browser UA
    print(f"\n  [4] Browser UA (normal):")
    status, html = fetch(article['url'], BROWSER, 15)
    if status:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
        if words > 50 and not pw:
            _, preview = count_readable_words(content)
            print(f"      Preview: {preview[:200]}...")
    else:
        print(f"      ERREUR: {str(status)[:80]}")
    
    # Strategy 5: r.jina.ai
    print(f"\n  [5] r.jina.ai (text extraction):")
    status, text = fetch(f'https://r.jina.ai/{article["url"]}', {'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': BROWSER['User-Agent']}, 25)
    if status:
        words = len(text.split())
        pw = has_paywall(text)
        print(f"      HTTP {status} | {len(text)} chars | {words} mots | paywall: {pw}")
        if words > 50:
            print(f"      Preview: {text[:200]}...")
    else:
        print(f"      ERREUR: {str(status)[:80]}")
    
    # Strategy 6: Google Cache
    print(f"\n  [6] Google Cache:")
    cache_url = f'https://webcache.googleusercontent.com/search?q=cache:{article["url"]}'
    status, html = fetch(cache_url, GOOGLEBOT, 15)
    if status and status == 200:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
    else:
        print(f"      HTTP {status or 'FAIL'} - {'Bloque' if not status else 'vide/invalide'}")
    
    # Strategy 7: 12ft.io proxy
    print(f"\n  [7] 12ft.io proxy:")
    status, html = fetch(f'https://12ft.io/proxy?q={article["url"]}', BROWSER, 20)
    if status and status == 200 and len(html) > 500:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
        if words > 50 and not pw:
            _, preview = count_readable_words(content)
            print(f"      Preview: {preview[:200]}...")
    else:
        print(f"      HTTP {status or 'FAIL'} - {'echec' if not status or len(html) < 500 else 'ok'}")
    
    # Strategy 8: archive.org Wayback
    print(f"\n  [8] archive.org Wayback:")
    wayback_url = f'https://web.archive.org/web/2024/{article["url"]}'
    status, html = fetch(wayback_url, BROWSER, 20)
    if status and status == 200 and len(html) > 1000:
        content, words = extract_article_content(html)
        pw = has_paywall(content)
        print(f"      HTTP {status} | {len(html)} chars | article: {words} mots | paywall: {pw}")
    else:
        print(f"      HTTP {status or 'FAIL'} - non disponible")

print("\n" + "=" * 90)
print("RESUME DES STRATEGIES PAR SITE")
print("=" * 90)