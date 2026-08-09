#!/usr/bin/env node
/*
 * dod-xls809-feed-printful.mjs — XLS-809 register-before-land DoD for the free
 * Printful → Shopify products-import web tool (importable/feed-printful/).
 *
 * The load-bearing SPEC rule (§1/§4.3) is: advertise ONLY a capability that
 * runs as a live free web tool TODAY. This check proves exactly that, but in a
 * form that cannot self-flake on a third party:
 *
 *   1. cold pole — the page is not yet on site main → INDETERMINATE (exit 6),
 *      NEVER a false red. Register-before-land relies on this: the row lands
 *      before the page does.
 *   2. static wiring (deterministic, from disk) — page.js drives the two
 *      printful tool routes through the shared shell, and the hub links it.
 *   3. live capability proof — POST a CANNED Printful catalog snapshot (checked
 *      into test/fixtures) to the deployed printful_catalog_import route and
 *      assert it returns a real Shopify products CSV (Handle/Title header + a
 *      Printful-derived -pf<id> variant row). The snapshot is canned, so this
 *      leans on NEITHER Printful's live catalog API NOR the AI mapper — only on
 *      "is our own tool deployed and does it still transform". A 404 = the tool
 *      was pulled = the page is false advertising = RED. A network error / 5xx
 *      = infra = INDETERMINATE, not RED, so the gate does not self-flake.
 *
 * (The Printful-live pull half — printful_catalog_pull against Printful's public
 * catalog — is evidenced once at build time in the handoff, not baked into this
 * standing gate, precisely because it is openWorld and would flake here.)
 *
 * Exit 0 = PASS · 1 = RED · 6 = INDETERMINATE / cold pole (never a green, never
 * a false red).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const die6 = (m) => { console.error(`DID NOT RUN — ${m}`); process.exit(6); };
const red = (m) => { console.error(`RED — ${m}`); process.exit(1); };

const pageHtml = join(ROOT, "importable/feed-printful/index.html");
const pageJs = join(ROOT, "importable/feed-printful/page.js");
const hub = join(ROOT, "importable/index.html");
const fixture = join(ROOT, "test/fixtures/pages/printful-catalog-snapshot.min.json");

// ---- 1. cold pole: subject not landed on site main → INDETERMINATE ---------
if (!existsSync(pageJs) || !existsSync(pageHtml)) {
  die6("XLS-809 feed-printful page not landed on site main (cold pole)");
}
if (!existsSync(fixture)) die6("canned Printful snapshot fixture not landed (cold pole)");
// The hub is core site infrastructure; if the tree lacks it, that is an
// incomplete checkout, not a capability verdict → INDETERMINATE, never a crash.
if (!existsSync(hub)) die6("hub importable/index.html absent from tree (cold pole)");

// existsSync above is a fast pre-flight, not a guarantee: a read can still throw
// (EPERM/EBUSY, or a TOCTOU unlink between the check and the read). A throw here
// is an incomplete/hostile checkout, NOT a capability verdict → INDETERMINATE,
// never an uncaught crash that CI would read as a false red.
const readOr6 = (p, label) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    die6(`${label} unreadable after existsSync (infra/TOCTOU, not a capability verdict)`);
  }
};

// ---- 2. static wiring (deterministic) --------------------------------------
const js = readOr6(pageJs, "feed-printful/page.js");
for (const marker of ["printful_catalog_pull", "printful_catalog_import", "noFile", "XFA_SHOPIFY.toViewModel"]) {
  if (!js.includes(marker)) red(`feed-printful/page.js missing wiring marker: ${marker}`);
}
const hubHtml = readOr6(hub, "hub importable/index.html");
if (!hubHtml.includes('href="/importable/feed-printful/"')) {
  red("hub importable/index.html does not link /importable/feed-printful/");
}

// ---- 3. live capability proof (canned snapshot; no Printful / no AI) --------
// The endpoint is operator/runner config (XLS809_API exists only so an operator can
// point the gate at a staging host), not untrusted input — but constrain it anyway:
// a network gate must only ever reach the real API or an explicitly allowed local
// host, never an arbitrary URL. An off-allowlist or malformed override is a
// misconfiguration, not a capability verdict → INDETERMINATE, never a live call.
const API_ALLOWLIST = new Set(["api.xlsx-for-ai.dev", "localhost", "127.0.0.1"]);
const API = (process.env.XLS809_API || "https://api.xlsx-for-ai.dev").replace(/\/$/, "");
let apiUrl;
try {
  apiUrl = new URL(API);
} catch {
  die6("XLS809_API is not a valid URL — misconfiguration, not a capability verdict");
}
// Complete, single-pass validation of the operator-supplied endpoint. Every failure
// is a misconfiguration → INDETERMINATE (never a live call, never a false RED):
//   • host on the allowlist,
//   • https for the public host (http tolerated only for a local dev server),
//   • origin-only — a path/query/hash would corrupt the `${API}${path}` join.
const isLocal = apiUrl.hostname === "localhost" || apiUrl.hostname === "127.0.0.1";
if (!API_ALLOWLIST.has(apiUrl.hostname)) {
  die6(`XLS809_API host ${apiUrl.hostname} is not on the allowlist — refusing to call an arbitrary endpoint`);
}
if (apiUrl.protocol !== "https:" && !(isLocal && apiUrl.protocol === "http:")) {
  die6("XLS809_API must use https (http allowed only for localhost) — misconfiguration, not a capability verdict");
}
if (apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
  die6("XLS809_API must be a bare origin with no path/query/hash — misconfiguration, not a capability verdict");
}
const snapshot_b64 = Buffer.from(readOr6(fixture, "canned Printful snapshot")).toString("base64");

// The gate always sends the ~7 KB canned snapshot, so a healthy import response is
// small; cap the decoded payload so a pathological/hostile server response cannot
// balloon memory. An oversized body is a server anomaly, not a capability verdict.
const MAX_FILE_B64 = 8 * 1024 * 1024; // 8 MB base64 — orders of magnitude over a real catalog CSV

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bounded retry-with-backoff over transient failures so a single infra blip does
// not exit 6 (or 1) on the first try. Only the error CLASS name (e.name) is ever
// logged — never e.message or any header/body — so no request-scoped value
// (least of all the Bearer api_key, which lives only in the header) can leak.
async function post(path, body, bearer, attempt = 1) {
  const MAX = 3;
  const headers = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    // Network failure / timeout is infra, not a capability verdict — retry, then die6.
    if (attempt < MAX) {
      await sleep(300 * 2 ** (attempt - 1));
      return post(path, body, bearer, attempt + 1);
    }
    die6(`api-server unreachable (${e && e.name}) — infra, not a capability failure`);
  }
  // Transient HTTP (5xx / 408 / 425 / 429): retry with backoff while attempts remain;
  // a persistent one falls through to transientOrPass at the call site.
  if (
    (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) &&
    attempt < MAX
  ) {
    await sleep(300 * 2 ** (attempt - 1));
    return post(path, body, bearer, attempt + 1);
  }
  return res;
}

// Parse a response body as JSON, classifying a 2xx-but-non-JSON body (e.g. a
// proxy/CDN error page) as INDETERMINATE infra rather than letting an uncaught
// throw exit 1 as a false RED.
async function asJson(res, what) {
  try {
    return await res.json();
  } catch {
    // No error detail is interpolated — a non-JSON body is classified by status,
    // and its text must never reach a log line.
    die6(`${what} returned a non-JSON body — infra, not a capability verdict`);
  }
}

// Single classification boundary for transient/infra HTTP statuses: 5xx plus
// the transient 4xx (408 Request Timeout, 425 Too Early, 429 Too Many Requests
// — the anonymous key is rate-limited, so 429 in CI is infra, not a capability
// verdict). Everything left as non-ok after this (400/401/403/404…) is a
// genuine RED handled by the caller.
function transientOrPass(res, what) {
  if (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) {
    die6(`${what} ${res.status} — transient/infra, not a capability verdict`);
  }
}

const run = async () => {
  const cres = await post("/api/v1/clients", { client_version: "dod-xls809/1.0", platform: "web" });
  transientOrPass(cres, "client mint");
  if (!cres.ok) red(`anonymous client mint failed (${cres.status})`);
  const key = (await asJson(cres, "client mint")).api_key;
  if (!key) red("client mint returned no api_key");

  const ires = await post("/api/v1/tools/printful_catalog_import", { snapshot_b64, filename: "dod-xls809" }, key);
  if (ires.status === 404) red("printful_catalog_import is NOT deployed (404) — capability not web-deliverable");
  transientOrPass(ires, "printful_catalog_import");
  if (!ires.ok) red(`printful_catalog_import failed (${ires.status})`);

  const j = await asJson(ires, "printful_catalog_import");
  const b64 = j && j._meta && j._meta.file_b64;
  // A non-string (or empty) file_b64 from a 200 is a malformed capability
  // response, not a crash: guard the type before Buffer.from, which throws on
  // a non-string argument.
  if (typeof b64 !== "string" || b64.length === 0) red("printful_catalog_import returned no/invalid _meta.file_b64");
  if (b64.length > MAX_FILE_B64) {
    die6(`printful_catalog_import returned an oversized payload (${b64.length}B base64) — server anomaly, not a capability verdict`);
  }
  const csv = Buffer.from(b64, "base64").toString("utf8").split(/\r?\n/);
  // Strip a UTF-8 BOM the CSV writer may prepend, and match Handle/Title on comma
  // boundaries so a column like "PageTitle" cannot false-green the "Title" check.
  // Deliberately NO CSV column-splitting here \u2014 quoted fields with embedded commas
  // would mis-index a naive split. The two assertions this gate needs are both
  // split-free, and therefore immune to quoting anywhere in a row:
  //   \u2022 header: Shopify's fixed column names (Handle, Title) carry no commas, so
  //     match them as whole comma-delimited FIELDS via boundary regex.
  //   \u2022 rows: Handle is column 0 (start of line) and Shopify handles are slug-safe
  //     (lowercase/digits/hyphens \u2014 never a comma or quote), so a Printful-derived
  //     handle appears as "-pf<id>" in the FIRST field. Anchor to it; [^,]* stays
  //     inside the Handle field regardless of how later columns are quoted.
  const header = (csv[0] || "").replace(/^\uFEFF/, "");
  if (!/(^|,)Handle(,|$)/.test(header) || !/(^|,)Title(,|$)/.test(header)) {
    red(`CSV header missing Handle/Title: ${header.slice(0, 120)}`);
  }
  const dataRows = csv.slice(1).filter((r) => r.length > 0);
  const hasPfHandle = dataRows.some((r) => /^[^,]*-pf\d+/.test(r));
  if (dataRows.length < 1 || !hasPfHandle) {
    red("CSV has no Printful-derived variant row (expected a -pf<id> Handle in the first column)");
  }

  console.log(`PASS — XLS-809 feed-printful wired + printful_catalog_import live (CSV ${dataRows.length} data rows, Handle/Title present)`);
  process.exit(0);
};

// Never leave run() as a bare unhandled rejection: on modern Node that exits
// non-zero, which CI would misread as a RED. Any unclassified async throw is a
// gate/infra fault, not a capability verdict → INDETERMINATE.
run().catch((e) => die6(`unexpected error in DoD gate (${e && e.name}) — not a capability verdict`));
