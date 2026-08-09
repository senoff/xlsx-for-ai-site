/*
 * shopify-amazon-feed — "Turn a Shopify products export into an Amazon feed" (XLS-817).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + the one server call:
 *
 *   shopify_amazon_feed { file_b64 } — a Shopify native PRODUCTS export CSV in,
 *   an Amazon flat-file inventory feed (tab-delimited Template rows) out. The
 *   serialized feed is base64 in `_meta.file_b64`; the producer ledger
 *   (what mapped, what couldn't, the row tallies) is in `_meta.ledger`.
 *
 * No options: the core-field mapping is deterministic, and a product missing a
 * required identifier is excluded to the ledger, never guessed. Read-only for
 * the upload — this produces a NEW file and never changes the source CSV.
 */
(function () {
  "use strict";

  var AMAZON_MIME = "text/tab-separated-values";

  function safeBase(filename) {
    var base = String(filename || "products.csv").replace(/\.(csv|txt|tsv|xlsx)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "products";
  }

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step, filename = api.filename;

    step(0, "on");
    return runTool("shopify_amazon_feed", { file_b64: fileB64 }).then(function (resp) {
      step(0, "done"); step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var ledger = (meta.ledger && typeof meta.ledger === "object") ? meta.ledger : {};
      var summary = (ledger.summary && typeof ledger.summary === "object") ? ledger.summary : {};
      var rowsIn = typeof summary.rowsIn === "number" ? summary.rowsIn : 0;
      var emitted = typeof meta.row_count === "number" ? meta.row_count : 0;
      var flagged = typeof summary.flagged === "number" ? summary.flagged : 0;
      var feedB64 = meta.file_b64 || null;

      step(1, "done"); step(2, "on");
      step(2, "done");

      // No listings emitted — the export had no product rows that carry the
      // core fields Amazon requires. Offer no download; nothing was produced.
      if (emitted === 0 || !feedB64) {
        return {
          heading: "No Amazon listings could be built",
          summary: [{ n: 0, l: "listings emitted", cls: "" }],
          findings: buildFindings(ledger),
          empty: [
            "None of the ", { b: String(rowsIn) + " source row" + (rowsIn === 1 ? "" : "s") },
            " had the core fields Amazon needs (a title, price, and a valid identifier). ",
            "Check your export includes those columns, then try again — your file is unchanged.",
          ],
        };
      }

      var listWord = emitted === 1 ? "listing" : "listings";
      var summaryChips = [
        { n: emitted, l: "Amazon " + listWord, cls: "ok" },
        { n: rowsIn, l: rowsIn === 1 ? "source row" : "source rows" },
      ];
      if (flagged > 0) summaryChips.push({ n: flagged, l: "flagged", cls: "" });

      var did = mapDid(ledger);

      return {
        summary: summaryChips,
        heading: "Your Amazon inventory feed is ready",
        findings: buildFindings(ledger),
        ledger: {
          did: did.length ? did : [["Mapped your products into Amazon's flat-file template columns."]],
          kept: [
            "Your original export wasn't changed — this only produces a new feed file.",
            "A product missing a required identifier (UPC/EAN/GTIN) was left out and listed above, never guessed.",
            "Upload the downloaded file in Seller Central under Inventory → Add Products via Upload.",
          ],
        },
        download: {
          file_b64: feedB64,
          filename: safeBase(filename) + "-amazon-feed.txt",
          mime: AMAZON_MIME,
        },
      };
    });
  }

  // Producer ledger `did` (array of { plainLanguage }) → rich-text lines.
  function mapDid(ledger) {
    var did = Array.isArray(ledger.did) ? ledger.did : [];
    return did.slice(0, 8).map(function (d) {
      return [String((d && d.plainLanguage) || "")];
    }).filter(function (l) { return l[0] !== ""; });
  }

  // Producer ledger `couldnt` (array of { field, plainLanguage }) → findings
  // rows the shell renders as "here's what we couldn't do", with attention.
  function buildFindings(ledger) {
    var couldnt = Array.isArray(ledger.couldnt) ? ledger.couldnt : [];
    return couldnt.slice(0, 12).map(function (c) {
      var field = String((c && c.field) || "").trim();
      var why = String((c && c.plainLanguage) || "").trim();
      var cell = field ? field + " — " + why : why;
      return { cell: cell, attn: true };
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".csv",
    extensions: ["csv"],
    reassure:
      "Free · no signup. Your export is read in memory to build the Amazon feed, then discarded. Nothing is stored, and your original file is never changed — you download a new feed file.",
    runningLabel: "Building your Amazon feed…",
    steps: [
      "Reading your products export",
      "Mapping products to Amazon's template",
      "Preparing your download",
    ],
    process: process,
  });
})();
