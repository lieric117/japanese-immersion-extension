// Offline test for the in-page edit panel (2026-07-30 redesign of "edit last
// card") and the retained-audio buffer it edits.
//
// Usage:  node scripts/test-edit-panel.js
//
// Covers the parts with real logic: the Anki-field ↔ plain-text conversions the
// panel round-trips every field through, where the target word's bolding ends
// up after an edit, the chip's content-scaled expand window, and the
// updateNoteFields call shape — in particular that replacing audio blanks the
// field in the same call, since not doing so makes the card play both clips.
//
// AnkiConnect and the DOM are stubbed; everything under test is read out of the
// real source files.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

function grab(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} — did it get renamed?`);
  return m[0];
}

let failed = 0;
function check(label, cond, detail) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
}

// A `document.createElement` stub just capable enough for the HTML↔text
// helpers: these only ever see markup this extension itself produced (escaped
// text plus <br> and <b>), so tag-stripping and the five escaped entities is a
// faithful stand-in for the browser's parser here.
const document = {
  createElement: () => ({
    _text: "",
    set innerHTML(html) {
      this._text = String(html)
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
    },
    get textContent() {
      return this._text;
    },
  }),
};

const helpers = new Function(
  "document",
  [
    grab(content, /^function escapeHtml\([\s\S]*?\n\}/m, "escapeHtml"),
    grab(content, /^function ankiHtmlToPlain\([\s\S]*?\n\}/m, "ankiHtmlToPlain"),
    grab(content, /^function plainToAnkiHtml\([\s\S]*?\n\}/m, "plainToAnkiHtml"),
    grab(content, /^function parseStoredSentence\([\s\S]*?\n\}/m, "parseStoredSentence"),
    grab(content, /^function buildEditedSentenceHtml\([\s\S]*?\n\}/m, "buildEditedSentenceHtml"),
    grab(content, /^function parseSoundFilename\([\s\S]*?\n\}/m, "parseSoundFilename"),
    grab(content, /^const CHIP_EXPANDED_BASE_MS = .*$/m, "CHIP_EXPANDED_BASE_MS"),
    grab(content, /^const CHIP_EXPANDED_PER_CHAR_MS = .*$/m, "CHIP_EXPANDED_PER_CHAR_MS"),
    grab(content, /^const CHIP_EXPANDED_MAX_MS = .*$/m, "CHIP_EXPANDED_MAX_MS"),
    grab(content, /^function chipExpandedMs\([\s\S]*?\n\}/m, "chipExpandedMs"),
    "return { ankiHtmlToPlain, plainToAnkiHtml, parseStoredSentence, buildEditedSentenceHtml, parseSoundFilename, chipExpandedMs, CHIP_EXPANDED_MAX_MS };",
  ].join("\n")
)(document);

// ── stored sentence → plain text + where the target word sits ───────────────
{
  const stored = "けれど<br><b>それ</b>は違った";
  const parsed = helpers.parseStoredSentence(stored);
  check(
    "stored sentence: <br> becomes a newline and the bolded word is located by offset",
    parsed.text === "けれど\nそれは違った" && parsed.wordSurface === "それ" && parsed.wordStart === 4,
    JSON.stringify(parsed)
  );
  check(
    "the recorded offset actually indexes the word in the plain text",
    parsed.text.slice(parsed.wordStart, parsed.wordStart + parsed.wordSurface.length) === "それ",
    JSON.stringify(parsed)
  );
}
{
  const parsed = helpers.parseStoredSentence("bolding was lost somehow");
  check(
    "a sentence with no bolding parses without inventing one",
    parsed.wordStart === -1 && parsed.wordSurface === "",
    JSON.stringify(parsed)
  );
}
{
  // The identical word twice: the offset must decide, not a text search.
  const parsed = helpers.parseStoredSentence("それはそれで<b>それ</b>だ");
  check(
    "the SECOND occurrence stays the marked one",
    parsed.wordStart === 6 && parsed.text.slice(6, 8) === "それ",
    JSON.stringify(parsed)
  );
}

// ── rebuilding the sentence after an edit ──────────────────────────────────
{
  const original = "それはそれで それだ";
  // The offset is verified before use, so the second occurrence stays bolded
  // rather than the first.
  const html = helpers.buildEditedSentenceHtml(original, "それ", 7);
  check(
    "an unedited sentence keeps bolding the occurrence that was captured",
    html === "それはそれで <b>それ</b>だ",
    html
  );
}
{
  const html = helpers.buildEditedSentenceHtml("まったく違う文です", "それ", 0);
  check(
    "if the word was edited out, the sentence saves with no bolding rather than guessing",
    html === "まったく違う文です" && !html.includes("<b>"),
    html
  );
}
{
  const html = helpers.buildEditedSentenceHtml("新しい それ の文", "それ", 0);
  check(
    "an edited sentence re-locates the word",
    html === "新しい <b>それ</b> の文",
    html
  );
}
{
  const html = helpers.buildEditedSentenceHtml("a < b & c\nsecond line", "b", 0);
  check(
    "HTML-special characters are escaped and newlines become <br>",
    html === "a &lt; <b>b</b> &amp; c<br>second line",
    html
  );
}
// The live-testing bug this function was rewritten for (2026-07-31): changing
// the target word passed the OLD word's offset with the NEW word's surface,
// and the old code spliced at it — deleting `surface.length` characters of the
// sentence at a position that didn't spell the word. The exact reported case,
// which produced うまくら うまくいったみたいだね.
{
  const original = "どうやら うまくいったみたいだね";
  const html = helpers.buildEditedSentenceHtml(original, "うまく", 0);
  check(
    "changing the target word never edits the sentence, only its bolding",
    html === "どうやら <b>うまく</b>いったみたいだね",
    html
  );
  check(
    "the reported corruption (うまくら…) cannot be produced",
    !helpers.ankiHtmlToPlain(html).startsWith("うまくら"),
    html
  );
  check(
    "the sentence's own characters survive the rebuild unchanged",
    helpers.ankiHtmlToPlain(html) === original,
    helpers.ankiHtmlToPlain(html)
  );
}
{
  // The new word's own offset is honoured when it's the RIGHT one — the second
  // occurrence, not the first, when that's what the picker reported.
  const html = helpers.buildEditedSentenceHtml("それはそれで それだ", "それ", 3);
  check(
    "a verified offset picks out the intended occurrence of a repeated word",
    html === "それは<b>それ</b>で それだ",
    html
  );
}

// ── round-tripping ─────────────────────────────────────────────────────────
{
  const text = "line one\nline two & <tag>";
  const back = helpers.ankiHtmlToPlain(helpers.plainToAnkiHtml(text));
  check("plain → Anki HTML → plain is lossless", back === text, JSON.stringify(back));
}

// ── audio filename extraction ──────────────────────────────────────────────
{
  check(
    "the superseded media filename is recovered from the Audio field",
    helpers.parseSoundFilename("[sound:jp-immersion-123-456.wav]") === "jp-immersion-123-456.wav",
    "parse failed"
  );
  check(
    "an empty Audio field yields no filename to delete",
    helpers.parseSoundFilename("") === null && helpers.parseSoundFilename(undefined) === null,
    "expected null"
  );
}

// ── chip expand window scales with content ─────────────────────────────────
{
  const short = helpers.chipExpandedMs({ sentenceText: "はい", translation: "Yes." });
  const long = helpers.chipExpandedMs({
    sentenceText: "けれどそれは違った、と彼女はしばらく考えてから静かに言った",
    translation: "But that was not how it happened, she said quietly after thinking for a while.",
  });
  check(
    "a longer capture gets a longer window than a single word",
    long > short,
    `short=${short} long=${long}`
  );
  const huge = helpers.chipExpandedMs({ sentenceText: "あ".repeat(5000), translation: "x".repeat(5000) });
  check(
    "the window is capped, so a pathological line can't pin the chip open",
    huge === helpers.CHIP_EXPANDED_MAX_MS,
    `huge=${huge}`
  );
  check(
    "the expanded window always ends before the chip's own lifetime",
    helpers.CHIP_EXPANDED_MAX_MS < Number(grab(content, /^const CHIP_LIFETIME_MS = (\d+)/m, "CHIP_LIFETIME_MS").match(/\d+/)[0]),
    "expanded window can outlast the chip"
  );
}

// ── background: updateNoteFields call shape ────────────────────────────────
function makeUpdate(handler) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const { action, params } = JSON.parse(init.body);
    calls.push({ action, params });
    let result = null;
    let error = null;
    try {
      result = handler(action, params);
    } catch (e) {
      error = e.message;
    }
    return { json: async () => ({ result, error }) };
  };
  const fns = new Function(
    "fetch",
    [
      grab(bg, /^const ANKICONNECT_URL = .*$/m, "ANKICONNECT_URL"),
      grab(bg, /^const ANKICONNECT_VERSION = .*$/m, "ANKICONNECT_VERSION"),
      grab(bg, /^async function invokeAnkiConnect\([\s\S]*?\n\}/m, "invokeAnkiConnect"),
      grab(bg, /^async function ankiNoteInfo\([\s\S]*?\n\}/m, "ankiNoteInfo"),
      grab(bg, /^async function updateAnkiNote\([\s\S]*?\n\}/m, "updateAnkiNote"),
      "return { updateAnkiNote, ankiNoteInfo };",
    ].join("\n")
  )(fakeFetch);
  return { ...fns, calls };
}

(async () => {
  {
    const { updateAnkiNote, calls } = makeUpdate(() => null);
    await updateAnkiNote({ noteId: 1, fields: { Sentence: "x" } });
    check(
      "a text-only edit sends one updateNoteFields and touches no media",
      calls.length === 1 && calls[0].action === "updateNoteFields" && !calls[0].params.note.audio,
      JSON.stringify(calls)
    );
  }
  {
    const { updateAnkiNote, calls } = makeUpdate(() => null);
    await updateAnkiNote({
      noteId: 7,
      fields: { Sentence: "x" },
      audio: "BASE64",
      previousAudioFilename: "old.wav",
    });
    const note = calls[0].params.note;
    check(
      "replacing audio blanks the Audio field in the SAME call",
      note.fields.Audio === "" && note.audio[0].data === "BASE64" && note.audio[0].fields[0] === "Audio",
      JSON.stringify(note)
    );
    check(
      "the superseded media file is deleted AFTER the update, not before",
      calls.length === 2 && calls[1].action === "deleteMediaFile" && calls[1].params.filename === "old.wav",
      JSON.stringify(calls.map((c) => c.action))
    );
  }
  {
    // A failed update must leave the old media alone — the note still points at it.
    const { updateAnkiNote, calls } = makeUpdate((action) => {
      if (action === "updateNoteFields") throw new Error("cannot create note because it is a duplicate");
      return null;
    });
    let threw = null;
    try {
      await updateAnkiNote({ noteId: 7, fields: {}, audio: "B", previousAudioFilename: "old.wav" });
    } catch (e) {
      threw = e.message;
    }
    check(
      "a failed update never deletes the old audio",
      threw !== null && !calls.some((c) => c.action === "deleteMediaFile"),
      JSON.stringify(calls.map((c) => c.action))
    );
  }
  {
    // Media deletion is best-effort: an untidy leftover must not turn a
    // successful edit into a reported failure.
    const { updateAnkiNote } = makeUpdate((action) => {
      if (action === "deleteMediaFile") throw new Error("no such file");
      return null;
    });
    let ok = false;
    try {
      await updateAnkiNote({ noteId: 7, fields: {}, audio: "B", previousAudioFilename: "gone.wav" });
      ok = true;
    } catch {}
    check("a failed media cleanup still reports the edit as saved", ok, "the edit was reported as failed");
  }
  {
    const { ankiNoteInfo } = makeUpdate((action) => (action === "notesInfo" ? [{}] : null));
    const info = await ankiNoteInfo(5);
    check("a deleted note reads back as null, not as an empty card", info === null, JSON.stringify(info));
  }
  {
    const { ankiNoteInfo } = makeUpdate((action) =>
      action === "notesInfo" ? [{ noteId: 5, fields: { Word: { value: "分かる" } }, tags: [] }] : null
    );
    const info = await ankiNoteInfo(5);
    check(
      "a live note reads back with its field values flattened",
      info?.fields.Word === "分かる",
      JSON.stringify(info)
    );
  }

  // The redesign's central claim: editing no longer requires leaving the page.
  check(
    "neither trigger surface opens Anki's editor as its primary action any more",
    /editBtn\.addEventListener\("click", \(\) => openEditPanel\(/.test(content) &&
      /btn\.addEventListener\("click", \(\) => \{\s*if \(!lastAddedNote\) return;\s*openEditPanel\(/.test(content),
    "a trigger surface still calls openAnkiNoteInEditor directly"
  );
  check(
    "Anki's own editor survives only as the panel's secondary escape hatch",
    (content.match(/openAnkiNoteInEditor\(/g) ?? []).length === 2 &&
      /openInAnki\.addEventListener\("click", \(\) => openAnkiNoteInEditor\(/.test(content),
    "openAnkiNoteInEditor is reachable from somewhere other than the panel"
  );

// ── the retained PCM buffer (audio-capture.js) ─────────────────────────────
// The design's central claim is that the buffer supports EXTENDING a clip, not
// just tightening it — which is the whole reason it exists instead of
// re-decoding the exported WAV. These drive the real ring buffer with a
// synthetic signal and check that the retained window really is wider than the
// exported clip, and that re-encoding doesn't compound the loudness gain.
function makeAudioHarness() {
  const ac = fs.readFileSync(path.join(ROOT, "audio-capture.js"), "utf8");
  return new Function(
    "setTimeout",
    [
      grab(ac, /^const AUDIO_BUFFER_SECONDS = .*$/m, "AUDIO_BUFFER_SECONDS"),
      grab(ac, /^const AUDIO_TARGET_RMS = .*$/m, "AUDIO_TARGET_RMS"),
      grab(ac, /^const AUDIO_PEAK_CEILING = .*$/m, "AUDIO_PEAK_CEILING"),
      grab(ac, /^const AUDIO_MAX_GAIN = .*$/m, "AUDIO_MAX_GAIN"),
      grab(ac, /^const AUDIO_SILENCE_PEAK = .*$/m, "AUDIO_SILENCE_PEAK"),
      grab(ac, /^const AUDIO_EDIT_PAD_SECONDS = .*$/m, "AUDIO_EDIT_PAD_SECONDS"),
      grab(ac, /^const AUDIO_MAX_CLIP_SECONDS = .*$/m, "AUDIO_MAX_CLIP_SECONDS"),
      "let audioCtx = null, ringBuffer = null, ringWritePos = 0, ringFilled = false, samplesWritten = 0;",
      "let retainedClip = null, retainedBounds = null, retainedClipToken = null;",
      grab(ac, /^function captureNow\([\s\S]*?\n\}/m, "captureNow"),
      grab(ac, /^let discontinuities = \[\];$/m, "discontinuities"),
      grab(ac, /^function continuousBoundsAround\([\s\S]*?\n\}/m, "continuousBoundsAround"),
      grab(ac, /^function isMoreComplete\([\s\S]*?\n\}/m, "isMoreComplete"),
      grab(ac, /^function sealRetainedClip\([\s\S]*?\n\}/m, "sealRetainedClip"),
      grab(ac, /^function resetRingBuffer\([\s\S]*?\n\}/m, "resetRingBuffer"),
      grab(ac, /^function normalizeLoudness\([\s\S]*?\n\}/m, "normalizeLoudness"),
      grab(ac, /^function encodeWav\([\s\S]*?\n\}/m, "encodeWav"),
      grab(ac, /^function sliceRawRange\([\s\S]*?\n\}/m, "sliceRawRange"),
      grab(ac, /^function retainClipForEditing\([\s\S]*?\n\}/m, "retainClipForEditing"),
      grab(ac, /^function cutRetainedClip\([\s\S]*?\n\}/m, "cutRetainedClip"),
      grab(ac, /^function topUpRetainedClip\([\s\S]*?\n\}/m, "topUpRetainedClip"),
      grab(ac, /^function retainedClipInfo\([\s\S]*?\n\}/m, "retainedClipInfo"),
      grab(ac, /^function encodeRetainedRange\([\s\S]*?\n\}/m, "encodeRetainedRange"),
      grab(ac, /^function clearRetainedClip\([\s\S]*?\n\}/m, "clearRetainedClip"),
      `return {
         AUDIO_EDIT_PAD_SECONDS,
         retainClipForEditing, retainedClipInfo, encodeRetainedRange, clearRetainedClip,
         sealRetainedClip,
         markDiscontinuity: () => discontinuities.push(captureNow()),
         // Fills the ring buffer with \`seconds\` of signal, advancing the clock.
         fill: (seconds, sampleRate, sampleAt) => {
           audioCtx = { sampleRate, currentTime: 0 };
           resetRingBuffer(sampleRate);
           const total = Math.round(seconds * sampleRate);
           for (let i = 0; i < total; i++) {
             ringBuffer[ringWritePos] = sampleAt(i / sampleRate);
             ringWritePos++;
             if (ringWritePos >= ringBuffer.length) { ringWritePos = 0; ringFilled = true; }
           }
           // The capture clock IS the write count (2026-08-15) — see captureNow.
           audioCtx.currentTime = seconds;
           samplesWritten = total;
         },
         retained: () => retainedClip,
       };`,
    ].join("\n")
  )((fn) => fn); // the delayed top-up runs immediately here, standing in for real time
}

// The post-roll doesn't exist yet at the moment a clip is retained — the line
// has only just ended. Opening the trim editor before it has played must still
// offer the full padding, which means re-cutting from the ring buffer on
// demand. Reported live 2026-07-31 as the right-hand pad "not really being 3
// seconds" when the panel was opened quickly.
{
  const h = makeAudioHarness();
  const RATE = 8000;
  const signal = (t) => (t >= 10 && t < 12 ? 0.4 * Math.sin(2 * Math.PI * 220 * t) : 0.02);
  // The buffer ends exactly where the line does: nothing after it has played.
  h.fill(12, RATE, signal);
  h.retainClipForEditing(10, 12);
  const early = h.retainedClipInfo(64);
  check(
    "retained immediately, there is no post-roll to offer yet",
    early !== null && early.duration - early.clipEnd < 0.05,
    JSON.stringify({ tail: early && early.duration - early.clipEnd })
  );
  // Three more seconds play, and the editor is opened only now.
  h.fill(15, RATE, signal);
  const later = h.retainedClipInfo(64);
  check(
    "opening the editor later re-cuts the buffer and the full pad is there",
    Math.abs(later.duration - later.clipEnd - h.AUDIO_EDIT_PAD_SECONDS) < 0.05,
    JSON.stringify({ tail: later.duration - later.clipEnd, pad: h.AUDIO_EDIT_PAD_SECONDS })
  );
  check(
    "re-cutting doesn't move the clip's own bounds within the buffer",
    Math.abs(later.clipEnd - later.clipStart - 2) < 0.05 && Math.abs(later.clipStart - h.AUDIO_EDIT_PAD_SECONDS) < 0.05,
    JSON.stringify({ clipStart: later.clipStart, clipEnd: later.clipEnd })
  );
}

{
  const h = makeAudioHarness();
  const RATE = 8000;
  // 20s of buffer; a "line" of tone from t=10 to t=12 with quiet room tone
  // either side, so extending past the clip picks up audibly different content.
  h.fill(20, RATE, (t) => (t >= 10 && t < 12 ? 0.4 * Math.sin(2 * Math.PI * 220 * t) : 0.02));
  h.retainClipForEditing(10, 12);
  const info = h.retainedClipInfo(64);
  const pad = h.AUDIO_EDIT_PAD_SECONDS;

  check(
    "the retained buffer is padded on BOTH sides of the exported clip",
    info !== null && info.clipStart > 0.5 && info.duration - info.clipEnd > 0.5,
    JSON.stringify({ duration: info?.duration, clipStart: info?.clipStart, clipEnd: info?.clipEnd })
  );
  check(
    "the padding matches AUDIO_EDIT_PAD_SECONDS on each side",
    Math.abs(info.clipStart - pad) < 0.05 && Math.abs(info.duration - info.clipEnd - pad) < 0.05,
    JSON.stringify({ clipStart: info.clipStart, tail: info.duration - info.clipEnd, pad })
  );
  check(
    "the marked clip bounds span the captured line, not the whole buffer",
    Math.abs(info.clipEnd - info.clipStart - 2) < 0.05,
    `clip length=${(info.clipEnd - info.clipStart).toFixed(3)}s`
  );
  check(
    "a clip can be EXTENDED past what was exported — the point of keeping PCM",
    h.encodeRetainedRange(0, info.duration) !== null &&
      h.encodeRetainedRange(info.clipStart - 1, info.clipEnd + 1) !== null,
    "extending beyond the original bounds produced nothing"
  );
  check(
    "and TIGHTENED",
    h.encodeRetainedRange(info.clipStart + 0.5, info.clipEnd - 0.5) !== null,
    "tightening produced nothing"
  );
  check(
    "an inverted or empty selection encodes nothing rather than garbage",
    h.encodeRetainedRange(5, 5) === null && h.encodeRetainedRange(5, 4) === null,
    "an empty range produced audio"
  );

  // Re-encoding must not compound normalization: the buffer is stored raw, so
  // the same range encoded twice has to be byte-identical.
  const first = h.encodeRetainedRange(info.clipStart, info.clipEnd);
  const second = h.encodeRetainedRange(info.clipStart, info.clipEnd);
  check(
    "re-trimming the same range twice yields identical audio (gain isn't compounded)",
    first !== null && first === second,
    "two encodes of the same range differed"
  );

  const peaksOk = info.peaks.length === 64 && info.peaks.every((p) => p >= 0 && p <= 1);
  check("the waveform envelope is normalized to 0..1 at the requested resolution", peaksOk, JSON.stringify(info.peaks.slice(0, 5)));
  // The tone sits inside the clip and the room tone outside it, so the middle
  // of the envelope must be louder than its edges — i.e. the drawing lines up
  // with where the audio actually is.
  const mid = info.peaks[32];
  check("the envelope reflects where the audio actually is", mid > info.peaks[2] * 3, `mid=${mid} edge=${info.peaks[2]}`);

  h.clearRetainedClip();
  check("clearing releases the buffer", h.retainedClipInfo() === null, "buffer survived clearRetainedClip");
}

{
  // Silence must not be exported as an amplified hiss — same rule the original
  // capture path follows.
  const h = makeAudioHarness();
  h.fill(20, 8000, () => 0);
  h.retainClipForEditing(10, 12);
  const info = h.retainedClipInfo(16);
  check(
    "a silent selection exports nothing rather than amplified noise",
    info !== null && h.encodeRetainedRange(info.clipStart, info.clipEnd) === null,
    "silence produced audio"
  );
}

// ── 2026-08-15: the retained buffer's own limits ────────────────────────────

{
  // A cue left open across a discontinuity records an extent far longer than any
  // subtitle line. The exported clip has always been capped; the EDITOR's view
  // of it was not, which is where the 44-second waveform in the live report came
  // from — the card's audio was already trimmed to 20s by the time it was sent.
  const h = makeAudioHarness();
  h.fill(45, 8000, (t) => (t > 40 ? 0.4 : 0.001));
  h.retainClipForEditing(0, 44);
  const info = h.retainedClipInfo(32);
  const span = info.clipEnd - info.clipStart;
  check(
    "the edit buffer is capped at AUDIO_MAX_CLIP_SECONDS, like the exported clip",
    span <= 20.01,
    `clip spans ${span.toFixed(2)}s`
  );
}

{
  // Padding must never reach across a seek. The audio either side of one is
  // adjacent in the ring buffer but comes from two unrelated moments, and
  // dragging the trim handles out into it played the spliced result — reported
  // live as "extending the bars plays a bunch of fragmented audio clips".
  const h = makeAudioHarness();
  h.fill(20, 8000, () => 0.2);
  h.markDiscontinuity(); // stands in for noteSeek, at t=20 on the capture clock
  h.fill(30, 8000, () => 0.2); // ten more seconds play on the far side of the jump
  // The captured line sits 2s after the jump, so its 3s of pre-roll padding
  // would reach 1s back across it.
  h.retainClipForEditing(22, 24);
  const info = h.retainedClipInfo(32);
  check(
    "padding stops at a discontinuity instead of splicing across it",
    info !== null && info.clipStart <= 2.01,
    `pre-roll = ${info && info.clipStart.toFixed(2)}s (should stop at the jump, 2s before the line)`
  );
}

{
  // Sealing is what keeps the trim editor working after the user moves on to
  // the next episode: the samples are already a private copy, and only the
  // ability to GROW them is lost. Reported live as the editor saying the audio
  // was "no longer available to edit" the moment the episode changed.
  const h = makeAudioHarness();
  h.fill(15, 8000, (t) => (t >= 10 && t < 12 ? 0.4 : 0.02));
  h.retainClipForEditing(10, 12);
  const before = h.retainedClipInfo(32);
  h.sealRetainedClip();
  const after = h.retainedClipInfo(32);
  check(
    "a sealed clip is still fully readable and editable",
    after !== null && Math.abs(after.duration - before.duration) < 0.01 && after.sealed === true,
    JSON.stringify({ before: before && before.duration, after: after && after.duration, sealed: after && after.sealed })
  );
  check(
    "and re-encoding a range out of it still works",
    h.encodeRetainedRange(after.clipStart, after.clipEnd) !== null,
    "a sealed clip refused to encode"
  );
  // The ring buffer moves on to a completely different episode. A sealed clip
  // must not be re-cut from it.
  h.fill(30, 8000, () => 0.001);
  const later = h.retainedClipInfo(32);
  check(
    "a sealed clip is not re-cut from the next episode's buffer",
    Math.abs(later.duration - before.duration) < 0.01,
    `duration moved from ${before.duration.toFixed(2)} to ${later.duration.toFixed(2)}`
  );
}

{
  // An unsealed clip whose start has since aged out of the 45-second ring
  // buffer must not be silently re-cut shorter with its markers moved to fit —
  // the editor would then show the same card's audio starting somewhere else.
  const h = makeAudioHarness();
  h.fill(15, 8000, (t) => (t >= 10 && t < 12 ? 0.4 : 0.02));
  h.retainClipForEditing(10, 12);
  const before = h.retainedClipInfo(32);
  h.fill(70, 8000, () => 0.02); // the original range is long gone
  const later = h.retainedClipInfo(32);
  check(
    "a re-cut that would lose the clip's start is refused",
    Math.abs(later.clipStart - before.clipStart) < 0.01 && Math.abs(later.duration - before.duration) < 0.01,
    JSON.stringify({ before: [before.clipStart, before.duration], later: [later.clipStart, later.duration] })
  );
}

  console.log(failed ? `\n${failed} FAILED` : `\nall passed`);
  process.exit(failed ? 1 : 0);
})();
