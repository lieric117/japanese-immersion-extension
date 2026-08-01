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
// "POS" (2026-07-17), "Frequency" (2026-07-19), and "JLPT" (2026-07-22) are
// opt-in metadata fields — always PRESENT on the note type, but the caller
// sends an empty string unless the user has the corresponding toggle on (see
// addAnkiNote), and the template's `{{#POS}}...{{/POS}}` /
// `{{#Frequency}}...{{/Frequency}}` / `{{#JLPT}}...{{/JLPT}}` conditionals
// just render nothing for an empty field, so opting out looks identical to a
// card created before that field existed at all.
//
// "Audio" (2026-07-22) is NOT gated by a toggle the same way — it's simply
// empty whenever content.js couldn't produce a clip (capture unavailable, or
// the requested slice had already aged out of the ring buffer), same
// silent-degrade pattern, but there's no separate opt-in setting for it.
// Unlike the other three, its content isn't written directly into the field
// here — AnkiConnect's own `audio` note param (see addAnkiNote) stores the
// file and writes a `[sound:...]` reference into this field itself.
// "Source" (2026-07-23) is the fourth opt-in toggle field, same empty-string-
// when-off pattern as POS/Frequency/JLPT — the show/episode a word was
// encountered in, threaded in from content.js's own detectShowEpisode()
// result (not background.js, which has no way to know which episode is
// currently loaded).
//
// "Translation" (2026-07-23) is NOT opt-in-toggle-gated like Source — it's
// one of the originally-deferred core card fields (grouped with Sentence in
// the 2026-07-02 core-fields decision, not with the POS/Frequency/JLPT
// metadata toggles), simply empty whenever content.js has no matching
// English cue for the capture. Sourced from Crunchyroll's own captions (see
// project-plan.md Decisions Log, 2026-07-23) via content.js's own English-cue
// tracking, not background.js.
const ANKI_MODEL_FIELDS = ["Word", "Reading", "Gloss", "Sentence", "POS", "Frequency", "JLPT", "Audio", "Source", "Translation"];

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
.jlpt {
  font-size: 14px;
  color: #888;
  margin-top: 6px;
}
.audio {
  margin-top: 8px;
}
.source {
  font-size: 12px;
  color: #aaa;
  margin-top: 6px;
}
.translation {
  font-size: 18px;
  color: #555;
  margin-top: 8px;
  font-style: italic;
}
`;

// Audio placed on the FRONT template (not back-only like POS/Frequency/JLPT)
// so it plays as part of the recall prompt itself, not just a reveal — and
// via {{FrontSide}} below, it still shows on the back too, available
// throughout review either way.
const ANKI_FRONT_TEMPLATE = `<div class="sentence">{{Sentence}}</div>
{{#Audio}}<div class="audio">{{Audio}}</div>{{/Audio}}`;
// Translation sits immediately under {{FrontSide}} — i.e. directly below the
// Japanese sentence, above the answer rule — rather than down among the
// metadata fields (2026-07-26). Two things drove the move: it keeps the
// translation adjacent to the sentence it translates instead of separated
// from it by the word/reading/gloss block, and it puts Japanese above
// English in the same order the live subtitle stack uses (see content.css's
// #jp-immersion-subtitle-stack), so the card reads the way the screen did.
// It stays OFF the front template, unchanged from the original 2026-07-23
// design and reaffirmed in live testing: showing the English translation as
// part of the recall prompt would give away the answer before the attempt.
// Each field is its own block-level <div>, so the sentence and translation
// always render on separate lines rather than running together.
const ANKI_BACK_TEMPLATE = `{{FrontSide}}
{{#Translation}}<div class="translation">{{Translation}}</div>{{/Translation}}
<hr id="answer">
<div class="word">{{Word}}</div>
<div class="reading">{{Reading}}</div>
<div class="gloss">{{Gloss}}</div>
{{#POS}}<div class="pos">{{POS}}</div>{{/POS}}
{{#Frequency}}<div class="frequency">{{Frequency}}</div>{{/Frequency}}
{{#JLPT}}<div class="jlpt">{{JLPT}}</div>{{/JLPT}}
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}`;

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
  // Targets the note type's ACTUAL card-template name rather than assuming
  // the "Card 1" this code created it with (2026-07-26). updateModelTemplates
  // matches templates by name and silently ignores a name the note type
  // doesn't have — it does not error — so on any collection where that card
  // ended up named something else (renamed in Anki's Cards screen, or the
  // note type recreated by hand under the same name), every template update
  // this function has ever pushed was a no-op, leaving the card rendering
  // from a stale template indefinitely while every add still reported
  // success. Only the first template is touched: this note type is
  // single-card by design, and blindly overwriting a second template the
  // user added themselves would destroy their own work.
  const templates = await invokeAnkiConnect("modelTemplates", { modelName: ANKI_MODEL_NAME });
  const templateName = Object.keys(templates ?? {})[0] ?? "Card 1";
  await invokeAnkiConnect("updateModelTemplates", {
    model: { name: ANKI_MODEL_NAME, templates: { [templateName]: { Front: ANKI_FRONT_TEMPLATE, Back: ANKI_BACK_TEMPLATE } } },
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
// `audioBase64` is a base64-encoded WAV clip (see content.js's sliceClipWav)
// or null when no capture was available for this word — AnkiConnect's own
// `audio` note param (not the `fields` map) is what actually stores the file
// into Anki's media folder and writes the resulting `[sound:...]` reference
// into the Audio field; `Audio: ""` in `fields` below is just the field's
// starting value before that happens; AnkiConnect appends to it.
async function addAnkiNote({ word, reading, gloss, sentenceHtml, pos, frequency, jlpt, audio: audioBase64, source, translation }) {
  await ensureAnkiSetup();
  return invokeAnkiConnect("addNote", {
    note: {
      deckName: ANKI_DECK_NAME,
      modelName: ANKI_MODEL_NAME,
      fields: {
        Word: word,
        Reading: reading,
        Gloss: gloss,
        Sentence: sentenceHtml,
        POS: pos ?? "",
        Frequency: frequency ?? "",
        JLPT: jlpt ?? "",
        Audio: "",
        Source: source ?? "",
        Translation: translation ?? "",
      },
      options: { allowDuplicate: false },
      tags: ["japanese-immersion-extension"],
      audio: audioBase64 ? [{ data: audioBase64, filename: `jp-immersion-${Date.now()}.wav`, fields: ["Audio"] }] : undefined,
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

// Reads a note's CURRENT fields back out of Anki (2026-07-30). The edit panel
// calls this on every open rather than trusting anything cached from capture
// time: the note may have been hand-edited in Anki since, and silently
// overwriting those edits with our stale copy would be data loss the user never
// asked for. Returns null when the note no longer exists, which the caller must
// distinguish from an error — AnkiConnect returns an empty array for a missing
// id rather than failing.
async function ankiNoteInfo(noteId) {
  const infos = await invokeAnkiConnect("notesInfo", { notes: [noteId] });
  const info = infos?.[0];
  // A deleted note comes back as an empty object in some AnkiConnect versions
  // and is simply absent in others; both mean the same thing here.
  if (!info || !info.noteId) return null;
  const fields = {};
  for (const [name, value] of Object.entries(info.fields ?? {})) fields[name] = value.value ?? "";
  return { noteId: info.noteId, fields, tags: info.tags ?? [] };
}

// Writes changed fields back, optionally replacing the audio (2026-07-30).
//
// Audio replacement is a two-part operation and the ORDER matters: `fields`
// is applied first and the media file is appended into whichever field is
// named in `audio[].fields`, exactly as `addNote` behaves. So replacing a clip
// means blanking `Audio` in `fields` in the SAME call — otherwise AnkiConnect
// appends a second `[sound:…]` and the card plays both the old and the new clip
// back to back.
//
// The superseded media file is deleted afterwards, not before: if the update
// fails, the note still references it and deleting first would leave a card
// pointing at a file that no longer exists. Filenames are unique per capture,
// so nothing else can be referencing it. A failure to delete is swallowed —
// an orphaned media file is untidy but harmless (Anki's own Check Media
// cleans it up), and it must not turn a successful edit into a reported one.
async function updateAnkiNote({ noteId, fields, audio, previousAudioFilename }) {
  const note = { id: noteId, fields };
  if (audio) {
    note.fields = { ...fields, Audio: "" };
    note.audio = [
      {
        data: audio,
        filename: `jp-immersion-${noteId}-${Date.now()}.wav`,
        fields: ["Audio"],
      },
    ];
  }
  await invokeAnkiConnect("updateNoteFields", { note });
  if (audio && previousAudioFilename) {
    try {
      await invokeAnkiConnect("deleteMediaFile", { filename: previousAudioFilename });
    } catch {
      // See above — never fails the edit.
    }
  }
  return { ok: true };
}

// Hands a note to Anki's own card editor. **Demoted to a secondary escape
// hatch on 2026-07-30** — it was the primary action when "edit last card" was
// first built (2026-07-29), which was wrong: it required leaving Crunchyroll
// for the Anki desktop app, failing the "capture and keep watching" test the
// same way any other playback interruption does. Editing now happens in an
// in-page panel (see content.js), and this remains only for what that panel
// deliberately doesn't cover — tags, note type, and deletion.
//
// Two AnkiConnect actions can do this and they are not equally available.
// `guiEditNote` opens the Edit dialog directly on the one note, which is
// exactly what's wanted, but it's a much later addition to the API than the
// rest of what this extension uses and an older AnkiConnect build simply
// doesn't implement it. `guiBrowse` has existed from the beginning and can be
// aimed at a single note with a `nid:` query, landing the user in the Browse
// window with that card selected — one extra click away from the same place.
// So the better one is tried first and the older one is a fallback, rather
// than picking one and hoping the user's install matches.
//
// The fallback fires ONLY for an unimplemented action. Any other failure — Anki
// closed, note already deleted — is surfaced as-is, because `guiBrowse` would
// happily open an empty search result and look like success.
async function editAnkiNote(noteId) {
  try {
    await invokeAnkiConnect("guiEditNote", { note: noteId });
    return { opened: "editor" };
  } catch (err) {
    if (!/unsupported action|unknown action|not supported/i.test(err.message)) throw err;
    await invokeAnkiConnect("guiBrowse", { query: `nid:${noteId}` });
    return { opened: "browser" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_SUBTITLES") {
    fetchSubtitles(message)
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

  if (message.type === "FETCH_ENTRY_FILES") {
    fetchEntryFiles(message.entryId, message.episode)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "FETCH_ENGLISH_SUBTITLES") {
    fetchEnglishSubtitles(message.url, message.format)
      .then((cues) => sendResponse({ cues }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "LOOKUP_WORD") {
    // `metaShowPos`/`metaShowFreq`/`metaShowJlpt`/`metaShowSource` (Phase 5,
    // 2026-07-17 / 2026-07-19 / 2026-07-22 / 2026-07-23) are bundled into the
    // SAME round trip rather than a second storage read
    // from content.js — the popup already waits on this one message before
    // rendering, so there's no benefit to a separate fetch, and this keeps
    // the toggle's storage key private to background.js (content.js only
    // ever sees the resolved booleans).
    Promise.all([
      lookupWord(message.word, message.isParticle, message.pos, message.isHonorificSuffix),
      chrome.storage.local.get(["metaShowPos", "metaShowFreq", "metaShowJlpt", "metaShowSource"]),
    ])
      .then(([{ results, posTags }, { metaShowPos, metaShowFreq, metaShowJlpt, metaShowSource }]) =>
        sendResponse({
          results,
          posTags,
          showPos: metaShowPos ?? false,
          showFreq: metaShowFreq ?? false,
          showJlpt: metaShowJlpt ?? false,
          showSource: metaShowSource ?? false,
        })
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
      jlpt: message.jlpt,
      audio: message.audio,
      source: message.source,
      translation: message.translation,
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

  if (message.type === "EDIT_ANKI_NOTE") {
    editAnkiNote(message.noteId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "ANKI_NOTE_INFO") {
    ankiNoteInfo(message.noteId)
      .then((note) => sendResponse({ note }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message.type === "UPDATE_ANKI_NOTE") {
    updateAnkiNote({
      noteId: message.noteId,
      fields: message.fields,
      audio: message.audio,
      previousAudioFilename: message.previousAudioFilename,
    })
      .then((result) => sendResponse(result))
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

// A comparison key with ALL punctuation and spacing collapsed (2026-07-31).
// Crunchyroll and Jimaku routinely spell the same film with different
// punctuation — "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train"
// against "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train" — which
// normalizeTitle's lowercase-and-apostrophes treatment still sees as two
// different titles. Those two are identical under this one.
function looseTitle(name) {
  return normalizeTitle(name)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Jimaku's search is a substring match against its own titles, so a query it
// doesn't hold verbatim returns NOTHING rather than something approximate.
// That is how a real catalogue entry came back as "no Jimaku entry found" in
// the 2026-07-31 live pass, on four titles that all demonstrably exist:
//
//   "Re:ZERO -Starting Life in Another World- Memory Snow"     -> 0 entries
//   "Demon Slayer: Kimetsu no Yaiba - The Movie: Mugen Train"  -> 0
//   "Attack on Titan Chronicle"                                -> 0
//   "Re:ZERO -Starting Life in Another World-"                 -> 6  (has the OVAs)
//   "Mugen Train"                                              -> 6  (has the movie)
//   "Attack on Titan"                                          -> 15
//
// So a zero-result search is re-tried on progressively broader queries. Two
// shapes recover everything measured above: the segment after the last colon
// (how films and OVAs are titled — "…: Mugen Train"), and dropping trailing
// words one at a time until what's left is the franchise Jimaku indexes under.
// Ordered most-specific-first, and capped, since each rung is a live request
// and only ever runs when the one before it found nothing at all.
const MIN_SEARCH_QUERY_CHARS = 4;
const MAX_SEARCH_LADDER_RUNGS = 6;
function searchQueryLadder(title) {
  const out = [];
  const push = (raw) => {
    // Trailing separators are dropped: "Re:ZERO -Starting Life in Another
    // World-" minus its last word leaves a dangling "-", which Jimaku's
    // substring match then fails on for want of one character.
    const q = String(raw ?? "")
      .replace(/[\s:\-–—―~・]+$/u, "")
      .trim();
    if (q.length >= MIN_SEARCH_QUERY_CHARS && !out.includes(q)) out.push(q);
  };
  push(title);
  const afterLastColon = String(title ?? "").match(/:\s*([^:]+)$/);
  if (afterLastColon) push(afterLastColon[1]);
  const words = String(title ?? "").trim().split(/\s+/);
  for (let n = words.length - 1; n >= 2; n--) push(words.slice(0, n).join(" "));
  return out.slice(0, MAX_SEARCH_LADDER_RUNGS);
}

// Picks the entry that IS this exact title, for content with no season
// information to match on — films, OVAs, specials and compilations, which
// Crunchyroll publishes with no `partOfSeason` block at all.
//
// Deliberately strict, because the failure it replaces was silent: with no
// season signal, the old code fell through to the plain title match, which for
// a film listed under a franchise page is the franchise's own entry — i.e.
// season 1's subtitles, rendered over a movie, with nothing logged (the
// 2026-07-31 report). A confident answer or none is more useful than a
// confident-looking guess.
//
// `wasFullQuery` says the search that produced these entries used the whole
// title. When that comes back with exactly one entry, Jimaku's own index has
// matched a spelling this function can't derive — "Attack on Titan: THE LAST
// ATTACK" finding "Attack on Titan the Movie: The Last Attack" — and that is
// better evidence than any local string comparison.
//
// The containment test runs in ONE direction only, and that asymmetry is the
// whole point: an entry name may be longer than Crunchyroll's title, but an
// entry whose name is CONTAINED in it is the franchise, not this film.
// "Re:ZERO -Starting Life in Another World-" is contained in "Re:ZERO
// -Starting Life in Another World- Memory Snow", and matching it would
// reintroduce exactly the bug this exists to fix.
function matchEntryByFullTitle(entries, title, wasFullQuery) {
  const wanted = looseTitle(title);
  if (!wanted) return null;
  const fields = (e) => [looseTitle(e.name), looseTitle(e.english_name)].filter(Boolean);
  const exact = entries.find((e) => fields(e).includes(wanted));
  if (exact) return exact;
  if (wasFullQuery && entries.length === 1) return entries[0];
  const contained = entries.filter((e) => fields(e).some((f) => f.includes(wanted)));
  return contained.length === 1 ? contained[0] : null;
}

// Whether a title is EPISODIC — a numbered run of TV episodes — or one of the
// side formats (OVA/OAD collections, films, specials, picture dramas, recaps).
//
// Until 2026-08-01 that question was answered by "did Crunchyroll publish a
// `partOfSeason` block?", which is wrong in both directions and produced three
// separate live failures:
//
//   - Crunchyroll lists an OVA/OAD collection AS a season, block and all
//     (Re:Zero's "…OVAs", Attack on Titan's "OAD"). Treated as ordinary TV,
//     they went down the season-NUMBER path and took a numbered TV season's
//     entry — Attack on Titan's OADs silently loaded season 2's subtitles,
//     from a populated entry, so nothing looked wrong.
//   - The same misreading suppressed the unfiltered file listing below, so
//     Re:Zero's OVAs resolved to exactly the right entry and then hard-errored
//     with "No subtitle file found for episode 1" — the entry holds four
//     files, none of them numbered 1.
//   - A film has no block at all, so `wantedSeason` fell back to 1 and the
//     season match then claimed credit for it: "matched by season 1" on a
//     movie, which is the one thing that log line exists to make impossible.
//
// OVA/OAD/ONA are one class deliberately: they are the same format under
// different names, and Jimaku indexes Attack on Titan's OADs under "…OVA".
const NON_EPISODIC_CLASSES = [
  ["ova", /\b(?:ovas?|oads?|onas?)\b/i, "OVA/OAD"],
  ["movie", /\b(?:movies?|films?|gekijouban)\b/i, "a film"],
  ["special", /\b(?:specials?)\b/i, "a special"],
  ["picture-drama", /\bpicture drama\b/i, "a picture drama"],
  ["recap", /\b(?:recaps?|compilation)\b/i, "a recap"],
];

function nonEpisodicClass(name) {
  const s = String(name ?? "");
  return NON_EPISODIC_CLASSES.find(([, re]) => re.test(s)) ?? null;
}

// Picks the entry for a side-format season, by matching the FORMAT Crunchyroll
// named it with against the format in a Jimaku entry's own name — "OAD" finds
// "Attack on Titan OVA" where neither the season number nor the season name
// can. Requires the entry to belong to this franchise, so a stray OVA from
// some other show the search happened to return can't win, and requires the
// match to be unique: a franchise with several side formats of the SAME class
// is genuinely ambiguous, and the entry dropdown is the honest answer there.
function matchEntryByNonEpisodicClass(entries, seasonName, query, contentTitles = []) {
  const cls = nonEpisodicClass(seasonName);
  if (!cls) return null;
  const series = looseTitle(query);
  if (!series) return null;
  // Films are individually titled works and a franchise routinely has several,
  // so "the only film-class entry here" is not an identification — it is
  // whichever film the search happened to return. That is exactly how Mugen
  // Train loaded Infinity Castle's subtitles, confidently and silently, in the
  // 2026-08-01 live pass: the franchise search doesn't contain Mugen Train's
  // entry at all, and Infinity Castle was the only film in the results.
  // Collections are the opposite shape — a franchise has ONE OVA bucket, one
  // specials bucket — and there the format word IS the identity, which is what
  // makes Crunchyroll's "OADs" resolvable to Jimaku's "…OVA" at all. So films
  // must be identified by title (see matchEntryByContentTitle, which runs
  // first); only collection classes may be claimed on format alone.
  if (cls[0] === "movie" && !matchEntryByContentTitle(entries, contentTitles, cls)) return null;
  const matches = entries.filter((e) => {
    const fields = [looseTitle(e.name), looseTitle(e.english_name)].filter(Boolean);
    if (!fields.some((fld) => fld.startsWith(series) && fld !== series)) return false;
    return [e.name, e.english_name].some((n) => nonEpisodicClass(n)?.[0] === cls[0]);
  });
  return matches.length === 1 ? matches[0] : null;
}

// Identifies non-episodic content by ITS OWN title rather than the franchise's
// — the signal that was missing entirely until 2026-08-01, and the reason three
// different films failed three different ways in that live pass. Crunchyroll's
// `partOfSeries.name` is the franchise on some film pages and the film on
// others, and its season name at best says "a movie"; the episode title is the
// only field that reliably says WHICH film.
//
// Matching is containment in one direction only, same asymmetry as
// matchEntryByFullTitle: a Jimaku entry name may carry more than the film's
// title ("Attack on Titan the Movie: The Last Attack" holds "The Last Attack"),
// but an entry whose name is merely contained in the title is the franchise.
//
// A tie is broken by format class, which is the one job the class does well
// here: "Mugen Train" matches both the film (3338) and the TV retelling (3335,
// "…Mugen Train Arc"), and the class says which of the two this page is.
// Crunchyroll's JSON-LD `name` is a COMPOUND, not a title (confirmed on a live
// Mugen Train page, 2026-08-01):
//
//   "Demon Slayer …The Movie: Mugen Train | E1 - Demon Slayer …The Movie: Mugen Train"
//
// Verbatim, that string returns ZERO results from Jimaku — measured — so
// passing it through as a search query or a match key would have disabled the
// whole content-title tier on exactly the pages it exists for. Split back into
// the titles it's built from: the part before the pipe, and the part after the
// "E<n> - " marker. For a film those are the same string; for an OVA collection
// the second is the one that names the individual OVA ("Memory Snow"), which is
// what the file narrowing needs.
//
// Crunchyroll's `partOfSeason.name` joins them as a third candidate: on that
// same page it is the clean film title, and it is the field `nameMatch` would
// have resolved this correctly from all along, had the search returned the
// film's entry at all.
//
// Ordered most-specific-first, and anything that merely repeats the series
// title is dropped — that names the franchise, not this work.
const MIN_CONTENT_TITLE_CHARS = 4;
const MAX_CONTENT_TITLE_SEARCHES = 2;
// Crunchyroll's episode code is NOT always numeric. Measured shapes: "E1" on a
// film, "EEX" on an extra, and it uses several more for specials and ONAs. So
// the code is matched as an opaque token, anchored by the pipe before it and
// the dash after — the first version of this required E<digits> and silently
// stopped extracting anything on Memory Snow's real page. Anything after a
// pipe is taken even when no code matches at all, so the next format Crunchyroll
// invents degrades to a usable title rather than to nothing.
const EPISODE_CODE_RE = /^E[A-Za-z0-9]{1,8}\s*[-–—]\s*/u;
// A trailing qualifier Jimaku's filenames won't carry — "Memory Snow
// (Director's Cut)" has to still match a file named "Memory.Snow". Kept as an
// EXTRA candidate rather than a replacement, so the fuller title gets first go.
const TRAILING_QUALIFIER_RE = /\s*[（([][^）)\]]*[）)\]]\s*$/u;

// A candidate that is nothing but a format word ("OVAs", "Specials") names a
// format, not a work — it can't narrow anything, and searching it returns
// unrelated shows' OVA entries. Dropped for the same reason a candidate equal
// to the series title is.
function stripFormatWords(s) {
  let out = String(s ?? "");
  for (const [, re] of NON_EPISODIC_CLASSES) out = out.replace(new RegExp(re.source, "gi"), " ");
  return out;
}

// A THIRD shape of `name`, and its own recognised case rather than something
// that happens to fall through (both films confirmed live, 2026-08-01):
//
//   "Attack on Titan: THE LAST ATTACK | Attack on Titan: THE LAST ATTACK"
//
// No episode code at all, just the title duplicated across the pipe. That
// duplication IS the signal: an episodic page names the series on one side and
// the episode on the other, so a page naming the same work twice is a
// standalone work. It matters because neither film's season name contains a
// format word ("THE LAST ATTACK", "Infinity Castle I"), so `nonEpisodicClass`
// sees nothing, and without this both were classed as ordinary TV — which
// skipped the entire content-title path and reproduced both original bugs
// exactly: Infinity Castle unresolved, The Last Attack silently loading the
// flagship series.
function looksLikeStandaloneWork(episodeTitle) {
  const raw = String(episodeTitle ?? "").trim();
  const pipe = raw.indexOf("|");
  if (pipe < 0) return false;
  const after = raw.slice(pipe + 1).trim();
  if (EPISODE_CODE_RE.test(after)) return false;
  const before = looseTitle(raw.slice(0, pipe));
  return Boolean(before) && before === looseTitle(after);
}

// Guards a single-result search from being trusted across shows: the entry has
// to be the same work or the same franchise as the query, in either direction.
// Both directions are needed and neither alone suffices — Jimaku's entry name
// extends the series for a film folded into its parent show ("Attack on Titan"
// → "Attack on Titan the Movie: The Last Attack"), and is SHORTER than it for a
// film with its own Crunchyroll series entity ("…Infinity Castle I" → "…Infinity
// Castle"). The asymmetry that matters elsewhere doesn't apply here, because
// this is a sanity filter on evidence Jimaku's own index already produced, not
// a match rule deciding between candidates.
function sharesFranchise(entry, query) {
  const series = looseTitle(query);
  if (!series) return false;
  return [looseTitle(entry.name), looseTitle(entry.english_name)]
    .filter(Boolean)
    .some((f) => f.startsWith(series) || series.startsWith(f));
}

function contentTitleCandidates(episodeTitle, seasonName, query) {
  const series = looseTitle(query);
  const raw = String(episodeTitle ?? "").trim();
  const out = [];
  const push = (s) => {
    const t = String(s ?? "").trim();
    const loose = looseTitle(t);
    if (!loose || loose.length < MIN_CONTENT_TITLE_CHARS || loose === series) return;
    if (!looseTitle(stripFormatWords(t))) return;
    if (out.some((existing) => looseTitle(existing) === loose)) return;
    out.push(t);
  };
  const pushWithVariants = (s) => {
    const t = String(s ?? "").trim();
    if (!t) return;
    push(t);
    const trimmed = t.replace(TRAILING_QUALIFIER_RE, "").trim();
    if (trimmed && trimmed !== t) push(trimmed);
  };
  const pipe = raw.indexOf("|");
  if (pipe >= 0) {
    // Most specific first: the half that names this individual episode/film.
    pushWithVariants(raw.slice(pipe + 1).trim().replace(EPISODE_CODE_RE, ""));
    pushWithVariants(raw.slice(0, pipe));
  } else {
    pushWithVariants(raw);
  }
  pushWithVariants(seasonName);
  return out;
}

// Narrows an unfiltered file listing to the ones naming this specific piece of
// content. Compared on the same punctuation-insensitive key as entry titles, so
// separators in a release name ("Memory.Snow.WEBRip") don't defeat it. Tries
// each candidate title in turn and takes the first that narrows anything.
function filesMatchingTitle(files, contentTitles) {
  for (const title of contentTitles) {
    const wanted = looseTitle(title);
    if (!wanted || wanted.length < MIN_CONTENT_TITLE_CHARS) continue;
    const hits = files.filter((f) => looseTitle(f.name).includes(wanted));
    if (hits.length) return { files: hits, title };
  }
  return { files: [], title: null };
}
// Takes the candidate list from contentTitleCandidates, most-specific-first,
// and returns the entry plus WHICH title identified it — the log line names it,
// so a live console shows the signal that actually did the work rather than the
// compound string it was parsed out of.
function matchEntryByContentTitle(entries, contentTitles, cls = null) {
  const fields = (e) => [looseTitle(e.name), looseTitle(e.english_name)].filter(Boolean);
  for (const title of contentTitles) {
    const wanted = looseTitle(title);
    if (!wanted) continue;
    const matches = entries.filter((e) => fields(e).some((f) => f.includes(wanted)));
    if (matches.length === 1) return { entry: matches[0], title };
    if (matches.length > 1 && cls) {
      const sameClass = matches.filter((e) =>
        [e.name, e.english_name].some((n) => nonEpisodicClass(n)?.[0] === cls[0])
      );
      if (sameClass.length === 1) return { entry: sameClass[0], title };
    }
  }
  return null;
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
// A trailing "Part N" / "Cour N" is a COUR marker, not a season, and is
// stripped and ignored before season parsing (2026-07-26). It has to be
// handled explicitly rather than left alone, because otherwise the bare-number
// rule below reads its number as the season: real Jimaku names where that goes
// wrong are "Shingeki no Kyojin 3 Part 2" (season 3 cour 2, would read as
// season 2), "SPY×FAMILY Part 2" (season 1 cour 2, would read as season 2) and
// "BOCCHI THE ROCK! Recap Part 2" (a recap, would read as season 2).
const PART_SUFFIX_RE = /\s+(?:part|cour)\s*\d+\s*$/i;

const SEASON_ROMAN = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9 };

// Upper bound on the BARE trailing-number form only. A number this large is
// far more likely to be part of the title than a season count — "Mob Psycho
// 100" and "Jujutsu Kaisen 0" are the real cases this protects (the first
// would otherwise parse as season 100, the second as season 0). Seasons past
// this are still detected via the explicit "Season N" wording.
const MAX_BARE_SEASON_NUMBER = 20;

// Jimaku names seasons in several different conventions, and which one a show
// uses is not predictable — all four of these are live on the site right now:
//   "Sousou no Frieren 2nd Season"                 -> ordinal + the word season
//   "SPY×FAMILY Season 2"                          -> the word season + number
//   "Overlord II", "Mob Psycho 100 III"            -> roman numeral
//   "Kono Subarashii Sekai ni Shukufuku wo! 3"     -> bare trailing number
// Ordered most-specific first so "…2nd Season" is consumed by the ordinal rule
// before the bare-number rule can see its digits.
// Every pattern anchors on WHITESPACE before the marker and never consumes a
// leading separator character. Allowing an optional ":"/"-" there looks
// harmless but isn't: `String.match` returns the LEFTMOST match, so on
// "Re:ZERO -Starting Life in Another World- Season 2" it would start the match
// at the title's own trailing dash and strip it, leaving a base title that no
// longer equals what Crunchyroll reports — silently falling back to season 1
// for the exact multi-season show this is meant to fix.
const SEASON_PATTERNS = [
  { re: /\s+(\d+)(?:st|nd|rd|th)\s+season\s*$/i, value: (m) => Number(m[1]) },
  { re: /\s+season\s+(\d+)\s*$/i, value: (m) => Number(m[1]) },
  { re: /\s+(II|III|IV|V|VI|VII|VIII|IX)\s*$/, value: (m) => SEASON_ROMAN[m[1]] },
  {
    re: /\s+(\d+)\s*$/,
    value: (m) => {
      const n = Number(m[1]);
      return n >= 2 && n <= MAX_BARE_SEASON_NUMBER ? n : null;
    },
  },
];

// Splits a Jimaku entry name into its season number and the base title with
// the season/cour marker removed. An entry with no marker is season 1 — that's
// how Jimaku names first seasons (no suffix at all), not a fallback guess.
//
// The bare-number rule is only safe because of how its result is USED: callers
// require the returned `base` to still match the show title Crunchyroll
// reported before accepting the season. So a title that genuinely ends in a
// number ("Mob Psycho 100") strips down to something that no longer matches
// ("Mob Psycho") and is rejected, while a real season suffix strips down to
// exactly the franchise title and is accepted. Parsing alone is not trusted.
function parseSeasonMarker(name) {
  if (!name) return { season: 1, base: name ?? "" };
  const withoutPart = name.replace(PART_SUFFIX_RE, "").trim();
  for (const pattern of SEASON_PATTERNS) {
    const m = withoutPart.match(pattern.re);
    if (!m) continue;
    const season = pattern.value(m);
    if (season == null) continue; // matched the shape but not a plausible season number
    return { season, base: withoutPart.slice(0, m.index).trim() };
  }
  return { season: 1, base: withoutPart };
}

function stripSeasonSuffix(name) {
  return name ? parseSeasonMarker(name).base : name;
}

function entrySeasonNumber(name) {
  return parseSeasonMarker(name).season;
}

// Crunchyroll's `partOfSeason.seasonNumber` is a POSITIONAL INDEX into its own
// season list, not the anime's canonical season number — confirmed 2026-07-27
// against a live report on Re:Zero, where every season from the OVAs onward
// loaded the NEXT season's subtitles:
//
//   Crunchyroll season slot   what Crunchyroll numbers it   what loaded
//   Season 1                  1                             season 1  (right)
//   OVAs                      2                             season 2
//   Season 2                  3                             season 3
//   Season 3                  4                             season 4
//   Season 4                  5                             season 1  (fallback)
//
// Crunchyroll orders its season list by release date and counts OVA/special
// collections as seasons; Re:Zero's OVAs came out between seasons 1 and 2, so
// everything after them is shifted by one. The last row is the same bug, just
// louder: nothing on Jimaku parses as "season 5", so the existing fallback
// quietly served season 1. Verified the Jimaku side is NOT at fault — a direct
// API search returns clean, correctly-named entries for all four seasons plus
// a separate "…OVAs" entry.
//
// No arithmetic fix exists: the size of the shift depends on how many
// non-season collections Crunchyroll happens to list before the season being
// watched, which is per-show data this extension has no access to. So the
// number is demoted to a fallback and the season's NAME is matched instead —
// Crunchyroll's own season titles and Jimaku's `english_name` are both the
// official English title ("Re:ZERO -Starting Life in Another World- Season 2"
// on both sides), which is an exact match with nothing to infer.
//
// `query` is the SERIES title. A season name identical to it carries no
// season information at all (either it genuinely is season 1, or Crunchyroll
// simply repeats the series name for every season) — matching on it would pin
// every season of every show to whichever entry is named after the bare
// franchise, i.e. season 1. That would be a regression for the multi-season
// shows the number-based path already gets right, so those cases are handed
// straight back to it instead.
// Three forms, because Crunchyroll and Jimaku don't agree on how much of the
// franchise title a season's name repeats (measured 2026-07-29 against live
// Jimaku search results for 12 multi-season franchises):
//   1. The whole name matches: Crunchyroll "…Season 2" / Jimaku english_name
//      "…Season 2". The Frieren / SPY×FAMILY / Slime / Shield Hero shape.
//   2. Series title + season name matches: Crunchyroll names the season alone
//      ("Entertainment District Arc") while Jimaku prefixes the franchise
//      ("Demon Slayer: Kimetsu no Yaiba Entertainment District Arc").
//   3. The entry starts with the series title AND ends with the season name.
//      Same case as 2 but tolerant of punctuation between the two ("Dr. STONE:
//      STONE WARS" for series "Dr. STONE" + season "Stone Wars").
// Both halves are required in form 3 — a suffix match alone would let a short
// season name ("OVA") hit an unrelated show that a fuzzy title search happened
// to return, and a prefix match alone would hit every season of the franchise.
// The leading space on the suffix keeps it to a word boundary.
//
// **Why this matters beyond tidiness:** arc-named seasons are precisely where
// the season-NUMBER path fails hardest. Measured across those 12 franchises,
// Demon Slayer S2/S3, Attack on Titan S4 and Dr. STONE S2/S3 all fall through
// the number path to the exact-title fallback — which is season 1's entry, the
// silent-wrong-subtitles bug, on five seasons of three popular shows. Name
// matching is the only tier that can resolve them at all.
//
// `query` is the SERIES title. A season name identical to it carries no season
// information (either it genuinely is season 1, or Crunchyroll simply repeats
// the series name for every season) — matching on it would pin every season of
// every such show to whichever entry is named after the bare franchise, i.e.
// season 1. That would be a regression for the multi-season shows the
// number-based path already gets right, so those are handed back to it.
function matchEntryBySeasonName(entries, seasonName, query) {
  if (!seasonName) return null;
  const wanted = normalizeTitle(seasonName);
  const series = normalizeTitle(query);
  if (!wanted || wanted === series) return null;
  const withSeries = normalizeTitle(`${query} ${seasonName}`);
  const matches = (raw) => {
    const field = normalizeTitle(raw);
    if (!field) return false;
    return (
      field === wanted ||
      field === withSeries ||
      (field.startsWith(series) && field.endsWith(` ${wanted}`))
    );
  };
  return entries.find((e) => matches(e.name) || matches(e.english_name)) ?? null;
}

// Jimaku splits a single Crunchyroll season into separate "Part N"/"Cour N"
// entries whenever the season aired in two cours, and the episode numbering
// does NOT restart in the way the entry names suggest — so the entry chosen for
// the season is simply missing the back half of it. Confirmed 2026-07-29
// against the live API: Re:Zero's "2nd Season" entry returns ZERO files for
// episodes 14–25 (they're in "2nd Season Part 2"), and "Shingeki no Kyojin 3"
// returns none for episode 13+ (they're in "3 Part 2"). Crunchyroll presents
// each of those as one continuous season, so an episode past the cour boundary
// used to fail outright with "No subtitle file found".
//
// Returns the sibling entries worth retrying, in Jimaku's own order: same base
// title and same parsed season as the entry already chosen, excluding that
// entry itself. Deliberately NOT merged into the primary selection — the first
// entry is right for most of the season, and this only comes into play when it
// has nothing for the requested episode, so it costs one extra request on
// exactly the episodes that would otherwise have errored.
function courSiblingEntries(entries, chosen) {
  const chosenBase = normalizeTitle(stripSeasonSuffix(chosen.english_name ?? chosen.name));
  const chosenSeason = Math.max(entrySeasonNumber(chosen.name), entrySeasonNumber(chosen.english_name));
  return entries.filter((e) => {
    if (e.id === chosen.id) return false;
    const season = Math.max(entrySeasonNumber(e.name), entrySeasonNumber(e.english_name));
    if (season !== chosenSeason) return false;
    return (
      normalizeTitle(stripSeasonSuffix(e.name)) === chosenBase ||
      normalizeTitle(stripSeasonSuffix(e.english_name)) === chosenBase
    );
  });
}

// Second chance when the season name doesn't match a Jimaku entry outright:
// read the real season number out of the NAME (".. Season 2" -> 2) using the
// same marker patterns Jimaku entry names are parsed with. Crunchyroll's
// positional index is wrong about which season this is; its own title for that
// season isn't. Returns null when the name carries no season marker at all —
// an OVA/special collection, or a first season, both of which fall through to
// the existing number-based path rather than being guessed at.
function seasonNumberFromName(seasonName) {
  if (!seasonName) return null;
  const { season, base } = parseSeasonMarker(seasonName);
  // parseSeasonMarker reports an UNMARKED name as season 1 — the right default
  // for a Jimaku entry (that's how Jimaku names first seasons) but not a usable
  // signal here: a Crunchyroll season titled "OVAs" or "Director's Cut" has no
  // season number to read, and answering 1 for it would be a guess dressed up
  // as data. A number is therefore only returned when a marker was actually
  // consumed, which is exactly when the base comes back shorter than the name.
  if (base.length >= seasonName.trim().length) return null;
  return season;
}

// Resolves a show/episode query down to the candidate text-file list — the
// part `fetchSubtitles` (auto-load) and the switcher panel's file listing
// both need, factored out so a switcher-panel refresh doesn't duplicate this
// search+files-list round trip inside its own separate function.
async function searchJimakuEntries(query, headers) {
  const searchUrl = `${JIMAKU_API_BASE}/entries/search?anime=true&query=${encodeURIComponent(
    stripApostrophes(query)
  )}`;
  const searchRes = await fetch(searchUrl, { headers });
  if (!searchRes.ok) {
    throw new Error(`Jimaku search failed (${searchRes.status})`);
  }
  return searchRes.json();
}

async function resolveTextFiles(query, episode, headers, seasonNumber = null, seasonName = null, episodeTitle = null) {
  // Broadens the search rather than reporting nothing, when Jimaku's substring
  // index doesn't hold Crunchyroll's exact spelling — see searchQueryLadder.
  const ladder = searchQueryLadder(query);
  let entries = [];
  let usedQuery = ladder[0] ?? query;
  for (const candidate of ladder) {
    entries = await searchJimakuEntries(candidate, headers);
    if (entries.length) {
      usedQuery = candidate;
      break;
    }
  }
  if (!entries.length) {
    throw new Error(
      `No Jimaku entry found for "${query}"` +
        (ladder.length > 1 ? ` (also tried ${ladder.length - 1} broader searches)` : "")
    );
  }
  if (usedQuery !== ladder[0]) {
    console.log(
      `[jp-immersion] Jimaku has nothing indexed under "${query}" — found ${entries.length} entries by ` +
        `searching "${usedQuery}" instead.`
    );
  }
  // A plain substring search often returns films/specials/OVAs sharing the
  // main series' name (e.g. "One Piece" matches 26 entries). Prefer an exact
  // case-insensitive name match over just taking the first hit — and among
  // exact matches, prefer one whose season suffix (if any) matches the
  // detected season, so a multi-season show doesn't default to season 1's
  // entry when season 2+ is requested (see comments above).
  // Is this a numbered run of TV episodes at all? Everything below branches on
  // this rather than on whether Crunchyroll published a season block — see
  // nonEpisodicClass for the three live failures that distinction caused.
  const hasSeasonSignal = seasonNumber !== null || seasonName !== null;
  const sideFormat = nonEpisodicClass(seasonName);
  const isEpisodic = hasSeasonSignal && !sideFormat && !looksLikeStandaloneWork(episodeTitle);
  // Jimaku's index matching a spelling this code can't derive is better
  // evidence than any local string comparison — the same principle
  // matchEntryByFullTitle already applies to a single full-query hit, extended
  // to the searches made here. "Attack on Titan: THE LAST ATTACK" returns
  // exactly one entry whose name ("…the Movie: The Last Attack") no containment
  // test can reach, because Jimaku puts "the Movie:" in the middle of it.
  let soloHit = null;
  const noteSolo = (found, title) => {
    if (isEpisodic || soloHit || found.length !== 1) return;
    if (!sharesFranchise(found[0], query)) return;
    soloHit = { entry: found[0], title };
  };
  noteSolo(entries, usedQuery);

  // The film's own title gets its OWN search, merged into the candidate pool
  // (2026-08-01). The ladder above cannot cover this: it only widens when a
  // rung returns NOTHING, and a franchise query returns plenty — just not the
  // film. Measured live: "Demon Slayer: Kimetsu no Yaiba" returns six entries
  // and Mugen Train's is not among them, so no matching rule over that result
  // could ever have found it, while "Mugen Train" finds it first. One extra
  // request, only for non-episodic content, and only when the episode title
  // says something the series title doesn't.
  const contentTitles = isEpisodic ? [] : contentTitleCandidates(episodeTitle, seasonName, query);
  // Capped: each candidate is a live request, and the first two carry the
  // signal (the episode-specific part and the work's own title).
  for (const candidate of contentTitles.slice(0, MAX_CONTENT_TITLE_SEARCHES)) {
    const byTitle = await searchJimakuEntries(candidate, headers);
    noteSolo(byTitle, candidate);
    const known = new Set(entries.map((e) => e.id));
    const added = byTitle.filter((e) => !known.has(e.id));
    if (added.length) {
      console.log(
        `[jp-immersion] also searched this title's own name "${candidate}" — ` +
          `${added.length} entr${added.length === 1 ? "y" : "ies"} the series search didn't return.`
      );
      entries = entries.concat(added);
    }
  }

  const normalizedQuery = normalizeTitle(query);
  // Crunchyroll's own title for this season beats its own numbering of it, in
  // both forms: an outright entry match first, then the season number read out
  // of the name. Only if neither is available does the positional index get
  // used. See matchEntryBySeasonName above for the Re:Zero report behind this.
  const nameMatch = matchEntryBySeasonName(entries, seasonName, query);
  const namedSeason = seasonNumberFromName(seasonName);
  const wantedSeason = namedSeason ?? seasonNumber ?? 1;
  // The content's own title outranks everything below it for non-episodic
  // content: it is the only signal that says WHICH film, where the season name
  // says at most "a film" and the series name is often the whole franchise.
  // Gated on !isEpisodic — for ordinary TV the episode title is just this
  // week's episode name and matching entries against it would be noise.
  const contentHit = isEpisodic ? null : matchEntryByContentTitle(entries, contentTitles, sideFormat);
  const contentMatch = contentHit?.entry ?? null;
  const classMatch = matchEntryByNonEpisodicClass(entries, seasonName, query, contentTitles);
  // Gated on isEpisodic: for a film or an OVA collection `wantedSeason` is the
  // fabricated default of 1, and letting it match would both pick a TV season's
  // entry for side-format content and mislabel the log line that says why.
  const seasonMatch = !isEpisodic
    ? undefined
    : entries.find((e) => {
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
  // Films, OVAs, specials and compilations reach here with NO season signal at
  // all — Crunchyroll publishes no `partOfSeason` block for them, so
  // `seasonName` and `seasonNumber` are both null and neither match above can
  // fire. See matchEntryByFullTitle.
  const titleMatch = matchEntryByFullTitle(entries, query, usedQuery === ladder[0]);
  // Every tier above is an actual match against this title. Falling past all of
  // them to `entries[0]` was not a match at all — it was "whatever the search
  // happened to return first", which for a recap film listed under a franchise
  // page is the franchise's season 1. That guess is no longer made (2026-08-01,
  // user's call): a missed warning banner risks capturing wrong-show sentences
  // into permanent Anki cards, which is a worse failure than a temporarily
  // blank subtitle track. Playback is untouched — only subtitle loading stops.
  // A film we can't name is a film we can't identify. Once Crunchyroll has said
  // this page is a movie, the tiers below contentMatch can only offer the
  // FRANCHISE — an exact match on the series title is the TV series' entry, not
  // this film's — or a sibling film that happened to be in the results. Both
  // are silent wrong-content loads of exactly the kind the live pass caught, so
  // a movie with no title evidence resolves to nothing and asks. Collections
  // are exempt: a franchise has one OVA bucket, and classMatch identifies it.
  const filmUnidentified = sideFormat?.[0] === "movie" && !nameMatch && !contentMatch && !soloHit;
  // soloHit sits BELOW classMatch deliberately: an episode-title search can
  // return one unrelated show (an OAD named "Distress" would), and for a
  // collection the format match is the stronger evidence. It sits ABOVE
  // titleMatch because that tier's exact match on a bare franchise name is the
  // flagship-series fallback The Last Attack hit.
  const entry = filmUnidentified
    ? null
    : nameMatch ?? contentMatch ?? classMatch ?? soloHit?.entry ?? seasonMatch ?? titleMatch ?? plainMatch ?? null;
  const candidates = entries.map((e) => ({ id: e.id, name: e.english_name ?? e.name }));
  if (!entry) {
    // Still logged unconditionally, and still before any decision about the
    // UI — an unresolved load has to be as visible in the console as a
    // resolved one, or it becomes the new silent case.
    console.log(
      `[jp-immersion] no Jimaku entry identified for "${query}" episode ${episode} — ` +
        `${entries.length} search results, none of them a match.`
    );
    console.warn(
      `[jp-immersion] couldn't identify which Jimaku entry "${query}" is, and none of the ` +
        `${entries.length} search results matches it. Loading no subtitles rather than guessing — ` +
        `pick the right entry in the subtitle switcher, or use the manual upload fallback.`
    );
    return { textFiles: [], entryName: null, entrySeason: null, confident: false, entryId: null, candidates, unresolved: true };
  }
  if (namedSeason !== null && seasonNumber !== null && namedSeason !== seasonNumber) {
    // Not an error — this is the fix doing its job, and seeing it fire is how
    // the Re:Zero shift gets confirmed as gone from a live console rather than
    // from the subtitles happening to look right.
    console.log(
      `[jp-immersion] using season ${namedSeason} from Crunchyroll's season name "${seasonName}" ` +
        `instead of its season number ${seasonNumber} (Crunchyroll numbers seasons by list position).`
    );
  }

  // A show whose seasons Jimaku does NOT split into separate entries keeps
  // everything under one season-1-looking entry, and picking it for a season-3
  // episode is correct — so a mismatch here can't be treated as an error.
  // But when it IS wrong it has been silently wrong (reported 2026-07-26:
  // season 3 of KonoSuba loading season 1's files, noticed only by reading the
  // subtitles), so it is surfaced instead of passed over: logged here, and the
  // resolved entry name is returned to the caller so the switcher panel can
  // show which Jimaku entry these files actually came from.
  const resolvedSeason = Math.max(entrySeasonNumber(entry.name), entrySeasonNumber(entry.english_name));
  // Reaching here means one of the tiers above matched, and every one of them
  // is a positive identification — so an entry that got this far is identified
  // by construction, and `confident` is simply true (2026-08-01). It used to be
  // computed, because resolution could also fall through to `entries[0]`, which
  // was a guess rather than a match; that fallback is gone, along with the
  // "using X as a guess" warning that reported it. An unidentified title now
  // returns `unresolved` above without reaching this point at all.
  const matchedBy = nameMatch
    ? "Crunchyroll's season name"
    : contentMatch
      ? `this title's own name "${contentHit.title}"`
      : classMatch
        ? `Crunchyroll listing this season as ${sideFormat[2]}`
        : soloHit && entry === soloHit.entry
          ? `Jimaku's only match for "${soloHit.title}"`
          : seasonMatch
            ? `season ${wantedSeason}`
            : titleMatch
              ? "an exact title match"
              : "an exact entry-name match";
  // Logged on EVERY load, not only on a detected mismatch (2026-07-31). Every
  // diagnostic here used to be conditional on the failure being noticed, which
  // is why a movie loading the wrong season produced a completely silent
  // console — the one case with no season data to disagree about.
  console.log(
    `[jp-immersion] Jimaku entry "${entry.english_name ?? entry.name}" (id ${entry.id}) ` +
      `for "${query}" episode ${episode} — matched by ${matchedBy}.`
  );
  const listFiles = async (forEntry, { allEpisodes = false } = {}) => {
    const filesUrl = allEpisodes
      ? `${JIMAKU_API_BASE}/entries/${forEntry.id}/files`
      : `${JIMAKU_API_BASE}/entries/${forEntry.id}/files?episode=${episode}`;
    const filesRes = await fetch(filesUrl, { headers });
    if (!filesRes.ok) {
      throw new Error(`Jimaku file lookup failed (${filesRes.status})`);
    }
    return filesRes.json();
  };

  let usedEntry = entry;
  let files = await listFiles(entry);
  // An empty result for a season Jimaku split across cours means the episode is
  // in the OTHER half — see courSiblingEntries. Only reached when the chosen
  // entry genuinely has nothing, so it never costs a request on a normal load.
  if (!files.length) {
    for (const sibling of courSiblingEntries(entries, entry)) {
      const siblingFiles = await listFiles(sibling);
      if (!siblingFiles.length) continue;
      console.log(
        `[jp-immersion] "${entry.english_name ?? entry.name}" has no files for episode ${episode} — ` +
          `using "${sibling.english_name ?? sibling.name}", which does (Jimaku splits this season across cours).`
      );
      usedEntry = sibling;
      files = siblingFiles;
      break;
    }
  }
  // Non-episodic content doesn't reliably carry an episode number on Jimaku's
  // side either (2026-07-31): a film is one file, and an OVA collection numbers
  // its parts however the uploader felt like. Crunchyroll reports episode 1 for
  // most of them, so an `?episode=` filter that matches nothing means the
  // numbering simply doesn't line up — not that the entry is empty. Listing the
  // entry's files unfiltered is the right answer there, and the switcher then
  // shows all of them. Gated on the content being non-episodic — doing this for
  // a real episode would happily serve some other episode's subtitles. That
  // gate was "no season signal at all" until 2026-08-01, which excluded the
  // OVA collections Crunchyroll publishes AS seasons: Re:Zero's OVAs resolved
  // to the right entry and then hard-errored on its four unnumbered files.
  if (!files.length && !isEpisodic) {
    const all = await listFiles(entry, { allEpisodes: true });
    if (all.length) {
      // Narrowed by the episode's own title first (2026-08-01). An OVA
      // collection's files are one per OVA, so dumping all of them leaves the
      // switcher showing an identical list for Memory Snow and The Frozen Bond
      // — no way to tell which is which without already knowing the answer.
      // Only a match narrows: a title Jimaku spells differently (Crunchyroll's
      // "The Frozen Bond" vs. the uploader's "Hyouketsu no Kizuna") matches
      // nothing and correctly falls through to the full list rather than to an
      // empty one.
      const narrowed = filesMatchingTitle(all, contentTitles);
      if (narrowed.files.length && narrowed.files.length < all.length) {
        console.log(
          `[jp-immersion] "${entry.english_name ?? entry.name}" has no file numbered episode ${episode} — ` +
            `narrowed its ${all.length} files to ${narrowed.files.length} matching this title's own name "${narrowed.title}".`
        );
        files = narrowed.files;
      } else {
        console.log(
          `[jp-immersion] "${entry.english_name ?? entry.name}" has no file numbered episode ${episode} — ` +
            `listing all ${all.length} of its files instead (normal for a movie, OVA or special)` +
            (contentTitles.length ? `; none of them names "${contentTitles[0]}".` : ".")
        );
        files = all;
      }
    }
  }
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
  return {
    textFiles,
    entryName: usedEntry.english_name ?? usedEntry.name,
    entrySeason: resolvedSeason,
    // Handed to the switcher panel so a wrong pick is fixable in-page rather
    // than being a dead end (2026-07-31). The candidate list is every entry the
    // search returned, which for an ambiguous film is where the right one is.
    // `confident` is true for anything returned from here — see above; the
    // switcher's own picker is driven by the `unresolved` response instead.
    confident: true,
    entryId: usedEntry.id,
    candidates,
  };
}

async function fetchAndParseFile(file, headers) {
  const fileRes = await fetch(file.url, { headers });
  if (!fileRes.ok) {
    throw new Error(`Subtitle download failed (${fileRes.status})`);
  }
  const rawText = await fileRes.text();
  const isAss = /\.(ass|ssa)$/i.test(file.name);
  const cues = isAss ? parseAss(rawText) : parseSrt(rawText);
  // Applied to the JAPANESE track only — never to fetchEnglishSubtitles
  // below, which is the English file by definition and would be stripped to
  // nothing. Every Japanese-subtitle consumer (on-screen box, Anki Sentence
  // field, audio-capture cue boundaries) reads from this one parsed list, so
  // doing it here fixes all of them at once. See stripDualLanguageCues.
  return stripDualLanguageCues(cues);
}

// Auto-load path: resolves candidates, picks one (fileHint override, else
// the top-ranked uploader — the user's own saved preference if any, else
// the hardcoded default), downloads and parses it. Also returns the FULL
// ranked candidate list and which URL got auto-selected (2026-07-15) — the
// switcher panel (content.js) uses this same response to render every
// option without a second, redundant Jimaku round trip, and to pre-select
// the entry that's actually playing rather than guessing at it separately.
// Takes the FETCH_SUBTITLES message itself rather than six positional
// arguments (2026-07-27) — the list had grown past the point where a call site
// was readable, and adding `seasonName` to it would have made a seventh.
async function fetchSubtitles({ query, episode, fileHint = null, preferredUploader = null, seasonNumber = null, seasonName = null, episodeTitle = null }) {
  const headers = await getJimakuHeaders();
  const { textFiles, entryName, confident, entryId, candidates, unresolved } = await resolveTextFiles(
    query,
    episode,
    headers,
    seasonNumber,
    seasonName,
    episodeTitle
  );
  // Nothing matched, so nothing is loaded (2026-08-01). Returned as a normal
  // response rather than thrown: an error message replaces the subtitle box and
  // takes the switcher panel with it, and the entry picker is the whole point
  // of this state — the user needs the candidate list to choose from.
  if (unresolved) {
    return {
      cues: [],
      files: [],
      selectedUrl: null,
      entryName: null,
      entryId: null,
      entryConfident: false,
      entryCandidates: candidates,
      entryUnresolved: true,
    };
  }
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
    // Which Jimaku entry these files came from (2026-07-26) — shown in the
    // switcher panel so the season actually being used is visible at a
    // glance, rather than only discoverable by noticing the subtitles are
    // wrong partway into an episode.
    entryName,
    // Entry-level selection (2026-07-31): which entry this is, whether it was
    // identified or guessed, and what else the search found. The switcher panel
    // turns the last two into a picker, so a film that resolves to the wrong
    // entry is one dropdown away from the right one instead of a dead end.
    entryId,
    entryConfident: confident,
    entryCandidates: candidates,
  };
}

// Switcher-panel entry override (2026-07-31) — lists one specific Jimaku
// entry's files, for when automatic resolution picked the wrong one. Files are
// requested for the episode first and unfiltered as a fallback, the same way
// resolveTextFiles handles non-episodic content: a user reaching for this
// control is usually on exactly the kind of title whose numbering doesn't line
// up, so refusing to list anything would defeat the point of offering it.
async function fetchEntryFiles(entryId, episode) {
  const headers = await getJimakuHeaders();
  const list = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Jimaku file lookup failed (${res.status})`);
    return res.json();
  };
  let files = Number.isInteger(episode)
    ? await list(`${JIMAKU_API_BASE}/entries/${entryId}/files?episode=${episode}`)
    : [];
  if (!files.length) files = await list(`${JIMAKU_API_BASE}/entries/${entryId}/files`);
  const textFiles = files.filter((f) => !ARCHIVE_RE.test(f.name));
  if (!textFiles.length) throw new Error("That entry has no subtitle files for this episode.");
  const ranked = rankFiles(textFiles, null);
  const cues = await fetchAndParseFile(ranked[0], headers);
  return {
    cues,
    files: ranked.map((f) => ({ name: f.name, url: f.url, size: f.size })),
    selectedUrl: ranked[0].url,
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

// English subtitles (Phase 5, 2026-07-23) — the URL comes from
// caption-url-sniffer.js (a MAIN-world content script observing Crunchyroll's
// own `play` API response, see project-plan.md Decisions Log), already
// time-signed and requiring no auth headers of our own, unlike the Jimaku
// fetch above. `format` ("ass" or anything else, treated as srt) comes
// straight from that same API response rather than sniffed from a filename,
// since this URL has no real filename/extension to sniff (see fetchAndParseFile's
// isAss check, which this deliberately doesn't reuse).
// The URL here ultimately comes from a page-context window.postMessage (see
// caption-url-sniffer.js) — any script on the page (a malicious ad, an XSS
// payload) could broadcast a spoofed message with an arbitrary URL, since
// postMessage has no way to authenticate the sender beyond same-window
// origin. Validated here, right before the one place that actually acts on
// it (an unrestricted fetch), rather than trusting content.js's forwarding —
// only a real crunchyrollcdn.com URL is fetched at all.
function isTrustedCrunchyrollCdnUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)crunchyrollcdn\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchEnglishSubtitles(url, format) {
  if (!isTrustedCrunchyrollCdnUrl(url)) {
    // Names the actual hostname (2026-07-26). The allowlist and
    // manifest.json's host_permissions both hardcode `*.crunchyrollcdn.com`,
    // which was the assumed CDN host when this was built and has never been
    // confirmed against a real signed subtitle URL — if Crunchyroll serves
    // these from any other host, this is where the feature dies, and the old
    // message gave no way to tell that apart from a genuine spoof attempt.
    let host = "(unparseable)";
    try {
      host = new URL(url).hostname;
    } catch {}
    throw new Error(
      `Refused to fetch English subtitles from untrusted host "${host}" — only *.crunchyrollcdn.com is allowed (see isTrustedCrunchyrollCdnUrl)`
    );
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`English subtitle fetch failed (${res.status})`);
  }
  const rawText = await res.text();
  const cues = format === "ass" ? parseAss(rawText) : parseSrt(rawText);
  if (!cues.length) {
    throw new Error(`English subtitle file parsed to 0 cues (format "${format}", ${rawText.length} bytes)`);
  }
  return cues;
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
