# Japanese Immersion Extension — Project Plan

_Last updated: 2026-07-02_

This is the **full source of truth** for the project — vision, target user, competitive analysis, scope, technical architecture, build order, decisions, and open questions. `CLAUDE.md` is a short session-start briefing that points back here; if you need the detail behind a decision or a task, it's in this document.

---

## 1. Product Vision & Core Goal

**Core goal:** Let learners who are already studying Japanese elsewhere (WaniKani, Bunpro, a textbook, a tutor) use Crunchyroll anime as real immersion practice, with just enough support to confirm what they half-know without breaking the scene. **The extension's job is to keep them watching, not to teach them.**

This is the product's north star, not just a feature list. Every scope decision traces back to it — see Section 4's litmus test.

**The premise this is built on:** Crunchyroll has no native Japanese subtitle track in any form — confirmed against Crunchyroll's own support documentation, which lists official subtitle/CC support only in Arabic, English, French, German, Portuguese, and Spanish (verified 2026-06-23). The extension fills a real, confirmed gap rather than duplicating an existing platform feature.

**Positioning — three pillars, not independent (the first causes the other two):**
1. **Lean by design, not by compromise.** No backend, no AI API calls. Originally a cost/architecture decision, but it doubles as the product's philosophy: nothing stands between the learner and the dictionary — the right default for a user who already has a more rigorous resource for grammar instruction elsewhere.
2. **Structurally cheaper to run.** No per-user AI-API or server cost, which gives room to compete on price or reinvest in the product without the margin pressure competitors running AI/server infrastructure carry.
3. **Depth on one platform, not breadth across many.** ManabiDojo spans Crunchyroll, Netflix, YouTube, manga, and general web. We go deep on Crunchyroll-specific problems (forced-subtitle coexistence, fansub drift, anime-specific vocab) instead of spreading thin.

---

## 2. Target User

**Not a beginner looking for their first grammar explanation.** Someone who already has a study system — WaniKani or similar for kanji/vocab SRS, Bunpro or similar for grammar SRS, maybe a textbook or tutor — and uses anime as immersion time: the place they meet studied material in the wild, build real reading/listening speed, and confirm or correct what they think they already know.

For this user, immersion time has one job: exposure and confirmation, fast, without breaking the flow of watching. It is **not** tutoring time. They already have a trusted resource for grammar instruction; an AI explanation competing with that resource is a worse experience than no explanation, not a better one. A typical session is mostly watching, with a click only when a word stops them — recognized-but-unsure, or an inflection that threw them — followed by a two-second confirmation, then back to the show.

**What this user actually wants, in priority order:**
1. Japanese subtitles to exist at all on Crunchyroll, synced well enough not to be annoying
2. A fast way to check a word without leaving the player
3. A way to send anything that caught their attention into the SRS system they already use and trust (Anki) — not a second, competing review system

**What this user does *not* want:**
- To be taught grammar mid-episode by an AI (duplicates/competes with Bunpro-equivalent)
- A built-in flashcard/quiz system that duplicates Anki, where they already have months of review history

---

## 3. Competitive Landscape

**Main competitor: ManabiDojo** — 2-person team, ~2 years old, ~5,000–8,000 Chrome Web Store users, 4.7–4.8 rating. Free tier covers Crunchyroll-catalog shows with basic lookups; $6/month or $120 lifetime unlocks AI features, flashcards, Netflix support, and — notably — parsing of raw *imported* subtitles for dictionary lookup (a user who imports a missing show via Jimaku still needs to pay to get word-segmented, clickable text on it, even though import itself is free).

### 3.1 Where ManabiDojo already leads (parity, not a gap for us to close)

