#!/usr/bin/env python3
"""Live DoD for the Shopify EXPORT landing pages (XLS-210 products,
XLS-211 collections) on the real deploy.

These are a DIFFERENT SHAPE from the import shell pages (XLS-206..209). Export is
a live-store GraphQL pull inside the OAuth-gated Importable app — there is no
public anonymous producer route and no file for a shell to accept. So an export
page is a CONTENT/FUNNEL page: it names the native gap accurately and links to the
authenticated export surface. There is no upload panel to drive, so dod-page-walk
(which uploads a fixture and reads the download) cannot check it. This does.

What it asserts on each served page (per the XLS-210/211 card contract):
  1) the page resolves 200 on the real deploy
  2) the native-gap narrative is PRESENT and matches the ACCURATE claim for that
     page (a stale/false public gap claim is a RED blocker) — and the specific
     FALSE claim the card forbids is ABSENT
  3) the CTA funnels to the authenticated app export surface
     (app.xlsx-for-ai.dev/app/export) and NOT to a non-existent public producer
     route or an anonymous upload panel
  4) the page is free / no-signup (no signup-wall words, no <form>)
  5) prose uniqueness (XLS-221): the .xfa-mcp-copy block is md5-distinct across
     export-products, export-collections, AND import-products (XLS-206), and each
     names its own entity

Falsifiability. A content check that only greps for strings can silently pass on
anything, so `--selftest` runs every assertion against a synthetic page that is
BROKEN in exactly the way each assertion is meant to catch, and requires each to
go RED. A green live run is only trustworthy because the same assertions provably
redden on a broken page (run --selftest in CI alongside the live run).

Exit 0 = PASS · 1 = FAIL · 2 = DID NOT RUN (never a green).

Usage:
  python3 scripts/dod-shopify-export-pages.py            # live check on the deploy
  python3 scripts/dod-shopify-export-pages.py --selftest # prove the assertions can fail
  BASE_URL=http://localhost:8000 python3 scripts/dod-shopify-export-pages.py
"""
import hashlib
import os
import re
import sys
import time
import urllib.request

SITE = os.environ.get("BASE_URL", "https://xlsx-for-ai.dev").rstrip("/")
# The authenticated export surface the pages must funnel to (XLS-210/211).
EXPORT_SURFACE = "app.xlsx-for-ai.dev/app/export"
# Non-existent public producer routes / anonymous-tool markers that would mean
# the page claims an export path that does not exist.
FORBIDDEN_ROUTES = [
    "/api/v1/tools/shopify_products_export",
    "/api/v1/tools/shopify_collections_export",
]
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# slug -> assertion spec for that page.
#   must:   substrings that MUST appear (case-insensitive) — the accurate gap claim
#   forbid: substrings that must NOT appear — the specific FALSE claim the card bans
#   entity: keyword the .xfa-mcp prose must name (ties prose to its tool)
PAGES = {
    "export-shopify-products": {
        "entity": "product",
        "must": [
            "export shopify products",       # search intent / topic
            "variant",                        # the real metafield gap axis
            "metafield",                      # the subject
            "leading-zero",                   # the Excel-fidelity gap, precisely stated
            EXPORT_SURFACE,                   # CTA funnels to the auth surface
        ],
        # The card forbids the flat-false claim that native CSV has no metafields.
        "forbid": [
            "shopify's csv export has no metafields",
            "shopify does not export metafields",
            "shopify garbles",
        ],
    },
    "export-shopify-collections": {
        "entity": "collection",
        "must": [
            "export shopify collections",     # search intent / topic
            "no native collection export",    # the strongest, accurate gap
            "import-only",                     # the Collection-column truth
            "smart collection",               # must cover smart + manual
            EXPORT_SURFACE,                   # CTA funnels to the auth surface
        ],
        "forbid": [
            # A page must not tell the visitor to use a native export that doesn't exist.
            "shopify's native collection export",
            "use shopify's built-in collection export",
        ],
    },
}

# The XLS-221 uniqueness set the card names: the two new pages + XLS-206.
UNIQUENESS_SET = ["export-shopify-products", "export-shopify-collections", "import-shopify-products"]

