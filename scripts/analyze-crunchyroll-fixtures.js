// Sweeps the output of collect-crunchyroll-fixtures.js against the REAL
// resolution logic in background.js, so a catalogue-wide capture becomes
// findings rather than a large JSON file.
//
// Usage:  node scripts/analyze-crunchyroll-fixtures.js <collected.json>
//
// Loads background.js in a vm and uses its own `nonEpisodicClass`,
// `looksLikeStandaloneWork` and `contentTitleCandidates` — so this measures
// what would actually happen, not a description of it. Five questions, each
// one a place this project has already been wrong:
//
//   1. Which seasons does the classifier call non-episodic, and which does it
//      MISS that look non-episodic by name? A miss is the Mugen Train bug.
//   2. What shapes does the JSON-LD `name` field really take? Three so far;
//      each new one has broken the parser.
//   3. Does Crunchyroll number episodes absolutely or per season? This is the
//      open question from the Naruto work, and the episodes endpoint answers
//      it directly — no JSON-LD needed.
//   4. Which series are Naruto-shaped (multi-season, high episode count) and
//      therefore candidates for the same numbering collision?
//   5. What season_number values occur? 0, 66 and 68 are all real.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/analyze-crunchyroll-fixtures.js <collected.json>");
  process.exit(2);
}

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  fetch: async () => {
    throw new Error("no network");
  },
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
    ";this.__x = { nonEpisodicClass, looksLikeStandaloneWork, contentTitleCandidates, parseFileEpisode, looseTitle };",
  sandbox,
  { filename: "background.js" }
);
const X = sandbox.__x;

const data = JSON.parse(fs.readFileSync(input, "utf8"));
const seriesList = Object.values(data.series ?? {});

// Words that make a human read a season title as non-episodic. Deliberately
// WIDER than the resolver's own classifier — the gap between the two is the
// finding, so this must not just re-implement it.
// Wider than the resolver's own classifier in what it covers (prologue, extras,
// shorts, "the final chapters"), but it shares one exclusion: "Special Edition"
// is a qualifier on an ordinary season, not a format. Without that this reports
// One Piece's three Special Edition arcs as misses on every run — noise that
// buries a real one.
const LOOKS_SIDE_FORMAT =
  /\b(ova|ovas|oad|oads|ona|specials?(?!\s+(?:edition|version|cut|feature|screening|broadcast))|movie|movies|film|films|picture drama|recap|compilation|prologue|epilogue|extra|extras|short|shorts|the final chapters)\b/i;

const out = {
  seasons: 0,
  episodes: 0,
  flagged: [],
  missed: [],
  overFlagged: [],
  nameShapes: new Map(),
  numbering: [],
  seasonNumbers: new Map(),
  longRunners: [],
  truncated: [],
  errored: 0,
};

for (const series of seriesList) {
  const seasons = series.seasons ?? [];
  let seriesEpisodes = 0;

  for (const season of seasons) {
    out.seasons++;
    const title = season.title ?? "";
    const eps = season.episodes ?? [];
    seriesEpisodes += eps.length;
    out.episodes += eps.length;

    // At One Piece scale the episodes endpoint may paginate; if it does, every
    // downstream conclusion is drawn from a partial list. Compared against the
    // season's own declared count so a gap is visible rather than assumed away.
    // A season whose fetch ERRORED has no episode list to be short — reporting
    // it as truncated buries the real signal under auth noise, which is what
    // the first partial capture did (28 of 32 "short" seasons were all 401s).
    if (!season.error && Number.isInteger(season.number_of_episodes) && season.number_of_episodes !== eps.length) {
      out.truncated.push({
        series: series.seriesTitle ?? series.seriesId,
        season: title,
        declared: season.number_of_episodes,
        got: eps.length,
      });
    }

    if (season.error) out.errored++;

    const sn = season.season_number;
    out.seasonNumbers.set(sn, (out.seasonNumbers.get(sn) ?? 0) + 1);

    // 1. classifier agreement
    const cls = X.nonEpisodicClass(title);
    const looksSide = LOOKS_SIDE_FORMAT.test(title);
    const row = { series: series.seriesTitle ?? series.seriesId, season: title, seasonNumber: sn, episodes: eps.length };
    if (cls) out.flagged.push({ ...row, as: cls[0] });
    else if (looksSide) out.missed.push(row);
    if (cls && !looksSide) out.overFlagged.push({ ...row, as: cls[0] });

    // 2. JSON-LD `name` shapes
    for (const ld of season.jsonLd ?? []) {
      const name = ld?.data?.name;
      if (typeof name !== "string") continue;
      const shape = shapeOf(name);
      const bucket = out.nameShapes.get(shape) ?? { count: 0, examples: [] };
      bucket.count++;
      if (bucket.examples.length < 3) bucket.examples.push(name);
      out.nameShapes.set(shape, bucket);
      // does the parser get a usable title out of it?
      const cands = X.contentTitleCandidates(name, ld?.data?.partOfSeason?.name, ld?.data?.partOfSeries?.name);
      if (!cands.length) bucket.unparsed = (bucket.unparsed ?? 0) + 1;
    }
  }

  // 3 + 4. numbering convention, from the episode lists themselves
  const numbered = seasons.filter((s) => !s.error && (s.episodes ?? []).length && Number.isInteger(s.season_number));
  const ordered = [...numbered].sort((a, b) => a.season_number - b.season_number);
  if (ordered.length >= 2) {
    const later = ordered.slice(1);
    const restarts = later.filter((s) => (s.episodes[0]?.episode_number ?? null) === 1).length;
    const continues = later.filter((s) => (s.episodes[0]?.episode_number ?? 0) > 1).length;
    const verdict =
      restarts && !continues ? "season-relative" : continues && !restarts ? "absolute" : restarts || continues ? "MIXED" : "unknown";
    out.numbering.push({
      series: series.seriesTitle ?? series.seriesId,
      seasons: ordered.length,
      episodes: seriesEpisodes,
      verdict,
      firstEpisodeNumbers: ordered.map((s) => `S${s.season_number}:${s.episodes[0]?.episode_number ?? "?"}`).join(" "),
    });
  }
  if (seriesEpisodes >= 100 && seasons.length >= 3) {
    out.longRunners.push({ series: series.seriesTitle ?? series.seriesId, seasons: seasons.length, episodes: seriesEpisodes });
  }
}

