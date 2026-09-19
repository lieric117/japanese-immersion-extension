# Correctness audit — progress log

Started 2026-09-18 from commit `c1c95b2`. This file exists so a fresh session can pick the audit up from here. It records the phase, the findings, pending decisions, and what's done. The brief for the audit is in the session prompt (not repeated here). The three rules that matter most:
- Fix mechanisms, not instances.
- Never load subtitles without a confident season identity.
- Separate what was checked against the live API from what was only checked offline.

## Status

| Phase | State |
|---|---|
| 0 — Pipeline map | done — `docs/audit/pipeline-map.md` |
| 1 — Failure taxonomy | in progress — `docs/audit/failure-taxonomy.md` |
| 2 — Invariants | drafted in the map/taxonomy, enforcement pending |
| 3 — Harness | built (see below); first live runs pending |
| 4 — Fixes | detection first, then parsing |

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

Results: *pending, filled in below when the run completes.*

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

## Pending decisions for the user

*(none yet)*

## Done

- Phase 0 map.
- Harness scaffolding: offline-tested on fixtures; the detection sweep smoke-tested offline.
