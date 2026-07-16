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
//   - g/p/m: collected from the first 3 senses that have at least one gloss
//     (see the sense-selection budget fix below for a 2026-07-11 correction
//     to this). partOfSpeech/misc codes are a deduped union across the same
//     senses, in first-occurrence order.
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
//   - Sense-selection budget (g/p/m) now only spends its 3-slot budget on
//     senses that end up VISIBLE after gloss dedup, not every sense merely
//     considered — added 2026-07-11 after live testing on よ (JMdict id
//     2029090) found 2 of its 4 senses being wasted (one dedup-emptied
//     entirely, still charged against the budget) which meant the popup
//     could only ever show 2 near-duplicate rows and never reached the
//     entry's genuinely distinct 4th (`int`) sense. See selectSensesView.
//   - Per-reading sense filtering for entries with `appliesToKana`
//     restrictions — added 2026-07-11 after live testing found な/なあ (one
//     shared JMdict entry, id 2029110) always showing な's own
//     appliesToKana:["な"]-restricted senses ("don't"/"do") even when the
//     reading actually being looked up was なあ. Affects 802 of 217768
//     entries (confirmed count against the raw release); every other entry
//     is unaffected and takes the original single-entry-per-word path. Does
//     NOT do the symmetric fix for `appliesToKanji` restrictions (463
//     entries) — no live-test case has shown that one actually producing a
//     wrong card yet. See hasKanaRestriction/sensesForReading.
//   - `si`: per-sense array (parallel to `g`, same indices/length) of JMdict's
//     `info` (s_inf) annotation text for that sense, joined with "; " when a
//     sense carries more than one — "" for a visible sense with no note.
//     Included on the entry only when at least one sense has a non-empty
//     note. Added 2026-07-15 after よ's popup showed sense 1 as a bare "hey;
//     you" with no indication it's a sentence-final particle used for
//     certainty/emphasis/contempt/etc. — that qualifier is real JMdict data
//     (s_inf), just never carried into the compact format. Scanned the raw
//     release before adding this rather than assuming: prt (62.8%) and int
//     (23.3%) senses carry a note far more often than content-word POS
//     (nouns 1.5%, verbs 3-6%, adjectives 2-7%), confirming the intuition
//     that function words need this more — but when a content-word sense
//     DOES have one, it's typically NOT redundant register/dialect info
//     already covered by the archaic badge; it's substantive grammatical-
//     construction info (らしい: "after the plain form of a verb or
//     adjective...") or kanji-nuance disambiguation (あう: "逢う is often used
//     for close friends... 遭う may have an undesirable nuance") that the
//     existing archaic-badge/kanji-rarity mechanisms don't cover at all. So
//     this is NOT scoped to prt/int-primary entries the way the sense-budget
//     fix above is — it's included for any visible sense on any entry,
//     regardless of POS. Cost is negligible either way: only 6,668 of
//     252,198 senses in the whole raw release carry a note at all (2.6%),
//     ~160KB of raw text total.
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

