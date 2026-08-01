// Phase 3: segment subtitle text into words (kuromoji) and let the learner
// click a word to see its reading + definition (JMdict, looked up in the
// background worker).

// This entry's first Jimaku file for Witch Hat Atelier ep 1 (Haruhana's
// release) is a dual Chinese+Japanese sub track ("[CHS, JPN]") —
// background.js's fetchSubtitles would silently grab it via textFiles[0] and
// feed mixed-language text into the tokenizer. The same uploader also has a
// Japanese-only cut of the same release ("[JPN]"), so hint toward that one
// instead. Still a manual stopgap (2026-07-05/06) ahead of Phase 4.5's real
// ranked file-selection algorithm — hardcoded to this one show/uploader
// quirk, not a general mechanism. Once auto-detection (below) generalizes to
// other shows, this hint will only apply on shows where the string happens
// to appear in a filename, which is harmless (fetchSubtitles falls back to
// the first text file when nothing matches).
const FILE_HINT = "[JPN]";

// Show/episode auto-detection (Phase 4.5, 2026-07-15) — replaces the
// previous hardcoded SHOW_QUERY/EPISODE constants. Reads Crunchyroll's own
// schema.org JSON-LD (a `TVEpisode` block, present for SEO/rich-results
// purposes), confirmed present via direct page inspection on a real,
// logged-in watch page before building this (Crunchyroll's page is behind a
// Cloudflare bot challenge, so this couldn't be verified by fetching the
// page directly — a real DevTools console dump was needed).
// **Real finding that reverses the 2026-07-04 decision this was designed
// against:** Crunchyroll's page exposes NO external ID (no TMDB/AniList/MAL
// ID anywhere in the page's meta tags, JSON-LD, or embedded script state) —
// the "resolve via TMDB/AniList ID from Crunchyroll metadata" plan assumed
// data that doesn't actually exist on the page. What IS reliably present is
// the plain series title (`partOfSeries.name`), season number
// (`partOfSeason.seasonNumber`), and episode number (`episodeNumber`).
// Verified directly against the real Jimaku API (not assumed) that this is
// actually sufficient: querying `english_name`-preferring search with the
// exact title Crunchyroll exposes ("Witch Hat Atelier") returns exactly one
// clean match (Jimaku id 11793, whose own `name` is the JP-romanized
// "Tongari Boushi no Atelier" — matched via `english_name`, confirming
// Jimaku already indexes English titles as an alias, not just JP names).
// `fetchSubtitles` (background.js) already prefers an exact `name`/
// `english_name` match over `entries[0]` — that logic is unchanged, this
// just feeds it a live-detected title instead of a hardcoded one.
// `seasonNumber` is threaded into FETCH_SUBTITLES (2026-07-17) so
// background.js's entry search can pick the right Jimaku ENTRY for a
// multi-season show — Jimaku splits each season into a separate entry with
// its own free-text name (e.g. Frieren season 2 is a wholly different entry,
// "...Season 2", not more files under season 1's entry), which a
// season-agnostic exact title match can't distinguish. Doesn't resolve the
// separate, already-known per-FILE restart-numbering problem within a single
// entry (Naruto: Shippuuden's S07E01-style Jimaku file tagging, see Decisions
// Log 2026-07-06) — that's a different axis, still unsolved. Returns null
// (not a guess/fallback) when no parseable TVEpisode block is found, so the
// caller can show a clear error instead of querying Jimaku with a wrong or
// empty title.
let warnedMissingSeasonNameFor = null;
function detectShowEpisode() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    if (data["@type"] !== "TVEpisode") continue;
    const seriesTitle = data.partOfSeries?.name;
    const episodeNumber = data.episodeNumber;
    if (!seriesTitle || !Number.isInteger(episodeNumber)) continue;
    const detected = {
      seriesTitle,
      episodeNumber,
      seasonNumber: Number.isInteger(data.partOfSeason?.seasonNumber) ? data.partOfSeason.seasonNumber : null,
      // Crunchyroll's own name for this season, when it publishes one
      // (2026-07-27). Preferred over `seasonNumber` for picking a Jimaku
      // entry — see background.js's resolveTextFiles for why the NUMBER can't
      // be trusted on its own.
      seasonName: typeof data.partOfSeason?.name === "string" ? data.partOfSeason.name : null,
    };
    // Diagnostic, logged only when the expected field is missing: the
    // season-name matching in background.js is built on Crunchyroll publishing
    // this, which couldn't be verified without a live browser (the page is
    // behind a Cloudflare challenge). If this line ever appears, that fix has
    // degraded to the old number-only behaviour and the object dumped here
    // says what to try instead. Once per episode, not once per call — this
    // function runs on every watchdog tick as well as on every load.
    if (detected.seasonName === null && warnedMissingSeasonNameFor !== location.pathname) {
      warnedMissingSeasonNameFor = location.pathname;
      if (data.partOfSeason) {
        console.warn(
          "[jp-immersion] no partOfSeason.name on this page — season matching falls back to the season NUMBER, " +
            "which Crunchyroll assigns by list position rather than by season. partOfSeason was:",
          data.partOfSeason
        );
      } else {
        // Not gated on partOfSeason existing, as of 2026-07-31 — the ENTIRELY
        // absent case was the one that mattered and the one that said nothing.
        // Films, OVAs, specials and compilations have no season block at all,
        // which used to be read as "season 1" in silence: a movie playing under
        // the franchise's first season subtitles, with an empty console. Entry
        // resolution now handles this case explicitly (see background.js's
        // matchEntryByFullTitle); this line is what says the page is in it.
        console.log(
          "[jp-immersion] this title has no season information at all (normal for a movie, OVA or special) — " +
            "the Jimaku entry will be identified by title instead."
        );
      }
    }
    return detected;
  }
  return null;
}

// JAPANESE_WORD_RE and groupTokens live in tokenize-utils.js (loaded before
// this file by the manifest) so the batch-testing script can import them too.

let tokenizer = null;
let cues = null;
let activePopup = null;

// English captions (Phase 5, 2026-07-23) — sourced from Crunchyroll's own
// caption file, found by caption-url-sniffer.js (a MAIN-world content script
// observing the page's own network traffic, see project-plan.md Decisions
// Log) and forwarded here via postMessage. `englishCues` uses the SAME
// {start, end, text} shape as the Japanese `cues` above, but is matched
// against RAW video.currentTime in handleTimeUpdate below, NOT the
// offset-adjusted time Japanese cues use — Crunchyroll's own captions are
// synced to the video by construction, unlike community fansub files, so
// applying the manual per-episode offset would actively misalign them.
let englishCues = null;
let lastEnglishText = null;
// Module-scope, not a local in init() (2026-07-23) — same reasoning as
// `video`: loadSubtitles below needs to clear/hide it on episode change
// without every function in the chain needing it threaded through as a
// parameter.
let subtitleBoxEn = null;

// Bumped every time loadSubtitles resets for a new episode, so an English
// subtitle fetch still in flight from the PREVIOUS episode can't land after
// the reset and repopulate `englishCues` with the old episode's lines
// (2026-07-26). Same guard-by-generation pattern renderCue already uses for
// its own async round-trip (`renderGeneration`).
let englishCueEpoch = 0;
// The URL currently fetched or being fetched, so the sniffer's replay (see
// caption-url-sniffer.js) doesn't trigger a duplicate fetch of a file we
// already have.
let englishCueUrl = null;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const url = event.data?.__jpImmersionCaptionUrl;
  if (!url) return;
  if (url === englishCueUrl) return; // already fetched (or fetching) this exact file
  // The pathname the sniffer captured this URL on (2026-07-27). A replay
  // stamped with a DIFFERENT pathname is the previous episode's caption file
  // and must be ignored; one stamped with the current pathname is this
  // episode's, whether it was found before or after we noticed the navigation.
  // That distinction is the whole fix for the show-switch bug below — see
  // requestCaptionReplay.
  const stampedPath = event.data.__jpImmersionCaptionPath;
  if (stampedPath != null && stampedPath !== location.pathname) return;
  const format = event.data.__jpImmersionCaptionFormat ?? "ass";
  englishCueUrl = url;
  const epoch = englishCueEpoch;
  chrome.runtime.sendMessage({ type: "FETCH_ENGLISH_SUBTITLES", url, format }, (response) => {
    if (epoch !== englishCueEpoch) return; // episode changed while this was in flight
    if (!response || response.error) {
      // Left as a console warning rather than on-screen UI, but deliberately
      // explicit about which stage failed: this feature spent an entire
      // live-testing cycle (2026-07-26) showing nothing with no indication
      // anywhere of whether the URL was never found, was found and refused,
      // or was fetched and parsed to zero cues.
      console.warn("[jp-immersion] English subtitle fetch failed:", response?.error ?? "no response from background");
      englishCueUrl = null; // allow a retry if the sniffer sees the URL again
      return;
    }
    englishCues = response.cues;
    console.log(`[jp-immersion] English subtitles loaded: ${response.cues?.length ?? 0} cues`);
  });
});

// Tells caption-url-sniffer.js (MAIN world) to (re)broadcast the caption URL
// it has cached. Without this, a `play` response that resolved before this
// content script loaded was lost outright — see the sniffer's own `lastFound`
// comment for the full bug.
function requestCaptionReplay() {
  window.postMessage({ __jpImmersionContentReady: true }, "*");
}
requestCaptionReplay();

// Clears English caption state for an EPISODE CHANGE — and only that
// (2026-07-26). This used to live inside loadSubtitles(), which was wrong in
// a way that live testing caught precisely: loadSubtitles runs on initial
// page load and on every internal Jimaku retry, not just on episode change,
// so a successfully-loaded set of English cues was being wiped by an
// unrelated Japanese-subtitle load. The console showed it exactly —
// "English subtitles loaded: 317 cues" arriving BEFORE init() ran, then
// init()'s own loadSubtitles() call discarding them, leaving englishCues
// null with no English on screen and an empty Anki Translation field, even
// though every earlier stage of the pipeline had succeeded. Nothing re-posts
// the URL afterwards (the sniffer only replays on the ready handshake, which
// has already happened by then), so the loss was permanent for the page.
//
// DOES ask the sniffer to replay its cached URL, as of 2026-07-27 — reversing
// the original decision not to, which turns out to have been the cause of a
// real bug rather than a safeguard against one. Reported from live testing:
// switching from KonoSuba to Witch Hat Atelier left the Japanese subtitles
// working but no English at all until a full page reload.
//
// The race, in order: Crunchyroll changes the pathname and fetches the new
// episode's `play` data immediately; the sniffer sees it and posts the URL;
// this content script fetches and loads those cues — and only THEN, up to a
// full second later (the pathname poll's interval), does the navigation get
// noticed and this function run, destroying cues that were already the correct
// ones. Nothing re-posts afterwards, so the loss was permanent for the page.
//
// The original objection was sound but is now handled at the other end: a
// cached URL might still be the PREVIOUS episode's, and loading it would show
// the wrong episode's translations. The sniffer now stamps each URL with the
// pathname it was captured on (2026-07-27), so the listener above can accept a
// replay of the current episode's URL and discard a replay of the old one —
// which is exactly the distinction that was missing.
function resetEnglishCaptions() {
  englishCues = null;
  lastEnglishText = null;
  // Invalidates any in-flight fetch from the previous episode, and clears the
  // dedupe key so the new episode's own caption URL is fetched even in the
  // (unlikely) case Crunchyroll reuses the same signed URL.
  englishCueEpoch++;
  englishCueUrl = null;
  if (subtitleBoxEn) renderEnglishCue(subtitleBoxEn, "");
  requestCaptionReplay();
}
// Module-scope (not local to init()'s timeupdate listener) so the
// SPA-navigation reload below can also reset it — see loadSubtitles/
// jp-immersion-locationchange.
let lastText = null;
// The audio-capture cue-timeline entry for whatever `lastText` currently
// refers to (Phase 5, 2026-07-22, see audio-capture.js) — updated in lockstep
// with `lastText` itself so a word click can capture a direct reference to
// it synchronously, the same reasoning as `lastText` being module-scope.
let lastCueEntry = null;
// The window (in SUBTITLE-FILE time, i.e. before the offset is added back)
// spanned by whatever Japanese text is on screen right now, or null when
// nothing is. Set every tick by updateJapaneseCue and consumed by
// updateEnglishCue, which pairs English cues against it rather than running
// its own independent time match — see there for why. Module-scope rather
// than local to init() (2026-07-26) so click-time code can read it too: the
// Anki sentence merge (see buildMergedAnkiSentence) needs to know which cue
// window the clicked word was in.
let activeJpWindow = null;
// The cue window whose text is ACTUALLY PAINTED in the Japanese box right now,
// as opposed to `activeJpWindow` above, which is whatever the clock says
// should be showing. The two differ for exactly as long as renderCue's async
// dictionary round-trips take, which is normally imperceptible — but not on
// the first line after a page load or after alt-tabbing back, where the
// background service worker has idled out and has to be woken up first.
// Live testing 2026-07-27 reported precisely that: on the first subtitle only,
// the English line appeared before the Japanese one, everything after it
// simultaneous. English is paired against THIS window (2026-07-27) so it can't
// paint ahead of the Japanese line it belongs to — the same "one decision
// drives both boxes" principle updateEnglishCue was already built on, applied
// to the render itself rather than only to the cue matching.
let renderedJpWindow = null;
// Module-scope (not a const captured once inside init()), so a full
// show-to-show navigation can swap it out. Real report 2026-07-17: after
// switching from one show to a different one, the switcher panel/ranking
// kept updating correctly under the hood (background.js state is
// unaffected), but the actual on-screen subtitle text stayed permanently
// blank until a full page reload, which only re-fixed it by re-running
// init() from scratch — same-show episode-to-episode navigation was already
// confirmed NOT to hit this (2026-07-15/17). Diagnosed, not directly
// observed via devtools: the original code queried
// `document.querySelector("video")` exactly once and attached the
// timeupdate listener to that one element forever — the leading theory is
// that a full show change (unlike same-show episode navigation) swaps in a
// brand new <video> node, leaving the old element quietly dead (detached,
// frozen `currentTime`, no more real playback events) with nothing to
// re-query or re-bind to the new one. This fix (re-query + rebind on every
// SPA navigation) resolves the symptom either way, whether or not the node
// swap is the exact mechanism — worth flagging if it recurs after this.
let video = null;
// Tracks the (seriesTitle, seasonNumber, episodeNumber) of whatever was last
// successfully loaded, so a SPA-navigation-triggered reload can tell a
// genuinely fresh detection apart from Crunchyroll's schema.org block still
// holding the PREVIOUS episode's data for a brief window after the pathname
// already changed — a race this project's own 2026-07-17 retry mitigation
// explicitly flagged as a known, unaddressed gap ("doesn't address the DOM
// briefly holding the PREVIOUS episode's still-parseable block instead of
// failing outright"), and a real report the same day (switching Witch Hat
// Atelier episode 1 → 2 → 1 → 2 landing back on episode 1's default uploader
// instead of episode 2's) matches this exact shape. See loadSubtitles.
let lastLoadedIdentity = null;
function episodeIdentity(detected) {
  return `${detected.seriesTitle} ${detected.seasonNumber} ${detected.episodeNumber}`;
}
// True from the moment a subtitle load starts until it finishes or fails,
// including across its own internal retries — read only by the watchdog below,
// so it never fires a second, competing fetch on top of one already running.
let subtitleLoadPending = false;

// "Edit last card" (Phase 5, 2026-07-29) — the last note this page session
// added to Anki, as `{ id, label }`, or null if none yet. Feeds two surfaces:
// an Edit button in the popup's own success row, and the persistent control
// below.
//
// Kept in memory rather than in `chrome.storage.local`, deliberately. Persisting
// it would leave the button offering to edit a card added days ago on a
// different show, which is not what "last card" means to someone who just
// pressed it — and a stale note id can also have been deleted in Anki
// meanwhile. Surviving SPA navigation (which is what actually matters, since
// Crunchyroll doesn't reload between episodes) comes free from module scope; a
// full page reload clearing it is correct, not a limitation.
let lastAddedNote = null;
// The persistent control's elements, module-scope because `renderEntries` (a
// top-level function, not part of init()) has to refresh them the moment a card
// is added or undone.
let editLastCardControl = null;
let editLastCardButton = null;

// Opens `noteId` in Anki's own editor, reporting failure on the button that was
// clicked rather than in a separate error surface — same pattern as the
// "+ Anki" button's own "Failed — retry" state.
//
// **Secondary only, as of 2026-07-30.** This was the primary action when "edit
// last card" was first built; editing now happens in the in-page panel (see
// openEditPanel), and this is reached solely through that panel's "Open in
// Anki" control, for tags/note type/deletion — the things the panel
// deliberately doesn't cover.
function openAnkiNoteInEditor(noteId, btn, restoreLabel) {
  btn.disabled = true;
  btn.textContent = "Opening…";
  chrome.runtime.sendMessage({ type: "EDIT_ANKI_NOTE", noteId }, (response) => {
    btn.disabled = false;
    if (!response || response.error) {
      btn.textContent = "Couldn't open";
      btn.title = response?.error ?? "Unknown error";
      return;
    }
    // Anki now has focus, so this button is behind another window — restore it
    // immediately instead of leaving a stale "Opening…" for the user to come
    // back to.
    btn.textContent = restoreLabel;
    btn.title =
      response.opened === "browser"
        ? "Opened in Anki's card browser — this Anki version has no direct edit action"
        : "Opens this card in Anki's own editor";
  });
}

// Sits with the offset/upload/switcher controls (see init) rather than in the
// subtitle overlay: it's a set-once-and-forget tool like those, not something
// to put in front of the video. Hidden entirely until a card has actually been
// added, so it costs nothing for a session where the user never captures.
// Named with the word so it's obvious WHICH card is about to open — "edit last
// card" with no referent is a small act of faith on a destructive-looking
// button.
function buildEditLastCardControl() {
  const control = document.createElement("div");
  control.id = "jp-immersion-edit-last";
  const btn = document.createElement("button");
  btn.addEventListener("click", () => {
    if (!lastAddedNote) return;
    openEditPanel(lastAddedNote.id);
  });
  control.appendChild(btn);
  editLastCardControl = control;
  editLastCardButton = btn;
  refreshEditLastCardControl();
  return control;
}

function editLastCardLabel() {
  return lastAddedNote ? `Edit last card (${lastAddedNote.label})` : "Edit last card";
}

// Single owner of the control's visibility, so nothing else has to decide
// whether a card exists — including the SPA-navigation handler, which would
// otherwise reveal an empty control when returning to a watch page.
function refreshEditLastCardControl() {
  if (!editLastCardControl || !editLastCardButton) return;
  editLastCardControl.style.display = lastAddedNote ? "" : "none";
  editLastCardButton.textContent = editLastCardLabel();
  editLastCardButton.title = "Opens this card in Anki's own editor";
}

// Called when a note is deleted from Anki (Undo). Only forgets it if it's still
// the note the persistent control refers to: a popup lives on as a chip after
// the next subtitle line, so a LATER capture may already have replaced this one
// as "last card" by the time its Undo is pressed, and clearing unconditionally
// would hide a button that points at a card which still exists.
// Notes undone (or found already gone) this page session. Read by the deferred
// audio attach (2026-07-31), which must not write to a note that no longer
// exists — `lastAddedNote` can't answer that question, since capturing a second
// word moves it on while the first note is still perfectly alive.
const forgottenNotes = new Set();