_p, _f = [], []
def ok(m): _p.append(m); print("PASS:", m)
def bad(m): _f.append(m); print("FAIL:", m)

BLOCK_RE = re.compile(r'<div class="xfa-mcp-copy"[^>]*>(.*?)</div>\s*<footer', re.S)
TAG_RE = re.compile(r"<[^>]+>")
FORM_RE = re.compile(r"<form\b", re.I)
SIGNUP_WALLS = ["sign in", "sign up", "log in", "create an account", "start free trial", "enter your card"]


def prose_of(html):
    """The .xfa-mcp-copy block flattened to text (same recipe as dod-xls221)."""
    m = BLOCK_RE.search(html)
    if not m:
        return None
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", m.group(1))).strip()


def check_page(slug, html, spec):
    """Run every content assertion for one page against its HTML. Returns the
    .xfa-mcp prose (or None) for the cross-page uniqueness pass."""
    low = html.lower()

    # 2) native-gap narrative present + accurate; the forbidden false claim absent
    for needle in spec["must"]:
        ok("%s: present %r" % (slug, needle)) if needle.lower() in low \
            else bad("%s: MISSING required narrative/claim %r" % (slug, needle))
    for needle in spec["forbid"]:
        bad("%s: contains FORBIDDEN false claim %r" % (slug, needle)) if needle.lower() in low \
            else ok("%s: free of false claim %r" % (slug, needle))

    # 3) CTA funnels to the auth surface, NOT a public producer route / upload panel
    ok("%s: CTA funnels to auth export surface" % slug) if EXPORT_SURFACE in low \
        else bad("%s: CTA does not link the authenticated export surface" % slug)
    for route in FORBIDDEN_ROUTES:
        bad("%s: references non-existent public producer route %r" % (slug, route)) if route.lower() in low \
            else ok("%s: no public producer route %r" % (slug, route))
    bad("%s: has an upload panel (#xfa-panel) — export is not an anonymous upload" % slug) \
        if 'id="xfa-panel"' in low else ok("%s: no anonymous upload panel" % slug)

    # 4) free / no signup
    walls = [w for w in SIGNUP_WALLS if w in low]
    ok("%s: no signup-wall wording" % slug) if not walls else bad("%s: signup-wall words present: %s" % (slug, walls))
    ok("%s: no <form> (nothing to submit)" % slug) if not FORM_RE.search(html) else bad("%s: page has a <form>" % slug)
    ok("%s: says free" % slug) if "free" in low else bad("%s: does not say it's free" % slug)

    prose = prose_of(html)
    if prose is None:
        bad("%s: no .xfa-mcp-copy block" % slug)
    elif spec["entity"].lower() in prose.lower():
        ok("%s: mcp prose names its entity (%r)" % (slug, spec["entity"]))
    else:
        bad("%s: mcp prose missing entity keyword %r" % (slug, spec["entity"]))
    return prose


