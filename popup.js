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
