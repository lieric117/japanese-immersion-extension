// Offline test for caption-url-sniffer.js's sibling-episode detection.
//
// Usage:  node scripts/test-sibling-sniffer.js
//
// Runs the real MAIN-world script in a `vm` sandbox with a fake `window`,
// pushes a response body through the fetch wrapper it installs, and asserts on
// what it posts back. That path — page response in, postMessage out — is the
// whole contract with content.js, and none of it is reachable from the
// resolver's own suite.
//
// This file exists because the sibling-title feature has now had its input
// shape guessed wrong twice: first a batched "episodes in this season"
// response that does not exist at all, then a flat `season_title`/
// `episode_number` shape that belongs to a different endpoint. The payload
// below is the REAL captured response from Frozen Bond's page (2026-08-01),
// pasted verbatim rather than described.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "caption-url-sniffer.js"), "utf8");

// Verbatim from `GET /content/v2/discover/previous_episode/GR3KQQ7QR?locale=en-US`
// on Re:Zero's "The Frozen Bond" page. Trimmed only by the `...` the capture
// itself elided; every field the detector reads is present and unedited.
const PREVIOUS_EPISODE = {
  data: [
    {
      playhead: 1486,
      fully_watched: false,
      panel: {
        title: "Memory Snow (Director's Cut)",
        episode_metadata: {
          episode: "EX",
          episode_number: 1,
          season_id: "GYVDVV35Y",
          season_number: 2,
          season_title: "OVAs",
          series_id: "GRGG9798R",
          series_title: "Re:ZERO -Starting Life in Another World-",
        },
      },
    },
  ],
};

// The `play` response the sniffer already handled, kept here as a regression
// guard: adding sibling detection must not stop captions being found.
const PLAY_RESPONSE = {
  subtitles: { "en-US": { url: "https://cdn.crunchyroll.com/x.ass", format: "ass" } },
};

function runSniffer() {
  const posts = [];
  const logs = [];
  let pendingBody = null;

  const win = {
    addEventListener: () => {},
    postMessage: (msg) => posts.push(msg),
    fetch: async () => ({
      clone: () => ({ text: async () => pendingBody }),
    }),
  };
  win.window = win;

  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};

  const sandbox = {
    window: win,
    location: { pathname: "/watch/GABC123/frozen-bond" },
    console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) },
    XMLHttpRequest: FakeXHR,
    URL,
    JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "caption-url-sniffer.js" });

  return {
    posts,
    logs,
    stats: () => win.__jpImmersionSnifferStats(),
    // Drives a response through the wrapper the script installed over fetch.
    async deliver(body) {
      pendingBody = typeof body === "string" ? body : JSON.stringify(body);
      await win.fetch("https://beta-api.crunchyroll.com/whatever");
      // The wrapper reads the body in a detached promise chain, so let the
      // microtask queue drain before asserting.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const cases = [
  {
    why: "the real previous_episode response yields one sibling, with its season identifiers",
    async run(s) {
      await s.deliver(PREVIOUS_EPISODE);
      const post = s.posts.find((p) => p.__jpImmersionSiblingEpisodes);
      if (!post) return "nothing was posted for the sibling episode";
      const got = post.__jpImmersionSiblingEpisodes;
      if (got.length !== 1) return `${got.length} siblings, want 1`;
      const [sib] = got;
      if (sib.title !== "Memory Snow (Director's Cut)") return `title ${JSON.stringify(sib.title)}`;
      if (sib.seasonId !== "GYVDVV35Y") return `seasonId ${JSON.stringify(sib.seasonId)}`;
      if (sib.seasonTitle !== "OVAs") return `seasonTitle ${JSON.stringify(sib.seasonTitle)}`;
      if (sib.seriesTitle !== "Re:ZERO -Starting Life in Another World-") return `seriesTitle ${JSON.stringify(sib.seriesTitle)}`;
      if (post.__jpImmersionSiblingPath !== "/watch/GABC123/frozen-bond") return "pathname stamp missing";
      return null;
    },
  },
  {
    why: "the title is reported unmodified — the qualifier is stripped downstream, not here",
    async run(s) {
      await s.deliver(PREVIOUS_EPISODE);
      const sib = s.posts.find((p) => p.__jpImmersionSiblingEpisodes)?.__jpImmersionSiblingEpisodes?.[0];
      // background.js needs the raw title AND derives its own variants; losing
      // "(Director's Cut)" here would silently change what can be matched.
      return sib?.title.includes("(Director's Cut)") ? null : "the qualifier was stripped in the sniffer";
    },
  },
  {
    why: "a next_episode response in the same shape works identically",
    async run(s) {
      const next = JSON.parse(JSON.stringify(PREVIOUS_EPISODE));
      next.data[0].panel.title = "The Frozen Bond (Director's Cut)";
      next.data[0].panel.episode_metadata.episode_number = 2;
      await s.deliver(next);
      const sib = s.posts.find((p) => p.__jpImmersionSiblingEpisodes)?.__jpImmersionSiblingEpisodes?.[0];
      return sib?.title === "The Frozen Bond (Director's Cut)" ? null : "next_episode shape not handled";
    },
  },
  {
    why: "an episode_metadata block with no season_id is ignored, not half-accepted",
    async run(s) {
      const broken = JSON.parse(JSON.stringify(PREVIOUS_EPISODE));
      delete broken.data[0].panel.episode_metadata.season_id;
      await s.deliver(broken);
      return s.posts.some((p) => p.__jpImmersionSiblingEpisodes) ? "posted a sibling with no season id" : null;
    },
  },
  {
    why: "an unrelated JSON response posts nothing and does not throw",
    async run(s) {
      await s.deliver({ data: [{ some: "thing" }], episode_metadata: "decoy string" });
      return s.posts.some((p) => p.__jpImmersionSiblingEpisodes) ? "posted a sibling for an unrelated body" : null;
    },
  },
  {
    why: "a non-JSON body is ignored (most page responses aren't JSON)",
    async run(s) {
      await s.deliver("<!doctype html><html>episode_metadata</html>");
      return s.posts.some((p) => p.__jpImmersionSiblingEpisodes) ? "posted a sibling for an HTML body" : null;
    },
  },
  {
    why: "REGRESSION: the caption URL is still found alongside the new detection",
    async run(s) {
      await s.deliver(PREVIOUS_EPISODE);
      await s.deliver(PLAY_RESPONSE);
      const cap = s.posts.find((p) => p.__jpImmersionCaptionUrl);
      if (!cap) return "the play response no longer yields a caption URL";
      return s.stats().found === 1 ? null : `stats.found = ${s.stats().found}`;
    },
  },
  {
    why: "the stats counter reports siblings seen, so a live session can tell 'not firing' from 'not present'",
    async run(s) {
      await s.deliver(PREVIOUS_EPISODE);
      return s.stats().siblingEpisodesSeen === 1 ? null : `siblingEpisodesSeen = ${s.stats().siblingEpisodesSeen}`;
    },
  },
];

(async () => {
  let failed = 0;
  for (const c of cases) {
    const s = runSniffer();
    let problem;
    try {
      problem = await c.run(s);
    } catch (e) {
      problem = `threw: ${e.message}`;
    }
    if (problem) failed++;
    console.log(`${problem ? "FAIL" : "PASS"}  ${c.why}`);
    if (problem) console.log(`        ${problem}`);
  }
  console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nall ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
