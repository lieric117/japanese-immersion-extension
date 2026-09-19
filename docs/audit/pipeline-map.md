# Pipeline map — show detection and subtitle parsing/segmentation

Phase 0 of the 2026-09-18 correctness audit. Traced from the code at commit `c1c95b2`, not from the project plan. Each stage lists its inputs and outputs, and marks with **⚠** every place a wrong result can get through *silently*: no error, no log, no visible sign on screen. `file:line` references point at `c1c95b2`.

"Silently" is the key word. A stage that fails loudly (throws, shows the manual-upload message, shows the entry picker) is safe by this project's rules. The only unsafe outcome is a confident wrong answer, because those end up in permanent Anki cards.

---

## A. Show detection: Crunchyroll episode → Jimaku subtitle file(s)

```
 page DOM ──D1──▶ detected{series, season#, seasonName, episode#, episodeTitle}
                    │
   triggers ──D2────┤  (init / 1s pathname poll + popstate / 2s watchdog / 500ms retries)
                    │
 chrome.storage ─D3─┤  uploaderPref / entryPref / siblings cache, keyed on detected fields
                    ▼
            FETCH_SUBTITLES (content.js:1076)
                    │
      ┌─────────────┴──────────────┐
      ▼ preferredEntryId set        ▼ otherwise
   D4 filesFromRememberedEntry   D5 resolveTextFiles
      └─────────────┬──────────────┘
                    ▼
            D6 rankFiles + applyFileHint → pick → fetchAndParseFile
                    ▼
            D8 content.js callback: `cues = response.cues`
                    ▲
   D7 manual paths: FETCH_ENTRY_FILES (entry picker), FETCH_SUBTITLE_FILE (file picker)
```

