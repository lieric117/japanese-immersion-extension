// Offline batch-testing script for the Japanese subtitle pipeline.
// Runs kuromoji tokenization + jmdict lookup over real Jimaku subtitle files
// outside the browser, so segmentation/lookup bugs surface in minutes instead
// of hours of manual playback.
//
// Usage:
//   cd scripts && npm install        (first time only)
//   JIMAKU_API_KEY=your_key node batch-test.js
//
// The API key is the same one you saved in the extension's toolbar popup.
// It never touches any file — just read from the environment variable.

"use strict";

const path = require("path");
const fs = require("fs");
const kuromoji = require("kuromoji");

// ── shared modules from the extension ────────────────────────────────────────
const { parseSrt, parseAss } = require("../subtitle-parser.js");
const {
  groupTokens,
  JAPANESE_WORD_RE,
  findKanaMergeCandidates,
  applyKanaMerges,
  findPhraseMatchCandidates,
  classifyAndSelectPhraseMatches,
  applyPhraseMatches,
  findKatakanaUnsuppressCandidates,
  applyKatakanaUnsuppress,
  derivePotentialFormBase,
  selectPotentialFormMatches,
} = require("../tokenize-utils.js");

// ── paths ─────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, "..");
const DICT_PATH = path.join(ROOT, "vendor", "kuromoji-dict");
const JMDICT_PATH = path.join(ROOT, "jmdict-compact.json");
const JIMAKU_API_BASE = "https://jimaku.cc/api";

// ── shows to test ─────────────────────────────────────────────────────────────
// Mix of speech registers and subtitle sources to surface segmentation gaps
// that wouldn't show up from testing one show only.
const SHOWS = [
  // Slice-of-life: dense casual speech, contractions, te-form chains
  { name: "Bocchi the Rock!", entryId: 1648, episodes: [1] },
  // Fantasy: formal narration + dialogue + battle fragments; multiple uploaders
  { name: "Frieren: Beyond Journey's End", entryId: 729, episodes: [1] },
  // Different uploader: NanakoRaws uses different filename conventions from SubsPlease.
  // ep 1 on Jimaku is a bulk .7z archive (eps 1-1152); ep 894 has individual files.
  { name: "One Piece", entryId: 1563, episodes: [894] },
];

// Archive extensions we can't parse as subtitle text
const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;

// Lines that are pure music notation or sound effects — not dialogue, skip them.
// Matches lines like "♪～", "（馬の進行音）", "(laughs)", etc.
const NOISE_LINE_RE = /^[\s（(♪～）)…]+$|^（[^）]*）$/;

// ── helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTokenizer(dicPath) {
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((err, t) => (err ? reject(err) : resolve(t)));
  });
}

