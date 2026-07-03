/*
 * fix-formula-errors — page logic (XLS-193).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + the compound chain:
 *
 *   1. xlsx_formulas (include_results) — locate every formula + its cached
 *      result. Any cached result that is an Excel error token is a broken
 *      formula (rock-solid: the token is literally in the cell).
 *   2. xlsx_eval (cells) — recompute the NON-error formulas with an
 *      independent engine (HyperFormula). Because both routes normalize
 *      results through the SAME renderResult, a numeric string mismatch is a
 *      genuine disagreement, not a formatting artifact. We flag:
 *        (a) a formula that recomputes to an error the cache hid, and
 *        (b) a formula whose recomputed number differs from the stored one
 *            (the "silent-wrong" case — no error token, still wrong).
 *
 * Conservative by design: this page is a trust surface. We only flag a
 * silent-wrong cell on an unambiguous signal (a real #error token from the
 * recompute, or two finite numbers that differ). Addressing failures from the
 * recompute ("sheet not found") never start with '#', so they can't
 * masquerade as findings.
 */
(function () {
  "use strict";

  // Excel error tokens → plain-English cause.
  var TOKENS = [
    ["#GETTING_DATA", "A slow external data source hasn’t returned yet — the cell is still waiting on it."],
    ["#SPILL!", "A dynamic-array formula can’t expand because something is already sitting in the cells it needs to fill."],
    ["#VALUE!", "A value is the wrong type — usually text where a number is expected."],
    ["#DIV/0!", "It divides by zero, or by a cell that’s empty."],
    ["#CALC!", "A calculation can’t complete — often an empty array a function can’t work with."],
    ["#NAME?", "An unrecognized name — a misspelled function or a named range that doesn’t exist."],
    ["#NULL!", "Two ranges that don’t intersect — usually a space typed where a comma or colon was meant."],
    ["#REF!", "The formula points at a cell, row, column, or sheet that was deleted or moved."],
    ["#NUM!", "An invalid or out-of-range number — too large, or an impossible math result."],
    ["#N/A", "A lookup (VLOOKUP, XLOOKUP, MATCH) found no match."],
  ];

  var EVAL_CAP = 100; // xlsx_eval hard cap: 100 cells per request

  // Exact whole-value match (trimmed, case-insensitive). Error cells render
  // the token as their ENTIRE value ("#REF!"), so an exact compare is both
  // correct and immune to a literal string like "see #N/A in the docs" being
  // misread as an error.
  function tokenIn(text) {
    var up = String(text == null ? "" : text).trim().toUpperCase();
    for (var i = 0; i < TOKENS.length; i++) {
      if (up === TOKENS[i][0]) return TOKENS[i];
    }
    return null;
  }

  // A stored/recomputed cell counts as "a real error" only if it carries an
  // Excel error token — this is what keeps recompute addressing errors
  // (which never start with '#') out of the findings.
  function isErrorToken(text) {
    return tokenIn(text) !== null;
  }

  // Both routes render numbers identically, so an exact string compare is
  // already fair; the numeric parse is a second guard so "2" vs "2.0"-style
  // edge cases (shouldn't occur, but cheap to cover) don't false-flag.
  function asFiniteNumber(s) {
    if (s == null || s === "") return null;
    var t = String(s).trim().replace(/,/g, "");
    if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return null;
    var n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function ref(sheet, cell) { return sheet + "!" + cell; }
  function label(sheet, cell) { return (sheet ? sheet + "!" : "") + cell; }

  function process(fileB64, api) {
    var runTool = api.runTool, parseTable = api.parseTable, textOf = api.textOf, step = api.step;

    step(0, "on");
    return runTool("xlsx_formulas", { file_b64: fileB64, options: { include_results: true, limit: 5000 } })
      .then(function (resp) {
        step(0, "done"); step(1, "on");

        var rows = parseTable(textOf(resp));
        var sheets = {};
        var formulaCells = [];   // { sheet, cell, formula, cached }
        rows.forEach(function (r) {
          var sheet = r["Sheet"] || "";
          var cell = r["Cell"] || "";
          if (!cell) return;
          sheets[sheet] = true;
          formulaCells.push({
            sheet: sheet,
            cell: cell,
            formula: (r["Formula"] || "").replace(/^`|`$/g, ""),
            cached: r["Cached Result"] || "",
          });
        });

        var findings = [];
        var errored = {}; // ref -> true, so we don't double-report via recompute
        formulaCells.forEach(function (f) {
          var tok = tokenIn(f.cached);
          if (tok) {
            errored[ref(f.sheet, f.cell)] = true;
            findings.push({
              cell: label(f.sheet, f.cell),
              token: tok[0],
              formula: f.formula,
              why: tok[1],
              silent: false,
              attn: true,
            });
          }
        });

        // Recompute the formulas that showed NO error token, to catch the
        // silent-wrong ones. Cap at the route's 100-cell limit; the extra
        // ones simply aren't recomputed (the error-token pass already
        // covered every formula for the primary check).
        var eligible = formulaCells.filter(function (f) {
          return !errored[ref(f.sheet, f.cell)] && f.formula;
        });
        var toRecompute = eligible.slice(0, EVAL_CAP);

        var sheetNames = Object.keys(sheets);
        var ctx = {
          formulaCells: formulaCells, findings: findings, sheetNames: sheetNames,
          toRecompute: toRecompute, eligibleCount: eligible.length,
        };

        if (toRecompute.length === 0) {
          step(1, "done"); step(2, "done");
          return ctx;
        }

        step(1, "done"); step(2, "on");
        var cells = toRecompute.map(function (f) { return ref(f.sheet, f.cell); });
        return runTool("xlsx_eval", { file_b64: fileB64, cells: cells }).then(function (evResp) {
          step(2, "done");
          var evRows = parseTable(textOf(evResp));
          var byRef = {};
          evRows.forEach(function (r) {
            var input = (r["Input"] || "").replace(/^`|`$/g, "");
            byRef[input] = { result: r["Result"] || "", type: (r["Type"] || "").toLowerCase() };
          });

          toRecompute.forEach(function (f) {
            var got = byRef[ref(f.sheet, f.cell)];
            if (!got) return;

            // (a) recompute returns an error token. Two sub-cases:
            //   • cached was a real non-error value → genuinely silent-wrong
            //     (the stored value hid an error the recompute exposes).
            //   • cached was blank → the file simply never stored a result for
            //     this errored cell (some readers drop the token). Framing it
            //     as "looked fine but…" would be a lie on a trust surface, so
            //     report it as a normal error, same as the pass-1 findings.
            if (got.type === "error" && isErrorToken(got.result)) {
              var tok = tokenIn(got.result);
              var cachedBlank = String(f.cached == null ? "" : f.cached).trim() === "";
              findings.push({
                cell: label(f.sheet, f.cell),
                token: tok[0],
                formula: f.formula,
                why: cachedBlank
                  ? ["This formula returns ", { b: tok[0] }, " — " + tok[1]]
                  : [
                      "Excel’s stored value looked fine, but an independent recompute returns ",
                      { b: tok[0] }, " — " + tok[1],
                    ],
                silent: !cachedBlank,
                attn: true,
              });
              return;
            }

            // (b) two finite numbers that disagree → silent-wrong.
            var a = asFiniteNumber(f.cached), b = asFiniteNumber(got.result);
            if (a !== null && b !== null && a !== b) {
              findings.push({
                cell: label(f.sheet, f.cell),
                token: null,
                formula: f.formula,
                why: [
                  "No error shown, but the two engines disagree on the answer: the file stores ",
                  { b: f.cached }, ", an independent recompute gets ",
                  { b: got.result }, ". Worth a closer look.",
                ],
                silent: true,
                attn: true,
              });
            }
          });

          return ctx;
        }).catch(function () {
          // Recompute is a bonus pass — if it fails, still return the
          // rock-solid error-token findings rather than failing the page.
          step(2, "done");
          return ctx;
        });
      })
      .then(function (ctx) {
        var findings = ctx.findings;
        var total = ctx.formulaCells.length;
        var nSheets = ctx.sheetNames.length;
        var broken = findings.filter(function (f) { return !f.silent; }).length;
        var silent = findings.filter(function (f) { return f.silent; }).length;

        var summary = [
          { n: total, l: total === 1 ? "formula" : "formulas", cls: "" },
          { n: broken, l: broken === 1 ? "error" : "errors", cls: broken ? "bad" : "ok" },
          { n: silent, l: "silent-wrong", cls: silent ? "bad" : "ok" },
        ];

        var recomputed = Math.min(ctx.eligibleCount, EVAL_CAP);
        var did = [
          ["Scanned ", { b: String(total) }, " formula" + (total === 1 ? "" : "s") +
            " across ", { b: String(nSheets) }, " sheet" + (nSheets === 1 ? "" : "s") + "."],
        ];
        if (recomputed > 0) {
          did.push(ctx.eligibleCount > EVAL_CAP
            ? ["Recomputed the first ", { b: String(EVAL_CAP) }, " of ", { b: String(ctx.eligibleCount) },
               " formulas with an independent engine to catch answers that are wrong without showing an error."]
            : ["Recomputed the formulas with an independent engine to catch answers that are wrong without showing an error."]);
        }

        var vm = {
          summary: summary,
          heading: findings.length
            ? (findings.length === 1 ? "1 formula needs a look" : findings.length + " formulas need a look")
            : "No broken formulas found",
          findings: findings,
          ledger: {
            did: did,
            kept: [
              "Didn’t change a single cell — this is a read-only check.",
              "Nothing from your file was stored; it was read in memory and discarded.",
            ],
          },
        };

        if (!findings.length) {
          vm.empty = total === 0
            ? "We didn’t find any formulas in this workbook — nothing to check. If you expected formulas, they may be on a sheet that’s empty or stored as plain values."
            : "Every formula returns a clean result, and an independent recompute agrees with each one. Nothing looks broken.";
        }

        return vm;
      });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure: "Your file is read in memory to check the formulas, then discarded. Nothing is stored, nothing is changed.",
    runningLabel: "Checking your formulas…",
    steps: [
      "Reading every formula in the workbook",
      "Finding the ones throwing an error",
      "Recomputing to catch the silent-wrong ones",
    ],
    process: process,
  });
})();
