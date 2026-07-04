# Japanese Immersion Extension — Project Plan

_Last updated: 2026-07-04_

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
- Color-coded frequency-rank badges (green/yellow/orange/gray) — more granular than a simple common/uncommon flag. **Gap being closed (2026-07-04):** now planned as a real, graduated frequency-rank toggle, replacing the earlier common-word flag — see Section 4 and Decisions Log.
- POS tags, inflection info, kanji ON/KUN + JLPT level, a Names dictionary tab. **Declined, not gaps (2026-07-04):** kanji ON/KUN display and a Names dictionary were both considered and rejected — see Decisions Log. (Kanji-containing names are still made clickable as ordinary words, a separate, narrower fix — see Section 5.)
- Custom dictionary URL buttons (up to 3, e.g. Jisho), choice of dictionary API source. **Declined (2026-07-04):** cuts against the single-dictionary "nothing stands between the learner and the dictionary" positioning — see Decisions Log.
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
- **Structurally lower cost base.** No backend/AI-API cost per user, giving room to price sustainably even though our pricing *model* (subscription + lifetime) now matches theirs and WaniKani/Bunpro's — see Decisions Log 2026-06-30 and Build Order Phase 7. This is a cost-structure advantage, not a pricing-model differentiator.

**Real UX gap still open, not spun as a differentiator:** auto-offset-detection on import (aligning automatically against the platform's native subtitle track, rather than requiring a manual nudge the first time) — no decision made on this yet. The other two ManabiDojo gaps in this category are now resolved: per-season "remember my preferred uploader" memory is decided and scheduled (Section 6, Phase 6), and the title-search mismatch (Crunchyroll's English titles vs. Jimaku's JP/romanized indexing) is decided in favor of TMDB/AniList ID resolution (Section 6, Phase 6) — see Decisions Log 2026-07-04 for both.

---

## 4. V1 Scope

**Litmus test for anything added to this list:** Does it help the user capture something quickly and keep watching, or feed something into a system they already use? Or does it ask them to stop and be taught, or duplicate a tool they already trust? First → in. Second → out, regardless of whether ManabiDojo has it.

### Must-have (core loop)

- [ ] Crunchyroll support only (no Netflix, no YouTube, no manga yet)
- [ ] Universal subtitle import from Jimaku (search by show, not a curated list)
- [ ] Manual subtitle file upload fallback (.srt/.ass) for anything not on Jimaku — also the answer to "shows with zero Jimaku subtitles at all" (see Open Questions, Resolved); scheduled as its own Phase 4 priority slot gating Phase 5, see Section 6
- [ ] Display a synced Japanese subtitle overlay on the Crunchyroll player — the core premise (no native Japanese track exists at all) and the target user's #1 priority (Section 2)
- [ ] Subtitle offset/sync adjustment tools (hotkeys + manual nudge) — must-have since community subs often drift
- [ ] Word-level segmentation of Japanese subtitle text (morphological analysis)
- [ ] Click/hover word → popup with definition + reading (JMdict data)
- [ ] **Anki export** — capture a clicked word or sentence and send it to the user's existing Anki deck via **AnkiConnect** (decided 2026-07-02 over offline .apkg/CSV — see Decisions Log). Moved from the differentiation layer into the core loop 2026-07-02: this *is* the "keep watching" loop's endpoint, not a bolt-on. Full card fields, capture UX, and metadata-toggle spec live in Section 5 (Technical Architecture); sentence translation and audio/screenshot fields are deferred — see Section 8. JLPT's toggle is a narrow, 2026-07-02 exception to the original JLPT exclusion, opt-in/off-by-default only, never an always-on label/filter/sort — it doesn't reopen the AI-explanation or wordbook/SRS exclusions below, which stand for unrelated reasons.

### Additional differentiation features (build after core loop works)

- [ ] Furigana-only display mode (no romaji, no translation overlay)
- [ ] English subtitle display (Jimaku fetch alongside Japanese, dual-display, hides Crunchyroll's own layer) — also the prerequisite for the deferred sentence-translation Anki field
- [ ] Subtitle appearance controls (font size, position, background opacity)
- [ ] Hotkeys (toggle subtitles, pause-and-reveal, offset adjust)
- [ ] Auto-pause on new subtitle line (Anki-style reveal)

### Explicitly excluded from v1 (resist scope creep)

- **AI grammar/sentence explanations** — excluded on principle, not just cost. Competes with a resource the target user already trusts more (e.g. Bunpro) and breaks the immersion the product exists to protect. BYOK (user's own LLM API key, called client-side) would be the path if ever revisited without compromising the no-backend architecture — but this is a deliberate stance, not a missing feature.
- **Built-in wordbook / SRS / quiz system** — would duplicate Anki, where the target user already has review history. Anki export feeds that system instead of competing with it.
- Other video platforms (Netflix, YouTube, etc.) — Crunchyroll-only by design, not a Netflix-specific gap; see Section 1's "depth on one platform" positioning
- Manga OCR / general web support
- **Romaji subtitle-display toggle** — excluded 2026-07-04, not just deprioritized. A subtitle-level romaji layer (as opposed to anything in the popup) is a total-beginner feature — it exists for learners who can't read kana yet, which the target user by definition already can. Same shape of exclusion as kanji ON/KUN readings: not a priority call, this isn't the product's job for this persona.
- **Kana-only subtitle-display mode** — excluded 2026-07-04. Unlike romaji, this isn't just lower-value, it actively works against furigana mode: furigana keeps the kanji visible and adds the reading on top, reinforcing kanji the target user is likely also studying elsewhere; kana-only would strip the kanji out entirely, which is a step backward for that goal, not a lighter version of the same feature.

---

## 5. Technical Architecture

Current/final state of each piece, organized to match Section 6's phase ordering: general/cross-cutting architecture first, then grouped by the build phase each piece belongs to. Where something evolved through more than one attempt, only the final state is described here — the rejected alternatives and reasoning live in the Decisions Log (Section 7) to avoid duplicating that history in two places.

### General / cross-cutting architecture

Decisions and constraints that apply across the whole extension, not tied to a single build phase.

- **Platform: Chrome extension, Manifest V3.** Not really a choice — MV2 has been fully disabled in stable Chrome since October 2024, with no path back; the last enterprise-policy workaround closed in 2025, and even the developer-flag workaround was being phased out by mid-2026.
- **Context split between service worker and content script is forced, not stylistic** (confirmed during Phase 2/3 build): Chrome is deprecating cross-origin `fetch` from content scripts, so all Jimaku network calls live in the background service worker; kuromoji's XHR-based dictionary loader forces tokenization into the content script. Net effect: network I/O → background, anything needing a real DOM/XHR → content script.
- **Settings/storage:** Chrome extension local storage. Jimaku API key stored via a toolbar popup UI, never in a config file (2026-06-23).

### Phase 1–2: Extension skeleton & subtitle pipeline

- **Subtitle source: Jimaku API.** REST API gated by a personal account + API key; entries keyed to TMDB/AniList IDs with subtitle files attached underneath. Rate limit 25 req/min per key — cache search results client-side rather than re-querying on every load. Known footgun: a year number in a title search breaks results (strip years before searching by name). Exact contract: `GET /api/entries/search` (query/anilist_id/tmdb_id/anime/after/before), `GET /api/entries/{id}`, `GET /api/entries/{id}/files?episode=N`. Auth is the raw API key in an `Authorization` header (no `Bearer` prefix); all endpoints return `x-ratelimit-*` headers and `429` on limit. Auth is per-user (needed for the Phase 7 onboarding flow — the user needs their own Jimaku account + key). No viable alternative source exists for this niche. `JIMAKU_API_KEY` is now set as a persistent environment variable in the user's `~/.zshenv` (2026-07-03), so `scripts/batch-test.js` runs directly (`cd scripts && node batch-test.js`) without needing the key re-entered.
- **Subtitle parsing:** `.srt`/`.ass` into timed text blocks. Verified 2026-06-30 (Bocchi/SubsPlease files) that long dialogue lines are sometimes split across multiple `Dialogue:` events at the same timestamp — `cues.filter()` + `.join("\n")` reassembles the full line (SubsPlease convention, not a bug).
- **Overlay UI:** injected DOM overlay synced to video playback time. Must coexist with Crunchyroll's own forced-subtitle layer on some titles — confirmed 2026-06-23 this is a player-rendered text/caption layer, not burned into video pixels, so it needs a z-index/positioning strategy, not a video-corruption workaround. Still untested hands-on (Section 8). **Fullscreen parenting fix (2026-06-30):** DOM elements appended to `document.body` don't render when a fullscreen element is active; fixed with `getContainer()` (`document.fullscreenElement ?? document.body`) + a `fullscreenchange` listener that re-parents overlay elements.

### Phase 3: Word parsing & dictionary lookup (foundational)

- **Dictionary: JMdict via jmdict-simplified** (JSON build, not raw EDRDG XML — the raw format's DTD entities are awkward to parse in JS). Actively maintained (daily generation since mid-2006, 200k+ entries), CC BY-SA, commercial use explicitly permitted, attribution required, no open-source requirement on consuming software.
- **JMdict delivery format (2026-06-23, extended 2026-06-24).** The raw `jmdict-eng` release (117MB) is too large to `JSON.parse` synchronously without stalling either extension context. Ships instead as a custom-trimmed `jmdict-compact.json` (~29MB as of 2026-06-24), built once offline: indexes every kanji/kana surface form to an entry index, keeping first reading, up to 5 glosses, `partOfSpeech` codes, and a `common` flag, plus an 83-code `posTags` map. Loaded/cached in memory by the background service worker; content script sends a word, gets back entry objects + `posTags`. Known limitations discovered through later Phase 4 testing (gloss/sense cap, single-reading-per-entry, duplicate near-identical entries) are covered under Phase 4 below, since that's where they were found and are being fixed.
- **Word segmentation: kuromoji.js** (client-side, pure JS), locked in 2026-06-23 after checking ManabiDojo's own stack (Ichiran/Ichimoe + CaboCha, confirmed server-side). Bundled locally, runs in the content script (its dictionary loader needs `XMLHttpRequest`, unavailable in service workers). Each token carries `conjugated_type`/`conjugated_form` (Japanese grammatical labels), a katakana `reading`, and `basic_form`/`pos`. Known limitations of the library itself, discovered through later Phase 4 testing, are covered under Phase 4 below.

### Phase 4: Sync tooling & multi-show validation

**Dictionary-data precision:**

- **`jmdict-compact.json`'s sense/gloss cap and single-reading-per-entry limitations.** Capped at 3 senses/5 glosses per word (see Phase 3 above for why the cap exists) — **open question:** does this lose meanings that matter for highly polysemous words in practice? Revisit if testing surfaces an incomplete definition (Section 8). Separately, **known limitation, fix scheduled (found 2026-07-03, rescheduled to active work 2026-07-04):** the compact format keeps only one reading (`r`) per entry, so a word found via a genuinely different, legitimate alternate reading (e.g. くる resolving to 刳る, a rare kanji spelling of 抉る) displays that entry's primary reading (えぐる) instead of the reading actually used to reach it — looks like a stray unrelated homograph but isn't. Confirmed NOT an index-corruption bug (40/40 randomly-sampled candidates checked against the raw `jmdict-eng` release were real multi-reading words). Affects ~37,000 (index key, entry) pairs dictionary-wide, ~11.2% (4,157) involving a `common`-flagged entry (a rough proxy only — the case that surfaced this, 刳る, is itself non-common yet appeared in real Frieren dialogue). The fix needs restructuring compact entries to split by distinct reading, not a data prune (pruning would break real, if rare, lookups) — scheduled into Phase 4/5, see Build Order.
- **Duplicate-gloss homograph entries, fix designed but not yet built (2026-07-04).** When a headword has multiple JMdict entries for different readings with near-identical gloss lists (酒 → さけ vs 酒 → ささ, both "alcohol; sake"; 君 → きみ vs 君 → きんじ, both "you"), the popup currently shows both as equal-weight cards. Planned two-tier fix: check the rare reading's JMdict `re_inf`/`misc` tags (e.g. `ok` = out-dated reading, same tag family as the existing rK/sK kanji-rarity fix; `arch`/`obs`/`dated` at the sense level) and show an explicit sourced label (e.g. "(archaic)") when present, closer to what Jisho shows; fall back to demotion (secondary note, mirroring dual-view) when no such tag exists for that entry. Requires adding `re_inf`/`misc` to `jmdict-compact.json` if not already carried, the same low-cost regeneration pattern as the 2026-06-24 POS-code addition, and verifying against the raw `jmdict-eng` release whether specific cases like 酒/君 actually carry the tag before assuming they do. Exact demotion-vs-tag comparison rule (strict byte-identical gloss match vs. fuzzier overlap) still TBD.
- **Word-frequency data (superseded 2026-07-03).** jmdict-simplified's public JSON exposes only a collapsed `common: boolean`, not the underlying priority tier (ichi1/ichi2, newsN, nfXX) — confirmed 2026-07-01 against the raw `jmdict-eng-3.6.2.json` release; `tags` only carries reading-form annotations (ateji, gikun, rK/rk/sK/sk, oK/ok, iK/ik), never priority markers. This gap is now closed for homograph ordering via TUBELEX-JA (BSD-3-Clause, YouTube-subtitle-derived, 337,757 lemmas) — see the next entry. The same TUBELEX data now also powers the real, graduated frequency-rank toggle decided 2026-07-04 (Section 4), which replaces the earlier `common`-flag-based toggle.
- **Homograph/sense ordering via TUBELEX (2026-07-03, two-part fix same day).** `scripts/apply-tubelex-frequency.js` re-ranks every multi-entry index key by real usage frequency, superseding the earlier rK/sK kanji-rarity heuristic wherever real data exists (that heuristic remains the fallback tiebreak where TUBELEX has no data for either candidate). Needs no raw jmdict-eng re-download: `jmdict-compact.json`'s own index already links every kanji spelling to the same entry object as its kana reading (e.g. `index["こと"]`, `index["事"]`, and `index["琴"]` all point to shared entries), so per-entry frequency is derived by inverting the existing index and taking the max TUBELEX count across all surface forms pointing to each entry — no new field added, file size unchanged (30,772,667 bytes). First pass: 59,703 of 217,625 entries matched a nonzero frequency, 6,624 index keys reordered, fixing こと-style sense ordering (事 "thing/matter": 1,105,160 vs 琴 "zither": 372). Same-day follow-up fixed a cross-reading contamination bug in that first pass: taking the *max* frequency across every key pointing to an entry let a rare sense borrow an unrelated common word's frequency via a shared reading (そうか's "Buddhist temple" sense outranking its own common interjection sense by borrowing 宗家's frequency; だ's own high frequency outranking だ-as-copula under a shared index key). Fixed by checking, ahead of raw frequency: (1) whether a KANA-ONLY key matches the entry's own displayed reading (kanji keys are exempt — excluding them dropped coverage from 59,703 to 9,450 entries, since TUBELEX's lemma field is often in kanji); (2) JMdict's own curated `common` flag, since an automated MeCab-based frequency tool can fail to lemmatize a casual multi-morpheme interjection like そうか as its own token, so "no data" isn't reliably distinguishable from "genuinely rare." Re-validated: 59,011 entries scored, 2,999 keys reordered, `scripts/batch-test.js`'s 6 pattern counts unchanged (89/38/53/24/397/125). Also fixed the 大事なことさ bug (な showing だ+た as equally-weighted cards) as a side effect.
- **いる/居る JMdict ordering (2026-07-01):** fixed using rK/sK ("rarely-used kanji") tags already present in the source — an entry whose kanji forms are all rK/sK-tagged (or has none) is conventionally kana-written, so it ranks first for a kana-only lookup key. Directly fixes 居る ranking above 射る/炒る. Matched back to `jmdict-compact.json` by (reading, first gloss) fingerprint (217,601/217,625 matched). Later reinforced with real usage data by the TUBELEX pass above, which supersedes this heuristic wherever it has data.

**kuromoji.js limitations (found via Phase 4 testing):**

- **`word_type` can't distinguish segmentation errors from correct parses** (confirmed 2026-07-01): both a genuine kuromoji mistake and a correct parse get tagged `"KNOWN"`; length/adjacency heuristics are the only reliable signal for that class of bug.
- **Has no working runtime user-dictionary feature** — confirmed 2026-07-01 that the bundled library's `"USER"` node-type branch is dead code (`// TODO User dictionary`, never implemented by the library's own author). Any future "teach it new words" feature needs either an offline dictionary recompile or an application-level merge mechanism (see Kana-merge below), not a runtime CSV load.
- **Per-token `reading` is not a reliable signal for sense disambiguation** (checked 2026-07-03, not built on). Tested as a candidate anchor for kanji-heteronym sense ordering (一行 = いっこう "party/group" vs いちぎょう "one line"): unreliable both in the reported case (勇者一行 triggers a Viterbi-cost segmentation split with no usable single-token reading at all) and in general (correct for 大分, wrong for 十分/人気, which are missing their alternate readings entirely). Concluded not solid enough to build a fix on; logged as an accepted limitation (Section 8) rather than pursued further.
- **Benchmark lindera-wasm/Vibrato-wasm only if real subtitle-corpus testing shows a quality gap** — not pre-emptive; no gap has surfaced yet (Section 8).

**Popup content & display:**

- **Popup POS labels (2026-07-03):** `content.js`'s `POS_LABELS`/`posLabel()`/`formatPosChips()` centralize JMdict POS-code → short-label formatting (e.g. `n` → "Noun", `vs` → "する-verb", all `v5*` codes → "Godan verb"), applied at every popup render site. Cuts kokugo-grammar-school parentheticals ((futsuumeishi), (keiyoushi), etc.) and the redundant "(common)" tag on the default noun case; caps at 3 chips per sense. `n-pr` (proper noun) has a label ready but is currently unreachable — JMdict's proper-noun data lives in the separate JMnedict database, which this project doesn't ingest. **くる/する self-headword exception:** `IRREGULAR_VERB_SELF_CODES` suppresses the "Kuru verb"/"する-verb" chip only when くる/する (or their rare kanji spellings 来る/為る) is the resolved headword itself, since the label would just restate the headword in grammatical-term form — kept for every other case, e.g. a compound where くる/する is a component (持ってくる) or a noun+する pairing (凱旋, tagged `vs` not `vs-i`/`vs-s`/`vs-c` so it's unaffected either way), where the label is real, non-obvious information. Unlike Ichidan/Godan (kept as-is everywhere), くる/する as standalone headwords have no comparable ambiguity to disambiguate.
- **Furigana centering fix (2026-07-03):** `content.css`'s `.jp-immersion-popup-reading` (the `<ruby>` headword element) had `display: block`, which overrides the browser's native ruby layout algorithm responsible for centering `<rt>` over the base text, falling back to plain block stacking instead. Fixed with explicit `ruby-position: over`; the element still participates correctly in its flex-row parent since flex items get their outer display auto-"blockified" regardless of this property. Only fixes centering for the existing group/jukugo-ruby style (whole reading over the whole compound) — mono-ruby (per-kanji distributed furigana) is a separate, deliberately-deferred Phase 6 item.
- **Popup inflection line (2026-07-03, two-part rework same day).** `content.js`'s `INFLECTION_LABELS`/`describeInflection()` replaced the old "Dictionary form: X (inflected: Y-form)" line with native-morpheme labels (て-form, た-form, etc.), no line at all when there's nothing to show, and no synthesized composite label for inflection chains (んだろう-style shows the raw chain text instead). Noun+plain-copula groupings (凱旋+です) get an explicit `+ です (copula)` label instead of being mislabeled as the noun's own inflection — depends on a new `conjugatedForm` field carried on every Rule-3-path group (display-only, doesn't affect merge/grouping), needed to detect imperative (命令形), which never appears in the `inflections` array at all. `INFLECTION_LABELS` also carries the labels for the newly-mergeable auxiliaries below (-ば; られる/れる (passive); せる/させる (causative)). Same-day follow-up pass added a short plain-English parenthetical to every label (て-form → "(connective)", ない-form → "(negative)", etc.) and split だ/です into three distinct wordings based on whether the preceding token is 名詞 or 形容詞: noun+plain だ → "(copula)"; noun+polite です → "(polite copula)"; い-adjective+です → "(polite)" only, since です there adds only politeness to an already-complete predicate, no copula-linking work. That pass also fixed two real bugs surfaced while building it: な (だ's attributive/体言接続 form, e.g. 大事な) previously showed no inflection line at all, now labeled "な (attributive)"; んだ/んです (Rule 0.6's construction) was wrongly falling through to the generic verb-past-tense だ table entry, now labeled "んだ (explanatory)" / "んです (explanatory, polite)". なら (だ's conditional/仮定形 form) has the identical gap as な did — flagged, not fixed, since it wasn't in scope of what was asked.
- **Small っ (sokuon) is 2 UTF-16 code units**, not 1 (confirmed 2026-07-01) — relevant for any future kana-length heuristic; don't assume "1 mora = 1 character" for small kana (っ/ゃ/ゅ/ょ).
- **だ/です plain-copula vs. conjecture-form (でしょ/だろ):** share the same `basic_form`; the only distinguishing field is `conjugated_form` (`基本形` plain terminal vs. `未然形` imperfective stem+volitional). This is Rule 3's allowlist signal, below.

**Grouping/merge pipeline (content-script segmentation logic):**

`tokenize-utils.js` runs several post-tokenization passes before rendering; `groupTokens(tokens, fuseSpans)` is the core grouping function. Current rule set (as of 2026-07-03):

- **Rule 0** — Honorific prefix (お弁当 → looks up 弁当).
- **Rule 0.5** — Pronoun + pluralizing suffix (私たち, 僕たち): merged deterministically, no JMdict check, since the pattern is always grammatical.
- **Rule 0.6** — ん + copula-family (んだ/んです/んだろう/んでしょう): deterministic, looks up のだ directly and keeps the copula chain as the inflection label. Needed because JMdict has a headword for んだ but not んだろう/んでしょう.
- **Rule 1** — Te-form: [動詞]+[て/で] → one group (main verb); the following auxiliary gets its own group, so the learner can look up both. Also handles Rule 2 (contracted te-form auxiliary, 見てる → 見ている).
- **Rule 3** — Allowlisted auxiliary absorption: only `PURE_INFLECTION_AUX` (た/ない/たい/せる/させる/れる/られる/う) and the plain copula (だ/です, `基本形`) absorb into the preceding word. Everything else tagged 助動詞 (らしい/べき/まい) does not absorb and typically gets picked up correctly by the phrase-matcher instead.
  - **でしょ/だろ exception (2026-07-03):** these share です/だ's `basic_form` but are the conjecture stem (`conjugated_form === "未然形"`, not `基本形`) — でしょう/だろう, including the bare でしょ/だろ colloquial form with no う following, have their own JMdict headword ("probably; I guess"). The group's lookup word is the reconstructed surface, not the copula's own basic_form, so でしょう/だろう resolves to its own definition instead of です/だ's plain "be; is."
  - **せる/させる/れる/られる gap fixed (2026-07-03):** these are listed in `PURE_INFLECTION_AUX` but were never actually reachable — the absorption check required `pos === "助動詞"`, while kuromoji always tags these `動詞` with `pos_detail_1 === "接尾"` (verb-suffix). Confirmed a pre-existing gap, not a regression; fixed by also accepting that tag combination. Each was previously independently clickable as its own token.
  - **ば conditional absorption added (2026-07-03, new scope):** 助詞 ば now absorbs into a preceding verb/adjective already conjugated to `仮定形` (見れば, 聞けば) — mirrors the たり/だり precedent (surface-form check on a 助詞) with an added conjugation gate, since bare ば has an unrelated real noun sense ("place") that only the conjugation context rules out. Approved via the project's litmus test: two separate clicks is worse than one click on the real conditional-inflected verb, same reasoning that justified て/た merging.
- **Katakana-only proper-noun runs** merge into one fully inert (`word: null`, no click, no underline) span if any token is tagged 固有名詞, or — for names kuromoji's own tag misses (e.g. ヒンメル/アイゼン, inconsistently tagged 一般) — if a standalone katakana word has no real JMdict entry at all (async existence check). **Scope narrowed to katakana-only runs (2026-07-04, not yet implemented):** kanji-containing names (e.g. a character or place name written with kanji) are no longer to be suppressed — they'll be treated as ordinary clickable words, click → standard JMdict popup, the same as any other sentence word. This narrows the earlier 2026-07-01 fix that suppressed the popup for *any* proper-noun-tagged word with no real JMdict entry, katakana or kanji alike — see Decisions Log and Build Order.

**Phrase-matching** (`findPhraseMatchCandidates`/`classifyAndSelectPhraseMatches`/`applyPhraseMatches`) runs on **raw kuromoji tokens**, not `groupTokens`' output — required because 帰ったら tokenizes as one combined 帰っ+たら auxiliary token, so Rule 3 would already absorb it before any post-hoc scan on grouped output could see it. Implemented via a `fuseSpans` parameter threaded into `groupTokens` (fuse-outcome spans finalize before Rules 0–3 run on those positions) plus per-group `tokenStart`/`tokenEnd` tracking. Every accepted match resolves to one of two outcomes, selected together in one overlap pass (longest span wins):
- **fuse** — replaces individual tokens with one clickable unit (からといって, じゃない, んだ, にもかかわらず, ひとりぼっち). Gated on existence + (5+ characters, or every source token tagged 名詞, or a function-POS match, or two adjacent ≤2-character 動詞/形容詞 tokens — the signal for a kuromoji segmentation error like ぼっ+ち). A "baseline redundancy" filter rejects any span `groupTokens` would already produce correctly on its own (prevents the いた→板 "board" collision).
- **dual-view** — attaches as a secondary "Also, as a set phrase" note without touching the individual tokens, when **both boundary tokens are genuine content words** (動詞/名詞/形容詞/副詞/連体詞) worth their own click regardless (もの…なる). If either boundary is a particle/auxiliary/copula-contraction, the match fully fuses instead. と (助詞) is an explicit exception, forced to dual-view even next to a negative verb (探さないと), since it retains a common, unrelated job (plain reported-speech/conditional と) a full fuse would wrongly override. **Pure noun+noun exception (2026-07-03):** a span where every token is 名詞 (e.g. 王都 = 王+都, no intervening particle) always fuses instead, even though both boundary tokens independently pass the content-word check — dual-view exists for cases like もの…なる where the boundary words stay independently meaningful across an intervening particle, not for two nouns directly adjacent forming an ordinary compound. Previously any all-noun span was wrongly classified dual-view first, burying the compound's own definition (e.g. 王都) under its first half's (王, "king").

**Kana-merge** (`findKanaMergeCandidates`/`applyKanaMerges`) fixes a single word kuromoji fragmented (ただいま！→た+だ+いま), triggered by trailing hard punctuation or an embedded elongation mark (〜) against a hiragana run. The elongation branch needs only JMdict existence; the punctuation branch also requires a function-word POS match (prt/exp/conj/int/aux-v) — needed after real corpus false positives (はいい→"dethronement", あったか→"warm").

Both mechanisms only trigger an async background round-trip (`CHECK_KANA_MERGES`) when candidates actually exist; the common case (neither present) stays synchronous. Any future tightening/loosening needs empirical validation via `scripts/batch-test.js` (Patterns 5/6/7), not a one-off test sentence.

**Other Phase 4 fixes:**

- **Module export guard (2026-06-30):** `typeof module !== "undefined"` isn't a safe Node-only check in content scripts (`module` can exist in some browser/bundler contexts); changed to `typeof process !== "undefined"` in `tokenize-utils.js` and `subtitle-parser.js`.
- **Particle POS filtering (2026-06-30):** grammatical particles (は/が/に/で, etc.) have JMdict entries tagged `"prt"`; homophone common-noun entries (に→荷, は→歯, な→菜) lack that tag. An `isParticle` flag threaded content.js → background.js, filtered to `r.p?.includes("prt")`, gives correct grammatical definitions instead of misleading homophone nouns.
- **Half-width katakana (2026-06-30, root cause found 2026-07-01):** some subtitle releases (VCB-Studio) encode katakana in the half-width range (U+FF66–FF9F); `JAPANESE_WORD_RE` originally covered only full-width, leaving these non-clickable (fixed 2026-06-30 by adding the `ｦ-ﾟ` range). That fix made them *clickable* but not *resolvable* — `jmdict-compact.json`'s index is full-width-only, so every half-width click had silently shown "no entry" since Phase 3. Fixed 2026-07-01 with `normalizeHalfwidthKatakana()` applied at the single point every lookup passes through (the JMdict-index-lookup layer in `background.js`).
- **Manual subtitle upload architecture (decided 2026-07-04, not yet built):** user-facing file-picker UI feeding a local `.srt`/`.ass` file into the existing `subtitle-parser.js` (built in Phase 2 for Jimaku-sourced files) — no new parsing logic needed, just a new input path. Answers "shows with zero Jimaku subtitles" (Section 8) as well as any per-episode override need.

_This section will continue to grow as later-phase testing surfaces more segmentation/sync edge cases._

### Phase 5: Anki export

- **Anki export architecture (decided 2026-07-02):** AnkiConnect, local HTTP server at `127.0.0.1:8765`, called via `fetch()` from the background service worker — same shape as the existing Jimaku calls, consistent with the no-backend approach. Requires Anki desktop + AnkiConnect running at capture time — needs a clear "Anki isn't open" state with retry, not a silent failure. **Capture UX:** "Add to Anki" button on the existing word-click popup, sends instantly, undo/edit-last-card available after (no pre-send edit step). **Core card fields:** target word, reading, gloss, full subtitle sentence with the target word marked. **Metadata toggles:** opt-in, off-by-default, shared by the popup and the card as one toggle set — POS label, JLPT level (source externally if jmdict-simplified doesn't carry the tag itself — decided 2026-07-04, toggle stays either way), and a frequency-rank badge (decided 2026-07-04: 3 text tiers — Common / Uncommon / Rare — no raw numbers shown, and no badge at all when TUBELEX has no data for the word, rather than defaulting an unranked word to "Rare"; replaces the earlier common-word flag/placeholder; built on the TUBELEX usage-frequency data already integrated for homograph ordering in Phase 4 above; exact numeric thresholds per tier TBD during implementation, ideally percentile-based against the real TUBELEX distribution rather than fixed counts). Sentence translation and audio/screenshot fields are deferred — see Open Questions.

### Phase 6–7: Differentiation, polish & launch prep

- **Mono-ruby (per-kanji distributed furigana), designed but deliberately deferred (identified 2026-07-03).** Requested during Phase 4 live testing for readability — the current furigana centering fix (Phase 4 above) only handles group/jukugo-ruby (whole reading centered over the whole compound), not per-kanji distribution (e.g. おう over 王 and と over 都 within 王都). Needs a new data source (KANJIDIC, JMdict's sister project, for per-kanji on'yomi/kun'yomi) plus an alignment algorithm to match a compound's reading against its characters' possible readings, and won't work at all for jukujikun words (大人=おとな) where the reading doesn't decompose per-kanji. A naive even-split heuristic was rejected: it would produce wrong splits most of the time (王都: おう is 2 mora, と is 1 — not a 50/50 split), actively misleading a learner rather than helping. Not built as a quick fix for this reason.
- **Jimaku per-season offset/uploader memory, designed but not yet built (un-deferred 2026-07-04).** Cache the chosen Jimaku file/uploader + computed offset keyed per show (and season, since a new season may reasonably use a different uploader); auto-apply on any new episode of an already-configured show, no re-prompt. Today's per-episode manual override (Phase 4) stays available for the rare episode needing a different offset, without overwriting the show-level default. Viewable/clearable by the user.
- **Jimaku search-by-title mismatch, fix decided but not yet built (2026-07-04).** Resolve via TMDB/AniList ID from Crunchyroll metadata, chosen over a fuzzy-search fallback despite more build effort, for reliability — an ID-based lookup doesn't depend on how close Crunchyroll's English title happens to render to Jimaku's JP/romanized indexing.

No technical architecture locked in yet for English subtitle display, furigana-only mode, appearance controls, auto-pause, onboarding, or packaging — this section will populate as design/build work begins on each.

---

## 6. Build Order

Each phase lists what's **done** and what **remains**, remaining items in priority order. Anything gated on another task or deprioritized says so explicitly.

**Phase 0 — Finalize spec** ✅ Complete (this doc).

**Phase 1 — Environment & extension skeleton** ✅ Complete. Basic Manifest V3 skeleton injecting into the Crunchyroll page, verified on a real watch page.

**Phase 2 — Subtitle pipeline proof of concept** ✅ Complete. Query Jimaku for one show, fetch a subtitle file, parse it, display raw Japanese text synced to video playback time (no clicking/dictionary). Verified end-to-end against Witch Hat Atelier ep. 1.

**Phase 3 — Word parsing & dictionary lookup** ✅ Complete.
- Segment parsed subtitle text into clickable words; click/hover → JMdict popup. Verified against Witch Hat Atelier ep 1.
- Merged auxiliary-verb tokens (た/ない/etc.) into the preceding word, fixing wrong lookups on inflected words (生まれた was splitting into 生まれ + unrelated noun 田) — the origin of what's now Rule 3 (see Section 5, Phase 4, Grouping/merge pipeline).
- Popup enrichment: furigana (ruby markup), inflection line, POS labels, common-word badge — each substantially reworked in Phase 4 (see Section 5, Phase 4, Popup content & display).

**Phase 4 — Sync tooling & multi-show validation** ▶ CURRENT

*Done:*
- Offset adjustment UI + hotkeys: ±0.1s buttons, reset, Alt+←/→/0, offset persisted per-episode URL in `chrome.storage.local`
- Batch-testing script (`scripts/batch-test.js`), now reporting 7 corpus-validation patterns
- Multi-show manual testing: Bocchi the Rock! ep 1 (8 bugs found & fixed), Frieren (confirmed working), One Piece ep 894 (no forced-subtitle layer)
- Jimaku entry-selection bug fixed (exact-match preference over `entries[0]`) — see Decisions Log 2026-07-01
- Full grouping-pipeline rebuild (katakana-name inertness, half-width-katakana resolution, speaker-prefix/inline-furigana stripping, Rule 3 rewrite, Rule 0.6, phrase-matcher restructure, dual-view mechanism) — see Section 5 and Decisions Log
- First live-browser pass (Frieren ep 1) fixed でしょう/だろう resolution, 王都-style compound ordering, and 凱旋+です mislabeling — see Section 5 (Grouping/merge pipeline; Popup content & display) and Decisions Log
- こと-style JMdict sense-ordering resolved via TUBELEX — see Section 5 (Homograph/sense ordering via TUBELEX)
- Popup content-decisions spec implemented (POS chip labels, inflection-line rework) — see Section 5 (Popup content & display)
- Follow-up fixes: bare だろ/でしょ resolution, れる/られる/せる/させる/ば merging (pre-existing gap, not a regression), ば conditional absorption added as new scope — see Section 5 (Grouping/merge pipeline) and Decisions Log
- Full corpus validation run (all 3 shows) — caught and fixed a でしょう/だろう regression missed by hand-picked tests (Pattern 2 lookup misses 43→38) — see Decisions Log 2026-07-03
- Further live-testing round: furigana centering, Kuru/Suru chip suppression, TUBELEX cross-contamination fix, full inflection-label descriptor pass — see Section 5; kanji-heteronym disambiguation, この先 dual-view primacy, and duplicate-gloss homographs investigated and logged rather than fixed at the time — see Section 8 and Decisions Log

*Remaining, in priority order:*
1. ⬜ **In progress** — live re-test of the Phase 4 grouping-pipeline rebuild against real Crunchyroll; everything is corpus-validated only so far (see Section 5, Phase 4, for the full list of what's included), not yet re-verified live
2. ⬜ Un-suppress popups for kanji-containing proper nouns (names/places written with kanji) so they behave as ordinary clickable words — decided 2026-07-04, not yet implemented; katakana-only name runs stay fully inert, unaffected (see Section 5)
3. ⬜ Restructure compact JMdict entries to support more than one reading per entry, fixing the multi-reading display-precision bug (くる resolving to 刳る shows as えぐる instead of くる) — decided 2026-07-04 to fix now rather than backlog; not a data prune, ~37,000 (index key, entry) pairs affected dictionary-wide (see Section 5)
4. ⬜ Duplicate-gloss homograph entries (酒/君-style near-identical duplicate readings) — real JMdict-sourced "(archaic)"-style tag where one exists, demotion as fallback otherwise; decided 2026-07-04, full design in Section 5.
5. ⬜ **Manual subtitle file upload fallback (.srt/.ass)** — committed must-have scope that was never scheduled into a phase until now (caught 2026-07-04); own priority slot, gates the start of Phase 5 — see Section 5 for the architecture and Decisions Log for why it's gating
6. Accepted residual edge cases, not scheduled work: があん (rare interjection collision), たの-vs-のか tie-break, occasional harmless dual-view "noise"
7. Conditional, not scheduled: lindera-wasm/Vibrato-wasm benchmark, only if real testing shows a kuromoji quality gap; forced-subtitle overlay test, only if a confirmed-forced-subtitle Crunchyroll title turns up — none has so far, don't actively hunt for one

**Phase 5 — Anki export** (core-loop completion; moved out of the old "differentiation layer" 2026-07-02 — see Section 4)

*Remaining, in priority order:*
1. ⬜ Run the DRM feasibility test against a live Crunchyroll episode (`canvas.drawImage()`, `video.captureStream()`, `AudioContext.createMediaElementSource()`, across ≥2 shows) — gates whether audio/screenshot fields are ever built; if blocked, drop both fields from the roadmap entirely rather than leaving them pending
2. ⬜ AnkiConnect wiring (`fetch()` to `127.0.0.1:8765` from the background service worker)
3. ⬜ Core card fields: target word, reading, gloss, full subtitle sentence with the target word marked (needs the click-time subtitle line threaded into the AnkiConnect call)
4. ⬜ "Anki isn't open" error state with retry — not a silent failure, not an implied fallback to file export
5. ⬜ "Add to Anki" button on the word-click popup; instant send; post-save toast with undo + edit-last-card
6. ⬜ Opt-in metadata toggles (shared between popup and card): POS (ready), frequency-rank badge (ready to build), JLPT (source externally if needed) — decided 2026-07-04, full design in Section 5
7. Open, not scheduled: sentence-only capture with no target word — revisit once there's usage data from the popup-based flow

**Phase 6 — Differentiation & polish**

*Remaining, in priority order:*
1. English subtitle display: fetch English subtitle from Jimaku alongside Japanese, dual-display (Japanese clickable, English non-clickable), hide Crunchyroll's own subtitle layer — also unblocks the deferred sentence-translation Anki field
2. Furigana-only display mode
3. Mono-ruby (per-kanji distributed furigana) — deliberately deferred, not a quick fix; full reasoning and rejected naive-heuristic approach in Section 5
4. Subtitle appearance controls (font size, position, background opacity)
5. Auto-pause on new subtitle line
6. Jimaku search-by-title mismatch fix — needed before the real search UI ships; approach decided 2026-07-04 (TMDB/AniList ID resolution), full reasoning in Section 5
7. Jimaku per-season offset/uploader memory — un-deferred 2026-07-04, now active Phase 6 work; full design in Section 5

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

**2026-07-01 — Three smaller live-testing fixes, each user-directed:** (1) suppress the popup entirely for proper-noun-tagged words with no real JMdict entry, rather than adding JMnedict name translations (deferred, not rejected — narrowed to katakana-only runs 2026-07-04, and the JMnedict deferral itself hardened to a full decline the same day, see below for both); (2) strip speaker-name prefixes ((Name)/Name:) from the display entirely, rather than normalizing both conventions to one style; (3) added a kuromoji-POS-to-JMdict-POS-category definition filter, reusing the particle-filter pattern — confirmed it only helps cross-category collisions (こと's particle sense vs. noun senses), not same-category ones.

**2026-07-01 — こと-style sense-ordering deferred to a dedicated future session**, not solved this session. The ideal domain-specific frequency list no longer exists on GitHub; the Leeds Corpus alternative has an unclear/NOASSERTION license (a risk this project has otherwise avoided). TUBELEX (BSD-3-Clause) looks viable but wasn't investigated further — rejected integrating it in a rushed tail-end addition in favor of giving it its own focused, corpus-validated session. (Superseded 2026-07-03 — see below.)

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

**2026-07-02 — Metadata toggles (POS, common-word, JLPT, frequency-placeholder) share one toggle set across the popup and the card**, not separate settings per surface — avoids the popup and the card silently disagreeing about what's shown for the same word. (Toggle *composition* changed 2026-07-04 — common-word/placeholder replaced by a real frequency-rank badge, see below — but this entry's architecture decision, one shared toggle set, still stands unchanged.)

**2026-07-02 — JLPT tagging scope reversal is narrow, not a full reopening.** In scope only as an opt-in, off-by-default toggle — not an always-visible label/filter/sort. The original exclusion targeted active mid-episode teaching breaking immersion (same reasoning as the AI-explanation exclusion); passive, opt-in metadata the user deliberately enables doesn't do that. Does not reopen the AI-explanation or wordbook/SRS exclusions, which stand for unrelated reasons. If jmdict-simplified doesn't carry JLPT tags at all, sourcing them is a separate, unscoped build task. (Sourcing question resolved 2026-07-04 — see below.)

**2026-07-02 — Frequency-marker toggle ships as a UI placeholder now; underlying logic explicitly not built yet.** Same root cause as the こと sense-ordering gap: jmdict-simplified only exposes a collapsed `common: boolean`. Shipping the placeholder now keeps the toggle set's shape stable while gating the real logic behind the same future dedicated session already planned for こと. Drop the separate common-word toggle once frequency ships for real, not before. (Superseded 2026-07-04 — see below.)

**2026-07-02 — Sentence translation on the Anki card deferred, not rejected**, pending Phase 6's English-subtitle pipeline. Low-cost to defer: if the learner already has the word's meaning from the card, a full sentence translation is mainly a comprehension backstop on a later review, not core value.

**2026-07-02 — Audio/screenshot Anki fields left undecided, gated on a not-yet-run feasibility test**, rather than assuming they're blocked from general DRM/EME research already done this session. That research (Widevine + `canvas.drawImage()`/`captureStream()`) was general, not confirmed against Crunchyroll's actual player — the project's own standard (per the forced-subtitle precedent) is to verify a platform limitation hands-on before closing it out.

**2026-07-02 — Anki capture lives in the existing popup, not a separate gesture.** "Add to Anki" button on the existing word-click popup, sends instantly, undo/edit available after — not a separate line-level hotkey/gesture, and not a pre-send edit step. The separate-gesture idea is speculative demand with no confirmed evidence, carried forward as an open question instead of built. Mirrors a proven pattern (Yomitan, which ManabiDojo's own users are already pairing their tool with). A pre-send edit modal was rejected because it reintroduces the "stop and interact with a form" friction the instant-send/undo pattern exists to avoid.

**2026-07-02 — Anki export moved from the differentiation layer into the core-loop must-have list** (Section 4), reflecting that it's the endpoint of the "capture and keep watching" loop, not an add-on feature.

**2026-07-02 — Jimaku per-season offset/uploader memory pushed to Phase 6, not scheduled into Phase 4/5.** Lower priority than the differentiation-layer work already committed to those phases; a quality-of-life item on top of an already-working manual offset tool, better designed once there's a real, sustained user base to design the memory feature around. Not a "we don't need this" — stays a known, real UX shortfall vs. ManabiDojo. (Un-deferred 2026-07-04 — see below.)

**2026-07-03 — こと-style sense ordering un-deferred and solved via TUBELEX.** Re-verified the candidate first rather than assuming the 07-01 pick was still right: confirmed directly against the actual data (not just docs), BSD-3-Clause license, and its lemma field distinguishes exact kanji spellings (事 vs 琴), not just readings — exactly the missing signal. Rejected re-touching the raw jmdict-eng release: `jmdict-compact.json`'s own index already links every kanji spelling to the same entry as its kana reading, so per-entry frequency scores could be derived entirely from data already in the repo plus the TUBELEX file. Built as a general re-ranking of every multi-entry index key (`scripts/apply-tubelex-frequency.js`), not a こと-specific patch.

**2026-07-03 — 王都-style compound-noun misclassification fixed by excluding pure noun+noun spans from dual-view classification, not by changing the fuse-eligibility gate itself.** The fuse gate already would have accepted these spans — the bug was `isDualViewMatch` claiming them first. Confirmed the fix doesn't regress the case dual-view exists for (もの…なる): that span always has a particle between its boundary tokens, so it's never all-名詞.

**2026-07-03 — でしょう/だろう fixed with a direct override inside Rule 3's own group-construction step, not by relaxing the phrase-matcher's baseline-redundancy filter.** The redundancy filter's job (skip re-checking a span groupTokens already handles correctly) is still valid in general; でしょう/だろう was a case where the baseline grouping's *span* was already right but its *word* wasn't, which the filter can't distinguish. Fixing it at the source (mirroring how Rule 0.6 already special-cases the ん-prefixed んでしょう/んだろう construction) is more robust than patching the filter.

**2026-07-03 — Noun+plain-copula groupings (凱旋+です) relabeled as an explicit "+ です (copula)" attachment, not suppressed entirely.** Both options were on the table; relabeling keeps the copula visible as real information rather than silently dropping it.

**2026-07-03 — Popup content-decisions spec (POS chip labels, inflection-line rework) deliberately scoped to popup text/labeling only, no grouping changes**, even after discovering along the way that られる/れる, せる/させる, and ば weren't merging into the preceding verb at all — flagged as a separate gap rather than silently expanding scope inside a content-only task. Confirmed empirically (no git history existed to check "was it different before") that this was a pre-existing gap from when the allowlist was first written, not a regression: `PURE_INFLECTION_AUX` listed these but Rule 3's absorption check required `pos === "助動詞"`, while kuromoji always tags them `動詞`/`接尾`. Fixed as its own follow-up once flagged, by additionally accepting that tag combination.

**2026-07-03 — ば conditional absorption added, a genuinely new scope decision, approved via the project's own litmus test.** Unlike れる/られる/せる/させる, ば was never in the `PURE_INFLECTION_AUX` allowlist at all — its absence wasn't a bug but a real "should we build this" question. Ran it through the litmus test directly: leaving ば as the one pure-inflection auxiliary not merged was an inconsistency with why て/た merging was already worth doing, not a deliberate line. Gated on `conjugated_form === "仮定形"` so it doesn't misfire on ば's unrelated "place" noun sense.

**2026-07-03 — でしょう/だろう fix extended to the bare conjecture stem (no う), after a user question prompted a re-check for generality.** The original fix only overrode the lookup word once う had actually been absorbed; colloquial そうだろ/そうでしょ (a real, common spoken form, not a truncation) still fell through to だ/です's own definition. Simplified to always use the reconstructed surface rather than gating on whether う was present.

**2026-07-03 — Fixed a real regression in the でしょう/だろう fix, caught by the user-run `scripts/batch-test.js` corpus validation.** `isConjectureCopula`'s gate (`conjugated_form !== "基本形"`) was broader than intended — でした/だった (past-tense です/だ) tokenize with `conjugated_form` values that are also "not 基本形" but aren't the conjecture stem, so the fix wrongly routed their surface string through as the lookup word (no JMdict headword of its own), turning a silent wrong-entry bug into a new lookup miss. Narrowed to the exact signal originally intended (`conjugated_form === "未然形"`), confirmed via a before/after corpus diff (Pattern 2 lookup misses: 43 → 38, all other patterns unchanged). This is the reason the user's own corpus validation mattered — hand-picked test sentences never happened to include a past-tense copula case.

**2026-07-03 — Multi-reading display-precision issue investigated, diagnosis corrected mid-investigation, then deliberately not fixed this session.** Initial hypothesis (an index-corruption bug affecting ~2,500–10,500 entries) was wrong — verified via the raw `jmdict-eng` release that every sampled case was a real multi-reading word, not a data error. Rejected a string-similarity threshold as a tightening tool: it doesn't actually separate the two categories (a confirmed-legitimate case, でけえ/でかい, scored *lower* similarity than the confirmed-bug case that started the investigation, くる/えぐる). Rejected building the entry-splitting-by-reading fix now — user's call, based on the common-flag breakdown (~11.2% of cases involve a common entry) — logged as a known limitation instead, to prioritize later against real-world frequency of occurrence rather than guessing now. (Rescheduled to active work — see later entry below.)

**2026-07-03 — Kanji-heteronym sense-context disambiguation (一行 いっこう vs いちぎょう) rejected as an anchor-to-kuromoji-reading fix, per a check requested before building anything.** Tested kuromoji's per-token `reading` output across several heteronym pairs before deciding: unreliable both in the specific reported case (a segmentation quirk leaves no usable single-token reading at all) and in general (correct for 大分, wrong for 十分/人気). Explicitly rejected pursuing real sentence-level disambiguation to solve this properly, on the same grounds as the AI-grammar-explanation exclusion (meaningfully bigger lift, cuts against the no-AI/no-backend architecture) — logged as an accepted limitation instead. (Reverified and reasoning refined 2026-07-04 — see below.)

**2026-07-04 — Frequency-rank badge graduates from placeholder to a real, built feature; common-word toggle dropped in its place.** Closes a genuine parity gap vs. ManabiDojo's color-coded frequency badges (Section 3.1), following the plan already set on 2026-07-02: the TUBELEX usage-frequency data built for homograph ordering (Section 5) is repurposed to power a user-facing graduated frequency tier, replacing the binary common-word flag rather than sitting alongside it. Rejected building this as an addition to the existing common-word toggle — a graduated signal supersedes a binary one outright, and keeping both would just be redundant UI. (Tier design finalized in a follow-up decision below.)

**2026-07-04 — Kanji ON/KUN reading display rejected as a feature, including as an opt-in toggle.** ManabiDojo has this (Section 3.1), but it fails the product's own litmus test differently than a simple missing feature: ON/KUN readings are kanji-level pedagogy (how to read a character in isolation), not confirmation of the specific word/inflection in context — that's the job of a kanji-SRS tool (e.g. WaniKani) the target user already has and trusts. Making it opt-in doesn't change this, since the objection isn't intrusiveness — it's the same reasoning that excludes AI grammar explanations and the built-in wordbook regardless of how unobtrusively they're offered.

**2026-07-04 — Names dictionary (JMnedict integration) and custom dictionary URL buttons / choice of dictionary source both declined, not just deferred.** Both are real ManabiDojo parity items (Section 3.1) but neither was judged worth building: a dedicated names database adds a second data source and ingestion pipeline for a problem the kanji-name fix below already addresses well enough, and custom dictionary buttons/source-switching cut against the "nothing stands between the learner and the dictionary" positioning (Section 1) — there's one dictionary, not a menu of them. Not tracked as an Open Question or a UX gap to close in Section 3.3, since the user has decided against building either, not merely postponed the decision.

**2026-07-04 — Kanji-containing proper nouns made clickable again, narrowing the 2026-07-01 popup-suppression fix to katakana-only name runs.** The 2026-07-01 fix ("suppress the popup entirely for proper-noun-tagged words with no real JMdict entry") applied uniformly to any 固有名詞-tagged word, katakana or kanji. Reconsidered: kanji names carry real character-level meaning (readings, kanji-level glosses) useful to a learner even without a dedicated name entry, unlike arbitrary katakana transliterations (ヒンメル, アイゼン) which have no meaningful decomposition to show. Kanji-containing names are now excluded from the suppression rule and behave as ordinary clickable words; katakana-only runs remain fully inert (see Section 5), since that inertness targets exactly the case — transliterated fantasy/foreign names — that still has nothing useful to show. Rejected building a JMnedict names dictionary as the fix instead — the actual problem was over-suppression, not missing name-specific data (see the Names-dictionary decision above).

**2026-07-04 — Duplicate-gloss homograph entries get a real JMdict-sourced "(archaic)"-style tag where one exists, demotion as the fallback only.** Original call was demotion alone (mirroring dual-view); refined after reconsidering that JMdict already carries real rarity data for exactly this case — `re_inf` reading-level tags (`ok` = out-dated reading, same tag family as the existing rK/sK kanji-rarity fix) and `misc` sense-level tags (`arch`, `obs`, `dated`). Rejected demotion-only as the final design: it visually deprioritizes the duplicate without ever telling the user why, where a sourced tag (closer to what Jisho shows) is strictly more informative for the same UI cost. Demotion remains the fallback for any duplicate that turns out not to carry one of these tags — not every rare-looking duplicate is formally "archaic" in JMdict's own data, and that needs verifying against the raw release per-case, not assumed. May require adding `re_inf`/`misc` to `jmdict-compact.json` if not already present, the same kind of low-cost regeneration as the 2026-06-24 POS-code addition.

**2026-07-04 — Multi-reading display-precision fix (くる/えぐる-style) rescheduled from backlog to active work.** Supersedes the earlier same-day call to defer this pending real-world frequency-of-occurrence data. User's call: fix it now rather than wait — scheduled into Phase 4/5 (see Build Order). Still requires restructuring compact JMdict entries to support more than one reading per entry, not a data prune (Section 5); the ~37,000 affected (index key, entry) pairs and ~11.2% common-entry overlap already scoped stand as the starting reference for the fix.

**2026-07-04 — JLPT data will be sourced externally if jmdict-simplified doesn't carry it, rather than dropping the toggle.** Closes the standing 2026-07-02 open question. The toggle stays either way — if jmdict-simplified has JLPT tags, use them directly; if not, this becomes an explicit, scoped build task to find and integrate an external JLPT-level source (candidate not yet chosen).

**2026-07-04 — Frequency-rank badge tier design locked in.** 3 text tiers (Common / Uncommon / Rare), no raw numbers, no badge shown when there's no TUBELEX data for a word. Rejected 4 tiers split as Common/Very Common at the top — that split doesn't change what the learner does with either label (both mean "don't dwell"), so it's a distinction without a difference; a 4th tier would be more useful at the *bottom* (e.g. "Very Rare") if ever added, not the top. Rejected showing the raw TUBELEX frequency number — meaningless without context, forces interpretation mid-episode, works against "confirm and keep watching." Rejected defaulting an unranked (no-data) word to "Rare" — same reasoning already applied to the そうか/TUBELEX scoring fix: absence of data isn't evidence of rarity. Exact numeric thresholds per tier are an implementation detail, ideally percentile-based against the real TUBELEX distribution rather than fixed counts — not decided here. Visual treatment (color-coding, iconography) is explicitly out of scope for this decision — bundled into whatever future task designs the Anki/popup card visuals generally.

**2026-07-04 — Jimaku search-by-title mismatch resolved via TMDB/AniList ID resolution from Crunchyroll metadata, over a fuzzy-search fallback.** More build effort than a fuzzy-match layer on Jimaku's own search, but more reliable — an ID-based lookup doesn't depend on how close Crunchyroll's English title happens to render to Jimaku's JP/romanized indexing, which a fuzzy match would.

**2026-07-04 — Romaji subtitle-display toggle excluded, not merely deprioritized.** A subtitle-level romaji layer is a total-beginner feature — it exists for learners who can't read kana yet, which the target user, by definition, already can. Same shape of exclusion as kanji ON/KUN readings (see above): not a priority call, this isn't the product's job for this persona, so it doesn't get built even as a low-priority extra.

**2026-07-04 — Kana-only subtitle-display mode also excluded, for a sharper reason than romaji.** Considered as a possibly-more-useful alternative to romaji, then rejected: kana-only doesn't just fail to help this persona, it actively works against furigana mode, which keeps kanji visible and adds the reading on top — reinforcing kanji the target user likely already studies elsewhere. Stripping the kanji out entirely (what kana-only would do) is a step backward for that goal, not a lighter version of the same feature.

**2026-07-04 — Jimaku per-season offset/uploader memory un-deferred, moved to active Phase 6 work with a concrete design**, superseding the 2026-07-02 "defer until a real user base exists" call. Reconsidered scope: a show's uploader/offset choice is stable for its whole run in practice (not a per-episode judgment call), which removes most of the edge-case design risk that motivated deferring it. Design: cache the chosen file/uploader + computed offset keyed per show (and season, since a new season may reasonably use a different uploader); auto-apply on any new episode of an already-configured show, no re-prompt; keep today's per-episode manual override available for the rare episode needing a different offset, without overwriting the show-level default; viewable/clearable.

**2026-07-04 — Manual subtitle file upload fallback (.srt/.ass) scheduled into its own Phase 4 priority slot, gating the start of Phase 5.** Caught as a real scheduling gap: it's committed must-have scope (Section 4) that had never actually been assigned to a phase. Chosen over bundling it into general Phase 4 work or pushing it to Phase 6 — the user's call was that it should ship on its own, before Anki export work begins, rather than compete for priority with either the current bug-fix backlog or the later UX-polish phase. No new parsing work needed — `subtitle-parser.js` already handles `.srt`/`.ass` from Phase 2; this is the user-facing upload flow only.

**2026-07-04 — Sentence-only capture reconsidered and kept deferred, with the reasoning corrected.** The original "speculative demand, no confirmed evidence" framing was too dismissive — reviewing it again surfaced a real use case (a sentence with no confusing vocabulary can still be worth saving for other reasons), genuinely distinct from what target-word capture covers. Rejected building it now anyway: it needs its own capture paradigm (a line-level trigger, and a design decision for what fills the word/reading/gloss fields with no target word), not a toggle on the existing flow, and the user's own expectation is it will come up less often than ordinary target-word capture. Real post-Phase-5 usage of the word-click flow is a better signal than guessing now.

**2026-07-04 — Kanji-heteronym disambiguation reverified before accepting it permanently; reasoning refined, conclusion unchanged.** The original 2026-07-03 entry correctly ruled out one approach (anchoring to kuromoji's own reading signal — confirmed unreliable) but its "logged as an accepted limitation" framing understated that a second approach was never actually evaluated: a small hardcoded lookup per heteronym pair (e.g. "一行 preceded by 勇者/私たち-type words → いっこう, otherwise いちぎょう"), which is technically buildable without AI or a backend. Re-evaluated and still rejected — not because it's impossible, but because it doesn't scale: every ambiguous heteronym pair would need its own hand-curated collocate list, maintained indefinitely as new cases surface, the same whack-a-mole pattern already rejected once for kana-merge (hardcoded broken-word list, superseded by the general `findKanaMergeCandidates` mechanism). Only one confirmed real occurrence of this problem exists so far (一行), which doesn't justify that maintenance burden. Accepted as a permanent limitation on scope/maintenance grounds, not technical impossibility.

**2026-07-04 — この先 dual-view primacy severity assessed as low before accepting it permanently.** Checked for other reported instances of this exact pattern (demonstrative + noun competing with a lexicalized idiom) — none exist in testing so far; a hypothetical parallel (そのうち, "eventually" vs その+うち compositionally) illustrates the same shape but hasn't actually been encountered. Severity judged low because dual-view doesn't hide either reading: the individual-word definitions (この/先) and the "Also, as a set phrase" note are both displayed together with no extra click required to see the second one, unlike the multi-reading bug (wrong furigana shown with no indication anything's off) or duplicate-gloss noise (two contradictory-looking cards). Worst case is a moment of the first reading not quite fitting, immediately resolved by the adjacent note — accepted as-is on that basis, not left unexamined.

---

## 8. Open Questions

### Ongoing

Two of the ten previously-listed items — kanji-heteronym disambiguation and この先 dual-view primacy — turned out to already be fully settled (reverified and accepted permanently, with Decisions Log entries) rather than genuinely open; moved to Resolved below.

**Needs testing or real-world feedback to resolve:**
1. **Forced-subtitle overlay behavior** — still fully untested hands-on. Deprioritized, and skepticism is warranted: no research or testing so far has turned up a single Crunchyroll title with an actual untoggleable forced-subtitle layer (One Piece ep 894 confirmed clean; nothing else has surfaced one either). Treated as speculative until a real case appears — don't invest further design thought here without one. *(Phase 4)*
2. **lindera-wasm vs. Vibrato-wasm fallback** — which is the better choice if kuromoji.js segmentation quality proves insufficient on colloquial/slang-heavy dialogue. Deferred until real testing shows a gap. *(Phase 4)*
3. **`jmdict-compact.json`'s 3-sense/5-gloss cap** — does this lose meanings that matter for highly polysemous words in practice? Revisit if Phase 4 testing surfaces an incomplete or contextually-wrong definition. *(Phase 4)*
4. **Dual-view "noise"** — the mechanism sometimes attaches a real-but-not-strictly-relevant coincidental match. Non-destructive; accepted as an inherent trade-off unless live testing shows it's genuinely distracting. Confirmed real-corpus instance 2026-07-03: もの…になる attaches a wrong idiomatic gloss ("to prove successful") to a sentence where もの is used compositionally, not idiomatically — a different failure mode (a wrong gloss shown with equal weight, not just an extra click) but still non-destructive, so priority stays as scoped. *(Phase 4)*
5. **Audio/screenshot Anki fields — feasibility test designed, not yet run.** Test `canvas.drawImage()`, `video.captureStream()`, and `AudioContext.createMediaElementSource()` against a live Crunchyroll episode, across ≥2 shows, to confirm whether Widevine DRM blocks frame/audio extraction. If blocked, drop both fields from the roadmap entirely (not defer) and log as a confirmed platform limitation. *(Phase 5)*
6. **Sentence-only capture, no target word** — reconsidered 2026-07-04: the use case is real (a sentence with no confusing vocabulary can still be worth saving), not just speculative, but it requires its own capture paradigm (a line-level trigger, decisions about what fills the word/reading/gloss fields with no target word) rather than a toggle on the existing flow — real build cost, not a quick add. Kept deferred rather than cut: expected to come up less often than ordinary target-word capture, and real usage of the word-click flow post-Phase-5 will show whether it's actually needed better than guessing now. *(Phase 5)*
7. **Pricing specifics** — monthly and lifetime price points. Model is decided (subscription + lifetime); exact numbers revisit after soft-launch feedback. *(Phase 7)*

**Needs an actual decision to resolve:**
1. **Auto-offset-detection on Jimaku import** — real, still-open UX gap vs. ManabiDojo (Section 3.3): aligning subtitle sync automatically against the platform's native subtitle track, rather than requiring a manual nudge the first time. No decision made yet; not investigated in the same pass as the other two Jimaku-import gaps (per-season memory, title-search mismatch), which are both now resolved. *(Phase 6)*

### Resolved

- **Te-form auxiliary chains** (2026-06-30) — handled by Rule 1 (split into main-verb+て / auxiliary) and Rule 2 (contracted forms). Verified against 食べてしまった, 話しかけてくれる, 持っていった, 見てる, 読んでいる — 89 occurrences across 1236 lines (~7%) in the first batch run.
- **Fullscreen subtitle visibility** (2026-06-30) — fixed via `getContainer()` + `fullscreenchange` re-parent listener; verified on Bocchi ep 1.
- **ASS simultaneous multi-line subtitles** (2026-06-30) — fixed via `cues.filter()` + `.join("\n")` instead of `cues.find()`.
- **Inline furigana in subtitle files** (2026-07-01) — stripped via `INLINE_FURIGANA_RE` per user request (redundant with click-to-check, looked cluttered).
- **One Piece ep 894 forced-subtitle status** (2026-07-01) — confirmed this episode does NOT have Crunchyroll's forced-subtitle layer; that interaction remains untested (see Ongoing, "Forced-subtitle overlay behavior").
- **んだろう/んでしょう showing bare ん's wrong sense** (2026-07-01, second round) — turned out to be a missing-construction problem (JMdict has no headword for the extended forms), not an entry-ranking problem like こと/いる. Fixed with dedicated Rule 0.6, not entry ranking.
- **それも and ないと "no entry" assumptions** (2026-07-01, second round) — both turned out to have real JMdict entries the original bug report assumed didn't exist. それも: confirmed real, left as-is. ないと: also real, routed through the と dual-view carve-out specifically.
- **Anki export design** (2026-07-02) — AnkiConnect over offline export; core fields = word + reading + gloss + full sentence. See Decisions Log 2026-07-02.
- **Capture-action UX** (2026-07-02) — "Add to Anki" button on the existing popup, instant send, undo/edit-last-card after. See Decisions Log 2026-07-02.
- **こと-style JMdict sense-ordering** (2026-07-03) — solved via TUBELEX-frequency integration (`scripts/apply-tubelex-frequency.js`), a general re-ranking mechanism, not a こと-specific patch. See Decisions Log 2026-07-03.
- **でしょう/だろう resolving to です's own definition** (2026-07-03) — real bug (not the earlier, already-resolved んだろう construction issue), fixed in Rule 3's group-construction step. See Decisions Log 2026-07-03.
- **王都-style compound-noun ordering** (2026-07-03) — fixed by excluding pure noun+noun spans from dual-view classification. See Decisions Log 2026-07-03.
- **凱旋+です noun+copula mislabeling** (2026-07-03) — relabeled as "+ です (copula)" rather than suppressed. See Decisions Log 2026-07-03.
- **れる/られる, せる/させる, ば not merging into the preceding verb** (2026-07-03) — れる/られる/せる/させる was a real, never-working gap (confirmed not a regression); ば was genuinely new scope, approved via the litmus test. Both fixed. See Decisions Log 2026-07-03.
- **でしょう/だろう fix's bare-form gap** (2026-07-03) — original fix only covered でしょう/だろう with う present; extended to also cover colloquial bare だろ/でしょ. See Decisions Log 2026-07-03.
- **な (大事なことさ) showing だ+た as equally-weighted cards** (2026-07-03) — traced to the TUBELEX cross-reading contamination bug, fixed there; separately, な itself now gets its own inflection label ("な (attributive)") instead of showing none. See Section 5 (Homograph/sense ordering via TUBELEX; Popup content & display).
- **んだ/んです wrongly labeled "た-form"** (2026-07-03) — Rule 0.6's ん+copula-family construction was falling through to the generic verb-past-tense だ table entry; given its own "んだ (explanatory)" / "んです (explanatory, polite)" labels. See Section 5 (Popup content & display).
- **Inflection-label plain-English descriptors** (2026-07-03) — every label now includes a short parenthetical (て-form (connective), ない-form (negative), etc.); だ/です copula labels split into three distinct wordings (copula / polite copula / polite) based on whether the preceding word is a noun or い-adjective. See Section 5 (Popup content & display).
- **Duplicate-gloss homograph entries shown as separate, equally-weighted cards** (2026-07-04) — decided on a two-tier fix: a real JMdict-sourced "(archaic)"-style tag (from `re_inf`/`misc` data) where the duplicate reading actually carries one, demotion to a secondary note (mirroring dual-view) as the fallback otherwise. Scheduled into Phase 4 Build Order; needs verifying against raw JMdict whether specific cases like 酒/君 actually carry the tag, and the demotion comparison rule is still TBD. See Decisions Log 2026-07-04.
- **Multi-reading entries displaying the wrong reading, prioritization** (2026-07-04) — decided to fix now rather than backlog it. Scheduled into Phase 4 Build Order. See Decisions Log 2026-07-04.
- **JLPT tag sourcing** (2026-07-04) — decided to source externally if jmdict-simplified lacks the data; toggle stays either way. See Decisions Log 2026-07-04.
- **Jimaku search-by-title mismatch** (2026-07-04) — decided in favor of TMDB/AniList ID resolution over a fuzzy-search fallback. Scheduled into Phase 6 Build Order. See Decisions Log 2026-07-04.
- **Jimaku per-season offset/uploader memory** (2026-07-04) — un-deferred; decided to build with a per-show/season caching design. Scheduled into Phase 6 Build Order. See Decisions Log 2026-07-04.
- **Romaji toggle investment level** (2026-07-04) — resolved by excluding it entirely, not a priority call. See Decisions Log 2026-07-04.
- **Shows with zero Jimaku subtitles available at all** (2026-07-04) — resolved: this *is* what the manual upload fallback (Section 4; scheduled Phase 4, see Build Order) handles — a zero-Jimaku-results state becomes an upload prompt rather than a dead end. Only remaining detail is empty-state copy, not a design decision.
- **Pricing specifics** (2026-07-04) — reviewed and reconfirmed: kept deferred to post-soft-launch, since it doesn't block any coding work. No change from the original 2026-06-30 pricing-model decision.

---

## How to use this doc

**project-plan.md is the full source of truth.** `CLAUDE.md` is a short session-start briefing (goals, litmus test, current priorities, working-style rules) that points back here for detail — it should not duplicate this document's content, only summarize what's needed to start a session.

### Formatting rules — read before editing this document

These are not suggestions; a session that writes into this doc without following them needs to be corrected before the next session starts. If you (Claude Code) find yourself about to write a paragraph into Section 6, or a decision title that's a full sentence, stop and re-read this list.

- **Decisions Log entries are ALWAYS `**Date — Short bolded title.** Reasoning/rejected-alternative in plain text after.`** The bolded part is a short label (under ~12 words) someone could scan in a list of 50 entries and immediately know what it's about — never a full recap of what happened. Bad: `**2026-07-03 — After investigating whether kuromoji's reading field could be used to disambiguate 一行 in context, we determined it could not because of a segmentation quirk and inconsistent behavior on other heteronyms, so we logged it as an accepted limitation.**` Good: `**2026-07-03 — Kanji-heteronym sense-context disambiguation (一行) rejected as an anchor-to-kuromoji-reading fix.**` followed by the detail as normal sentences below.
- **Only genuine decisions go in the Decisions Log.** Test: "what did you choose this over?" If the honest answer is "there was nothing else to do" — confirming an API contract, discovering a platform limitation, verifying a fact — it's a finding, and it belongs in Section 5 (Technical Architecture) instead, dated inline, not logged as a decision.
- **If a decision revises an earlier one, don't add a new entry — find the original and update it** (or add a one-line "(Superseded on [date] — see below)" pointer if the revision is big enough to deserve its own entry, as with the こと sense-ordering deferral). Do not let the same decision appear twice with two different titles.
- **Section 5 (Technical Architecture) is organized by category, not a flat list.** General/cross-cutting architecture first, then grouped by build phase in Section 6's own order (Phase 1–2, Phase 3, Phase 4, Phase 5, Phase 6–7). When adding a new entry, place it under the phase it actually belongs to (usually the phase where it was built or where the bug was found) — don't just append to the end of the section. If a phase category doesn't exist yet because nothing's been built for it, add a one-line placeholder (see Phase 6–7) rather than omitting the heading.
- **Section 5 (Technical Architecture) entries are current-state descriptions, not session logs.** Each bullet describes what's true *now*, with the date it became true in parentheses inline. If something was fixed, then fixed again differently, only describe the final state — don't keep the superseded description around "for history." History lives in the Decisions Log.
- **Section 6 (Build Order) "Done" bullets are one line each**, summarizing what shipped, not narrating how it was built or why. If a bug fix needs more than one line to explain, that explanation belongs in Section 5 (what changed technically) and/or Section 7 (what was decided) — the Build Order bullet just says what got fixed and points there implicitly (it doesn't even need "see Section 5" on every line; that's the default assumption for this doc).
- **Section 8 (Open Questions) entries are 2–4 sentences max.** State the question, why it's open, and what would resolve it. Do not paste a full investigation narrative — if the investigation is worth preserving, it's a Decisions Log entry (if concluded) or belongs summarized in Technical Architecture (if it's a standing limitation).
- **Ongoing questions are split into "Needs testing or real-world feedback" and "Needs an actual decision."** Test for which bucket: would a test/corpus result/usage data resolve this on its own, or does a person need to weigh options and choose? If neither applies — the reasoning is already fully worked out and accepted — it's not Ongoing at all; it belongs in Resolved (or wasn't a genuine open question in the first place).
- **Before adding anything to Resolved, check it isn't already fully covered by a Decisions Log entry or a Section 5 entry.** A one-line pointer ("see Decisions Log [date]") is the right shape; restating that entry's reasoning in full is duplication and should be trimmed to just the pointer, or dropped from Section 8 entirely if the pointer is all there'd be.
- **Never duplicate the same fact across two sections.** If a technical fact and the decision behind it are both worth recording, split them: the *current state* goes in Section 5, the *reasoning/rejected alternative* goes in Section 7, and each references the other only if needed — don't restate one inside the other in full.
- **Never cross-reference an Open Questions or Build Order item by number** (e.g. "see Ongoing #3"). These lists get reordered whenever an item resolves and the rest renumber — a numbered reference goes stale silently the very next edit. Reference by name instead (e.g. "see Ongoing, 'Forced-subtitle overlay behavior'"), which stays correct regardless of position.
- **Update the `_Last updated:_` date at the top of the file whenever you edit it.**

### End-of-session update checklist

1. Update Section 6 (Build Order): move completed items from "remaining" to "done" **as one-line bullets** (see formatting rules above), add any newly-discovered remaining items in priority order.
2. Scan the session for genuine decisions (per the test above). Add qualifying ones to Section 7 with a short bolded title, in date order. If a decision revises an earlier one, consolidate — don't duplicate.
3. Update Section 8: move resolved questions to "Resolved" (one line, pointing to the Decisions Log entry that resolved it if there is one — don't restate its reasoning); add new ones to "Ongoing" under the correct subsection (needs testing/feedback vs. needs a decision), in phase-priority order within each, in 2–4 sentences each.
4. If a real architectural or technical detail changed, update Section 5 directly — describe the new current state, don't append a second description alongside the old one.
5. Check Section 3 (Competitive Landscape) and Section 4 (V1 Scope) for drift — e.g. a feature moving between "differentiation" and "core loop," or new competitor findings — and update in place rather than leaving stale claims.
6. Update the `_Last updated:_` date at the top of this document.
7. If nothing decision-worthy happened (pure implementation, no surprises), say so explicitly in the session's chat response rather than skipping the check silently — but this doc itself doesn't need an edit in that case.
