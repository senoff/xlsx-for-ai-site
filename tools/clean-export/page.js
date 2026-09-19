/*
 * clean-export — "Clean up a messy export" page logic (XLS-204).
 *
 * Rides the shared shell (shell.js / shell.css). Compound flow — three tools,
 * one plain-language result. The before→after ledger IS the review surface:
 * nothing changes silently.
 *
 *   1. xlsx_doctor        — a quick overall-health scan (the "before" read).
 *   2. xlsx_data_clean     (mode: execute) — the actual cleanup. Execute only
 *      auto-applies SAFE-tier fixes (trim whitespace, coerce numbers-stored-as
 *      -text, drop fully-duplicate rows, clear trailing noise, normalize
 *      dates/labels/currency). Anything that needs a judgment call — filling
 *      blanks, dropping a constant column — comes back applied:false with a
 *      reason. We surface those under "what we didn't touch" rather than guess.
 *      Cleaned bytes come back as _meta.file_b64 (base64 .xlsx) ONLY when at
 *      least one fix was applied; a file with nothing safe to fix returns a
 *      null file_b64, which we render as "nothing to clean / left for review".
 *   3. xlsx_validate      — cross-engine check on the CLEANED bytes (the
 *      "after" confirmation): engines_agree === true means two independent
 *      engines open the result identically.
 *
 * Read-only for the source: this produces a NEW file and never touches the
 * uploaded workbook.
 */