function forgetAddedNote(noteId) {
  forgottenNotes.add(noteId);
  // The retained PCM buffer is a copy of a couple of megabytes; if the note it
  // belongs to has just been deleted, nothing can ever edit that audio again,
  // so it's released here rather than waiting for the next capture to overwrite
  // it. Checked independently of `lastAddedNote` below, since the two can point
  // at different notes.
  if (audioBufferNoteId === noteId) {
    audioBufferNoteId = null;
    clearRetainedClip();
  }
  if (lastAddedNote?.id !== noteId) return;
  lastAddedNote = null;
  refreshEditLastCardControl();
}

// Show/episode opt-in Anki field (Phase 5, 2026-07-23) — the currently-loaded
// show/episode, set alongside lastLoadedIdentity in loadSubtitles below so a
// word click always has access to the same detection data without needing
// its own separate call to detectShowEpisode(). Deliberately content.js-only
// state, not round-tripped through background.js — background.js has no way
// to know which episode is currently loaded, unlike POS/frequency/JLPT which
// are properties of the word itself and come from the dictionary lookup.
let currentShowEpisode = null;

// Season included only when set and not 1 — Crunchyroll's own partOfSeries.name
// is stable across an entire franchise's seasons (confirmed in background.js's
// own rankFiles comments: Frieren season 2 episodes still report the plain,
// un-suffixed title), so a season-less string would be genuinely ambiguous
// for any multi-season show, not just a cosmetic omission.
function formatShowEpisode(info) {
  if (!info) return null;
  const seasonPart = info.seasonNumber && info.seasonNumber !== 1 ? `Season ${info.seasonNumber}, ` : "";
  return `${info.seriesTitle} — ${seasonPart}Episode ${info.episodeNumber}`;
}

// SPA-navigation detection (2026-07-15, revised same day after the first
// attempt failed live testing). Confirmed via live testing that Crunchyroll
// does NOT reload the page between episodes: clicking to the next episode
// left the previous episode's subtitles showing until a manual page
// refresh, since init()'s one-time detectShowEpisode()+FETCH_SUBTITLES call
// never re-ran.
//
// First attempt wrapped `history.pushState`/`replaceState` to dispatch a
// custom event — shipped, then confirmed NOT working by a second live test
// (subtitles still stayed stale after switching episodes). Root cause:
// content scripts run in an ISOLATED JS world, which gets its own separate
// `history` object wrapping the shared browsing-context navigation state —
// reassigning `history.pushState` from the isolated world has no effect on
// Crunchyroll's own (main-world) calls to ITS OWN, unpatched
// `history.pushState` reference. The DOM/navigation STATE is correctly
// shared across both worlds (reading `location.pathname` works fine), only
// FUNCTION OVERRIDES fail to cross the isolated/main-world boundary — so
// polling the state directly sidesteps the problem entirely instead of
// trying to intercept whichever world's code changed it.
let lastPathname = location.pathname;
function notifyIfPathnameChanged() {
  if (location.pathname === lastPathname) return;
  lastPathname = location.pathname;
  window.dispatchEvent(new Event("jp-immersion-locationchange"));
}
setInterval(notifyIfPathnameChanged, 1000);
// Real back/forward navigation actually does fire a genuine browser-level
// `popstate` event (not a JS function call Crunchyroll's own code makes),
// so unlike the pushState/replaceState wrapper this one legitimately
// crosses the world boundary — kept as a faster-than-1s supplement to the
// poll above, not the primary mechanism.
window.addEventListener("popstate", notifyIfPathnameChanged);

// Stage directions like （ドアの開く音） and pure music lines are subtitle
// annotations, not dialogue — skip them at display time.
const STAGE_RE = /^[\s（(♪～）)…]+$|^[（(][^）)]*[）)]$/u;

// Speaker-name prefixes conventions vary by subtitle source: some use a
// bracketed name "（直樹）dialogue", others "Name: dialogue". Unlike STAGE_RE
// (which only matches a parenthetical that's the WHOLE line, i.e. a stage
// direction with no dialogue), this only strips a leading name when dialogue
// actually follows it — names are short, hence the {1,12} cap.
const SPEAKER_PREFIX_RE = /^(?:[（(][^）)]{1,12}[）)]|[^:：\n]{1,12}[:：])\s*/;

// Some subtitle authors add inline furigana for a hard kanji directly as
// bracketed text, e.g. 凱旋(がいせん). Redundant with click-to-check, which
// already surfaces the reading — and left in, it just looks cluttered. Only
// strips a parenthetical directly attached (no space) to a kanji run whose
// contents are pure hiragana, so it doesn't touch stage directions or other
// asides that aren't a reading annotation.
const INLINE_FURIGANA_RE = /([㐀-鿿々]+)[（(]([ぁ-んー]+)[）)]/g;

