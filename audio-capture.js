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

// Padding around a sliced cue window, ASYMMETRIC as of 2026-08-15. It used to
// be 0.2s on both sides, and live testing reported the same thing every time:
// the start was fine and "the very end of the sentence is usually omitted".
//
// That asymmetry is in the source data, not in the clock. A subtitle line's END
// timestamp is routinely authored a little before the speech actually finishes
// — the line clears as the sentence lands, and the final mora or sentence-final
// particle trails past it — while its START is authored a little early so the
// text is readable before the line is spoken. Add to that a merged sentence,
// whose end is deliberately snapped back to the subtitle's own end (see
// sliceClipWavWhenReady's audioTimeAt), and 0.2s of tail is simply not enough.
//
// Deliberately NOT "compensate for audioCtx.outputLatency": that is a real but
// separate effect, it shifts BOTH edges the same way, and its sign depends on
// assumptions about the media element's presentation clock that this project
// has no way to verify live. Widening the tail is the fix the evidence points
// at; if a later live pass reports clips starting late as well, that is the
// point at which latency compensation becomes the right explanation.
const AUDIO_PAD_START_SECONDS = 0.2;
const AUDIO_PAD_END_SECONDS = 0.6;
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
let boundVideo = null; // the <video> element the current graph is attached to

// ── The capture clock (2026-08-15) ──────────────────────────────────────────
//
// Every timestamp in this module — cue extents, seek marks, clip bounds — is
// measured in SAMPLES ACTUALLY WRITTEN to the ring buffer, expressed as
// seconds. It replaces audioCtx.currentTime, which this module used until now.
//
// The two agree exactly while audio is flowing, and disagree precisely when it
// isn't. A paused <video> keeps its graph running and feeds SILENCE through it,
// so audioCtx.currentTime went on advancing and the ring buffer went on filling
// with nothing — meaning a cue left open across a pause measured the pause as
// part of the line. That is the reported bug: pause for a while, resume,
// capture immediately, and the card gets "44.29 seconds of nothing, then audio
// at the very end" (live pass, 2026-08-15). The old AUDIO_MAX_CLIP_SECONDS cap
// bounded the exported clip but not the editor's own view of it, which is where
// that 44-second waveform came from.
//
// Not writing silence while paused (see the processor below) and counting
// position in written samples together make a pause take zero space on this
// clock: the audio either side of it is adjacent, exactly as the ring buffer
// stores it, and no cue can be inflated by however long the user sat paused.
// It also means the buffer always holds 45 seconds of real audio rather than 45
// seconds of a pause.
let samplesWritten = 0;

// Deliberately NOT reset by resetRingBuffer: the buffer's CONTENTS are dropped
// on a show change, but the clock has to keep moving forward or timings
// recorded before the swap would compare equal to ones recorded after it.
function captureNow() {
  return audioCtx ? samplesWritten / audioCtx.sampleRate : null;
}

// Which capture graph owns the ring buffer (2026-07-31). Every graph ever built
// stays CONNECTED — disconnecting createMediaElementSource silences the video
// permanently (confirmed 2026-07-17), so the old graph can never be torn down
// when Crunchyroll swaps in a new <video> on a show change. Before this, the
// old graph's processor therefore kept writing into the same ring buffer
// alongside the new one, interleaving two unrelated streams sample by sample:
// the "waveform stutter/glitch that a page refresh fixes" from the 2026-07-31
// live pass. Each processor now captures its own generation and writes only
// while it is still the current one — no disconnection, no audio routing
// touched, the stale processor simply goes quiet.
let graphGeneration = 0;

// Bumped whenever the recorded timeline stops describing what is actually
// playing — a seek, or SPA navigation to another episode. Entries carry the
// epoch they were recorded in, so a merged clip can never be widened across
// one of these discontinuities, and an in-flight capture that spans one
// resolves with no audio instead of the wrong episode's.
let cueEpoch = 0;

