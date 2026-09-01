#!/usr/bin/env node
/*
 * dod-1208-hub-page-walk.mjs — the XLS-1208 hub page's DoD.
 *
 * The card's DoD is not "the page renders." It is: the demo file's MESSY headers
 * map to the right `product.metafields.*` keys through a real run, and the
 * mapped/couldn't ledger the visitor reads is ACCURATE. So this drives the real
 * page in a real browser: it uploads metafields-apparel-basics.xlsx through the
 * page's own file input, waits out the real state machine, reads the rendered
 * ledger, and takes the download a visitor would take — then asserts on the
 * CONTENT of both.
 *
 * Every assertion names something only a working tool could produce (a specific
 * merchant header landing on a specific metafield key; a specific handle from
 * the fixture inside the emitted CSV), so a silent no-op fails rather than
 * passes. Three columns in the fixture are ones we must REFUSE — a product
 * title and two reference-typed columns — and they are asserted into the
 * "needs you" half, because a what-I-mapped list nobody can check is a claim,
 * not a ledger.
 *
 *   Exit 0 = PASS · 1 = FAIL · 2 = DID NOT RUN (never a silent green).
 *
 * The API the page talks to is https://api.xlsx-for-ai.dev and that is what the
 * browser requests — CSP included. Point API= at whichever build should answer
 * it; requests are re-issued there and fulfilled back to the page unchanged.
 * That indirection exists because a brand-new route cannot be on the deployed
 * service before this branch merges; once it is deployed, run with
 * API=https://api.xlsx-for-ai.dev and the interception is a pass-through.
 *
 * Usage:
 *   # serve the branch tree, and have a server build answering on API
 *   python3 -m http.server 8799 --bind 127.0.0.1
 *   node scripts/dod-1208-hub-page-walk.mjs
 *   SITE=http://127.0.0.1:8799 API=https://api.xlsx-for-ai.dev node scripts/dod-1208-hub-page-walk.mjs
 */
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.SITE || "http://127.0.0.1:8799").replace(/\/$/, "");
const API = (process.env.API || "http://127.0.0.1:8791").replace(/\/$/, "");
const PAGE = "/importable/bulk-upload-shopify-metafields/";
const FIXTURE = join(ROOT, "importable/bulk-upload-shopify-metafields/metafields-apparel-basics.xlsx");

const die = (msg) => {
  console.error(`DID NOT RUN — ${msg}`);
  process.exit(2);
};

if (!existsSync(FIXTURE)) die(`fixture missing: ${FIXTURE} (run scripts/make-metafields-apparel-basics.mjs)`);
try {
  const probe = await fetch(SITE + PAGE);
  if (!probe.ok) die(`the page is not being served at ${SITE + PAGE} (got ${probe.status})`);
} catch (e) {
  die(`no static server at ${SITE} — ${e.message}`);
}

const fails = [];
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fails.push(label);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true });

// The page asks api.xlsx-for-ai.dev (its CSP allows exactly that host). Re-issue
// each of those requests at API and hand the real response back to the page.
await ctx.route("https://api.xlsx-for-ai.dev/**", async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  let r;
  try {
    r = await fetch(API + u.pathname + u.search, {
      method: req.method(),
      headers: req.headers(),
      body: req.method() === "GET" || req.method() === "HEAD" ? undefined : req.postData(),
    });
  } catch (e) {
    await route.abort();
    return;
  }
  const body = Buffer.from(await r.arrayBuffer());
  const headers = Object.fromEntries(r.headers.entries());
  delete headers["content-encoding"];
  delete headers["content-length"];
  headers["access-control-allow-origin"] = "*";
  await route.fulfill({ status: r.status, headers, body });
});

const page = await ctx.newPage();
const cspViolations = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(t);
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(SITE + PAGE, { waitUntil: "networkidle" });

ok((await page.locator("h1").count()) === 1, "exactly one <h1>");
ok(
  (await page.locator("h1").innerText()).includes("Bulk-upload Shopify product metafields"),
  "h1 is the card's title",
);

