// One-time offline fix for jmdict-compact.json's index ordering — real
// frequency data, superseding the earlier rK/sK kanji-rarity heuristic
// (fix-jmdict-priority.js) wherever it's actually available.
//
// Bug: homograph readings with no shared kanji at all can't be ordered by
// kanji-rarity (that heuristic only ranks a kana-only spelling ahead of a
// rare-kanji one) — こと's zither sense (琴) and thing/matter sense (事) are
// both ordinary, non-rare kanji, so nothing in JMdict itself says 事 is far
// more common in practice. jmdict-simplified's public JSON doesn't expose
// priority-tier data at all (confirmed 2026-07-01, see fix-jmdict-priority.js),
// so this needs real usage data from outside JMdict.
//
// Data source: TUBELEX-JA (naist-nlp/tubelex, BSD-3-Clause), a frequency list
// derived from ~163M tokens of Japanese YouTube subtitle text — casual spoken
// register, a good match for anime dialogue (unlike BCCWJ's formal-writing
// bias, which is also research/education-only licensed). Verified directly
// against the actual data (not just docs) that its lemma field distinguishes
// exact kanji spellings, not just readings: 事 → 1,105,160 vs 琴 → 372 vs the
// kana-only adverbial こと → 177, out of 337,757 unique lemmas.
//
// No need to re-touch the raw jmdict-eng release for this: jmdict-compact.json's
// own index already links every kanji spelling to the same entry object as its
// kana reading (confirmed: index["こと"] and index["事"] share entry 28920,
// index["こと"] and index["琴"] share entry 21996) — so a global "best surface
// form" frequency per entry can be built entirely from data already in this
// repo plus the TUBELEX file, by inverting the existing index.
//
// Usage:
//   1. Download the current release: https://github.com/naist-nlp/tubelex
//      (frequencies/tubelex-ja-lemma-pos.tsv.xz)
//   2. Decompress it to a plain .tsv (e.g. `unxz` or `python3 -c
//      "import lzma,shutil; shutil.copyfileobj(lzma.open('tubelex-ja-lemma-pos.tsv.xz'), open('tubelex-ja-lemma-pos.tsv','wb'))"`)
//   3. node apply-tubelex-frequency.js <path-to-decompressed-tsv>
//
// Also persists a `fr` (frequency-rank) tier per entry — "common"/"uncommon"/
// "rare" — added 2026-07-19 for the frequency-rank badge (Phase 5). Prior to
// this, the TUBELEX score was used only to SORT the index during generation
// and then discarded; there was no way to look up "how frequent is this
// word" at runtime at all. Thresholds are absolute TUBELEX occurrence counts,
// confirmed with the user against the real score distribution and boundary
// word spot-checks (not picked blind): score >= 500 -> common, >= 20 ->
// uncommon, >= 1 -> rare, 0 -> no field at all (no badge — absence of data
// isn't evidence of rarity, matches the 2026-07-04 tier-design decision).
//
// A `common:true` entry with score 0 (JMdict's own editors marked it common,
// but TUBELEX has literally no data — confirmed 2026-07-19: 3,224 such
// entries, e.g. でしょう/かもしれない/おかね, because TUBELEX's tokenizer
// doesn't lemmatize these as single units at all, unrelated to real
// frequency) is NOT left unbadged — it consults orphaned-tier-overrides.json
// (built separately by build-orphaned-tier-overrides.js, see that file's own
// header for the full corpus/nf-priority fallback methodology) instead of
// falling through to "no data". Every other 0-score entry (not JMdict-common)
// gets no `fr` field, same as before.
//
// Pipeline order matters: run generate-jmdict-compact.js, then
// fix-jmdict-priority.js, then build-orphaned-tier-overrides.js (produces
// orphaned-tier-overrides.json — needs its OWN inputs, see that file's
// header), THEN this script last. If orphaned-tier-overrides.json doesn't
// exist yet (e.g. a regen done before ever running that script), this
// silently skips the fallback rather than erroring — every entry still gets
// whatever tier its raw TUBELEX score alone would produce.
const fs = require("fs");
const path = require("path");

const overridesPath = path.join(__dirname, "orphaned-tier-overrides.json");
const orphanedOverrides = fs.existsSync(overridesPath) ? JSON.parse(fs.readFileSync(overridesPath, "utf8")) : {};

const tsvPath = process.argv[2];
if (!tsvPath) {
  console.error("Usage: node apply-tubelex-frequency.js <path-to-tubelex-ja-lemma-pos.tsv>");
  process.exit(1);
}

const COMPACT_PATH = path.join(__dirname, "..", "jmdict-compact.json");

console.log("Loading compact dictionary...");
const compact = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));

