# Japanese Immersion Extension — working rules

This file covers **how to work in this repo**: rules, commands and the session routine. All project state — status, priorities, how each part works, decisions and open questions — is in `project-plan.md`.

## Session start

1. Read the session brief.
2. Read `project-plan.md` → **Status**.
3. Read `project-plan.md` → **Architecture** and **Decisions** for the component(s) you'll touch. (This replaces reading all of Decisions and Open questions every session, which no longer scales.)

## Product guardrail

**Core goal:** let learners who already study Japanese elsewhere use Crunchyroll anime as real immersion practice, with just enough support to confirm what they half-know without breaking the scene. **The extension's job is to keep them watching, not to teach them:** click a word for a fast dictionary check, capture a word or sentence into Anki, and everything else is secondary.

**Litmus test** (a word-for-word copy of `project-plan.md` → Scope → Litmus test):

**Does it help the user capture something quickly and keep watching, or feed something into a system they already use (e.g. Anki)? Or does it ask them to stop and be taught, or duplicate a tool they already trust (e.g. Anki, or their existing grammar/SRS tools)?** First answer → in scope. Second answer → out, regardless of whether a competitor (ManabiDojo or anyone else) has it. This test is the tie-breaker whenever something is ambiguous. It overrides the Scope lists in `project-plan.md`, not the other way around.

- **Build only what the session brief asks for.** If something outside it seems needed — a new feature, extra behaviour, a "while I'm here" improvement — stop and ask Eric first. If an idea fails the litmus test, say so rather than proposing to build it.
- When the brief doesn't clearly cover something, check `project-plan.md` → Scope before starting.
- `project-plan.md` holds the canonical core goal and litmus test. If either changes, update both files.

## Working with Eric

- Eric has no prior coding experience: explain what you're doing in plain terms when it isn't obvious.
- Prefer small, testable steps over large multi-file changes Eric can't verify.
- Flag ambiguous implementation choices as questions instead of resolving them silently.
- Architectural and scope decisions come from the brief or from Eric — never decided silently.

## Engineering rules

