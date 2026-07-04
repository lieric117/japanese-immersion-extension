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
// Doesn't regenerate entries/posTags (unaffected by this) — only reorders
// each index[] array, same footprint-conscious approach as
// fix-jmdict-priority.js (no new per-entry fields persisted).

const fs = require("fs");
const path = require("path");

const tsvPath = process.argv[2];
if (!tsvPath) {
  console.error("Usage: node apply-tubelex-frequency.js <path-to-tubelex-ja-lemma-pos.tsv>");
  process.exit(1);
}

const COMPACT_PATH = path.join(__dirname, "..", "jmdict-compact.json");

console.log("Loading compact dictionary...");
const compact = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));

console.log("Loading TUBELEX frequency list...");
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
    if (tab1 === -1 || tab2 === -1) continue;
    const word = line.slice(0, tab1);
    const count = Number(line.slice(tab1 + 1, tab2));
    freqMap.set(word, count);
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
let scored = 0;
for (const [idx, keys] of entryToKeys) {
  const ownReading = toHiragana(compact.entries[idx].r ?? "");
  let best = 0;
  for (const key of keys) {
    if (KANA_ONLY_RE.test(key) && toHiragana(key) !== ownReading) continue;
    const f = freqMap.get(key);
    if (f !== undefined && f > best) best = f;
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

console.log("Writing jmdict-compact.json...");
fs.writeFileSync(COMPACT_PATH, JSON.stringify(compact));
console.log("Done.");
