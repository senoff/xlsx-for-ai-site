/*
 * convert — page logic (XLS-195).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + the conversion:
 *
 *   xlsx_convert (to: csv, sheets: first) — render the first sheet as CSV.
 *   A CSV holds a single table, so we convert the first sheet only and name
 *   the others we left out. The route returns the CSV in the response BODY
 *   (text targets aren't byte payloads), framed with a "## Convert → csv"
 *   header and a trailing rotating sign-off; both are stripped here so the
 *   download is a clean .csv the visitor can open or import as-is.
 *
 * Read-only for the source: this produces a NEW file and never touches the
 * uploaded workbook.
 */
(function () {
  "use strict";

  // The server frames a text-target body as:
  //   ## Convert → csv\n\nSource detected: N sheets (…)\n\n<raw csv>
  // and buildToolResponse appends "\n\n<closer>, Xlsx-for-ai" to every body.
  // Strip the trailing sign-off (anchored to end) and the leading header
  // (anchored to start) to recover the exact CSV. Both markers are single
  // lines, so the regexes survive blank rows inside the CSV itself. Patterns
  // are CRLF-tolerant (\r?\n) so a CRLF-normalized body strips just as cleanly
  // as the LF body SheetJS emits today.
  function extractCsv(body) {
    var csv = String(body == null ? "" : body);
    csv = csv.replace(/(?:\r?\n){2}[^\r\n]*,\s*Xlsx-for-ai\s*$/, "");
    csv = csv.replace(/^##[^\r\n]*\r?\n\r?\nSource detected:[^\r\n]*\r?\n\r?\n/, "");
    return csv;
  }

  function process(fileB64, api) {
    var runTool = api.runTool, textOf = api.textOf, step = api.step, filename = api.filename;

    step(0, "on");
    return runTool("xlsx_convert", { file_b64: fileB64, to: "csv", options: { sheets: "first" } })
      .then(function (resp) {
        step(0, "done"); step(1, "on");

        var meta = (resp && typeof resp === "object" && resp._meta) || {};
        var csv = extractCsv(textOf(resp));

        step(1, "done"); step(2, "on");

        var allSheets = meta.source_sheet_names || [];
        var rendered = meta.rendered_sheets || [];
        var renderedName = rendered[0] || allSheets[0] || "the first sheet";
        var others = allSheets.filter(function (s) { return rendered.indexOf(s) === -1; });

        var trimmed = csv.replace(/\n+$/, "");
        var rowCount = trimmed === "" ? 0 : trimmed.split("\n").length;

        // Filename is user-supplied (the uploaded file's name) — strip path
        // separators and control chars before it becomes the download name.
        var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
        base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").trim();
        var csvName = (base || "workbook") + ".csv";

        step(2, "done");

        // Empty first sheet → no rows to write; offer no download rather than
        // hand back a zero-byte file that looks like a failure.
        if (rowCount === 0) {
          return {
            heading: "Nothing to convert",
            empty: [
              "The first sheet (", { b: renderedName }, ") has no data, so the CSV would be empty. ",
              "Try a workbook with values in its first sheet.",
            ],
          };
        }

        var kept = ["Your original spreadsheet wasn’t changed — this only produces a new file."];
        if (others.length) {
          kept.unshift([
            "A CSV holds one sheet, so we left these out: ", { b: others.join(", ") },
            ". Move the sheet you need to the front and convert again.",
          ]);
        }

        return {
          summary: [
            { n: rowCount, l: rowCount === 1 ? "row" : "rows", cls: "ok" },
            { n: allSheets.length, l: allSheets.length === 1 ? "sheet" : "sheets", cls: "" },
          ],
          heading: "Your CSV is ready",
          empty: [
            "Converted ", { b: renderedName }, " to CSV — ",
            { b: String(rowCount) + " row" + (rowCount === 1 ? "" : "s") },
            ". Click below to download it.",
          ],
          ledger: {
            did: [["Converted sheet ", { b: renderedName }, " to a clean .csv file."]],
            kept: kept,
          },
          download: { text: csv, filename: csvName, mime: "text/csv;charset=utf-8" },
        };
      });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure: "Your file is read in memory to build the CSV, then discarded. Nothing is stored, and your original workbook is never changed.",
    runningLabel: "Converting your spreadsheet…",
    steps: [
      "Reading your workbook",
      "Converting the first sheet to CSV",
      "Preparing your download",
    ],
    process: process,
  });
})();
