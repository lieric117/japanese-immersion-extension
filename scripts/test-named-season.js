// A named season is never matched by its list position alone (2026-09-18
// audit). Replays verbatim live Jimaku responses (fixtures/jimaku/
// named-season-2026-09-18.json, recorded by scripts/audit/record-scenario.js)
// through the real resolveTextFiles. Crunchyroll strings are verbatim from the
// 2026-08-01/-01b catalogue captures; the compound `name` is RECONSTRUCTED in
// the measured episode/film shapes.
//
// Usage:  node scripts/test-named-season.js   [BACKGROUND_JS=<old copy> to see the pre-fix failure]

"use strict";
const fs = require("fs");
const path = require("path");
const { loadBackground } = require("./audit/load-background.js");
const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "jimaku", "named-season-2026-09-18.json"), "utf8"));
const fetch = async (url) => {
  const u = String(url);
  if (!(u in recorded)) throw new Error(`request not in the recorded fixture: ${u}`);
  return { ok: true, status: 200, json: async () => recorded[u], text: async () => JSON.stringify(recorded[u]) };
};
const bg = loadBackground({ fetch, backgroundPath: process.env.BACKGROUND_JS || undefined });
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
const run = (a) => bg.resolveTextFiles(a.query, a.episode, { Authorization: "k" }, a.seasonNumber, a.seasonName, a.episodeTitle, []).catch((e) => ({ error: e.message }));

(async () => {
  let r = await run({ query: "Kaiju No. 8", episode: 1, seasonNumber: 2, seasonName: "Kaiju No. 8: Mission Recon", episodeTitle: "Kaiju No. 8: Mission Recon | E1 - Kaiju No. 8: Mission Recon" });
  check("Kaiju No. 8: Mission Recon (a recap at list position 2) does NOT load Season 2's entry", r.unresolved === true, JSON.stringify(r).slice(0, 160));

  r = await run({ query: "Re:ZERO -Starting Life in Another World-", episode: 1, seasonNumber: 1, seasonName: "Season 1: Director’s Cut", episodeTitle: "Season 1: Director’s Cut | E1 - The End of the Beginning and the Beginning of the End" });
  check("Re:ZERO 'Season 1: Director's Cut' still resolves to season 1 — its marker is read mid-name", r.entryId === 332, JSON.stringify(r).slice(0, 160));

  r = await run({ query: "Fate/Grand Order Absolute Demonic Front: Babylonia", episode: 0, seasonNumber: 1, seasonName: "Fate/Grand Order Final Singularity Grand Temple of Time: Solomon", episodeTitle: "Fate/Grand Order Final Singularity Grand Temple of Time: Solomon | Fate/Grand Order Final Singularity Grand Temple of Time: Solomon" });
  check("FGO Solomon (a film under Babylonia's series, film-shaped page) loads nothing", !r.textFiles?.length, JSON.stringify(r).slice(0, 160));

  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
