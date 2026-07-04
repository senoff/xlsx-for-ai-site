#!/usr/bin/env python3
"""Live DoD for the Shopify import shell pages (XLS-207 collections,
XLS-208 inventory, XLS-209 redirects) on the real deploy.

Proves the assembled flow end-to-end, not just the pieces:
  1) deploy landed        — served shopify-import.js is reachable
  2) prose uniqueness     — every tool page's .xfa-mcp-copy block is md5-distinct
                            (no SEO dilution) and each new page names its tool
  3) route contract/parity— the exact call the shell makes (mint anon key ->
                            Bearer POST the fixture to /api/v1/tools/<tool>) returns
                            a well-formed _meta.ledger for the SAME rows an agent
                            would send. Honest-decline (no prod ANTHROPIC_API_KEY)
                            and live-mapping are BOTH accepted; the contract shape
                            and rows-in count must hold either way.
  4) page render          — headless Chrome: #xfa-panel mounts, all 3 scripts load
  5) page + host 200

Honest-decline is spec-sanctioned: with no mapper key in prod every column lands
in `couldnt`, `did` is empty, columnsMapped==0, and no download is offered. The
DoD asserts that shape is internally consistent rather than requiring mapped>0.
"""
import base64, hashlib, json, re, subprocess, sys, time, urllib.request, urllib.error

SITE = "https://xlsx-for-ai.dev"
API = "https://api.xlsx-for-ai.dev"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# The API edge WAF 403s the default Python-urllib UA (bot filter); a browser UA
# passes, exactly as the real page's fetch() does. Not a product gate.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"

# The three new pages: slug -> (tool, prose keyword, fixture csv, expected data rows)
NEW = {
    "import-shopify-collections": (
        "shopify_collections_import", "collection",
        "name,url-handle,description,visible\n"
        "Summer Essentials,summer-essentials,Lightweight pieces.,TRUE\n"
        "New Arrivals,new-arrivals,The latest additions.,TRUE\n"
        "Best Sellers,best-sellers,Customer favorites.,TRUE\n",
        3,
    ),
    "import-shopify-inventory": (
        "shopify_inventory_import", "inventory",
        "SKU,Location,Quantity\n"
        "DOD-SKU-1,Main Warehouse,7\n"
        "DOD-SKU-2,Main Warehouse,12\n"
        "DOD-SKU-3,Main Warehouse,0\n",
        3,
    ),
    "import-shopify-redirects": (
        "shopify_url_redirects_import", "redirect",
        "Redirect from,Redirect to\n"
        "/old-alpha,/collections/all\n"
        "/old-beta,/products/new\n"
        "/old-gamma,/pages/about\n",
        3,
    ),
}

# The existing tool pages that also carry a .xfa-mcp-copy block (uniqueness set).
EXISTING = [
    "check-for-macros", "clean-export", "compare", "convert-excel-to-csv",
    "filter-rows", "fix-broken-links", "fix-formula-errors", "get-ready-safely",
    "remove-duplicates", "remove-personal-data", "run-any-tool", "summarize",
    "whats-inside-excel-file",
]

_p, _f = [], []
def ok(m): _p.append(m); print("PASS:", m)
def bad(m): _f.append(m); print("FAIL:", m)

