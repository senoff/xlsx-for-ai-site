#!/usr/bin/env node
/*
 * dod-xls835-importable-page.mjs — the executable DoD check for XLS-835 (refresh
 * /importable to match the shipped app's capabilities). The register-before-land
 * row points at it (senoff/work-state:state/xlsx-card-checks.json).
 *
 * The card's check, in three clauses, plus an accuracy guard:
 *   "page capability list matches live app entity set AND contains approve-gate +
 *    receipt language AND no submission-status claim contradicting Partners state."
 *
 * FIVE arms, worst-of aggregation. The four content arms read the page OFF DISK
 * (`importable/index.html` shipped in THIS repo) so they never depend on a deploy
 * to redden — the deployed bytes ARE these bytes once this lands. The LIVE arm only
 * asserts the page still 200s; it does NOT content-match, because before this lands
 * the live host still serves the OLD page (a content assert there would false-FAIL).
 *
 *   1. ENTITY-SET (hermetic, POSITIVE). The page must name every entity in the live
 *      app entity set AND carry both direction headings (import / export). The set is
 *      derived from the deployed app (importable-shopify @ 7d8e5e1b), NOT from memory:
 *        - IMPORT doors = the verdict-GREEN entities in entity-gate-verdicts.json
 *          resolved through entity-picker.ts (products/collections front doors +
 *          inventory + the GREEN home-hub tiles redirects/pages/articles/shop;
 *          companies is NOT green → correctly absent).
 *        - EXPORT doors = the entities the export UI (routes/app.export.tsx) actually
 *          renders a non-PCD download form for: collections, products, inventory,
 *          redirects, files, pages, articles, translations, activity, menus,
 *          metaobject-definitions, metaobject-entries.
 *      Naming an entity that IS in the set is required; a half-list reddens.
 *
 *   2. SAFETY (hermetic). The page must carry all four safety pillars in visible
 *      language: approve-before-write, create/update-never-delete, a reconciled
 *      receipt, and read-only export. This is the app's differentiator; omitting a
 *      pillar is the exact staleness the card was opened to fix.
 *
 *   3. STATUS (hermetic, NEGATIVE). The page must make NO submission-status claim
 *      that contradicts the Partners state (app is DRAFT / pre-submit). "in review",
 *      "review queue", "submitted", "now live on the app store" and kin are FORBIDDEN.
 *      Launch-intent framing ("coming to the Shopify App Store") is allowed.
 *
 *   4. ACCURACY (hermetic, NEGATIVE). The page must NOT advertise an entity that is
 *      NOT merchant-exposed in submission #1 — the PCD doors de-shipped for sub-#1
 *      (customers/orders/draft-orders/companies) and the entities with an engine but
 *      no demo UI door (discounts/payouts). Over-claiming a capability the reviewer
 *      cannot see in the demo is as wrong as under-claiming one they can.
 *
 *   5. LIVE (network). GET the deployed /importable/ and assert HTTP 200, no redirect
 *      followed. Unreachable host = DID_NOT_RUN (exit 6), never a false FAIL.
 *
 * Usage:
 *   node scripts/dod-xls835-importable-page.mjs               # all arms
 *   PAGE=/path/to/index.html node scripts/dod-...mjs          # override disk page
 *   BASE_URL=https://xlsx-for-ai.dev node scripts/dod-...mjs  # override live host
 *   node scripts/dod-xls835-importable-page.mjs --selftest    # prove arms redden
 *
 * Exit: 0 = PASS · 1 = FAIL (a real defect, named) · 6 = DID_NOT_RUN / INDETERMINATE
 *       (an arm could not see its subject — the ONLY rc xlsx_board_verify reads as
 *       INDETERMINATE; every other nonzero is graded FAIL).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const PAGE = process.env.PAGE || join(REPO_ROOT, 'importable', 'index.html');
const BASE_URL = (process.env.BASE_URL || 'https://xlsx-for-ai.dev').replace(/\/+$/, '');
const LIVE_URL = `${BASE_URL}/importable/`;

const PASS = 0, FAIL = 1, DID_NOT_RUN = 6;

// ── the live app entity set (derived from importable-shopify @ 7d8e5e1b) ──────
// Each token is a visible phrase the page must contain (matched case-insensitively).
const IMPORT_ENTITIES = [
  'products', 'collections', 'inventory',
  'url redirects', 'pages', 'blog posts', 'shop settings',
];
// Export-distinct tokens: entities the export UI exposes that the import list does
// NOT already prove (files/translations/menus/metaobjects/activity). Asserting these
// on top of the shared ones proves the export surface is described, not just import.
const EXPORT_ONLY_ENTITIES = ['files', 'translations', 'menus', 'metaobject', 'activity'];
const DIRECTION_HEADINGS = ['import into your store', 'export out to a spreadsheet'];

// ── the four safety pillars (each is a set of alternatives; ANY one satisfies) ─
const SAFETY_PILLARS = [
  { name: 'approve-before-write', any: ['until you approve', 'before it’s written', "before it's written", 'approve before anything', 'nothing has happened yet', 'nothing touches your store until you approve'] },
  { name: 'itemized-preview', any: ['itemized preview', 'exactly what changes for each'] },
  { name: 'never-delete', any: ['never deletes', 'never delete anything', 'creates and updates, never deletes'] },
  { name: 'reconciled-receipt', any: ['reconciled receipt', 'accounts for every row', 'a receipt that accounts'] },
  { name: 'read-only-export', any: ['export is read-only', 'only reads your store', 'changes nothing'] },
];

// ── forbidden submission-status claims (arm 3) ────────────────────────────────
const FORBIDDEN_STATUS = [
  'review queue', 'in review', 'under review', 'in the app store review',
  'submitted to the app store', 'now live on the app store', 'live in the app store',
  'available in the app store now', 'available on the app store now',
];

// ── entities that must NOT be advertised in submission #1 (arm 4) ─────────────
// Word-boundary matched to avoid false hits (e.g. "order" inside other words).
const FORBIDDEN_ENTITIES = ['customers', 'orders', 'draft orders', 'draft-orders', 'discounts', 'payouts', 'companies'];

function readPage() {
  if (!existsSync(PAGE)) return null;
  return readFileSync(PAGE, 'utf8');
}

// arm 1
function armEntitySet(html) {
  if (html === null) return { arm: 'ENTITY-SET', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const lc = html.toLowerCase();
  const missImport = IMPORT_ENTITIES.filter((t) => !lc.includes(t));
  const missExport = EXPORT_ONLY_ENTITIES.filter((t) => !lc.includes(t));
  const missHead = DIRECTION_HEADINGS.filter((t) => !lc.includes(t));
  const miss = [
    ...missImport.map((t) => `import:${t}`),
    ...missExport.map((t) => `export:${t}`),
    ...missHead.map((t) => `heading:${t}`),
  ];
  return miss.length === 0
    ? { arm: 'ENTITY-SET', code: PASS, msg: `all ${IMPORT_ENTITIES.length} import + ${EXPORT_ONLY_ENTITIES.length} export-distinct entities + both direction headings present` }
    : { arm: 'ENTITY-SET', code: FAIL, msg: `page omits live-app entities/headings: ${miss.join(', ')}` };
}

// arm 2
function armSafety(html) {
  if (html === null) return { arm: 'SAFETY', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const lc = html.toLowerCase();
  const missing = SAFETY_PILLARS.filter((p) => !p.any.some((s) => lc.includes(s.toLowerCase()))).map((p) => p.name);
  return missing.length === 0
    ? { arm: 'SAFETY', code: PASS, msg: `all ${SAFETY_PILLARS.length} safety pillars present` }
    : { arm: 'SAFETY', code: FAIL, msg: `safety pillar(s) missing: ${missing.join(', ')}` };
}

// arm 3
function armStatus(html) {
  if (html === null) return { arm: 'STATUS', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const lc = html.toLowerCase();
  const hits = FORBIDDEN_STATUS.filter((s) => lc.includes(s));
  return hits.length === 0
    ? { arm: 'STATUS', code: PASS, msg: 'no submission-status claim contradicting Partners DRAFT state' }
    : { arm: 'STATUS', code: FAIL, msg: `forbidden status claim(s) on page: ${hits.join(', ')}` };
}

// arm 4
function armAccuracy(html) {
  if (html === null) return { arm: 'ACCURACY', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const lc = html.toLowerCase();
  const hits = FORBIDDEN_ENTITIES.filter((t) => new RegExp(`\\b${t.replace(/[-]/g, '[- ]')}\\b`).test(lc));
  return hits.length === 0
    ? { arm: 'ACCURACY', code: PASS, msg: 'no non-exposed / PCD entity advertised as a sub-#1 capability' }
    : { arm: 'ACCURACY', code: FAIL, msg: `page advertises entities not exposed in submission #1: ${hits.join(', ')}` };
}

// arm 5
async function armLive() {
  let res;
  try {
    res = await fetch(LIVE_URL, { redirect: 'manual', headers: { 'user-agent': 'xls835-dod' } });
  } catch (e) {
    return { arm: 'LIVE', code: DID_NOT_RUN, msg: `host unreachable (${e.code || e.message}) — not measured` };
  }
  return res.status === 200
    ? { arm: 'LIVE', code: PASS, msg: `${LIVE_URL} → 200` }
    : { arm: 'LIVE', code: FAIL, msg: `${LIVE_URL} → ${res.status} (expected 200, no redirect)` };
}

async function main() {
  const html = readPage();
  const results = [armEntitySet(html), armSafety(html), armStatus(html), armAccuracy(html), await armLive()];
  let worst = PASS;
  for (const r of results) {
    const tag = r.code === PASS ? 'PASS' : r.code === FAIL ? 'FAIL' : 'DID_NOT_RUN';
    console.log(`  [${tag}] ${r.arm}: ${r.msg}`);
    if (r.code === FAIL) worst = FAIL;
    else if (r.code === DID_NOT_RUN && worst !== FAIL) worst = DID_NOT_RUN;
  }
  const verdict = worst === PASS ? 'PASS' : worst === FAIL ? 'FAIL' : 'DID_NOT_RUN';
  console.log(`XLS-835 DoD: ${verdict}`);
  process.exitCode = worst;
}

// ── selftest: prove each content arm reddens on a doctored subject ────────────
function selftest() {
  let ok = true;
  const good = readPage();
  if (good === null) { console.log(`  selftest DID_NOT_RUN: real page not found at ${PAGE}`); process.exitCode = DID_NOT_RUN; return; }

  // the shipped page must be green on all four hermetic arms
  for (const r of [armEntitySet(good), armSafety(good), armStatus(good), armAccuracy(good)]) {
    if (r.code !== PASS) { console.log(`  selftest FAIL: shipped page not green on ${r.arm}: ${r.msg}`); ok = false; }
  }
  // doctoring must redden each arm
  if (armEntitySet(good.replace(/translations/ig, 'xxx')).code !== FAIL) { console.log('  selftest FAIL: entity-set did not redden on a dropped export'); ok = false; }
  if (armSafety(good.replace(/never delete[s]?[^.]*/ig, 'xxx')).code !== FAIL) { console.log('  selftest FAIL: safety did not redden on a dropped pillar'); ok = false; }
  if (armStatus(good + ' It is in the Shopify App Store review queue now.').code !== FAIL) { console.log('  selftest FAIL: status did not redden on a review-queue claim'); ok = false; }
  if (armAccuracy(good + ' <li>Customers — export your customers</li>').code !== FAIL) { console.log('  selftest FAIL: accuracy did not redden on a PCD claim'); ok = false; }

  console.log(ok ? '  selftest PASS: shipped page green; each content arm reddens on a doctored page.' : '  selftest FAILED');
  process.exitCode = ok ? PASS : FAIL;
}

if (process.argv.includes('--selftest')) selftest();
else await main();
