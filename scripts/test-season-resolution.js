// Offline test for Jimaku ENTRY selection — which season's subtitle entry a
// given Crunchyroll page resolves to (background.js's resolveTextFiles).
//
// Usage:  node scripts/test-season-resolution.js
//
// Reads the real selection functions straight out of background.js rather than
// re-implementing them, so this can't drift from what ships. The entry lists
// below are real Jimaku search results, captured 2026-07-27 via the live API.
//
// The Re:Zero cases are the 2026-07-27 live-test report: every season from the
// OVAs onward loaded the NEXT season's subtitles, because Crunchyroll numbers
// its seasons by list position and counts the OVA collection as season 2.

"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from background.js — did it get renamed?`);
  return m[0];
}

const {
  normalizeTitle,
  stripSeasonSuffix,
  entrySeasonNumber,
  matchEntryBySeasonName,
  seasonNumberFromName,
} = new Function(
  [
    grab(/^function stripApostrophes\([\s\S]*?\n\}/m, "stripApostrophes"),
    grab(/^function normalizeTitle\([\s\S]*?\n\}/m, "normalizeTitle"),
    grab(/^const PART_SUFFIX_RE = .*$/m, "PART_SUFFIX_RE"),
    grab(/^const SEASON_ROMAN = .*$/m, "SEASON_ROMAN"),
    grab(/^const MAX_BARE_SEASON_NUMBER = .*$/m, "MAX_BARE_SEASON_NUMBER"),
    grab(/^const SEASON_PATTERNS = \[[\s\S]*?\n\];/m, "SEASON_PATTERNS"),
    grab(/^function parseSeasonMarker\([\s\S]*?\n\}/m, "parseSeasonMarker"),
    grab(/^function stripSeasonSuffix\([\s\S]*?\n\}/m, "stripSeasonSuffix"),
    grab(/^function entrySeasonNumber\([\s\S]*?\n\}/m, "entrySeasonNumber"),
    grab(/^function matchEntryBySeasonName\([\s\S]*?\n\}/m, "matchEntryBySeasonName"),
    grab(/^function seasonNumberFromName\([\s\S]*?\n\}/m, "seasonNumberFromName"),
    "return { normalizeTitle, stripSeasonSuffix, entrySeasonNumber, matchEntryBySeasonName, seasonNumberFromName };",
  ].join("\n")
)();

// Mirrors resolveTextFiles' selection block exactly — everything either side of
// it is network I/O.
function selectEntry(entries, query, seasonNumber, seasonName) {
  const normalizedQuery = normalizeTitle(query);
  const nameMatch = matchEntryBySeasonName(entries, seasonName, query);
  const namedSeason = seasonNumberFromName(seasonName);
  const wantedSeason = namedSeason ?? seasonNumber ?? 1;
  const seasonMatch = entries.find((e) => {
    const seasonOk =
      entrySeasonNumber(e.name) === wantedSeason || entrySeasonNumber(e.english_name) === wantedSeason;
    if (!seasonOk) return false;
    return (
      normalizeTitle(stripSeasonSuffix(e.name)) === normalizedQuery ||
      normalizeTitle(stripSeasonSuffix(e.english_name)) === normalizedQuery
    );
  });
  const plainMatch = entries.find(
    (e) => normalizeTitle(e.name) === normalizedQuery || normalizeTitle(e.english_name) === normalizedQuery
  );
  return nameMatch ?? seasonMatch ?? plainMatch ?? entries[0];
}

// Real Jimaku search results (live API, 2026-07-27).
const REZERO = [
  { id: 332, name: "Re:Zero kara Hajimeru Isekai Seikatsu", english_name: "Re:ZERO -Starting Life in Another World-" },
  { id: 3081, name: "Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season", english_name: "Re:ZERO -Starting Life in Another World- Season 2" },
  { id: 3082, name: "Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2", english_name: "Re:ZERO -Starting Life in Another World- Season 2 Part 2" },
  { id: 7615, name: "Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season", english_name: "Re:ZERO -Starting Life in Another World- Season 3" },
  { id: 11820, name: "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season", english_name: "Re:ZERO -Starting Life in Another World- Season 4" },
  { id: 3083, name: "Re:Zero kara Hajimeru Isekai Seikatsu OVAs", english_name: "Re:ZERO -Starting Life in Another World- OVAs" },
  { id: 5700, name: "Shironeko Project: ZERO CHRONICLE", english_name: "Shironeko Project ZERO CHRONICLE" },
];

const FRIEREN = [
  { id: 729, name: "Sousou no Frieren", english_name: "Frieren: Beyond Journey's End" },
  { id: 11446, name: "Sousou no Frieren 2nd Season", english_name: "Frieren: Beyond Journey's End Season 2" },
];

const RZ = "Re:ZERO -Starting Life in Another World-";

const cases = [
  // — Re:Zero: Crunchyroll's season NUMBER is shifted by the OVA collection
  //   sitting at list position 2. Every one of these was wrong before.
  { why: "Re:Zero S1", entries: REZERO, query: RZ, seasonNumber: 1, seasonName: RZ, want: 332 },
  { why: "Re:Zero OVAs (Crunchyroll calls it season 2)", entries: REZERO, query: RZ, seasonNumber: 2, seasonName: `${RZ} OVAs`, want: 3083 },
  { why: "Re:Zero S2 (Crunchyroll calls it season 3)", entries: REZERO, query: RZ, seasonNumber: 3, seasonName: `${RZ} Season 2`, want: 3081 },
  { why: "Re:Zero S3 (Crunchyroll calls it season 4)", entries: REZERO, query: RZ, seasonNumber: 4, seasonName: `${RZ} Season 3`, want: 7615 },
  { why: "Re:Zero S4 (Crunchyroll calls it season 5)", entries: REZERO, query: RZ, seasonNumber: 5, seasonName: `${RZ} Season 4`, want: 11820 },

  // — The name path must also work when only the NUMBER inside the name is
  //   usable, i.e. Crunchyroll's title doesn't match a Jimaku entry outright.
  { why: "season number read from a name that matches no entry", entries: REZERO, query: RZ, seasonNumber: 5, seasonName: "Re:Zero Season 3", want: 7615 },

  // — Regression guards: the number path must still work untouched when
  //   Crunchyroll publishes no season name, or repeats the series title.
  { why: "no season name at all — falls back to the number", entries: FRIEREN, query: "Frieren: Beyond Journey's End", seasonNumber: 2, seasonName: null, want: 11446 },
  { why: "season name repeats the series title — must not pin to season 1", entries: FRIEREN, query: "Frieren: Beyond Journey's End", seasonNumber: 2, seasonName: "Frieren: Beyond Journey's End", want: 11446 },
  { why: "season 1 with no name", entries: FRIEREN, query: "Frieren: Beyond Journey's End", seasonNumber: 1, seasonName: null, want: 729 },
  { why: "Frieren S2 by name", entries: FRIEREN, query: "Frieren: Beyond Journey's End", seasonNumber: 2, seasonName: "Frieren: Beyond Journey's End Season 2", want: 11446 },
];

let failed = 0;
for (const c of cases) {
  const got = selectEntry(c.entries, c.query, c.seasonNumber, c.seasonName);
  const ok = got && got.id === c.want;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.why}\n        -> entry ${got ? got.id : "(none)"} "${got ? got.english_name : ""}"` +
      (ok ? "" : `\n        want entry ${c.want}`)
  );
}
console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