// Fansub-provider markup with no linguistic content, stripped globally
// (unlike STAGE_RE above, which only matches a parenthetical that's the
// WHOLE line). 「」『』“” quote brackets are real Japanese orthographic
// punctuation and are never touched, and neither are unit signs (°℃‰№) or
// the geometric shapes Japanese text uses to censor a character (クソビ○チ).
//
// Defined by CLASS rather than by enumeration (2026-07-27, generalized again
// 2026-07-29 after measuring against real files) — the rule used to be a
// literal list of five characters, which is why each new provider convention
// arrived as its own bug report. Three positive definitions now:
//
//   1. `\p{Extended_Pictographic}` — every emoji, whatever a provider picks.
//   2. U+2600–27BF — Miscellaneous Symbols plus Dingbats, the two contiguous
//      Unicode blocks dedicated to decorative symbols. This is what catches
//      the music notes (♪♩♫♬), the continuation arrows (➡➨) and the
//      off-screen-speech marker (⚟). Deliberately whole blocks, not the
//      characters that happen to have been noticed: neither block contains any
//      Japanese punctuation or unit sign, so there is nothing in them worth
//      keeping.
//   3. 《》⸨⸩ — inner-monologue/off-screen brackets. This one stays an
//      explicit list ON PURPOSE, and can't be otherwise: Unicode classifies
//      these identically to 「」『』（） (Ps/Pe), so no property can tell a
//      monologue marker from a real quote. The distinction is semantic, so it
//      is curated, and the list covers every pair the corpus actually uses.
//
// A trailing 〜/～ directly after a stripped symbol goes with it (♬～ is one
// music marker), but 〜 on its own is left alone — it's a real
// vowel-elongation convention in ordinary dialogue. Variation selectors, ZWJ
// and skin-tone modifiers are stripped alongside the emoji they modified so no
// orphaned invisible characters are left behind.
//
// ‼ and ⁉ are deliberately EXEMPT: Unicode counts them as pictographic, but in
// Japanese subtitles they're ordinary sentence-final punctuation (本当か⁉).
//
// **Measured, not assumed:** across 49,592 cues from 48 real Jimaku files
// spanning 7 shows and every provider offered for them, this changes 515 lines
// versus the enumerated version — 243 ♬ music lines and 85 ♪ ones now
// correctly dropped or de-marked, 48 ➨ arrows, 12 ⚟ and 11 ⸨⸩ markers now
// stripped — and breaks nothing that previously rendered correctly.
const FANSUB_MARKUP_RE =
  /[《》⸨⸩]|(?![\u{203C}\u{2049}])(?:\p{Extended_Pictographic}|[\u{2600}-\u{27BF}])[〜～]?|[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

// Short, learner-facing POS chip labels — cuts kokugo-grammar-school jargon
// ((futsuumeishi), (keiyoushi), etc.) that's redundant with the plain-language
// label next to it, and collapses JMdict's fine-grained conjugation-class
// codes (14 Godan variants, 25 archaic Nidan/Yodan ones) down to the two
// pedagogical terms this persona's tools (WaniKani/Bunpro-style) actually use.
// "n-pr" (proper noun) isn't reachable with this project's data source at
// all — JMdict's proper-noun entries live in the separate JMnedict database,
// which this project deliberately doesn't ingest (see project-plan.md
// Decisions Log) — kept here only so the label is correct if that ever changes.
const POS_LABELS = {
  "adj-f": "Pre-noun adjectival",
  "adj-i": "I-adjective",
  "adj-ix": "I-adjective",
  "adj-ku": "I-adjective (archaic)",
  "adj-na": "Na-adjective",
  "adj-nari": "Na-adjective (archaic)",
  "adj-no": "Adjectival noun (+の)",
  "adj-pn": "Pre-noun adjectival",
  "adj-shiku": "I-adjective (archaic)",
  "adj-t": "Taru-adjective",
  adv: "Adverb",
  "adv-to": "Adverb (+と)",
  aux: "Auxiliary",
  "aux-adj": "Auxiliary adjective",
  "aux-v": "Auxiliary verb",
  conj: "Conjunction",
  cop: "Copula",
  ctr: "Counter",
  exp: "Expression",
  int: "Interjection",
  n: "Noun",
  "n-pr": "Proper noun",
  "n-pref": "Prefix",
  "n-suf": "Suffix",
  num: "Numeral",
  pn: "Pronoun",
  pref: "Prefix",
  prt: "Particle",
  suf: "Suffix",
  unc: "Unclassified",
  "v-unspec": "Verb",
  v1: "Ichidan verb",
  "v1-s": "Ichidan verb",
  vz: "Ichidan verb",
  vk: "Kuru verb",
  vn: "Irregular verb",
  vr: "Irregular verb",
  vs: "する-verb",
  "vs-c": "する-verb",
  "vs-i": "する-verb",
  "vs-s": "する-verb",
  vi: "Intransitive",
  vt: "Transitive",
};

function posLabel(code) {
  if (POS_LABELS[code]) return POS_LABELS[code];
  if (code.startsWith("v5")) return "Godan verb";
  if (code.startsWith("v4")) return "Yodan verb (archaic)";
  if (code.startsWith("v2")) return "Nidan verb (archaic)";
  return code;
}

// くる/する's own irregular-verb-class chip ("Kuru verb"/"する-verb") is only
// real information when くる/する is a *component* of the resolved headword
// (持ってくる, or a noun+する pairing like 凱旋 — telling the learner a
// non-obvious fact about how that specific word/compound conjugates).
// When くる/する IS the resolved headword itself, the chip just restates the
// headword in grammatical-term form — unlike Ichidan/Godan, which genuinely
// disambiguate something spelling alone can't tell you (does 帰る conjugate
// as godan or ichidan?), くる/する as standalone headwords have no such
// ambiguity to resolve. Checked against both kanji and kana spellings since
// kuromoji's basic_form mirrors whichever script the actual conjugated token
// was written in (来る/くる both occur; 為る is する's rare archaic kanji form).
// Deliberately doesn't suppress "vs" (JMdict's code for a noun that merely
// *takes* する, e.g. 凱旋) — that's the real-information case this exists to
// preserve, not the headword-is-する case this suppresses.
const IRREGULAR_VERB_SELF_CODES = {
  くる: new Set(["vk"]),
  来る: new Set(["vk"]),
  する: new Set(["vs-i", "vs-s", "vs-c"]),
  為る: new Set(["vs-i", "vs-s", "vs-c"]),
};

// Caps at 3 chips per sense (matches every worked example: 王's king sense =
// Noun + Suffix, 凱旋 = Noun + する-verb + Intransitive) and dedupes so e.g. a
// sense tagged with two Godan sub-variants doesn't show "Godan verb" twice.
function formatPosChips(pCodes, word) {
  const skip = IRREGULAR_VERB_SELF_CODES[word];
  const seen = new Set();
  const chips = [];
  for (const code of pCodes) {
    if (skip && skip.has(code)) continue;
    const label = posLabel(code);
    if (seen.has(label)) continue;
    seen.add(label);
    chips.push(label);
    if (chips.length >= 3) break;
  }
  return chips.join(" · ");
}

// Native-morpheme inflection labels — matches how this persona already
// studies conjugation (e.g. a Jisho-style inflection table), not English
// grammar terminology. Keyed by the literal absorbed-auxiliary surface form
// (see groupTokens' `inflections` array in tokenize-utils.js). れる/られる and
// せる/させる each collapse to one fixed combined label regardless of which
// variant actually appeared, since both members of each pair share the exact
// same grammatical function (passive/potential; causative) — a deliberate,
// requested simplification, not a bug.
const INFLECTION_LABELS = {
  て: "て-form (connective)",
  で: "て-form (connective)",
  た: "た-form (past)",
  だ: "た-form (past)",
  ない: "ない-form (negative)",
  たい: "たい-form (desire)",
  たら: "-たら (conditional)",
  だら: "-たら (conditional)",
  ば: "-ば (conditional)",
  う: "-よう/-おう (volitional)",
  れる: "られる/れる (passive)",
  られる: "られる/れる (passive)",
  せる: "せる/させる (causative)",
  させる: "せる/させる (causative)",
  たり: "たり (representative action)",
  だり: "たり (representative action)",
  てる: "てる (contracted ている)",
  てた: "てた (contracted ていた)",
  てく: "てく (contracted ていく)",
  てき: "てき (contracted てきた/てくる)",
  なく: "ない-form, connective (negative)",
  お: "お (honorific prefix)",
  ご: "ご (honorific prefix)",
};

// Decided: chained/compound inflections (んだろう, etc.) don't get a
// synthesized composite label — too speculative ahead of real evidence this
// session; just show the raw native chain as-is (see project-plan.md).
//
// Noun/adjective+copula/politeness-suffix branches, three distinct labels
// (not one universal formula) — confirmed 2026-07-03 while fixing the
// 大事なことさ bug:
//   - noun + plain だ (田中だ) → real copula, plain register: "(copula)"
//   - noun + polite です (凱旋です) → real copula, polite register:
//     "(polite copula)"
//   - i-adjective + です (いいです) → です attaches to an い-adjective, which
//     already has its own predicate function on its own (いい alone is a
//     complete sentence) — です here adds ONLY politeness, doing no
//     copula-like linking work at all, so it gets "(polite)" with no
//     "copula" in it.
// な (だ's attributive/体言接続 form, e.g. 大事な) is the OTHER half of that
// same bug: grammatically distinct from plain だ (基本形) despite sharing the
// same basic_form, and previously showed no inflection line at all (its own
// group carries no absorbed `inflections` — conjugatedForm is the only
// signal it's a special form of だ, not だ itself). Checked first, since it
// doesn't go through the `inflections`-array branches below at all.
//
// んだ/んです (Rule 0.6, the ん+copula-family construction) previously fell
// through to the same table entry as verb-past-tense だ, showing "た-form" —
// wrong, んだ has nothing to do with past tense. Given its own label,
// checked via `word === "のだ"` (the literal value Rule 0.6 always sets).
function describeInflection(inflections, pos, conjugatedForm, word) {
  if (pos === "助動詞" && conjugatedForm === "体言接続") {
    return "な (attributive)";
  }
  if (word === "のだ" && inflections.length === 1) {
    return inflections[0] === "です" ? "んです (explanatory, polite)" : "んだ (explanatory)";
  }
  // んだろう/んでしょう (Rule 0.6's ん+copula-family chain extended with the
  // conjecture stem だろ/でしょ + う) previously fell through to the raw
  // inflections.join("") fallback below, showing just "だろう" — not
  // informative. Mirrors the んだ/んです labeling above.
  if (word === "のだ" && inflections.length === 2 && inflections[1] === "う") {
    return inflections[0] === "でしょ"
      ? "んでしょう (explanatory, conjecture, polite)"
      : "んだろう (explanatory, conjecture)";
  }
  if (inflections.length === 1 && (inflections[0] === "だ" || inflections[0] === "です")) {
    if (pos === "名詞") {
      return inflections[0] === "です" ? "+ です (polite copula)" : "+ だ (copula)";
    }
    if (pos === "形容詞" && inflections[0] === "です") {
      return "+ です (polite)";
    }
  }
  if (inflections.length === 0) {
    if (conjugatedForm && conjugatedForm.startsWith("命令")) return "命令形 (imperative)";
    // い-adjective's conjunctive/adverbial く-form (うまく in うまくなる,
    // うまくて) isn't absorbed into anything — Rule 1's te-merge only applies
    // to 動詞, not 形容詞 — so it stays its own group with no `inflections`
    // entry recorded, and previously showed no note explaining the form at
    // all even though it resolves correctly to the dictionary form (うまい).
    if (pos === "形容詞" && conjugatedForm === "連用テ接続") return "く-form (adverbial)";
    return null;
  }
  if (inflections.length === 1 && INFLECTION_LABELS[inflections[0]]) {
    return INFLECTION_LABELS[inflections[0]];
  }
  // れる/られる/せる/させる absorb ない (or its て-form/connective なく) as a
  // SEPARATE second inflections entry (信じられない → ["られ", "ない"]) — the
  // suffix's own surface form here is its 未然形 stem (られ/れ/せ/させ), not
  // the INFLECTION_LABELS-keyed dictionary form (られる/れる/せる/させる), so
  // neither the length-1 branch above nor a direct table lookup matches, and
  // this fell through to the raw, untranslated join below (plain "られない")
  // while every other inflection gets a plain-English label. Scoped to
  // exactly this family+ない/なく shape, not a general chained-inflection
  // composer — see the んだろう/んでしょう handling above for why chains don't
  // get a synthesized label in general.
  const PASSIVE_CAUSATIVE_STEMS = { れ: "れる", られ: "られる", せ: "せる", させ: "させる" };
  if (
    inflections.length === 2 &&
    PASSIVE_CAUSATIVE_STEMS[inflections[0]] &&
    INFLECTION_LABELS[inflections[1]]
  ) {
    return `${INFLECTION_LABELS[PASSIVE_CAUSATIVE_STEMS[inflections[0]]]} + ${INFLECTION_LABELS[inflections[1]]}`;
  }
  return inflections.join("");
}

// In fullscreen the browser only renders children of the fullscreen element,
// so our overlays need to live there while fullscreen is active.
function getContainer() {
  return document.fullscreenElement ?? document.body;
}

// Community subtitle timing drifts inconsistently release to release, so the
// offset is remembered per watch-page URL rather than globally. `let`, not
// `const` (2026-07-15) — recomputed on SPA episode navigation (see
// loadSubtitles) so a saved offset doesn't leak from one episode's storage
// key into another's session without an intervening page reload.
let OFFSET_STORAGE_KEY = `offset:${location.pathname}`;
let offset = 0;

// Per-show-per-season uploader preference memory (Phase 4.5, 2026-07-16).
// Keyed on the SAME (seriesTitle, seasonNumber) pair detectShowEpisode()
// already resolves — deliberately NOT per-episode (that's what `fileHint`
// and the switcher panel's live per-episode pick are for) and NOT scoped to
// offset memory's existing per-pathname key at all (that's a separate,
// unrelated mechanism this doesn't touch). Only ever stores an UPLOADER TAG
// (e.g. "Haruhana"), not a specific file/URL — a saved file URL would go
// stale the moment the episode changes, but an uploader tag generalizes
// across every episode of the same show+season, which is the whole point.
function uploaderPrefKey(seriesTitle, seasonNumber) {
  return `uploaderPref:${seriesTitle}:${seasonNumber ?? "?"}`;
}

// Extracts a release group's bracket tag from the START of a Jimaku
// filename (e.g. "[Haruhana] Tongari Boushi..." → "Haruhana") — the only
// place uploader identity exists at all, confirmed 2026-07-15 (no
// structured uploader field in Jimaku's API). Returns null for files with
// no leading bracket tag (e.g. direct-source rips like "とんがり帽子の
// アトリエ.S01E01...Netflix...") — there's no uploader identity to
// remember for those, so a pick landing on one simply doesn't persist a
// preference, rather than saving something meaningless.
function extractUploaderTag(filename) {
  const match = filename.match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}

// Detects the current show/episode and fetches its subtitles into the
// shared `cues` variable, which the timeupdate listener below (attached
// once in init()) already reads from continuously — so reassigning `cues`
// here is sufficient to make new subtitles appear, no listener re-attachment
// needed. Called once from init() on initial page load, and again from the
// jp-immersion-locationchange listener below on every SPA episode change.
// `switcherPanel` (2026-07-15) is populated with the same response's ranked
// candidate list, so it doesn't need its own separate Jimaku round trip.
function loadSubtitles(subtitleBox, switcherPanel, retriesLeft = 2, expectChange = false) {
  subtitleLoadPending = true;
  cues = null;
  lastText = null;
  // NOTE: English captions are deliberately NOT reset here (moved out
  // 2026-07-26 — see resetEnglishCaptions below for the bug this caused).
  // They come from an entirely separate pipeline driven by Crunchyroll's own
  // network activity, on its own schedule, with no relationship to this
  // Jimaku fetch — including this reset here meant a perfectly good set of
  // English cues was destroyed by an unrelated Japanese-subtitle load.
  // Undoes renderCue's `display: none` (see there) for the gap-between-lines
  // case — every status/error message this function can show below needs to
  // actually be visible, not silently hidden by a state left over from
  // whatever the box was doing a moment before this call.
  subtitleBox.style.display = "";
  subtitleBox.textContent = "Loading subtitles…";
  renderSwitcherOptions(switcherPanel, null, null, null);
  const detected = detectShowEpisode();
  // `expectChange` is only true from the locationchange listener below,
  // where the pathname is already known to have just changed — so a
  // detection that still matches the PREVIOUS episode's identity is stale
  // data, not a real result, even though it parsed without error. Confirmed
  // real 2026-07-17: navigating Witch Hat Atelier ep1→ep2→ep1→ep2 landed
  // back on ep1's default uploader instead of ep2's, consistent with a
  // stale re-detection silently re-fetching the wrong episode.
  const stale = expectChange && detected && lastLoadedIdentity === episodeIdentity(detected);
  if ((!detected || stale) && retriesLeft > 0) {
    // On SPA episode/show navigation, the pathname can update slightly
    // before Crunchyroll's own schema.org TVEpisode block for the new
    // episode is actually in the DOM (or, per `stale` above, still reflects
    // the old one) — a real report (2026-07-17) of the "couldn't detect"
    // error appearing intermittently on next-episode navigation, reliably
    // fixed by a full page reload (which gives the DOM more than enough time
    // to settle), matches this shape. A bounded retry after a short delay
    // covers that transient window without requiring a manual reload.
    setTimeout(() => loadSubtitles(subtitleBox, switcherPanel, retriesLeft - 1, expectChange), 500);
    return;
  }
  if (!detected) {
    subtitleLoadPending = false;
    subtitleBox.textContent =
      'Couldn\'t detect the show/episode from this page — use "Upload subtitle file" below instead.';
    return;
  }
  lastLoadedIdentity = episodeIdentity(detected);
  currentShowEpisode = detected;
  // Saved per-show-per-season uploader preference (if any) is threaded into
  // the SAME FETCH_SUBTITLES call rather than fetched separately and then
  // possibly re-fetched — background.js's rankFiles gives it top priority
  // in the ranking itself, so only one Jimaku round trip is ever needed
  // regardless of whether a preference exists. A saved preference with no
  // matching file this episode is a silent no-op there (the "sticky
  // fallback" requirement) — nothing to handle on this side.
  chrome.storage.local.get(uploaderPrefKey(detected.seriesTitle, detected.seasonNumber), (stored) => {
    const preferredUploader = stored[uploaderPrefKey(detected.seriesTitle, detected.seasonNumber)] ?? null;
    chrome.runtime.sendMessage(
      {
        type: "FETCH_SUBTITLES",
        query: detected.seriesTitle,
        episode: detected.episodeNumber,
        seasonNumber: detected.seasonNumber,
        seasonName: detected.seasonName,
        fileHint: FILE_HINT,
        preferredUploader,
      },
      (response) => {
        subtitleLoadPending = false;
        if (!response) {
          subtitleBox.textContent = "Extension error: no response from background.";
          return;
        }
        if (response.error) {
          subtitleBox.textContent = `Subtitle error: ${response.error} — use "Upload subtitle file" below if Jimaku has nothing for this show.`;
          return;
        }
        cues = response.cues;
        // Nothing matched, so nothing loaded (2026-08-01) — deliberately not an
        // error state: the video keeps playing, and the switcher panel below
        // still renders its entry picker so there's a way forward.
        if (response.entryUnresolved) {
          subtitleBox.textContent =
            'Couldn\'t tell which Jimaku entry this is — no subtitles loaded. Pick an entry below, or use "Upload subtitle file".';
        }
        renderSwitcherOptions(switcherPanel, response.files, response.selectedUrl, detected, response.entryName, {
          confident: response.entryConfident !== false,
          entryId: response.entryId ?? null,
          candidates: response.entryCandidates ?? [],
          unresolved: Boolean(response.entryUnresolved),
        });
        // Forces an immediate re-render via the shared timeupdate listener
        // (see init()) instead of waiting for the video's own next natural
        // timeupdate tick — otherwise a paused video (or one that hasn't
        // started its next tick yet) shows no change until the user seeks or
        // presses play. Same fix already applied to the manual-upload path
        // (buildUploadControl) when this was first caught there; this path
        // had the identical gap, confirmed real 2026-07-17 (reported as
        // subtitles "stuck on Loading subtitles…" inconsistently).
        if (video) video.dispatchEvent(new Event("timeupdate"));
      }
    );
  });
}

// The manifest matches every crunchyroll.com page, not just watch pages
// (needed so `jp-immersion-locationchange` can detect navigating INTO a
// watch page without a full reload) — but the homepage/search page also
// often has an unrelated `<video>` element (an autoplay hero banner/promo),
// which the old `document.querySelector("video")` check alone couldn't tell
// apart from a real episode player. Confirmed real 2026-07-17: the
// "couldn't detect the show/episode" error was showing up on the homepage
// and search page, where it's not just wrong but actively confusing (there's
// no video to have subtitles for at all). `/watch/` is Crunchyroll's real
// watch-page URL segment — not independently re-verified against the live
// site this session, flag if this turns out wrong for some URL shape.
function isWatchPage() {
  return location.pathname.includes("/watch/");
}

function init() {
  video = document.querySelector("video");
  if (!video || !isWatchPage()) {
    setTimeout(init, 1000);
    return;
  }

  initAudioCapture(video);

  // Both subtitle boxes live inside one bottom-anchored flex column
  // (2026-07-26) rather than each being independently `position: fixed` at
  // its own viewport offset. That's the fix for the JP/EN vertical-order bug
  // found in live testing: previously the Japanese box was pinned at
  // bottom:60px and the English box at bottom:20px, which only kept English
  // visually below Japanese as long as the English caption stayed short. A
  // two- or three-line English caption grows UPWARD from its own 20px anchor
  // straight into the Japanese box's space, and since both boxes carry the
  // same max z-index, the later sibling (English) paints on top — so a long
  // English line renders over the Japanese one and reads as the two having
  // swapped places. Stacking them as flex children of a single anchor makes
  // the order structural: Japanese is the first child, English the second,
  // and neither can overlap the other at any caption length. Per the
  // 2026-07-26 decision, Japanese-on-top is fixed intent, not configurable.
  const subtitleStack = document.createElement("div");
  subtitleStack.id = "jp-immersion-subtitle-stack";

  const subtitleBox = document.createElement("div");
  subtitleBox.id = "jp-immersion-subtitle";
  subtitleStack.appendChild(subtitleBox);
  // Text set by loadSubtitles() below, not here — it's called both on
  // initial load and on every SPA episode change, so it owns this state.

  // English caption display (Phase 5, 2026-07-23) — plain text, no
  // click-to-lookup (per the original dual-display spec: "Japanese clickable,
  // English non-clickable"), positioned below the Japanese line. Its own
  // element rather than sharing subtitleBox since the two are independently
  // driven (different cue sources, different timing reference — see
  // englishCues above) and dual-display means both need to be visible at once,
  // not toggled between.
  subtitleBoxEn = document.createElement("div");
  subtitleBoxEn.id = "jp-immersion-subtitle-en";
  subtitleBoxEn.style.display = "none";
  subtitleStack.appendChild(subtitleBoxEn);

  getContainer().appendChild(subtitleStack);

  const offsetControl = buildOffsetControl();
  getContainer().appendChild(offsetControl);

  const switcherPanel = buildSwitcherPanel();
  getContainer().appendChild(switcherPanel);

  const editLastCard = buildEditLastCardControl();
  getContainer().appendChild(editLastCard);

  document.addEventListener("fullscreenchange", () => {
    const target = getContainer();
    // One re-parent for the whole stack — the two boxes are its children now
    // (see above), so moving them individually would tear them back out of it.
    target.appendChild(subtitleStack);
    target.appendChild(offsetControl);
    target.appendChild(switcherPanel);
    target.appendChild(editLastCard);
    // A live (not yet chipped) word-click popup needs the same re-parenting
    // — confirmed real bug via live testing (2026-07-22, same root cause the
    // chip was fixed for above): created before a fullscreen toggle, it was
    // left behind in the old container and stopped rendering.
    if (activePopup) target.appendChild(activePopup);
  });

  try {
    buildTokenizer();
  } catch (err) {
    // Tokenizer failure (e.g. invalidated extension context) is non-fatal —
    // subtitles will still display as plain text without word segmentation.
    console.error("[Japanese Immersion] tokenizer failed to start:", err);
  }

  chrome.storage.local.get(OFFSET_STORAGE_KEY, (stored) => {
    offset = stored[OFFSET_STORAGE_KEY] ?? 0;
    updateOffsetDisplay();
  });

  // Named (not inline) so it can be detached from an old <video> node and
  // reattached to a new one — see the rebinding logic in the
  // jp-immersion-locationchange listener below. Reads the module-scope
  // `video` variable rather than closing over this function's own local
  // parameter, so it always reflects whichever element is CURRENTLY bound,
  // even though the function reference itself never changes. Reads from the
  // shared `cues` variable so either a Jimaku fetch or a manual file upload
  // (see buildUploadControl) can populate it interchangeably, without each
  // needing its own listener. `lastText` is module-scope (not declared here)
  // so an episode change (loadSubtitles, below) can reset it too.
  function handleTimeUpdate() {
    updateJapaneseCue();
    updateEnglishCue();
  }

  // Split out of handleTimeUpdate (2026-07-26) — see updateEnglishCue below
  // for the desync bug this split fixes.
  function updateJapaneseCue() {
    if (!cues) {
      activeJpWindow = null;
      return;
    }
    const adjustedTime = video.currentTime - offset;
    // ASS files often split one visual subtitle across multiple simultaneous
    // Dialogue events — collect all that match the current time and join them.
    //
    // Written as an explicit loop rather than the chained .filter/.map it
    // used to be (2026-07-26) purely so each surviving piece of text stays
    // paired with the CUE it came from — the chain discarded that link at the
    // first .map, and updateEnglishCue now needs the timing of the cues that
    // actually contributed visible text (not merely the ones that matched the
    // clock, which includes stage directions that get filtered out below).
    // The order of operations is identical to the old chain.
    //
    // The filter chain itself lives in `cueDisplayText` (2026-07-27) rather
    // than being spelled out again here. It was duplicated line-for-line in
    // both places, with a comment on the other copy promising the two stay
    // identical — a promise nothing enforced, and one that a filter-ordering
    // fix the same day would have quietly broken on one side only. Calling the
    // one function makes "what a cue looks like on screen" and "what a cue
    // contributes to a merged Anki sentence" the same code by construction.
    // (`cueDisplayText` also handles the half-width→full-width katakana
    // normalization that used to happen inline here — some releases, e.g.
    // VCB-Studio, encode katakana half-width, and it has to be normalized
    // BEFORE tokenization or a word resolves correctly on click while still
    // displaying as ｽﾏﾎ.)
    // The "which cues are showing, and what do they render to" step itself
    // lives in `japaneseDisplayAt` (2026-07-29) so the English gap-bridging
    // below can ask the same question about a moment that ISN'T now — the
    // cue just before a gap and the one just after it.
    const { window, text } = japaneseDisplayAt(adjustedTime);
    activeJpWindow = window;
    if (text === lastText) return;
    lastText = text;
    lastCueEntry = markCueBoundary(text, activeJpWindow);
    // The English box is updated from renderCue's completion callback, not
    // from here — see `renderedJpWindow` for the first-line stagger that
    // fixes. Captured into a local first: `activeJpWindow` is module-scope and
    // a later tick can reassign it before this callback runs.
    const windowBeingRendered = activeJpWindow;
    renderCue(subtitleBox, text, () => {
      renderedJpWindow = windowBeingRendered;
      updateEnglishCue();
    });
  }

  // English caption matching (2026-07-23) — deliberately independent of the
  // Japanese pipeline above: RAW video.currentTime, not adjustedTime (see
  // englishCues' own comment for why), no tokenizer/click-handling, and
  // doesn't participate in the popup/chip lifecycle at all (chipifyPopup is
  // only ever triggered by the JAPANESE line changing, since that's what the
  // user is actually interacting with).
  //
  // Its own function, called unconditionally from handleTimeUpdate, rather
  // than a trailing block inside updateJapaneseCue's body (2026-07-26) —
  // that's the JP/EN desync bug found in live testing. Sitting there, this
  // code was unreachable on any tick where the Japanese line hadn't just
  // changed, because updateJapaneseCue's own `if (text === lastText) return`
  // (and its `if (!cues) return`) bailed out first. The English box therefore
  // only ever redrew AT a Japanese cue boundary: an English line whose real
  // start/end fell mid-Japanese-line appeared late or lingered on screen
  // until the Japanese line happened to change, which is exactly the
  // "one lingers after the other has cleared" symptom. Nothing to do with
  // the offset (confirmed by the user at offset=0, where the two time
  // references are identical) — the two boxes simply weren't being evaluated
  // on the same ticks. They now both re-evaluate on every timeupdate, so a
  // boundary either box crosses is picked up on the same tick.
  //
  // Paired to the JAPANESE cue window rather than matched against the clock
  // on its own (2026-07-26). Matching independently is what live testing
  // reported as the two lines appearing and disappearing at visibly different
  // moments even at offset 0: the two files are authored separately, so the
  // same spoken line carries boundaries that differ by a few hundred
  // milliseconds, and `timeupdate` only fires ~4x/second — so a 150ms
  // difference in the source data lands the two changes on DIFFERENT ticks
  // and becomes a ~250ms visible stagger. No amount of fixing our own timing
  // helps, because the discrepancy is in the source files.
  //
  // Slaving the English line to the Japanese one makes them simultaneous by
  // construction: there is now a single decision ("is Japanese text showing,
  // and which cue window does it span") driving both boxes, so they can only
  // ever change together. It also preserves the case live testing explicitly
  // flagged as correct — one English sentence spanning two consecutive
  // Japanese cues: each Japanese window pairs with that same English cue, the
  // rendered text is therefore identical across both, and renderEnglishCue
  // no-ops on unchanged text, so the English line simply stays on screen
  // across the transition instead of blinking.
  //
  // TRADE-OFF, deliberate: English now shows ONLY while Japanese is showing.
  // A moment Crunchyroll translates but the Jimaku file has no line for (a
  // sign, a dropped line), or an episode whose Japanese subtitles failed to
  // load at all, displays no English either. That is the direct cost of
  // "they appear and disappear at exactly the same time" — the two cannot be
  // both independently timed and perfectly simultaneous. Consistent with the
  // extension being Japanese-first, but flag it if it proves annoying in use.
  function updateEnglishCue() {
    if (!englishCues) return;
    // With Japanese on screen, the English line is whatever pairs with it. With
    // nothing on screen, it's normally cleared too — except across a short gap
    // inside a split sentence, where it's held (2026-07-29, see
    // bridgedEnglishText for the blink this fixes).
    const enText = renderedJpWindow
      ? pairedEnglishText(renderedJpWindow)
      : bridgedEnglishText(video.currentTime - offset);
    if (enText === lastEnglishText) return;
    lastEnglishText = enText;
    renderEnglishCue(subtitleBoxEn, enText);
  }
  video.addEventListener("timeupdate", handleTimeUpdate);
  // Skipping around detaches the audio clock's recorded cue extents from what
  // is actually playing — see audio-capture.js's noteSeek. Live testing
  // (2026-07-31) found this as occasional 22–40 second, mostly-silent clips
  // captured shortly after seeking.
  video.addEventListener("seeking", noteSeek);

  loadSubtitles(subtitleBox, switcherPanel);

  // Re-detect and re-fetch on SPA episode navigation (2026-07-15) — without
  // this, `cues` keeps pointing at the previous episode's subtitles
  // indefinitely, since Crunchyroll doesn't reload the page between
  // episodes (confirmed via live testing). Also recomputes the offset
  // storage key/value for the new episode's URL, so a saved offset doesn't
  // leak across episodes.
  window.addEventListener("jp-immersion-locationchange", () => {
    // The one place English caption state should be cleared: the episode
    // actually changed, so the previous episode's translations are now stale
    // (2026-07-26 — see resetEnglishCaptions for why this can't live in
    // loadSubtitles). Runs for both branches below: leaving a watch page
    // needs the cues dropped just as much as switching episodes does.
    resetEnglishCaptions();
    // Same reasoning, for the audio side (2026-07-31): the rolling buffer and
    // the recorded cue extents describe an episode that is no longer playing.
    // Without this, a capture still waiting for its line to finish went on to
    // slice a buffer that by then held the NEXT episode — reported live as a
    // card whose audio came from the episode navigated to, not the one the
    // word was captured from.
    resetCaptureForNavigation();
    // Navigating away from a watch page (e.g. back to browse/search) via SPA
    // navigation, not a full reload — hide the UI rather than letting
    // loadSubtitles run and eventually show "couldn't detect the
    // show/episode" on a page that was never showing an episode to begin
    // with. See `isWatchPage` above for the same-day report this addresses.
    if (!isWatchPage()) {
      // Hides the stack, not just the Japanese box (2026-07-26) — the
      // English box is a sibling inside it and was previously left visible
      // on non-watch pages, since this branch predates it existing.
      closeEditPanel(); // anchored to a page that's no longer showing an episode
      subtitleStack.style.display = "none";
      switcherPanel.style.display = "none";
      offsetControl.style.display = "none";
      uploadControl.style.display = "none";
      editLastCard.style.display = "none";
      removeChip();
      closePopup();
      return;
    }
    subtitleStack.style.display = "";
    switcherPanel.style.display = "";
    offsetControl.style.display = "";
    uploadControl.style.display = "";
    // Not set directly: whether this one is visible depends on whether a card
    // has been added, which refreshEditLastCardControl owns.
    refreshEditLastCardControl();
    OFFSET_STORAGE_KEY = `offset:${location.pathname}`;
    chrome.storage.local.get(OFFSET_STORAGE_KEY, (stored) => {
      offset = stored[OFFSET_STORAGE_KEY] ?? 0;
      updateOffsetDisplay();
    });
    rebindVideoIfSwapped();
    loadSubtitles(subtitleBox, switcherPanel, 2, true);
  });

  // Re-query for the <video> element and rebind if Crunchyroll swapped in a
  // different one — see the `video` declaration above for the real report this
  // addresses (switching shows entirely left subtitles permanently blank until
  // a full reload). A same-show episode change appears to reuse the existing
  // <video> node (this is then just a same-element no-op, confirmed via the
  // 2026-07-15/17 episode-nav testing never hitting this issue), so this mainly
  // matters for the heavier show-to-show case.
  function rebindVideoIfSwapped() {
    const freshVideo = document.querySelector("video");
    if (!freshVideo || freshVideo === video) return false;
    if (video) {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeking", noteSeek);
    }
    video = freshVideo;
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeking", noteSeek);
    initAudioCapture(video);
    removeChip(); // anchored to the old <video> element's rect, now stale
    return true;
  }

  // Watchdog (2026-07-27), for the show-to-show switch that came back from
  // live testing as "sometimes no subtitles at all until I hard-reload the
  // page". Both of the things it re-checks were already handled ONCE, at the
  // instant navigation was noticed — which is the problem: on a show change
  // Crunchyroll rebuilds the player and its schema.org block on its own
  // schedule, and if either lands after that instant, the one-shot handling
  // above has already run and nothing looks again.
  //
  //   - A <video> swapped in AFTER the rebind check leaves the timeupdate
  //     listener attached to a detached, frozen element: no ticks, so no
  //     subtitle ever renders, matching the report exactly. (The existing
  //     500ms retries cover the detection side of this window but not the
  //     video side, which had no retry at all.)
  //   - A schema.org block that still held the PREVIOUS show's data through
  //     all of loadSubtitles' retries leaves the wrong show's subtitles
  //     loaded, with nothing scheduled to correct it.
  //
  // Both are just "what's loaded no longer matches what the page says", so
  // both are checked the same way: cheaply, on a timer, for as long as the page
  // is open. A full reload fixed these because it re-ran everything from
  // scratch — this re-runs the two parts that actually go stale, without one.
  setInterval(() => {
    if (!isWatchPage()) return;
    if (rebindVideoIfSwapped()) {
      console.log("[jp-immersion] <video> element was swapped out — rebound and re-rendering.");
      video.dispatchEvent(new Event("timeupdate"));
    }
    if (subtitleLoadPending) return; // a load is already in flight; let it finish
    const detected = detectShowEpisode();
    if (!detected || episodeIdentity(detected) === lastLoadedIdentity) return;
    console.log(
      `[jp-immersion] page now reports "${episodeIdentity(detected)}" but "${lastLoadedIdentity}" is loaded — reloading subtitles.`
    );
    resetEnglishCaptions();
    loadSubtitles(subtitleBox, switcherPanel);
  }, 2000);

  const uploadControl = buildUploadControl();
  getContainer().appendChild(uploadControl);
  document.addEventListener("fullscreenchange", () => {
    getContainer().appendChild(uploadControl);
  });

  document.addEventListener("click", (event) => {
    if (activePopup && !activePopup.contains(event.target) && !event.target.classList.contains("jp-immersion-word")) {
      closePopup();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!event.altKey) return;
    if (event.key === "ArrowLeft") {
      setOffset(offset - 0.1);
    } else if (event.key === "ArrowRight") {
      setOffset(offset + 0.1);
    } else if (event.code === "Digit0") {
      setOffset(0);
    } else {
      return;
    }
    event.preventDefault();
  });
}

function buildOffsetControl() {
  const control = document.createElement("div");
  control.id = "jp-immersion-offset";

  const dec = document.createElement("button");
  dec.textContent = "−0.1s";
  dec.addEventListener("click", () => setOffset(offset - 0.1));

  const value = document.createElement("span");
  value.id = "jp-immersion-offset-value";

  const inc = document.createElement("button");
  inc.textContent = "+0.1s";
  inc.addEventListener("click", () => setOffset(offset + 0.1));

  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.addEventListener("click", () => setOffset(0));

  control.append(dec, value, inc, reset);
  return control;
}

// Manual subtitle switcher panel (Phase 4.5, 2026-07-15) — lets the user
// override the auto-selected Jimaku file with any other candidate for the
// same show+episode (background.js's `rankFiles`/`fetchSubtitles` already
// returns every candidate, ranked, not just the winner — no separate Jimaku
// round trip needed here). Rough/functional only, no visual polish
// (deliberately deferred to Phase 6, same as the switcher panel's whole
// build-order entry) — a single labeled <select>, not a custom dropdown.
function buildSwitcherPanel() {
  const control = document.createElement("div");
  control.id = "jp-immersion-switcher";
  return control;
}

// Repopulates the switcher panel from a FETCH_SUBTITLES response (or clears
// it when `files` is null — no candidates yet, or the auto-fetch failed and
// there's nothing to switch between). Kept separate from buildSwitcherPanel
// so loadSubtitles() can refresh the SAME panel element on every episode
// change instead of rebuilding it. `detected` (2026-07-16) is only needed to
// derive the uploader-preference storage key when the user picks a file
// manually — null is fine for the "nothing to show yet" clearing call.
function renderSwitcherOptions(panel, files, selectedUrl, detected, entryName = null, entryInfo = null) {
  panel.textContent = "";
  // No files is normally "nothing to switch between", so the panel hides. The
  // exception (2026-08-01) is the unresolved state: no entry matched, so
  // nothing was loaded on purpose, and the entry picker below is the only way
  // out short of manual upload — hiding it would make the dead end permanent.
  const hasEntryPicker = Boolean(entryInfo && !entryInfo.confident && entryInfo.candidates?.length > 1);
  if ((!files || !files.length) && !hasEntryPicker) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "flex";

  // Entry picker (2026-07-31). Films, OVAs, specials and compilations carry no
  // season information on Crunchyroll's page at all, so there is often nothing
  // to identify which Jimaku entry they are — see background.js's
  // matchEntryByFullTitle. Rather than guess silently, which is what shipped
  // the "movie plays with season 1's subtitles" bug, an unidentified entry says
  // so here and offers every candidate the search returned.
  if (entryInfo && !entryInfo.confident && entryInfo.candidates?.length > 1) {
    const warning = document.createElement("div");
    warning.className = "jp-immersion-switcher-warning";
    // Two different situations, and conflating them is how the wrong-subtitles
    // case reads as reassuring. Either something IS loaded and needs checking,
    // or nothing was loaded at all and the user has to choose (2026-08-01).
    warning.textContent = entryInfo.unresolved
      ? "Couldn't tell which Jimaku entry this is, so no subtitles were loaded — pick one:"
      : "Couldn't tell which Jimaku entry this is — check these are the right subtitles:";
    panel.appendChild(warning);

    const entryLabel = document.createElement("label");
    entryLabel.textContent = "Jimaku entry: ";
    const entrySelect = document.createElement("select");
    for (const candidate of entryInfo.candidates) {
      const option = document.createElement("option");
      option.value = String(candidate.id);
      option.textContent = candidate.name;
      if (candidate.id === entryInfo.entryId) option.selected = true;
      entrySelect.appendChild(option);
    }
    entrySelect.addEventListener("change", () => {
      const chosenId = Number(entrySelect.value);
      entrySelect.disabled = true;
      chrome.runtime.sendMessage(
        { type: "FETCH_ENTRY_FILES", entryId: chosenId, episode: detected?.episodeNumber ?? null },
        (response) => {
          entrySelect.disabled = false;
          if (!response || response.error) {
            entrySelect.value = String(entryInfo.entryId);
            warning.textContent = response?.error ?? "Couldn't load that entry.";
            return;
          }
          cues = response.cues;
          lastText = null;
          // Re-rendered from the new entry's own file list, with the picker
          // kept open on the entry now in use — the pick may well need
          // another try, and collapsing the control after one attempt would
          // make the second one harder than the first.
          const chosen = entryInfo.candidates.find((c) => c.id === chosenId);
          renderSwitcherOptions(panel, response.files, response.selectedUrl, detected, chosen?.name ?? null, {
            ...entryInfo,
            entryId: chosenId,
            // Something is loaded now, so the "no subtitles were loaded" wording
            // above must not persist into a state where it's false.
            unresolved: false,
          });
          if (video) video.dispatchEvent(new Event("timeupdate"));
        }
      );
    });
    entryLabel.appendChild(entrySelect);
    panel.appendChild(entryLabel);
  }

  // Names the Jimaku ENTRY the files below came from (2026-07-26). Jimaku
  // indexes each season as a separate entry, and picking the wrong one has
  // been a recurring, silent failure — the file names in the dropdown are
  // usually just "[Uploader] Show - 05.ass", which looks perfectly correct
  // whether it came from season 1 or season 3. Showing the entry title makes
  // the season being used visible without having to read the subtitles to
  // find out. See background.js's resolveTextFiles.
  // Nothing loaded, so there is no file list to offer — the entry picker above
  // is the entire panel until the user resolves it.
  if (!files || !files.length) return;

  const label = document.createElement("label");
  label.textContent = entryName ? `Subtitle file (${entryName}): ` : "Subtitle file: ";
  if (entryName) label.title = `Jimaku entry: ${entryName}`;

  const select = document.createElement("select");
  for (const file of files) {
    const option = document.createElement("option");
    option.value = file.url;
    option.textContent = file.name;
    if (file.url === selectedUrl) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    const chosen = files.find((f) => f.url === select.value);
    if (!chosen) return;
    chrome.runtime.sendMessage(
      { type: "FETCH_SUBTITLE_FILE", url: chosen.url, name: chosen.name },
      (response) => {
        if (!response || response.error) {
          // Revert the dropdown to whatever's still actually loaded rather
          // than leaving it showing a selection that silently failed.
          select.value = selectedUrl;
          return;
        }
        cues = response.cues;
        lastText = null;
        // A manual pick becomes this show+season's remembered uploader
        // preference going forward (2026-07-16) — only when the chosen
        // file actually has an extractable uploader tag; an unbracketed
        // direct-source file (Netflix/Amazon rip) has no reusable identity
        // to save, so picking one just applies for this episode, same as
        // before, with no memory created.
        const uploaderTag = extractUploaderTag(chosen.name);
        if (uploaderTag && detected) {
          chrome.storage.local.set({
            [uploaderPrefKey(detected.seriesTitle, detected.seasonNumber)]: uploaderTag,
          });
        }
        // Same forced-re-render fix as loadSubtitles() above — a manual
        // switch while paused (the common case: you pause to go fiddle with
        // the dropdown) would otherwise leave the OLD file's last-rendered
        // line on screen indefinitely, since `cues` changed but nothing ever
        // told the timeupdate listener to re-check it.
        if (video) video.dispatchEvent(new Event("timeupdate"));
      }
    );
  });

  label.appendChild(select);
  panel.appendChild(label);
}

