// Subtitle responses are bound to the episode they were requested for
// (2026-09-18 audit, root cause RC-D1). Runs content.js's REAL
// beginSubtitleRequest / subtitleRequestIsCurrent / installCues against a
// stubbed page whose URL and JSON-LD the test moves around — the SPA-navigation
// race that let one episode's subtitles land on another.
//
// Usage:  node scripts/test-subtitle-binding.js

"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const grab = (re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — renamed?`);
  return m[0];
};

const page = { pathname: "/watch/A/ep1", detected: null };
const installed = [];
const make = new Function(
  "page",
  "installed",
  `
  const location = { get pathname() { return page.pathname; } };
  const detectShowEpisode = () => page.detected;
  const console = { log() {} };
  let cues = null, lastText = null, currentShowEpisode = null;
  const setActiveSubtitleFile = (name) => installed.push(name);
  ${grab(/^function episodeIdentity\([\s\S]*?\n\}/m, "episodeIdentity")}
  ${grab(/^let subtitleRequestSeq = 0;[\s\S]*?\n\}\nfunction subtitleRequestIsCurrent\([\s\S]*?\n\}/m, "request helpers")}
  ${grab(/^function installCues\([\s\S]*?\n\}/m, "installCues")}
  ${grab(/^function detectionIsStale\([\s\S]*?\n\}/m, "detectionIsStale")}
  return { beginSubtitleRequest, installCues, detectionIsStale, episodeIdentity, bump: () => ++subtitleRequestSeq, state: () => ({ cues, currentShowEpisode }) };
`
);
const h = make(page, installed);

let failed = 0;
const check = (label, cond) => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
};
// content.js's own key, not a copy of it — so the checks below can't drift
// from the real one.
const episodeIdentityOf = (d) => h.episodeIdentity(d);
const ep = (n) => ({ seriesTitle: "S", seasonName: "Season 1", seasonNumber: 1, episodeNumber: n, episodeTitle: `Season 1 | E${n} - T${n}` });

// 1. ordinary load
page.detected = ep(1);
const r1 = h.beginSubtitleRequest(ep(1));
check("a response for the episode on screen is installed", h.installCues(r1, ["ep1"], "f1") && h.state().cues[0] === "ep1");
check("…and labels the Anki source with that episode", h.state().currentShowEpisode.episodeNumber === 1);

// 2. the race: ep1's load in flight, user navigates to ep2, ep2 loads, ep1 answers LAST
const slow = h.beginSubtitleRequest(ep(1));
page.pathname = "/watch/B/ep2";
page.detected = ep(2);
const fast = h.beginSubtitleRequest(ep(2));
check("the newer episode's response is installed", h.installCues(fast, ["ep2"], "f2"));
check("the older episode's LATE response is discarded", !h.installCues(slow, ["ep1-late"], "f1") && h.state().cues[0] === "ep2");

// 3. navigated but no new load started yet (e.g. JSON-LD still settling)
const pending = h.beginSubtitleRequest(ep(2));
page.pathname = "/watch/C/ep3";
check("a response is discarded once the URL has moved on", !h.installCues(pending, ["x"], "f"));

// 4. same URL, JSON-LD now reports a different episode (a stale block was read at request time)
page.detected = ep(3);
const staleReq = h.beginSubtitleRequest(ep(2));
check("a response for an identity the page no longer reports is discarded", !h.installCues(staleReq, ["x"], "f"));

// 5. a newer request supersedes an older one even on the same page (manual pick vs auto load)
const auto = h.beginSubtitleRequest(ep(3));
const pick = h.beginSubtitleRequest(ep(3));
check("a manual pick supersedes an automatic load still in flight", h.installCues(pick, ["picked"], "p") && !h.installCues(auto, ["auto"], "a") && h.state().cues[0] === "picked");

// 6. two episodes that collided under the OLD identity key are told apart
const a = { seriesTitle: "Shangri-La Frontier", seasonName: "Season 1", seasonNumber: 1, episodeNumber: 15, episodeTitle: "Season 1 | E15 - Fifteen" };
const b = { ...a, episodeTitle: "Season 1 | E14.5 - Special Bonus Episode" };
page.detected = b;
check("episodes sharing series/season/number are still distinct requests", !h.installCues(h.beginSubtitleRequest(a), ["x"], "f"));

// 7. the stale gate loadSubtitles uses after SPA navigation (2026-09-20)
const loaded = ep(5);
const same = { ...ep(5) };
check("on a fresh load nothing is ever treated as stale", !h.detectionIsStale(same, false, episodeIdentityOf(loaded)));
check("after navigation, a block still reporting the loaded episode is stale", h.detectionIsStale(same, true, episodeIdentityOf(loaded)));
check("…unless its own URL names this page — then it's a URL rewrite, load now", !h.detectionIsStale({ ...same, urlConfirmed: true }, true, episodeIdentityOf(loaded)));
check("a block reporting a different episode is never stale", !h.detectionIsStale(ep(6), true, episodeIdentityOf(loaded)));
check("no detection at all is not 'stale' (it's 'nothing yet')", !h.detectionIsStale(null, true, episodeIdentityOf(loaded)));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
