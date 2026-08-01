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
// Detects the right response by its JSON SHAPE — a `subtitles` (or
// `captions`) object with locale keys, each an object with a `url` — not by
// matching the request's URL/path. Crunchyroll's own internal endpoint naming
// isn't documented anywhere and isn't something to hardcode a guess against;
// this survives that naming changing entirely, at the cost of briefly parsing
// every fetch/XHR response as JSON (cheap, and this only runs once per
// episode load in practice).
//
// Communicates the found URL to content.js (the isolated-world content
// script) via `window.postMessage` — MAIN world and ISOLATED world content
// scripts don't share a JS scope, but DO share the same DOM/window for
// dispatching real events, which is the standard way to bridge the two.
(() => {
  // The last caption URL found, kept so it can be REPLAYED when content.js
  // announces it's listening (2026-07-26). This is a real bug fix, not
  // defensive padding: this script runs at `document_start` and content.js at
  // `document_idle`, so on a fresh page load Crunchyroll's own `play` request
  // can easily resolve before content.js exists to hear about it. The
  // original fire-and-forget postMessage was simply lost in that window, with
  // no retry and no cache — the English track then never appeared for the
  // whole page session, silently (no error, just no English line), which is
  // exactly the "doesn't show anywhere" report from live testing 2026-07-26.
  let lastFound = null;

  // Counters behind window.__jpImmersionSnifferStats() — a live diagnostic
  // for the one question this script can't answer from the extension side:
  // whether it is seeing the page's traffic AT ALL. If `fetchCalls` is 0 on a
  // loaded watch page, the override isn't in the path the player actually
  // uses (e.g. the request is made from a Web Worker or service worker, which
  // have their own separate global scopes this override never touches) — a
  // completely different problem from "saw the response, didn't recognise it".
  const stats = { fetchCalls: 0, xhrCalls: 0, jsonBodies: 0, subtitleShaped: 0, found: 0, siblingEpisodesSeen: 0 };

  function pickEnglish(container) {
    if (!container || typeof container !== "object") return null;
    // Exact match first, then any English variant (en-GB, plain "en", and
    // Crunchyroll's own occasional locale spellings) — the original code
    // required the literal key "en-US" and gave up otherwise (2026-07-26).
    const keys = Object.keys(container);
    const preferred =
      keys.find((k) => k.toLowerCase() === "en-us") ??
      keys.find((k) => k.toLowerCase().startsWith("en"));
    if (!preferred) return null;
    const entry = container[preferred];
    if (!entry?.url) return null;
    return { url: entry.url, format: entry.format ?? "ass", locale: preferred };
  }

  // Sibling episode titles (2026-08-01), used by background.js to rule a Jimaku
  // subtitle file OUT as belonging to a DIFFERENT episode — see
  // excludeOtherEpisodeFiles there.
  //
  // There is no batched "episodes in this season" response to watch for; that
  // was an assumption, and searching a real page's network log found nothing
  // like it. What Crunchyroll's frontend actually fires on every episode load
  // is ADJACENT-episode lookups — `/content/v2/discover/previous_episode/{id}`
  // and its next_episode counterpart — each returning exactly one episode,
  // nested differently from the CMS season endpoint:
  //
  //   data[].panel.title                            "Memory Snow (Director's Cut)"
  //   data[].panel.episode_metadata.season_id       "GYVDVV35Y"
  //   data[].panel.episode_metadata.season_title    "OVAs"
  //   data[].panel.episode_metadata.series_title    "Re:ZERO -Starting Life…"
  //
  // So one page load yields one or two siblings, not a season. content.js
  // accumulates them per season across visits (see its own cache): a 2-episode
  // OVA set is fully covered by a single load, and an 8-episode OAD set fills
  // in as episodes are watched — partial coverage still rules out real files,
  // which is the whole point of excluding rather than matching.
  //
  // Shape-detected like the captions above, and still fails closed: no match
  // means no siblings and the previous listing behaviour. The season/series
  // titles are forwarded rather than filtered here because this MAIN-world
  // script has no access to the extension's own state — content.js checks them
  // against the page's own JSON-LD, since an adjacent episode can legitimately
  // belong to the PREVIOUS season and must not be treated as a sibling.
  function checkAdjacentEpisode(data) {
    const items = Array.isArray(data?.data) ? data.data : null;
    if (!items || !items.length) return;
    const found = [];
    for (const item of items) {
      const panel = item?.panel;
      const meta = panel?.episode_metadata;
      if (!panel || !meta || typeof meta !== "object") continue;
      const title = typeof panel.title === "string" ? panel.title.trim() : "";
      if (!title || typeof meta.season_id !== "string" || !meta.season_id) continue;
      found.push({
        title,
        seasonId: meta.season_id,
        seasonTitle: typeof meta.season_title === "string" ? meta.season_title : null,
        seriesTitle: typeof meta.series_title === "string" ? meta.series_title : null,
      });
    }
    if (!found.length) return;
    stats.siblingEpisodesSeen += found.length;
    console.log(
      `[jp-immersion] caption sniffer: saw ${found.length} adjacent episode(s) — ` +
        found.map((s) => `"${s.title}" (season ${s.seasonTitle ?? s.seasonId})`).join(", ")
    );
    window.postMessage({ __jpImmersionSiblingEpisodes: found, __jpImmersionSiblingPath: location.pathname }, "*");
  }

  function checkAndForward(bodyText) {
    if (typeof bodyText !== "string" || bodyText.length === 0) return;
    // Cheap pre-filter before the JSON.parse — most page responses are large
    // and irrelevant, and this runs on every single one.
    const maybeCaptions = bodyText.indexOf("subtitles") !== -1 || bodyText.indexOf("captions") !== -1;
    const maybeEpisodes = bodyText.indexOf("episode_metadata") !== -1;
    if (!maybeCaptions && !maybeEpisodes) return;
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      return; // not a JSON response — most page requests aren't
    }
    stats.jsonBodies++;
    if (maybeEpisodes) {
      try {
        checkAdjacentEpisode(data);
      } catch {}
    }
    if (!maybeCaptions) return;
    // `subtitles` is where Crunchyroll's `play` response carried translated
    // tracks when this was built; `captions` is checked as a fallback in case
    // that naming differs on some responses/regions, since neither is
    // documented and both would carry the same shape.
    const container = data.subtitles ?? data.captions;
    if (!container || typeof container !== "object") return;
    stats.subtitleShaped++;
    const found = pickEnglish(container);
    if (!found) {
      // Shape matched but no usable English entry — worth surfacing, because
      // it distinguishes "Crunchyroll changed the response" from "we never
      // saw the response", and the available locale keys say which.
      console.warn(
        "[jp-immersion] caption sniffer: found a subtitles/captions object with no usable English entry. Locales present:",
        Object.keys(container)
      );
      return;
    }
    stats.found++;
    // Stamped with the pathname this response arrived on (2026-07-27) so
    // content.js can tell a replay of the CURRENT episode's URL from a replay
    // of the previous one — the two are otherwise indistinguishable, and
    // getting them mixed up is what previously ruled replay-after-navigation
    // out entirely. See content.js's own message listener.
    found.pathname = location.pathname;
    let host = "(unparseable)";
    try {
      host = new URL(found.url).hostname;
    } catch {}
    // Logged unconditionally, not behind a debug flag: this feature failed
    // silently through an entire live-testing cycle (2026-07-26) because
    // nothing anywhere reported whether the URL had been found, and the host
    // in particular decides whether background.js will accept it at all (see
    // isTrustedCrunchyrollCdnUrl there).
    console.log(
      `[jp-immersion] caption sniffer: found ${found.locale} subtitles (format: ${found.format}) on host ${host}`
    );
    lastFound = found;
    post(found);
  }

  function post(found) {
    window.postMessage(
      {
        __jpImmersionCaptionUrl: found.url,
        __jpImmersionCaptionFormat: found.format,
        __jpImmersionCaptionPath: found.pathname ?? null,
      },
      "*"
    );
  }

  // content.js announces itself once its own message listener is live, and
  // again after every SPA navigation reset; replay whatever was already found.
  // See `lastFound` above. Whether a replayed URL is actually USED is decided
  // on the content.js side from the pathname stamp — this script deliberately
  // stays a dumb cache rather than trying to reason about navigation itself.
  //
  // Deliberately does NOT check `event.source === window` the way content.js's
  // own listener does (2026-07-26). That check is a security measure on the
  // receiving end of the URL, where it matters because the URL gets fetched
  // with extension privileges — here it would guard nothing (the only effect
  // is replaying a URL this script already found and already broadcast with a
  // "*" target origin), while risking silently breaking the whole replay if
  // `source` doesn't compare equal across the MAIN/ISOLATED world boundary.
  // Not something that can be verified outside a real browser, so not
  // something to depend on.
  window.addEventListener("message", (event) => {
    if (!event.data?.__jpImmersionContentReady) return;
    if (lastFound) post(lastFound);

  });

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    stats.fetchCalls++;
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
    stats.xhrCalls++;
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

  window.__jpImmersionSnifferStats = () => ({
    ...stats,
    lastFoundHost: lastFound ? new URL(lastFound.url).hostname : null,
  });

  // Startup marker (2026-07-26). Without it, "no sniffer output at all" is
  // ambiguous between three very different states: the extension wasn't
  // reloaded, this MAIN-world script didn't run on this page, or it ran fine
  // and simply never saw a matching response. Only the third is a bug in the
  // detection logic, and they need different fixes.
  console.log("[jp-immersion] caption sniffer installed (run __jpImmersionSnifferStats() for counts)");
})();