// Manual subtitle upload fallback (2026-07-06) — for shows Jimaku has zero
// entries for at all, or a per-episode override when the auto-fetched file
// is wrong/missing. Feeds a local .srt/.ass file into the same
// parseSrt/parseAss already built in Phase 2 for Jimaku-sourced files (now
// also loaded as a content script, see manifest.json) — no new parsing
// logic, just a new input path alongside the existing FETCH_SUBTITLES one.
// Always visible (not just shown on a Jimaku failure), since a per-episode
// override is a real, expected use case even when Jimaku succeeds. Reads the
// module-scope `video` (2026-07-17, no longer a captured parameter) so a
// pick made after a show-to-show navigation swapped the active element still
// targets the CURRENT one, not whatever was active when this control was
// first built.
function buildUploadControl() {
  const control = document.createElement("div");
  control.id = "jp-immersion-upload";

  const label = document.createElement("label");
  label.textContent = "Upload subtitle file (.srt/.ass): ";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".srt,.ass,.ssa";

  const status = document.createElement("span");
  status.id = "jp-immersion-upload-status";

  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    status.textContent = "Loading…";

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const isAss = /\.(ass|ssa)$/i.test(file.name);
        const parsedCues = isAss ? parseAss(reader.result) : parseSrt(reader.result);
        if (!parsedCues.length) {
          status.textContent = `No cues found in "${file.name}" — check the file is a valid .srt/.ass.`;
          return;
        }
        cues = parsedCues;
        status.textContent = `Loaded "${file.name}" (${parsedCues.length} cues).`;
        // Forces an immediate re-render using the existing timeupdate
        // listener (see init()) rather than waiting for the video to fire
        // its own next timeupdate — otherwise a paused video shows no
        // change until the user seeks or presses play.
        video.dispatchEvent(new Event("timeupdate"));
      } catch (err) {
        status.textContent = `Failed to parse "${file.name}": ${err.message}`;
      }
    };
    reader.onerror = () => {
      status.textContent = `Failed to read "${file.name}".`;
    };
    reader.readAsText(file);
  });

  label.appendChild(input);
  control.append(label, status);
  return control;
}

function setOffset(newOffset) {
  offset = Math.round(newOffset * 10) / 10; // avoid float drift like 0.30000000000000004
  chrome.storage.local.set({ [OFFSET_STORAGE_KEY]: offset });
  updateOffsetDisplay();
}

function updateOffsetDisplay() {
  const value = document.getElementById("jp-immersion-offset-value");
  if (value) value.textContent = `Offset: ${offset.toFixed(1)}s`;
}

function buildTokenizer() {
  kuromoji
    .builder({ dicPath: chrome.runtime.getURL("vendor/kuromoji-dict/") })
    .build((err, builtTokenizer) => {
      if (err) {
        console.error("[Japanese Immersion] kuromoji failed to load:", err);
        return;
      }
      tokenizer = builtTokenizer;
    });
}

// Incremented on every renderCue call so an in-flight CHECK_KANA_MERGES
// response can tell it's been superseded by a newer subtitle line (e.g. the
// viewer scrubbed past it) and skip rendering into a stale subtitleBox state.
let renderGeneration = 0;

// The `onDone` handed to the CURRENT renderCue call, fired once its text is
// actually in the DOM (2026-07-27). Only one is ever outstanding — a new
// renderCue supersedes the previous line entirely — so a single slot is
// enough, and the generation check in `finishRender` is what makes a late
// callback from a superseded line a no-op rather than a stale update.
let pendingRenderDone = null;
function finishRender(generation) {
  if (generation !== renderGeneration) return;
  const done = pendingRenderDone;
  pendingRenderDone = null;
  if (done) done();
}

// Plain-text English caption rendering (2026-07-23) — no tokenization, no
// click handlers, per the dual-display spec (Japanese clickable, English
// non-clickable). Hides on empty text rather than leaving a blank styled box
// visible, same fix as the Japanese box's own stray-empty-box bug
// (2026-07-17) — this box has the same padding/background in content.css and
// would show the same artifact otherwise.
function renderEnglishCue(subtitleBoxEn, text) {
  if (!text) {
    subtitleBoxEn.style.display = "none";
    subtitleBoxEn.textContent = "";
    return;
  }
  subtitleBoxEn.style.display = "";
  subtitleBoxEn.textContent = text;
}

// `onDone` fires once this line is on screen — synchronously for a clear or an
// untokenized line, and after however many dictionary round-trips the line
// needs otherwise. Optional: nothing about rendering depends on it, it exists
// so the English box can be kept in lockstep (see `renderedJpWindow`).
// Runs the full tokenize → phrase-match → kana-merge → katakana pipeline for a
// line of Japanese and resolves to the clickable groups it produces.
//
// Extracted from renderCue's own four-stage callback chain (2026-07-30) so the
// edit panel's "Change word" flow can put the SAME clickable tokens on a stored
// sentence that the subtitle line had at capture time. Rebuilding that chain a
// second time for the panel is exactly the duplication that had to be undone
// for the display filters on 2026-07-27, so it was factored instead.
//
// Each stage is only an async round-trip when it actually finds candidates, so
// a line with none stays effectively synchronous, as before. The one behaviour
// change from the callback version: a superseded line now finishes building its
// groups before being discarded, instead of bailing at whichever stage it had
// reached. That's a few wasted dictionary-membership lookups on rapid subtitle
// changes and nothing else — the generation check that matters still guards the
// DOM write in renderCue.
function checkKanaMerges(texts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CHECK_KANA_MERGES", texts }, (response) => {
      resolve(response?.membership ?? {});
    });
  });
}

async function buildGroupsForText(text) {
  const tokens = tokenizer.tokenize(text);

  // Phrase-matching (multi-token JMdict expressions like からといって, じゃない,
  // んだ, たら) has to run on the RAW token stream, before groupTokens/Rule 3
  // ever touch it — 帰ったら tokenizes as 帰っ+たら (one combined auxiliary
  // token), and Rule 3 would already absorb it into 帰った before any
  // post-hoc scan could see it as available for a separate たら match.
  let groups;
  const phraseCandidates = findPhraseMatchCandidates(tokens);
  if (phraseCandidates.length === 0) {
    groups = groupTokens(tokens);
  } else {
    const membership = await checkKanaMerges([...new Set(phraseCandidates.map((c) => c.lookupText))]);
    const { fuseSpans, dualViewSpans } = classifyAndSelectPhraseMatches(tokens, phraseCandidates, membership);
    groups = applyPhraseMatches(tokens, fuseSpans, dualViewSpans);
  }

  // Then kana-merge (single-word fragmentation like ただいま！) runs on whatever
  // groups resulted.
  const kanaCandidates = findKanaMergeCandidates(groups);
  if (kanaCandidates.length > 0) {
    const membership = await checkKanaMerges([...new Set(kanaCandidates.map((c) => c.lookupText))]);
    groups = applyKanaMerges(groups, kanaCandidates, membership);
  }

  // Runs unconditionally, after kana-merge has already had its chance to claim
  // a lone っ into a real merged word (んっ) — see suppressTrailingSokuon in
  // tokenize-utils.js for why the ordering matters.
  groups = suppressTrailingSokuon(groups);

  const unsuppressCandidates = findKatakanaUnsuppressCandidates(groups);
  if (unsuppressCandidates.length > 0) {
    const membership = await checkKanaMerges([...new Set(unsuppressCandidates.map((i) => groups[i].surface))]);
    groups = applyKatakanaUnsuppress(groups, unsuppressCandidates, membership);
  }

  const nameCandidates = findKatakanaNameCandidates(groups);
  if (nameCandidates.length > 0) {
    const membership = await checkKanaMerges([...new Set(nameCandidates.map((i) => groups[i].surface))]);
    groups = applyKatakanaNameSuppression(groups, nameCandidates, membership);
  }

  return groups;
}

