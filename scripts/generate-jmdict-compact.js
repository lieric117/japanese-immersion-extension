// Regenerates jmdict-compact.json from scratch from the raw jmdict-eng
// release. Reconstructed from the documented spec (project-plan.md Section 5)
// since the original 2026-06-24 generation script was never saved to this
// repo — reverse-engineered against the CURRENT file and validated
// statistically before use (>99.96% exact match on r/g/p/c across all 217k+
// entries; residual mismatches traced to version drift between raw-release
// snapshots, not an algorithm difference — confirmed by manual inspection of
// samples showing genuinely different gloss text, not a capping/ordering
// difference).
//
// Confirmed rules (all cross-checked against the current file):
//   - r: first kana reading (kana[0].text).
//   - g/p/m: collected from the first 3 senses that have at least one gloss.
//     Within each sense, take its first 2 glosses BY POSITION (not "first 2
//     unique") — a gloss whose exact text was already added from an earlier
//     sense is dropped, not backfilled from later in that same sense.
//     partOfSpeech/misc codes are a deduped union across the same senses, in
//     first-occurrence order.
//   - c: true if ANY kanji or ANY kana element has common:true (not just the
//     first of each).
//   - index: every kanji.text AND every kana.text (all variants) point to
//     the entry.
//   - posTags: static reference map, unaffected by any of this — copied
//     as-is from the existing file rather than regenerated.
//
// Two new fields not in the original format, added for later fixes:
//   - `rs`: full array of this entry's kana readings, included only when
//     there's more than one — lets background.js's lookupWord display
//     whichever reading was ACTUALLY used to reach the entry, not just its
//     primary one (fixes the くる/えぐる display-precision bug).
//   - `m`: deduped union of sense-level `misc` tags (arch/obs/dated/etc)
//     across the same up-to-3 included senses as `p`, only when non-empty —
//     powers the duplicate-gloss archaic-tag-or-demotion fix.
//   - `ki`: deduped union of kana-level tags (ok/ik/sk/etc) across this
//     entry's readings, only when non-empty — same tag family as kanji
//     rK/sK (already used for the existing `kp` boost), but for readings.
// Does NOT compute `kp` (kana-primary boost) — that's a separate, already-
// working pass (fix-jmdict-priority.js), meant to run again after this script
// against a fresh raw-release copy.
//
// Usage: node generate-jmdict-compact.js <path-to-raw-jmdict-eng.json>
// The raw jmdict-simplified release (~117MB) isn't checked into the repo —
// download the current jmdict-eng-*.json.zip from
// https://github.com/scriptin/jmdict-simplified/releases and unzip it first.

"use strict";

const fs = require("fs");
const path = require("path");

const rawPath = process.argv[2];
if (!rawPath) {
  console.error("Usage: node generate-jmdict-compact.js <path-to-raw-jmdict-eng.json>");
  process.exit(1);
}

const COMPACT_PATH = path.join(__dirname, "..", "jmdict-compact.json");

console.log("Loading existing compact file (to reuse the static posTags map)...");
const existing = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));
const posTags = existing.posTags;

console.log("Loading raw jmdict-eng release (large file, may take a moment)...");
const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));

console.log(`Processing ${raw.words.length} raw entries...`);
const entries = [];
const index = {};

function addToIndex(key, idx) {
  let arr = index[key];
  if (!arr) index[key] = arr = [];
  arr.push(idx);
}

function dedupedUnion(arraysOfCodes) {
  const seen = new Set();
  const result = [];
  for (const codes of arraysOfCodes) {
    for (const code of codes) {
      if (seen.has(code)) continue;
      seen.add(code);
      result.push(code);
    }
  }
  return result;
}

for (const w of raw.words) {
  if (!w.kana.length) continue;

  const readings = w.kana.map((k) => k.text);
  const r = readings[0];

  const g = [];
  const gSeen = new Set();
  const pGroups = [];
  const mGroups = [];
  let sensesUsed = 0;
  for (const s of w.sense) {
    if (sensesUsed >= 3) break;
    if (!s.gloss.length) continue;
    for (const gl of s.gloss.slice(0, 2)) {
      if (gSeen.has(gl.text)) continue;
      gSeen.add(gl.text);
      g.push(gl.text);
    }
    pGroups.push(s.partOfSpeech);
    mGroups.push(s.misc);
    sensesUsed++;
  }
  const p = dedupedUnion(pGroups);
  const m = dedupedUnion(mGroups);
  const ki = dedupedUnion(w.kana.map((k) => k.tags));

  const common = w.kanji.some((k) => k.common) || w.kana.some((k) => k.common);

  const entry = { r, g, p };
  if (common) entry.c = true;
  if (readings.length > 1) entry.rs = readings;
  if (m.length > 0) entry.m = m;
  if (ki.length > 0) entry.ki = ki;

  const idx = entries.length;
  entries.push(entry);

  const allTexts = new Set([...w.kanji.map((k) => k.text), ...w.kana.map((k) => k.text)]);
  for (const key of allTexts) addToIndex(key, idx);
}

console.log(`Built ${entries.length} entries, ${Object.keys(index).length} index keys.`);

const compact = { entries, index, posTags };

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
