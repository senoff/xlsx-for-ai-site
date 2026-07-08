/*
 * import-shopify-collections — page config (XLS-207).
 *
 * Thin wrapper over the shared Shopify import builder (shopify-import.js):
 * calls the shopify_collections_import producer and renders the two-bucket
 * ledger. All rendering lives in the shared helper; this file supplies only
 * the route name and per-page copy.
 */
(function () {
  "use strict";
  window.XFA_SHOPIFY.build({
    tool: "shopify_collections_import",
    entity: "collection",
    readyHeading: "Your Shopify collections import file is ready",
    noneHeading: "We couldn’t map your collection columns automatically",
    runningLabel: "Building your Shopify collections import…",
    reassure:
      "Free · no signup. Your file is read in memory to map its columns to Shopify’s collection fields, then discarded. Nothing is stored, and your original file is never changed — you download a separate import CSV.",
    steps: ["Mapping your columns to Shopify’s collection fields"],
  });
})();