// `onDone` fires once this line is on screen — synchronously for a clear or an
// untokenized line, and after however many dictionary round-trips the line
// needs otherwise. Optional: nothing about rendering depends on it, it exists
// so the English box can be kept in lockstep (see `renderedJpWindow`).
function renderCue(subtitleBox, text, onDone = null) {
  const myGeneration = ++renderGeneration;
  pendingRenderDone = onDone;
  chipifyPopup();
  subtitleBox.textContent = "";
  if (!text) {
    // A real, confirmed bug (2026-07-17), not just cosmetic: `#jp-immersion-
    // subtitle` has real padding/border-radius/background in content.css,
    // so an EMPTY-but-still-`display: block` div renders as a small visible
    // dark rounded box even with no text — reported as a stray "oval" over
    // whatever happens to be on screen at that exact fixed viewport spot
    // (bottom-60px, horizontally centered) during any gap between subtitle
    // lines, which is most of the runtime for typical dialogue pacing.
    // Confirmed as ours, not Crunchyroll's: disappeared when the extension
    // was disabled. Went unnoticed initially because `pointer-events: none`
    // (deliberate, so it never blocks clicking the video underneath) also
    // means a right-click on it inspects whatever's BEHIND it instead — the
    // element itself never showed up as inspectable, despite being real.
    subtitleBox.style.display = "none";
    finishRender(myGeneration);
    return;
  }
  subtitleBox.style.display = "";

  if (!tokenizer) {
    subtitleBox.textContent = text;
    finishRender(myGeneration);
    return;
  }

  buildGroupsForText(text).then((groups) => {
    if (myGeneration !== renderGeneration) return; // a newer line took over mid-lookup
    renderGroups(subtitleBox, groups);
    finishRender(myGeneration);
  });
}

function renderGroups(subtitleBox, groups) {
  // Running character offset within the full rendered line (2026-07-17,
  // Phase 5) — every group's surface concatenates in order to exactly
  // reproduce `lastText`, so tracking this here gives the Anki-capture flow
  // an EXACT position to bold the clicked word at, rather than a substring
  // search that could match the wrong occurrence if the same word appears
  // twice in one line.
  let offset = 0;
  for (const group of groups) {
    if (group.word === null) {
      subtitleBox.appendChild(document.createTextNode(group.surface));
      offset += group.surface.length;
      continue;
    }

    const span = document.createElement("span");
    span.className = "jp-immersion-word";
    span.textContent = group.surface;
    span.dataset.word = group.word;
    span.dataset.surface = group.surface;
    span.dataset.startOffset = offset;
    span._inflections = group.inflections;
    span._isParticle = group.isParticle ?? false;
    span._isHonorificSuffix = group.isHonorificSuffix ?? false;
    span._pos = group.pos ?? null;
    span._conjugatedForm = group.conjugatedForm ?? null;
    span._idiomWord = group.idiomWord ?? null;
    span.addEventListener("click", onWordClick);
    subtitleBox.appendChild(span);
    offset += group.surface.length;
  }
}

// groupTokens, findKanaMergeCandidates, applyKanaMerges, findPhraseMatchCandidates,
// classifyAndSelectPhraseMatches, applyPhraseMatches are defined in tokenize-utils.js.

// Shared by buildSentenceHtml and renderEntries's own fallback below — both
// need to embed plain subtitle/dictionary text into an Anki field's HTML.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Which English cues are this Japanese window's translation. Shared by the
// on-screen English line (updateEnglishCue) and the Anki sentence merge
// (buildMergedAnkiSentence) so the two can never disagree about what pairs
// with what.
//
// MIDPOINT containment, both ways: an English cue belongs to this Japanese
// window if it is CENTRED inside the window, or if the window's own centre
// falls inside the English cue. The first arm covers ordinary 1:1 pairing and
// one-Japanese-line-translated-as-two-English-sentences; the second covers
// two-Japanese-cues-to-one-English-sentence, where the English cue is far
// longer than either window. `window` is in subtitle-file time, English cues
// are in raw video time, so the offset is added back to map one onto the
// other — which also means correcting the Japanese offset re-pairs the
// English along with it.
function pairEnglishCues(window) {
  if (!englishCues || !window) return [];
  const winStart = window.start + offset;
  const winEnd = window.end + offset;
  const winMidpoint = (winStart + winEnd) / 2;
  return englishCues.filter((c) => {
    const cueMidpoint = (c.start + c.end) / 2;
    return (
      (cueMidpoint >= winStart && cueMidpoint <= winEnd) ||
      (winMidpoint >= c.start && winMidpoint <= c.end)
    );
  });
}

// The rendered English text for a Japanese cue window — `pairEnglishCues`'
// result flattened the one way every caller wants it. Factored out (2026-07-29)
// because the gap-bridging below has to compare the English of two DIFFERENT
// windows for equality, which means both sides must be produced identically.
function pairedEnglishText(window) {
  return pairEnglishCues(window)
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join("\n");
}

// How long a gap between two Japanese cues can be and still have the English
// line held on screen across it (see bridgedEnglishText). A cosmetic comfort
// limit, NOT a sentence-boundary classifier — the "both sides map to the same
// English cue" test is what establishes that two cues are one sentence, and
// this only stops the English line floating alone under an empty Japanese box
// through a long dramatic pause.
//
// **Measured before picking a number** (2026-07-29, 14,742 gaps between
// consecutive display windows across 24 real files from 6 episodes): the
// distribution has NO trough to site a cutoff in. 78% of all gaps are under
// 100ms, and past ~0.5s the density just decays smoothly with no valley. It
// also varies far more by PROVIDER than by show — on Frieren ep 7 alone, gaps
// under 100ms are 43% of the total on [Moozzi2] but 78% on the NTV rip, and
// KonoSuba/Re:Zero releases run 94–96%. So a fixed constant can't separate
// "same sentence" from "next sentence", and a threshold scaled to average cue
// duration wouldn't either — the variation is in the shape of the gap
// distribution, not in the timescale. That's precisely why the English-identity
// test carries the decision and this value only has to be *comfortable*: 1s is
// long enough to bridge the overwhelming majority of within-sentence gaps and
// short enough that a real pause still clears the box. One named constant,
// trivial to retune against real footage.
const JP_GAP_BRIDGE_SECONDS = 1.0;

// Keeps the English line up across a SHORT gap between two Japanese cues that
// translate to the same English sentence (2026-07-29). Returns the text to hold,
// or "" to clear the box.
//
// The bug this fixes: a split sentence's two Japanese cues are usually
// separated by a few tens of milliseconds, and if a `timeupdate` tick happens
// to land in that gap the Japanese window goes null, the English box clears,
// and the very next tick re-renders the same English sentence — a visible blink
// of identical text. The existing no-op-on-unchanged-text guard in
// updateEnglishCue can't help, because the intervening state isn't "the same
// text", it's empty.
//
// Three outcomes, by gap length:
//   - Effectively no gap: no tick lands between the cues, so this never runs and
//     the unchanged-text guard already prevents any re-render.
//   - Gap within JP_GAP_BRIDGE_SECONDS: bridged. Japanese is empty through the
//     pause, English stays.
//   - Longer gap: not bridged. Both boxes clear, and English re-mounts fresh
//     with the next Japanese cue — otherwise it floats alone under an empty
//     Japanese box through a genuine dialogue pause.
//
// Keyed on JAPANESE cue timing, deliberately, not on the English track's own
// cue boundaries — the English file is authored independently and its
// boundaries are what caused the original desync (see updateEnglishCue).
// Display-only: nothing here is visible to the Anki sentence merge, which stays
// English-content-driven and is unaffected.
function bridgedEnglishText(fileTime) {
  if (!cues || !englishCues) return "";
  // The Japanese cue boundaries either side of this moment.
  let prevEnd = null;
  let nextStart = null;
  for (const cue of cues) {
    if (cue.end <= fileTime && (prevEnd === null || cue.end > prevEnd)) prevEnd = cue.end;
    if (cue.start >= fileTime && (nextStart === null || cue.start < nextStart)) nextStart = cue.start;
  }
  // Nothing before or nothing after means the episode's first or last gap,
  // which has no pair of cues to bridge BETWEEN.
  if (prevEnd === null || nextStart === null) return "";
  if (nextStart - prevEnd > JP_GAP_BRIDGE_SECONDS) return "";
  // Sample just inside each neighbouring cue rather than at its boundary, so
  // the sample can't land in the gap it's measuring.
  const before = japaneseDisplayAt(prevEnd - 0.001);
  const after = japaneseDisplayAt(nextStart + 0.001);
  if (!before.window || !after.window) return "";
  const beforeEn = pairedEnglishText(before.window);
  // Only bridge when both sides are the SAME English sentence. Different
  // English either side means two separate sentences with a pause between
  // them, which is the existing hide-then-show behaviour and stays unchanged.
  if (!beforeEn || beforeEn !== pairedEnglishText(after.window)) return "";
  return beforeEn;
}

// Which Japanese cues are on screen at a given SUBTITLE-FILE time (i.e. offset
// already applied), and the single block of text they render to. ASS files
// often split one visual subtitle across several simultaneous Dialogue events,
// so the answer is a join of every cue matching that instant, and the window is
// their combined extent.
function japaneseDisplayAt(fileTime) {
  if (!cues) return { window: null, text: "" };
  const parts = [];
  for (const cue of cues) {
    if (fileTime < cue.start || fileTime > cue.end) continue;
    const text = cueDisplayText(cue);
    if (!text) continue; // stage direction or markup-only — never contributes
    parts.push({ cue, text });
  }
  if (!parts.length) return { window: null, text: "" };
  return {
    window: {
      start: Math.min(...parts.map((p) => p.cue.start)),
      end: Math.max(...parts.map((p) => p.cue.end)),
    },
    text: parts.map((p) => p.text).join("\n"),
  };
}

// THE display filter chain — the single definition of what a raw subtitle cue
// looks like once it reaches the screen. Called both by updateJapaneseCue (per
// cue, per tick) and by the Anki sentence merge, so a cue's contribution to a
// merged sentence is identical to what it looks like on screen by
// construction. Returns "" for a cue that wouldn't be displayed at all (stage
// direction, markup-only).
// Fansub markup is stripped BEFORE the stage-direction test (2026-07-27), not
// after. Live testing found a KonoSuba line rendering as "🔊（警報）": the
// emoji prefix meant STAGE_RE — which only matches a parenthetical that is the
// ENTIRE line — never recognised it as a stage direction, so an annotation
// that should have been dropped outright was displayed instead. Stripping
// markup first restores the whole-line shape STAGE_RE is looking for. Nothing
// else in the chain depends on the old order: SPEAKER_PREFIX_RE and
// INLINE_FURIGANA_RE both key off parentheses/kanji that markup stripping
// never touches.
function cueDisplayText(cue) {
  let t = cue.text.trim();
  t = t.replace(FANSUB_MARKUP_RE, "").trim();
  if (!t || STAGE_RE.test(t)) return "";
  t = t.replace(SPEAKER_PREFIX_RE, "").trim();
  t = t.replace(INLINE_FURIGANA_RE, "$1").trim();
  if (!t) return "";
  return normalizeHalfwidthKatakana(t);
}

// One spoken sentence is often split across two consecutive Japanese subtitle
// cues while Crunchyroll translates it as a single English sentence — measured
// at ~12% of cues across four episodes (2026-07-26). On screen that's correct
// and deliberately left alone (the next line is a second away), but it makes a
// BAD Anki card: the Sentence field captures half a sentence. This rebuilds
// the full sentence for capture only.
//
// Anki-only by the user's explicit choice (2026-07-26): merging the on-screen
// display too would make the Japanese line depend on Crunchyroll's English
// track being available, so the same show would read differently depending on
// whether the caption pipeline fired. Capture is where the split actually
// hurts, so that's the only place it's corrected.
//
// English-driven because it has to be — a Japanese-only rule ("merge when the
// line doesn't end in 。／？／！") was measured and rejected: sentence-final
// punctuation turns out to be an artifact of each uploader's transcription
// style, present on 10% of cues in one file and 87% in another, so such a rule
// merges ~37% of cues on unpunctuated files and behaves completely differently
// per provider.
//
// Returns null whenever anything is ambiguous — no English cues loaded, the
// window pairs with zero or several English cues, or nothing neighbours it.
// The caller then falls back to the single on-screen line, which is today's
// behaviour and always safe.
function buildMergedAnkiSentence(displayedText) {
  if (!cues || !englishCues || !activeJpWindow || !displayedText) return null;
  const paired = pairEnglishCues(activeJpWindow);
  // Only merge on an unambiguous 1:1 anchor. If this window already maps to
  // several English cues, the Japanese line is the longer unit of the two and
  // there is nothing to join it to.
  if (paired.length !== 1) return null;
  const anchor = paired[0];

  const before = [];
  const after = [];
  for (const cue of cues) {
    // Skip the cues making up the window itself — the displayed text is
    // spliced in verbatim below rather than rebuilt, so that the clicked
    // word's recorded character offset stays exactly valid.
    if (cue.end > activeJpWindow.start && cue.start < activeJpWindow.end) continue;
    const own = pairEnglishCues({ start: cue.start, end: cue.end });
    if (own.length !== 1 || own[0] !== anchor) continue;
    const text = cueDisplayText(cue);
    if (!text) continue;
    if (cue.end <= activeJpWindow.start) before.push({ start: cue.start, end: cue.end, text });
    else if (cue.start >= activeJpWindow.end) after.push({ start: cue.start, end: cue.end, text });
  }
  if (!before.length && !after.length) return null;

  before.sort((a, b) => a.start - b.start);
  after.sort((a, b) => a.start - b.start);
  const beforeText = before.map((p) => p.text).join("\n");
  const parts = [...before.map((p) => p.text), displayedText, ...after.map((p) => p.text)];
  return {
    text: parts.join("\n"),
    // How far the displayed line moved within the merged string, so the
    // caller can shift the clicked word's offset by the same amount. Includes
    // the "\n" separator that follows the prefix.
    offsetShift: beforeText ? beforeText.length + 1 : 0,
    // The merged group's full extent in subtitle-file time, used to widen the
    // audio clip to match it (see audio-capture.js's sliceClipWavWhenReady).
    // Timings rather than the group's first/last display TEXT, which is not a
    // reliable key — see that function for the bug this replaced.
    mergeStart: Math.min(activeJpWindow.start, ...before.map((p) => p.start)),
    mergeEnd: Math.max(activeJpWindow.end, ...after.map((p) => p.end)),
  };
}

// Builds the HTML the Anki "Sentence" field expects (the clicked word
// wrapped in <b>) from the exact position `renderGroups` recorded on the
// span, not a substring search — robust against the same word appearing
// twice in one line, unlike indexOf(). Captured once, synchronously, at
// click time (2026-07-17) — NOT re-read later when the "+ Anki" button
// itself is clicked, since `lastText` is module-scope and the video may
// have advanced to a new line during the async LOOKUP_WORD round-trip (or
// while the user is still reading the popup) by the time that happens.
// Returns null if the offset is missing/invalid rather than guessing, so
// the caller can fall back to no sentence rather than a corrupted one.
function buildSentenceHtml(sentenceText, startOffset, surface) {
  if (!sentenceText || !Number.isInteger(startOffset) || startOffset < 0) return null;
  const end = startOffset + surface.length;
  if (end > sentenceText.length || sentenceText.slice(startOffset, end) !== surface) return null;
  // Line breaks are converted AFTER escaping and per-slice, so the escaped
  // offsets the <b> wrapper depends on are never disturbed (2026-07-26).
  // A cue split across several simultaneous ASS Dialogue events is joined
  // with "\n" upstream in updateJapaneseCue, and the on-screen box renders
  // that correctly via `white-space: pre-wrap` — but an Anki field is plain
  // HTML, where a raw newline collapses to a space, so a two-part line
  // arrived on the card as one run-on sentence.
  const toHtml = (s) => escapeHtml(s).replace(/\n/g, "<br>");
  return toHtml(sentenceText.slice(0, startOffset)) + "<b>" + toHtml(surface) + "</b>" + toHtml(sentenceText.slice(end));
}

// Matches the popup's own numbered-sense display (renderEntries below) so
// the Anki card's Gloss field shows the same thing the learner already saw
// when they clicked "+ Anki", not a differently-formatted summary.
function formatGlossForAnki(g) {
  return g.map((senseGlosses, i) => `${i + 1}. ${senseGlosses.join("; ")}`).join("<br>");
}

