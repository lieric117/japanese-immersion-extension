// Offline test for English subtitle visibility across split-sentence Japanese
// cue gaps (content.js's bridgedEnglishText).
//
// Usage:  node scripts/test-english-bridging.js
//
// Replays a timeline at the browser's real ~4Hz `timeupdate` rate and records
// what the English box shows on every tick, so a one-tick blink is visible to
// the assertions the same way it is to the eye. Runs the PRE-FIX logic over the
// same timeline as a control — if a case doesn't blink before the fix, it isn't
// testing anything.
//
// Reads the real functions out of content.js rather than re-implementing them.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const { normalizeHalfwidthKatakana } = require(path.join(ROOT, "tokenize-utils.js"));

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — did it get renamed?`);
  return m[0];
}

const TICK = 0.25; // Chrome fires timeupdate ~4x/second

function makeHarness(jpCues, enCues) {
  const parts = [
    "let cues = JP, englishCues = EN, offset = 0;",
    grab(/^const STAGE_RE =[\s\S]*?;$/m, "STAGE_RE"),
    grab(/^const SPEAKER_PREFIX_RE =[\s\S]*?;$/m, "SPEAKER_PREFIX_RE"),
    grab(/^const INLINE_FURIGANA_RE =[\s\S]*?;$/m, "INLINE_FURIGANA_RE"),
    grab(/^const FANSUB_MARKUP_RE =[\s\S]*?;$/m, "FANSUB_MARKUP_RE"),
    grab(/^function cueDisplayText\(cue\) \{[\s\S]*?\n\}/m, "cueDisplayText"),
    grab(/^function pairEnglishCues\([\s\S]*?\n\}/m, "pairEnglishCues"),
    grab(/^function pairedEnglishText\([\s\S]*?\n\}/m, "pairedEnglishText"),
    grab(/^const JP_GAP_BRIDGE_SECONDS = .*$/m, "JP_GAP_BRIDGE_SECONDS"),
    grab(/^function bridgedEnglishText\([\s\S]*?\n\}/m, "bridgedEnglishText"),
    grab(/^function japaneseDisplayAt\([\s\S]*?\n\}/m, "japaneseDisplayAt"),
    "return { japaneseDisplayAt, pairedEnglishText, bridgedEnglishText, JP_GAP_BRIDGE_SECONDS };",
  ];
  return new Function("normalizeHalfwidthKatakana", "JP", "EN", parts.join("\n"))(
    normalizeHalfwidthKatakana,
    jpCues,
    enCues
  );
}

// Walks the timeline and returns the per-tick [japanese, english] the boxes
// would show. `bridge: false` reproduces the pre-2026-07-29 behaviour (English
// cleared whenever no Japanese is on screen) as a control.
function replay(h, from, to, bridge) {
  const frames = [];
  for (let t = from; t <= to + 1e-9; t += TICK) {
    const { window, text } = h.japaneseDisplayAt(t);
    const en = window ? h.pairedEnglishText(window) : bridge ? h.bridgedEnglishText(t) : "";
    frames.push({ t: Number(t.toFixed(3)), jp: text, en });
  }
  return frames;
}

// How many times the English box goes from showing something to showing
// nothing. A split sentence should do this once, at the end — never in the
// middle.
function clears(frames) {
  let n = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i - 1].en && !frames[i].en) n++;
  return n;
}
// Every MOUNT event: a tick where the English box goes from showing nothing (or
// something different) to showing text. Compares against the PREVIOUS TICK, not
// against the last thing pushed — a blink re-mounts the identical sentence, so
// collapsing on value would hide exactly the bug this file exists to catch.
function mounts(frames) {
  const out = [];
  let prev = "";
  for (const f of frames) {
    if (f.en && f.en !== prev) out.push(f.en);
    prev = f.en;
  }
  return out;
}

let failed = 0;
function check(label, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
}

const EN_ONE = [{ start: 10, end: 15, text: "But that is not how it went." }];

// ── Zone 2: short gap, same English sentence — must be bridged ───────────────
{
  // 400ms gap: at 4Hz at least one tick lands inside it.
  const jp = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.4, end: 14.5, text: "それは違った" },
  ];
  const h = makeHarness(jp, EN_ONE);
  const after = replay(h, 9, 16, true);
  const before = replay(h, 9, 16, false);

  check(
    "control: the pre-fix logic really does blink here",
    mounts(before).length === 2 && clears(before) === 2,
    `pre-fix mounts=${mounts(before).length} clears=${clears(before)} — if this isn't 2/2 the case tests nothing`
  );
  check(
    "Zone 2: short gap, same English — mounted once, cleared once",
    mounts(after).length === 1 && clears(after) === 1,
    `mounts=${mounts(after).length} clears=${clears(after)}`
  );
  check(
    "Zone 2: Japanese box still empties during the gap (display unchanged above)",
    after.some((f) => !f.jp && f.en),
    "expected at least one tick with English showing and Japanese empty"
  );
  check(
    "Zone 2: Japanese line itself is untouched by bridging",
    JSON.stringify(after.map((f) => f.jp)) === JSON.stringify(before.map((f) => f.jp)),
    "the Japanese sequence differs between bridged and unbridged replays"
  );
}

