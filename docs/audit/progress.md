# Correctness audit — progress log

Started 2026-09-18 from commit `c1c95b2`. This file exists so a fresh session can pick the audit up from here. It records the phase, the findings, pending decisions, and what's done. The brief for the audit is in the session prompt (not repeated here). The three rules that matter most:
- Fix mechanisms, not instances.
- Never load subtitles without a confident season identity.
- Separate what was checked against the live API from what was only checked offline.

## Status

| Phase | State |
|---|---|
| 0 — Pipeline map | done — `docs/audit/pipeline-map.md` |
| 1 — Failure taxonomy | done — `docs/audit/failure-taxonomy.md` |
| 2 — Invariants | enforced in code and tests — see `report.md` §3 |
| 3 — Harness | built; detection sweep run live (1,485 sampled episodes, all three captures) |
| 4 — Fixes | done: 7 detection + 7 parsing root causes, one commit each; end-of-session report in `report.md` |

## Environment notes (read first)

- `JIMAKU_API_KEY` lives in `~/.zshenv`. The file was missing, and then malformed (`export <key>`, no variable name), when this session started. Fixed to `export JIMAKU_API_KEY=…`. The Bash tool's shell doesn't source it, so scripts are run as `zsh -c 'source ~/.zshenv; node …'`.
- Jimaku's rate limit is **25 requests per window** (`x-ratelimit-limit: 25`). The new client paces from the response headers and never runs two live tools at once.

## Harness (all under `scripts/audit/`, dependencies isolated in `scripts/audit/node_modules`)

| File | What it does |
|---|---|
| `jimaku-client.js` | Disk-cached (`.audit-cache/jimaku/`, gitignored), header-paced Jimaku fetch. `JIMAKU_CACHE_MODE=offline` replays a snapshot exactly, so a before/after comparison is on identical data. |
| `load-background.js` | Runs the real `background.js` in a vm sandbox with any fetch. |
| `file-identity.js` | An independent filename → episode-claim parser that keeps the `Sxx` season, which `audit-resolution.js` discards. |
| `detection-sweep.js` | Runs every captured episode through the real `fetchSubtitles`: PICKED-OFF-EPISODE, SEASON-MIX, NONE-STATES-EPISODE, REMEMBERED-DIVERGES. |
| `parse-pipeline.js` | The real `cueDisplayText` + `buildGroupsForText` (extracted from content.js) + real `lookupWord` over the shipped JMdict. |
| `build-corpus.js` | Samples a diverse corpus: one file per (release group, format) per entry. |
| `parse-sweep.js` | Invariants plus anomaly clustering over the corpus. `--files` sweeps local fixtures. Second analyzer: UniDic via `lindera-wasm-unidic`. |
| `fixtures/adversarial.{srt,ass}` | Hand-built adversarial inputs (clearly synthetic). |

## Baseline (before any change, commit `c1c95b2`, live API)

Commands (run strictly one at a time):
- `node scripts/audit-resolution.js fixtures/crunchyroll-catalogue-2026-08-04.json --only "tokyo ghoul,slimes,mushoku,shangri,dress-up,kimetsu no yaiba"` (known-bug regression)
- `node scripts/audit-resolution.js fixtures/known-bugs-2026-08-02.json [--background <6ff83e8 copy>]` (proof: old resolver 9 defects, current 0)
- `node scripts/sweep-resolution.js fixtures/crunchyroll-catalogue-<date>.json` for all three captures

Results (live, 2026-09-18 23:20 → 2026-09-19 00:50):
| Run | Result |
|---|---|
| Known-bug six shows (08-04 capture) | 274 episodes, **0 proven** (MIXED/DUPLICATE/COLLISION/EMPTY all 0); flagged: DECLINED 43, UNACCOUNTED 28, MISSING 1 |
| `--background` proof, resolver 6ff83e8 | **9 proven** (MIXED 1, DUPLICATE 2, COLLISION 3, EMPTY 3), as documented |
| `--background` proof, current | 0 proven |
| sweep 08-04 (90 seasons) | OK 71, SUSPECT 3, ASKS 12, ERROR 4 |
| sweep 08-01 (134 seasons) | OK 86, SUSPECT 25, ASKS 11, ERROR 12 |
| sweep 08-01b (75 seasons) | OK 48, SUSPECT 4, ASKS 18, ERROR 5 |

