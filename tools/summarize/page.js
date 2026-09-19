/*
 * summarize — "Summarize / total up my data" page logic (XLS-201).
 *
 * Rides the shared shell (shell.js / shell.css). Param-free v1: upload one
 * workbook, get a plain-language summary of every column — the total of each
 * numeric column plus its average and range, and the count / blanks / distinct
 * values of every column. Download the whole summary as a .csv.
 *
 * Two tools, one read-only result:
 *   1. xlsx_read      — returns every cell exactly (a Markdown table of the
 *      sheet). We total the numeric columns client-side from these EXACT values,
 *      so "total up my data" means a real sum, not a rounded estimate.
 *   2. xlsx_describe  — its _meta.row_count is the authoritative row total; we
 *      compare it against how many rows xlsx_read returned so that, on a very
 *      large workbook where the read is capped, we say the totals cover the
 *      first N rows rather than silently under-count.
 *
 * Read-only: nothing about the uploaded workbook is changed; the download is a
 * fresh summary file, never the original.
 *
 * Group-by totals, counts-by-value and pivots are the deliberate follow (they
 * need the shared params UI); this v1 totals whole columns with no options.
 */
(function () {
  "use strict";

  var CSV_MIME = "text/csv";

  // Is a raw cell string a finite number? Tolerates surrounding spaces and a
  // leading currency/percent-free plain number. Empty → not a value.
  function asNumber(s) {
    if (s == null) return null;
    var t = String(s).trim();
    if (t === "") return null;
    // Reject anything that isn't a bare number (no thousands separators, no $).
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
    var n = Number(t);
    return Number.isFinite(n) ? n : null;
  }

  function isBlank(s) {
    return s == null || String(s).trim() === "";
  }

  // Format a number for on-screen display: integers plain, otherwise up to two
  // decimals (trailing zeros trimmed). Full precision is kept for the CSV.
  function fmtNum(n) {
    if (!Number.isFinite(n)) return "—";
    if (Number.isInteger(n)) return String(n);
    var r = Number(n.toFixed(2));
    return String(r);
  }

  // Build per-column stats from the parsed cell rows (exact values).
  //   { name, numeric, count, blanks, unique, sum, min, max, mean, sample }
  function summarize(headers, rows) {
    return headers.map(function (h) {
      var count = 0, blanks = 0;
      var seen = {}, uniq = 0;
      var nums = [];
      var allNumeric = true, hasValue = false;
      var sample = "";
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i][h];
        if (isBlank(v)) { blanks++; continue; }
        count++;
        hasValue = true;
        var key = String(v);
        if (!seen[key]) { seen[key] = 1; uniq++; }
        if (!sample) sample = key;
        var n = asNumber(v);
        if (n === null) allNumeric = false;
        else nums.push(n);
      }
      var numeric = hasValue && allNumeric && nums.length === count;
      var col = {
        name: h,
        numeric: numeric,
        count: count,
        blanks: blanks,
        unique: uniq,
        sample: sample,
        sum: null, min: null, max: null, mean: null,
      };
      if (numeric && nums.length) {
        var sum = 0, min = Infinity, max = -Infinity;
        for (var k = 0; k < nums.length; k++) {
          sum += nums[k];
          if (nums[k] < min) min = nums[k];
          if (nums[k] > max) max = nums[k];
        }
        col.sum = sum;
        col.min = min;
        col.max = max;
        col.mean = sum / nums.length;
      }
      return col;
    });
  }

  function csvCell(s) {
    var t = String(s == null ? "" : s);
    // Neutralize CSV/formula injection: a leading = + - @ (or a control char)
    // makes spreadsheet apps evaluate a sheet-controlled value as a formula when
    // the download is opened. Prefix a single quote to force it to plain text.
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\n\t]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function toCsv(cols) {
    var header = ["Column", "Type", "Count", "Blanks", "Unique", "Sum", "Min", "Max", "Mean"];
    var lines = [header.join(",")];
    cols.forEach(function (c) {
      lines.push([
        csvCell(c.name),
        c.numeric ? "number" : "text",
        c.count,
        c.blanks,
        c.unique,
        c.numeric ? c.sum : "",
        c.numeric ? c.min : "",
        c.numeric ? c.max : "",
        c.numeric ? c.mean : "",
      ].join(","));
    });
    return lines.join("\n") + "\n";
  }

  function safeBase(filename) {
    var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "workbook";
  }

  function process(fileB64, api) {
    var runTool = api.runTool, parseTable = api.parseTable, textOf = api.textOf, step = api.step;

    step(0, "on");
    // Read exact cells and the authoritative row_count in parallel. A describe
    // hiccup must not sink the summary — fall back to {} and skip the
    // completeness cross-check.
    var readP = runTool("xlsx_read", { file_b64: fileB64 });
    var descP = runTool("xlsx_describe", { file_b64: fileB64 }).then(
      function (r) { return (r && typeof r === "object" && r._meta) || {}; },
      function () { return {}; }
    );

    return Promise.all([readP, descP]).then(function (both) {
      step(0, "done"); step(1, "on");
      var readResp = both[0], dMeta = both[1] || {};
      var rows = parseTable(textOf(readResp));
      var headers = rows.length ? Object.keys(rows[0]) : [];
      var cols = summarize(headers, rows);

      var readRows = rows.length;
      var totalRows =
        typeof dMeta.row_count === "number" ? dMeta.row_count : readRows;
      var partial = totalRows > readRows;

      step(1, "done");
      return buildResult({
        cols: cols,
        headers: headers,
        readRows: readRows,
        totalRows: totalRows,
        partial: partial,
        filename: api.filename,
      });
    });
  }

  function buildResult(ctx) {
    var cols = ctx.cols;
    var numeric = cols.filter(function (c) { return c.numeric; });
    var textCols = cols.filter(function (c) { return !c.numeric; });

    // ---- nothing to summarize ----
    if (cols.length === 0 || ctx.readRows === 0) {
      return {
        summary: [{ n: 0, l: "columns found", cls: "" }],
        heading: "Couldn’t find a data table",
        empty: [
          "We couldn’t find a table of rows and columns to summarize in this file. ",
          "Make sure the first sheet has a header row with data underneath it. Your file is unchanged.",
        ],
        ledger: {
          did: [],
          kept: [
            "Your original file wasn’t changed.",
            "Read your workbook in memory to check it, then discarded it — nothing was stored.",
          ],
        },
      };
    }

    // ---- per-column findings list ----
    var vmFindings = cols.map(function (c) {
      if (c.numeric) {
        return {
          cell: c.name,
          token: "number",
          why: [
            "total ", { b: fmtNum(c.sum) },
            " · avg " + fmtNum(c.mean) +
              " · range " + fmtNum(c.min) + "–" + fmtNum(c.max) +
              " · " + c.count + " value" + (c.count === 1 ? "" : "s") +
              (c.blanks ? " · " + c.blanks + " blank" + (c.blanks === 1 ? "" : "s") : ""),
          ],
        };
      }
      return {
        cell: c.name,
        token: "text",
        why: [
          c.count + " value" + (c.count === 1 ? "" : "s") +
            " · " + c.unique + " unique" +
            (c.blanks ? " · " + c.blanks + " blank" + (c.blanks === 1 ? "" : "s") : "") +
            (c.sample ? " · e.g. " + c.sample : ""),
        ],
      };
    });

    // ---- ledger ----
    var did = [
      numeric.length > 0
        ? ["Totalled every numeric column — ", { b: "(" + numeric.length + ")" },
           " — with its average and range."]
        : ["Summarized every column — no numeric columns to total."],
      ["Counted values, blanks and distinct entries for all ", { b: String(cols.length) },
       " column" + (cols.length === 1 ? "" : "s") + "."],
    ];

    var kept = [
      "Your original file wasn’t changed — this is a read-only summary.",
    ];
    if (ctx.partial) {
      kept.push(
        "Totals cover the first " + ctx.readRows + " of " + ctx.totalRows +
          " rows — the file was large enough that we summarized the leading rows."
      );
    }
    kept.push("Didn’t store your file — it’s read in memory and discarded.");
    kept.push(
      "Totals by category and pivot tables are coming next — this first version totals whole columns."
    );

    // ---- summary cards ----
    var summary = [
      { n: numeric.length, l: numeric.length === 1 ? "numeric column" : "numeric columns", cls: numeric.length > 0 ? "ok" : "" },
      { n: ctx.totalRows, l: ctx.totalRows === 1 ? "row" : "rows" },
      { n: cols.length, l: cols.length === 1 ? "column" : "columns" },
    ];

    var outName = safeBase(ctx.filename) + "-summary.csv";
    var headingBits =
      numeric.length > 0
        ? "Totalled " + numeric.length + " numeric column" + (numeric.length === 1 ? "" : "s")
        : "Summarized " + cols.length + " column" + (cols.length === 1 ? "" : "s");

    return {
      summary: summary,
      heading: "Here’s your data, summarized",
      findings: vmFindings,
      empty: [
        headingBits + " and counted every column. ",
        "Download the full summary as a spreadsheet-ready .csv below.",
      ],
      ledger: { did: did, kept: kept },
      download: { text: toCsv(cols), filename: outName, mime: CSV_MIME },
    };
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Your file is read in memory to summarize it, then discarded. Nothing is stored, and your original workbook is never changed — you download a separate .csv summary.",
    runningLabel: "Summarizing your data…",
    steps: ["Reading every value", "Totalling the numbers"],
    process: process,
  });
})();
