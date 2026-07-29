// Offline test for "edit last card" (Phase 5's final item, built 2026-07-29).
//
// Usage:  node scripts/test-edit-last-card.js
//
// Covers the two pieces that have real logic in them:
//   - background.js's editAnkiNote, whose fallback must fire for an
//     unimplemented AnkiConnect action and for nothing else.
//   - content.js's remembered-note state machine, which decides whether the
//     persistent control is visible and what it says.
//
// AnkiConnect itself is stubbed (no Anki required) and the DOM is stubbed down
// to the three properties the control touches. Both are read out of the real
// source files rather than reimplemented.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function grabFrom(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} — did it get renamed?`);
  return m[0];
}

let failed = 0;
function check(label, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
}

// ── background.js: editAnkiNote ─────────────────────────────────────────────
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

// Builds editAnkiNote over a fake AnkiConnect. `handler(action, params)` either
// returns a result or throws — i.e. it stands in for the server, not for
// invokeAnkiConnect, so the real error-translation logic is still exercised.
function makeEditAnkiNote(handler) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const { action, params } = JSON.parse(init.body);
    calls.push({ action, params });
    let result = null;
    let error = null;
    try {
      result = handler(action, params);
    } catch (e) {
      if (e && e.__network) throw e; // nothing listening on the port
      error = e.message;
    }
    return { json: async () => ({ result, error }) };
  };
  const fn = new Function(
    "fetch",
    [
      grabFrom(bg, /^const ANKICONNECT_URL = .*$/m, "ANKICONNECT_URL"),
      grabFrom(bg, /^const ANKICONNECT_VERSION = .*$/m, "ANKICONNECT_VERSION"),
      grabFrom(bg, /^async function invokeAnkiConnect\([\s\S]*?\n\}/m, "invokeAnkiConnect"),
      grabFrom(bg, /^async function editAnkiNote\([\s\S]*?\n\}/m, "editAnkiNote"),
      "return editAnkiNote;",
    ].join("\n")
  )(fakeFetch);
  return { editAnkiNote: fn, calls };
}

