// Runs the actual Jimaku API calls. This has to live here rather than in
// content.js because Chrome is removing cross-origin fetch from content
// scripts — only extension pages/service workers can fetch other origins.

importScripts("subtitle-parser.js", "tokenize-utils.js");

const JIMAKU_API_BASE = "https://jimaku.cc/api";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_SUBTITLES") {
    fetchSubtitles(message.query, message.episode)
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

async function fetchSubtitles(query, episode) {
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
  const file = files[0];

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
};

// normalizeHalfwidthKatakana is defined in tokenize-utils.js (imported above)
// — jmdict-compact.json's index is full-width-only (confirmed 2026-07-01),
// so this still runs a second time here as a defense-in-depth normalization
// at the JMdict-index-lookup layer even though content.js now also
// normalizes the raw subtitle text up front (fixes half-width display).

async function lookupWord(word, isParticle = false, pos = null) {
  const jmdict = await loadJmdict();
  word = normalizeHalfwidthKatakana(word);
  let entryIndexes = jmdict.index[word] ?? [];
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
