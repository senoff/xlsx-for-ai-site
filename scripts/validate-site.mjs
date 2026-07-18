#!/usr/bin/env node
/*
 * validate-site.mjs — the MECHANICAL pre-merge gate for the static site.
 *
 * This is the graded surface xlsx-merge's door reads: it runs before merge, on
 * the PR's own tree, and needs no live deploy. It is deliberately NOT the DoD.
 * The DoD (dod-*.py / dod-page-walk.mjs) is a post-deploy live probe and proves
 * a tool actually ran; this proves the tree it is about to merge is not broken:
 *
 *   1. HTML structure — every page has a doctype, a single <html>/<head>/<title>
 *      and exactly one <h1>, and its <head>-critical tags are balanced. A page
 *      that lost its </head> or shipped two <h1>s is a RED here, not a surprise
 *      in production.
 *   2. Internal links resolve — every site-local href/src (root-relative or
 *      relative; external http(s)/mailto/tel/data/# are out of scope) points at
 *      a file that exists on disk, with "/foo/" resolved to foo/index.html.
 *   3. Referenced assets exist — the stylesheet/script/image a page pulls in
 *      must be present in the tree. (A stricter restatement of #2 for the tags
 *      whose absence silently breaks the page rather than a link.)
 *
 * Sitemap freshness is asserted by the workflow (regenerate + `git diff
 * --exit-code sitemap.xml`), not here, because gen-sitemap.mjs already owns that
 * logic and re-implementing it would be a second answer that can drift.
 *
 * Usage:  node scripts/validate-site.mjs            # validate the whole tree
 *         node scripts/validate-site.mjs --selftest # prove every check reddens
 *
 * Exit 0 = clean · 1 = validation error(s) found · 2 = the runner itself failed
 * (bad args, no pages found — never a silent green).
 *
 * Falsifiability: --selftest runs each check against a page broken in exactly
 * the way that check must catch and requires each to redden. A validator that
 * cannot fail is not a gate.
 */
