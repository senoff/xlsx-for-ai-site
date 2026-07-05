/*
 * fix-shopify-products — page logic (XLS-213 Part-2).
 *
 * Wires the deterministic, keyless shopify_products_import_fix route to the
 * shared shell. Unlike the mapper import pages (shopify-import.js), this route
 * takes an ALREADY-Shopify-shaped but BROKEN products export and repairs it
 * byte-deterministically — no AI, no column-guessing. Its response shape also
 * differs: the reviewed CSV is at TOP-LEVEL file_b64 (not _meta.file_b64), and
 * the ledger is a FIX ledger (fixed / couldnt / warnings), not a mapping ledger
 * (did / couldnt). Because there is exactly one fix page, the view-model lives
 * here rather than in a shared builder.
 *
 * Read-only for the source: this produces a NEW CSV and never changes the
 * uploaded file. Every defect is either fixed (with before → after) or flagged
 * (with a reason) — nothing is changed silently.
 */
(function () {
  "use strict";

  var CSV_MIME = "text/csv";

  // Machine reason code (couldnt row) → short chip label.
  var REASON = {
    duplicate_handle_conflict: "duplicate handle",
    missing_required_field: "missing field",
    unresolvable_value: "needs your call",
    ambiguous: "ambiguous",
  };

  function safeBase(filename) {
    var base = String(filename || "products.csv").replace(/\.(csv|xlsx?|ods)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "products";
  }

  // resp is the FULL route response: { file_b64 (top-level), _meta:{ filename,
  // ledger } }. The fix ledger always yields a CSV (rowsOut === rowsIn) even
  // when every defect is only flagged — so a download is always offered.
  function toViewModel(resp, filename) {
    var m = (resp && resp._meta) || {};
    var ledger = m.ledger || {};
    var fixed = Array.isArray(ledger.fixed) ? ledger.fixed : [];
    var couldnt = Array.isArray(ledger.couldnt) ? ledger.couldnt : [];
    var warnings = Array.isArray(ledger.warnings) ? ledger.warnings : [];
    var sum = ledger.summary || {};
    var fileB64 = resp && resp.file_b64 ? resp.file_b64 : null;

    var fixedCount = typeof sum.fixedCount === "number" ? sum.fixedCount : fixed.length;
    var flaggedCount = typeof sum.flaggedCount === "number" ? sum.flaggedCount : couldnt.length;
    var rowsIn = typeof sum.rowsIn === "number" ? sum.rowsIn : null;

    // ---- summary cards ----
    var summary = [
      { n: fixedCount, l: fixedCount === 1 ? "issue fixed" : "issues fixed", cls: fixedCount > 0 ? "ok" : "" },
    ];
    if (flaggedCount > 0) summary.push({ n: flaggedCount, l: "to review", cls: "bad" });
    if (rowsIn != null) summary.push({ n: rowsIn, l: rowsIn === 1 ? "row" : "rows" });

    // ---- per-defect findings (fixed → couldnt → warnings), capped ----
    var findings = [];
    fixed.forEach(function (f) {
      var beforeAfter = null;
      if (f.before != null && f.after != null) {
        beforeAfter = " (" + String(f.before) + " → " + String(f.after) + ")";
      }
      findings.push({
        cell: f.field,
        token: "fixed",
        attn: false,
        why: [{ b: "fixed" }, " — " + (f.plainLanguage || "repaired " + f.field + ".") + (beforeAfter || "")],
      });
    });
    couldnt.forEach(function (c) {
      findings.push({
        cell: c.field,
        token: REASON[c.reason] || "review",
        attn: true,
        why: [{ b: "needs you" }, " — " + (c.plainLanguage || "couldn’t repair this automatically.") + (c.detail ? " " + c.detail : "")],
      });
    });
    warnings.forEach(function (w) {
      findings.push({
        cell: w.field,
        token: "formula",
        attn: true,
        why: w.message || "starts with a spreadsheet formula character; the value was kept as-is.",
      });
    });
    var CAP = 14;
    var shown = findings.slice(0, CAP);
    if (findings.length > CAP) {
      shown.push({ cell: "+" + (findings.length - CAP) + " more", silent: true, why: ["not shown above"] });
    }

    // ---- ledger rows ----
    var didRows = fixed.map(function (f) {
      return f.plainLanguage || ["Fixed ", { b: f.field }, "."];
    });
    var kept = ["Your original file wasn’t changed — this is a new, repaired import file."];
    couldnt.forEach(function (c) {
      kept.push([
        { b: c.field }, " — " + (c.plainLanguage || "couldn’t be repaired automatically.") + (c.detail ? " " + c.detail : ""),
      ]);
    });
    warnings.forEach(function (w) {
      kept.push([
        { b: w.field },
        " — flagged a formula-style value and kept it as-is; it’s safe for Shopify import, just take care opening the CSV in a spreadsheet.",
      ]);
    });
    kept.push("Didn’t store your file — it’s read in memory and discarded.");

    // ---- lead line ----
    var lead;
    if (fixedCount > 0) {
      lead = ["Repaired ", { b: fixedCount + " issue" + (fixedCount === 1 ? "" : "s") }, " in your products export"];
      if (flaggedCount > 0) lead.push(" and flagged " + flaggedCount + " for your review");
      lead.push(". Download the repaired file below, then upload it in your Shopify admin.");
    } else if (flaggedCount > 0) {
      lead = [
        "Nothing needed an automatic repair, but ", { b: flaggedCount + " item" + (flaggedCount === 1 ? "" : "s") },
        " need your review before import. The reviewed file is ready to download below.",
      ];
    } else {
      lead = [
        "No issues found — your products export already matches Shopify’s import format. ",
        "The canonical copy is ready below if you’d like it.",
      ];
    }

    return {
      summary: summary,
      heading: fixedCount > 0 ? "Your repaired Shopify products import file is ready"
        : "We checked your Shopify products export",
      findings: shown,
      empty: lead,
      ledger: { did: didRows, kept: kept },
      download: fileB64 ? {
        file_b64: fileB64,
        filename: m.filename || safeBase(filename) + "-shopify-import.csv",
        mime: CSV_MIME,
      } : null,
    };
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".csv,.xlsx",
    extensions: ["csv", "xlsx"],
    reassure:
      "Your file is read in memory to check it against Shopify’s products import format, then discarded. " +
      "Nothing is stored, and your original file is never changed — you download a separate, repaired CSV.",
    runningLabel: "Checking and repairing your Shopify products export…",
    steps: ["Checking your export against Shopify’s products import format"],
    process: function (fileB64, api) {
      api.step(0, "on");
      return api.runTool("shopify_products_import_fix", { file_b64: fileB64, filename: api.filename }).then(function (resp) {
        api.step(0, "done");
        return toViewModel(resp, api.filename);
      });
    },
  });
})();
