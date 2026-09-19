#!/usr/bin/env python3
"""
Generate the XLS-1453 GS<>Excel problem/solution article set.

Content-only, self-contained pages modelled on developers/ and large-files/
(inline <style>, /copy.js for the copy blocks, strict CSP). Every article's
"our solution" <section> carries data-catalog-class / data-disposition /
data-claim-tier so the honesty-gate check (SPEC §7 TEST_PLAN) is mechanical:
a reviewer greps the section and confirms the claim tier matches the catalog
row cited, without re-deriving it.

Disposition claims are carried VERBATIM from gs-tier3-article-set-SPEC.md §3
(itself carried from corpus-hardening-07 §2). No disposition is upgraded here.
Bucket B (#5,#6,#7,#10) and Wave 2 (7 defects) are intentionally NOT built.
"""
import os, re, html, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "google-sheets")

STYLE = """  :root {
    --fg: #1a1a1a;
    --muted: #5a5a5a;
    --bg: #ffffff;
    --accent: #107c41;
    --border: #e6e6e6;
    --code-bg: #f5f5f5;
    --flag: #c2610c;
    --flag-soft: #fdf1e5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--fg);
    background: var(--bg);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    font-size: 0.92em;
  }
  pre {
    background: var(--code-bg);
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 16px 0;
    white-space: pre-wrap;
  }
  code { background: var(--code-bg); padding: 2px 5px; border-radius: 3px; }
  pre code { background: none; padding: 0; }

  .wrap { max-width: 760px; margin: 0 auto; padding: 0 24px; }

  header {
    border-bottom: 1px solid var(--border);
    padding: 18px 0;
  }
  header .wrap { display: flex; align-items: center; justify-content: space-between; }
  header .logo { font-weight: 700; font-size: 18px; color: var(--fg); }
  header .logo .x { color: var(--accent); }
  header nav a { color: var(--muted); margin-left: 22px; font-size: 14px; }
  header nav a:hover { color: var(--fg); text-decoration: none; }

  main { padding: 48px 0 96px; }
  main h1 {
    font-size: 34px;
    line-height: 1.2;
    margin: 0 0 12px;
    letter-spacing: -0.02em;
  }
  main .lede { font-size: 19px; color: var(--muted); margin: 0 0 12px; }
  .eyebrow {
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px;
    font-weight: 600; color: var(--accent); margin: 0 0 10px;
  }
  main h2 {
    font-size: 22px;
    margin: 36px 0 12px;
    border-top: 1px solid var(--border);
    padding-top: 28px;
    letter-spacing: -0.01em;
  }
  main h2:first-of-type { border-top: 0; padding-top: 0; }
  main h3 { font-size: 17px; margin: 24px 0 8px; }
  main ul, main ol { padding-left: 22px; }
  main li { margin: 8px 0; }
  main strong { font-weight: 600; }
  main em { color: var(--muted); }

  .note {
    background: var(--flag-soft);
    border: 1px solid #f2d9bf;
    border-radius: 8px;
    padding: 14px 16px;
    margin: 20px 0;
    font-size: 15px;
  }
  .note strong { color: var(--flag); }

  .card-list { list-style: none; padding-left: 0; }
  .card-list li { margin: 14px 0; }
  .card-list .q { font-weight: 600; }

  .copy { cursor: pointer; position: relative; }
  .copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .copy.copied { outline: 2px solid var(--accent); outline-offset: 2px; }
  .copy::after {
    content: 'Click to copy';
    position: absolute; top: 8px; right: 10px;
    font-size: 11px; color: var(--muted);
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .copy.copied::after { content: 'Copied \\2713'; color: var(--accent); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  footer {
    border-top: 1px solid var(--border);
    padding: 28px 0;
    color: var(--muted);
    font-size: 13px;
  }
  footer .wrap { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  footer a { color: var(--muted); margin-left: 0; }
  footer .links a { margin-left: 16px; }
  footer a:hover { color: var(--fg); }"""

HEADER = """<header>
  <div class="wrap">
    <div class="logo"><span class="x">x</span>lsx-for-ai</div>
    <nav>
      <a href="/">Home</a>
      <a href="/google-sheets/">Google Sheets</a>
      <a href="/developers/">Developers</a>
      <a href="https://github.com/senoff/xlsx-for-ai" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>"""

FOOTER = """<footer>
  <div class="wrap">
    <div>&copy; 2026 xlsx-for-ai. All rights reserved.</div>
    <div class="links">
      <a href="/">Home</a>
      <a href="/google-sheets/">Google Sheets</a>
      <a href="/tools/">Tools</a>
      <a href="/developers/">Developers</a>
      <a href="/privacy/">Privacy</a>
      <a href="https://github.com/senoff/xlsx-for-ai" rel="noopener">GitHub</a>
    </div>
  </div>
</footer>"""

# CSP identical to developers/ (script-src 'self' for /copy.js; no frames/connect beyond self)
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; "
       "frame-ancestors 'none'; object-src 'none'")

ICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E"
        "%3Crect width='64' height='64' rx='10' fill='%23107c41'/%3E%3Ctext x='32' y='42' "
        "text-anchor='middle' font-family='sans-serif' font-weight='700' font-size='28' "
        "fill='white'%3Ex%3C/text%3E%3C/svg%3E")

def page(slug, title, description, ld_json, body):
    canonical = f"https://xlsx-for-ai.dev/google-sheets/{slug}/" if slug else "https://xlsx-for-ai.dev/google-sheets/"
    ld = ""
    if ld_json:
        ld = '\n<script type="application/ld+json">\n' + ld_json + '\n</script>'
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(description)}">
<meta name="author" content="xlsx-for-ai">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:type" content="article">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<link rel="canonical" href="{canonical}">
<link rel="icon" href="{ICON}">
<style>
{STYLE}
</style>{ld}
</head>
<body>

<span id="copy-status" class="sr-only" aria-live="polite"></span>

{HEADER}

<main>
<div class="wrap">
{body}
</div>
</main>

{FOOTER}

<script src="/copy.js"></script>

</body>
</html>
"""

# ---- shared building blocks ------------------------------------------------

def solution(catalog_class, disposition, claim_tier, inner):
    return (f'<section class="solution" data-catalog-class="{catalog_class}" '
            f'data-disposition="{disposition}" data-claim-tier="{claim_tier}">\n'
            f'<h2>How xlsx-for-ai handles it</h2>\n{inner}\n</section>')

# Standard "connect or convert" instruction blocks, per direction.
CONNECT_STEPS = """<ol>
  <li><strong>Add the connector to Claude</strong> once &mdash; open <strong>Settings &rarr; Connectors &rarr; Add custom connector</strong> and paste <code>https://api.xlsx-for-ai.dev/mcp/claude</code>. Full steps are on the <a href="/developers/">developers page</a>.</li>
  <li><strong>Read the live Sheet by id.</strong> In Claude, ask:
    <pre class="copy" role="button" tabindex="0" data-copy="Read this Google Sheet and convert it to an .xlsx, with xfa. Flag anything that won&#39;t survive the conversion: https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit" title="Click to copy"><code>Read this Google Sheet and convert it to an .xlsx, with xfa.
