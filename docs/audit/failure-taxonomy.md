# Failure taxonomy — built from the input space, not from known bugs

Phase 1 of the 2026-09-18 audit. Each row is a *category of input* that could produce a wrong result, followed by its coverage **before** this audit (commit `c1c95b2`) and **after** it. The final state is filled in as fixes land (see `progress.md`).

Coverage key:
- **C**: covered by a pinned test.
- **P**: partially covered, or handled in code but not pinned.
- **N**: not covered.
- **D**: deliberately declines. That's safe by design: the picker or the manual-upload message is shown.

Evidence key:
- **live**: measured against the live API or live-captured Crunchyroll data.
- **code**: read from the code.
- **synthetic**: shown on a hand-built input (a guess about real inputs until the corpus confirms it).

## 1. Show detection

### 1a. Page metadata (Crunchyroll JSON-LD)
| # | Input category | Failure if mishandled | Before | Evidence |
|---|---|---|---|---|
| A1 | No/unparseable `TVEpisode` block | nothing to resolve | P (returns null → upload message; untested) | code |
| A2 | **Stale block after SPA navigation** | previous episode's subtitles under the new episode | P: 1s of retries, then **loads the stale identity** → **after: 5s wait; nothing shows meanwhile; responses bound to identity (C: test-subtitle-binding)** | code |
| A3 | Two `TVEpisode` blocks | first wins, silently | N → **after: disagreeing blocks = not yet detectable (C: test-detect-show-episode)** | code |
| A4 | Episode code forms: numeric, `EEX`, `SP1`, `P1`, `I/II/III`, `14.5`, `0`, none, duplicated-title film | wrong position | C (numeric, EEX, 14.5, 0-film, film); P (`SP1`, roman) | live |
| A5 | `episodeNumber` ≠ title code | wrong episode | C | live |
| A6 | `seasonNumber` positional / non-unique / unbounded | wrong season | P: **the number was still trusted for a distinctly named, unmarked season (Kaiju No. 8: Mission Recon → Season 2, live)** → **after: C, never matched by position alone (test-named-season)** | live |
| A7 | No `partOfSeason.name` | falls back to the number | P | live |
| A8 | **Two different episodes share the load identity** | staleness check and watchdog can't tell them apart | **N** — 37 real episodes collide → **after: C, 0 collisions over 6,997 (test-detection-identity)** | live |
| A9 | **Two different works share the per-season memory key** | a remembered pick crosses works | **N** — 6 real season slots collide, 3 of them a TV season with a film → **after: C, 0 over 231 seasons** | live |

### 1b. Title and season naming (Crunchyroll vs Jimaku)
| # | Input category | Before | Evidence |
|---|---|---|---|
| B1 | Season markers: `2nd Season`, `Season 2`, roman, bare trailing number, `Part/Cour N`, `Final Season` | C | live |
| B2 | Word-form markers: `Second Season`, `Season Two`, `2nd Cour`, `Part II`; **mid-name `Season 1: Director's Cut`** | N → **after: mid-name `Season N` read on Crunchyroll's side (C); Jimaku-side census pending** | code |
| B3 | Arc-named seasons (Jimaku `STONE WARS` vs CR `Season 2`) | D (declines, remembered pick) | live |
| B4 | Sequel/localised titles with no shared text (`√A`/`Root A`, `Case Closed`/`Detective Conan`) | D — inherently ambiguous without a title map | live |
| B5 | Year suffixes (`Fruits Basket (2019)`) | C | live |
| B6 | Punctuation, apostrophes, separators | C (`looseTitle`, apostrophe strip) | live |
| B7 | **Unicode compatibility variants** (full-width ASCII, `×`/`x`, `～`/`~`, macrons `ō`/`ou`) | N | code |
| B8 | Audio/edition qualifiers `(English Dub)`, `(Dub)`, `Special Edition` | C | live |
| B9 | Side formats: OVA/OAD/ONA, film, special, recap, picture drama, stage | C | live |
| B10 | Content with no Jimaku entry at all | D | live |

