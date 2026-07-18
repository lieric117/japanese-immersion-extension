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

**Phase 5 — Anki export.** Core loop is built and confirmed live end-to-end (2026-07-17): DRM test, AnkiConnect wiring, the dedicated "Japanese Immersion" deck/note type, the "Add to Anki" button with exact-offset sentence bolding, and an opt-in POS toggle — see `project-plan.md` Section 6 Phase 5 for the full done list. Paused here at the user's call. Next, in priority order (none started, each needs real work before it's a quick pickup):
1. Frequency-rank badge — needs a `jmdict-compact.json` regeneration (the raw TUBELEX score is currently never persisted per-entry, only used to sort during generation) plus real percentile-based tier thresholds derived from the actual data, confirmed with the user before hardcoding.
2. JLPT level — needs an external data source chosen first (jmdict-compact.json has none); a real decision, not a build task.
3. Audio field placement/design — confirmed technically viable (Decisions Log 2026-07-17), but where it fits in the build order and its capture-timing/UI design is the user's call, still pending.

If regenerating `jmdict-compact.json` (any phase), both `scripts/fix-jmdict-priority.js` AND `scripts/apply-tubelex-frequency.js` must be re-run after — a regression from skipping the latter shipped and had to be caught mid-testing (see Decisions Log 2026-07-13).

`JIMAKU_API_KEY` is a persistent environment variable in `~/.zshenv` — `scripts/batch-test.js` runs directly without asking the user for the key.

## Scope guardrails — do not build these unless asked

- **No AI grammar/sentence explanations, ever, in any form.** Breaks immersion and competes with resources the user already trusts more. If this ever gets revisited, that's a deliberate scope conversation to have with the user first, not something to build proactively.
- **No built-in wordbook/SRS/quiz system.** Anki export is the mechanism for this — don't build a competing review system.
- **No other video platforms (Netflix, YouTube, etc.), manga OCR, or general web support.** Crunchyroll-only by design, not a Netflix-specific gap.
- **No romaji or kana-only subtitle-display modes.** Both explicitly excluded 2026-07-04, not just deprioritized — wrong fit for this persona, not a missing feature. Furigana mode is the one display-simplification feature in scope.
- **JLPT level tagging is opt-in/off-by-default only** — never an always-visible label, filter, or sort feature. (JLPT data will be sourced externally if jmdict-simplified lacks it — decided 2026-07-04, not dropped.)
- **Screenshot Anki field is dropped from the roadmap entirely (2026-07-17, confirmed DRM-blocked, not deferred) — don't build it.** Audio field is confirmed technically viable (2026-07-17) but not yet scheduled or designed — ask the user before building it (`project-plan.md` Section 8).
- **The frequency-rank badge is now a real feature, not a placeholder** — 3 text tiers (Common/Uncommon/Rare), no raw numbers, no badge when there's no data (decided 2026-07-04). It replaces the old common-word toggle entirely — don't build both. Numeric thresholds per tier are still TBD; confirm with the user before hardcoding them. See `project-plan.md` Section 5.

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
