# Correctness audit — end-of-session report (2026-09-18/19)

Scope: show detection (Crunchyroll episode → Jimaku file) and subtitle parsing/segmentation/lookup. The work started at commit `c1c95b2` and runs through the audit commits that follow it. Companion documents: `pipeline-map.md` (Phase 0), `failure-taxonomy.md` (Phase 1, before/after coverage per input class), `progress.md` (state for a fresh session).

## 1. Failure taxonomy — coverage before vs after

See `failure-taxonomy.md` for every row. The summary below counts input classes that could produce a *silent* wrong result:

| | Before | After |
|---|---|---|
| Detection classes not covered | 9 (A2 partial, A3, A8, A9, C4 unknown, C6, C7 partial, G1, G2, H1) | 0 unguarded. C4 was measured safe; C6 was measured to be provider labelling; C7 is reduced to one residual that never auto-loads |
| Parsing classes not covered | 14 | 0 unguarded that produce wrong content. The residuals (PA12, PA16b, PC8, ~100 kana cut-offs) degrade to "shown honestly" or "no entry" |

## 2. Root causes found and fixed (one commit each)

**Detection**
| # | Mechanism | Evidence | Fix |
|---|---|---|---|
| D1 | No binding between a subtitle response and the episode it was requested for; identity key shared by 37 real episodes; a stale page loaded after 1s | code + live capture | request binding (`installCues`), unique identity, 5s stale wait |
| D2 | Per-season memory keyed on list position: 6 real slots shared, 3 of them a TV season with a film | live capture | `seasonMemoryKey` includes the season name / work title |
| D3 | Remembered entry and entry picker listed the whole entry when `?episode=N` was empty, and auto-loaded its top file | **10 wrong loads / 1,485 sampled live episodes** | one retrieval path, `filesForEntry` |
| D4 | Offset retry picked up the absolute uploader's file for a local number | live listing (entry 7707) | drop the population the offset came from |
| D5 | Season matched by Crunchyroll list position when the season had its own unmarked name | **Kaiju No. 8: Mission Recon → Season 2; Char's Counterattack → Gundam TV** (live sweep) | position used only when the page names no season |
| D6 | Fractional-episode specials in integer-episode answers | **MHA 13.5, Slime 24.5** (live) | dropped |
| D7 | Two TVEpisode blocks settled by document order | code | not-yet-detectable → retry |

**Parsing**
| # | Mechanism | Evidence (386 real files) | Fix |
|---|---|---|---|
| P1 | kuromoji deletes text after astral-character runs | property test: 30/3,000 inputs | `tokenizeLossless` |
| P2 | Timestamps read as exactly three fields | 5 Bandai films lost every cue past 1h | base-60 any-count parse |
| P3 | .srt tag markup, gaiji placeholders | 984 lines | stripped at parse |
| P4 | Typesetting layers in the dialogue track | 2,296 karaoke moments, 1,067 doubled lines | `cleanParsedCues`, display dedupe |
| P5 | Display filters assumed one clean line | 8,411 → 614 leftover lines | per-line filters, `Cf` removal |
| P6 | Dual-language strip dropped Japanese lines | 351 lines | 338 rescued by hiragana share |
| P7 | Grunts read as verb stems; stutters as verbs | 2,483 → 341 (verb-as-interjection disagreement with UniDic) | attach-only rule, strict utterance lookup, stutter pass |

## 3. Invariants now enforced

In code:
- **Detection.** Cues are installed only for the newest request whose identity the page still reports. The episode identity and the season memory key are unique over all captured data. Every entry source uses `filesForEntry`. No entry is chosen by list position alone for a named season. An integer episode never gets a fractional file.
- **Parsing.** Tokens rebuild the line (`tokenizeLossless`, round-trip checked). Groups rebuild the line (runtime fallback to plain text). Unreadable timestamps are reported. A lookup word always has support in the text: either an attach-only form with something attached, or the utterance itself.

