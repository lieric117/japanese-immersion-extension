// Phase 3: segment subtitle text into words (kuromoji) and let the learner
// click a word to see its reading + definition (JMdict, looked up in the
// background worker). Search-by-show UI still doesn't exist — hardcoded.

const SHOW_QUERY = "Sousou no Frieren";
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
    } else if (event.key === "0") {
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
    span._isProperNoun = group.isProperNoun ?? false;
    span._pos = group.pos ?? null;
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
  const surface = span.dataset.surface;
  const inflections = span._inflections ?? [];
  const isParticle = span._isParticle ?? false;
  const isProperNoun = span._isProperNoun ?? false;
  const pos = span._pos ?? null;
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
      // Invented character/place names are frequently proper nouns with no
      // real JMdict entry — silently close instead of showing a "no
      // dictionary entry" popup for something that was never meant to have one.
      if (isProperNoun) {
        closePopup();
        return;
      }
      popup.textContent = `No dictionary entry for "${word}"`;
      return;
    }
    popup.innerHTML = "";

    if (surface !== word) {
      const inflectionLine = document.createElement("div");
      inflectionLine.className = "jp-immersion-popup-inflection";
      inflectionLine.textContent =
        inflections.length > 0
          ? `Dictionary form: ${word} (inflected: ${inflections
              .map((i) => `${i}-form`)
              .join(" + ")})`
          : `Dictionary form: ${word}`;
      popup.appendChild(inflectionLine);
    }

    renderEntries(popup, word, response.results, response.posTags ?? {});

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
        renderEntries(popup, idiomWord, idiomResponse.results, idiomResponse.posTags ?? {});
      });
    }
  });
}

function renderEntries(container, word, results, posTags) {
  for (const { r, g, p, c } of results.slice(0, 3)) {
    const entry = document.createElement("div");
    entry.className = "jp-immersion-popup-entry";

    const headerRow = document.createElement("div");
    headerRow.className = "jp-immersion-popup-header-row";
    headerRow.appendChild(buildHeadword(word, r));
    if (c) {
      const badge = document.createElement("span");
      badge.className = "jp-immersion-popup-common-badge";
      badge.textContent = "common word";
      headerRow.appendChild(badge);
    }
    entry.appendChild(headerRow);

    if (p && p.length > 0) {
      const posLine = document.createElement("div");
      posLine.className = "jp-immersion-popup-pos";
      posLine.textContent = p.map((code) => posTags[code] ?? code).join(", ");
      entry.appendChild(posLine);
    }

    const gloss = document.createElement("div");
    gloss.className = "jp-immersion-popup-gloss";
    gloss.textContent = g.join("; ");
    entry.appendChild(gloss);
    container.appendChild(entry);
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
