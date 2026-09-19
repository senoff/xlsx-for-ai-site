#!/usr/bin/env node
/*
 * gen-internal-links.mjs — topic-cluster internal-linking generator (XLS-1616).
 *
 * /tools/ and /importable/ are two-level trees: a CATEGORY HUB
 * (`<root>/<category>/index.html`) with LEAF pages underneath it
 * (`<root>/<category>/<slug>/index.html`). The top-level site hubs
 * (`tools/index.html`, `importable/index.html`) already hand-link every
 * category — that's out of scope here (see spec §1.1). Everything else in
 * these two trees was structurally orphaned: a category hub never linked its
 * own children, and a leaf never linked back to its hub, its siblings, or a
 * breadcrumb — only the site-wide header/footer.
 *
 * This script injects three machine-generated blocks, each wrapped in a
 * paired HTML-comment marker so a re-run finds-or-replaces instead of
 * duplicating, and NEVER touches hand-authored body content:
 *
 *   - breadcrumb (every LEAF)         — Home > Tools|Importable > Category > current
 *   - related-siblings (every LEAF)   — every other leaf under the same category
 *   - children (every category HUB)   — every leaf under that category
 *
 * Sibling/child selection is deliberately unfiltered: ALL other leaves under
 * the same immediate parent, alphabetical by slug. Fully deterministic ->
 * naturally idempotent, and a leaf's related-list and its hub's children-list
 * are the same set rendered from two vantage points (one extraction function,
 * three call sites).
 *
 * Injection anchors (byte-stable across every sampled page, both trees):
 *   top    `<main>\n<div class="wrap">\n`   (breadcrumb goes right after this)
 *   bottom `\n</div>\n</main>`               (children/related go right before this)
 *
 * Idempotency: each block is wrapped in
 *   <!-- XLS-1616:{breadcrumb|children|related}:start -->  ...  <!-- XLS-1616:{same}:end -->
 * A re-run replaces everything between an existing marker pair; only inserts
 * at the anchor when no marker pair exists yet. A file is only written back
 * when its content actually changed (byte comparison), so a clean re-run
 * touches zero files and `git diff` stays empty.
 *
 * Usage: node scripts/gen-internal-links.mjs   (idempotent — safe to re-run)
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "./gen-sitemap.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TREES = [
  { root: "tools", label: "Tools" },
  { root: "importable", label: "Importable" },
];

// ---------------------------------------------------------------------------
// Discovery — restricted to the two trees this card scopes, mirroring
// gen-sitemap.mjs's own directory-walk style rather than re-deriving it.
// ---------------------------------------------------------------------------

function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function hasIndex(dir) {
  return existsSync(join(dir, "index.html"));
}

// A meta-refresh "Moved" stub (same detection rule as gen-sitemap.mjs's
// isExcludedFromSitemap) is not real page content — it has no <h1>, no
// breadcrumb-worthy body, nothing to link to/from. After
// gen-shopify-redirect-stubs.mjs reissues the 124 /tools/ Shopify stubs,
// tools/ contains whole category trees (hub + every leaf) that are 100%
// stubs mirroring their /importable/ counterpart. Those must be skipped
// here entirely, or extractH1() has nothing to extract.
function isRedirectStub(file) {
  try {
    return /<meta\b[^>]*\bhttp-equiv\s*=\s*["']refresh["']/i.test(readFileSync(file, "utf8"));
  } catch {
    return true; // unreadable -> treat as not real content, fail closed
  }
}

// One entry per non-flat category: { treeRoot, treeLabel, category, hubFile,
// hubUrl, leaves: [{ slug, file, url }] (alphabetical by slug) }.
// Flat categories (no subdirectory with its own index.html) are skipped
// entirely — nothing to break out, they stay at their existing inbound=1 by
// construction (spec §1.1 / §4.3's named floor).
function discoverCategories() {
  const cats = [];
  for (const { root, label } of TREES) {
    const rootDir = join(ROOT, root);
    for (const catName of subdirs(rootDir)) {
      const catDir = join(rootDir, catName);
      if (!hasIndex(catDir)) continue; // shouldn't happen, but skip defensively
      const hubFile = join(catDir, "index.html");
      if (isRedirectStub(hubFile)) continue; // reissued Shopify stub tree — not real content
      const leafSlugs = subdirs(catDir)
        .filter((s) => hasIndex(join(catDir, s)))
        .filter((s) => !isRedirectStub(join(catDir, s, "index.html")));
      if (leafSlugs.length === 0) continue; // flat category — out of scope
      const hubUrl = `/${root}/${catName}/`;
      const leaves = leafSlugs
        .sort()
        .map((slug) => ({
          slug,
          file: join(catDir, slug, "index.html"),
          url: `/${root}/${catName}/${slug}/`,
        }));
      cats.push({
        treeRoot: root,
        treeLabel: label,
        treeUrl: `/${root}/`,
        category: catName,
        hubFile: join(catDir, "index.html"),
        hubUrl,
        leaves,
      });
    }
  }
  return cats;
}

// ---------------------------------------------------------------------------
// h1 extraction — one function, reused for breadcrumb crumb text, the
// current-leaf crumb, hub children link text, and sibling link text, so the
// label a reader sees is always in sync with hand-edited page copy and never
// duplicated as a second name string anywhere in this script.
// ---------------------------------------------------------------------------

function extractH1(file) {
  const html = readFileSync(file, "utf8");
  const m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) throw new Error(`no <h1> found in ${file} — cannot derive link text`);
  return m[1].replace(/<[^>]+>/g, "").trim();
}

// The extracted h1 text is already legal HTML (it came straight out of an
// <h1>...</h1>), so it is safe to reuse verbatim inside newly generated
// markup. JSON-LD, by contrast, wants the PLAIN string (a JSON string escapes
// its own quotes; leaving HTML entities in would double-encode), so decode
// the handful of entities these titles actually use before JSON.stringify.
const ENTITY_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#x27": "'", "#39": "'",
  nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY_MAP[ent] ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

const MARK = (type, phase) => `<!-- XLS-1616:${type}:${phase} -->`;

function renderBreadcrumb(cat, leafUrl, leafH1) {
  const catH1 = extractH1(cat.hubFile);
  const items = [
    { name: "Home", url: `${ORIGIN}/` },
    { name: cat.treeLabel, url: `${ORIGIN}${cat.treeUrl}` },
    { name: decodeEntities(catH1), url: `${ORIGIN}${cat.hubUrl}` },
    { name: decodeEntities(leafH1), url: `${ORIGIN}${leafUrl}` },
  ];
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
  return [
    MARK("breadcrumb", "start"),
    `<nav class="xfa-breadcrumb" aria-label="Breadcrumb">`,
    `  <a href="/">Home</a>`,
    `  <span aria-hidden="true">/</span>`,
    `  <a href="${cat.treeUrl}">${cat.treeLabel}</a>`,
    `  <span aria-hidden="true">/</span>`,
    `  <a href="${cat.hubUrl}">${catH1}</a>`,
    `  <span aria-hidden="true">/</span>`,
    `  <span aria-current="page">${leafH1}</span>`,
    `</nav>`,
    `<script type="application/ld+json">`,
    JSON.stringify(ld),
    `</script>`,
    MARK("breadcrumb", "end"),
  ].join("\n");
}

function renderChildren(cat) {
  const catH1 = extractH1(cat.hubFile);
  const items = cat.leaves
    .map((leaf) => `  <li><a href="${leaf.url}">${extractH1(leaf.file)}</a></li>`)
    .join("\n");
  return [
    MARK("children", "start"),
    `<h2>All ${catH1} guides</h2>`,
    `<ul class="xfa-children">`,
    items,
    `</ul>`,
    MARK("children", "end"),
  ].join("\n");
}

function renderRelated(cat, leaf) {
  const catH1 = extractH1(cat.hubFile);
  const siblings = cat.leaves.filter((l) => l.slug !== leaf.slug);
  const items = siblings
    .map((sib) => `  <li><a href="${sib.url}">${extractH1(sib.file)}</a></li>`)
    .join("\n");
  return [
    MARK("related", "start"),
    `<h2>More ${catH1} guides</h2>`,
    `<ul class="xfa-related">`,
    items,
    `</ul>`,
    `<p><a href="${cat.hubUrl}">&larr; All ${catH1} guides</a></p>`,
    MARK("related", "end"),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Idempotent marker injection
// ---------------------------------------------------------------------------

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TOP_ANCHOR = '<main>\n<div class="wrap">\n';
const BOTTOM_ANCHOR = "\n</div>\n</main>";

function upsertTop(html, type, block, file) {
  const start = MARK(type, "start");
  const end = MARK(type, "end");
  const re = new RegExp(`${escapeForRegex(start)}[\\s\\S]*?${escapeForRegex(end)}`);
  if (re.test(html)) return html.replace(re, block);
  if (!html.includes(TOP_ANCHOR)) {
    throw new Error(`${file}: top injection anchor not found — cannot insert ${type} block`);
  }
  return html.replace(TOP_ANCHOR, TOP_ANCHOR + block + "\n");
}

function upsertBottom(html, type, block, file) {
  const start = MARK(type, "start");
  const end = MARK(type, "end");
  const re = new RegExp(`${escapeForRegex(start)}[\\s\\S]*?${escapeForRegex(end)}`);
  if (re.test(html)) return html.replace(re, block);
  if (!html.includes(BOTTOM_ANCHOR)) {
    throw new Error(`${file}: bottom injection anchor not found — cannot insert ${type} block`);
  }
  return html.replace(BOTTOM_ANCHOR, "\n" + block + "\n" + BOTTOM_ANCHOR);
}

function writeIfChanged(file, html) {
  const before = readFileSync(file, "utf8");
  if (before === html) return false;
  writeFileSync(file, html);
  return true;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function run() {
  const cats = discoverCategories();
  let hubsTouched = 0, leavesTouched = 0, hubsUnchanged = 0, leavesUnchanged = 0;

  for (const cat of cats) {
    // HUB — children block only.
    {
      const html = readFileSync(cat.hubFile, "utf8");
      const block = renderChildren(cat);
      const updated = upsertBottom(html, "children", block, cat.hubFile);
      if (writeIfChanged(cat.hubFile, updated)) hubsTouched++; else hubsUnchanged++;
    }
    // LEAF — breadcrumb (top) + related (bottom).
    for (const leaf of cat.leaves) {
      let html = readFileSync(leaf.file, "utf8");
      const leafH1 = extractH1(leaf.file);
      const bcBlock = renderBreadcrumb(cat, leaf.url, leafH1);
      html = upsertTop(html, "breadcrumb", bcBlock, leaf.file);
      const relBlock = renderRelated(cat, leaf);
      html = upsertBottom(html, "related", relBlock, leaf.file);
      if (writeIfChanged(leaf.file, html)) leavesTouched++; else leavesUnchanged++;
    }
  }

  const totalLeaves = cats.reduce((n, c) => n + c.leaves.length, 0);
  console.log(
    `gen-internal-links: ${cats.length} categories, ${totalLeaves} leaves — ` +
    `hubs written=${hubsTouched} unchanged=${hubsUnchanged}; ` +
    `leaves written=${leavesTouched} unchanged=${leavesUnchanged}`
  );
}

run();
