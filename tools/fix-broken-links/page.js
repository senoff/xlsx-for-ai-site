/*
 * fix-broken-links — page logic (XLS-203).
 *
 * Scoped to ONE honest promise: broken links to OTHER workbooks (external
 * references). A formula like ='[1]Budget.xlsx'!B4 stops working the moment the
 * other file is moved, renamed, or deleted — Excel shows the last value it
 * cached and never updates again. We find those, and freeze each one to that
 * last saved value so the workbook stands on its own.
 *
 * Two read-only calls, then one write to a COPY:
 *   1. xlsx_healer_diagnose {file_b64} — scans every external reference and
 *      reports its status. _meta.diagnostic.references[] carries source_path,
 *      cached_value, and the consumer cells; anything whose current_status is
 *      not "ok" is a broken link.
 *   2. xlsx_healer_cure {operation:"make_standalone", mode:"as_copy",
 *      cure_params:{scope:"safe_only"}} — freezes each safe broken reference to
 *      its cached value and returns a repaired COPY in _meta.file_b64. We never
 *      touch the uploaded file; the fix is a new download.
 *
 * Honest by construction: we freeze to the LAST SAVED VALUE and say so — the
 * frozen cells will no longer auto-update. safe_only leaves genuinely complex
 * references (huge ranges, INDIRECT/OFFSET) untouched rather than guess.
 */