// ── Zone 3: long gap, same English — must NOT be bridged ────────────────────
{
  const jp = [
    { start: 10, end: 12, text: "けれど" },
    { start: 14.5, end: 16, text: "それは違った" }, // 2.5s gap, over the threshold
  ];
  const en = [{ start: 10, end: 16, text: "But that is not how it went." }];
  const h = makeHarness(jp, en);
  const frames = replay(h, 9, 17, true);
  check(
    "Zone 3: long gap is not bridged — English clears through the pause",
    frames.some((f) => !f.jp && !f.en) && mounts(frames).length === 2,
    `mounts=${mounts(frames).length}, no fully-empty tick found: ${!frames.some((f) => !f.jp && !f.en)}`
  );
}

// ── Boundary: different English either side — behaviour unchanged ────────────
{
  const jp = [
    { start: 10, end: 12, text: "おはよう" },
    { start: 12.4, end: 14.5, text: "いい天気だね" },
  ];
  const en = [
    { start: 10, end: 12, text: "Good morning." },
    { start: 12.4, end: 14.5, text: "Nice weather." },
  ];
  const h = makeHarness(jp, en);
  const after = replay(h, 9, 16, true);
  const before = replay(h, 9, 16, false);
  check(
    "Boundary: adjacent cues with DIFFERENT English behave exactly as before",
    JSON.stringify(after) === JSON.stringify(before),
    "bridging changed a case it must not touch"
  );
}

// ── Zone 1: truly simultaneous boundary — no blink, nothing to bridge ───────
{
  const jp = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12, end: 14, text: "それは違った" }, // cue 2 starts exactly as cue 1 ends
  ];
  const h = makeHarness(jp, EN_ONE);
  const frames = replay(h, 9, 15, true);
  check(
    "Zone 1: back-to-back cues — English mounts once, never blinks",
    mounts(frames).length === 1 && clears(frames) === 1,
    `mounts=${mounts(frames).length} clears=${clears(frames)}`
  );
}

// ── Threshold edges ─────────────────────────────────────────────────────────
{
  const h0 = makeHarness([], []);
  const T = h0.JP_GAP_BRIDGE_SECONDS;
  for (const [gap, shouldBridge, label] of [
    [T - 0.1, true, "just inside the threshold"],
    [T + 0.1, false, "just outside the threshold"],
  ]) {
    const jp = [
      { start: 10, end: 12, text: "けれど" },
      { start: 12 + gap, end: 14 + gap, text: "それは違った" },
    ];
    const en = [{ start: 10, end: 15 + gap, text: "But that is not how it went." }];
    const h = makeHarness(jp, en);
    const frames = replay(h, 9, 15 + gap, true);
    const bridged = mounts(frames).length === 1;
    check(
      `Threshold: a ${gap.toFixed(2)}s gap is ${shouldBridge ? "" : "not "}bridged (${label})`,
      bridged === shouldBridge,
      `mounts=${mounts(frames).length}`
    );
  }
}

// ── Three-cue sentence, two gaps ────────────────────────────────────────────
{
  const jp = [
    { start: 10, end: 11.5, text: "けれど" },
    { start: 11.9, end: 13, text: "それは" },
    { start: 13.4, end: 14.5, text: "違った" },
  ];
  const h = makeHarness(jp, EN_ONE);
  const frames = replay(h, 9, 16, true);
  check(
    "A sentence split across THREE cues bridges both gaps",
    mounts(frames).length === 1 && clears(frames) === 1,
    `mounts=${mounts(frames).length} clears=${clears(frames)}`
  );
}

// ── Stage directions must not act as bridge anchors ─────────────────────────
{
  // A stage-direction-only cue sits in the gap. It renders to nothing, so the
  // gap is still a gap and the two real lines should still bridge across it.
  const jp = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.1, end: 12.3, text: "（ドアの開く音）" },
    { start: 12.4, end: 14.5, text: "それは違った" },
  ];
  const h = makeHarness(jp, EN_ONE);
  const frames = replay(h, 9, 16, true);
  check(
    "A stage-direction cue inside the gap doesn't break the bridge",
    mounts(frames).length === 1,
    `mounts=${mounts(frames).length} — a filtered-out cue was treated as real`
  );
}

// ── No English track at all ─────────────────────────────────────────────────
{
  const jp = [
    { start: 10, end: 12, text: "けれど" },
    { start: 12.4, end: 14.5, text: "それは違った" },
  ];
  const h = makeHarness(jp, []);
  const frames = replay(h, 9, 16, true);
  check(
    "No English cues — nothing is ever shown or bridged",
    frames.every((f) => f.en === ""),
    "produced English text with an empty English track"
  );
}

console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
process.exit(failed ? 1 : 0);
