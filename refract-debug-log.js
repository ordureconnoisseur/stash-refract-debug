/* ═══════════════════════════════════════════════════════════════════
   refract-debug diagnostic logger
   ───────────────────────────────────────────────────────────────────
   Loads alongside refract.js in the debug build. Captures evidence for
   the "Save button stuck disabled after Apply" report:

     • Every scrape-dialog open/close and its dialogClassName
     • Every Apply click inside a .scrape-dialog
     • Snapshot of every <input>/<select>/<textarea> value on the
       enclosing performer edit form BEFORE and AFTER Apply, with
       a diff so we can see which fields actually changed
     • Save-button disabled state at +0ms, +200ms, +1000ms after Apply
     • Save-button disabled-attribute MutationObserver — logs every
       transition with timestamp
     • Save click attempts: logs disabled=true/false and which button
     • Uncaught JS errors + unhandled promise rejections
     • Manual one-shot dump: type `refractDebugDump()` in DevTools
       console to print the current form/Save snapshot on demand

   Logs are prefixed `[refract-debug]` so the reporter can filter the
   console and copy-paste the relevant block. No data leaves the
   browser. Toggle off by removing refract-debug-log.js from
   refract-debug.yml's javascript: list.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
    "use strict";

    var TAG = "[refract-debug]";
    var STYLE = "color:#a06cff;font-weight:600";

    function log() {
        var args = ["%c" + TAG, STYLE];
        for (var i = 0; i < arguments.length; i++) { args.push(arguments[i]); }
        try { console.log.apply(console, args); } catch (e) {}
    }
    function warn() {
        var args = ["%c" + TAG, STYLE];
        for (var i = 0; i < arguments.length; i++) { args.push(arguments[i]); }
        try { console.warn.apply(console, args); } catch (e) {}
    }

    /* ── Uncaught error capture ─────────────────────────────────────── */
    window.addEventListener("error", function (e) {
        warn("JS error:", e.message, "@", (e.filename || "?") + ":" + e.lineno);
    });
    window.addEventListener("unhandledrejection", function (e) {
        warn("Unhandled promise rejection:", e.reason);
    });

    /* ── Form snapshot helpers ──────────────────────────────────────── */
    /* Walk the nearest enclosing performer/scene/whatever edit form and
       capture { name → value } for every named input/select/textarea.
       Excludes hidden + disabled controls so noise stays low. */
    function snapshotForm(root) {
        if (!root) { return {}; }
        var out = {};
        root.querySelectorAll("input, select, textarea").forEach(function (el) {
            if (el.type === "hidden") { return; }
            var key = el.name || el.id || el.getAttribute("data-rb-event-key") || null;
            if (!key) {
                /* Try to derive from the .form-group label or [data-field] ancestor */
                var fg = el.closest("[data-field], .form-group");
                if (fg) {
                    key = fg.getAttribute("data-field") ||
                          (fg.querySelector(".col-form-label, label") || {}).textContent ||
                          null;
                    if (key) { key = key.trim().slice(0, 40); }
                }
            }
            if (!key) { key = "(anon:" + (el.tagName.toLowerCase()) + ")"; }
            var v;
            if (el.type === "checkbox") { v = el.checked; }
            else { v = el.value; }
            if (typeof v === "string" && v.length > 80) { v = v.slice(0, 77) + "..."; }
            /* If a key appears twice (left/right column in scrape dialog),
               disambiguate with a counter. */
            var base = key, n = 1;
            while (out.hasOwnProperty(key)) { n++; key = base + "#" + n; }
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
        /* Stash performer/scene/whatever edit panel renders Save as a
           btn-success or btn-primary inside .details-edit (page-level)
           OR inside .modal-footer (tagger create modal flow). Grab
           every plausible candidate so we don't miss one. */
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
                "inModal=" + inModal,
                "class=" + JSON.stringify(b.className));
        });
    }

    /* ── MutationObserver: track disabled attribute on Save buttons ── */
    var watchedSaves = new WeakSet();
    var saveAttrObserver = new MutationObserver(function (records) {
        records.forEach(function (r) {
            if (r.type === "attributes" && r.attributeName === "disabled") {
                var btn = r.target;
                log("Save disabled changed →", btn.disabled,
                    "text=" + JSON.stringify((btn.textContent || "").trim().slice(0, 30)));
            }
        });
    });
    function attachSaveAttrObservers() {
        findSaveButtons().forEach(function (b) {
            if (watchedSaves.has(b)) { return; }
            watchedSaves.add(b);
            saveAttrObserver.observe(b, { attributes: true, attributeFilter: ["disabled", "class"] });
        });
    }

    /* ── Scrape-dialog tracking ─────────────────────────────────────── */
    var seenScrapeDialogs = new WeakSet();
    function inspectScrapeDialog(modalContent) {
        if (seenScrapeDialogs.has(modalContent)) { return; }
        seenScrapeDialogs.add(modalContent);
        var dlg = modalContent.closest(".modal-dialog");
        var dlgClass = dlg ? dlg.className : "(no .modal-dialog)";
        log("scrape dialog opened. dialogClassName=" + JSON.stringify(dlgClass));
        var apply = modalContent.querySelector(".modal-footer .btn.btn-primary");
        log("  apply btn text=" + JSON.stringify((apply && apply.textContent || "").trim()),
            "disabled=" + (apply ? apply.disabled : "(none)"));
    }

    /* ── Click capture: Apply + Save ────────────────────────────────── */
    var pendingBefore = null;
    document.body.addEventListener("click", function (e) {
        var btn = e.target.closest("button.btn");
        if (!btn) { return; }
        var text = (btn.textContent || "").trim().toLowerCase();
        var scrapeModalContent = btn.closest(".modal-content");
        var inScrapeDialog = scrapeModalContent &&
            scrapeModalContent.querySelector(":scope > .modal-body > .dialog-container");

        /* Apply inside a scrape dialog → start the before/after snapshot
           sequence. The "form" we want to snapshot is the page form
           UNDERNEATH the modal, not the modal itself. */
        if (text === "apply" && inScrapeDialog) {
            log("Apply clicked in scrape dialog");
            /* Page form lives outside the modal. Find #performer-edit /
               #scene-edit / first <form id*="edit"> we can spot. */
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

            /* After Apply, the modal closes and React reconciles the
               page form. Sample at 0/200/1000ms. */
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
                                 "this explains why Save stays disabled (formik.dirty=false)");
                        } else {
                            log("  form fields changed:", changed.length);
                            changed.forEach(function (k) {
                                log("    " + k + ":", JSON.stringify(d[k].before), "→", JSON.stringify(d[k].after));
                            });
                        }
                        pendingBefore = null;
                    }
                }, delay);
            });
        }

        /* Save click attempt — log the disabled state at the moment of
           click. If it's disabled, the click is a no-op but we want to
           know that the user IS trying to click it. */
        if (text === "save" || text === "save & new") {
            log("Save click attempted. disabled=" + btn.disabled,
                "inModal=" + !!btn.closest(".modal"),
                "form=" + (btn.closest("form") ? btn.closest("form").id || "(no id)" : "(no form)"));
        }
    }, true);

    /* ── DOM observer: detect scrape dialogs as they mount ──────────── */
    var bodyObserver = new MutationObserver(function (records) {
        records.forEach(function (r) {
            r.addedNodes.forEach(function (n) {
                if (n.nodeType !== 1) { return; }
                /* React might mount the modal as the .modal node directly,
                   or insert .modal-content somewhere inside. Cover both. */
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
                /* Also attach Save-button observers when any edit form
                   mounts/re-renders, so we catch disabled transitions
                   that happen without an Apply click in between. */
                attachSaveAttrObservers();
            });
        });
    });
    if (document.body) {
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        attachSaveAttrObservers();
    } else {
        document.addEventListener("DOMContentLoaded", function () {
            bodyObserver.observe(document.body, { childList: true, subtree: true });
            attachSaveAttrObservers();
        });
    }

    /* ── Manual dump — for the reporter to run on demand ─────────────── */
    window.refractDebugDump = function () {
        log("=== manual dump ===");
        log("URL:", location.pathname + location.search);
        log("Refract version: refract-debug 1.11.4-debug");
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
        var scrapeOpen = document.querySelector(".modal-content:has(> .modal-body > .dialog-container)");
        log("scrape dialog currently open:", !!scrapeOpen);
        if (scrapeOpen) {
            var dlg = scrapeOpen.closest(".modal-dialog");
            log("  dialogClassName:", dlg ? dlg.className : "?");
        }
        log("=== end dump ===");
    };

    log("diagnostic logger active. Call refractDebugDump() for a manual snapshot.");
})();
