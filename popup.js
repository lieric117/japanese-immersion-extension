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
