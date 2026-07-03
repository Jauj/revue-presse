#!/usr/bin/env python3
"""Diagnostic approfondi : cas difficiles + solutions alternatives"""
import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

BROWSER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

def fetch(url, headers=None, timeout=20):
    try:
        req = urllib.request.Request(url, headers=headers or BROWSER)
        resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        return resp.status, resp.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', errors='replace')[:500]
    except Exception as e:
        return None, str(e)[:200]

def strip_tags(html):
    return re.sub(r'<[^>]*>', ' ', html).strip()

def word_count(text):
    return len(text.split())

print("=" * 90)
print("TESTS APPROFONDIS - Solutions alternatives")
print("=" * 90)

# === 1. Le Monde : r.jina.ai contient l'article mais avec header nav ===
print("\n### 1. LE MONDE - Analyse détaillée r.jina.ai")
url = 'https://www.lemonde.fr/economie/article/2026/07/01/brompton-bicycle-le-fabricant-londonien-du-velo-pliant-veut-s-installer-en-france_6712345_3234.html'
status, text = fetch(f'https://r.jina.ai/{url}', {'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': BROWSER['User-Agent']}, 25)
if status == 200:
    lines = text.split('\n')
    print(f"  Total: {len(text)} chars, {word_count(text)} mots, {len(lines)} lignes")
    # Find where actual article content starts (skip nav)
    article_start = 0
    for i, line in enumerate(lines):
        if any(kw in line for kw in ['Brompton', 'vélo', 'Londres', 'article', 'Entreprise']):
            article_start = max(0, i - 2)
            break
    print(f"  Contenu nav (avant article): {word_count(chr(10).join(lines[:article_start]))} mots")
    article_text = '\n'.join(lines[article_start:])
    print(f"  Contenu article (après nav): {word_count(article_text)} mots")
    print(f"  Preview article:\n    {chr(10).join(lines[article_start:article_start+8])}")
    
    # Test: skip first 15 lines (typical jina nav)
    skip_text = '\n'.join(lines[15:])
    print(f"\n  Apres skip 15 lignes: {word_count(skip_text)} mots")

# === 2. Mediapart : tester si le toot Mastodon a un lien vers l'article original ===
print("\n\n### 2. MEDIAPART - Analyse des toots Mastodon")
status, rss = fetch('https://mediapart.social/@mediapart.rss')
if status == 200:
    items = re.findall(r'<item>([\s\S]*?)</item>', rss)
    for i, item in enumerate(items[:3]):
        title_m = re.search(r'<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>', item, re.I)
        desc_m = re.search(r'<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</description>', item, re.I)
        link_m = re.search(r'<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</link>', item, re.I)
        
        desc_html = desc_m.group(1) if desc_m else ''
        # Extract actual link from toot (often in <a> tags)
        links = re.findall(r'href="([^"]+)"', desc_html)
        toot_text = strip_tags(desc_html)
        
        print(f"  Toot {i}: {toot_text[:120]}...")
        print(f"    Links in toot: {links}")
        # Check if any link is to mediapart.fr article
        mp_links = [l for l in links if 'mediapart.fr' in l]
        if mp_links:
            print(f"    -> Mediapart article link: {mp_links[0]}")
            # Try fetching the article via jina
            jstatus, jtext = fetch(f'https://r.jina.ai/{mp_links[0]}', {'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': BROWSER['User-Agent']}, 25)
            if jstatus == 200:
                print(f"    -> r.jina.ai: {word_count(jtext)} mots")
                # Skip first 10 lines (nav)
                jlines = jtext.split('\n')
                clean_jina = '\n'.join(jlines[10:])
                print(f"    -> Apres skip nav: {word_count(clean_jina)} mots")
                if word_count(clean_jina) > 50:
                    print(f"    -> Preview: {clean_jina[:200]}...")

# === 3. NPA : tester avec Google Cache direct et alternatives ===
print("\n\n### 3. NPA - Alternatives d'extraction")
npa_url = 'https://npa-revolutionnaires.org/strasbourg-bas-rhin-des-centaines-de-places-disparues-dans-les-ecoles-maternelles-et-primaire/'

# Test si le site répond avec un timeout plus long
print(f"  [a] Direct (timeout 30s):")
status, html = fetch(npa_url, BROWSER, 30)
print(f"      Resultat: HTTP {status}, {len(html) if html else 0} chars")

