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
| A2 | **Stale block after SPA navigation** | previous episode's subtitles under the new episode | P: 1s of retries, then **loads the stale identity** | code |
| A3 | Two `TVEpisode` blocks | first wins, silently | N (never observed) | code |
| A4 | Episode code forms: numeric, `EEX`, `SP1`, `P1`, `I/II/III`, `14.5`, `0`, none, duplicated-title film | wrong position | C (numeric, EEX, 14.5, 0-film, film); P (`SP1`, roman) | live |
| A5 | `episodeNumber` ≠ title code | wrong episode | C | live |
| A6 | `seasonNumber` positional / non-unique / unbounded | wrong season | C (name preferred; number last) | live |
| A7 | No `partOfSeason.name` | falls back to the number | P | live |
| A8 | **Two different episodes share the load identity** | staleness check and watchdog can't tell them apart | **N** — 37 real episodes collide | live |
| A9 | **Two different works share the per-season memory key** | a remembered pick crosses works | **N** — 6 real season slots collide, 3 of them a TV season with a film | live |

### 1b. Title and season naming (Crunchyroll vs Jimaku)
| # | Input category | Before | Evidence |
|---|---|---|---|
| B1 | Season markers: `2nd Season`, `Season 2`, roman, bare trailing number, `Part/Cour N`, `Final Season` | C | live |
| B2 | Word-form markers: `Second Season`, `Season Two`, `2nd Cour`, `Part II` | N | code |
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
| C4 | **Episode 0 on an episodic season** (prologues, `E0`) | N: `?episode=0` semantics on Jimaku unverified | code |
| C5 | Cour splits (Part 2 entries; arc title + bare number; 3 cours) | C | live |
| C6 | **Season mixing inside one answer** (`S01E05` + `S02E05`) | N: invisible to the resolver *and* to `audit-resolution.js` | code |
| C7 | Jimaku's filter answering with another episode, with no 第N話 in the names | P (only 第N話-keyed triggers + cour retry) | code |

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
| G1 | **Remembered entry** (after a manual pick) | **N**: an empty `?episode=N` → the whole entry is listed → arbitrary file auto-loaded as "confident" | code |
| G2 | **Manual entry pick** | **N**: same unfiltered fallback; the user sees the list, but the auto-loaded file is arbitrary | code |
| G3 | Manual file pick | correct by definition | — |

### 1f. Lifecycle and concurrency
| # | Input category | Before | Evidence |
|---|---|---|---|
| H1 | **A response arriving after navigation** | **N**: overwrites the current episode's cues | code |
| H2 | Video element swapped | C (watchdog) | live |

### 1g. API and network
| # | Input category | Before | Evidence |
|---|---|---|---|
| F1 | Errors / 429 / dropped connection mid-resolution | P: every fetch throws on non-OK, so it fails loud, never partial | code |
| F2 | Malformed or empty JSON | P: throws, fails loud | code |

## 2. Parsing and segmentation

### 2a. File format (`subtitle-parser.js`, display filters)
| # | Input category | Before | Evidence |
|---|---|---|---|
| PA1 | **SRT `.`-millisecond timestamps** | N: NaN, the cue silently never shows | synthetic |
| PA2 | **SRT HTML markup** (`<i>`, `<font>`) | N: shown literally, sent to Anki | synthetic |
| PA3 | ASS override tags in SRT | C (2026-08-15) | live |
| PA4 | **ASS escapes** `\h` | N: literal `\h` | synthetic |
| PA5 | ASS vector drawings (`\p1`) | N (usually removed by accident by the dual-language strip) | synthetic |
| PA6 | Karaoke `\k` tags | C | code |
| PA7 | **Layered duplicate events** | N: the line shown twice | synthetic |
| PA8 | Stacked / overlapping cues | P (joined with `\n`) | live |
| PA9 | **Line break inside a word** | N | synthetic |
| PA10 | **Speaker labels**: `Name：`, `（Name）` | P: first line only; **also strips non-names** (`10:`) | synthetic |
| PA11 | Stage directions / sound effects | P: whole-line only (Open Q #14) | live |
| PA12 | **Inner monologue in parentheses** | N: dropped as a stage direction. Inherently ambiguous by shape | synthetic |
| PA13 | Music symbols, emoji | C | live |
| PA14 | Half-width katakana / full-width digits | C | live |
| PA15 | Inline furigana `漢字(かんじ)` | C (hiragana readings); katakana readings N | live |
| PA16 | Dual-language tracks | C | live |
| PA17 | Encoding (BOM, UTF-16, mojibake) | N | — |
| PA18 | **HTML entities** | N | synthetic |
| PA19 | **Han characters kuromoji can't classify** (`𠮟`, compatibility ideographs) | N: symbol, orphaned auxiliary | synthetic |

### 2b. Tokenization (kuromoji/IPADIC + grouping)
| # | Input category | Before | Evidence |
|---|---|---|---|
| PB1 | Losslessness (tokens/groups rebuild the text) | N: never asserted; Anki bold offsets depend on it | — |
| PB2 | Unknown words | P (fallback lookups) | live |
| PB3 | Personal names (katakana, kanji) | C | live |
| PB4 | Katakana loanwords | C | live |
| PB5 | Compounds | C (noun+noun fuse) | live |
| PB6 | Long auxiliary chains | C (allowlist, Rule 0.6) | live |
| PB7 | Colloquial contractions ちゃう/じゃん/んだ/てる | P (てる, んだ covered; others unmeasured) | live |
| PB8 | Sentence-final particles | C (prt filter) | live |
| PB9 | Interjections, fragmented by punctuation | C (kana-merge) | live |
| PB10 | Stutters (`わ、わたし`) and elongations (`すごーい`, `ねぇ`) | P (small-vowel collapse only) | live |
| PB11 | Onomatopoeia | P | — |
| PB12 | Honorific prefixes and suffixes | C | live |
| PB13 | Counters, numerals, dates | P (numerals only) | live |
| PB14 | Dialects (Kansai `せや/あかん/ほんま/へん`) | N | — |

### 2c. Lookup
| # | Input category | Before | Evidence |
|---|---|---|---|
| PC1 | Deinflection to dictionary form | P (kuromoji `basic_form` + potential-form fallback) | live |
| PC2 | Homographs | C: ordered by frequency, all shown, the user picks the card | live |
| PC3 | Multiple readings | C (`rs` swap) | live |
| PC4 | Wrong-sense selection | D: every sense shown; nothing auto-picked | live |
| PC5 | No JMdict match | C ("no dictionary entry") | live |
| PC6 | Multi-word expressions / grammar patterns | C (phrase matcher, dual-view) | live |
| PC7 | **Lemma drift**: a mis-segmented token's `basic_form` is a real but unrelated word | N | live (historical `っ`→`く`) |

*Measured frequencies and the "after" column are filled in from the sweeps; see `progress.md`.*