// Hard ceiling on an exported clip (2026-07-31). Cue extents are measured on
// the audio clock, which keeps running through a seek — so a cue left open
// across a skip recorded a duration covering the skipped time, producing the
// 22–40 second mostly-silent clips reported in the live pass. `noteSeek` below
// is the real fix; this bounds the damage from any other way the two clocks
// could drift, since no single subtitle line is anywhere near this long.
const AUDIO_MAX_CLIP_SECONDS = 20;

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
    // A new <video> means a new stream: whatever is retained can no longer be
    // grown from this buffer, and anything recorded before now describes a
    // different episode.
    sealRetainedClip();
    noteDiscontinuity();
    resetRingBuffer(audioCtx.sampleRate);
    cueTimeline = [];

    const source = audioCtx.createMediaElementSource(videoEl);
    const processor = audioCtx.createScriptProcessor(AUDIO_PROCESS_BUFFER_SIZE, 2, 1);
    const generation = ++graphGeneration;
    processor.onaudioprocess = (event) => {
      // A superseded graph stops writing but stays connected — see
      // graphGeneration. Its <video> is detached by now, so it is only ever
      // producing silence anyway; what matters is that it isn't interleaving
      // that silence into the live graph's samples.
      if (generation !== graphGeneration) return;
      // Silence is not audio. A paused (or mid-seek) media element still feeds
      // the graph, and recording that would put a hole in the buffer the size
      // of however long the user sat paused — see captureNow for the clip-
      // length bug that caused. Skipping the write instead makes the capture
      // clock stop with the video, so the audio either side of a pause is
      // adjacent both in the buffer and on the clock.
      if (boundVideo && (boundVideo.paused || boundVideo.seeking)) return;
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
      samplesWritten += len;
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
  const now = captureNow();
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
    epoch: cueEpoch,
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

// Closes the open cue at the moment the video jumps, and starts a new epoch
// (2026-07-31). Called from content.js on the <video>'s own `seeking` event.
//
// Closing rather than discarding is deliberate: the ring buffer holds the audio
// that was actually HEARD, and the open cue's [audioStart, now] describes it
// correctly right up to the jump. What stops being true at a seek is everything
// after it — subtitle-file timings on the far side of the jump no longer line
// up with audio-clock positions recorded before it, so widening a merged clip
// across the boundary would splice two unrelated moments together, and a cue
// left open across it would measure the skip itself as part of the line. Both
// are prevented by the epoch, without throwing away audio that is still good.
function noteSeek() {
  if (cueTimeline.length > 0) {
    const open = cueTimeline[cueTimeline.length - 1];
    if (open.audioEnd === null && audioCtx) open.audioEnd = captureNow();
  }
  // Anything still waiting on a line to finish is resolved NOW, from the audio
  // that has actually played, instead of being voided by the epoch bump below
  // (2026-08-15). See flushPendingCaptures.
  flushPendingCaptures();
  noteDiscontinuity();
  cueEpoch++;
}

// Where the recorded timeline stops being continuous, on the capture clock.
// Audio either side of one of these positions is adjacent IN THE BUFFER but
// came from two unrelated moments, so a clip must never be widened across one:
// that is what made extending the trim handles after skipping around play "a
// bunch of fragmented audio clips" (live pass, 2026-08-15). Trimmed to what the
// ring buffer can still hold, since a mark older than that describes samples
// that have been overwritten anyway.
let discontinuities = [];

function noteDiscontinuity() {
  const now = captureNow();
  if (now === null) return;
  discontinuities.push(now);
  const cutoff = now - AUDIO_BUFFER_SECONDS;
  discontinuities = discontinuities.filter((t) => t >= cutoff);
}

// The widest range around [start, end] that contains no discontinuity — i.e.
// how far padding may reach before it would splice in another moment.
function continuousBoundsAround(start, end) {
  let low = -Infinity;
  let high = Infinity;
  for (const t of discontinuities) {
    if (t <= start && t > low) low = t;
    if (t >= end && t < high) high = t;
  }
  return { low, high };
}

// Captures still waiting for their line to finish, as callbacks that resolve
// them from whatever has played so far (2026-08-15).
//
// The reported behaviour: changing episode before the verification chip appears
// always produced a card with an empty audio field. That was deliberate — the
// ring buffer would hold the NEXT episode by the time the wait finished, and no
// audio beats the wrong episode's audio — but it threw away something that was
// never in doubt. At the moment of the jump the buffer still holds the audio
// that was really heard, and the line the user clicked has already played most
// or all of the way through. Slicing THEN gives a correct, merely short clip.
//
// Called before the epoch bump in noteSeek, so the pending finish still passes
// its own epoch check and takes the ordinary path.
let pendingCaptures = new Set();

function flushPendingCaptures() {
  if (pendingCaptures.size === 0) return;
  const flushing = [...pendingCaptures];
  pendingCaptures.clear();
  for (const finishNow of flushing) finishNow();
}

// Everything recorded so far belongs to an episode that is no longer playing
// (2026-07-31). Called from content.js on SPA navigation.
//
// Fixes the live-pass report that navigating mid-capture produced a card whose
// audio came from the NEXT episode: nothing here was reset on navigation, so a
// capture still waiting for its cue to end went on to slice a ring buffer that
// by then held the new episode. The buffer is cleared as well as the timeline,
// so the worst case is a card with no audio rather than a card with the wrong
// audio — the same silent-degrade path every other capture failure takes.
function resetCaptureForNavigation() {
  // Runs FIRST, and flushes any capture still in flight while the buffer it
  // needs is still the one it was recorded against (2026-08-15) — see
  // flushPendingCaptures for the empty-audio-field report this fixes.
  noteSeek();
  cueTimeline = [];
  // The retained edit buffer is SEALED, not dropped (2026-08-15). It is an
  // independent copy of PCM, so it survives the ring buffer being cleared
  // perfectly well; the only thing episode navigation invalidates is the
  // ability to re-cut it, which is exactly what sealing turns off. Dropping it
  // is what made the trim editor say "Audio for this card is no longer
  // available to edit" the moment the user moved on to the next episode, for a
  // clip that was sitting complete in memory the whole time.
  sealRetainedClip();
  if (audioCtx) resetRingBuffer(audioCtx.sampleRate);
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
  const now = captureNow();
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
  const end = cueEntry.audioEnd ?? captureNow();
  let paddedStart = cueEntry.audioStart - AUDIO_PAD_START_SECONDS;
  const paddedEnd = end + AUDIO_PAD_END_SECONDS;
  // Trimmed from the FRONT, never the back: when these two clocks have drifted
  // it is always the start that is stale (a cue that was left open across a
  // skip), while the end is the moment the line the user clicked actually
  // finished. See AUDIO_MAX_CLIP_SECONDS.
  if (paddedEnd - paddedStart > AUDIO_MAX_CLIP_SECONDS) {
    console.warn(
      `[jp-immersion] clip ran to ${(paddedEnd - paddedStart).toFixed(1)}s — trimmed to ` +
        `${AUDIO_MAX_CLIP_SECONDS}s (the cue was probably left open across a seek).`
    );
    paddedStart = paddedEnd - AUDIO_MAX_CLIP_SECONDS;
  }
  const now = captureNow();
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
// The clip's own bounds on the capture clock, kept so the buffer can be re-cut
// from the ring buffer later — see topUpRetainedClip. Null once sealed.
let retainedBounds = null;
// Which capture the retained buffer belongs to (2026-08-15). The buffer is only
// cut when the capture RESOLVES, which is well after the Anki note exists, so
// "the buffer belongs to the newest note" was wrong for exactly as long as a
// capture was still in flight — the trim editor opened on the PREVIOUS card's
// clip and played it back, which is what the live pass reported as the preview
// playing the audio captured before. content.js hands each capture a token at
// click time and only points a note at the buffer once the matching token has
// actually landed here.
let retainedClipToken = null;

function retainedClipTokenIs(token) {
  return token !== null && retainedClipToken === token;
}

// Post-roll can't exist at the moment a clip is finalized: the cue has only
// just ended, so the ring buffer holds nothing after it yet. This cuts what is
// available now (pre-roll and the clip itself), and topUpRetainedClip re-cuts
// it once the post-roll has actually been recorded.
function retainClipForEditing(audioStart, audioEnd, token = null) {
  if (audioStart === null || audioEnd === null) return;
  // The same ceiling the exported clip gets (2026-08-15). Without it the editor
  // could open on a window the export itself refused to cut — a cue left open
  // across a discontinuity produced the 44-second waveform reported in the live
  // pass, even though the WAV that went to Anki had already been trimmed to 20.
  // Trimmed from the FRONT for the same reason sliceClipWav trims from the
  // front: when the two clocks disagree it is the start that is stale.
  if (audioEnd - audioStart > AUDIO_MAX_CLIP_SECONDS) audioStart = audioEnd - AUDIO_MAX_CLIP_SECONDS;
  retainedBounds = { audioStart, audioEnd };
  retainedClipToken = token;
  cutRetainedClip();
}

// Cuts (or re-cuts) the padded edit buffer. Padding never reaches across a
// discontinuity (2026-08-15) — see continuousBoundsAround. Before that, pulling
// the trim handles outward after skipping around the episode played audio
// spliced together from wherever the user had jumped from, which is not
// something a user can be expected to make sense of in a waveform.
function cutRetainedClip() {
  if (!retainedBounds || !audioCtx) return;
  const { audioStart, audioEnd } = retainedBounds;
  const { low, high } = continuousBoundsAround(audioStart, audioEnd);
  const from = Math.max(audioStart - AUDIO_EDIT_PAD_SECONDS, low);
  const to = Math.min(audioEnd + AUDIO_EDIT_PAD_SECONDS, high);
  const raw = sliceRawRange(from, to);
  if (!raw) return;
  const candidate = {
    samples: raw.samples,
    sampleRate: audioCtx.sampleRate,
    clipStart: Math.max(0, audioStart - raw.startAudioTime),
    clipEnd: Math.max(0, audioEnd - raw.startAudioTime),
  };
  // A re-cut is only ever an improvement, never a replacement (2026-08-15). The
  // ring buffer is 45 seconds long, so re-cutting a clip whose start has since
  // aged out of it would silently return a SHORTER buffer with its markers
  // shifted to fit — the editor would show the same card's audio starting
  // somewhere else. Keeping whichever version has more on each side makes a
  // late re-cut a no-op instead.
  if (retainedClip && !isMoreComplete(candidate, retainedClip)) return;
  retainedClip = candidate;
}

function isMoreComplete(candidate, current) {
  const trailing = (c) => c.samples.length / c.sampleRate - c.clipEnd;
  return candidate.clipStart >= current.clipStart && trailing(candidate) > trailing(current);
}

// Re-cuts the retained buffer if its trailing padding is still short of
// AUDIO_EDIT_PAD_SECONDS — i.e. if it was taken before that much audio had
// played. Called on every read (see retainedClipInfo), so the editor always
// works from as much padding as actually exists by the time it is opened.
//
// This replaced a fixed timer (2026-07-31). The timer fired 3.25 seconds after
// capture and was the only thing that ever filled in the post-roll, so opening
// the panel before it fired gave a buffer that could barely be extended to the
// right at all — reported in the live pass as the right-side pad "not really
// being 3 seconds". Re-cutting on demand has no such window: the 45-second ring
// buffer holds the audio either way, so this is only ever a question of when it
// gets copied out of it.
//
// It is still possible for the right-hand pad to be genuinely short — that was
// the 2026-08-15 report, of a pad that "never reaches the full 3 seconds"
// while the left one always does. Two causes, both real, both now handled: a
// discontinuity within 3 seconds after the line (the pad is clamped to it on
// purpose, above), and an episode that has not PLAYED 3 more seconds yet, where
// there is nothing to top up from until it does. Sealing on navigation is what
// makes the second case permanent rather than transient — a clip sealed 1s
// after the line keeps 1s of post-roll for good — so the editor now says which
// of the two it is rather than showing a short pad with no explanation.
function topUpRetainedClip() {
  if (!retainedClip || !retainedBounds) return;
  const trailing = retainedClip.samples.length / retainedClip.sampleRate - retainedClip.clipEnd;
  if (trailing >= AUDIO_EDIT_PAD_SECONDS - 0.05) return; // already complete
  cutRetainedClip();
}

// Stops the retained buffer being re-cut, keeping whatever it currently holds
// (2026-08-15). Called when the ring buffer is about to stop describing the
// episode the clip came from — SPA navigation, or a <video> swap. The samples
// are already a private copy, so the clip stays fully editable; all that is
// lost is the ability to grow its padding, which is exactly what has become
// impossible.
function sealRetainedClip() {
  topUpRetainedClip();
  retainedBounds = null;
}

// What the trim UI needs to draw itself, or null when there's nothing retained
// (capture unavailable, or the buffer was dropped). `peaks` is a max-amplitude
// envelope at whatever resolution the caller asks for, so the waveform doesn't
// have to ship hundreds of thousands of samples into the DOM layer.
function retainedClipInfo(peakCount = 240) {
  topUpRetainedClip();
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
    // What the editor can tell the user about its own limits (2026-08-15):
    // whether the padding is still growing, and how much there actually is on
    // each side. A short right-hand pad is expected in two cases and confusing
    // in neither once it's stated — see topUpRetainedClip.
    sealed: retainedBounds === null,
    padStart: clipStart,
    padEnd: samples.length / sampleRate - clipEnd,
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
  retainedBounds = null;
  retainedClipToken = null;
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
//
// **The display window is coarser than the sentence** (2026-07-31), which is
// the second live report against this function: capturing from the second half
// of a split sentence produced a clip running on into the following line. A
// displayed window spans every cue visible at that instant, so on a provider
// that stacks cues it routinely starts before the merged sentence does and ends
// after it. Snapping the clip to those window edges therefore over-captures by
// design. The edges are now interpolated back to the sentence's own subtitle
// timings (see audioTimeAt), so the window is used to LOCATE the sentence in
// the buffer, not to bound it.
//
// `maxWaitMs` is generous because it no longer costs the user anything: the
// card is written to Anki before this resolves (see content.js), and the audio
// field is filled in when it does. A first-half capture that timed out used to
// mean first-half-only audio on the card — the other half of the same live
// report — so waiting longer is now strictly better than giving up early.
function sliceClipWavWhenReady(cueEntry, maxWaitMs = 20000, mergeStart = null, mergeEnd = null, token = null) {
  return new Promise((resolve) => {
    if (!cueEntry) {
      resolve(null);
      return;
    }
    // One resolution per capture, whichever path gets there first — the normal
    // wait, the timeout, or a forced flush from noteSeek (2026-08-15).
    let settled = false;
    let forceFinish = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      pendingCaptures.delete(forceFinish);
      resolve(value);
    };
    const index = cueTimeline.indexOf(cueEntry);
    const merging = index !== -1 && mergeStart !== null && mergeEnd !== null;
    // Cue boundaries either side of a gap can differ by a few milliseconds
    // between what the merge computed and what was displayed; compare with a
    // tolerance rather than for exact equality.
    const EPS = 0.05;
    // Recorded before any waiting starts: a seek or an episode change during
    // the wait invalidates every timing this was going to slice between.
    const epoch = cueEntry.epoch ?? cueEpoch;
    const sameEpoch = (e) => (e.epoch ?? epoch) === epoch;

    // Converts a SUBTITLE-FILE timestamp to a position on the audio clock,
    // using one displayed window as the reference point. Both clocks advance in
    // real seconds, so within a single window the offset between them is
    // constant and the conversion is exact. Clamped to the window it was
    // measured from, so the arithmetic can't walk outside the stretch of buffer
    // that window actually describes if the video was paused partway through
    // it — the known dead-air case, already accepted as expected behaviour.
    const audioTimeAt = (entry, jpTime) => {
      if (!entry || entry.jpStart === null || entry.audioStart === null) return null;
      const t = entry.audioStart + (jpTime - entry.jpStart);
      const upper = entry.audioEnd ?? t;
      return Math.max(entry.audioStart, Math.min(t, upper));
    };

    // Widening the START is possible immediately: those cues have already
    // played, so their timestamps are already recorded. Walks back to the
    // EARLIEST displayed window still inside the merged span.
    let startEntry = cueEntry;
    if (merging) {
      for (let i = index - 1; i >= 0; i--) {
        const e = cueTimeline[i];
        if (!sameEpoch(e)) break; // a seek or an episode change — nothing before this is comparable
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
        if (!sameEpoch(e)) return null; // the sentence never finished on this side of the jump
        if (e.jpEnd === null) continue;
        if (e.jpEnd + EPS >= mergeEnd) return e.audioEnd !== null ? e : null;
      }
      return null;
    };

    const finish = (endEntry, waitForTail = true) => {
      // A seek or an episode change while this was waiting means the buffer no
      // longer holds what these timings describe. No audio field is the right
      // answer — the same silent degrade a muted player or an aged-out clip
      // already takes — rather than slicing whatever now sits at those
      // positions, which after navigation is the next episode (reported live
      // 2026-07-31).
      if (epoch !== cueEpoch) {
        settle(null);
        return;
      }
      // On timeout, fall back to the clicked cue's own extent for the END
      // while KEEPING the widened start — a clip that covers the first half
      // of the sentence plus whatever played is strictly better than
      // discarding the widening entirely.
      const end = endEntry ?? cueEntry;
      // Both edges are pulled in from the display window to the merged
      // sentence's own subtitle timings where the window is the wider of the
      // two — see audioTimeAt and this function's header. Without this the clip
      // inherits every neighbouring cue that happened to share the window.
      let audioStart = startEntry.audioStart;
      let audioEnd = end.audioEnd;
      if (merging) {
        if (startEntry.jpStart !== null && startEntry.jpStart < mergeStart - EPS) {
          audioStart = audioTimeAt(startEntry, mergeStart) ?? audioStart;
        }
        if (endEntry && endEntry.jpEnd !== null && endEntry.jpEnd > mergeEnd + EPS) {
          audioEnd = audioTimeAt(endEntry, mergeEnd) ?? audioEnd;
        }
        // Never let the tightening invert or erase the clip: if the two edges
        // cross (a window whose timings don't behave as assumed), the untouched
        // window bounds are still a usable clip and a wrong-but-present one
        // beats none.
        if (!(audioEnd > audioStart)) {
          audioStart = startEntry.audioStart;
          audioEnd = end.audioEnd;
        }
      }
      // A FLUSHED capture (a seek or an episode change interrupted it) gets one
      // extra guard: the timeline is closed at the moment the jump was NOTICED,
      // which for SPA navigation is up to a second after it happened — long
      // enough for the next episode's audio to have started arriving. A
      // displayed line can never run longer than its own subtitle window, so
      // that window is the honest ceiling on how much of the buffer belongs to
      // it. Without this the "keep the audio heard so far" path could reinstate
      // a smaller version of the wrong-episode bug it replaced.
      if (!waitForTail && end && end.jpStart !== null && end.jpEnd !== null && end.audioStart !== null) {
        const ceiling = end.audioStart + (end.jpEnd - end.jpStart) + 0.25;
        if (audioEnd > ceiling && ceiling > audioStart) audioEnd = ceiling;
      }

      // The trailing pad has to have been RECORDED before it can be sliced
      // (2026-08-15). A cue's end is noticed by the next `timeupdate`, so at
      // this moment the buffer typically holds only a fraction of a second past
      // the line — sliceClipWav's own clamp then silently shortened the tail to
      // whatever happened to exist, which is the other half of why the end of
      // the sentence kept getting cut off. Nothing is blocked on this wait (the
      // card is already in Anki), so it costs the user nothing.
      const cut = () => {
        // Retained for the trim editor (2026-07-30) over the SAME bounds the
        // exported clip uses, so the editor's "original clip" markers line up
        // with what actually went onto the card. Done here rather than in
        // sliceClipWav because these are the merged, widened bounds — slicing
        // happens on them, but only this function knows them.
        retainClipForEditing(audioStart, audioEnd, token);
        settle(sliceClipWav({ audioStart, audioEnd }));
      };
      if (!waitForTail || audioEnd === null) {
        cut();
        return;
      }
      const needed = audioEnd + AUDIO_PAD_END_SECONDS;
      // Bounded: a video paused right after the line stops the capture clock
      // outright, and a short tail is a far better outcome than a card that
      // waits for a pause to end before its audio arrives.
      const tailDeadline = Date.now() + 2000;
      const waitForPad = () => {
        const now = captureNow();
        if (settled) return;
        if (now !== null && now < needed && Date.now() < tailDeadline) {
          setTimeout(waitForPad, 100);
          return;
        }
        cut();
      };
      waitForPad();
    };

    // Resolve from whatever has played, ignoring the fact that the line may not
    // have finished — registered for the whole life of the wait, and called by
    // flushPendingCaptures when a seek or an episode change is about to make
    // the timeline uncomparable. See that function for the report this fixes.
    forceFinish = () => {
      if (settled) return;
      finish(endReady(), false);
    };
    pendingCaptures.add(forceFinish);

    const ready = endReady();
    if (ready) {
      finish(ready);
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    const poll = () => {
      if (settled) return; // a flush got there first
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