(function () {
  "use strict";

  var XLSX_MIME =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  // Plain-language copy per xlsx_data_clean finding type.
  //   did       — imperative sentence for the "what we did" ledger row.
  //   noun      — short chip label + phrase for the review ledger.
  //   leftAlone — override sentence when this type is deliberately NOT applied.
  var LABELS = {
    type_coercion_mistake: {
      did: "Converted numbers that were stored as text back into real numbers",
      noun: "numbers stored as text",
    },
    whitespace_residue: {
      did: "Trimmed stray leading and trailing spaces",
      noun: "extra spaces",
    },
    duplicate_data_row: {
      did: "Removed duplicate rows, keeping the first copy of each",
      noun: "duplicate rows",
    },
    trailing_row_noise: {
      did: "Cleared empty trailing rows at the bottom",
      noun: "empty trailing rows",
    },
    na_variant: {
      did: "Standardized inconsistent “not available” markers",
      noun: "N/A markers",
    },
    mixed_date_format: {
      did: "Normalized dates to one consistent format",
      noun: "mixed date formats",
    },
    categorical_variant: {
      did: "Unified inconsistent category labels to a single spelling",
      noun: "label variants",
    },
    currency_locale_normalize: {
      did: "Normalized money values to a consistent format",
      noun: "currency values",
    },
    numeric_precision: {
      did: "Rounded over-precise numbers",
      noun: "over-precise numbers",
    },
    encoding_glitch: {
      did: "Fixed garbled characters left by an encoding glitch",
      noun: "encoding glitches",
    },
    merged_cell_residue: {
      did: "Cleared leftover merged-cell residue",
      noun: "merged-cell residue",
    },
    header_row_not_first: {
      did: "Moved the header row to the top",
      noun: "misplaced header",
    },
    duplicate_header: {
      did: "Resolved duplicate column headers",
      noun: "duplicate headers",
    },
    constant_column: {
      did: "Flagged columns that hold a single repeated value",
      noun: "single-value columns",
      leftAlone:
        "Left columns that hold one repeated value in place — removing a column is your call, not ours.",
    },
    missing_value_imputable: {
      did: "Filled blank cells",
      noun: "blank cells",
      leftAlone:
        "Left blank cells as they were — we don’t invent missing data. Fill those in yourself if you need them.",
    },
  };

  function humanize(t) {
    return String(t || "issue").replace(/_/g, " ");
  }

  function labelFor(type) {
    return LABELS[type] || { did: "Fixed " + humanize(type), noun: humanize(type) };
  }

  // A finding's location as a short human string: "Sheet1!A2", "Sheet1!col B",
  // "Sheet1!col B:D", or a sheet / workbook fallback.
  function locOf(f) {
    var loc = (f && f.location) || {};
    var sheet = loc.sheet || "";
    if (loc.cell_ref) return sheet ? sheet + "!" + loc.cell_ref : loc.cell_ref;
    if (loc.col_range) {
      var cr =
        loc.col_range.start === loc.col_range.end
          ? loc.col_range.start
          : loc.col_range.start + ":" + loc.col_range.end;
      return sheet ? sheet + "!col " + cr : "col " + cr;
    }
    return sheet || "workbook";
  }

  // Group findings by type, preserving first-seen order → [{type, count}].
  function groupByType(findings) {
    var map = {};
    var order = [];
    findings.forEach(function (f) {
      var t = f.type || "unknown";
      if (!map[t]) {
        map[t] = { type: t, count: 0 };
        order.push(t);
      }
      map[t].count += 1;
    });
    return order.map(function (t) {
      return map[t];
    });
  }

  // Turn a data_clean applied_error into a short plain-language reason.
  function plainReason(err) {
    var e = String(err || "");
    if (/never-fabricate|flag-only/.test(e)) return "we won’t invent data that isn’t there";
    if (/review tier/.test(e)) return "it needs a judgment call we won’t make automatically";
    if (!e) return "left for you to decide";
    return e;
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
    return runTool("xlsx_doctor", { file_b64: fileB64 }).then(function (docResp) {
      step(0, "done"); step(1, "on");
      var docMeta = (docResp && typeof docResp === "object" && docResp._meta) || {};

      return runTool("xlsx_data_clean", { file_b64: fileB64, mode: "execute" }).then(function (cleanResp) {
        step(1, "done"); step(2, "on");
        var m = (cleanResp && typeof cleanResp === "object" && cleanResp._meta) || {};
        var findings = Array.isArray(m.findings) ? m.findings : [];
        var applied = findings.filter(function (f) { return f.applied === true; });
        var notApplied = findings.filter(function (f) { return f.applied !== true; });
        var cleanedB64 = m.file_b64 || null;
        var appliedCount =
          typeof m.applied_count === "number" ? m.applied_count : applied.length;

        // Validate the CLEANED bytes when we have them (after-confirmation).
        // A validate hiccup must not sink the whole result — fall back to {}.
        var validateP = cleanedB64
          ? runTool("xlsx_validate", { file_b64: cleanedB64 }).then(
              function (r) { return (r && typeof r === "object" && r._meta) || {}; },
              function () { return {}; }
            )
          : Promise.resolve(null);

        return validateP.then(function (valMeta) {
          step(2, "done");
          return buildResult({
            docMeta: docMeta,
            findings: findings,
            applied: applied,
            notApplied: notApplied,
            cleanedB64: cleanedB64,
            appliedCount: appliedCount,
            valMeta: valMeta,
            filename: filename,
          });
        });
      });
    });
  }

  function buildResult(ctx) {
    var findings = ctx.findings;
    var applied = ctx.applied;
    var notApplied = ctx.notApplied;
    var appliedCount = ctx.appliedCount;
    var cleanedB64 = ctx.cleanedB64;

    // ---- overall-health notes from xlsx_doctor (medium + high only) ----
    var docFindings = Array.isArray(ctx.docMeta.findings) ? ctx.docMeta.findings : [];
    var healthNotes = docFindings.filter(function (f) {
      return f.severity === "high" || f.severity === "medium";
    });

    // ================= nothing found at all =================
    if (findings.length === 0) {
      var kept0 = [
        "Your original file wasn’t changed.",
        "Read your workbook in memory to check it, then discarded it — nothing was stored.",
      ];
      if (healthNotes.length > 0) {
        kept0.push(healthLine(healthNotes));
      }
      return {
        summary: [{ n: 0, l: "issues found", cls: "ok" }],
        heading: "Your export is already clean",
        empty: [
          "We scanned every sheet and found no data grime to fix — no stray spaces, ",
          "numbers stored as text, duplicate rows, or inconsistent values. Your file is unchanged.",
        ],
        ledger: { did: [], kept: kept0 },
      };
    }

    // ---- ledger: what we did ----
    var did = [];
    groupByType(applied).forEach(function (g) {
      did.push([labelFor(g.type).did, " ", { b: "(" + g.count + ")" }, "."]);
    });

    // ---- ledger: what we didn't touch ----
    var kept = [
      cleanedB64 && appliedCount > 0
        ? "Your original file wasn’t changed — this is a clean copy."
        : "Your original file wasn’t changed.",
    ];
    groupByType(notApplied).forEach(function (g) {
      var lbl = labelFor(g.type);
      if (lbl.leftAlone) {
        kept.push(lbl.leftAlone + " (" + g.count + ")");
      } else {
        kept.push([
          "Left ", { b: g.count + " " + lbl.noun }, " for you to review — ",
          "each needs a judgment call we won’t make automatically.",
        ]);
      }
    });
    if (ctx.valMeta && ctx.valMeta.engines_agree === true) {
      kept.push("Double-checked the cleaned file opens the same in two independent spreadsheet engines.");
    }
    kept.push("Didn’t store your file — it’s read in memory and discarded.");
    if (healthNotes.length > 0) {
      kept.push(healthLine(healthNotes));
    }

    // ---- per-issue findings list (capped) ----
    var vmFindings = [];
    var CAP = 12;
    findings.slice(0, CAP).forEach(function (f) {
      var lbl = labelFor(f.type);
      vmFindings.push({
        cell: locOf(f),
        token: lbl.noun,
        attn: f.applied === true ? false : true,
        why:
          f.applied === true
            ? [{ b: "fixed" }, " — " + lbl.did.toLowerCase() + "."]
            : [{ b: "left for you" }, " — " + plainReason(f.applied_error) + "."],
      });
    });
    var moreCount = findings.length - Math.min(findings.length, CAP);
    if (moreCount > 0) {
      vmFindings.push({ cell: "+" + moreCount + " more", silent: true, why: ["not shown above"] });
    }

    // ---- summary cards ----
    var summary = [
      {
        n: appliedCount,
        l: appliedCount === 1 ? "issue cleaned" : "issues cleaned",
        cls: appliedCount > 0 ? "ok" : "",
      },
    ];
    if (notApplied.length > 0) {
      summary.push({ n: notApplied.length, l: "left to review", cls: "bad" });
    }

    // ================= found, but nothing was safe to auto-fix =================
    if (appliedCount === 0 || !cleanedB64) {
      return {
        summary: summary,
        heading: "Found things worth a look",
        findings: vmFindings,
        empty: [
          "We found ", { b: String(notApplied.length) + " issue" + (notApplied.length === 1 ? "" : "s") },
          ", but none were safe to fix automatically — each needs your judgment. ",
          "Here’s what to check. Your file is unchanged.",
        ],
        ledger: { did: did, kept: kept },
      };
    }

    // ================= cleaned copy is ready =================
    var outName = safeBase(ctx.filename) + "-cleaned.xlsx";
    return {
      summary: summary,
      heading: "Your cleaned file is ready",
      findings: vmFindings,
      empty: [
        "Cleaned up ", { b: String(appliedCount) + " issue" + (appliedCount === 1 ? "" : "s") },
        " and left anything that needs your judgment untouched. Download the clean copy below.",
      ],
      ledger: { did: did, kept: kept },
      download: { file_b64: cleanedB64, filename: outName, mime: XLSX_MIME },
    };
  }

  function healthLine(notes) {
    var n = notes.length;
    return (
      "Also checked overall workbook health — " +
      n + " note" + (n === 1 ? "" : "s") +
      " (run xlsx_doctor for the detail)."
    );
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Your file is read in memory to scan, clean, and re-check it, then discarded. Nothing is stored, and your original workbook is never changed — you download a separate clean copy.",
    runningLabel: "Cleaning up your export…",
    steps: [
      "Scanning for problems",
      "Cleaning up the data",
      "Double-checking the cleaned file",
    ],
    process: process,
  });
})();