// Maps a JMdict POS code (jmdict-compact.json's `p` array) and a TUBELEX/
// UniDic top-level POS class (the "pos" column, e.g. "助詞-終助詞" — only the
// segment before the first "-" is used, UniDic's coarsest category) onto one
// shared category. Deliberately coarse (matches this project's existing
// POS_CATEGORY_MATCHERS pattern in background.js) — the goal is only to catch
// a clear cross-category mismatch (particle vs. noun), not fine sense
// disambiguation within the same category.
function jmdictCategory(p) {
  if (p.startsWith("v") || p === "aux-v") return "verb";
  if (p.startsWith("adj")) return "adj";
  if (p === "adv" || p === "adv-to") return "adv";
  if (p === "prt") return "particle";
  if (p === "conj") return "conj";
  if (p === "int") return "interjection";
  if (p === "pref" || p === "n-pref") return "prefix";
  if (p === "suf" || p === "n-suf") return "suffix";
  if (p === "pn") return "pronoun";
  if (p === "aux" || p === "aux-adj") return "aux";
  if (p === "exp") return "expr";
  if (p === "n" || p === "num" || p === "ctr") return "noun";
  return null;
}
const UNIDIC_TOP_CLASS_TO_CATEGORY = {
  名詞: "noun",
  動詞: "verb",
  形容詞: "adj",
  形状詞: "adj",
  副詞: "adv",
  連体詞: "adj",
  接続詞: "conj",
  感動詞: "interjection",
  助詞: "particle",
  助動詞: "aux",
  接頭辞: "prefix",
  接尾辞: "suffix",
  代名詞: "pronoun",
};

console.log("Loading TUBELEX frequency list...");
// { word: { count, category } } — category is the mapped UniDic top-level
// class, or null if unmapped (symbols, NUM/UNK/WEB/EMAIL/etc. placeholders).
const freqMap = new Map();
{
  const raw = fs.readFileSync(tsvPath, "utf8");
  let lineStart = raw.indexOf("\n") + 1; // skip header
  const len = raw.length;
  while (lineStart < len) {
    let lineEnd = raw.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = len;
    const line = raw.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (!line) continue;
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    const tab3 = line.indexOf("\t", tab2 + 1);
    const tab4 = line.indexOf("\t", tab3 + 1);
    const tab5 = line.indexOf("\t", tab4 + 1);
    if (tab1 === -1 || tab2 === -1 || tab4 === -1) continue;
    const word = line.slice(0, tab1);
    const count = Number(line.slice(tab1 + 1, tab2));
    const posField = line.slice(tab4 + 1, tab5 === -1 ? undefined : tab5);
    const topClass = posField.split("-")[0];
    const category = UNIDIC_TOP_CLASS_TO_CATEGORY[topClass] ?? null;
    freqMap.set(word, { count, category });
  }
}
console.log(`Loaded ${freqMap.size} TUBELEX lemma frequencies.`);

console.log("Inverting jmdict-compact.json's index (entry -> every surface form pointing to it)...");
const entryToKeys = new Map();
for (const key of Object.keys(compact.index)) {
  for (const idx of compact.index[key]) {
    let keys = entryToKeys.get(idx);
    if (!keys) entryToKeys.set(idx, (keys = []));
    keys.push(key);
  }
}

// Katakana -> hiragana, used below to recognize genuine script variants of
// the SAME reading (あかん/アカン) without conflating them with a genuinely
// different reading that just happens to share a kanji spelling.
function toHiragana(str) {
  let result = "";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    result += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return result;
}

// ぁ-ゟ (hiragana) / ァ-ヿ (katakana) / ー (prolonged sound mark) only — a key
// entirely in this range is a *reading*, not a kanji spelling.
const KANA_ONLY_RE = /^[ぁ-ゟァ-ヿー]+$/;

