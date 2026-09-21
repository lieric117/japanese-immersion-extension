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
const helpers = new Function(
  "page",
  `
  const document = { querySelectorAll: () => page.blocks.map((b) => ({ textContent: typeof b === "string" ? b : JSON.stringify(b) })) };
  const location = { get pathname() { return page.pathname; } };
  const console = { warn() {}, log() {} };
  let warnedMissingSeasonNameFor = null, warnedEpisodeMismatchFor = null, warnedMissingBlockUrlFor = null;
  ${grab(/^const EPISODE_CODE_IN_NAME_RE = .*$/m, "EPISODE_CODE_IN_NAME_RE")}
  ${grab(/^function episodeNumberFromName\([\s\S]*?\n\}/m, "episodeNumberFromName")}
  ${grab(/^const WATCH_ID_RE = .*$/m, "WATCH_ID_RE")}
  ${grab(/^function watchIdFrom\([\s\S]*?\n\}/m, "watchIdFrom")}
  ${grab(/^function episodeIdentity\([\s\S]*?\n\}/m, "episodeIdentity")}
  ${grab(/^let warnedConflictingBlocksFor = null;\nlet warnedStaleBlockFor = null;\nfunction detectShowEpisode\([\s\S]*?\n\}/m, "detectShowEpisode")}
  ${grab(/^function detectFromJsonLdScript\([\s\S]*?\n\}/m, "detectFromJsonLdScript")}
  return { detectShowEpisode, watchIdFrom };
`
)(page);
const detect = () => helpers.detectShowEpisode();
const { watchIdFrom } = helpers;

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

// --- the block's own episode URL (2026-09-20, Open Question 21) ------------
// Crunchyroll publishes the episode's watch URL in the block's `url`/`@id`,
// and replaces the whole block in place on in-app navigation — so a block
// naming another episode's URL is the page's previous metadata, mid-swap.
const withUrl = (b, id) => ({ ...b, url: `https://www.crunchyroll.com/watch/${id}/slug-text`, "@id": `https://www.crunchyroll.com/watch/${id}` });
const e1 = withUrl(elbaph, "GONE1");
const e2 = withUrl(block("Elbaph (1156-current) | E1157 - Next", 2), "GTWO2");

page.pathname = "/watch/GONE1/slug-text";
page.blocks = [e1];
d = detect();
check("a block naming this page's watch id is used, and says so", d?.episodeNumber === 1156 && d.urlConfirmed === true, JSON.stringify(d));

page.pathname = "/watch/GTWO2/next-episode";
page.blocks = [e1];
check("the previous episode's block alone → null (wait), not a wrong load", detect() === null);

page.blocks = [e1, e2];
d = detect();
check("mid-swap, the block naming THIS page wins over the previous one", d?.episodeNumber === 1157, JSON.stringify(d));

page.blocks = [e2, elbaph];
d = detect();
check("a URL-confirmed block is not outvoted by one that names no page", d?.episodeNumber === 1157, JSON.stringify(d));

page.blocks = [e2, withUrl(block("Elbaph (1156-current) | E1158 - Third", 3), "GTWO2")];
check("two blocks claiming THIS page but different episodes → null (wait)", detect() === null);

page.pathname = "/watch/GONE1/slug-text";
page.blocks = [elbaph];
d = detect();
check("a block with no url still detects, flagged as unconfirmed", d?.episodeNumber === 1156 && d.urlConfirmed === null, JSON.stringify(d));

page.pathname = "/series/GSERIES/one-piece";
page.blocks = [e1];
d = detect();
check("off a watch page, a url is present but nothing to compare it to", d?.episodeNumber === 1156 && d.urlConfirmed === null, JSON.stringify(d));

page.pathname = "/watch/GONE1/slug-text";
page.blocks = [{ ...elbaph, url: "https://www.crunchyroll.com/series/GSERIES/one-piece" }];
d = detect();
check("a url that isn't a watch URL is not treated as a mismatch", d?.episodeNumber === 1156 && d.urlConfirmed === null, JSON.stringify(d));

// --- URL shapes on either side of the comparison (2026-09-20) --------------
// Only the id after /watch/ is compared, so everything around it — a locale
// prefix, the slug, a query string, a fragment, a trailing slash, the origin —
// must be ignored on both sides. Watch URLs in the wild carry all of these:
// Crunchyroll localises the path (/de/watch/…), links carry ?t= resume
// timestamps, and the JSON-LD side is an absolute URL where the page side is a
// bare pathname.
const ID = "GRDQKPQ1X";
for (const [label, value] of [
  ["absolute URL with slug", `https://www.crunchyroll.com/watch/${ID}/the-long-sought-elbaph`],
  ["locale-prefixed path", `/de/watch/${ID}/die-lang-ersehnte`],
  ["locale-region prefix", `/es-419/watch/${ID}/slug`],
  ["query string", `https://www.crunchyroll.com/watch/${ID}/slug?t=612`],
  ["query string, no slug", `https://www.crunchyroll.com/watch/${ID}?t=612`],
  ["fragment", `https://www.crunchyroll.com/watch/${ID}/slug#top`],
  ["trailing slash", `/watch/${ID}/`],
  ["no slug at all", `/watch/${ID}`],
]) {
  check(`watch id reads through a ${label}`, watchIdFrom(value) === ID, `${value} → ${watchIdFrom(value)}`);
}
check("a non-watch URL yields no id", watchIdFrom("https://www.crunchyroll.com/series/GSER/one-piece") === null);
check("a missing url yields no id", watchIdFrom(undefined) === null && watchIdFrom(null) === null);

// The same shapes, through the real comparison: page and block written
// differently must still match, and a different id must still mismatch.
const shapes = [
  ["absolute block url vs bare pathname", `https://www.crunchyroll.com/watch/${ID}/slug`, `/watch/${ID}/slug`],
  ["locale prefix on the page only", `https://www.crunchyroll.com/watch/${ID}/slug`, `/de/watch/${ID}/anderer-slug`],
  ["query on the block url", `https://www.crunchyroll.com/watch/${ID}/slug?t=90`, `/watch/${ID}/slug`],
  ["trailing slash on the page", `https://www.crunchyroll.com/watch/${ID}/slug`, `/watch/${ID}/`],
  ["different slug, same id", `https://www.crunchyroll.com/watch/${ID}/en-slug`, `/watch/${ID}/jp-slug`],
];
for (const [label, url, pathname] of shapes) {
  page.pathname = pathname;
  page.blocks = [{ ...elbaph, url }];
  d = detect();
  check(`same episode across ${label}`, d?.urlConfirmed === true, `${url} vs ${pathname} → ${JSON.stringify(d?.urlConfirmed)}`);
}
page.pathname = `/de/watch/GOTHER9/slug/`;
page.blocks = [{ ...elbaph, url: `https://www.crunchyroll.com/watch/${ID}/slug?t=90` }];
check("a different id still mismatches through all of that", detect() === null);

// `@id` is used when `url` is absent, and ignored when `url` is usable.
page.pathname = `/watch/${ID}/slug`;
page.blocks = [{ ...elbaph, "@id": `https://www.crunchyroll.com/watch/${ID}` }];
check("@id alone confirms the page", detect()?.urlConfirmed === true);
page.blocks = [{ ...elbaph, url: `https://www.crunchyroll.com/watch/${ID}/slug`, "@id": "https://www.crunchyroll.com/watch/GSTALE1" }];
check("url wins over a disagreeing @id", detect()?.urlConfirmed === true);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
