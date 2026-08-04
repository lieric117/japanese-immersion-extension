// Sweeps a catalogue capture through the REAL resolver against the LIVE Jimaku
// API, and reports which seasons resolve to the wrong entry.
//
// Usage:  node scripts/sweep-resolution.js <collected.json> [--limit N] [--series "substring"]
//
// WHY THIS EXISTS, stated plainly: `analyze-crunchyroll-fixtures.js` does NOT
// test resolution. It checks season-title classification, numbering
// conventions and field shapes — useful, but it never calls resolveTextFiles
// and never contacts Jimaku. Its "zero misses" result was read as "these shows
// resolve correctly", which it never meant. Tokyo Ghoul, My Dress-Up Darling
// and Slimes 300 Years were all loading season 1's subtitles for later seasons
// while that result stood (reported 2026-08-02).
//
// This runs the real thing: for every season in the capture it calls
// `resolveTextFiles` with the season's own metadata and live Jimaku responses,
// then asks whether the entry it picked plausibly IS that season.
//
// The verdicts are deliberately coarse, because the only fully reliable check
// is a human reading subtitles:
//   OK        the resolved entry's name accounts for the season's own name
//   SUSPECT   resolved confidently to an entry that does NOT account for it —
//             the silent-wrong-subtitles shape, and the one worth reading
//   ASKS      resolved unconfidently or not at all; the picker would appear
//   ERROR     threw (no entry, no files, archives only)
//
// SUSPECT is the signal. A season named "Root A" resolving to the entry named
// after the bare franchise is exactly what this is for.
//
// TWO THINGS TO KNOW BEFORE READING THE OUTPUT:
//
//   - SUSPECT is a READING LIST, not a verdict. Shows whose Jimaku entry
//     legitimately covers every season produce SUSPECT on every one of them —
//     One Piece has a single "ONE PIECE" entry for all 24 arc seasons, and
//     resolving each to it is correct. The heuristic cannot tell that apart
//     from Tokyo Ghoul's "Root A" landing on season 1's entry, which is a bug.
//     A human has to look.
//
//   - DON'T RUN THIS ALONGSIDE THE OTHER LIVE TESTS. It saturates Jimaku's
//     rate limit for minutes at a time; `test-render-pipeline.js` and
//     `test-merged-audio-span.js --live` will fail with confusing errors while
//     it runs, and those failures are contention, not regressions.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
  console.error('usage: node scripts/sweep-resolution.js <collected.json> [--limit N] [--series "substring"]');
  process.exit(2);
}
const limit = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const seriesFilter = args.includes("--series") ? args[args.indexOf("--series") + 1].toLowerCase() : null;

const KEY = process.env.JIMAKU_API_KEY;
if (!KEY) {
  console.error("JIMAKU_API_KEY is not set (it lives in ~/.zshenv).");
  process.exit(2);
}

// ── sandbox: the real background.js, with fetch pointed at the live API ──────
const logs = [];
// Every Jimaku request in the whole sweep goes through one throttle. The
// resolver makes 2-4 per season, so pacing seasons alone still bursts and
// Jimaku answers 429 — which the resolver then reports as a hard error and the
// sweep would score as a resolution failure. Spaced, plus backoff on 429, so a
// rate limit never masquerades as a finding.
const REQUEST_SPACING_MS = 700;
let lastRequest = 0;
async function throttledFetch(url, init) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, lastRequest + REQUEST_SPACING_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await globalThis.fetch(url, init);
    if (res.status !== 429 || attempt >= 4) return res;
    const backoff = 2000 * Math.pow(2, attempt);
    process.stdout.write(`   (429 — waiting ${backoff / 1000}s)\n`);
    await new Promise((r) => setTimeout(r, backoff));
  }
}

const sandbox = {
  console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push("WARN " + a.join(" ")), error() {} },
  fetch: (...a) => throttledFetch(...a),
  importScripts: () => {},
  chrome: {
    runtime: { onMessage: { addListener: () => {} }, getURL: (s) => s },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  setTimeout,
  clearTimeout,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8") +
    ";this.__resolve = resolveTextFiles; this.__loose = looseTitle;",
  sandbox,
  { filename: "background.js" }
);
const resolveTextFiles = sandbox.__resolve;
const looseTitle = sandbox.__loose;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(fs.readFileSync(input, "utf8"));