- **Fix the mechanism, not the instance.** A fix that only works for one show, episode or word isn't a fix — find the general cause. State a rule as the class of thing it covers, not a list of cases; where a list is unavoidable, label it as deliberate.
- **When unsure, fail visibly instead of guessing silently.** Wrong data that persists (a wrong card in the user's Anki) is worse than showing nothing; prefer a visible "couldn't do this" to a silent fallback.
- **Offline tests aren't live validation — always report which one you did.** Before trusting a fix, verify it against the real corpus or the live API, not a hand-picked example; verify a platform limitation hands-on before declaring it.
- **Real-world data must be real.** Test data from external sources (Crunchyroll, Jimaku) is captured from the live source or explicitly marked as a guess or constructed. Never invent its shape.
- **Don't break what works.** Run the relevant regression checks (below) before and after a change, and add a pinned test for every fixed root cause.
- **Keep one definition for anything two surfaces must agree on** (e.g. the subtitle line and the Anki card) — one function, never two copies kept in sync by hand.
- **Test the real code, not a copy:** tests load or extract the shipping source.
- **Don't build for a hypothetical gap** — confirm the problem exists in real data first.
- Rules that apply to only one component go in that component's **Invariants** in `project-plan.md`, not here.

## Repo map

- `manifest.json` — Manifest V3 config: content scripts, the MAIN-world sniffer, host permissions.
- `background.js` — service worker: Jimaku search and entry/file resolution, JMdict lookup, AnkiConnect, caption fetch.
- `content.js` — content script: show/episode detection, subtitle overlay, popup, switcher, Anki capture, edit panel.
- `content.css` — styles for the overlay, popup, chips and panels.
- `tokenize-utils.js` — tokenizing wrapper, grouping rules, phrase-matching, kana-merge, shared normalizers.
- `subtitle-parser.js` — `.srt`/`.ass` parsing and dialogue-track cleanup (shared by Jimaku files and manual upload).
- `audio-capture.js` — rolling audio buffer, clip slicing, loudness normalization, the edit panel's retained audio.
- `caption-url-sniffer.js` — page-world script reading Crunchyroll's `play` response (English captions) and adjacent-episode titles.
- `popup.html`, `popup.js` — toolbar popup: Jimaku API key and the "Extra info" toggles.
- `jmdict-compact.json` — the shipped dictionary, built by the scripts below. `vendor/` — kuromoji.js and its dictionary.
- `scripts/` — offline tests, the batch corpus test, dictionary build scripts, live audit tools, browser-console collectors; `scripts/audit/` is the correctness-audit harness; `scripts/jlpt-data/` and `scripts/orphaned-tier-overrides.json` are build inputs.
- `fixtures/` — live-captured test data (catalogue captures, recorded Jimaku responses, caption and JSON-LD captures).
- `docs/live-test-checklist.md` — browser test steps. `docs/audit/` — the 2026-09-18 correctness audit write-up.
- `project-plan.md` — all project state. `.audit-cache/` — the audit's disk cache of live Jimaku responses (gitignored).

## Commands & testing

Offline tests are `node scripts/<name>.js` (seconds each; several need `scripts/node_modules` — `cd scripts && npm install`). Run the ones covering what you changed, before and after (the property test is `scripts/test-parse-invariants.js`; the audit sweeps `scripts/audit/detection-sweep.js` and `scripts/audit/parse-sweep.js` are below):

| Changed | Run |
|---|---|
| Entry/file resolution (`background.js`) | `test-entry-resolution.js`, `test-season-resolution.js`, `test-remembered-entry.js`, `test-named-season.js`, `test-fractional-special.js` (the last three replay `fixtures/jimaku/`; `BACKGROUND_JS=<old copy>` shows the pre-fix failure), then the live audit below |
| Detection / navigation (`content.js`) | `test-detect-show-episode.js`, `test-detection-identity.js`, `test-subtitle-binding.js`, `test-stale-timeout.js` |
| `caption-url-sniffer.js` | `test-sibling-sniffer.js` |
| Parsing / display filters | `test-subtitle-parser.js`, `test-display-filters.js`, `test-display-join.js` |
| Tokenizing / grouping / lookup | `test-parse-invariants.js` (property test), `test-utterance-lemmas.js`, `test-render-pipeline.js`, and `batch-test.js` |
| English pairing / bridging | `test-english-bridging.js` |
| Edit panel / chip / Anki notes | `test-edit-last-card.js`, `test-edit-panel.js` |
| Audio merge widening | `test-merged-audio-span.js` (`--live` replays real files; needs the API key) |

- **`scripts/batch-test.js`** — tokenizing and lookup over the real 3-show corpus; compare its pattern counts against the current baseline in `project-plan.md` → Architecture → Test & audit tooling (and update it there when a change moves the counts on purpose). It doesn't check ordering.
- **Testing resolution correctness needs `scripts/audit-resolution.js`, NOT `analyze-crunchyroll-fixtures.js`** — the latter never calls `resolveTextFiles`, and its "zero misses" results were twice mistaken for evidence that shows resolve correctly. Run `scripts/audit-resolution.js <capture>` against live Jimaku, and re-run the six known-bug shows after **any** resolver change; that run is what caught a fix regressing a clean show on 2026-08-11: `node scripts/audit-resolution.js <capture.json> --only "tokyo ghoul,slimes,mushoku,shangri,dress-up,kimetsu no yaiba"`. Full runs go in `--only` batches of ~150 episodes (~1.5s/episode; bigger batches exceed the 600s foreground limit). The `--background` proof: `fixtures/known-bugs-2026-08-02.json` against `background.js` from commit `6ff83e8` must report 9 proven defects, and 0 against current code.
- `scripts/sweep-resolution.js <capture.json>` sweeps every season through the live resolver; `scripts/analyze-crunchyroll-fixtures.js <collected.json>` checks metadata shapes only.
- **Correctness-audit harness** (`scripts/audit/`, see `docs/audit/progress.md`): `detection-sweep.js` and `parse-sweep.js` replay live Jimaku responses cached in `.audit-cache/` (`JIMAKU_CACHE_MODE=offline`), so a before/after comparison runs on identical data (`--lists` + `diff-lists.js`); `build-corpus.js` builds the parse corpus; `record-scenario.js` records fixtures for pinned tests; `entry-name-census.js` and `show-cluster.js` inspect results; `jimaku-client.js`, `load-background.js`, `parse-pipeline.js` and `file-identity.js` are modules the tools import, not commands. `audit-resolution.js`/`sweep-resolution.js` use the same cache.
- **Never run live Jimaku tools side by side** (the audit, the sweep, `test-render-pipeline.js`, `test-merged-audio-span.js --live`): they saturate Jimaku's rate limit and the failures then read as regressions.
- **Browser-console scripts, not node:** `collect-crunchyroll-fixtures.js` (bulk catalogue capture), `collect-jsonld-blocks.js` (real `TVEpisode` blocks and their timing), `probe-play-captions.js` (every caption track in the `play` response) — paste into a logged-in Crunchyroll page; see their headers. Save captures under `fixtures/`.
- **Live entry-resolution regression script:** after a change to `resolveTextFiles`, the sibling sniffer or episode-number extraction, re-run it in a browser (`project-plan.md` → Architecture → Test & audit tooling).
- **Rebuilding `jmdict-compact.json`** (any phase) — run in this order: `generate-jmdict-compact.js` → `fix-jmdict-priority.js` → `scripts/build-orphaned-tier-overrides.js` → `scripts/apply-tubelex-frequency.js` (must run last among these four — see its own header) → `scripts/apply-jlpt-level.js` (no ordering dependency on the others, just needs `id` to exist; appended last by convention). Skipping a step has shipped a real regression before (Decisions → Dictionary data & lookup; the 2026-07-13 gotcha).
- **`JIMAKU_API_KEY`** is a persistent environment variable in `~/.zshenv` (first set 2026-07-03, re-created 2026-09-20 after the file went missing), so an interactive terminal runs `cd scripts && node batch-test.js` directly. The Bash tool's shell doesn't source it: run live scripts as `zsh -c 'source ~/.zshenv; node …'`.
- **Debugging tips:** resolver logs are in the **service worker** console (`chrome://extensions` → the extension's "service worker" link), not the page console; `__jpImmersionSnifferStats()` runs in the page console. Layout and CSS bugs can be reproduced in headless Chrome against the real `content.css` with a local harness page — no Crunchyroll or DRM needed.

## Session end

1. Update `project-plan.md` by following its **How to use this doc** section, including its end-of-session checklist.
2. Give Eric an end-of-session summary: what changed; what was validated live vs offline only; what's still unverified; and any ambiguities you flagged or had to decide. If nothing decision-worthy happened, say so.

## Editing this file

Edit only when a rule, command or key file changes. Project state never goes here — if you're tempted to add it, it belongs in `project-plan.md`. Keep it under ~100 lines, one line per rule.
