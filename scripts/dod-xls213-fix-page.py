#!/usr/bin/env python3
"""Live Part-2 DoD for the XLS-213 fix-shopify-products page on the real deploy.

Proves the assembled fix flow end-to-end (SPM Ruling 2, 2026-07-05: "XLS-213
closes when Part-2 page DoD goes green on live deploy, not on the route alone"):

  1) deploy landed  — served /tools/fix-shopify-products/page.js is reachable and
                      wires the keyless tool (shopify_products_import_fix).
  2) page render    — headless Chrome: #xfa-panel mounts; shell.js + this page's
                      page.js load; shopify-import.js is NOT loaded (the fix page
                      is standalone, not a mapper-shell page).
  3) route contract — the EXACT call the page makes (mint anon key -> Bearer POST
                      a deliberately-broken products CSV to
                      /api/v1/tools/shopify_products_import_fix) returns 200 with a
                      top-level file_b64 (the fix route ALWAYS returns a CSV,
                      rowsOut===rowsIn) and _meta.ledger carrying fixed/couldnt/
                      warnings/summary. summary.rowsIn===rowsOut===nrows.
  4) real repair    — a broken input yields at least one detected defect
                      (fixedCount + flaggedCount > 0). The fixture carries a
                      "$"-prefixed price (doc-grounded price_format_normalized) and
                      a "Price" header alias (doc-grounded header_normalized).
  5) determinism    — the keyless route's defining property: two identical calls
                      return byte-identical file_b64 (this is the "byte parity"
                      an agent MCP call would see — deterministic, no model).
  6) page + host 200.

Keyless route: no prod ANTHROPIC_API_KEY needed. Unlike the mapper pages there is
no honest-decline branch — a CSV is always produced.
"""
import base64, json, re, subprocess, sys, time, urllib.request, urllib.error

SITE = "https://xlsx-for-ai.dev"
API = "https://api.xlsx-for-ai.dev"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

SLUG = "fix-shopify-products"
TOOL = "shopify_products_import_fix"

# Deliberately-broken but already-Shopify-shaped classic export. Defects grounded
# in packages/shopify-producer/docs/xls-213-rule-appendix.md:
#   - "Price" header  -> header_normalized to canonical "Variant Price"
#   - "$19.99"/"$1,299" price -> price_format_normalized (single leading symbol)
# 3 data rows; rowsIn must round-trip to 3.
FIXTURE = (
    "Handle,Title,Price,Variant SKU\n"
    "summer-tee,Summer Tee,$19.99,DOD-TEE-1\n"
    'winter-hoodie,Winter Hoodie,"$1,299.00",DOD-HOODIE-1\n'
    "canvas-tote,Canvas Tote,12.5,DOD-TOTE-1\n"
)
# Well-formed RFC-4180 (the $1,299.00 field is quoted so every row is 4 columns).
# The DoD asserts contract shape + rowsIn + determinism, not a pinned fixedCount,
# so it is robust to exactly how the route buckets each field.
NROWS = 3

_p, _f = [], []
def ok(m): _p.append(m); print("PASS:", m)
def bad(m): _f.append(m); print("FAIL:", m)

