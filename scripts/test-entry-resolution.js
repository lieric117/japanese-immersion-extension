// Offline test for the WHOLE entry-resolution path — background.js's
// `resolveTextFiles`, driven end to end with a mocked Jimaku API.
//
// Usage:  node scripts/test-entry-resolution.js
//
// How this differs from test-season-resolution.js, which it sits alongside
// rather than replaces: that file tests the selection HELPERS in isolation
// (matchEntryBySeasonName, courSiblingEntries, searchQueryLadder,
// matchEntryByFullTitle) and, for the entry pick, a hand-copied mirror of
// resolveTextFiles' selection block. A mirror can agree with itself while
// disagreeing with what ships, and it cannot see anything the real function
// does AROUND the selection: the query ladder, the per-episode file lookup,
// the cour-sibling retry, the unfiltered-listing fallback, the archive filter,
// or any of the logging. This file runs the real function instead, in a `vm`
// sandbox with `fetch` mocked, so all of that is under test.
//
// Every case asserts THREE things, because the 2026-07-31 live pass produced
// both failure shapes — right subtitles with no log at all, and a missing log
// hiding a wrong entry:
//   (a) which entry was selected,
//   (b) the exact console lines produced,
//   (c) the resulting UI state: silent success (`confident`), warning +
//       entry dropdown (`!confident` with candidates), or hard error (throw).
//
// Logging is asserted UNCONDITIONALLY: any case that returns without emitting
// the `Jimaku entry "…" — matched by …` line fails, even if it picked the
// right entry. Frieren S2 looking correct on screen while saying nothing in
// the console is what made that pass unverifiable.
//
// All fixture data is real, captured from the live Jimaku API on 2026-08-01
// (searches, entry ids and names, and file listings including the archive-only
// and empty-per-episode ones).

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── sandbox ─────────────────────────────────────────────────────────────────
// background.js is a service worker: it calls importScripts and registers a
// chrome.runtime listener at top level. Both are stubbed; nothing else in it
// runs until a function is called. Loading the whole real file (rather than
// extracting pieces by regex) is what keeps this from drifting.
const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

let logs = [];
let warns = [];
let activeFetch = async () => {
  throw new Error("fetch called outside a test case");
};

