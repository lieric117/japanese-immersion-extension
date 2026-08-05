// Offline test for Jimaku ENTRY selection — which season's subtitle entry a
// given Crunchyroll page resolves to (background.js's resolveTextFiles).
//
// Usage:  node scripts/test-season-resolution.js
//
// Reads the real selection functions straight out of background.js rather than
// re-implementing them, so this can't drift from what ships. Every entry list
// below is a real Jimaku search result captured via the live API (2026-07-27
// for Re:Zero and Frieren, 2026-07-29 for the rest).
//
// The Re:Zero cases are the 2026-07-27 live-test report: every season from the
// OVAs onward loaded the NEXT season's subtitles, because Crunchyroll numbers
// its seasons by list position and counts the OVA collection as season 2.
//
// The arc-named and cour-split cases come from a 2026-07-29 generality pass
// over 12 multi-season franchises, which found two further classes the
// season-number path cannot handle at all:
//   - Seasons named by ARC with no season number anywhere (Demon Slayer,
//     Attack on Titan's Final Season, Dr. STONE) — five seasons across three
//     popular shows, every one of them silently resolving to season 1.
//   - Seasons Jimaku splits across cours, where the entry picked for the season
//     has no files for the back half of it (confirmed live: Re:Zero's
//     "2nd Season" returns zero files for episodes 14–25).

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
  courSiblingEntries,
  searchQueryLadder,
  matchEntryByFullTitle,
  nonEpisodicClass,
  matchEntryByNonEpisodicClass,
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
    grab(/^const TRAILING_QUALIFIER_RE = .*$/m, "TRAILING_QUALIFIER_RE"),
    grab(/^function matchEntryBySeasonName\([\s\S]*?\n\}/m, "matchEntryBySeasonName"),
    grab(/^function seasonNumberFromName\([\s\S]*?\n\}/m, "seasonNumberFromName"),
    grab(/^function courSiblingEntries\([\s\S]*?\n\}/m, "courSiblingEntries"),
    grab(/^function looseTitle\([\s\S]*?\n\}/m, "looseTitle"),
    grab(/^const MIN_SEARCH_QUERY_CHARS = .*$/m, "MIN_SEARCH_QUERY_CHARS"),
    grab(/^const MAX_SEARCH_LADDER_RUNGS = .*$/m, "MAX_SEARCH_LADDER_RUNGS"),
    grab(/^function searchQueryLadder\([\s\S]*?\n\}/m, "searchQueryLadder"),
    grab(/^function queryWordsAppearIn\([\s\S]*?\n\}/m, "queryWordsAppearIn"),
    grab(/^function matchEntryByFullTitle\([\s\S]*?\n\}/m, "matchEntryByFullTitle"),
    grab(/^const NON_EPISODIC_CLASSES = \[[\s\S]*?\n\];/m, "NON_EPISODIC_CLASSES"),
    grab(/^function nonEpisodicClass\([\s\S]*?\n\}/m, "nonEpisodicClass"),
    grab(/^function matchEntryByNonEpisodicClass\([\s\S]*?\n\}/m, "matchEntryByNonEpisodicClass"),
    "return { normalizeTitle, stripSeasonSuffix, entrySeasonNumber, matchEntryBySeasonName, seasonNumberFromName, courSiblingEntries, searchQueryLadder, matchEntryByFullTitle, nonEpisodicClass, matchEntryByNonEpisodicClass };",
  ].join("\n")
)();

