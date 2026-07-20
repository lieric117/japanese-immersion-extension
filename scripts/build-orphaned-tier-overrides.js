// Builds scripts/orphaned-tier-overrides.json — tier overrides for JMdict
// entries jmdict-simplified marks common:true but TUBELEX has literally zero
// data for (confirmed 2026-07-19: 3,224 entries, e.g. でしょう/かもしれない/
// おかね/おにいさん — TUBELEX's own tokenizer just doesn't lemmatize these as
// single units, unrelated to how common they actually are). Without this,
// the frequency-rank badge would show NOTHING for some of the most ordinary
// words a learner will see, while rarer words nearby get a real tier.
//
// Two-source fallback, corpus taking priority over nf-rank whenever both are
// available:
//   1. Corpus count, from the SAME 3 shows/episodes scripts/batch-test.js
//      already uses (Bocchi ep1, Frieren ep1, One Piece ep894) — real anime
//      dialogue, the right register, but a thin corpus (~1300-3400 word-token
//      occurrences per episode). An orphaned entry that DOES show up here is
//      trusted over nf-rank; among orphaned entries with any corpus hit,
//      relative rank within that set decides common vs. uncommon (rough
//      rank-order, not an attempt at real percentiles from 3 episodes).
//   2. nf-priority rank (raw JMdict_e.xml's news/ichi/spec/gai/nf tags —
//      NOT available in jmdict-simplified's JSON, confirmed 2026-07-01) for
//      everything else. Every one of the 3,224 entries has at least one
//      priority tag (jmdict-simplified's own `common` flag is literally
//      derived from priority-tag presence, so this is guaranteed, not just
//      likely). CAVEAT, confirmed via spot-check: nf/news tags are
//      newspaper-frequency-derived — the same formal-writing-corpus bias
//      TUBELEX was chosen over BCCWJ specifically to avoid (see
//      apply-tubelex-frequency.js's own header). nf01-ranked entries in this
//      orphaned set included 委員会/外務省/共産党/総選挙/自民党 — newspaper-
//      common, not anime-dialogue-common. Mitigated by the formal-register
//      keyword check below, which demotes entries matching a bounded,
//      enumerable political/institutional keyword list — NOT a general
//      register classifier, just catching this one confirmed cluster.
//
// Usage:
//   1. Download the raw EDRDG XML (a DIFFERENT file from jmdict-simplified's
//      JSON — only the raw XML carries priority tags):
//      curl -o JMdict_e.gz http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz
//      gunzip JMdict_e.gz
//   2. Download+decompress the raw jmdict-simplified JSON too (same one
//      generate-jmdict-compact.js takes) — used only to map id -> kanji/kana
//      text for matching priority tags, not re-parsed for POS/gloss data.
//   3. JIMAKU_API_KEY=... node build-orphaned-tier-overrides.js
//        <path-to-JMdict_e> <path-to-raw-jmdict-eng.json>
//
// This is a scoped, one-time regex extraction from the raw XML (only
// <ent_seq>/<ke_pri>/<re_pri> text, no entity resolution needed — those only
// appear inside <pos>/<misc>/<dial>/<field>, untouched here) — NOT a switch
// to XML as this project's primary JMdict source. That decision (jmdict-
// simplified JSON over raw XML, DTD entities awkward to parse) stands
// unchanged; this is a narrow supplementary lookup.
//
// Output: { [id]: "common" | "uncommon" } — only entries this script
// actually assigns a tier to. Entries demoted by the formal-register check
// are simply absent (falls back to no badge, same as any other no-data
// word) rather than forced into a tier that doesn't fit.

"use strict";
const fs = require("fs");
const path = require("path");
const kuromoji = require("kuromoji");
const { parseAss } = require("../subtitle-parser.js");
const { groupTokens, JAPANESE_WORD_RE, findPhraseMatchCandidates, classifyAndSelectPhraseMatches, applyPhraseMatches } = require("../tokenize-utils.js");