In tests:
- property test I1–I5 (6,000 random adversarial inputs);
- `test-detection-identity` (injectivity over 6,997 episodes and 231 seasons);
- replayed-live-response tests for D3/D4/D5/D6;
- the corpus sweeps as regression harnesses.

## 4. Live-validated vs offline-only

- **Live API / live-captured:** every Jimaku response used by the sweeps and pinned tests was fetched live this session, cached in `.audit-cache/`, then replayed. Crunchyroll inputs come verbatim from the three catalogue captures (live CMS data). The JSON-LD compound `name` is **reconstructed** in its measured shape. Also run live: the baseline and post-fix regression runs (known-bug six shows 0 → 0 proven, `--background` proof 9/0 both times, three sweeps identical apart from the two intended declines).
- **Offline only:** everything in `content.js` (binding, keys, stale wait, display filters, dedupe, stutters) has been run against extracted real functions and real data, but **not in a browser**. Checklist group F in `project-plan.md` covers it.
- **Never observed live, guarded anyway:** two disagreeing TVEpisode blocks; the absolute-population offset case (not reachable on Shangri-La's real episode list).

## 5. Remaining risks and inherently ambiguous cases

| Case | How it degrades |
|---|---|
| Stale JSON-LD after navigation | ~~time-based~~ **closed 2026-09-20**: the block names its own episode URL, so a stale block is recognised however long it lasts. Residual only if Crunchyroll drops the field, which logs a warning and falls back to the 5s wait |
| Cour entry's other-numbered files in the switcher list (SPY x FAMILY ep 13) | never auto-loaded; only offered |
| FGO *Solomon* (film under the Babylonia series) | loud refusal on a film-shaped page; the sweep's wrong load came from its own reconstruction |
| Parenthesised speech vs sound effect (14 lines) | kept as a stage direction (dropped) |
| Amazon ruby with a lost reading tag (3 files) | tags stripped, reading left inline |
| Kanji names split to single kanji; numeral + counter split | each fragment clickable, with an honest or generic gloss |
| Old-form kanji, Chinese lines in lyric files | honest "no entry" / visible Chinese |
| ~100 cut-off kana verbs (`あたっ…`) | "no entry" instead of their verb (the price of 3,400 fewer wrong verbs) |
| Katakana-only exclamations in a dropped dual-language style | lost (2 lines) |

## 6. Questions for you — all three answered 2026-09-20

1. **JSON-LD URL/id** (Open Question 21): **yes — `url` and `@id` both.** The user loaded S1E1, clicked next, and read the block on E2 immediately and again seconds later: `url`, `@id`, `episodeNumber` and `name` had all updated both times, so the block is replaced in place on in-app navigation and does not stay stale for human-scale delays. The sub-second window right after navigation can't be observed by hand — and that is precisely the window the check now covers. **Built the same day:** `detectShowEpisode` compares the id after `/watch/` in the block's `url`/`@id` with the page's own, drops a block naming a different episode, and uses one naming this page with no wait. The 5s wait survives only as the fallback for a block carrying no URL, with a once-per-episode warning if Crunchyroll ever drops the field. See Decisions Log 2026-09-20; tests in `scripts/test-detect-show-episode.js` (8 new cases) and `scripts/test-subtitle-binding.js` (the stale gate).
2. **The kana cut-off trade** in P7: **accepted as built** — "no entry" is right for `あたっ…`, in exchange for grunts no longer showing a confident wrong verb. No warning-plus-verb variant.
3. **Picks re-asked once:** **accepted as built** — old-key picks are not migrated.

## 7. Suggested doc updates (already applied — review rather than rewrite)

- `CLAUDE.md`: priorities now point at checklist groups B–F and `docs/audit/`; test list, audit harness, the new `batch-test` baseline `92/49/…` (Pattern 2 +10 = grunts now missing honestly), and the Bash-shell key note.
- `project-plan.md`: 13 Decisions Log entries dated 2026-09-18; Section 5 has new detection- and parsing-invariant entries plus updated filter-chain and remembered-entry entries; Section 6 has one-line done bullets, the filtering item closed, and checklist group F; Section 8 marks #14 root-cause-fixed and adds #21–22.
