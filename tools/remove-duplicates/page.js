/*
 * remove-duplicates — page logic (XLS-196).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + the de-duplication:
 *
 *   xlsx_data_clean (mode: execute, detectors: [duplicate_data_row]) — scan
 *   for fully-duplicate DATA rows and splice out the later copies, keeping the
 *   first of each. The header row is never touched. Execute mode returns the
 *   cleaned workbook bytes as `_meta.file_b64` (base64 .xlsx) — but ONLY when
 *   at least one row was removed; a file with no duplicates comes back with a
 *   null file_b64 and applied_count 0, which we render as a clean "nothing to
 *   remove" state rather than a pointless re-download of the untouched file.
 *
 * Read-only for the source: this produces a NEW file and never touches the
 * uploaded workbook.
 */
(function () {
  "use strict";

  var XLSX_MIME =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step, filename = api.filename;

    step(0, "on");
    return runTool("xlsx_data_clean", {
      file_b64: fileB64,
      mode: "execute",
      detectors: ["duplicate_data_row"],
    }).then(function (resp) {
      step(0, "done"); step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var removed = typeof meta.applied_count === "number" ? meta.applied_count : 0;
      var cleanedB64 = meta.file_b64 || null;

      step(1, "done"); step(2, "on");

      // Count the distinct sheets the removals touched, for the ledger copy.
      var findings = Array.isArray(meta.findings) ? meta.findings : [];
      var sheetSet = {};
      findings.forEach(function (f) {
        var s = f && f.location && f.location.sheet;
        if (s) sheetSet[s] = true;
      });
      var sheetsTouched = Object.keys(sheetSet).length;

      // Filename is user-supplied (the uploaded file's name) — strip path
      // separators and control chars before it becomes the download name.
      var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
      base = base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
        .trim();
      var outName = (base || "workbook") + "-deduplicated.xlsx";

      step(2, "done");

      // No duplicates (or, defensively, execute returned no cleaned bytes) →
      // offer no download; the original file is already free of repeats.
      if (removed === 0 || !cleanedB64) {
        return {
          heading: "No duplicate rows found",
          empty: [
            "Every row in your spreadsheet is already unique, so there was nothing to remove. ",
            "Your file is unchanged.",
          ],
        };
      }

      var rowWord = removed === 1 ? "row" : "rows";
      var did = [
        [
          "Removed ", { b: String(removed) + " duplicate " + rowWord },
          ", keeping the first copy of each.",
        ],
      ];
      if (sheetsTouched > 1) {
        did.push(["Duplicates were found across ", { b: String(sheetsTouched) + " sheets" }, "."]);
      }

      return {
        summary: [
          { n: removed, l: "duplicate " + rowWord + " removed", cls: "ok" },
        ],
        heading: "Your de-duplicated file is ready",
        empty: [
          "Removed ", { b: String(removed) + " duplicate " + rowWord },
          " and kept the first of each. Click below to download the clean copy.",
        ],
        ledger: {
          did: did,
          kept: [
            "Your original spreadsheet wasn’t changed — this only produces a new file.",
            "Your header row and every unique row were left exactly as they were.",
          ],
        },
        download: { file_b64: cleanedB64, filename: outName, mime: XLSX_MIME },
      };
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Your file is read in memory to find and remove duplicate rows, then discarded. Nothing is stored, and your original workbook is never changed.",
    runningLabel: "Removing duplicate rows…",
    steps: [
      "Reading your workbook",
      "Finding duplicate rows",
      "Preparing your download",
    ],
    process: process,
  });
})();
