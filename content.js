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
// Returns `seasonNumber` too even though it's not yet threaded into the
// Jimaku query (Jimaku's `/files?episode=N` endpoint has no season
// parameter) — kept for Phase 4.5's later ranked-selection step, which needs
// season context to resolve the already-known per-season restart-numbering
// problem (Naruto: Shippuuden's S07E01-style Jimaku file tagging, see
// Decisions Log 2026-07-06). Returns null (not a guess/fallback) when no
// parseable TVEpisode block is found, so the caller can show a clear error
// instead of querying Jimaku with a wrong or empty title.
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
    return {
      seriesTitle,
      episodeNumber,
      seasonNumber: Number.isInteger(data.partOfSeason?.seasonNumber) ? data.partOfSeason.seasonNumber : null,
    };
  }
  return null;
}

// JAPANESE_WORD_RE and groupTokens live in tokenize-utils.js (loaded before
// this file by the manifest) so the batch-testing script can import them too.

let tokenizer = null;
let cues = null;
let activePopup = null;
// Module-scope (not local to init()'s timeupdate listener) so the
// SPA-navigation reload below can also reset it — see loadSubtitles/
// jp-immersion-locationchange.
let lastText = null;

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
// WHOLE line): ➡ continuation-into-next-cue arrows, 》 bracket markers,
// 📺 TV-dialogue emoji, and a 🎵〜 music-note marker. 〜 on its own (not
// preceded by 🎵) is left alone — it's a real vowel-elongation convention
// elsewhere in ordinary dialogue, not fansub markup. 「」 quote brackets are
// real Japanese orthographic punctuation and are never touched.
const FANSUB_MARKUP_RE = /[➡》📺]|🎵〜?/gu;

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
function loadSubtitles(subtitleBox, switcherPanel) {
  cues = null;
  lastText = null;
  subtitleBox.textContent = "Loading subtitles…";
  renderSwitcherOptions(switcherPanel, null, null, null);
  const detected = detectShowEpisode();
  if (!detected) {
    subtitleBox.textContent =
      'Couldn\'t detect the show/episode from this page — use "Upload subtitle file" below instead.';
    return;
  }
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
        fileHint: FILE_HINT,
        preferredUploader,
      },
      (response) => {
        if (!response) {
          subtitleBox.textContent = "Extension error: no response from background.";
          return;
        }
        if (response.error) {
          subtitleBox.textContent = `Subtitle error: ${response.error} — use "Upload subtitle file" below if Jimaku has nothing for this show.`;
          return;
        }
        cues = response.cues;
        renderSwitcherOptions(switcherPanel, response.files, response.selectedUrl, detected);
      }
    );
  });
}

