/*
 * import-shopify-metafields — page config (XLS-1207).
 *
 * Not built on XFA_SHOPIFY.build. That helper's view model counts COLUMNS
 * (mapped / flagged); this page's whole subject is ROW outcomes — which rows
 * were written, which were left alone, which were held back — so it mounts the
 * shell directly and renders the row-outcome ledger the
 * shopify_metafields_safe_reimport route returns.
 *
 * The outcome table is the page's argument: a visitor who came here worried
 * that blank cells wipe values needs to SEE the blank rows sitting under "left
 * unchanged", not read a promise that they were.
 */
(function () {
  "use strict";

  var CSV_MIME = "text/csv";

  // Machine reason code → short chip label on a held-back row.
  var REASON = {
    type_locked: "type locked",
    type_unreadable: "unknown type",
    blank_would_clear: "blank would clear",
    value_invalid_for_type: "wrong value shape",
    identity_incomplete: "missing identity",
    duplicate_target: "duplicate row",
    owner_unusable: "owner unusable",
    needs_connected_store: "needs your store",
    not_writable_here: "not writable",
    destructive_command: "destructive",
    unknown_command: "unknown command",
    column_not_recognized: "column ignored",
  };

  function safeBase(filename) {
    var base = String(filename || "metafields.csv").replace(/\.(csv|xlsx?|ods)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "metafields";
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  function toViewModel(m, filename) {
    var ledger = (m && m.ledger) || {};
    var did = Array.isArray(ledger.did) ? ledger.did : [];
    var unchanged = Array.isArray(ledger.unchanged) ? ledger.unchanged : [];
    var couldnt = Array.isArray(ledger.couldnt) ? ledger.couldnt : [];
    var warnings = Array.isArray(ledger.warnings) ? ledger.warnings : [];
    var sum = ledger.summary || {};
    var fileB64 = m.file_b64 || null;

    var written = typeof sum.rowsWritten === "number" ? sum.rowsWritten : 0;
    var left = typeof sum.rowsLeftUnchanged === "number" ? sum.rowsLeftUnchanged : unchanged.length;
    var declined = typeof sum.rowsDeclined === "number" ? sum.rowsDeclined : couldnt.length;
    var rowsIn = typeof sum.rowsIn === "number" ? sum.rowsIn : null;

    // ---- summary cards ----
    var summary = [
      { n: written, l: plural(written, "row will update", "rows will update"), cls: written > 0 ? "ok" : "" },
      { n: left, l: "left unchanged" },
    ];
    if (declined > 0) summary.push({ n: declined, l: "need your review", cls: "bad" });

    // ---- the outcome table: one line per row of your file ----
    var byRow = {};
    var maxRow = 0;
    unchanged.forEach(function (u) {
      byRow[u.rowRef] = { what: "Left unchanged", detail: u.metafield, why: u.plainLanguage };
      if (u.rowRef > maxRow) maxRow = u.rowRef;
    });
    couldnt.forEach(function (c) {
      if (!c.rowRef) return; // a column-level entry, not a row
      byRow[c.rowRef] = {
        what: "Held back",
        detail: c.field,
        why: (c.plainLanguage || "") + (c.remediation ? " " + c.remediation : ""),
      };
      if (c.rowRef > maxRow) maxRow = c.rowRef;
    });

    var gridRows = [];
    for (var r = 2; r <= maxRow; r += 1) {
      var hit = byRow[r];
      if (hit) gridRows.push([String(r), hit.what, hit.detail, hit.why]);
    }
    var grid = gridRows.length
      ? { headers: ["Row", "Outcome", "Metafield", "Why"], rows: gridRows }
      : null;

    // ---- findings: the held-back rows, spelled out ----
    var findings = [];
    couldnt.forEach(function (c) {
      findings.push({
        cell: c.rowRef ? "Row " + c.rowRef + " · " + c.field : c.field,
        token: REASON[c.reason] || "review",
        attn: true,
        why: [
          { b: "needs you" },
          " — " + (c.plainLanguage || "we couldn’t write this row.") + (c.remediation ? " " + c.remediation : ""),
        ],
      });
    });
    warnings.forEach(function (w) {
      findings.push({
        cell: w.column,
        token: "formula",
        attn: true,
        why: w.plainLanguage || "starts with a spreadsheet formula character.",
      });
    });
    var CAP = 14;
    var shown = findings.slice(0, CAP);
    if (findings.length > CAP) {
      shown.push({ cell: "+" + (findings.length - CAP) + " more", silent: true, why: ["not shown above"] });
    }

    // ---- ledger ----
    var didRows = [];
    if (written > 0) {
      didRows.push([
        "Wrote ", { b: written + " " + plural(written, "row", "rows") },
        " into the import file — every one with a value you actually typed.",
      ]);
    }
    unchanged.forEach(function (u) {
      didRows.push([{ b: u.metafield }, " — " + (u.plainLanguage || "left exactly as it is on your store.")]);
    });
    did.forEach(function (d) {
      didRows.push(["Read your ", { b: d.sourceHeader }, " column as " + d.targetField + "."]);
    });

    var kept = [
      "Left " + left + " blank " + plural(left, "cell", "cells") +
        " out of the import file entirely — a blank cell is a wipe, so we never send one.",
    ];
    couldnt.forEach(function (c) {
      kept.push([
        { b: c.rowRef ? "Row " + c.rowRef : c.field },
        " — " + (c.plainLanguage || "held back.") + (c.remediation ? " " + c.remediation : ""),
      ]);
    });
    kept.push("Didn’t change your original file — this is a separate import CSV.");
    kept.push("Didn’t store your file — it’s read in memory and discarded.");

    var lead;
    if (written > 0 && fileB64) {
      lead = [
        { b: written + " " + plural(written, "row", "rows") }, " will update, ",
        { b: left + " " + plural(left, "metafield", "metafields") }, " will be left exactly as ",
        plural(left, "it is", "they are"),
      ];
      if (declined > 0) lead.push(", and " + declined + " " + plural(declined, "row needs", "rows need") + " your eyes");
      lead.push(". Download the import file below, then upload it in your Shopify admin.");
    } else {
      lead = [
        "Nothing in this file would change a metafield value. ",
        "Every row was either blank (so we left the existing value alone) or held back — details below. ",
        "Your original file is unchanged.",
      ];
    }

    var vm = {
      summary: summary,
      heading:
        written > 0 && fileB64
          ? "Your safe metafields import file is ready"
          : "Nothing to write — here’s why",
      findings: shown,
      empty: lead,
      ledger: { did: didRows, kept: kept },
    };
    if (findings.length && rowsIn != null) vm.gridNote = "One line per row of your file that we did not write.";
    if (grid) vm.grid = grid;
    if (written > 0 && fileB64) {
      vm.download = {
        file_b64: fileB64,
        filename: m.filename || safeBase(filename) + "-metafields-safe-import.csv",
        mime: CSV_MIME,
      };
    }
    return vm;
  }

  function process(fileB64, api) {
    api.step(0, "on");
    return api
      .runTool("shopify_metafields_safe_reimport", { file_b64: fileB64, filename: api.filename })
      .then(function (resp) {
        api.step(0, "done");
        var m = (resp && typeof resp === "object" && resp._meta) || {};
        return toViewModel(m, api.filename);
      });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".csv,.xlsx",
    extensions: ["csv", "xlsx"],
    reassure:
      "Free · no signup. Your file is read in memory to work out which metafields would change, then discarded. Nothing is stored, and your original file is never changed — you download a separate import CSV.",
    runningLabel: "Checking what this import would change…",
    steps: ["Comparing every row against what a re-import would do"],
    process: process,
  });
})();
