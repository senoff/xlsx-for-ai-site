#!/usr/bin/env node
/*
 * dod-xls227-xfetch-retry.mjs — DoD for XLS-227 (xfetch transient-retry).
 *
 * xfetch (tools/shell.js) is IIFE-internal — not exported, so it cannot be
 * unit-imported. This drives a REAL browser through the shared shell exactly
 * as a visitor's tool call does (window.XFA.runTool → ensureKey → xfetch POST
 * to /api/v1/tools/<name>), with Playwright page.route() standing in for the
 * live API, and asserts on the ATTEMPT COUNT — the only thing that proves a
 * retry actually happened.
 *
 * Two arms, both must hold:
 *   RETRY (transient 5xx):  the tool route returns 503, 503, 200. A working
 *     xfetch retries through both 503s and succeeds on the 3rd try -> the route
 *     is hit EXACTLY 3 times and runTool RESOLVES. Revert the retry and the
 *     first 503 surfaces immediately: 1 hit, runTool rejects -> this arm REDS.
 *   NO-RETRY (terminal 4xx): the tool route returns 400 once. A 4xx is terminal
 *     (401 has its own re-mint path; 400/413/415 are hard) -> the route is hit
 *     EXACTLY 1 time and runTool rejects. This arm stays GREEN with or without
 *     the retry, so it fences the fix against over-retrying 4xx.
 *
 * The page loads /tools/shell.js by ROOT-absolute path, so we serve the repo
 * root over a real (ephemeral-port) HTTP server rather than file://. Fully
 * self-contained and headless — no live server, no network.
 *
 * Exit 0 = PASS (both arms) · 1 = FAIL · 2 = DID NOT RUN (never a green).
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE_PATH = "/tools/convert-excel-to-csv/"; // any page loading the shared shell
const NAV_MS = 30000;

const die = (msg) => { console.error(`DID NOT RUN — ${msg}`); process.exit(2); };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xlsx": "application/octet-stream",
};

// ---- a minimal static server rooted at the repo (so /tools/shell.js resolves) ----
function staticServer() {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const full = normalize(join(ROOT, p));
      if (!full.startsWith(ROOT) || !existsSync(full)) { res.statusCode = 404; return res.end("not found"); }
      const ext = full.slice(full.lastIndexOf("."));
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.end(await readFile(full));
    } catch (e) {
      res.statusCode = 500; res.end("err");
    }
  });
}

// ---- run one arm in a fresh browser context ----
async function runArm(browser, base, statusSequence) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let toolHits = 0;

  // key bootstrap always succeeds (not the subject; keep it out of the count)
  await page.route("**/api/v1/clients", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ api_key: "test-key" }) })
  );
  // the subject: the tool route, driven by the per-attempt status sequence
  await page.route("**/api/v1/tools/**", (route) => {
    const status = statusSequence[Math.min(toolHits, statusSequence.length - 1)];
    toolHits += 1;
    const body = status === 200
      ? JSON.stringify({ content: [{ text: "ok" }], _meta: {} })
      : JSON.stringify({ error: "stub", status });
    route.fulfill({ status, contentType: "application/json", body });
  });

  const resp = await page.goto(base + PAGE_PATH, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  if (!resp || !resp.ok()) { await context.close(); die(`page ${PAGE_PATH} did not load (status ${resp && resp.status()})`); }

  const hasShell = await page.evaluate(() => !!(window.XFA && typeof window.XFA.runTool === "function"));
  if (!hasShell) { await context.close(); die("window.XFA.runTool not present — shell.js failed to load"); }

  const outcome = await page.evaluate(async () => {
    try { await window.XFA.runTool("convert", { file_b64: "dGVzdA==", options: {} }); return "resolved"; }
    catch (e) { return "rejected:" + (e && e.name); }
  });

  await context.close();
  return { toolHits, outcome };
}

// ---- main ----
const server = staticServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  server.close();
  die(`could not launch chromium (playwright browser installed?): ${e && e.message}`);
}

const fails = [];
try {
  // ARM 1 — transient 5xx retries to success
  const retry = await runArm(browser, base, [503, 503, 200]);
  if (retry.toolHits !== 3) fails.push(`RETRY arm: expected 3 tool attempts (503,503,200), got ${retry.toolHits}`);
  if (retry.outcome !== "resolved") fails.push(`RETRY arm: expected runTool to resolve after retrying, got "${retry.outcome}"`);

  // ARM 2 — terminal 4xx does NOT retry
  const noRetry = await runArm(browser, base, [400]);
  if (noRetry.toolHits !== 1) fails.push(`NO-RETRY arm: expected exactly 1 tool attempt (400 terminal), got ${noRetry.toolHits}`);
  if (!noRetry.outcome.startsWith("rejected")) fails.push(`NO-RETRY arm: expected runTool to reject on 400, got "${noRetry.outcome}"`);

  console.log(`XLS-227 arms: retry={hits:${retry.toolHits},outcome:${retry.outcome}} no-retry={hits:${noRetry.toolHits},outcome:${noRetry.outcome}}`);
} finally {
  await browser.close();
  server.close();
}

if (fails.length) {
  console.error("FAIL — XLS-227 xfetch transient-retry:");
  for (const f of fails) console.error("  - " + f);
  process.exit(1);
}
console.log("PASS — xfetch retries transient 5xx (3 attempts) and does NOT retry terminal 4xx (1 attempt).");
process.exit(0);