def fetch(url, timeout=20):
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(url + sep + "cb=%d" % time.time_ns(),
                                 headers={"Cache-Control": "no-cache", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

def post_json(url, body, headers=None, timeout=60):
    data = json.dumps(body).encode()
    h = {"Content-Type": "application/json", "User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))

# ------------------------------------------------------------------ 1) deploy
print("== 1) wait for deploy (served shopify-import.js) ==")
deployed = False
for i in range(80):
    try:
        js = fetch(SITE + "/tools/shopify-import.js")
        if "XFA_SHOPIFY" in js:
            deployed = True; print("  deployed at attempt", i + 1); break
    except Exception as e:
        print("  fetch err:", e)
    time.sleep(30)
ok("served shopify-import.js is live") if deployed else bad("shopify-import.js not deployed after ~40min")
if not deployed:
    print("\n==== Shopify import pages DoD: %d passed / %d failed (DEPLOY NOT LANDED) ====" % (len(_p), len(_f)))
    sys.exit(1)

# ------------------------------------------------------ 2) prose uniqueness
print("== 2) prose uniqueness + tool-tie across all tool pages ==")
block_re = re.compile(r'<div class="xfa-mcp-copy"[^>]*>(.*?)</div>\s*<footer', re.S)
tag_re = re.compile(r"<[^>]+>")
hashes = {}
def prose(slug):
    html = fetch("%s/tools/%s/" % (SITE, slug))
    m = block_re.search(html)
    if not m:
        return None
    return re.sub(r"\s+", " ", tag_re.sub(" ", m.group(1))).strip()

for slug in EXISTING:
    try:
        t = prose(slug)
        if t: hashes[slug] = hashlib.md5(t.encode()).hexdigest()
        else: bad("%s: no .xfa-mcp-copy block" % slug)
    except Exception as e:
        bad("%s: fetch failed (%s)" % (slug, e))

for slug, (tool, kw, _csv, _n) in NEW.items():
    try:
        t = prose(slug)
    except Exception as e:
        bad("%s: fetch failed (%s)" % (slug, e)); continue
    if not t:
        bad("%s: no .xfa-mcp-copy block" % slug); continue
    hashes[slug] = hashlib.md5(t.encode()).hexdigest()
    ok("%s: prose names its tool ('%s')" % (slug, kw)) if kw.lower() in t.lower() \
        else bad("%s: prose missing keyword '%s'" % (slug, kw))

total = len(EXISTING) + len(NEW)
if len(hashes) == total and len(set(hashes.values())) == total:
    ok("all %d prose blocks are md5-distinct (no SEO dilution)" % total)
else:
    dupes = [s for s in hashes if list(hashes.values()).count(hashes[s]) > 1]
    bad("prose NOT all-distinct; collisions: %s" % dupes)

# ----------------------------------------------- 3) route contract / parity
print("== 3) live route contract (mint key -> POST fixture) ==")
try:
    st, cj = post_json(API + "/api/v1/clients",
                       {"client_version": "web-tools-1.0", "platform": "web"})
    api_key = cj.get("api_key")
    ok("minted anon key") if api_key else bad("no api_key in /clients response")
except Exception as e:
    bad("/api/v1/clients failed (%s)" % e); api_key = None

if api_key:
    auth = {"Authorization": "Bearer " + api_key}
    for slug, (tool, kw, csv, nrows) in NEW.items():
        b64 = base64.b64encode(csv.encode()).decode()
        try:
            st, resp = post_json(API + "/api/v1/tools/" + tool,
                                 {"file_b64": b64, "filename": slug + ".csv"},
                                 headers=auth)
        except urllib.error.HTTPError as e:
            bad("%s: route HTTP %d" % (tool, e.code)); continue
        except Exception as e:
            bad("%s: route call failed (%s)" % (tool, e)); continue
        ok("%s: route 200" % tool) if st == 200 else bad("%s: route status %d" % (tool, st))
        meta = (resp or {}).get("_meta") or {}
        led = meta.get("ledger") or {}
        shape = all(k in led for k in ("did", "kept", "couldnt", "summary"))
        ok("%s: ledger has did/kept/couldnt/summary" % tool) if shape \
            else bad("%s: ledger missing keys (%s)" % (tool, list(led.keys())))
        if shape:
            s = led["summary"]
            ok("%s: rowsIn == %d" % (tool, nrows)) if s.get("rowsIn") == nrows \
                else bad("%s: rowsIn %s != %d" % (tool, s.get("rowsIn"), nrows))
            mapped = s.get("columnsMapped", 0)
            if mapped == 0:
                # honest-decline: did empty, no download offered
                consistent = (len(led["did"]) == 0 and len(led["couldnt"]) > 0)
                ok("%s: honest-decline consistent (did empty, cols flagged)" % tool) if consistent \
                    else bad("%s: honest-decline inconsistent (did=%d couldnt=%d)"
                             % (tool, len(led["did"]), len(led["couldnt"])))
            else:
                # live-mapping: did non-empty and a CSV was produced
                has_file = bool(meta.get("file_b64"))
                ok("%s: live-mapping produced file (cols=%d)" % (tool, mapped)) if (len(led["did"]) > 0 and has_file) \
                    else bad("%s: mapped=%d but did=%d file=%s"
                             % (tool, mapped, len(led["did"]), has_file))

# --------------------------------------------------------- 4) page render
print("== 4) headless render: panel + scripts ==")
def dom(url):
    return subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                           "--virtual-time-budget=6000", "--dump-dom",
                           url + "?cb=%d" % time.time()],
                          capture_output=True, text=True, timeout=60).stdout

for slug, (tool, kw, _csv, _n) in NEW.items():
    d = dom("%s/tools/%s/" % (SITE, slug))
    checks = {
        "panel mounts": d.count('id="xfa-panel"') == 1,
        "shell.js": "/tools/shell.js" in d,
        "shopify-import.js": "/tools/shopify-import.js" in d,
        "page.js": ("/tools/%s/page.js" % slug) in d,
    }
    for k, v in checks.items():
        ok("%s: %s" % (slug, k)) if v else bad("%s: %s" % (slug, k))

# ----------------------------------------------------------- 5) page 200
print("== 5) pages + host resolve 200 ==")
for slug in list(NEW) + [""]:
    url = SITE + ("/tools/%s/" % slug if slug else "/tools/")
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            ok("%s 200" % url) if r.status == 200 else bad("%s %d" % (url, r.status))
    except Exception as e:
        bad("%s error %s" % (url, e))

print("\n==== Shopify import pages DoD: %d passed / %d failed ====" % (len(_p), len(_f)))
sys.exit(0 if not _f else 1)
