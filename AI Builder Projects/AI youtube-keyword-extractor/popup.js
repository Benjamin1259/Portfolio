const statusEl = document.getElementById("status");

chrome.runtime.sendMessage({ type: "CHECK_API_KEY" }, (res) => {
  if (res?.ok && res.hasKey) {
    statusEl.textContent = "✓ Gemini API key is set.";
    statusEl.className = "ok";
  } else {
    statusEl.textContent = "⚠ No Gemini API key set yet.";
    statusEl.className = "warn";
  }
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
