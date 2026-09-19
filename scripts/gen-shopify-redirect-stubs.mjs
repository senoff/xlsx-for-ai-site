#!/usr/bin/env node
/*
 * gen-shopify-redirect-stubs.mjs — reissue the /tools/ Shopify redirect stubs
 * (XLS-1616 §2). On 2026-08-06 (e0de183, PR #13) 124 tools/-tree index.html
 * meta-refresh stubs were deleted after 7 Shopify tool trees moved wholesale
 * to /importable/. That deletion means any inbound link, bookmark, or
 * search-engine index entry still pointing at the old /tools/... path
 * 404s today instead of forwarding to the new /importable/... home.
 *
 * The 124 followed exactly one path rule with zero exceptions:
 *   /tools/<X>/  ->  /importable/<X>/     (first-segment swap, tail identical)
 * across exactly these 7 category trees (STUB_CATEGORIES below — verified by
 * diffing e0de183^ against e0de183 for the deleted tools/-tree index.html files).
 *
 * This generator is a FULL-FILE REGENERATE, not an injection: a stub owns
 * 100% of its file (nothing hand-authored ever lives in one), so always
 * overwriting the same template from the same inputs is trivially idempotent
 * (byte-identical output every run) and self-healing — if a leaf is later
 * added to or removed from one of the 7 importable trees, the next run
 * adds/removes its /tools/ stub to match, with no hand-maintained path list
 * to fall out of date.
 *
 * Usage: node scripts/gen-shopify-redirect-stubs.mjs   (idempotent — safe to re-run)
 * After running, re-run scripts/gen-sitemap.mjs — isExcludedFromSitemap()
 * already detects http-equiv="refresh" and keeps these stubs OUT of
 * sitemap.xml automatically, so this never changes the sitemap URL set.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN } from "./gen-sitemap.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STUB_CATEGORIES = [
  "export-shopify-collections",
  "export-shopify-products",
  "fix-shopify-products",
  "import-shopify-collections",
  "import-shopify-products",
  "import-shopify-inventory",
  "import-shopify-redirects",
];

function subdirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// Every importable/<category>/[<slug>/]index.html under the 7 stub
// categories, as the /importable/... URL tail each stub must redirect to.
// Same directory-walk shape as gen-sitemap.mjs's findIndexHtml, restricted to
// these 7 trees.
export function discoverStubTargets() {
  const targets = [];
  for (const category of STUB_CATEGORIES) {
    const catDir = join(ROOT, "importable", category);
    if (!existsSync(join(catDir, "index.html"))) continue;
    targets.push({ urlPath: `${category}/`, });
    for (const slug of subdirs(catDir)) {
      if (existsSync(join(catDir, slug, "index.html"))) {
        targets.push({ urlPath: `${category}/${slug}/` });
      }
    }
  }
  return targets;
}

function renderStub(urlPath) {
  const target = `${ORIGIN}/importable/${urlPath}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moved | xlsx-for-ai</title>
<meta http-equiv="refresh" content="0; url=${target}">
<link rel="canonical" href="${target}">
<meta name="robots" content="noindex">
</head>
<body>
<p>This page has moved to <a href="${target}">${target}</a>. Redirecting&hellip;</p>
</body>
</html>
`;
}

function writeIfChanged(file, content) {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return true;
}

function run() {
  const targets = discoverStubTargets();
  let written = 0, unchanged = 0;
  for (const { urlPath } of targets) {
    const file = join(ROOT, "tools", urlPath, "index.html");
    if (writeIfChanged(file, renderStub(urlPath))) written++; else unchanged++;
  }
  console.log(
    `gen-shopify-redirect-stubs: ${targets.length} stub(s) across ${STUB_CATEGORIES.length} categories — written=${written} unchanged=${unchanged}`
  );
}

// Only run as a side-effecting CLI when invoked directly (not when imported,
// e.g. by a future dod-shopify-stubs sweep that reuses discoverStubTargets).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
