// Continuous rolling audio-buffer capture for the Anki audio field (Phase 5,
// 2026-07-22). Loaded as a plain content script before content.js (same
// global-scope-sharing pattern as tokenize-utils.js/subtitle-parser.js — see
// their own headers), so the functions below are called directly from there.
//
// Chosen over a per-click rewind-and-recapture approach: by the time "+ Anki"
// is clicked the dialogue has usually already played, and rewind-and-
// recapture would need to visibly seek the video backward on every single
// capture — undercutting the "capture and keep watching" core positioning
// (see project-plan.md Decisions Log, 2026-07-22). A continuous buffer avoids
// that at the cost of an always-on capture graph.
//
// Uses a ScriptProcessorNode over a raw-PCM ring buffer rather than
// AudioWorkletNode: functionally equivalent for this use case (not real-
// time/low-latency audio), and avoids needing a separate worklet module file
// (a manifest web_accessible_resources entry, loaded via chrome.runtime.getURL)
// plus cross-thread chunked message passing just to get samples into
// content.js's own scope. ScriptProcessorNode is deprecated but still fully
// functional in Chrome — revisit only if that changes.
//
// The graph MUST stay connected straight through to destination the entire
// time a page is open — confirmed 2026-07-17 (DRM feasibility test) that
// disconnecting createMediaElementSource silences the video's audio output
// until a full page reload, with no way to reroute it back. This module only
// ever ADDS taps in parallel to the direct sourceNode->destination path, and
// never disconnects anything once connected.
//
// Buffer position and cue-boundary timestamps are both recorded on
// audioCtx.currentTime — NOT video.currentTime or wall-clock performance.now()
// — specifically because AudioContext's own clock keeps advancing in real
// time regardless of video pause/seek state, while still exactly matching how
// much real audio the ring buffer has actually accumulated. That sidesteps
// having to reconcile buffer position against a video timeline that can jump
// discontinuously (seeking, pausing) between when a cue was seen and when the
// user actually commits the card, up to the chip's own lifetime later.

const AUDIO_BUFFER_SECONDS = 45; // covers worst-case cue length + chip lifetime (~15s) + padding, with margin
const AUDIO_PAD_SECONDS = 0.2; // symmetric padding added to each side of a sliced cue window
const AUDIO_PROCESS_BUFFER_SIZE = 4096; // samples per ScriptProcessorNode callback (~85ms at 48kHz)

// Loudness normalization (2026-07-26), applied to each sliced clip just
// before WAV encoding. Fixes a real bug found in live testing: the exported
// Anki audio's loudness tracked Crunchyroll's own in-page volume slider, so
// a clip captured at low player volume was quiet on the card and one
// captured at high volume was loud — the same word captured on two different
// evenings could differ by tens of dB.
//
// This is inherent to the capture point, not a mistake in the graph above:
// per the Web Audio spec, createMediaElementSource taps the media element
// AFTER its own volume/muted attenuation is applied, and there is no
// upstream tap available. The obvious alternative — captureStream() on the
// video element, which is unaffected by the volume property — is already
// confirmed blocked outright for this DRM content (2026-07-17 feasibility
// test). So the volume has to be corrected on the captured samples instead
// of avoided at the source, which is what these do.
//
// RMS-targeted rather than peak-only: peak normalization would key the whole
// clip's level off a single loudest sample, so one incidental transient (a
// door slam, a sound effect over the line) would leave the dialogue itself
// quiet. Matching RMS matches roughly what the ear hears as loudness, which
// is the thing that needs to be consistent card-to-card. The peak ceiling
// below then reins in the resulting gain so the RMS target can never drive
// samples into clipping.
const AUDIO_TARGET_RMS = 0.09; // ~-21 dBFS, a normal speech level
const AUDIO_PEAK_CEILING = 0.95; // gain is capped so the loudest sample lands no higher than this
const AUDIO_MAX_GAIN = 32; // ~+30 dB, so a very quiet capture isn't amplified into pure hiss
// Below this peak the clip is treated as silence and no audio is exported at
// all (see normalizeLoudness) — the case where the user had Crunchyroll
// muted outright. Normalizing that would just scale the noise floor up to
// dialogue level, producing a card with a loud hiss on it, which is worse
// than the existing no-audio-field degrade path.
const AUDIO_SILENCE_PEAK = 0.0008;