### 1c. Episode numbering
| # | Input category | Before | Evidence |
|---|---|---|---|
| C1 | CR absolute vs per-season numbering | C (magnitude rule, offset probes) | live |
| C2 | Jimaku uploaders mixing absolute and per-season numbering inside one entry | C (second numbering, offset from ep 1) | live |
| C3 | Fractional episodes (`14.5`) | C (non-episodic) | live |
| C4 | Episode 0 on an episodic season (prologues, `E0`) | **measured live: `?episode=0` returns nothing → loud error. Safe (D)** | live |
| C5 | Cour splits (Part 2 entries; arc title + bare number; 3 cours) | C | live |
| C6 | Season labels differing inside one answer | **measured: 14 of 449 sampled episodes, all one episode labelled two ways by different providers (Netflix files sequels as their own show). Not a defect; flagged in the sweep, not scored** | live |
| C7 | Jimaku's filter answering with another episode | P → **after: fractional specials (第13.5話) dropped from integer episodes (C); an offset retry drops the absolute uploader's population (C). Residual: a cour entry's own-numbered files stay in the switcher list (never auto-loaded) — see progress.md** | live |

### 1d. Entry sets and file sets
| # | Input category | Before | Evidence |
|---|---|---|---|
| D1 | One entry holds every season (One Piece, Naruto) | C | live |
| D2 | Split per season / per cour | C | live |
| D3 | Search returns unrelated shows | C (franchise checks) | live |
| D4 | A lone result that is a different work | C | live |
| D5 | Search truncation / pagination | N (unknown whether Jimaku truncates) | — |
| E1 | Several legitimate files for one episode | C (narrowing never collapses alternates) | live |
| E2 | Batch archives | C | live |
| E3 | Dual-language files | C (fileHint + strip) | live |
| E4 | Uploader preference ordering | C | live |

### 1e. Paths other than automatic resolution
| # | Input category | Before | Evidence |
|---|---|---|---|
| G1 | **Remembered entry** (after a manual pick) | **N**: empty `?episode=N` → whole entry listed → arbitrary file auto-loaded as "confident" (8 proven on 449 sampled episodes) → **after: C, same rules as the resolver; 0 (test-remembered-entry)** | live |
| G2 | **Manual entry pick** | **N**: same unfiltered fallback → **after: C, resolver rules; when nothing matches, the list is shown and NOTHING is loaded** | live |
| G3 | Manual file pick | correct by definition | — |

### 1f. Lifecycle and concurrency
| # | Input category | Before | Evidence |
|---|---|---|---|
| H1 | **A response arriving after navigation** | **N** → **after: C, request binding (test-subtitle-binding)** | code |
| H2 | Video element swapped | C (watchdog) | live |

### 1g. API and network
| # | Input category | Before | Evidence |
|---|---|---|---|
| F1 | Errors / 429 / dropped connection mid-resolution | P: every fetch throws on non-OK, so it fails loud, never partial | code |
| F2 | Malformed or empty JSON | P: throws, fails loud | code |

## 2. Parsing and segmentation

Measured on the 386-file corpus (`scripts/audit/parse-sweep.js`: 233,963 distinct displayed lines, 129 Jimaku entries, 90 series, every release-group/format bucket). "After" is the same corpus, same cache.

