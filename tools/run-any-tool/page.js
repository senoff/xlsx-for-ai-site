/*
 * run-any-tool — "Run any tool on your file" advanced surface (XLS-216).
 *
 * The technical backstop to the plain-language page-per-need tools: upload a
 * workbook, pick any of the file-based tools the server exposes, fill a form
 * we auto-render from that tool's inputSchema (fetched live from the public
 * GET /api/v1/tools/list), and run it. It hits the exact same POST tool route
 * an MCP client uses — a web visitor IS an MCP user with the UI filling params,
 * so the output is parity with calling the tool directly.
 *
 * Two-stage flow via the shell params primitive's dependent re-render:
 *   upload → discover (tool inventory) → buildForm returns just the tool
 *   picker → on pick (reload) buildForm returns picker + that tool's fields →
 *   run → the tool's text output shown verbatim, plus a download when the tool
 *   returns file bytes.
 *
 * Scope: we surface tools whose schema takes a single uploaded file (file_b64).
 * That structurally excludes the dual-file diff, handle/session tools, and the
 * write tool. We also drop xlsx_post_slack / xlsx_post_teams by name: they need
 * a user secret (a token) and post to an external service — a secret does not
 * belong in a web form, and an external side-effect isn't a "run against my
 * file" op.
 *
 * Read-only: every surfaced tool reads the upload in memory; the source
 * workbook is never changed. Tools that transform return a NEW file to
 * download.
 */
