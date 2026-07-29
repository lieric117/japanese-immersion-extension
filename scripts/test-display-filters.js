// Offline test for the subtitle display filter chain (content.js's
// cueDisplayText) — what a raw subtitle cue looks like by the time it reaches
// the screen, and which cues are dropped entirely.
//
// Usage:  node scripts/test-display-filters.js
//
// Reads the real regexes and the real function straight out of content.js
// rather than re-implementing them, so this can't drift from what ships.
//
// Every case that predates 2026-07-27 is a regression guard: this chain has
// been extended several times from live reports, and each addition is one
// character away from swallowing something it shouldn't (see the ‼/⁉ and 「」
// cases in particular).

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const { normalizeHalfwidthKatakana } = require(path.join(ROOT, "tokenize-utils.js"));

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — did it get renamed?`);
  return m[0];
}

const cueDisplayText = new Function(
  "normalizeHalfwidthKatakana",
  [
    // `[\s\S]*?;$` rather than `.*$` so a declaration wrapped across lines is
    // still picked up whole — FANSUB_MARKUP_RE outgrew one line on 2026-07-29.
    grab(/^const STAGE_RE =[\s\S]*?;$/m, "STAGE_RE"),
    grab(/^const SPEAKER_PREFIX_RE =[\s\S]*?;$/m, "SPEAKER_PREFIX_RE"),
    grab(/^const INLINE_FURIGANA_RE =[\s\S]*?;$/m, "INLINE_FURIGANA_RE"),
    grab(/^const FANSUB_MARKUP_RE =[\s\S]*?;$/m, "FANSUB_MARKUP_RE"),
    grab(/^function cueDisplayText\(cue\) \{[\s\S]*?\n\}/m, "cueDisplayText"),
    "return cueDisplayText;",
  ].join("\n")
)(normalizeHalfwidthKatakana);

const cases = [
  // [raw cue text, expected display text, why]

  // — 2026-07-27 live reports (KonoSuba)
  ["\u{1F50A}（警報）", "", "loudspeaker emoji + stage direction — the emoji prefix used to stop STAGE_RE matching"],
  ["《ここはどこだ", "ここはどこだ", "opening inner-monologue bracket — only the closing one was ever listed"],
  ["\u{1F3A4}ああーテスト", "ああーテスト", "any pictograph is stripped, not just an enumerated three"],
  ["\u{2764}\u{FE0F}", "", "emoji + variation selector leaves nothing invisible behind"],

  // — regression guards for everything the chain already did
  ["（警報）", "", "bare stage direction"],
  ["《ここはどこだ》", "ここはどこだ", "both brackets"],
  ["ここはどこだ》", "ここはどこだ", "closing bracket alone"],
  ["➡行くぞ", "行くぞ", "continuation arrow"],
  ["\u{1F4FA}ニュースです", "ニュースです", "TV emoji"],
  ["\u{1F3B5}〜ららら", "ららら", "music-note marker takes the wave with it"],
  ["♪", "", "pure music line"],
  ["（直樹）おはよう", "おはよう", "speaker prefix, dialogue kept"],
  ["凱旋(がいせん)する", "凱旋する", "inline furigana"],
  ["ｽﾏﾎを見る", "スマホを見る", "half-width katakana normalized before tokenization"],

  // — 2026-07-29 generality pass: found by scanning 49,592 cues across 48 real
  //   Jimaku files, all of them cases the enumerated version missed
  ["♬～", "", "the OTHER music notes — 244 lines in the corpus, all previously displayed as-is"],
  ["♩", "", "and the rest of the note block"],
  ["♫", "", "likewise"],
  ["➨", "", "second continuation-arrow glyph, 48 lines in the corpus"],
  ["➨行くぞ", "行くぞ", "...with dialogue after it"],
  ["⚟あの子", "あの子", "off-screen-speech marker, 12 lines in the corpus"],
  ["⸨そこのあなた⸩", "そこのあなた", "second monologue bracket pair, 11 lines in the corpus"],
  ["\u{1F44D}\u{1F3FD}", "", "skin-tone modifier goes with its emoji"],

  // — things that must NOT be touched
  ["本当か⁉", "本当か⁉", "interrobang is punctuation here, despite being Extended_Pictographic"],
  ["すごい‼", "すごい‼", "double-bang likewise"],
  ["「やめて」", "「やめて」", "quote brackets are real Japanese orthography"],
  ["『題名』", "『題名』", "and the title brackets"],
  ["“引用”", "“引用”", "and the curly quotes"],
  ["風の音〜", "風の音〜", "bare wave is vowel elongation, not markup"],
  ["ヒキニートはやめろ、クソビ○チ。", "ヒキニートはやめろ、クソビ○チ。", "geometric shapes censor a character — real content, not decoration"],
  ["36°C", "36°C", "degree sign is a unit, though Unicode calls it a symbol"],
  ["気温は25℃", "気温は25℃", "and the combined form"],
  ["№5", "№5", "numero sign likewise"],
];

let failed = 0;
for (const [raw, want, why] of cases) {
  const got = cueDisplayText({ text: raw });
  const ok = got === want;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${JSON.stringify(raw)} -> ${JSON.stringify(got)}` +
      (ok ? "" : `  (want ${JSON.stringify(want)})`) +
      `   ${why}`
  );
}
console.log(failed ? `\n${failed} of ${cases.length} FAILED` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
