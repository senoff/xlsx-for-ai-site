#!/usr/bin/env node
/*
 * dod-sitemap-no-stale-urls.mjs — the REVERSE half of sitemap hygiene
 * (XLS-1616 §3.1). The existing build-validate.yml "Sitemap covers every
 * page" step already proves disk ⊆ sitemap (every page on disk has a <loc>).
 * It has never proven the other direction: sitemap ⊆ disk. If a <loc> was
 * ever added to sitemap.xml by hand, or survived a page delete because
 * someone forgot to regenerate before that gate existed, it is a stale row —
 * a URL sitemap.xml tells Google is canonical whose only live behavior is a
 * redirect or a 404. That is exactly the "Source=Website, flagged as
 * redirect" shape the card names.
 *
 * Reuses discoverPageUrls() (gen-sitemap.mjs) as the disk-truth set — no
 * second discovery implementation to drift from the one gen-sitemap.mjs
 * itself uses to WRITE sitemap.xml.
 *
 * Usage:  node scripts/dod-sitemap-no-stale-urls.mjs            # check the committed sitemap.xml
 *         node scripts/dod-sitemap-no-stale-urls.mjs --selftest # prove it can redden
 * Exit: 0 = no stale rows · 1 = stale row(s) found (named) · 2 = did not run.
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPageUrls, ROOT } from "./gen-sitemap.mjs";

const SITEMAP_PATH = join(ROOT, "sitemap.xml");

export function parseLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

// Pure comparison: any sitemap <loc> absent from the disk-discovered URL set
// is stale. Returns {ok, stale[]}.
export function findStale(sitemapUrls, diskUrls) {
  const have = new Set(diskUrls);
  const stale = sitemapUrls.filter((u) => !have.has(u));
  return { ok: stale.length === 0, stale };
}

function runLive() {
  let xml;
  try {
    xml = readFileSync(SITEMAP_PATH, "utf8");
  } catch (e) {
    console.error(`DID NOT RUN — could not read ${SITEMAP_PATH} (${e.message})`);
    process.exit(2);
  }
  const sitemapUrls = parseLocs(xml);
  if (sitemapUrls.length === 0) {
    console.error(`DID NOT RUN — ${SITEMAP_PATH} parsed to 0 <loc> URLs`);
    process.exit(2);
  }
  const diskUrls = discoverPageUrls();
  const { ok, stale } = findStale(sitemapUrls, diskUrls);
  for (const u of stale) console.error(`STALE-IN-SITEMAP ${u} — no matching page on disk (never hand-edit sitemap.xml; regenerate from disk instead)`);
  console.log(`SITEMAP-NO-STALE-URLS verdict=${ok ? "PASS" : "FAIL"} sitemap=${sitemapUrls.length} disk=${diskUrls.length} stale=${stale.length}`);
  process.exit(ok ? 0 : 1);
}

function selftest() {
  let proven = 0, wrong = 0;
  const disk = ["https://x/", "https://x/tools/"];
  const cleanSitemap = ["https://x/", "https://x/tools/"];
  const staleSitemap = ["https://x/", "https://x/tools/", "https://x/tools/deleted-page/"];
  const good = findStale(cleanSitemap, disk);
  const bad = findStale(staleSitemap, disk);
  if (good.ok && good.stale.length === 0) { proven++; console.log("  ✓ clean sitemap: no stale rows"); }
  else { wrong++; console.log(`  ✗ clean sitemap unexpectedly flagged: ${JSON.stringify(good.stale)}`); }
  if (!bad.ok && bad.stale.includes("https://x/tools/deleted-page/")) { proven++; console.log(`  ✓ stale row reddens: ${JSON.stringify(bad.stale)}`); }
  else { wrong++; console.log(`  ✗ stale row did NOT redden (VACUOUS): ${JSON.stringify(bad.stale)}`); }
  console.log(`\nselftest: ${proven} proven / ${wrong} wrong.`);
  process.exit(wrong === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else runLive();
