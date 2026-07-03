#!/usr/bin/env node
/*
 * gen-sitemap.mjs — regenerate /sitemap.xml from the pages that actually exist
 * on disk (XLS-219). Currency is STRUCTURAL: every public page is an
 * `index.html`, so scanning for them auto-discovers new /tools/ pages the moment
 * they ship — no hand-maintained URL list to fall out of date.
 *
 * URL rule: derive the URL from the directory path with a trailing slash
 * (`foo/index.html` -> `/foo/`). We deliberately do NOT read each page's
 * <link rel=canonical>: some canonicals omit the trailing slash and that form
 * 301-redirects on GitHub Pages, which would put redirected URLs in the sitemap.
 * The trailing-slash path form is the one that returns 200.
 *
 * <lastmod> = the file's last git commit date (YYYY-MM-DD), falling back to
 * today for a not-yet-committed page.
 *
 * Usage: node scripts/gen-sitemap.mjs   (run from the repo root; writes ./sitemap.xml)
 * Ship DoD: any change that adds, removes, or renames a page re-runs this.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://xlsx-for-ai.dev";
const SKIP_DIRS = new Set(["node_modules", ".git", "scripts", "logo"]);

function findIndexHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findIndexHtml(full));
    else if (name === "index.html") out.push(full);
  }
  return out;
}

// filesystem path -> canonical trailing-slash URL
function urlFor(file) {
  let rel = file.slice(ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
  rel = rel.replace(/index\.html$/, ""); // "tools/compare/index.html" -> "tools/compare/"
  return ORIGIN + "/" + rel; // rel already ends in "/" (or is "" for the homepage)
}

function lastmod(file) {
  try {
    const d = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], {
      cwd: ROOT, encoding: "utf8",
    }).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  } catch { /* uncommitted / no history */ }
  return new Date().toISOString().slice(0, 10);
}

const pages = findIndexHtml(ROOT)
  .map((f) => ({ url: urlFor(f), lastmod: lastmod(f) }))
  // homepage first, then alphabetical — deterministic output
  .sort((a, b) => (a.url === ORIGIN + "/" ? -1 : b.url === ORIGIN + "/" ? 1 : a.url.localeCompare(b.url)));

const body = pages
  .map((p) => `  <url>\n    <loc>${p.url}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n  </url>`)
  .join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

writeFileSync(join(ROOT, "sitemap.xml"), xml);
console.log(`sitemap.xml written — ${pages.length} pages`);
for (const p of pages) console.log(`  ${p.url}  (${p.lastmod})`);