function init() {
  const video = document.querySelector("video");
  if (!video) {
    setTimeout(init, 1000);
    return;
  }

  const subtitleBox = document.createElement("div");
  subtitleBox.id = "jp-immersion-subtitle";
  getContainer().appendChild(subtitleBox);
  // Text set by loadSubtitles() below, not here — it's called both on
  // initial load and on every SPA episode change, so it owns this state.

  const offsetControl = buildOffsetControl();
  getContainer().appendChild(offsetControl);

  const switcherPanel = buildSwitcherPanel();
  getContainer().appendChild(switcherPanel);

  document.addEventListener("fullscreenchange", () => {
    const target = getContainer();
    target.appendChild(subtitleBox);
    target.appendChild(offsetControl);
    target.appendChild(switcherPanel);
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

  // Attached once, unconditionally — reads from the shared `cues` variable so
  // either a Jimaku fetch or a manual file upload (see buildUploadControl)
  // can populate it interchangeably, without each needing its own listener.
  // `lastText` is module-scope (not declared here) so an episode change
  // (loadSubtitles, below) can reset it too.
  video.addEventListener("timeupdate", () => {
    if (!cues) return;
    const adjustedTime = video.currentTime - offset;
    // ASS files often split one visual subtitle across multiple simultaneous
    // Dialogue events — collect all that match the current time and join them.
    const text = cues
      .filter((c) => adjustedTime >= c.start && adjustedTime <= c.end)
      .map((c) => c.text.trim())
      .filter((t) => t && !STAGE_RE.test(t))
      .map((t) => t.replace(SPEAKER_PREFIX_RE, "").trim())
      .map((t) => t.replace(INLINE_FURIGANA_RE, "$1"))
      .map((t) => t.replace(FANSUB_MARKUP_RE, "").trim())
      .filter((t) => t)
      // Normalizes half-width katakana (some fansub releases, e.g.
      // VCB-Studio, encode katakana this way) to full-width BEFORE
      // tokenization — the 2026-07-01 fix only normalized at the JMdict
      // lookup layer, so a half-width word resolved correctly on click
      // but still displayed half-width on screen (スマホ shown as ｽﾏﾎ).
      .map((t) => normalizeHalfwidthKatakana(t))
      .join("\n");
    if (text === lastText) return;
    lastText = text;
    renderCue(subtitleBox, text);
  });

  loadSubtitles(subtitleBox, switcherPanel);

  // Re-detect and re-fetch on SPA episode navigation (2026-07-15) — without
  // this, `cues` keeps pointing at the previous episode's subtitles
  // indefinitely, since Crunchyroll doesn't reload the page between
  // episodes (confirmed via live testing). Also recomputes the offset
  // storage key/value for the new episode's URL, so a saved offset doesn't
  // leak across episodes.
  window.addEventListener("jp-immersion-locationchange", () => {
    OFFSET_STORAGE_KEY = `offset:${location.pathname}`;
    chrome.storage.local.get(OFFSET_STORAGE_KEY, (stored) => {
      offset = stored[OFFSET_STORAGE_KEY] ?? 0;
      updateOffsetDisplay();
    });
    loadSubtitles(subtitleBox, switcherPanel);
  });

  const uploadControl = buildUploadControl(video);
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
function renderSwitcherOptions(panel, files, selectedUrl, detected) {
  panel.textContent = "";
  if (!files || !files.length) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "flex";

  const label = document.createElement("label");
  label.textContent = "Subtitle file: ";

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
// override is a real, expected use case even when Jimaku succeeds.
function buildUploadControl(video) {
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

function renderCue(subtitleBox, text) {
  const myGeneration = ++renderGeneration;
  closePopup();
  subtitleBox.textContent = "";
  if (!text) return;

  if (!tokenizer) {
    subtitleBox.textContent = text;
    return;
  }

  const tokens = tokenizer.tokenize(text);

  // Phrase-matching (multi-token JMdict expressions like からといって, じゃない,
  // んだ, たら) has to run on the RAW token stream, before groupTokens/Rule 3
  // ever touch it — 帰ったら tokenizes as 帰っ+たら (one combined auxiliary
  // token), and Rule 3 would already absorb it into 帰った before any
  // post-hoc scan could see it as available for a separate たら match. Then
  // kana-merge (single-word fragmentation like ただいま！) runs on whatever
  // groups result — each stage is its own async round-trip only when it
  // actually finds candidates, so the common case (neither) stays fully
  // synchronous.
  const phraseCandidates = findPhraseMatchCandidates(tokens);
  if (phraseCandidates.length === 0) {
    renderAfterPhraseMerge(subtitleBox, myGeneration, groupTokens(tokens));
    return;
  }

  const phraseTexts = [...new Set(phraseCandidates.map((c) => c.lookupText))];
  chrome.runtime.sendMessage({ type: "CHECK_KANA_MERGES", texts: phraseTexts }, (response) => {
    if (myGeneration !== renderGeneration) return;
    const membership = response?.membership ?? {};
    const { fuseSpans, dualViewSpans } = classifyAndSelectPhraseMatches(tokens, phraseCandidates, membership);
    const groups = applyPhraseMatches(tokens, fuseSpans, dualViewSpans);
    renderAfterPhraseMerge(subtitleBox, myGeneration, groups);
  });
}

function renderAfterPhraseMerge(subtitleBox, myGeneration, groups) {
  const candidates = findKanaMergeCandidates(groups);
  if (candidates.length === 0) {
    renderAfterKanaMerge(subtitleBox, myGeneration, groups);
    return;
  }

  const texts = [...new Set(candidates.map((c) => c.lookupText))];
  chrome.runtime.sendMessage({ type: "CHECK_KANA_MERGES", texts }, (response) => {
    if (myGeneration !== renderGeneration) return;
    const membership = response?.membership ?? {};
    renderAfterKanaMerge(subtitleBox, myGeneration, applyKanaMerges(groups, candidates, membership));
  });
}

function renderAfterKanaMerge(subtitleBox, myGeneration, groups) {
  // Runs unconditionally, after kana-merge has already had its chance to
  // claim a lone っ into a real merged word (んっ) — see suppressTrailingSokuon
  // in tokenize-utils.js for why the ordering matters.
  groups = suppressTrailingSokuon(groups);
  const candidates = findKatakanaUnsuppressCandidates(groups);
  if (candidates.length === 0) {
    renderAfterKatakanaUnsuppress(subtitleBox, myGeneration, groups);
    return;
  }

  const texts = [...new Set(candidates.map((i) => groups[i].surface))];
  chrome.runtime.sendMessage({ type: "CHECK_KANA_MERGES", texts }, (response) => {
    if (myGeneration !== renderGeneration) return;
    const membership = response?.membership ?? {};
    renderAfterKatakanaUnsuppress(subtitleBox, myGeneration, applyKatakanaUnsuppress(groups, candidates, membership));
  });
}

function renderAfterKatakanaUnsuppress(subtitleBox, myGeneration, groups) {
  const candidates = findKatakanaNameCandidates(groups);
  if (candidates.length === 0) {
    renderGroups(subtitleBox, groups);
    return;
  }

  const texts = [...new Set(candidates.map((i) => groups[i].surface))];
  chrome.runtime.sendMessage({ type: "CHECK_KANA_MERGES", texts }, (response) => {
    if (myGeneration !== renderGeneration) return;
    const membership = response?.membership ?? {};
    renderGroups(subtitleBox, applyKatakanaNameSuppression(groups, candidates, membership));
  });
}

function renderGroups(subtitleBox, groups) {
  for (const group of groups) {
    if (group.word === null) {
      subtitleBox.appendChild(document.createTextNode(group.surface));
      continue;
    }

    const span = document.createElement("span");
    span.className = "jp-immersion-word";
    span.textContent = group.surface;
    span.dataset.word = group.word;
    span.dataset.surface = group.surface;
    span._inflections = group.inflections;
    span._isParticle = group.isParticle ?? false;
    span._isHonorificSuffix = group.isHonorificSuffix ?? false;
    span._pos = group.pos ?? null;
    span._conjugatedForm = group.conjugatedForm ?? null;
    span._idiomWord = group.idiomWord ?? null;
    span.addEventListener("click", onWordClick);
    subtitleBox.appendChild(span);
  }
}

// groupTokens, findKanaMergeCandidates, applyKanaMerges, findPhraseMatchCandidates,
// classifyAndSelectPhraseMatches, applyPhraseMatches are defined in tokenize-utils.js.

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

    const inflectionText = describeInflection(inflections, pos, conjugatedForm, word);
    if (inflectionText) {
      const inflectionLine = document.createElement("div");
      inflectionLine.className = "jp-immersion-popup-inflection";
      inflectionLine.textContent = inflectionText;
      popup.appendChild(inflectionLine);
    }

    renderEntries(popup, word, response.results);

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
        popup.appendChild(label);
        renderEntries(popup, idiomWord, idiomResponse.results);
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

function renderEntries(container, word, results) {
  const seenFirstGloss = new Set();
  for (const entry of results.slice(0, 3)) {
    const { r, g, si, p, c, k } = entry;

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
    if (c) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-common-badge";
      badge.textContent = "common word";
      headerRow.appendChild(badge);
    }
    if (tagLabel) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-archaic-badge";
      badge.textContent = tagLabel;
      headerRow.appendChild(badge);
    }
    cardEl.appendChild(headerRow);

    if (p && p.length > 0) {
      const chips = formatPosChips(p, word);
      if (chips) {
        const posLine = document.createElement("div");
        posLine.className = "jp-immersion-popup-pos";
        posLine.textContent = chips;
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

init();