console.log("Scoring every entry by its best matching-reading frequency...");
const scoreByEntry = new Int32Array(compact.entries.length);
// Skipped entirely if this or fix-jmdict-priority.js was never run: entries
// with no rK/sK-derived flag just get score 0 the same as anything else
// TUBELEX has no data for, which falls back to the existing common+kp
// tiebreak below — this never makes an entry rank worse than it did before.
//
// A KANA-ONLY key only counts toward an entry's score if it's a script
// variant of the entry's OWN reading (`r`) — not any kana key entryToKeys
// associates with it. Confirmed real 2026-07-03: an entry can be legitimately
// indexed under a genuinely DIFFERENT reading too (僧家 reads both そうか
// "Buddhist temple" and そうけ "head of family" — the compact format doesn't
// split entries per reading, same root cause as the multi-reading display
// limitation). Scoring by the max across ALL of an entry's keys let 僧家's
// そうか-sense entry borrow そうけ's much higher frequency (driven by the
// unrelated, common word 宗家 sharing that reading) — ranking a rare
// "Buddhist temple" sense above the correct, common そうか interjection
// ("is that so?"), which is only reachable via そうか and so never got that
// inflated score. KANJI keys are NOT filtered this way and always count —
// unlike kana readings, a kanji spelling doesn't carry its own competing
// "which sense is this" ambiguity here (TUBELEX's own lemma field is often
// itself in kanji — 為る, 居る, 言う — filtering those out the same way as
// kana would have starved the vast majority of ordinary single-reading
// words of any score at all, confirmed empirically: an earlier version of
// this filter that excluded ALL non-matching keys, kanji included, dropped
// scored-entry coverage from 59,703 to 9,450 entries).
// POS-compatibility gate (2026-07-05): a kana reading can be shared by
// completely unrelated words in different grammatical categories — 子's ね
// reading (zodiac-sign noun, JMdict "n") shares its bare kana key with the
// sentence-final particle ね, which TUBELEX's own "ね" lemma row tags 助詞
// (particle), not 名詞 (noun). TUBELEX aggregates ALL real-world usage of ね
// under that one row regardless of which JMdict sense a human would assign —
// in practice that's ~100% the enormously common particle, so the zodiac
// noun's entry was inheriting a wildly inflated score with no relation to its
// own actual frequency. Unlike the そうか contamination fixed above (a
// DIFFERENT reading cross-linked via a shared kanji spelling), this is the
// SAME reading legitimately shared across categories — the existing
// own-reading-match check can't catch it, since the reading genuinely does
// match. Gated the same lenient way as everything else in this script: only
// rejects a clear cross-category mismatch; an unmapped TUBELEX category
// (symbols, NUM/UNK/etc.) or an entry with no mappable JMdict category is
// always allowed through, so this narrows contamination without repeating the
// earlier coverage-collapse mistake (59,703 -> 9,450 entries) from an
// over-broad filter.
function entryCategories(idx) {
  const categories = new Set();
  for (const p of compact.entries[idx].p ?? []) {
    const cat = jmdictCategory(p);
    if (cat) categories.add(cat);
  }
  return categories;
}

let scored = 0;
for (const [idx, keys] of entryToKeys) {
  const ownReading = toHiragana(compact.entries[idx].r ?? "");
  const categories = entryCategories(idx);
  let best = 0;
  for (const key of keys) {
    if (KANA_ONLY_RE.test(key) && toHiragana(key) !== ownReading) continue;
    const f = freqMap.get(key);
    if (f === undefined) continue;
    if (categories.size > 0 && f.category && !categories.has(f.category)) continue;
    if (f.count > best) best = f.count;
  }
  if (best > 0) {
    scoreByEntry[idx] = best;
    scored++;
  }
}

console.log(`${scored} of ${compact.entries.length} entries matched a nonzero TUBELEX frequency.`);

console.log("Re-sorting index arrays (own-reading match, then frequency, then common+kana-primary tiebreak)...");
let reordered = 0;
for (const key of Object.keys(compact.index)) {
  const indices = compact.index[key];
  if (indices.length < 2) continue;
  const before = indices.join(",");
  const normalizedKey = toHiragana(key);
  // Own-reading match is checked FIRST, ahead of frequency — not just as
  // part of the frequency computation above. Confirmed necessary 2026-07-03:
  // だ is legitimately indexed under key "だ" alongside た's own entry (a
  // real euphonic/voiced alternate reading of た). た is an enormously common
  // word on its OWN reading, so scoring it by its own frequency (correctly,
  // for its own "た" key) still outranks だ's actual copula sense when both
  // sit under key "だ" — even though だ's own reading obviously matches この
  // key and た's doesn't. An entry whose own reading IS this key should
  // never lose to one that's merely cross-linked here via an alternate
  // reading, regardless of how frequent that entry is under its own,
  // different, reading.
  const ownReadingMatches = (i) => (KANA_ONLY_RE.test(key) ? toHiragana(compact.entries[i].r ?? "") === normalizedKey : true);
  // JMdict's own curator-assigned `common` flag is checked BEFORE raw
  // TUBELEX frequency, not after. Confirmed necessary 2026-07-03: そうか
  // ("is that so?", genuinely common, an everyday interjection) lost to
  // そうか ("additive", not common at all) purely on frequency, because
  // casual multi-morpheme interjections are exactly the kind of thing a
  // MeCab-based automated corpus tool like TUBELEX often fails to lemmatize
  // as their own token — meaning "no data" (score 0) isn't reliably
  // distinguishable from "genuinely rare," while a small amount of noise in
  // an obscure entry's count can still beat a real common word's zero. A
  // curated, human-reviewed common flag is a more trustworthy signal than
  // an automated corpus count having a coverage gap.
  const withIndex = indices.map((idx, pos) => ({ idx, pos }));
  withIndex.sort((a, b) => {
    const matchDiff = (ownReadingMatches(b.idx) ? 1 : 0) - (ownReadingMatches(a.idx) ? 1 : 0);
    if (matchDiff !== 0) return matchDiff;
    const commonDiff = (compact.entries[b.idx].c ? 1 : 0) - (compact.entries[a.idx].c ? 1 : 0);
    if (commonDiff !== 0) return commonDiff;
    const scoreDiff = scoreByEntry[b.idx] - scoreByEntry[a.idx];
    if (scoreDiff !== 0) return scoreDiff;
    const boost = (i) => (compact.entries[i].kp && compact.entries[i].c ? 1 : 0);
    const boostDiff = boost(b.idx) - boost(a.idx);
    if (boostDiff !== 0) return boostDiff;
    return a.pos - b.pos;
  });
  compact.index[key] = withIndex.map((w) => w.idx);
  if (compact.index[key].join(",") !== before) reordered++;
}
console.log(`Re-ordered ${reordered} index keys.`);