function onWordClick(event) {
  event.stopPropagation();
  const span = event.currentTarget;
  const word = span.dataset.word;
  const inflections = span._inflections ?? [];
  const isParticle = span._isParticle ?? false;
  const isHonorificSuffix = span._isHonorificSuffix ?? false;
  const pos = span._pos ?? null;
  const conjugatedForm = span._conjugatedForm ?? null;
  const idiomWord = span._idiomWord ?? null;
  // Rebuilds a sentence split across consecutive cues, for the CARD only —
  // the on-screen line is untouched (2026-07-26, user's call). Falls back to
  // the displayed line whenever the merge is ambiguous. The clicked word's
  // recorded offset is shifted by however much the displayed line moved
  // within the merged string, so the <b> wrapping still lands exactly on the
  // word that was clicked (buildSentenceHtml verifies this and returns null
  // rather than guessing if it ever doesn't line up).
  const merged = buildMergedAnkiSentence(lastText);
  const sentenceHtml = buildSentenceHtml(
    merged ? merged.text : lastText,
    Number(span.dataset.startOffset) + (merged ? merged.offsetShift : 0),
    span.dataset.surface
  );
  // Captured synchronously at click time, same reasoning as sentenceHtml
  // above (2026-07-22) — lastCueEntry is module-scope and the video may
  // advance to a new line before the "+ Anki" button is actually clicked.
  // Bundles everything the audio slice needs, captured synchronously for the
  // same reason as the sentence above. `mergeStart`/`mergeEnd` are non-null
  // only when the sentence was merged, and widen the clip to cover the whole
  // merged span so the card's audio matches its sentence.
  const audioRequest = {
    entry: lastCueEntry,
    mergeStart: merged ? merged.mergeStart : null,
    mergeEnd: merged ? merged.mergeEnd : null,
  };
  // The same sentence/word the Anki fields are built from, kept as PLAIN text
  // rather than the escaped HTML that goes on the card (2026-07-30). Both the
  // capture-verification chip and the edit panel need to show it and, in the
  // panel's case, re-tokenize it — neither can work backwards from the HTML
  // reliably. Captured synchronously here for the same reason everything else
  // in this function is: the video has usually moved on by the time the
  // "+ Anki" button is actually pressed.
  const captureContext = {
    sentenceText: merged ? merged.text : lastText,
    wordStart: Number(span.dataset.startOffset) + (merged ? merged.offsetShift : 0),
    wordSurface: span.dataset.surface,
    // The English line for THIS sentence, snapshotted here with everything
    // else rather than read when the capture completes. The chip used to read
    // module-scope `lastEnglishText` at completion time — after the audio
    // wait, by which point the subtitle has usually moved on — so it showed
    // the NEXT line's translation, or a blank one when nothing followed
    // (reported live 2026-07-31, capturing おかしい). The Anki field was always
    // correct; only the chip was wrong, which is the worst place for it, since
    // checking the capture is the chip's entire job.
    translation: lastEnglishText ?? "",
  };
  // Show/episode opt-in field (2026-07-23) — captured the same way, though
  // in practice this one is stable for an entire episode's worth of clicks,
  // not just until the next line.
  const showEpisodeText = formatShowEpisode(currentShowEpisode);
  // English translation (2026-07-23) — captured the same way as the
  // Japanese sentence above, same reasoning: lastEnglishText is module-scope
  // and can change before the "+ Anki" button is actually clicked.
  //
  // Escaped and line-broken here (2026-07-26) rather than passed through as
  // raw text: Anki fields are HTML, so an apostrophe-free caption was fine
  // but one containing < or & rendered wrong or swallowed text, and a
  // two-line caption collapsed onto one line — the same fix, for the same
  // reason, as buildSentenceHtml's own. Preserving the caption's line breaks
  // also keeps Crunchyroll's own break positions on the card, which live
  // testing specifically confirmed as worth keeping.
  const translationText = lastEnglishText ? escapeHtml(lastEnglishText).replace(/\n/g, "<br>") : null;

  removeChip(); // a new lookup replaces whatever chip is currently showing
  closePopup();
  const popup = document.createElement("div");
  popup.id = "jp-immersion-popup";
  popup.textContent = "Looking up…";
  getContainer().appendChild(popup);
  positionPopup(popup, span);
  activePopup = popup;

  chrome.runtime.sendMessage({ type: "LOOKUP_WORD", word, isParticle, pos, isHonorificSuffix }, (response) => {
    if (!activePopup) return; // user already dismissed it
    if (!response || response.error) {
      popup.textContent = `Lookup failed: ${response?.error ?? "unknown error"}`;
      return;
    }
    if (!response.results.length) {
      // Kanji-containing proper nouns (character/place names) behave as
      // ordinary clickable words (decided 2026-07-04) — a missing JMdict
      // entry shows the normal "no dictionary entry" message like any other
      // word, not a silent close. Katakana-only invented names (ヒンメル,
      // アイゼン) never reach this branch at all: groupTokens' katakana-run
      // rule already makes the whole run inert (word: null, no click
      // handler) before a click is even possible.
      popup.textContent = `No dictionary entry for "${word}"`;
      return;
    }
    popup.innerHTML = "";

    // Wraps everything below in one toggleable unit — the chip-hover CSS
    // (content.css) shows/hides this whole div at once, so the popup can
    // later be converted into a chip (see chipifyPopup) without needing a
    // separately-designed mini view: hovering the chip re-reveals exactly
    // this same content, "+ Anki" button included.
    const body = document.createElement("div");
    body.className = "jp-immersion-popup-body";
    popup.appendChild(body);

    const inflectionText = describeInflection(inflections, pos, conjugatedForm, word);
    if (inflectionText) {
      const inflectionLine = document.createElement("div");
      inflectionLine.className = "jp-immersion-popup-inflection";
      inflectionLine.textContent = inflectionText;
      body.appendChild(inflectionLine);
    }

    renderEntries(body, word, response.results, sentenceHtml, response.showPos, response.showFreq, response.showJlpt, audioRequest, response.showSource, showEpisodeText, translationText, captureContext);

    // Marks this popup as eligible to become a chip once the next line rolls
    // in (see chipifyPopup) — only set once real content has actually
    // rendered, so a still-loading or error-state popup never gets chipped.
    popup._chipLabel = `${word}${response.results[0]?.r ? ` (${response.results[0].r})` : ""}`;

    // Dual-view: this word is also the start of a matched multi-word set
    // phrase (see tokenize-utils.js's isDualViewMatch) whose meaning isn't a
    // replacement for this word's own definition, just additional context —
    // e.g. もの keeps its own "thing" definition, with 物になる ("to prove
    // oneself") shown below as a set phrase it happens to also start.
    if (idiomWord) {
      chrome.runtime.sendMessage({ type: "LOOKUP_WORD", word: idiomWord }, (idiomResponse) => {
        if (!activePopup || activePopup !== popup) return;
        if (!idiomResponse || idiomResponse.error || !idiomResponse.results.length) return;
        const label = document.createElement("div");
        label.className = "jp-immersion-popup-inflection";
        label.textContent = `Also, as a set phrase: ${idiomWord}`;
        body.appendChild(label);
        renderEntries(body, idiomWord, idiomResponse.results, sentenceHtml, response.showPos, response.showFreq, response.showJlpt, audioRequest, response.showSource, showEpisodeText, translationText, captureContext);
      });
    }
  });
}

// Sense-level `misc` tags (checked ahead of reading-level ones, priority
// order) and reading-level tags that mark a headword's specific reading as
// old/irregular (same tag family as the kanji rK/sK rarity fix). Used only
// for the duplicate-gloss homograph fix below — a real, JMdict-sourced label
// is always preferred over silent demotion when one of these is present.
const ARCHAIC_MISC_LABELS = { arch: "archaic", obs: "obsolete", dated: "dated" };
const ARCHAIC_READING_TAGS = new Set(["ok", "ik"]);

// Yodan/Nidan conjugation-class POS codes (v4*/v2*) are pre-modern-only
// grammar — JMdict's own posTags map labels literally every one of them
// "(archaic)" (confirmed by inspecting the full map, not assumed from just
// v4r/v2r-s) — the same real signal as an explicit misc `arch` tag, just
// carried on `p` instead of `m`. Real entries exist with a v4/v2 code and NO
// explicit misc tag at all (confirmed: 捧ぐ/ささぐ, v2g-s, carries no `m`) —
// these previously fell through to silent demotion despite the POS chip
// itself already showing "(archaic)". Checked only as a FALLBACK, after the
// explicit m/ki checks, so an entry with its own real tag isn't overridden —
// one tag shown, sourced from whichever signal fired first.
function isArchaicVerbType(entry) {
  return entry.p?.some((p) => p.startsWith("v4") || p.startsWith("v2")) ?? false;
}

// Duplicate-gloss homographs (酒 → さけ vs 酒 → ささ, both "alcohol; sake"; 君
// → きみ vs 君 → きんじ, both "you") otherwise show as separate, equal-weight
// cards with no indication one is the rare/dated reading. Checked against the
// raw JMdict release per-case (2026-07-05), not assumed: real 酒/君 duplicates
// do carry `misc`/reading tags confirming this. Returns a real sourced label
// when the entry's own data has one; null means "duplicate, but nothing to
// cite" — the caller demotes it instead.
function archaicTagLabel(entry) {
  for (const code of entry.m ?? []) {
    if (ARCHAIC_MISC_LABELS[code]) return ARCHAIC_MISC_LABELS[code];
  }
  if (entry.ki?.some((t) => ARCHAIC_READING_TAGS.has(t))) return "dated reading";
  if (isArchaicVerbType(entry)) return "archaic";
  return null;
}

// True when `word` (the surface actually clicked/looked up) has no kanji of
// its own — the only case where showing an entry's kanji spelling(s) next to
// the header adds information rather than just repeating what's already
// visible in the ruby headword itself.
const NO_KANJI_RE = /^[^㐀-鿿]*$/;

function renderEntries(container, word, results, sentenceHtml, showPos, showFreq, showJlpt, audioRequest, showSource, showEpisodeText, translationText, captureContext) {
  // Falls back to just the bolded word alone when the exact-offset lookup in
  // buildSentenceHtml couldn't confirm a match (rare: only if lastText and
  // the span's own recorded surface/offset somehow disagree) — degrades to
  // less context rather than disabling capture entirely for that click.
  const effectiveSentenceHtml = sentenceHtml ?? `<b>${escapeHtml(word)}</b>`;
  const seenFirstGloss = new Set();
  for (const entry of results.slice(0, 3)) {
    const { r, g, si, p, c, k, fr, jlpt } = entry;

    // A later entry sharing its first gloss with one already shown above is
    // very likely the same core meaning under a rarer/alternate reading, not
    // a genuinely distinct sense worth equal billing — visually demote it
    // unless a real JMdict-sourced label explains why (checked below).
    // g is grouped by sense (array of arrays, since 2026-07-06) — g[0]?.[0]
    // is still the entry's first/primary gloss string.
    const firstGloss = g[0]?.[0];
    const isDuplicate = firstGloss !== undefined && seenFirstGloss.has(firstGloss);
    seenFirstGloss.add(firstGloss);
    // archaicTagLabel checked unconditionally, not just for duplicates
    // (2026-07-06 fix): a real archaic/dated/obsolete signal is worth
    // showing on ANY card, not only ones that happen to collide with an
    // earlier card's first gloss — confirmed real gap via live testing (呉る,
    // こかす/倒す both have their own distinct first gloss, so isDuplicate was
    // always false for them, and the verb-type-implied archaic signal never
    // got a chance to render at all despite their own POS chip already
    // reading "(archaic)"). Demotion, unlike the tag, still only applies to
    // genuine duplicates — an ordinary non-duplicate entry with no archaic
    // signal stays a normal, undemoted card.
    const tagLabel = archaicTagLabel(entry);
    const demoted = isDuplicate && !tagLabel;

    const cardEl = document.createElement("div");
    cardEl.className = demoted ? "jp-immersion-popup-entry jp-immersion-popup-entry-demoted" : "jp-immersion-popup-entry";

    const headerRow = document.createElement("div");
    headerRow.className = "jp-immersion-popup-header-row";
    headerRow.appendChild(buildHeadword(word, r));
    // Homograph cards reached via a kana-only lookup (いる → 居る/入る/要る)
    // otherwise show identical kana headers with no way to tell them apart
    // at a glance — show the entry's own kanji spelling(s) as extra context.
    // Skipped when `word` already has its own kanji (already visible in the
    // ruby headword itself, so this would just repeat it).
    if (k && k.length > 0 && NO_KANJI_RE.test(word)) {
      const kanjiSpan = document.createElement("span");
      kanjiSpan.className = "jp-immersion-popup-kanji-spelling";
      kanjiSpan.textContent = k.join("・");
      headerRow.appendChild(kanjiSpan);
    }
    // Frequency-rank badge (Phase 5, 2026-07-19) replaces the old binary
    // common-word flag entirely, per the 2026-07-04 decision — a graduated
    // 3-tier signal supersedes a boolean one, keeping both would just be
    // redundant UI. Gated behind the opt-in toggle like POS; no badge at all
    // when `fr` is absent (no TUBELEX data for this word) — absence of data
    // isn't evidence of rarity, so this deliberately does NOT default to
    // showing "rare".
    if (showFreq && fr) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-freq-badge";
      badge.textContent = fr;
      headerRow.appendChild(badge);
    }
    // JLPT-level badge (Phase 5, 2026-07-22) — same opt-in-toggle/no-badge-
    // without-data pattern as the frequency-rank badge above. Sourced from an
    // external, explicitly unofficial "educated guess" list (see
    // scripts/apply-jlpt-level.js) — absence of a tag isn't evidence the word
    // is off-list, just that this JMdict entry's id didn't match the source.
    if (showJlpt && jlpt) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-jlpt-badge";
      badge.textContent = jlpt;
      headerRow.appendChild(badge);
    }
    if (tagLabel) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-archaic-badge";
      badge.textContent = tagLabel;
      headerRow.appendChild(badge);
    }
    cardEl.appendChild(headerRow);

    // Gated behind the opt-in toggle (Phase 5, 2026-07-17) — this is the
    // ONLY thing the toggle controls; `p` (POS codes) is still read
    // unconditionally elsewhere in this function (formatPosChips itself,
    // for the Anki capture below, and archaicTagLabel's own internal
    // POS-based archaic-verb-type check above) — those aren't "showing POS
    // metadata" in the sense the toggle means, they're using the codes for
    // an unrelated correctness signal that has nothing to do with whether
    // the user opted in to seeing POS labels.
    let posChips = null;
    if (p && p.length > 0) {
      posChips = formatPosChips(p, word);
      if (showPos && posChips) {
        const posLine = document.createElement("div");
        posLine.className = "jp-immersion-popup-pos";
        posLine.textContent = posChips;
        cardEl.appendChild(posLine);
      }
    }

    // Numbered per-sense gloss list (2026-07-06) — g's sense boundaries
    // (added the same day, see jmdict-compact.json's generation script) let
    // each sense render as its own numbered row instead of one flattened,
    // unnumbered string. A single-sense entry still gets a bare "1." row for
    // visual consistency rather than special-casing it away.
    const glossList = document.createElement("div");
    glossList.className = "jp-immersion-popup-gloss-list";
    g.forEach((senseGlosses, i) => {
      const row = document.createElement("div");
      row.className = "jp-immersion-popup-gloss-row";
      const number = document.createElement("span");
      number.className = "jp-immersion-popup-gloss-number";
      number.textContent = `${i + 1}.`;
      const text = document.createElement("span");
      text.className = "jp-immersion-popup-gloss";
      text.textContent = senseGlosses.join("; ");
      // JMdict's s_inf annotation for this sense (2026-07-15) — e.g. よ's
      // first sense is just "hey; you" without it, giving no indication
      // it's the sentence-final particle used for certainty/emphasis/
      // contempt/etc. Appended as a child node of the gloss span (not a new
      // flex sibling in the row) so a long note wraps as ordinary inline
      // text alongside the gloss instead of as its own layout box.
      const note = si?.[i];
      if (note) {
        const noteSpan = document.createElement("span");
        noteSpan.className = "jp-immersion-popup-gloss-note";
        noteSpan.textContent = ` (${note})`;
        text.appendChild(noteSpan);
      }
      row.appendChild(number);
      row.appendChild(text);
      glossList.appendChild(row);
    });
    cardEl.appendChild(glossList);

    // Add to Anki (Phase 5, 2026-07-17) — per-card, not once per popup, so a
    // homograph with multiple cards shown lets the user pick exactly which
    // reading/sense actually matches what they saw. Instant send on click
    // (no separate confirm step, per the 2026-07-02 capture-UX decision);
    // success replaces the button with an inline "Added to Anki" + Undo
    // (calls AnkiConnect's deleteNotes with the returned note ID) rather than
    // a separate toast component — the popup card IS already the transient,
    // dismissible surface a toast would otherwise be, so a second one would
    // be redundant. "Edit last card" from the original build-order item is
    // NOT built here — deferred as a smaller follow-up, see project-plan.md.
    const ankiRow = document.createElement("div");
    ankiRow.className = "jp-immersion-popup-anki-row";
    const ankiBtn = document.createElement("button");
    ankiBtn.className = "jp-immersion-popup-anki-btn";
    ankiBtn.textContent = "+ Anki";
    ankiBtn.addEventListener("click", async () => {
      ankiBtn.disabled = true;
      ankiBtn.textContent = "Adding…";
      // Waits for the cue to actually finish before slicing, not just
      // "whatever's played so far" — fixes a real bug caught via live
      // testing (2026-07-22): clicking before the line ended produced a clip
      // cut off mid-sentence.
      //
      // **Started here but NOT awaited (2026-07-31).** The card is written to
      // Anki straight away and the audio field is filled in afterwards, in a
      // second call. Awaiting it meant the whole capture — the button, the
      // verification chip, everything — sat pending until the line finished,
      // which for a sentence split across two cues means waiting out the
      // SECOND half: the multi-second delay reported in the live pass. It also
      // forced the wait to be short, so a capture that timed out silently
      // wrote first-half-only audio; with nothing blocked on it the wait can
      // now be generous instead (see sliceClipWavWhenReady's own maxWaitMs).
      // The video keeps playing throughout either way — nothing is paused or
      // interrupted, matching the "keep watching" positioning that ruled out
      // rewind-and-recapture in the first place.
      const audioPending = sliceClipWavWhenReady(
        audioRequest.entry,
        undefined,
        audioRequest.mergeStart,
        audioRequest.mergeEnd
      );
      chrome.runtime.sendMessage(
        {
          type: "ADD_ANKI_NOTE",
          word,
          reading: r,
          gloss: formatGlossForAnki(g),
          sentenceHtml: effectiveSentenceHtml,
          // Only sent when the user has actually opted in — matches the
          // popup's own display exactly (same `posChips` string, not
          // separately recomputed), so the card can never show POS info the
          // in-page popup itself didn't also show for this same capture.
          pos: showPos ? posChips : null,
          // Same pattern as `pos` above (2026-07-19) — matches the badge
          // text exactly (`fr`, e.g. "common"), only sent when the toggle is
          // on and the entry actually has a tier.
          frequency: showFreq && fr ? fr : null,
          // Same pattern again (2026-07-22) — matches the JLPT badge exactly.
          jlpt: showJlpt && jlpt ? jlpt : null,
          // Always null on this call as of 2026-07-31 — the clip is still
          // being waited for. It arrives in the follow-up update below, and
          // stays absent entirely when capture was never available
          // (DRM/browser-policy failure), the player was muted, or the clip
          // aged out of the ring buffer: the same silent-degrade pattern as a
          // missing frequency/JLPT tag.
          audio: null,
          // Show/episode opt-in field (2026-07-23) — no popup badge (unlike
          // POS/frequency/JLPT), since "which episode is this" is redundant
          // in-context while already watching that exact episode; only
          // relevant later, reviewing the card out of context.
          source: showSource && showEpisodeText ? showEpisodeText : null,
          // English translation (2026-07-23) — not opt-in-toggle-gated
          // (unlike Source), same as Sentence/Gloss: one of the originally
          // deferred core fields, not a metadata add-on. Null whenever no
          // English cue was captured for this moment (Crunchyroll caption
          // fetch still pending, failed, or this word was clicked during a
          // gap between English lines).
          translation: translationText,
        },
        (response) => {
          if (!response || response.error) {
            ankiBtn.textContent = "Failed — retry";
            ankiBtn.title = response?.error ?? "Unknown error";
            ankiBtn.disabled = false;
            return;
          }
          const noteId = response.result;
          // Becomes the target of the persistent "Edit last card" control
          // (2026-07-29). Recorded here rather than where the button lives, so
          // it's set exactly when a card really exists in Anki.
          lastAddedNote = { id: noteId, label: word };
          refreshEditLastCardControl();
          // The retained PCM buffer (audio-capture.js) always holds the MOST
          // RECENT capture, so it only belongs to this note until the next one
          // is made. Recording which note it matches is what lets the edit
          // panel offer audio trimming for that note and degrade cleanly for
          // any older one, instead of silently editing the wrong clip.
          audioBufferNoteId = noteId;
          // Second phase: the clip lands on the card whenever it's ready
          // (2026-07-31). Deliberately fire-and-forget — the card already
          // exists and is already correct in every other field, so a failure
          // here means a card with no audio, which is the same degrade path a
          // muted player already takes. Skipped entirely if the note has since
          // been undone, so Undo can't be followed by a write that resurrects
          // an audio field on a deleted note.
          audioPending.then((audio) => {
            if (!audio || forgottenNotes.has(noteId)) return;
            chrome.runtime.sendMessage(
              { type: "UPDATE_ANKI_NOTE", noteId, fields: {}, audio, previousAudioFilename: null },
              (updateResponse) => {
                if (!updateResponse || updateResponse.error) {
                  console.warn(
                    "[jp-immersion] card added, but its audio couldn't be attached:",
                    updateResponse?.error ?? "no response from background"
                  );
                }
              }
            );
          });
          noteCaptureComplete(cardEl.closest("#jp-immersion-popup") ?? activePopup ?? activeChip, {
            noteId,
            word,
            reading: r,
            gloss: g.map((senseGlosses) => senseGlosses.join("; ")).join(" / "),
            sentenceText: captureContext?.sentenceText ?? "",
            wordStart: captureContext?.wordStart ?? -1,
            wordSurface: captureContext?.wordSurface ?? word,
            translation: captureContext?.translation ?? "",
          });
          ankiRow.textContent = "";
          const doneLabel = document.createElement("span");
          doneLabel.className = "jp-immersion-popup-anki-done";
          doneLabel.textContent = "Added to Anki";
          // Edit is offered here as well as in the persistent control because
          // this is the moment the user is most likely to want it — they're
          // looking at what they just captured. The persistent one exists
          // because this popup becomes a chip on the next subtitle line, i.e.
          // within a second or two, which is long gone by the time anyone
          // notices a card needs fixing.
          const editBtn = document.createElement("button");
          editBtn.className = "jp-immersion-popup-anki-edit";
          editBtn.textContent = "Edit";
          editBtn.title = "Opens this card in Anki's own editor";
          editBtn.addEventListener("click", () => openEditPanel(noteId));
          const undoBtn = document.createElement("button");
          undoBtn.className = "jp-immersion-popup-anki-undo";
          undoBtn.textContent = "Undo";
          undoBtn.addEventListener("click", () => {
            undoBtn.disabled = true;
            chrome.runtime.sendMessage({ type: "DELETE_ANKI_NOTE", noteId }, (delResponse) => {
              if (!delResponse || delResponse.error) {
                undoBtn.disabled = false;
                undoBtn.title = delResponse?.error ?? "Undo failed";
                return;
              }
              doneLabel.textContent = "Removed from Anki";
              undoBtn.remove();
              // The note no longer exists, so neither Edit surface may keep
              // pointing at it.
              editBtn.remove();
              forgetAddedNote(noteId);
            });
          });
          ankiRow.appendChild(doneLabel);
          ankiRow.appendChild(editBtn);
          ankiRow.appendChild(undoBtn);
        }
      );
    });
    ankiRow.appendChild(ankiBtn);
    cardEl.appendChild(ankiRow);

    container.appendChild(cardEl);
  }
}

