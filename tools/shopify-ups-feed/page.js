/*
 * shopify-ups-feed — "Turn a Shopify orders export into a UPS WorldShip batch" (XLS-817).
 *
 * Rides the shared shell (shell.js / shell.css) in params mode: upload → offer
 * optional package/service defaults (weight, box size, service level, billing)
 * → run the server tool → hand back a WorldShip batch-import CSV, one row per
 * order.
 *
 *   shopify_ups_feed { file_b64, options? } — a Shopify ORDERS export CSV in,
 *   a UPS WorldShip batch shipment-import CSV in `_meta.file_b64`; the
 *   exclusion / blank-attribute notes in `_meta.flags`.
 *
 * Every option is optional — Shopify orders can't carry weight, box size, or
 * service level, so the producer applies sensible defaults for anything left
 * blank. Read-only for the upload; the source CSV is never changed.
 */
(function () {
  "use strict";

  var UPS_MIME = "text/csv";

  function safeBase(filename) {
    var base = String(filename || "orders.csv").replace(/\.(csv|txt|tsv|xlsx)$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "orders";
  }

  // No discover call — every field is an optional shipping default, not derived
  // from the file. Placeholders show the default that applies when left blank.
  function buildForm() {
    return [
      { type: "text", name: "weight_lb", label: "Package weight (lb)", placeholder: "1" },
      { type: "text", name: "length_in", label: "Box length (in)", placeholder: "12" },
      { type: "text", name: "width_in", label: "Box width (in)", placeholder: "9" },
      { type: "text", name: "height_in", label: "Box height (in)", placeholder: "3" },
      { type: "text", name: "ups_service_code", label: "UPS service code", placeholder: "3DS" },
      {
        type: "select", name: "residential", label: "Delivery type",
        options: [
          { value: "", label: "Residential (default)" },
          { value: "true", label: "Residential" },
          { value: "false", label: "Commercial" },
        ],
      },
      {
        type: "select", name: "bill_transportation_to", label: "Bill transportation to",
        options: [
          { value: "", label: "Shipper (default)" },
          { value: "Shipper", label: "Shipper" },
          { value: "Receiver", label: "Receiver" },
          { value: "Third Party", label: "Third Party" },
        ],
      },
    ];
  }

  // Parse a positive number from a text field; return null if blank or invalid
  // (invalid is treated as "left blank" → the producer default applies).
  function posNum(v) {
    var s = String(v == null ? "" : v).trim();
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) && n > 0 ? n : null;
  }

  function process(fileB64, api, values) {
    values = values || {};
    var options = {};
    var wl = posNum(values.weight_lb); if (wl !== null) options.weight_lb = wl;
    var ln = posNum(values.length_in); if (ln !== null) options.length_in = ln;
    var wd = posNum(values.width_in); if (wd !== null) options.width_in = wd;
    var ht = posNum(values.height_in); if (ht !== null) options.height_in = ht;
    var svc = String(values.ups_service_code || "").trim(); if (svc) options.ups_service_code = svc;
    var res = String(values.residential || "").trim();
    if (res === "true") options.residential = true;
    else if (res === "false") options.residential = false;
    var bill = String(values.bill_transportation_to || "").trim();
    if (bill) options.bill_transportation_to = bill;

    var body = { file_b64: fileB64 };
    if (Object.keys(options).length) body.options = options;

    api.step(0, "on");
    return api.runTool("shopify_ups_feed", body).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");

      var meta = (resp && typeof resp === "object" && resp._meta) || {};
      var flags = Array.isArray(meta.flags) ? meta.flags : [];
      var emitted = typeof meta.row_count === "number" ? meta.row_count : 0;
      var feedB64 = meta.file_b64 || null;

      api.step(1, "done"); api.step(2, "on"); api.step(2, "done");

      var counts = countFlags(flags);

      if (emitted === 0 || !feedB64) {
        return {
          heading: "No shipments could be built",
          summary: [{ n: 0, l: "shipments", cls: "" }],
          findings: flagFindings(flags),
          empty: [
            "None of the orders in that file had a shippable destination address. ",
            "Make sure you exported ", { b: "Orders" }, " (not products), then try again — your file is unchanged.",
          ],
        };
      }

      var shipWord = emitted === 1 ? "shipment" : "shipments";
      var chips = [{ n: emitted, l: "UPS " + shipWord, cls: "ok" }];
      if (counts.excluded > 0) chips.push({ n: counts.excluded, l: "excluded", cls: "" });
      if (counts.blank > 0) chips.push({ n: counts.blank, l: counts.blank === 1 ? "warning" : "warnings", cls: "" });

      return {
        summary: chips,
        heading: "Your UPS WorldShip batch is ready",
        findings: flagFindings(flags),
        ledger: {
          did: [
            ["Built " + emitted + " " + shipWord + ", one per order with a shippable address."],
            defaultsLine(options),
          ].filter(Boolean),
          kept: [
            "Your original export wasn't changed — this only produces a new import file.",
            "Orders without a shippable address were excluded and listed above, never guessed.",
            "In WorldShip, import this file with Import/Export → Batch Import.",
          ],
        },
        download: {
          file_b64: feedB64,
          filename: safeBase(api.filename) + "-ups-worldship.csv",
          mime: UPS_MIME,
        },
      };
    });
  }

  function defaultsLine(options) {
    var overridden = Object.keys(options);
    if (!overridden.length) {
      return ["Applied the default package (1 lb, 12×9×3 in, service 3DS, residential) — Shopify orders don't carry these."];
    }
    return ["Applied your package defaults for weight, size, and service to every shipment."];
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
    params: true,
    runLabel: "Build my UPS batch",
    runningLabel: "Building your UPS batch…",
    steps: [
      "Reading your orders",
      "Building WorldShip rows",
      "Preparing your download",
    ],
    reassure:
      "Free · no signup. Your orders export is read in memory to build the WorldShip batch, then discarded. Nothing is stored, and your original file is never changed — you download a new import file. Every field below is optional; leave any blank to use the default.",
    buildForm: buildForm,
    process: process,
  });
})();
