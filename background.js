// Runs the actual Jimaku API calls. This has to live here rather than in
// content.js because Chrome is removing cross-origin fetch from content
// scripts — only extension pages/service workers can fetch other origins.

importScripts("subtitle-parser.js", "tokenize-utils.js");

const JIMAKU_API_BASE = "https://jimaku.cc/api";

// Phase 5 — Anki export. AnkiConnect (a local Anki add-on, not a hosted
// service) runs an HTTP server on the user's own machine while Anki is open;
// every action (listing decks, adding a note, etc.) is one POST request with
// an `action`/`version`/`params` body, responding `{result, error}` — `error`
// is non-null on failure rather than an HTTP error status, so a successful
// fetch() doesn't by itself mean the action succeeded. This one helper is the
// only place that talks to AnkiConnect directly; every later Phase 5 feature
// (card creation, deck/model listing, the "Anki isn't open" error state)
// calls through it rather than building its own fetch.
const ANKICONNECT_URL = "http://127.0.0.1:8765";
const ANKICONNECT_VERSION = 6;

async function invokeAnkiConnect(action, params = {}) {
  let response;
  try {
    response = await fetch(ANKICONNECT_URL, {
      method: "POST",
      body: JSON.stringify({ action, version: ANKICONNECT_VERSION, params }),
    });
  } catch {
    // A network-level failure here (not an AnkiConnect `error` field) means
    // there was nothing listening on the port at all — Anki isn't open, or
    // the AnkiConnect add-on isn't installed/enabled. Distinct message from
    // the `data.error` case below (a real AnkiConnect-level failure, e.g. a
    // bad deck name) so the eventual UI can tell the two apart.
    throw new Error("Couldn't reach Anki — make sure Anki is open and the AnkiConnect add-on is installed.");
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data.result;
}

// Deliberately a dedicated deck + note type ("Japanese Immersion"), not
// reusing Anki's stock "Basic" (only 2 fields — not enough room to keep
// word/reading/gloss/sentence as independently stylable fields) and not the
// user's own "Kaishi 1.5k" deck (their existing curated study deck — user's
// explicit call 2026-07-17 to keep immersion-sourced cards separate from it).
// Card direction is sentence-first (also the user's call, 2026-07-17): the
// FRONT shows the captured sentence with the target word already bolded
// (the caller is responsible for wrapping the word in `<b>` before it
// reaches here — this function doesn't parse or rewrite the sentence HTML
// itself), testing recall from real context; the BACK reveals word/reading/
// gloss. Matches this project's core-loop goal (confirm what you half-know
// from the actual scene) better than a word-first traditional flashcard.
const ANKI_DECK_NAME = "Japanese Immersion";
const ANKI_MODEL_NAME = "Japanese Immersion";
// "POS" (2026-07-17) and "Frequency" (2026-07-19) are opt-in metadata
// fields — always PRESENT on the note type, but the caller sends an empty
// string unless the user has the corresponding toggle on (see addAnkiNote),
// and the template's `{{#POS}}...{{/POS}}` / `{{#Frequency}}...{{/Frequency}}`
// conditionals just render nothing for an empty field, so opting out looks
// identical to a card created before that field existed at all.
const ANKI_MODEL_FIELDS = ["Word", "Reading", "Gloss", "Sentence", "POS", "Frequency"];

const ANKI_MODEL_CSS = `
.card {
  font-family: sans-serif;
  font-size: 22px;
  text-align: center;
  color: black;
  background-color: white;
}
.sentence {
  font-size: 26px;
  margin-bottom: 10px;
}
.sentence b {
  color: #1a7f37;
}
.word {
  font-size: 32px;
  font-weight: bold;
  margin-top: 10px;
}
.reading {
  font-size: 20px;
  color: #555;
}
.gloss {
  font-size: 20px;
  margin-top: 8px;
}
.pos {
  font-size: 14px;
  color: #888;
  margin-top: 6px;
}
.frequency {
  font-size: 14px;
  color: #888;
  margin-top: 6px;
}
`;

const ANKI_FRONT_TEMPLATE = `<div class="sentence">{{Sentence}}</div>`;
const ANKI_BACK_TEMPLATE = `{{FrontSide}}
<hr id="answer">
<div class="word">{{Word}}</div>
<div class="reading">{{Reading}}</div>
<div class="gloss">{{Gloss}}</div>
{{#POS}}<div class="pos">{{POS}}</div>{{/POS}}
{{#Frequency}}<div class="frequency">{{Frequency}}</div>{{/Frequency}}`;

// Idempotent — checks before creating, so it's safe to call before every
// single card add (e.g. in case the user deletes the deck/note type in
// Anki later) rather than assuming a one-time setup step already ran.
async function ensureAnkiSetup() {
  const [decks, models] = await Promise.all([invokeAnkiConnect("deckNames"), invokeAnkiConnect("modelNames")]);
  if (!decks.includes(ANKI_DECK_NAME)) {
    await invokeAnkiConnect("createDeck", { deck: ANKI_DECK_NAME });
  }
  if (!models.includes(ANKI_MODEL_NAME)) {
    await invokeAnkiConnect("createModel", {
      modelName: ANKI_MODEL_NAME,
      inOrderFields: ANKI_MODEL_FIELDS,
      css: ANKI_MODEL_CSS,
      cardTemplates: [{ Name: "Card 1", Front: ANKI_FRONT_TEMPLATE, Back: ANKI_BACK_TEMPLATE }],
    });
    return;
  }
  // Model already existed (e.g. created in an earlier session/test before a
  // new opt-in field like POS existed) — add any missing fields rather than
  // recreating the model, which would orphan every existing card. Reapplies
  // the current template on every call regardless of whether a field was
  // just added (cheap, idempotent), so an older install picks up template
  // changes (like the new conditional POS line) without needing a fresh
  // model — the alternative (only updating templates when a field was
  // added) would silently skip template-only changes with no field change.
  const existingFields = await invokeAnkiConnect("modelFieldNames", { modelName: ANKI_MODEL_NAME });
  for (const field of ANKI_MODEL_FIELDS) {
    if (!existingFields.includes(field)) {
      await invokeAnkiConnect("modelFieldAdd", { modelName: ANKI_MODEL_NAME, fieldName: field });
    }
  }
  await invokeAnkiConnect("updateModelTemplates", {
    model: { name: ANKI_MODEL_NAME, templates: { "Card 1": { Front: ANKI_FRONT_TEMPLATE, Back: ANKI_BACK_TEMPLATE } } },
  });
}

// `sentenceHtml` is expected to already have the target word wrapped in
// `<b>...</b>` (Anki fields render as HTML) — this function just moves data
// into AnkiConnect's `addNote` shape, it doesn't do any text processing of
// its own. Duplicate detection is AnkiConnect's own default behavior (first
// field, i.e. Word, must be unique within the note type) — not overridden
// here, so adding the exact same word twice fails with a clear AnkiConnect
// error rather than silently creating a duplicate card. `pos` is optional
// (the opt-in toggle, 2026-07-17) — sent as an empty string when absent, not
// omitted, since the field must exist on every note either way and the
// template already renders nothing for an empty value.
async function addAnkiNote({ word, reading, gloss, sentenceHtml, pos, frequency }) {
  await ensureAnkiSetup();
  return invokeAnkiConnect("addNote", {
    note: {
      deckName: ANKI_DECK_NAME,
      modelName: ANKI_MODEL_NAME,
      fields: { Word: word, Reading: reading, Gloss: gloss, Sentence: sentenceHtml, POS: pos ?? "", Frequency: frequency ?? "" },
      options: { allowDuplicate: false },
      tags: ["japanese-immersion-extension"],
    },
  });
}

// Archive files (bulk multi-episode downloads) can't be parsed as subtitle
// text directly — same filter already used in scripts/batch-test.js, ported
// here since production fetchSubtitles never had it (confirmed real gap
// 2026-07-06: Naruto ep 1's Jimaku files list a .zip as its first entry,
// which `files[0]` would have picked blindly and failed to parse).
const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;

// "Best subtitle" selection (Phase 4.5, 2026-07-15) — a hardcoded uploader-
// preference list, not real popularity-based ranking. Confirmed directly
// against the real Jimaku API before building this that no per-file or
// per-entry popularity/usage signal exists at all (view count, downloads,
// favorites — nothing), so ranking by real usage data isn't an option here;
// see project-plan.md Decisions Log 2026-07-15. Seeded from uploaders
// actually seen working well across this project's own live-testing so far
// (SubsPlease: Bocchi/Frieren; Haruhana: Witch Hat Atelier; VCB-Studio:
// confirmed real via the half-width-katakana releases fix) — a living list
// to extend as more shows surface reliable uploaders, not a general "best
// fansub groups" ranking pulled from outside knowledge. There's no
// structured uploader field in Jimaku's file objects (confirmed same
// session: only `url`/`name`/`size`/`last_modified`) — a release group only
// appears as a bracket tag baked into the filename (e.g. "[Haruhana] ..."),
// so matching is filename-substring, same mechanism `fileHint` already uses.
const PREFERRED_UPLOADERS = ["SubsPlease", "Haruhana", "VCB-Studio"];

// Sorts ALL candidate files by uploader preference (preferred uploaders
// first, in list order; everything else keeps Jimaku's own original relative
// order after) — not just picking one, so the switcher panel (Phase 4.5,
// 2026-07-15) can show every candidate ranked, not only the auto-selected
// winner. `rankFiles(files)[0]` is the same pick the old single-winner
// `selectPreferredFile` used to return. Doesn't attempt season-level
// disambiguation for shows whose Jimaku entry restart-numbers per season
// (e.g. Naruto: Shippuuden's S07E01-style tagging, Decisions Log 2026-07-06)
// — that needs its own filename-pattern design validated against real
// multi-season data, a separate problem from uploader trust-ranking, not
// solved here. `fileHint` is applied on top of this ranking in
// `fetchSubtitles`, not inside it — this ranking only orders by UPLOADER, not
// language track, so it can't by itself resolve a same-uploader dual-track
// case like Witch Hat Atelier's own CHS+JPN release.
//
// `preferredUploader` (2026-07-16) — the user's own per-show-per-season pick
// (content.js's switcher panel, saved via chrome.storage.local), given top
// priority ahead of the hardcoded PREFERRED_UPLOADERS default when present.
// Implemented by prepending it to the priority list rather than as a special
// case, which gets the "sticky fallback" build-order requirement for free:
// if no candidate file actually matches the user's saved uploader for THIS
// episode, every file's rank falls through to wherever it'd land in the
// unmodified default list anyway — same as if no preference existed at all,
// with nothing written back to storage from here, so a single episode's gap
// never touches the saved show+season preference.
function rankFiles(files, preferredUploader = null) {
  const uploaderPriority = preferredUploader
    ? [preferredUploader, ...PREFERRED_UPLOADERS.filter((u) => u !== preferredUploader)]
    : PREFERRED_UPLOADERS;
  const scored = files.map((f, i) => {
    const rank = uploaderPriority.findIndex((u) => f.name.includes(`[${u}]`));
    return { f, rank: rank === -1 ? uploaderPriority.length : rank, i };
  });
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i);
  return scored.map((s) => s.f);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_SUBTITLES") {
    fetchSubtitles(message.query, message.episode, message.fileHint, message.preferredUploader, message.seasonNumber)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "FETCH_SUBTITLE_FILE") {
    fetchSubtitleFile(message.url, message.name)
      .then((cues) => sendResponse({ cues }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "LOOKUP_WORD") {
    // `metaShowPos`/`metaShowFreq` (Phase 5, 2026-07-17 / 2026-07-19) are
    // bundled into the SAME round trip rather than a second storage read
    // from content.js — the popup already waits on this one message before
    // rendering, so there's no benefit to a separate fetch, and this keeps
    // the toggle's storage key private to background.js (content.js only
    // ever sees the resolved booleans).
    Promise.all([lookupWord(message.word, message.isParticle, message.pos, message.isHonorificSuffix), chrome.storage.local.get(["metaShowPos", "metaShowFreq"])])
      .then(([{ results, posTags }, { metaShowPos, metaShowFreq }]) =>
        sendResponse({ results, posTags, showPos: metaShowPos ?? false, showFreq: metaShowFreq ?? false })
      )
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "CHECK_KANA_MERGES") {
    checkKanaMergeCandidates(message.texts)
      .then((membership) => sendResponse({ membership }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "ANKICONNECT_PING") {
    invokeAnkiConnect("version")
      .then((result) => sendResponse({ result }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "ADD_ANKI_NOTE") {
    addAnkiNote({
      word: message.word,
      reading: message.reading,
      gloss: message.gloss,
      sentenceHtml: message.sentenceHtml,
      pos: message.pos,
      frequency: message.frequency,
    })
      .then((result) => sendResponse({ result }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "DELETE_ANKI_NOTE") {
    invokeAnkiConnect("deleteNotes", { notes: [message.noteId] })
      .then((result) => sendResponse({ result }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  return false;
});

async function getJimakuHeaders() {
  const { jimakuApiKey } = await chrome.storage.local.get("jimakuApiKey");
  if (!jimakuApiKey) {
    throw new Error(
      "No Jimaku API key saved. Click the extension icon and save your key."
    );
  }
  return { Authorization: jimakuApiKey };
}

// Jimaku's search endpoint returns ZERO results for a multi-word query if any
// one word's apostrophe doesn't byte-match its own index — confirmed via
// direct API calls while diagnosing a real "no Jimaku entry found" report for
// Frieren season 2 (2026-07-17): Crunchyroll's JSON-LD spells the title with
// a straight apostrophe ("Journey's End"), Jimaku's own entry uses a
// typographic one ("Journey’s End"), and searching the straight-apostrophe
// form returns nothing even though "Frieren: Beyond" alone (no apostrophe
// word) returns both Frieren entries fine. Stripping the apostrophe entirely
// also returns both entries, and doesn't require guessing which Unicode
// apostrophe variant Jimaku's own index happens to use for a given title, so
// that's the fix — applied to the search query AND to both sides of the
// exact-match comparison below (Jimaku's stored names keep their apostrophe).
function stripApostrophes(s) {
  return s.replace(/['’‘`]/g, "");
}

function normalizeTitle(name) {
  return stripApostrophes(name?.trim().toLowerCase() ?? "");
}

// Jimaku indexes each season of a multi-season show as a SEPARATE entry with
// its own free-text name — no structured season field in the API response
// (confirmed via a real search while diagnosing the same Frieren report:
// entry 729 "Sousou no Frieren" / "Frieren: Beyond Journey's End" is season
// 1, entry 11446 "Sousou no Frieren 2nd Season" / "...Season 2" is season 2).
// Crunchyroll's own partOfSeries.name is stable across a whole franchise's
// seasons (confirmed: season 2 episodes still report the plain, un-suffixed
// title), so the season number has to pick WHICH ENTRY to use, not just
// which file within one entry — the old season-agnostic exact-match always
// landed on whichever entry has no season suffix at all (i.e. season 1's),
// so a season-2 request would have silently served season 1's subtitles
// under a matching episode NUMBER once the apostrophe bug above is fixed,
// with no error at all. Heuristic, not a structured lookup (Jimaku has
// nothing structured to match against instead): strip a trailing "Season N"
// / "Nth Season" marker before the title comparison, and require the
// extracted N to equal the detected season, defaulting an entry with no
// marker to season 1.
const SEASON_SUFFIX_RE = /\s*(?:(\d+)(?:st|nd|rd|th)?\s*season|season\s*(\d+))\s*$/i;

function stripSeasonSuffix(name) {
  return name ? name.replace(SEASON_SUFFIX_RE, "").trim() : name;
}

function entrySeasonNumber(name) {
  const m = name?.match(SEASON_SUFFIX_RE);
  return m ? Number(m[1] ?? m[2]) : 1;
}

// Resolves a show/episode query down to the candidate text-file list — the
// part `fetchSubtitles` (auto-load) and the switcher panel's file listing
// both need, factored out so a switcher-panel refresh doesn't duplicate this
// search+files-list round trip inside its own separate function.
async function resolveTextFiles(query, episode, headers, seasonNumber = null) {
  const searchUrl = `${JIMAKU_API_BASE}/entries/search?anime=true&query=${encodeURIComponent(
    stripApostrophes(query)
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
  // case-insensitive name match over just taking the first hit — and among
  // exact matches, prefer one whose season suffix (if any) matches the
  // detected season, so a multi-season show doesn't default to season 1's
  // entry when season 2+ is requested (see comments above).
  const normalizedQuery = normalizeTitle(query);
  const wantedSeason = seasonNumber ?? 1;
  const seasonMatch = entries.find((e) => {
    const seasonOk =
      entrySeasonNumber(e.name) === wantedSeason || entrySeasonNumber(e.english_name) === wantedSeason;
    if (!seasonOk) return false;
    return (
      normalizeTitle(stripSeasonSuffix(e.name)) === normalizedQuery ||
      normalizeTitle(stripSeasonSuffix(e.english_name)) === normalizedQuery
    );
  });
  const plainMatch = entries.find(
    (e) => normalizeTitle(e.name) === normalizedQuery || normalizeTitle(e.english_name) === normalizedQuery
  );
  const entry = seasonMatch ?? plainMatch ?? entries[0];

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
  return textFiles;
}

async function fetchAndParseFile(file, headers) {
  const fileRes = await fetch(file.url, { headers });
  if (!fileRes.ok) {
    throw new Error(`Subtitle download failed (${fileRes.status})`);
  }
  const rawText = await fileRes.text();
  const isAss = /\.(ass|ssa)$/i.test(file.name);
  return isAss ? parseAss(rawText) : parseSrt(rawText);
}

// Auto-load path: resolves candidates, picks one (fileHint override, else
// the top-ranked uploader — the user's own saved preference if any, else
// the hardcoded default), downloads and parses it. Also returns the FULL
// ranked candidate list and which URL got auto-selected (2026-07-15) — the
// switcher panel (content.js) uses this same response to render every
// option without a second, redundant Jimaku round trip, and to pre-select
// the entry that's actually playing rather than guessing at it separately.
async function fetchSubtitles(query, episode, fileHint = null, preferredUploader = null, seasonNumber = null) {
  const headers = await getJimakuHeaders();
  const textFiles = await resolveTextFiles(query, episode, headers, seasonNumber);
  const ranked = rankFiles(textFiles, preferredUploader);
  // Optional manual override for picking a specific file among several
  // candidates Jimaku returns for the same requested episode — needed since
  // Jimaku's own per-file episode tagging isn't always reliable. Confirmed
  // real 2026-07-06: a Hulu-sourced batch upload for Naruto: Shippuuden
  // tags an entire season's worth of files (each using a per-season
  // "SxxE01" restart numbering, e.g. S07E01 = 第144話, episode 144) as
  // "episode 1" — the unfiltered first-match pick would silently grab the
  // wrong episode's subtitles. Still kept even now that ranked selection
  // exists (2026-07-15) — it solves a different axis (same-uploader
  // language-track disambiguation, e.g. Witch Hat Atelier's own CHS+JPN
  // dual-track release) that uploader-preference ranking alone can't.
  //
  // Scoped to the TOP-RANKED file's own uploader (2026-07-17), not searched
  // across every candidate — confirmed real via a live report ("stuck on
  // Haruhana no matter what I pick or how I navigate") plus direct Jimaku API
  // verification: Witch Hat Atelier's `FILE_HINT` ("[JPN]") only ever matches
  // Haruhana's own release ("[Haruhana] ... [JPN].ass"), and the old
  // unscoped `textFiles.find(...)` would return that file regardless of
  // `ranked[0]` — silently overriding BOTH the default ranking AND a saved
  // uploader preference for this show, every single time, since nothing
  // about the override respected who `rankFiles` actually chose. `fileHint`
  // was only ever meant to disambiguate BETWEEN one uploader's own multiple
  // releases (Haruhana's dual CHS+JPN cut vs. its JPN-only cut), not compete
  // with uploader selection itself — this restores that original scope by
  // only matching within files that share the top-ranked pick's own bracket
  // tag. Falls through to no hint at all (matching pre-fileHint behavior)
  // when the top pick has no bracket tag to scope by (an unbracketed
  // direct-source file, e.g. Netflix/Amazon).
  const topTag = ranked[0]?.name.match(/^\[([^\]]+)\]/)?.[1];
  const hinted =
    fileHint && topTag
      ? textFiles.find(
          (f) => f.name.startsWith(`[${topTag}]`) && f.name.toLowerCase().includes(fileHint.toLowerCase())
        )
      : null;
  const file = hinted ?? ranked[0];
  const cues = await fetchAndParseFile(file, headers);
  return {
    cues,
    files: ranked.map((f) => ({ name: f.name, url: f.url, size: f.size })),
    selectedUrl: file.url,
  };
}

// Manual switcher-panel pick (Phase 4.5, 2026-07-15) — downloads and parses
// one SPECIFIC file the user chose from the ranked list `fetchSubtitles`
// already returned, bypassing the auto-selection entirely. Doesn't need
// `resolveTextFiles` again since the caller already has the file's `url`/
// `name` from that earlier response.
async function fetchSubtitleFile(url, name) {
  const headers = await getJimakuHeaders();
  return fetchAndParseFile({ url, name }, headers);
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

async function lookupWord(word, isParticle = false, pos = null, isHonorificSuffix = false) {
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
  // `isDirect` — true when `word` IS this entry's own primary reading, false
  // when it only matched via an alternate kana reading listed in `rs`. Kept
  // alongside `display` (rather than checked against `display.r` later) since
  // the rs-swap below overwrites `display.r` to equal `word` for ANY entry
  // that lists it as an alternate — after that swap, r === word is true for
  // every candidate, direct or not, so the distinction has to be captured
  // before it's erased.
  let candidates = entryIndexes.map((i) => {
    const entry = jmdict.entries[i];
    const isDirect = entry.r === word;
    const display = entry.rs && entry.rs.includes(word) && entry.r !== word ? { ...entry, r: word } : entry;
    return { display, isDirect };
  });
  if (isParticle) {
    // Filter to particle-sense entries only (JMdict POS code "prt").
    // Falls back to all entries if the particle isn't in the index as "prt"
    // (e.g. obscure sentence-final particles not in jmdict-compact.json).
    const particleCandidates = candidates.filter((c) => c.display.p && c.display.p.includes("prt"));
    if (particleCandidates.length > 0) candidates = particleCandidates;
    // A particle reached only via an entry's SECONDARY kana reading (bare て
    // matching quotative って's entry, which lists て as a colloquial-
    // contraction alternate reading alongside its primary って) can
    // coincidentally outrank the entry whose PRIMARY reading actually IS the
    // word looked up (て's own plain connective entry) — both are real,
    // correctly prt-tagged entries, so the filter above can't tell them
    // apart. Confirmed real via live testing: 気づかなくて's て card showed
    // quotative って's senses ("you said", "do you seriously think that")
    // alongside the correct connective て senses. When at least one surviving
    // candidate's own primary reading IS the word being looked up, prefer
    // those and drop the ones reached only through an alternate — doesn't
    // touch the rs-swap display-precision feature above (くる → 刳る), which
    // only affects HOW an already-selected entry displays its reading, never
    // which entries get selected.
    const direct = candidates.filter((c) => c.isDirect);
    if (direct.length > 0) candidates = direct;
  } else if (isHonorificSuffix) {
    // Mirrors the isParticle filter above, but for JMdict POS code "suf" —
    // an honorific personal-name suffix (さん, さま, くん, ちゃん, 様, 氏, ...)
    // shares its bare kana reading with unrelated ordinary-noun homographs
    // far more often than not (さん alone also reaches 酸 "acid", 三 "three",
    // 讃 "praise", ...), and the generic POS_CATEGORY_MATCHERS["名詞"] matcher
    // below can't tell them apart — it accepts any "n"-prefixed code, which
    // every one of those unrelated nouns also carries. Confirmed real via
    // live testing: 仕立て屋さん's さん card showed 酸/三/讃 instead of the
    // honorific sense. See tokenize-utils.js's isHonorificSuffix detection
    // (kuromoji's own 名詞/接尾/人名 tagging) for the general, non-word-
    // specific trigger.
    const sufCandidates = candidates.filter((c) => c.display.p && c.display.p.includes("suf"));
    if (sufCandidates.length > 0) candidates = sufCandidates;
  } else if (pos && POS_CATEGORY_MATCHERS[pos]) {
    const matcher = POS_CATEGORY_MATCHERS[pos];
    const posCandidates = candidates.filter((c) => c.display.p && c.display.p.some(matcher));
    if (posCandidates.length > 0) candidates = posCandidates;
  }
  return { results: candidates.map((c) => c.display), posTags: jmdict.posTags };
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
