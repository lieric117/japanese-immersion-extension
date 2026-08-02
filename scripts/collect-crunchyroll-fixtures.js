// Bulk fixture collector for Crunchyroll catalogue data (2026-08-01).
//
// NOT a node script — paste this whole file into the browser console on any
// crunchyroll.com page while logged in. Everything it reads is data the logged-
// in session is already entitled to; it makes no request the site's own
// frontend doesn't.
//
// WHY THIS EXISTS: every fixture in this project has been collected one page at
// a time, by hand. That has now produced three separate rounds where a fixture
// built on an assumed shape passed offline while the real page failed. This
// walks a whole list of shows in one pass so fixtures come from measured data
// by default rather than by exception.
//
// USAGE
//   1. Log in to Crunchyroll, open any page on the site, open the console.
//   2. Paste this file. It defines `crFixtures` and prints a usage line.
//   3. Run:  await crFixtures.diagnose()
//      Reports which auth method works and whether watch-page HTML (for
//      JSON-LD) is fetchable from script. Read its output before step 4 — if
//      something is unavailable it says so rather than silently skipping.
//   4. Run:  await crFixtures.run([...series ids or URLs...])
//      Progress is logged as it goes; it downloads a JSON file at the end and
//      also leaves the result on `window.crFixtureData`.
//
// AUTH EXPIRES MID-RUN, and the walk is built around that (2026-08-01): a real
// 30-series run lost its token after roughly three series and then failed 55
// times identically. A hook keeps the page's freshest Authorization header on
// hand for the whole session, a 401 triggers one shared refresh and retries the
// request, and runs RESUME — re-running the same list keeps whatever completed
// and fetches only the rest. Leave the tab focused; background tabs throttle
// timers and the page mints new tokens more slowly when it isn't visible.
//
// INPUT FORMAT: an array of series ids ("GRGG9798R") and/or any URL containing
// one ("https://www.crunchyroll.com/series/GRGG9798R/naruto-shippuden").
// Mixed is fine; duplicates are ignored.
//
// The three endpoints used are the ones already captured live this session; the
// JSON-LD step is the uncertain one and is reported rather than assumed.

