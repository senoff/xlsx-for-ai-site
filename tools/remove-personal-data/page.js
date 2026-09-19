/*
 * remove-personal-data — "Remove personal data before sharing" page logic (XLS-198).
 *
 * Rides the shared shell (shell.js / shell.css). Param-free v1: upload one
 * workbook, and xlsx_redact (default `pii` mode) auto-detects structured
 * personal data — emails, phone numbers, SSNs, card/bank numbers, and PII
 * hiding in the file's own document properties — and masks ONLY those values,
 * leaving every other cell, formula, and the workbook structure intact.
 *
 * The deliverable is the before→after ledger: we SHOW what categories were
 * found and how many of each, and where (sheet!cell), then hand back a safe
 * copy to download. We deliberately NEVER echo a masked value back — the API's
 * pii_manifest carries only type/count/location, never the raw match, so a
 * value can't re-leak through this page.
 *
 * Honest about its limits: detection is pattern-based, so names and free-text
 * personal details are NOT auto-detected. That caveat is a first-class ledger
 * line ("what we couldn't touch"), not fine print — the user must eyeball the
 * copy before sharing.
 *
 * Category-deselect (choose which PII types to mask) is the deliberate follow —
 * it needs the shared params UI (same primitive as filter-rows / get-ready-safely).
 * Read-only for the source: this produces a NEW file, never touches the upload.
 */