const xmlPath = process.argv[2];
const rawJsonPath = process.argv[3];
const tubelexTsvPath = process.argv[4];
if (!xmlPath || !rawJsonPath || !tubelexTsvPath) {
  console.error("Usage: node build-orphaned-tier-overrides.js <path-to-JMdict_e> <path-to-raw-jmdict-eng.json> <path-to-tubelex-ja-lemma-pos.tsv>");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const COMPACT_PATH = path.join(ROOT, "jmdict-compact.json");
const DICT_PATH = path.join(ROOT, "vendor", "kuromoji-dict");
const OUT_PATH = path.join(__dirname, "orphaned-tier-overrides.json");
const JIMAKU_API_BASE = "https://jimaku.cc/api";
const NOISE_LINE_RE = /^[\s（(♪～）)…]+$|^（[^）]*）$/;

// Same corpus scripts/batch-test.js uses (see its own SHOWS list) — kept in
// sync manually since this script runs standalone/infrequently, not on every
// batch-test run.
const SHOWS = [
  { name: "Bocchi the Rock!", entryId: 1648, episodes: [1] },
  { name: "Frieren: Beyond Journey's End", entryId: 729, episodes: [1] },
  { name: "One Piece", entryId: 1563, episodes: [894] },
];
const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;

// Bounded, enumerable political/institutional keyword check — NOT a general
// register classifier. Catches the confirmed nf01 offenders (委員会/外務省/
// 共産党/総選挙/自民党) and their obvious siblings. A word matching this list
// gets demoted one tier from what nf-rank alone would assign (common ->
// uncommon -> no forced tier), since nf-rank alone can't tell "frequent in
// 1990s newspapers" apart from "frequent in anime dialogue."
const FORMAL_KANJI_KEYWORDS = ["党", "省", "議会", "選挙", "大臣", "条約", "庁", "内閣", "官房", "委員", "国会", "閣僚", "外交", "裁判所", "検察", "法案", "首相", "衆議院", "参議院", "知事", "県議", "市議"];
const FORMAL_GLOSS_KEYWORDS = ["ministry", "political party", "committee", "election", "diet member", "house of representatives", "house of councillors", "cabinet", "prime minister", "parliament", "legislature", "government agency", "bureau", "governor", "diplomatic", "treaty", "legislation", "statute"];

function isFormalRegister(entry) {
  if (entry.k && entry.k.some((k) => FORMAL_KANJI_KEYWORDS.some((kw) => k.includes(kw)))) return true;
  const glossText = (entry.g || []).flat().join(" ").toLowerCase();
  return FORMAL_GLOSS_KEYWORDS.some((kw) => glossText.includes(kw));
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function jimakuGet(url, apiKey) {
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Jimaku ${res.status} — ${url}`);
  return res.json();
}

async function fetchCues(entryId, episode, apiKey) {
  const files = await jimakuGet(`${JIMAKU_API_BASE}/entries/${entryId}/files?episode=${episode}`, apiKey);
  const textFiles = files.filter((f) => !ARCHIVE_RE.test(f.name));
  const file = textFiles[0];
  const res = await fetch(file.url, { headers: { Authorization: apiKey } });
  const raw = await res.text();
  const isAss = /\.(ass|ssa)$/i.test(file.name);
  const { parseSrt } = require("../subtitle-parser.js");
  return { cues: isAss ? parseAss(raw) : parseSrt(raw), fileName: file.name };
}

async function main() {
  console.log("Loading jmdict-compact.json...");
  const compact = JSON.parse(fs.readFileSync(COMPACT_PATH, "utf8"));

  // Recomputes the exact same TUBELEX score apply-tubelex-frequency.js
  // computes, so this script's candidate pool is the REAL orphaned set
  // (common:true AND score===0) rather than every common:true entry —
  // matters because the corpus-hit relative-rank step below needs to rank
  // ONLY among genuinely orphaned entries; including already-well-scored
  // entries in that pool would skew the top-half/bottom-half split.
  console.log("Loading TUBELEX lemma TSV to recompute scores (same logic as apply-tubelex-frequency.js)...");
  const UNIDIC_TOP_CLASS_TO_CATEGORY = {
    名詞: "noun", 動詞: "verb", 形容詞: "adj", 形状詞: "adj", 副詞: "adv",
    連体詞: "adj", 接続詞: "conj", 感動詞: "interjection", 助詞: "particle",
    助動詞: "aux", 接頭辞: "prefix", 接尾辞: "suffix", 代名詞: "pronoun",
  };
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
  const freqMap = new Map();
  {
    const raw = fs.readFileSync(tubelexTsvPath, "utf8");
    let lineStart = raw.indexOf("\n") + 1;
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
  const entryToKeys = new Map();
  for (const key of Object.keys(compact.index)) {
    for (const idx of compact.index[key]) {
      let keys = entryToKeys.get(idx);
      if (!keys) entryToKeys.set(idx, (keys = []));
      keys.push(key);
    }
  }
  function toHiragana(str) {
    let result = "";
    for (const ch of str) {
      const code = ch.codePointAt(0);
      result += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
    }
    return result;
  }
  const KANA_ONLY_RE = /^[ぁ-ゟァ-ヿー]+$/;
  function entryCategoriesFor(idx) {
    const categories = new Set();
    for (const p of compact.entries[idx].p ?? []) {
      const cat = jmdictCategory(p);
      if (cat) categories.add(cat);
    }
    return categories;
  }
  const scoreByEntry = new Int32Array(compact.entries.length);
  for (const [idx, keys] of entryToKeys) {
    const ownReading = toHiragana(compact.entries[idx].r ?? "");
    const categories = entryCategoriesFor(idx);
    let best = 0;
    for (const key of keys) {
      if (KANA_ONLY_RE.test(key) && toHiragana(key) !== ownReading) continue;
      const f = freqMap.get(key);
      if (f === undefined) continue;
      if (categories.size > 0 && f.category && !categories.has(f.category)) continue;
      if (f.count > best) best = f.count;
    }
    if (best > 0) scoreByEntry[idx] = best;
  }

  console.log("Finding truly orphaned entries (common:true AND zero TUBELEX score)...");
  const orphanCandidates = [];
  for (let idx = 0; idx < compact.entries.length; idx++) {
    const e = compact.entries[idx];
    if (e.c && e.id !== undefined && scoreByEntry[idx] === 0) orphanCandidates.push(e);
  }
  console.log(`${orphanCandidates.length} genuinely orphaned entries (common:true, score 0).`);

  console.log("\nParsing raw JMdict_e.xml for priority tags (regex-scoped, no DTD entity resolution)...");
  const xml = fs.readFileSync(xmlPath, "utf8");
  const entryBlocks = xml.split("<entry>").slice(1);
  const idToPriority = new Map();
  const ENT_SEQ_RE = /<ent_seq>(\d+)<\/ent_seq>/;
  const PRI_RE = /<(?:ke_pri|re_pri)>([^<]+)<\/(?:ke_pri|re_pri)>/g;
  for (const block of entryBlocks) {
    const idMatch = ENT_SEQ_RE.exec(block);
    if (!idMatch) continue;
    const pris = new Set();
    let m;
    PRI_RE.lastIndex = 0;
    while ((m = PRI_RE.exec(block))) pris.add(m[1]);
    if (pris.size > 0) idToPriority.set(idMatch[1], [...pris]);
  }
  console.log(`${idToPriority.size} raw entries carry a priority tag.`);

  console.log("\nBuilding kuromoji tokenizer...");
  const tokenizer = await new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: DICT_PATH }).build((err, t) => (err ? reject(err) : resolve(t)));
  });

  console.log("\nFetching + tokenizing the batch-test corpus for real occurrence counts...");
  const apiKey = process.env.JIMAKU_API_KEY;
  if (!apiKey) throw new Error("JIMAKU_API_KEY not set");
  const corpusCounts = new Map(); // word -> count (word = the same lookup key groupTokens/content.js would use)
  for (const show of SHOWS) {
    for (const ep of show.episodes) {
      process.stdout.write(`  ${show.name} ep ${ep}… `);
      const { cues, fileName } = await fetchCues(show.entryId, ep, apiKey);
      console.log(`${cues.length} cues from ${fileName}`);
      for (const cue of cues) {
        const text = cue.text.trim();
        if (!text || !JAPANESE_WORD_RE.test(text) || NOISE_LINE_RE.test(text)) continue;
        const tokens = tokenizer.tokenize(text);
        const candidates = findPhraseMatchCandidates(tokens);
        let groups;
        if (!candidates.length) {
          groups = groupTokens(tokens);
        } else {
          const membership = {};
          for (const c of candidates) {
            if (membership[c.lookupText] !== undefined) continue;
            const idxs = compact.index[c.lookupText] ?? [];
            const posCodes = [...new Set(idxs.flatMap((i) => compact.entries[i].p ?? []))];
            membership[c.lookupText] = { exists: idxs.length > 0, posCodes };
          }
          const { fuseSpans, dualViewSpans } = classifyAndSelectPhraseMatches(tokens, candidates, membership);
          groups = applyPhraseMatches(tokens, fuseSpans, dualViewSpans);
        }
        for (const g of groups) {
          if (g.word === null) continue;
          corpusCounts.set(g.word, (corpusCounts.get(g.word) || 0) + 1);
        }
      }
      await sleep(2500);
    }
  }
  console.log(`Corpus built: ${corpusCounts.size} unique lookup words.`);

  console.log("\nAssigning tiers to orphaned candidates...");
  const withCorpusHit = [];
  const overrides = {};
  let nfAssigned = 0, corpusAssigned = 0, demoted = 0;

  function bestNf(pri) {
    let best = null;
    for (const p of pri) {
      const m = /^nf(\d+)$/.exec(p);
      if (m) best = best === null ? Number(m[1]) : Math.min(best, Number(m[1]));
    }
    return best;
  }

  for (const entry of orphanCandidates) {
    const corpusHit = corpusCounts.get(entry.r) || (entry.k && entry.k.reduce((sum, k) => sum + (corpusCounts.get(k) || 0), 0)) || 0;
    if (corpusHit > 0) {
      withCorpusHit.push({ entry, count: corpusHit });
      continue;
    }
    const pri = idToPriority.get(String(entry.id));
    if (!pri) continue; // shouldn't happen (common:true implies a priority tag) — defensive only
    const nf = bestNf(pri);
    let tier = nf !== null ? (nf <= 12 ? "common" : "uncommon") : "uncommon"; // ichi/spec/gai-only, no nf number
    if (isFormalRegister(entry)) {
      demoted++;
      if (tier === "common") tier = "uncommon";
      else continue; // uncommon -> demoted to no forced tier at all
    }
    overrides[entry.id] = tier;
    nfAssigned++;
  }

  // Corpus-hit entries: relative rank within THIS set decides tier (rough
  // rank-order over a 3-episode corpus, not real percentiles) — top half by
  // count -> common, rest -> uncommon. Formal-register demotion still
  // applies even with a corpus hit (a political term appearing once in
  // Frieren doesn't stop being newspaper-register).
  withCorpusHit.sort((a, b) => b.count - a.count);
  const half = Math.ceil(withCorpusHit.length / 2);
  withCorpusHit.forEach(({ entry, count }, i) => {
    let tier = i < half ? "common" : "uncommon";
    if (isFormalRegister(entry)) {
      demoted++;
      if (tier === "common") tier = "uncommon";
      else return;
    }
    overrides[entry.id] = tier;
    corpusAssigned++;
  });

  console.log(`\nCorpus-hit orphaned entries: ${withCorpusHit.length}`);
  console.log(`Assigned via corpus rank: ${corpusAssigned}`);
  console.log(`Assigned via nf-priority fallback: ${nfAssigned}`);
  console.log(`Demoted (formal-register match): ${demoted}`);
  console.log(`Total overrides written: ${Object.keys(overrides).length}`);

  fs.writeFileSync(OUT_PATH, JSON.stringify(overrides, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
