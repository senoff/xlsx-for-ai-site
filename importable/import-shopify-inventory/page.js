/*
 * import-shopify-inventory — page config (XLS-208).
 *
 * Thin wrapper over the shared Shopify import builder (shopify-import.js):
 * calls the shopify_inventory_import producer and renders the two-bucket
 * ledger. Decimal quantities, blank rows, and unmatched SKUs are flagged
 * server-side (whole-number native rule) and land under "what needs you".
 */
(function () {
  "use strict";
  window.XFA_SHOPIFY.build({
    tool: "shopify_inventory_import",
    entity: "inventory",
    readyHeading: "Your Shopify inventory import file is ready",
    noneHeading: "We couldn’t map your inventory columns automatically",
    runningLabel: "Building your Shopify inventory import…",
    reassure:
      "Your file is read in memory to map SKUs and quantities to Shopify’s inventory fields, then discarded. Nothing is stored, and your original file is never changed — you download a separate import CSV.",
    steps: ["Mapping your SKUs and quantities to Shopify’s inventory fields"],
  });
})();
