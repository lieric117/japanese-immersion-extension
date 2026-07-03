// One-time offline fix for jmdict-compact.json's index ordering.
//
// Bug: entries whose kana reading is common but whose kanji form is rarely
// used in real writing (e.g. 居る "to be", tagged rK = "rarely-used kanji")
// ranked behind common-kanji homographs (射る, 炒る, 入る, 要る, 鋳る) for the
// key "いる" — purely because of raw JMdict entry-ID order, not usage
// frequency.
//
// jmdict-simplified's public JSON only exposes a collapsed `common` boolean
// per kanji/kana (not the underlying ichi/news/spec tier or nfXX frequency
// rank), so this can't be fixed by "sort by priority" — that data isn't in
// the source at all. Instead this uses the rK/rk/sK/sk ("rarely-used
// kanji"/"search-only kanji") tags already present on kanji elements: an
// entry whose kanji form(s) are ALL tagged this way (or which has no kanji at
// all) is a word that's conventionally WRITTEN in kana, so it should rank
// ahead of other common entries when the lookup key itself is kana-only.
//
// Doesn't regenerate jmdict-compact.json's entries/posTags from scratch (that
// data is unaffected by this bug and re-deriving it risks unrelated drift) —
// only adds a `kp` (kana-primary) flag to matched entries and re-orders each
// index array so common + kana-primary entries come first.
//
// Usage: node fix-jmdict-priority.js <path-to-raw-jmdict-eng.json>
// The raw jmdict-simplified release (~117MB) isn't checked into the repo —
// download the current jmdict-eng-*.json.zip from
// https://github.com/scriptin/jmdict-simplified/releases and unzip it first.

const fs = require("fs");
const path = require("path");

const rawPath = process.argv[2];
if (!rawPath) {
  console.error("Usage: node fix-jmdict-priority.js <path-to-raw-jmdict-eng.json>");
  process.exit(1);
}

const COMPACT_PATH = path.join(__dirname, "..", "jmdict-compact.json");
const RARE_KANJI_TAGS = new Set(["rK", "rk", "sK", "sk"]);

console.log("Loading compact dictionary...");
const compact = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));

console.log("Loading raw jmdict-simplified release (large file, may take a moment)...");
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));

console.log("Indexing raw entries by (primary kana, first gloss)...");
const rawKanaPrimaryByKey = new Map();
for (const w of raw.words) {
  if (!w.kana.length || !w.sense.length) continue;
  const firstSenseWithGloss = w.sense.find((s) => s.gloss.length);
  if (!firstSenseWithGloss) continue;
  const key = w.kana[0].text + "||" + firstSenseWithGloss.gloss[0].text;
  if (rawKanaPrimaryByKey.has(key)) continue; // rare collision — keep first match
  const kanaPrimary =
    w.kanji.length === 0 ||
    w.kanji.every((k) => k.tags.some((t) => RARE_KANJI_TAGS.has(t)));
  rawKanaPrimaryByKey.set(key, kanaPrimary);
}

console.log("Tagging compact entries...");
let tagged = 0;
let unmatched = 0;
for (const entry of compact.entries) {
  const key = entry.r + "||" + entry.g[0];
  if (!rawKanaPrimaryByKey.has(key)) {
    unmatched++;
    continue;
  }
  if (rawKanaPrimaryByKey.get(key)) {
    entry.kp = true;
    tagged++;
  }
}
console.log(
  `Marked ${tagged} entries as kana-primary. ${unmatched} of ${compact.entries.length} entries had no raw match (left unchanged).`
);

console.log("Re-sorting index arrays (common + kana-primary entries first)...");
let reordered = 0;
for (const key of Object.keys(compact.index)) {
  const indices = compact.index[key];
  if (indices.length < 2) continue;
  const isBoosted = (i) => compact.entries[i].kp && compact.entries[i].c;
  if (!indices.some(isBoosted)) continue;
  const boosted = indices.filter(isBoosted);
  const rest = indices.filter((i) => !isBoosted(i));
  compact.index[key] = [...boosted, ...rest];
  reordered++;
}
console.log(`Re-ordered ${reordered} index keys.`);

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