let audioCtx = null;
let ringBuffer = null; // Float32Array, mono
let ringWritePos = 0; // next write index
let ringFilled = false; // true once the buffer has wrapped at least once
let lastProcessAudioTime = 0; // audioCtx.currentTime as of the most recent onaudioprocess call
let boundVideo = null; // the <video> element the current graph is attached to

// The currently-open cue's audio-time extent, plus a short trailing history
// so a click captured just before a cue transition still resolves correctly.
// Entries: { text, audioStart, audioEnd } — audioEnd is null while the cue is
// still the one on screen, filled in the moment the NEXT transition happens.
let cueTimeline = [];

function resetRingBuffer(sampleRate) {
  ringBuffer = new Float32Array(Math.round(AUDIO_BUFFER_SECONDS * sampleRate));
  ringWritePos = 0;
  ringFilled = false;
}

// Idempotent per <video> element — createMediaElementSource throws if called
// twice on the same element, and SPA navigation (content.js's own
// jp-immersion-locationchange handling) can rebind `video` to a genuinely new
// element on a show change, which needs its own fresh graph.
function initAudioCapture(videoEl) {
  if (!videoEl || boundVideo === videoEl) return;
  boundVideo = videoEl;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    resetRingBuffer(audioCtx.sampleRate);
    cueTimeline = [];

    const source = audioCtx.createMediaElementSource(videoEl);
    const processor = audioCtx.createScriptProcessor(AUDIO_PROCESS_BUFFER_SIZE, 2, 1);
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const left = input.getChannelData(0);
      const right = input.numberOfChannels > 1 ? input.getChannelData(1) : null;
      const len = left.length;
      for (let i = 0; i < len; i++) {
        ringBuffer[ringWritePos] = right ? (left[i] + right[i]) / 2 : left[i];
        ringWritePos++;
        if (ringWritePos >= ringBuffer.length) {
          ringWritePos = 0;
          ringFilled = true;
        }
      }
      lastProcessAudioTime = audioCtx.currentTime;
    };

    // source -> destination is the REAL audible output path, unchanged from
    // before this feature existed. source -> processor -> destination is a
    // parallel tap purely so the processor's onaudioprocess callback actually
    // fires (Web Audio only runs nodes that are part of a graph reaching
    // destination) — the processor's own output is left untouched (silent,
    // Web Audio's default for an unwritten output buffer), so this second
    // path contributes nothing audible and can't double the sound.
    source.connect(audioCtx.destination);
    source.connect(processor);
    processor.connect(audioCtx.destination);
  } catch (err) {
    // DRM or browser-policy failure — every reader below already treats "no
    // data" as a normal, silent no-op (no audio field), matching how a
    // missing frequency/JLPT tag degrades, rather than surfacing an error.
    console.warn("[jp-immersion] audio capture unavailable:", err);
  }
}

// Called from content.js's handleTimeUpdate whenever the displayed subtitle
// text changes — closes out the previous cue's end timestamp and opens a new
// one. Returns the NEW entry (the one `text` now refers to), so a click
// happening while this cue is on screen can capture a direct reference to it,
// mirroring how `lastText` itself is captured synchronously at click time.
//
// `jpWindow` (2026-07-27) is the {start, end} span in SUBTITLE-FILE time that
// this displayed text came from, or null for a gap between lines. It's what
// lets sliceClipWavWhenReady locate a neighbouring line by TIMING rather than
// by matching its text — see there for the bug that motivated it.
function markCueBoundary(text, jpWindow = null) {
  const now = audioCtx ? audioCtx.currentTime : null;
  if (cueTimeline.length > 0) {
    const prev = cueTimeline[cueTimeline.length - 1];
    if (prev.audioEnd === null) prev.audioEnd = now;
  }
  const entry = {
    text,
    audioStart: now,
    audioEnd: null,
    jpStart: jpWindow ? jpWindow.start : null,
    jpEnd: jpWindow ? jpWindow.end : null,
  };
  cueTimeline.push(entry);
  // Trim history older than the ring buffer can possibly still hold —
  // unbounded growth would otherwise leak memory over a long viewing session.
  if (now !== null) {
    const cutoff = now - AUDIO_BUFFER_SECONDS;
    while (cueTimeline.length > 1 && cueTimeline[0].audioEnd !== null && cueTimeline[0].audioEnd < cutoff) {
      cueTimeline.shift();
    }
  }
  return entry;
}

