/*
 * check-for-macros — page logic (XLS-199).
 *
 * Rides the shared shell (shell.js / shell.css). The shell owns the upload
 * widget, anon-key bootstrap, and the running/result/error states; this file
 * supplies only the copy + a two-call read-only safety report:
 *
 *   1. xlsx_macros — is there a VBA project? (_meta.has_macros,
 *      vba_project_size_bytes, module_names). The route NEVER extracts or
 *      runs macro source; it reports presence + size only.
 *   2. xlsx_external_links — does the file pull values from other workbooks?
 *      (_meta.external_link_count, _meta.links[] with target_kind). Network /
 *      absolute / http targets are the ones that leak paths or break on move.
 *
 * Read-only trust surface: we report, we never claim antivirus, and we never
 * touch the file. A "has macros: yes" is deliberately framed as informational,
 * not a virus warning — plenty of legitimate workbooks contain macros.
 */
(function () {
  "use strict";

  // Target kinds that carry real risk: they leak a filesystem/network path or
  // silently break when the workbook is sent elsewhere.
  var RISKY_KINDS = { network: 1, absolute: 1, http: 1 };

  function meta(resp) {
    return (resp && typeof resp === "object" && resp._meta) || {};
  }

  function process(fileB64, api) {
    var runTool = api.runTool, step = api.step;

    step(0, "on");
    return runTool("xlsx_macros", { file_b64: fileB64 }).then(function (macResp) {
      step(0, "done"); step(1, "on");
      var mac = meta(macResp);
      var hasMacros = mac.has_macros === true;
      var vbaBytes = typeof mac.vba_project_size_bytes === "number" ? mac.vba_project_size_bytes : 0;
      var moduleCount = Array.isArray(mac.module_names)
        ? mac.module_names.length
        : (typeof mac.module_count === "number" ? mac.module_count : 0);

      return runTool("xlsx_external_links", { file_b64: fileB64 }).then(function (extResp) {
        step(1, "done"); step(2, "on");
        var ext = meta(extResp);
        var extCount = typeof ext.external_link_count === "number" ? ext.external_link_count : 0;
        var links = Array.isArray(ext.links) ? ext.links : [];
        var riskyCount = links.filter(function (l) {
          return l && RISKY_KINDS[l.target_kind] === 1;
        }).length;
        step(2, "done");

        var findings = [];

        // ----- VBA macros -----
        if (hasMacros) {
          var sizeKb = (vbaBytes / 1024).toFixed(1);
          var why = [
            "This workbook can run code. It contains a VBA macro project",
            vbaBytes > 0 ? " (about " + sizeKb + " KB" + (moduleCount > 0 ? ", " + moduleCount + " module" + (moduleCount === 1 ? "" : "s") : "") + ")" : "",
            ". That isn’t automatically dangerous — many normal files have macros — but treat it like any program from a source you don’t fully trust: review it before enabling macros, and prefer a sandboxed machine if you don’t recognize where it came from. Excel will prompt you before anything runs.",
          ];
          findings.push({ cell: "VBA macros", token: "Present", silent: true, attn: true, why: why });
        } else {
          findings.push({
            cell: "VBA macros", token: "None", attn: false,
            why: "No macros — this file can’t run code, and Excel won’t prompt you about macros when you open it.",
          });
        }

        // ----- External links -----
        if (extCount === 0) {
          findings.push({
            cell: "External links", token: "None", attn: false,
            why: "Self-contained — this file doesn’t pull values from any other workbook.",
          });
        } else {
          var linkWord = extCount === 1 ? "link" : "links";
          var extWhy;
          if (riskyCount > 0) {
            extWhy = [
              "This file pulls values from ", { b: String(extCount) + " other " + linkWord },
              ", and ", { b: String(riskyCount) + " of them" },
              " point at an absolute path or a network share. Those can expose where the file lives and will break if you send the workbook to someone else. Check the referenced paths before sharing.",
            ];
          } else {
            extWhy = [
              "This file pulls values from ", { b: String(extCount) + " other " + linkWord },
              " by relative path. Nothing sensitive is exposed, but the links may break if the other files aren’t sent along with it.",
            ];
          }
          findings.push({ cell: "External links", token: String(extCount), attn: riskyCount > 0, why: extWhy });
        }

        // ----- Summary + verdict -----
        var summary = [
          { n: hasMacros ? "Yes" : "No", l: "has macros", cls: hasMacros ? "" : "ok" },
          { n: extCount, l: "external " + (extCount === 1 ? "link" : "links"), cls: extCount ? "" : "ok" },
        ];

        var allClear = !hasMacros && extCount === 0;
        var heading = allClear
          ? "No macros, no external links"
          : "Here’s what’s inside this file";

        var vm = {
          summary: summary,
          heading: heading,
          findings: findings,
          ledger: {
            did: [
              ["Checked for ", { b: "VBA macros" }, " and ", { b: "external workbook links" }, " — the two things that decide whether a file is safe to open."],
            ],
            kept: [
              "Didn’t open, run, or extract any macro code — this is a read-only report.",
              "Didn’t change your file, and nothing from it was stored; it was read in memory and discarded.",
            ],
          },
        };
        if (allClear) {
          vm.ledger.did.push("Found no macros and no links to other files — nothing here can run code or reach outside the workbook.");
        }
        return vm;
      });
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    reassure:
      "Free · no signup. Read in memory to check for macros, then discarded — never opened, run, or stored. It reports whether macros are present, not whether they're malicious; an antivirus scanner is the tool for a full verdict.",
    runningLabel: "Checking your file…",
    steps: [
      "Reading your workbook",
      "Checking for macros and external links",
      "Writing your safety report",
    ],
    process: process,
  });
})();
