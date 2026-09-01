/*
 * shopify-google-feed — "Turn a Shopify products export into a Google feed" (XLS-817).
 *
 * Rides the shared shell (shell.js / shell.css) in params mode: upload → collect
 * the two facts a Google Merchant Center feed needs that aren't in the product
 * rows (the store domain for product links, and the currency for prices) →
 * run the server tool → hand back the feed.
 *
 *   shopify_google_feed { file_b64, options: { store_domain, currency_code } }
 *   → a tab-delimited Google Shopping product feed in `_meta.file_b64`; the
 *   never-silently-wrong exclusion / blank-attribute notes in `_meta.flags`.
 *
 * Read-only for the upload — this produces a NEW feed and never changes the
 * source CSV.
 */
(function () {
  "use strict";

  var GOOGLE_MIME = "text/tab-separated-values";

  function safeBase(filename) {
    var base = String(filename || "products.csv").replace(/\.(csv|txt|tsv|xlsx)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "products";
  }

  // No discover call — the two options are fixed, not derived from the file.
  function buildForm() {
    return [
      {
        type: "text", name: "store_domain", label: "Your store's web address",
        placeholder: "https://shop.example.com",
      },
      {
        type: "text", name: "currency_code", label: "Currency (ISO code)",
        placeholder: "USD",
      },
    ];
  }

  function process(fileB64, api, values) {
    var storeDomain = String((values && values.store_domain) || "").trim();
    var currency = String((values && values.currency_code) || "").trim().toUpperCase();

    // Both are required — Google product links need a domain and every price
    // needs a currency. Nothing is sent to the server until they're present.
    if (!storeDomain || !currency) {
      return Promise.resolve({
        heading: "Add your store domain and currency",
        empty: [
          "Google needs your ", { b: "store web address" }, " (for each product link) and a ",
          { b: "currency code" }, " (for every price) before it can build the feed. ",
          "Fill both in above — nothing was sent to the server yet.",
        ],
      });
    }

    api.step(0, "on");
    return api.runTool("shopify_google_feed", {
      file_b64: fileB64,
      options: { store_domain: storeDomain, currency_code: currency },
    }).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var flags = Array.isArray(meta.flags) ? meta.flags : [];
      var emitted = typeof meta.row_count === "number" ? meta.row_count : 0;
      var feedB64 = meta.file_b64 || null;

      api.step(1, "done"); api.step(2, "on"); api.step(2, "done");

      var counts = countFlags(flags);

      if (emitted === 0 || !feedB64) {
        return {
          heading: "No Google offers could be built",
          summary: [{ n: 0, l: "offers emitted", cls: "" }],
          findings: flagFindings(flags),
          empty: [
            "None of your products had what Google needs for an offer (a title, price, and image). ",
            "Check your export includes those columns, then try again — your file is unchanged.",
          ],
        };
      }

      var offerWord = emitted === 1 ? "offer" : "offers";
      var chips = [{ n: emitted, l: "Google " + offerWord, cls: "ok" }];
      if (counts.excluded > 0) chips.push({ n: counts.excluded, l: "excluded", cls: "" });
      if (counts.blank > 0) chips.push({ n: counts.blank, l: counts.blank === 1 ? "blank-attribute warning" : "blank-attribute warnings", cls: "" });

      return {
        summary: chips,
        heading: "Your Google Shopping feed is ready",
        findings: flagFindings(flags),
        ledger: {
          did: [
            ["Built " + emitted + " " + offerWord + " with links under ", { code: storeDomain }, " and prices in ", { code: currency }, "."],
          ],
          kept: [
            "Your original export wasn't changed — this only produces a new feed file.",
            "Products missing a title, price, or image were excluded and listed above, never guessed.",
            "In Google Merchant Center, add this file as a scheduled or manual feed upload.",
          ],
        },
        download: {
          file_b64: feedB64,
          filename: safeBase(api.filename) + "-google-feed.txt",
          mime: GOOGLE_MIME,
        },
      };
    });
  }

  function countFlags(flags) {
    var excluded = 0, blank = 0;
    flags.forEach(function (f) {
      if (f && f.kind === "excluded") excluded += 1;
      else if (f && f.kind === "blank-attribute") blank += 1;
    });
    return { excluded: excluded, blank: blank };
  }

  function flagFindings(flags) {
    return flags.slice(0, 12).map(function (f) {
      var handle = String((f && f.handle) || "").trim();
      var reason = String((f && f.reason) || "").trim();
      var tag = f && f.kind === "excluded" ? "excluded" : ("blank " + String((f && f.attribute) || "")).trim();
      var cell = (handle ? handle + " (" + tag + ")" : tag) + (reason ? " — " + reason : "");
      return { cell: cell, attn: true };
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".csv",
    extensions: ["csv"],
    params: true,
    runLabel: "Build my Google feed",
    runningLabel: "Building your Google feed…",
    steps: [
      "Mapping products to Google's fields",
      "Checking each offer",
      "Preparing your download",
    ],
    reassure:
      "Free · no signup. Your export is read in memory to build the Google feed, then discarded. Nothing is stored, and your original file is never changed — you download a new feed file.",
    buildForm: buildForm,
    process: process,
  });
})();
