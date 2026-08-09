#!/usr/bin/env node
/*
 * dod-xls763-api-discoverability.mjs — the executable DoD check for XLS-763
 * (public-API cross-repo discoverability). XLS-763 shipped two doc/site edits so
 * the read-only discovery routes 761/762 added to the server (`/api/v1/reference`
 * + `/api/v1/openapi.json`) are actually FINDABLE: named in the npm README and on
 * the marketing site's /developers/ page, and both routes live-200. This check is
 * the answer to "how do we know 763 works?" — the register-before-land row points
 * at it (senoff/work-state:state/xlsx-card-checks.json).
 *
 * Three arms, one per DoD clause. A route is "discoverable" only if BOTH the
 * reference and the openapi.json path are named on a surface — naming one is a
 * half-door, so each arm asserts the PAIR.
 *
 *   1. SITE (hermetic).  developers/index.html (shipped in THIS repo) must name
 *      both discovery routes in the visible page — DoD §5(3). Read off disk, no
 *      network: this is the arm that must never depend on a deploy to redden.
 *
 *   2. NPM README (cross-repo).  The npm package README must name both routes —
 *      DoD §5(1). The README lives in the sibling npm repo, not here, so it is read
 *      from that repo's LANDED state — `git show <ref>:README.md` at NPM_README_REF
 *      (default origin/main), NOT the working tree, so the arm is immune to whatever
 *      branch the npm checkout happens to sit on. NPM_README (an explicit file path)
 *      overrides for offline testing. If neither is resolvable (npm repo not on this
 *      box, or ref missing), the arm is DID_NOT_RUN (exit 2) — never a false PASS and
 *      never a false FAIL: a check that cannot see its subject must say so, not guess.
 *
 *   3. LIVE (network).  GET both routes on the live host and assert HTTP 200 with
 *      NO redirect followed — DoD §5(2). A 301/404/5xx FAILS: a doc that links a
 *      route which does not 200 is a broken promise. Unreachable host (DNS/conn) =
 *      DID_NOT_RUN (exit 2), distinct from a reached-but-non-200 FAIL.
 *
 * The three are complementary: SITE proves the page says it, README proves the
 * package says it, LIVE proves the thing it points at is really there. None
 * replaces another.
 *
 * Usage:
 *   node scripts/dod-xls763-api-discoverability.mjs               # all three arms
 *   BASE_URL=https://api.xlsx-for-ai.dev node scripts/dod-...mjs  # override host
 *   NPM_README=/path/to/README.md node scripts/dod-...mjs         # override readme
 *   node scripts/dod-xls763-api-discoverability.mjs --selftest    # prove arms redden
 *
 * Exit: 0 = PASS (all runnable arms green) · 1 = FAIL (a real defect, named)
 *       2 = DID_NOT_RUN (an arm could not see its subject — never green).
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BASE_URL = (process.env.BASE_URL || 'https://api.xlsx-for-ai.dev').replace(/\/+$/, '');
// The npm README is read from its LANDED state, not a working tree (see header, ARM 2).
const NPM_REPO = process.env.NPM_REPO || join(homedir(), 'xlsx-for-ai');
const NPM_README_REF = process.env.NPM_README_REF || 'origin/main';
const NPM_README = process.env.NPM_README || ''; // explicit file path override (offline testing)

// The two discovery routes 763 exists to surface. Each must appear on every doc
// surface (as a full URL or a bare path — grep the path fragment, host-agnostic).
const ROUTES = ['/api/v1/reference', '/api/v1/openapi.json'];

const PASS = 0, FAIL = 1, DID_NOT_RUN = 2;

function namesBothRoutes(haystack) {
  return ROUTES.filter((r) => !haystack.includes(r));
}

// ── ARM 1: SITE (hermetic) ─────────────────────────────────────────────────
function armSite() {
  const page = join(REPO_ROOT, 'developers', 'index.html');
  if (!existsSync(page)) {
    return { arm: 'SITE', code: DID_NOT_RUN, msg: `developers/index.html absent at ${page} — /developers/ page not on this tree.` };
  }
  const html = readFileSync(page, 'utf8');
  const missing = namesBothRoutes(html);
  if (missing.length) {
    return { arm: 'SITE', code: FAIL, msg: `/developers/ page does not name ${missing.join(' + ')} — the discovery route(s) are not surfaced on the site.` };
  }
  return { arm: 'SITE', code: PASS, msg: `/developers/ names both discovery routes.` };
}

// ── ARM 2: NPM README (cross-repo, landed state) ───────────────────────────
function readNpmReadme() {
  // Explicit file path wins (offline testing).
  if (NPM_README) {
    if (!existsSync(NPM_README)) return { err: `NPM_README=${NPM_README} does not exist` };
    return { text: readFileSync(NPM_README, 'utf8'), src: NPM_README };
  }
  // Otherwise read the LANDED README from the npm repo's ref (default origin/main).
  if (!existsSync(join(NPM_REPO, '.git'))) return { err: `npm repo not a git checkout at ${NPM_REPO}` };
  try {
    const text = execFileSync('git', ['-C', NPM_REPO, 'show', `${NPM_README_REF}:README.md`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
    return { text, src: `${NPM_REPO}@${NPM_README_REF}:README.md` };
  } catch {
    return { err: `git show ${NPM_README_REF}:README.md failed in ${NPM_REPO} (ref missing / not fetched)` };
  }
}

function armReadme() {
  const { text, src, err } = readNpmReadme();
  if (err) {
    return { arm: 'NPM-README', code: DID_NOT_RUN, msg: `${err} — arm could not see its subject.` };
  }
  const missing = namesBothRoutes(text);
  if (missing.length) {
    return { arm: 'NPM-README', code: FAIL, msg: `npm README (${src}) does not name ${missing.join(' + ')} — the discovery route(s) are not surfaced in the package docs.` };
  }
  return { arm: 'NPM-README', code: PASS, msg: `npm README (${src}) names both discovery routes.` };
}

// ── ARM 3: LIVE (network) ──────────────────────────────────────────────────
async function armLive() {
  const failures = [];
  let unreachable = 0;
  for (const route of ROUTES) {
    const url = BASE_URL + route;
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) {
        failures.push(`${route} → HTTP ${res.status} (want 200, no redirect)`);
      }
    } catch (e) {
      unreachable += 1;
      failures.push(`${route} → unreachable (${e?.name || 'error'})`);
    }
  }
  if (unreachable === ROUTES.length) {
    return { arm: 'LIVE', code: DID_NOT_RUN, msg: `host ${BASE_URL} unreachable for all routes — network/DNS, not a route verdict.` };
  }
  if (failures.length) {
    return { arm: 'LIVE', code: FAIL, msg: `live discovery route(s) do not 200: ${failures.join('; ')}` };
  }
  return { arm: 'LIVE', code: PASS, msg: `both discovery routes live-200 on ${BASE_URL}.` };
}

async function main() {
  const results = [armSite(), armReadme(), await armLive()];
  let worst = PASS;
  for (const r of results) {
    const tag = r.code === PASS ? 'PASS' : r.code === FAIL ? 'FAIL' : 'DID_NOT_RUN';
    console.log(`  [${tag}] ${r.arm}: ${r.msg}`);
    // FAIL dominates DID_NOT_RUN dominates PASS.
    if (r.code === FAIL) worst = FAIL;
    else if (r.code === DID_NOT_RUN && worst !== FAIL) worst = DID_NOT_RUN;
  }
  const verdict = worst === PASS ? 'PASS' : worst === FAIL ? 'FAIL' : 'DID_NOT_RUN';
  console.log(`XLS-763 DoD: ${verdict}`);
  process.exitCode = worst;
}

// ── selftest: prove each content arm reddens on a doctored subject ──────────
function selftest() {
  let ok = true;
  const good = `see ${ROUTES[0]} and ${ROUTES[1]}`;
  const half = `see ${ROUTES[0]} only`;
  if (namesBothRoutes(good).length !== 0) { console.log('  selftest FAIL: full text flagged missing'); ok = false; }
  if (namesBothRoutes(half).length !== 1) { console.log('  selftest FAIL: half-door not caught'); ok = false; }
  if (namesBothRoutes('').length !== 2) { console.log('  selftest FAIL: empty text not caught'); ok = false; }
  console.log(ok ? '  selftest PASS: pair-grep reddens on a missing route.' : '  selftest FAILED');
  process.exitCode = ok ? PASS : FAIL;
}

if (process.argv.includes('--selftest')) selftest();
else await main();
