/**
 * plan-wording.test.mjs — XLS-2048. The home page, the developers page and the terms page state
 * the same plan names, limits, price and counts, and they are the ones in plan-copy.json (the
 * list the server's 402 text is written from). Fails if any page drifts or brings back a
 * retired phrase. Includes a negative control: the stale home page text must be caught.
 *
 * Run: node test/pages/plan-wording.test.mjs   (npm test runs it too)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPY = JSON.parse(readFileSync(join(ROOT, "plan-copy.json"), "utf8"));
const PAGES = ["index.html", "developers/index.html", "terms/index.html"];

// Plain text of a page: tags gone, entities folded, whitespace collapsed.
function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

// Returns the list of problems with one page's text (empty = clean).
export function planProblems(page, t) {
  const bad = [];
  for (const k of ["freePlanName", "paidPlanName", "freeLimit", "freeCohort", "trial", "paidOffer"]) {
    if (!t.includes(COPY[k])) bad.push(`${page}: missing "${COPY[k]}"`);
  }
  for (const r of COPY.retired) {
    if (t.includes(r)) bad.push(`${page}: has retired "${r}"`);
  }
  return bad;
}

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`);
}

for (const p of PAGES) {
  const html = readFileSync(join(ROOT, p), "utf8");
  const t = text(html);
  const bad = planProblems(p, t);
  check(`${p} states the plans as plan-copy.json does`, bad.length === 0, bad.join("; "));
  // the raw markup (meta description, JSON-LD) too, so a stale phrase cannot hide in a tag
  const raw = COPY.retired.filter((r) => html.includes(r));
  check(`${p} markup has no retired phrase`, raw.length === 0, raw.join(", "));
}

const home = text(readFileSync(join(ROOT, "index.html"), "utf8"));
const dev = text(readFileSync(join(ROOT, "developers/index.html"), "utf8"));
check("home states the tool count", home.includes(`${COPY.toolCount} tools`));
check("developers page states the same tool count", dev.includes(`${COPY.toolCount} tools`));
check(
  "home states the function count",
  home.includes(`${COPY.functionCount} Excel functions`) && home.includes(`${COPY.sheetsOnlyCount} Google Sheets-only`),
);
const listed = new Set(
  [...readFileSync(join(ROOT, "index.html"), "utf8").matchAll(/<p class="name"><code>([a-z_0-9]+)<\/code>/g)].map((m) => m[1]),
);
check(`home lists exactly ${COPY.toolCount} tools`, listed.size === COPY.toolCount, `lists ${listed.size}`);

// Negative control: the text that was live before this fix must be reported.
const stale =
  "Free to start — all 50 tools. a free plan of 500 files a month for the first 1,000 people who sign in, otherwise a 10-file trial and then $25 a year for 10,000 files a month. 10,000 calls";
const staleBad = planProblems("stale-home", text(stale));
check("negative control: stale home text is caught", staleBad.length >= 3, staleBad.join("; "));
check("negative control: terms wording from before is caught", planProblems("old-terms", "US $25 per year, billed annually, for 10,000 files a month").length > 0);

if (failed) {
  console.log(`${failed} FAIL`);
  process.exit(1);
}
console.log("ALL PASS");
