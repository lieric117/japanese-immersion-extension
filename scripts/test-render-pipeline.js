// Equivalence test for the subtitle render pipeline refactor (2026-07-30).
//
// Usage:  node scripts/test-render-pipeline.js
//         (needs scripts/node_modules — same setup as batch-test.js)
//
// `renderCue` used to run its four dictionary stages as a chain of nested
// callbacks. That chain was extracted into `buildGroupsForText` so the edit
// panel's "Change word" flow could reuse the exact same pipeline instead of
// growing a second copy of it. This file exists to prove the extraction didn't
// change what the pipeline produces: it runs the NEW function and a frozen copy
// of the OLD callback chain over the same real subtitle lines and compares the
// resulting groups field by field.
//
// The old chain below is a deliberate verbatim snapshot, not shared code — it
// is the thing being compared against, so it must not track future edits.

"use strict";

const fs = require("fs");
const path = require("path");
const kuromoji = require("kuromoji");

const ROOT = path.join(__dirname, "..");
const { parseAss, parseSrt } = require(path.join(ROOT, "subtitle-parser.js"));
const utils = require(path.join(ROOT, "tokenize-utils.js"));
const {
  groupTokens,
  findKanaMergeCandidates,
  applyKanaMerges,
  findPhraseMatchCandidates,
  classifyAndSelectPhraseMatches,
  applyPhraseMatches,
  findKatakanaUnsuppressCandidates,
  applyKatakanaUnsuppress,
  suppressTrailingSokuon,
  findKatakanaNameCandidates,
  applyKatakanaNameSuppression,
} = utils;

