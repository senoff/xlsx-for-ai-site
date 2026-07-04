#!/usr/bin/env python3
"""XLS-225 live DoD: served <meta name="description"> on /clean-data/ and
/large-files/ must each be <=155 code-points. Waits for the deploy to serve
the trimmed metas, then asserts the length bar on the real deploy."""
import re, sys, time, urllib.request

BASE = "https://xlsx-for-ai.dev"
PAGES = ("clean-data", "large-files")
LIMIT = 155
META_RE = re.compile(r'<meta name="description" content="(.*?)">', re.S)

_p, _f = [], []
def ok(m): _p.append(m); print("PASS:", m)
def bad(m): _f.append(m); print("FAIL:", m)

def fetch(url):
    req = urllib.request.Request(
        url + ("&" if "?" in url else "?") + "cb=%d" % time.time_ns(),
        headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")

def meta_len(slug):
    html = fetch("%s/%s/" % (BASE, slug))
    m = META_RE.search(html)
    if not m:
        return None, None
    c = m.group(1)
    return len(c), c

# wait until BOTH pages serve a meta description at or under the bar
print("== wait for deploy (both metas <=%d code-points) ==" % LIMIT)
deployed = False
for i in range(60):
    lens = {}
    for slug in PAGES:
        try:
            n, _ = meta_len(slug)
        except Exception as e:
            n = None
            print("  fetch err %s: %s" % (slug, e))
        lens[slug] = n
    if all(lens[s] is not None and lens[s] <= LIMIT for s in PAGES):
        deployed = True
        print("  served trimmed at attempt", i + 1, lens)
        break
    print("  attempt %d: %s (not yet)" % (i + 1, lens))
    time.sleep(20)

if not deployed:
    bad("deploy did not serve both trimmed metas after ~20min")
    print("\n==== XLS-225 LIVE DoD: %d passed / %d failed (DEPLOY NOT LANDED) ====" % (len(_p), len(_f)))
    sys.exit(1)

# assert the length bar on each served page, and that content is non-empty
for slug in PAGES:
    n, c = meta_len(slug)
    if n is None:
        bad("%s: no <meta name=description> served" % slug); continue
    if n == 0:
        bad("%s: empty meta description" % slug); continue
    if n <= LIMIT:
        ok("%s: served meta description %d code-points (<=%d)" % (slug, n, LIMIT))
    else:
        bad("%s: served meta description %d code-points (>%d)" % (slug, n, LIMIT))
    print("   %s: %s" % (slug, c))

print("\n==== XLS-225 LIVE DoD: %d passed / %d failed ====" % (len(_p), len(_f)))
sys.exit(0 if not _f else 1)
