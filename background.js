// Runs the actual Jimaku API calls. This has to live here rather than in
// content.js because Chrome is removing cross-origin fetch from content
// scripts — only extension pages/service workers can fetch other origins.

importScripts("subtitle-parser.js", "tokenize-utils.js");

const JIMAKU_API_BASE = "https://jimaku.cc/api";

// Archive files (bulk multi-episode downloads) can't be parsed as subtitle
// text directly — same filter already used in scripts/batch-test.js, ported
// here since production fetchSubtitles never had it (confirmed real gap
// 2026-07-06: Naruto ep 1's Jimaku files list a .zip as its first entry,
// which `files[0]` would have picked blindly and failed to parse).
const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_SUBTITLES") {
    fetchSubtitles(message.query, message.episode, message.fileHint)
      .then((cues) => sendResponse({ cues }))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "LOOKUP_WORD") {
    lookupWord(message.word, message.isParticle, message.pos)
      .then(({ results, posTags }) => sendResponse({ results, posTags }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "CHECK_KANA_MERGES") {
    checkKanaMergeCandidates(message.texts)
      .then((membership) => sendResponse({ membership }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

async function fetchSubtitles(query, episode, fileHint = null) {
  const { jimakuApiKey } = await chrome.storage.local.get("jimakuApiKey");
  if (!jimakuApiKey) {
    throw new Error(
      "No Jimaku API key saved. Click the extension icon and save your key."
    );
  }
  const headers = { Authorization: jimakuApiKey };

  const searchUrl = `${JIMAKU_API_BASE}/entries/search?anime=true&query=${encodeURIComponent(
    query
  )}`;
  const searchRes = await fetch(searchUrl, { headers });
  if (!searchRes.ok) {
    throw new Error(`Jimaku search failed (${searchRes.status})`);
  }
  const entries = await searchRes.json();
  if (!entries.length) {
    throw new Error(`No Jimaku entry found for "${query}"`);
  }
  // A plain substring search often returns films/specials/OVAs sharing the
  // main series' name (e.g. "One Piece" matches 26 entries). Prefer an exact
  // case-insensitive name match over just taking the first hit.
  const normalizedQuery = query.trim().toLowerCase();
  const entry =
    entries.find(
      (e) =>
        e.name?.trim().toLowerCase() === normalizedQuery ||
        e.english_name?.trim().toLowerCase() === normalizedQuery
    ) ?? entries[0];

  const filesUrl = `${JIMAKU_API_BASE}/entries/${entry.id}/files?episode=${episode}`;
  const filesRes = await fetch(filesUrl, { headers });
  if (!filesRes.ok) {
    throw new Error(`Jimaku file lookup failed (${filesRes.status})`);
  }
  const files = await filesRes.json();
  if (!files.length) {
    throw new Error(`No subtitle file found for episode ${episode}`);
  }
  const textFiles = files.filter((f) => !ARCHIVE_RE.test(f.name));
  if (!textFiles.length) {
    throw new Error(
      `Only archive files found for episode ${episode} (${files
        .map((f) => f.name)
        .join(", ")}) — use the manual upload fallback instead`
    );
  }
  // Optional manual override for picking a specific file among several
  // candidates Jimaku returns for the same requested episode — needed since
  // Jimaku's own per-file episode tagging isn't always reliable. Confirmed
  // real 2026-07-06: a Hulu-sourced batch upload for Naruto: Shippuuden
  // tags an entire season's worth of files (each using a per-season
  // "SxxE01" restart numbering, e.g. S07E01 = 第144話, episode 144) as
  // "episode 1" — the unfiltered first-match pick would silently grab the
  // wrong episode's subtitles. `fileHint` (a case-insensitive filename
  // substring) is a stopgap for exactly this until Phase 4.5's real ranked
  // "best subtitle" selection ships — falls back to the first text file
  // when no hint is given or nothing matches, same as before.
  const hinted = fileHint
    ? textFiles.find((f) => f.name.toLowerCase().includes(fileHint.toLowerCase()))
    : null;
  const file = hinted ?? textFiles[0];

  const fileRes = await fetch(file.url, { headers });
  if (!fileRes.ok) {
    throw new Error(`Subtitle download failed (${fileRes.status})`);
  }
  const rawText = await fileRes.text();

  const isAss = /\.(ass|ssa)$/i.test(file.name);
  return isAss ? parseAss(rawText) : parseSrt(rawText);
}

// Lazily loaded once per service worker lifetime, then kept in memory.
// { entries: [{r, g: [...], p?: [posCode, ...], c?: true}],
//   index: {surfaceForm: [entryIdx, ...]}, posTags: {posCode: "plain English label"} }
let jmdictPromise = null;

function loadJmdict() {
  if (!jmdictPromise) {
    jmdictPromise = fetch(chrome.runtime.getURL("jmdict-compact.json")).then(
      (res) => res.json()
    );
  }
  return jmdictPromise;
}

// Maps kuromoji's coarse Japanese POS category to a check against JMdict's
// finer POS codes. A light "reject a clearly mismatched word class" filter —
// e.g. ruling out a pure-noun homograph when kuromoji tagged the clicked
// token as a verb. Doesn't attempt real sense disambiguation: two entries in
// the *same* coarse category (こと's zither vs. thing — both nouns) still
// aren't distinguished by this. Same safe-fallback pattern as the existing
// particle filter below: only narrows results if at least one entry actually
// matches, so a gap in this mapping can never hide every result.
const POS_CATEGORY_MATCHERS = {
  動詞: (p) => p.startsWith("v"),
  形容詞: (p) => p === "adj-i" || p === "adj-ix",
  名詞: (p) => p.startsWith("n") || p === "pn" || p.startsWith("adj-na") || p === "adj-no",
  副詞: (p) => p.startsWith("adv"),
  連体詞: (p) => p === "adj-pn",
  接続詞: (p) => p === "conj",
  感動詞: (p) => p === "int",
  接頭詞: (p) => p.startsWith("n-pref") || p === "pref",
  助動詞: (p) => p.startsWith("aux"),
  // Not a real kuromoji tag — tokenize-utils.js's groupTokens sets this
  // sentinel `pos` on every phrase-matcher fuse-outcome group (からといって,
  // じゃない, んだ, そうか), since a fused span covering multiple raw tokens of
  // possibly-mixed POS has no single natural kuromoji category to inherit.
  // JMdict's own "exp"/"int" codes are the closest fit for a fused
  // colloquial phrase/expression — confirmed real fix for そうか, which
  // otherwise showed unrelated noun homographs (層化, 装花) sharing the same
  // reading with no filtering applied at all (2026-07-06).
  __phraseFuse: (p) => p === "exp" || p === "int",
};

// normalizeHalfwidthKatakana is defined in tokenize-utils.js (imported above)
// — jmdict-compact.json's index is full-width-only (confirmed 2026-07-01),
// so this still runs a second time here as a defense-in-depth normalization
// at the JMdict-index-lookup layer even though content.js now also
// normalizes the raw subtitle text up front (fixes half-width display).

// Formats a digit string (half- or full-width) as a comma-grouped gloss
// (1234 → "1,234") — Western thousands-grouping, since the gloss is the
// popup's English-facing side, distinct from the reading's Japanese
// base-10000 grouping (see numberToReading in tokenize-utils.js).
function formatNumberGloss(digitStr) {
  const halfwidth = digitStr.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const trimmed = halfwidth.replace(/^0+(?=\d)/, "");
  return trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function lookupWord(word, isParticle = false, pos = null) {
  const jmdict = await loadJmdict();
  word = normalizeHalfwidthKatakana(word);
  // jmdict-compact.json's own numeral entries (0-9, most round tens/hundreds/
  // thousands, 10000) are indexed under full-width digit glyphs, not the
  // ASCII ones a subtitle actually contains — same normalize-for-lookup-only
  // pattern as normalizeHalfwidthKatakana above.
  if (NUMERAL_ONLY_RE.test(word)) word = normalizeDigitsToFullwidth(word);
  let entryIndexes = jmdict.index[word] ?? [];
  if (entryIndexes.length === 0 && NUMERAL_ONLY_RE.test(word)) {
    // Fallback only, same shape as every other lookupWord fallback: JMdict
    // only carries entries for a finite set of round numbers (confirmed
    // against the compact file directly) — any other digit combination
    // (24, 456, 2019, ...) gets a synthesized reading instead of a real
    // dictionary hit. numberToReading is a closed, deterministic algorithm
    // (standard Japanese numeral construction, including the real sound-change
    // irregulars for 百/千 — see tokenize-utils.js), not a per-number lookup
    // table, so it needs no maintenance as new numbers show up in dialogue.
    return {
      // g is grouped by sense (array of arrays, since 2026-07-06) — a single
      // synthesized "sense" containing one gloss, matching jmdict-compact.json's
      // real entries' shape so content.js's numbered-gloss rendering works
      // the same way for both.
      results: [{ r: numberToReading(word), g: [[formatNumberGloss(word)]], p: ["num"] }],
      posTags: jmdict.posTags,
    };
  }
  if (entryIndexes.length === 0) {
    // Fallback only, never applied to an already-successful lookup: a small
    // vowel written directly after its own large-vowel counterpart (おぉ) is a
    // real expressive-writing convention JMdict's own reading list doesn't
    // enumerate (see collapseVowelElongation in tokenize-utils.js) — try again
    // with it collapsed before giving up.
    const collapsed = collapseVowelElongation(word);
    if (collapsed !== word) entryIndexes = jmdict.index[collapsed] ?? [];
  }
  if (entryIndexes.length === 0) {
    // Fallback only, same shape as the vowel-elongation one above: kuromoji
    // doesn't recognize every godan potential form (輝ける has zero
    // conjugation signal at all in its own tokenization — see
    // derivePotentialFormBase in tokenize-utils.js), so try reverse-deriving
    // the plain dictionary form and looking that up instead. Filtered to
    // godan-tagged entries only (v5*) — potential form is specifically a
    // godan pattern, so this can't accidentally accept an unrelated ichidan
    // verb or noun/adjective that happens to share the derived spelling.
    const potentialBase = derivePotentialFormBase(word);
    if (potentialBase) {
      const candidates = selectPotentialFormMatches(jmdict.index[potentialBase] ?? [], jmdict);
      if (candidates.length > 0) entryIndexes = candidates;
    }
  }
  // jmdict-compact.json only carries one canonical reading (`r`) directly,
  // but an entry reachable via a genuinely different, legitimate alternate
  // reading (e.g. くる resolving to 刳る, a rare kanji spelling of 抉る) needs
  // to display THAT reading, not the entry's primary one (えぐる) — the
  // 2026-07-05 regeneration added `rs` (the entry's full reading list) to
  // support this. Copies the entry rather than mutating it in place — these
  // are the same shared objects cached in `jmdict.entries` across every
  // future lookup this service-worker lifetime.
  let results = entryIndexes.map((i) => {
    const entry = jmdict.entries[i];
    if (entry.rs && entry.rs.includes(word) && entry.r !== word) {
      return { ...entry, r: word };
    }
    return entry;
  });
  if (isParticle) {
    // Filter to particle-sense entries only (JMdict POS code "prt").
    // Falls back to all entries if the particle isn't in the index as "prt"
    // (e.g. obscure sentence-final particles not in jmdict-compact.json).
    const particleResults = results.filter((r) => r.p && r.p.includes("prt"));
    if (particleResults.length > 0) results = particleResults;
  } else if (pos && POS_CATEGORY_MATCHERS[pos]) {
    const matcher = POS_CATEGORY_MATCHERS[pos];
    const posResults = results.filter((r) => r.p && r.p.some(matcher));
    if (posResults.length > 0) results = posResults;
  }
  return { results, posTags: jmdict.posTags };
}

// Used by content.js to check whether a run of adjacent hiragana tokens that
// kuromoji split apart is actually a single JMdict word (e.g. ただいま getting
// fragmented into た+だ+いま next to punctuation, or かくれんぼ split by a
// mid-word elongation mark). posCodes lets tokenize-utils.js's applyKanaMerges
// apply its function-word gate on punctuation-triggered candidates.
async function checkKanaMergeCandidates(texts) {
  const jmdict = await loadJmdict();
  const membership = {};
  for (const text of texts) {
    // Keyed by the original (possibly half-width) text so callers can look
    // it up by whatever candidate string they generated — only the index
    // lookup itself uses the normalized form.
    const entryIndexes = jmdict.index[normalizeHalfwidthKatakana(text)] ?? [];
    const posCodes = [...new Set(entryIndexes.flatMap((i) => jmdict.entries[i].p ?? []))];
    membership[text] = { exists: entryIndexes.length > 0, posCodes };
  }
  return membership;
}
