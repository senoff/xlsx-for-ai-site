/*
 * import-shopify-redirects — page config (XLS-209).
 *
 * Thin wrapper over the shared Shopify import builder (shopify-import.js):
 * calls the shopify_url_redirects_import producer and renders the two-bucket
 * ledger. Blank targets and absolute URLs where Shopify wants a path are
 * flagged server-side and land under "what needs you".
 */
(function () {
  "use strict";
  window.XFA_SHOPIFY.build({
    tool: "shopify_url_redirects_import",
    entity: "redirect",
    readyHeading: "Your Shopify URL redirects import file is ready",
    noneHeading: "We couldn’t map your redirect columns automatically",
    runningLabel: "Building your Shopify redirects import…",
    reassure:
      "Your file is read in memory to map your old and new paths to Shopify’s redirect fields, then discarded. Nothing is stored, and your original file is never changed — you download a separate import CSV.",
    steps: ["Mapping your old and new paths to Shopify’s redirect fields"],
  });
})();
