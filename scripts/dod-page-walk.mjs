#!/usr/bin/env node
/*
 * dod-page-walk.mjs — the web-tool pages' DoD check. Drives a REAL page in a
 * REAL browser and asserts the tool ACTUALLY DID THE WORK.
 *
 * The card's DoD says "upload a real .xlsx through the LIVE page URL". An HTTP
 * 200 does not satisfy that: it proves the page renders and says nothing about
 * whether the tool ran. A page can render, spin, and hand back an empty file.
 * So this uploads a fixture through the page's own file input, waits out the
 * real state machine, takes the download the visitor would take, and asserts on
 * the CONTENT — the fixture's own rows must come back out.
 *
 * Asserting on fixture content is what makes the check able to go RED. Every
 * case's expectations are drawn from a fixture that carries the defect its tool
 * is supposed to find (see make-page-fixtures.mjs), so a silent no-op fails.
 *
 * Five of the pages produce no download at all — their result IS the rendered
 * findings/preview-grid. Those assert on the panel, with the same rule: the
 * assertion must name something only a working tool could produce.
 *
 * Usage:  node scripts/dod-page-walk.mjs <case-id>        # e.g. XLS-195
 *         node scripts/dod-page-walk.mjs --list
 *         BASE_URL=http://localhost:8000 node scripts/dod-page-walk.mjs XLS-195
 *
 * Exit 0 = PASS · 1 = FAIL · 2 = DID NOT RUN (never a green).
 *
 * An unknown case-id exits 2, never 0. A runner that "passes" when it matched
 * nothing is the NAME_FILTER_UNGUARDED defect — a check that cannot fail for
 * your card is not your card's check.
 */
import { chromium } from "playwright";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "../test/pages/cases.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = (process.env.BASE_URL || "https://xlsx-for-ai.dev").replace(/\/$/, "");
const NAV_MS = 45000;
const RUN_MS = 120000; // formula eval + a healer cure on a live server is slow

const die = (msg) => {
  console.error(`DID NOT RUN — ${msg}`);
  process.exit(2);
};

const arg = process.argv[2];
if (arg === "--list") {
  for (const [id, c] of Object.entries(CASES)) console.log(`${id}\t${c.path}\t${c.what}`);
  process.exit(0);
}
if (!arg) die("usage: node scripts/dod-page-walk.mjs <case-id> | --list");

// The existence assertion. A case-id we don't know is a DID-NOT-RUN, not a pass.
const kase = CASES[arg];
if (!kase) die(`unknown case "${arg}" — known: ${Object.keys(CASES).join(", ")}`);

const url = BASE_URL + kase.path;
const fixture = (f) => resolve(ROOT, "test/fixtures/pages", f);

// A downloaded .xlsx is bytes; flatten it to text so a content assertion can be
// written the same way for every case regardless of the output format.
async function flatten(path, name) {
  if (/\.xlsx?$|\.xlsm$/i.test(name)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const lines = [];
    wb.eachSheet((ws) => {
      ws.eachRow((row) => lines.push(row.values.slice(1).map((v) => (v == null ? "" : String(v.text ?? v.result ?? v))).join(" | ")));
    });
    return { text: lines.join("\n"), rows: lines.length };
  }
  const text = readFileSync(path, "utf8");
  return { text, rows: text.trim() === "" ? 0 : text.trim().split("\n").length };
}

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
const fails = [];
let panelText = "";
let out = { text: "", rows: 0 };

