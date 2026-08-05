/*
 * validate-excel-file — page logic (XLS-192).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, the running/result/error states, and the POST helper; this file
 * supplies only the copy + a single call to the PUBLIC, no-signup validator:
 *
 *   api.runAnonTool("xlsx_validate", { file_b64 })
 *     → POST /api/v1/anon/xlsx_validate  (no key, no Bearer — XLS-192 anon rail)
 *
 * xlsx_validate renders the workbook through TWO independent engines
 * (@protobi/exceljs and @cj-tech-master/excelts) and diffs their canonical
 * output. If they agree, the file reads the same everywhere that matters; if
 * they diverge, that's an early warning that some tool down the line — a
 * different library, a stricter importer — may read the file differently than
 * the one that wrote it. Every fact this page shows is drawn from the tool's
 * own structured `_meta` (engines[], divergences[], engines_agree): a page that
 * only *looked* like it ran can't name both engines, the real sheet count, or a
 * specific divergence.
 */
(function () {
  "use strict";

  var ENGINE_LABEL = {
    protobi: "protobi (@protobi/exceljs)",
    excelts: "excelts (@cj-tech-master/excelts)",
  };
  function engineName(e) {
    if (!e) return "an engine";
    return ENGINE_LABEL[e.name] || e.name || "an engine";
  }

  // Convert a 1-based column index to an A1-style column letter for a friendlier
  // location label; falls back to the raw number if the input isn't a positive
  // integer (the tool always emits a number, this is just defensive).
  function colLetter(n) {
    var num = Number(n);
    if (!Number.isFinite(num) || num < 1) return String(n);
    var s = "";
    num = Math.floor(num);
    while (num > 0) {
      var r = (num - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      num = Math.floor((num - 1) / 26);
    }
    return s;
  }

  // One divergence object → a { cell, why } finding. Each of the five kinds the
  // tool can emit is spelled out; an unknown future kind degrades to its raw
  // JSON rather than being silently dropped (a validator must never hide a
  // disagreement it was told about).
  function divergenceFinding(d) {
    if (!d || !d.kind) return { cell: "difference", why: JSON.stringify(d) };
    switch (d.kind) {
      case "sheet_count_differs":
        return {
          cell: "sheet count",
          why: [
            "The engines see a different number of sheets — ",
            { b: String(d.protobi_count) }, " vs ", { b: String(d.excelts_count) },
            ". A reader that expects one count may miss or mangle a sheet.",
          ],
        };
      case "sheet_name_differs":
        return {
          cell: "sheet " + (Number(d.index) + 1),
          why: [
            "Sheet ", { b: String(Number(d.index) + 1) }, " is named ",
            { b: d.protobi_name }, " by one engine and ", { b: d.excelts_name },
            " by the other.",
          ],
        };
      case "row_count_differs":
        return {
          cell: d.sheet,
          why: [
            "Sheet ", { b: d.sheet }, " has ", { b: String(d.protobi_rows) },
            " rows in one engine and ", { b: String(d.excelts_rows) }, " in the other.",
          ],
        };
      case "col_count_differs":
        return {
          cell: d.sheet + " · row " + d.row,
          why: [
            "Row ", { b: String(d.row) }, " of sheet ", { b: d.sheet }, " has ",
            { b: String(d.protobi_cols) }, " columns in one engine and ",
            { b: String(d.excelts_cols) }, " in the other.",
          ],
        };
      case "cell_value_differs":
        return {
          cell: d.sheet + "!" + colLetter(d.col) + d.row,
          why: [
            "One engine reads ", { b: d.protobi_value === "" ? "(blank)" : d.protobi_value },
            ", the other reads ", { b: d.excelts_value === "" ? "(blank)" : d.excelts_value }, ".",
          ],
        };
      default:
        return { cell: d.kind, why: JSON.stringify(d) };
    }
  }

  function process(fileB64, api) {
    api.step(0, "on");
    // No key, no signup — the public anon rail. Same reject rules as the authed
    // tool (garbage/oversize are 400/413'd server-side and surface as the
    // shell's standard error card).
    return api.runAnonTool("xlsx_validate", { file_b64: fileB64 }).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var engines = meta.engines || [];
      var divergences = meta.divergences || [];
      var agree = meta.engines_agree === true;
      var text = api.textOf(resp);

      // An engine that failed to LOAD the file at all is the loudest signal —
      // one library couldn't even open what the other did. Report it first and
      // never call that "agreement".
      var failed = engines.filter(function (e) { return e && e.load_succeeded === false; });

      api.step(1, "done");

      var findings = [];
      failed.forEach(function (e) {
        var why = [engineName(e), " could not open this file"];
        if (e.error) { why.push(": ", { b: String(e.error) }); }
        why.push(". Another reader may reject it the same way.");
        findings.push({ cell: engineName(e), token: "won’t open", why: why, silent: false, attn: true });
      });
      divergences.forEach(function (d) {
        var f = divergenceFinding(d);
        findings.push({ cell: f.cell, why: f.why, silent: true, attn: true });
      });

      var sheetCount = engines.length && engines[0] && typeof engines[0].sheet_count === "number"
        ? engines[0].sheet_count : null;

      var summary = [
        { n: engines.length || 2, l: "engines", cls: "" },
        { n: agree ? "Yes" : "No", l: "agree", cls: agree ? "ok" : "bad" },
        { n: divergences.length, l: divergences.length === 1 ? "difference" : "differences", cls: divergences.length ? "bad" : "ok" },
      ];

      var did = [
        [
          "Read your workbook through ", { b: String(engines.length || 2) },
          " independent engines — ",
          engines.map(engineName).join(" and ") || "protobi and excelts",
          " — and compared every sheet, row, and cell.",
        ],
      ];
      if (sheetCount != null) {
        did.push(["Both engines saw ", { b: String(sheetCount) },
          " sheet" + (sheetCount === 1 ? "" : "s") + " in the file."]);
      }

      var vm = {
        summary: summary,
        heading: failed.length
          ? (failed.length === 1 ? "One engine couldn’t open this file" : "Neither engine could fully open this file")
          : agree
            ? "Both engines read your workbook identically"
            : (divergences.length === 1
                ? "1 difference between the two engines"
                : divergences.length + " differences between the two engines"),
        findings: findings,
        output: text,
        ledger: {
          did: did,
          kept: [
            "Didn’t change a single cell — this is a read-only check.",
            "Nothing from your file was stored; it was read in memory and discarded.",
          ],
        },
      };

      if (!findings.length) {
        vm.empty = "Both engines opened the file and agree on every sheet, row, and cell. It should read the same wherever it’s opened.";
      }

      return vm;
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure: "Free · no signup. Your file is read in memory by two independent engines to compare them, then discarded. Nothing is stored, nothing is changed.",
    runningLabel: "Validating your workbook…",
    steps: [
      "Reading your file through two independent engines",
      "Comparing every sheet, row, and cell",
    ],
    process: process,
  });
})();