// Builds a `{ g, p, m }` view from a (possibly pre-filtered — see
// selectSensesByReading below) list of raw senses, applying the 3-sense
// display budget and cross-sense gloss dedup.
//
// The budget is only spent on senses that actually end up VISIBLE (non-empty
// after dedup), not on every sense merely considered — added 2026-07-11,
// fixing a real bug found via live testing on よ (JMdict id 2029090, 4
// senses: "hey; you" / "hey" / "hey; hold on" / int "yo; hey"). The old
// budget-counts-everything version spent 2 of its 3 slots on sense 0 ("hey;
// you") and sense 1 ("hey" — fully swallowed by dedup, since "hey" was
// already seen, leaving an EMPTY g row that still cost a slot), then spent
// its last slot on sense 2, leaving no room to ever reach sense 3 (the
// distinct `int` "yo; hey" sense) — so the popup only ever showed 2
// low-information, near-duplicate rows ("hey; you" / "hold on") no matter
// which of よ's real, distinct discourse functions (assertive vs.
// attention-getting) prompted the lookup. Now sense 1's dedup-emptied row is
// skipped without spending a slot, so sense 3 is reached and shown too.
function selectSensesView(senses, budget = 3) {
  const g = [];
  const si = [];
  const gSeen = new Set();
  const pGroups = [];
  let firstVisibleMisc = null;
  let sensesShown = 0;
  for (const s of senses) {
    if (sensesShown >= budget) break;
    if (!s.gloss.length) continue;
    const senseGlosses = [];
    for (const gl of s.gloss.slice(0, 3)) {
      if (gSeen.has(gl.text)) continue;
      gSeen.add(gl.text);
      senseGlosses.push(gl.text);
    }
    // Still contributes to p regardless of whether it ends up visible in g —
    // matches the original algorithm's intent that p reflects everything
    // looked at while filling the budget, not just what rendered.
    pGroups.push(s.partOfSpeech);
    if (senseGlosses.length > 0) {
      // `m` deliberately tracks the misc of whichever sense produced g[0]
      // (previously always senses[0], since a first sense can never itself
      // be dedup-emptied — nothing's been seen yet — so this is a strict
      // generalization of the prior behavior, not a change to it), not a
      // union across all included senses/readings (2026-07-06 fix) — that
      // was the original design, but live testing found it actively wrong
      // once archaicTagLabel() (content.js) started checking every card, not
      // just duplicates: こと's entry has an `arch`-tagged SECOND sense
      // ("stringed instrument") while its first/primary sense ("koto,
      // 13-stringed zither") isn't archaic at all, so the union wrongly
      // tagged the whole common-word card "archaic"; 君 has the same shape
      // with `obs` on its third sense.
      if (firstVisibleMisc === null) firstVisibleMisc = s.misc;
      g.push(senseGlosses);
      si.push(s.info && s.info.length > 0 ? s.info.join("; ") : "");
      sensesShown++;
    }
  }
  return { g, si, p: dedupedUnion(pGroups), m: firstVisibleMisc ?? [] };
}

// True when at least one sense restricts which kana reading(s) it applies to
// (JMdict's `appliesToKana`, e.g. な/なあ/なー/なぁ share one entry, but its
// "don't"/"do" senses are tagged appliesToKana: ["な"] — they're specifically
// the prohibitive-particle な, not the attention-getting/admiring なあ family
// that shares the same entry). The overwhelmingly common case (a sense
// applying to every reading, appliesToKana: ["*"]) is unaffected — this only
// ever changes output for the ~0.4% of entries (802 of 217768, confirmed by
// direct count against the raw release) that actually carry a restriction.
// Particle/interjection entries get a higher sense budget (8, vs. the
// default 3) — added 2026-07-13 after live testing found real senses cut off
// for common function words: の's sentence-final question sense (6th
// position) and ただ今's "right away" sense (4th position) were both real,
// distinct, frequently-needed senses lost purely to the fixed cap, not a
// context-disambiguation problem (see the popup's own numbered-sense
// design — this doesn't try to guess which sense fits a given sentence,
// just shows more of what's real).
//
// Scoped to prt/int-PRIMARY entries specifically (the first sense with a
// gloss is tagged "prt" or "int"), not raised globally — confirmed via a
// direct scan of the raw release that content words (verbs/nouns/
// adjectives) have a long, effectively unbounded tail of legitimate senses
// (落ちる has 27, する has 17, とる has 18, ...; 273 COMMON entries exceed 6
// senses) where even a doubled cap would still constantly cut real content
// and just clutters the popup for the common case instead. Particles/
// interjections are a fundamentally different shape: a small, closed set of
// distinct GRAMMATICAL FUNCTIONS rather than open-ended semantic extension —
// confirmed only 806 entries are prt/int-primary at all, and raising their
// budget to 8 fully covers 802 of those 806 (99.5%), including both
// confirmed cases (の needs 6, ただ今 needs 4). The 4 remaining outliers (か:
// 15 senses, が: 10, に: 9, quotative って: 9 — already handled separately by
// the primary-reading-preference fix above) are words whose real usage is
// this genuinely broad; accepting a partial list for those 4 is a much
// smaller tradeoff than the alternative (an unbounded cap that stops
// protecting against clutter for every polysemous common verb).
function isFunctionWordPrimary(senses) {
  const firstWithGloss = senses.find((s) => s.gloss.length > 0);
  if (!firstWithGloss) return false;
  return firstWithGloss.partOfSpeech.includes("prt") || firstWithGloss.partOfSpeech.includes("int");
}
const FUNCTION_WORD_SENSE_BUDGET = 8;