(function () {
  "use strict";

  // Dropped by name: need an external secret + post off-box (see header).
  var EXCLUDE = { xlsx_post_slack: 1, xlsx_post_teams: 1 };

  // Captured at discover(), read back in buildForm()/process() (the primitive
  // hands process only b64/api/values).
  var discovered = { tools: [], byName: {} };

  function humanize(key) {
    var s = String(key == null ? "" : key).replace(/^xlsx_/, "").replace(/_/g, " ").trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  }
  function labelFor(t) {
    var title = (t.annotations && t.annotations.title) || humanize(t.name);
    return title + " — " + t.name;
  }
  function shortDesc(d) {
    var s = String(d == null ? "" : d).replace(/\s+/g, " ").trim();
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }
  function safeBase(filename) {
    var base = String(filename || "workbook.xlsx").replace(/\.xlsx$/i, "");
    base = base.replace(/[<>:"/\\|?*\x00-\x1F]/g, "").replace(/[‎‏‪-‮⁦-⁩]/g, "").trim();
    return base || "workbook";
  }

  // ---- discover: the public tool inventory (no auth required) ----
  function discover(b64, api) {
    return fetch(window.XFA.API + "/api/v1/tools/list", { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("Couldn’t load the tool list. Please try again in a moment.");
        return r.json();
      })
      .then(function (j) {
        var tools = ((j && j.tools) || []).filter(function (t) {
          return !EXCLUDE[t.name] && t.inputSchema && t.inputSchema.properties && t.inputSchema.properties.file_b64;
        });
        if (!tools.length) throw new Error("No tools are available to run right now. Please try again later.");
        var byName = {};
        tools.forEach(function (t) { byName[t.name] = t; });
        discovered = { tools: tools, byName: byName };
        return discovered;
      });
  }

  // ---- schema → form fields (recursive; skips file_b64) ----
  // Nesting is encoded in field names with "__" (survives the primitive's
  // safeName id-sanitizer); process() splits on it to rebuild the object.
  function enumField(fname, label, values) {
    var opts = [{ value: "", label: "— default —" }].concat(
      values.map(function (v) { return { value: v, label: String(v) }; })
    );
    return { type: "select", name: fname, label: label, options: opts };
  }
  function scalarSub(key, p) {
    if (p.enum && p.enum.length) {
      return { type: "select", name: key, label: humanize(key),
        options: [{ value: "", label: "—" }].concat(p.enum.map(function (v) { return { value: v, label: String(v) }; })) };
    }
    return { type: "text", name: key, label: humanize(key), placeholder: humanize(key) };
  }
  function fieldFor(fname, label, p) {
    if (p.enum && p.enum.length) return enumField(fname, label, p.enum);
    var t = p.type;
    if (t === "string") return { type: "text", name: fname, label: label, placeholder: p.description ? shortDesc(p.description) : "" };
    if (t === "integer" || t === "number") return { type: "text", name: fname, label: label + " (number)", placeholder: p.description ? shortDesc(p.description) : "number" };
    if (t === "boolean") return enumField(fname, label, ["true", "false"]);
    if (t === "array") {
      var items = p.items || {};
      if (items.type === "object" && items.properties) {
        var row = Object.keys(items.properties).map(function (k) { return scalarSub(k, items.properties[k] || {}); });
        return { type: "repeat", name: fname, label: label, addLabel: "Add", min: 0, max: 16, row: row };
      }
      return { type: "text", name: fname, label: label + " (comma-separated)", placeholder: "a, b, c" };
    }
    return null; // objects handled by recursion in schemaFields; unknowns skipped
  }
  function schemaFields(schema, prefix) {
    prefix = prefix || "";
    var props = (schema && schema.properties) || {};
    var required = (schema && schema.required) || [];
    var out = [];
    Object.keys(props).forEach(function (key) {
      if (key === "file_b64") return;
      var p = props[key] || {};
      var fname = prefix ? prefix + "__" + key : key;
      if (p.type === "object" && p.properties && Object.keys(p.properties).length) {
        out = out.concat(schemaFields(p, fname));
        return;
      }
      var label = humanize(key) + (required.indexOf(key) >= 0 ? " *" : "");
      var f = fieldFor(fname, label, p);
      if (f) out.push(f);
    });
    return out;
  }

  // ---- buildForm: tool picker (+ the chosen tool's fields) ----
  function buildForm(d, values) {
    values = values || {};
    var toolOpts = [{ value: "", label: "— choose a tool —" }].concat(
      (d.tools || []).map(function (t) { return { value: t.name, label: labelFor(t) }; })
    );
    var picker = { type: "select", name: "tool", label: "What do you want to do?", options: toolOpts, reload: true, value: values.tool || "" };
    var chosen = values.tool && d.byName[values.tool];
    if (!chosen) return [picker];
    return [picker].concat(schemaFields(chosen.inputSchema, ""));
  }

  // ---- values → tool args (mirrors schemaFields naming; coerces types) ----
  function coerceScalar(p, raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (s === "") return undefined;
    // Coerce by declared type even for enums: a typed enum ([1,2,3] / [true])
    // must send 3 / true, not "3" / "true", or the server's enum-membership
    // check rejects the string form. String enums (type string/absent) fall
    // through to the raw string. Integer uses Number.isInteger so "12abc"/"1e3"
    // are rejected rather than silently truncated by parseInt.
    if (p.type === "boolean") return s === "true" ? true : s === "false" ? false : undefined;
    if (p.type === "integer") { var i = Number(s); return Number.isInteger(i) ? i : undefined; }
    if (p.type === "number") { var n = Number(s); return isFinite(n) ? n : undefined; }
    return s;
  }
  function buildArgs(schema, values, prefix) {
    prefix = prefix || "";
    var props = (schema && schema.properties) || {};
    var out = {};
    Object.keys(props).forEach(function (key) {
      if (key === "file_b64") return;
      var p = props[key] || {};
      var fname = prefix ? prefix + "__" + key : key;
      if (p.type === "object" && p.properties && Object.keys(p.properties).length) {
        var nested = buildArgs(p, values, fname);
        if (Object.keys(nested).length) out[key] = nested;
        return;
      }
      if (p.type === "array") {
        var items = p.items || {};
        if (items.type === "object" && items.properties) {
          var rows = ((values[fname] || [])).map(function (rowObj) {
            var o = {};
            Object.keys(items.properties).forEach(function (ik) {
              var v = coerceScalar(items.properties[ik] || {}, rowObj[ik]);
              if (v !== undefined) o[ik] = v;
            });
            return o;
          }).filter(function (o) { return Object.keys(o).length; });
          if (rows.length) out[key] = rows;
          return;
        }
        var raw = String(values[fname] == null ? "" : values[fname]).trim();
        if (raw) {
          var arr = raw.split(",").map(function (x) { return coerceScalar(items, x); }).filter(function (x) { return x !== undefined; });
          if (arr.length) out[key] = arr;
        }
        return;
      }
      var val = coerceScalar(p, values[fname]);
      if (val !== undefined) out[key] = val;
    });
    return out;
  }

  // ---- render the tool response ----
  function renderResp(tool, resp, api) {
    var m = (resp && typeof resp === "object" && resp._meta) || {};
    var text = api.textOf(resp);
    var vm = {
      heading: (tool.annotations && tool.annotations.title) || humanize(tool.name),
      output: text,
      ledger: {
        did: [],
        kept: [
          "This ran the " + tool.name + " tool on your uploaded file, exactly as an AI agent would call it over the API.",
          "Your workbook was read in memory to run this, then discarded — nothing was stored.",
        ],
      },
    };
    if (!text) vm.empty = ["The tool ran and returned no text output."];
    // Transform tools return output bytes inline in _meta.file_b64 — offer them.
    if (m.file_b64) {
      vm.download = { file_b64: m.file_b64, filename: safeBase(api.filename) + "-" + tool.name.replace(/^xlsx_/, "") + ".xlsx" };
      vm.ledger.did.push("Produced a new file for you to download — your original is untouched.");
    }
    return vm;
  }

  function process(b64, api, values) {
    var toolName = values.tool;
    var tool = toolName && discovered.byName[toolName];
    if (!tool) {
      return Promise.resolve({
        heading: "Pick a tool to run",
        empty: ["Choose a tool from the list above, fill in any options it needs, then run it — nothing has been sent yet."],
      });
    }
    var body = buildArgs(tool.inputSchema, values, "");
    body.file_b64 = b64;
    api.step(0, "on");
    return api.runTool(toolName, body).then(function (resp) {
      api.step(0, "done"); api.step(1, "on");
      var vm = renderResp(tool, resp, api);
      api.step(1, "done");
      return vm;
    });
  }

  window.XFA.mount("#xfa-panel", {
    accept: ".xlsx",
    params: true,
    discoverLabel: "Loading the tool list…",
    runningLabel: "Running the tool…",
    runLabel: "Run it",
    steps: ["Running the tool on your file", "Preparing the result"],
    reassure:
      "Free · no signup. Your file is read in memory to run the tool you pick, then discarded. Nothing is stored, and your original workbook is never changed.",
    discover: discover,
    buildForm: buildForm,
    process: process,
  });
})();
