// One-time offline pass adding a `jlpt` field ("N5".."N1") to
// jmdict-compact.json entries, sourced from an external list — jmdict-simplified
// carries no JLPT data at all (confirmed 2026-07-04, see project-plan.md
// Decisions Log).
//
// Data source: stephenmk/yomitan-jlpt-vocab's original_data/*.csv
// (jlpt-data/n1.csv..n5.csv in this repo), which packages Jonathan Waller's
// JLPT Resources vocabulary list — the same underlying list Jisho.org uses
// for its own JLPT tags. CC BY-SA 4.0, see jlpt-data/README.md and
// jlpt-data/LICENSE.txt for the full attribution requirement (not yet
// surfaced anywhere user-facing — tracked for Phase 7 packaging).
//
// Chosen over the elzup/jlpt-word-list lineage (same underlying Waller data,
// but re-licensed MIT downstream with no JMdict-seq keys) specifically
// because every row here already carries the exact JMdict `ent_seq` —
// jmdict-compact.json's own `id` field (added 2026-07-19 for exactly this
// join) — so this is a direct ID match, not fuzzy kanji/reading matching like
// the TUBELEX frequency merge needed (and which caused a real cross-reading
// contamination bug there — see apply-tubelex-frequency.js).
//
// No ordering dependency on fix-jmdict-priority.js/build-orphaned-tier-
// overrides.js/apply-tubelex-frequency.js — this only needs `id` to already
// exist (set by generate-jmdict-compact.js) and doesn't touch index ordering,
// so it's safe to run any time after that. Documented as running last in the
// regen pipeline purely by convention (append-only field, least reason to
// re-run after it).
//
// Caveat inherited directly from the source (see jlpt-data/README.md): no
// official JLPT vocabulary list has existed since 2010, so this is a
// community "educated guess," not authoritative — matches this project's
// existing rule that JLPT level is opt-in/off-by-default only, never an
// always-visible label.
//
// Usage: node apply-jlpt-level.js
const fs = require("fs");
const path = require("path");

const COMPACT_PATH = path.join(__dirname, "..", "jmdict-compact.json");
const JLPT_DATA_DIR = path.join(__dirname, "jlpt-data");
const LEVELS = ["n5", "n4", "n3", "n2", "n1"]; // easiest first — resolves conflicts to the easier level, see conflict note below

console.log("Loading compact dictionary...");
const compact = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));

console.log("Loading JLPT level lists...");
// jmdict_seq (string) -> "N5".."N1"
//
// ~450 of ~8,300 source rows (checked directly, not assumed) turn out to
// share a jmdict_seq with a row on a DIFFERENT level list — inspected a
// sample and confirmed this is not a parsing bug: it's Waller's list
// distinguishing different SPELLINGS of the same JMdict entry by level
// (1198180: 会う read あう is N5, the same entry's 遭う spelling is N2). Since
// jmdict-compact.json's `id` is per-entry, not per-spelling, that distinction
// can't be preserved through this join — resolved by keeping the easier
// level, a reasonable default given the compact format already treats one
// entry's various kanji spellings as informational rather than separate.
const levelBySeq = new Map();
let conflicts = 0;
for (const level of LEVELS) {
  const csvPath = path.join(JLPT_DATA_DIR, `${level}.csv`);
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split("\n");
  for (let i = 1; i < lines.length; i++) {
    // Fields beyond the first are quoted/commas-containing free text
    // (waller_definition) — only jmdict_seq (always a plain leading integer)
    // is needed here, so a full CSV parse isn't necessary.
    const line = lines[i];
    if (!line) continue;
    const commaIdx = line.indexOf(",");
    const seq = commaIdx === -1 ? line.trim() : line.slice(0, commaIdx);
    if (!seq) continue;
    const label = level.toUpperCase();
    if (levelBySeq.has(seq) && levelBySeq.get(seq) !== label) {
      conflicts++;
      continue; // keep the first (easier-level) assignment already set
    }
    levelBySeq.set(seq, label);
  }
}
console.log(`Loaded ${levelBySeq.size} JLPT-tagged JMdict entries across N5-N1${conflicts ? ` (${conflicts} cross-level conflicts kept at the easier level)` : ""}.`);

console.log("Assigning jlpt field by exact JMdict id match...");
let matched = 0;
for (const entry of compact.entries) {
  const level = entry.id !== undefined ? levelBySeq.get(entry.id) : undefined;
  if (level) {
    entry.jlpt = level;
    matched++;
  } else {
    delete entry.jlpt;
  }
}
console.log(`${matched} of ${compact.entries.length} entries matched a JLPT level (of ${levelBySeq.size} source entries — the gap is source words whose id isn't present in this JMdict release/compact build).`);

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
