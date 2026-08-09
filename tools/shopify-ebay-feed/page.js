/*
 * shopify-ebay-feed — "Turn a Shopify products export into an eBay feed" (XLS-817).
 *
 * The one feed that needs facts the product rows don't carry: eBay wants a
 * numeric leaf category + condition PER product type, and business-policy
 * fields per listing. So this page runs in params mode with a discover step:
 *
 *   discover  — read the uploaded products CSV in the browser and list the
 *               distinct Shopify "Type" values (falling back to "Product
 *               Category"), the exact key the server maps on.
 *   buildForm — one category-id + condition-id pair per discovered type, plus
 *               the business-policy options (location, handling time, returns,
 *               shipping).
 *   process   — reassemble category_map + options and call:
 *   shopify_ebay_feed { file_b64, category_map, options } → an eBay File
 *   Exchange Basic Template CSV in `_meta.file_b64`; the did/couldnt/summary
 *   ledger in `_meta.ledger`.
 *
 * A type with no category mapping is excluded to the ledger, never guessed —
 * a wrong eBay category is a policy violation, not a cosmetic slip.
 * Read-only for the upload; the source CSV is never changed.
 */
(function () {
  "use strict";

  var EBAY_MIME = "text/csv";

  // Stashed at discover() and read back in process() — the primitive hands
  // process only (b64, api, values), not the discovered object.
  var discovered = { types: [] };

  function safeBase(filename) {
    var base = String(filename || "products.csv").replace(/\.(csv|txt|tsv|xlsx)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "products";
  }

  // ---- decode + CSV parse (browser side, for the type list only) ----
  function b64ToText(b64) {
    var bin = atob(String(b64 || ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var text = new TextDecoder("utf-8").decode(bytes);
    return text.replace(/^﻿/, "");
  }

  // Minimal RFC-4180 CSV parse into rows of string cells. Handles quoted
  // fields, escaped quotes (""), and quoted newlines. Sufficient for reading
  // a Shopify export's header + Type column; the server does the real parse.
  function parseCsv(text) {
    var rows = [], row = [], cell = "", i = 0, inQ = false, n = text.length;
    while (i < n) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        cell += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === ",") { row.push(cell); cell = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
      cell += c; i++;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function discover(b64, api) {
    return Promise.resolve().then(function () {
      var rows = parseCsv(b64ToText(b64));
      if (!rows.length) throw new Error("That file looks empty. Export your products from Shopify and try again.");
      var header = rows[0].map(function (h) { return String(h == null ? "" : h).trim(); });
      function idxOf(name) {
        for (var j = 0; j < header.length; j++) if (header[j].toLowerCase() === name) return j;
        return -1;
      }
      var typeIdx = idxOf("type");
      var pcIdx = idxOf("product category");
      if (typeIdx === -1 && pcIdx === -1) {
        throw new Error("We couldn't find a “Type” or “Product Category” column — that's how eBay categories are mapped. Check you exported Products, then try again.");
      }
      var seen = {}, types = [];
      for (var r = 1; r < rows.length; r++) {
        var t = typeIdx >= 0 ? String(rows[r][typeIdx] || "").trim() : "";
        if (!t && pcIdx >= 0) t = String(rows[r][pcIdx] || "").trim();
        if (!t || seen[t]) continue;
        seen[t] = 1;
        types.push(t);
      }
      if (!types.length) {
        throw new Error("Your products don't have any Type (or Product Category) values filled in — eBay needs those to map categories. Add them in Shopify, then try again.");
      }
      // Cap the form at a sane number of type rows; the rest still convert but
      // are excluded to the ledger until you map them.
      if (types.length > 40) types = types.slice(0, 40);
      discovered = { types: types };
      return discovered;
    });
  }

  function buildForm(d) {
    var fields = [];
    var types = (d && d.types) || [];
    types.forEach(function (t, i) {
      fields.push({
        type: "text", name: "cat_" + i,
        label: "eBay category ID for “" + t + "”",
        placeholder: "e.g. 20625",
      });
      fields.push({
        type: "text", name: "cond_" + i,
        label: "Condition ID for “" + t + "”",
        placeholder: "1000 = New",
      });
    });
    fields.push({ type: "text", name: "location", label: "Item location", placeholder: "Austin, TX" });
    fields.push({ type: "text", name: "dispatch_time_max", label: "Handling time (days)", placeholder: "3" });
    fields.push({ type: "text", name: "returns_accepted_option", label: "Returns option", placeholder: "ReturnsAccepted" });
    fields.push({ type: "text", name: "shipping_type", label: "Shipping type", placeholder: "Flat" });
    fields.push({ type: "text", name: "duration", label: "Listing duration (optional)", placeholder: "GTC" });
    fields.push({ type: "text", name: "format", label: "Listing format (optional)", placeholder: "FixedPrice" });
    return fields;
  }

  function process(fileB64, api, values) {
    values = values || {};
    var types = discovered.types || [];

    // Reassemble the category map from the per-type field pairs. A type is only
    // mapped when BOTH ids are present; a half-filled pair is treated as unmapped
    // (the product converts but is excluded to the ledger) rather than sent as
    // a partial the server would reject.
    var categoryMap = {};
    var mappedCount = 0;
    types.forEach(function (t, i) {
      var cat = String(values["cat_" + i] || "").trim();
      var cond = String(values["cond_" + i] || "").trim();
      if (cat && cond) {
        categoryMap[t] = { category_id: cat, condition_id: cond };
        mappedCount += 1;
      }
    });

    var location = String(values.location || "").trim();
    var dispatch = String(values.dispatch_time_max || "").trim();
    var returns = String(values.returns_accepted_option || "").trim();
    var shipping = String(values.shipping_type || "").trim();
    var duration = String(values.duration || "").trim();
    var format = String(values.format || "").trim();

    // Guard rails before any server call: at least one mapped type, and the four
    // required policy fields. These mirror the server's own requirements so the
    // visitor gets an instructive message here instead of a bare 400.
    if (mappedCount === 0) {
      return Promise.resolve({
        heading: "Map at least one product type",
        empty: [
          "Fill in an ", { b: "eBay category ID and condition ID" },
          " for at least one of your product types above. eBay won't accept a listing without a real ",
          "category, so we never guess one — nothing was sent to the server yet.",
        ],
      });
    }
    if (!location || !dispatch || !returns || !shipping) {
      return Promise.resolve({
        heading: "Fill in your listing policies",
        empty: [
          "eBay needs an ", { b: "item location" }, ", ", { b: "handling time" }, ", ",
          { b: "returns option" }, ", and ", { b: "shipping type" },
          " for every listing. Add the ones left blank above, then run it again.",
        ],
      });
    }

    var options = {
      location: location,
      dispatch_time_max: dispatch,
      returns_accepted_option: returns,
      shipping_type: shipping,
    };
    if (duration) options.duration = duration;
    if (format) options.format = format;

    api.step(0, "on");
    return api.runTool("shopify_ebay_feed", {
      file_b64: fileB64,
      category_map: categoryMap,
      options: options,
    }).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var ledger = (meta.ledger && typeof meta.ledger === "object") ? meta.ledger : {};
      var summary = (ledger.summary && typeof ledger.summary === "object") ? ledger.summary : {};
      var rowsIn = typeof summary.rowsIn === "number" ? summary.rowsIn : 0;
      var emitted = typeof meta.row_count === "number" ? meta.row_count : 0;
      var excluded = typeof summary.rowsExcluded === "number" ? summary.rowsExcluded : 0;
      var feedB64 = meta.file_b64 || null;

      api.step(1, "done"); api.step(2, "on"); api.step(2, "done");

      if (emitted === 0 || !feedB64) {
        return {
          heading: "No eBay listings could be built",
          summary: [{ n: 0, l: "listings", cls: "" }],
          findings: couldntFindings(ledger),
          empty: [
            "None of your ", { b: String(rowsIn) + " source row" + (rowsIn === 1 ? "" : "s") },
            " matched a mapped type with a published, priced variant. Map the types you're selling ",
            "above (see what was skipped), then try again — your file is unchanged.",
          ],
        };
      }

      var listWord = emitted === 1 ? "listing" : "listings";
      var chips = [
        { n: emitted, l: "eBay " + listWord, cls: "ok" },
        { n: mappedCount, l: mappedCount === 1 ? "type mapped" : "types mapped" },
      ];
      if (excluded > 0) chips.push({ n: excluded, l: "excluded", cls: "" });

      return {
        summary: chips,
        heading: "Your eBay File Exchange feed is ready",
        findings: couldntFindings(ledger),
        ledger: {
          did: [
            ["Built " + emitted + " " + listWord + " from " + mappedCount + " mapped " + (mappedCount === 1 ? "type" : "types") + "."],
          ],
          kept: [
            "Your original export wasn't changed — this only produces a new feed file.",
            "A product whose type you didn't map was excluded and listed above — an eBay category is never guessed.",
            "In Seller Hub, upload this file with File Exchange (or Seller Hub Reports → Upload).",
          ],
        },
        download: {
          file_b64: feedB64,
          filename: safeBase(api.filename) + "-ebay-file-exchange.csv",
          mime: EBAY_MIME,
        },
      };
    });
  }

  // Producer ledger `couldnt` (array of { field, plainLanguage }) → findings.
  function couldntFindings(ledger) {
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
    params: true,
    discoverLabel: "Reading your product types…",
    runLabel: "Build my eBay feed",
    runningLabel: "Building your eBay feed…",
    steps: [
      "Mapping products to eBay listings",
      "Preparing your download",
    ],
    reassure:
      "Free · no signup. Your export is read in memory to build the eBay feed, then discarded. Nothing is stored, and your original file is never changed — you download a new feed file. We read your product types in your browser to build the form below.",
    discover: discover,
    buildForm: buildForm,
    process: process,
  });
})();
