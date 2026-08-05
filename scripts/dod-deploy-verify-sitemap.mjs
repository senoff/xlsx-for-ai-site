#!/usr/bin/env node
/*
 * dod-deploy-verify-sitemap.mjs — the POST-DEPLOY deploy-verify for the static
 * site (XLS-743, Bob 2026-08-05). Two arms, run against the LIVE deployed site:
 *
 *   1. COMPLETENESS (sitemap ⊇ built routes).  The live sitemap must list every
 *      canonical page that exists on disk at the deployed sha. A page that shipped
 *      but is absent from the sitemap is a BLIND SPOT: the 200-sweep would never
 *      GET it, so a deploy could 404 it and the sweep would still pass. That is
 *      the false-GREEN this arm exists to kill — a sweep is only as complete as
 *      its sitemap. Built routes come from gen-sitemap.mjs's OWN discovery
 *      (imported, not re-implemented) so the two answers cannot drift.
 *
 *   2. SWEEP (every sitemap URL 200s).  GET every <loc> in the live sitemap and
 *      assert HTTP 200 with NO redirect followed — a 301/404/500 FAILS. Redirects
 *      are a real failure here: gen-sitemap deliberately emits trailing-slash URLs
 *      because the non-slash form 301s on GitHub Pages, so a redirected <loc> means
 *      the sitemap carries a form that does not 200.
 *
 * An HTTP 200 alone does not prove a TOOL ran — that is dod-page-walk.mjs's job
 * (a real browser, real upload, asserts on content). This is the deploy-WIDE
 * regression guard: no existing page silently 404s, and the sitemap stays honest.
 * The two are complementary; neither replaces the other.
 *
 * Usage:
 *   node scripts/dod-deploy-verify-sitemap.mjs              # sweep https://xlsx-for-ai.dev
 *   BASE_URL=https://staging.example node scripts/dod-deploy-verify-sitemap.mjs
 *   node scripts/dod-deploy-verify-sitemap.mjs --selftest   # prove BOTH arms redden
 *
 * Exit: 0 = PASS · 1 = FAIL (a real defect, named) · 2 = DID NOT RUN (never green).
 * The verdict line carries value-bearing counts (swept=/non200=/missing=), so a
 * consumer greps a measured result, not a bare anchor an empty run could echo.
 */
import { createServer } from "node:http";
import { discoverPageUrls } from "./gen-sitemap.mjs";

const BASE_URL = (process.env.BASE_URL || "https://xlsx-for-ai.dev").replace(/\/$/, "");
const CONCURRENCY = Number(process.env.SWEEP_CONCURRENCY || 16);
const REQ_MS = Number(process.env.SWEEP_TIMEOUT_MS || 15000);

const die = (msg) => {
  console.error(`DID NOT RUN — ${msg}`);
  process.exit(2);
};

// ---- pure helpers (unit-testable by --selftest, no network of their own) ----

const pathOf = (u) => {
  try { return new URL(u).pathname; } catch { return u; }
};

const parseLocs = (xml) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

// COMPLETENESS arm as a pure set comparison. built ⊆ sitemap (by path), else the
// missing built routes are the defect. Returns {ok, missing[]}.
export function completeness(builtUrls, sitemapUrls) {
  const have = new Set(sitemapUrls.map(pathOf));
  const missing = builtUrls.map(pathOf).filter((p) => !have.has(p));
  return { ok: missing.length === 0, missing };
}

// SWEEP arm as a pure function over an injectable fetcher. Every url must resolve
// to status 200 with no redirect. Returns {ok, failures:[{url,status}]}.
export async function sweep(urls, { baseUrl, fetchFn, concurrency = CONCURRENCY, timeoutMs = REQ_MS }) {
  const targets = urls.map((u) => {
    // Retarget the loc's ORIGIN onto baseUrl so a staging/local mirror can be
    // swept, but keep the path+query the sitemap actually declares.
    const p = new URL(u);
    return { declared: u, target: baseUrl.replace(/\/$/, "") + p.pathname + p.search };
  });
  const failures = [];
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const { declared, target } = targets[i++];
      let status = 0;
      try {
        const ctl = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
        const r = await fetchFn(target, { method: "GET", redirect: "manual", signal: ctl });
        status = r.status;
      } catch (e) {
        status = `ERR:${e.name || "fetch"}`;
      }
      if (status !== 200) failures.push({ url: declared, target, status });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker));
  return { ok: failures.length === 0, failures };
}