Confirmed directly from their Features page (2026-06-30) and changelog:
- Up to four toggleable subtitle layers: Japanese (with furigana-above-kanji while paused), Kana, Romaji, and Native (dual subtitles in any officially-supported language) — their "Native" layer covers the same end-user need as our planned English-subtitle feature
- Jimaku import with **auto-offset-detection** (aligns against the platform's native subtitle track) and per-season "Jimaku history" (remembers preferred uploader/file, viewable/clearable) — materially more polished than our current manual-offset-only flow
- AI sentence/grammar breakdown (chunk-by-chunk, refreshable) and AI in-context translation (meaning of the clicked word *in this specific sentence*)
- Color-coded frequency-rank badges (green/yellow/orange/gray) — more granular than a simple common/uncommon flag
- POS tags, inflection info, kanji ON/KUN + JLPT level, a Names dictionary tab
- Custom dictionary URL buttons (up to 3, e.g. Jisho), choice of dictionary API source
- Built-in Wordbook with mastery levels and Anki-compatible export
- Romaji toggle, hotkeys, furigana display — all already shipped and mature

**Root cause of their reliability issues:** their parsing stack (Ichiran/Ichimoe + CaboCha) is confirmed **server-side**, not client-side, via their own changelog describing uploaded subtitles being sent to "our server" for parsing, with explicit capacity limits.

### 3.2 Known user complaints (our opportunity map)

1. **Paywall trust issue** — free features moved behind subscription after launch; specifically, the parsing/lookup step on imported subtitles is gated even though import itself is free
2. **Reliability** — intermittent bugs, server connectivity, regional subtitle issues (very likely downstream of the server-side parsing stack above)
3. **Price** — €6/month seen as expensive by some users relative to free alternatives (Yomitan + ASBPlayer); multiple reviews mention pairing ManabiDojo with Yomitan, suggesting a segment of their own users already prefers a leaner, non-AI dictionary-lookup tool

### 3.3 Our differentiation strategy

Revised 2026-06-30 after direct review of ManabiDojo's site, and again 2026-07-02 once Anki export moved into the core loop. Don't re-litigate 3.1/3.2 without new evidence.

- **Anki export that isn't paywalled a second time.** Core to the loop from the start (see Section 4), not bundled inside a wordbook system the user may not want, and not gated behind premium the way theirs is.
- **No AI middleman — a stance, not a missing feature.** Doesn't duplicate/compete with a grammar resource (e.g. Bunpro) the target user already trusts, and doesn't break immersion mid-episode. Directly answers complaint #1/#2's underlying cause (server-side AI dependency) by design.
- **Free, ungated parsing on imported subtitles.** Universal Jimaku import with full dictionary lookup from day one — ManabiDojo paywalls exactly this step.
- **Crunchyroll-specific depth vs. multi-platform breadth.** Forced-subtitle coexistence, fansub drift handling, anime-specific vocabulary, instead of spreading across Netflix/YouTube/manga/web.
- **Structurally lower cost base.** No backend/AI-API cost per user, giving room to price sustainably even though our pricing *model* (subscription + lifetime) now matches theirs and WaniKani/Bunpro's — see Section 4. This is a cost-structure advantage, not a pricing-model differentiator.

**Real UX gaps to close, not spun as differentiators — tracked in Section 8 Open Questions:** auto-offset-detection on import, per-season "remember my preferred uploader" memory, title-search matching (Crunchyroll's English titles vs. Jimaku's JP/romanized indexing).

---

## 4. V1 Scope

**Litmus test for anything added to this list:** Does it help the user capture something quickly and keep watching, or feed something into a system they already use? Or does it ask them to stop and be taught, or duplicate a tool they already trust? First → in. Second → out, regardless of whether ManabiDojo has it.

### Must-have (core loop)

- [ ] Crunchyroll support only (no Netflix, no YouTube, no manga yet)
- [ ] Universal subtitle import from Jimaku (search by show, not a curated list)
- [ ] Manual subtitle file upload fallback (.srt/.ass) for anything not on Jimaku
- [ ] Subtitle offset/sync adjustment tools (hotkeys + manual nudge) — must-have since community subs often drift
- [ ] Word-level segmentation of Japanese subtitle text (morphological analysis)
- [ ] Click/hover word → popup with definition + reading (JMdict data)
- [ ] **Anki export** — capture a clicked word or sentence and send it to the user's existing Anki deck via **AnkiConnect** (decided 2026-07-02 over offline .apkg/CSV — see Decisions Log). Moved from the differentiation layer into the core loop 2026-07-02: this *is* the "keep watching" loop's endpoint, not a bolt-on. Core card fields: target word, reading, gloss, full subtitle sentence with the target word marked. "Add to Anki" button on the existing word-click popup, sends instantly, undo/edit-last-card available after (no pre-send edit step). Requires Anki desktop + AnkiConnect running at capture time — needs a clear "Anki isn't open" state with retry, not a silent failure. Opt-in, off-by-default metadata toggles (shared by the popup and the card, one toggle set): POS label, common-word flag, JLPT level, and a frequency-marker placeholder (UI only — see Section 5). Sentence translation and audio/screenshot fields deferred — see Section 8.

### Additional differentiation features (build after core loop works)

- [ ] Furigana-only display mode (no romaji, no translation overlay)
- [ ] Romaji toggle (lower priority — see Open Questions on whether this persona needs it)
- [ ] English subtitle display (Jimaku fetch alongside Japanese, dual-display, hides Crunchyroll's own layer) — also the prerequisite for the deferred sentence-translation Anki field
- [ ] Subtitle appearance controls (font size, position, background opacity)
- [ ] Hotkeys (toggle subtitles, pause-and-reveal, offset adjust)
- [ ] Auto-pause on new subtitle line (Anki-style reveal)
- [ ] Subscription pricing (monthly) with a lifetime-purchase option — matches standard practice across WaniKani, Bunpro, and ManabiDojo (see Decisions Log 2026-06-30); a business-model item, not a competitive differentiator (see Section 3.3)

### Explicitly excluded from v1 (resist scope creep)

- **AI grammar/sentence explanations** — excluded on principle, not just cost. Competes with a resource the target user already trusts more (e.g. Bunpro) and breaks the immersion the product exists to protect. BYOK (user's own LLM API key, called client-side) would be the path if ever revisited without compromising the no-backend architecture — but this is a deliberate stance, not a missing feature.
- **Built-in wordbook / SRS / quiz system** — would duplicate Anki, where the target user already has review history. Anki export feeds that system instead of competing with it.
- Netflix support
- **JLPT level tagging as a default/always-visible feature** — narrowly reversed 2026-07-02: in scope only as an opt-in, off-by-default toggle on the popup and Anki card (see above), not as an always-on label/filter/sort. Does not reopen the AI-explanation or wordbook/SRS exclusions above, which stand for unrelated reasons.
- Manga OCR / general web support

---

## 5. Technical Architecture

Current/final state of each piece, with the date it was last locked in or changed. Where something evolved through more than one attempt, only the final state is described here — the rejected alternatives and reasoning live in the Decisions Log (Section 7) to avoid duplicating that history in two places.

- **Platform: Chrome extension, Manifest V3.** Not really a choice — MV2 has been fully disabled in stable Chrome since October 2024, with no path back; the last enterprise-policy workaround closed in 2025, and even the developer-flag workaround was being phased out by mid-2026.
- **Subtitle source: Jimaku API.** REST API gated by a personal account + API key; entries keyed to TMDB/AniList IDs with subtitle files attached underneath. Rate limit 25 req/min per key — cache search results client-side rather than re-querying on every load. Known footgun: a year number in a title search breaks results (strip years before searching by name). Exact contract: `GET /api/entries/search` (query/anilist_id/tmdb_id/anime/after/before), `GET /api/entries/{id}`, `GET /api/entries/{id}/files?episode=N`. Auth is the raw API key in an `Authorization` header (no `Bearer` prefix); all endpoints return `x-ratelimit-*` headers and `429` on limit. Auth is per-user (needed for the Phase 7 onboarding flow — the user needs their own Jimaku account + key). No viable alternative source exists for this niche.
- **Dictionary: JMdict via jmdict-simplified** (JSON build, not raw EDRDG XML — the raw format's DTD entities are awkward to parse in JS). Actively maintained (daily generation since mid-2006, 200k+ entries), CC BY-SA, commercial use explicitly permitted, attribution required, no open-source requirement on consuming software.
- **JMdict delivery format (2026-06-23, extended 2026-06-24).** The raw `jmdict-eng` release (117MB) is too large to `JSON.parse` synchronously without stalling either extension context. Ships instead as a custom-trimmed `jmdict-compact.json` (~29MB as of 2026-06-24), built once offline: indexes every kanji/kana surface form to an entry index, keeping first reading, up to 5 glosses, `partOfSpeech` codes, and a `common` flag, plus an 83-code `posTags` map. Loaded/cached in memory by the background service worker; content script sends a word, gets back entry objects + `posTags`. **Known cap, open question:** limited to 3 senses/5 glosses per word — revisit if testing surfaces an incomplete definition (Section 8).
- **jmdict-simplified's public JSON exposes only a collapsed `common: boolean`, not the underlying priority tier** (ichi1/ichi2, newsN, nfXX) — confirmed 2026-07-01 against the raw `jmdict-eng-3.6.2.json` release. `tags` only ever carries reading-form annotations (ateji, gikun, rK/rk/sK/sk, oK/ok, iK/ik), never priority markers. Any feature needing real frequency-tier data (frequency-marker toggle, こと sense-ordering) needs an external corpus — TUBELEX (BSD-3-Clause, YouTube-subtitle-derived) is the current candidate, unvetted as of this date.
- **Word segmentation: kuromoji.js** (client-side, pure JS), locked in 2026-06-23 after checking ManabiDojo's own stack (Ichiran/Ichimoe + CaboCha, confirmed server-side). Benchmark lindera-wasm/Vibrato-wasm only if real subtitle-corpus testing shows a quality gap (not pre-emptive). Bundled locally, runs in the content script (its dictionary loader needs `XMLHttpRequest`, unavailable in service workers). Each token carries `conjugated_type`/`conjugated_form` (Japanese grammatical labels), a katakana `reading`, `basic_form`/`pos`, and a `word_type: "KNOWN"|"UNKNOWN"` flag — confirmed 2026-07-01 that `word_type` can't distinguish a genuine kuromoji segmentation error from a correct parse (both tag "KNOWN"); length/adjacency heuristics are the only reliable signal for that class of bug. **Has no working runtime user-dictionary feature** — confirmed 2026-07-01 that the bundled library's `"USER"` node-type branch is dead code (`// TODO User dictionary`, never implemented by the library's own author). Any future "teach it new words" feature needs either an offline dictionary recompile or an application-level merge mechanism (see below), not a runtime CSV load.
- **Context split between service worker and content script is forced, not stylistic** (confirmed during Phase 2/3 build): Chrome is deprecating cross-origin `fetch` from content scripts, so all Jimaku network calls live in the background service worker; kuromoji's XHR-based dictionary loader forces tokenization into the content script. Net effect: network I/O → background, anything needing a real DOM/XHR → content script.
- **Overlay UI:** injected DOM overlay synced to video playback time. Must coexist with Crunchyroll's own forced-subtitle layer on some titles — confirmed 2026-06-23 this is a player-rendered text/caption layer, not burned into video pixels, so it needs a z-index/positioning strategy, not a video-corruption workaround. Still untested hands-on (Section 8). **Fullscreen parenting fix (2026-06-30):** DOM elements appended to `document.body` don't render when a fullscreen element is active; fixed with `getContainer()` (`document.fullscreenElement ?? document.body`) + a `fullscreenchange` listener that re-parents overlay elements.
- **Subtitle parsing:** `.srt`/`.ass` into timed text blocks. Verified 2026-06-30 (Bocchi/SubsPlease files) that long dialogue lines are sometimes split across multiple `Dialogue:` events at the same timestamp — `cues.filter()` + `.join("\n")` reassembles the full line (SubsPlease convention, not a bug).
- **Settings/storage:** Chrome extension local storage. Jimaku API key stored via a toolbar popup UI, never in a config file (2026-06-23).
- **Anki export architecture (decided 2026-07-02):** AnkiConnect, local HTTP server at `127.0.0.1:8765`, called via `fetch()` from the background service worker — same shape as the existing Jimaku calls, consistent with the no-backend approach.
- **Module export guard (2026-06-30):** `typeof module !== "undefined"` isn't a safe Node-only check in content scripts (`module` can exist in some browser/bundler contexts); changed to `typeof process !== "undefined"` in `tokenize-utils.js` and `subtitle-parser.js`.
- **Particle POS filtering (2026-06-30):** grammatical particles (は/が/に/で, etc.) have JMdict entries tagged `"prt"`; homophone common-noun entries (に→荷, は→歯, な→菜) lack that tag. An `isParticle` flag threaded content.js → background.js, filtered to `r.p?.includes("prt")`, gives correct grammatical definitions instead of misleading homophone nouns.
- **Half-width katakana (2026-06-30, root cause found 2026-07-01):** some subtitle releases (VCB-Studio) encode katakana in the half-width range (U+FF66–FF9F); `JAPANESE_WORD_RE` originally covered only full-width, leaving these non-clickable (fixed 2026-06-30 by adding the `ｦ-ﾟ` range). That fix made them *clickable* but not *resolvable* — `jmdict-compact.json`'s index is full-width-only, so every half-width click had silently shown "no entry" since Phase 3. Fixed 2026-07-01 with `normalizeHalfwidthKatakana()` applied at the single point every lookup passes through (see merge-mechanism notes below).
- **いる/居る JMdict ordering (2026-07-01):** fixed using rK/sK ("rarely-used kanji") tags already present in the source — an entry whose kanji forms are all rK/sK-tagged (or has none) is conventionally kana-written, so it ranks first for a kana-only lookup key. Directly fixes 居る ranking above 射る/炒る. Matched back to `jmdict-compact.json` by (reading, first gloss) fingerprint (217,601/217,625 matched).
- **Small っ (sokuon) is 2 UTF-16 code units**, not 1 (confirmed 2026-07-01) — relevant for any future kana-length heuristic; don't assume "1 mora = 1 character" for small kana (っ/ゃ/ゅ/ょ).
- **だ/です plain-copula vs. conjecture-form (でしょ/だろ):** share the same `basic_form`; the only distinguishing field is `conjugated_form` (`基本形` plain terminal vs. `未然形` imperfective stem+volitional). This is Rule 3's allowlist signal (below).

### Grouping/merge pipeline (content-script segmentation logic)

`tokenize-utils.js` runs several post-tokenization passes before rendering; `groupTokens(tokens, fuseSpans)` is the core grouping function. Current rule set (as of 2026-07-01, second round):

- **Rule 0** — Honorific prefix (お弁当 → looks up 弁当).
- **Rule 0.5** — Pronoun + pluralizing suffix (私たち, 僕たち): merged deterministically, no JMdict check, since the pattern is always grammatical.
- **Rule 0.6** — ん + copula-family (んだ/んです/んだろう/んでしょう): deterministic, looks up のだ directly and keeps the copula chain as the inflection label. Needed because JMdict has a headword for んだ but not んだろう/んでしょう.
- **Rule 1** — Te-form: [動詞]+[て/で] → one group (main verb); the following auxiliary gets its own group, so the learner can look up both.
- **Rule 2** — Contracted te-form auxiliary (見てる → 見ている).
- **Rule 3** — Allowlisted auxiliary absorption: only `PURE_INFLECTION_AUX` (た/ない/たい/せる/させる/れる/られる/う) and the plain copula (だ/です, `基本形`) absorb into the preceding word. Everything else tagged 助動詞 (でしょう/だろう/らしい/べき/まい) does not absorb and typically gets picked up correctly by the phrase-matcher instead.
- **Katakana-only proper-noun runs** merge into one fully inert (`word: null`, no click, no underline) span if any token is tagged 固有名詞, or — for names kuromoji's own tag misses (e.g. ヒンメル/アイゼン, inconsistently tagged 一般) — if a standalone katakana word has no real JMdict entry at all (async existence check).

**Phrase-matching** (`findPhraseMatchCandidates`/`classifyAndSelectPhraseMatches`/`applyPhraseMatches`) runs on **raw kuromoji tokens**, not `groupTokens`' output — required because 帰ったら tokenizes as one combined 帰っ+たら auxiliary token, so Rule 3 would already absorb it before any post-hoc scan on grouped output could see it. Implemented via a `fuseSpans` parameter threaded into `groupTokens` (fuse-outcome spans finalize before Rules 0–3 run on those positions) plus per-group `tokenStart`/`tokenEnd` tracking. Every accepted match resolves to one of two outcomes, selected together in one overlap pass (longest span wins):
- **fuse** — replaces individual tokens with one clickable unit (からといって, じゃない, んだ, にもかかわらず, ひとりぼっち). Gated on existence + (5+ characters, or every source token tagged 名詞, or a function-POS match, or two adjacent ≤2-character 動詞/形容詞 tokens — the signal for a kuromoji segmentation error like ぼっ+ち). A "baseline redundancy" filter rejects any span `groupTokens` would already produce correctly on its own (prevents the いた→板 "board" collision).
- **dual-view** — attaches as a secondary "Also, as a set phrase" note without touching the individual tokens, when **both boundary tokens are genuine content words** (動詞/名詞/形容詞/副詞/連体詞) worth their own click regardless (もの…なる). If either boundary is a particle/auxiliary/copula-contraction, the match fully fuses instead. と (助詞) is an explicit exception, forced to dual-view even next to a negative verb (探さないと), since it retains a common, unrelated job (plain reported-speech/conditional と) a full fuse would wrongly override.

**Kana-merge** (`findKanaMergeCandidates`/`applyKanaMerges`) fixes a single word kuromoji fragmented (ただいま！→た+だ+いま), triggered by trailing hard punctuation or an embedded elongation mark (〜) against a hiragana run. The elongation branch needs only JMdict existence; the punctuation branch also requires a function-word POS match (prt/exp/conj/int/aux-v) — needed after real corpus false positives (はいい→"dethronement", あったか→"warm").

Both mechanisms only trigger an async background round-trip (`CHECK_KANA_MERGES`) when candidates actually exist; the common case (neither present) stays synchronous. Any future tightening/loosening needs empirical validation via `scripts/batch-test.js` (Patterns 5/6/7), not a one-off test sentence.

_This section will continue to grow as later-phase testing surfaces more segmentation/sync edge cases._

---

## 6. Build Order

Each phase lists what's **done** and what **remains**, remaining items in priority order. Anything gated on another task or deprioritized says so explicitly.

**Phase 0 — Finalize spec** ✅ Complete (this doc).

**Phase 1 — Environment & extension skeleton** ✅ Complete. Basic Manifest V3 skeleton injecting into the Crunchyroll page, verified on a real watch page.

**Phase 2 — Subtitle pipeline proof of concept** ✅ Complete. Query Jimaku for one show, fetch a subtitle file, parse it, display raw Japanese text synced to video playback time (no clicking/dictionary). Verified end-to-end against Witch Hat Atelier ep. 1.

**Phase 3 — Word parsing & dictionary lookup** ✅ Complete.
- Segment parsed subtitle text into clickable words; click/hover → JMdict popup. Verified against Witch Hat Atelier ep 1.
- Merged auxiliary-verb tokens (た/ない/etc.) into the preceding word, fixing wrong lookups on inflected words (生まれた was splitting into 生まれ + unrelated noun 田).
- Popup enrichment: furigana (ruby markup), inflection line, POS labels, common-word badge.

**Phase 4 — Sync tooling & multi-show validation** ▶ CURRENT

*Done:*
- Offset adjustment UI + hotkeys: ±0.1s buttons, reset, Alt+←/→/0, offset persisted per-episode URL in `chrome.storage.local`
- Batch-testing script (`scripts/batch-test.js`), now reporting 7 corpus-validation patterns (te-form chains, JMdict lookup misses, unmerged 連用形, kana-merge/phrase-fuse/phrase-dual-view false-positive checks)
- Multi-show manual testing: Bocchi the Rock! ep 1 (8 bugs found & fixed), Frieren (confirmed working), One Piece ep 894 (subtitles load correctly; confirmed this episode has no forced-subtitle layer)
- Jimaku entry-selection bug fixed (was grabbing `entries[0]`, sometimes a movie/OVA instead of the main series)
- Full grouping-pipeline rebuild from a detailed live-testing bug report: katakana-name inertness, half-width-katakana definition resolution, speaker-prefix/inline-furigana stripping, Rule 3 allowlist rewrite, Rule 0.6 construction, phrase-matcher restructure onto raw tokens, dual-view mechanism — see Section 5 for the technical detail and Section 7 for the decision history

*Remaining, in priority order:*
1. ⬜ **In progress** — live browser testing of the full Phase 4 grouping-pipeline rebuild against real Crunchyroll (started end of last session; corpus-validated only so far)
2. ⬜ こと-style JMdict sense-ordering (zither/city/thing-matter senses all `common:true`, can't be disambiguated with current data) — deferred to a dedicated session, needs an external frequency corpus (TUBELEX candidate, unvetted)
3. ⬜ Forced-subtitle overlay test — deprioritized; no confirmed-forced-subtitle Crunchyroll title has turned up yet, don't actively hunt for one
4. Accepted residual edge cases, not scheduled work: があん (rare interjection collision), たの-vs-のか tie-break, occasional harmless dual-view "noise"
5. Conditional, not scheduled: lindera-wasm/Vibrato-wasm benchmark, only if real testing shows a kuromoji quality gap

**Phase 5 — Anki export** (core-loop completion; moved out of the old "differentiation layer" 2026-07-02 — see Section 4)

*Remaining, in priority order:*
1. ⬜ Run the DRM feasibility test against a live Crunchyroll episode (`canvas.drawImage()`, `video.captureStream()`, `AudioContext.createMediaElementSource()`, across ≥2 shows) — gates whether audio/screenshot fields are ever built; if blocked, drop both fields from the roadmap entirely rather than leaving them pending
2. ⬜ AnkiConnect wiring (`fetch()` to `127.0.0.1:8765` from the background service worker)
3. ⬜ Core card fields: target word, reading, gloss, full subtitle sentence with the target word marked (needs the click-time subtitle line threaded into the AnkiConnect call)
4. ⬜ "Anki isn't open" error state with retry — not a silent failure, not an implied fallback to file export
5. ⬜ "Add to Anki" button on the word-click popup; instant send; post-save toast with undo + edit-last-card
6. ⬜ Opt-in metadata toggles (shared between popup and card): POS (ready), common-word (ready), JLPT (check whether jmdict-simplified carries JLPT tags at all — may need an external source, unscoped if so), frequency (placeholder UI only — logic blocked on the same corpus gap as こと)
7. Open, not scheduled: sentence-only capture with no target word — revisit once there's usage data from the popup-based flow

**Phase 6 — Differentiation & polish**

*Remaining, in priority order:*
1. English subtitle display: fetch English subtitle from Jimaku alongside Japanese, dual-display (Japanese clickable, English non-clickable), hide Crunchyroll's own subtitle layer — also unblocks the deferred sentence-translation Anki field
2. Furigana-only display mode
3. Romaji toggle — lower priority than furigana for this persona, don't over-invest
4. Subtitle appearance controls (font size, position, background opacity)
5. Auto-pause on new subtitle line
6. Jimaku search-by-title mismatch fix — Crunchyroll shows English titles, Jimaku indexes JP/romanized titles, and Jimaku's search doesn't fuzzy-match across that gap; needs a design solution (e.g. resolve via TMDB/AniList ID from Crunchyroll metadata, or a fallback fuzzy-search flow) before the real search UI ships
7. Jimaku per-season offset/uploader memory ("Jimaku history") — deferred here from Phase 4/5, quality-of-life item on top of an already-working manual offset tool; better designed once there's a real user base to design the memory feature around

**Phase 7 — Packaging & launch prep**
- Settings persistence
- Onboarding flow, including the user's own Jimaku account + API key setup
- Chrome Web Store listing
- Subscription + lifetime pricing setup (price points TBD — see Open Questions)

---

## 7. Decisions Log

Settled decisions, ordered by date, so they don't get re-debated. Each entry is a genuine choice between real alternatives (test: "what did you choose this over?" has a real answer) — findings, constraints, or verified facts with no alternative live in Section 5 instead. Where a decision was later revised, it's consolidated into one entry showing the final state.

**2026-06-22 — Browser extension, not a desktop app.** Simpler payments, distribution, cross-platform story.

**2026-06-22 — Universal Jimaku import from day one, no curated show list.** Sync/offset tooling treated as must-have, not a later add-on.

**2026-06-22 — V1 platform scope is Crunchyroll only.**

**2026-06-23 — Stay client-side; kuromoji.js locked in as the v1 morphological analyzer.** Rejected matching ManabiDojo's server-side stack (Ichiran/Ichimoe + CaboCha) — that would take on the same backend-cost structure implicated in their own reliability complaints and undercut our pricing positioning. kuromoji.js is pure JS, no WASM toolchain, and shares MeCab/IPADIC lineage with Ichiran itself. Benchmark lindera-wasm/Vibrato-wasm only if real corpus testing shows a quality gap.

**2026-06-23 — jmdict-simplified (JSON) instead of parsing raw EDRDG XML directly.** The raw format's DTD entities are awkward to parse in JS.

**2026-06-23 — CLAUDE.md ↔ project-plan.md sync process defined.** Read Decisions Log/Open Questions at session start; update both files and scan for decisions/open-question changes at session end.

**2026-06-23 — Jimaku API key stored in `chrome.storage.local` via a toolbar popup**, not in any config file.

**2026-06-23 — Built a one-time offline preprocessing step for JMdict.** The full `jmdict-eng` release (117MB) was too large to parse synchronously at runtime; a Python script trims it to `jmdict-compact.json`.

**2026-06-24 — Fixed auxiliary-token segmentation with a targeted grouping rule**, not a tokenizer swap. Merging 助動詞 tokens into the preceding word was a grouping/boundary problem, not a tagging-accuracy problem, so pulling forward the lindera/Vibrato benchmark wouldn't have helped.

**2026-06-24 — Regenerated `jmdict-compact.json` (27MB → ~29MB) to retain POS codes, common-flag, and a posTags map**, to support new popup features (POS labels, common badge). Low-cost since the source was already downloaded.

**2026-06-30 — Te-form auxiliary chains split into two clickable units** (main-verb+て / auxiliary) rather than merged into one. Lets the learner look up both the verb meaning and the auxiliary's nuance separately.

**2026-06-30 — Extracted shared `tokenize-utils.js`** rather than duplicating `groupTokens`/`JAPANESE_WORD_RE` in the batch-test script, to avoid two implementations silently diverging.

**2026-06-30 — Made particles clickable with JMdict POS-code "prt" filtering**, rather than suppressing them entirely (frustrating) or showing all matching entries (misleading homophone nouns).

**2026-06-30 — Simplified Rule 1 (te-form merge) to always merge [動詞]+[て/で]** regardless of the following token, removing a constraint that blocked correct merges for terminal/non-auxiliary uses (乗り遅れて, 止まっていい).

**2026-06-30 — Stage-direction filter (`STAGE_RE`) added to content.js itself**, not left in the batch script only, since lines like （ドアの開く音） are never useful to the learner.

**2026-06-30 — Positioning pivot: lean into differentiation instead of feature parity.** After direct review of ManabiDojo's site, confirmed several planned "differentiators" (romaji, hotkeys, POS/inflection, furigana) are already parity or behind theirs. Rejected chasing feature-for-feature parity (AI breakdown, wordbook/quiz, multi-platform) as infeasible for a solo project; leaned into Crunchyroll-only depth, an AI-free architecture as a stance, and a structurally lower cost base instead — see Section 3.

**2026-06-30 — Anki export moved from excluded to in-scope**, instead of building an in-house wordbook/SRS/quiz system. The target user already has SRS history in Anki; feeding that system fits the core "capture and keep watching" goal better than a second, competing system would.

**2026-06-30 — Reaffirmed AI grammar/sentence explanations stay excluded, on stronger grounds.** Originally excluded as "expensive to replicate"; now excluded because it actively works against the product's purpose (breaks immersion, competes with a more-trusted resource like Bunpro) regardless of how it's built. Rejected an opt-in BYOK version for the same reason — the issue isn't technical feasibility.

**2026-06-30 — Subscription + lifetime-purchase pricing, replacing the original flat one-time-price plan.** Matches standard practice (WaniKani, Bunpro, ManabiDojo). The user's explicit preference, since the market has normalized subscription+lifetime enough that a flat one-time price would read as unfamiliar rather than a selling point.

**2026-07-01 — Jimaku entry-selection fixed via exact-match preference, not hardcoded IDs.** Prefers an exact case-insensitive name/english_name match over `entries[0]`. Rejected hardcoding known-good entry IDs per tested show — doesn't generalize to a real user's search.

**2026-07-01 — Kuromoji "user dictionary" plan abandoned; replaced with a JMdict-anchored merge mechanism.** The library has no working runtime user-dictionary feature at all (dead code, confirmed). Rejected (1) recompiling the binary IPADIC dictionary offline — too heavy for an open-ended, never-"complete" problem (anime slang is an unbounded long tail); (2) a hardcoded broken-word list — same reason, and root-causing ただいま！/か〜くれんぼ showed they were a Viterbi cost/punctuation-adjacency issue, not missing vocabulary. Built `findKanaMergeCandidates`/`applyKanaMerges` instead: self-generalizes to any show without per-word maintenance.

**2026-07-01 — Kana-merge gating settled on a function-POS-code filter, not the `common` flag or no gate at all.** `common` rejected real fixes like かくれんぼ (not flagged common despite being ordinary). No gate at all produced real false positives at 1257-line-corpus scale (はいい→"dethronement", あったか→"warm", etc.) that all matched only a content-word POS, while every correct match matched a function-word POS.

**2026-07-01 — General phrase-matcher built per explicit design mandate**, not hardcoded phrase-by-phrase. Went through three corpus-driven hardening rounds: existence-only → function-POS gate (rejected false positives like にし→"west"); gate wrongly rejected legit compounds (文化祭) → two-path rule (all-名詞 spans need only existence, mixed spans need the gate); that wrongly rejected ひとりぼっち (mis-tagged by the pre-existing ぼっち segmentation bug) → accept any 3+-group span on existence alone, since every false positive found was 2-group and every real phrase was 3+.

**2026-07-01 — Pronoun+suffix compounds (私たち, 僕たち) handled by a deterministic Rule 0.5**, not the general phrase-matcher, since `pn` isn't a function-word POS code (would fail the matcher's own gate) and the pattern is always grammatical regardless of that specific pronoun's JMdict headword status.

**2026-07-01 — Rule 3 (助動詞 absorption) narrowed to an explicit allowlist, in two passes.** First pass: restricted to verb/adjective-preceding tokens, excluding nouns (fixed 僧侶だろ directly, freed んだ for the phrase-matcher). Second pass, same day: rewritten from "any 助動詞 not excluded" to a positive allowlist (`PURE_INFLECTION_AUX` + plain-copula check via `conjugated_form`), so でしょう/だろう/らしい/べき/まい correctly stay separate. Rejected special-casing each construction individually in favor of one structural rule, per the user's "does this carry independent meaning" test applied uniformly.

**2026-07-01 — いる/居る ordering fixed with kanji-rarity (rK/sK) tags, not a priority/frequency resort.** jmdict-simplified's public JSON doesn't expose priority-tier data at all — confirmed by direct inspection of the raw release.

**2026-07-01 — Three smaller live-testing fixes, each user-directed:** (1) suppress the popup entirely for proper-noun-tagged words with no real JMdict entry, rather than adding JMnedict name translations (deferred, not rejected); (2) strip speaker-name prefixes ((Name)/Name:) from the display entirely, rather than normalizing both conventions to one style; (3) added a kuromoji-POS-to-JMdict-POS-category definition filter, reusing the particle-filter pattern — confirmed it only helps cross-category collisions (こと's particle sense vs. noun senses), not same-category ones.

**2026-07-01 — こと-style sense-ordering deferred to a dedicated future session**, not solved this session. The ideal domain-specific frequency list no longer exists on GitHub; the Leeds Corpus alternative has an unclear/NOASSERTION license (a risk this project has otherwise avoided). TUBELEX (BSD-3-Clause) looks viable but wasn't investigated further — rejected integrating it in a rushed tail-end addition in favor of giving it its own focused, corpus-validated session.

**2026-07-01 (second round) — Katakana-name detection uses JMdict existence, not kuromoji's 固有名詞 tag alone.** The tag proved inconsistent (レン/ハイター tagged correctly; equally-fictional ヒンメル/アイゼン tagged as ordinary nouns) — existence-check is the reliable fallback for what the tag misses.

**2026-07-01 (second round) — Half-width katakana normalization centralized at the JMdict-index-lookup layer** (`normalizeHalfwidthKatakana()` in `background.js`), not at each candidate-generation call site, so every consumer (word clicks, kana-merge, phrase-merge, katakana-name check) benefits from one fix instead of needing it repeated four times.

**2026-07-01 (second round) — Phrase-matching restructured to run on raw kuromoji tokens instead of `groupTokens`' output**, per explicit design requirement (帰ったら tokenizes as one combined auxiliary token, so Rule 3 would absorb it before any post-hoc scan on grouped output could see a separate たら candidate). Implemented via a `fuseSpans` parameter threaded into `groupTokens` plus per-group token-range tracking.

**2026-07-01 (second round) — Dual-view mechanism added: a matched phrase can attach as a secondary note instead of replacing the individual tokens**, when both boundary tokens are genuine content words worth their own click. Rejected applying dual-view universally — じゃ/か/ら/だ don't carry useful standalone meaning the way もの/なる do, so exposing them again would undo the point of the Rule 3 allowlist work.

**2026-07-01 (second round) — と (助詞) carved out as an always-dual-view exception**, even adjacent to a negative verb (探さないと). Rejected treating it like じゃ/か/ら/だ (always-fuse) — と retains a genuinely common, unrelated job (plain reported-speech/conditional と) far more often than the ないと "have to" idiom; a full fuse would mis-gloss ordinary quotation as an obligation.

**2026-07-01 (second round) — Added Rule 0.6 (ん + copula-family) as its own deterministic rule**, not left to the phrase-matcher. JMdict has a headword for んだ but not んだろう/んでしょう, so the matcher's exact-string-anchoring genuinely can't reach the extended forms no matter how it's tuned.

**2026-07-01 (second round) — Added a "baseline redundancy" filter to phrase-matching**: reject any candidate span `groupTokens` already produces correctly on its own. The alternative (accept the resulting noise as residual, like があん) was rejected because this specific collision (い+た vs. 板 "board") is far higher-frequency — it appears in nearly every past-progressive-tense scene.

**2026-07-01 (second round) — `hasSuspiciousFragment` signal tightened to "two adjacent ≤2-character 動詞/形容詞 tokens," in two corrections.** First version (any single 1-character verb/adjective token) was too broad, wrongly catching normal conjugation stems (し for する, い for いる) and causing new collisions. Tightening to "exactly 1 character" then missed ぼっ itself, since it's 2 UTF-16 code units (ぼ + small っ), not 1.

**2026-07-02 — AnkiConnect chosen over offline .apkg/CSV export**, superseding an earlier same-session provisional pick of offline export. Offline export breaks the "capture and keep watching" loop (best case: queue locally, stop watching later, manually import — the same failure mode that excluded the built-in wordbook); building both at once would double the design/testing surface. AnkiConnect is architecturally consistent with the no-backend approach (a `fetch()` to a local server, same shape as Jimaku calls) and a reasonable ask of a user who already has SRS habits (it's Anki's most-installed add-on). Known limitation to design around: requires Anki desktop running at capture time.

**2026-07-02 — Anki card core fields: target word, reading, gloss, full subtitle sentence (target word marked)** — not word-only, and not the full audio/screenshot version. Word-only loses the sentence context that gives real value over a standalone SRS system. Full sentence-mining with audio/screenshot deferred pending the DRM feasibility test, not rejected outright.

**2026-07-02 — Metadata toggles (POS, common-word, JLPT, frequency-placeholder) share one toggle set across the popup and the card**, not separate settings per surface — avoids the popup and the card silently disagreeing about what's shown for the same word.

**2026-07-02 — JLPT tagging scope reversal is narrow, not a full reopening.** In scope only as an opt-in, off-by-default toggle — not an always-visible label/filter/sort. The original exclusion targeted active mid-episode teaching breaking immersion (same reasoning as the AI-explanation exclusion); passive, opt-in metadata the user deliberately enables doesn't do that. Does not reopen the AI-explanation or wordbook/SRS exclusions, which stand for unrelated reasons. If jmdict-simplified doesn't carry JLPT tags at all, sourcing them is a separate, unscoped build task.

**2026-07-02 — Frequency-marker toggle ships as a UI placeholder now; underlying logic explicitly not built yet.** Same root cause as the こと sense-ordering gap: jmdict-simplified only exposes a collapsed `common: boolean`. Shipping the placeholder now keeps the toggle set's shape stable while gating the real logic behind the same future dedicated session already planned for こと. Drop the separate common-word toggle once frequency ships for real, not before.

**2026-07-02 — Sentence translation on the Anki card deferred, not rejected**, pending Phase 6's English-subtitle pipeline. Low-cost to defer: if the learner already has the word's meaning from the card, a full sentence translation is mainly a comprehension backstop on a later review, not core value.

**2026-07-02 — Audio/screenshot Anki fields left undecided, gated on a not-yet-run feasibility test**, rather than assuming they're blocked from general DRM/EME research already done this session. That research (Widevine + `canvas.drawImage()`/`captureStream()`) was general, not confirmed against Crunchyroll's actual player — the project's own standard (per the forced-subtitle precedent) is to verify a platform limitation hands-on before closing it out.

**2026-07-02 — Anki capture lives in the existing word-click popup, sends instantly, undo/edit available after — not a separate line-level hotkey/gesture, and not a pre-send edit step.** The separate-gesture idea is speculative demand with no confirmed evidence, carried forward as an open question instead of built. Mirrors a proven pattern (Yomitan, which ManabiDojo's own users are already pairing their tool with). A pre-send edit modal was rejected because it reintroduces the "stop and interact with a form" friction the instant-send/undo pattern exists to avoid.

**2026-07-02 — Anki export moved from the differentiation layer into the core-loop must-have list** (Section 4), reflecting that it's the endpoint of the "capture and keep watching" loop, not an add-on feature.

**2026-07-02 — Jimaku per-season offset/uploader memory ("Jimaku history") pushed to Phase 6, not scheduled into Phase 4/5.** Lower priority than the differentiation-layer work already committed to those phases; a quality-of-life item on top of an already-working manual offset tool, better designed once there's a real, sustained user base to design the memory feature around. Not a "we don't need this" — stays a known, real UX shortfall vs. ManabiDojo.

---

## 8. Open Questions

### Ongoing (ordered by phase/build priority)

1. **Live browser testing of the Phase 4 grouping-pipeline rebuild** — in progress; results expected this session. Everything in Section 5's grouping-pipeline notes is corpus-validated only so far, not yet confirmed in the actual Crunchyroll player. *(Phase 4)*
2. **こと-style JMdict sense-ordering** — needs an external word-frequency corpus (TUBELEX candidate, unvetted); deferred to a dedicated session. Confirmed distinct from the (now-resolved) んだろう construction issue — don't conflate the two if revisited. *(Phase 4)*
3. **Forced-subtitle overlay behavior** — still fully untested hands-on; One Piece ep 894 doesn't have this layer. Deprioritized — no confirmed-forced-subtitle title has turned up, don't actively hunt for one. *(Phase 4)*
4. **lindera-wasm vs. Vibrato-wasm fallback** — which is the better choice if kuromoji.js segmentation quality proves insufficient on colloquial/slang-heavy dialogue. Deferred until real testing shows a gap. *(Phase 4)*
5. **`jmdict-compact.json`'s 3-sense/5-gloss cap** — does this lose meanings that matter for highly polysemous words in practice? Revisit if Phase 4 testing surfaces an incomplete or contextually-wrong definition. *(Phase 4)*
6. **Dual-view "noise"** — the mechanism sometimes attaches a real-but-not-strictly-relevant coincidental match (して showing "Also: してい — servant/janitor"). Non-destructive; accepted as an inherent trade-off unless live testing shows it's genuinely distracting rather than easily ignored. *(Phase 4)*
7. **Audio/screenshot Anki fields — feasibility test designed, not yet run.** Test `canvas.drawImage()`, `video.captureStream()`, and `AudioContext.createMediaElementSource()` against a live Crunchyroll episode, across ≥2 shows, to confirm whether Widevine DRM blocks frame/audio extraction. If blocked, drop both fields from the roadmap entirely (not defer) and log as a confirmed platform limitation. *(Phase 5)*
8. **JLPT tag sourcing** — unconfirmed whether jmdict-simplified carries JLPT level data at all; if not, sourcing it is a separate, unscoped build task. *(Phase 5)*
9. **Sentence-only capture, no target word** — is there real demand for capturing a sentence/construction without a specific word triggering it? Not built in v1 — speculative demand, no confirmed evidence. Revisit once there's usage data from the popup-based capture flow; if it matters, it's a fast-follow, not a redesign. *(Phase 5)*
10. **Jimaku search-by-title mismatch** — Crunchyroll's English titles vs. Jimaku's JP/romanized-title indexing means a real user searching by the title they know could get zero results (confirmed via the Frieren search failure). Needs a design solution (e.g. TMDB/AniList ID resolution from Crunchyroll metadata, or fuzzy-search/suggestion fallback) before the real search UI ships. *(Phase 6)*
11. **Jimaku per-season offset/uploader memory** — real UX gap vs. ManabiDojo; deferred to Phase 6, needs its own design pass once there's a real user base to design around. *(Phase 6)*
12. **Romaji toggle investment level** — this persona (already doing kanji-focused SRS) likely values furigana more than a full romaji layer, which tends to serve total beginners. Keep in scope, don't over-invest unless user feedback says otherwise. *(Phase 6)*
13. **Shows with zero Jimaku subtitles available at all** — how to handle beyond the manual upload fallback. *(General / ongoing)*
14. **Pricing specifics** — monthly and lifetime price points. Model is decided (subscription + lifetime); exact numbers revisit after soft-launch feedback. *(Phase 7)*

### Resolved

- **Te-form auxiliary chains** (2026-06-30) — handled by Rule 1 (split into main-verb+て / auxiliary) and Rule 2 (contracted forms). Verified against 食べてしまった, 話しかけてくれる, 持っていった, 見てる, 読んでいる — 89 occurrences across 1236 lines (~7%) in the first batch run.
- **Fullscreen subtitle visibility** (2026-06-30) — fixed via `getContainer()` + `fullscreenchange` re-parent listener; verified on Bocchi ep 1.
- **ASS simultaneous multi-line subtitles** (2026-06-30) — fixed via `cues.filter()` + `.join("\n")` instead of `cues.find()`.
- **Inline furigana in subtitle files** (2026-07-01) — stripped via `INLINE_FURIGANA_RE` per user request (redundant with click-to-check, looked cluttered).
- **One Piece ep 894 forced-subtitle status** (2026-07-01) — confirmed this episode does NOT have Crunchyroll's forced-subtitle layer; that interaction remains untested (see Ongoing #3).
- **kuromoji user-dictionary feasibility** (2026-07-01) — confirmed no working runtime feature exists at all (dead code); ただいま！/か〜くれんぼ were a punctuation/elongation-adjacency segmentation bug, not missing vocabulary, fixed via kana-merge instead.
- **いる/居る ordering** (2026-07-01) — fixed via kanji-rarity tags, not the originally-assumed priority/frequency sort (that data isn't exposed in the source at all).
- **んだろう/んでしょう showing bare ん's wrong sense** (2026-07-01, second round) — turned out to be a missing-construction problem (JMdict has no headword for the extended forms), not an entry-ranking problem like こと/いる. Fixed with dedicated Rule 0.6, not entry ranking.
- **それも and ないと "no entry" assumptions** (2026-07-01, second round) — both turned out to have real JMdict entries the original bug report assumed didn't exist. それも: confirmed real, left as-is. ないと: also real, routed through the と dual-view carve-out specifically.
- **Anki export design** (2026-07-02) — AnkiConnect over offline export; core fields = word + reading + gloss + full sentence. See Decisions Log 2026-07-02.
- **Capture-action UX** (2026-07-02) — "Add to Anki" button on the existing popup, instant send, undo/edit-last-card after. See Decisions Log 2026-07-02.

---

## How to use this doc

- **project-plan.md is the full source of truth.** `CLAUDE.md` is a short session-start briefing (goals, litmus test, current priorities, working-style rules) that points back here for detail — it should not duplicate this document's content, only summarize what's needed to start a session.
- **Formatting conventions to keep consistent when editing this doc:**
  - Decisions Log entries: one bolded, dated, short summary title per entry, followed by the reasoning/rejected-alternative in plain text below it — not a full paragraph as the heading.
  - Technical Architecture: flat list of current/final states with dates, not a table. If a decision revised something more than once, describe only the final state here and put the revision history in the Decisions Log.
  - Build Order: split cleanly into "done" and "remaining" per phase; remaining items ordered by priority, with dependency/deprioritization notes inline. Narrative decision-making does not belong here — log it in Section 7 instead and reference it with a short pointer.
  - Open Questions: split into "Ongoing" and "Resolved," Ongoing ordered by which phase/build-order step it affects.
- **At the start of a session:** read the Decisions Log and Open Questions sections in full — they carry context that a phase summary alone won't.
- **At the end of a session:**
  1. Update Section 6 (Build Order): move completed items from "remaining" to "done," add any newly-discovered remaining items in priority order.
  2. Scan for genuine **decisions** (real rejected alternative — test: "what did you choose this over?"). If the honest answer is "there was nothing else to do," it's a finding, not a decision — it belongs in Section 5 (Technical Architecture) instead. Add qualifying decisions to Section 7 with a short bolded title, in date order. If a decision revises an earlier one, consolidate into a single updated entry rather than adding a second one.
  3. Update Section 8: move resolved questions to "Resolved," add new ones to "Ongoing" in the correct phase-priority position.
  4. If a real architectural or scope detail changed, update Section 5 directly (not just Section 7) so the "current state" list stays accurate on its own.
  5. Check Section 3 (Competitive Landscape) and Section 4 (V1 Scope) for drift — e.g. a feature moving between "differentiation" and "core loop," or new competitor findings — and update in place rather than leaving stale claims.
- If nothing decision-worthy happened (pure implementation, no surprises), say so explicitly rather than skipping the check silently.
