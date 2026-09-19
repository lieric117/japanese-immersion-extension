// Kana utterances and stutters are not looked up as unrelated verbs
// (2026-09-18 audit, root cause found by UniDic disagreeing with kuromoji over
// the 386-file corpus). Runs the REAL pipeline (scripts/audit/parse-pipeline.js)
// on VERBATIM corpus lines and checks what each click would look up.
// Usage: node scripts/test-utterance-lemmas.js
"use strict";
const { createPipeline } = require("./audit/parse-pipeline.js");
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
(async () => {
  const p = await createPipeline();
  const groupsOf = async (line) => p.buildGroupsForText(line);
  const find = (groups, surface) => groups.find((g) => g.surface === surface);
  const lookup = async (g) => (g && g.word !== null ? p.lookupWord(g.word, g.isParticle, g.pos, g.isHonorificSuffix) : null);

  // Bocchi the Rock! S01E07 [Recluse] and S01E01 — verbatim.
  for (const [line, surface] of [["\u3046\u3063 \u3053\u308c\u306f\u2026", "\u3046\u3063"], ["\u3046\u308f\u3063\uff01", "\u3046\u308f\u3063"]]) {
    const g = find(await groupsOf(line), surface);
    const r = await lookup(g);
    check(`"${surface}" in "${line}" looks up the utterance, not a verb`, g && g.word === surface && r.results.every((e) => (e.p ?? []).some((x) => x === "int" || x === "exp")), JSON.stringify(g));
  }
  {
    const g = find(await groupsOf("\u3046\u3046\u2026"), "\u3046\u3046");
    const r = await lookup(g);
    check('"\u3046\u3046\u2026" shows no entry rather than \u690d\u3046 "to plant"', g && r.results.length === 0, JSON.stringify(r?.results?.[0]));
  }
  for (const [line, frag] of [["\u307b\u2026 \u307b\u304b\u306b\u306f", "\u307b"], ["\u3044\u2026 \u3044\u3084", "\u3044"], ["\u3072\u3063\u2026 \u3072\u3044\uff5e\u3063\uff01", "\u3072\u3063"]]) {
    const g = find(await groupsOf(line), frag);
    check(`the stutter fragment "${frag}" in "${line}" is not clickable`, g && g.word === null, JSON.stringify(g));
  }
  // Cut-off verbs keep their verb: the kanji is the evidence.
  for (const [line, surface, word] of [["\u8a00\u3063\u2026", "\u8a00\u3063", "\u8a00\u3046"], ["\u5f85\u3063\u2026 \u5f85\u3063\u3066", "\u5f85\u3063", "\u5f85\u3064"]]) {
    const g = find(await groupsOf(line), surface);
    check(`"${surface}" in "${line}" is still the verb ${word}`, g && g.word === word, JSON.stringify(g));
  }
  // A kana verb with something attached is untouched.
  {
    const g = find(await groupsOf("\u3084\u3063\u3061\u3083\u3063\u305f"), "\u3084\u3063");
    check('"\u3084\u3063" in "\u3084\u3063\u3061\u3083\u3063\u305f" is still \u3084\u308b', g && g.word === "\u3084\u308b", JSON.stringify(g));
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
