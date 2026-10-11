#!/usr/bin/env node
/*
 * front-door.test.mjs — XLS-3006 page tests. Hermetic: a local static server for
 * the repo, a real headless browser, and stand-in answers for the API. Nothing
 * here may reach the production API: every request that is not the local server
 * or a declared stand-in is aborted AND counted as a failure.
 *
 * Case ids are the audit's spec-line ids (door-C-api-web.md): C3-1 ... C3-15.
 *
 * Run:  node test/pages/front-door.test.mjs        (npm test runs it too)
 * Exit 0 = all pass · 1 = a case failed · 2 = could not run.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE = "/tools/convert-excel-to-csv/";
const FIXTURE = join(ROOT, "test/fixtures/pages/rows.xlsx");
const API = "https://api.xlsx-for-ai.dev";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function staticServer() {
  return createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || "/").split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const full = normalize(join(ROOT, p));
      if (!full.startsWith(ROOT) || !existsSync(full)) { res.statusCode = 404; return res.end("not found"); }
      res.setHeader("Content-Type", MIME[full.slice(full.lastIndexOf("."))] || "application/octet-stream");
      res.end(await readFile(full));
    } catch { res.statusCode = 500; res.end("err"); }
  });
}

const CSV_OK = {
  content: [{ text: "## Convert → csv\n\nSource detected: 1 sheet (Sheet1)\n\nsku,qty\nA-1,3\nB-2,7" }],
  _meta: { source_sheet_names: ["Sheet1"], rendered_sheets: ["Sheet1"] },
};
const json = (status, body, headers = {}) => ({
  status, contentType: "application/json", body: JSON.stringify(body),
  headers: { "access-control-expose-headers": "Retry-After", ...headers },
});

let browser, base;
const leaks = [];

// A fresh visitor: empty storage, stand-ins for the two API routes, and a guard
// that aborts (and records) anything else that tries to leave the machine.
async function visitor({ clients, tools, path = PAGE }) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.route(
    (u) => u.hostname !== "127.0.0.1",
    (route) => { leaks.push(route.request().url()); route.abort(); }
  );
  const hits = { clients: 0, tools: 0, toolAuth: [] };
  await ctx.route(`${API}/api/v1/clients`, (route) => {
    hits.clients += 1;
    const a = clients[Math.min(hits.clients - 1, clients.length - 1)];
    route.fulfill(a);
  });
  await ctx.route(`${API}/api/v1/tools/**`, (route) => {
    hits.tools += 1;
    hits.toolAuth.push(route.request().headers()["authorization"] || "");
    const a = tools[Math.min(hits.tools - 1, tools.length - 1)];
    route.fulfill(a);
  });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  return { ctx, page, hits };
}

async function dropAndSettle(page, file = FIXTURE) {
  await page.setInputFiles("#xfa-file", file);
  await page.locator("#xfa-again, .notice.err").first().waitFor({ state: "visible", timeout: 30000 });
  const err = page.locator(".notice.err");
  return (await err.count()) ? { err: (await err.first().innerText()).trim(), href: await err.first().locator("a").first().getAttribute("href").catch(() => null) } : { ok: true };
}

const OK_KEY = json(201, { client_id: "c1", api_key: "xfa_standin_key" });
const OK_TOOL = json(200, CSV_OK);
const mustNot = (text, re, what) => { if (re.test(text)) throw new Error(`${what}: found ${re} in: ${text}`); };
const must = (text, re, what) => { if (!re.test(text)) throw new Error(`${what}: expected ${re} in: ${text}`); };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`); };

const tests = [];
const T = (id, fn) => tests.push({ id, fn });

// ---------------------------------------------------------------- browser cases
// C3-1 / item 10: the shared script starts a session and runs one tool. If a
// change breaks every tool page, this goes red.
T("C3-1 shared script starts a session and runs one tool (fresh visitor)", async () => {
  const { ctx, page, hits } = await visitor({ clients: [OK_KEY], tools: [OK_TOOL] });
  const r = await dropAndSettle(page);
  if (!r.ok) throw new Error("page showed an error: " + r.err);
  must(await page.locator("#xfa-panel").innerText(), /Your CSV is ready/, "result heading");
  eq(hits.clients, 1, "registrations");
  eq(hits.tools, 1, "tool calls");
  eq(hits.toolAuth[0], "Bearer xfa_standin_key", "tool call carried the new key");
  await ctx.close();
});

T("C3-2 registration 401: says sign-in is not available here yet, links developers page, no retry text", async () => {
  const { ctx, page, hits } = await visitor({ clients: [json(401, { error: { code: "unauthorized", message: "Missing or invalid OAuth bearer token" } })], tools: [OK_TOOL] });
  const r = await dropAndSettle(page);
  must(r.err || "", /needs you to sign in/, "401 text");
  must(r.err, /not available on this page yet/, "401 text");
  mustNot(r.err, /try again in a moment/i, "401 must not say retry");
  eq(r.href, "/developers/", "401 link");
  eq(hits.tools, 0, "no tool call without a key");
  await ctx.close();
});

T("C3-2 registration 429 with Retry-After: shows the real wait and a step", async () => {
  const { ctx, page } = await visitor({ clients: [json(429, { error: { code: "rate_limit_exceeded", message: "Too many registrations from this IP; try again later." } }, { "retry-after": "3000" })], tools: [OK_TOOL] });
  const r = await dropAndSettle(page);
  must(r.err || "", /about 50 minutes/, "429 wait");
  mustNot(r.err, /give it a minute/i, "429 must not promise a minute");
  eq(r.href, "/developers/", "429 link");
  await ctx.close();
});

T("C3-2 registration 429 without a readable Retry-After: says up to an hour", async () => {
  const { ctx, page } = await visitor({ clients: [json(429, { error: { message: "x" } })], tools: [OK_TOOL] });
  const r = await dropAndSettle(page);
  must(r.err || "", /up to an hour/, "429 fallback wait");
  await ctx.close();
});

T("C3-2 registration 503: says what happened and gives a mail link, after the automatic retries", async () => {
  const { ctx, page, hits } = await visitor({ clients: [json(503, { error: { message: "down" } })], tools: [OK_TOOL] });
  const r = await dropAndSettle(page);
  must(r.err || "", /problem starting your session/, "5xx text");
  must(r.err, /email us/i, "5xx next step");
  eq(r.href, "mailto:support@xlsx-for-ai.dev", "5xx link");
  eq(hits.clients, 3, "xfetch retried registration 3 times");
  await ctx.close();
});

T("C3-3 tool 400 shows the server's own reason (password-protected file)", async () => {
  const reason = "This file is password-protected. Remove the password in Excel (File → Info → Protect Workbook) and re-upload.";
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [json(400, { error: { code: "encrypted_workbook", message: reason } })] });
  const r = await dropAndSettle(page);
  must(r.err || "", /password-protected\. Remove the password in Excel/, "server reason shown");
  mustNot(r.err, /error 400/i, "no bare status");
  await ctx.close();
});

T("C3-3 tool 400 with no reason: a plain sentence with a step, never 'error N' alone", async () => {
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [{ status: 400, contentType: "text/plain", body: "" }] });
  const r = await dropAndSettle(page);
  must(r.err || "", /couldn’t process that file/, "fallback sentence");
  must(r.err, /save it again as \.xlsx or \.csv/, "fallback next step");
  mustNot(r.err, /\(error 400\)/, "old text");
  await ctx.close();
});

T("C3-3 tool 402 shows the server's explanation", async () => {
  const msg = "You've used your 10 free files — subscribe to Xlsx Pro ($25/yr) for 10,000 files/month.";
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [json(402, { error: { code: "upgrade_required", message: msg } })] });
  const r = await dropAndSettle(page);
  must(r.err || "", /subscribe to Xlsx Pro/, "402 reason");
  await ctx.close();
});

T("C3-4 a file over the page's own limit: plain statement, real limits, route for bigger files, no pay hint", async () => {
  const { ctx, page, hits } = await visitor({ clients: [OK_KEY], tools: [OK_TOOL] });
  const r = await dropAndSettle(page, { name: "big.xlsx", mimeType: "application/octet-stream", buffer: Buffer.alloc(11 * 1024 * 1024) });
  must(r.err || "", /over the 10 MB this page accepts/, "page limit stated as the page's own");
  must(r.err, /\.xlsx 100 MB, \.csv 200 MB, \.xls 100 MB, \.xlsb 10 MB/, "real limits");
  must(r.err, /API or the assistant connector/, "route for bigger files");
  mustNot(r.err, /free web tool|upgrade|pay|paid|plan/i, "no hint that paying raises the limit");
  eq(r.href, "/large-files/", "link");
  eq(hits.tools, 0, "nothing sent");
  await ctx.close();
});

T("C3-4 idle page states its own 10 MB as a page limit and points to the API or connector", async () => {
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [OK_TOOL] });
  const t = await page.locator("#xfa-panel").innerText();
  must(t, /up to 10 MB on this page/, "idle limit");
  must(t, /use the API or the assistant connector/, "idle pointer");
  mustNot(t, /free web tool/i, "old wording");
  await ctx.close();
});

T("C3-4 server 413: server's reason plus split-or-convert and the large-files link, no upgrade", async () => {
  const msg = "File is 150 MB; the .xlsx limit is 100 MB.";
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [json(413, { error: { code: "file_too_large", message: msg } })] });
  const r = await dropAndSettle(page);
  must(r.err || "", /the \.xlsx limit is 100 MB/, "server reason");
  must(r.err, /Split it into smaller files or save it as \.csv/, "next step");
  mustNot(r.err, /upgrade|paid|10 MB limit for the free/i, "no pay hint");
  eq(r.href, "/large-files/", "link");
  await ctx.close();
});

T("C3-5 tool 429 with Retry-After 3000 shows the real wait", async () => {
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [json(429, { error: { message: "Per-key limit" } }, { "retry-after": "3000" })] });
  const r = await dropAndSettle(page);
  must(r.err || "", /about 50 minutes/, "real wait");
  mustNot(r.err, /give it a minute/i, "old wait");
  await ctx.close();
});

T("C3-5 tool 429 with no readable Retry-After shows the server's own text, not a fixed minute", async () => {
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [json(429, { error: { message: "Monthly file-processing limit reached — resets at the start of next UTC month." } })] });
  const r = await dropAndSettle(page);
  must(r.err || "", /resets at the start of next UTC month/, "server text");
  await ctx.close();
});

// XLS-3015 item 6: a Shopify tool page rides the same shared script, so the new error
// texts must render there too. No Shopify feature work; the page is only a second host
// for the shared script, driven with a Shopify export fixture and stand-in answers.
const SHOPIFY_PAGE = "/tools/shopify-amazon-feed/";
const SHOPIFY_FIXTURE = join(ROOT, "test/fixtures/pages/shopify-products-feed-golden.csv");

T("XLS-3015-6 Shopify tool page: registration 401 shows the sign-in text and the developers link", async () => {
  const { ctx, page, hits } = await visitor({
    path: SHOPIFY_PAGE,
    clients: [json(401, { error: { code: "unauthorized", message: "Missing or invalid OAuth bearer token" } })],
    tools: [OK_TOOL],
  });
  const r = await dropAndSettle(page, SHOPIFY_FIXTURE);
  must(r.err || "", /needs you to sign in/, "401 text");
  mustNot(r.err, /try again in a moment/i, "401 must not say retry");
  eq(r.href, "/developers/", "401 link");
  eq(hits.tools, 0, "no tool call without a key");
  await ctx.close();
});

T("XLS-3015-6 Shopify tool page: 429 with Retry-After 3000 shows the real wait", async () => {
  const { ctx, page } = await visitor({
    path: SHOPIFY_PAGE,
    clients: [OK_KEY],
    tools: [json(429, { error: { message: "Per-key limit" } }, { "retry-after": "3000" })],
  });
  const r = await dropAndSettle(page, SHOPIFY_FIXTURE);
  must(r.err || "", /about 50 minutes/, "real wait");
  mustNot(r.err, /give it a minute/i, "old wait");
  await ctx.close();
});

T("XLS-3015-6 Shopify tool page: a 400 shows the server's own reason, not a bare status", async () => {
  const reason = "This file is password-protected. Remove the password in Excel (File → Info → Protect Workbook) and re-upload.";
  const { ctx, page } = await visitor({
    path: SHOPIFY_PAGE,
    clients: [OK_KEY],
    tools: [json(400, { error: { code: "encrypted_workbook", message: reason } })],
  });
  const r = await dropAndSettle(page, SHOPIFY_FIXTURE);
  must(r.err || "", /password-protected\. Remove the password in Excel/, "server reason shown");
  mustNot(r.err, /error 400/i, "no bare status");
  await ctx.close();
});

// ---------------------------------------------------------------- page-text cases
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SIZES = [".xlsx", "100 MB", ".csv", "200 MB", ".xls", ".xlsb", "10 MB"];

T("C3-10 developers page does not send no-terminal hosts to another machine; describes the sign-in link", async () => {
  const t = read("developers/index.html");
  mustNot(t, /machine you control|on another machine|CI or any host with no terminal/i, "old instruction");
  must(t, /sign-in link shown right there in the assistant/, "sign-in link described");
  must(t, /nothing needs a second machine/, "no second machine");
});

T("C3-12 terms section 5 describes files, not size, and sells no size", async () => {
  const t = read("terms/index.html");
  const s5 = t.slice(t.indexOf("<h2>5. Fees</h2>"), t.indexOf("<h2>6."));
  must(s5, /500 files a month/, "free count");
  must(s5, /first 1,000 people who sign in/, "free cohort");
  must(s5, /10-file trial/, "trial");
  must(s5, /\$25 per year[^.]*10,000 files a month/, "paid");
  must(s5, /never by file size/, "not by size");
  must(s5, /not sold/, "size not sold");
  mustNot(s5, /larger than those free limits|covers larger files|within our free size limits/, "retired model");
});

T("C3-12 large-files page states the limits, what to do, and the existing contact route", async () => {
  const t = read("large-files/index.html");
  for (const s of SIZES) must(t, new RegExp(s.replace(/\./g, "\\.")), "limit " + s);
  must(t, /Split it/, "split");
  must(t, /Convert it/, "convert");
  must(t, /mailto:support@xlsx-for-ai\.dev/, "existing contact route");
  mustNot(t, /going up here shortly|weighing dedicated|stays free/i, "dead-end text");
  mustNot(t, /<iframe/i, "no form backend invented");
});

T("XLS-3006-6 home and developers limits text matches the plans", async () => {
  for (const p of ["index.html", "developers/index.html"]) {
    const t = read(p);
    mustNot(t, /no paid tier|10,000 calls|10 MB per file|email link|magic link|sign in by email/i, p + " old limits text");
    must(t, /500 files a month/, p + " free plan");
    must(t, /\$25 a year for 10,000 files a month/, p + " paid plan");
    must(t, /\.xlsx 100 MB, \.csv 200 MB, \.xls 100 MB, \.xlsb 10 MB, (any )?other types? 10 MB/, p + " size limits");
  }
});

async function siteFiles(dir = ROOT, out = []) {
  for (const n of await readdir(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = join(dir, n);
    if ((await stat(p)).isDirectory()) await siteFiles(p, out);
    else if (/\.(html|js|xml|txt)$/.test(n)) out.push(p);
  }
  return out;
}

T("XLS-3006-7 no page carries the 2026-11-06 date; notice-before-change is stated instead", async () => {
  const bad = [];
  for (const f of await siteFiles()) if (/2026-11-06|November 6|Nov 6/.test(readFileSync(f, "utf8"))) bad.push(f.replace(ROOT + "/", ""));
  if (bad.length) throw new Error("date still on: " + bad.join(", "));
  for (const p of ["index.html", "developers/index.html"]) must(read(p), /signing in is recommended/i, p + " recommendation");
  must(read("developers/index.html"), /give notice before anything about those keys changes/, "notice promise");
});

T("XLS-3006-8 hosted connector address is on developers and home; no page uses /mcp/claude", async () => {
  must(read("developers/index.html"), /https:\/\/api\.xlsx-for-ai\.dev\/mcp<\/code>/, "developers address");
  must(read("developers/index.html"), /Add custom connector/, "developers steps");
  must(read("index.html"), /https:\/\/api\.xlsx-for-ai\.dev\/mcp<\/code>/, "home pointer");
  must(read("google-sheets-to-excel/index.html"), /https:\/\/api\.xlsx-for-ai\.dev\/mcp<\/code>/, "google-sheets-to-excel address");
  const bad = [];
  for (const f of await siteFiles()) if (/xlsx-for-ai\.dev\/mcp\/claude/.test(readFileSync(f, "utf8"))) bad.push(f.replace(ROOT + "/", ""));
  if (bad.length) throw new Error("/mcp/claude still on: " + bad.join(", "));
});

T("C3-15 page-walk script does not register a production account unless told to", async () => {
  const src = read("scripts/dod-page-walk.mjs");
  const guard = src.indexOf('"--register-prod-key"');
  const post = src.indexOf("api.xlsx-for-ai.dev/api/v1/clients");
  if (guard < 0 || post < 0 || guard > post) throw new Error("registration is not behind the explicit flag");
  const cache = join(ROOT, "node_modules", ".xfa-page-walk-key");
  if (existsSync(cache)) return; // a cached key would let the script go on to the live site; the source check above stands
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/dod-page-walk.mjs"), "XLS-195"], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
  eq(r.status, 2, "exit code (did not run)");
  must(r.stderr, /Nothing was registered/, "says nothing was registered");
});

T("XLS-3015-4 page-walk usage text names the --register-prod-key flag", async () => {
  const src = read("scripts/dod-page-walk.mjs");
  must(src, /usage: node scripts\/dod-page-walk\.mjs[^;]*--register-prod-key/, "usage line in source");
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/dod-page-walk.mjs")], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
  eq(r.status, 2, "exit code (did not run)");
  must(r.stderr, /--register-prod-key/, "usage printed at run time names the flag");
});

T("XLS-3015-5 shell.js has no per-page maxBytes option; every page still shows the shared 10 MB", async () => {
  mustNot(read("tools/shell.js"), /cfg\.maxBytes/, "per-page option");
  const bad = [];
  for (const f of await siteFiles()) if (/maxBytes\s*:/.test(readFileSync(f, "utf8"))) bad.push(f.replace(ROOT + "/", ""));
  if (bad.length) throw new Error("a page still sets maxBytes: " + bad.join(", "));
  const { ctx, page } = await visitor({ clients: [OK_KEY], tools: [OK_TOOL] });
  must(await page.locator("#xfa-panel").innerText(), /up to 10 MB on this page/, "shared limit shown");
  await ctx.close();
});

T("XLS-3015-b the support address on the terms page is the one the server texts use", async () => {
  must(read("terms/index.html"), /mailto:support@xlsx-for-ai\.dev">support@xlsx-for-ai\.dev</, "terms address");
});

// ---------------------------------------------------------------- run
const server = staticServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
base = `http://127.0.0.1:${server.address().port}`;
try { browser = await chromium.launch(); }
catch (e) { server.close(); console.error("DID NOT RUN — could not launch chromium: " + (e && e.message)); process.exit(2); }

let pass = 0; const failed = [];
for (const { id, fn } of tests) {
  try { await fn(); pass++; console.log("PASS  " + id); }
  catch (e) { failed.push(id); console.log("FAIL  " + id + "\n      " + String(e && e.message).split("\n")[0]); }
}
if (leaks.length) { failed.push("no request left the machine"); console.log("FAIL  requests that tried to leave: " + [...new Set(leaks)].join(", ")); }
else { pass++; console.log("PASS  no request left the machine (production API never called)"); }
await browser.close();
server.close();
console.log(`\n${pass} passed, ${failed.length} failed, ${pass + failed.length} total`);
process.exit(failed.length ? 1 : 0);
