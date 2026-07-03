#!/usr/bin/env python3
"""Diagnostic complet des 16 sources RSS et extraction articles"""
import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

HEADERS_BOT = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'application/rss+xml, application/xml, text/xml, text/html',
}
HEADERS_BROWSER = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

SOURCES = [
    {'name': 'Le Monde - Campus', 'url': 'https://www.lemonde.fr/campus/rss_full.xml', 'type': 'rss'},
    {'name': 'Le Monde - Politique', 'url': 'https://www.lemonde.fr/politique/rss_full.xml', 'type': 'rss'},
    {'name': 'Le Monde - Economie', 'url': 'https://www.lemonde.fr/economie/rss_full.xml', 'type': 'rss'},
    {'name': 'Le Monde - International', 'url': 'https://www.lemonde.fr/international/rss_full.xml', 'type': 'rss'},
    {'name': 'Les Echos - Economie', 'url': 'https://services.lesechos.fr/rss/les-echos-economie.xml', 'type': 'rss_echos'},
    {'name': 'Les Echos - Monde', 'url': 'https://services.lesechos.fr/rss/les-echos-monde.xml', 'type': 'rss_echos'},
    {'name': 'Les Echos - Politique', 'url': 'https://services.lesechos.fr/rss/les-echos-politique.xml', 'type': 'rss_echos'},
    {'name': 'Mediapart', 'url': 'https://mediapart.social/@mediapart.rss', 'type': 'rss'},
    {'name': 'CEPII', 'url': 'https://www.cepii.fr/CEPII/rss/RSSLettre.asp', 'type': 'rss'},
    {'name': 'The Next Recession', 'url': 'https://thenextrecession.wordpress.com/feed/', 'type': 'rss'},
    {'name': 'Groupe Marxiste', 'url': 'https://groupemarxiste.info/feed/', 'type': 'rss'},
    {'name': 'NPA', 'url': 'https://npa-revolutionnaires.org/feed/', 'type': 'rss'},
    {'name': 'POI', 'url': 'https://partiouvrierindependant-poi.fr/feed/', 'type': 'rss'},
    {'name': 'Marxiste.org', 'url': 'https://marxiste.org/?format=feed&type=rss', 'type': 'rss'},
    {'name': 'Parti des Travailleurs', 'url': 'https://parti-des-travailleurs.fr/feed/', 'type': 'rss'},
    {'name': 'Revolution Permanente', 'url': 'https://t.me/s/revolution_permanente', 'type': 'telegram'},
]

def fetch(url, headers=None, timeout=20):
    try:
        req = urllib.request.Request(url, headers=headers or HEADERS_BOT)
        resp = urllib.request.urlopen(req, timeout=timeout, context=ctx)
        return resp.status, resp.read().decode('utf-8', errors='replace')
    except Exception as e:
        return None, str(e)

def strip_tags(html):
    return re.sub(r'<[^>]*>', ' ', html).strip()

def parse_rss_items(xml):
    items = []
    for m in re.finditer(r'<(?:item|entry)>([\s\S]*?)</(?:item|entry)>', xml, re.IGNORECASE):
        block = m.group(1)
        title_m = re.search(r'<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>', block, re.I)
        link_m = re.search(r'<link[^>]*href="([^"]+)"', block, re.I) or re.search(r'<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</link>', block, re.I)
        desc_m = re.search(r'<(?:description|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</(?:description|summary)>', block, re.I)
        content_m = re.search(r'<content(?::\w+)?[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</content(?::\w+)?>', block, re.I)
        
        desc_text = strip_tags(desc_m.group(1) or '') if desc_m else ''
        content_text = strip_tags(content_m.group(1) or '') if content_m else ''
        title = strip_tags(title_m.group(1) or '').strip()[:80] if title_m else ''
        link = (link_m.group(1) or (link_m.group(2) or '')).strip() if link_m else ''
        
        items.append({
            'title': title,
            'link': link,
            'desc_words': len(desc_text.split()),
            'desc_chars': len(desc_text),
            'content_words': len(content_text.split()),
            'content_chars': len(content_text),
            'has_full_content': content_m is not None and len(content_text.split()) > 50,
        })
    return items

print("=" * 80)
print("DIAGNOSTIC RSS - Contenu disponible dans chaque flux")
print("=" * 80)

for src in SOURCES:
    print(f"\n### {src['name']}")
    
    if src['type'] == 'telegram':
        status, text = fetch(src['url'], HEADERS_BROWSER, 20)
        if status:
            msgs = re.findall(r'class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)</div>', text)
            print(f"  Telegram: HTTP {status} - {len(msgs)} messages")
        else:
            print(f"  ERREUR: {text}")
        continue
    
    if src['type'] == 'rss_echos':
        # Test direct first
        status, text = fetch(src['url'], HEADERS_BOT, 15)
        print(f"  Direct (Googlebot UA): HTTP {status}" if status else f"  Direct: ERREUR {text}")
        # Test with browser
        status2, text2 = fetch(src['url'], HEADERS_BROWSER, 15)
        print(f"  Browser UA: HTTP {status2}" if status2 else f"  Browser: ERREUR {text2}")
        if status and status == 200:
            items = parse_rss_items(text)
            print(f"  Articles: {len(items)}")
            if items:
                a = items[0]
                print(f"    [0] desc={a['desc_words']}w, content={a['content_words']}w | {a['title'][:60]}")
        continue
    
    status, text = fetch(src['url'], HEADERS_BOT, 15)
    if not status:
        status, text = fetch(src['url'], HEADERS_BROWSER, 15)
    
    if not status:
        print(f"  ERREUR: {text}")
        continue
    
    print(f"  HTTP {status} - {len(text)} chars RSS")
    
    items = parse_rss_items(text)
    print(f"  Articles: {len(items)}")
    
    if not items:
        continue
    
    with_content = [i for i in items if i['content_words'] > 0]
    long_desc = [i for i in items if i['desc_words'] > 80]
    usable = [i for i in items if i['has_full_content'] or i['desc_words'] > 80]
    
    if with_content:
        avg = sum(i['content_words'] for i in with_content) // len(with_content)
        print(f"  <content> tag: {len(with_content)} articles (avg {avg} mots)")
    if long_desc:
        avg = sum(i['desc_words'] for i in long_desc) // len(long_desc)
        print(f"  <description> > 80 mots: {len(long_desc)} articles (avg {avg} mots)")
    print(f"  Articles utilisables (content>50w ou desc>80w): {len(usable)}/{len(items)}")
    
    # Show first 2 articles
    for i, a in enumerate(items[:2]):
        print(f"    [{i}] title={a['title'][:50]}")
        print(f"        link={a['link'][:70]}")
        print(f"        desc={a['desc_words']}w ({a['desc_chars']}c), content={a['content_words']}w ({a['content_chars']}c)")