// Mirrors resolveTextFiles' selection block exactly — everything either side of
// it is network I/O. A mirror can agree with itself while disagreeing with what
// ships, so the authoritative end-to-end coverage (real function, mocked fetch,
// log and UI-state assertions) lives in test-entry-resolution.js; this stays
// because it covers the selection helpers at a granularity that one can't.
function selectEntry(entries, query, seasonNumber, seasonName) {
  const normalizedQuery = normalizeTitle(query);
  const nameMatch = matchEntryBySeasonName(entries, seasonName, query);
  const namedSeason = seasonNumberFromName(seasonName);
  const wantedSeason = namedSeason ?? seasonNumber ?? 1;
  const isEpisodic = (seasonNumber !== null || seasonName !== null) && !nonEpisodicClass(seasonName);
  const classMatch = matchEntryByNonEpisodicClass(entries, seasonName, query);
  const seasonMatch = !isEpisodic
    ? undefined
    : entries.find((e) => {
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
  return nameMatch ?? classMatch ?? seasonMatch ?? plainMatch ?? entries[0];
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

// Real Jimaku search results for the arc-named shows (live API, 2026-07-29).
// These are the shows the season-NUMBER path cannot resolve at all: none of
// their later seasons carries a season marker, so every one of them used to
// fall through to the exact-title fallback, i.e. season 1's entry.
const DEMON_SLAYER = [
  { id: 846, name: "Kimetsu no Yaiba", english_name: "Demon Slayer: Kimetsu no Yaiba" },
  { id: 4038, name: "Kimetsu no Yaiba: Hashira Geiko-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Hashira Training Arc" },
  { id: 3336, name: "Kimetsu no Yaiba: Katanakaji no Sato-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc" },
  { id: 3337, name: "Kimetsu no Yaiba: Yuukaku-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc" },
];

const AOT = [
  { id: 1435, name: "Shingeki no Kyojin", english_name: "Attack on Titan" },
  { id: 3458, name: "Shingeki no Kyojin 2", english_name: "Attack on Titan Season 2" },
  { id: 3456, name: "Shingeki no Kyojin 3", english_name: "Attack on Titan Season 3" },
  { id: 3457, name: "Shingeki no Kyojin 3 Part 2", english_name: "Attack on Titan Season 3 Part 2" },
  { id: 3459, name: "Shingeki no Kyojin: The Final Season", english_name: "Attack on Titan Final Season" },
  { id: 3460, name: "Shingeki no Kyojin: The Final Season Part 2", english_name: "Attack on Titan Final Season Part 2" },
  { id: 1597, name: "Shingeki no Kyojin OVA", english_name: "Attack on Titan OVA" },
];

const DR_STONE = [
  { id: 730, name: "Dr. STONE", english_name: "Dr. STONE" },
  { id: 3678, name: "Dr. STONE: STONE WARS", english_name: "Dr. STONE: STONE WARS" },
  { id: 3679, name: "Dr. STONE: NEW WORLD", english_name: "Dr. STONE New World" },
  { id: 7845, name: "Dr. STONE: NEW WORLD Part 2", english_name: "Dr. STONE New World Part 2" },
];

const arcCases = [
  // Crunchyroll names these seasons by their ARC, with no season number
  // anywhere. The name is the only usable signal.
  { why: "Demon Slayer Entertainment District Arc (season name only)", entries: DEMON_SLAYER, query: "Demon Slayer: Kimetsu no Yaiba", seasonNumber: 3, seasonName: "Entertainment District Arc", want: 3337 },
  { why: "Demon Slayer Swordsmith Village Arc", entries: DEMON_SLAYER, query: "Demon Slayer: Kimetsu no Yaiba", seasonNumber: 5, seasonName: "Swordsmith Village Arc", want: 3336 },
  { why: "Demon Slayer, Crunchyroll repeating the full title", entries: DEMON_SLAYER, query: "Demon Slayer: Kimetsu no Yaiba", seasonNumber: 3, seasonName: "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc", want: 3337 },
  { why: "AoT Final Season — must NOT pick the Part 2 entry", entries: AOT, query: "Attack on Titan", seasonNumber: 6, seasonName: "Final Season", want: 3459 },
  { why: "AoT Final Season Part 2 picks the Part 2 entry", entries: AOT, query: "Attack on Titan", seasonNumber: 7, seasonName: "Final Season Part 2", want: 3460 },
  { why: "Dr. STONE Stone Wars (punctuation between title and season name)", entries: DR_STONE, query: "Dr. STONE", seasonNumber: 2, seasonName: "Stone Wars", want: 3678 },
  { why: "Dr. STONE New World", entries: DR_STONE, query: "Dr. STONE", seasonNumber: 3, seasonName: "New World", want: 3679 },
  { why: "AoT S1 with no season name still resolves by number", entries: AOT, query: "Attack on Titan", seasonNumber: 1, seasonName: null, want: 1435 },
  { why: "AoT S3 by number (marker present, name path not needed)", entries: AOT, query: "Attack on Titan", seasonNumber: 3, seasonName: null, want: 3456 },
];

for (const c of arcCases) {
  const got = selectEntry(c.entries, c.query, c.seasonNumber, c.seasonName);
  const ok = got && got.id === c.want;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.why}\n        -> entry ${got ? got.id : "(none)"} "${got ? got.english_name : ""}"` +
      (ok ? "" : `\n        want entry ${c.want}`)
  );
  cases.push(c); // count it in the total
}

// ── cour-split sibling lookup ────────────────────────────────────────────────
// Jimaku puts the back half of a two-cour season in its own entry, so the entry
// picked for the season has no files for the later episodes. These check that
// the right sibling is offered as the retry, and that unrelated entries aren't.
const courCases = [
  {
    why: "Re:Zero 2nd Season offers its Part 2 entry as the retry",
    entries: REZERO, chosen: 3081, wantSiblings: [3082],
  },
  {
    why: "AoT Season 3 offers its Part 2 entry",
    entries: AOT, chosen: 3456, wantSiblings: [3457],
  },
  {
    why: "AoT Final Season offers its Part 2 entry (arc-named, no season digit)",
    entries: AOT, chosen: 3459, wantSiblings: [3460],
  },
  {
    why: "Re:Zero season 1 has no cour siblings — must offer nothing",
    entries: REZERO, chosen: 332, wantSiblings: [],
  },
  {
    why: "Re:Zero OVAs entry has no cour siblings",
    entries: REZERO, chosen: 3083, wantSiblings: [],
  },
];

for (const c of courCases) {
  const chosen = c.entries.find((e) => e.id === c.chosen);
  const got = courSiblingEntries(c.entries, chosen).map((e) => e.id);
  const ok = got.length === c.wantSiblings.length && got.every((id, i) => id === c.wantSiblings[i]);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.why}\n        -> [${got.join(", ")}]` + (ok ? "" : `   want [${c.wantSiblings.join(", ")}]`)
  );
  cases.push(c);
}

// ── non-episodic content: films, OVAs, specials, compilations ───────────────
// The 2026-07-31 live pass found two failures here, both stemming from
// Crunchyroll publishing no `partOfSeason` block for this kind of title.
// Everything below is measured against the live Jimaku API on the same date:
// the zero-result searches are real, and so are the entries that exist anyway.
// The same live search as DEMON_SLAYER above, with the film entries the
// arc-season cases don't need — this is what a search including the movies
// actually returns (live API, 2026-07-31).
const DEMON_SLAYER_FILMS = [
  { id: 846, name: "Kimetsu no Yaiba", english_name: "Demon Slayer: Kimetsu no Yaiba" },
  { id: 12471, name: "Kimetsu no Yaiba: Mugenjou-hen Movie 1 - Akaza Sairai", english_name: "Demon Slayer: Kimetsu no Yaiba Infinity Castle" },
  { id: 3335, name: "Kimetsu no Yaiba: Mugen Ressha-hen (TV)", english_name: "Demon Slayer: Kimetsu no Yaiba Mugen Train Arc" },
  { id: 3338, name: "Kimetsu no Yaiba: Mugen Ressha-hen", english_name: "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" },
];

// A query ladder rung only ever runs when the one before it found NOTHING, so
// these assert the rungs exist and are ordered, not that each one is used.
const ladderCases = [
  {
    why: "a film's own subtitle is tried as a query — 'Mugen Train' finds the movie entry",
    title: "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train",
    wantIncludes: "Mugen Train",
  },
  {
    why: "trailing words are dropped back to the franchise Jimaku indexes under",
    title: "Re:ZERO -Starting Life in Another World- Memory Snow",
    wantIncludes: "Re:ZERO -Starting Life in Another World",
  },
  {
    why: "a dangling separator is trimmed, so the broadened query can still match",
    title: "Attack on Titan Chronicle",
    wantIncludes: "Attack on Titan",
  },
];
for (const c of ladderCases) {
  const ladder = searchQueryLadder(c.title);
  const ok = ladder.includes(c.wantIncludes) && ladder[0] === c.title;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.why}` + (ok ? "" : `\n        got [${ladder.join(" | ")}]`));
  cases.push(c);
}

const titleCases = [
  {
    why: "a film whose full title Jimaku holds verbatim resolves to its own entry",
    entries: DEMON_SLAYER_FILMS, title: "Demon Slayer: Kimetsu no Yaiba Infinity Castle", full: true, want: 12471,
  },
  {
    why: "punctuation differences don't stop the match (': ' vs. ' -…- ')",
    entries: DEMON_SLAYER_FILMS, title: "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train", full: false, want: 3338,
  },
  {
    why: "Jimaku's own single hit on the full title is trusted over local string comparison",
    entries: [{ id: 11263, name: "Shingeki no Kyojin Movie: Kanketsu-hen - The Last Attack", english_name: "Attack on Titan the Movie: The Last Attack" }],
    title: "Attack on Titan: THE LAST ATTACK", full: true, want: 11263,
  },
  {
    // The regression this function exists to prevent: the franchise entry's
    // name is a PREFIX of the OVA's Crunchyroll title, and matching on that is
    // exactly how a movie ended up playing season 1's subtitles.
    why: "the franchise entry is NOT accepted for an OVA that merely starts with its name",
    entries: REZERO, title: `${RZ} Memory Snow`, full: false, want: null,
  },
  {
    why: "an ambiguous compilation resolves to nothing rather than to season 1",
    entries: AOT, title: "Attack on Titan Chronicle", full: false, want: null,
  },
];
for (const c of titleCases) {
  const got = matchEntryByFullTitle(c.entries, c.title, c.full);
  const gotId = got ? got.id : null;
  const ok = gotId === c.want;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.why}` + (ok ? "" : `\n        -> ${gotId}   want ${c.want}`)
  );
  cases.push(c);
}

// Confidence is what decides whether the switcher panel asks the user. A wrong
// answer here is worse than a wrong entry: it's a wrong entry shown as correct.
const confidenceCases = [
  { why: "an identified film is confident", entries: DEMON_SLAYER_FILMS, title: "Demon Slayer: Kimetsu no Yaiba Infinity Castle", full: true, hasSeasonSignal: false, want: true },
  { why: "an unidentified OVA is NOT confident", entries: REZERO, title: `${RZ} Memory Snow`, full: false, hasSeasonSignal: false, want: false },
  { why: "an unidentified compilation is NOT confident", entries: AOT, title: "Attack on Titan Chronicle", full: false, hasSeasonSignal: false, want: false },
];
for (const c of confidenceCases) {
  const titleMatch = matchEntryByFullTitle(c.entries, c.title, c.full);
  const got = Boolean(titleMatch || c.hasSeasonSignal);
  const ok = got === c.want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.why}` + (ok ? "" : `\n        -> ${got}   want ${c.want}`));
  cases.push(c);
}

console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
