/*
 * cases.mjs — one entry per web-tool page card. The runner (scripts/dod-page-walk.mjs)
 * drives the live page and asserts these.
 *
 * THE RULE EVERY CASE OBEYS: the assertion must name something ONLY A WORKING
 * TOOL COULD PRODUCE, drawn from the fixture's own content. Not "HTTP 200", not
 * "a download appeared" — a page that renders, spins, and hands back an empty
 * file satisfies both. Where the tool's job is REMOVAL (redaction), the sharpest
 * form is the reverse: assert the PII is ABSENT from the output, so a silent
 * no-op goes red.
 *
 * Each case is severable: it fails for its own card and only its own card. Two
 * cards may share a page (194 asserts the shared shell's ledger, 195 asserts the
 * CSV content) but never share an assertion — a check that cannot fail for YOUR
 * card is not your card's check.
 *
 * Fields:
 *   path            live URL path (the card's own URL — 202 deliberately drives
 *                   the /see-inside/ stub, redirect and all, because that is the
 *                   URL the card shipped)
 *   mode            single | dual | params
 *   fixtures        [file] (or [a, b] for dual), from test/fixtures/pages/
 *   form            params-mode form steps, filled the way a visitor would
 *   download        true = must offer a file · false = must NOT offer one
 *   expectPanel     substrings the rendered result must contain
 *   absentPanel     substrings it must NOT contain (the "doesn't over-report" arm)
 *   expectIn        [{selector, values}] — assert inside a specific element
 *   expectDownload  substrings the downloaded bytes must contain
 *   absentDownload  substrings the downloaded bytes must NOT contain
 *   expectRows      exact row count of the downloaded file
 *   expectLedger    the "what we did / what we didn't touch" promise must render
 */
