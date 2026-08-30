/*
 * bulk-upload-shopify-metafields — page config (XLS-1208).
 *
 * Thin wrapper over the shared Shopify import builder (shopify-import.js):
 * calls the shopify_product_metafields_import producer and renders the same
 * two-bucket ledger every other page on this site renders.
 *
 * The difference from the sibling pages is what the producer accepts, not what
 * this file does: there is no column-naming grammar to obey here. The merchant's
 * own headers — "Fabric Content", "Wash Instructions", "Ingredients" — are read
 * on MEANING and mapped onto product.metafields.custom.*, and anything that
 * couldn't be placed is named in the couldnt bucket with the reason, never
 * silently dropped. So the copy below promises mapping, not formatting.
 */
(function () {
  "use strict";
  window.XFA_SHOPIFY.build({
    tool: "shopify_product_metafields_import",
    entity: "product metafields",
    readyHeading: "Your Shopify product metafields import file is ready",
    noneHeading: "We couldn’t place any of your columns",
    runningLabel: "Reading your column names and mapping them…",
    reassure:
      "Free · no signup. Your file is read in memory to work out what each column means, then discarded. Nothing is stored, and your original file is never changed — you download a separate import file.",
    steps: ["Reading your column names and mapping them to product metafields"],
    noneLead: [
      "We read your columns but couldn’t confidently place any of them on a product metafield, ",
      "so no import file was produced — and we’d rather say so than guess. Here’s what we saw in each ",
      "column and what it would need. Your original file is unchanged.",
    ],
  });
})();
