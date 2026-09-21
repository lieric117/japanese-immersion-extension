// What loadSubtitles does when the stale-detection retries run out
// (2026-09-20). The rule being pinned: **the retry path never falls back to a
// stale block.** Either the page's own TVEpisode block confirms the episode, or
// nothing is loaded — no FETCH_SUBTITLES, no cues, and `lastLoadedIdentity`
// left alone so the watchdog still repairs it when the block settles.
//
// Runs content.js's REAL loadSubtitles in a sandbox: the DOM, chrome.* and the
// switcher are stubbed, and setTimeout runs the retry immediately so the whole
// 5-second budget is exercised in one tick.
//
// Usage:  node scripts/test-stale-timeout.js

"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const grab = (re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — renamed?`);
  return m[0];
};

// One scenario = one fresh sandbox, since loadSubtitles mutates module state.
function run({ detected, expectChange, lastLoaded }) {
  const log = { sent: [], timers: 0, warnings: [] };
  const box = { style: {}, textContent: "" };
  const make = new Function(
    "log",
    "box",
    "page",
    `
    const location = { get pathname() { return page.pathname; } };
    const detectShowEpisode = () => page.detected;
    const console = { log() {}, warn: (...a) => log.warnings.push(a.join(" ")) };
    const chrome = {
      storage: { local: { get: (keys, cb) => cb({}) } },
      runtime: { sendMessage: (msg) => log.sent.push(msg) },
    };
    const setTimeout = (fn) => { log.timers++; fn(); };
    const renderSwitcherOptions = () => {};
    const setActiveSubtitleFile = () => {};
    const uploaderPrefKey = () => "u";
    const siblingCacheKey = () => "s";
    const entryPrefKey = () => "e";
    const FILE_HINT = "[JPN]";
    let seasonEpisodeTitles = [];
    let cues = null, lastText = null, currentShowEpisode = null, subtitleLoadPending = false;
    let lastLoadedIdentity = page.lastLoaded;
    ${grab(/^function episodeIdentity\([\s\S]*?\n\}/m, "episodeIdentity")}
    ${grab(/^let subtitleRequestSeq = 0;[\s\S]*?\n\}\nfunction subtitleRequestIsCurrent\([\s\S]*?\n\}/m, "request helpers")}
    ${grab(/^function installCues\([\s\S]*?\n\}/m, "installCues")}
    ${grab(/^function detectionIsStale\([\s\S]*?\n\}/m, "detectionIsStale")}
    ${grab(/^const STALE_DETECTION_RETRIES = \d+;/m, "STALE_DETECTION_RETRIES")}
    ${grab(/^function loadSubtitles\([\s\S]*?\n\}/m, "loadSubtitles")}
    return (b, e) => {
      loadSubtitles(b, null, null, e);
      return { cues, lastLoadedIdentity, retries: log.timers };
    };
  `
  );
  const page = { pathname: "/watch/NEW/ep2", detected, lastLoaded };
  const state = make(log, box, page)(box, expectChange);
  return { ...state, sent: log.sent, warnings: log.warnings, text: box.textContent };
}

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};

const ep = (n, urlConfirmed = null) => ({
  seriesTitle: "S",
  seasonName: "Season 1",
  seasonNumber: 1,
  episodeNumber: n,
  episodeTitle: `Season 1 | E${n} - T${n}`,
  urlConfirmed,
});
const idOf = (d) => [d.seriesTitle, d.seasonName, d.seasonNumber, d.episodeNumber, d.episodeTitle].join(" ‖ ");

// 1. The block never stops reporting the loaded episode, and carries no URL to
//    settle it: the whole retry budget runs, then NOTHING loads.
let r = run({ detected: ep(1), expectChange: true, lastLoaded: idOf(ep(1)) });
check("a stale block exhausts the retries", r.retries === 10, `retries=${r.retries}`);
check("…and then no subtitle request is sent at all", r.sent.length === 0, JSON.stringify(r.sent));
check("…and no cues are installed", r.cues === null);
check("…and the box says why, pointing at upload", /not loading subtitles/.test(r.text) && /Upload subtitle file/.test(r.text), r.text);
check("…and warns with the identity it refused", r.warnings.some((w) => /loading nothing/.test(w)), r.warnings.join("|"));
check(
  "…and leaves lastLoadedIdentity alone, so the watchdog still repairs it",
  r.lastLoadedIdentity === idOf(ep(1)),
  String(r.lastLoadedIdentity)
);

// 2. No block at all for the whole budget: same outcome by the other branch.
r = run({ detected: null, expectChange: true, lastLoaded: idOf(ep(1)) });
check("no block at all also loads nothing", r.retries === 10 && r.sent.length === 0 && r.cues === null);
check("…with the couldn't-detect message", /Couldn't detect the show\/episode/.test(r.text), r.text);

// 3. The page's own block, naming a NEW episode: loads at once, no retries.
r = run({ detected: ep(2), expectChange: true, lastLoaded: idOf(ep(1)) });
check("a new episode loads immediately", r.retries === 0 && r.sent.length === 1, `retries=${r.retries} sent=${r.sent.length}`);
check("…and is recorded as loaded", r.lastLoadedIdentity === idOf(ep(2)));

// 4. A URL rewrite: same episode, but the block's own URL names THIS page.
//    That is the case the 5s wait could never tell from late metadata.
r = run({ detected: ep(1, true), expectChange: true, lastLoaded: idOf(ep(1)) });
check("a URL-confirmed block loads with no wait even on the same episode", r.retries === 0 && r.sent.length === 1, `retries=${r.retries}`);

// 5. An ordinary first load (no navigation): never treated as stale.
r = run({ detected: ep(1), expectChange: false, lastLoaded: idOf(ep(1)) });
check("a first load with no navigation is not stale", r.retries === 0 && r.sent.length === 1);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