(function () {
  "use strict";

  function meta(resp) {
    return (resp && typeof resp === "object" && resp._meta) || {};
  }

  function basename(p) {
    var s = String(p || "").replace(/^file:\/\//, "").replace(/[?#].*$/, "");
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s || "another workbook";
  }

  // A reference is broken (worth freezing) when the diagnose scan could not
  // confirm its source — every status except "ok".
  function isBroken(ref) {
    return ref && ref.current_status && ref.current_status !== "ok";
  }

  var MAX_SHOWN = 60;

  function findingFor(ref) {
    var src = basename(ref.source_path);
    var consumers = Array.isArray(ref.consumer_locations) ? ref.consumer_locations : [];
    var cells = consumers.filter(function (c) { return c && c.cell_ref; }).map(function (c) {
      return (c.sheet_name ? c.sheet_name + "!" : "") + c.cell_ref;
    });
    var shownCells = cells.slice(0, 6).join(", ") + (cells.length > 6 ? ", …" : "");
    var cached = ref.cached_value != null && ref.cached_value !== ""
      ? String(ref.cached_value) : null;

    var why = ["This workbook pulled values from ", { code: src },
      ", which can’t be found — so those cells were stuck on the last value Excel saved"];
    if (cached != null && cells.length === 1) {
      why.push(" ("); why.push({ code: cached }); why.push(")");
    }
    why.push(". ");
    if (cells.length > 0) {
      why.push(cells.length === 1 ? "Used in " : "Used in " + cells.length + " cells: ");
      why.push({ code: shownCells });
      why.push(". ");
    }
    why.push("We froze it to that saved value, so the cell keeps its number instead of showing a broken link.");

    return { cell: src, token: "broken link", attn: true, why: why };
  }

  // Count the per-cell freezes the cure actually performed. The receipt lists
  // one "…: <cell>: formula → cached value" line per frozen cell, plus a summary
  // line we don't want to count. Accept either arrow glyph in case the receipt
  // format rotates between the unicode "→" and an ASCII "->".
  function countFrozen(actions) {
    if (!Array.isArray(actions)) return 0;
    return actions.filter(function (a) {
      return /formula\s*(?:→|->)\s*cached value/.test(String(a)) && /:\s*[A-Za-z]+\d+:/.test(String(a));
    }).length;
  }

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step;

    step(0, "on");
    return runTool("xlsx_healer_diagnose", { file_b64: fileB64 }).then(function (diagResp) {
      step(0, "done"); step(1, "on");
      var dm = meta(diagResp);
      var report = (dm && dm.diagnostic) || {};
      var refs = Array.isArray(report.references) ? report.references : [];
      var broken = refs.filter(isBroken);
      var brokenConsumers = broken.reduce(function (n, r) {
        return n + (Array.isArray(r.consumer_locations) ? r.consumer_locations.length : 0);
      }, 0);
      step(1, "done");

      // ---- No broken links: already self-contained ----
      if (broken.length === 0) {
        step(2, "on"); step(2, "done");
        var extScanned = dm.statistics && typeof dm.statistics.references_scanned === "number"
          ? dm.statistics.references_scanned : refs.length;
        return {
          summary: [
            { n: 0, l: "broken links", cls: "ok" },
            { n: extScanned, l: extScanned === 1 ? "link checked" : "links checked", cls: "" },
          ],
          heading: "No broken links — this workbook is already self-contained",
          findings: [],
          empty: extScanned === 0
            ? "This workbook doesn’t pull values from any other file, so there’s nothing to fix — it already stands on its own."
            : "Every link to another workbook still resolves, so there’s nothing broken to freeze.",
          ledger: {
            did: [["Scanned every link to another workbook and checked whether each one still resolves."]],
            kept: [
              "Didn’t change your file — this is a read-only check.",
              "Didn’t store anything from your file; it was read in memory and discarded.",
            ],
          },
        };
      }

      // ---- Broken links found: freeze them to their last saved values ----
      step(2, "on");
      return runTool("xlsx_healer_cure", {
        file_b64: fileB64,
        operation: "make_standalone",
        mode: "as_copy",
        cure_params: { scope: "safe_only" },
      }).then(function (cureResp) {
        step(2, "done");
        var cm = meta(cureResp);
        var frozen = countFrozen(cm.cure_actions_taken);
        var repaired = typeof cm.file_b64 === "string" ? cm.file_b64 : null;
        var notFrozen = brokenConsumers - frozen;

        var findings = broken.slice(0, MAX_SHOWN).map(findingFor);
        if (broken.length > MAX_SHOWN) {
          findings.push({
            cell: "…and more", token: "+" + (broken.length - MAX_SHOWN), silent: true, attn: false,
            why: "Showing the first " + MAX_SHOWN + " of " + broken.length + " broken links — the download below fixes all of them.",
          });
        }

        var summary = [
          { n: broken.length, l: broken.length === 1 ? "broken link" : "broken links", cls: "" },
          { n: frozen, l: frozen === 1 ? "cell frozen" : "cells frozen", cls: frozen > 0 ? "ok" : "" },
        ];
        if (notFrozen > 0) {
          summary.push({ n: notFrozen, l: notFrozen === 1 ? "cell left as-is" : "cells left as-is", cls: "" });
        }

        var did = [
          ["Found ", { b: String(broken.length) + (broken.length === 1 ? " broken link" : " broken links") },
           " to other workbooks and froze the affected cells to the ", { b: "last value Excel saved" },
           " — the numbers stay put instead of showing a broken link."],
        ];
        if (notFrozen > 0) {
          did.push(["Left " + notFrozen + (notFrozen === 1 ? " cell" : " cells") +
            " untouched because the reference was too complex to freeze safely (a large range or a dynamic formula) — better to leave it than to guess."]);
        }

        var vm = {
          summary: summary,
          heading: frozen > 0
            ? "Froze the broken links to their last saved values"
            : "Found broken links, but they were too complex to freeze safely",
          findings: findings,
          ledger: {
            did: did,
            kept: [
              "Didn’t change your original file — the fix is a separate copy you download below.",
              "Froze each broken link to its last saved value; those cells will no longer try to auto-update from the missing file.",
              "Didn’t store anything from your file; it was read in memory and discarded.",
            ],
          },
        };
        if (frozen > 0 && repaired) {
          var base = String(api.filename || "workbook").replace(/\.xlsx$/i, "");
          vm.download = { file_b64: repaired, filename: base + ".repaired.xlsx",
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
        } else {
          vm.empty = "The broken links here point at large ranges or dynamic formulas that can’t be frozen to a single value without risking wrong results, so we left the file unchanged rather than guess.";
        }
        return vm;
      });
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Your file is read in memory to find broken links to other workbooks, then discarded. We never change your original file — the repaired copy is a separate download, and nothing from your file is stored.",
    runningLabel: "Checking your workbook for broken links…",
    steps: [
      "Reading your workbook",
      "Finding broken links to other files",
      "Freezing them to their last saved values",
    ],
    process: process,
  });
})();