// A coarse signature: digits collapsed, so "…| E1 - …" and "…| E12 - …" group.
function shapeOf(name) {
  const pipe = name.indexOf("|");
  if (pipe < 0) return "NO PIPE";
  const after = name.slice(pipe + 1).trim();
  const before = name.slice(0, pipe).trim();
  const code = after.match(/^E([A-Za-z0-9]{1,8})\s*[-–—]/);
  const dup = X.looseTitle(before) === X.looseTitle(after.replace(/^E[A-Za-z0-9]{1,8}\s*[-–—]\s*/, ""));
  if (!code) return X.looseTitle(before) === X.looseTitle(after) ? "PIPE, NO CODE, halves identical" : "PIPE, NO CODE, halves differ";
  const kind = /^\d+$/.test(code[1]) ? "numeric" : "non-numeric";
  return `PIPE + E<${kind}> code${dup ? ", halves identical" : ", halves differ"}`;
}

// ── report ──────────────────────────────────────────────────────────────────
const h = (s) => `\n${s}\n${"─".repeat(s.length)}`;
console.log(`Analysed ${seriesList.length} series, ${out.seasons} seasons, ${out.episodes} episodes.`);
if (out.errored) {
  console.log(
    `${out.errored} season(s) failed to fetch — their episode lists are absent, not empty. ` +
      `Re-run to fill them in; conclusions below cover only what was collected.`
  );
}
if (data.errors?.length) console.log(`(${data.errors.length} collection error(s) — see the JSON.)`);

console.log(h("1. Non-episodic classification"));
console.log(`   flagged as a side format : ${out.flagged.length}`);
for (const r of out.flagged.slice(0, 25)) console.log(`     [${r.as}] ${r.series} — "${r.season}" (season ${r.seasonNumber}, ${r.episodes} ep)`);
if (out.flagged.length > 25) console.log(`     …and ${out.flagged.length - 25} more`);
console.log(`\n   MISSED — reads as a side format but the classifier says episodic: ${out.missed.length}`);
if (!out.missed.length) console.log("     (none — no Mugen-Train-shaped gaps in this sample)");
for (const r of out.missed) console.log(`     ${r.series} — "${r.season}" (season ${r.seasonNumber}, ${r.episodes} ep)`);
if (out.overFlagged.length) {
  console.log(`\n   flagged but NOT obviously a side format (check for false positives): ${out.overFlagged.length}`);
  for (const r of out.overFlagged.slice(0, 15)) console.log(`     [${r.as}] ${r.series} — "${r.season}"`);
}

console.log(h("2. JSON-LD `name` shapes"));
if (!out.nameShapes.size) console.log("   (no JSON-LD collected — diagnose() said it wasn't fetchable)");
for (const [shape, b] of [...out.nameShapes].sort((a, c) => c[1].count - a[1].count)) {
  console.log(`   ${String(b.count).padStart(4)}  ${shape}${b.unparsed ? `   ⚠ ${b.unparsed} yielded NO usable title` : ""}`);
  for (const e of b.examples) console.log(`         e.g. ${JSON.stringify(e.slice(0, 110))}`);
}

console.log(h("3. Crunchyroll's episode numbering (answers the open question)"));
for (const r of out.numbering.sort((a, b) => b.episodes - a.episodes)) {
  const mark = r.verdict === "MIXED" ? " ⚠" : "";
  console.log(`   ${r.verdict.padEnd(15)}${mark} ${r.series} (${r.seasons} seasons, ${r.episodes} ep)  ${r.firstEpisodeNumbers}`);
}

console.log(h("4. Naruto-shaped candidates (100+ episodes, 3+ seasons)"));
if (!out.longRunners.length) console.log("   (none in this sample)");
for (const r of out.longRunners.sort((a, b) => b.episodes - a.episodes)) {
  const n = out.numbering.find((x) => x.series === r.series);
  console.log(`   ${r.series} — ${r.seasons} seasons, ${r.episodes} episodes, numbering: ${n?.verdict ?? "unknown"}`);
}

console.log(h("5. Episode lists that don't match their declared count"));
if (!out.truncated.length) console.log("   (none — every season's episode list is complete)");
for (const r of out.truncated.slice(0, 20)) {
  console.log(`   ⚠ ${r.series} — "${r.season}": declared ${r.declared}, got ${r.got}`);
}
if (out.truncated.length > 20) console.log(`   …and ${out.truncated.length - 20} more`);

console.log(h("6. season_number values seen"));
console.log(
  "   " +
    [...out.seasonNumbers].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}×${v}`).join("  ")
);
console.log("");