### 2a. File format (`subtitle-parser.js`, display filters)
| # | Input category | Before | After | Evidence |
|---|---|---|---|---|
| PA1 | **Timestamps**: `.` separator, **four-field `00:01:00:15,367` (Bandai films)** | N: every cue past 1h NaN, never shown (5 files, 574–728 cues each) | C: base-60 fields of any count; unreadable ones reported | live corpus |
| PA2 | **.srt tag markup** (`<i>`, `<font>`, `<rb>`) | N: 984 lines rendered tags | C: 0 | live corpus |
| PA2b | **ARIB gaiji placeholders** `[外:<hex>]` | N (1 file) | C: → 〓 | live corpus |
| PA3 | ASS override tags in .srt | C | C | live |
| PA4 | ASS escapes `\h` | N | measured 0 occurrences; not changed | live corpus |
| PA5 | ASS vector drawings | N | measured 0 residue lines; not changed | live corpus |
| PA6 | Karaoke `\k` tags | C | C | code |
| PA7 | **Layered duplicate events** | N: 1,067 lines doubled | C: shown once | live corpus |
| PA7b | **Karaoke typeset one glyph per event** | N: 7 files, 2,296 moments, one char per line | C: dropped as an effect layer | live corpus |
| PA8 | Stacked / overlapping cues | P | P (NanakoRaws four-line shape still open) | live |
| PA9 | Line break inside a word | suspected | **measured not a defect**: line breaks in real files are sentence/speaker boundaries; the detector's hits were joins of separate lines | live corpus |
| PA10 | **Speaker labels** | P: first line only; `５：５` cut | C: per line; digit colon guarded (18 lines) | live corpus |
| PA10b | **Invisible marks (U+200E/U+202A) before labels** | N: 780 cues unfiltered | C | live corpus |
| PA10c | Labels carrying readings, dialogue dashes, several leading groups | N | C | live corpus |
| PA11 | Stage directions not spanning the line | P (Open Q #14) | C: per line (leftover parentheticals 8,411 → 614 lines, the rest content) | live corpus |
| PA11b | **Doubled `((…))` around speech** | N | C: brackets removed per line, words kept | live corpus |
| PA12 | Parenthesised speech vs sound effect | N | **D — inherently ambiguous, measured 14 of 233,963 lines**; kept as a stage direction | live corpus |
| PA13 | Music symbols, emoji | C | C | live |
| PA14 | Half-width katakana / full-width digits | C | C | live |
| PA15 | Inline furigana | C (hiragana) | C (hiragana + katakana, spaces) | live corpus |
| PA16 | **Dual-language tracks dropping Japanese lines** | N: 351 lines lost | C: 338 rescued; 13 left are Chinese credits (correct) + katakana-only exclamations/lyrics (accepted) | live corpus |
| PA16b | Chinese lines inside a Japanese-majority style | N | residual (honest: visible, never mis-looked-up) — Open Questions | live corpus |
| PA17 | Encoding (BOM, UTF-16, mojibake) | N | not observed in the corpus; not changed | live corpus |
| PA18 | HTML entities | N | measured 0 | live corpus |
| PA19 | **Astral-plane characters (emoji runs, 𠮟, 𩸽)** | N: kuromoji deleted following text | C: `tokenizeLossless`; the characters themselves stay unclickable (51 lines) | property test + corpus |
| PA20 | **WebVTT cue settings** (`--> 00:00:03.000 align:start`) on a non-ASS English track (logged 2026-09-22) | N | **N, deliberately unfixed**: parseSrt reads the settings as part of the end time, NaN, cue never shows. Not reachable today (every English track the sniffer reads is ASS; the one WebVTT track seen, the dub's `captions`, has no settings). Expected-fail check in `test-subtitle-parser.js`; the sniffer warns on any non-ASS format | synthetic + live probe |

### 2b. Tokenization
| # | Input category | Before | After | Evidence |
|---|---|---|---|---|
| PB1 | **Losslessness** (tokens / groups rebuild the line) | N, and FALSE on astral runs | C: property test (6,000 inputs) + corpus (0 violations) + runtime guard | synthetic + live |
| PB2 | Unknown words | P | P | live |
| PB3 | Names | C | C; residual: kanji given names split to single kanji (KANJI-FRAGMENT 11.8k lines, e.g. 紅|莉|栖) — inherent to IPADIC, shown honestly | live corpus |
| PB5 | Compounds | C | C; residual: numeral + counter (２|人) split | live corpus |
| PB7 | Colloquial contractions | P | P | live |
| PB10 | **Stutters** (`ほ… ほかには`) | N: fragment → ほる/いる | C: unclickable | live corpus |
| PB10b | **Grunts read as verb stems** (`うっ`, `くっ`, `うわっ`, `うう`) | N: thousands of wrong verbs | C: utterance lookup, strict (verbs-as-interjection 2,483 → 341) | UniDic disagreement |
| PB14 | Dialects | N | not separately measured; UniDic disagreement shows no dialect-specific cluster | live corpus |

### 2c. Lookup
| # | Input category | Before | After | Evidence |
|---|---|---|---|---|
| PC2/PC4 | Homographs / wrong sense | C / D | unchanged: every entry shown, the user picks the card | live |
| PC7 | **Lemma drift** | N | C for the attach-only-form class; residual: ~100 genuinely cut-off kana verbs (`あたっ…`) now show no entry (the stated trade) | UniDic disagreement |
| PC8 | Old-form kanji (會/當/來) | N | residual: honest no-entry, mostly lyrics — Open Questions | live corpus |
