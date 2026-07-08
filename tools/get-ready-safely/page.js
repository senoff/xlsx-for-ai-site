/*
 * get-ready-safely — "Get this ready to send safely" page logic (XLS-205).
 *
 * The compound pre-flight: before you send a spreadsheet outside your company,
 * one pass scans SIX leak vectors, cleans the three that are safe to clean
 * automatically, and REPORTS the three that are your call — then hands back a
 * cleaned copy. The original upload is never touched.
 *
 *   Cleaned for you (destructive — all from ONE xlsx_redact call, mode=pii +
 *   strip_comments + strip_metadata + strip_macros, so the before→after ledger
 *   is drawn from a single manifest):
 *     1. Personal data (PII)      — masked values
 *     2. Document metadata        — author / company / revision cleared
 *     3. Internal notes/comments  — cell comments removed
 *     4. Macros (VBA)             — stripped + DISCLOSED via manifest.macros_removed
 *
 *   Macros are an OPT-IN, DISCLOSED clean (XLS-224 ruling): a macro-enabled file
 *   is routinely blocked by a recipient's security, so the safe-to-send copy
 *   removes them and says so — the original keeps them. This is NOT a silent
 *   strip: the redact route only strips because we pass strip_macros, and the
 *   count is reported back for the ledger.
 *
 *   Surfaced for you to decide (report-only — NEVER silently removed):
 *     5. Hidden sheets            — xlsx_list_sheets (Visibility column)
 *     6. External links & paths   — xlsx_external_links + xlsx_hyperlinks
 *
 * Honesty is a first-class ledger line: pattern-based PII misses names/free
 * text, and hidden ROWS/COLUMNS inside a sheet aren't auto-flagged — the ledger
 * says so plainly. A detector that fails becomes a "couldn't check — review
 * manually" line, never a silent all-clear (this is a safety tool).
 *
 * Read-only for the source: produces a NEW file, never mutates the upload.
 */
