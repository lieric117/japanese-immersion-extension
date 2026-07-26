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
function markCueBoundary(text) {
  const now = audioCtx ? audioCtx.currentTime : null;
  if (cueTimeline.length > 0) {
    const prev = cueTimeline[cueTimeline.length - 1];
    if (prev.audioEnd === null) prev.audioEnd = now;
  }
  const entry = { text, audioStart: now, audioEnd: null };
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
  return encodeWav(out, sampleRate);
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
function sliceClipWavWhenReady(cueEntry, maxWaitMs = 8000) {
  return new Promise((resolve) => {
    if (!cueEntry || cueEntry.audioEnd !== null) {
      resolve(sliceClipWav(cueEntry));
      return;
    }
    const deadline = Date.now() + maxWaitMs;
    const poll = () => {
      if (cueEntry.audioEnd !== null || Date.now() >= deadline) {
        resolve(sliceClipWav(cueEntry));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}
