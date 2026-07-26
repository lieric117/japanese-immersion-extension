// Passively observes Crunchyroll's own network traffic to find the English
// subtitle file URL (Phase 5, 2026-07-23) — see project-plan.md Decisions
// Log for the full reasoning. Runs in the page's own MAIN world (not this
// extension's isolated world — see manifest.json's `"world": "MAIN"` entry),
// which is required to read fetch/XHR RESPONSE BODIES at all:
// chrome.webRequest can observe request/response metadata in Manifest V3,
// but not bodies, so intercepting the page's own fetch()/XMLHttpRequest
// calls from inside its own execution context is the only way to see what
// Crunchyroll's player code itself received — without this extension making
// any additional request of its own (a deliberate choice, not an
// implementation detail: reads data the page already legitimately fetches
// for its own logged-in session, rather than independently calling
// Crunchyroll's undocumented internal API).
//
// Detects the right response by its JSON SHAPE — a top-level `subtitles`
// object with locale keys, each an object with a `url` — not by matching the
// request's URL/path. Crunchyroll's own internal endpoint naming isn't
// documented anywhere and isn't something to hardcode a guess against; this
// survives that naming changing entirely, at the cost of briefly parsing
// every fetch/XHR response as JSON (cheap, and this only runs once per
// episode load in practice).
//
// Communicates the found URL to content.js (the isolated-world content
// script) via `window.postMessage` — MAIN world and ISOLATED world content
// scripts don't share a JS scope, but DO share the same DOM/window for
// dispatching real events, which is the standard way to bridge the two.
(() => {
  function checkAndForward(bodyText) {
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return; // not a JSON response — most page requests aren't
    }
    const subs = data?.subtitles;
    if (!subs || typeof subs !== "object") return;
    const enUs = subs["en-US"];
    if (!enUs?.url) return;
    window.postMessage(
      { __jpImmersionCaptionUrl: enUs.url, __jpImmersionCaptionFormat: enUs.format ?? "ass" },
      "*"
    );
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      // .clone() so reading the body here doesn't consume it out from under
      // whatever the page's own code was going to do with the original
      // response.
      response
        .clone()
        .text()
        .then(checkAndForward)
        .catch(() => {});
      return response;
    });
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        checkAndForward(this.responseText);
      } catch {
        // responseType other than "text"/"" (e.g. blob/arraybuffer) throws
        // reading .responseText — not the JSON API response we want anyway.
      }
    });
    return originalSend.apply(this, args);
  };
})();