import { readdirSync, statSync, existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

// Directories that are not part of the served page tree.
const SKIP_DIRS = new Set([".git", "node_modules", "scripts", "test", "clean-data", "large-files", ".github"]);

// ---------------------------------------------------------------------------
// Tree walk — every index.html plus any top-level *.html (index, privacy, etc.)
// ---------------------------------------------------------------------------
function findHtml(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") && name !== ".") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      findHtml(full, out);
    } else if (name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction helpers (regex, not a DOM — no dep, and enough for these checks).
// Attribute values are matched in single OR double quotes.
// ---------------------------------------------------------------------------
const ATTR = (tag, attr) =>
  new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*["']([^"']*)["']`, "gi");

function attrValues(html, tag, attr) {
  const re = ATTR(tag, attr);
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function countTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}\\b`, "gi"));
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// CHECK 1 — HTML structure
// ---------------------------------------------------------------------------
// A redirect stub (<meta http-equiv="refresh">) is a "Moved" page: valid doctype/
// head/title/body but deliberately no <h1> and no content. Holding it to the
// content-heading rule would be a guard stricter than the page it guards — a
// false red on every PR that merely touches the tree. It still gets the
// structural + link checks; only the single-<h1> content rule is waived.
function isRedirectStub(html) {
  return /<meta\b[^>]*\bhttp-equiv\s*=\s*["']refresh["']/i.test(html);
}

function checkStructure(html, errs) {
  if (!/<!doctype html>/i.test(html)) errs.push("missing <!doctype html>");
  if (countTag(html, "html") !== 1) errs.push(`expected exactly 1 <html>, found ${countTag(html, "html")}`);
  if (countTag(html, "head") !== 1) errs.push(`expected exactly 1 <head>, found ${countTag(html, "head")}`);
  if (!/<\/head>/i.test(html)) errs.push("missing </head>");
  if (countTag(html, "body") !== 1) errs.push(`expected exactly 1 <body>, found ${countTag(html, "body")}`);
  if (!/<\/body>/i.test(html)) errs.push("missing </body>");
  if (countTag(html, "title") !== 1) errs.push(`expected exactly 1 <title>, found ${countTag(html, "title")}`);
  if (!isRedirectStub(html)) {
    const h1 = countTag(html, "h1");
    if (h1 !== 1) errs.push(`expected exactly 1 <h1>, found ${h1}`);
  }
}

// ---------------------------------------------------------------------------
// CHECK 2/3 — internal links + referenced assets resolve to a file on disk
// ---------------------------------------------------------------------------
function isExternal(url) {
  return /^(?:https?:)?\/\//i.test(url)   // http(s):// and protocol-relative //
    || /^(?:mailto:|tel:|data:|javascript:)/i.test(url)
    || url.startsWith("#")
    || url.trim() === "";
}

// Resolve a site-local URL to the file that must exist. Returns an absolute path
// or null if the URL is external / an anchor (not our concern).
function resolveLocal(url, pageFile) {
  if (isExternal(url)) return null;
  let u = url.split("#")[0].split("?")[0];
  if (u === "") return null;
  // A link may percent-encode on-disk characters (e.g. "%20"); decode before the
  // existence check or a real file reads as missing (a false red). Malformed
  // escapes are left as-is rather than throwing.
  try { u = decodeURI(u); } catch { /* keep raw */ }
  const base = u.startsWith("/") ? ROOT : dirname(pageFile);
  const rel = u.startsWith("/") ? u.slice(1) : u;
  let p = resolve(base, rel);
  // "/tools/" (or a dir with no extension) resolves to its index.html.
  if (u.endsWith("/")) return join(p, "index.html");
  return p;
}

function existsResolved(p) {
  if (existsSync(p)) {
    // A directory reference without a trailing slash still serves its index.html.
    try { if (statSync(p).isDirectory()) return existsSync(join(p, "index.html")); } catch { /* fallthrough */ }
    return true;
  }
  // Extensionless path that is really a directory index (e.g. "/tools/foo").
  if (!extname(p) && existsSync(join(p, "index.html"))) return true;
  return false;
}

// Drop comment blocks and the BODIES of <script>/<style> (keeping the opening
// tags, so <script src> is still extracted) before scanning for links. Without
// this, a literal `href="..."` inside inline JS or a comment would be treated as
// a real link and could false-red. Same rule the DoD probe's NOISE_RE applies.
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2")
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");
}

