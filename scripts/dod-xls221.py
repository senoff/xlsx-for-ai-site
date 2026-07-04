#!/usr/bin/env python3
"""XLS-221 live DoD on the real deploy. Adds SPM's required uniqueness assertion:
no two tool pages' .xfa-mcp prose are identical, and each names its own tool."""
import hashlib, re, subprocess, sys, time, urllib.request

BASE = "https://xlsx-for-ai.dev"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# slug -> keyword that must appear in that page's prose (ties prose to its tool)
PAGES = {
 "check-for-macros": "macros",
 "clean-export": "export",
 "compare": "diff",
 "convert-excel-to-csv": "CSV",
 "filter-rows": "rows",
 "fix-broken-links": "links",
 "fix-formula-errors": "formula",
 "get-ready-safely": "safe",
 "remove-duplicates": "dedupe",
 "remove-personal-data": "redact",
 "run-any-tool": "operation",
 "summarize": "summariz",
 "whats-inside-excel-file": "inside",
}

_p, _f = [], []
def ok(m): _p.append(m); print("PASS:", m)
def bad(m): _f.append(m); print("FAIL:", m)

def fetch(url):
    req = urllib.request.Request(url + ("&" if "?" in url else "?") + "cb=%d" % time.time_ns(),
                                 headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")

# 1) wait for the new shell.js (marker: .xfa-mcp-copy sourcing) to be served
print("== 1) wait for deploy (served shell.js has .xfa-mcp-copy) ==")
deployed = False
for i in range(80):
    try:
        if "xfa-mcp-copy" in fetch(BASE + "/tools/shell.js"):
            deployed = True; print("  deployed at attempt", i + 1); break
    except Exception as e:
        print("  fetch err:", e)
    time.sleep(30)
ok("served shell.js is the unique-prose version") if deployed else bad("shell.js not deployed after ~40min")
if not deployed:
    print("\n==== XLS-221 LIVE DoD: %d passed / %d failed (DEPLOY NOT LANDED) ====" % (len(_p), len(_f)))
    sys.exit(1)

# 2) uniqueness + tool-tie on served HTML (.xfa-mcp-copy block is static in HTML)
print("== 2) 13 pages: unique prose + names its own tool ==")
block_re = re.compile(r'<div class="xfa-mcp-copy"[^>]*>(.*?)</div>\s*<footer', re.S)
tag_re = re.compile(r"<[^>]+>")
hashes = {}
for slug, kw in PAGES.items():
    try:
        html = fetch("%s/tools/%s/" % (BASE, slug))
    except Exception as e:
        bad("%s: fetch failed (%s)" % (slug, e)); continue
    m = block_re.search(html)
    if not m:
        bad("%s: no .xfa-mcp-copy block in served HTML" % slug); continue
    text = re.sub(r"\s+", " ", tag_re.sub(" ", m.group(1))).strip()
    hashes[slug] = hashlib.md5(text.encode()).hexdigest()
    if kw.lower() in text.lower():
        ok("%s: prose names its tool ('%s')" % (slug, kw))
    else:
        bad("%s: prose missing tool keyword '%s'" % (slug, kw))

if len(hashes) == len(PAGES) and len(set(hashes.values())) == len(PAGES):
    ok("all %d prose blocks are distinct (no duplicate content)" % len(PAGES))
else:
    dupes = [s for s in hashes if list(hashes.values()).count(hashes[s]) > 1]
    bad("prose NOT all-distinct; collisions: %s" % dupes)

# 3) headless render: section builds, single id, aria, install verbatim, /#docs
print("== 3) headless render 3 pages ==")
def dom(url):
    return subprocess.run([CHROME, "--headless", "--disable-gpu", "--no-sandbox",
                           "--virtual-time-budget=6000", "--dump-dom",
                           url + "?cb=%d" % time.time()],
                          capture_output=True, text=True, timeout=60).stdout

for slug in ("convert-excel-to-csv", "remove-personal-data", "fix-formula-errors"):
    d = dom("%s/tools/%s/" % (BASE, slug))
    checks = {
      "section present": d.count('id="xfa-mcp"') == 1,
      "single #xfa-mcp-h": d.count('id="xfa-mcp-h"') == 1,
      "aria-labelledby": 'aria-labelledby="xfa-mcp-h"' in d,
      "install verbatim": "claude mcp add xfa -- xlsx-for-ai-mcp" in d and "npm install -g xlsx-for-ai" in d,
      "/#docs link": 'href="/#docs"' in d,
      "raw block removed": 'class="xfa-mcp-copy"' not in d,
    }
    for k, v in checks.items():
        ok("%s: %s" % (slug, k)) if v else bad("%s: %s" % (slug, k))

# 4) hub opts out
print("== 4) hub opts out ==")
hub = dom(BASE + "/tools/")
ok("hub has no section") if 'id="xfa-mcp"' not in hub else bad("hub unexpectedly has section")

# 5) /#docs host resolves
print("== 5) / resolves 200 ==")
try:
    with urllib.request.urlopen(BASE + "/", timeout=15) as r:
        ok("/ 200") if r.status == 200 else bad("/ %d" % r.status)
except Exception as e:
    bad("/ error %s" % e)

print("\n==== XLS-221 LIVE DoD: %d passed / %d failed ====" % (len(_p), len(_f)))
sys.exit(0 if not _f else 1)