// Scales `samples` in place to a consistent perceived loudness, and returns
// whether the clip was usable at all — false means it was silent (see
// AUDIO_SILENCE_PEAK) and the caller should export no audio rather than a
// clip of amplified noise. Mutates rather than copying: the array is already
// a freshly-allocated slice owned by the caller, never the ring buffer
// itself, so there's no shared state to corrupt.
function normalizeLoudness(samples) {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
    sumSquares += s * s;
  }
  if (peak < AUDIO_SILENCE_PEAK) return false;
  const rms = Math.sqrt(sumSquares / samples.length);
  // rms can still be ~0 for a clip that's silent apart from one sample above
  // the floor; the peak cap below is what actually bounds gain in that case,
  // but guard the division anyway rather than relying on Infinity clamping.
  let gain = rms > 0 ? AUDIO_TARGET_RMS / rms : AUDIO_MAX_GAIN;
  gain = Math.min(gain, AUDIO_PEAK_CEILING / peak, AUDIO_MAX_GAIN);
  // Deliberately applied even when gain < 1 — a capture made at high player
  // volume gets turned DOWN to the same target, which is the whole point of
  // normalizing rather than just boosting quiet clips.
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return true;
}

// Encodes a mono Float32Array [-1, 1] as a 16-bit PCM WAV file, returned as a
// base64 string ready for AnkiConnect's addNote `audio[].data` field. Chosen
// over webm/opus (2026-07-22): a WAV header plus raw samples is a direct fit
// for this ring buffer's own raw-PCM storage, with no extra encoding step;
// opus would need a second, separate encoding pipeline bolted on just for
// smaller file size, which doesn't matter much for local Anki storage.
function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000; // avoid a call-stack blowout from String.fromCharCode(...hugeArray)
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Raw, un-normalized samples for an audio-clock range, CLAMPED to whatever the
// ring buffer actually still holds rather than refusing when the request runs
// past either edge (2026-07-30). Returns `{ samples, startAudioTime }`, where
// `startAudioTime` is where the returned data really begins — later than asked
// for if the request reached back past the oldest sample retained.
//
// Separate from sliceClipWav's own bounds handling on purpose: that function
// must keep returning null for an out-of-range clip, because "no audio field"
// is its documented degrade path. This one exists for the edit buffer, where a
// partially-available window is strictly better than nothing.
function sliceRawRange(startAudioTime, endAudioTime) {
  if (!audioCtx || !ringBuffer) return null;
  const sampleRate = audioCtx.sampleRate;
  const now = lastProcessAudioTime || audioCtx.currentTime;
  const maxAgo = ringFilled ? ringBuffer.length : ringWritePos;
  let startSamplesAgo = Math.round((now - startAudioTime) * sampleRate);
  let endSamplesAgo = Math.round((now - endAudioTime) * sampleRate);
  startSamplesAgo = Math.min(startSamplesAgo, maxAgo); // don't read past the oldest sample
  endSamplesAgo = Math.max(endSamplesAgo, 0); // don't read past what's been written
  const sliceLength = startSamplesAgo - endSamplesAgo;
  if (sliceLength <= 0) return null;
  const samples = new Float32Array(sliceLength);
  for (let i = 0; i < sliceLength; i++) {
    const samplesAgo = startSamplesAgo - i;
    const idx = (((ringWritePos - samplesAgo) % ringBuffer.length) + ringBuffer.length) % ringBuffer.length;
    samples[i] = ringBuffer[idx];
  }
  return { samples, startAudioTime: now - startSamplesAgo / sampleRate };
}

