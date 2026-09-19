// content.js's japaneseDisplayAt — the join of every cue on screen at one
// moment, which both the display and the Anki sentence are built from
// (2026-09-18 audit). Lines are VERBATIM from the audit corpus
// (機動戦士ガンダム.ククルス・ドアンの島.WEBRip.Amazon, which carries every line twice);
// timings are SYNTHETIC.
// Usage: node scripts/test-display-join.js
"use strict";
const fs = require("fs");
const path = require("path");
const utils = require(path.join(__dirname, "..", "tokenize-utils.js"));
const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const grab = (re, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label}`);
  return m[0];
};
const make = new Function(
  "utils",
  "cuesRef",
  `const { normalizeHalfwidthKatakana } = utils;
   let cues = cuesRef.cues;
   ${grab(/^const STAGE_RE = .*$/m, "STAGE_RE")}
   ${grab(/^const SPEAKER_PREFIX_RE = .*$/m, "SPEAKER_PREFIX_RE")}
   ${grab(/^const INLINE_FURIGANA_RE = .*$/m, "INLINE_FURIGANA_RE")}
   ${grab(/^const FANSUB_MARKUP_RE =\n.*$/m, "FANSUB_MARKUP_RE")}
   ${grab(/^const ASS_OVERRIDE_RE = .*$/m, "ASS_OVERRIDE_RE")}
   ${grab(/^const SENTENCE_PERIOD_RE = .*$/m, "SENTENCE_PERIOD_RE")}
   ${(src.match(/^const DIGIT_COLON_RE = .*$/m) ?? [""])[0]}
   ${grab(/^function cueDisplayText\([\s\S]*?\n\}/m, "cueDisplayText")}
   ${(src.match(/^function lineDisplayText\([\s\S]*?\n\}/m) ?? [""])[0]}
   ${grab(/^function japaneseDisplayAt\([\s\S]*?\n\}/m, "japaneseDisplayAt")}
   return (c) => { cues = c; return japaneseDisplayAt; };`
);
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
const at = (cues, t) => make(utils, { cues })(cues)(t);

let r = at([{ start: 1, end: 3, text: "水は大切に使います" }, { start: 1, end: 3, text: "水は大切に使います" }], 2);
check("the same line from two events at once is shown once", r.text === "水は大切に使います", JSON.stringify(r.text));
r = at([{ start: 1, end: 3, text: "えっ" }, { start: 1.5, end: 3, text: "はーい" }], 2);
check("two DIFFERENT simultaneous lines are both kept, in order", r.text === "えっ\nはーい", JSON.stringify(r.text));
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
