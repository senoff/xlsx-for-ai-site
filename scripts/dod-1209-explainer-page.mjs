#!/usr/bin/env node
/*
 * dod-1209-explainer-page.mjs — the executable DoD check for XLS-1209, the
 * metafield-display explainer page. The register-before-land row points at it
 * (senoff/work-state:state/xlsx-card-checks.json).
 *
 * XLS-1209 is the only card in the XLS-257 set with NO backend component, NO
 * demo file and NO tool on the page. Its DoD is therefore EDITORIAL — and the
 * card's hard constraint is a negative one, set by the product owner: the page
 * must never claim that any product of ours performs the fix. It explains and
 * guides; the fix happens in the merchant's theme.
 *
 * A constraint stated only in a card is a constraint that rots on the next edit.
 * This script makes it a gate: the over-claim ban is a machine-checkable arm
 * that reddens if anyone ever writes the sentence.
 *
 * FIVE arms, worst-of aggregation. The four content arms read the page OFF DISK
 * (shipped in THIS repo) so they never depend on a deploy to redden. The LIVE
 * arm only asserts the page 200s; it cannot content-match pre-land.
 *
 *   1. CAUSES (hermetic, POSITIVE). The page must genuinely cover all four known
 *      causes, each proven by tokens specific to THAT cause (not by a shared word
 *      like "metafield" that any half-written page would carry):
 *        1 vintage / non-Online-Store-2.0 theme — no dynamic-source connector
 *        2 block type vs metafield type mismatch
 *        3 OS 2.0, bound, no error, blank — because the value is EMPTY
 *        4 URL-type metafields the dynamic-source picker cannot reach
 *      A page that drops one of the four is a half-diagnosis and reddens here.
 *
 *   2. NO-OVERCLAIM (hermetic, NEGATIVE) — THE CARD'S HARD CONSTRAINT. Zero
 *      affirmative claims that we/our tools perform the theme fix. The list is
 *      deliberately AFFIRMATIVE-FORM only ("we fix this", "our tool displays"),
 *      because the page's honesty section necessarily talks ABOUT such claims in
 *      order to deny them, and a matcher that reddened on "no import tool, ours
 *      included, can make a metafield appear" would punish exactly the sentence
 *      the constraint exists to require. Arm 3 is what stops that denial from
 *      being quietly deleted.
 *
 *   3. DISCLAIMER (hermetic, POSITIVE). The absence of an over-claim is not the
 *      same as the presence of the honest statement — a page could satisfy arm 2
 *      by saying nothing at all about the boundary, which is the softer version
 *      of the mistake the card names. The page must explicitly state that no
 *      import tool of ours can make a metafield appear, and that display is the
 *      theme's job.
 *
 *   4. NO-TOOL (hermetic, NEGATIVE). A pure explainer must not grow a tool
 *      surface: no file input, no upload dropzone, no tool panel mount, no demo
 *      workbook download, no page.js. This is the structural half of arm 2 — the
 *      over-claim a page makes by SHAPE rather than by sentence, since an upload
 *      box on this page would imply the upload is the fix no matter what the copy
 *      says.
 *
 *   5. LIVE (network). GET the deployed page and assert HTTP 200. Unreachable or
 *      not-yet-deployed = DID_NOT_RUN (exit 6), never a false FAIL.
 *
 * Usage:
 *   node scripts/dod-1209-explainer-page.mjs               # all arms
 *   PAGE=/path/to/index.html node scripts/dod-1209-...mjs  # override disk page
 *   BASE_URL=https://xlsx-for-ai.dev node scripts/...mjs   # override live host
 *   node scripts/dod-1209-explainer-page.mjs --selftest    # prove arms redden
 *
 * Exit: 0 = PASS · 1 = FAIL (a real defect, named) · 6 = DID_NOT_RUN /
 *       INDETERMINATE (an arm could not see its subject — the ONLY rc
 *       xlsx_board_verify reads as INDETERMINATE; every other nonzero = FAIL).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SLUG = 'shopify-metafield-not-showing-on-product-page';
const PAGE = process.env.PAGE || join(REPO_ROOT, 'importable', SLUG, 'index.html');
const BASE_URL = (process.env.BASE_URL || 'https://xlsx-for-ai.dev').replace(/\/+$/, '');
const LIVE_URL = `${BASE_URL}/importable/${SLUG}/`;

const PASS = 0, FAIL = 1, DID_NOT_RUN = 6;

// ── arm 1: the four causes, each pinned by tokens unique to that cause ────────
// `all` = every token must be present (so a cause is proven covered, not merely
// name-dropped). Matched case-insensitively against the page text.
const CAUSES = [
  {
    name: '1-vintage-theme',
    all: ['vintage', 'online store 2.0', 'dynamic source'],
  },
  {
    name: '2-block-type-mismatch',
    all: ['add block', 'text block', 'image block', "don't match"],
  },
  {
    name: '3-empty-value',
    all: ['renders nothing', 'no value on that particular product', 'metafields'],
  },
  {
    name: '4-url-type',
    all: ['url metafield', 'rich text', 'platform limitation'],
  },
];

// ── arm 2: forbidden AFFIRMATIVE over-claims (the card's hard constraint) ─────
// Every entry is a claim that we/our product performs the theme-side fix. None
// may appear on the page in any form. See the header note on why this list is
// affirmative-only.
const FORBIDDEN_OVERCLAIM = [
  'we fix this', 'we fix that', "we'll fix", 'we can fix', 'we will fix',
  'our tool fixes', 'our tools fix', 'our importer fixes', 'this tool fixes',
  'our import fixes', 'importing fixes', 'the import fixes',
  'our tool displays', 'our tool will display', 'we display it',
  'we make it show', 'makes it show up', 'we can make it show',
  'fixes this for you', 'fix this for you', 'fixes it for you',
  'upload here to', 'upload your file here to', 'upload your sheet to show',
  'upload to fix', 'use our tool to display', 'we put it on your product page',
  'we get it showing', 'gets it showing', 'solves this for you',
];

// ── arm 3: the honest boundary statement must be PRESENT, not merely un-denied ─
// Each pillar is a set of alternatives; ANY one satisfies it.
const DISCLAIMER_PILLARS = [
  {
    name: 'no-import-tool-can-display',
    any: [
      'no import tool, ours included, can make a metafield appear',
      'no import tool — ours included — can make a metafield appear',
      'no import tool of ours can make a metafield appear',
    ],
  },
  {
    name: 'display-belongs-to-the-theme',
    any: [
      'decided entirely by your theme',
      'belongs to your <strong>theme</strong>',
      'that is where they have to happen',
    ],
  },
  {
    name: 'nothing-to-upload-here',
    any: [
      'there is nothing to upload on this page',
      'nothing to upload',
    ],
  },
];

// ── arm 4: structural tool surfaces that must NOT exist on a pure explainer ───
const FORBIDDEN_STRUCTURE = [
  { name: 'file-input', re: /<input\b[^>]*type\s*=\s*["']file["']/i },
  { name: 'dropzone', re: /class\s*=\s*["'][^"']*\bdropzone\b/i },
  { name: 'tool-panel-mount', re: /id\s*=\s*["']xfa-panel["']/i },
  { name: 'demo-workbook-download', re: /href\s*=\s*["'][^"']*\.(xlsx|xls|csv)["']/i },
  { name: 'page-js', re: /<script\b[^>]*src\s*=\s*["'][^"']*page\.js["']/i },
];

function readPage() {
  if (!existsSync(PAGE)) return null;
  return readFileSync(PAGE, 'utf8');
}

// Text as a reader sees it: tags dropped, entities for the punctuation this page
// actually uses decoded, whitespace collapsed. Matching on rendered text (not raw
// HTML) is what makes a phrase like "don't match" findable when the source spells
// it with a typographic apostrophe, and stops a match from being defeated by an
// inline <strong> landing mid-phrase.
function pageText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;|&#8217;|’/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&rarr;/g, '->')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// arm 1
function armCauses(html) {
  if (html === null) return { arm: 'CAUSES', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const t = pageText(html);
  const miss = [];
  for (const c of CAUSES) {
    const gone = c.all.filter((tok) => !t.includes(tok.toLowerCase()));
    if (gone.length) miss.push(`${c.name} (missing: ${gone.join(' | ')})`);
  }
  return miss.length === 0
    ? { arm: 'CAUSES', code: PASS, msg: `all ${CAUSES.length} known causes covered with cause-specific evidence` }
    : { arm: 'CAUSES', code: FAIL, msg: `cause coverage incomplete: ${miss.join('; ')}` };
}

// arm 2 — the card's hard constraint
function armNoOverclaim(html) {
  if (html === null) return { arm: 'NO-OVERCLAIM', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const t = pageText(html);
  const hits = FORBIDDEN_OVERCLAIM.filter((s) => t.includes(s.toLowerCase()));
  return hits.length === 0
    ? { arm: 'NO-OVERCLAIM', code: PASS, msg: `0/${FORBIDDEN_OVERCLAIM.length} forbidden over-claim phrasings present` }
    : { arm: 'NO-OVERCLAIM', code: FAIL, msg: `page claims our product performs the fix: ${hits.join(', ')}` };
}

// arm 3
function armDisclaimer(html) {
  if (html === null) return { arm: 'DISCLAIMER', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const t = pageText(html);
  const missing = DISCLAIMER_PILLARS
    .filter((p) => !p.any.some((s) => t.includes(pageText(s))))
    .map((p) => p.name);
  return missing.length === 0
    ? { arm: 'DISCLAIMER', code: PASS, msg: `all ${DISCLAIMER_PILLARS.length} honesty pillars stated explicitly` }
    : { arm: 'DISCLAIMER', code: FAIL, msg: `honest-boundary statement missing: ${missing.join(', ')}` };
}

// arm 4
function armNoTool(html) {
  if (html === null) return { arm: 'NO-TOOL', code: DID_NOT_RUN, msg: `page not found at ${PAGE}` };
  const hits = FORBIDDEN_STRUCTURE.filter((f) => f.re.test(html)).map((f) => f.name);
  return hits.length === 0
    ? { arm: 'NO-TOOL', code: PASS, msg: 'no upload/tool/demo-file surface — page is a pure explainer' }
    : { arm: 'NO-TOOL', code: FAIL, msg: `explainer page carries a tool surface: ${hits.join(', ')}` };
}

// arm 5
async function armLive() {
  let res;
  try {
    res = await fetch(LIVE_URL, { redirect: 'manual', headers: { 'user-agent': 'xls1209-dod' } });
  } catch (e) {
    return { arm: 'LIVE', code: DID_NOT_RUN, msg: `host unreachable (${e.code || e.message}) — not measured` };
  }
  if (res.status === 404) {
    return { arm: 'LIVE', code: DID_NOT_RUN, msg: `${LIVE_URL} -> 404 (pre-land / not yet deployed) — not a verdict` };
  }
  return res.status === 200
    ? { arm: 'LIVE', code: PASS, msg: `${LIVE_URL} -> 200` }
    : { arm: 'LIVE', code: FAIL, msg: `${LIVE_URL} -> ${res.status} (expected 200, no redirect)` };
}

async function main() {
  const html = readPage();
  const results = [armCauses(html), armNoOverclaim(html), armDisclaimer(html), armNoTool(html), await armLive()];
  let worst = PASS;
  for (const r of results) {
    const tag = r.code === PASS ? 'PASS' : r.code === FAIL ? 'FAIL' : 'DID_NOT_RUN';
    console.log(`  [${tag}] ${r.arm}: ${r.msg}`);
    if (r.code === FAIL) worst = FAIL;
    else if (r.code === DID_NOT_RUN && worst !== FAIL) worst = DID_NOT_RUN;
  }
  const verdict = worst === PASS ? 'PASS' : worst === FAIL ? 'FAIL' : 'DID_NOT_RUN';
  console.log(`XLS-1209 DoD: ${verdict}`);
  process.exitCode = worst;
}

// ── selftest: the shipped page is green, and every arm reddens when doctored ──
function selftest() {
  let ok = true;
  const good = readPage();
  if (good === null) { console.log(`  selftest DID_NOT_RUN: real page not found at ${PAGE}`); process.exitCode = DID_NOT_RUN; return; }

  for (const r of [armCauses(good), armNoOverclaim(good), armDisclaimer(good), armNoTool(good)]) {
    if (r.code !== PASS) { console.log(`  selftest FAIL: shipped page not green on ${r.arm}: ${r.msg}`); ok = false; }
  }

  const must = (cond, why) => { if (!cond) { console.log(`  selftest FAIL: ${why}`); ok = false; } };

  // arm 1 must redden once per cause, not just in aggregate — a single shared
  // token could otherwise carry all four and hide a dropped cause.
  must(armCauses(good.replace(/vintage/ig, 'xxx')).code === FAIL, 'CAUSES did not redden on a dropped vintage-theme cause');
  must(armCauses(good.replace(/Image block/ig, 'xxx')).code === FAIL, 'CAUSES did not redden on a dropped block-mismatch cause');
  // Doctoring targets are chosen to be uninterrupted in the RAW source: the arms
  // match rendered text, so a phrase the page spells across a tag or a line break
  // ("renders <em>nothing</em>") is findable by the arm but not by a raw replace,
  // and doctoring it would produce a vacuously-green selftest.
  must(armCauses(good.replace(/no value on that particular product/ig, 'xxx')).code === FAIL, 'CAUSES did not redden on a dropped empty-value cause');
  must(armCauses(good.replace(/platform limitation/ig, 'xxx')).code === FAIL, 'CAUSES did not redden on a dropped URL-type cause');

  // arm 2 — the hard constraint. Redden on each SHAPE of over-claim, so the ban
  // is proven live rather than assumed from an all-clear on compliant copy.
  must(armNoOverclaim(good + '<p>Don\'t worry, we fix this for you.</p>').code === FAIL, 'NO-OVERCLAIM did not redden on a "we fix this" claim');
  must(armNoOverclaim(good + '<p>Our tool displays the metafield for you.</p>').code === FAIL, 'NO-OVERCLAIM did not redden on an "our tool displays" claim');
  must(armNoOverclaim(good + '<p>Just upload here to make it appear.</p>').code === FAIL, 'NO-OVERCLAIM did not redden on an "upload here to" claim');
  // ...and must NOT redden on the honest denial it exists to require.
  must(armNoOverclaim(good + '<p>No import tool of ours can fix this for you in your theme.</p>').code === FAIL,
    'NO-OVERCLAIM sanity: "fix this for you" is on the ban list and must hit even inside a sentence');

  // arm 3 — deleting the honest statement must redden even though arm 2 stays green.
  const stripped = good.replace(/No import tool, ours included/i, 'Something else entirely');
  must(armDisclaimer(stripped).code === FAIL, 'DISCLAIMER did not redden when the honest boundary statement was removed');
  must(armNoOverclaim(stripped).code === PASS, 'DISCLAIMER/NO-OVERCLAIM are not independent: removing the denial reddened the ban arm too');

  // arm 4 — each structural tool surface must be caught on its own.
  must(armNoTool(good.replace('</body>', '<input type="file" accept=".xlsx"></body>')).code === FAIL, 'NO-TOOL did not redden on a file input');
  must(armNoTool(good.replace('</body>', '<div class="dropzone">drop</div></body>')).code === FAIL, 'NO-TOOL did not redden on a dropzone');
  must(armNoTool(good.replace('</body>', '<div id="xfa-panel"></div></body>')).code === FAIL, 'NO-TOOL did not redden on a tool panel mount');
  must(armNoTool(good.replace('</body>', '<a href="demo.xlsx">demo</a></body>')).code === FAIL, 'NO-TOOL did not redden on a demo-workbook download');
  must(armNoTool(good.replace('</body>', '<script src="page.js"></script></body>')).code === FAIL, 'NO-TOOL did not redden on a page.js');

  console.log(ok
    ? '  selftest PASS: shipped page green on all four hermetic arms; each arm reddens on a doctored page.'
    : '  selftest FAILED');
  process.exitCode = ok ? PASS : FAIL;
}

if (process.argv.includes('--selftest')) selftest();
else await main();