async function jimakuGet(url, apiKey) {
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Jimaku ${res.status} — ${url}`);
  return res.json();
}

async function fetchCues(entryId, episode, apiKey) {
  const files = await jimakuGet(
    `${JIMAKU_API_BASE}/entries/${entryId}/files?episode=${episode}`,
    apiKey
  );

  const textFiles = files.filter((f) => !ARCHIVE_RE.test(f.name));
  if (!textFiles.length) {
    const names = files.map((f) => f.name).join(", ");
    throw new Error(
      files.length
        ? `Only archive files found (${names}) — pick a different episode`
        : `No files for ep ${episode}`
    );
  }

  const file = textFiles[0];
  const res = await fetch(file.url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const raw = await res.text();

  const isAss = /\.(ass|ssa)$/i.test(file.name);
  return { cues: isAss ? parseAss(raw) : parseSrt(raw), fileName: file.name };
}

// ── pattern detectors ─────────────────────────────────────────────────────────
// All run against the raw kuromoji token array for one subtitle line,
// EXCEPT lookupMiss which runs against the grouped output.
// They return arrays of hit objects; empty array = no hit.

// Pattern 1 — te-form auxiliary chain
// Sequence: [動詞] → [助詞 て/で] → [動詞].
// The linking て/で is pos 助詞, so our current 助動詞-only merge rule skips it.
// Result: 食べてしまった renders as 食べ + て + しまった — three clickable units
// instead of one, and て looks up as the unrelated conjunction.
function detectTeFormChains(tokens) {
  const hits = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const c = tokens[i + 2];
    if (
      a.pos === "動詞" &&
      b.pos === "助詞" &&
      (b.surface_form === "て" || b.surface_form === "で") &&
      c.pos === "動詞"
    ) {
      hits.push({
        chain: a.surface_form + b.surface_form + c.surface_form,
        headsLookup: `${a.basic_form} + ${c.basic_form}`,
      });
    }
  }
  return hits;
}

// Pattern 2 — JMdict lookup miss
// A group whose word (the kuromoji basic_form we send to the dictionary) has
// no entry in jmdict-compact.json. Filters out proper nouns and all-katakana
// words (loan words) since those are expected misses, not pipeline bugs.
function detectLookupMisses(groups, jmdict) {
  const hits = [];
  for (const g of groups) {
    if (g.word === null) continue;
    if (jmdict.index[g.word]) continue; // found — good

    // Suppress expected non-entries:
    // – single characters are often particles or punctuation fragments
    if ([...g.word].length === 1) continue;
    // – all-katakana words are loan words JMdict may not cover
    if (/^[゠-ヿ]+$/.test(g.word)) continue;
    // – words with no kanji and no hiragana are likely romanji/noise
    if (!/[ぁ-ん㐀-鿿]/.test(g.word)) continue;

    hits.push({ surface: g.surface, wordLookedUp: g.word });
  }
  return hits;
}

// Pattern 3 removed: the "dangling single-char fragment" heuristic produced
// 1463 hits on the first real run, almost all false positives (normal 1-char
// kanji words like 人/指/私 and particles like が/に/て). Single-char Japanese
// words are routine in Japanese, not a sign of mis-segmentation.

// Pattern 4 — conjunctive verb stem (連用形) still unmerged after the te-form fix.
// After the Rule 1 + Rule 2 fix, Cases that are now handled are filtered out.
// What remains: contracted forms NOT starting with て (e.g. ちゃう/ちゃった for
// てしまう/てしまった casual speech), or other unexpected following tokens.
function detectUnmergedInflections(tokens) {
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.pos !== "動詞") continue;
    if (t.conjugated_form !== "連用形") continue;
    if (t.surface_form === t.basic_form) continue;

    const next = tokens[i + 1];
    if (!next) continue;
    if (next.pos === "助動詞") continue; // Rule 3 handles this
    // Rule 1 handles: [動詞]+[助詞 て/で]+[動詞] — filter out the て/で particle side
    if (next.pos === "助詞" && (next.surface_form === "て" || next.surface_form === "で")) continue;
    // Rule 2 handles: contracted auxiliaries starting with て
    if (next.pos === "動詞" && next.surface_form.startsWith("て")) continue;

    hits.push({
      surface: t.surface_form,
      basic: t.basic_form,
      nextToken: `${next.surface_form} (${next.pos})`,
    });
  }
  return hits;
}

// Pattern 5 — kana merge candidates (content.js's fragmented-word fix).
// Reports every merge findKanaMergeCandidates/applyKanaMerges would actually
// apply against real subtitle lines — a corpus-scale check for false-positive
// merges (a coincidental concatenation matching an unrelated JMdict entry)
// before trusting the fix beyond the two confirmed cases (ただいま！, か〜くれんぼ).
function detectKanaMerges(groups, jmdict) {
  const candidates = findKanaMergeCandidates(groups);
  if (!candidates.length) return [];

  const membership = {};
  for (const c of candidates) {
    if (membership[c.lookupText] !== undefined) continue;
    const idxs = jmdict.index[c.lookupText] ?? [];
    const posCodes = [...new Set(idxs.flatMap((i) => jmdict.entries[i].p ?? []))];
    membership[c.lookupText] = { exists: idxs.length > 0, posCodes };
  }

  const merged = applyKanaMerges(groups, candidates, membership);
  // Unmerged groups are pushed by reference in applyKanaMerges, so anything
  // NOT in the original groups array is a newly-created merge.
  const originalRefs = new Set(groups);
  return merged
    .filter((g) => !originalRefs.has(g))
    .map((g) => ({ merged: g.surface, lookupWord: g.word }));
}

// Pattern 6 — phrase-match fuse candidates (general multi-token JMdict-phrase
// fix). Reports every multi-token FUSE it would apply (replacing the
// individual tokens with one clickable unit), so real dialogue can surface
// cases where a real JMdict entry exists for a sub-string that's actually a
// coincidental parse in context. A 1257-line corpus check found this happens
// constantly for plain existence-only matching (はした→"fraction", たね→"seed",
// こうか→dozens of unrelated nouns); the fuse path requires a function-POS
// match or an all-noun span (see FUNCTION_POS_CODES), same as kana-merge's
// punctuation branch.
//
// Pattern 7 — phrase-match dual-view candidates. Reports every case where a
// matched phrase gets attached as a secondary "also, as a set phrase" note
// without touching the individual tokens (ものになる attaching to もの while
// もの/に/なる all stay independently clickable) — see isDualViewMatch.
function detectPhraseMatches(tokens, jmdict) {
  const candidates = findPhraseMatchCandidates(tokens);
  if (!candidates.length) return { fuseHits: [], dualViewHits: [], groups: groupTokens(tokens) };

  const membership = {};
  for (const c of candidates) {
    if (membership[c.lookupText] !== undefined) continue;
    const idxs = jmdict.index[c.lookupText] ?? [];
    const posCodes = [...new Set(idxs.flatMap((i) => jmdict.entries[i].p ?? []))];
    membership[c.lookupText] = { exists: idxs.length > 0, posCodes };
  }

  const { fuseSpans, dualViewSpans } = classifyAndSelectPhraseMatches(tokens, candidates, membership);
  const groups = applyPhraseMatches(tokens, fuseSpans, dualViewSpans);

  const fuseHits = fuseSpans.map((span) => {
    const g = groups.find((gr) => gr.tokenStart === span.start && gr.tokenEnd === span.end);
    return { merged: g?.surface ?? span.lookupText, lookupWord: span.lookupText };
  });
  const dualViewHits = dualViewSpans.map((span) => {
    const owner = groups.find((gr) => gr.tokenStart <= span.start && span.start <= gr.tokenEnd);
    return { attachedTo: owner?.surface ?? "?", idiomWord: span.lookupText };
  });
  return { fuseHits, dualViewHits, groups };
}

// Pattern 8 — katakana proper-noun un-suppression (2026-07-05 fix). Reports
// every group findKatakanaUnsuppressCandidates/applyKatakanaUnsuppress
// resolves to a real word after groupTokens' hasProperNoun rule silenced the
// whole run (チヤホヤ, mis-tagged 固有名詞 on its first half) — a corpus-scale
// false-positive check before trusting the fix broadly, same validation
// pattern as Pattern 5's kana-merge check.
function detectKatakanaUnsuppress(groups, jmdict) {
  const candidates = findKatakanaUnsuppressCandidates(groups);
  if (!candidates.length) return [];

  const membership = {};
  for (const i of candidates) {
    const surface = groups[i].surface;
    if (membership[surface] !== undefined) continue;
    const idxs = jmdict.index[surface] ?? [];
    membership[surface] = { exists: idxs.length > 0 };
  }

  const unsuppressed = applyKatakanaUnsuppress(groups, candidates, membership);
  const hits = [];
  for (const i of candidates) {
    if (unsuppressed[i].word !== null) hits.push({ surface: groups[i].surface, resolvedTo: unsuppressed[i].word });
  }
  return hits;
}

// Pattern 9 — godan potential-form reverse-conjugation fallback (2026-07-05
// fix). Reports every JMdict lookup-miss (Pattern 2's own candidates) that
// derivePotentialFormBase resolves to a real godan verb — a corpus-scale
// check for the exact false-positive risk this fix was built to avoid: a
// word ending in an e-row kana that ISN'T actually a potential form,
// coincidentally reverse-deriving to an unrelated but real godan verb. Only
// fires on words that already have no direct entry (see detectLookupMisses),
// same fallback-only gate as background.js's lookupWord.
function detectPotentialFormResolutions(groups, jmdict) {
  const hits = [];
  for (const g of groups) {
    if (g.word === null) continue;
    if (jmdict.index[g.word]) continue; // has a direct entry — not a miss
    if ([...g.word].length === 1) continue;
    if (/^[゠-ヿ]+$/.test(g.word)) continue;
    if (!/[ぁ-ん㐀-鿿]/.test(g.word)) continue;

    const base = derivePotentialFormBase(g.word);
    if (!base) continue;
    const candidates = selectPotentialFormMatches(jmdict.index[base] ?? [], jmdict);
    if (candidates.length > 0) {
      hits.push({ surface: g.surface, wordLookedUp: g.word, resolvedBase: base, gloss: jmdict.entries[candidates[0]].g });
    }
  }
  return hits;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.JIMAKU_API_KEY;
  if (!apiKey) {
    console.error("Error: set JIMAKU_API_KEY=your_key before running this script.");
    process.exit(1);
  }

  console.log("Loading kuromoji dictionary…");
  const tokenizer = await buildTokenizer(DICT_PATH);
  console.log("Loading JMdict…");
  const jmdict = JSON.parse(fs.readFileSync(JMDICT_PATH, "utf8"));
  console.log("Ready.\n");

  const MAX_EXAMPLES = 8;

  const report = {
    totalLines: 0,
    shows: [],
    patterns: {
      teFormChain:         { label: "Pattern 1 — Te-form auxiliary chains (should now split into two groups)", count: 0, examples: [] },
      lookupMiss:          { label: "Pattern 2 — JMdict lookup misses (non-particle, non-katakana words)", count: 0, examples: [] },
      unmergedInflection:  { label: "Pattern 4 — Conjunctive stem (連用形) still unmerged after te-form fix (new gaps)", count: 0, examples: [] },
      kanaMerge:           { label: "Pattern 5 — Kana merges applied (check for false-positive merges)", count: 0, examples: [] },
      phraseMerge:         { label: "Pattern 6 — Phrase-match fuses applied (check for coincidental/contextually-wrong merges)", count: 0, examples: [] },
      phraseDualView:      { label: "Pattern 7 — Phrase-match dual-view notes attached (individual tokens stay clickable)", count: 0, examples: [] },
      katakanaUnsuppress:  { label: "Pattern 8 — Katakana proper-noun un-suppression applied (check for false-positive un-suppressions)", count: 0, examples: [] },
      potentialForm:       { label: "Pattern 9 — Godan potential-form fallback resolutions (check for false-positive reverse-conjugations)", count: 0, examples: [] },
    },
  };

  // kanaMerge/phraseMerge/phraseDualView/katakanaUnsuppress/potentialForm
  // examples are uncapped — verifying every merge/resolution for false
  // positives is the point of these patterns, not just sampling a few.
  const UNCAPPED_PATTERNS = new Set(["kanaMerge", "phraseMerge", "phraseDualView", "katakanaUnsuppress", "potentialForm"]);
  function record(key, lineText, detail) {
    const p = report.patterns[key];
    p.count++;
    if (UNCAPPED_PATTERNS.has(key) || p.examples.length < MAX_EXAMPLES) {
      p.examples.push({ line: lineText.replace(/\n/g, "／"), detail });
    }
  }

  for (const show of SHOWS) {
    for (const ep of show.episodes) {
      process.stdout.write(`Fetching ${show.name} ep ${ep}… `);

      let cues, fileName;
      try {
        ({ cues, fileName } = await fetchCues(show.entryId, ep, apiKey));
      } catch (err) {
        console.log(`SKIPPED — ${err.message}`);
        report.shows.push({ show: show.name, ep, status: `skipped: ${err.message}` });
        continue;
      }
      console.log(`${cues.length} cues from ${fileName}`);
      report.shows.push({ show: show.name, ep, file: fileName, cues: cues.length });

      let linesThisEp = 0;
      for (const cue of cues) {
        const text = cue.text.trim();
        // Skip empty lines and pure music/sound-effect notations
        if (!text || !JAPANESE_WORD_RE.test(text) || NOISE_LINE_RE.test(text)) continue;

        report.totalLines++;
        linesThisEp++;

        const tokens = tokenizer.tokenize(text);
        const { fuseHits, dualViewHits, groups } = detectPhraseMatches(tokens, jmdict);

        for (const hit of detectTeFormChains(tokens))          record("teFormChain", text, hit);
        for (const hit of detectLookupMisses(groups, jmdict))   record("lookupMiss", text, hit);
        for (const hit of detectUnmergedInflections(tokens))    record("unmergedInflection", text, hit);
        for (const hit of detectKanaMerges(groups, jmdict))     record("kanaMerge", text, hit);
        for (const hit of fuseHits)                             record("phraseMerge", text, hit);
        for (const hit of dualViewHits)                         record("phraseDualView", text, hit);
        for (const hit of detectKatakanaUnsuppress(groups, jmdict)) record("katakanaUnsuppress", text, hit);
        for (const hit of detectPotentialFormResolutions(groups, jmdict)) record("potentialForm", text, hit);
      }

      console.log(`  → ${linesThisEp} lines tokenized`);
      await sleep(2500); // stay under Jimaku's 25 req/min rate limit
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("BATCH TEST REPORT");
  console.log("═══════════════════════════════════════════════════════════");
  console.log();
  console.log("Files processed:");
  for (const s of report.shows) {
    if (s.status) {
      console.log(`  ${s.show} ep ${s.ep}: ${s.status}`);
    } else {
      console.log(`  ${s.show} ep ${s.ep}: ${s.cues} cues from ${s.file}`);
    }
  }
  console.log(`\nTotal Japanese dialogue lines tokenized: ${report.totalLines}`);
  console.log();

  for (const [, p] of Object.entries(report.patterns)) {
    console.log(`──────────────────────────────────────────────────────────`);
    console.log(`${p.label}`);
    console.log(`Occurrences: ${p.count}`);
    if (p.examples.length) {
      console.log(`Examples (up to ${MAX_EXAMPLES}):`);
      for (const ex of p.examples) {
        console.log(`  • "${ex.line}"`);
        console.log(`    ${JSON.stringify(ex.detail)}`);
      }
    } else {
      console.log("  (no examples)");
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