// `word` is the dictionary form sent to the lookup (e.g. 分かる, or a numeral
// glyph run like "23"), `reading` is that specific entry's kana reading (e.g.
// わかる, にじゅうさん). If they're identical there's nothing to annotate, so
// it's shown as plain reading text — otherwise it's rendered as furigana over
// the whole word, matching the <ruby>word<rt>reading</rt></ruby> format. Keyed
// on word !== reading directly rather than "does word contain kanji": that
// was only ever a proxy for the same check (kanji headwords always differ
// from their kana reading) — a numeral glyph run (23 → にじゅうさん) needs the
// same ruby treatment despite having no kanji at all.
function buildHeadword(word, reading) {
  if (word === reading) {
    const span = document.createElement("span");
    span.className = "jp-immersion-popup-reading";
    span.textContent = reading;
    return span;
  }

  const ruby = document.createElement("ruby");
  ruby.className = "jp-immersion-popup-reading";
  ruby.appendChild(document.createTextNode(word));
  const rt = document.createElement("rt");
  rt.textContent = reading;
  ruby.appendChild(rt);
  return ruby;
}

function positionPopup(popup, anchor) {
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 8}px`;
}

function closePopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}

// "Last looked-up word" chip (Phase 5, 2026-07-22) — the popup still
// auto-dismisses the instant the next subtitle line rolls in (unchanged,
// keeps the next line readable), but if it had already finished loading real
// content, it gets converted into a small persistent chip instead of just
// discarded, giving the user a few more seconds to still act on it. Reuses
// the SAME popup DOM element/listeners rather than building a separate chip
// component — reading (hover) and committing (the "+ Anki" button already
// inside it) stay the same interaction, not two.
let activeChip = null;
let chipTimer = null;
let chipRepositionHandler = null;
const CHIP_LIFETIME_MS = 15000; // ~15s, per the 2026-07-22 decision

// Called from renderCue right before a new cue's text takes over. Only ever
// converts a popup that actually finished loading real entries (`_chipLabel`
// is set once renderEntries has run, see onWordClick) — a still-loading
// "Looking up…" or a "No dictionary entry" popup just closes normally, same
// as before this feature existed.
function chipifyPopup() {
  if (!activePopup || !activePopup._chipLabel) {
    closePopup();
    return;
  }
  const captured = activePopup._captureInfo;
  const chip = activePopup;
  activePopup = null; // ownership transfers to the chip; no longer "the" active popup
  if (captured) {
    // This lookup was actually captured, so the chip's job is verification, not
    // just holding the definition — see showCaptureChip.
    showCaptureChip(captured);
    chip.remove();
    return;
  }
  chip.classList.add("jp-immersion-popup-chip");
  const label = document.createElement("div");
  label.className = "jp-immersion-popup-chip-label";
  label.textContent = chip._chipLabel;
  chip.insertBefore(label, chip.firstChild);
  mountChip(chip);
}

// Shared chip lifecycle: single-slot, positioned against the video, re-parented
// on fullscreen toggle, and removed after CHIP_LIFETIME_MS. Factored out
// (2026-07-30) so the capture-verification chip below gets exactly the same
// lifecycle as the lookup chip rather than a parallel one.
//
// Re-parents into the current fullscreen element (or back to body) on every
// toggle, not just repositions — confirmed real bug via live testing
// (2026-07-22): the Fullscreen API only renders elements inside whichever
// element is currently fullscreen, so a chip created before entering fullscreen
// (parented to body) simply stops rendering once fullscreen starts, even though
// it's still alive in the DOM.
function mountChip(chip) {
  removeChip(); // single-slot — a new chip always replaces whatever's showing
  getContainer().appendChild(chip);
  positionChip(chip);
  activeChip = chip;
  chipRepositionHandler = () => {
    getContainer().appendChild(chip);
    positionChip(chip);
  };
  window.addEventListener("resize", chipRepositionHandler);
  document.addEventListener("fullscreenchange", chipRepositionHandler);
  chipTimer = setTimeout(removeChip, CHIP_LIFETIME_MS);
}

// ── Capture-verification chip (2026-07-30) ──────────────────────────────────
//
// A card's content is worth a glance right after capture — segmentation, sense
// selection, JP/EN desync and split-sentence merge glitches are the project's
// four known bug categories, and all four are visible in the captured Sentence,
// Word/Reading/Gloss and Translation.
//
// The POPUP was evaluated for this job and rejected on three counts: its layout
// is built for dictionary lookup, not a sentence-level summary; its
// "Adding…" → "Added to Anki" transition was gated on audio-capture completion
// rather than subtitle timing, so it was often still pending when the subtitle
// line changed; and some lines (single-word ones especially) simply aren't on
// screen long enough for any popup-based verification window to be reliable.
// The chip's lifetime is already decoupled from the subtitle line's, which
// solves the third for free.
//
// The second reason no longer exists as of 2026-07-31: the Anki send is now
// two-phase, so nothing waits on audio capture, and this chip appears the
// moment the card is WRITTEN rather than when its clip lands. The rejection
// stands on the other two counts, and the chip's content is unaffected either
// way — it shows no audio, so the clip arriving later changes nothing it
// displays.
//
// Deliberately shows JP sentence + highlighted word + reading + gloss + EN
// only. POS/Frequency/JLPT/Source are excluded: they're deterministic outputs
// of a correct Word/Gloss selection and are rarely independently wrong, so
// including them would spend a short, limited glance on low-value checking.
// That also keeps this view independent of the real Anki card face, which is
// expected to be redesigned in Phase 6.
// Retuned 2026-07-31 after the first live pass: a long merged sentence didn't
// stay up long enough to read, while a single-word capture was not reported as
// lingering — so the per-character term and the cap both rise and the base is
// left near where it was. The cap stays below CHIP_LIFETIME_MS by a few
// seconds, since an expanded duration at or above the chip's own lifetime would
// mean the collapsed state never actually appeared.
const CHIP_EXPANDED_BASE_MS = 2400;
const CHIP_EXPANDED_PER_CHAR_MS = 110;
const CHIP_EXPANDED_MAX_MS = 12000;

// Scales with how much there is to read rather than using one fixed timer: a
// single-word capture needs a fraction of the window a long merged sentence
// does, and a duration that suits one badly misfits the other. The curve itself
// is provisional and flagged for tuning during live-testing — see
// project-plan.md Open Questions.
function chipExpandedMs(info) {
  const chars = (info.sentenceText?.length ?? 0) + (info.translation?.length ?? 0) / 2;
  return Math.min(CHIP_EXPANDED_MAX_MS, CHIP_EXPANDED_BASE_MS + chars * CHIP_EXPANDED_PER_CHAR_MS);
}

// Records that a capture finished, on whichever element currently represents
// that lookup. Handles both orderings, which is the whole point: if the popup
// is still open, the info rides along and chipifyPopup builds a verification
// chip when the line changes; if the subtitle already moved on and the popup is
// now a plain lookup chip, that chip is upgraded in place — the case the old
// popup-based approach couldn't cover at all.
function noteCaptureComplete(el, info) {
  if (el) el._captureInfo = info;
  if (el && el === activeChip) showCaptureChip(info);
}

function showCaptureChip(info) {
  const chip = document.createElement("div");
  chip.id = "jp-immersion-capture-chip";

  const label = document.createElement("div");
  label.className = "jp-immersion-capture-chip-label";
  label.textContent = info.reading && info.reading !== info.word ? `${info.word} (${info.reading})` : info.word;

  const body = document.createElement("div");
  body.className = "jp-immersion-capture-chip-body";

  const sentence = document.createElement("div");
  sentence.className = "jp-immersion-capture-chip-sentence";
  appendSentenceWithHighlight(sentence, info.sentenceText, info.wordStart, info.wordSurface);
  body.appendChild(sentence);

  if (info.gloss) {
    const gloss = document.createElement("div");
    gloss.className = "jp-immersion-capture-chip-gloss";
    gloss.textContent = info.gloss;
    body.appendChild(gloss);
  }

  if (info.translation) {
    const translation = document.createElement("div");
    translation.className = "jp-immersion-capture-chip-translation";
    translation.textContent = info.translation;
    body.appendChild(translation);
  }

  const row = document.createElement("div");
  row.className = "jp-immersion-capture-chip-actions";
  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => openEditPanel(info.noteId));
  const undoBtn = document.createElement("button");
  undoBtn.className = "jp-immersion-capture-chip-undo";
  undoBtn.textContent = "Undo";
  // Undo stays available for the chip's whole life, in both states: the note is
  // already fully written to Anki by the time this chip exists, so removing it
  // is exactly as valid at second 14 as at second 1.
  undoBtn.addEventListener("click", () => {
    undoBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "DELETE_ANKI_NOTE", noteId: info.noteId }, (delResponse) => {
      if (!delResponse || delResponse.error) {
        undoBtn.disabled = false;
        undoBtn.title = delResponse?.error ?? "Undo failed";
        return;
      }
      forgetAddedNote(info.noteId);
      removeChip();
    });
  });
  row.append(editBtn, undoBtn);
  body.appendChild(row);

  chip.append(label, body);
  mountChip(chip);

  // State 1 → State 2. Hover re-expansion is CSS-only (see content.css): the
  // rest of this UI shows and hides instantly too, and a morph animation was
  // explicitly deferred to Phase 6's visual pass rather than built one-off here.
  const collapse = setTimeout(() => chip.classList.add("jp-immersion-capture-chip-collapsed"), chipExpandedMs(info));
  chip._onRemove = () => clearTimeout(collapse);
}

// Renders `text` with the captured word marked, using the recorded OFFSET
// rather than a substring search — the same reasoning buildSentenceHtml uses:
// the identical word can appear twice in one sentence and only one of them is
// the one that was clicked. Falls back to plain text if the offset doesn't line
// up, rather than highlighting the wrong occurrence.
function appendSentenceWithHighlight(container, text, wordStart, wordSurface) {
  if (!text) return;
  const end = wordStart + (wordSurface?.length ?? 0);
  const usable =
    Number.isInteger(wordStart) && wordStart >= 0 && end <= text.length && text.slice(wordStart, end) === wordSurface;
  if (!usable) {
    container.textContent = text;
    return;
  }
  container.appendChild(document.createTextNode(text.slice(0, wordStart)));
  const mark = document.createElement("b");
  mark.textContent = wordSurface;
  container.appendChild(mark);
  container.appendChild(document.createTextNode(text.slice(end)));
}

function removeChip() {
  if (chipTimer) {
    clearTimeout(chipTimer);
    chipTimer = null;
  }
  if (chipRepositionHandler) {
    window.removeEventListener("resize", chipRepositionHandler);
    document.removeEventListener("fullscreenchange", chipRepositionHandler);
    chipRepositionHandler = null;
  }
  if (activeChip) {
    if (activeChip._onRemove) activeChip._onRemove();
    activeChip.remove();
    activeChip = null;
  }
}

// Anchored to the <video> element's own current bounding rect (bottom-right
// corner), not a fixed viewport coordinate computed once — recomputed on
// resize/fullscreenchange while the chip is alive (see chipifyPopup), so it
// can't end up drifting over unrelated page content the way the old
// empty-subtitle-box bug did (2026-07-17, see project-plan.md).
function positionChip(chip) {
  if (!video) return;
  const rect = video.getBoundingClientRect();
  chip.style.left = "";
  chip.style.right = `${window.innerWidth - rect.right + 8}px`;
  chip.style.bottom = `${window.innerHeight - rect.bottom + 8}px`;
}

// ── In-page edit panel (2026-07-30) ─────────────────────────────────────────
//
// Replaces the 2026-07-29 build, which opened Anki's own note editor as the
// PRIMARY action. That was a hand-off rather than an edit: it required leaving
// Crunchyroll for the Anki desktop app, which fails the "capture and keep
// watching" litmus test exactly the way any other playback interruption does.
// AnkiConnect's `notesInfo`/`updateNoteFields` need neither Anki's window
// focused nor visible, so the same edits can happen here without the
// interruption. "Open in Anki" survives as a secondary escape hatch, scoped to
// what this panel deliberately doesn't cover — tags, note type, deletion.
let editPanel = null;
let editState = null;
// Which note the retained PCM buffer (audio-capture.js) belongs to. The buffer
// always holds the most recent capture, so editing any older note must degrade
// to "audio unavailable" rather than silently trimming a different clip.
let audioBufferNoteId = null;

function ankiHtmlToPlain(html) {
  if (!html) return "";
  const el = document.createElement("div");
  el.innerHTML = String(html).replace(/<br\s*\/?>/gi, "\n");
  return el.textContent ?? "";
}

function plainToAnkiHtml(text) {
  return escapeHtml(text ?? "").replace(/\n/g, "<br>");
}

// Recovers the plain sentence plus where the bolded target word sits in it, so
// the panel can re-tokenize the sentence and mark the current word without
// re-deriving either from the HTML every time it needs them.
function parseStoredSentence(html) {
  const text = ankiHtmlToPlain(html);
  const m = String(html ?? "").match(/<b>([\s\S]*?)<\/b>/i);
  if (!m) return { text, wordStart: -1, wordSurface: "" };
  return { text, wordStart: ankiHtmlToPlain(String(html).slice(0, m.index)).length, wordSurface: ankiHtmlToPlain(m[1]) };
}

// Rebuilds the Sentence field's HTML with `surface` marked as the target word.
//
// **Markup only — this never edits the sentence itself.** `preferredStart` is
// the offset the caller believes the word sits at, and it is VERIFIED against
// the text before use rather than trusted: an offset that doesn't actually
// spell `surface` is a stale offset, and splicing at it corrupts the sentence
// instead of bolding it. That was a real bug (reported live 2026-07-31):
// changing the target word reused the OLD word's offset with the NEW word's
// length, so どうやら うまくいったみたいだね targeting どうやら, re-pointed at
// うまく, was rewritten as うまくら うまくいったみたいだね — the first three
// characters overwritten mid-word. Every path now falls back to locating the
// word by search, and to no bolding at all if it isn't in the sentence, so the
// worst case is a card that's merely unbolded rather than one whose Japanese
// has been mangled.
function buildEditedSentenceHtml(text, surface, preferredStart) {
  if (!surface) return plainToAnkiHtml(text);
  const spelledAt = (i) => i >= 0 && text.slice(i, i + surface.length) === surface;
  const start = spelledAt(preferredStart) ? preferredStart : text.indexOf(surface);
  if (!spelledAt(start)) return plainToAnkiHtml(text);
  return (
    plainToAnkiHtml(text.slice(0, start)) +
    "<b>" + plainToAnkiHtml(surface) + "</b>" +
    plainToAnkiHtml(text.slice(start + surface.length))
  );
}

function parseSoundFilename(audioField) {
  const m = String(audioField ?? "").match(/\[sound:([^\]]+)\]/);
  return m ? m[1] : null;
}

function closeEditPanel() {
  // Closing the panel silences any preview still playing — otherwise a clip
  // started just before Close carries on over the episode with no surface left
  // to stop it from (reported live 2026-07-31).
  stopPreview();
  if (editPanel) {
    if (editPanel._cleanup) editPanel._cleanup();
    editPanel.remove();
    editPanel = null;
  }
  editState = null;
}

function openEditPanel(noteId) {
  closeEditPanel();
  const panel = document.createElement("div");
  panel.id = "jp-immersion-edit-panel";
  panel.textContent = "Loading card…";
  getContainer().appendChild(panel);
  editPanel = panel;
  // Re-parented on fullscreen toggle for the same reason every other floating
  // element here is (2026-07-22): the Fullscreen API only renders elements
  // inside the fullscreen element.
  const reparent = () => getContainer().appendChild(panel);
  document.addEventListener("fullscreenchange", reparent);

  // Keyboard events from inside the panel are stopped before anything else can
  // act on them (2026-07-31). Crunchyroll binds its own player shortcuts at the
  // page level, so typing a space into the sentence box paused the video and
  // typing "m" muted it — the text never arrived and the episode reacted
  // instead. Capture phase on `window` is what makes this work: it runs before
  // any listener bound further down the tree, in either world. Unlike the
  // failed `history.pushState` override (Phase 4.5), this genuinely crosses the
  // isolated/main-world boundary, because it's one shared DOM event dispatch
  // rather than a function reference each world holds its own copy of.
  //
  // `stopPropagation` only — never `preventDefault`, which would stop the
  // character being typed at all. It also deliberately covers this extension's
  // OWN Alt+arrow offset hotkeys: while the panel has focus, keys belong to the
  // panel.
  const swallowKeys = (event) => {
    if (panel.contains(event.target)) event.stopPropagation();
  };
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(type, swallowKeys, true);
  }

  panel._cleanup = () => {
    document.removeEventListener("fullscreenchange", reparent);
    for (const type of ["keydown", "keyup", "keypress"]) {
      window.removeEventListener(type, swallowKeys, true);
    }
  };

  // Always read the note back fresh rather than trusting anything cached from
  // capture: it may have been hand-edited in Anki since, and overwriting those
  // edits with a stale copy would be data loss the user never asked for.
  chrome.runtime.sendMessage({ type: "ANKI_NOTE_INFO", noteId }, (response) => {
    if (editPanel !== panel) return; // panel was closed or replaced while loading
    if (!response || response.error) {
      renderEditPanelError(panel, response?.error ?? "Couldn't reach Anki.", noteId);
      return;
    }
    if (!response.note) {
      // Explicitly distinguished from a failure: the note is gone, and retrying
      // will never help, so the panel must not offer a retry that can't work.
      renderEditPanelError(panel, "That card no longer exists in Anki — it may have been deleted.", noteId, false);
      forgetAddedNote(noteId);
      return;
    }
    renderEditPanel(panel, noteId, response.note);
  });
}

function renderEditPanelError(panel, message, noteId, retryable = true) {
  panel.textContent = "";
  const msg = document.createElement("div");
  msg.className = "jp-immersion-edit-error";
  msg.textContent = message;
  const row = document.createElement("div");
  row.className = "jp-immersion-edit-actions";
  if (retryable) {
    const retry = document.createElement("button");
    retry.textContent = "Retry";
    retry.addEventListener("click", () => openEditPanel(noteId));
    row.appendChild(retry);
  }
  const close = document.createElement("button");
  close.textContent = "Close";
  close.addEventListener("click", closeEditPanel);
  row.appendChild(close);
  panel.append(msg, row);
}

function renderEditPanel(panel, noteId, note) {
  const fields = note.fields;
  const stored = parseStoredSentence(fields.Sentence);
  editState = {
    noteId,
    original: fields,
    storedSentence: stored,
    // Pending word selection from "Change word", or null while the captured one
    // stands. Holds all five derived fields together — see the cascade below.
    pendingWord: null,
    audio: null, // { start, end } in retained-buffer seconds, once trimmed
    previousAudioFilename: parseSoundFilename(fields.Audio),
  };

  panel.textContent = "";
  const header = document.createElement("div");
  header.className = "jp-immersion-edit-header";
  header.textContent = "Edit card";
  const closeX = document.createElement("button");
  closeX.className = "jp-immersion-edit-close";
  closeX.textContent = "✕";
  closeX.addEventListener("click", closeEditPanel);
  header.appendChild(closeX);
  panel.appendChild(header);

  const status = document.createElement("div");
  status.className = "jp-immersion-edit-status";
  panel.appendChild(status);

  // — Word / Reading / Gloss: never free text ——————————————————————————
  // These three are cascade-derived from ONE dictionary-entry selection made at
  // capture time, and POS/Frequency/JLPT hang off that same selection. Editing
  // them as independent text boxes would let them drift out of sync with each
  // other and with the three fields below, producing a card whose reading
  // doesn't belong to its word or whose frequency describes a different entry.
  // So changing them means re-picking an entry, through the same
  // tokenize → lookup UI used at capture, and the pick cascades all five
  // together.
  const wordSection = document.createElement("div");
  wordSection.className = "jp-immersion-edit-section";
  const wordSummary = document.createElement("div");
  wordSummary.className = "jp-immersion-edit-word-summary";
  const changeBtn = document.createElement("button");
  changeBtn.textContent = "Change word";
  const picker = document.createElement("div");
  picker.className = "jp-immersion-edit-picker";
  picker.style.display = "none";
  changeBtn.addEventListener("click", () => {
    const showing = picker.style.display !== "none";
    picker.style.display = showing ? "none" : "";
    changeBtn.textContent = showing ? "Change word" : "Cancel change";
    // Segments whatever the sentence box says RIGHT NOW, not the stored
    // sentence: picking a word out of a sentence the user has since edited
    // would record an offset into text that no longer exists.
    if (!showing) openWordPicker(picker, refreshDerived, sentenceInput.value);
  });
  wordSection.append(labelled("Word", wordSummary), changeBtn, picker);
  panel.appendChild(wordSection);

  // — Read-only derived fields ————————————————————————————————————————
  // Deterministic outputs of the dictionary entry and the episode metadata, not
  // independently authored at capture. Letting them be typed would allow a card
  // whose POS or frequency contradicts the very word/gloss it describes. They
  // display live and move only as a side effect of a new selection above.
  const derived = document.createElement("div");
  derived.className = "jp-immersion-edit-derived";
  panel.appendChild(derived);

  // — Freely editable text ————————————————————————————————————————————
  const sentenceInput = document.createElement("textarea");
  sentenceInput.className = "jp-immersion-edit-textarea";
  sentenceInput.value = stored.text;
  sentenceInput.addEventListener("input", updateDirty);
  panel.appendChild(labelled("Sentence (Japanese)", sentenceInput));

  const translationInput = document.createElement("textarea");
  translationInput.className = "jp-immersion-edit-textarea";
  translationInput.value = ankiHtmlToPlain(fields.Translation);
  translationInput.addEventListener("input", updateDirty);
  panel.appendChild(labelled("Translation (English)", translationInput));

  // — Audio ————————————————————————————————————————————————————————————
  const audioSection = document.createElement("div");
  audioSection.className = "jp-immersion-edit-section";
  panel.appendChild(labelled("Audio", audioSection));
  buildAudioEditor(audioSection, noteId, updateDirty);

  // — Footer ———————————————————————————————————————————————————————————
  const actions = document.createElement("div");
  actions.className = "jp-immersion-edit-actions";
  const openInAnki = document.createElement("button");
  openInAnki.className = "jp-immersion-edit-secondary";
  openInAnki.textContent = "Open in Anki";
  openInAnki.title = "For tags, note type or deleting the card — things this panel doesn't cover";
  openInAnki.addEventListener("click", () => openAnkiNoteInEditor(noteId, openInAnki, "Open in Anki"));
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeEditPanel);
  const save = document.createElement("button");
  save.className = "jp-immersion-edit-save";
  save.textContent = "Save";
  save.disabled = true;
  save.addEventListener("click", () => saveEditPanel(save, status, sentenceInput, translationInput));
  actions.append(openInAnki, cancel, save);
  panel.appendChild(actions);

  refreshDerived();

  function labelled(text, control) {
    const wrap = document.createElement("label");
    wrap.className = "jp-immersion-edit-field";
    const lbl = document.createElement("span");
    lbl.className = "jp-immersion-edit-label";
    lbl.textContent = text;
    wrap.append(lbl, control);
    return wrap;
  }

  // Redraws the word summary and the four read-only rows from whichever
  // selection currently stands — the captured one, or a pending replacement.
  function refreshDerived() {
    const p = editState.pendingWord;
    const word = p ? p.word : fields.Word;
    const reading = p ? p.reading : fields.Reading;
    const gloss = p ? p.gloss : ankiHtmlToPlain(fields.Gloss);
    wordSummary.textContent = `${word}${reading && reading !== word ? ` (${reading})` : ""} — ${gloss}`;
    derived.textContent = "";
    const rows = [
      ["Part of speech", p ? p.pos : ankiHtmlToPlain(fields.POS)],
      ["Frequency", p ? p.frequency : fields.Frequency],
      ["JLPT", p ? p.jlpt : fields.JLPT],
      ["Source", ankiHtmlToPlain(fields.Source)],
    ];
    for (const [name, value] of rows) {
      const row = document.createElement("div");
      row.className = "jp-immersion-edit-derived-row";
      const k = document.createElement("span");
      k.className = "jp-immersion-edit-label";
      k.textContent = name;
      const v = document.createElement("span");
      v.textContent = value || "—";
      row.append(k, v);
      derived.appendChild(row);
    }
    if (p) {
      picker.style.display = "none";
      changeBtn.textContent = "Change word";
    }
    updateDirty();
  }

  // Save stays disabled until something has actually changed, so the panel can
  // never fire a pointless write.
  function updateDirty() {
    const dirty =
      editState.pendingWord !== null ||
      editState.audio !== null ||
      sentenceInput.value !== stored.text ||
      translationInput.value !== ankiHtmlToPlain(fields.Translation);
    save.disabled = !dirty;
  }
}

// Renders the stored sentence as clickable tokens with the current target word
// marked, using the SAME pipeline the subtitle line uses (buildGroupsForText),
// so a word is segmented here exactly as it was at capture. Picking a token
// opens its senses; picking a sense cascades all five derived fields at once.
function openWordPicker(picker, onPicked, currentText = null) {
  picker.textContent = "Segmenting…";
  const { wordStart: storedStart, wordSurface } = editState.storedSentence;
  const text = currentText ?? editState.storedSentence.text;
  // The recorded offset describes the STORED sentence. Once that sentence has
  // been edited it no longer points anywhere meaningful, so the "currently
  // targeting" marker is simply not drawn rather than drawn on whatever token
  // now happens to sit at that position.
  const wordStart = text === editState.storedSentence.text ? storedStart : -1;
  if (!tokenizer) {
    picker.textContent = "Word segmentation isn't available right now.";
    return;
  }
  buildGroupsForText(text).then((groups) => {
    if (!editState) return;
    picker.textContent = "";
    const line = document.createElement("div");
    line.className = "jp-immersion-edit-picker-line";
    const senses = document.createElement("div");
    senses.className = "jp-immersion-edit-picker-senses";
    let offset = 0;
    for (const group of groups) {
      const start = offset;
      offset += group.surface.length;
      if (group.word === null) {
        line.appendChild(document.createTextNode(group.surface));
        continue;
      }
      const span = document.createElement("span");
      span.className = "jp-immersion-word";
      span.textContent = group.surface;
      // Marks whichever token covers the captured word's recorded position —
      // by offset, not by matching text, since the same word can occur twice.
      if (wordStart >= 0 && start <= wordStart && start + group.surface.length > wordStart) {
        span.classList.add("jp-immersion-edit-picker-current");
      }
      span.addEventListener("click", () => showSensesFor(group, senses, onPicked, start));
      line.appendChild(span);
    }
    picker.append(line, senses);
    const hint = document.createElement("div");
    hint.className = "jp-immersion-edit-hint";
    hint.textContent = wordSurface
      ? `Click a word to change the card's target — currently “${wordSurface}”.`
      : "Click a word to set the card's target.";
    picker.insertBefore(hint, line);
  });
}