// Does the resolved entry account for the season we asked for? Deliberately
// generous — the aim is to surface the season that resolved to something with
// NOTHING of its own name in it, not to grade wording.
function entryAccountsForSeason(entryName, seasonTitle, seriesTitle) {
  const entry = looseTitle(entryName);
  const season = looseTitle(seasonTitle);
  const series = looseTitle(seriesTitle);
  if (!entry || !season) return true;
  if (entry.includes(season) || season.includes(entry)) return true;
  // The distinguishing part of the season name: what it adds beyond the series
  // title. If the entry carries any of those words, call it accounted for.
  // Words that carry no identity: they appear in season names everywhere and a
  // Jimaku entry has no reason to repeat them. Without this, "Season 1" reads
  // as distinguishing (it adds "season" and "1") and every first season is
  // flagged — noise that buries the real ones.
  const NOISE = new Set([
    "season", "part", "cour", "english", "dub", "dubbed", "sub", "subtitled",
    "hd", "edition", "the", "a", "of", "and", "movies", "movie",
  ]);
  const seriesWords = new Set(series.split(" "));
  const extra = season
    .split(" ")
    .filter((w) => w && !seriesWords.has(w) && !NOISE.has(w) && !/^\d+$/.test(w));
  if (!extra.length) return true; // season name adds nothing; nothing to check
  return extra.some((w) => entry.includes(w));
}

(async () => {
  const rows = [];
  let n = 0;
  for (const series of Object.values(data.series ?? {})) {
    const seriesTitle = series.seriesTitle ?? series.seriesId;
    if (seriesFilter && !String(seriesTitle).toLowerCase().includes(seriesFilter)) continue;
    for (const season of series.seasons ?? []) {
      if (n >= limit) break;
      const eps = season.episodes ?? [];
      if (!eps.length) continue;
      n++;
      const ep = eps[0];
      const episodeNumber = Number.isInteger(ep.episode_number) ? ep.episode_number : 1;
      // Reconstructed in the shape measured on real pages. Flagged as a
      // reconstruction: the capture has no JSON-LD, so this is the one input
      // here that is not verbatim.
      const compoundName = `${season.title} | E${ep.episode ?? episodeNumber} - ${ep.title ?? ""}`;
      logs.length = 0;
      let verdict;
      let detail = "";
      try {
        const r = await resolveTextFiles(
          seriesTitle,
          episodeNumber,
          { Authorization: KEY },
          Number.isInteger(season.season_number) ? season.season_number : null,
          season.title,
          compoundName,
          []
        );
        if (r.unresolved) {
          verdict = "ASKS";
          detail = "no entry identified";
        } else {
          const ok = entryAccountsForSeason(r.entryName, season.title, seriesTitle);
          verdict = r.confident ? (ok ? "OK" : "SUSPECT") : "ASKS";
          detail = `${r.entryName} (id ${r.entryId}), ${r.textFiles.length} file(s)`;
        }
      } catch (e) {
        verdict = "ERROR";
        detail = e.message;
      }
      const matchedBy = (logs.find((l) => l.includes("— matched by ")) ?? "").split("— matched by ")[1] ?? "";
      rows.push({ seriesTitle, season: season.title, seasonNumber: season.season_number, verdict, detail, matchedBy: matchedBy.replace(/\.$/, "") });
      const mark = { OK: " ", SUSPECT: "!", ASKS: "?", ERROR: "x" }[verdict];
      console.log(
        `${mark} ${verdict.padEnd(8)} ${String(seriesTitle).slice(0, 28).padEnd(28)} S${String(season.seasonNumber ?? season.season_number).padEnd(3)} ${String(season.title).slice(0, 40).padEnd(40)} -> ${detail.slice(0, 60)}`
      );
      await sleep(50);
    }
  }

  const by = (v) => rows.filter((r) => r.verdict === v);
  console.log(`\n${"─".repeat(78)}`);
  console.log(`swept ${rows.length} seasons:  OK ${by("OK").length}   SUSPECT ${by("SUSPECT").length}   ASKS ${by("ASKS").length}   ERROR ${by("ERROR").length}`);
  if (by("SUSPECT").length) {
    console.log(`\nSUSPECT — resolved CONFIDENTLY to an entry that doesn't account for the season.`);
    console.log(`This is the silent-wrong-subtitles shape; each one needs a human to confirm.`);
    for (const r of by("SUSPECT")) {
      console.log(`   ${r.seriesTitle} / "${r.season}"`);
      console.log(`      -> ${r.detail}   [matched by ${r.matchedBy}]`);
    }
  }
  if (by("ERROR").length) {
    console.log(`\nERROR — nothing loaded at all:`);
    for (const r of by("ERROR")) console.log(`   ${r.seriesTitle} / "${r.season}": ${r.detail}`);
  }
  console.log("");
})();