### D1 — `detectShowEpisode()` (content.js:66)
- **In:** every `<script type="application/ld+json">` on the page.
- **Out:** the first block with `@type: "TVEpisode"`, reduced to `seriesTitle` (`partOfSeries.name`), `episodeNumber` (numeric code from `name`'s `| E<n> -` if present, else `episodeNumber`), `seasonNumber`, `seasonName` (`partOfSeason.*`), `episodeTitle` (raw compound `name`).
- ⚠ **Stale block after SPA navigation.** The pathname changes before Crunchyroll replaces the JSON-LD. D1 cannot tell a stale block from a fresh one. It parses fine either way.
- ⚠ **More than one `TVEpisode` block.** First one wins, silently. Never observed; noted as unverified.
- Numeric code vs `episodeNumber` disagreement: logged once (content.js:88). Non-numeric code (`EEX`, `E14.5`): D1 falls back to `episodeNumber`, and D5's `episodeCodeKind` then treats the page as unnumbered. Loud in the log, safe.

### D2 — load lifecycle (content.js:1010 `loadSubtitles`, 1480 locationchange, 1550 watchdog)
- **In:** navigation events, the D1 output, `lastLoadedIdentity`.
- **Out:** a `FETCH_SUBTITLES` request. Its callback installs `cues`.
- The identity used for staleness and for the watchdog is `series seasonNumber episodeNumber` (content.js:413).
- ⚠ **Identity collisions.** Measured on the three live catalogue captures: **37 real episodes share this key with a different episode** (e.g. Shangri-La Frontier S1 ep14 and its 14.5 bonus; Solo Leveling; Slime; Attack on Titan; Fate/UBW ep 0). Navigating between two of them reads as "stale" for 1s, and the watchdog can never notice that it loaded the wrong one.
- ⚠ **Stale after retries → loads anyway.** When the JSON-LD still reports the previous episode after two 500ms retries, `loadSubtitles` goes ahead with the stale identity and loads the previous episode's file under the new episode (content.js:1035–1046). The watchdog repairs it later, but only if the identities differ; see the collisions above.
- ⚠ **No request/response binding.** The `FETCH_SUBTITLES` callback assigns `cues = response.cues` unconditionally (content.js:1098). Navigation fires a new load without cancelling the one in flight. Resolution takes several seconds when retries are involved, so if the previous episode's response lands last, **it overwrites the current episode's cues**, with no error. The entry-picker (content.js:1726) and file-picker (content.js:1783) callbacks have the same shape.

### D3 — per-season memory (content.js:971, 985, 205, 937)
- **In:** `seriesTitle`, `seasonNumber` (and `seasonName` for the sibling cache).
- **Out:** `preferredUploader`, `preferredEntryId`, `siblingTitles`.
- `entryPref` / `uploaderPref` / `offsetProvider` keys are `series:seasonNumber`.
- ⚠ **Key collisions between different works.** Measured on the live captures, 6 season slots are shared by genuinely different seasons, films included: `("Mobile Suit Gundam", 1)` = the TV dub **and** the film *Char's Counterattack*; `("KONOSUBA", 3)` = S3 dub **and** the film *Legend of Crimson* dub; FGO Babylonia dub **and** the film *Solomon*; Gintama's four season-1 slots. An entry picked for one is **used for the other**. Pages with no season at all share `series:?`.

### D4 — `filesFromRememberedEntry` (background.js:2366)
- **In:** the remembered entry id and the episode number.
- **Out:** the file list, marked `entryConfident: true, entryRemembered: true`.
- ⚠ **Unfiltered fallback for episodic content.** If `?episode=N` returns nothing, it returns the entry's **entire** file list, and `rankFiles[0]` is loaded, i.e. whichever episode that happens to be. D5 explicitly forbids this for episodic content ("doing this for a real episode would happily serve some other episode's subtitles", background.js:2203). D4 skips that guard entirely, along with every other D5 check: filter disagreement, archives-only, wrong-episode answer, cour/offset retries.
- ⚠ Combined with the D3 collisions, a film's remembered entry becomes a TV season's subtitle source with no warning beyond "Using the Jimaku entry you picked".
- `fileHint` is applied **unscoped** here (background.js:2408). That's the pre-2026-07-17 bug the scoped `applyFileHint` fixed. It changes which uploader is picked, not which episode.

### D5 — `resolveTextFiles` (background.js:1626)
Stages, in order:
1. **Search ladder** (`searchQueryLadder`): full title → after last colon → drop trailing words (≤6 rungs, only on zero results).
2. **Later-season broadening:** when the season name says "not season 1" and the results look like one work, search more ladder rungs and merge.
3. **Episodic classification:** `isEpisodic = hasSeasonSignal && !sideFormat && !standalone && !unnumbered`.
4. **Content-title searches** (non-episodic only): up to 2 searches on the page's own title, merged if they share the franchise; `soloHit` recorded.
5. **Tier cascade**: `nameMatch ?? contentMatch ?? classMatch ?? soloHit ?? seasonMatch ?? safeTitleMatch ?? safePlainMatch`. Guards: `unidentifiableSideFormat` (film/stage not named), `franchiseFallbackUnsafe` (split franchise, or a season name that says it's a later season).
   - No tier matches → `unresolved` (the picker; safe).
6. **File retrieval** (episodic): `?episode=N`; locally re-resolved when the answer disagrees on 第N話, is archives only, or states a different 第N話. Then retries in order: cour sibling (with coverage check and a conflicting-file drop), continuation cour (numbering must continue), offset from Jimaku's episode 1, second-numbering offset, single-unnumbered-file special.
7. **File retrieval** (non-episodic): full listing, narrowed by the content title and then by numbered part, otherwise excluding other episodes' titles. The whole list is refused when only the series title matched and the files name episodes.
8. **Archive filter**, then return.
- ⚠ **Episode identity of the final list is never checked as a whole.** Only the cour retry drops files that state a different episode. On the main path, `?episode=N` is trusted unless one of the three 第N話-keyed triggers fires. Two unguarded shapes:
  (a) **season mixing**: `S01E05` and `S02E05` both state episode 5. Nothing reads the season part, and the audit's `MIXED` check doesn't either (its `statedIdentity` discards `Sxx`);
  (b) **an answer where no file states N but some state other episodes**, on an entry without 第N話.
- ⚠ **Title normalization gaps.** `looseTitle`/`normalizeTitle` do no Unicode compatibility folding (full-width ASCII, `×` vs `x`, `～` vs `~`, macrons). Usually this shows up loudly as a miss (the picker). It's silent only where a *lower* tier then succeeds on a different entry.
- ⚠ **Episode 0.** `?episode=0` behaviour on Jimaku's side is unverified (a falsy 0 might be read as "no filter"). A prologue coded `E0` is classed as episodic.

### D6 — ranking and pick (background.js:583, 573, 2447)
- Uploader preference order, then `fileHint` within the top uploader. Only ever chooses *among* files D4/D5 returned, so it can't introduce a wrong episode that wasn't already in the list. It decides which of several wrong ones gets shown, though.

### D7 — manual paths
- `fetchEntryFiles` (background.js:2503): the same ⚠ unfiltered fallback as D4. This is the picker's *first* load, so the user sees the list, but the auto-picked file from an unfiltered episodic listing is still arbitrary.
- `fetchSubtitleFile`: the user chose the exact file. Correct by definition.

### D8 — installing cues (content.js:1098, 1726, 1783, 1852)
- ⚠ See D2. Nothing ties the arriving `cues` to the page identity they were requested for.

---

## B. Parsing and segmentation: raw subtitle file → tokens, readings, lookups

```
 file text ─P1─▶ cues[{start,end,text,style,align}] ─P2─▶ dual-language strip
      ─P3─▶ japaneseDisplayAt(t): join of all cues active at t (with "\n")
      ─P4─▶ cueDisplayText: ASS tags → markup → stage-direction drop → speaker prefix
                              → inline furigana → 。→space → half-width kana
      ─P5─▶ kuromoji tokens
      ─P6─▶ phrase candidates → JMdict membership → fuse/dual-view → groupTokens(Rules 0–3)
      ─P7─▶ kana-merge → trailing-っ suppression → katakana un-suppress → katakana-name suppress
      ─P8─▶ renderGroups: spans with running character offsets (Anki uses these)
      ─P9─▶ click → LOOKUP_WORD(word, isParticle, pos, isHonorificSuffix) → lookupWord
```

### P1 — `parseSrt` / `parseAss` (subtitle-parser.js)
- ⚠ **SRT timestamps with `.` instead of `,`** (`00:00:01.500`): `sMs.split(",")` gives `ms = undefined`, so the time is `NaN`, and the cue never matches any playback time. It's **silently dropped from display** (no error).
- ⚠ **SRT HTML markup** (`<i>`, `<font color=…>`, `<b>`): not stripped anywhere. It renders as literal text and goes to the tokenizer and Anki.
- ⚠ **ASS escapes other than `\N`**: `\h` (hard space) is left in as literal `\h`. `\n` (soft break) is converted to a hard line break.
- ⚠ **ASS vector drawings** (`{\p1}m 0 0 l …{\p0}`): the tags are stripped, and the drawing path renders as a line of "dialogue".
- ⚠ **ASS time with a malformed field count**: `fields[1]`/`fields[2]` throws on a short `Dialogue:` line, and **the whole file fails to parse**. That one is loud.
- `Comment:` events are skipped (correct).

### P2 — `stripDualLanguageCues`
- Keeps styles with >50% kana. ⚠ A Japanese style that is mostly kanji-only lines (e.g. sign typesetting) could be dropped. It fails open when nothing is Japanese.

### P3 — `japaneseDisplayAt` (content.js:2263)
- ⚠ **Duplicated layered events.** Typesetters often emit the same line twice (a shadow layer plus a fill layer, or a karaoke fx duplicate). Both are active, so the text renders **twice**, and goes into Anki twice.
- ⚠ **Line breaks inside a word.** Joining cues, or a `\N` in the middle of a word, puts `\n` inside the tokenizer input, which forces a token boundary in the middle of the word.

### P4 — `cueDisplayText` (content.js:2297)
- ⚠ `SPEAKER_PREFIX_RE` strips **any** text up to 12 characters before the first `:`/`：`, e.g. `10:30に集合` → `30に集合`, and `ルール：…` loses its head noun. Silent text loss.
- ⚠ `STAGE_RE` drops a line that is **entirely** parenthesised, which is also how many releases write inner monologue: `（どうしよう…）`. Inherently ambiguous (see taxonomy). It's also blind to a stage direction that doesn't span the whole line (Open Question #14).
- Multi-line cues: speaker-prefix stripping applies only to the first line.

### P5 — kuromoji tokenization
- Assumed lossless (tokens concatenate back to the input). **Not verified anywhere** before this audit.
- ⚠ `JAPANESE_WORD_RE` (tokenize-utils.js:9) doesn't cover CJK Extension B+ (surrogate pairs, e.g. `𠮟る`), CJK Compatibility Ideographs, or `々`/`〆` on their own. A token made of those becomes plain unclickable text. Not wrong, just silent.

### P6 — phrase matching + `groupTokens`
- Groups carry `tokenStart`/`tokenEnd`. Fuse spans are gated on JMdict existence plus a POS/length gate. Dual-view never replaces anything.
- ⚠ A fuse that isn't there to fix a kuromoji error but just coincides with an unrelated headword replaces correct individual words (the historical いた→板, してい cases). It's guarded by baseline alignment and the gates, but there's no systematic measurement of how often a fuse's POS disagrees with its constituents.

### P7 — post-passes
- `applyKanaMerges`, `suppressTrailingSokuon`, katakana (un)suppression rebuild groups **without** `tokenStart`/`tokenEnd`/`pos`/`isParticle`. The merged group looks up with no POS filter, which is intended.
- ⚠ Losslessness here depends on each pass concatenating surfaces correctly. It's asserted nowhere.

### P8 — `renderGroups` (content.js:2064)
- Records `startOffset` = the running sum of `group.surface.length`. **Assumes** the groups concatenate to the displayed text. If they don't, the Anki capture bolds the wrong characters (the offset drifts). Unchecked.

### P9 — `lookupWord` (background.js:2646)
- The lookup key is kuromoji's `basic_form` (or a fused/merged surface). Candidates come from the JMdict index, then fallbacks: numeral synthesis, vowel-elongation collapse, godan potential. Then POS filters, which only ever *narrow*, never to zero.
- Ambiguity isn't hidden: **every** remaining homograph entry is rendered, ordered by frequency, and the user picks which one to send to Anki. This is the existing graceful-degradation path for sense ambiguity.
- ⚠ **Lemma drift.** When kuromoji mis-segments, `basic_form` can be a real but *unrelated* word (the historical `っ` → `く` → 句/区/九). The popup then shows a confident, wrong entry for text that isn't on screen. There's no check that the looked-up lemma is consistent with the displayed surface.
