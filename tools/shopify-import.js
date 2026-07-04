/*
 * shopify-import.js — shared page logic for the Shopify import builders
 * (XLS-207 collections, XLS-208 inventory, XLS-209 URL redirects).
 *
 * All three ride the shared shell (shell.js / shell.css) and call one
 * stateless file-producer route each. The route returns a two-bucket ledger
 * (_meta.ledger {did, couldnt, warnings, summary}) plus the mapped import CSV
 * (_meta.file_b64). Every source column lands in exactly one of did/couldnt —
 * nothing silently vanishes — and the remediation text for anything we can't
 * map is authored server-side (so the "connect your store in Importable"
 * guidance stays on-brand and consistent), which is why the three pages differ
 * only in copy: the rendering is identical.
 *
 * Launch posture is merchant-reviewed FILE PRODUCER, not an autonomous write:
 * we hand back a reviewed CSV the merchant uploads in their Shopify admin. We
 * name no competitor and claim no exclusivity — just "here's a clean import
 * file, here's what needs your eyes."
 *
 * Read-only for the source: this produces a NEW CSV and never changes the
 * uploaded file.
 */
(function () {
  "use strict";

  var CSV_MIME = "text/csv";

  // Machine reason code → short chip label for a couldnt row.
  var REASON = {
    no_match: "no match",
    low_confidence: "unsure",
    value_mismatch: "value mismatch",
    ai_unavailable: "mapping offline",
    out_of_scope_inventory: "out of scope",
    live_store_required: "needs your store",
    ambiguous: "ambiguous",
  };

  function safeBase(filename) {
    var base = String(filename || "shopify.csv").replace(/\.(csv|xlsx?|ods)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "shopify";
  }

  function toViewModel(m, filename, cfg) {
    var ledger = (m && m.ledger) || {};
    var did = Array.isArray(ledger.did) ? ledger.did : [];
    var couldnt = Array.isArray(ledger.couldnt) ? ledger.couldnt : [];
    var warnings = Array.isArray(ledger.warnings) ? ledger.warnings : [];
    var sum = ledger.summary || {};
    var fileB64 = m.file_b64 || null;

    var mapped = typeof sum.columnsMapped === "number" ? sum.columnsMapped : did.length;
    var flagged = typeof sum.flagged === "number" ? sum.flagged : couldnt.length;
    var rowsIn = typeof sum.rowsIn === "number" ? sum.rowsIn : null;

    // ---- summary cards ----
    var summary = [
      { n: mapped, l: mapped === 1 ? "column mapped" : "columns mapped", cls: mapped > 0 ? "ok" : "" },
    ];
    if (flagged > 0) summary.push({ n: flagged, l: "to review", cls: "bad" });
    if (rowsIn != null) summary.push({ n: rowsIn, l: rowsIn === 1 ? "row" : "rows" });

    // ---- per-column findings (did → couldnt → warnings), capped ----
    var findings = [];
    did.forEach(function (d) {
      findings.push({
        cell: d.sourceHeader,
        token: "→ " + d.targetField,
        attn: false,
        why: [{ b: "mapped" }, " — " + (d.plainLanguage || "mapped to " + d.targetField + ".")],
      });
    });
    couldnt.forEach(function (c) {
      var extra = c.remediation ? " " + c.remediation : "";
      findings.push({
        cell: c.field,
        token: REASON[c.reason] || "review",
        attn: true,
        why: [{ b: "needs you" }, " — " + (c.plainLanguage || "couldn’t map this automatically.") + extra],
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

    // ---- ledger rows ----
    var didRows = did.map(function (d) {
      return d.plainLanguage || ["Mapped ", { b: d.sourceHeader }, " → " + d.targetField + "."];
    });
    var kept = ["Your original file wasn’t changed — this is a new import file."];
    couldnt.forEach(function (c) {
      kept.push([
        { b: c.field }, " — " + (c.plainLanguage || "couldn’t be mapped.") + (c.remediation ? " " + c.remediation : ""),
      ]);
    });
    warnings.forEach(function (w) {
      kept.push([
        { b: w.column },
        " — flagged a formula-style value; it’s safe for Shopify import, just take care opening the CSV in a spreadsheet.",
      ]);
    });
    kept.push("Didn’t store your file — it’s read in memory and discarded.");

    // ---- ready vs honest-decline ----
    if (mapped > 0 && fileB64) {
      var lead = [
        "Mapped ", { b: mapped + " column" + (mapped === 1 ? "" : "s") },
        " to Shopify’s " + cfg.entity + " import format",
      ];
      if (flagged > 0) lead.push(" and flagged " + flagged + " for your review");
      lead.push(". Download the import file below, then upload it in your Shopify admin.");
      return {
        summary: summary,
        heading: cfg.readyHeading,
        findings: shown,
        empty: lead,
        ledger: { did: didRows, kept: kept },
        download: {
          file_b64: fileB64,
          filename: m.filename || safeBase(filename) + "-shopify-import.csv",
          mime: CSV_MIME,
        },
      };
    }

    // Nothing mapped (e.g. the mapper is offline, or no column matched): no
    // download — an import file with no mapped columns wouldn't help. Show what
    // each column needs instead. This is the spec-sanctioned honest-decline.
    return {
      summary: summary,
      heading: cfg.noneHeading,
      findings: shown,
      empty: cfg.noneLead || [
        "We couldn’t confidently map your columns to Shopify’s " + cfg.entity +
          " fields, so no import file was produced. ",
        "Here’s what each column needs. Your original file is unchanged.",
      ],
      ledger: { did: didRows, kept: kept },
    };
  }

  // Mount a Shopify import builder page. cfg supplies the tool route + per-page
  // copy; the ledger→view-model mapping is shared.
  function build(cfg) {
    function process(fileB64, api) {
      api.step(0, "on");
      return api.runTool(cfg.tool, { file_b64: fileB64, filename: api.filename }).then(function (resp) {
        api.step(0, "done");
        var m = (resp && typeof resp === "object" && resp._meta) || {};
        return toViewModel(m, api.filename, cfg);
      });
    }
    window.XFA.mount(cfg.mountSel || "#xfa-panel", {
      accept: ".csv,.xlsx",
      extensions: ["csv", "xlsx"],
      reassure: cfg.reassure,
      runningLabel: cfg.runningLabel,
      steps: cfg.steps || ["Mapping your columns to Shopify’s import fields"],
      process: process,
    });
  }

  window.XFA_SHOPIFY = { build: build };
})();