def fetch(url, timeout=20):
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(url + sep + "cb=%d" % time.time_ns(),
                                 headers={"Cache-Control": "no-cache", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


# ------------------------------------------------------------------ selftest
def selftest():
    """Prove each assertion class can go RED. Build a well-formed page for one
    slug, confirm it PASSES, then mutate it one break at a time and require the
    failure count to rise for each mutation. A check that stays green on a broken
    page is asserting nothing."""
    print("== --selftest: every assertion must redden on a broken page ==")
    good = _synth_good("export-shopify-collections")
    spec = PAGES["export-shopify-collections"]

    def fails_for(html):
        # Run check_page in isolation and return ONLY its failures, without
        # leaking into the module-level accumulators the summary reads.
        global _p, _f
        saved_p, saved_f = _p, _f
        _p, _f = [], []
        check_page("selftest", html, spec)
        out = list(_f)
        _p, _f = saved_p, saved_f
        return out

    base = fails_for(good)
    if base:
        for f in base:
            print("  unexpected FAIL on the good synthetic page:", f)
        print("SELFTEST: BROKEN — the good page does not pass its own assertions")
        return 1
    print("  baseline good synthetic page passes all assertions (0 failures)")

    mutations = {
        "drop the native-gap claim": lambda h: h.replace("no native collection export", "collections are easy to export"),
        "inject the forbidden false claim": lambda h: h.replace("</h1>", "</h1><p>Use Shopify's native collection export.</p>"),
        "break the CTA (wrong host)": lambda h: h.replace(EXPORT_SURFACE, "example.com/nope"),
        "add a public producer route": lambda h: h.replace("</body>", '<a href="/api/v1/tools/shopify_collections_export">x</a></body>'),
        "add an upload panel": lambda h: h.replace('<div class="panel">', '<div class="panel"><div id="xfa-panel"></div>'),
        "add a signup wall": lambda h: h.replace("</h1>", "</h1><p>Sign up to continue.</p>"),
        "add a <form>": lambda h: h.replace("</body>", "<form></form></body>"),
        "remove the mcp entity keyword": lambda h: h.replace("collection", "widget"),
    }
    proven, vacuous = 0, 0
    for name, mut in mutations.items():
        broken = mut(good)
        got = fails_for(broken)
        if len(got) > 0:
            proven += 1
            print("PASS: selftest mutation reddened: %s (%d failure(s))" % (name, len(got)))
        else:
            vacuous += 1
            print("FAIL: selftest mutation did NOT redden (assertion is vacuous): %s" % name)
    print("\n==== --selftest: %d proven / %d vacuous ====" % (proven, vacuous))
    return 0 if vacuous == 0 else 1


def _synth_good(slug):
    """A minimal well-formed page that satisfies every assertion for `slug`.
    Used only by --selftest as the mutation baseline — never fetched."""
    spec = PAGES[slug]
    must = "\n".join("<p>%s</p>" % m for m in spec["must"])
    return (
        "<!DOCTYPE html><html><head><title>t</title></head><body>"
        "<h1>Export shopify collections</h1>" + must +
        '<div class="panel"><a class="btn primary" href="https://%s">Export</a>'
        "<p>Free, no signup.</p></div>" % EXPORT_SURFACE +
        '<div class="xfa-mcp-copy" hidden><h2>agent</h2>'
        "<p>Let your agent reshape a collection export over MCP.</p></div>"
        "<footer>f</footer></body></html>"
    )


# ------------------------------------------------------------------ live run
def live():
    print("== live DoD on %s ==" % SITE)
    htmls = {}
    for slug in PAGES:
        url = "%s/tools/%s/" % (SITE, slug)
        try:
            status, html = fetch(url)
        except Exception as e:
            bad("%s: fetch failed (%s)" % (url, e))
            continue
        ok("%s 200" % url) if status == 200 else bad("%s HTTP %d" % (url, status))
        htmls[slug] = html
        check_page(slug, html, PAGES[slug])

    # 5) cross-page prose uniqueness (XLS-221) across the two new pages + XLS-206
    print("== prose uniqueness across %s ==" % ", ".join(UNIQUENESS_SET))
    hashes = {}
    for slug in UNIQUENESS_SET:
        html = htmls.get(slug)
        if html is None and slug not in PAGES:
            try:
                _s, html = fetch("%s/tools/%s/" % (SITE, slug))
            except Exception as e:
                bad("%s: fetch failed for uniqueness (%s)" % (slug, e))
                continue
        if html is None:
            continue
        t = prose_of(html)
        if not t:
            bad("%s: no .xfa-mcp-copy block for uniqueness" % slug)
            continue
        hashes[slug] = hashlib.md5(t.encode()).hexdigest()
    if len(hashes) == len(UNIQUENESS_SET) and len(set(hashes.values())) == len(UNIQUENESS_SET):
        ok("all %d prose blocks are md5-distinct (no SEO dilution)" % len(UNIQUENESS_SET))
    else:
        dupes = [s for s in hashes if list(hashes.values()).count(hashes[s]) > 1]
        bad("prose NOT all-distinct across the uniqueness set; collisions: %s" % dupes)

    print("\n==== Shopify export pages DoD: %d passed / %d failed ====" % (len(_p), len(_f)))
    return 0 if not _f else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(live())
