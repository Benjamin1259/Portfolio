const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const statusEl = document.getElementById("status");

async function load() {
  const { geminiApiKey, geminiModel } = await chrome.storage.sync.get([
    "geminiApiKey",
    "geminiModel",
  ]);
  if (geminiApiKey) apiKeyInput.value = geminiApiKey;
  if (geminiModel) modelSelect.value = geminiModel;
}

document.getElementById("save").addEventListener("click", async () => {
  const geminiApiKey = apiKeyInput.value.trim();
  const geminiModel = modelSelect.value;
  await chrome.storage.sync.set({ geminiApiKey, geminiModel });
  statusEl.textContent = "Saved.";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});

load();