(async () => {
  {
    const { editAnkiNote, calls } = makeEditAnkiNote((action) => {
      if (action === "guiEditNote") return null;
      throw new Error("should not be called");
    });
    const res = await editAnkiNote(1234);
    check(
      "modern AnkiConnect: opens the editor directly, no fallback request",
      res.opened === "editor" && calls.length === 1 && calls[0].action === "guiEditNote" && calls[0].params.note === 1234,
      `opened=${res.opened} calls=${JSON.stringify(calls)}`
    );
  }

  {
    const { editAnkiNote, calls } = makeEditAnkiNote((action) => {
      if (action === "guiEditNote") throw new Error("unsupported action");
      return null;
    });
    const res = await editAnkiNote(1234);
    check(
      "older AnkiConnect: falls back to the browser, aimed at that one note",
      res.opened === "browser" &&
        calls.length === 2 &&
        calls[1].action === "guiBrowse" &&
        calls[1].params.query === "nid:1234",
      `opened=${res.opened} calls=${JSON.stringify(calls)}`
    );
  }

  {
    // A deleted note must NOT be papered over: guiBrowse would open an empty
    // search and look like success.
    const { editAnkiNote, calls } = makeEditAnkiNote((action) => {
      if (action === "guiEditNote") throw new Error("Note was not found: 1234");
      return null;
    });
    let threw = null;
    try {
      await editAnkiNote(1234);
    } catch (e) {
      threw = e.message;
    }
    check(
      "missing note surfaces the real error instead of falling back",
      threw === "Note was not found: 1234" && calls.length === 1,
      `threw=${JSON.stringify(threw)} calls=${calls.length}`
    );
  }

  {
    // Anki closed entirely — invokeAnkiConnect's own network-failure message,
    // and again no fallback attempt.
    const { editAnkiNote, calls } = makeEditAnkiNote(() => {
      const e = new Error("connection refused");
      e.__network = true;
      throw e;
    });
    let threw = null;
    try {
      await editAnkiNote(1234);
    } catch (e) {
      threw = e.message;
    }
    check(
      "Anki closed: reports that, and doesn't try the fallback either",
      /Couldn't reach Anki/.test(threw ?? "") && calls.length === 1,
      `threw=${JSON.stringify(threw)} calls=${calls.length}`
    );
  }

  // ── content.js: the remembered-note state machine ─────────────────────────
  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");

  function makeControl() {
    const el = () => ({
      style: {},
      textContent: "",
      title: "",
      children: [],
      addEventListener() {},
      appendChild(c) {
        this.children.push(c);
      },
    });
    const document = { createElement: el };
    return new Function(
      "document",
      [
        "let lastAddedNote = null;",
        "let editLastCardControl = null;",
        "let editLastCardButton = null;",
        grabFrom(content, /^function buildEditLastCardControl\([\s\S]*?\n\}/m, "buildEditLastCardControl"),
        grabFrom(content, /^function editLastCardLabel\([\s\S]*?\n\}/m, "editLastCardLabel"),
        grabFrom(content, /^function refreshEditLastCardControl\([\s\S]*?\n\}/m, "refreshEditLastCardControl"),
        grabFrom(content, /^function forgetAddedNote\([\s\S]*?\n\}/m, "forgetAddedNote"),
        `return {
           build: buildEditLastCardControl,
           forget: forgetAddedNote,
           refresh: refreshEditLastCardControl,
           addNote: (id, label) => { lastAddedNote = { id, label }; refreshEditLastCardControl(); },
           control: () => editLastCardControl,
           button: () => editLastCardButton,
         };`,
      ].join("\n")
    )(document);
  }

  {
    const h = makeControl();
    h.build();
    check(
      "no card yet: control is hidden",
      h.control().style.display === "none",
      `display=${JSON.stringify(h.control().style.display)}`
    );

    h.addNote(1234, "分かる");
    check(
      "after a capture: visible, and names the word so it's clear which card",
      h.control().style.display === "" && h.button().textContent === "Edit last card (分かる)",
      `display=${JSON.stringify(h.control().style.display)} label=${JSON.stringify(h.button().textContent)}`
    );

    h.addNote(5678, "食べる");
    check(
      "a second capture retargets the control",
      h.button().textContent === "Edit last card (食べる)",
      `label=${JSON.stringify(h.button().textContent)}`
    );

    // Undo of the OLDER note, whose popup is still around as a chip. The newer
    // card still exists, so the control must keep pointing at it.
    h.forget(1234);
    check(
      "undoing an older card leaves the control on the newer one",
      h.control().style.display === "" && h.button().textContent === "Edit last card (食べる)",
      `display=${JSON.stringify(h.control().style.display)} label=${JSON.stringify(h.button().textContent)}`
    );

    h.forget(5678);
    check(
      "undoing the card it points at hides the control again",
      h.control().style.display === "none",
      `display=${JSON.stringify(h.control().style.display)}`
    );
  }

  {
    // The SPA-navigation handler calls refresh() when returning to a watch page
    // instead of setting display itself — otherwise it would reveal an empty
    // control on a session where nothing has been captured.
    const h = makeControl();
    h.build();
    h.control().style.display = "none"; // as the leave-watch-page branch sets it
    h.refresh();
    check(
      "returning to a watch page with no captures keeps the control hidden",
      h.control().style.display === "none",
      `display=${JSON.stringify(h.control().style.display)}`
    );
    h.addNote(1234, "分かる");
    h.control().style.display = "none";
    h.refresh();
    check(
      "returning to a watch page WITH a capture restores the control",
      h.control().style.display === "",
      `display=${JSON.stringify(h.control().style.display)}`
    );
  }

  // The control must be re-parented on fullscreen toggle like every other
  // control, and hidden when leaving a watch page — both are wiring in init()
  // that can't be exercised without a browser, so assert the wiring exists.
  check(
    "the control is re-parented on fullscreenchange, like the other controls",
    /target\.appendChild\(editLastCard\);/.test(content),
    "no fullscreenchange re-parent found for editLastCard"
  );
  check(
    "the control is hidden when leaving a watch page",
    /editLastCard\.style\.display = "none";/.test(content),
    "no non-watch-page hide found for editLastCard"
  );

  console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
  process.exit(failed ? 1 : 0);
})();