// Assigning the `fr` (frequency-rank) tier runs AFTER the re-sort above, not
// alongside the raw scoreByEntry computation — deliberately, to avoid a real
// bug caught 2026-07-19 during testing: scoreByEntry trusts ANY kanji-key
// match unconditionally (by design — see the KANA-ONLY-key comment above,
// kanji spellings aren't reading-gated because that's needed for the common
// case of an ordinary word being scored via its own kanji). But that means a
// RARE alternate reading sharing a kanji with a common one inherits the
// common reading's entire score: 僕's archaic やつがれ/やつこ readings (both
// c: undefined, real words but obscure) matched key "僕" and inherited ぼく's
// huge TUBELEX count, scoring high enough for a false "Common" tier — even
// though the existing index-ORDER logic already correctly ranks ぼく first
// for key "僕" (common flag beats score in the tiebreak above), the raw score
// itself doesn't know that. For tiering (a per-entry LABEL a learner sees,
// not just a display-order tiebreak), that distinction matters: only trust a
// kanji key's score for THIS entry if it's the entry the just-finished
// re-sort actually put first for that exact kanji spelling — i.e. the same
// signal already used to pick the "real" entry for display order, reused
// here so the badge can't disagree with which entry the popup treats as
// primary. Kana-key contributions don't need this (already own-reading-
// gated, so た can't inherit だ's score or vice versa).
console.log("Assigning frequency-rank tiers (fr field)...");
const KANJI_PRIMARY_FOR_KEY = new Map(); // kanji key -> idx index[0] resolves to
for (const key of Object.keys(compact.index)) {
  if (KANA_ONLY_RE.test(key)) continue;
  KANJI_PRIMARY_FOR_KEY.set(key, compact.index[key][0]);
}
let tierCounts = { common: 0, uncommon: 0, rare: 0, orphanFallback: 0 };
for (let idx = 0; idx < compact.entries.length; idx++) {
  const entry = compact.entries[idx];
  const ownReading = toHiragana(entry.r ?? "");
  const categories = entryCategories(idx);
  let trustedScore = 0;
  for (const key of entryToKeys.get(idx) ?? []) {
    if (KANA_ONLY_RE.test(key)) {
      if (toHiragana(key) !== ownReading) continue;
    } else if (KANJI_PRIMARY_FOR_KEY.get(key) !== idx) {
      continue; // a rarer homograph riding on a more common entry's kanji — don't trust it for tiering
    }
    const f = freqMap.get(key);
    if (f === undefined) continue;
    if (categories.size > 0 && f.category && !categories.has(f.category)) continue;
    if (f.count > trustedScore) trustedScore = f.count;
  }

  let tier;
  if (trustedScore >= 500) tier = "common";
  else if (trustedScore >= 20) tier = "uncommon";
  else if (trustedScore >= 1) tier = "rare";
  else if (entry.c && entry.id !== undefined && orphanedOverrides[entry.id]) {
    tier = orphanedOverrides[entry.id];
    tierCounts.orphanFallback++;
  }
  if (tier) {
    entry.fr = tier;
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  } else {
    delete entry.fr;
  }
}
console.log(
  `Tiers assigned — common: ${tierCounts.common}, uncommon: ${tierCounts.uncommon}, rare: ${tierCounts.rare} (of which ${tierCounts.orphanFallback} via the orphaned-entry override, not a raw TUBELEX score).`
);

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
