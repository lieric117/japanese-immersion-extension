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
//     partOfSpeech/misc codes are a deduped union across the same senses, in
//     first-occurrence order.
//   - c: true if ANY kanji or ANY kana element has common:true (not just the
//     first of each).
//   - index: every kanji.text AND every kana.text (all variants) point to
//     the entry.
//   - posTags: static reference map, unaffected by any of this — copied
//     as-is from the existing file rather than regenerated.
//
// Fields added after the original format, for later fixes:
//   - `rs`: full array of this entry's kana readings, included only when
//     there's more than one — lets background.js's lookupWord display
//     whichever reading was ACTUALLY used to reach the entry, not just its
//     primary one (fixes the くる/えぐる display-precision bug).
//   - `m`: the FIRST included sense's own `misc` tags (arch/obs/dated/etc),
//     only when non-empty — powers the duplicate-gloss/archaic-tag fix.
//     NOT a union across all up-to-3 included senses (that was the original
//     design, reverted 2026-07-06 — see the follow-up fix entry below for
//     why a later-sense-only tag like こと's arch-tagged 2nd sense or 君's
//     obs-tagged 3rd sense must not taint the card's primary, non-archaic
//     first sense).
//   - `ki`: the entry's PRIMARY reading's (`w.kana[0]`) own tags (ok/ik/etc),
//     only when non-empty — same tag family as kanji rK/sK (already used for
//     the existing `kp` boost), but for readings. NOT a union across every
//     alternate reading (reverted 2026-07-06 — an alternate reading's own
//     rare/irregular tag, e.g. じゃない's ik-tagged ぢゃない alternate, must
//     not taint the primary reading actually being shown).
//   - `k`: array of this entry's kanji spellings, included only when
//     non-empty (kana-only entries have none) — added 2026-07-06 so a
//     homograph popup card can show WHICH kanji spelling it's actually about
//     (いる → 居る/入る/要る) instead of three identical kana headers.
//     Confirmed the raw release carries this per-entry (射る/炒る・煎る・熬る/入る
//     for いる's first three senses) but the compact format was discarding it
//     entirely before this field existed. Excludes rK/sK/oK/iK-tagged forms
//     (rare/search-only/out-dated/irregular kanji, e.g. 來る — 来る's obsolete
//     kyūjitai form) as of the same-day follow-up fix below, falling back to
//     the unfiltered list only if every form happens to be tagged rare.
//   - `g` is now GROUPED BY SENSE (array of arrays — one sub-array per
//     included sense) instead of one flattened array, added 2026-07-06 to
//     support numbered sense display (1., 2., 3.) in the popup. Each sense's
//     sub-array takes its first 3 glosses BY POSITION (bumped from 2,
//     2026-07-06) — a gloss whose exact text was already added from an
//     earlier sense is dropped, not backfilled from later in that same
//     sense, same dedup rule as before, just no longer flattening the result
//     away. A sense that loses every one of its glosses to dedup is dropped
//     entirely (not kept as an empty numbered row) — rare in practice, since
//     real JMdict senses essentially never fully duplicate an earlier sense.
//     Consumers that expect a flat array/string (content.js's duplicate-gloss
//     first-gloss check, fix-jmdict-priority.js's fingerprint key) now read
//     `g[0]?.[0]` instead of `g[0]`.
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
    const senseGlosses = [];
    for (const gl of s.gloss.slice(0, 3)) {
      if (gSeen.has(gl.text)) continue;
      gSeen.add(gl.text);
      senseGlosses.push(gl.text);
    }
    // Counts against the 3-sense budget and contributes to p/m regardless —
    // matches the original algorithm's counting exactly. Only whether an
    // empty (fully-deduped) sense's sub-array gets pushed to g changes, so a
    // sense that lost every gloss to dedup doesn't render as an empty
    // numbered row — rare in practice, real JMdict senses essentially never
    // fully duplicate an earlier sense.
    if (senseGlosses.length > 0) g.push(senseGlosses);
    pGroups.push(s.partOfSpeech);
    mGroups.push(s.misc);
    sensesUsed++;
  }
  const p = dedupedUnion(pGroups);
  // `m`/`ki` deliberately do NOT union across all included senses/readings
  // (2026-07-06 fix) — that was the original design, but live testing found
  // it actively wrong once archaicTagLabel() (content.js) started checking
  // every card, not just duplicates: こと's entry has an `arch`-tagged SECOND
  // sense ("stringed instrument") while its first/primary sense ("koto,
  // 13-stringed zither") isn't archaic at all, so the union wrongly tagged
  // the whole common-word card "archaic"; 君 has the same shape with `obs`
  // on its third sense; じゃない's entry has NO misc tags anywhere, but its
  // kana array's alternate reading ぢゃない is tagged `ik`, and the old
  // ki-as-union wrongly leaked that onto the primary じゃない reading, which
  // carries no tags of its own. `m` now reflects only the FIRST included
  // sense's own misc tags (the sense driving the first-gloss duplicate
  // check and the card's primary identity) and `ki` only the entry's
  // PRIMARY reading's own tags (`w.kana[0]`) — not every alternate reading's
  // tags conflated together. Known residual gap, not fixed here: if a user
  // clicks a specific ALTERNATE reading via the `rs`-swap mechanism
  // (background.js) that happens to be archaic/dated while the primary
  // reading isn't, the badge won't reflect that specific reading — no real
  // case of this has turned up in testing, so not building for it now.
  const m = mGroups[0] ?? [];
  const ki = w.kana[0]?.tags ?? [];
  // Excludes rK/sK/oK/iK-tagged forms (rare/search-only/out-dated/irregular
  // kanji — confirmed real counts in the raw release: sK 14831, rK 5732,
  // iK 604, oK 538) — added 2026-07-06 so the kanji-spelling-on-homograph-
  // cards feature shows only standard modern spellings, not e.g. 來る
  // (来る's obsolete kyūjitai form, sK) or ぢゃ無い (じゃない's non-standard
  // kanji form, also sK). Deliberately does NOT filter `ateji`/`io`
  // (phonetic-substitution kanji like 寿司, irregular okurigana) — neither
  // signals "rare/wrong," just "unusual," and real common words use both.
  // Deliberately does NOT fall back to the unfiltered list when every kanji
  // form is tagged rare — confirmed that's the correct outcome, not an
  // over-filtering artifact: じゃない's two kanji forms (じゃ無い, ぢゃ無い) are
  // BOTH tagged sK, and じゃない genuinely has no standard modern kanji
  // spelling at all — an entry where every kanji form is rare/search-only IS
  // exactly the "conventionally kana-only" signal, not an edge case to work
  // around. `k` simply ends up omitted for these (see below), same as any
  // other kana-only entry.
  const RARE_KANJI_TAGS = new Set(["rK", "sK", "oK", "iK"]);
  const kanjiSpellings = w.kanji.filter((k) => !k.tags.some((t) => RARE_KANJI_TAGS.has(t))).map((k) => k.text);

  const common = w.kanji.some((k) => k.common) || w.kana.some((k) => k.common);

  const entry = { r, g, p };
  if (common) entry.c = true;
  if (readings.length > 1) entry.rs = readings;
  if (m.length > 0) entry.m = m;
  if (ki.length > 0) entry.ki = ki;
  if (kanjiSpellings.length > 0) entry.k = kanjiSpellings;

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
