// Offline test for the split-sentence audio widening (audio-capture.js's
// sliceClipWavWhenReady) — which stretch of the rolling audio buffer a merged
// Anki sentence's clip covers.
//
// Usage:  node scripts/test-merged-audio-span.js
//         JIMAKU_API_KEY=... node scripts/test-merged-audio-span.js --live
//
// Without --live it runs on the hand-built fixtures below. With --live it also
// replays two REAL Frieren ep 7 subtitle files from Jimaku — [Moozzi2], which
// shows one cue at a time, and [NanakoRaws], which stacks several Dialogue
// events into one visible line 80% of the time. That second shape is what the
// old text-key matching could not handle (live report 2026-07-27: capturing
// from the first half of a split sentence sat busy for the full timeout and
// then wrote audio of the first half only).
//
// Reads the real function out of audio-capture.js rather than re-implementing
// it, with only the WAV encoding stubbed out — there is no audio here, just the
// question of which [start, end] the clip would be cut from.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "audio-capture.js"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from audio-capture.js — did it get renamed?`);
  return m[0];
}

// A test harness around the real markCueBoundary/sliceClipWavWhenReady, with
// the ring buffer and WAV encoder replaced by a recorder. `audioCtx`/`now` are
// driven by hand so the whole thing runs instantly instead of in real time.
function makeHarness() {
  const setup =
    grab(/^const AUDIO_BUFFER_SECONDS = .*$/m, "AUDIO_BUFFER_SECONDS") +
    `
    let cueTimeline = [];
    let cueEpoch = 0;
    let clock = 0;
    let audioCtx = { get currentTime() { return clock; } };
    // The capture clock (2026-08-15) — samples actually written, driven here by
    // hand. Equal to video time on a straight playthrough, which is what these
    // fixtures replay.
    function captureNow() { return clock; }
    // Zero in the harness so the tail wait resolves immediately: these fixtures
    // are about WHICH [start, end] a clip is cut from, and the real 0.6s pad
    // would otherwise make every case sit out a wall-clock wait for audio that
    // this harness never produces.
    const AUDIO_PAD_END_SECONDS = 0;
    let pendingCaptures = new Set();
    function flushPendingCaptures() {
      const flushing = [...pendingCaptures];
      pendingCaptures.clear();
      for (const finishNow of flushing) finishNow();
    }
    let discontinuities = [];
    function noteDiscontinuity() { discontinuities.push(clock); }
    let sliceCalls = [];
    let retainCalls = [];
    function sliceClipWav(entry) {
      sliceCalls.push({ audioStart: entry.audioStart, audioEnd: entry.audioEnd });
      return "WAV";
    }
    // Stands in for the retained edit buffer (2026-07-30). Recorded rather than
    // ignored so the tests can assert the editor is handed the SAME bounds that
    // were exported — if those drifted apart, the trim UI's "original clip"
    // markers would point somewhere the card's audio never covered.
    function retainClipForEditing(start, end, token) { retainCalls.push({ audioStart: start, audioEnd: end, token }); }
  `;
  return new Function(
    setup +
      grab(/^function markCueBoundary\([\s\S]*?\n\}/m, "markCueBoundary") +
      "\n" +
      grab(/^function noteSeek\([\s\S]*?\n\}/m, "noteSeek") +
      "\n" +
      grab(/^function sliceClipWavWhenReady\([\s\S]*?\n\}\n/m, "sliceClipWavWhenReady") +
      `
      return {
        markCueBoundary,
        noteSeek,
        sliceClipWavWhenReady,
        seekAway: () => { cueEpoch++; },
        flushPendingCaptures,
        discontinuities: () => discontinuities,
        tick: (t) => { clock = t; },
        timeline: () => cueTimeline,
        sliceCalls: () => sliceCalls,
        retainCalls: () => retainCalls,
      };`
  )();
}

