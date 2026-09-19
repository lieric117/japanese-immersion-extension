// content.js's detectShowEpisode over stubbed pages (2026-09-18 audit, taxonomy
// A3). The `name` strings are verbatim from live pages (Decisions Log
// 2026-08-01); the surrounding JSON-LD objects are RECONSTRUCTED around them
// with only the fields detection reads.
//
// Usage:  node scripts/test-detect-show-episode.js

"use strict";
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const grab = (re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label}`);
  return m[0];
};
const page = { blocks: [], pathname: "/watch/X/y" };
const detect = new Function(
  "page",
  `
  const document = { querySelectorAll: () => page.blocks.map((b) => ({ textContent: typeof b === "string" ? b : JSON.stringify(b) })) };
  const location = { get pathname() { return page.pathname; } };
  const console = { warn() {}, log() {} };
  let warnedMissingSeasonNameFor = null, warnedEpisodeMismatchFor = null;
  ${grab(/^const EPISODE_CODE_IN_NAME_RE = .*$/m, "EPISODE_CODE_IN_NAME_RE")}
  ${grab(/^function episodeNumberFromName\([\s\S]*?\n\}/m, "episodeNumberFromName")}
  ${grab(/^function episodeIdentity\([\s\S]*?\n\}/m, "episodeIdentity")}
  ${grab(/^let warnedConflictingBlocksFor = null;\nfunction detectShowEpisode\([\s\S]*?\n\}/m, "detectShowEpisode")}
  ${grab(/^function detectFromJsonLdScript\([\s\S]*?\n\}/m, "detectFromJsonLdScript")}
  return detectShowEpisode;
`
)(page);

let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
const block = (name, episodeNumber, season = { name: "Elbaph (1156-current)", seasonNumber: 24 }) => ({
  "@type": "TVEpisode",
  name,
  episodeNumber,
  partOfSeries: { name: "One Piece" },
  partOfSeason: season,
});
const elbaph = block("Elbaph (1156-current) | E1156 - The Long-sought Elbaph!", 1);

page.blocks = [elbaph];
let d = detect();
check("the title code wins over episodeNumber (One Piece 1156)", d?.episodeNumber === 1156, JSON.stringify(d));

page.blocks = ['{"@type":"WebSite"}', "not json", elbaph];
check("unrelated and unparseable blocks are skipped", detect()?.episodeNumber === 1156);

page.blocks = [elbaph, { ...elbaph }];
check("two blocks for the SAME episode still detect it", detect()?.episodeNumber === 1156);

page.blocks = [elbaph, block("Elbaph (1156-current) | E1157 - Next", 2)];
check("two blocks for DIFFERENT episodes → null (wait), never the first one", detect() === null);

page.blocks = [];
check("no block → null", detect() === null);

const lastAttack = {
  "@type": "TVEpisode",
  name: "Attack on Titan: THE LAST ATTACK | Attack on Titan: THE LAST ATTACK",
  episodeNumber: 1,
  partOfSeries: { name: "Attack on Titan" },
};
page.blocks = [lastAttack];
d = detect();
check("a season-less film still detects (no season fields)", d && d.seasonName === null && d.seasonNumber === null, JSON.stringify(d));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
