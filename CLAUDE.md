# Project: Japanese Immersion Extension for Crunchyroll

This file is a **session-start briefing**, not the full project record. It exists to tell you the goal, the rules, and what to work on right now. For anything else — competitive analysis, technical history, the full decisions log, open questions — read `project-plan.md`, which is the source of truth. Don't duplicate its content back into this file; keep this one short and current.

**If you're about to write more than 2–3 sentences into the "Current phase & priorities" section below, stop.** That level of detail belongs in `project-plan.md`'s Build Order (Section 6), not here — link to it instead of restating it. See the formatting rules at the bottom of this file before editing.

## Core goal — read this first

Let learners who already study Japanese elsewhere (kanji/vocab SRS, grammar SRS, a textbook, a tutor) use Crunchyroll anime as real immersion practice, with just enough support to confirm what they half-know without breaking the scene. **The extension's job is to keep them watching, not to teach them.**

**Target user:** not a beginner looking for their first grammar explanation. Someone who already has a study system and uses anime time to meet vocab/grammar in the wild, build reading speed, and quickly confirm or correct what they think they know — then get back to the show.

**Litmus test for any new feature idea:** Does this help the user capture something quickly and keep watching, or feed something into a system they already use (e.g. Anki)? Or does it ask them to stop and be taught, or duplicate a tool they already trust (e.g. Anki, or their existing grammar/SRS tools)? First answer → in scope. Second answer → out, regardless of whether a competitor has it. This test is the tie-breaker whenever something is ambiguous — it overrides the scope list in `project-plan.md`, not the other way around.

**What this is:** A Chrome extension adding clickable, learner-friendly Japanese subtitles to Crunchyroll (which has no native Japanese subtitle track at all). Click/hover a word mid-episode → fast dictionary check. Capture a word or sentence → send to Anki. Everything else is secondary to that loop.

## Read before starting work

At the start of every session, read `project-plan.md`'s **Decisions Log** and **Open Questions** sections (Sections 7–8) — they carry context that isn't summarized here and may be directly relevant to what you're about to build.

## Current phase & priorities

**Phase 5 — Anki export. Every build item is complete.** The whole 2,526-episode capture has now been audited (2026-08-11), reducing the outstanding resolution defects to **five root causes**; three are fixed, one is blocked, one is decided but unbuilt. The edit-panel/chip and audio-capture batches from 2026-07-31 are fixed but **still never re-tested**. Details in `project-plan.md` Section 6 Phase 5, which opens with a **"Follow-up plan — start here next session"** block listing all five. Next, in priority order:
1. **RC1 — seasons that silently load the wrong subtitles** (Dr. STONE, Fruits Basket). Decided: decline to the picker; the decline condition still needs defining. It is the last open resolution defect apart from RC3, which is **blocked** on an input `resolveTextFiles` doesn't get — read its entry before attempting it. RC2, RC4 and RC5 are done.
2. **Re-test the 2026-07-31 fixes live** (checklist groups B–D) plus the 20–30 minute continuous-session check. Largest block of unverified work in the project.
3. **Fix the rest of the 2026-07-31 report** — the subtitle-text filtering group and the NanakoRaws line-break shape.

Re-run the six known-bug shows (`--only "tokyo ghoul,slimes,mushoku,shangri,dress-up,kimetsu no yaiba"`) after **any** resolver change — that run is what caught a fix regressing a clean show on 2026-08-11.

**Testing resolution correctness needs `scripts/audit-resolution.js`, NOT `analyze-crunchyroll-fixtures.js`** — the latter only checks season-title classification and metadata shapes, never calls `resolveTextFiles`, and its "zero misses" results were twice mistaken for evidence that shows resolve correctly. The audit checks actual per-episode file lists against live Jimaku; its header states exactly what it can and cannot prove, and `--background <path>` runs it against an older `background.js` to confirm it still catches known bugs before it's trusted on new ones. Run it in **foreground batches** via `--only` (long background runs keep being killed, losing everything since the report writes only at the end), and never alongside `test-render-pipeline.js` or `test-merged-audio-span.js --live` — it saturates Jimaku's rate limit and their failures then look like regressions.

Offline tests live in `scripts/`: `batch-test.js` (corpus baseline `92/39/57/33/354/109/9/9/35/2`), `test-display-filters.js`, `test-entry-resolution.js`, `test-sibling-sniffer.js`, `test-season-resolution.js`, `test-english-bridging.js`, `test-edit-last-card.js`, `test-edit-panel.js`, `test-render-pipeline.js`, `test-merged-audio-span.js` (`--live` for the real-file replay). `collect-crunchyroll-fixtures.js` is NOT a node script — it's pasted into a logged-in browser console to bulk-collect real catalogue data for fixtures (see its header); `analyze-crunchyroll-fixtures.js <collected.json>` sweeps that capture for metadata shapes only; `audit-resolution.js <capture.json>` is the one that tests resolution. Captures live in `fixtures/`.

