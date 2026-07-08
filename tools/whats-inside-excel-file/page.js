/*
 * see-inside — page logic (XLS-202).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + a two-call read-only overview:
 *
 *   1. xlsx_list_sheets — the workbook inventory (_meta.sheet_count + a
 *      markdown table of every sheet's name / rows / cols / visibility). We
 *      pick the first VISIBLE sheet as the one to profile in detail.
 *   2. xlsx_describe {sheet} — the primary sheet's column profile
 *      (_meta.column_count / row_count + a table of column name, type, count,
 *      nulls, unique, sample). This is the "what each column holds" answer.
 *
 *   3. xlsx_read {sheet, maxRows} — the first rows of the profiled sheet,
 *      rendered as a read-only preview grid via the shell's parseGrid + grid
 *      view model (XLS-217). "Here's what each column holds" (describe) plus
 *      "here's what the actual data looks like" (the grid).
 *
 * Read-only: we describe and peek, we never change the file. xlsx_schema (a
 * second column-type view keyed by column letter) is still not surfaced —
 * describe already carries per-column type + a sample value. Overview facts
 * trace 1:1 to the three calls.
 */
(function () {
  "use strict";

  function meta(resp) {
    return (resp && typeof resp === "object" && resp._meta) || {};
  }

  // Pick the sheet to profile: the first visible sheet, else the first sheet.
  function pickPrimary(sheetRows) {
    for (var i = 0; i < sheetRows.length; i++) {
      if (String(sheetRows[i].Visibility || "").toLowerCase() === "visible") return sheetRows[i];
    }
    return sheetRows[0] || null;
  }

  // "100×5" dims label from a list_sheets row, with a visibility suffix when
  // the sheet isn't the plain visible case.
  function sheetLabel(row) {
    var dims = String(row.Rows || "0") + "×" + String(row.Columns || "0");
    var vis = String(row.Visibility || "visible").toLowerCase();
    return vis === "visible" ? dims : dims + ", " + vis;
  }

  var MAX_COLS_SHOWN = 50;
  var PREVIEW_ROWS = 20; // first N data rows shown in the peek grid

  function process(fileB64, api) {
    var runTool = api.runTool, parseTable = api.parseTable, textOf = api.textOf, step = api.step;
    var parseGrid = api.parseGrid;

    step(0, "on");
    return runTool("xlsx_list_sheets", { file_b64: fileB64 }).then(function (lsResp) {
      step(0, "done"); step(1, "on");
      var sheetRows = parseTable(textOf(lsResp)); // [{'#',Name,Rows,Columns,Visibility}]
      var sheetCount = typeof meta(lsResp).sheet_count === "number" ? meta(lsResp).sheet_count : sheetRows.length;
      var primary = pickPrimary(sheetRows);
      var primaryName = primary ? primary.Name : undefined;

      var describeBody = { file_b64: fileB64 };
      if (primaryName) describeBody.options = { sheet: primaryName };

      return runTool("xlsx_describe", describeBody).then(function (descResp) {
        step(1, "done"); step(2, "on");
        var descRows = parseTable(textOf(descResp)); // Column | Type | Count | Nulls | Unique | Min | Max | Mean | Std | Sample
        var dm = meta(descResp);
        var colCount = typeof dm.column_count === "number" ? dm.column_count : descRows.length;
        var rowCount = typeof dm.row_count === "number" ? dm.row_count : 0;
        var profiledSheet = dm.sheet || primaryName || "";

        var findings = [];

        // ----- Sheet inventory (only when there's more than one) -----
        if (sheetCount > 1 && sheetRows.length) {
          var names = sheetRows.map(function (r) { return r.Name + " (" + sheetLabel(r) + ")"; });
          var why = [
            "This workbook has ", { b: String(sheetCount) + " sheets" }, ": ",
            names.join(", "), ". The column profile below is for ",
            { b: profiledSheet }, ".",
          ];
          findings.push({ cell: "Sheets", token: String(sheetCount), silent: true, attn: false, why: why });
        }

        // ----- Column profile of the primary sheet -----
        if (descRows.length === 0) {
          findings.push({
            cell: profiledSheet || "This sheet", token: "Empty", silent: true, attn: false,
            why: "No tabular data — this sheet doesn't have columns to profile.",
          });
        } else {
          var shown = descRows.slice(0, MAX_COLS_SHOWN);
          shown.forEach(function (r) {
            var count = r.Count || "0";
            var nulls = r.Nulls || "0";
            var unique = r.Unique || "0";
            var why = [
              { b: count }, " filled · ", { b: nulls }, " blank · ", { b: unique }, " distinct",
            ];
            // Numeric range, when describe reported one (min/max are "—" for text).
            if (r.Min && r.Min !== "—" && r.Max && r.Max !== "—") {
              why.push(" · range " + r.Min + "–" + r.Max);
              if (r.Mean && r.Mean !== "—") why.push(", mean " + r.Mean);
            }
            if (r.Sample && r.Sample !== "—") {
              why.push(" · e.g. ");
              why.push({ code: r.Sample });
            }
            findings.push({
              cell: r.Column || "(unnamed)",
              token: r.Type || "—",
              attn: false,
              why: why,
            });
          });
          if (descRows.length > MAX_COLS_SHOWN) {
            findings.push({
              cell: "…and more", token: "+" + (descRows.length - MAX_COLS_SHOWN), silent: true, attn: false,
              why: "Showing the first " + MAX_COLS_SHOWN + " of " + descRows.length + " columns.",
            });
          }
        }

        var summary = [
          { n: sheetCount, l: sheetCount === 1 ? "sheet" : "sheets", cls: "" },
          { n: colCount, l: colCount === 1 ? "column" : "columns", cls: "" },
          { n: rowCount, l: rowCount === 1 ? "row" : "rows", cls: "" },
        ];

        var heading = sheetCount === 1 && profiledSheet
          ? "Inside “" + profiledSheet + "”"
          : "Here’s what’s inside this workbook";

        // Peek the first rows of the profiled sheet as a read-only grid, so the
        // overview shows what the actual data looks like — not just its shape.
        // Read the SAME sheet describe profiled (profiledSheet), not just the
        // picked primary — dm.sheet is what the column table above describes, so
        // the grid must match it or the preview would show a different tab.
        var readSheet = profiledSheet || primaryName;
        var readBody = { file_b64: fileB64, options: { maxRows: PREVIEW_ROWS } };
        if (readSheet) readBody.options.sheet = readSheet;

        return runTool("xlsx_read", readBody).then(function (readResp) {
          step(2, "done");
          var grid = parseGrid ? parseGrid(textOf(readResp)) : { headers: [], rows: [] };

          var vm = {
            summary: summary,
            heading: heading,
            findings: findings,
            ledger: {
              did: [
                ["Listed every sheet, profiled the columns of ", { b: profiledSheet || "the main sheet" },
                 ", and previewed its first rows — the type, how full each column is, a sample value, and the actual data."],
              ],
              kept: [
                "Didn’t change your file — this is a read-only overview.",
                "Didn’t store anything from your file; it was read in memory and discarded.",
              ],
            },
          };
          if (grid.headers.length) {
            vm.grid = grid;
            vm.gridNote = "First " + grid.rows.length +
              (grid.rows.length === 1 ? " row of “" : " rows of “") +
              (profiledSheet || primaryName || "the sheet") + "”.";
          }
          return vm;
        });
      });
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Free · no signup. Your file is read in memory to describe what's inside, then discarded. We never change your file, and nothing from it is stored.",
    runningLabel: "Looking inside your file…",
    steps: [
      "Reading the workbook",
      "Profiling the columns",
      "Writing your overview",
    ],
    process: process,
  });
})();
