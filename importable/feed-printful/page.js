/*
 * feed-printful/page.js — XLS-809. Produce a Shopify products-import CSV from a
 * Printful blank-product catalog.
 *
 * No file upload: the merchant enters Printful catalog product IDs. We pull the
 * public catalog snapshot (printful_catalog_pull — no merchant credential, it
 * reads Printful's public product catalog) and map it to a Shopify products
 * import (printful_catalog_import), reusing the shared shell transport
 * (window.XFA.runTool / key handling / download) and the shopify-import ledger
 * view-model. The Printful catalog is read-only; nothing is stored.
 */
(function () {
  "use strict";

  // toViewModel reads cfg.entity / cfg.readyHeading / cfg.noneHeading for its
  // copy; the ledger shape (did/couldnt/warnings/summary) is identical to the
  // Shopify file-producer tools, so the mapping is shared verbatim.
  var VM_CFG = {
    entity: "products",
    readyHeading: "Your Shopify products import file is ready",
    noneHeading: "We couldn’t build an import from those product IDs",
    reassure: "We read Printful’s public catalog for the IDs you enter — nothing is stored.",
  };

  // Accept one id per row, or a comma/space-separated list pasted into a single
  // row. Keep only strictly-positive integers; de-dupe; cap at the pull route's
  // documented max of 20.
  function parseIds(rows) {
    var ids = [];
    (rows || []).forEach(function (r) {
      var raw = r && r.id != null ? String(r.id).trim() : "";
      raw.split(/[\s,]+/).forEach(function (tok) {
        if (!tok) return;
        var n = parseInt(tok, 10);
        if (n > 0 && String(n) === tok.replace(/^0+/, "")) ids.push(n);
      });
    });
    var seen = {}, out = [];
    ids.forEach(function (n) { if (!seen[n]) { seen[n] = 1; out.push(n); } });
    return out.slice(0, 20);
  }

  window.XFA.mount("#xfa-panel", {
    noFile: true,
    startName: "printful-catalog",
    reassure: VM_CFG.reassure,
    runLabel: "Build my Shopify import",
    againLabel: "Start over",
    backLabel: "Start over",
    buildForm: function () {
      return [
        {
          type: "repeat",
          name: "ids",
          label: "Printful catalog product IDs (e.g. 71 for the Bella + Canvas 3001 tee)",
          addLabel: "Add another product ID",
          min: 1,
          max: 20,
          row: [{ type: "text", name: "id", label: "", placeholder: "e.g. 71" }],
        },
        { type: "text", name: "markup", label: "Retail markup × (default 2.0)", placeholder: "2.0" },
      ];
    },
    process: function (_b64, api, values) {
      var ids = parseIds(values && values.ids);
      if (!ids.length) {
        throw new Error("Enter at least one Printful catalog product ID (a positive number, e.g. 71).");
      }
      var markup = parseFloat(values && values.markup);
      return api.runTool("printful_catalog_pull", { product_ids: ids }).then(function (pull) {
        var snap = pull && pull._meta && pull._meta.snapshot_b64;
        if (!snap) {
          throw new Error("Couldn’t pull a catalog for those IDs — check the product IDs and try again.");
        }
        var body = { snapshot_b64: snap, filename: "printful-catalog" };
        if (markup > 0) body.markup_multiplier = markup;
        return api.runTool("printful_catalog_import", body);
      }).then(function (imp) {
        var m = (imp && typeof imp === "object" && imp._meta) || {};
        return window.XFA_SHOPIFY.toViewModel(m, "printful-catalog", VM_CFG);
      });
    },
  });
})();
