// An integer episode's file list never holds a file naming a fractional
// episode (2026-09-18 audit). Replays verbatim live responses for My Hero
// Academia season 1 episode 1 (fixtures/jimaku/fractional-special-2026-09-18.json),
// whose Jimaku answer carries Amazon's "S02E01.第13.5話" recap special, and checks
// the digit-led Netflix titles that must survive (from the same live run).
// Usage: node scripts/test-fractional-special.js   [BACKGROUND_JS=<old copy>]
"use strict";
const fs = require("fs");
const path = require("path");
const { loadBackground } = require("./audit/load-background.js");
const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "jimaku", "fractional-special-2026-09-18.json"), "utf8"));
const fetch = async (url) => {
  const u = String(url);
  if (/\/download\//.test(u)) return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  if (!(u in recorded)) throw new Error(`request not in the recorded fixture: ${u}`);
  return { ok: true, status: 200, json: async () => recorded[u], text: async () => JSON.stringify(recorded[u]) };
};
const bg = loadBackground({ fetch, backgroundPath: process.env.BACKGROUND_JS || undefined, exportNames: ["statesFractionalEpisode"], storage: { jimakuApiKey: "k" } });
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
(async () => {
  const r = await bg.fetchSubtitles({ query: "My Hero Academia", episode: 1, seasonNumber: 1, seasonName: "Season 1", episodeTitle: "Season 1 | E1 - Izuku Midoriya: Origin", fileHint: "[JPN]", siblingTitles: [] });
  const names = r.files.map((f) => f.name);
  check("MHA S1 ep 1 no longer offers the 第13.5話 recap special", !names.some((n) => n.includes("第13.5話")), JSON.stringify(names));
  check("…and keeps every real episode-1 file (3)", names.filter((n) => /S01E01/.test(n)).length === 3, JSON.stringify(names));
  if (bg.statesFractionalEpisode) {
    // Verbatim live filenames (Black Clover ep 102, Haikyu!! TO THE TOP ep 13):
    // episode TITLES that begin with a digit, not fractional positions.
    for (const n of ["ブラッククローバー.S02E102.2つのキセキ.WEBRip.Netflix.ja[cc].srt", "ハイキュー!!.S04E13.2日目.WEBRip.Netflix.ja[cc].srt"]) {
      check(`a digit-led title is not a fractional episode: ${n}`, !bg.statesFractionalEpisode(n));
    }
    check("第13.5話 is a fractional episode", bg.statesFractionalEpisode("僕のヒーローアカデミア.S02E01.第13.5話 ヒーローノート.WEBRip.Amazon.ja-jp[sdh].srt"));
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
