/* ═══════════════════════════════════════════════════════════════════
   refract-debug diagnostic logger
   ───────────────────────────────────────────────────────────────────
   Loads alongside refract.js in the debug build. Captures evidence for
   the "Save button stuck disabled after Apply" report and exposes it
   through both DevTools console (prefix `[refract-debug]`) AND a
   floating on-screen panel — bottom-right pill button that opens a
   log viewer with Copy-to-Clipboard and Download-as-.txt actions.
   The reporter never needs to open DevTools.

   What's captured:
     • Uncaught JS errors + unhandled promise rejections
     • Every scrape-dialog mount: dialog className, Apply state
     • Every Apply click: pre/post snapshot of the underlying page
       form (every input/select/textarea value), diffed at +1s so we
       can see which fields actually changed
     • Save-button disabled-attribute transitions (Mutation observer)
     • Save-button state at +0/+200/+1000ms after Apply
     • Save click attempts (success or "click on disabled" no-op)

   Key signal: if the post-Apply diff shows NO fields changed,
   formik.dirty stays false and Save is supposed to be disabled —
   the bug is the scraper, not Refract.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    var TAG = "[refract-debug]";
    var STYLE = "color:#a06cff;font-weight:600";
    var MAX_BUFFER = 500;
    var buffer = [];   /* { ts, level, parts } */
    var panel = null;
    var pillCount = null;
    var logArea = null;

    /* ── Logging primitive ──────────────────────────────────────────── */
    function record(level, args) {
        var parts = [];
        for (var i = 0; i < args.length; i++) {
            var a = args[i];
            if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") {
                parts.push(String(a));
            } else {
                try { parts.push(JSON.stringify(a)); }
                catch (e) { parts.push(String(a)); }
            }
        }
        var entry = {
            ts: new Date().toISOString(),
            level: level,
            text: parts.join(" ")
        };
        buffer.push(entry);
        if (buffer.length > MAX_BUFFER) { buffer.splice(0, buffer.length - MAX_BUFFER); }
        try {
            var cs = ["%c" + TAG, STYLE];
            for (var j = 0; j < args.length; j++) { cs.push(args[j]); }
            (level === "warn" ? console.warn : console.log).apply(console, cs);
        } catch (e) {}
        refreshUi();
    }
    function log()  { record("log",  arguments); }
    function warn() { record("warn", arguments); }

    /* ── Uncaught error capture ─────────────────────────────────────── */
    window.addEventListener("error", function (e) {
        warn("JS error:", e.message, "@", (e.filename || "?") + ":" + e.lineno);
    });
    window.addEventListener("unhandledrejection", function (e) {
        warn("Unhandled promise rejection:", e.reason);
    });

    /* ── Form snapshot helpers ──────────────────────────────────────── */
    function snapshotForm(root) {
        if (!root) { return {}; }
        var out = {};
        root.querySelectorAll("input, select, textarea").forEach(function (el) {
            if (el.type === "hidden") { return; }
            var key = el.name || el.id || el.getAttribute("data-rb-event-key") || null;
            if (!key) {
                var fg = el.closest("[data-field], .form-group");
                if (fg) {
                    key = fg.getAttribute("data-field") ||
                          (fg.querySelector(".col-form-label, label") || {}).textContent ||
                          null;
                    if (key) { key = key.trim().slice(0, 40); }
                }
            }
            if (!key) { key = "(anon:" + el.tagName.toLowerCase() + ")"; }
            var v;
            if (el.type === "checkbox") { v = el.checked; }
            else { v = el.value; }
            if (typeof v === "string" && v.length > 80) { v = v.slice(0, 77) + "..."; }
            var base = key;
            while (out.hasOwnProperty(key)) { key = base + "#" + (parseInt(key.split("#")[1] || "1", 10) + 1); }
            out[key] = v;
        });
        return out;
    }
    function diffSnapshots(before, after) {
        var changed = {};
        var allKeys = {};
        Object.keys(before).forEach(function (k) { allKeys[k] = 1; });
        Object.keys(after).forEach(function (k) { allKeys[k] = 1; });
        Object.keys(allKeys).forEach(function (k) {
            var b = before.hasOwnProperty(k) ? before[k] : "(missing)";
            var a = after.hasOwnProperty(k)  ? after[k]  : "(missing)";
            if (b !== a) { changed[k] = { before: b, after: a }; }
        });
        return changed;
    }

    /* ── Save button enumeration ────────────────────────────────────── */
    function findSaveButtons() {
        var sel = [
            ".details-edit .btn-success",
            ".details-edit .btn-primary",
            "#save-split-button",
            "#save-split-button button",
            ".modal-footer .btn.btn-primary",
            ".ModalFooter .btn.btn-primary"
        ].join(", ");
        return Array.prototype.slice.call(document.querySelectorAll(sel));
    }
    function snapshotSaveButtons(label) {
        var btns = findSaveButtons();
        if (!btns.length) {
            log(label, "no Save button found in DOM");
            return;
        }
        btns.forEach(function (b, i) {
            var inModal = !!b.closest(".modal");
            log(label + " save[" + i + "]",
                "disabled=" + b.disabled,
                "text=" + JSON.stringify((b.textContent || "").trim().slice(0, 40)),
                "inModal=" + inModal);
        });
    }

    /* ── Disabled-attribute observer on Save buttons ────────────────── */
    var watchedSaves = new WeakSet();
    var saveAttrObserver = new MutationObserver(function (records) {
        records.forEach(function (r) {
            if (r.type === "attributes" && r.attributeName === "disabled") {
                log("Save disabled changed →", r.target.disabled,
                    "text=" + JSON.stringify((r.target.textContent || "").trim().slice(0, 30)));
            }
        });
    });
    function attachSaveAttrObservers() {
        findSaveButtons().forEach(function (b) {
            if (watchedSaves.has(b)) { return; }
            watchedSaves.add(b);
            saveAttrObserver.observe(b, { attributes: true, attributeFilter: ["disabled"] });
        });
    }

    /* ── Scrape-dialog tracking ─────────────────────────────────────── */
    var seenScrapeDialogs = new WeakSet();
    function inspectScrapeDialog(modalContent) {
        if (seenScrapeDialogs.has(modalContent)) { return; }
        seenScrapeDialogs.add(modalContent);
        var dlg = modalContent.closest(".modal-dialog");
        log("scrape dialog opened. dialogClassName=" +
            JSON.stringify(dlg ? dlg.className : "(no .modal-dialog)"));
        var apply = modalContent.querySelector(".modal-footer .btn.btn-primary");
        log("  apply btn text=" + JSON.stringify((apply && apply.textContent || "").trim()),
            "disabled=" + (apply ? apply.disabled : "(none)"));
    }

    /* ── Click capture: Apply + Save ────────────────────────────────── */
    var pendingBefore = null;
    document.body && document.body.addEventListener("click", function (e) {
        var btn = e.target.closest("button.btn");
        if (!btn) { return; }
        var text = (btn.textContent || "").trim().toLowerCase();
        var scrapeModalContent = btn.closest(".modal-content");
        var inScrapeDialog = scrapeModalContent &&
            scrapeModalContent.querySelector(":scope > .modal-body > .dialog-container");

        if (text === "apply" && inScrapeDialog) {
            log("Apply clicked in scrape dialog");
            var pageForm = document.querySelector(
                "form#performer-edit, form#scene-edit, form#studio-edit, " +
                "form#movie-edit, form#gallery-edit, form#group-edit, " +
                "form[id$='-edit']"
            );
            pendingBefore = {
                form: pageForm,
                snapshot: pageForm ? snapshotForm(pageForm) : null,
                ts: Date.now()
            };
            log("  page form id=" + (pageForm ? pageForm.id : "(NONE FOUND)"),
                "fields=" + (pendingBefore.snapshot ? Object.keys(pendingBefore.snapshot).length : 0));
            snapshotSaveButtons("  pre-apply");

            [0, 200, 1000].forEach(function (delay) {
                setTimeout(function () {
                    attachSaveAttrObservers();
                    snapshotSaveButtons("  +" + delay + "ms");
                    if (delay === 1000 && pendingBefore && pendingBefore.form) {
                        var after = snapshotForm(pendingBefore.form);
                        var d = diffSnapshots(pendingBefore.snapshot, after);
                        var changed = Object.keys(d);
                        if (!changed.length) {
                            warn("  no form fields changed after Apply — " +
                                 "Save will stay disabled because formik.dirty=false");
                        } else {
                            log("  form fields changed:", changed.length);
                            changed.forEach(function (k) {
                                log("    " + k + ":", JSON.stringify(d[k].before), "→", JSON.stringify(d[k].after));
                            });
                        }
                        flashPill();
                        pendingBefore = null;
                    }
                }, delay);
            });
        }

        if (text === "save" || text === "save & new") {
            log("Save click attempted. disabled=" + btn.disabled,
                "inModal=" + !!btn.closest(".modal"),
                "form=" + (btn.closest("form") ? btn.closest("form").id || "(no id)" : "(no form)"));
            flashPill();
        }
    }, true);

    /* ── DOM observer: scrape dialogs as they mount ─────────────────── */
    function startBodyObserver() {
        var bodyObserver = new MutationObserver(function (records) {
            records.forEach(function (r) {
                r.addedNodes.forEach(function (n) {
                    if (n.nodeType !== 1) { return; }
                    var contents = [];
                    if (n.matches && n.matches(".modal-content")) { contents.push(n); }
                    if (n.querySelectorAll) {
                        n.querySelectorAll(".modal-content").forEach(function (c) { contents.push(c); });
                    }
                    contents.forEach(function (c) {
                        if (c.querySelector(":scope > .modal-body > .dialog-container")) {
                            inspectScrapeDialog(c);
                        }
                    });
                    attachSaveAttrObservers();
                });
            });
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        attachSaveAttrObservers();
    }

    /* ── Floating panel UI ──────────────────────────────────────────── */
    function buildPanel() {
        if (panel || !document.body) { return; }

        /* Styles inline so the panel works regardless of theme. */
        var style = document.createElement("style");
        style.textContent = [
            "#refract-debug-pill{position:fixed;bottom:14px;right:14px;z-index:99999;",
            "  background:#1f1029;color:#d8c8ff;border:1px solid #6b3fbc;border-radius:999px;",
            "  padding:6px 12px;font:600 12px/1 system-ui,sans-serif;cursor:pointer;",
            "  box-shadow:0 4px 16px rgba(0,0,0,0.45),0 0 18px rgba(160,108,255,0.25);",
            "  user-select:none;transition:transform 0.15s,box-shadow 0.15s;}",
            "#refract-debug-pill:hover{transform:translateY(-1px);",
            "  box-shadow:0 6px 22px rgba(0,0,0,0.55),0 0 24px rgba(160,108,255,0.4);}",
            "#refract-debug-pill.flash{animation:rdb-flash 0.6s ease-out;}",
            "@keyframes rdb-flash{0%{background:#a06cff;color:#fff;}100%{}}",
            "#refract-debug-panel{position:fixed;bottom:50px;right:14px;z-index:99999;",
            "  width:min(640px,calc(100vw - 28px));height:min(440px,60vh);display:none;",
            "  flex-direction:column;background:#0f0a18;color:#e8e0ff;",
            "  border:1px solid #6b3fbc;border-radius:8px;",
            "  box-shadow:0 18px 50px rgba(0,0,0,0.65),0 0 28px rgba(160,108,255,0.18);",
            "  font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;}",
            "#refract-debug-panel.open{display:flex;}",
            "#refract-debug-panel header{display:flex;align-items:center;gap:8px;",
            "  padding:8px 12px;background:#1a1029;border-bottom:1px solid #2a1c40;",
            "  font:600 12px system-ui,sans-serif;}",
            "#refract-debug-panel header .grow{flex:1;}",
            "#refract-debug-panel button.act{background:#2a1c40;color:#e8e0ff;",
            "  border:1px solid #4a2f7a;border-radius:5px;padding:4px 10px;font:600 11px system-ui,sans-serif;",
            "  cursor:pointer;transition:background 0.12s,border-color 0.12s;}",
            "#refract-debug-panel button.act:hover{background:#3a2858;border-color:#6b3fbc;}",
            "#refract-debug-panel button.act.primary{background:#6b3fbc;border-color:#a06cff;color:#fff;}",
            "#refract-debug-panel button.act.primary:hover{background:#7d4cd6;}",
            "#refract-debug-panel textarea{flex:1;background:#0a0612;color:#d8c8ff;",
            "  border:0;padding:10px 12px;resize:none;outline:none;",
            "  font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;",
            "  scrollbar-width:thin;scrollbar-color:#6b3fbc transparent;}",
            "#refract-debug-panel .toast{background:#1a1029;border-top:1px solid #2a1c40;",
            "  padding:6px 12px;font:11px system-ui,sans-serif;color:#a8a0c8;text-align:center;}"
        ].join("\n");
        document.head.appendChild(style);

        var pill = document.createElement("div");
        pill.id = "refract-debug-pill";
        pill.title = "Refract debug — click to view captured logs";
        pill.innerHTML = "Refract Debug · <span id=\"refract-debug-count\">0</span>";
        document.body.appendChild(pill);
        pillCount = pill.querySelector("#refract-debug-count");

        panel = document.createElement("div");
        panel.id = "refract-debug-panel";
        panel.innerHTML = [
            "<header>",
            "  <span>Refract Debug — captured logs</span>",
            "  <span class=\"grow\"></span>",
            "  <button class=\"act\" data-action=\"clear\">Clear</button>",
            "  <button class=\"act\" data-action=\"download\">Download .txt</button>",
            "  <button class=\"act primary\" data-action=\"copy\">Copy to clipboard</button>",
            "  <button class=\"act\" data-action=\"close\">×</button>",
            "</header>",
            "<textarea readonly spellcheck=\"false\"></textarea>",
            "<div class=\"toast\">",
            "  Reproduce the bug, then click <b>Copy to clipboard</b> and paste in your message. ",
            "  Manual snapshot: type <code>refractDebugDump()</code> in DevTools.",
            "</div>"
        ].join("\n");
        document.body.appendChild(panel);
        logArea = panel.querySelector("textarea");

        pill.addEventListener("click", function () {
            panel.classList.toggle("open");
            if (panel.classList.contains("open")) { refreshUi(); logArea.scrollTop = logArea.scrollHeight; }
        });
        panel.addEventListener("click", function (e) {
            var b = e.target.closest("button[data-action]");
            if (!b) { return; }
            var act = b.getAttribute("data-action");
            if (act === "close") { panel.classList.remove("open"); }
            else if (act === "clear") { buffer.length = 0; refreshUi(); }
            else if (act === "copy") { copyToClipboard(b); }
            else if (act === "download") { downloadTxt(); }
        });

        refreshUi();
    }
    function refreshUi() {
        if (pillCount) { pillCount.textContent = String(buffer.length); }
        if (logArea && panel && panel.classList.contains("open")) {
            var atBottom = logArea.scrollTop + logArea.clientHeight >= logArea.scrollHeight - 8;
            logArea.value = serializeLogs();
            if (atBottom) { logArea.scrollTop = logArea.scrollHeight; }
        }
    }
    function flashPill() {
        var p = document.getElementById("refract-debug-pill");
        if (!p) { return; }
        p.classList.remove("flash");
        void p.offsetWidth;
        p.classList.add("flash");
    }
    function serializeLogs() {
        var head = [
            "Refract Debug log — " + new Date().toISOString(),
            "URL: " + location.pathname + location.search,
            "UA: " + navigator.userAgent,
            "Version: refract-debug 1.11.6-debug",
            "Entries: " + buffer.length + " (capped at " + MAX_BUFFER + ")",
            "────────────────────────────────────────────────────────────────"
        ].join("\n");
        var body = buffer.map(function (e) {
            return e.ts + " " + (e.level === "warn" ? "WARN " : "     ") + e.text;
        }).join("\n");
        return head + "\n" + body + "\n";
    }
    function copyToClipboard(btn) {
        var text = serializeLogs();
        var ok = function () {
            var prev = btn.textContent;
            btn.textContent = "Copied ✓";
            setTimeout(function () { btn.textContent = prev; }, 1600);
        };
        var fail = function (e) {
            warn("Copy failed:", e && e.message);
            /* Fallback: select textarea contents so the user can ctrl+c */
            if (logArea) { logArea.focus(); logArea.select(); }
            btn.textContent = "Select all + Ctrl+C";
            setTimeout(function () { btn.textContent = "Copy to clipboard"; }, 3000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(ok, fail);
        } else {
            try {
                logArea.value = text;
                logArea.focus(); logArea.select();
                document.execCommand("copy");
                ok();
            } catch (e) { fail(e); }
        }
    }
    function downloadTxt() {
        var text = serializeLogs();
        var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "refract-debug-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /* ── Manual one-shot dump for DevTools power users ──────────────── */
    window.refractDebugDump = function () {
        log("=== manual dump ===");
        log("URL:", location.pathname + location.search);
        snapshotSaveButtons("save state");
        var pageForm = document.querySelector("form[id$='-edit']");
        if (pageForm) {
            log("page form id=" + pageForm.id);
            var snap = snapshotForm(pageForm);
            Object.keys(snap).forEach(function (k) {
                log("  " + k + " =", JSON.stringify(snap[k]));
            });
        } else {
            log("no edit form found on this page");
        }
        var scrapeOpen = document.querySelector(".modal-content");
        log("any modal currently open:", !!scrapeOpen);
        log("=== end dump ===");
    };

    /* ── Boot ────────────────────────────────────────────────────────── */
    function boot() {
        startBodyObserver();
        buildPanel();
        log("diagnostic logger active. Click the bottom-right pill to view/copy/download logs.");
    }
    if (document.body) { boot(); }
    else { document.addEventListener("DOMContentLoaded", boot); }
})();