// Slices the ring buffer between a captured cue entry's [audioStart, audioEnd]
// (padded on both sides), returning a base64 WAV string, or null if capture
// was never available, the entry has no timing at all, or the requested range
// has already been overwritten (only possible if the user sat on an
// actionable chip far longer than its own lifetime allows for — checked
// rather than silently returning garbage).
function sliceClipWav(cueEntry) {
  if (!audioCtx || !ringBuffer || !cueEntry || cueEntry.audioStart === null) return null;
  const sampleRate = audioCtx.sampleRate;
  const end = cueEntry.audioEnd ?? audioCtx.currentTime;
  const paddedStart = cueEntry.audioStart - AUDIO_PAD_SECONDS;
  const paddedEnd = end + AUDIO_PAD_SECONDS;
  const now = lastProcessAudioTime || audioCtx.currentTime;
  const startSamplesAgo = Math.round((now - paddedStart) * sampleRate);
  const endSamplesAgo = Math.round((now - paddedEnd) * sampleRate);
  const maxAgo = ringFilled ? ringBuffer.length : ringWritePos;
  if (startSamplesAgo <= 0 || startSamplesAgo > maxAgo) return null; // too recent to have been written yet, or too old — out of buffer range
  const clampedEndSamplesAgo = Math.max(0, endSamplesAgo);
  const sliceLength = startSamplesAgo - clampedEndSamplesAgo;
  if (sliceLength <= 0) return null;
  const out = new Float32Array(sliceLength);
  for (let i = 0; i < sliceLength; i++) {
    const samplesAgo = startSamplesAgo - i;
    const idx = ((ringWritePos - samplesAgo) % ringBuffer.length + ringBuffer.length) % ringBuffer.length;
    out[i] = ringBuffer[idx];
  }
  // Correct for whatever the player's volume slider happened to be at during
  // capture (2026-07-26) — see normalizeLoudness. A silent clip (player
  // muted) returns null here, taking the same no-audio-field path every
  // other capture failure already takes, rather than attaching a WAV of
  // silence to the card. Logged rather than surfaced in the UI: the "+ Anki"
  // button has no partial-success state today, and a muted player is a
  // deliberate act by the user, not an error to interrupt them about.
  if (!normalizeLoudness(out)) {
    console.warn("[jp-immersion] captured clip was silent (player muted?) — no audio field added");
    return null;
  }
  return encodeWav(out, sampleRate);
}

// ── Retained edit buffer (Phase 5, "edit last card" redesign, 2026-07-30) ────
//
// The audio trim editor works from RAW PCM kept in memory, not from re-decoding
// the WAV already exported to Anki (`retrieveMediaFile`). Re-decoding can only
// ever support TIGHTENING a clip, because the exported file is all there is —
// and both directions have real uses: tightening cuts bleed from an adjacent
// line or dead air, while EXTENDING recovers a line whose audio started late,
// or pulls in the following line for context. Keeping the samples is the only
// way to offer the second.
//
// So the retained buffer is deliberately WIDER than the clip that was exported,
// by AUDIO_EDIT_PAD_SECONDS on each side. Without that padding there would be
// nothing to extend into and the buffer would be no better than the re-decode.
//
// Stored un-normalized. `normalizeLoudness` mutates in place and is applied per
// export, so normalizing here and again on save would compound the gain every
// time a clip was re-trimmed.
//
// Lifetime is deliberately in-memory only, matching `lastAddedNote`'s in
// content.js: both entry points to the editor are already bounded to lifetimes
// at or below this one (the chip's ~15s, and the persistent control's note id,
// which itself clears on a full page reload), so there is no reachable state
// where the buffer needed to outlive the id that points at it.
const AUDIO_EDIT_PAD_SECONDS = 3; // provisional, see project-plan.md Open Questions

// { samples, sampleRate, clipStart, clipEnd } — clipStart/clipEnd are SECONDS
// from the start of `samples`, marking where the originally exported clip sat
// inside the padded buffer. Everything content.js passes back in is in these
// same buffer-relative seconds.
let retainedClip = null;
// Guards the delayed top-up below against a newer capture: an older top-up
// firing after a newer capture would replace the wrong clip's audio.
let retainToken = 0;
let retainTopUpTimer = null;