function hasKanaRestriction(senses) {
  return senses.some((s) => {
    const atk = s.appliesToKana;
    return atk && atk.length > 0 && !(atk.length === 1 && atk[0] === "*");
  });
}

// Senses applicable to one specific kana reading: appliesToKana ["*"] (all
// readings) or a list explicitly including this reading.
function sensesForReading(senses, readingText) {
  return senses.filter((s) => {
    const atk = s.appliesToKana;
    if (!atk || atk.length === 0) return true;
    if (atk.length === 1 && atk[0] === "*") return true;
    return atk.includes(readingText);
  });
}

for (const w of raw.words) {
  if (!w.kana.length) continue;

  const readings = w.kana.map((k) => k.text);
  const r = readings[0];

  const senseBudget = isFunctionWordPrimary(w.sense) ? FUNCTION_WORD_SENSE_BUDGET : 3;
  const { g, si, p, m } = selectSensesView(w.sense, senseBudget);
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
  if (si.some((x) => x)) entry.si = si;

  const idx = entries.length;
  entries.push(entry);

  const kanjiTexts = new Set(w.kanji.map((k) => k.text));
  if (!hasKanaRestriction(w.sense)) {
    // Fast, unchanged path for the ~99.6% of entries with no per-sense kana
    // restriction — every kanji/kana form indexes straight to the one entry
    // just built, exactly as before this fix.
    for (const key of new Set([...kanjiTexts, ...readings])) addToIndex(key, idx);
    continue;
  }

  // Kanji forms still all point at the primary entry (built from the
  // primary reading's applicable senses) — a kanji spelling's OWN sense
  // restrictions (`appliesToKanji`) are a separate, symmetric gap (463 of
  // 217768 entries) not fixed here, since no live-test case has actually
  // shown it producing a wrong card yet, unlike this kana-side one.
  for (const key of kanjiTexts) addToIndex(key, idx);

  // Each kana reading gets senses filtered to what actually applies to IT,
  // not the primary reading's senses reused wholesale — confirmed real via
  // live testing: な/なあ/なー/なぁ all share one JMdict entry (id 2029110),
  // but its first two senses ("don't" / "do") are tagged
  // appliesToKana: ["な"] specifically (JMdict's own signal that these are
  // the prohibitive-particle な, not shared with なあ's attention-getting/
  // admiring family) — the unfiltered version showed those な-only senses
  // for EVERY reading including なあ, so a なあ lookup (すぐ元に…なあ) showed
  // "don't"/"do" nonsense instead of なあ's real senses. A reading whose
  // filtered view is IDENTICAL to the primary reading's (the common case
  // even among these 802 entries — most kana-restricted entries restrict
  // only ONE of several readings) just reuses the primary entry rather than
  // creating a redundant duplicate.
  const primarySenses = sensesForReading(w.sense, r);
  for (const readingText of new Set(readings)) {
    const thisSenses = sensesForReading(w.sense, readingText);
    if (
      thisSenses.length === primarySenses.length &&
      thisSenses.every((s, i) => s === primarySenses[i])
    ) {
      addToIndex(readingText, idx);
      continue;
    }
    const view = selectSensesView(thisSenses, isFunctionWordPrimary(thisSenses) ? FUNCTION_WORD_SENSE_BUDGET : 3);
    if (view.g.length === 0) {
      // Defensive fallback only — every real case checked has at least one
      // sense applying to every non-primary reading it lists, so this
      // shouldn't trigger, but an empty g would break content.js's rendering.
      addToIndex(readingText, idx);
      continue;
    }
    const variant = { r, g: view.g, p: view.p };
    if (common) variant.c = true;
    if (readings.length > 1) variant.rs = readings;
    if (view.m.length > 0) variant.m = view.m;
    if (ki.length > 0) variant.ki = ki;
    if (kanjiSpellings.length > 0) variant.k = kanjiSpellings;
    if (view.si.some((x) => x)) variant.si = view.si;
    const variantIdx = entries.length;
    entries.push(variant);
    addToIndex(readingText, variantIdx);
  }
}

console.log(`Built ${entries.length} entries, ${Object.keys(index).length} index keys.`);

const compact = { entries, index, posTags };

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