If regenerating `jmdict-compact.json` (any phase), run in this order: `generate-jmdict-compact.js` → `fix-jmdict-priority.js` → `scripts/build-orphaned-tier-overrides.js` → `scripts/apply-tubelex-frequency.js` (must run last among these four — see its own header) → `scripts/apply-jlpt-level.js` (no ordering dependency on the others, just needs `id` to exist; appended last by convention). Skipping a step has shipped a real regression before (see Decisions Log 2026-07-13).

`JIMAKU_API_KEY` is a persistent environment variable in `~/.zshenv` — `scripts/batch-test.js` runs directly without asking the user for the key.

## Scope guardrails — do not build these unless asked

- **No AI grammar/sentence explanations, ever, in any form.** Breaks immersion and competes with resources the user already trusts more. If this ever gets revisited, that's a deliberate scope conversation to have with the user first, not something to build proactively.
- **No built-in wordbook/SRS/quiz system.** Anki export is the mechanism for this — don't build a competing review system. This bars a rival *review* system, not editing a card you just made: the in-page edit panel (2026-07-30) is in scope, and reading this guardrail as banning it is the mistake that shipped the wrong design on 2026-07-29.
- **No other video platforms (Netflix, YouTube, etc.), manga OCR, or general web support.** Crunchyroll-only by design, not a Netflix-specific gap.
- **No romaji or kana-only subtitle-display modes.** Both explicitly excluded 2026-07-04, not just deprioritized — wrong fit for this persona, not a missing feature. Furigana mode is the one display-simplification feature in scope.
- **JLPT level tagging is opt-in/off-by-default only** — never an always-visible label, filter, or sort feature. (JLPT data will be sourced externally if jmdict-simplified lacks it — decided 2026-07-04, not dropped.)
- **Screenshot Anki field is dropped from the roadmap entirely (2026-07-17, confirmed DRM-blocked, not deferred) — don't build it.** The audio field it was grouped with was built on 2026-07-22 and is no longer an open question.
- **The frequency-rank badge is built (2026-07-19)** — 3 text tiers (Common/Uncommon/Rare), no raw numbers, no badge when there's no data. It replaced the old common-word badge entirely, gated behind the opt-in `metaShowFreq` toggle. Thresholds are locked in (see `project-plan.md` Section 7, 2026-07-19) — don't re-derive or re-ask about them without a real reason to revisit. See `project-plan.md` Section 5 (Phase 5) for the full pipeline.

Full reasoning for all of these is in `project-plan.md` Section 4 (V1 Scope) and Section 7 (Decisions Log) — check there before assuming an exception applies.

## Working style

- I (the user) have no prior coding experience. Explain what you're doing in plain terms when it's not obvious. Prefer small, testable steps over large multi-file changes I can't verify.
- When something is ambiguous, apply the litmus test above first. If still ambiguous, default to `project-plan.md`'s V1 Scope rather than asking — unless it's a meaningful scope decision, in which case ask first rather than deciding silently.

## Formatting rules for this file — read before editing

- **This file stays under ~1 page.** If an edit would make it noticeably longer, the new content almost certainly belongs in `project-plan.md` instead, with a one-line pointer left here.
- **"Current phase & priorities" is a short numbered list (2–4 items), not a paragraph.** Each item is one sentence stating *what to do next*, not a recap of everything that happened last session. Session recaps (what was fixed, what bugs were found, the full list of fixes not yet re-verified) belong in `project-plan.md`'s Build Order "Done" list — write them there, then write one short pointer sentence here if the top priority changed.
- **Don't inline lists of specific bugs/constructions fixed** (e.g. every individual grammar pattern touched this session) — that level of detail belongs in `project-plan.md` Section 6, already written there by the same session. Repeating it here is exactly the duplication this file exists to avoid.
- **Scope guardrails are one line each.** If a guardrail needs more than one sentence of justification, put the justification in `project-plan.md` and link to it — don't grow the bullet here.

## End-of-session checklist

Before stopping, update `project-plan.md` (not this file — this file only needs edits if the *current phase/priorities* section above has gone stale, and even then, only a short pointer update, not a rewrite):

1. **Build Order (Section 6):** move finished items from "remaining" to "done" for the current phase, as one-line bullets; add newly-discovered remaining items in priority order.
2. **Decisions Log (Section 7):** scan the session for genuine decisions — a real rejected alternative existed, not just "there was nothing else to do." Add qualifying ones with a short bolded title (not a full-sentence title — see `project-plan.md`'s own formatting rules), dated, in order. If a decision revises an earlier logged one, update that entry rather than adding a duplicate.
3. **Open Questions (Section 8):** move anything resolved this session into "Resolved" (one line, pointing to the Decisions Log entry — don't restate its reasoning); add new ones to "Ongoing" under the correct subsection (needs testing/feedback vs. needs a decision — see `project-plan.md`'s own formatting rules for the test), in the right phase-priority slot (2–4 sentences each).
4. **Technical Architecture (Section 5):** if something now works differently than planned, update the relevant entry directly to describe the new current state — don't leave the old description in place alongside it.
5. Update `project-plan.md`'s `_Last updated:_` date.
6. Come back to this file and update **only** the "Current phase & priorities" section above, and only if the phase changed or the top priority shifted — as a short pointer to `project-plan.md`, not a restatement of its contents.
7. If nothing decision-worthy happened this session, say so explicitly rather than skipping the check silently.