export const CASES = {
  // --- XLS-193 — Fix my formula errors ------------------------------------
  // The fixture carries three real broken formulas (#REF! / #DIV/0! / #NAME?)
  // AND one healthy one (B5, =1+1). Both halves matter: the page must name the
  // three broken cells, and must NOT flag the healthy cell. "Flags everything"
  // is as useless as "flags nothing", and only the absent arm can tell them
  // apart.
  "XLS-193": {
    what: "fix formula errors — names the broken cells, spares the healthy one",
    path: "/tools/fix-formula-errors/",
    mode: "single",
    fixtures: ["formula-errors.xlsx"],
    download: false,
    expectPanel: ["B2", "#REF!", "B3", "#DIV/0!", "B4", "#NAME?"],
    absentPanel: ["B5"],
    redArm: { fixture: "rows.xlsx" }, // no formulas at all -> nothing to name
  },

  // --- XLS-194 — the shared shell + result-ledger (the design system) -----
  // Subject is the SHELL, not the tool: upload → run → result → download, and
  // the plain-language ledger. Driven on the convert page, but it asserts only
  // shell-owned surfaces, so a CSV regression doesn't redden it and a ledger
  // regression doesn't redden XLS-195.
  "XLS-194": {
    what: "shared upload→run→download shell + result-ledger renders",
    path: "/tools/convert-excel-to-csv/",
    mode: "single",
    fixtures: ["rows.xlsx"],
    download: true,
    expectLedger: true,
    expectPanel: ["Download the result", "Check another file"],
    // The shell is fixture-independent by design, so no decoy can redden it —
    // swapping the upload just produces a different valid result. Declared
    // manual rather than left blank: --red-arm on this case exits DID-NOT-RUN
    // instead of quietly reporting "proven". Arm exercised by pointing BASE_URL
    // at a local copy of the site with the ledger renderer disabled, which
    // reddens it on the expectLedger assertion.
    redArm: {
      manual: "shell contract — no fixture can redden it; run against a local build with renderResult's ledger block removed",
    },
  },

  // --- XLS-195 — Convert Excel to CSV ------------------------------------
  // The fixture's own rows must come back out of the download. 5 rows = header
  // + 4 data rows; the second sheet ("Notes") is deliberately left out of a CSV.
  "XLS-195": {
    what: "convert to CSV — the fixture's rows come back out",
    path: "/tools/convert-excel-to-csv/",
    mode: "single",
    fixtures: ["rows.xlsx"],
    download: true,
    expectDownload: ["sku,qty,price", "A-1,3,9.5", "D-4,9,14.75"],
    expectRows: 5,
    redArm: { fixture: "duplicates.xlsx" }, // no A-1/D-4 rows to carry through
  },

  // --- XLS-196 — Remove duplicate rows -----------------------------------
  // Two-sided, which is what makes it real: the duplicates must COLLAPSE (8 rows
  // in → 5 out) AND the uniques must SURVIVE. A no-op fails the row count; an
  // over-eager dedupe that eats unique rows fails the content assertion.
  "XLS-196": {
    what: "remove duplicates — dups collapse, uniques survive",
    path: "/tools/remove-duplicates/",
    mode: "single",
    fixtures: ["duplicates.xlsx"],
    download: true,
    expectDownload: ["DUP-1", "DUP-2", "UNIQ-1", "UNIQ-2"],
    expectRows: 5,
    expectPanel: ["duplicate"],
    redArm: { fixture: "rows.xlsx" }, // no duplicate rows -> nothing to collapse
  },

  // --- XLS-197 — Compare two spreadsheets ---------------------------------
  // The fixture pair has exactly three known deltas (B-2's qty 7→70, C-3→E-5)
  // and one row that is IDENTICAL in both. The identical row must not be
  // reported — that arm is what stops "flags everything" from passing.
  "XLS-197": {
    what: "compare — names the real deltas, and only those",
    path: "/tools/compare/",
    mode: "dual",
    fixtures: ["compare-a.xlsx", "compare-b.xlsx"],
    download: true,
    // Assert whole diff ROWS, not loose values. "70" and "E-5" come from file B
    // alone, so any file A paired with B would satisfy them — the first draft of
    // this case would have passed with the wrong original, which is precisely
    // what --red-arm is for. The before→after pair can only be produced by BOTH
    // files being the right ones.
    expectDownload: ["| B3 | 7 | 70 |", "| A4 | C-3 | E-5 |"],
    absentDownload: ["A-1"],
    expectPanel: ["changed"],
    redArm: { fixture: "duplicates.xlsx" }, // wrong original -> the "before" values change
  },

  // --- XLS-198 — Remove personal data ------------------------------------
  // The sharpest red arm available to us. Assert the PII is GONE from the file
  // the visitor downloads: if redaction silently no-ops, the values come back
  // and this goes red. The control cell must survive, so "redact everything"
  // fails too.
  "XLS-198": {
    what: "remove personal data — the PII is ABSENT from the downloaded file",
    path: "/tools/remove-personal-data/",
    mode: "single",
    fixtures: ["pii.xlsx"],
    download: true,
    absentDownload: [
      "ada.lovelace@example.com",
      "alan.turing@example.com",
      "(415) 555-0100",
      "123-45-6789",
      "234-56-7890",
      "4111 1111 1111 1111",
    ],
    expectDownload: ["keep-this-cell", "keep-this-too"],
    redArm: { fixture: "rows.xlsx" }, // no PII -> the control cell cannot come back
  },

  // --- XLS-199 — Does this file have macros? ------------------------------
  // Driven with a REAL macro-bearing .xlsm. A page that only ever sees .xlsx
  // can only ever answer "no macros" — which is a green that cannot go red.
  "XLS-199": {
    what: "check for macros — finds a real vbaProject in a real .xlsm",
    path: "/tools/check-for-macros/",
    mode: "single",
    fixtures: ["macros.xlsm"],
    download: false,
    // The page reports the module COUNT but deliberately doesn't name the
    // modules (the names are heuristic, "may have false positives"), so the
    // assertion names what it really does report. absentPanel carries the arm
    // that matters: the all-clear heading must NOT appear. Upload a workbook
    // with no macros and this page says exactly that — which is how we know the
    // check can still go red now that the door accepts .xlsm.
    expectPanel: ["VBA macros", "Present", "can run code", "5 modules"],
    absentPanel: ["No macros, no external links"],
    redArm: { fixture: "rows.xlsx" }, // no macros -> must say so, and must not claim Present
  },

  // --- XLS-200 — Pull out just the rows I need ----------------------------
  // Fill the filter the way a visitor would (qty > 5) and assert BOTH sides:
  // the matching rows are in the download and the non-matching ones are not.
  // A filter that returns everything fails the absent arm.
  "XLS-200": {
    what: "filter rows — keeps what matches, drops what doesn't",
    path: "/tools/filter-rows/",
    mode: "params",
    fixtures: ["rows.xlsx"],
    form: [
      { selector: '[data-xfa-sub="column"]', select: "qty" },
      { selector: '[data-xfa-sub="op"]', select: "gt" },
      { selector: '[data-xfa-sub="value"]', fill: "5" },
    ],
    download: true,
    expectDownload: ["B-2", "D-4"],
    absentDownload: ["A-1", "C-3"],
    redArm: { fixture: "duplicates.xlsx" }, // no qty>5 rows named B-2/D-4
  },

  // --- XLS-201 — Summarize / total up my data -----------------------------
  // qty sums to 20 and price to 40.5 in the fixture. A page that renders a
  // summary of nothing cannot print those numbers.
  "XLS-201": {
    what: "summarize — computes the fixture's real totals",
    path: "/tools/summarize/",
    mode: "single",
    fixtures: ["rows.xlsx"],
    download: true,
    expectPanel: ["total 20"],
    expectDownload: ["qty"],
    redArm: { fixture: "duplicates.xlsx" }, // qty does not total 20
  },

  // --- XLS-202 — See what's inside this spreadsheet ------------------------
  // Drives the card's OWN url (/tools/see-inside/), which is a meta-refresh stub
  // to /tools/whats-inside-excel-file/. Driving the stub is the point: if the
  // redirect breaks, the URL the card shipped stops working, and that is the
  // card's failure. Asserts the page-owned surface (sheet inventory + column
  // profile), leaving the grid primitive itself to XLS-217.
  "XLS-202": {
    what: "see-inside — profiles the workbook (via the shipped /see-inside/ URL)",
    path: "/tools/see-inside/",
    mode: "single",
    fixtures: ["rows.xlsx"],
    download: false,
    expectPanel: ["Notes", "sku", "qty", "price"],
    redArm: { fixture: "duplicates.xlsx" }, // single-sheet, no "price" column
  },

  // --- XLS-203 — Fix broken links & references ----------------------------
  // The fixture carries a genuinely dangling external link (ZIP-injected: its
  // target file does not exist). The page must NAME the missing source book.
  "XLS-203": {
    what: "fix broken links — names the dangling external reference",
    path: "/tools/fix-broken-links/",
    mode: "single",
    fixtures: ["broken-links.xlsx"],
    download: false,
    expectPanel: ["missing-source-book", "broken link"],
    redArm: { fixture: "rows.xlsx" }, // no external links -> nothing to name
  },

  // --- XLS-205 — Get this ready to send safely ----------------------------
  // Same absent-assertion as 198, on the "safe copy" this page hands back: the
  // PII must be gone from the file the visitor is about to send to someone else.
  "XLS-205": {
    what: "get ready safely — the safe copy carries no PII",
    path: "/tools/get-ready-safely/",
    mode: "single",
    fixtures: ["pii.xlsx"],
    download: true,
    absentDownload: ["ada.lovelace@example.com", "123-45-6789", "4111 1111 1111 1111"],
    expectDownload: ["keep-this-cell"],
    redArm: { fixture: "rows.xlsx" }, // nothing to clean -> no safe copy to hand back
  },

  // --- XLS-213 — Clean up / fix a Shopify product import file --------------
  // The fixture uses none of Shopify's canonical column names. The whole job is
  // mapping onto them, so the canonical headers coming back IS the proof — a
  // page that passes the source file through cannot produce them.
  // Shopify's admin UI exports one set of header labels and Shopify's own
  // importer demands another. Translating between the two is the fix tool's job,
  // so the canonical headers coming back IS the proof — plus the leading-zero
  // SKU surviving, which a spreadsheet round-trip would have eaten.
  "XLS-213": {
    what: "fix Shopify products — admin-UI headers come back import-ready",
    path: "/tools/fix-shopify-products/",
    mode: "single",
    fixtures: ["shopify-products-adminui.csv"],
    download: true,
    expectDownload: ["Handle", "Title", "Body (HTML)", "Variant Price", "cafe-mug", "0001234"],
    absentDownload: ["URL handle", "Compare-at price"],
    expectPanel: ["fixed"],
    redArm: { fixture: "rows.xlsx" }, // not a Shopify export at all
  },

  // --- XLS-216 — Run any tool ---------------------------------------------
  // The advanced runner: pick a tool from the LIVE tool list, fill its
  // schema-derived form, run it. The tool picker is the only reload:true field
  // on the site, so the form re-renders mid-flow. Asserts the raw tool output
  // carries the fixture's real sheet names.
  "XLS-216": {
    what: "run any tool — schema-driven runner executes the picked tool",
    path: "/tools/run-any-tool/",
    mode: "params",
    fixtures: ["rows.xlsx"],
    form: [{ selector: '[data-xfa-field="tool"]', select: "xlsx_list_sheets", rerenders: true }],
    download: false,
    expectPanel: ["Sheet1", "Notes"],
    redArm: { fixture: "duplicates.xlsx" }, // has no "Notes" sheet to list
  },

  // --- XLS-217 — the read-only preview-grid primitive -----------------------
  // Subject is the GRID, not the page: assert the fixture's real cell values are
  // inside table.preview-grid. The grid can break (no table rendered) while the
  // column-profile findings still render — which is exactly why this is its own
  // check and not folded into XLS-202.
  "XLS-217": {
    what: "preview-grid primitive — renders the fixture's real cells",
    path: "/tools/whats-inside-excel-file/",
    mode: "single",
    fixtures: ["rows.xlsx"],
    download: false,
    expectIn: [{ selector: "table.preview-grid", values: ["sku", "A-1", "D-4", "14.75"] }],
    redArm: { fixture: "duplicates.xlsx" }, // grid cannot contain A-1 / 14.75
  },
};