Flag anything that won't survive the conversion:
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit</code></pre>
    Reading a live Sheet is read-only and uses a read-only Google token you supply &mdash; see the <a href="/developers/">developers page</a> for the one-time setup.</li>
  <li><strong>Or skip the token</strong> &mdash; in Google Sheets choose <strong>File &rarr; Download &rarr; Microsoft Excel (.xlsx)</strong>, then ask Claude to <em>&ldquo;read this file with xfa and tell me what it flagged.&rdquo;</em> Same reader, same flags.</li>
  <li><strong>Read the flags.</strong> The result tells you exactly what it did and what it couldn&rsquo;t carry across &mdash; so you review a short list instead of hunting for a wrong number later.</li>
</ol>"""

def csv_steps(download="CSV"):
    return f"""<ol>
  <li><strong>Add the connector to Claude</strong> once (<a href="/developers/">how</a>), or use it directly &mdash; either way there&rsquo;s no signup.</li>
  <li><strong>Export from Google Sheets.</strong> Choose <strong>File &rarr; Download &rarr; Comma-separated values (.csv)</strong> for the sheet you want.</li>
  <li><strong>Hand it to xfa.</strong> Ask Claude:
    <pre class="copy" role="button" tabindex="0" data-copy="Read this CSV with xfa and show me the columns exactly as they parsed." title="Click to copy"><code>Read this CSV with xfa and show me the columns
exactly as they parsed.</code></pre>
    You&rsquo;ll see the columns split correctly, with the delimiter it detected called out.</li>
  <li><strong>Prefer the live Sheet?</strong> You can also point <code>xlsx_read</code> at the Sheet by id (read-only token, <a href="/developers/">setup here</a>) and ask for CSV back.</li>
</ol>"""

RELATED = """<h2>More Google Sheets &harr; Excel problems</h2>
<ul class="card-list">
  <li><span class="q"><a href="/google-sheets/arrayformula-not-working-in-excel/">ARRAYFORMULA stopped working in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/dynamic-array-spill-broke-in-excel/">A spilled range (FILTER, SORT, UNIQUE) broke in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/sheets-only-functions-break-in-excel/">Google-Sheets-only functions break in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/xludf-dummyfunction-name-error-in-excel/">__xludf.DUMMYFUNCTION / #NAME? after downloading a Google Sheet</a></span></li>
  <li><span class="q"><a href="/google-sheets/query-function-not-working-in-excel/">QUERY function not working in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/importrange-not-working-in-excel/">IMPORTRANGE not working in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/googlefinance-not-working-in-excel/">GOOGLEFINANCE not working in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/named-function-error-in-excel/">A named function shows an error in Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/numbers-dates-change-converting-to-excel/">Numbers or dates look different after converting</a></span></li>
  <li><span class="q"><a href="/google-sheets/notes-comments-lost-converting-to-excel/">Notes and comments when converting to Excel</a></span></li>
  <li><span class="q"><a href="/google-sheets/huge-empty-rows-columns-in-export/">Huge empty rows or columns in a Sheets export</a></span></li>
  <li><span class="q"><a href="/google-sheets/csv-columns-wrong-semicolon-delimiter/">CSV columns are wrong (semicolons instead of commas)</a></span></li>
</ul>
<p style="margin-top:24px;"><a href="/google-sheets/">&larr; All Google Sheets &harr; Excel guides</a></p>"""

def article_ld(title, description, slug):
    return ('{\n'
            '  "@context": "https://schema.org",\n'
            '  "@type": "TechArticle",\n'
            f'  "headline": {json_str(title)},\n'
            f'  "description": {json_str(description)},\n'
            f'  "url": "https://xlsx-for-ai.dev/google-sheets/{slug}/",\n'
            '  "isPartOf": { "@type": "WebSite", "name": "xlsx-for-ai", "url": "https://xlsx-for-ai.dev/" },\n'
            '  "publisher": { "@type": "Organization", "name": "xlsx-for-ai", "url": "https://xlsx-for-ai.dev/" }\n'
            '}')

def json_str(s):
    import json
    return json.dumps(s)

# ---- the 8 publishable-now articles ---------------------------------------

ARTICLES = []

# ---------- #2 ARRAYFORMULA (A2, detected-declined, Decline) ----------
ARTICLES.append(dict(
  slug="arrayformula-not-working-in-excel",
  title="ARRAYFORMULA not working in Excel — xlsx-for-ai",
  desc="Google Sheets ARRAYFORMULA has no Excel equivalent, so it can convert to a wrong or blank result. xlsx-for-ai detects it and tells you rather than guessing.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>ARRAYFORMULA stopped working when I opened my Sheet in Excel</h1>
<p class="lede">You wrapped a formula in <code>ARRAYFORMULA</code> so it filled a whole column at once. In Excel that column is now empty, showing <code>#NAME?</code>, or &mdash; worse &mdash; a single value where a whole range used to be.</p>

<h2>What&rsquo;s actually breaking</h2>
<p><code>ARRAYFORMULA</code> is a Google-Sheets-only function. It tells Sheets to run an ordinary formula across an entire range and spill the results down. Excel has no function by that name. Modern Excel does have its own spilling behaviour, but it is triggered by the formula itself, not by a wrapper &mdash; so there is nothing for <code>ARRAYFORMULA(...)</code> to map onto.</p>
<p>When a file carrying <code>ARRAYFORMULA</code> is opened in Excel, one of a few things happens: Excel doesn&rsquo;t recognise the name and shows <code>#NAME?</code>; the wrapper is stripped and only the first cell computes, so a column of results collapses to one value; or the exported file froze the last computed values and the live behaviour is simply gone. The dangerous case is the middle one &mdash; a column that looks populated but is quietly wrong.</p>

""" + solution("A2", "detected-declined", "decline", """<p>xlsx-for-ai reads your Google Sheet with its own engine rather than handing the formula to Excel and hoping. When it meets <code>ARRAYFORMULA</code>, it <strong>detects that the function has no faithful Excel equivalent and declines to guess a result</strong>, telling you the cell and the reason instead of emitting a number that might be wrong.</p>
<p>That is the honest trade we make here: <strong>a visible, explained non-answer beats a silently wrong one.</strong> You get a short, specific list &mdash; &ldquo;this range depended on <code>ARRAYFORMULA</code>, which doesn&rsquo;t convert&rdquo; &mdash; so you can decide how to rebuild it, rather than shipping a spreadsheet whose totals are off by a column.</p>
<p>To be clear about what this is <em>not</em>: we do <strong>not</strong> silently reconstruct the array or recompute what the formula would have produced. We flag it. Rewriting it for Excel is your call &mdash; usually by replacing the wrapper with Excel&rsquo;s own spill (for example a plain range formula, or <code>FILTER</code>/<code>SEQUENCE</code> where appropriate).""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Rule of thumb:</strong> if xfa flags an <code>ARRAYFORMULA</code> range, rebuild it with a native Excel formula in that top cell and let Excel spill it &mdash; don&rsquo;t copy the values down by hand, or they&rsquo;ll go stale.</div>
""" + RELATED,
))