def fetch(url, timeout=20):
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(url + sep + "cb=%d" % time.time_ns(),
                                 headers={"Cache-Control": "no-cache", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")

def post_json(url, body, headers=None, timeout=60):
    data = json.dumps(body).encode()
    h = {"Content-Type": "application/json", "User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))

# ------------------------------------------------------------------ 1) deploy
print("== 1) wait for deploy (served page.js wires the keyless tool) ==")
deployed = False
for i in range(80):
    try:
        _, js = fetch("%s/tools/%s/page.js" % (SITE, SLUG))
        if TOOL in js:
            deployed = True; print("  deployed at attempt", i + 1); break
    except Exception as e:
        print("  fetch err:", e)
    time.sleep(30)
ok("served page.js is live and wires %s" % TOOL) if deployed \
    else bad("page.js not deployed after ~40min")
if not deployed:
    print("\n==== XLS-213 fix-page DoD: %d passed / %d failed (DEPLOY NOT LANDED) ===="
          % (len(_p), len(_f)))
    sys.exit(1)

# --------------------------------------------------------- 2) page render
print("== 2) headless render: panel + standalone scripts ==")
def dom(url):
    return subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                           "--virtual-time-budget=6000", "--dump-dom",
                           url + "?cb=%d" % int(time.time())],
                          capture_output=True, text=True, timeout=60).stdout
d = dom("%s/tools/%s/" % (SITE, SLUG))
checks = {
    "panel mounts": d.count('id="xfa-panel"') == 1,
    "shell.js loaded": "/tools/shell.js" in d,
    "page.js loaded": ("/tools/%s/page.js" % SLUG) in d,
    "NOT a mapper page (no shopify-import.js)": "/tools/shopify-import.js" not in d,
}
for k, v in checks.items():
    ok(k) if v else bad(k)

# ----------------------------------------------- 3+4+5) route contract/parity
print("== 3) live route contract (mint key -> POST broken CSV) ==")
try:
    st, cj = post_json(API + "/api/v1/clients",
                       {"client_version": "web-tools-1.0", "platform": "web"})
    api_key = cj.get("api_key")
    ok("minted anon key") if api_key else bad("no api_key in /clients response")
except Exception as e:
    bad("/api/v1/clients failed (%s)" % e); api_key = None

if api_key:
    auth = {"Authorization": "Bearer " + api_key}
    b64 = base64.b64encode(FIXTURE.encode()).decode()
    body = {"file_b64": b64, "filename": SLUG + ".csv"}
    resp = None
    try:
        st, resp = post_json(API + "/api/v1/tools/" + TOOL, body, headers=auth)
        ok("route 200") if st == 200 else bad("route status %d" % st)
    except urllib.error.HTTPError as e:
        bad("route HTTP %d" % e.code)
    except Exception as e:
        # Log the exception TYPE only, never str(e): the Authorization header
        # (anon key) must never reach stdout even in an error path.
        bad("route call failed (%s)" % type(e).__name__)

    if resp:
        file_b64 = resp.get("file_b64")
        ok("top-level file_b64 present (route always returns a CSV)") if file_b64 \
            else bad("no top-level file_b64 (fix route must always return a CSV)")
        meta = resp.get("_meta") or {}
        led = meta.get("ledger") or {}
        shape = all(k in led for k in ("fixed", "couldnt", "warnings", "summary"))
        ok("ledger has fixed/couldnt/warnings/summary") if shape \
            else bad("ledger missing keys (%s)" % list(led.keys()))
        if shape:
            s = led["summary"]
            ok("rowsIn == %d" % NROWS) if s.get("rowsIn") == NROWS \
                else bad("rowsIn %s != %d" % (s.get("rowsIn"), NROWS))
            ok("rowsOut === rowsIn (no rows added/dropped)") \
                if s.get("rowsOut") == s.get("rowsIn") \
                else bad("rowsOut %s != rowsIn %s" % (s.get("rowsOut"), s.get("rowsIn")))
            # 4) real repair: a broken input produced at least one detected defect
            fc = s.get("fixedCount", len(led.get("fixed") or []))
            gc = s.get("flaggedCount", len(led.get("couldnt") or []))
            ok("broken input detected >=1 defect (fixed=%d flagged=%d)" % (fc, gc)) \
                if (fc + gc) > 0 \
                else bad("broken input produced NO defects (fixed=0 flagged=0)")

        # 5) determinism: keyless route -> identical call -> byte-identical CSV
        print("== 5) determinism (byte parity an agent MCP call would see) ==")
        try:
            st2, resp2 = post_json(API + "/api/v1/tools/" + TOOL, body, headers=auth)
            f2 = (resp2 or {}).get("file_b64")
            ok("two identical calls -> byte-identical file_b64 (deterministic)") \
                if (file_b64 and f2 == file_b64) \
                else bad("determinism broken: file_b64 differs across identical calls")
        except Exception as e:
            bad("determinism re-call failed (%s)" % type(e).__name__)

# ----------------------------------------------------------- 6) page 200
print("== 6) page + host resolve 200 ==")
for url in ["%s/tools/%s/" % (SITE, SLUG), "%s/tools/" % SITE]:
    try:
        st, _ = fetch(url, timeout=15)
        ok("%s 200" % url) if st == 200 else bad("%s %d" % (url, st))
    except Exception as e:
        bad("%s error %s" % (url, e))

print("\n==== XLS-213 fix-page DoD: %d passed / %d failed ====" % (len(_p), len(_f)))
sys.exit(0 if not _f else 1)
