/*
 * filter-rows — "Pull out just the rows I need" page logic (XLS-200).
 *
 * First consumer of the shared params-UI primitive (cfg.params) added to
 * shell.js. Flow: upload → discover the sheet's columns (xlsx_describe) →
 * render a form of filter predicates and/or sort keys → run xlsx_filter and/or
 * xlsx_sort → hand back a CSV of the matching rows.
 *
 * Composition: neither filter nor sort returns a file, so they can't be chained
 * server-side. Three cases:
 *   - predicates only  → xlsx_filter          (pure server parity)
 *   - sort keys only   → xlsx_sort            (pure server parity)
 *   - both             → xlsx_filter, then a DEFINED client-side display-sort
 *     of the ≤1000 matched survivors. The survivors come back as a markdown
 *     table (strings — original cell types are lost), so an exact port of the
 *     server's compareCells is impossible; the combined sort is defined by its
 *     own rules (see clientSort) and the copy says "sorted the matching rows,"
 *     never "identical to the sort tool." Truncation is pre-sort: the 1000 cap
 *     is the filter's (file-order) survivors, which we then sort.
 *
 * Sheet binding: xlsx_describe profiles one sheet and reports its name; every
 * filter/sort call passes options.sheet = that sheet so the columns the user
 * picked line up with the rows the server operates on (multi-sheet safety). We
 * never pass header_row, so all three calls share the server's header default.
 *
 * Read-only: this reads the upload in memory and returns a new CSV; the source
 * workbook is never changed.
 */