const sandbox = {
  console: {
    log: (...a) => logs.push(a.join(" ")),
    warn: (...a) => warns.push(a.join(" ")),
    error: (...a) => warns.push(a.join(" ")),
  },
  fetch: (...a) => activeFetch(...a),
  importScripts: () => {},
  chrome: {
    runtime: { onMessage: { addListener: () => {} }, getURL: (s) => s },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  setTimeout,
  clearTimeout,
  URL,
  TextDecoder,
  TextEncoder,
};
vm.createContext(sandbox);
vm.runInContext(`${src}\n;this.__resolveTextFiles = resolveTextFiles;`, sandbox, {
  filename: "background.js",
});
const resolveTextFiles = sandbox.__resolveTextFiles;
if (typeof resolveTextFiles !== "function") {
  throw new Error("resolveTextFiles did not load out of background.js — was it renamed?");
}

// ── mocked Jimaku API ───────────────────────────────────────────────────────
// `search` is keyed by the query the extension would send; the mock compares
// apostrophe-stripped, because searchJimakuEntries strips them on the way out
// (that strip is why "Frieren: Beyond Journey's End" finds Jimaku's curly
// "Journey’s" at all). A query with no fixture returns [], exactly as Jimaku's
// substring index does for a title it doesn't hold — that is what makes the
// ladder rungs fire.
const stripApostrophes = (s) => String(s).replace(/['’‘`]/g, "");
const f = (name) => ({ name, url: `https://jimaku.cc/f/${encodeURIComponent(name)}`, size: 40000 });
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

function makeFetch(fixture) {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/entries/search")) {
      const q = u.searchParams.get("query");
      const key = Object.keys(fixture.search ?? {}).find((k) => stripApostrophes(k) === q);
      return jsonRes(key ? fixture.search[key] : []);
    }
    const m = u.pathname.match(/\/entries\/(\d+)\/files$/);
    if (m) {
      const entryFiles = (fixture.files ?? {})[m[1]] ?? {};
      const episode = u.searchParams.get("episode");
      // `all` is the unfiltered listing; numeric keys are the per-episode ones.
      const names = episode === null ? entryFiles.all ?? [] : entryFiles[episode] ?? [];
      return jsonRes(names.map(f));
    }
    throw new Error(`unexpected request: ${url}`);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

// ── real Jimaku data (live API, 2026-08-01) ─────────────────────────────────
const FRIEREN = [
  { id: 729, name: "Sousou no Frieren", english_name: "Frieren: Beyond Journey’s End" },
  { id: 11446, name: "Sousou no Frieren 2nd Season", english_name: "Frieren: Beyond Journey’s End Season 2" },
];

const KONOSUBA = [
  { id: 1627, name: "Kono Subarashii Sekai ni Shukufuku wo!", english_name: "KONOSUBA -God's blessing on this wonderful world!" },
  { id: 2833, name: "Kono Subarashii Sekai ni Shukufuku wo! 2", english_name: "KONOSUBA -God's blessing on this wonderful world! 2" },
  { id: 2837, name: "Kono Subarashii Sekai ni Shukufuku wo! 2: Kono Subarashii Geijutsu ni Shukufuku wo!", english_name: "KONOSUBA -God's blessing on this wonderful world! 2: God's Blessings on These Wonderful Works of Art!" },
  { id: 2835, name: "Kono Subarashii Sekai ni Shukufuku wo! 3", english_name: "KONOSUBA -God's blessing on this wonderful world! 3" },
  { id: 2834, name: "Kono Subarashii Sekai ni Shukufuku wo! Kurenai Densetsu", english_name: "KONOSUBA -God's blessing on this wonderful world!- Legend of Crimson" },
  { id: 2836, name: "Kono Subarashii Sekai ni Shukufuku wo!: Kono Subarashii Choker ni Shukufuku wo!", english_name: "KONOSUBA -God's blessing on this wonderful world!: God's Blessings On This Wonderful Choker!" },
];

// The full "Attack on Titan" result — 15 entries, films and OVAs included.
// The OAD and compilation cases below both land in this list.
const AOT = [
  { id: 1435, name: "Shingeki no Kyojin", english_name: "Attack on Titan" },
  { id: 3458, name: "Shingeki no Kyojin 2", english_name: "Attack on Titan Season 2" },
  { id: 3456, name: "Shingeki no Kyojin 3", english_name: "Attack on Titan Season 3" },
  { id: 3457, name: "Shingeki no Kyojin 3 Part 2", english_name: "Attack on Titan Season 3 Part 2" },
  { id: 3462, name: "Shingeki no Kyojin Kouhen: Jiyuu no Tsubasa", english_name: "Attack on Titan Part II: Wings of Freedom" },
  { id: 11263, name: "Shingeki no Kyojin Movie: Kanketsu-hen - The Last Attack", english_name: "Attack on Titan the Movie: The Last Attack" },
  { id: 1597, name: "Shingeki no Kyojin OVA", english_name: "Attack on Titan OVA" },
  { id: 3461, name: "Shingeki no Kyojin Zenpen: Guren no Yumiya", english_name: "Attack on Titan Part I: Crimson Bow and Arrow" },
  { id: 3465, name: "Shingeki no Kyojin Picture Drama", english_name: "Attack on Titan Picture Drama" },
  { id: 3459, name: "Shingeki no Kyojin: The Final Season", english_name: "Attack on Titan Final Season" },
  { id: 3464, name: "Shingeki no Kyojin: The Final Season - Kanketsu-hen Special 2", english_name: "Attack on Titan Final Season THE FINAL CHAPTERS Special 2" },
  { id: 3463, name: "Shingeki no Kyojin: The Final Season - Kanketsu-hen Special 1", english_name: "Attack on Titan Final Season THE FINAL CHAPTERS Special 1" },
  { id: 3460, name: "Shingeki no Kyojin: The Final Season Part 2", english_name: "Attack on Titan Final Season Part 2" },
  { id: 1470, name: "Shingeki! Kyojin Chuugakkou", english_name: "Attack on Titan: Junior High" },
  { id: 3467, name: "Shingeki no Kyojin: Kuinaki Sentaku", english_name: "Attack on Titan: No Regrets" },
];

const LAST_ATTACK_ONLY = [
  { id: 11263, name: "Shingeki no Kyojin Movie: Kanketsu-hen - The Last Attack", english_name: "Attack on Titan the Movie: The Last Attack" },
];

const INFINITY_CASTLE_ONLY = [
  { id: 12471, name: "Kimetsu no Yaiba: Mugenjou-hen Movie 1 - Akaza Sairai", english_name: "Demon Slayer: Kimetsu no Yaiba Infinity Castle" },
];

// The whole "Demon Slayer: Kimetsu no Yaiba" result — the arc seasons plus the
// two films, i.e. the TV cut and the film cut of Mugen Train side by side.
const DEMON_SLAYER = [
  { id: 846, name: "Kimetsu no Yaiba", english_name: "Demon Slayer: Kimetsu no Yaiba" },
  { id: 12471, name: "Kimetsu no Yaiba: Mugenjou-hen Movie 1 - Akaza Sairai", english_name: "Demon Slayer: Kimetsu no Yaiba Infinity Castle" },
  { id: 3335, name: "Kimetsu no Yaiba: Mugen Ressha-hen (TV)", english_name: "Demon Slayer: Kimetsu no Yaiba Mugen Train Arc" },
  { id: 4038, name: "Kimetsu no Yaiba: Hashira Geiko-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Hashira Training Arc" },
  { id: 3336, name: "Kimetsu no Yaiba: Katanakaji no Sato-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc" },
  { id: 3337, name: "Kimetsu no Yaiba: Yuukaku-hen", english_name: "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc" },
];

const MUGEN_TRAIN = [
  { id: 3338, name: "Kimetsu no Yaiba: Mugen Ressha-hen", english_name: "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" },
  { id: 3335, name: "Kimetsu no Yaiba: Mugen Ressha-hen (TV)", english_name: "Demon Slayer: Kimetsu no Yaiba Mugen Train Arc" },
  { id: 11745, name: "Meitantei Conan: Haibara Ai Monogatari - Kurogane no Mystery Train" },
  { id: 8534, name: 'Hazure Skill "Kinomi Master": Skill no Mi (Tabetara Shinu) wo Mugen ni Taberareru You ni Natta Ken Nitsuite', english_name: "Bogus Skill <<Fruitmaster>> ~About that time I became able to eat unlimited numbers of Skill Fruits (that kill you)~" },
  { id: 9431, name: "Kanchigai no Atelier Meister: Eiyuu Party no Moto Zatsuyougakari ga, Jitsu wa Sentou Igai ga SSS Rank Datta to Iu Yoku Aru Hanashi", english_name: "The Unaware Atelier Meister" },
  { id: 7023, name: "Sekai Meisaku Gekijou Kanketsu Ban: Alps Monogatari Watashi no Annette", english_name: "World Masterpiece Theater Complete Edition: The Alps Story - My Annette" },
];

const REZERO = [
  { id: 332, name: "Re:Zero kara Hajimeru Isekai Seikatsu", english_name: "Re:ZERO -Starting Life in Another World-" },
  { id: 3081, name: "Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season", english_name: "Re:ZERO -Starting Life in Another World- Season 2" },
  { id: 3082, name: "Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2", english_name: "Re:ZERO -Starting Life in Another World- Season 2 Part 2" },
  { id: 7615, name: "Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season", english_name: "Re:ZERO -Starting Life in Another World- Season 3" },
  { id: 3083, name: "Re:Zero kara Hajimeru Isekai Seikatsu OVAs", english_name: "Re:ZERO -Starting Life in Another World- OVAs" },
];

const RZ = "Re:ZERO -Starting Life in Another World-";

// Real file listings. Names matter: the archive filter reads them, and the
// per-episode vs. unfiltered split is exactly where the OVA bugs live.
const FILES = {
  // An ordinary TV season: files are numbered, the episode filter works.
  11446: {
    1: [
      "[Haruhana] Sousou no Frieren - 29 [WebRip][HEVC-10bit 1080p][JPN].ass",
      "[NanakoRaws] Sousou no Frieren S2 - 01 (NTV 1080p HEVC AAC).ass",
      "葬送のフリーレン.S02E01.じゃあ行こうか.WEBRip.Amazon.ja-jp[sdh].srt",
    ],
  },
  2835: {
    1: [
      "Kono.Subarashii.Sekai.ni.Shukufuku.wo.S03E01.2024.1080p.CR.WEB-DL.x264.AAC.srt",
      "[SubsPlease] Kono Subarashii Sekai ni Shukufuku wo! S3 - 01 (1080p) [D6088444].ass",
    ],
  },
  // A film: one entry, a handful of files, and Jimaku ignores `?episode=` on
  // it (episode 0 and episode 1 both return the whole listing).
  3338: {
    1: [
      "Demon Slayer -Kimetsu no Yaiba- The Movie Mugen Train (Fujitv 2021.09.25 retimed for BD).ja.srt",
      "Gekijouban Kimetsu no Yaiba Mugen Ressha Hen BDSUP.7z",
      "[Judas] Kimetsu no Yaiba - Movie 01 - Mugen Train [BD 1080p][HEVC x265 10bit][Dual-Audio].srt",
    ],
    all: [
      "Demon Slayer -Kimetsu no Yaiba- The Movie Mugen Train (Fujitv 2021.09.25 retimed for BD).ja.srt",
      "Gekijouban Kimetsu no Yaiba Mugen Ressha Hen BDSUP.7z",
      "[Judas] Kimetsu no Yaiba - Movie 01 - Mugen Train [BD 1080p][HEVC x265 10bit][Dual-Audio].srt",
    ],
  },
  // The archive-only entry: the ONLY file Jimaku holds for this film is a .7z.
  12471: {
    1: ["Demon.Slayer.Kimetsu.no.Yaiba.Infinity.Castle.2025.1080p.BDRip.AAC5.1.10bits.x265-Rapta.sup.7z"],
    all: ["Demon.Slayer.Kimetsu.no.Yaiba.Infinity.Castle.2025.1080p.BDRip.AAC5.1.10bits.x265-Rapta.sup.7z"],
  },
  // A film Crunchyroll reports as episode 0. Jimaku returns everything.
  11263: {
    0: [
      "Shingeki no Kyojin - The Last Attack.srt",
      "[VCB-Studio] Shingeki no Kyojin Movie 5 The Last Attack [Ma10p_1080p][x265_flac].sup.7z",
    ],
    all: [
      "Shingeki no Kyojin - The Last Attack.srt",
      "[VCB-Studio] Shingeki no Kyojin Movie 5 The Last Attack [Ma10p_1080p][x265_flac].sup.7z",
    ],
  },
  // OVA collections: NOTHING is numbered episode 1, but the entry is far from
  // empty. Per-episode returns []; unfiltered returns the real listing.
  3083: {
    26: ["Re_ゼロから始める異世界生活.新編集版.S01E26.Memory.Snow.WEBRip.Netflix.ja[cc].srt"],
    all: [
      "Re_ゼロから始める異世界生活.新編集版.S01E26.Memory.Snow.WEBRip.Netflix.ja[cc].srt",
      "Re_ゼロから始める異世界生活.新編集版.S01E27.氷結の絆.WEBRip.Netflix.ja[cc].srt",
      "[NanakoRaws] Re Zero kara Hajimeru Isekai Seikatsu - Hyouketsu no Kizuna (AT-X 1920x1080 x265 AAC).ass",
    ],
  },
  1597: {
    all: [
      "Shingeki no Kyojin S00E07 (Ilse's Notebook Memoirs of a Recon Corps Member) 2013 1080p Bluray REMUX AVC AAC 2.0 Dual Audio -ZR.srt",
      "Shingeki no Kyojin S00E13 (Distress) 2014 1080p Bluray REMUX AVC AAC 2.0 Dual Audio -ZR.srt",
      "[Kamigami] Shingeki no Kyojin - #3.25 OAD2 [1024x576 x264 AAC][CHT, JPN].ass",
      "[Kamigami] Shingeki no Kyojin - 03.5 OAD [DVD 848x480 x264 AAC][CHS, JPN].ass",
    ],
  },
  // Attack on Titan season 1 and 2 — present only so a WRONG resolution to
  // them produces plausible-looking files rather than an incidental empty
  // list. A test that passes because the wrong entry happened to be empty
  // isn't testing resolution.
  3335: { 1: ["[Judas] Kimetsu no Yaiba - Mugen Train Arc - 01 [1080p][HEVC x265 10bit].srt"] },
  1435: { 1: ["[Ohys-Raws] Shingeki no Kyojin - 01 (MX 1280x720 x264 AAC).srt"] },
  3458: { 1: ["[Ohys-Raws] Shingeki no Kyojin S2 - 01 (MX 1280x720 x264 AAC).srt"] },
};

// Both outcomes count: resolving to an entry, and resolving to nothing. An
// unresolved load has to be as visible in the console as a resolved one, or it
// just becomes the new silent case.
const ENTRY_LOG_RE = /^\[jp-immersion\] (?:Jimaku entry "|no Jimaku entry identified )/;

// ── cases ───────────────────────────────────────────────────────────────────
// `log`/`warn`, when given, must match the captured output EXACTLY and in
// order — not "contains". A log line drifting is a real regression: it is the
// only way a live session can tell which path resolved an entry.
const cases = [
  // ── 1. ordinary multi-season TV ───────────────────────────────────────────
  {
    why: "Frieren S2 — resolves by season NAME, and says so",
    args: { query: "Frieren: Beyond Journey's End", episode: 1, seasonNumber: 2, seasonName: "Frieren: Beyond Journey’s End Season 2" },
    search: { "Frieren: Beyond Journey's End": FRIEREN },
    files: FILES,
    expect: {
      entryId: 11446,
      entryName: "Frieren: Beyond Journey’s End Season 2",
      confident: true,
      fileCount: 3,
      log: [
        `[jp-immersion] Jimaku entry "Frieren: Beyond Journey’s End Season 2" (id 11446) for "Frieren: Beyond Journey's End" episode 1 — matched by Crunchyroll's season name.`,
      ],
      warn: [],
    },
  },
  {
    why: "KonoSuba S3 — no season name published, resolves by season NUMBER",
    args: { query: "KONOSUBA -God's blessing on this wonderful world!", episode: 1, seasonNumber: 3, seasonName: null },
    search: { "KONOSUBA -God's blessing on this wonderful world!": KONOSUBA },
    files: FILES,
    expect: {
      entryId: 2835,
      confident: true,
      fileCount: 2,
      log: [
        `[jp-immersion] Jimaku entry "KONOSUBA -God's blessing on this wonderful world! 3" (id 2835) for "KONOSUBA -God's blessing on this wonderful world!" episode 1 — matched by season 3.`,
      ],
      warn: [],
    },
  },

  // ── 2. a film with a clean exact match ────────────────────────────────────
  {
    why: "Mugen Train — the film's own entry, reached by broadening the query, NOT the TV arc entry",
    args: { query: "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train", episode: 1, seasonNumber: null, seasonName: null },
    search: { "Mugen Train": MUGEN_TRAIN },
    files: FILES,
    expect: {
      entryId: 3338,
      confident: true,
      fileCount: 2, // the .7z is filtered out
      log: [
        `[jp-immersion] Jimaku has nothing indexed under "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train" — found 6 entries by searching "Mugen Train" instead.`,
        `[jp-immersion] Jimaku entry "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" (id 3338) for "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train" episode 1 — matched by an exact title match.`,
      ],
      warn: [],
    },
  },

  // ── 2b. THE LIVE FAILURES (2026-08-01 service-worker console) ─────────────
  // The earlier Mugen Train fixture passed offline while the real thing loaded
  // the wrong film, because the fixture assumed Crunchyroll hands us the FULL
  // film title as the series name. It doesn't: the live query was the bare
  // franchise "Demon Slayer: Kimetsu no Yaiba", whose search results do not
  // contain Mugen Train's entry at all. These three cases use the queries the
  // console actually recorded.
  {
    // Every field here is verbatim from the live page's JSON-LD (2026-08-01),
    // INCLUDING the compound `name`. That string is not a title: passing it to
    // Jimaku verbatim returns zero results (measured), so this case is what
    // proves the compound is parsed apart rather than searched as-is. A fixture
    // with a clean "Mugen Train" would pass without testing that at all.
    why: "Mugen Train from a bare franchise query — the silent wrong-film load",
    args: {
      query: "Demon Slayer: Kimetsu no Yaiba",
      episode: 1,
      seasonNumber: 2,
      seasonName: "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train",
      episodeTitle:
        "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train | E1 - Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train",
    },
    search: {
      "Demon Slayer: Kimetsu no Yaiba": DEMON_SLAYER,
      // The film's own title is the only query that finds its entry. The
      // compound has no fixture, so if the code ever searched it verbatim this
      // case would fail exactly as the live page did.
      "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train": [MUGEN_TRAIN[0]],
    },
    files: FILES,
    expect: {
      entryId: 3338,
      confident: true,
      fileCount: 2,
      log: [
        `[jp-immersion] also searched this title's own name "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" — 1 entry the series search didn't return.`,
        `[jp-immersion] Jimaku entry "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" (id 3338) for "Demon Slayer: Kimetsu no Yaiba" episode 1 — matched by Crunchyroll's season name.`,
      ],
      warn: [],
    },
    // 12471 is the entry it actually loaded live — the only film-class entry in
    // the franchise results. 3335 is the TV retelling, the other near-miss.
    mustNotResolveTo: [12471, 3335, 846],
  },
  {
    why: "Infinity Castle — a trailing 'I' in Crunchyroll's title must not reject the correct entry",
    args: {
      query: "Demon Slayer: Kimetsu no Yaiba Infinity Castle I",
      episode: 1,
      seasonNumber: null,
      seasonName: null,
      episodeTitle: "Demon Slayer: Kimetsu no Yaiba Infinity Castle I | E1 - Infinity Castle",
    },
    search: {
      "Demon Slayer: Kimetsu no Yaiba Infinity Castle": INFINITY_CASTLE_ONLY,
      "Infinity Castle": INFINITY_CASTLE_ONLY,
    },
    files: FILES,
    expect: {
      // Its only file is a .7z, so this still ends in the archive error — but
      // it must get there by IDENTIFYING the entry, not by rejecting it.
      throws:
        "Only archive files found for episode 1 (Demon.Slayer.Kimetsu.no.Yaiba.Infinity.Castle.2025.1080p.BDRip.AAC5.1.10bits.x265-Rapta.sup.7z) — use the manual upload fallback instead",
      log: [
        `[jp-immersion] Jimaku has nothing indexed under "Demon Slayer: Kimetsu no Yaiba Infinity Castle I" — found 1 entries by searching "Demon Slayer: Kimetsu no Yaiba Infinity Castle" instead.`,
        `[jp-immersion] Jimaku entry "Demon Slayer: Kimetsu no Yaiba Infinity Castle" (id 12471) for "Demon Slayer: Kimetsu no Yaiba Infinity Castle I" episode 1 — matched by this title's own name "Infinity Castle".`,
      ],
      warn: [],
    },
  },
  {
    why: "The Last Attack — must not fall through to the flagship TV series entry",
    args: {
      query: "Attack on Titan",
      episode: 0,
      seasonNumber: null,
      seasonName: null,
      episodeTitle: "Attack on Titan: THE LAST ATTACK | E1 - THE LAST ATTACK",
    },
    search: { "Attack on Titan": AOT, "THE LAST ATTACK": LAST_ATTACK_ONLY, "Attack on Titan: THE LAST ATTACK": LAST_ATTACK_ONLY },
    files: FILES,
    expect: {
      entryId: 11263,
      confident: true,
      fileCount: 1,
      log: [
        `[jp-immersion] Jimaku entry "Attack on Titan the Movie: The Last Attack" (id 11263) for "Attack on Titan" episode 0 — matched by this title's own name "THE LAST ATTACK".`,
      ],
      warn: [],
    },
    mustNotResolveTo: [1435],
  },
  {
    // The safety net for when the episode title is missing or useless: a film
    // must never be claimed on format alone, because a franchise has several
    // and "the only film in these results" is whichever one the search
    // returned. Unresolved + picker is the correct outcome, not a silent pick.
    why: "a film with no usable episode title resolves to nothing, never to a sibling film",
    args: {
      query: "Demon Slayer: Kimetsu no Yaiba",
      episode: 1,
      seasonNumber: null,
      seasonName: "Demon Slayer: Kimetsu no Yaiba The Movie",
      episodeTitle: null,
    },
    search: { "Demon Slayer: Kimetsu no Yaiba": DEMON_SLAYER },
    files: FILES,
    expect: { unresolved: true, confident: false, noFileFetch: true, minCandidates: 2, warnCount: 1 },
    mustNotResolveTo: [12471, 3338, 846],
  },

  // ── 3. matched, but no usable subtitle file ───────────────────────────────
  {
    why: "Infinity Castle — entry found, but Jimaku holds only a .7z: its OWN failure state",
    args: { query: "Demon Slayer: Kimetsu no Yaiba Infinity Castle", episode: 1, seasonNumber: null, seasonName: null },
    search: { "Demon Slayer: Kimetsu no Yaiba Infinity Castle": INFINITY_CASTLE_ONLY },
    files: FILES,
    expect: {
      throws:
        "Only archive files found for episode 1 (Demon.Slayer.Kimetsu.no.Yaiba.Infinity.Castle.2025.1080p.BDRip.AAC5.1.10bits.x265-Rapta.sup.7z) — use the manual upload fallback instead",
      // Must NOT look like "no entry found": the entry WAS identified, and the
      // log has to say so before the failure, or a live session can't tell the
      // two apart.
      log: [
        `[jp-immersion] Jimaku entry "Demon Slayer: Kimetsu no Yaiba Infinity Castle" (id 12471) for "Demon Slayer: Kimetsu no Yaiba Infinity Castle" episode 1 — matched by an exact title match.`,
      ],
      warn: [],
    },
  },

  // ── 4. a film Crunchyroll numbers as episode 0 ────────────────────────────
  {
    why: "AoT: The Last Attack as episode 0 — resolves via the film path, not generic episode handling",
    args: { query: "Attack on Titan: THE LAST ATTACK", episode: 0, seasonNumber: null, seasonName: null },
    search: { "Attack on Titan: THE LAST ATTACK": LAST_ATTACK_ONLY },
    files: FILES,
    expect: {
      entryId: 11263,
      confident: true,
      fileCount: 1, // the .sup.7z is filtered out
      log: [
        `[jp-immersion] Jimaku entry "Attack on Titan the Movie: The Last Attack" (id 11263) for "Attack on Titan: THE LAST ATTACK" episode 0 — matched by an exact title match.`,
      ],
      warn: [],
    },
  },

  // ── 5. franchise-ambiguous: an OVA collection Crunchyroll lists as a season ─
  {
    why: "Re:Zero OVAs — right entry, but nothing numbered episode 1: must list the entry's files, not hard-error",
    args: { query: RZ, episode: 1, seasonNumber: 2, seasonName: `${RZ} OVAs` },
    // Keyed WITHOUT the trailing dash: the ladder's first rung strips trailing
    // separators, so that is the query that actually goes on the wire.
    search: { "Re:ZERO -Starting Life in Another World": REZERO },
    files: FILES,
    expect: {
      entryId: 3083,
      confident: true,
      fileCount: 3,
      log: [
        `[jp-immersion] Jimaku entry "Re:ZERO -Starting Life in Another World- OVAs" (id 3083) for "${RZ}" episode 1 — matched by Crunchyroll's season name.`,
        `[jp-immersion] "Re:ZERO -Starting Life in Another World- OVAs" has no file numbered episode 1 — listing all 3 of its files instead (normal for a movie, OVA or special); none of them names "${RZ} OVAs".`,
      ],
      warn: [],
    },
  },

  // ── 6. a recap film with no entry of its own ──────────────────────────────
  {
    // The 2026-08-01 decision: nothing loads here. A missed warning banner
    // risks capturing wrong-show sentences into permanent Anki cards, which is
    // worse than a temporarily blank subtitle track. Asserting the absence of
    // the FETCH is the point — "no entry returned" would still pass if the
    // function had already pulled season 1's files down.
    why: "AoT Chronicle — no entry matches, so nothing is selected and nothing is fetched",
    args: { query: "Attack on Titan Chronicle", episode: 1, seasonNumber: null, seasonName: null },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: {
      unresolved: true,
      confident: false,
      noFileFetch: true,
      minCandidates: 2, // the dropdown still needs real options to offer
      log: [
        `[jp-immersion] Jimaku has nothing indexed under "Attack on Titan Chronicle" — found 15 entries by searching "Attack on Titan" instead.`,
        `[jp-immersion] no Jimaku entry identified for "Attack on Titan Chronicle" episode 1 — 15 search results, none of them a match.`,
      ],
      warnCount: 1,
    },
    // The specific old behaviour: season 1's entry, silently, behind a banner.
    mustNotResolveTo: [1435],
  },
  {
    // The other side of the distinction: "load nothing" is only for when there
    // is no right answer at all. A query that DOES match an entry still loads
    // it, even when the requested season doesn't exist on Jimaku — otherwise
    // this change would blank out shows that work today.
    why: "a season number with no matching Jimaku season still loads the matched franchise entry",
    args: { query: "Attack on Titan", episode: 1, seasonNumber: 9, seasonName: null },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: {
      entryId: 1435,
      unresolved: false,
      confident: true,
      fileCount: 1,
      log: [
        `[jp-immersion] Jimaku entry "Attack on Titan" (id 1435) for "Attack on Titan" episode 1 — matched by an exact title match.`,
      ],
      warn: [],
    },
  },

  // ── 7. OAD content that must not fall back to a numbered TV season ────────
  {
    // REAL Crunchyroll metadata, captured 2026-08-01 from the season list for
    // Attack on Titan (series id GY3VC2P34): season title "Attack on Titan
    // OADs", season number 66. Both values matter — the plural "OADs" is what
    // the format classifier has to recognise, and 66 is a live example of a
    // season number far outside any normal sequential range, which is why
    // nothing may depend on that number being small.
    why: "AoT OADs with Crunchyroll's real season metadata ('Attack on Titan OADs', season 66)",
    args: { query: "Attack on Titan", episode: 1, seasonNumber: 66, seasonName: "Attack on Titan OADs" },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: {
      entryId: 1597,
      confident: true,
      fileCount: 4,
      log: [
        `[jp-immersion] Jimaku entry "Attack on Titan OVA" (id 1597) for "Attack on Titan" episode 1 — matched by Crunchyroll listing this season as OVA/OAD.`,
        `[jp-immersion] "Attack on Titan OVA" has no file numbered episode 1 — listing all 4 of its files instead (normal for a movie, OVA or special); none of them names "Attack on Titan OADs".`,
      ],
      warn: [],
    },
    // The specific regression: season 2's entry is a real, populated entry, so
    // taking it produces working-looking subtitles from the wrong show.
    mustNotResolveTo: [3458, 1435],
  },
  {
    // Kept as a robustness guard, not a real observation: Crunchyroll's season
    // titles are free text and this extension reads them from JSON-LD rather
    // than from the season-list API the value above was captured from, so the
    // bare form has to work too.
    why: "AoT OADs with a bare 'OAD' season name",
    args: { query: "Attack on Titan", episode: 1, seasonNumber: 66, seasonName: "OAD" },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: { entryId: 1597, confident: true, fileCount: 4 },
    mustNotResolveTo: [3458, 1435],
  },
  {
    // Season 66 with no season name at all — the case where the format
    // classifier has nothing to read. It must not resolve to a TV season by
    // number, and with nothing identifying it, it must load nothing.
    why: "season 66 with no season name must not be read as any TV season's entry",
    args: { query: "Attack on Titan", episode: 1, seasonNumber: 66, seasonName: null },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: { entryId: 1435, unresolved: false, confident: true, fileCount: 1, warn: [] },
    mustNotResolveTo: [3458, 3456, 3459],
  },

  // ── 5b. narrowing an unfiltered listing by the episode's own title ────────
  {
    // Compound `name` again, in the OVA shape this time — here the two halves
    // DIFFER, and it's the part after "E1 - " that names the individual OVA.
    // Taking the pre-pipe half would narrow nothing.
    why: "Re:Zero's Memory Snow narrows the OVA entry's files to the one naming it",
    args: { query: RZ, episode: 1, seasonNumber: 2, seasonName: `${RZ} OVAs`, episodeTitle: `${RZ} OVAs | E1 - Memory Snow` },
    search: { "Re:ZERO -Starting Life in Another World": REZERO },
    files: FILES,
    expect: {
      entryId: 3083,
      confident: true,
      fileCount: 1,
      log: [
        `[jp-immersion] Jimaku entry "Re:ZERO -Starting Life in Another World- OVAs" (id 3083) for "${RZ}" episode 1 — matched by Crunchyroll's season name.`,
        `[jp-immersion] "Re:ZERO -Starting Life in Another World- OVAs" has no file numbered episode 1 — narrowed its 3 files to 1 matching this title's own name "Memory Snow".`,
      ],
      warn: [],
    },
  },
  {
    // The honest limit of title narrowing, asserted rather than hidden:
    // Crunchyroll's English title and the uploader's romanised one share no
    // characters, so nothing matches and the full list is still the answer.
    // Falling through to everything is correct here; falling through to an
    // EMPTY list would not be.
    why: "The Frozen Bond finds no filename match and still lists everything, not nothing",
    args: { query: RZ, episode: 1, seasonNumber: 2, seasonName: `${RZ} OVAs`, episodeTitle: `${RZ} OVAs | E1 - The Frozen Bond` },
    search: { "Re:ZERO -Starting Life in Another World": REZERO },
    files: FILES,
    expect: {
      entryId: 3083,
      confident: true,
      fileCount: 3,
      log: [
        `[jp-immersion] Jimaku entry "Re:ZERO -Starting Life in Another World- OVAs" (id 3083) for "${RZ}" episode 1 — matched by Crunchyroll's season name.`,
        `[jp-immersion] "Re:ZERO -Starting Life in Another World- OVAs" has no file numbered episode 1 — listing all 3 of its files instead (normal for a movie, OVA or special); none of them names "The Frozen Bond".`,
      ],
      warn: [],
    },
  },
  {
    why: "an AoT OAD narrows its entry's files by the OAD's own title",
    args: { query: "Attack on Titan", episode: 1, seasonNumber: 66, seasonName: "Attack on Titan OADs", episodeTitle: "Attack on Titan OADs | E3 - Distress" },
    search: { "Attack on Titan": AOT },
    files: FILES,
    expect: { entryId: 1597, confident: true, fileCount: 1 },
  },

  // Generality: the same mechanism on a different franchise, and reached via
  // the format match rather than the season-name match — Crunchyroll's "OVA"
  // doesn't equal Jimaku's "…OVAs", so only the format class connects them.
  {
    why: "Re:Zero OVAs when Crunchyroll's season name doesn't match the entry's wording",
    args: { query: RZ, episode: 1, seasonNumber: 2, seasonName: "OVA" },
    search: { "Re:ZERO -Starting Life in Another World": REZERO },
    files: FILES,
    expect: {
      entryId: 3083,
      confident: true,
      fileCount: 3,
      log: [
        `[jp-immersion] Jimaku entry "Re:ZERO -Starting Life in Another World- OVAs" (id 3083) for "${RZ}" episode 1 — matched by Crunchyroll listing this season as OVA/OAD.`,
        `[jp-immersion] "Re:ZERO -Starting Life in Another World- OVAs" has no file numbered episode 1 — listing all 3 of its files instead (normal for a movie, OVA or special).`,
      ],
      warn: [],
    },
    mustNotResolveTo: [332, 3081],
  },

  // ── regression guards for the ordinary paths the fix must not disturb ─────
  {
    // The trap the format classifier could plausibly fall into: a TV season
    // NAMED after a film, with both the film and the TV cut in the results.
    why: "Demon Slayer's Mugen Train ARC is episodic TV — must take the TV entry, not the film's",
    args: { query: "Demon Slayer: Kimetsu no Yaiba", episode: 1, seasonNumber: 2, seasonName: "Mugen Train Arc" },
    search: { "Demon Slayer: Kimetsu no Yaiba": DEMON_SLAYER },
    files: FILES,
    expect: {
      entryId: 3335,
      confident: true,
      fileCount: 1,
      log: [
        `[jp-immersion] Jimaku entry "Demon Slayer: Kimetsu no Yaiba Mugen Train Arc" (id 3335) for "Demon Slayer: Kimetsu no Yaiba" episode 1 — matched by Crunchyroll's season name.`,
      ],
      warn: [],
    },
    mustNotResolveTo: [3338, 846],
  },
  {
    why: "a real TV episode with no file for it still hard-errors — the unfiltered listing must NOT leak here",
    args: { query: "Frieren: Beyond Journey's End", episode: 7, seasonNumber: 2, seasonName: "Frieren: Beyond Journey’s End Season 2" },
    search: { "Frieren: Beyond Journey's End": FRIEREN },
    files: FILES,
    expect: {
      throws: "No subtitle file found for episode 7",
      log: [
        `[jp-immersion] Jimaku entry "Frieren: Beyond Journey’s End Season 2" (id 11446) for "Frieren: Beyond Journey's End" episode 7 — matched by Crunchyroll's season name.`,
      ],
      warn: [],
    },
  },
  {
    why: "nothing found at any ladder rung is still a clean hard error",
    args: { query: "Some Show That Does Not Exist", episode: 1, seasonNumber: 1, seasonName: null },
    search: {},
    files: {},
    expect: {
      throws: `No Jimaku entry found for "Some Show That Does Not Exist" (also tried 4 broader searches)`,
      noEntryLog: true, // nothing was resolved, so there is nothing to log
      log: [],
      warn: [],
    },
  },
];

// ── runner ──────────────────────────────────────────────────────────────────
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function run() {
  let failed = 0;
  for (const c of cases) {
    logs = [];
    warns = [];
    const fetchMock = makeFetch(c);
    activeFetch = fetchMock;
    const problems = [];
    let result = null;
    let error = null;
    try {
      result = await resolveTextFiles(
        c.args.query,
        c.args.episode,
        { Authorization: "test-key" },
        c.args.seasonNumber,
        c.args.seasonName,
        c.args.episodeTitle ?? null
      );
    } catch (e) {
      error = e;
    }
    const x = c.expect;

    // (c) failure state first — a throw invalidates every value assertion.
    if (x.throws) {
      if (!error) problems.push(`expected a hard error, got entry ${result.entryId}`);
      else if (error.message !== x.throws) problems.push(`error message:\n           got  ${error.message}\n           want ${x.throws}`);
    } else if (error) {
      problems.push(`unexpected hard error: ${error.message}`);
    }

    if (!error && !x.throws) {
      // (a) which entry
      if (x.entryId !== undefined && result.entryId !== x.entryId) {
        problems.push(`entry ${result.entryId} "${result.entryName}", want ${x.entryId}`);
      }
      if (x.entryName !== undefined && result.entryName !== x.entryName) {
        problems.push(`entry name "${result.entryName}", want "${x.entryName}"`);
      }
      if (x.fileCount !== undefined && result.textFiles.length !== x.fileCount) {
        problems.push(`${result.textFiles.length} usable files, want ${x.fileCount}`);
      }
      // (c) UI state
      if (x.confident !== undefined && result.confident !== x.confident) {
        problems.push(`confident=${result.confident}, want ${x.confident}`);
      }
      if (x.minCandidates !== undefined && result.candidates.length < x.minCandidates) {
        problems.push(`${result.candidates.length} candidates for the dropdown, want at least ${x.minCandidates}`);
      }
      if (c.mustNotResolveTo?.includes(result.entryId)) {
        problems.push(`resolved to entry ${result.entryId}, which this case exists to rule out`);
      }
      // The "load nothing" state: no entry, and — the part that actually
      // matters — no subtitle ever fetched, so nothing can reach a card.
      if (x.unresolved !== undefined && Boolean(result.unresolved) !== x.unresolved) {
        problems.push(`unresolved=${Boolean(result.unresolved)}, want ${x.unresolved}`);
      }
      if (x.unresolved === true) {
        if (result.entryId !== null) problems.push(`unresolved but still selected entry ${result.entryId}`);
        if (result.textFiles.length) problems.push(`unresolved but returned ${result.textFiles.length} files`);
      }
    }
    if (x.noFileFetch) {
      const fileCalls = fetchMock.calls.filter((u) => /\/files(\?|$)/.test(u));
      if (fileCalls.length) {
        problems.push(`fetched ${fileCalls.length} file listing(s) when it should have fetched none:\n           ${fileCalls.join("\n           ")}`);
      }
    }

    // (b) logging — asserted for every case, including the ones that throw.
    // The unconditional rule: resolving an entry at all MUST produce the entry
    // line, so a correct-but-silent resolution fails here.
    if (!x.noEntryLog && !logs.some((l) => ENTRY_LOG_RE.test(l))) {
      problems.push("no entry-resolution log line was emitted (logging must be unconditional)");
    }
    if (x.log && !eq(logs, x.log)) {
      problems.push(`console.log lines:\n           got  ${JSON.stringify(logs, null, 1)}\n           want ${JSON.stringify(x.log, null, 1)}`);
    }
    if (x.warn && !eq(warns, x.warn)) {
      problems.push(`console.warn lines:\n           got  ${JSON.stringify(warns, null, 1)}\n           want ${JSON.stringify(x.warn, null, 1)}`);
    }
    if (x.warnCount !== undefined && warns.length !== x.warnCount) {
      problems.push(`${warns.length} warnings, want ${x.warnCount}`);
    }
    // The warning IS the dropdown's trigger, so the two must agree.
    if (!error && !x.throws && result.confident === false && warns.length === 0) {
      problems.push("resolved with confident=false but warned about nothing");
    }
    // Guards the resolver's own split, which is what the "load nothing" change
    // rests on: an entry comes back if and only if it was identified. This is
    // why `confident` could be reduced to a constant on the resolved path, so
    // it has to be enforced rather than assumed — a future tier that selects
    // an entry without identifying it would reintroduce exactly the silent
    // wrong-entry load that change removed, and would surface here rather than
    // in a live session.
    if (!error && !x.throws && Boolean(result.entryId) !== result.confident) {
      problems.push(
        `entryId=${result.entryId} but confident=${result.confident} — an entry was selected without being identified (or vice versa)`
      );
    }

    if (problems.length) failed++;
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${c.why}`);
    for (const p of problems) console.log(`        ${p}`);
  }
  console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nall ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

run();