async function fetchSitemapLocs(baseUrl, fetchFn) {
  const url = baseUrl.replace(/\/$/, "") + "/sitemap.xml";
  let r;
  try {
    r = await fetchFn(url, { method: "GET", redirect: "manual" });
  } catch (e) {
    die(`could not fetch the live sitemap at ${url} (${e.message})`);
  }
  if (r.status !== 200) die(`live sitemap ${url} returned HTTP ${r.status}, not 200`);
  const xml = await r.text();
  const locs = parseLocs(xml);
  if (locs.length === 0) die(`live sitemap ${url} parsed to 0 <loc> URLs — refusing to certify an empty sweep`);
  return locs;
}

// ---------------------------- live run ----------------------------

async function runLive() {
  const fetchFn = globalThis.fetch;
  if (!fetchFn) die("global fetch is unavailable (need Node 18+)");

  const built = discoverPageUrls();
  if (built.length === 0) die("gen-sitemap discovery found 0 pages on disk — refusing to certify");

  const liveLocs = await fetchSitemapLocs(BASE_URL, fetchFn);

  // ARM 1 — completeness: the LIVE sitemap must cover every built route.
  const comp = completeness(built, liveLocs);
  // ARM 2 — sweep: every URL the live sitemap declares must 200.
  const swp = await sweep(liveLocs, { baseUrl: BASE_URL, fetchFn });

  for (const p of comp.missing) console.error(`MISSING-FROM-SITEMAP ${p} — built on disk, absent from the live sitemap (blind spot)`);
  for (const f of swp.failures) console.error(`NON-200 ${f.status} ${f.target} (declared ${f.url})`);

  const ok = comp.ok && swp.ok;
  const verdict = ok ? "PASS" : "FAIL";
  console.log(
    `DEPLOY-VERIFY-SITEMAP verdict=${verdict} base=${BASE_URL} built=${built.length} swept=${liveLocs.length} non200=${swp.failures.length} missing=${comp.missing.length}`
  );
  process.exit(ok ? 0 : 1);
}

// ---------------------------- selftest ----------------------------
// Hermetic proof that BOTH arms can go RED. No dependency on the live site or
// the repo's real pages — a self-test that leans on real state proves nothing.

async function selftest() {
  let proven = 0, wrong = 0;
  const note = (name, redFired, detail) => {
    if (redFired) { proven++; console.log(`  ✓ ${name} reddens — ${detail}`); }
    else { wrong++; console.log(`  ✗ ${name} DID NOT redden — ${detail} (this check cannot fail; it is not a check)`); }
  };

  // Arm 1: completeness reds when a built route is absent from the sitemap.
  {
    const built = ["https://x/", "https://x/tools/", "https://x/privacy/"];
    const sitemapMissingOne = ["https://x/", "https://x/privacy/"]; // /tools/ dropped
    const bad = completeness(built, sitemapMissingOne);
    const good = completeness(built, ["https://x/", "https://x/tools/", "https://x/privacy/"]);
    note("completeness (built route removed from sitemap)",
      !bad.ok && bad.missing.map(pathOf).includes("/tools/") && good.ok,
      `missing=${JSON.stringify(bad.missing)}, full-set ok=${good.ok}`);
  }

  // Arm 2: sweep reds on a non-200, against a REAL local server (one 200, one 404).
  {
    const srv = createServer((req, res) => {
      if (req.url === "/ok/") { res.writeHead(200); res.end("ok"); }
      else { res.writeHead(404); res.end("nope"); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const bad = await sweep([`http://x/ok/`, `http://x/broken/`], { baseUrl: base, fetchFn: globalThis.fetch, concurrency: 2 });
      const good = await sweep([`http://x/ok/`], { baseUrl: base, fetchFn: globalThis.fetch, concurrency: 2 });
      note("sweep (a page 404s)",
        !bad.ok && bad.failures.some((f) => String(f.status) === "404" && f.url.endsWith("/broken/")) && good.ok,
        `failures=${JSON.stringify(bad.failures.map((f) => [pathOf(f.url), f.status]))}, all-200 ok=${good.ok}`);
    } finally {
      srv.close();
    }
  }

  // Arm 1b: completeness reads REAL discovery — prove discoverPageUrls is wired
  // and non-empty, and that dropping one of its entries from the sitemap reds.
  {
    const built = discoverPageUrls();
    if (built.length === 0) { wrong++; console.log("  ✗ discoverPageUrls returned 0 — cannot self-test against real discovery"); }
    else {
      const sitemapMinusOne = built.slice(1); // drop the homepage
      const bad = completeness(built, sitemapMinusOne);
      note("completeness (real discovery, one page dropped)",
        !bad.ok && bad.missing.length >= 1,
        `${built.length} real pages discovered, missing=${bad.missing.length}`);
    }
  }

  console.log(`\nselftest: ${proven} proven / ${wrong} wrong.`);
  process.exit(wrong === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  await selftest();
} else {
  await runLive();
}