(function () {
  "use strict";

  // Human label + echo glyph per server op token. The select option value is
  // the server op; the label is the human text. in/not_in are deferred (need
  // list parsing) — out of v1 scope.
  var OPS = [
    { v: "eq", l: "is", e: "=" },
    { v: "ne", l: "is not", e: "≠" },
    { v: "gt", l: ">", e: ">" },
    { v: "gte", l: "≥", e: "≥" },
    { v: "lt", l: "<", e: "<" },
    { v: "lte", l: "≤", e: "≤" },
    { v: "contains", l: "contains", e: "contains" },
    { v: "not_contains", l: "does not contain", e: "does not contain" },
    { v: "is_null", l: "is empty", e: "is empty" },
    { v: "not_null", l: "is not empty", e: "is not empty" },
  ];
  var OP_BY_V = {};
  OPS.forEach(function (o) { OP_BY_V[o.v] = o; });
  var NO_VALUE = { is_null: 1, not_null: 1 }; // ops that take no value

  // Sheet + columns captured at discover() and read back in process() (the
  // primitive hands process only b64/api/values, not the discovered object).
  var discovered = { columns: [], sheet: "" };

  function safeBase(filename) {
    var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
    base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/[‎‏‪-‮⁦-⁩]/g, "").trim();
    return base || "workbook";
  }

  // ---- discover: column names + sheet for the dropdowns ----
  function discover(b64, api) {
    return api.runTool("xlsx_describe", { file_b64: b64 }).then(function (resp) {
      var m = (resp && typeof resp === "object" && resp._meta) || {};
      var rows = api.parseTable(api.textOf(resp)); // one row per column: {Column, Type, ...}
      var names = [], seen = {};
      rows.forEach(function (r) {
        var name = String(r.Column == null ? "" : r.Column).trim();
        if (!name || seen[name]) return; // blank-named excluded; duplicates → first
        seen[name] = 1;
        names.push(name);
      });
      if (!names.length) {
        throw new Error("We couldn’t find any named columns on that sheet. Check it has a header row, then try again.");
      }
      discovered = { columns: names, sheet: m.sheet || "" };
      return discovered;
    });
  }

  // ---- buildForm: predicate rows + sort rows ----
  function buildForm(d) {
    var colOpts = (d.columns || []).map(function (c) { return { value: c, label: c }; });
    var opOpts = OPS.map(function (o) { return { value: o.v, label: o.l }; });
    var dirOpts = [
      { value: "asc", label: "A→Z / low→high" },
      { value: "desc", label: "Z→A / high→low" },
    ];
    return [
      {
        type: "repeat", name: "predicates", label: "Keep rows where…", addLabel: "Add a filter",
        min: 1, max: 16,
        row: [
          { type: "select", name: "column", label: "Column", options: colOpts },
          { type: "select", name: "op", label: "Condition", options: opOpts },
          { type: "text", name: "value", label: "Value", placeholder: "value" },
        ],
      },
      {
        type: "repeat", name: "sort", label: "Then sort by… (optional)", addLabel: "Add a sort",
        min: 0, max: 8,
        row: [
          { type: "select", name: "column", label: "Column", options: colOpts },
          { type: "select", name: "direction", label: "Order", options: dirOpts },
        ],
      },
    ];
  }

  // ---- validity / drop rules (applied before branching) ----
  function collectPreds(values) {
    return (values.predicates || [])
      .filter(function (p) {
        if (!p.column || !p.op) return false;
        if (NO_VALUE[p.op]) return true;
        return String(p.value == null ? "" : p.value).trim() !== "";
      })
      .map(function (p) {
        if (NO_VALUE[p.op]) return { column: p.column, op: p.op };
        return { column: p.column, op: p.op, value: String(p.value).trim() };
      });
  }
  function collectSorts(values) {
    return (values.sort || [])
      .filter(function (s) { return !!s.column; })
      .map(function (s) { return { column: s.column, direction: s.direction === "desc" ? "desc" : "asc" }; });
  }

  // ---- DEFINED client-side display-sort (combined case only) ----
  function numOf(x) {
    var s = String(x == null ? "" : x).trim();
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function clientSort(rows, sorts) {
    var indexed = rows.map(function (r, i) { return { r: r, i: i }; });
    indexed.sort(function (x, y) {
      for (var k = 0; k < sorts.length; k++) {
        var col = sorts[k].column, dir = sorts[k].direction === "desc" ? -1 : 1;
        var a = String(x.r[col] == null ? "" : x.r[col]);
        var b = String(y.r[col] == null ? "" : y.r[col]);
        var ae = a === "", be = b === "";
        if (ae && be) continue;
        if (ae) return 1;  // empties last — direction-independent
        if (be) return -1;
        var na = numOf(a), nb = numOf(b), c;
        if (na !== null && nb !== null) c = na < nb ? -1 : na > nb ? 1 : 0;
        else c = a < b ? -1 : a > b ? 1 : 0;
        if (c !== 0) return c * dir;
      }
      return x.i - y.i; // stable: preserve pre-sort (file) order on full ties
    });
    return indexed.map(function (o) { return o.r; });
  }

  // ---- CSV (RFC-4180-ish quoting) ----
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) {
    if (!rows.length) return "";
    var cols = Object.keys(rows[0]);
    var lines = [cols.map(csvCell).join(",")];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(","));
    });
    return lines.join("\r\n");
  }

  // ---- rule echoes (what ran) ----
  function echoPreds(preds) {
    return preds.map(function (p) {
      var op = OP_BY_V[p.op];
      var s = p.column + " " + (op ? op.e : p.op);
      if (!NO_VALUE[p.op]) s += " " + p.value;
      return { cell: s, attn: false };
    });
  }
  function echoSorts(sorts) {
    return sorts.map(function (s, i) {
      return { cell: (i === 0 ? "Sorted by " : "then by ") + s.column + " " + (s.direction === "desc" ? "↓" : "↑"), attn: false };
    });
  }

  function process(b64, api, values) {
    var preds = collectPreds(values);
    var sorts = collectSorts(values);

    if (!preds.length && !sorts.length) {
      return Promise.resolve({
        heading: "Add a rule to get started",
        empty: [
          "Add at least one filter (", { b: "keep rows where…" },
          ") or one sort, then run it — nothing was sent to the server yet.",
        ],
      });
    }

    var options = { limit: 1000 };
    if (discovered.sheet) options.sheet = discovered.sheet;
    api.step(0, "on");

    var mode = preds.length && sorts.length ? "both" : preds.length ? "filter" : "sort";
    var body = mode === "sort"
      ? { file_b64: b64, by: sorts, options: options }
      : { file_b64: b64, predicates: preds, options: options };
    var toolName = mode === "sort" ? "xlsx_sort" : "xlsx_filter";

    return api.runTool(toolName, body).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");
      var m = (resp && typeof resp === "object" && resp._meta) || {};
      var rows = api.parseTable(api.textOf(resp));
      if (mode === "both" && sorts.length) rows = clientSort(rows, sorts);
      api.step(1, "done");
      return buildVM(rows, m, { mode: mode, preds: preds, sorts: sorts, filename: api.filename });
    });
  }

  function buildVM(rows, m, ctx) {
    var returned = rows.length;
    var isFilter = ctx.mode !== "sort";
    var matched = isFilter
      ? (typeof m.total_matches === "number" ? m.total_matches : returned)
      : (typeof m.row_count === "number" ? m.row_count : returned);
    var truncated = !!m.input_truncated || (isFilter && matched > returned);

    if (returned === 0) {
      return {
        heading: isFilter ? "No rows matched" : "Nothing to sort",
        summary: [{ n: 0, l: isFilter ? "matching rows" : "rows", cls: "" }],
        findings: echoPreds(ctx.preds).concat(echoSorts(ctx.sorts)),
        empty: isFilter
          ? ["No rows matched every rule (they combine with ", { b: "AND" }, "). Loosen a rule and try again — your file is unchanged."]
          : ["That sheet had no rows to sort. Your file is unchanged."],
      };
    }

    var rulesN = ctx.preds.length + ctx.sorts.length;
    var summary = [
      { n: matched, l: isFilter ? (matched === 1 ? "matching row" : "matching rows") : (matched === 1 ? "row sorted" : "rows sorted"), cls: "ok" },
      { n: rulesN, l: rulesN === 1 ? "rule applied" : "rules applied" },
    ];
    if (truncated && returned !== matched) {
      summary.push({ n: returned, l: "rows in this file" });
    }

    var kept = [
      "Your original file wasn’t changed — this is a new CSV of just the rows you asked for.",
      "Your workbook was read in memory to run this, then discarded — nothing was stored.",
    ];
    if (ctx.preds.length) kept.push("Filters combine with AND — a row is kept only if it matches every rule.");
    if (truncated) {
      if (ctx.mode === "both") {
        kept.push("Showing the first 1000 matching rows (in file order), then sorted — the sort runs on that matched subset, not the whole workbook.");
      } else if (isFilter) {
        kept.push("Showing the first 1000 matching rows (in file order).");
      } else {
        kept.push("Showing the first 1000 rows.");
      }
    }
    if (ctx.mode === "both") {
      kept.push("The combined sort orders the matching rows for display — it isn’t identical to the standalone sort tool.");
    }

    var heading = ctx.mode === "both"
      ? "Filtered and sorted — here are your rows"
      : isFilter ? "Here are the rows you asked for" : "Your rows, sorted";

    return {
      heading: heading,
      summary: summary,
      findings: echoPreds(ctx.preds).concat(echoSorts(ctx.sorts)),
      ledger: { did: [], kept: kept },
      download: {
        text: toCsv(rows),
        filename: safeBase(ctx.filename) + "-rows.csv",
        mime: "text/csv",
      },
    };
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    params: true,
    discoverLabel: "Reading your columns…",
    runningLabel: "Pulling your rows…",
    runLabel: "Get my rows",
    steps: ["Applying your rules", "Building your CSV"],
    reassure:
      "Free · no signup. Your file is read in memory to filter and sort it, then discarded. Nothing is stored, and your original workbook is never changed — you download a new CSV of just the rows you asked for.",
    discover: discover,
    buildForm: buildForm,
    process: process,
  });
})();
