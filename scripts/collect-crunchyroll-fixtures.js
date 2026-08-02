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

  function seriesIdOf(input) {
    const m = String(input ?? "").match(SERIES_ID_RE);
    return m ? m[1] : null;
  }

  async function api(path, headers = authHeaders) {
    const res = await fetch(path, { headers: headers ?? {}, credentials: "include" });
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
      await api(PROBE, headers);
      return true;
    } catch {
      return false;
    }
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

  // Last resort, and the only method that cannot be wrong: take the header off
  // one of the page's own requests. Same principle the extension's caption
  // sniffer already relies on.
  function captureFromPageTraffic(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const originalFetch = window.fetch;
      const done = (headers) => {
        window.fetch = originalFetch;
        resolve(headers);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      window.fetch = function (...args) {
        try {
          const [input, init] = args;
          const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const auth = h.get("authorization");
          if (auth) {
            clearTimeout(timer);
            const out = { Authorization: auth };
            for (const k of ["x-cr-tab-id", "x-cr-device-id"]) if (h.get(k)) out[k] = h.get(k);
            done(out);
          }
        } catch {}
        return originalFetch.apply(this, args);
      };
    });
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
        authHeaders = await captureFromPageTraffic();
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

    const ids = [...new Set((inputs ?? []).map(seriesIdOf).filter(Boolean))];
    if (!ids.length) {
      console.log("%c[cr-fixtures] no usable series ids in that input.", "color:#dc322f");
      return null;
    }

    const out = {
      capturedAt: new Date().toISOString(),
      note: "Real Crunchyroll catalogue data. Curated fields plus one raw episode per season.",
      series: {},
      errors: [],
    };
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

    console.log(
      `%c[cr-fixtures] DONE — ${Object.keys(out.series).length} series, ${nSeasons} seasons, ` +
        `${nEpisodes} episodes, ${nJsonLd} JSON-LD block(s), ${out.errors.length} error(s). ` +
        `${(json.length / 1024 / 1024).toFixed(2)} MB.`,
      "font-weight:bold;color:#268bd2"
    );
    if (out.errors.length) console.log("  errors:", out.errors);

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
