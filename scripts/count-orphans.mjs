#!/usr/bin/env node
/*
 * count-orphans.mjs — measure structural-orphan count for /tools/ + /importable/
 * (XLS-1616 TEST_PLAN §4.1). Reuses gen-sitemap.mjs's discoverPages() for the
 * page set — no second directory walk.
 *
 * Method (locked by the spec, because a naive count is meaningless — every
 * page already carries the IDENTICAL header/footer, so counting those would
 * mean no page could ever show inbound <= 1):
 *   1. Discover pages via discoverPages().
 *   2. Per page, extract only the substring between the first `<main>` and the
 *      last `</main>` — header/footer are structurally out of scope, only
 *      <main> content carries page-specific topical signal.
 *   3. Within that substring, collect every href targeting a local page,
 *      resolved to the canonical trailing-slash URL form gen-sitemap.mjs uses,
 *      restricted to /tools/ and /importable/ targets.
 *   4. inbound(T) = count of DISTINCT source pages (not raw anchor count)
 *      linking to T from within <main>, excluding self-links.
 *   5. Orphan = any /tools/ or /importable/ page with inbound <= 1.
 *
 * Usage: node scripts/count-orphans.mjs           (prints the count + list)
 *        node scripts/count-orphans.mjs --quiet   (verdict line only)
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPages, ORIGIN, ROOT } from "./gen-sitemap.mjs";

const SCOPE_RE = /^\/(tools|importable)\//;

function mainContent(html) {
  const start = html.indexOf("<main>");
  const end = html.lastIndexOf("</main>");
  if (start === -1 || end === -1 || end < start) return "";
  return html.slice(start + "<main>".length, end);
}

function hrefTargets(mainHtml) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(mainHtml)) !== null) out.push(m[1]);
  return out;
}

// Resolve an href found inside a page's <main> to the canonical trailing-slash
// URL PATH form (matches gen-sitemap.mjs's urlFor output, path-only).
function resolveToPath(href, pageUrlPath) {
  let u = href.split("#")[0].split("?")[0];
  if (!u) return null;
  if (/^(?:https?:)?\/\//i.test(u) || /^(?:mailto:|tel:|data:|javascript:)/i.test(u)) {
    // Absolute external, or absolute-to-our-own-origin — only count if it's
    // literally our own origin (defensive; the site never links itself this way).
    if (!u.startsWith(ORIGIN)) return null;
    u = u.slice(ORIGIN.length) || "/";
  }
  if (!u.startsWith("/")) {
    // Relative link — resolve against the page's own directory.
    const baseDir = pageUrlPath.replace(/[^/]*$/, ""); // strip trailing filename, keep trailing /
    u = new URL(u, "https://x" + baseDir).pathname;
  }
  if (!u.endsWith("/")) {
    // "/tools/foo/index.html"-style or extensionless — normalize to a directory
    // form the same way urlFor() does; a bare file reference without a slash
    // is not a canonical page URL in this tree, so drop the filename.
    u = u.replace(/\/index\.html$/, "/");
    if (!u.endsWith("/")) u += "/";
  }
  return u;
}

function run() {
  const pages = discoverPages();
  const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]));
  const inbound = new Map(); // targetPath -> Set(sourcePath)

  for (const p of pages) {
    const path = new URL(p.url).pathname;
    const file = join(ROOT, path.slice(1), "index.html");
    let html;
    try { html = readFileSync(file, "utf8"); } catch { continue; }
    const main = mainContent(html);
    const hrefs = hrefTargets(main);
    const seenTargets = new Set();
    for (const href of hrefs) {
      const targetPath = resolveToPath(href, path);
      if (!targetPath) continue;
      if (!SCOPE_RE.test(targetPath)) continue;   // restricted to /tools/ + /importable/
      if (targetPath === path) continue;           // exclude self-links
      if (!byPath.has(targetPath)) continue;        // must be a real discovered page
      if (seenTargets.has(targetPath)) continue;    // distinct SOURCE pages, not raw anchors
      seenTargets.add(targetPath);
      if (!inbound.has(targetPath)) inbound.set(targetPath, new Set());
      inbound.get(targetPath).add(path);
    }
  }

  const scopedPages = pages.filter((p) => SCOPE_RE.test(new URL(p.url).pathname));
  const orphans = [];
  for (const p of scopedPages) {
    const path = new URL(p.url).pathname;
    const count = inbound.has(path) ? inbound.get(path).size : 0;
    if (count <= 1) orphans.push({ path, inbound: count });
  }
  orphans.sort((a, b) => a.path.localeCompare(b.path));

  const quiet = process.argv.includes("--quiet");
  if (!quiet) {
    for (const o of orphans) console.log(`  orphan inbound=${o.inbound}  ${o.path}`);
  }
  console.log(
    `count-orphans: scoped(/tools/+/importable/)=${scopedPages.length} orphans(inbound<=1)=${orphans.length}`
  );
}

run();