(function () {
  "use strict";

  var XLSX_MIME =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // Plain-language label per pii_frisk type_key. Locale/format suffixes are
  // normalized away first (phone_international / phone_us → phone), so one
  // family maps to one human label. Unknown keys fall back to humanize().
  var LABELS = {
    email: "Email addresses",
    phone: "Phone numbers",
    ssn: "Social Security numbers",
    credit_card: "Card numbers",
    card: "Card numbers",
    card_pan: "Card numbers",
    iban: "Bank account numbers (IBAN)",
    bank_account: "Bank account numbers",
    bank: "Bank account numbers",
    routing_number: "Bank routing numbers",
    dob: "Dates of birth",
    date_of_birth: "Dates of birth",
    passport: "Passport numbers",
    drivers_license: "Driver’s license numbers",
    gov_id: "Government ID numbers",
    national_id: "National ID numbers",
    tax_id: "Tax ID numbers",
    ein: "Employer ID numbers",
    ip: "IP addresses",
    ip_address: "IP addresses",
    mac_address: "Device (MAC) addresses",
    address: "Postal addresses",
    postal_code: "Postal codes",
    doc_metadata_pii: "Personal info in file properties",
  };

  // Drop locale/format qualifiers so phone_international, phone_us, ssn_us,
  // gov_id_uk … collapse onto their family key before LABELS lookup.
  function familyKey(type) {
    return String(type || "")
      .replace(
        /_(us|uk|ca|eu|international|intl|domestic|national|local|generic|std|v\d+)$/i,
        ""
      );
  }

  function humanize(t) {
    var s = String(t || "personal data").replace(/_/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Personal data";
  }

  function labelFor(type) {
    var fam = familyKey(type);
    return LABELS[type] || LABELS[fam] || humanize(fam);
  }

  // A single location as a short human string. Cell PII → "Sheet1!B2";
  // document-property PII (author, title, …) → "file properties".
  function locStr(l) {
    if (!l) return "";
    if (l.surface === "doc_property") return "file properties";
    var sheet = l.sheet || "";
    if (l.cell) return sheet ? sheet + "!" + l.cell : l.cell;
    return sheet || "workbook";
  }

  // Summarize up to `cap` locations for one type into "Sheet1!B2, B3 +2 more".
  // Collapses repeated "file properties" to a single mention.
  function whereFor(locs, cap) {
    if (!locs || !locs.length) return "";
    var seen = {};
    var parts = [];
    for (var i = 0; i < locs.length; i++) {
      var s = locStr(locs[i]);
      if (!s || seen[s]) continue;
      seen[s] = 1;
      parts.push(s);
    }
    if (parts.length <= cap) return parts.join(", ");
    var shown = parts.slice(0, cap).join(", ");
    return shown + " +" + (parts.length - cap) + " more";
  }

  function safeBase(filename) {
    var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "workbook";
  }

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step, filename = api.filename;

    step(0, "on");
    // Default mode is 'pii' — auto-detect + mask only detected personal data,
    // preserving every non-PII cell, formula, and the workbook structure. The
    // safe copy comes back as _meta.file_b64; the manifest carries counts +
    // locations only (never the raw values).
    return runTool("xlsx_redact", { file_b64: fileB64 }).then(function (resp) {
      step(0, "done"); step(1, "on");
      var m = (resp && typeof resp === "object" && resp._meta) || {};
      var manifest = (m && typeof m.pii_manifest === "object" && m.pii_manifest) || {};
      step(1, "done");
      return buildResult({
        manifest: manifest,
        sheets: typeof m.sheets === "number" ? m.sheets : null,
        cleanB64: m.file_b64 || null,
        filename: filename,
      });
    });
  }

  function buildResult(ctx) {
    var man = ctx.manifest || {};
    var byType = (man && typeof man.by_type === "object" && man.by_type) || {};
    var locations = Array.isArray(man.locations) ? man.locations : [];
    var redacted =
      typeof man.redacted_count === "number"
        ? man.redacted_count
        : typeof man.findings_count === "number"
        ? man.findings_count
        : 0;
    var skipped = typeof man.skipped_count === "number" ? man.skipped_count : 0;

    // Category families sorted by count desc, then label asc — stable display.
    var types = Object.keys(byType);
    var categories = types.length;
    types.sort(function (a, b) {
      var d = (byType[b] || 0) - (byType[a] || 0);
      if (d !== 0) return d;
      var la = labelFor(a), lb = labelFor(b);
      return la < lb ? -1 : la > lb ? 1 : 0;
    });

    // Honesty line — pattern detection can't catch names or free-text PII.
    var reviewNote =
      "Names and free-text personal details aren’t auto-detected — scan the safe copy yourself before you share it.";

    // ================= nothing detected =================
    if (redacted === 0) {
      var kept0 = [
        "Your original file wasn’t changed.",
        reviewNote,
        "Read your workbook in memory to check it, then discarded it — nothing was stored.",
      ];
      return {
        summary: [{ n: 0, l: "personal-data values", cls: "ok" }],
        heading: "No personal data detected",
        empty: [
          "We scanned every sheet and the file’s own document properties and found no ",
          "emails, phone numbers, IDs, or card/bank numbers to mask. Your file is unchanged.",
        ],
        ledger: { did: [], kept: kept0 },
      };
    }

    // ---- per-category findings (before→after) ----
    var vmFindings = types.map(function (t) {
      var n = byType[t] || 0;
      var where = whereFor(
        locations.filter(function (l) { return l.type === t; }),
        3
      );
      return {
        cell: labelFor(t),
        token: "masked",
        why: [
          { b: n + " found" },
          " → masked" + (where ? " · " + where : ""),
        ],
      };
    });

    // ---- ledger: what we did ----
    var did = types.map(function (t) {
      var n = byType[t] || 0;
      return ["Masked ", { b: String(n) }, " " + lowerFirst(labelFor(t)) + "."];
    });

    // ---- ledger: what we kept / couldn't touch ----
    var kept = [
      "Your original file wasn’t changed — this is a separate safe copy.",
      "We never show the masked values back — you only see counts and where they were.",
    ];
    if (skipped > 0) {
      kept.push(
        "Left " + skipped + " near-match" + (skipped === 1 ? "" : "es") +
          " untouched — they didn’t look like real personal data on a second check."
      );
    }
    kept.push(reviewNote);
    kept.push("Didn’t store your file — it’s read in memory and discarded.");
    kept.push(
      "Choosing which categories to mask is coming next — this first version masks every kind it detects."
    );

    // ---- summary cards ----
    var summary = [
      { n: redacted, l: redacted === 1 ? "value masked" : "values masked", cls: "ok" },
      { n: categories, l: categories === 1 ? "type of personal data" : "types of personal data" },
    ];
    if (typeof ctx.sheets === "number") {
      summary.push({ n: ctx.sheets, l: ctx.sheets === 1 ? "sheet" : "sheets" });
    }

    var outName = safeBase(ctx.filename) + "-redacted.xlsx";

    // A safe copy is always produced when redacted > 0. Guard anyway: if the
    // API somehow returned no bytes, show the ledger without a broken download.
    var out = {
      summary: summary,
      heading: "Personal data masked — here’s your safe copy",
      findings: vmFindings,
      empty: [
        "Masked ", { b: String(redacted) + " value" + (redacted === 1 ? "" : "s") },
        " across ", { b: String(categories) + " categor" + (categories === 1 ? "y" : "ies") },
        " of personal data. Download the safe copy below — your original is untouched.",
      ],
      ledger: { did: did, kept: kept },
    };
    if (ctx.cleanB64) {
      out.download = { file_b64: ctx.cleanB64, filename: outName, mime: XLSX_MIME };
    }
    return out;
  }

  function lowerFirst(s) {
    var t = String(s || "");
    return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Your file is read in memory to find and mask personal data, then discarded. Nothing is stored, and your original workbook is never changed — you download a separate, safe copy.",
    runningLabel: "Removing personal data…",
    steps: ["Scanning for personal data", "Masking and writing a safe copy"],
    process: process,
  });
})();