(function () {
  "use strict";

  var XLSX_MIME =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }
  function s(n) { return n === 1 ? "" : "s"; }

  function safeBase(filename) {
    var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
    base = base
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .trim();
    return base || "workbook";
  }

  // ---- report-vector extractors (null = the detector couldn't run) --------
  function hiddenSheetNames(resp, api) {
    if (!resp || resp.__err) return null;
    var rows = api.parseTable(api.textOf(resp));
    var names = [];
    for (var i = 0; i < rows.length; i++) {
      var v = String(rows[i].Visibility || "").toLowerCase();
      if (v === "hidden" || v === "veryhidden") names.push(rows[i].Name || "(unnamed)");
    }
    return names;
  }
  function externalLinkCount(resp) {
    if (!resp || resp.__err) return null;
    var m = resp._meta || {};
    return num(m.external_link_count, 0);
  }
  // Only hyperlinks that point OUT of the workbook leak infrastructure —
  // in-workbook (#Sheet!A1) and mailto links are harmless, so exclude them.
  function riskyHyperlinkCount(resp, api) {
    if (!resp || resp.__err) return null;
    var rows = api.parseTable(api.textOf(resp)), n = 0;
    for (var i = 0; i < rows.length; i++) {
      var k = String(rows[i].Kind || "").toLowerCase();
      if (k === "external" || k === "unknown") n++;
    }
    return n;
  }
  function macroInfo(resp) {
    if (!resp || resp.__err) return null;
    var m = resp._meta || {};
    return { has: !!m.has_macros, count: num(m.module_count, 0) };
  }

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step;
    var errNull = function () { return { __err: true }; };

    step(0, "on");
    // One redact call does all three destructive cleans; its manifest is the
    // single source for the before→after ledger.
    var cleanBody = {
      file_b64: fileB64,
      options: { mode: "pii", strip_comments: true, strip_metadata: true, strip_macros: true },
    };
    return runTool("xlsx_redact", cleanBody).then(function (redactResp) {
      step(0, "done"); step(1, "on");
      var clean = (redactResp && redactResp._meta) || {};
      // Report scans run on the ORIGINAL upload — we describe what's actually in
      // the file the user is about to send, not the cleaned copy.
      return Promise.all([
        runTool("xlsx_list_sheets", { file_b64: fileB64 }).catch(errNull),
        runTool("xlsx_external_links", { file_b64: fileB64 }).catch(errNull),
        runTool("xlsx_hyperlinks", { file_b64: fileB64 }).catch(errNull),
        runTool("xlsx_macros", { file_b64: fileB64 }).catch(errNull),
      ]).then(function (r) {
        step(1, "done"); step(2, "on");
        var vm = buildResult({
          clean: clean,
          hidden: hiddenSheetNames(r[0], api),
          extLinks: externalLinkCount(r[1]),
          hyperlinks: riskyHyperlinkCount(r[2], api),
          macros: macroInfo(r[3]),
          filename: api.filename,
        });
        step(2, "done");
        return vm;
      });
    });
  }

  function buildResult(ctx) {
    var clean = ctx.clean || {};
    var man = (clean.pii_manifest && typeof clean.pii_manifest === "object" && clean.pii_manifest) || {};
    var byType = (man.by_type && typeof man.by_type === "object" && man.by_type) || {};
    // docProps identity (author, company, last-modified-by) is caught by the PII
    // scanner as doc_metadata_pii (surface: doc_property), so in mode:pii it lands
    // in the PII manifest and metadata_cleared stays empty — the scan scrubbed
    // those fields before strip_metadata ran. Split the manifest by that type so
    // the ledger attributes cell values and document-metadata to their own lines
    // instead of lumping identity under "personal data."
    var docMetaPii = num(byType.doc_metadata_pii, 0);
    var totalRedacted = num(man.redacted_count, num(man.findings_count, 0));
    var piiCount = Math.max(0, totalRedacted - docMetaPii);
    var piiCats = 0;
    for (var bk in byType) {
      if (byType.hasOwnProperty(bk) && bk !== "doc_metadata_pii") piiCats++;
    }
    var metaCleared = docMetaPii + (Array.isArray(clean.metadata_cleared) ? clean.metadata_cleared.length : 0);
    var comments = num(clean.comments_removed, 0);
    // Macros: authoritative count of VBA projects the redact call actually
    // stripped (we passed strip_macros). Disclosed as an auto-clean, not silent.
    // The xlsx_macros scan on the original enriches the ledger with module count.
    var macrosRemoved = num(clean.macros_removed, 0);
    var macroModules = (ctx.macros && ctx.macros.count) || 0;
    var cleanB64 = clean.file_b64 || null;
    var destructive = piiCount + metaCleared + comments + macrosRemoved;

    // ---- ledger: what we cleaned (green ✓) ----
    var did = [];
    if (piiCount > 0) {
      did.push(["Masked ", { b: String(piiCount) }, " personal data value" + s(piiCount) +
        (piiCats > 1 ? " across " + piiCats + " categories" : "") +
        " (emails, phone numbers, IDs and similar)."]);
    }
    if (metaCleared > 0) {
      did.push(["Cleared ", { b: String(metaCleared) }, " identifying field" + s(metaCleared) +
        " from the file’s properties (author, company, revision history)."]);
    }
    if (comments > 0) {
      did.push(["Removed ", { b: String(comments) }, " cell comment" + s(comments) +
        " that may hold internal notes."]);
    }
    if (macrosRemoved > 0) {
      var modNote = macroModules > 0 ? " (" + macroModules + " module" + s(macroModules) + ")" : "";
      did.push(["Removed the file’s ", { b: "VBA macros" }, modNote +
        " so the copy is safe to send — a macro-enabled file is routinely blocked by the recipient’s security. Your original still has them, so clean the original by hand in Excel instead if the recipient actually needs the macros."]);
    }

    // ---- findings: what you should review (never removed for you) ----
    var findings = [];
    var couldntCheck = [];

    if (ctx.hidden === null) {
      couldntCheck.push("We couldn’t check for hidden sheets this time — open the copy and look for any you didn’t expect.");
    } else if (ctx.hidden.length > 0) {
      var names = ctx.hidden.slice(0, 4).join(", ") + (ctx.hidden.length > 4 ? ", +" + (ctx.hidden.length - 4) + " more" : "");
      findings.push({
        cell: "Hidden sheets",
        token: "your call",
        why: [{ b: ctx.hidden.length + " hidden sheet" + s(ctx.hidden.length) }, ": " + names +
          ". These stay in the copy and the recipient can unhide them — delete them in Excel if they shouldn’t go out."],
      });
    }

    var extNull = ctx.extLinks === null, hypNull = ctx.hyperlinks === null;
    if (extNull && hypNull) {
      couldntCheck.push("We couldn’t check for external links this time — review any links to other files before sending.");
    } else {
      var extTotal = (ctx.extLinks || 0) + (ctx.hyperlinks || 0);
      if (extTotal > 0) {
        findings.push({
          cell: "External links & file paths",
          token: "your call",
          why: [{ b: extTotal + " external reference" + s(extTotal) }, " to other files, data connections or web links. " +
            "Links to network shares (\\\\server) or local paths (C:\\Users\\…) reveal your infrastructure and will break for the recipient. We leave them in place — remove them in Excel if you’d rather not share them."],
        });
      }
    }

    // Macros are handled as a disclosed auto-clean (see the "did" ledger above),
    // not a review item — the copy is macro-free and we say so, the original
    // keeps them. A failed macro scan only costs us the module-count enrichment;
    // the redact call's macros_removed is the authoritative disclosure.

    // ---- ledger: what we didn’t touch / honesty ----
    var kept = ["Your original file wasn’t changed — this is a separate, cleaned copy."];
    if (piiCount > 0) kept.push("We never show masked values back — you only see counts, never the data.");
    for (var i = 0; i < couldntCheck.length; i++) kept.push(couldntCheck[i]);
    kept.push("Names and free-text personal details aren’t auto-detected, and hidden rows or columns inside a sheet aren’t flagged — open the copy and eyeball it before you send.");
    if (findings.length > 0) kept.push("We didn’t remove the items above — hidden sheets and external links are yours to decide on.");
    kept.push("Didn’t store your file — it’s read in memory and discarded.");

    // ---- summary + heading ----
    var summary = [{ n: destructive, l: destructive === 1 ? "thing cleaned" : "things cleaned", cls: "ok" }];
    summary.push({ n: findings.length, l: "to review", cls: findings.length > 0 ? "bad" : "" });

    var heading, empty;
    if (destructive > 0 && findings.length > 0) {
      heading = "Cleaned — and a few things to review";
    } else if (destructive > 0) {
      heading = "Cleaned and ready to send";
      empty = ["Cleaned ", { b: String(destructive) + " item" + s(destructive) },
        " and found nothing left to review. Download the safe copy below — your original is untouched."];
    } else if (findings.length > 0) {
      heading = "A few things to review before you send";
    } else {
      heading = "Looks safe to send";
      empty = ["We scanned all six leak vectors — personal data, file metadata, comments, hidden sheets, external links and macros — and found nothing to clean or flag. Your file is unchanged."];
    }

    var out = {
      summary: summary,
      heading: heading,
      findings: findings.length > 0 ? findings : null,
      empty: empty,
      ledger: { did: did, kept: kept },
    };
    // Only offer a download when the copy actually differs from the original.
    if (destructive > 0 && cleanB64) {
      out.download = { file_b64: cleanB64, filename: safeBase(ctx.filename) + "-safe-copy.xlsx", mime: XLSX_MIME };
    }
    return out;
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Free · no signup. Your file is read in memory to clean a copy and scan for leaks, then discarded. Nothing is stored, your original workbook is never changed, and cleaned values are never shown back.",
    runningLabel: "Getting your file ready to send…",
    steps: [
      "Cleaning personal data, metadata and comments",
      "Scanning for hidden sheets, links and macros",
      "Building your review",
    ],
    process: process,
  });
})();
