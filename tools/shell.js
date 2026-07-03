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
      var cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
      if (/^-{2,}$/.test(cells.join("").replace(/[:\s|]/g, ""))) continue; // separator
      if (!headers) { headers = cells; continue; }
      var obj = {};
      for (var j = 0; j < headers.length; j++) obj[headers[j]] = cells[j] != null ? cells[j] : "";
      rows.push(obj);
    }
    return rows;
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

    function renderIdle() {
      panel.innerHTML =
        '<div class="dropzone" id="xfa-drop" role="button" tabindex="0" aria-label="Choose a spreadsheet">' +
          '<div class="icon">↑</div>' +
          '<div class="big">Drop your spreadsheet here</div>' +
          '<div class="small">or <span class="pick">choose a file</span> · .xlsx up to 10 MB</div>' +
          '<input type="file" id="xfa-file" accept="' + esc(accept) + '" />' +
        '</div>' +
        '<div class="reassure">' + esc(cfg.reassure || "Your file is processed in memory and never stored.") + '</div>';
      var drop = panel.querySelector("#xfa-drop");
      var input = panel.querySelector("#xfa-file");
      drop.addEventListener("click", function () { input.click(); });
      drop.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
      drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("drag"); });
      drop.addEventListener("dragleave", function () { drop.classList.remove("drag"); });
      drop.addEventListener("drop", function (e) {
        e.preventDefault(); drop.classList.remove("drag");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) start(e.dataTransfer.files[0]);
      });
      input.addEventListener("change", function () { if (input.files[0]) start(input.files[0]); });
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

    function start(file) {
      var name = file.name || "workbook.xlsx";
      if (!/\.xlsx$/i.test(name)) { renderError("This tool reads Excel .xlsx files. Please choose a .xlsx workbook."); return; }
      if (file.size > (cfg.maxBytes || MAX_BYTES)) { renderError("That file is over the 10 MB limit for the free web tool."); return; }
      renderRunning(name);
      fileToBase64(file).then(function (b64) {
        return cfg.process(b64, {
          runTool: runTool, parseTable: parseTable, textOf: textOf, esc: esc,
          step: stepState, filename: name
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
  //   { file_b64, filename }  — transform routes (convert, clean, redact,
  //     healer-cure, …) return the output bytes inline in _meta.file_b64.
  //     No server round-trip: the bytes are already in hand.
  //   { handle, filename }    — handle-based routes (stamp, receipt, session
  //     commit) leave bytes in the client-scoped cache; fetch them here.
  function startDownload(dl) {
    if (!dl) return Promise.resolve();
    if (dl.file_b64 != null) {
      // Inline bytes are already in hand — decode + save directly. Guard the
      // decode so a malformed payload surfaces the same friendly failure the
      // handle path gives, instead of an unhandled throw.
      try { saveBytes(dl.file_b64, dl.filename); }
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

  function saveBytes(b64, filename) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    var blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = filename || "result.xlsx";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  window.XFA = {
    mount: mount, runTool: runTool, parseTable: parseTable,
    fileToBase64: fileToBase64, textOf: textOf, esc: esc, API: API
  };
})();
