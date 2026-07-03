# Project: Japanese Immersion Extension for Crunchyroll

This file is a **session-start briefing**, not the full project record. It exists to tell you the goal, the rules, and what to work on right now. For anything else — competitive analysis, technical history, the full decisions log, open questions — read `project-plan.md`, which is the source of truth. Don't duplicate its content back into this file; keep this one short and current.

## Core goal — read this first

Let learners who already study Japanese elsewhere (kanji/vocab SRS, grammar SRS, a textbook, a tutor) use Crunchyroll anime as real immersion practice, with just enough support to confirm what they half-know without breaking the scene. **The extension's job is to keep them watching, not to teach them.**

**Target user:** not a beginner looking for their first grammar explanation. Someone who already has a study system and uses anime time to meet vocab/grammar in the wild, build reading speed, and quickly confirm or correct what they think they know — then get back to the show.

**Litmus test for any new feature idea:** Does this help the user capture something quickly and keep watching, or feed something into a system they already use (e.g. Anki)? Or does it ask them to stop and be taught, or duplicate a tool they already trust (e.g. Anki, or their existing grammar/SRS tools)? First answer → in scope. Second answer → out, regardless of whether a competitor has it. This test is the tie-breaker whenever something is ambiguous — it overrides the scope list in `project-plan.md`, not the other way around.

**What this is:** A Chrome extension adding clickable, learner-friendly Japanese subtitles to Crunchyroll (which has no native Japanese subtitle track at all). Click/hover a word mid-episode → fast dictionary check. Capture a word or sentence → send to Anki. Everything else is secondary to that loop.

## Read before starting work

At the start of every session, read `project-plan.md`'s **Decisions Log** and **Open Questions** sections (Sections 7–8) — they carry context that isn't summarized here and may be directly relevant to what you're about to build.

## Current phase & priorities

**Phase 4 — Sync tooling & multi-show validation** (see `project-plan.md` Section 6 for full detail). Top priority right now:
1. Live browser testing of the full grouping-pipeline rebuild against real Crunchyroll — everything from the last session's work is corpus-validated only, not yet confirmed working in the live player. Fix whatever this surfaces.
2. Once Phase 4 testing is stable, Phase 5 (Anki export) starts with the DRM feasibility test — see `project-plan.md` Open Questions #7 for the exact test to run.

Don't start Phase 5 or 6 work ahead of this unless explicitly told to — check `project-plan.md` Section 6 for the current phase marker if unsure.

## Scope guardrails — do not build these unless asked

- **No AI grammar/sentence explanations, ever, in any form.** Breaks immersion and competes with resources the user already trusts more. If this ever gets revisited, that's a deliberate scope conversation to have with the user first, not something to build proactively.
- **No built-in wordbook/SRS/quiz system.** Anki export is the mechanism for this — don't build a competing review system.
- **No Netflix, manga OCR, or general web support.** Crunchyroll only.
- **JLPT level tagging is opt-in/off-by-default only** — never an always-visible label, filter, or sort feature.
- **Don't build audio/screenshot Anki fields, or their UI, until the DRM feasibility test (Phase 5) resolves.**
- **Don't build the frequency-marker toggle's actual logic** — it's a placeholder UI element only, blocked on a corpus-licensing gap. See `project-plan.md` Section 5.

Full reasoning for all of these is in `project-plan.md` Section 4 (V1 Scope) and Section 7 (Decisions Log) — check there before assuming an exception applies.

## Working style

- I (the user) have no prior coding experience. Explain what you're doing in plain terms when it's not obvious. Prefer small, testable steps over large multi-file changes I can't verify.
- When something is ambiguous, apply the litmus test above first. If still ambiguous, default to `project-plan.md`'s V1 Scope rather than asking — unless it's a meaningful scope decision, in which case ask first rather than deciding silently.

## End-of-session checklist

Before stopping, update `project-plan.md` (not this file — this file only needs edits if the *current phase/priorities* section above has gone stale):

1. **Build Order (Section 6):** move finished items from "remaining" to "done" for the current phase; add newly-discovered remaining items in priority order.
2. **Decisions Log (Section 7):** scan the session for genuine decisions — a real rejected alternative existed, not just "there was nothing else to do." Add qualifying ones with a short bolded title, dated, in order. If a decision revises an earlier logged one, update that entry rather than adding a duplicate.
3. **Open Questions (Section 8):** move anything resolved this session into "Resolved"; add new ones to "Ongoing" in the right phase-priority slot.
4. **Technical Architecture (Section 5):** if something now works differently than planned, update the relevant entry directly.
5. Come back to this file (`CLAUDE.md`) and update the **Current phase & priorities** section above if the phase changed or priorities shifted.
6. If nothing decision-worthy happened this session, say so explicitly rather than skipping the check silently.
