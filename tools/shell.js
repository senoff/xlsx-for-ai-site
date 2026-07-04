/*
 * Web-tools shared shell (XLS-194) — runtime.
 *
 * One script drives every page-per-need upload surface: anonymous key
 * bootstrap (no signup), the upload widget, the reading/running/result/error
 * state machine, the POST-to-tool helper, and the standard result + ledger
 * renderer. A page supplies only a config object with its copy and a `process`
 * function that orchestrates the compound chain and returns a view model.
 *
 * Contract with the live server (api.xlsx-for-ai.dev):
 *   POST /api/v1/clients        {client_version, platform} -> {api_key}
 *   POST /api/v1/tools/<name>   {file_b64, options} + Bearer -> {content:[{text}], _meta}
 * Auth is Bearer-only; the anon key is minted transparently and cached in
 * localStorage so a returning visitor never re-registers. "Free, no signup" is
 * preserved: the visitor never sees a key or a form.
 */
(function () {
  "use strict";

  var API = "https://api.xlsx-for-ai.dev";
  var KEY_STORE = "xfa_web_key";
  var MAX_BYTES = 10 * 1024 * 1024; // FREE_TIER_MAX_FILE_BYTES on the server
  var TIMEOUT_MS = 90000;           // formula eval on a big workbook can be slow
  var MAX_GRID_ROWS = 500;          // preview-grid DOM ceiling (XLS-217)

  function XfaError(message) { this.name = "XfaError"; this.message = message; }
  XfaError.prototype = Object.create(Error.prototype);

  // fetch with an AbortController deadline so a hung request can't spin the
  // UI forever. Only network-level failures (abort, offline, DNS) are mapped
  // to a friendly XfaError here; HTTP status handling stays in the callers.
  function xfetch(url, opts) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    var merged = { signal: ctrl.signal };
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
    return fetch(url, merged).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (err) {
      clearTimeout(timer);
      if (err && err.name === "AbortError") {
        throw new XfaError("That took too long to process. Try a smaller file, or try again in a moment.");
      }
      throw new XfaError("Couldn’t reach the checker. Check your connection and try again.");
    });
  }

  // The shell is the single HTML-escaping authority. Pages hand us plain
  // strings or rich-text segment arrays — never raw HTML. A string is escaped
  // whole; an array renders each segment escaped, with {b} bold and {code}
  // monospace as the only markup a page can emit. This makes it impossible
  // for tool output (or a page bug) to inject markup into the DOM.
  function renderSeg(seg) {
    if (seg == null) return "";
    if (typeof seg === "string") return esc(seg);
    if (seg.b != null) return "<b>" + esc(seg.b) + "</b>";
    if (seg.code != null) return "<code>" + esc(seg.code) + "</code>";
    return esc(seg.t != null ? seg.t : "");
  }
  function rich(val) {
    if (val == null) return "";
    if (Array.isArray(val)) return val.map(renderSeg).join("");
    return renderSeg(val);
  }

  // ---- anonymous key bootstrap ----------------------------------------
  // The cached key is an ANONYMOUS, rate-limited, low-privilege key (the
  // server mints it with no PII, caps registrations per IP, and accepts
  // Bearer-only with credentials:false — no cookies). localStorage is an
  // accepted store for it: it is not a user credential, and HttpOnly cookies
  // would break the cookie-less CORS model the API is built on.
  var _registering = null;
  function registerKey() {
    if (_registering) return _registering;
    _registering = xfetch(API + "/api/v1/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_version: "web-tools-1.0", platform: "web" })
    }).then(function (r) {
      if (!r.ok) throw new XfaError("Couldn't start a session. Please try again in a moment.");
      return r.json();
    }).then(function (j) {
      if (!j || !j.api_key) throw new XfaError("Couldn't start a session. Please try again in a moment.");
      try { localStorage.setItem(KEY_STORE, j.api_key); } catch (_) { /* private mode: fall back to memory */ }
      _memKey = j.api_key;
      return j.api_key;
    }).finally(function () { _registering = null; });
    return _registering;
  }
  var _memKey = null;
  function currentKey() {
    if (_memKey) return _memKey;
    try { _memKey = localStorage.getItem(KEY_STORE); } catch (_) { _memKey = null; }
    return _memKey;
  }
  function clearKey() {
    _memKey = null;
    try { localStorage.removeItem(KEY_STORE); } catch (_) { /* ignore */ }
  }
  function ensureKey() {
    var k = currentKey();
    return k ? Promise.resolve(k) : registerKey();
  }

  // ---- POST to a tool route -------------------------------------------
  // Retries key registration exactly once on a 401 (stale/rotated key).
  function runTool(name, body, _retried) {
    // name is supplied by our own page code, never user input — but guard the
    // URL path anyway so a bad caller can't smuggle path separators / traversal.
    if (!/^[a-z0-9_]+$/.test(name)) {
      return Promise.reject(new XfaError("Unknown tool."));
    }
    return ensureKey().then(function (key) {
      return xfetch(API + "/api/v1/tools/" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (r.status === 401 && !_retried) { clearKey(); return runTool(name, body, true); }
      if (r.status === 413) throw new XfaError("That file is over the 10 MB limit for the free web tool.");
      if (r.status === 429) throw new XfaError("Too many requests right now — give it a minute and try again.");
      if (!r.ok) throw new XfaError("The tool couldn't process that file (error " + r.status + ").");
      return r.json();
    });
  }

  // ---- helpers --------------------------------------------------------
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new XfaError("Couldn't read that file.")); };
      reader.onload = function () {
        var s = String(reader.result);
        var comma = s.indexOf(",");
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.readAsDataURL(file);
    });
  }

  // Parse a Markdown pipe-table (the tool routes' text output) into row
  // objects keyed by header. Deterministic server output; tolerant of the
  // leading/trailing pipes and the `---` separator row.
  function parseTable(text) {
    var lines = String(text || "").split("\n");
    var rows = [], headers = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("|") === -1) continue;
      // A cell holding a literal '|' is rendered by the server as '\|'. Protect
      // those with a sentinel so they survive the pipe-split, then restore them
      // per-cell — otherwise a value like "A|B" would split into two columns.
      var protectedLine = line.replace(/\\\|/g, "\uE000");
      var cells = protectedLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) {
        return c.trim().replace(/\uE000/g, "|");
      });
      if (/^-{2,}$/.test(cells.join("").replace(/[:\s|]/g, ""))) continue; // separator
      if (!headers) { headers = cells; continue; }
      var obj = {};
      for (var j = 0; j < headers.length; j++) obj[headers[j]] = cells[j] != null ? cells[j] : "";
      rows.push(obj);
    }
    return rows;
  }

  // Positional variant of parseTable for the preview-grid primitive (XLS-217):
  // returns { headers:[...], rows:[[...],...] } preserving column order so a
  // sheet renders as a faithful cell grid. Same markdown pipe-table input
  // (xlsx_read's output); the separator row is skipped. xlsx_read does not
  // escape literal pipes, so no un-escaping step is needed here. Keyed
  // parseTable is lossy for a grid — it drops position and collides duplicate
  // header names, both of which a raw cell preview must preserve.
  function parseGrid(text) {
    var lines = String(text || "").split("\n");
    var headers = null, rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf("|") === -1) continue;
      var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) {
        return c.trim();
      });
      // Markdown header-separator row: EVERY cell is dashes (with optional
      // alignment colons). Tested per-cell, not on the concatenation, so a real
      // data row that happens to hold "----" in one column isn't dropped.
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) continue;
      if (!headers) { headers = cells; continue; }
      rows.push(cells);
    }
    return { headers: headers || [], rows: rows };
  }

  function textOf(resp) {
    try { return resp.content[0].text || ""; } catch (_) { return ""; }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- state machine --------------------------------------------------
  function mount(selector, cfg) {
    var panel = document.querySelector(selector);
    if (!panel) return;
    var accept = cfg.accept || ".xlsx";
    var maxB = cfg.maxBytes || MAX_BYTES;
    // Dual-upload mode (XLS-197): two side-by-side drop zones feeding ONE
    // process() with both files. Purely additive — a page opts in with
    // cfg.dual; single-file pages keep the original one-zone path untouched.
    var dual = !!cfg.dual;
    var labelA = (cfg.labels && cfg.labels.a) || "Original";
    var labelB = (cfg.labels && cfg.labels.b) || "Changed";
    var fileA = null, fileB = null;

    function validXlsx(name) { return /\.xlsx$/i.test(name || ""); }

    // Attach picker + drag/drop wiring to a dropzone element, routing the
    // chosen file to onFile. Shared by both the single and dual paths.
    function wireDrop(drop, onFile) {
      var input = drop.querySelector('input[type=file]');
      drop.addEventListener("click", function () { input.click(); });
      drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
      drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("drag"); });
      drop.addEventListener("dragleave", function () { drop.classList.remove("drag"); });
      drop.addEventListener("drop", function (e) {
        e.preventDefault(); drop.classList.remove("drag");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      });
      input.addEventListener("change", function () { if (input.files[0]) onFile(input.files[0]); });
    }

    function renderIdle() {
      if (dual) { renderIdleDual(); return; }
      panel.innerHTML =
        '<div class="dropzone" id="xfa-drop" role="button" tabindex="0" aria-label="Choose a spreadsheet">' +
          '<div class="icon">↑</div>' +
          '<div class="big">Drop your spreadsheet here</div>' +
          '<div class="small">or <span class="pick">choose a file</span> · .xlsx up to 10 MB</div>' +
          '<input type="file" id="xfa-file" accept="' + esc(accept) + '" />' +
        '</div>' +
        '<div class="reassure">' + esc(cfg.reassure || "Your file is processed in memory and never stored.") + '</div>';
      wireDrop(panel.querySelector("#xfa-drop"), start);
    }

    function dualZone(id, label) {
      return '<div class="dropzone dz" id="' + id + '" role="button" tabindex="0" aria-label="' + esc(label) + '">' +
          '<div class="dzlabel">' + esc(label) + '</div>' +
          '<div class="icon">↑</div>' +
          '<div class="big">Drop file</div>' +
          '<div class="small">or <span class="pick">choose a file</span> · .xlsx</div>' +
          '<input type="file" accept="' + esc(accept) + '" />' +
        '</div>';
    }

    function markChosen(drop, file) {
      drop.classList.add("chosen");
      var big = drop.querySelector(".big");
      var small = drop.querySelector(".small");
      if (big) big.textContent = "✓ " + (file.name || "file.xlsx");
      if (small) small.textContent = "click to replace";
    }

    function refreshCompare() {
      var btn = panel.querySelector("#xfa-compare");
      if (btn) btn.disabled = !(fileA && fileB);
    }

    function renderIdleDual() {
      fileA = null; fileB = null;
      panel.innerHTML =
        '<div class="dual">' + dualZone("xfa-drop-a", labelA) + dualZone("xfa-drop-b", labelB) + '</div>' +
        '<div class="reassure">' + esc(cfg.reassure || "Your files are processed in memory and never stored.") + '</div>' +
        '<div class="actions"><button class="btn primary" id="xfa-compare" disabled>' + esc(cfg.actionLabel || "Compare") + '</button></div>';
      var dropA = panel.querySelector("#xfa-drop-a");
      var dropB = panel.querySelector("#xfa-drop-b");
      wireDrop(dropA, function (f) { fileA = f; markChosen(dropA, f); refreshCompare(); });
      wireDrop(dropB, function (f) { fileB = f; markChosen(dropB, f); refreshCompare(); });
      panel.querySelector("#xfa-compare").addEventListener("click", function () {
        if (fileA && fileB) startDual(fileA, fileB);
      });
    }

    function renderRunning(filename) {
      var steps = (cfg.steps || []).map(function (s, i) {
        return '<li id="xfa-step-' + i + '"><span class="m">·</span>' + esc(s) + '</li>';
      }).join("");
      panel.innerHTML =
        '<div class="running">' +
          '<div class="spinner" role="status" aria-label="Working"></div>' +
          '<div class="lead">' + esc(cfg.runningLabel || "Working…") + '</div>' +
          '<div class="file">' + esc(filename) + '</div>' +
          (steps ? '<ul class="steps">' + steps + '</ul>' : "") +
        '</div>';
    }
    function stepState(i, state) {
      var el = panel.querySelector("#xfa-step-" + i);
      if (!el) return;
      el.className = state;
      var m = el.querySelector(".m");
      if (m) m.textContent = state === "done" ? "✓" : (state === "on" ? "→" : "·");
    }

    function renderError(message) {
      panel.innerHTML =
        '<div class="notice err"><b>Couldn’t finish.</b> ' + esc(message) + '</div>' +
        '<div class="actions"><button class="btn primary" id="xfa-retry">Try another file</button></div>';
      panel.querySelector("#xfa-retry").addEventListener("click", renderIdle);
    }

    function renderResult(vm) {
      var html = "";
      if (vm.summary && vm.summary.length) {
        html += '<div class="summary">' + vm.summary.map(function (c) {
          return '<div class="cnt ' + (c.cls || "") + '"><div class="n">' + esc(c.n) + '</div><div class="l">' + esc(c.l) + '</div></div>';
        }).join("") + '</div>';
      }
      html += '<div class="result">';
      if (vm.heading) html += '<h2>' + esc(vm.heading) + '</h2>';
      if (vm.findings && vm.findings.length) {
        html += '<div class="findings">' + vm.findings.map(function (f) {
          var tokCls = f.silent ? "tok silent" : "tok";
          return '<div class="finding ' + (f.attn === false ? "" : "attn") + '">' +
            '<div class="head"><span class="cell">' + esc(f.cell) + '</span>' +
              (f.token ? '<span class="' + tokCls + '">' + esc(f.token) + '</span>' : "") + '</div>' +
            (f.formula ? '<div class="formula">' + esc(f.formula) + '</div>' : "") +
            (f.why ? '<div class="why">' + rich(f.why) + '</div>' : "") +
          '</div>';
        }).join("") + '</div>';
      } else if (vm.empty) {
        html += '<div class="notice info">' + rich(vm.empty) + '</div>';
      }
      // Read-only preview grid (XLS-217): a { headers:[...], rows:[[...]] }
      // view model (typically from api.parseGrid on an xlsx_read result) shown
      // as a plain table with a distinguished header. Cells are esc()'d and
      // bounded to the header width so a stray split can't skew the columns.
      // No inputs, no download — a peek, never an edit.
      if (vm.grid && vm.grid.headers && vm.grid.headers.length) {
        var g = vm.grid;
        var allRows = g.rows || [];
        // DOM-safety ceiling: a preview is bounded by the caller (xlsx_read
        // maxRows), but as a reusable primitive we never trust that — a
        // pathological grid must not freeze the tab. Cap here and say so.
        var shownRows = allRows.slice(0, MAX_GRID_ROWS);
        var thead = '<thead><tr>' + g.headers.map(function (h) {
          return '<th scope="col">' + esc(h) + '</th>';
        }).join("") + '</tr></thead>';
        var tbody = '<tbody>' + shownRows.map(function (r) {
          return '<tr>' + g.headers.map(function (_h, ci) {
            return '<td>' + esc(r[ci] != null ? r[ci] : "") + '</td>';
          }).join("") + '</tr>';
        }).join("") + '</tbody>';
        html += '<div class="grid-wrap"><table class="preview-grid">' + thead + tbody + '</table></div>';
        if (allRows.length > shownRows.length) {
          html += '<div class="grid-note">Showing the first ' + shownRows.length + ' rows.</div>';
        } else if (vm.gridNote) {
          html += '<div class="grid-note">' + rich(vm.gridNote) + '</div>';
        }
      }
      // Raw text output (XLS-216): a tool's markdown/text result shown
      // verbatim in a scrollable monospace block. esc() is the sole DOM
      // authority — tool output can never inject markup.
      if (vm.output != null && String(vm.output) !== "") {
        html += '<pre class="tool-output">' + esc(vm.output) + '</pre>';
      }
      html += '</div>';

      if (vm.ledger) {
        html += '<div class="ledger"><div class="lhead">What we did &middot; what we didn’t touch</div>';
        (vm.ledger.did || []).forEach(function (d) {
          html += '<div class="lrow did"><span class="k">✓</span><span class="v">' + rich(d) + '</span></div>';
        });
        (vm.ledger.kept || []).forEach(function (d) {
          html += '<div class="lrow kept"><span class="k">—</span><span class="v">' + rich(d) + '</span></div>';
        });
        html += '</div>';
      }

      html += '<div class="actions">';
      if (vm.download) html += '<button class="btn primary" id="xfa-dl">Download the result</button>';
      html += '<button class="btn" id="xfa-again">Check another file</button></div>';
      panel.innerHTML = html;

      panel.querySelector("#xfa-again").addEventListener("click", renderIdle);
      if (vm.download) {
        panel.querySelector("#xfa-dl").addEventListener("click", function () {
          startDownload(vm.download);
        });
      }
    }

    // ---- params-UI mode (XLS-200) ---------------------------------------
    // Additive, opt-in via cfg.params. After upload we optionally run
    // cfg.discover(b64, api) for dynamic data (e.g. column names), then render
    // a form from cfg.buildForm(discovered) and hand the collected form state
    // to cfg.process(b64, api, values). Single-file and dual paths untouched.
    // The primitive is domain-agnostic: it collects every field/repeat row
    // verbatim; the page decides per-row validity in its process().
    var params = !!cfg.params;
    // Holds the object cfg.discover() resolved to, so a dependent re-render
    // (XLS-216) can re-invoke cfg.buildForm(discovered, values) without
    // re-reading the file.
    var lastDiscovered = {};

    function toolApi(name) {
      return { runTool: runTool, parseTable: parseTable, parseGrid: parseGrid, textOf: textOf, esc: esc, step: stepState, filename: name };
    }
    // name is page-authored; still restrict to a DOM-safe id before use as a
    // selector so a bad config can't smuggle selector/attribute syntax.
    function safeName(n) { return String(n == null ? "" : n).replace(/[^a-z0-9_]/g, ""); }

    function selectHtml(name, label, options, sub, selected, reload) {
      var opts = (options || []).map(function (o) {
        var sel = (selected != null && String(o.value) === String(selected)) ? " selected" : "";
        return '<option value="' + esc(o.value) + '"' + sel + '>' + esc(o.label != null ? o.label : o.value) + '</option>';
      }).join("");
      return '<label class="pf"><span class="pl">' + esc(label || "") + '</span>' +
        '<select ' + (sub ? "data-xfa-sub" : "data-xfa-field") + '="' + safeName(name) + '"' +
        (reload ? ' data-xfa-reload="1"' : "") + '>' + opts + '</select></label>';
    }
    function textHtml(name, label, placeholder, sub) {
      return '<label class="pf"><span class="pl">' + esc(label || "") + '</span>' +
        '<input type="text" ' + (sub ? "data-xfa-sub" : "data-xfa-field") + '="' + safeName(name) +
        '" placeholder="' + esc(placeholder || "") + '" /></label>';
    }
    function subHtml(f) {
      return f.type === "select" ? selectHtml(f.name, f.label, f.options, true) : textHtml(f.name, f.label, f.placeholder, true);
    }
    function rowHtml(field) {
      return '<div class="prow">' + (field.row || []).map(subHtml).join("") +
        '<button type="button" class="prow-x" aria-label="Remove">&times;</button></div>';
    }
    function fieldHtml(f) {
      if (f.type === "select") return selectHtml(f.name, f.label, f.options, false, f.value, f.reload);
      if (f.type === "text") return textHtml(f.name, f.label, f.placeholder, false);
      if (f.type === "checklist") {
        var boxes = (f.options || []).map(function (o) {
          return '<label class="pcheck"><input type="checkbox" data-xfa-check="' + safeName(f.name) +
            '" value="' + esc(o.value) + '"' + (o.checked ? " checked" : "") + ' /> ' + esc(o.label != null ? o.label : o.value) + '</label>';
        }).join("");
        return '<div class="pgroup" data-xfa-checklist="' + safeName(f.name) + '"><div class="pgl">' + esc(f.label || "") + '</div>' + boxes + '</div>';
      }
      if (f.type === "repeat") {
        return '<div class="pgroup prepeat" data-xfa-repeat="' + safeName(f.name) + '">' +
          '<div class="pgl">' + esc(f.label || "") + '</div>' +
          '<div class="prows" data-xfa-rows="' + safeName(f.name) + '"></div>' +
          '<button type="button" class="btn small" data-xfa-add="' + safeName(f.name) + '">' + esc(f.addLabel || "Add") + '</button></div>';
      }
      return "";
    }

    function wireRepeat(field) {
      var name = safeName(field.name);
      var rowsEl = panel.querySelector('[data-xfa-rows="' + name + '"]');
      var addBtn = panel.querySelector('[data-xfa-add="' + name + '"]');
      if (!rowsEl) return;
      var min = field.min != null ? field.min : 1;
      var max = field.max != null ? field.max : 16;
      function refresh() {
        var n = rowsEl.children.length;
        if (addBtn) addBtn.disabled = n >= max;
        for (var i = 0; i < rowsEl.children.length; i++) {
          var x = rowsEl.children[i].querySelector(".prow-x");
          if (x) x.style.visibility = n <= min ? "hidden" : "visible";
        }
      }
      function addRow() {
        if (rowsEl.children.length >= max) return;
        var tmp = document.createElement("div");
        tmp.innerHTML = rowHtml(field);
        var row = tmp.firstChild;
        rowsEl.appendChild(row);
        row.querySelector(".prow-x").addEventListener("click", function () {
          if (rowsEl.children.length > min) { rowsEl.removeChild(row); refresh(); }
        });
        refresh();
      }
      if (addBtn) addBtn.addEventListener("click", addRow);
      for (var k = 0; k < min; k++) addRow();
    }

    function collectValues(fields) {
      var out = {};
      (fields || []).forEach(function (f) {
        var name = safeName(f.name);
        if (f.type === "select" || f.type === "text") {
          var el = panel.querySelector('[data-xfa-field="' + name + '"]');
          out[f.name] = el ? String(el.value).trim() : "";
        } else if (f.type === "checklist") {
          var vals = [], boxes = panel.querySelectorAll('[data-xfa-check="' + name + '"]');
          for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) vals.push(boxes[i].value);
          out[f.name] = vals;
        } else if (f.type === "repeat") {
          var rows = [], rowEls = panel.querySelectorAll('[data-xfa-rows="' + name + '"] > .prow');
          for (var r = 0; r < rowEls.length; r++) {
            var obj = {};
            (f.row || []).forEach(function (sub) {
              var sel = rowEls[r].querySelector('[data-xfa-sub="' + safeName(sub.name) + '"]');
              obj[sub.name] = sel ? String(sel.value).trim() : "";
            });
            rows.push(obj);
          }
          out[f.name] = rows;
        }
      });
      return out;
    }

    function renderReading(filename) {
      panel.innerHTML =
        '<div class="running">' +
          '<div class="spinner" role="status" aria-label="Reading"></div>' +
          '<div class="lead">' + esc(cfg.discoverLabel || "Reading your file…") + '</div>' +
          '<div class="file">' + esc(filename) + '</div>' +
        '</div>';
    }

    function renderParams(fields, b64, name) {
      panel.innerHTML =
        '<div class="params">' +
          '<div class="pfile">' + esc(name) + '</div>' +
          '<form class="pform" onsubmit="return false">' + (fields || []).map(fieldHtml).join("") + '</form>' +
          '<div class="reassure">' + esc(cfg.reassure || "Your file is processed in memory and never stored.") + '</div>' +
          '<div class="actions"><button class="btn primary" id="xfa-run">' + esc(cfg.runLabel || "Run") + '</button>' +
          '<button class="btn" id="xfa-params-back">Choose another file</button></div>' +
        '</div>';
      (fields || []).forEach(function (f) { if (f.type === "repeat") wireRepeat(f); });
      // Dependent re-render (XLS-216): a field marked reload:true re-invokes
      // buildForm(discovered, currentValues) and re-renders the form — the
      // two-stage "pick a tool → render that tool's form" flow. Single-stage
      // pages declare no reload field and are untouched.
      var reloaders = panel.querySelectorAll('[data-xfa-reload="1"]');
      for (var ri = 0; ri < reloaders.length; ri++) {
        reloaders[ri].addEventListener("change", function () {
          var vals = collectValues(fields);
          var next = cfg.buildForm ? cfg.buildForm(lastDiscovered, vals) : [];
          renderParams(next, b64, name);
        });
      }
      panel.querySelector("#xfa-params-back").addEventListener("click", renderIdle);
      panel.querySelector("#xfa-run").addEventListener("click", function () {
        var values = collectValues(fields);
        renderRunning(name);
        Promise.resolve().then(function () {
          return cfg.process(b64, toolApi(name), values);
        }).then(function (vm) {
          renderResult(vm || {});
        }).catch(function (err) {
          renderError(err && err.message ? err.message : "Something went wrong. Please try again.");
        });
      });
    }

    // discover → buildForm → form. A rejection in discover OR a throw in
    // buildForm surfaces the standard error card (never a blank params screen).
    function startParams(name, b64) {
      renderReading(name);
      return Promise.resolve().then(function () {
        return cfg.discover ? cfg.discover(b64, toolApi(name)) : {};
      }).then(function (discovered) {
        lastDiscovered = discovered || {};
        var fields = cfg.buildForm ? cfg.buildForm(lastDiscovered, {}) : [];
        renderParams(fields, b64, name);
      }).catch(function (err) {
        renderError(err && err.message ? err.message : "Couldn’t read that file. Please try again.");
      });
    }

    function start(file) {
      var name = file.name || "workbook.xlsx";
      if (!/\.xlsx$/i.test(name)) { renderError("This tool reads Excel .xlsx files. Please choose a .xlsx workbook."); return; }
      if (file.size > (cfg.maxBytes || MAX_BYTES)) { renderError("That file is over the 10 MB limit for the free web tool."); return; }
      renderRunning(name);
      fileToBase64(file).then(function (b64) {
        if (params) return startParams(name, b64);
        return cfg.process(b64, toolApi(name)).then(function (vm) { renderResult(vm || {}); });
      }).catch(function (err) {
        renderError(err && err.message ? err.message : "Something went wrong. Please try again.");
      });
    }

    // Dual-file variant of start(): validate + size-check both files, then
    // hand cfg.process a { a, b } base64 map plus both filenames. The page's
    // process() runs the two-file tool (e.g. xlsx_diff) and returns the same
    // view model shape single-file pages use.
    function startDual(a, b) {
      var pair = [{ f: a, label: labelA }, { f: b, label: labelB }];
      for (var i = 0; i < pair.length; i++) {
        var f = pair[i].f, nm = f.name || "workbook.xlsx";
        if (!validXlsx(nm)) { renderError("Both files must be Excel .xlsx workbooks. “" + nm + "” isn’t one."); return; }
        if (f.size > maxB) { renderError("“" + nm + "” is over the 10 MB limit for the free web tool."); return; }
      }
      renderRunning((a.name || "file A") + "  ↔  " + (b.name || "file B"));
      Promise.all([fileToBase64(a), fileToBase64(b)]).then(function (b64s) {
        return cfg.process({ a: b64s[0], b: b64s[1] }, {
          runTool: runTool, parseTable: parseTable, parseGrid: parseGrid, textOf: textOf, esc: esc,
          step: stepState, filenameA: a.name, filenameB: b.name
        });
      }).then(function (vm) {
        renderResult(vm || {});
      }).catch(function (err) {
        renderError(err && err.message ? err.message : "Something went wrong. Please try again.");
      });
    }

    renderIdle();
  }

  // Download a result workbook. Two shapes, because the tool routes return
  // output two ways:
  //   { text, filename, mime }  — text-format transforms (convert → csv/json/
  //     md/…) render their output in the body, not as bytes. Save the raw
  //     string directly with the format's MIME type.
  //   { file_b64, filename, mime? }  — transform routes (convert to a binary
  //     format, clean, redact, healer-cure, …) return the output bytes inline
  //     in _meta.file_b64. No server round-trip: the bytes are already in hand.
  //     mime defaults to .xlsx.
  //   { handle, filename }    — handle-based routes (stamp, receipt, session
  //     commit) leave bytes in the client-scoped cache; fetch them here.
  function startDownload(dl) {
    if (!dl) return Promise.resolve();
    if (dl.text != null) {
      try { saveBlob(new Blob([dl.text], { type: dl.mime || "text/plain" }), dl.filename); }
      catch (err) { alert("Couldn’t save the file. Please run it again."); }
      return Promise.resolve();
    }
    if (dl.file_b64 != null) {
      // Inline bytes are already in hand — decode + save directly. Guard the
      // decode so a malformed payload surfaces the same friendly failure the
      // handle path gives, instead of an unhandled throw.
      try { saveBytes(dl.file_b64, dl.filename, dl.mime); }
      catch (err) { alert("Couldn’t save the file. Please run it again."); }
      return Promise.resolve();
    }
    return ensureKey().then(function (key) {
      return xfetch(API + "/api/v1/cache/download", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({ handle: dl.handle })
      });
    }).then(function (r) {
      if (!r.ok) throw new XfaError("The download link expired. Please run the file again.");
      return r.json();
    }).then(function (j) {
      saveBytes(j.file_b64, dl.filename);
    }).catch(function (err) { alert(err && err.message ? err.message : "Download failed."); });
  }

  function saveBytes(b64, filename, mime) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], {
      type: mime || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    saveBlob(blob, filename);
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename || "result.xlsx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  window.XFA = {
    mount: mount, runTool: runTool, parseTable: parseTable, parseGrid: parseGrid,
    fileToBase64: fileToBase64, textOf: textOf, esc: esc, API: API
  };

  // MCP-adoption section (XLS-221). Every tool page loads this shell, so it
  // builds the section once above the footer. The visitor just used a free
  // browser tool; this tells them the same operations are callable by their own
  // agent over MCP. Inform, not sell: it's the same product, also free — not an
  // upsell tier.
  //
  // Structure is shared here, but the PITCH PROSE is unique per page: each tool
  // page carries its own authored <div class="xfa-mcp-copy" hidden> (h2 + 1-2
  // paragraphs in that tool's language). Identical boilerplate across pages is
  // duplicate content that dilutes SEO, and this section is the funnel's
  // conversion point — so the copy is per-tool. The shell relocates that block
  // and wraps it with the SHARED, DRY frame: the canonical install snippet
  // (verbatim site copy — single source so it can't drift across pages) and the
  // /#docs link. A page opts in by shipping an .xfa-mcp-copy block; hub/stub
  // pages ship none (and most don't load this shell) so they opt out.
  //
  // Authoring contract: the copy block's <h2> carries NO id — the shell assigns
  // id="xfa-mcp-h" to the heading after relocation and points aria-labelledby at
  // it. The source block is removed before the section gets that id, so there is
  // never a duplicate id (even for a client on a stale cached shell).
  //
  // All markup is static (authored prose + constant install text, no user
  // input), so it's XSS- and CSP-safe under script-src 'self'. Runs at
  // end-of-body, so the footer anchor and the copy block already exist.
  function injectMcpSection() {
    if (document.getElementById("xfa-mcp")) return;          // idempotent
    var copy = document.querySelector(".xfa-mcp-copy");      // per-page unique prose
    var footer = document.querySelector("footer.site");
    if (!copy || !footer) return;                            // no copy/footer -> opt out
    var inner = copy.innerHTML;                              // authored h2 + prose (no id)
    copy.parentNode.removeChild(copy);                       // drop source first: never a dup id
    var sec = document.createElement("section");
    sec.className = "xfa-mcp";
    sec.id = "xfa-mcp";
    sec.innerHTML =
      '<div class="wrap">' +
        inner +                                              // unique, authored per tool
        '<pre class="xfa-mcp-cmd"><code>npm install -g xlsx-for-ai\n' +
        'claude mcp add xfa -- xlsx-for-ai-mcp</code></pre>' +
        '<p class="xfa-mcp-more"><a href="/#docs">See the full setup and agent ' +
        'config →</a></p>' +
      '</div>';
    var h = sec.querySelector("h2");                         // name the section off its own heading
    if (h) { h.id = "xfa-mcp-h"; sec.setAttribute("aria-labelledby", "xfa-mcp-h"); }
    footer.parentNode.insertBefore(sec, footer);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectMcpSection);
  } else {
    injectMcpSection();
  }
})();