Of the 32 SUSPECTs, 30 are known-correct shapes (One Piece's arcs on its single entry, OVA buckets, title-matched compilations). **Two are real wrong-content loads present at baseline**: FGO's *Solomon* film → the Babylonia TV entry ("matched by season 1"), and *Kaiju No. 8: Mission Recon* (a recap special) → Kaiju No. 8 Season 2's episodes ("matched by season 2"). See Pending decisions.
Every ERROR is a loud refusal. `?episode=0` on an episodic season comes back empty from Jimaku (live): episode-0 prologues fail loudly, never wrongly (taxonomy C4 → safe).

## Findings so far (Phase 0/1, from code + live-captured catalogue data)

Detection. Each is a silent wrong-content route, and each is measured, not hypothetical:
1. **Episode identity collisions** — `episodeIdentity` = series + season# + episode#. 37 real episodes across the three captures share it with a different episode. A richer key (series + season title + season# + code + episode title) collides on 0.
2. **Per-season memory key collisions** — `series:season#`. 6 real slots are shared by different works, films included (Gundam TV / *Char's Counterattack*; KonoSuba S3 dub / *Legend of Crimson* dub; FGO Babylonia dub / *Solomon*; Gintama ×4).
3. **Remembered and manual entry paths bypass the episode-identity rules.** On an empty `?episode=N` they list the whole entry and auto-load `rankFiles[0]`. That's the exact shortcut `resolveTextFiles` forbids for episodic content.
4. **No request/response binding.** A `FETCH_SUBTITLES` response that arrives after navigation overwrites the current episode's cues.
5. **Stale JSON-LD after retries** → the load proceeds with the previous identity.
6. **Season mixing** (`S01E05` + `S02E05` in one answer) is invisible to both the resolver and `audit-resolution.js`.

Parsing. Confirmed on synthetic inputs, frequency to be measured on the corpus:
- SRT `.`-millisecond timestamps → NaN → the cue is silently never shown.
- SRT `<i>` tags / HTML entities → rendered literally.
- ASS `\h` → literal `\h`.
- Layered duplicate events → the line is shown twice.
- Mid-word line breaks.
- Speaker-prefix regex strips `10:` out of `10:30`.
- Whole-line parenthesised inner monologue dropped as a stage direction.
- `𠮟` (a modern standard kanji outside the BMP) → tokenized as a symbol, so the verb is lost.

## Detection sweep results (live data, cached; old = c1c95b2, new = working tree)

Same 1,485 sampled episodes, identical cached responses (`JIMAKU_CACHE_MODE=offline`):
| | old | new |
|---|---|---|
| REMEMBERED-DIVERGES, wrong episode loaded (proven) | 10 | 0 |
| FRACTIONAL-IN-LIST (proven) | 4 | 0 |
| PICKED-OFF-EPISODE (proven) | 0 | 0 |
| SEASON-MIX (flagged; measured to be provider labelling) | 44 | 42 |
| remembered path diverging at all | 73 | 2 (SPY x FAMILY ep 13: the right file loads, the cour's other-numbered files stay in the list) |

`diff-lists.js` over the same run: automatic resolution changed on exactly 4 of 1,478 episodes. Three fractional specials were removed (MHA 13.5 ×2, Slime 24.5) and Kaiju No. 8: Mission Recon now declines. No legitimate file was lost anywhere.

Census over 192 cached search responses and 876 entries:
- Unicode-variant titles (B7): **0** Crunchyroll titles match a Jimaku name only under NFKC/diacritic folding. Measured absent, so not fixed.
- Unparsed Jimaku season words (B2): 30 names ("FINAL SEASON", "Second Season", "Major S2"). Every use of the parse also requires the base title to match, so these produce declines, never wrong loads.
- Duplicate entry names in one result set: 3 (One Piece Episode of Alabasta ×2, Gintama ×4). The tiers take the first. Both Alabasta entries are the same work, and Gintama's bare-name entries are reached only by the exact-title fallback.

## Root causes fixed (detection)

1. **RC-D1 unique identity + request binding** (content.js): committed 62919e7.
2. **RC-D2 season memory key** (content.js): committed 62919e7.
3. **RC-D3 one file-retrieval function for every entry source** (background.js `filesForEntry`): the remembered entry and the picker now follow the resolver's episode rules. A pick with no matching file lists the files and loads none.
4. **Offset retry drops the absolute uploader population** (background.js).
5. **A named season is never matched by list position alone**, plus mid-name "Season N" (background.js): fixes Kaiju No. 8: Mission Recon.
6. **Fractional-episode files dropped from integer episodes** (background.js).
7. **Disagreeing TVEpisode blocks = not yet detectable** (content.js).

## Pending decisions for the user

*(none. The FGO Solomon SUSPECT turned out to be an artifact of the sweep's reconstruction: on a film-shaped page it already fails loudly. Recorded as a residual risk, not a question.)*

The three questions in `report.md` §6 were answered on 2026-09-20 — see that section. One produced code: the `TVEpisode` block carries the episode's own watch URL, so staleness is now exact (Decisions Log 2026-09-20). The other two confirmed what was already built.

## Done

- Phase 0 map.
- Harness scaffolding: offline-tested on fixtures; the detection sweep smoke-tested offline.

## Parsing (386-file corpus, `.audit-cache/corpus.json`)

Root causes fixed, one commit each: lossless tokenization, any-count timestamps, .srt tag markup/gaiji, typesetting layers, per-line display filters, Japanese lines in dropped dual-language styles, grunts/stutters, runtime losslessness guard. Before/after numbers are in `failure-taxonomy.md` section 2 and `report.md`.

## Where to resume

Nothing is mid-flight. The next step is live: checklist group F in `project-plan.md` section 6 (item 1 now also covers the 2026-09-20 URL check's console lines).

**Environment, 2026-09-20:** both went missing and both are restored — `~/.zshenv` was re-created with the key (verified by a live `test-render-pipeline.js` run), and `.audit-cache/` was moved back from the user's Downloads folder (2,001 cached Jimaku responses + `corpus.json`, 60MB), so the offline replays below run again as written. To re-verify offline after any change:
- `JIMAKU_CACHE_MODE=offline node scripts/audit/detection-sweep.js <3 captures> --sample --lists after.json`, then `diff-lists.js` against a run with `--background <old copy>`;
- `node scripts/audit/parse-sweep.js --out r.json`;
- `node scripts/test-parse-invariants.js`.