function showSensesFor(group, container, onPicked, start = -1) {
  container.textContent = "Looking up…";
  chrome.runtime.sendMessage(
    {
      type: "LOOKUP_WORD",
      word: group.word,
      isParticle: group.isParticle ?? false,
      pos: group.pos ?? null,
      isHonorificSuffix: group.isHonorificSuffix ?? false,
    },
    (response) => {
      if (!editState) return;
      container.textContent = "";
      if (!response || response.error || !response.results?.length) {
        container.textContent = response?.error ? `Lookup failed: ${response.error}` : "No dictionary entry for that word.";
        return;
      }
      for (const entry of response.results.slice(0, 5)) {
        const option = document.createElement("button");
        option.className = "jp-immersion-edit-sense";
        const glossText = entry.g.map((senseGlosses) => senseGlosses.join("; ")).join(" / ");
        option.textContent = `${entry.r ?? group.word} — ${glossText}`;
        option.addEventListener("click", () => {
          // One selection sets all five together, which is the entire reason
          // these aren't free-text fields.
          editState.pendingWord = {
            word: group.word,
            reading: entry.r ?? "",
            gloss: entry.g.map((s, i) => `${i + 1}. ${s.join("; ")}`).join("<br>"),
            glossPlain: glossText,
            pos: formatPosChips(entry.p ?? [], group.word) ?? "",
            frequency: entry.fr ?? "",
            jlpt: entry.jlpt ?? "",
            surface: group.surface,
            // Where this token sits in the sentence that was segmented — the
            // only offset that describes the NEW word. Reusing the captured
            // word's offset here is what corrupted the sentence on save (see
            // buildEditedSentenceHtml).
            start,
          };
          onPicked();
        });
        container.appendChild(option);
      }
    }
  );
}

// Waveform with draggable start/end handles over the retained PCM buffer. The
// clip can be pulled WIDER than what was originally exported, not just
// tightened — that's the whole reason the buffer is kept instead of re-decoding
// the exported file, and why it carries padding on both sides.
function buildAudioEditor(section, noteId, onChange) {
  const unavailable = (why) => {
    const msg = document.createElement("div");
    msg.className = "jp-immersion-edit-hint";
    msg.textContent = why;
    section.appendChild(msg);
  };
  // Scoped to this section only: the rest of the panel stays fully usable when
  // audio can't be edited, since the text fields don't depend on it.
  if (noteId !== audioBufferNoteId) {
    unavailable("Audio editing is only available for the most recent capture.");
    return;
  }
  const info = retainedClipInfo();
  if (!info) {
    unavailable("Audio for this card is no longer available to edit.");
    return;
  }

  let start = info.clipStart;
  let end = info.clipEnd;

  const wave = document.createElement("div");
  wave.className = "jp-immersion-edit-wave";
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 64;
  wave.appendChild(canvas);
  const selection = document.createElement("div");
  selection.className = "jp-immersion-edit-wave-selection";
  const handleStart = document.createElement("div");
  handleStart.className = "jp-immersion-edit-wave-handle";
  const handleEnd = document.createElement("div");
  handleEnd.className = "jp-immersion-edit-wave-handle";
  wave.append(selection, handleStart, handleEnd);
  section.appendChild(wave);

  const readout = document.createElement("div");
  readout.className = "jp-immersion-edit-hint";
  section.appendChild(readout);

  const controls = document.createElement("div");
  controls.className = "jp-immersion-edit-actions";
  const play = document.createElement("button");
  play.textContent = "Play selection";
  play.addEventListener("click", () => previewRange(start, end, play));
  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.addEventListener("click", () => {
    start = info.clipStart;
    end = info.clipEnd;
    editState.audio = null;
    draw();
    onChange();
  });
  controls.append(play, reset);
  section.appendChild(controls);

  const ctx = canvas.getContext("2d");
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const barWidth = canvas.width / info.peaks.length;
    for (let i = 0; i < info.peaks.length; i++) {
      const h = Math.max(1, info.peaks[i] * (canvas.height - 4));
      ctx.fillRect(i * barWidth, (canvas.height - h) / 2, Math.max(1, barWidth - 0.5), h);
    }
    const toPct = (t) => `${(t / info.duration) * 100}%`;
    selection.style.left = toPct(start);
    selection.style.width = `${((end - start) / info.duration) * 100}%`;
    handleStart.style.left = toPct(start);
    handleEnd.style.left = toPct(end);
    const delta = end - start - (info.clipEnd - info.clipStart);
    readout.textContent =
      `${(end - start).toFixed(2)}s selected` +
      (editState.audio ? ` (${delta >= 0 ? "+" : ""}${delta.toFixed(2)}s vs. captured)` : " — unchanged");
  }

  const drag = (handle, isStart) => {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        const rect = wave.getBoundingClientRect();
        const t = Math.max(0, Math.min(info.duration, ((e.clientX - rect.left) / rect.width) * info.duration));
        // Handles can't cross, and a selection below ~100ms isn't a clip.
        if (isStart) start = Math.min(t, end - 0.1);
        else end = Math.max(t, start + 0.1);
        editState.audio = { start, end };
        draw();
        onChange();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };
  drag(handleStart, true);
  drag(handleEnd, false);
  draw();
}

// Plays a range straight from the retained buffer, so the preview is the same
// audio the save would write rather than an approximation of it.
// The one preview player, so a second play can't start on top of a first
// (reported live 2026-07-31: adjusting the trim handles repeatedly left
// several copies of the clip playing over each other, on top of the episode's
// own audio). Held at module scope rather than per-editor because closing the
// panel has to be able to silence it — see closeEditPanel.
let previewPlayer = null;

function stopPreview() {
  if (!previewPlayer) return;
  const { audio, url, restore } = previewPlayer;
  previewPlayer = null;
  audio.pause();
  URL.revokeObjectURL(url);
  if (restore) restore();
}

function previewRange(start, end, btn) {
  // A preview already running is left alone rather than restarted: the request
  // is almost always an accidental second click during a drag, and cutting the
  // clip off to start it again is exactly the stutter this is meant to stop.
  if (previewPlayer) return;
  const wav = encodeRetainedRange(start, end);
  if (!wav) {
    btn.textContent = "Nothing to play";
    return;
  }
  const bytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const audio = new Audio(url);
  const label = btn.textContent;
  btn.textContent = "Playing…";
  btn.disabled = true;
  const restore = () => {
    btn.textContent = label;
    btn.disabled = false;
  };
  previewPlayer = { audio, url, restore };
  audio.addEventListener("ended", stopPreview);
  audio.play().catch(stopPreview);
}

function saveEditPanel(saveBtn, status, sentenceInput, translationInput) {
  if (!editState) return;
  const { noteId, original, storedSentence, pendingWord } = editState;
  const fields = {};

  const sentenceText = sentenceInput.value;
  if (sentenceText !== storedSentence.text || pendingWord) {
    // A new word selection changes which token should be bolded, so the
    // sentence HTML is rebuilt in that case too, not only on a text edit.
    // The offset comes from whichever selection is in force — the picker
    // records where the token it segmented actually sits — and is only a
    // HINT: buildEditedSentenceHtml verifies it spells the word before using
    // it, so a sentence edited after the word was picked degrades to a search
    // rather than to a corrupted splice.
    const surface = pendingWord ? pendingWord.surface : storedSentence.wordSurface;
    const start = pendingWord
      ? pendingWord.start
      : sentenceText === storedSentence.text
        ? storedSentence.wordStart
        : -1;
    fields.Sentence = buildEditedSentenceHtml(sentenceText, surface, start);
  }
  const translationText = translationInput.value;
  if (translationText !== ankiHtmlToPlain(original.Translation)) fields.Translation = plainToAnkiHtml(translationText);

  if (pendingWord) {
    fields.Word = pendingWord.word;
    fields.Reading = pendingWord.reading;
    fields.Gloss = pendingWord.gloss;
    // POS/Frequency/JLPT are opt-in at capture time, and a card captured with a
    // toggle off has them empty on purpose. Re-picking a word must not smuggle
    // them onto a card that deliberately doesn't carry them, so each is only
    // rewritten if it was already populated.
    if (original.POS) fields.POS = pendingWord.pos;
    if (original.Frequency) fields.Frequency = pendingWord.frequency;
    if (original.JLPT) fields.JLPT = pendingWord.jlpt;
  }

  const audio = editState.audio ? encodeRetainedRange(editState.audio.start, editState.audio.end) : null;
  if (editState.audio && !audio) {
    status.textContent = "That audio selection is silent — adjust it or reset before saving.";
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  status.textContent = "";
  chrome.runtime.sendMessage(
    {
      type: "UPDATE_ANKI_NOTE",
      noteId,
      fields,
      audio,
      previousAudioFilename: editState.previousAudioFilename,
    },
    (response) => {
      if (!response || response.error) {
        // Nothing is discarded on failure — the panel stays exactly as it was
        // so the edit can be retried once Anki is reachable again.
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
        status.textContent = response?.error ?? "Couldn't reach Anki.";
        return;
      }
      // The note id stays remembered, so a second edit needs no re-trigger.
      if (lastAddedNote?.id === noteId && fields.Word) {
        lastAddedNote = { id: noteId, label: fields.Word };
        refreshEditLastCardControl();
      }
      saveBtn.textContent = "Saved";
      setTimeout(closeEditPanel, 600);
    }
  );
}

init();
