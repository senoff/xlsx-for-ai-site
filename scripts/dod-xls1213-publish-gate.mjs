#!/usr/bin/env node
/*
 * dod-xls1213-publish-gate.mjs — the executable DoD check for XLS-1213
 * (site-spoke deploy-ordering gate). SPM steered options 1 + 3 ONLY; option 2
 * (auto-deploy on merge) is DROPPED — the Hetzner cx53 host already auto-pulls
 * origin/main (~5 min), so deploy-drift-heal covers the lag. This instrument is
 * the durable answer to the 2026-08-30 incident: the site served
 * /importable/import-shopify-variant-metafields/ (200, LIVE) while prod api did
 * NOT carry POST /api/v1/tools/shopify_variant_metafields_import (404) — a
 * visitor uploading a file on a live page got a hard failure. A spoke page must
 * not front-run its backend.
 *
 * The seam this measures is "deployed bytes != serving" at the SITE/SERVER
 * boundary: publishing a spoke page is NOT end-to-end done until the server route
 * it POSTs to is actually live in prod. It recurs on every new spoke.
 *
 * ── The page→tool map (the subject) ────────────────────────────────────────
 * A spoke page invokes exactly one server tool via the shared runtime
 * (tools/shell.js): either an inline `runTool("<tool>")` or a per-page config
 * `tool: "<tool>"` consumed by a shared `runTool(cfg.tool, …)`. This check reads
 * the REPO TREE (the bytes that publish) — for every page that loads shell.js it
 * unions the tool literals across the page's own HTML and its same-origin
 * `<script src>` files. That tree mapping IS what goes live (a static publish),
 * so it needs no network to know which routes each page will front.
 *
 * A handful of shell.js pages legitimately POST no fixed serving tool (the two
 * client-side export pages, a reference/sample hub, and the generic run-any-tool
 * dispatcher). They are the TOOLLESS_ALLOWLIST. ANY OTHER shell.js page that
 * yields no extractable tool is a BLIND SPOT — a page that could front-run a
 * backend the gate cannot see — and the MAP arm FAILS on it loudly, rather than
 * silently skipping it (which is exactly how the incident class hides).
 *
 * ── Three arms ─────────────────────────────────────────────────────────────
 *   1. MAP (hermetic).  Off-disk, no network — the arm that must never depend on
 *      a deploy to redden. (a) no-blind-spot: every shell.js page maps to a tool
 *      or is allowlisted; (b) incident pin: import-shopify-variant-metafields →
 *      shopify_variant_metafields_import (so an extractor regression on the very
 *      case that caused the outage reddens here). Graded pre-merge in
 *      build-validate.yml.
 *
 *   2. GATE (network) — OPTION 1, the publish-gate.  For every distinct tool T in
 *      the map, POST ${API_BASE}/api/v1/tools/T. A **404** means the route is not
 *      deployed and the page(s) referencing it front-run their backend → FAIL,
 *      naming each (page, T). Any other status (400/401/415/405/2xx) means the
 *      route is PRESENT → pass (an empty POST to a live route 400s, it does not
 *      404). Host unreachable for every probe = DID_NOT_RUN (network, not a route
 *      verdict). Runs post-deploy + on schedule in deploy-verify-sitemap.yml.
 *
 *   3. DRIFT (network) — OPTION 3, the backstop monitor.  GET ${API_BASE}/healthz
 *      for prod's build_sha (+ uptime) and ALERT when a live page references an
 *      undeployed route (the GATE finding) — i.e. prod is serving a surface a
 *      live page front-runs. When the SERVER repo is resolvable on the box
 *      (SERVER_REPO), it also reports N = commits build_sha is behind origin/main
 *      as corroborating detail; in a bare site-CI checkout N is simply omitted
 *      (never a false verdict). Same scheduled cadence as the sitemap sweep.
 *
 * Usage:
 *   node scripts/dod-xls1213-publish-gate.mjs                 # all three arms
 *   node scripts/dod-xls1213-publish-gate.mjs --map-only      # hermetic MAP only (pre-merge)
 *   API_BASE=https://api.xlsx-for-ai.dev node scripts/dod-…   # override api host
 *   SERVER_REPO=/root/xlsx7 node scripts/dod-…                # resolve N-behind for DRIFT
 *   node scripts/dod-xls1213-publish-gate.mjs --selftest      # prove every arm reddens
 *
 * Exit: 0 = PASS (all runnable arms green) · 1 = FAIL (a real defect, named)
 *       6 = DID_NOT_RUN / INDETERMINATE (an arm could not see its subject — never
 *           green; 6 is the ONLY rc xlsx_board_verify reads as INDETERMINATE, so a
 *           host-unreachable live arm must not redden a card).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const API_BASE = (process.env.API_BASE || process.env.BASE_URL || 'https://api.xlsx-for-ai.dev').replace(/\/+$/, '');
const SERVER_REPO = process.env.SERVER_REPO || ''; // optional: resolve N-behind for DRIFT

// DID_NOT_RUN exits 6, NOT 2: xlsx_board_verify maps ONLY rc 6 to INDETERMINATE;
// every other nonzero is graded FAIL. A host-unreachable LIVE arm must read as
// "could not measure", never as a card-reddening defect (XLS-806 class).
const PASS = 0, FAIL = 1, DID_NOT_RUN = 6;

// The tool literal a page POSTs to, in either wiring shape. Tool names are the
// server route slugs: lowercase, digits, underscore.
const RUNTOOL_RE = /runTool\(\s*["']([a-z0-9_]+)["']/g;
const TOOLCFG_RE = /\btool\s*:\s*["']([a-z0-9_]+)["']/g;

// Shell.js pages that legitimately POST no fixed serving tool. Kept as an
// EXPLICIT allowlist (not a heuristic) so adding a new tool-less surface is a
// deliberate, reviewed edit — and any OTHER unmapped shell.js page reddens.
const TOOLLESS_ALLOWLIST = new Set([
  'importable/export-shopify-collections',      // client-side export, no tool POST
  'importable/export-shopify-products',         // client-side export, no tool POST
  'importable/metafields-store-move-references', // reference/sample hub page
  'tools/run-any-tool',                          // generic dispatcher: tool is user-chosen at runtime
]);

// The incident that motivated the card — pinned so an extractor regression on the
// exact page that caused the 2026-08-30 outage reddens the hermetic arm.
const INCIDENT_PAGE = 'importable/import-shopify-variant-metafields';
const INCIDENT_TOOL = 'shopify_variant_metafields_import';

// ── Subject: build the page→tool map from the tree ─────────────────────────
function walkIndexHtml(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e === 'test' || e === '.github') continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walkIndexHtml(p, acc);
    else if (e === 'index.html') acc.push(p);
  }
  return acc;
}

function toolsForPage(indexHtmlPath) {
  const html = readFileSync(indexHtmlPath, 'utf8');
  if (!html.includes('/tools/shell.js')) return null; // not a tool surface
  const pageDir = dirname(indexHtmlPath);
  const files = [indexHtmlPath];
  for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
    const src = m[1];
    if (/^https?:/i.test(src)) continue; // cross-origin: not our tool wiring
    const f = src.startsWith('/') ? join(REPO_ROOT, src) : join(pageDir, src);
    if (existsSync(f)) files.push(f);
  }
  const tools = new Set();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(RUNTOOL_RE)) tools.add(m[1]);
    for (const m of text.matchAll(TOOLCFG_RE)) tools.add(m[1]);
  }
  return tools;
}

// Returns { map: {relDir:[tools]}, unwired:[relDir], toolPages:{tool:[relDir]} }.
function buildPageToolMap() {
  const map = {};
  const unwired = [];
  const toolPages = {};
  for (const idx of walkIndexHtml(REPO_ROOT)) {
    const tools = toolsForPage(idx);
    if (tools === null) continue; // no shell.js: a prose/hub page, not a tool surface
    const relDir = relative(REPO_ROOT, dirname(idx)) || '.';
    if (tools.size === 0) {
      if (!TOOLLESS_ALLOWLIST.has(relDir)) unwired.push(relDir);
      continue;
    }
    const sorted = [...tools].sort();
    map[relDir] = sorted;
    for (const t of sorted) (toolPages[t] ||= []).push(relDir);
  }
  return { map, unwired, toolPages };
}

// ── ARM 1: MAP (hermetic) — pure over the built map ────────────────────────
function armMap({ map, unwired }) {
  if (unwired.length) {
    const shown = unwired.slice(0, 10).join(', ') + (unwired.length > 10 ? `, …(+${unwired.length - 10})` : '');
    return {
      arm: 'MAP', code: FAIL,
      msg: `${unwired.length} shell.js tool-surface page(s) yield NO extractable tool and are not on the toolless allowlist: ${shown}. A page that can front-run its backend must be probeable — wire its tool (runTool("…") / tool:"…") or, if it truly POSTs no fixed tool, add it to TOOLLESS_ALLOWLIST. Silently skipping it is the incident blind spot.`,
    };
  }
  const pageCount = Object.keys(map).length;
  const incidentMapped = map[INCIDENT_PAGE];
  if (incidentMapped !== undefined && !incidentMapped.includes(INCIDENT_TOOL)) {
    return {
      arm: 'MAP', code: FAIL,
      msg: `incident pin: ${INCIDENT_PAGE} maps to [${incidentMapped.join(',')}] but must include ${INCIDENT_TOOL} — the extractor regressed on the exact page that caused the 2026-08-30 outage.`,
    };
  }
  const pinNote = incidentMapped ? `incident pin OK (${INCIDENT_PAGE}→${INCIDENT_TOOL})` : `incident page absent (pin skipped)`;
  return { arm: 'MAP', code: PASS, msg: `${pageCount} spoke page(s) map to a serving tool, no blind spot; ${pinNote}.` };
}

// ── ARM 2: GATE (option 1) — pure over probe results ───────────────────────
// probeResults: [{ tool, status|null, unreachable:bool, pages:[relDir] }]
function armGate(probeResults) {
  if (probeResults.length === 0) return { arm: 'GATE', code: PASS, msg: `no serving tools referenced — nothing to gate.` };
  const reachable = probeResults.filter((p) => !p.unreachable);
  if (reachable.length === 0) {
    return { arm: 'GATE', code: DID_NOT_RUN, msg: `host ${API_BASE} unreachable for all ${probeResults.length} tool probe(s) — network/DNS, not a route verdict.` };
  }
  const undeployed = reachable.filter((p) => p.status === 404);
  if (undeployed.length) {
    const detail = undeployed
      .map((p) => `${p.tool} (404; used by ${p.pages.slice(0, 3).join(', ')}${p.pages.length > 3 ? `, +${p.pages.length - 3}` : ''})`)
      .join('; ');
    return {
      arm: 'GATE', code: FAIL,
      msg: `${undeployed.length} live-referenced route(s) NOT deployed to prod → page(s) front-run their backend: ${detail}. The page must not go 200-live until POST /api/v1/tools/<T> answers non-404.`,
    };
  }
  return { arm: 'GATE', code: PASS, msg: `all ${reachable.length} referenced route(s) present on ${API_BASE} (no 404).` };
}

// ── ARM 3: DRIFT (option 3) — pure over the gate result + healthz ──────────
// health: { build_sha|null, uptime_s|null, unreachable:bool }, behind: number|null
function armDrift(probeResults, health, behind) {
  const undeployed = probeResults.filter((p) => !p.unreachable && p.status === 404);
  const shaTag = health.build_sha ? `build_sha=${health.build_sha.slice(0, 12)}` : 'build_sha=unknown';
  const behindTag = behind === null ? '' : ` (${behind} commit(s) behind origin/main)`;
  if (health.unreachable && probeResults.every((p) => p.unreachable)) {
    return { arm: 'DRIFT', code: DID_NOT_RUN, msg: `healthz and tool probes both unreachable on ${API_BASE} — cannot measure drift.` };
  }
  if (undeployed.length) {
    return {
      arm: 'DRIFT', code: FAIL,
      msg: `DRIFT ALERT: prod (${shaTag}${behindTag}) serves a surface that a live page front-runs — undeployed route(s): ${undeployed.map((p) => p.tool).join(', ')}. Deploy the server (auto-pull ~5 min) or unpublish the page(s).`,
    };
  }
  return { arm: 'DRIFT', code: PASS, msg: `no drift: prod ${shaTag}${behindTag}, every live-referenced route is deployed.` };
}

// ── Live IO drivers (only reached on a real run, never in selftest) ────────
async function probeTool(tool) {
  const url = `${API_BASE}/api/v1/tools/${tool}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, unreachable: false };
  } catch {
    return { status: null, unreachable: true };
  }
}

async function fetchHealth() {
  try {
    const res = await fetch(`${API_BASE}/healthz`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    return { build_sha: body.build_sha ?? null, uptime_s: body.uptime_s ?? null, unreachable: false };
  } catch {
    return { build_sha: null, uptime_s: null, unreachable: true };
  }
}

// Best-effort: commits build_sha is behind origin/main in the SERVER repo, if the
// repo is resolvable on this box (it is not in a bare site-CI checkout → null).
function commitsBehind(buildSha) {
  if (!buildSha || !SERVER_REPO || !existsSync(join(SERVER_REPO, '.git'))) return null;
  try {
    const n = execFileSync('git', ['-C', SERVER_REPO, 'rev-list', '--count', `${buildSha}..origin/main`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+$/.test(n) ? Number(n) : null;
  } catch {
    return null; // sha not in history / repo not fetched — omit N, do not guess
  }
}

async function main() {
  const mapOnly = process.argv.includes('--map-only');
  const { map, unwired, toolPages } = buildPageToolMap();

  const results = [armMap({ map, unwired })];

  if (!mapOnly) {
    const tools = Object.keys(toolPages).sort();
    const probeResults = [];
    for (const tool of tools) {
      const r = await probeTool(tool);
      probeResults.push({ tool, status: r.status, unreachable: r.unreachable, pages: toolPages[tool] });
    }
    const health = await fetchHealth();
    const behind = commitsBehind(health.build_sha);
    results.push(armGate(probeResults));
    results.push(armDrift(probeResults, health, behind));
  }

  let worst = PASS;
  for (const r of results) {
    const tag = r.code === PASS ? 'PASS' : r.code === FAIL ? 'FAIL' : 'DID_NOT_RUN';
    console.log(`  [${tag}] ${r.arm}: ${r.msg}`);
    if (r.code === FAIL) worst = FAIL;
    else if (r.code === DID_NOT_RUN && worst !== FAIL) worst = DID_NOT_RUN;
  }
  const verdict = worst === PASS ? 'PASS' : worst === FAIL ? 'FAIL' : 'DID_NOT_RUN';
  console.log(`XLS-1213 DoD${mapOnly ? ' (map-only)' : ''}: ${verdict}`);
  process.exitCode = worst;
}

// ── selftest: prove EVERY arm reddens on a doctored subject (hermetic) ──────
function selftest() {
  let ok = true;
  const check = (name, cond) => { if (!cond) { console.log(`  selftest FAIL: ${name}`); ok = false; } };

  // MAP arm
  check('MAP passes on a clean map', armMap({ map: { [INCIDENT_PAGE]: [INCIDENT_TOOL] }, unwired: [] }).code === PASS);
  check('MAP fails on an unwired (blind-spot) page', armMap({ map: {}, unwired: ['importable/new-unwired-spoke'] }).code === FAIL);
  check('MAP fails when the incident page loses its tool', armMap({ map: { [INCIDENT_PAGE]: ['some_other_tool'] }, unwired: [] }).code === FAIL);
  check('MAP passes when the incident page is absent (pin skipped)', armMap({ map: { 'tools/convert': ['xlsx_convert'] }, unwired: [] }).code === PASS);

  // GATE arm (option 1)
  const gPages = { pages: ['importable/import-shopify-variant-metafields'] };
  check('GATE fails on a 404 (undeployed) route', armGate([{ tool: INCIDENT_TOOL, status: 404, unreachable: false, ...gPages }]).code === FAIL);
  check('GATE passes on a 400 (present) route', armGate([{ tool: 'xlsx_read', status: 400, unreachable: false, pages: ['tools/see-inside'] }]).code === PASS);
  check('GATE passes on a 200 (present) route', armGate([{ tool: 'xlsx_read', status: 200, unreachable: false, pages: ['tools/see-inside'] }]).code === PASS);
  check('GATE is DID_NOT_RUN when every probe is unreachable', armGate([{ tool: 'xlsx_read', status: null, unreachable: true, pages: ['x'] }]).code === DID_NOT_RUN);
  check('GATE fails if ANY route 404s among reachable ones', armGate([
    { tool: 'xlsx_read', status: 400, unreachable: false, pages: ['a'] },
    { tool: INCIDENT_TOOL, status: 404, unreachable: false, pages: ['b'] },
  ]).code === FAIL);

  // DRIFT arm (option 3)
  const healthy = { build_sha: 'a0b9e2b4e061f41d5e43a19dedc4a8612933d307', uptime_s: 100, unreachable: false };
  check('DRIFT alerts when a referenced route is undeployed', armDrift([{ tool: INCIDENT_TOOL, status: 404, unreachable: false, pages: ['b'] }], healthy, 7).code === FAIL);
  check('DRIFT passes when every referenced route is deployed', armDrift([{ tool: 'xlsx_read', status: 400, unreachable: false, pages: ['a'] }], healthy, 0).code === PASS);
  check('DRIFT is DID_NOT_RUN when healthz + probes all unreachable', armDrift([{ tool: 'x', status: null, unreachable: true, pages: ['a'] }], { build_sha: null, uptime_s: null, unreachable: true }, null).code === DID_NOT_RUN);

  console.log(ok ? '  selftest PASS: MAP/GATE/DRIFT each redden on a doctored subject.' : '  selftest FAILED');
  process.exitCode = ok ? PASS : FAIL;
}

if (process.argv.includes('--selftest')) selftest();
else await main();