// Post-roll can't exist at the moment a clip is finalized — the cue has only
// just ended, so the ring buffer holds nothing after it yet. Retaining happens
// twice for that reason: immediately, so the editor works even if it's opened
// at once (with pre-roll only), and again once enough time has passed for the
// post-roll to have been recorded. The second pass simply re-slices the full
// padded window, which the 45-second ring buffer still comfortably holds.
function retainClipForEditing(audioStart, audioEnd) {
  if (audioStart === null || audioEnd === null) return;
  const token = ++retainToken;
  if (retainTopUpTimer) clearTimeout(retainTopUpTimer);
  const capture = () => {
    if (token !== retainToken) return; // a newer capture owns the buffer now
    const raw = sliceRawRange(audioStart - AUDIO_EDIT_PAD_SECONDS, audioEnd + AUDIO_EDIT_PAD_SECONDS);
    if (!raw) return;
    retainedClip = {
      samples: raw.samples,
      sampleRate: audioCtx.sampleRate,
      clipStart: Math.max(0, audioStart - raw.startAudioTime),
      clipEnd: Math.max(0, audioEnd - raw.startAudioTime),
    };
  };
  capture();
  // +250ms so the padding is actually complete rather than borderline.
  retainTopUpTimer = setTimeout(capture, AUDIO_EDIT_PAD_SECONDS * 1000 + 250);
}

// What the trim UI needs to draw itself, or null when there's nothing retained
// (capture unavailable, or the buffer was dropped). `peaks` is a max-amplitude
// envelope at whatever resolution the caller asks for, so the waveform doesn't
// have to ship hundreds of thousands of samples into the DOM layer.
function retainedClipInfo(peakCount = 240) {
  if (!retainedClip) return null;
  const { samples, sampleRate, clipStart, clipEnd } = retainedClip;
  const peaks = [];
  const bucket = samples.length / peakCount;
  for (let i = 0; i < peakCount; i++) {
    const from = Math.floor(i * bucket);
    const to = Math.min(samples.length, Math.floor((i + 1) * bucket));
    let peak = 0;
    for (let j = from; j < to; j++) {
      const abs = samples[j] < 0 ? -samples[j] : samples[j];
      if (abs > peak) peak = abs;
    }
    peaks.push(peak);
  }
  // Drawn relative to the loudest point rather than to full scale: dialogue
  // captured at a low player volume would otherwise render as a flat line.
  const loudest = Math.max(...peaks, 0.0001);
  return {
    duration: samples.length / sampleRate,
    clipStart,
    clipEnd,
    peaks: peaks.map((p) => p / loudest),
  };
}

// Re-encodes a sub-range of the retained buffer, in buffer-relative seconds.
// Same normalization the original export used, applied once to this range, so a
// re-trimmed clip lands at the same loudness as every other card.
function encodeRetainedRange(startSec, endSec) {
  if (!retainedClip) return null;
  const { samples, sampleRate } = retainedClip;
  const from = Math.max(0, Math.round(startSec * sampleRate));
  const to = Math.min(samples.length, Math.round(endSec * sampleRate));
  if (to - from <= 0) return null;
  const out = samples.slice(from, to);
  if (!normalizeLoudness(out)) return null;
  return encodeWav(out, sampleRate);
}

function clearRetainedClip() {
  retainedClip = null;
  retainToken++;
  if (retainTopUpTimer) {
    clearTimeout(retainTopUpTimer);
    retainTopUpTimer = null;
  }
}

