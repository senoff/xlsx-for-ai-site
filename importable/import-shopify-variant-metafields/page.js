/*
 * import-shopify-variant-metafields — page config (XLS-1204).
 *
 * Thin wrapper over the shared Shopify import builder (shopify-import.js):
 * calls the shopify_variant_metafields_import producer and renders the
 * two-bucket ledger. Columns named `Variant Metafield: <namespace>.<key>`
 * are unpivoted into one import row per SKU and metafield; anything we
 * can't place lands under "what needs you".
 */
(function () {
  "use strict";
  window.XFA_SHOPIFY.build({
    tool: "shopify_variant_metafields_import",
    entity: "variant metafields",
    readyHeading: "Your Shopify variant metafields import file is ready",
    noneHeading: "We couldn’t find any variant metafield columns",
    runningLabel: "Building your variant metafields import…",
    reassure:
      "Free · no signup. Your file is read in memory to map SKUs and metafield columns to Shopify’s metafield fields, then discarded. Nothing is stored, and your original file is never changed — you download a separate import file.",
    steps: ["Mapping your SKUs and metafield columns to Shopify’s metafield fields"],
    noneLead: [
      "We couldn’t find a SKU column and metafield columns to build an import from, ",
      "so no import file was produced. Here’s what each column needs. Your original file is unchanged.",
    ],
  });
})();
