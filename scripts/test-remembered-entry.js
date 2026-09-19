// Every path that loads an entry's files applies the resolver's episode rules
// (2026-09-18 audit, root cause RC-D3). Replays VERBATIM live Jimaku responses
// recorded by scripts/audit/record-scenario.js (fixtures/jimaku/
// remembered-entry-2026-09-18.json) through the real background.js; a request
// the fixture doesn't hold fails the test rather than being answered.
//
// Usage:  node scripts/test-remembered-entry.js
//         BACKGROUND_JS=<old copy> node scripts/test-remembered-entry.js   (shows the pre-fix failure)
//
// The shape: Shangri-La Frontier season 2 is Crunchyroll episodes 26–50 and
// Jimaku entry 7707's episodes 1–25. Before the fix, a REMEMBERED pick of
// exactly the right entry (or picking it in the entry picker) asked
// `?episode=43`, got nothing, listed all 103 files and loaded the first —
// "Shangri-La Frontier (2024) - 26", season 2's FIRST episode — as confident.

"use strict";

const fs = require("fs");
const path = require("path");
const { loadBackground } = require("./audit/load-background.js");

const ROOT = path.join(__dirname, "..");
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "jimaku", "remembered-entry-2026-09-18.json"), "utf8"));
const fetch = async (url) => {
  const u = String(url);
  if (/\/download\//.test(u)) return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  if (!(u in recorded)) throw new Error(`request not in the recorded fixture: ${u}`);
  return { ok: true, status: 200, json: async () => recorded[u], text: async () => JSON.stringify(recorded[u]) };
};
const bg = loadBackground({ fetch, backgroundPath: process.env.BACKGROUND_JS || undefined, exportNames: ["fetchEntryFiles"], storage: { jimakuApiKey: "k" } });

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
const page = (ep) => ({ query: "Shangri-La Frontier", seasonNumber: 2, seasonName: "Season 2", episode: ep, episodeTitle: `Season 2 | E${ep} - x`, siblingTitles: [] });
const picked = (r) => (r?.selectedUrl ? decodeURIComponent(r.selectedUrl) : null);

(async () => {
  let r = await bg.fetchSubtitles({ ...page(43), fileHint: "[JPN]", preferredEntryId: 7707 });
  check("remembered entry, episode 43: loads the file for season 2 episode 18", /S2 - 18|S02E18/.test(picked(r) ?? ""), picked(r));
  check("…and offers only that episode's files, not the whole entry", r.files.length === 3, `${r.files.length} files`);

  r = await bg.fetchEntryFiles(7707, page(43));
  check("entry picker, episode 43: loads season 2 episode 18", /S2 - 18|S02E18/.test(picked(r) ?? ""), picked(r));

  r = await bg.fetchSubtitles({ ...page(26), fileHint: "[JPN]", preferredEntryId: 7707 });
  check("remembered entry, episode 26: loads season 2 episode 1 (the absolute uploader's '- 26')", /\(2024\) - 26 |S2 - 01|S02E01/.test(picked(r) ?? ""), picked(r));

  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