# Test Google Web Light (pour mobile, parfois sans JS)
print(f"  [b] Google Web Light:")
gwl_url = f'https://googleweblight.com/?lite_url={npa_url}'
status, html = fetch(gwl_url, BROWSER, 15)
print(f"      Resultat: HTTP {status}, {len(html) if html else 0} chars")
if status and html and len(html) > 500:
    print(f"      Preview: {strip_tags(html)[:200]}...")

# Test si c'est un problème DNS/connectivité depuis cette machine
print(f"  [c] Test connectivité (HEAD request):")
try:
    req = urllib.request.Request(npa_url, method='HEAD', headers=BROWSER)
    resp = urllib.request.urlopen(req, timeout=10, context=ctx)
    print(f"      HEAD: HTTP {resp.status}")
except Exception as e:
    print(f"      HEAD: {e}")

# === 4. POI : le contenu est en JS, tester des alternatives ===
print("\n\n### 4. POI - Contenu JS-rendered")
poi_url = 'https://partiouvrierindependant-poi.fr/2026/06/18/informations-ouvrieres-n914/'

# La page fait 72K chars — analyser ce qu'elle contient
status, html = fetch(poi_url, BROWSER, 20)
if status:
    # Chercher des indices de JS-rendered content
    scripts = re.findall(r'<script[^>]*src="([^"]+)"', html)
    inline_scripts = len(re.findall(r'<script[^>]*>([\s\S]*?)</script>', html))
    json_ld = re.findall(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', html)
    
    print(f"  Page: {len(html)} chars, {len(scripts)} scripts externes, {inline_scripts} scripts inline")
    if json_ld:
        import json
        for i, j in enumerate(json_ld[:2]):
            try:
                data = json.loads(j)
                if isinstance(data, dict) and data.get('articleBody'):
                    print(f"  JSON-LD articleBody: {word_count(data['articleBody'])} mots")
                    print(f"    Preview: {data['articleBody'][:200]}...")
            except:
                pass
    
    # Chercher le contenu dans des data attributes ou hidden divs
    hidden_content = re.findall(r'<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)</div>', html)
    if hidden_content:
        text = strip_tags(hidden_content[0])
        print(f"  entry-content div: {word_count(text)} mots")
        if word_count(text) > 20:
            print(f"    Preview: {text[:200]}...")
    
    # Check pour du contenu dans des balises <p> directement
    paragraphs = re.findall(r'<p[^>]*>([\s\S]*?)</p>', html)
    total_p_words = sum(word_count(strip_tags(p)) for p in paragraphs)
    print(f"  Total mots dans <p> tags: {total_p_words}")
    if total_p_words > 50:
        longest_p = max(paragraphs, key=lambda p: word_count(strip_tags(p)))
        print(f"  Plus long <p>: {word_count(strip_tags(longest_p))} mots")

# === 5. Les Echos : tester un RSS cache/proxy alternatif ===
print("\n\n### 5. LES ECHOS - Alternatives RSS")

# Test RSS2JSON (free tier)
rss_url = 'https://services.lesechos.fr/rss/les-echos-economie.xml'
print(f"  [a] rss2json.com:")
r2j_url = f'https://api.rss2json.com/v1/api.json?rss_url={rss_url}'
status, text = fetch(r2j_url, BROWSER, 15)
if status == 200:
    import json
    try:
        data = json.loads(text)
        if data.get('items'):
            print(f"      {len(data['items'])} items via rss2json")
            for item in data['items'][:2]:
                print(f"        Title: {item.get('title','')[:60]}")
                print(f"        Content: {word_count(item.get('content','') or item.get('description',''))} mots")
                print(f"        Link: {item.get('link','')[:70]}")
        else:
            print(f"      Response: {text[:200]}")
    except:
        print(f"      Non-JSON: {text[:200]}")
else:
    print(f"      HTTP {status}")

# Test rss.app proxy
print(f"  [b] rss.app (proxy RSS):")
app_url = f'https://api.rss.app/v1/feed.json?url={rss_url}'
status, text = fetch(app_url, BROWSER, 15)
if status == 200:
    try:
        data = json.loads(text)
        items = data.get('items', [])
        print(f"      {len(items)} items via rss.app")
    except:
        print(f"      Non-JSON: {text[:200]}")
else:
    print(f"      HTTP {status}")

# Test avec Google Feed API
print(f"  [c] Google Feed Proxy (AJAX):")
gf_url = f'https://ajax.googleapis.com/ajax/services/feed/load?v=1.0&q={rss_url}&num=5'
status, text = fetch(gf_url, BROWSER, 15)
if status == 200:
    print(f"      HTTP {status}, {len(text)} chars")
    try:
        data = json.loads(text)
        resp_data = data.get('responseData', {})
        feed = resp_data.get('feed', {})
        entries = feed.get('entries', [])
        print(f"      {len(entries)} entries")
        for e in entries[:2]:
            print(f"        Title: {e.get('title','')[:60]}")
            print(f"        Content: {word_count(e.get('content','') or e.get('contentSnippet',''))} mots")
    except:
        print(f"      Non-JSON: {text[:200]}")
else:
    print(f"      HTTP {status}")

# === 6. Test de l'AMP cache Google ===
print("\n\n### 6. GOOGLE AMP CACHE - Le Monde")
amp_url = 'https://lemonde-fr.cdn.ampproject.org/v/s/amp.lemonde.fr/economie/article/2026/07/01/brompton-bicycle-le-fabricant-londonien-du-velo-pliant-veut-s-installer-en-france_6712345_3234.html'
status, html = fetch(amp_url, BROWSER, 15)
if status == 200:
    text_content = strip_tags(html)
    print(f"  AMP Cache: HTTP {status}, {len(html)} chars, {word_count(text_content)} mots")
    # Extract article body from AMP
    amp_body = re.search(r'<div[^>]*class="[^"]*article_body[^"]*"[^>]*>([\s\S]*?)</div>', html)
    if amp_body:
        words = word_count(strip_tags(amp_body.group(1)))
        print(f"  article_body: {words} mots")
else:
    print(f"  AMP Cache: HTTP {status}")

# === 7. Test Google cache version texte ===
print("\n\n### 7. GOOGLE CACHE - Version texte")
cache_url = 'https://webcache.googleusercontent.com/search?q=cache:lemonde.fr/economie/article/2026/07/01/brompton+bicycle+velo+pliant+france'
status, html = fetch(cache_url, BROWSER, 15)
if status == 200:
    # Google cache returns a page with the cached content in a specific structure
    text = strip_tags(html)
    print(f"  Google Cache search: HTTP {status}, {len(html)} chars, {word_count(text)} mots")
    # Check for "text-only" link
    text_only_link = re.search(r'href="([^"]*webcache[^"]*strip=1[^"]*)"', html)
    if text_only_link:
        print(f"  Text-only link found!")
    # Check if content is embedded
    if 'Brompton' in html or 'brompton' in html.lower():
        print(f"  Article content FOUND in cache!")
        # Find article text
        idx = html.lower().find('brompton')
        snippet = strip_tags(html[max(0,idx-100):idx+500])
        print(f"  Snippet: {snippet[:300]}...")
else:
    print(f"  Google Cache: HTTP {status}")

print("\n\n### 8. SOLUTIONS GRATUITES POUR RSS PROXY")
# Test plusieurs services de proxy RSS gratuits
rss_test_urls = {
    'Le Monde Eco': 'https://www.lemonde.fr/economie/rss_full.xml',
}

for name, rss_url in rss_test_urls.items():
    print(f"\n  Source: {name}")
    
    # Test feedgrabber
    fg_url = f'https://feedgrabbr.com/feed/{rss_url}'
    s, t = fetch(fg_url, BROWSER, 10)
    print(f"    feedgrabbr: HTTP {s}")
    
    # Test Feedburner-like
    # Test si le RSS Le Monde a changé de format
    s, t = fetch(rss_url, BROWSER, 15)
    if s == 200:
        has_content = bool(re.search(r'<content', t, re.I))
        has_encoded = bool(re.search(r'content:encoded', t, re.I))
        print(f"    RSS direct: HTTP {s}, <content>: {has_content}, content:encoded: {has_encoded}")
        # Check sample item structure
        items = re.findall(r'<item>([\s\S]*?)</item>', t)
        if items:
            item = items[0]
            tags = re.findall(r'<([a-z:]+)', item, re.I)
            print(f"    Tags in first item: {list(set(tags))}")