# ---------- #4 dynamic-array spill (a4, detected-declined, Decline) ----------
ARTICLES.append(dict(
  slug="dynamic-array-spill-broke-in-excel",
  title="Dynamic array (FILTER, SORT, UNIQUE) broke converting to Excel — xlsx-for-ai",
  desc="A spilled range from FILTER, SORT or UNIQUE can convert to a wrong or partial result. xlsx-for-ai detects the spill and declines to guess rather than serving a wrong number.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My FILTER / SORT / UNIQUE range broke when I moved to Excel</h1>
<p class="lede">One formula in Google Sheets filled a block of cells &mdash; a filtered list, a sorted table, a de-duplicated column. In Excel that block is now truncated, shows <code>#SPILL!</code>, or only the first cell has anything in it.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Functions like <code>FILTER</code>, <code>SORT</code>, <code>UNIQUE</code> and <code>SEQUENCE</code> are <em>dynamic arrays</em>: one formula in one cell produces many results that &ldquo;spill&rdquo; into the cells around it. Both Google Sheets and modern Excel support spilling, but they don&rsquo;t agree on every detail &mdash; how the anchor cell is stored, how the spilled region is described, and what happens when a cell the array wants to spill into is already occupied.</p>
<p>The result is that a spilled range can survive the trip perfectly, or it can arrive truncated to a single cell, blocked with <code>#SPILL!</code>, or &mdash; the case worth worrying about &mdash; showing a plausible-looking partial result that is missing rows. A reader skimming the sheet has no way to tell the difference.</p>

""" + solution("a4", "detected-declined", "decline", """<p>xlsx-for-ai reads the workbook with its own engine and looks specifically at spilled ranges. When it can&rsquo;t reproduce a dynamic array faithfully, it <strong>detects the spill and declines to serve a guessed result</strong> &mdash; it points at the anchor cell and tells you the range depended on a dynamic array, instead of quietly writing a shorter list.</p>
<p>The principle is the same one we apply throughout: <strong>a safe, visible non-answer beats a silently wrong one.</strong> You find out at conversion time that a filtered or sorted block needs a second look &mdash; not three weeks later when someone notices the count is off.</p>
<p>What we deliberately don&rsquo;t do: we don&rsquo;t re-run the filter and fabricate the missing rows, and we don&rsquo;t claim to explain the exact internal reason the two engines disagreed. We tell you <em>which</em> range is affected so you can re-enter the formula in Excel, where the same <code>FILTER</code>/<code>SORT</code>/<code>UNIQUE</code> will usually spill correctly once it&rsquo;s live.""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Tip:</strong> once you&rsquo;re in Excel, retype the dynamic-array formula in its anchor cell rather than pasting values &mdash; that restores the live spill instead of a frozen snapshot.</div>
""" + RELATED,
))

# ---------- #1 Sheets-only functions (A1, silently-wrong, SPLIT/scoped) ----------
ARTICLES.append(dict(
  slug="sheets-only-functions-break-in-excel",
  title="Google-Sheets-only functions break in Excel — xlsx-for-ai",
  desc="Functions like GOOGLEFINANCE, GOOGLETRANSLATE and IMPORTRANGE have no Excel equivalent. xlsx-for-ai catches two ways they break on read; a third (values frozen at export) it does not yet detect.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My Google-Sheets-only functions break in Excel</h1>
<p class="lede">Formulas like <code>GOOGLEFINANCE</code>, <code>GOOGLETRANSLATE</code>, <code>IMPORTRANGE</code> or <code>IMAGE</code> work in Google Sheets but have no Excel equivalent. In Excel they error out &mdash; or, more quietly, sit there showing an old value that never updates.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>These are functions Google built into Sheets alone. Excel has never had them, so there is nothing to convert them <em>to</em>. Depending on how the file crosses over, a Sheets-only function shows up in Excel in one of three ways:</p>
<ul>
  <li><strong>Live read, formula intact:</strong> the formula text comes across and Excel doesn&rsquo;t recognise the name &mdash; you get a clear <code>#NAME?</code> error.</li>
  <li><strong>Cached error:</strong> the Sheet already showed an error for that cell, and that <code>#NAME?</code> is what carries over.</li>
  <li><strong>Frozen value:</strong> the export captured the last computed value as a plain number or string, and the formula is gone &mdash; so Excel shows a value that looks fine but will never recalculate.</li>
</ul>

""" + solution("A1", "silently-wrong", "detect-scoped", """<p>Here we are deliberately precise about what we can and can&rsquo;t promise today, because this class can fail silently and we won&rsquo;t claim more than we&rsquo;ve proven.</p>
<p><strong>What xlsx-for-ai catches now:</strong> the two cases above where a tell survives into the file &mdash; a live formula whose name Excel can&rsquo;t resolve, and a cached <code>#NAME?</code>. In both, our reader flags the cell as a Google-Sheets-only function that won&rsquo;t work in Excel, so you don&rsquo;t mistake it for a real value.</p>
<p><strong>What it does not catch yet:</strong> the <em>frozen-value</em> case. When an export has already replaced the formula with its last result, there is often no signature left in the file to distinguish it from a number someone typed. We do <strong>not</strong> currently detect that case, and we&rsquo;d rather say so than imply full coverage.</p>
<p>So the honest claim is narrow and true: <strong>we catch Sheets-only functions that still carry a tell, and we&rsquo;re open that a value frozen at export can slip through.</strong> If a converted number matters and the original cell used a Google-only function, check it against the live Sheet.""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Safest path:</strong> for cells that used <code>GOOGLEFINANCE</code>, <code>IMPORTRANGE</code> and friends, read the <em>live</em> Sheet by id (not a stale download) so the formula &mdash; and its flag &mdash; is still present for xfa to catch.</div>
""" + RELATED,
))

# ---------- #3 Named functions (a3, surfaces-error, narrowed) ----------
ARTICLES.append(dict(
  slug="named-function-error-in-excel",
  title="A named function shows an error in Excel — xlsx-for-ai",
  desc="Google Sheets named functions (custom LAMBDA-style functions) don't exist in Excel and surface as a visible #NAME? error. xlsx-for-ai shows you the error rather than hiding a wrong value.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>A named function from my Sheet shows an error in Excel</h1>
<p class="lede">You built a custom <em>named function</em> in Google Sheets &mdash; your own reusable formula with a name like <code>MARGIN</code> or <code>NET_PRICE</code>. Open the file in Excel and every cell that used it shows <code>#NAME?</code>.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Named functions are a Google Sheets feature: you define a formula once, give it a name and arguments, and reuse it like a built-in. The definition lives in the Sheet&rsquo;s settings, not in the cells. When the file moves to Excel, Excel has no matching definition &mdash; so the name is unknown and every call to it resolves to <code>#NAME?</code>.</p>
<p>The important thing about this failure is that it is <em>loud</em>. Unlike a value that silently comes across wrong, a missing named function produces a real, visible error in the cell. That&rsquo;s annoying, but it&rsquo;s honest &mdash; the spreadsheet is telling you something is missing rather than pretending everything computed.</p>

""" + solution("a3", "surfaces-error", "surface-error", """<p>xlsx-for-ai reads the cell&rsquo;s actual state and <strong>shows you the error rather than papering over it</strong>. When a named function can&rsquo;t be resolved, the result is a visible <code>#NAME?</code> in the output &mdash; not a fabricated number in its place. You see exactly where the gaps are, so you can redefine those formulas in Excel.</p>
<p>We&rsquo;re keeping this claim narrow on purpose. Today the honest promise is: <strong>you get a visible error, not a silently wrong value.</strong> We are <em>not</em> yet claiming to tell you specifically &ldquo;this was a dropped Google named function, here is its definition&rdquo; &mdash; distinguishing a dropped named function from an ordinary typo is work we&rsquo;re still proving out. What you can rely on now is that the failure is surfaced, not hidden.</p>
<p>Because the error is visible, the fix is straightforward: find each <code>#NAME?</code>, and replace the named-function call with the equivalent Excel formula (or an Excel <code>LAMBDA</code> defined in Name Manager).</p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Before you convert:</strong> in Google Sheets open <strong>Data &rarr; Named functions</strong> to see each custom function&rsquo;s definition &mdash; keep that list handy so you can rebuild them in Excel.</div>
""" + RELATED,
))

# ---------- #11 Number/date-format fidelity (d16, passthrough-ok, narrowed) ----------
ARTICLES.append(dict(
  slug="numbers-dates-change-converting-to-excel",
  title="Numbers or dates look different converting Sheets to Excel — xlsx-for-ai",
  desc="Display formatting can shift between Google Sheets and Excel. xlsx-for-ai doesn't silently change the stored value, and discloses any case where a locale shift would change a value.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My numbers or dates look different after converting to Excel</h1>
<p class="lede">A date that read <code>13/04/2026</code> in Google Sheets now shows as <code>04/13/2026</code> in Excel, or a currency amount lost its symbol, or a number gained or dropped decimal places. Did the data change &mdash; or just how it&rsquo;s shown?</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Most of the time, nothing in your data changed &mdash; only its <em>display format</em> did. A spreadsheet stores a number (say <code>46125</code> for a date, or <code>1234.5</code> for an amount) separately from the mask that decides how it&rsquo;s shown (<code>dd/mm/yyyy</code>, <code>$#,##0.00</code>, and so on). Google Sheets and Excel don&rsquo;t always carry those masks across identically, and both lean on the reader&rsquo;s locale for defaults &mdash; so the same stored value can appear in a different date order or with a different currency symbol.</p>
<p>The distinction that matters: a <strong>cosmetic</strong> format shift leaves the underlying value intact (the date is still the same day, just written differently). A genuine <strong>value</strong> change &mdash; where a locale difference actually reinterprets the stored number &mdash; is rarer but far more serious.</p>

""" + solution("d16", "passthrough-ok", "no-silent-corruption", """<p>xlsx-for-ai reads the stored value with its own engine, so it <strong>doesn&rsquo;t silently corrupt the number underneath the format</strong>. When you read a workbook, the value it reports is the value the file holds &mdash; a display-format difference between Sheets and Excel is cosmetic and doesn&rsquo;t change what&rsquo;s stored.</p>
<p>We&rsquo;re scoping this claim carefully rather than promising perfect format preservation. The honest statement is: <strong>we don&rsquo;t change your values, and if a case ever arose where a locale shift would change a stored value rather than just its display, that&rsquo;s exactly the kind of thing we disclose rather than pass through quietly.</strong> We are not claiming pixel-perfect reproduction of every number and date <em>mask</em> &mdash; some display drift between the two products is expected, and it&rsquo;s cosmetic.</p>
<p>So if a date looks re-ordered after conversion, read the underlying value (xfa will show it): in almost every case it&rsquo;s the same day, and you only need to reapply the date format you want in Excel.""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Quick sanity check:</strong> ask xfa for the raw value of a suspicious cell. If the stored number matches, it&rsquo;s a formatting difference &mdash; fix it with <strong>Format &rarr; Cells</strong> in Excel, and your data is untouched.</div>
""" + RELATED,
))

# ---------- #8 Notes/comments base split (c13, detected-metered, disclose base) ----------
ARTICLES.append(dict(
  slug="notes-comments-lost-converting-to-excel",
  title="Notes and comments converting Google Sheets to Excel — xlsx-for-ai",
  desc="Google Sheets has two kinds of annotation — legacy notes and threaded comments. xlsx-for-ai reads both and reports them so they aren't silently dropped when you convert.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>Where did my notes and comments go converting to Excel?</h1>
<p class="lede">Your Google Sheet had little annotations &mdash; some plain cell <em>notes</em>, some back-and-forth <em>comment threads</em>. After a round-trip to Excel you&rsquo;re not sure which survived, or you&rsquo;re worried some vanished silently.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Google Sheets has two different annotation systems that look similar but are stored differently. A <strong>note</strong> is a simple text sticky attached to a cell &mdash; the old, lightweight kind, with no author and no replies. A <strong>comment</strong> is a threaded discussion, with authors, replies, timestamps, and a resolved state. They sit in different places inside the file.</p>
<p>Excel has its own two-system history that only <em>looks</em> like a match. Older Excel &ldquo;comments&rdquo; were really cell notes; newer Excel &ldquo;threaded comments&rdquo; are the discussion kind. So converting isn&rsquo;t a clean note&rarr;note, comment&rarr;comment swap &mdash; it&rsquo;s two products with two overlapping systems each, and the mapping between them isn&rsquo;t one-to-one. That mismatch is exactly how an annotation can quietly go missing: a threaded comment can land as a flat note stripped of its replies, or a note can be filed as the wrong kind, and nothing warns you it happened.</p>
<p>Concretely: a reviewer&rsquo;s three-message thread on cell <code>B7</code> in Sheets might arrive in Excel as a single note reading only the first message &mdash; or not arrive at all &mdash; while you have no easy way to notice the other two replies are gone.</p>

""" + solution("c13", "detected-metered", "disclose", """<p>xlsx-for-ai reads <strong>both</strong> kinds of annotation and tells them apart. Its reader distinguishes legacy notes from threaded comments as it goes through the workbook, so both are surfaced in what it reports back &mdash; they aren&rsquo;t silently swallowed on the way through.</p>
<p>That base capability is what we&rsquo;re claiming here, and only that: <strong>we read your notes and your comments and disclose them, rather than dropping them without a word.</strong> You can ask for a workbook&rsquo;s comments explicitly and see both types listed with the cell they belong to.</p>
<p>What we&rsquo;re not over-claiming: a fully faithful round-trip of every threaded-comment detail &mdash; every reply, author and resolved flag reconstructed exactly on the other side &mdash; is a richer job than reading and reporting them, and we&rsquo;re still hardening the edges of it. The dependable promise today is that neither kind of annotation disappears unseen: you get told what&rsquo;s there.""") + """

<h2>How to check your file</h2>
<ol>
  <li><strong>Add the connector to Claude</strong> once (<a href="/developers/">how</a>).</li>
  <li><strong>Ask for the annotations directly.</strong> In Claude:
    <pre class="copy" role="button" tabindex="0" data-copy="Read this Google Sheet with xfa and list every note and comment, with the cell each one is on: https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit" title="Click to copy"><code>Read this Google Sheet with xfa and list every note
and comment, with the cell each one is on:
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit</code></pre>
  </li>
  <li><strong>Or from a download</strong> &mdash; <strong>File &rarr; Download &rarr; Microsoft Excel (.xlsx)</strong>, then ask xfa to <em>&ldquo;list the comments and notes in this file.&rdquo;</em></li>
  <li><strong>Reconcile.</strong> Use that list to confirm each annotation you care about made it across, and re-add any your workflow depends on.</li>
</ol>
<div class="note"><strong>Good habit:</strong> pull the notes-and-comments list <em>before</em> you convert, so you have a checklist to reconcile against afterwards.</div>
""" + RELATED,
))

# ---------- #9 Dimension-bloat (d17, detected-metered, Bluey landed, disclose) ----------
ARTICLES.append(dict(
  slug="huge-empty-rows-columns-in-export",
  title="Huge empty rows or columns in a Google Sheets export — xlsx-for-ai",
  desc="A Google Sheets export can carry a used range of millions of empty cells, bloating the file. xlsx-for-ai detects the phantom dimensions and flags them.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My Google Sheets export has millions of empty rows and columns</h1>
<p class="lede">You exported a modest Sheet, but the Excel file is huge and slow, the scrollbar thinks there are millions of rows, and pressing <kbd>Ctrl</kbd>+<kbd>End</kbd> jumps miles past your last real cell.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Every spreadsheet tracks a <em>used range</em> &mdash; the rectangle from A1 to the furthest cell it considers &ldquo;in use.&rdquo; Google Sheets is generous about what counts: a stray format applied to a whole column, a leftover value far down a sheet, or just the sheet&rsquo;s default grid can push that boundary out to enormous dimensions. When the file is exported, that inflated used range comes with it &mdash; so Excel believes the sheet spans far more rows and columns than actually hold data. The file balloons, opens slowly, and formulas that reference whole columns do needless work.</p>

""" + solution("d17", "detected-metered", "disclose", """<p>xlsx-for-ai has a dedicated profile for Google-Sheets exports that <strong>detects this phantom dimension bloat and flags it</strong>. When it reads a workbook whose declared used range is far larger than its real data, it recognises the pattern and calls it out, so a 40&nbsp;MB file that holds a few thousand real cells isn&rsquo;t a mystery &mdash; you&rsquo;re told the used range is inflated and by roughly how much.</p>
<p>The claim here is detection and disclosure: <strong>we surface the bloat so it&rsquo;s not invisible.</strong> That&rsquo;s the piece that&rsquo;s live and regression-guarded today. Trimming the sheet back to its true extent is then a deliberate step you take in Excel &mdash; select the empty rows below your data and the empty columns to the right, delete them, and save &mdash; rather than something that happens to your file without your say-so.</p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>To slim the file in Excel:</strong> click the first empty row under your data, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>&darr;</kbd> and delete; do the same for empty columns to the right; then save. The phantom used range collapses to your real data.</div>
""" + RELATED,
))

# ---------- #12 GS->CSV locale delimiter (g2, detected-declined/handled, handle) ----------
ARTICLES.append(dict(
  slug="csv-columns-wrong-semicolon-delimiter",
  title="CSV columns are wrong — semicolons instead of commas — xlsx-for-ai",
  desc="In some locales Google Sheets exports CSV with semicolons, so everything lands in one column. xlsx-for-ai detects the delimiter and reads the columns correctly.",
  body="""<div class="eyebrow">Google Sheets &rarr; CSV</div>
<h1>My Google Sheets CSV opens with everything in one column</h1>
<p class="lede">You downloaded a sheet as CSV, but instead of neat columns every row is one long string full of semicolons &mdash; <code>Alice;42;London</code> &mdash; and whatever you opened it in refuses to split it.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>&ldquo;CSV&rdquo; means <em>comma</em>-separated values, but not everywhere. In locales where the comma is the decimal separator (much of Europe, South America and beyond), a number like &ldquo;one and a half&rdquo; is written <code>1,5</code>, not <code>1.5</code>. If such a file also used commas to separate columns, that single value would split into two &mdash; <code>1</code> and <code>5</code> &mdash; and every decimal in the sheet would break.</p>
<p>To avoid that, Google Sheets (and Excel) switch the column separator to a <strong>semicolon</strong> in those locales, so <code>1,5</code> stays one number and columns are divided by <code>;</code> instead. The export you get is perfectly valid &mdash; it just isn&rsquo;t comma-delimited. A tool that blindly assumes commas finds none to split on and drops the whole row into a single column, which is why you see <code>Alice;42;London</code> sitting in column A.</p>
<p>It&rsquo;s not something you did wrong, and it&rsquo;s not a corrupt file. The separator is a regional setting &mdash; the same sheet exported by a colleague in a comma-decimal locale would come out semicolon-delimited too, whether or not the data has any decimals in it at all.</p>

""" + solution("g2", "detected-declined", "handle", """<p>xlsx-for-ai doesn&rsquo;t assume the separator &mdash; its CSV reader <strong>detects the delimiter and reads your columns correctly</strong> whether the file uses commas or semicolons. Point it at a semicolon-separated export and the fields split where they should, so <code>Alice;42;London</code> becomes three columns rather than one.</p>
<p>That delimiter detection is live and is the claim we stand behind here. We&rsquo;re still hardening the trickier locale edge &mdash; a file that combines semicolon columns <em>and</em> comma decimals inside the same numbers &mdash; so if your data has both, give the parsed numbers a quick look. For the common case (everything crammed into one column because the export used semicolons), xfa reads it right the first time.</p>""") + """

<h2>How to fix your file</h2>
""" + csv_steps() + """
<div class="note"><strong>Prefer commas?</strong> Ask xfa to read the semicolon CSV and hand it back as a standard comma-delimited CSV &mdash; then it opens cleanly anywhere that expects commas.</div>
""" + RELATED,
))

# ---------- XLS-1645: the __xludf.DUMMYFUNCTION wrapper (A1, silently-wrong, strong detect-scoped) ----------
ARTICLES.append(dict(
  slug="xludf-dummyfunction-name-error-in-excel",
  title="__xludf.DUMMYFUNCTION / #NAME? after downloading a Google Sheet — xlsx-for-ai",
  desc="Cells showing __xludf.DUMMYFUNCTION or #NAME? after a Google Sheets download aren't corrupt — Google wrapped the formula and cached its last result. xlsx-for-ai reliably detects the wrapper and reads back every function it hid, plus its cached value.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My cells show __xludf.DUMMYFUNCTION or #NAME? after downloading from Google Sheets</h1>
<p class="lede">You did <strong>File &rarr; Download &rarr; Microsoft Excel (.xlsx)</strong>, opened the file, and a bunch of cells now read something like <code>=IFERROR(__xludf.DUMMYFUNCTION(&quot;QUERY(A1:C50,...)&quot;),853.12)</code> &mdash; or just a flat <code>#NAME?</code>. Nothing is corrupt. That&rsquo;s Google leaving you a clue, not Excel breaking your file.</p>

<h2>What&rsquo;s actually breaking</h2>
<p>Every formula Sheets has that Excel doesn&rsquo;t &mdash; <code>QUERY</code>, <code>ARRAYFORMULA</code>, <code>IMPORTRANGE</code>, <code>GOOGLEFINANCE</code>, <code>GOOGLETRANSLATE</code>, the whole list &mdash; gets the same treatment on export. Google can&rsquo;t hand Excel a formula Excel can&rsquo;t run, so it wraps it: the real formula becomes a text string inside a function called <code>__xludf.DUMMYFUNCTION</code>, and the last value Sheets actually computed gets tucked into the second argument of an <code>IFERROR</code> around it. Click the cell and you&rsquo;re looking at both halves at once &mdash; the dead formula, and the answer it used to give.</p>
<p>Excel has never heard of <code>__xludf.DUMMYFUNCTION</code>, so it can&rsquo;t run it. Most of the time <code>IFERROR</code> catches that failure and falls through to the cached number, and the cell just looks normal &mdash; a plain value sitting there, quietly frozen. Sometimes, depending on how the formula nested, Excel can&rsquo;t even get that far and you get a flat <code>#NAME?</code> with no visible number at all.</p>
<p>Either way, the question that matters is <em>which</em> function got wrapped and whether the number you&rsquo;re looking at is the real cached answer. Wrapped a <code>QUERY</code>? See <a href="/google-sheets/query-function-not-working-in-excel/">QUERY function not working in Excel</a>. <code>IMPORTRANGE</code>? See <a href="/google-sheets/importrange-not-working-in-excel/">IMPORTRANGE not working in Excel</a>. <code>GOOGLEFINANCE</code>? See <a href="/google-sheets/googlefinance-not-working-in-excel/">GOOGLEFINANCE not working in Excel</a>.</p>

""" + solution("A1", "silently-wrong", "detect-scoped", """<p>This is the one spot in the whole Sheets-only-function mess where I&rsquo;ll say &ldquo;reliable&rdquo; without hedging it. <code>__xludf.DUMMYFUNCTION</code> is a literal, unmistakable string sitting in the formula &mdash; there&rsquo;s no guessing about whether it&rsquo;s there. Hand the file to xfa (the reader I use for this) and it <strong>reliably finds every <code>__xludf.DUMMYFUNCTION</code> wrapper, pulls out which Sheets-only function it&rsquo;s hiding, and reads back the cached value from the second argument</strong> &mdash; the same value Excel is either showing you or burying behind <code>#NAME?</code>.</p>
<p>That confidence is specific to this one signature. The moment a value has already been flattened &mdash; no wrapper, no formula text, just a plain number sitting where the formula used to be &mdash; there is nothing left in the file to detect, and xfa does <strong>not</strong> claim to catch that case; there&rsquo;s no tell left to find. But if what you&rsquo;re staring at is <code>__xludf.DUMMYFUNCTION</code> or a <code>#NAME?</code> that came from one, that wrapper is exactly the signature xfa is built to catch.</p>
<p>So instead of squinting at nested <code>IFERROR</code> arguments yourself, you get a list back: cell, which function got wrapped, and the value that was sitting inside it.</p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Quick manual check:</strong> click any cell showing <code>__xludf.DUMMYFUNCTION</code> and read the formula bar &mdash; the second argument to <code>IFERROR</code> is the cached value. That&rsquo;s the last-known-good number; it just stopped updating the moment you downloaded the file.</div>
""" + RELATED,
))

# ---------- XLS-1645: QUERY (A1, silently-wrong, detect-scoped) ----------
ARTICLES.append(dict(
  slug="query-function-not-working-in-excel",
  title="QUERY function not working in Excel after Google Sheets — xlsx-for-ai",
  desc="QUERY is a Google Sheets-only function — Excel has no built-in equivalent. Here's the fix map (FILTER, SUMIFS/COUNTIFS, Power Query) and what xlsx-for-ai can and can't tell you about the value left behind.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>My QUERY function doesn&rsquo;t work after I opened the file in Excel</h1>
<p class="lede">You built something with <code>=QUERY(A2:F900, &quot;select A, sum(D) where C=&#39;East&#39; group by A&quot;)</code> in Sheets. In Excel that cell is dead &mdash; <code>#NAME?</code>, or a frozen number that used to be right and no longer moves.</p>

<h2>What&rsquo;s actually breaking</h2>
<p><code>QUERY</code> runs a small SQL-like query language over a range &mdash; select, where, group by, order by, all in one string. Excel has no function that does that. Not a smaller version of it, not a rename &mdash; nothing. There&rsquo;s no direct swap, so the fix is rebuilding the logic with whatever piece of Excel actually covers what your particular <code>QUERY</code> was doing:</p>
<ul>
  <li><strong>Simple select/where</strong> (pick some columns, filter some rows) &mdash; Excel 365&rsquo;s <code>FILTER()</code> spills a range the same way <code>QUERY</code> did, natively, no helper columns.</li>
  <li><strong>Aggregate / group by</strong> (sums, counts, averages per group) &mdash; <code>SUMIFS</code>, <code>COUNTIFS</code>, <code>AVERAGEIFS</code> cover almost all of it once you know which group-by column you&rsquo;re keying on.</li>
  <li><strong>Real multi-condition, SQL-shaped stuff</strong> (joins, multiple aggregations, reshaping) &mdash; that&rsquo;s Power Query&rsquo;s job (<strong>Data &rarr; Get Data</strong>), not a single formula&rsquo;s.</li>
</ul>
<p>On export from Sheets, a broken <code>QUERY</code> cell almost always shows up wrapped in Google&rsquo;s own placeholder rather than as a clean error &mdash; see <a href="/google-sheets/xludf-dummyfunction-name-error-in-excel/">__xludf.DUMMYFUNCTION / #NAME? after downloading a Google Sheet</a> for what that wrapper contains and how to read the last real result back out of it.</p>

""" + solution("A1", "silently-wrong", "detect-scoped", """<p>xfa (the reader I use for this) reads a workbook and looks specifically for the ways a Sheets-only function survives into a file: a live <code>QUERY(...)</code> formula Excel can&rsquo;t resolve, a cached <code>#NAME?</code>, or &mdash; the strongest case &mdash; the <code>__xludf.DUMMYFUNCTION</code> wrapper with QUERY&rsquo;s last result cached inside it. All three of those, it flags: which cell, that it was a dead <code>QUERY</code>, and what value (if any) it can recover.</p>
<p>What it does <strong>not</strong> catch: a <code>QUERY</code> result that&rsquo;s already been flattened to a plain number or table with no formula and no wrapper left behind. At that point there&rsquo;s no signature in the file distinguishing it from data someone typed by hand, and xfa doesn&rsquo;t pretend otherwise.</p>
<p>So the honest claim is narrow: <strong>it catches a dead QUERY that still carries a tell, and it says so plainly when a frozen result might have slipped through with none.</strong></p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Rebuilding tip:</strong> <code>FILTER()</code> handles the select/where half natively and spills like <code>QUERY</code> did &mdash; wrap it in <code>SORT()</code> if the original had an <code>order by</code>.</div>
""" + RELATED,
))

# ---------- XLS-1645: IMPORTRANGE (A1, silently-wrong, detect-scoped) ----------
ARTICLES.append(dict(
  slug="importrange-not-working-in-excel",
  title="IMPORTRANGE not working in Excel after Google Sheets — xlsx-for-ai",
  desc="IMPORTRANGE pulls live data from another Google Sheet — Excel has no equivalent, so the values freeze the moment you export. Here's what that means and how to get live data back with Power Query.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>IMPORTRANGE doesn&rsquo;t work after I moved the file to Excel</h1>
<p class="lede"><code>IMPORTRANGE</code> was pulling live rows from another Google Sheet into this one. In Excel that link is just gone &mdash; either an error, or numbers that look fine and will never change again.</p>

<h2>What&rsquo;s actually breaking</h2>
<p><code>IMPORTRANGE(spreadsheet_url, range)</code> is a live formula reference into a completely different spreadsheet &mdash; it recalculates and re-pulls every time the source Sheet changes. Excel has no function that reaches across into another Google Sheet by URL like that. It&rsquo;s not that Excel&rsquo;s version is weaker or needs a flag turned on &mdash; there isn&rsquo;t one, because the two products don&rsquo;t share a data layer.</p>
<p>That makes <code>IMPORTRANGE</code> the worst case in this whole family for silently going stale. Most Sheets-only functions leave some trace behind on export &mdash; a dead formula string, a <code>#NAME?</code>, Google&rsquo;s own <code>__xludf.DUMMYFUNCTION</code> wrapper (see <a href="/google-sheets/xludf-dummyfunction-name-error-in-excel/">that page</a> for what the wrapper looks like when it does survive). But because <code>IMPORTRANGE</code> exists purely to bring in values, an export very often just freezes those values as plain numbers or text with nothing marking them as imported at all. They look exactly like something a person typed in by hand &mdash; and they&rsquo;ll sit there, unchanged, forever.</p>

""" + solution("A1", "silently-wrong", "detect-scoped", """<p>xfa (the reader I use for this) catches an <code>IMPORTRANGE</code> the same way it catches any Sheets-only function: when the formula itself, a cached error, or the <code>__xludf.DUMMYFUNCTION</code> wrapper is still present in the file, it flags the cell as a dead <code>IMPORTRANGE</code> rather than letting you mistake it for a real value.</p>
<p>What it does <strong>not</strong> catch: values already frozen to plain numbers with no formula or wrapper left &mdash; and because <code>IMPORTRANGE</code> cells convert to exactly that shape so easily, this is the function on this whole site where that blind spot bites hardest. If a converted number came from an <code>IMPORTRANGE</code> cell and it actually matters, don&rsquo;t trust a lack of a flag as proof it&rsquo;s current &mdash; check it against the live source.</p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Getting live data back in Excel:</strong> <code>IMPORTRANGE</code>&rsquo;s equivalent isn&rsquo;t a formula, it&rsquo;s <strong>Data &rarr; Get Data</strong> (Power Query) pointed at the source file or a published-to-web CSV, with a refresh schedule. Different mechanism, same job &mdash; numbers that update instead of freezing at export.</div>
""" + RELATED,
))

# ---------- XLS-1645: GOOGLEFINANCE (A1, silently-wrong, detect-scoped) ----------
ARTICLES.append(dict(
  slug="googlefinance-not-working-in-excel",
  title="GOOGLEFINANCE not working in Excel after Google Sheets — xlsx-for-ai",
  desc="GOOGLEFINANCE is Sheets-only — Excel has no matching function, though the 365 Stocks data type covers some of the same ground. Here's the fix and what a frozen GOOGLEFINANCE value looks like.",
  body="""<div class="eyebrow">Google Sheets &rarr; Excel</div>
<h1>GOOGLEFINANCE doesn&rsquo;t work after I opened my Sheet in Excel</h1>
<p class="lede">You had <code>=GOOGLEFINANCE(&quot;NASDAQ:AAPL&quot;,&quot;price&quot;)</code> pulling a live quote. In Excel that cell either shows <code>#NAME?</code>, or a number that hasn&rsquo;t moved since the day you downloaded the file.</p>

<h2>What&rsquo;s actually breaking</h2>
<p><code>GOOGLEFINANCE</code> is a live market-data feed built into Sheets &mdash; prices, exchange rates, historical series, fundamentals &mdash; with no Excel function of the same name and no exact equivalent. The closest thing Excel has is the <strong>Stocks</strong> linked data type in Excel 365 (<strong>Data &rarr; Stocks</strong>): you type a ticker or company name into a cell, convert it to the Stocks type, and pull fields out of it with dot-notation formulas like <code>=A1.Price</code>. It&rsquo;s a different mechanism (a typed cell, not a function call) with a different field set, so it isn&rsquo;t a drop-in swap &mdash; some of what <code>GOOGLEFINANCE</code> could pull (certain historical ranges, some currency pairs) the Stocks type simply doesn&rsquo;t carry.</p>
<p>When a <code>GOOGLEFINANCE</code> cell crosses over to Excel, it goes through the same export path as every other Sheets-only function: a dead formula, a cached error, or Google&rsquo;s <code>__xludf.DUMMYFUNCTION</code> wrapper with the last quote cached inside it &mdash; see <a href="/google-sheets/xludf-dummyfunction-name-error-in-excel/">that page</a> for how to read the cached value back out.</p>

""" + solution("A1", "silently-wrong", "detect-scoped", """<p>xfa (the reader I use for this) flags a dead <code>GOOGLEFINANCE</code> cell the same way it flags any Sheets-only function: a live formula Excel can&rsquo;t resolve, a cached <code>#NAME?</code>, or the <code>__xludf.DUMMYFUNCTION</code> wrapper all get caught and reported, with the cached quote pulled out where it&rsquo;s recoverable.</p>
<p>What it does <strong>not</strong> catch: a quote already frozen to a plain number with no formula or wrapper surviving in the file. A stock price that&rsquo;s just a number looks identical to one typed by hand, and xfa won&rsquo;t claim to tell those apart. If a price matters and the cell used to be <code>GOOGLEFINANCE</code>, treat any unflagged number as unverified and check it against a live source before you rely on it.</p>""") + """

<h2>How to check your file</h2>
""" + CONNECT_STEPS + """
<div class="note"><strong>Rebuilding tip:</strong> put the ticker in a cell, <strong>Data &rarr; Stocks</strong> to convert it to a linked data type, then reference fields with <code>=CELL.Price</code>, <code>=CELL.&quot;52 Week High&quot;</code>, and so on &mdash; that&rsquo;s the closest live equivalent Excel has.</div>
""" + RELATED,
))

# ---- hub page --------------------------------------------------------------

HUB_LD = ('{\n'
  '  "@context": "https://schema.org",\n'
  '  "@type": "CollectionPage",\n'
  '  "name": "Google Sheets \\u2194 Excel: problems and fixes",\n'
  '  "description": "Honest, per-problem guides for converting between Google Sheets and Excel \\u2014 what breaks, why, and how xlsx-for-ai handles it.",\n'
  '  "url": "https://xlsx-for-ai.dev/google-sheets/",\n'
  '  "isPartOf": { "@type": "WebSite", "name": "xlsx-for-ai", "url": "https://xlsx-for-ai.dev/" }\n'
  '}')

HUB_BODY = """<div class="eyebrow">Google Sheets &harr; Excel</div>
<h1>Google Sheets &harr; Excel: what breaks, and how we handle it.</h1>
<p class="lede">Moving a spreadsheet between Google Sheets and Excel is a well-known source of quiet breakage &mdash; a formula that stops working, a column that collapses, a file that balloons to millions of empty rows.</p>
<p>These guides are deliberately honest. Each one names a real problem, explains what&rsquo;s actually happening underneath, and says exactly what xlsx-for-ai does about it &mdash; whether that&rsquo;s reading the value correctly, <strong>detecting the problem and telling you rather than guessing</strong>, or flagging a loss so it isn&rsquo;t silent. Where a platform difference can&rsquo;t be prevented, we say so plainly. We&rsquo;d rather leave a guide unwritten than claim to solve something we don&rsquo;t.</p>

<h2>Formulas that don&rsquo;t convert</h2>
<ul class="card-list">
  <li><span class="q"><a href="/google-sheets/arrayformula-not-working-in-excel/">ARRAYFORMULA stopped working in Excel</a></span><br>
    A Sheets-only wrapper with no Excel equivalent &mdash; we detect it and decline to guess rather than serve a wrong column.</li>
  <li><span class="q"><a href="/google-sheets/dynamic-array-spill-broke-in-excel/">A spilled range (FILTER, SORT, UNIQUE) broke in Excel</a></span><br>
    Dynamic arrays don&rsquo;t always cross faithfully &mdash; we detect the spill and flag it instead of writing a shorter list.</li>
  <li><span class="q"><a href="/google-sheets/sheets-only-functions-break-in-excel/">Google-Sheets-only functions break in Excel</a></span><br>
    <code>GOOGLEFINANCE</code>, <code>IMPORTRANGE</code> and friends &mdash; we catch the cases that leave a tell, and we&rsquo;re open about the one that doesn&rsquo;t.</li>
  <li><span class="q"><a href="/google-sheets/xludf-dummyfunction-name-error-in-excel/">__xludf.DUMMYFUNCTION / #NAME? after downloading a Google Sheet</a></span><br>
    Google&rsquo;s own wrapper around the dead formula, with the last result cached inside it &mdash; the one case here we detect reliably.</li>
  <li><span class="q"><a href="/google-sheets/query-function-not-working-in-excel/">QUERY function not working in Excel</a></span><br>
    No Excel equivalent &mdash; the fix map is FILTER, SUMIFS/COUNTIFS, or Power Query depending on what the query did.</li>
  <li><span class="q"><a href="/google-sheets/importrange-not-working-in-excel/">IMPORTRANGE not working in Excel</a></span><br>
    Live cross-sheet data that freezes at export &mdash; the case most likely to slip past detection with no tell left.</li>
  <li><span class="q"><a href="/google-sheets/googlefinance-not-working-in-excel/">GOOGLEFINANCE not working in Excel</a></span><br>
    No direct Excel equivalent, though the 365 Stocks data type covers some of the same ground.</li>
  <li><span class="q"><a href="/google-sheets/named-function-error-in-excel/">A named function shows an error in Excel</a></span><br>
    Custom named functions don&rsquo;t exist in Excel &mdash; you get a visible error, not a silently wrong value.</li>
</ul>

<h2>Data that looks different</h2>
<ul class="card-list">
  <li><span class="q"><a href="/google-sheets/numbers-dates-change-converting-to-excel/">Numbers or dates look different after converting</a></span><br>
    Usually a display-format shift, not a data change &mdash; we don&rsquo;t silently corrupt the stored value.</li>
  <li><span class="q"><a href="/google-sheets/notes-comments-lost-converting-to-excel/">Notes and comments when converting to Excel</a></span><br>
    Two kinds of annotation, stored differently &mdash; we read both and disclose them so neither disappears unseen.</li>
</ul>

<h2>Files and CSV</h2>
<ul class="card-list">
  <li><span class="q"><a href="/google-sheets/huge-empty-rows-columns-in-export/">Huge empty rows or columns in a Sheets export</a></span><br>
    An inflated used range bloats the file &mdash; we detect the phantom dimensions and flag them.</li>
  <li><span class="q"><a href="/google-sheets/csv-columns-wrong-semicolon-delimiter/">CSV columns are wrong (semicolons instead of commas)</a></span><br>
    Some locales export CSV with semicolons &mdash; we detect the delimiter and read the columns correctly.</li>
</ul>

<h2>How you use these</h2>
<p>Every guide works the same way: add the xlsx-for-ai connector to Claude once, then either point it at your <strong>live Google Sheet by id</strong> (read-only, with a read-only Google token you supply) or hand it a <strong>downloaded export</strong>. It reads the file with its own engine and tells you what it did &mdash; and what it couldn&rsquo;t carry across. <a href="/developers/">See the setup steps &rarr;</a></p>
<p class="muted" style="color:var(--muted);font-size:14px;">More guides are on the way as we prove out each case &mdash; we add a problem here only once we actually handle it.</p>"""

def main():
    os.makedirs(OUT, exist_ok=True)
    # hub
    with open(os.path.join(OUT, "index.html"), "w") as f:
        f.write(page("", "Google Sheets to Excel: problems and fixes — xlsx-for-ai",
                     "Honest, per-problem guides for converting between Google Sheets and Excel — what breaks, why, and how xlsx-for-ai handles it. No signup.",
                     HUB_LD, HUB_BODY))
    # articles
    for a in ARTICLES:
        d = os.path.join(OUT, a["slug"])
        os.makedirs(d, exist_ok=True)
        ld = article_ld(a["title"], a["desc"], a["slug"])
        with open(os.path.join(d, "index.html"), "w") as f:
            f.write(page(a["slug"], a["title"], a["desc"], ld, a["body"]))
        # crude body word count (strip tags)
        text = re.sub(r"<[^>]+>", " ", a["body"])
        text = html.unescape(text)
        words = len(text.split())
        print(f"{a['slug']:48s} {words:4d} words")
    print(f"\nWrote hub + {len(ARTICLES)} articles to {OUT}")

if __name__ == "__main__":
    main()