// Replays a cue list through markCueBoundary exactly the way updateJapaneseCue
// does: at every distinct display window, with the joined text of every cue
// visible at that moment. Audio time is taken as equal to video time, which is
// what a straight playthrough gives.
function replay(h, cues, untilTime = Infinity) {
  const marks = [...new Set(cues.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  let lastText = null;
  for (const mark of marks) {
    if (mark > untilTime) break;
    const t = mark + 0.0005;
    const showing = cues.filter((c) => t >= c.start && t <= c.end);
    const text = showing.map((c) => c.text).join("\n");
    if (text === lastText) continue;
    lastText = text;
    h.tick(mark);
    const window = showing.length
      ? { start: Math.min(...showing.map((c) => c.start)), end: Math.max(...showing.map((c) => c.end)) }
      : null;
    const entry = h.markCueBoundary(text, window);
    entry._window = window;
  }
}

// The distinct display windows a cue list produces, in order.
function displayWindows(cues) {
  const marks = [...new Set(cues.flatMap((c) => [c.start, c.end]))].sort((a, b) => a - b);
  const out = [];
  let lastText = null;
  for (const mark of marks) {
    const t = mark + 0.0005;
    const showing = cues.filter((c) => t >= c.start && t <= c.end);
    if (!showing.length) {
      lastText = null;
      continue;
    }
    const text = showing.map((c) => c.text).join("\n");
    if (text === lastText) continue;
    lastText = text;
    out.push({ start: Math.min(...showing.map((c) => c.start)), end: Math.max(...showing.map((c) => c.end)), text });
  }
  return out;
}

let failed = 0;
function check(label, got, want) {
  const ok = Math.abs(got.audioStart - want.start) < 0.01 && Math.abs(got.audioEnd - want.end) < 0.01;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n        clip = [${got.audioStart.toFixed(2)}, ${got.audioEnd.toFixed(2)}]` +
      (ok ? "" : `   want [${want.start.toFixed(2)}, ${want.end.toFixed(2)}]`)
  );
}

// ── fixture: one sentence split across two lines, each drawn as a single cue ──
async function fixtureSingleCuePerLine() {
  const cues = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.5, end: 14.5, text: "それは違う" },
    { start: 16, end: 18, text: "次の話" },
  ];
  const h = makeHarness();
  replay(h, cues);
  const timeline = h.timeline();
  const first = timeline.find((e) => e.text === "けれど");
  const clip = await h.sliceClipWavWhenReady(first, 50, 10, 14.5);
  if (!clip) throw new Error("no clip produced");
  check("capture from the FIRST half — clip covers both halves", h.sliceCalls().pop(), { start: 10, end: 14.5 });
  check("the edit buffer is retained over the SAME bounds that were exported", h.retainCalls().pop(), { start: 10, end: 14.5 });

  const h2 = makeHarness();
  replay(h2, cues);
  const second = h2.timeline().find((e) => e.text === "それは違う");
  await h2.sliceClipWavWhenReady(second, 50, 10, 14.5);
  check("capture from the SECOND half — same clip", h2.sliceCalls().pop(), { start: 10, end: 14.5 });

  const h3 = makeHarness();
  replay(h3, cues);
  const solo = h3.timeline().find((e) => e.text === "次の話");
  h3.tick(18);
  h3.markCueBoundary("", null); // the line ends
  await h3.sliceClipWavWhenReady(solo, 50, null, null);
  check("no merge — clip is just that line (regression check)", h3.sliceCalls().pop(), { start: 16, end: 18 });
}

// ── fixture: the [NanakoRaws] shape — a second, simultaneous styled cue means
//    the displayed text is a JOIN, so it never equals any single cue's text ──
async function fixtureStackedCues() {
  const cues = [
    { start: 10, end: 12, text: "けれど" },
    { start: 10, end: 12, text: "(overlay)" },
    { start: 12.5, end: 14.5, text: "それは違う" },
    { start: 12.5, end: 14.5, text: "(overlay)" },
    { start: 16, end: 18, text: "次の話" },
  ];
  const h = makeHarness();
  replay(h, cues);
  const first = h.timeline().find((e) => e.jpStart === 10);
  await h.sliceClipWavWhenReady(first, 50, 10, 14.5);
  check("stacked cues — clip still covers both halves", h.sliceCalls().pop(), { start: 10, end: 14.5 });
}

// ── fixture: the second half has not played yet at capture time ───────────────
async function fixtureWaitsForSecondHalf() {
  const cues = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.5, end: 14.5, text: "それは違う" },
    { start: 16, end: 18, text: "次の話" },
  ];
  const h = makeHarness();
  replay(h, cues, 10); // only the first half has played
  const first = h.timeline()[h.timeline().length - 1];
  const pending = h.sliceClipWavWhenReady(first, 5000, 10, 14.5);
  let settled = false;
  pending.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 250));
  if (settled) {
    failed++;
    console.log("FAIL  waits for the second half — resolved before it played");
  } else {
    console.log("PASS  waits for the second half — still pending, as it should be");
  }
  replay(h, cues); // the rest of the episode plays out
  await pending;
  check("...then resolves covering both halves", h.sliceCalls().pop(), { start: 10, end: 14.5 });
}

// ── fixture: a merged group whose second half never arrives (end of episode) ──
async function fixtureTimeout() {
  const cues = [{ start: 10, end: 12, text: "けれど" }];
  const h = makeHarness();
  replay(h, cues);
  const first = h.timeline().find((e) => e.text === "けれど");
  await h.sliceClipWavWhenReady(first, 300, 10, 14.5);
  check("second half never plays — falls back to the clicked line", h.sliceCalls().pop(), { start: 10, end: 12 });
}

// ── fixture: a display window WIDER than the merged sentence ─────────────────
// The window spans every cue visible at that instant, so on a provider that
// stacks cues it can start before the sentence and run on past it. Snapping the
// clip to the window's edges then captures the neighbours too — the "bled into
// the next line" half of the 2026-07-31 live report. Built at the timeline level
// rather than by replay, so the window is exactly the awkward shape under test.
async function fixtureWindowWiderThanSentence() {
  const h = makeHarness();
  h.tick(10);
  const first = h.markCueBoundary("けれど", { start: 10, end: 12 });
  h.tick(12);
  // One window covering the sentence's second half AND what follows it.
  h.markCueBoundary("それは違う\n(sign)", { start: 12, end: 20 });
  h.tick(16);
  h.markCueBoundary("", null);
  await h.sliceClipWavWhenReady(first, 50, 10, 14);
  check("a window running past the sentence is cut back to the sentence's end", h.sliceCalls().pop(), {
    start: 10,
    end: 14,
  });

  const h2 = makeHarness();
  h2.tick(8);
  // A window that STARTS before the merged sentence does — the mirror case.
  h2.markCueBoundary("(sign)\nけれど", { start: 8, end: 12 });
  h2.tick(12);
  const second = h2.markCueBoundary("それは違う", { start: 12, end: 14 });
  h2.tick(14);
  h2.markCueBoundary("", null);
  await h2.sliceClipWavWhenReady(second, 50, 10, 14);
  check("a window starting before the sentence is cut forward to its start", h2.sliceCalls().pop(), {
    start: 10,
    end: 14,
  });
}

// ── fixture: seeking and episode changes invalidate the recorded timings ─────
async function fixtureSeekAndNavigation() {
  const cues = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.5, end: 14.5, text: "それは違う" },
  ];
  const h = makeHarness();
  replay(h, cues, 10); // only the first half has played
  const first = h.timeline()[h.timeline().length - 1];
  const pending = h.sliceClipWavWhenReady(first, 5000, 10, 14.5);
  h.tick(11);
  h.noteSeek(); // the user skips somewhere else mid-capture
  replay(h, cues); // whatever plays next fills the buffer
  const clip = await pending;
  // CHANGED 2026-08-15: this used to assert no audio at all. Voiding the clip
  // was the right call about the audio AFTER the jump and the wrong call about
  // the audio before it — at the moment of the seek the buffer still holds the
  // line the user actually clicked, most or all of the way through. It is now
  // sliced at that instant instead (see flushPendingCaptures), so the card gets
  // a short but correct clip rather than an empty audio field. The wrong-side-
  // of-the-jump audio is still excluded: the end is the seek, not what followed.
  const ok = clip !== null && Math.abs(h.sliceCalls()[h.sliceCalls().length - 1].audioEnd - 11) < 0.01;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  a capture spanning a seek is cut at the seek, not across it` +
      (ok ? "" : `\n        got ${JSON.stringify(h.sliceCalls().pop())}`)
  );

  // The open cue is closed at the jump, so its own clip still describes the
  // audio that was actually heard up to that point.
  const h2 = makeHarness();
  h2.tick(10);
  const open = h2.markCueBoundary("けれど", { start: 10, end: 12 });
  h2.tick(11);
  h2.noteSeek();
  const closed = open.audioEnd === 11;
  if (!closed) failed++;
  console.log(
    `${closed ? "PASS" : "FAIL"}  the open cue is closed at the seek, not left running across it` +
      (closed ? "" : `\n        audioEnd = ${open.audioEnd}`)
  );

  // The plain, unmerged case — a word captured while its line is still on
  // screen, then the user changes episode before the line ends (2026-08-15).
  // This is the shape the live pass reported as "the audio is always empty if I
  // switch to another episode before the sentence finishes capturing".
  const hNav = makeHarness();
  hNav.tick(10);
  const openLine = hNav.markCueBoundary("けれど", { start: 10, end: 12 });
  const navPending = hNav.sliceClipWavWhenReady(openLine, 5000, null, null);
  hNav.tick(11.4);
  hNav.noteSeek(); // what resetCaptureForNavigation does first
  const navClip = await navPending;
  const navOk = navClip !== null;
  if (!navOk) failed++;
  console.log(`${navOk ? "PASS" : "FAIL"}  navigating mid-capture keeps the audio heard so far, instead of voiding it`);
  if (navOk) check("...cut at the moment of the jump", hNav.sliceCalls().pop(), { start: 10, end: 11.4 });

  // The flush is capped at the line's own subtitle window (2026-08-15). SPA
  // navigation is noticed by a poll, up to a second after it happened, so the
  // buffer can already hold the start of the next episode by the time the
  // pending capture is flushed.
  const hCap = makeHarness();
  hCap.tick(10);
  const capLine = hCap.markCueBoundary("けれど", { start: 10, end: 12 });
  const capPending = hCap.sliceClipWavWhenReady(capLine, 5000, null, null);
  hCap.tick(13.5); // the jump was noticed 1.5s after the line's own window ended
  hCap.noteSeek();
  await capPending;
  check("a flushed clip can't run past the line's own subtitle window", hCap.sliceCalls().pop(), {
    start: 10,
    end: 12.25,
  });

  // Widening must not reach back across a jump into timings recorded before it.
  const h3 = makeHarness();
  h3.tick(10);
  h3.markCueBoundary("前の話", { start: 10, end: 12 });
  h3.tick(12);
  h3.noteSeek();
  const after = h3.markCueBoundary("それは違う", { start: 12, end: 14 });
  h3.tick(14);
  h3.markCueBoundary("", null);
  await h3.sliceClipWavWhenReady(after, 50, 10, 14);
  check("widening stops at the seek instead of splicing across it", h3.sliceCalls().pop(), { start: 12, end: 14 });
}

// ── live: replay real Jimaku files and merge every adjacent display pair ──────
async function live() {
  const { parseAss } = require(path.join(ROOT, "subtitle-parser.js"));
  const key = process.env.JIMAKU_API_KEY;
  if (!key) {
    console.log("\n(skipping --live: JIMAKU_API_KEY not set)");
    return;
  }
  const res = await fetch("https://jimaku.cc/api/entries/729/files?episode=7", { headers: { Authorization: key } });
  const files = await res.json();
  for (const prefix of ["[Moozzi2]", "[NanakoRaws] Sousou no Frieren - 07 (1080p).ass"]) {
    const f = files.find((x) => x.name.startsWith(prefix));
    const cues = parseAss(await (await fetch(f.url)).text());
    const windows = displayWindows(cues);
    let mismatches = 0;
    let tested = 0;
    // Treat every adjacent pair of displayed lines as if it were one sentence
    // split in two, and capture from the FIRST of the pair. Each pair gets its
    // own harness fed only its own two lines (plus the gap between them and the
    // boundary that closes the second) — replaying the whole episode into one
    // harness instead would see the real ring buffer's 45-second trim drop
    // every entry but the last few, which is correct behaviour and useless for
    // testing.
    for (let i = 0; i + 1 < windows.length; i++) {
      const a = windows[i];
      const b = windows[i + 1];
      // Only pairs close enough in time to plausibly be one spoken sentence.
      // Pairing lines a minute and a half apart (either side of an OP/ED card)
      // isn't a case the merge can produce, and the ring buffer genuinely
      // cannot hold both — the clip correctly falls back to the clicked line
      // there, which would read as a failure here for the wrong reason.
      if (b.start - a.end > 5) continue;
      const h = makeHarness();
      h.tick(a.start);
      const entry = h.markCueBoundary(a.text, { start: a.start, end: a.end });
      if (b.start > a.end) {
        h.tick(a.end);
        h.markCueBoundary("", null); // the gap between the two lines
      }
      h.tick(b.start);
      h.markCueBoundary(b.text, { start: b.start, end: b.end });
      h.tick(b.end);
      h.markCueBoundary("", null); // closes the second line
      tested++;
      await h.sliceClipWavWhenReady(entry, 50, a.start, b.end);
      const got = h.sliceCalls().pop();
      if (!got || Math.abs(got.audioStart - a.start) > 0.01 || Math.abs(got.audioEnd - b.end) > 0.01) {
        mismatches++;
        if (mismatches <= 3) {
          console.log(
            `        e.g. window ${i}: got ${got ? `[${got.audioStart.toFixed(2)}, ${got.audioEnd.toFixed(2)}]` : "no clip"} ` +
              `want [${a.start.toFixed(2)}, ${b.end.toFixed(2)}]`
          );
        }
      }
    }
    const ok = mismatches === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${f.name}\n        ${tested} adjacent-pair merges, ${mismatches} wrong`);
  }
}

(async () => {
  await fixtureSingleCuePerLine();
  await fixtureStackedCues();
  await fixtureWaitsForSecondHalf();
  await fixtureTimeout();
  await fixtureWindowWiderThanSentence();
  await fixtureSeekAndNavigation();
  if (process.argv.includes("--live")) await live();
  console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
  process.exit(failed ? 1 : 0);
})();
