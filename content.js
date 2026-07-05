// Phase 3: segment subtitle text into words (kuromoji) and let the learner
// click a word to see its reading + definition (JMdict, looked up in the
// background worker). Search-by-show UI still doesn't exist — hardcoded.

const SHOW_QUERY = "Bocchi the Rock!";
const EPISODE = 1;

// JAPANESE_WORD_RE and groupTokens live in tokenize-utils.js (loaded before
// this file by the manifest) so the batch-testing script can import them too.

// Matches kanji only — used to decide whether a headword needs furigana at
// all (a kana-only word doesn't need its own reading annotated above it).
const KANJI_RE = /[㐀-鿿]/;

let tokenizer = null;
let cues = null;
let activePopup = null;

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
  return inflections.join("");
}

// In fullscreen the browser only renders children of the fullscreen element,
// so our overlays need to live there while fullscreen is active.
function getContainer() {
  return document.fullscreenElement ?? document.body;
}

// Community subtitle timing drifts inconsistently release to release, so the
// offset is remembered per watch-page URL rather than globally.
const OFFSET_STORAGE_KEY = `offset:${location.pathname}`;
let offset = 0;

function init() {
  const video = document.querySelector("video");
  if (!video) {
    setTimeout(init, 1000);
    return;
  }

  const subtitleBox = document.createElement("div");
  subtitleBox.id = "jp-immersion-subtitle";
  getContainer().appendChild(subtitleBox);
  subtitleBox.textContent = "Loading subtitles…";

  const offsetControl = buildOffsetControl();
  getContainer().appendChild(offsetControl);

  document.addEventListener("fullscreenchange", () => {
    const target = getContainer();
    target.appendChild(subtitleBox);
    target.appendChild(offsetControl);
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

  chrome.runtime.sendMessage(
    { type: "FETCH_SUBTITLES", query: SHOW_QUERY, episode: EPISODE },
    (response) => {
      if (!response) {
        subtitleBox.textContent = "Extension error: no response from background.";
        return;
      }
      if (response.error) {
        subtitleBox.textContent = `Subtitle error: ${response.error}`;
        return;
      }

      cues = response.cues;
      let lastText = null;

      video.addEventListener("timeupdate", () => {
        const adjustedTime = video.currentTime - offset;
        // ASS files often split one visual subtitle across multiple simultaneous
        // Dialogue events — collect all that match the current time and join them.
        const text = cues
          .filter((c) => adjustedTime >= c.start && adjustedTime <= c.end)
          .map((c) => c.text.trim())
          .filter((t) => t && !STAGE_RE.test(t))
          .map((t) => t.replace(SPEAKER_PREFIX_RE, "").trim())
          .map((t) => t.replace(INLINE_FURIGANA_RE, "$1"))
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
    }
  );

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

  chrome.runtime.sendMessage({ type: "LOOKUP_WORD", word, isParticle, pos }, (response) => {
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
  return null;
}

function renderEntries(container, word, results) {
  const seenFirstGloss = new Set();
  for (const entry of results.slice(0, 3)) {
    const { r, g, p, c } = entry;

    // A later entry sharing its first gloss with one already shown above is
    // very likely the same core meaning under a rarer/alternate reading, not
    // a genuinely distinct sense worth equal billing — tag it with a real
    // JMdict-sourced label when one exists, or visually demote it otherwise.
    const isDuplicate = g[0] !== undefined && seenFirstGloss.has(g[0]);
    seenFirstGloss.add(g[0]);
    const tagLabel = isDuplicate ? archaicTagLabel(entry) : null;
    const demoted = isDuplicate && !tagLabel;

    const cardEl = document.createElement("div");
    cardEl.className = demoted ? "jp-immersion-popup-entry jp-immersion-popup-entry-demoted" : "jp-immersion-popup-entry";

    const headerRow = document.createElement("div");
    headerRow.className = "jp-immersion-popup-header-row";
    headerRow.appendChild(buildHeadword(word, r));
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

    const gloss = document.createElement("div");
    gloss.className = "jp-immersion-popup-gloss";
    gloss.textContent = g.join("; ");
    cardEl.appendChild(gloss);
    container.appendChild(cardEl);
  }
}

// `word` is the dictionary form sent to the lookup (e.g. 分かる), `reading`
// is that specific entry's kana reading (e.g. わかる). If the word has no
// kanji there's nothing to annotate, so it's shown as plain reading text —
// otherwise it's rendered as furigana over the whole word, matching the
// <ruby>kanji<rt>reading</rt></ruby> format.
function buildHeadword(word, reading) {
  if (!KANJI_RE.test(word)) {
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