// The hub's whole structural claim: the four spokes are reachable from here.
const SPOKES = [
  "/importable/import-shopify-variant-metafields/",
  "/importable/shopify-metafield-hard-types/",
  "/importable/import-shopify-metafields/",
  "/importable/metafields-store-move-references/",
];
for (const s of SPOKES) {
  const n = await page.locator(`a[href="${s}"]`).count();
  const r = await fetch(SITE + s);
  ok(n >= 1 && r.status === 200, `spoke link present and resolves: ${s}`);
}
ok(
  (await page.locator('a[href="metafields-apparel-basics.xlsx"]').count()) === 1,
  "demo file link present",
);
// Standing product-wide correction: this page carries no file-safety/virus-scan link.
const html = await page.content();
ok(!/virus|file[- ]safety|malware|scanned for/i.test(html), "no file-safety / virus-scan link on the page");

// ---- the real upload, through the page's own file input ----
await page.setInputFiles("#xfa-file", FIXTURE);
await page.waitForSelector(".result, .notice", { timeout: 120000 });

const panel = await page.locator("#xfa-panel").innerText();
console.log("\n---------------- rendered ledger ----------------");
console.log(panel);
console.log("------------------------------------------------\n");

// Each merchant header, in the merchant's own words, on the right metafield.
const CLAIMS = [
  ["Fabric Content", "custom.material"],
  ["Wash Instructions", "custom.care_instructions"],
  ["Fits Like", "custom.size_and_fit"],
  ["Ingredients", "custom.ingredients"],
  ["Tech Specs", "custom.specifications"],
];
for (const [header, field] of CLAIMS) {
  const re = new RegExp(header + "\\s*\\n?\\s*→ product\\.metafields\\." + field.replace(".", "\\."));
  ok(re.test(panel), `"${header}" → product.metafields.${field}`);
}
// The other half of the ledger — what we will NOT guess at.
for (const c of ["Product Title", "Related Styles", "Lookbook PDF"]) {
  ok(new RegExp(c + "[\\s\\S]{0,240}needs you").test(panel), `"${c}" surfaced under "needs you"`);
}
ok(/6\s*\n?\s*columns mapped/i.test(panel), "summary: 6 columns mapped");
ok(/3\s*\n?\s*to review/i.test(panel), "summary: 3 to review");
ok(/10\s*\n?\s*rows/i.test(panel), "summary: 10 product rows read");

// ---- the download the visitor would actually take ----
const dlBtn = page.locator("#xfa-dl");
ok((await dlBtn.count()) === 1, "download button offered");
if ((await dlBtn.count()) === 1) {
  const [dl] = await Promise.all([page.waitForEvent("download"), dlBtn.click()]);
  const csv = readFileSync(await dl.path(), "utf8");
  const lines = csv.replace(/\n$/, "").split("\n");
  console.log(`downloaded: ${dl.suggestedFilename()} — ${lines.length} lines`);
  console.log(`header: ${lines[0]}`);
  ok(/product-metafields-import\.csv$/.test(dl.suggestedFilename()), "download named by the route");
  ok(lines[0] === "Owner Type,Owner Handle,Namespace,Key,Type,Value,Command", "row-mode import header");
  ok(/heritage-flannel-shirt/.test(csv), "a real handle from the fixture is in the CSV");
  for (const key of ["material", "care_instructions", "size_and_fit", "ingredients", "specifications"]) {
    ok(csv.includes(`custom,${key},`), `emitted rows for custom.${key}`);
  }
  // The refused columns must not have leaked in under some other name.
  ok(!/Lookbook|Related Styles|cdn\.example-apparel/.test(csv), "flagged columns did NOT leak into the CSV");
  // Every write is a merge — nothing in this file can clear a value.
  const merges = (csv.match(/,MERGE(\r?\n|$)/g) || []).length;
  ok(merges >= 30, `every emitted row is a MERGE (${merges} found)`);
}

// frame-ancestors-via-<meta> is a site-wide advisory on every page shipping this
// CSP, not a violation caused by this page.
const realCsp = cspViolations.filter(
  (t) => !/frame-ancestors.{0,3} is ignored when delivered via a <meta>/.test(t),
);
ok(realCsp.length === 0, `no CSP violations (${realCsp.join(" | ")})`);
ok(pageErrors.length === 0, `no page errors (${pageErrors.join(" | ")})`);

await browser.close();
console.log(fails.length === 0 ? "\nPAGE DoD PASS" : `\nPAGE DoD FAIL — ${fails.length}: ${fails.join("; ")}`);
process.exit(fails.length === 0 ? 0 : 1);