(() => {
  "use strict";

  const SERIES_ID_RE = /\b(G[A-Z0-9]{6,})\b/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Deliberately conservative. This walks a lot of pages; the point is to be a
  // well-behaved client of an API the session is already using, not to race it.
  const DELAY_MS = 350;
  const EPISODE_SAMPLE_JSONLD = 1; // watch pages fetched per season

  let authHeaders = null;
  let jsonLdAvailable = null;
  // Whatever Authorization header the PAGE last used. Kept current by a hook
  // installed for the whole session (see installAuthWatcher) — Crunchyroll's
  // tokens are short-lived, measured at under two minutes of collecting in the
  // 2026-08-01 run, so a header captured once at diagnose() time is stale long
  // before a 30-series walk finishes.
  const authState = (window.__crFixturesAuth ??= { latest: null });

  function seriesIdOf(input) {
    const m = String(input ?? "").match(SERIES_ID_RE);
    return m ? m[1] : null;
  }

  function installAuthWatcher() {
    // Installed once per tab and never removed. Bound to window-scoped state so
    // re-pasting this file reuses the existing hook instead of orphaning it.
    if (window.__crFixturesWatching) return;
    window.__crFixturesWatching = true;
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const [input, init] = args;
        const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const auth = h.get("authorization");
        // Ignore this script's own requests, or it would just echo back the
        // stale token it is trying to replace.
        if (auth && !args[2]?.__crFixturesOwn) authState.latest = auth;
      } catch {}
      return originalFetch.apply(this, args);
    };
    const originalSend = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (String(name).toLowerCase() === "authorization" && value) authState.latest = value;
      return originalSend.apply(this, arguments);
    };
  }
  installAuthWatcher();

  async function rawFetch(path, headers) {
    // Third argument marks it as ours so the watcher above skips it.
    return window.fetch(path, { headers: headers ?? {}, credentials: "include" }, { __crFixturesOwn: true });
  }

  // Retries once through a re-auth on 401. Everything in the walk goes through
  // here, so a token expiring mid-run costs one refresh rather than every
  // remaining series (the 2026-08-01 report: 55 consecutive identical 401s).
  async function api(path, headers, { allowRefresh = true } = {}) {
    const res = await rawFetch(path, headers ?? authHeaders);
    if (res.status === 401 && allowRefresh) {
      const ok = await refreshAuth();
      if (ok) return api(path, null, { allowRefresh: false });
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // ── auth discovery ────────────────────────────────────────────────────────
  // Crunchyroll's v2 API is token-authenticated and the token's storage
  // location is not documented, so this tries the plausible sources in order
  // and VERIFIES each with a real request rather than assuming one works.
  const PROBE = "/content/v2/discover/browse?n=1&locale=en-US";

  async function worksWith(headers) {
    try {
      await api(PROBE, headers, { allowRefresh: false });
      return true;
    } catch {
      return false;
    }
  }

  // Re-acquires a working token mid-run, cheapest source first, and verifies
  // each with a real request. Only prompts the user once the free options are
  // exhausted — a long walk shouldn't need babysitting for something the page
  // refreshes on its own.
  let refreshing = null;
  function refreshAuth() {
    // Concurrent 401s share one refresh instead of stampeding.
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const current = authHeaders?.Authorization ?? null;

      // 1. The page may have refreshed its own token since we started.
      if (authState.latest && authState.latest !== current && (await worksWith({ Authorization: authState.latest }))) {
        authHeaders = { ...authHeaders, Authorization: authState.latest };
        console.log("%c  [auth] refreshed from the page's own traffic. ✔", "color:#859900");
        return true;
      }
      // 2. Storage may hold a newer one even if it didn't hold a usable one at
      //    diagnose() time — the key can rotate.
      for (const c of candidateTokens()) {
        const header = `Bearer ${c.token}`;
        if (header === current) continue;
        if (await worksWith({ Authorization: header })) {
          authHeaders = { ...authHeaders, Authorization: header };
          console.log(`%c  [auth] refreshed from storage key "${c.key}". ✔`, "color:#859900");
          return true;
        }
      }
      // 3. Wait for the page to mint a new one. It does this on its own
      //    schedule; interacting with the page just makes it happen sooner.
      console.log(
        "%c  [auth] token expired and no fresh one is available yet. Waiting up to 120s.\n" +
          "         To speed this up, interact with the page WITHOUT navigating away —\n" +
          "         scroll a carousel, open the profile menu, hover a shelf. Do NOT click a\n" +
          "         link that reloads the page, which would kill this script mid-run.",
        "color:#b58900"
      );
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await sleep(2000);
        if (authState.latest && authState.latest !== current && (await worksWith({ Authorization: authState.latest }))) {
          authHeaders = { ...authHeaders, Authorization: authState.latest };
          console.log("%c  [auth] recovered. ✔ resuming.", "color:#859900");
          return true;
        }
        for (const c of candidateTokens()) {
          const header = `Bearer ${c.token}`;
          if (header !== current && (await worksWith({ Authorization: header }))) {
            authHeaders = { ...authHeaders, Authorization: header };
            console.log("%c  [auth] recovered from storage. ✔ resuming.", "color:#859900");
            return true;
          }
        }
      }
      console.log("%c  [auth] gave up waiting. Remaining series will fail; re-run to resume.", "color:#dc322f");
      return false;
    })();
    const p = refreshing;
    p.finally(() => {
      if (refreshing === p) refreshing = null;
    });
    return p;
  }

  function looksLikeJwt(v) {
    return typeof v === "string" && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v.trim());
  }

  function* candidateTokens() {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const raw = store.getItem(key);
        if (!raw) continue;
        if (looksLikeJwt(raw)) yield { key, token: raw.trim() };
        try {
          const parsed = JSON.parse(raw);
          for (const field of ["access_token", "accessToken", "token", "jwt"]) {
            if (looksLikeJwt(parsed?.[field])) yield { key: `${key}.${field}`, token: parsed[field] };
          }
        } catch {}
      }
    }
  }

  async function diagnose() {
    console.log("%c[cr-fixtures] diagnosing…", "font-weight:bold");

    if (await worksWith({})) {
      authHeaders = {};
      console.log("  auth: session cookies alone are enough (no token needed).");
    } else {
      let found = null;
      for (const c of candidateTokens()) {
        if (await worksWith({ Authorization: `Bearer ${c.token}` })) {
          found = c;
          break;
        }
      }
      if (found) {
        authHeaders = { Authorization: `Bearer ${found.token}` };
        console.log(`  auth: bearer token found in storage key "${found.key}".`);
      } else {
        console.log(
          "%c  auth: no stored token worked. Falling back to reading the header off the page's own\n" +
            "        traffic — please CLICK SOMETHING on the page now (a show, a menu, anything that\n" +
            "        loads data). Waiting up to 20s…",
          "color:#b58900"
        );
        const deadline = Date.now() + 20000;
        while (!authHeaders && Date.now() < deadline) {
          await sleep(1000);
          if (authState.latest && (await worksWith({ Authorization: authState.latest }))) {
            authHeaders = { Authorization: authState.latest };
          }
        }
        if (authHeaders) console.log("  auth: captured from the page's own request. ✔");
        else {
          console.log("%c  auth: FAILED — nothing captured. Nothing else will work; stop here.", "color:#dc322f");
          return { auth: false };
        }
      }
    }

    // JSON-LD comes from the watch page's HTML, not from an API. Fetching that
    // from script MAY be served the same "unsupported browser" shell that
    // non-browser requests get; this checks rather than assuming either way.
    try {
      const probe = await fetch(location.href, { credentials: "include" });
      const html = await probe.text();
      jsonLdAvailable = html.includes("application/ld+json");
      console.log(
        jsonLdAvailable
          ? "  json-ld: watch-page HTML is fetchable from script — JSON-LD will be collected. ✔"
          : "%c  json-ld: page HTML fetched but carries no ld+json (likely a JS-rendered shell).\n" +
              "           Everything else still works; JSON-LD stays a manual, per-page capture.",
        jsonLdAvailable ? "" : "color:#b58900"
      );
    } catch (e) {
      jsonLdAvailable = false;
      console.log(`%c  json-ld: page fetch failed (${e.message}). Skipping JSON-LD.`, "color:#b58900");
    }

    console.log("[cr-fixtures] ready. Run: await crFixtures.run([...series ids or URLs...])");
    return { auth: true, jsonLd: jsonLdAvailable };
  }

  // ── collection ────────────────────────────────────────────────────────────
  // Fields are curated rather than raw — a 500-episode series would otherwise
  // produce a file too large to work with. One FULL raw object per season is
  // kept as `rawEpisodeSample` so the actual shape stays inspectable, which is
  // the thing that has repeatedly been guessed wrong.
  const seasonFields = [
    "id", "title", "slug_title", "season_number", "number_of_episodes",
    "is_subbed", "is_dubbed", "series_id",
  ];
  const episodeFields = [
    "id", "title", "slug_title", "episode", "episode_number", "sequence_number",
    "season_id", "season_number", "season_title", "series_id", "series_title",
    "duration_ms", "is_subbed", "is_dubbed",
  ];
  const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in (obj ?? {})).map((f) => [f, obj[f]]));

  async function fetchJsonLd(episodeId, slug) {
    if (!jsonLdAvailable) return null;
    try {
      const url = `/watch/${episodeId}/${slug ?? ""}`;
      const res = await fetch(url, { credentials: "include" });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const tag of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(tag.textContent);
          if (data?.["@type"] === "TVEpisode") return data;
        } catch {}
      }
      return null;
    } catch {
      return null;
    }
  }

  async function fetchAdjacent(episodeId) {
    // The shape the extension's sibling capture depends on. Collected for one
    // episode per series so its real nesting is on record too.
    const out = {};
    for (const which of ["previous_episode", "next_episode"]) {
      try {
        out[which] = await api(`/content/v2/discover/${which}/${episodeId}?locale=en-US`);
      } catch (e) {
        out[which] = { error: e.message };
      }
      await sleep(DELAY_MS);
    }
    return out;
  }

  async function run(inputs, options = {}) {
    if (!authHeaders) {
      const d = await diagnose();
      if (!d.auth) return null;
    }
    const { jsonLdPerSeason = EPISODE_SAMPLE_JSONLD, adjacentPerSeries = true } = options;

    const allIds = [...new Set((inputs ?? []).map(seriesIdOf).filter(Boolean))];
    if (!allIds.length) {
      console.log("%c[cr-fixtures] no usable series ids in that input.", "color:#dc322f");
      return null;
    }

    // Resumable by default: a re-run with the same list keeps whatever the
    // previous attempt completed and only fetches what's missing. Token expiry
    // then costs the remainder of one run rather than the whole walk.
    const previous = options.resume ?? window.crFixtureData ?? null;
    const out = {
      capturedAt: new Date().toISOString(),
      note: "Real Crunchyroll catalogue data. Curated fields plus one raw episode per season.",
      series: { ...(previous?.series ?? {}) },
      errors: [],
    };
    const ids = allIds.filter((id) => !out.series[id]);
    const carried = allIds.length - ids.length;
    if (carried) {
      console.log(`%c[cr-fixtures] resuming — ${carried} series already collected, ${ids.length} to go.`, "color:#268bd2");
    }
    if (!ids.length) {
      console.log("%c[cr-fixtures] everything on this list is already collected. Nothing to do.", "color:#859900");
      window.crFixtureData = out;
      return out;
    }
    let nSeasons = 0;
    let nEpisodes = 0;
    let nJsonLd = 0;

    console.log(`%c[cr-fixtures] walking ${ids.length} series…`, "font-weight:bold");

    for (const [i, seriesId] of ids.entries()) {
      try {
        const seasonsRes = await api(
          `/content/v2/cms/series/${seriesId}/seasons?force_locale=ja-JP&locale=en-US`
        );
        await sleep(DELAY_MS);
        const seasons = seasonsRes?.data ?? [];
        // The seasons response doesn't carry the series title; the episodes
        // below do, so it's backfilled once one arrives.
        const entry = { seriesId, seriesTitle: seasons[0]?.series_title ?? null, seasons: [] };

        for (const season of seasons) {
          const seasonOut = { ...pick(season, seasonFields), episodes: [], rawEpisodeSample: null, jsonLd: [] };
          try {
            const epRes = await api(
              `/content/v2/cms/seasons/${season.id}/episodes?preferred_audio_language=ja-JP&locale=en-US`
            );
            await sleep(DELAY_MS);
            const eps = epRes?.data ?? [];
            seasonOut.episodes = eps.map((e) => pick(e, episodeFields));
            seasonOut.rawEpisodeSample = eps[0] ?? null;
            if (!entry.seriesTitle && eps[0]?.series_title) entry.seriesTitle = eps[0].series_title;
            nEpisodes += eps.length;

            for (const ep of eps.slice(0, jsonLdPerSeason)) {
              const ld = await fetchJsonLd(ep.id, ep.slug_title);
              await sleep(DELAY_MS);
              if (ld) {
                nJsonLd++;
                seasonOut.jsonLd.push({ episodeId: ep.id, data: ld });
              }
            }
          } catch (e) {
            seasonOut.error = e.message;
            out.errors.push({ seriesId, seasonId: season.id, error: e.message });
          }
          entry.seasons.push(seasonOut);
          nSeasons++;
        }

        if (adjacentPerSeries) {
          const anyEp = entry.seasons.flatMap((s) => s.episodes).find((e) => e?.id);
          if (anyEp) entry.adjacentSample = { episodeId: anyEp.id, ...(await fetchAdjacent(anyEp.id)) };
        }

        out.series[seriesId] = entry;
        window.crFixtureData = out; // live, so a crash or expiry still leaves progress
        console.log(
          `  [${i + 1}/${ids.length}] ${entry.seriesTitle ?? seriesId}: ` +
            `${entry.seasons.length} season(s), ${entry.seasons.reduce((n, s) => n + s.episodes.length, 0)} episode(s)`
        );
      } catch (e) {
        out.errors.push({ seriesId, error: e.message });
        console.log(`%c  [${i + 1}/${ids.length}] ${seriesId}: FAILED — ${e.message}`, "color:#dc322f");
      }
    }

    window.crFixtureData = out;
    const json = JSON.stringify(out, null, 1);
    const failedIds = [...new Set(out.errors.filter((e) => e.seriesId && !out.series[e.seriesId]).map((e) => e.seriesId))];

    console.log(
      `%c[cr-fixtures] DONE — ${Object.keys(out.series).length} series, ${nSeasons} seasons, ` +
        `${nEpisodes} episodes, ${nJsonLd} JSON-LD block(s), ${out.errors.length} error(s). ` +
        `${(json.length / 1024 / 1024).toFixed(2)} MB.`,
      "font-weight:bold;color:#268bd2"
    );
    if (out.errors.length) console.log("  errors:", out.errors);
    if (failedIds.length) {
      console.log(
        `%c  ${failedIds.length} series did not collect. Re-run to resume — completed ones are skipped:\n` +
          `  await crFixtures.run(${JSON.stringify(failedIds)})`,
        "color:#b58900"
      );
    }

    // Downloaded rather than copied: this is routinely several MB, which the
    // console's own copy() truncates without saying so.
    try {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `crunchyroll-fixtures-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      console.log("  downloaded as a .json file. Also on window.crFixtureData.");
    } catch (e) {
      console.log(`  download failed (${e.message}) — it's on window.crFixtureData; use copy(JSON.stringify(crFixtureData)).`);
    }
    return out;
  }

  window.crFixtures = { diagnose, run, seriesIdOf };
  console.log(
    "%c[cr-fixtures] loaded. Start with:  await crFixtures.diagnose()",
    "font-weight:bold;color:#268bd2"
  );
})();