const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — did it get renamed?`);
  return m[0];
}

// ── the membership backend both sides share ─────────────────────────────────
// Same shape background.js's CHECK_KANA_MERGES returns, built straight from
// jmdict the way batch-test.js already does it.
function makeMembershipLookup(jmdict) {
  return (texts) => {
    const membership = {};
    for (const text of texts) {
      if (membership[text] !== undefined) continue;
      const idxs = jmdict.index[text] ?? [];
      const posCodes = [...new Set(idxs.flatMap((i) => jmdict.entries[i].p ?? []))];
      membership[text] = { exists: idxs.length > 0, posCodes };
    }
    return membership;
  };
}

// ── FROZEN reference: renderCue's pre-2026-07-30 callback chain ─────────────
// Structure preserved exactly; only the DOM writes are dropped and the final
// groups are handed to `done` instead of being rendered.
function oldChain(tokenizer, lookup, text, done) {
  const send = (texts, cb) => cb({ membership: lookup(texts) });
  const tokens = tokenizer.tokenize(text);

  const phraseCandidates = findPhraseMatchCandidates(tokens);
  if (phraseCandidates.length === 0) {
    afterPhraseMerge(groupTokens(tokens));
    return;
  }
  const phraseTexts = [...new Set(phraseCandidates.map((c) => c.lookupText))];
  send(phraseTexts, (response) => {
    const membership = response?.membership ?? {};
    const { fuseSpans, dualViewSpans } = classifyAndSelectPhraseMatches(tokens, phraseCandidates, membership);
    afterPhraseMerge(applyPhraseMatches(tokens, fuseSpans, dualViewSpans));
  });

  function afterPhraseMerge(groups) {
    const candidates = findKanaMergeCandidates(groups);
    if (candidates.length === 0) {
      afterKanaMerge(groups);
      return;
    }
    const texts = [...new Set(candidates.map((c) => c.lookupText))];
    send(texts, (response) => {
      const membership = response?.membership ?? {};
      afterKanaMerge(applyKanaMerges(groups, candidates, membership));
    });
  }

  function afterKanaMerge(groups) {
    groups = suppressTrailingSokuon(groups);
    const candidates = findKatakanaUnsuppressCandidates(groups);
    if (candidates.length === 0) {
      afterKatakanaUnsuppress(groups);
      return;
    }
    const texts = [...new Set(candidates.map((i) => groups[i].surface))];
    send(texts, (response) => {
      const membership = response?.membership ?? {};
      afterKatakanaUnsuppress(applyKatakanaUnsuppress(groups, candidates, membership));
    });
  }

  function afterKatakanaUnsuppress(groups) {
    const candidates = findKatakanaNameCandidates(groups);
    if (candidates.length === 0) {
      done(groups);
      return;
    }
    const texts = [...new Set(candidates.map((i) => groups[i].surface))];
    send(texts, (response) => {
      const membership = response?.membership ?? {};
      done(applyKatakanaNameSuppression(groups, candidates, membership));
    });
  }
}

// ── the NEW function, loaded out of content.js ──────────────────────────────
function makeNewPipeline(tokenizer, lookup) {
  const chrome = {
    runtime: {
      sendMessage(message, cb) {
        // Async on purpose: the real one is, and the refactor's whole point is
        // that awaiting it produces the same answer.
        setTimeout(() => cb({ membership: lookup(message.texts) }), 0);
      },
    },
  };
  return new Function(
    "chrome",
    "tokenizer",
    ...Object.keys(utils),
    [
      grab(/^function checkKanaMerges\([\s\S]*?\n\}/m, "checkKanaMerges"),
      grab(/^async function buildGroupsForText\([\s\S]*?\n\}/m, "buildGroupsForText"),
      "return buildGroupsForText;",
    ].join("\n")
  )(chrome, tokenizer, ...Object.values(utils));
}

// Groups carry functions/undefined inconsistently; compare the fields that
// actually drive rendering and the Anki capture.
function normalize(groups) {
  return groups.map((g) => ({
    surface: g.surface,
    word: g.word ?? null,
    inflections: g.inflections ?? null,
    isParticle: g.isParticle ?? false,
    isHonorificSuffix: g.isHonorificSuffix ?? false,
    pos: g.pos ?? null,
    conjugatedForm: g.conjugatedForm ?? null,
    idiomWord: g.idiomWord ?? null,
  }));
}

(async () => {
  console.log("Loading kuromoji + jmdict…");
  const tokenizer = await new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: path.join(ROOT, "vendor", "kuromoji-dict") }).build((e, t) => (e ? reject(e) : resolve(t)))
  );
  const jmdict = JSON.parse(fs.readFileSync(path.join(ROOT, "jmdict-compact.json"), "utf8"));
  const lookup = makeMembershipLookup(jmdict);
  const buildGroupsForText = makeNewPipeline(tokenizer, lookup);

  const key = process.env.JIMAKU_API_KEY;
  if (!key) {
    console.log("JIMAKU_API_KEY not set — cannot fetch corpus lines.");
    process.exit(1);
  }
  // Two providers from two shows: enough real lines to exercise every stage.
  const sources = [
    { entry: 729, episode: 7, prefix: "[Moozzi2]" },
    { entry: 1648, episode: 1, prefix: "[Recluse]" },
  ];
  const lines = [];
  for (const s of sources) {
    const res = await fetch(`https://jimaku.cc/api/entries/${s.entry}/files?episode=${s.episode}`, {
      headers: { Authorization: key },
    });
    const file = (await res.json()).find((f) => f.name.startsWith(s.prefix));
    if (!file) continue;
    const text = await (await fetch(file.url)).text();
    const cues = file.name.endsWith(".ass") ? parseAss(text) : parseSrt(text);
    for (const c of cues) if (c.text.trim()) lines.push(c.text.trim());
  }
  console.log(`Comparing ${lines.length} real subtitle lines…\n`);

  let mismatches = 0;
  for (const line of lines) {
    const oldGroups = await new Promise((resolve) => oldChain(tokenizer, lookup, line, resolve));
    const newGroups = await buildGroupsForText(line);
    const a = JSON.stringify(normalize(oldGroups));
    const b = JSON.stringify(normalize(newGroups));
    if (a === b) continue;
    mismatches++;
    if (mismatches <= 3) {
      console.log(`MISMATCH on ${JSON.stringify(line)}\n  old: ${a}\n  new: ${b}\n`);
    }
  }

  const ok = mismatches === 0;
  console.log(
    `${ok ? "PASS" : "FAIL"}  refactored pipeline matches the old callback chain\n` +
      `        ${lines.length} lines compared, ${mismatches} differing`
  );
  console.log(ok ? "\nall passed" : `\n${mismatches} FAILED`);
  process.exit(ok ? 0 : 1);
})();
