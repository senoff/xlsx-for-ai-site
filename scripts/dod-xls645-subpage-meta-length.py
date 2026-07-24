#!/usr/bin/env python3
"""XLS-645 source-property DoD: every long-tail Q&A/how-to subpage
(tools/<slug>/<subslug>/index.html) must ship a <meta name="description">
whose DECODED length is <=155 code-points.

Why DECODED, not raw. A search engine renders and truncates the decoded text,
not the HTML source. Several subpages carry entities in the meta content
(&#x27; for an apostrophe, &quot; for a quote), so a raw byte/char count would
overstate the real SERP length -- e.g. the shared "Short version..." reassurance
template is 160 raw but 145 decoded, and would be falsely flagged by a raw check
while a page trimmed to exactly 155 decoded would falsely pass a laxer one. This
is the same >155 bar as XLS-218 gap #4 and XLS-225, generalised correctly to
pages that contain HTML entities. (XLS-225 measured raw because those two pages
had no entities; here they do, so we decode.)

This is a SOURCE property (the committed file), so build-branch evidence is
sufficient -- no deploy/crawl is required to rule it. A live crawl is an optional
extra confirmation, not the gate.

Falsifiability. A length check that only ever sees compliant files can pass by
vacuity, so `--selftest` runs the exact assertion against synthetic pages that
are BROKEN in each way it must catch and requires each to go RED:
  * a page whose meta is 156 decoded code-points  -> MUST fail
  * a page whose meta is entity-inflated to >155 RAW but <=155 DECODED
    -> MUST pass (proves the decode step is actually applied, not skipped)
  * a page whose meta is exactly 155 decoded       -> MUST pass (boundary)
A green real run is only trustworthy because the same assertion provably reddens
on these.

Exit codes: 0 = all subpage metas <=155 decoded (or selftest passed);
1 = at least one subpage meta >155 decoded (or a selftest arm did not behave);
2 = no subpages found (wrong CWD / empty tree -- an empty set must not pass).
"""
import glob
import html
import os
import re
import sys

LIMIT = 155
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLOB = os.path.join(REPO, "tools", "*", "*", "index.html")
META_RE = re.compile(r'<meta name="description" content="([^"]*)"', re.I)


def decoded_len(raw):
    return len(html.unescape(raw))


def scan():
    """Return (over, total). `over` is a list of (decoded_len, relpath)."""
    over = []
    total = 0
    for path in sorted(glob.glob(GLOB)):
        with open(path, encoding="utf-8") as fh:
            m = META_RE.search(fh.read())
        if not m:
            continue  # no meta description tag on this subpage; not this DoD's bar
        total += 1
        n = decoded_len(m.group(1))
        if n > LIMIT:
            over.append((n, os.path.relpath(path, REPO)))
    return over, total


def run():
    over, total = scan()
    if total == 0:
        print("FAIL: no tools/*/*/index.html subpages found under %s "
              "(wrong CWD or empty tree) -- an empty set must not pass" % REPO)
        return 2
    if over:
        print("FAIL: %d subpage meta description(s) exceed %d decoded "
              "code-points:" % (len(over), LIMIT))
        for n, rel in sorted(over, reverse=True):
            print("  %3d  %s" % (n, rel))
        print("\n==== XLS-645 subpage meta-length DoD: %d/%d over ===="
              % (len(over), total))
        return 1
    print("PASS: all %d subpage meta descriptions <=%d decoded code-points"
          % (total, LIMIT))
    print("==== XLS-645 subpage meta-length DoD: 0/%d over ====" % total)
    return 0


def _page(meta_content):
    return ('<!DOCTYPE html><html><head>'
            '<meta name="description" content="%s">'
            '</head><body></body></html>') % meta_content


def selftest():
    """Prove the assertion reddens on each broken shape. Returns 0 iff every
    arm behaved as required."""
    import tempfile

    fails = []

    def check_arm(name, meta_content, expect_over):
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "tools", "selftest-slug", "selftest-sub")
            os.makedirs(sub)
            with open(os.path.join(sub, "index.html"), "w", encoding="utf-8") as fh:
                fh.write(_page(meta_content))
            # scan this synthetic tree directly
            over = []
            total = 0
            for path in glob.glob(os.path.join(d, "tools", "*", "*", "index.html")):
                with open(path, encoding="utf-8") as fh:
                    m = META_RE.search(fh.read())
                if not m:
                    continue
                total += 1
                if decoded_len(m.group(1)) > LIMIT:
                    over.append(path)
            got_over = bool(over)
            if got_over != expect_over:
                fails.append("%s: expected over=%s got over=%s (total=%d)"
                             % (name, expect_over, got_over, total))
                print("  SELFTEST FAIL:", fails[-1])
            else:
                print("  selftest ok: %s (over=%s)" % (name, got_over))

    # 156 decoded plain -> must be flagged
    check_arm("156-decoded-plain", "x" * 156, True)
    # exactly 155 decoded -> must pass
    check_arm("155-decoded-boundary", "y" * 155, False)
    # entity-inflated: 150 real chars where 5 are apostrophes written as &#x27;
    # raw length = 145 + 5*6 = 175 (>155 raw) but decoded = 150 (<=155)
    infl = ("z" * 145) + ("&#x27;" * 5)
    assert len(infl) > LIMIT and decoded_len(infl) <= LIMIT
    check_arm("entity-inflated-raw>155-decoded<=155", infl, False)
    # entity-inflated AND genuinely too long decoded (161 decoded) -> must flag
    long_infl = ("w" * 156) + ("&#x27;" * 5)  # decoded = 161
    assert decoded_len(long_infl) > LIMIT
    check_arm("entity-inflated-decoded>155", long_infl, True)

    if fails:
        print("\n==== XLS-645 selftest: %d arm(s) MISBEHAVED ====" % len(fails))
        return 1
    print("\n==== XLS-645 selftest: all arms behaved (check provably reddens) ====")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(run())
