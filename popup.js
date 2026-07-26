const input = document.getElementById("apiKeyInput");
const status = document.getElementById("status");

chrome.storage.local.get("jimakuApiKey", ({ jimakuApiKey }) => {
  if (jimakuApiKey) {
    input.placeholder = "Key saved (hidden)";
  }
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const key = input.value.trim();
  if (!key) return;
  chrome.storage.local.set({ jimakuApiKey: key }, () => {
    status.textContent = "Saved.";
    input.value = "";
  });
});

// Opt-in metadata toggles (Phase 5, 2026-07-17) — one shared toggle set
// read by both the in-page word-click popup (content.js) and the Anki
// capture flow (background.js), per the 2026-07-02 architecture decision
// (a single source of truth, so the popup and a captured card can't
// silently disagree about what's shown for the same word). Off by default
// — `metaShowPos` simply being absent from storage reads as false via the
// `?? false` fallback wherever it's read, no explicit initialization needed
// here. Frequency-rank and JLPT checkboxes are disabled placeholders: their
// underlying data isn't built yet (frequency needs a jmdict-compact.json
// regeneration, JLPT needs an external data source still to be chosen —
// see project-plan.md).
const posToggle = document.getElementById("toggle-pos");
chrome.storage.local.get("metaShowPos", ({ metaShowPos }) => {
  posToggle.checked = metaShowPos ?? false;
});
posToggle.addEventListener("change", () => {
  chrome.storage.local.set({ metaShowPos: posToggle.checked });
});

// Frequency-rank graduated from a disabled placeholder to a real toggle
// (2026-07-19) — same shared-toggle-set pattern as POS above.
const freqToggle = document.getElementById("toggle-frequency");
chrome.storage.local.get("metaShowFreq", ({ metaShowFreq }) => {
  freqToggle.checked = metaShowFreq ?? false;
});
freqToggle.addEventListener("change", () => {
  chrome.storage.local.set({ metaShowFreq: freqToggle.checked });
});

// JLPT level graduated from a disabled placeholder to a real toggle
// (2026-07-22) — same shared-toggle-set pattern as POS/frequency above.
const jlptToggle = document.getElementById("toggle-jlpt");
chrome.storage.local.get("metaShowJlpt", ({ metaShowJlpt }) => {
  jlptToggle.checked = metaShowJlpt ?? false;
});
jlptToggle.addEventListener("change", () => {
  chrome.storage.local.set({ metaShowJlpt: jlptToggle.checked });
});

// Show/episode source (2026-07-23) — same shared-toggle-set pattern, but
// Anki-only: there's no corresponding popup badge, since "which episode is
// this" is redundant while already watching that exact episode (only useful
// later, reviewing the card out of context) — see project-plan.md.
const sourceToggle = document.getElementById("toggle-source");
chrome.storage.local.get("metaShowSource", ({ metaShowSource }) => {
  sourceToggle.checked = metaShowSource ?? false;
});
sourceToggle.addEventListener("change", () => {
  chrome.storage.local.set({ metaShowSource: sourceToggle.checked });
});
