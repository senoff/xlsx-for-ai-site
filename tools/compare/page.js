/*
 * compare — page logic (XLS-197).
 *
 * The shell's dual-upload mode (cfg.dual) gives us two side-by-side drop
 * zones — "Original" and "Changed" — feeding ONE process() call with both
 * files. We run a single tool:
 *
 *   xlsx_diff {file_a_b64, file_b_b64} — a deterministic, cell-level semantic
 *   diff. For every sheet in either file it reports the cells that changed
 *   (before → after), the cells added, and the cells removed, plus sheet-level
 *   adds/removes. _meta carries {sheet_count, diff_hash}.
 *
 * Read-only: we compare, we never change either file. The full diff markdown
 * is offered as a download so a capped on-screen list never hides a change.
 */
(function () {
  "use strict";

  function meta(resp) {
    return (resp && typeof resp === "object" && resp._meta) || {};
  }

  // Walk the xlsx_diff markdown into a flat list of {sheet, address, type,
  // before?, after?, value?}. The body interleaves per-sheet "### name"
  // headers with up to three tables (Changed | Added | Removed), each with a
  // different column shape — so parseTable's single-header model doesn't fit;
  // we scan line by line and track the current sheet + section instead.
  function parseDiff(text) {
    var lines = String(text || "").split("\n");
    var out = [];
    var sheet = "", mode = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("### ") === 0) { sheet = line.slice(4).trim(); mode = ""; continue; }
      if (/changed cells/i.test(line)) { mode = "changed"; continue; }
      if (/(added cells|cells added)/i.test(line)) { mode = "added"; continue; }
      if (/removed cells/i.test(line)) { mode = "removed"; continue; }
      if (line.indexOf("|") !== 0) continue;
      var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
      if (/^-{2,}$/.test(cells.join("").replace(/[:\s|]/g, ""))) continue; // separator
      if (cells[0] === "Address") continue;                                // header
      if (!mode) continue;
      if (mode === "changed") out.push({ sheet: sheet, address: cells[0], type: "changed", before: cells[1], after: cells[2] });
      else if (mode === "added") out.push({ sheet: sheet, address: cells[0], type: "added", value: cells[1] });
      else if (mode === "removed") out.push({ sheet: sheet, address: cells[0], type: "removed", value: cells[1] });
    }
    return out;
  }

  var MAX_SHOWN = 60;

  function findingFor(d) {
    var where = (d.sheet ? d.sheet + "!" : "") + d.address;
    if (d.type === "changed") {
      return { cell: where, token: "changed", attn: false,
        why: [{ code: d.before || "(blank)" }, " → ", { code: d.after || "(blank)" }] };
    }
    if (d.type === "added") {
      return { cell: where, token: "added", attn: false,
        why: ["new value ", { code: d.value || "(blank)" }] };
    }
    return { cell: where, token: "removed", attn: false,
      why: ["was ", { code: d.value || "(blank)" }] };
  }

  function process(files, api) {
    var runTool = api.runTool, textOf = api.textOf, step = api.step;

    step(0, "on");
    return runTool("xlsx_diff", { file_a_b64: files.a, file_b_b64: files.b }).then(function (resp) {
      step(0, "done"); step(1, "on");
      var text = textOf(resp);
      var dm = meta(resp);
      var diffs = parseDiff(text);
      step(1, "done"); step(2, "on");

      var changed = 0, added = 0, removed = 0;
      for (var i = 0; i < diffs.length; i++) {
        if (diffs[i].type === "changed") changed++;
        else if (diffs[i].type === "added") added++;
        else removed++;
      }
      var total = diffs.length;
      var sheetsCompared = typeof dm.sheet_count === "number" ? dm.sheet_count
        : (typeof dm.sheets_compared === "number" ? dm.sheets_compared : undefined);

      var summary = [
        { n: sheetsCompared != null ? sheetsCompared : "—", l: "sheets compared", cls: "" },
        { n: changed, l: changed === 1 ? "cell changed" : "cells changed", cls: "" },
        { n: added, l: added === 1 ? "cell added" : "cells added", cls: "" },
        { n: removed, l: removed === 1 ? "cell removed" : "cells removed", cls: "" },
      ];
      step(2, "done");

      var findings = [];
      diffs.slice(0, MAX_SHOWN).forEach(function (d) { findings.push(findingFor(d)); });
      if (total > MAX_SHOWN) {
        findings.push({
          cell: "…and more", token: "+" + (total - MAX_SHOWN), silent: true, attn: false,
          why: "Showing the first " + MAX_SHOWN + " of " + total + " differences — download the full diff below.",
        });
      }

      var vm = {
        summary: summary,
        heading: total === 0
          ? "These two files match — no cell-level differences"
          : "Here’s what changed between the two files",
        findings: findings,
        ledger: {
          did: [
            ["Compared every sheet in both files cell by cell and listed each difference — what ",
             { b: "changed" }, ", what was ", { b: "added" }, ", and what was ", { b: "removed" }, "."],
          ],
          kept: [
            "Didn’t change either file — this is a read-only comparison.",
            "Didn’t store anything from your files; they were read in memory and discarded.",
          ],
        },
      };
      if (total === 0) {
        vm.empty = "Every sheet, row, and column matches. The two workbooks are identical in their cell values.";
      } else {
        vm.download = { text: text, filename: "diff.md", mime: "text/markdown" };
      }
      return vm;
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    dual: true,
    labels: { a: "Original", b: "Changed" },
    actionLabel: "Compare the two files",
    reassure:
      "Free · no signup. Both files are read in memory to compare them, then discarded. We never change either file, and nothing from them is stored.",
    runningLabel: "Comparing your two files…",
    steps: [
      "Reading both files",
      "Comparing cell by cell",
      "Writing the differences",
    ],
    process: process,
  });
})();