try {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  if (!resp || resp.status() !== 200) die(`page HTTP ${resp ? resp.status() : "no-response"} at ${url}`);
  // see-inside is a meta-refresh stub; let the redirect settle before we look
  // for an upload widget, or we'd drive the stub and find nothing.
  await page.waitForLoadState("networkidle", { timeout: NAV_MS }).catch(() => {});

  // ---- upload ----------------------------------------------------------
  if (kase.mode === "dual") {
    await page.setInputFiles("#xfa-drop-a input[type=file]", fixture(kase.fixtures[0]), { timeout: 20000 });
    await page.setInputFiles("#xfa-drop-b input[type=file]", fixture(kase.fixtures[1]), { timeout: 20000 });
    await page.locator("#xfa-compare").click({ timeout: 10000 });
  } else {
    await page.setInputFiles("#xfa-file", fixture(kase.fixtures[0]), { timeout: 20000 });
  }

  // No signup, no paywall: the tool must be usable with no credentials at all.
  // Scoped to the tool panel — the site nav/footer is not a wall, and checking
  // the whole body would fail pages for words that never block anyone.
  const panelNow = (await page.textContent("#xfa-panel").catch(() => "")) || "";
  for (const wall of ["Sign in", "Sign up", "Log in", "Upgrade", "Start free trial", "Enter your card"]) {
    if (panelNow.includes(wall)) fails.push(`signup/paywall wall in the tool panel: "${wall}"`);
  }

  // ---- params form (filter-rows, run-any-tool) -------------------------
  // The shell reads the file, discovers the columns/tools, renders a form, and
  // only then runs. Fill the form the way a visitor would, then press Run.
  if (kase.mode === "params") {
    await page.locator("#xfa-run").waitFor({ state: "visible", timeout: RUN_MS });
    for (const step of kase.form || []) {
      const el = page.locator(step.selector).first();
      await el.waitFor({ state: "visible", timeout: 30000 });
      if (step.select != null) await el.selectOption(step.select, { timeout: 15000 });
      else await el.fill(String(step.fill), { timeout: 15000 });
      // A reload:true select re-renders the whole form (run-any-tool's tool
      // picker); wait for the re-render before touching the next field.
      if (step.rerenders) await page.locator("#xfa-run").waitFor({ state: "visible", timeout: 30000 });
    }
    await page.locator("#xfa-run").click({ timeout: 10000 });
  }

  // ---- wait out the real state machine ---------------------------------
  // The shell ends in exactly one of two terminal views: a result (which always
  // carries #xfa-again) or an error card (.notice.err). Waiting for only the
  // happy one would hang on failure and report DID-NOT-RUN for what is really a
  // FAIL, so wait for either and tell them apart.
  const done = page.locator("#xfa-again, .notice.err");
  await done.first().waitFor({ state: "visible", timeout: RUN_MS });

  const err = page.locator(".notice.err");
  if (await err.count()) {
    const msg = ((await err.first().textContent()) || "").trim();
    console.error(`PAGE-DOD-RESULT verdict=FAIL url=${url}`);
    console.error(`  ✗ the page surfaced an error: ${msg}`);
    await browser.close();
    process.exit(1);
  }

  panelText = (await page.textContent("#xfa-panel")) || "";

  // Element-scoped assertions (XLS-217's preview grid): the values must be in
  // THAT element, not merely somewhere on the page. A grid that failed to render
  // while the same text appears in a findings list is still a broken grid.
  for (const { selector, values } of kase.expectIn || []) {
    const el = page.locator(selector);
    if (!(await el.count())) {
      fails.push(`expected element not rendered: ${selector}`);
      continue;
    }
    const text = (await el.first().textContent()) || "";
    for (const want of values) {
      if (!text.toLowerCase().includes(String(want).toLowerCase())) {
        fails.push(`${selector} missing: ${JSON.stringify(want)}`);
      }
    }
  }

  // ---- take the download the visitor would take ------------------------
  if (kase.download) {
    const dl = page.locator("#xfa-dl");
    if (!(await dl.count())) {
      fails.push("no download offered — the page finished without producing a result file");
    } else {
      const [got] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        dl.click(),
      ]);
      out = await flatten(await got.path(), got.suggestedFilename());
      if (!out.text.trim()) fails.push("the downloaded file is EMPTY — the page handed back nothing");
    }
  } else if (await page.locator("#xfa-dl").count()) {
    // This page is not supposed to produce a file. If it started producing one,
    // the card's contract changed and the check should be re-derived, not
    // silently pass.
    fails.push("this page offered a download it is not supposed to produce");
  }
} catch (e) {
  console.error(`DID NOT RUN — ${String(e).split("\n")[0]}`);
  await browser.close();
  process.exit(2); // could-not-determine is NEVER a pass
}
await browser.close();

// ---- the assertions that can go red ------------------------------------
const has = (hay, needle) => hay.toLowerCase().includes(String(needle).toLowerCase());
for (const want of kase.expectPanel || []) {
  if (!has(panelText, want)) fails.push(`result panel missing: ${JSON.stringify(want)}`);
}
for (const no of kase.absentPanel || []) {
  if (has(panelText, no)) fails.push(`result panel should NOT contain: ${JSON.stringify(no)}`);
}
for (const want of kase.expectDownload || []) {
  if (!has(out.text, want)) fails.push(`downloaded output missing: ${JSON.stringify(want)}`);
}
for (const no of kase.absentDownload || []) {
  if (has(out.text, no)) fails.push(`downloaded output STILL CONTAINS: ${JSON.stringify(no)}`);
}
if (kase.expectRows != null && out.rows !== kase.expectRows) {
  fails.push(`downloaded output has ${out.rows} rows, expected ${kase.expectRows}`);
}
if (kase.expectLedger && !(/what we did/i.test(panelText) && /(didn.t touch|wasn.t changed)/i.test(panelText))) {
  // The ledger is a product promise ("we tell you what we did AND what we
  // didn't touch"), not decoration — a tool that silently mutates is the thing
  // we position against. Its absence is a real failure.
  fails.push("result-ledger missing (no 'what we did / what we didn't touch')");
}

console.log(`--- ${kase.what}`);
console.log(`--- panel (${panelText.length} chars) ---\n${panelText.slice(0, 400)}`);
if (kase.download) console.log(`--- download (${out.rows} rows) ---\n${out.text.slice(0, 300)}`);
if (fails.length) {
  console.error(`PAGE-DOD-RESULT verdict=FAIL case=${arg} url=${url}`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`PAGE-DOD-RESULT verdict=PASS case=${arg} url=${url} — real upload, real browser, output carried the fixture's own content`);
