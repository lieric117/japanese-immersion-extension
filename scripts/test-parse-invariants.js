// Property / fuzz test for the segmentation invariants (2026-09-18 audit).
//
// Usage:  node scripts/test-parse-invariants.js [--n 3000] [--seed 1]
//
// Runs random strings — every character class a subtitle can contain, in
// adversarial mixtures — through the extension's REAL pipeline
// (scripts/audit/parse-pipeline.js: content.js's buildGroupsForText,
// tokenize-utils.js, background.js's lookups over the shipped JMdict) and
// asserts the properties everything downstream relies on:
//
//   I1  the tokens (tokenizeLossless — raw kuromoji fails this, see there)
//       concatenate back to the input exactly
//   I2  the final groups concatenate back to the input exactly — renderGroups
//       and the Anki bold offset assume this (content.js renderGroups)
//   I3  groupTokens' own groups cover every raw token exactly once, in order
//   I4  every clickable group carries a non-empty lookup word
//   I5  no clickable group is made only of non-word characters
//
// Deterministic for a given seed, so a failure is reproducible. Inputs are
// synthetic by construction; the corpus sweep (scripts/audit/parse-sweep.js)
// is the real-data counterpart.

"use strict";

const { createPipeline } = require("./audit/parse-pipeline.js");

const args = process.argv.slice(2);
const N = Number(args[args.indexOf("--n") + 1]) || 3000;
let seed = Number(args[args.indexOf("--seed") + 1]) || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];

const POOLS = [
  [..."あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉっゃゅょー"],
  [..."アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴヴァィゥェォッャュョー"],
  [..."ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｯｰﾞﾟ"],
  [..."日本人私僕君彼行来見食言思出入上下中大小時分今何事物方者気手目口心会前後自生年月学先王都虹夏々〆"],
  ["𠮟", "𩸽", "﨑", "髙"],
  [..."0123456789０１２３４５６７８９"],
  [..."。、！？…‥「」『』（）()【】〜～・：:；ー―"],
  [" ", "　", "\n", "\t"],
  ["😊", "🎵", "♪", "➡", "‼", "⁉", "○", "℃"],
  [..."abcXYZ-'"],
];
// Real phrases, so the phrase matcher, kana-merge and aux absorption actually fire.
const PHRASES = ["ただいま！", "じゃない", "からといって", "食べちゃった", "見てる", "んだろう", "やめろっ", "チヤホヤ", "ひとりぼっち", "私たち", "お弁当", "さん", "なければならない", "23", "２３"];

function randomText() {
  let s = "";
  const len = 1 + Math.floor(rand() * 24);
  while (s.length < len) s += rand() < 0.25 ? pick(PHRASES) : pick(pick(POOLS));
  return s;
}

(async () => {
  const pipe = await createPipeline();
  const { groupTokens } = pipe.utils;
  const JWORD = /[ぁ-ヿ㐀-鿿ｦ-ﾟ0-9０-９]/;
  const failures = [];
  for (let n = 0; n < N; n++) {
    const text = randomText();
    // I1 is asserted on the tokenization the extension actually uses.
    const tokens = pipe.utils.tokenizeLossless(pipe.tokenizer, text);
    const fail = (inv, detail) => failures.push({ inv, text, detail });
    if (tokens.map((t) => t.surface_form).join("") !== text) fail("I1", tokens.map((t) => t.surface_form).join("|"));
    const base = groupTokens(tokens);
    let next = 0;
    for (const g of base) {
      if (g.tokenStart !== next || g.tokenEnd < g.tokenStart) {
        fail("I3", `group ${JSON.stringify(g.surface)} covers ${g.tokenStart}..${g.tokenEnd}, expected to start at ${next}`);
        break;
      }
      next = g.tokenEnd + 1;
    }
    if (next !== tokens.length) fail("I3", `groups end at token ${next} of ${tokens.length}`);
    let groups;
    try {
      groups = await pipe.buildGroupsForText(text);
    } catch (e) {
      fail("THROW", e.message);
      continue;
    }
    if (groups.map((g) => g.surface).join("") !== text) fail("I2", groups.map((g) => g.surface).join("|"));
    for (const g of groups) {
      if (g.word === null) continue;
      if (typeof g.word !== "string" || !g.word) fail("I4", JSON.stringify(g));
      if (!JWORD.test(g.surface)) fail("I5", JSON.stringify(g));
    }
  }
  const byInv = {};
  for (const f of failures) (byInv[f.inv] ??= []).push(f);
  for (const inv of ["I1", "I2", "I3", "I4", "I5", "THROW"]) {
    const rows = byInv[inv] ?? [];
    console.log(`${rows.length ? "FAIL" : "PASS"}  ${inv}: ${rows.length} violation(s) over ${N} random inputs`);
    for (const r of rows.slice(0, 5)) console.log(`        ${JSON.stringify(r.text)} → ${r.detail}`);
  }
  console.log(failures.length ? `\n${failures.length} violations` : "\nall passed");
  process.exit(failures.length ? 1 : 0);
})();