// Waits for a still-in-progress cue to actually finish (audioEnd becomes
// non-null, set by markCueBoundary once the NEXT cue starts) before slicing,
// rather than settling for "whatever's played so far" — fixes a real bug
// caught via live testing (2026-07-22): clicking "+ Anki" while the line was
// still on screen produced a clip cut off mid-sentence, since sliceClipWav's
// own `end = cueEntry.audioEnd ?? audioCtx.currentTime` fallback used the
// click moment itself as the end boundary. Bounded by maxWaitMs as a safety
// net for a cue that never finishes in a reasonable time (the last line of
// an episode, or a long pause mid-line) — falls back to slicing with
// whatever's available rather than hanging the button forever.
//
// `mergeStart`/`mergeEnd` (2026-07-26) widen the clip to cover a sentence that
// was split across consecutive subtitle cues, so a merged Anki sentence gets
// audio matching the whole sentence rather than only the cue that happened to
// be on screen when the word was clicked (see content.js's
// buildMergedAnkiSentence). Both are SUBTITLE-FILE timestamps spanning the
// merged group; either being null means no merge, and the single-cue behaviour
// above applies unchanged.
//
// Matched against each timeline entry's own recorded cue window rather than by
// index offset, because cueTimeline also records the empty-text entries for
// gaps between lines — an index step of "one entry back" would land on a gap
// as often as on the previous line.
//
// Was matched by display TEXT until 2026-07-27, which live testing found
// broken: capturing from the first half of a split sentence sat busy for the
// full timeout and then produced audio of only the first half, while the card's
// text was correct. Text is not a usable key here. What `markCueBoundary`
// records is the JOIN of every cue visible at that instant, whereas the merge
// names ONE cue's text — identical only when nothing else is on screen. That's
// provider-dependent, not rare: measured on Frieren ep 7, [Moozzi2] shows one
// cue at a time (0% of display windows have two or more) while [NanakoRaws]
// shows two or more 80.5% of the time, and both are ordinary Japanese-only
// releases. Cue TIMING is what the merge is actually built on, is what the
// clip needs, and is unambiguous regardless of how a provider stacks its
// Dialogue events.
function sliceClipWavWhenReady(cueEntry, maxWaitMs = 8000, mergeStart = null, mergeEnd = null) {
  return new Promise((resolve) => {
    if (!cueEntry) {
      resolve(null);
      return;
    }
    const index = cueTimeline.indexOf(cueEntry);
    const merging = index !== -1 && mergeStart !== null && mergeEnd !== null;
    // Cue boundaries either side of a gap can differ by a few milliseconds
    // between what the merge computed and what was displayed; compare with a
    // tolerance rather than for exact equality.
    const EPS = 0.05;

    // Widening the START is possible immediately: those cues have already
    // played, so their timestamps are already recorded. Walks back to the
    // EARLIEST displayed window still inside the merged span.
    let startEntry = cueEntry;
    if (merging) {
      for (let i = index - 1; i >= 0; i--) {
        const e = cueTimeline[i];
        if (e.jpStart === null) continue; // a gap between lines — keep looking past it
        if (e.jpEnd <= mergeStart + EPS) break; // entirely before the merged span
        if (e.audioStart !== null) startEntry = e;
      }
    }

    // Widening the END may mean waiting for a cue that hasn't played yet: the
    // first displayed window reaching the end of the merged span, once it has
    // actually finished.
    const endReady = () => {
      if (!merging) {
        return cueEntry.audioEnd !== null ? cueEntry : null;
      }
      for (let i = index; i < cueTimeline.length; i++) {
        const e = cueTimeline[i];
        if (e.jpEnd === null) continue;
        if (e.jpEnd + EPS >= mergeEnd) return e.audioEnd !== null ? e : null;
      }
      return null;
    };

    const finish = (endEntry) => {
      // On timeout, fall back to the clicked cue's own extent for the END
      // while KEEPING the widened start — a clip that covers the first half
      // of the sentence plus whatever played is strictly better than
      // discarding the widening entirely.
      const end = endEntry ?? cueEntry;
      // Retained for the trim editor (2026-07-30) over the SAME bounds the
      // exported clip uses, so the editor's "original clip" markers line up
      // with what actually went onto the card. Done here rather than in
      // sliceClipWav because these are the merged, widened bounds — slicing
      // happens on them, but only this function knows them.
      retainClipForEditing(startEntry.audioStart, end.audioEnd);
      resolve(sliceClipWav({ audioStart: startEntry.audioStart, audioEnd: end.audioEnd }));
    };

    const ready = endReady();
    if (ready) {
      finish(ready);
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    const poll = () => {
      const entry = endReady();
      if (entry) {
        finish(entry);
        return;
      }
      if (Date.now() >= deadline) {
        finish(null);
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}