function checkLinks(rawHtml, pageFile, errs) {
  const html = stripNoise(rawHtml);
  const refs = [
    ...attrValues(html, "a", "href").map((u) => ["a href", u]),
    ...attrValues(html, "link", "href").map((u) => ["link href", u]),
    ...attrValues(html, "script", "src").map((u) => ["script src", u]),
    ...attrValues(html, "img", "src").map((u) => ["img src", u]),
  ];
  for (const [where, url] of refs) {
    const p = resolveLocal(url, pageFile);
    if (p === null) continue;              // external / anchor
    if (!existsResolved(p)) errs.push(`${where} "${url}" -> ${relative(ROOT, p)} does not exist`);
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
function validateFile(file) {
  const html = readFileSync(file, "utf8");
  const errs = [];
  checkStructure(html, errs);
  checkLinks(html, file, errs);
  return errs;
}

function runAll() {
  const files = findHtml(ROOT);
  if (files.length === 0) {
    console.error("validate-site: no .html pages found — refusing to report a green.");
    process.exit(2);
  }
  let bad = 0;
  for (const f of files) {
    const errs = validateFile(f);
    if (errs.length) {
      bad++;
      console.error(`\n✗ ${relative(ROOT, f)}`);
      for (const e of errs) console.error(`    - ${e}`);
    }
  }
  console.log(`\nvalidate-site: ${files.length} page(s) scanned, ${bad} with errors.`);
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Self-test — every check must redden on a page broken exactly for it.
// ---------------------------------------------------------------------------
function selftest() {
  // Hermetic: the self-test proves the validator's LOGIC, so it must not depend
  // on live repo assets (a PR that renames /tools/shell.css must red the real
  // pages, not the self-test). Fixtures live in an OS temp dir with RELATIVE
  // links resolved against a temp anchor page, and are removed at the end.
  const fix = mkdtempSync(join(tmpdir(), "validate-site-selftest-"));
  writeFileSync(join(fix, "shell.css"), "/* ok */");
  writeFileSync(join(fix, "shell.js"), "// ok");
  mkdirSync(join(fix, "sub"), { recursive: true });
  writeFileSync(join(fix, "sub", "index.html"), "<!doctype html><title>t</title><h1>t</h1>");
  const anchorFile = join(fix, "index.html");

  const good = `<!doctype html><html lang="en"><head><title>ok</title>
    <link rel="stylesheet" href="shell.css"></head>
    <body><h1>ok</h1><a href="sub/">tools</a>
    <script src="shell.js"></script></body></html>`;

  const mutate = (fn) => { const errs = []; const h = fn(good); checkStructure(h, errs); checkLinks(h, anchorFile, errs); return errs; };
  const cases = [
    ["good page is clean", () => good, 0],
    ["missing doctype", (h) => h.replace(/<!doctype html>/i, ""), 1],
    ["two <h1>", (h) => h.replace("</body>", "<h1>extra</h1></body>"), 1],
    ["missing </head>", (h) => h.replace("</head>", ""), 1],
    ["no title", (h) => h.replace(/<title>.*?<\/title>/i, ""), 1],
    ["dead relative href", (h) => h.replace('href="sub/"', 'href="sub/does-not-exist/"'), 1],
    ["dead asset src", (h) => h.replace('src="shell.js"', 'src="nope.js"'), 1],
    ["dead stylesheet", (h) => h.replace('href="shell.css"', 'href="nope.css"'), 1],
    // Exercises the ROOT-relative branch (u.startsWith("/") -> resolve against
    // ROOT). Hermetic: the inserted path cannot exist in the repo, so it reddens
    // regardless of tree contents.
    ["dead root-relative href", (h) => h.replace("</body>", '<a href="/no-such-dir-xyz123/">x</a></body>'), 1],
    // The redirect-stub exemption: a "Moved" page with no <h1> is clean...
    ["redirect stub without h1 is clean",
      () => `<!doctype html><html lang="en"><head><meta http-equiv="refresh" content="0; url=/x/"><title>Moved</title></head><body><a href="sub/">go</a></body></html>`, 0],
    // ...but the exemption must not leak: a NON-redirect page still needs its h1.
    ["non-redirect without h1 still reddens",
      () => good.replace("<h1>ok</h1>", ""), 1],
    // Noise strip: a dead link inside a <script> body or a comment is not a real
    // link and must not red.
    ["dead href inside <script> body is ignored",
      (h) => h.replace("</body>", '<script>var s = \'<a href="/no-such-xyz/">\';</script></body>'), 0],
    ["dead href inside comment is ignored",
      (h) => h.replace("</body>", '<!-- <a href="/no-such-xyz/">x</a> --></body>'), 0],
  ];
  let proven = 0, vacuous = 0, wrong = 0;
  try {
    for (const [name, fn, wantAtLeast] of cases) {
      const n = mutate(fn).length;
      if (wantAtLeast === 0) {
        if (n === 0) { proven++; console.log(`  ✓ ${name}: clean as expected`); }
        else { wrong++; console.error(`  ✗ ${name}: expected clean, got ${n} error(s)`); }
      } else {
        if (n >= wantAtLeast) { proven++; console.log(`  ✓ ${name}: reddened (${n})`); }
        else { vacuous++; console.error(`  ✗ ${name}: expected >=1 error, got ${n} (VACUOUS)`); }
      }
    }
  } finally {
    rmSync(fix, { recursive: true, force: true });
  }
  console.log(`\nselftest: ${proven} proven / ${vacuous} vacuous / ${wrong} wrong.`);
  process.exit(vacuous || wrong ? 1 : 0);
}

const arg = process.argv[2];
if (arg === "--selftest") selftest();
else if (arg && arg !== "") { console.error(`validate-site: unknown arg "${arg}"`); process.exit(2); }
else runAll();
