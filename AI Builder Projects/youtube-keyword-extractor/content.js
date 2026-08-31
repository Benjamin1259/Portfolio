// Runs on youtube.com/watch pages. Extracts the transcript from the page's
// own player data, asks the background worker to summarize it into
// keywords via Gemini, and renders a sidebar panel.

const PANEL_ID = "ytk-sidebar-panel";
const TOGGLE_ID = "ytk-toggle-button";

let state = {
  videoId: null,
  videoTitle: null,
  transcript: null,
  keywords: null,
  status: "idle", // idle | loading-transcript | loading-keywords | ready | error
  error: null,
};

function currentVideoId() {
  return new URLSearchParams(location.search).get("v");
}

function getVideoTitle() {
  return (
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
    document.title.replace(/ - YouTube$/, "")
  );
}

function findCaptionTracks() {
  for (const script of document.querySelectorAll("script")) {
    const text = script.textContent;
    if (!text || !text.includes("ytInitialPlayerResponse")) continue;
    const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
    if (!match) continue;
    try {
      const playerResponse = JSON.parse(match[1]);
      const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks?.length) return tracks;
    } catch {
      // keep looking in other script tags
    }
  }
  return null;
}

function pickBestTrack(tracks) {
  return (
    tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ||
    tracks.find((t) => t.languageCode?.startsWith("en")) ||
    tracks[0]
  );
}

// Filter this tab's DevTools console for "[ytk-debug]" to see just these —
// pairs with the matching "[ytk-debug]" logs in the background service
// worker's own console (chrome://extensions → this extension → "service
// worker" link) to see the full picture of what triggered what.
function debugLog(...args) {
  console.log("[ytk-debug]", new Date().toISOString(), ...args);
}

// "Extension context invalidated" fires when the extension gets reloaded
// (chrome://extensions → ⟳) while this tab still has the *old* content
// script running — its connection to the extension is severed, and
// chrome.runtime.sendMessage throws that exact string (synchronously, not
// as a rejection, hence the try/catch below on top of the .catch). Every
// call site already handles `{ ok: false, error }`, so normalizing to that
// shape here — with a message that actually says what to do — covers all
// of them at once instead of needing this in every click handler.
function normalizeSendMessageError(err) {
  const message = err?.message || String(err);
  if (/extension context invalidated/i.test(message)) {
    return {
      ok: false,
      error:
        "This tab's connection to the extension was lost (the extension was reloaded since this page loaded). Refresh the page to reconnect.",
    };
  }
  return { ok: false, error: message };
}

function sendMessage(message) {
  debugLog(`→ sending ${message.type}`, message.term || (message.terms ? `${message.terms.length} terms` : ""));
  try {
    return chrome.runtime.sendMessage(message).catch(normalizeSendMessageError);
  } catch (err) {
    return Promise.resolve(normalizeSendMessageError(err));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryTranscriptButton() {
  const candidates = document.querySelectorAll("button, yt-button-shape button, tp-yt-paper-button");
  for (const el of candidates) {
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
    if (label.includes("show transcript") || label === "transcript") return el;
  }
  return null;
}

// On a fresh page load (as opposed to an SPA navigation between videos)
// this can run before YouTube has finished rendering the description panel,
// so the transcript button may not exist yet — poll for it instead of
// checking once.
async function clickShowTranscriptButton(timeoutMs = 8000) {
  const start = Date.now();
  let expanded = false;
  while (Date.now() - start < timeoutMs) {
    const btn = queryTranscriptButton();
    if (btn) {
      debugLog("clicking Show transcript button");
      btn.click();
      return true;
    }

    // On some layouts the button only renders after the description is expanded.
    if (!expanded) {
      const expandBtn = document.querySelector(
        "#description-inline-expander #expand, tp-yt-paper-button#expand"
      );
      if (expandBtn) {
        expandBtn.click();
        expanded = true;
      }
    }

    await sleep(300);
  }
  return false;
}

// YouTube has shipped at least two different transcript panel
// implementations: the older Polymer `ytd-transcript-segment-renderer` and
// the newer `transcript-segment-view-model`. Match both so this keeps
// working across rollouts.
const SEGMENT_SELECTOR = "transcript-segment-view-model, ytd-transcript-segment-renderer";

function waitForTranscriptSegments(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const els = document.querySelectorAll(SEGMENT_SELECTOR);
      if (els.length > 0) return resolve(Array.from(els));
      if (Date.now() - start > timeoutMs) return resolve([]);
      setTimeout(poll, 200);
    };
    poll();
  });
}

// YouTube's transcript segments are custom elements that render their text
// inside their own (open) shadow root, so plain textContent/querySelector
// from the outer document can't see it — this walks light DOM *and* shadow
// trees to collect every text node.
function shadowAwareText(node) {
  const root = node.shadowRoot || node;
  let text = "";
  for (const child of root.childNodes || []) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    else if (child.nodeType === Node.ELEMENT_NODE) text += shadowAwareText(child);
  }
  return text;
}

const TIMECODE_RE = /^\d{1,2}:\d{2}(?::\d{2})?\s*/;

function parseTimeToSeconds(str) {
  if (!str) return null;
  const parts = str.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// Returns { time, seconds, text } for a transcript segment element. The
// dedicated text span (when present) excludes the timestamp, so the
// timestamp itself is pulled separately from the segment's raw text.
function extractSegment(el) {
  const raw = shadowAwareText(el).replace(/\s+/g, " ").trim();
  const timeMatch = raw.match(TIMECODE_RE);
  const time = timeMatch ? timeMatch[0].trim() : null;

  // Newer transcript UI: a dedicated span holds just the caption text
  // (light DOM, no shadow root). Older UI used a ".segment-text" class.
  const textSpan = el.querySelector(".segment-text, .ytAttributedStringHost, [role='text']");
  const text = textSpan?.textContent?.trim() || raw.replace(TIMECODE_RE, "").trim();

  return { time, seconds: parseTimeToSeconds(time), text };
}

function closeTranscriptPanel() {
  // Find the panel from an actual segment rather than a hardcoded target-id:
  // YouTube has shipped multiple transcript panel ids (e.g. the legacy
  // "engagement-panel-searchable-transcript" now sits permanently hidden
  // alongside a newer "PAmodern_transcript_view"), and guessing wrong just
  // silently no-ops.
  const segment = document.querySelector(SEGMENT_SELECTOR);
  const panel = segment?.closest("ytd-engagement-panel-section-list-renderer");
  const closeBtn = panel?.querySelector('#visibility-button button, button[aria-label*="Close" i]');
  if (closeBtn) debugLog("closing transcript panel");
  closeBtn?.click();
}

// Preferred transcript source: read the segments straight out of YouTube's
// own "Show transcript" panel. This uses YouTube's authenticated session to
// render the captions, so it isn't affected by the timedtext API's anti-bot
// restrictions that unauthenticated fetches increasingly run into.
async function getTranscriptFromDom(isStale) {
  const alreadyOpen = document.querySelectorAll(SEGMENT_SELECTOR).length > 0;
  if (!alreadyOpen) {
    const opened = await clickShowTranscriptButton();
    // A newer run may have taken over while we were waiting for the button.
    // If we're the one who opened the panel, close it before bowing out —
    // otherwise it's left sitting open on whatever video the user is on now.
    if (isStale()) {
      if (opened) closeTranscriptPanel();
      return null;
    }
    if (!opened) return null;
  } else if (isStale()) {
    return null;
  }

  const rawSegments = await waitForTranscriptSegments(8000);

  // We only need the text, not the panel itself — keep YouTube's own
  // transcript view out of the way regardless of who opened it.
  closeTranscriptPanel();

  if (!rawSegments.length) return null;
  const segments = rawSegments.map(extractSegment).filter((s) => s.text);
  if (!segments.length) return null;

  const transcript = segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { transcript, segments };
}

function ensureUI() {
  if (document.getElementById(TOGGLE_ID)) return;

  const toggle = document.createElement("button");
  toggle.id = TOGGLE_ID;
  toggle.type = "button";
  toggle.textContent = "🔑 Keywords";
  toggle.addEventListener("click", () => {
    const panel = document.getElementById(PANEL_ID);
    panel.classList.toggle("ytk-hidden");
  });
  document.body.appendChild(toggle);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "ytk-hidden";
  panel.innerHTML = `
    <div class="ytk-header">
      <div class="ytk-tabs">
        <button class="ytk-tab" data-tab="concepts">Key Concepts</button>
        <button class="ytk-tab" data-tab="words">Word Me Please</button>
        <button class="ytk-tab" data-tab="search">Search</button>
      </div>
      <div class="ytk-header-actions">
        <button id="ytk-minimize" title="Minimize">−</button>
        <button id="ytk-close" title="Close">×</button>
      </div>
    </div>
    <div id="ytk-body" class="ytk-body"></div>
  `;
  document.body.appendChild(panel);

  // Minimize and close both collapse down to just the 🔑 toggle button —
  // the toggle's own click handler (above) is what brings the panel back,
  // regardless of which of these hid it. This keeps working while the same
  // video keeps playing (nothing else forces the panel back open — see
  // showUI(), only called when a *new* video starts).
  panel.querySelector("#ytk-minimize").addEventListener("click", () => {
    panel.classList.add("ytk-hidden");
  });
  panel.querySelector("#ytk-close").addEventListener("click", () => {
    panel.classList.add("ytk-hidden");
  });

  panel.querySelectorAll(".ytk-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function showUI() {
  document.getElementById(TOGGLE_ID)?.classList.remove("ytk-hidden");
  document.getElementById(PANEL_ID)?.classList.remove("ytk-hidden");
}

function hideUI() {
  document.getElementById(TOGGLE_ID)?.classList.add("ytk-hidden");
  document.getElementById(PANEL_ID)?.classList.add("ytk-hidden");
}

let activeTab = "concepts";

function switchTab(tab) {
  activeTab = tab;
  render();
}

function updateTabButtons() {
  document.querySelectorAll(".ytk-tab").forEach((btn) => {
    btn.classList.toggle("ytk-tab-active", btn.dataset.tab === activeTab);
  });
}

function render() {
  const body = document.getElementById("ytk-body");
  if (!body) return;

  updateTabButtons();
  if (activeTab === "search") {
    renderSearchTab(body);
  } else if (activeTab === "words") {
    renderWordsTab(body);
  } else {
    renderConceptsTab(body);
  }
}

// Shown on all three tabs while waiting for the user to opt in — nothing
// (not the transcript extraction, not the Gemini call) happens until this
// is clicked, regardless of which tab they're looking at.
function renderGetInsightsPrompt(body) {
  body.innerHTML = `
    <p class="ytk-muted">Ready to analyze this video.</p>
    <button id="ytk-get-insights" class="ytk-cta-btn">Get Video Insights</button>
  `;
  body.querySelector("#ytk-get-insights").addEventListener("click", () => {
    state.onRequestInsights?.();
  });
}

function renderConceptsTab(body) {
  if (state.status === "idle") {
    body.innerHTML = `<p class="ytk-muted">Open a video to extract keywords.</p>`;
    return;
  }

  if (state.status === "not-started") {
    renderGetInsightsPrompt(body);
    return;
  }

  if (state.status === "loading-transcript") {
    body.innerHTML = `<p class="ytk-muted">Reading the transcript…</p>`;
    return;
  }

  if (state.status === "loading-keywords") {
    body.innerHTML = `<p class="ytk-muted">Asking Gemini for the key terms…</p>`;
    return;
  }

  if (state.status === "error") {
    body.innerHTML = `
      <p class="ytk-error">${escapeHtml(state.error)}</p>
      <button id="ytk-retry" class="ytk-retry-btn">Retry</button>
    `;
    body.querySelector("#ytk-retry").addEventListener("click", () => {
      const retryRunId = state.runId;
      runInsightsPipeline(() => isRunStale(retryRunId));
    });
    return;
  }

  if (state.status === "ready") {
    if (!state.keywords?.length) {
      body.innerHTML = `<p class="ytk-muted">Gemini didn't find any standout keywords for this video.</p>`;
      return;
    }
    body.innerHTML = "";
    for (const group of groupKeywordsByCategory(state.keywords)) {
      const header = document.createElement("div");
      header.className = "ytk-group-header";
      header.textContent = group.label;
      body.appendChild(header);

      for (const kw of group.items) {
        try {
          body.appendChild(renderKeywordCard(kw));
        } catch (err) {
          console.error("[ytk] skipping malformed keyword", kw, err);
        }
      }
    }
  }
}

function renderWordsTab(body) {
  if (state.status === "idle") {
    body.innerHTML = `<p class="ytk-muted">Open a video to look for slang and uncommon words.</p>`;
    return;
  }

  if (state.status === "not-started") {
    renderGetInsightsPrompt(body);
    return;
  }

  if (state.status === "loading-transcript") {
    body.innerHTML = `<p class="ytk-muted">Reading the transcript…</p>`;
    return;
  }

  if (state.status === "loading-keywords") {
    body.innerHTML = `<p class="ytk-muted">Asking Gemini for uncommon words…</p>`;
    return;
  }

  if (state.status === "error") {
    body.innerHTML = `
      <p class="ytk-error">${escapeHtml(state.error)}</p>
      <button id="ytk-retry" class="ytk-retry-btn">Retry</button>
    `;
    body.querySelector("#ytk-retry").addEventListener("click", () => {
      const retryRunId = state.runId;
      runInsightsPipeline(() => isRunStale(retryRunId));
    });
    return;
  }

  if (state.status === "ready") {
    if (!state.words?.length) {
      body.innerHTML = `<p class="ytk-muted">No standout slang or uncommon vocabulary in this video.</p>`;
      return;
    }
    body.innerHTML = "";
    for (const w of state.words) {
      try {
        body.appendChild(renderWordCard(w));
      } catch (err) {
        console.error("[ytk] skipping malformed word", w, err);
      }
    }
  }
}

function renderWordCard(w) {
  const card = document.createElement("div");
  card.className = "ytk-card";
  const tagLabel = w.type === "slang" ? "Slang" : "Vocabulary";
  card.innerHTML = `
    <div class="ytk-term">${escapeHtml(w.term)} <span class="ytk-word-tag ytk-word-tag-${escapeHtml(w.type)}">${tagLabel}</span></div>
    <div class="ytk-blurb">${escapeHtml(w.definition)}</div>
  `;
  return card;
}

function seekVideoTo(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return;
  const video = document.querySelector("video");
  if (!video) return;
  video.currentTime = seconds;
  video.play?.();
}

// Local, instant substring match against the timestamped segments — no
// Gemini call needed for "where does this appear."
function findMatches(query) {
  if (!state.segments?.length) return [];
  const needle = query.toLowerCase();
  return state.segments
    .filter((s) => s.text.toLowerCase().includes(needle))
    .map((s) => ({ time: s.time, seconds: s.seconds, snippet: s.text }));
}

// Search has its own run token, separate from currentRunId, since a search
// query can be in flight independently of (and outlive) the main
// transcript/keywords pipeline.
let currentSearchRunId = 0;

async function runSearch(query) {
  const searchId = ++currentSearchRunId;
  const isSearchStale = () => searchId !== currentSearchRunId;

  state.search = { query, status: "loading", summary: null, matches: null, error: null };
  render();

  try {
    const matches = findMatches(query);
    const res = await sendMessage({
      type: "EXPLAIN_KEYWORD",
      term: query,
      transcript: state.transcript,
      videoTitle: state.videoTitle,
    });
    if (isSearchStale()) return;

    if (!res?.ok) {
      state.search = { query, status: "error", error: res?.error || "Search failed.", summary: null, matches: null };
      render();
      return;
    }

    state.search = { query, status: "ready", summary: res.explanation, matches, error: null };
    render();
  } catch (err) {
    console.error("[ytk]", err);
    if (isSearchStale()) return;
    state.search = { query, status: "error", error: err?.message || String(err), summary: null, matches: null };
    render();
  }
}

function renderSearchTab(body) {
  const search = state.search || { query: "", status: "idle", summary: null, matches: null, error: null };

  if (state.status === "idle") {
    body.innerHTML = `<p class="ytk-muted">Open a video to search it.</p>`;
    return;
  }
  if (state.status === "not-started") {
    renderGetInsightsPrompt(body);
    return;
  }
  if (state.status === "loading-transcript" || state.status === "loading-keywords") {
    body.innerHTML = `<p class="ytk-muted">Waiting for the transcript to finish loading…</p>`;
    return;
  }
  if (state.status === "error" && !state.transcript) {
    body.innerHTML = `<p class="ytk-muted">Fix the Key Concepts tab first — search needs the transcript.</p>`;
    return;
  }

  body.innerHTML = `
    <form id="ytk-search-form" class="ytk-search-form">
      <input id="ytk-search-input" type="text" placeholder="Search this video…" value="${escapeHtml(search.query)}" />
      <button type="submit">Search</button>
    </form>
    <div id="ytk-search-results"></div>
  `;

  const resultsEl = body.querySelector("#ytk-search-results");
  if (search.status === "loading") {
    resultsEl.innerHTML = `<p class="ytk-muted">Searching…</p>`;
  } else if (search.status === "error") {
    resultsEl.innerHTML = `<p class="ytk-error">${escapeHtml(search.error)}</p>`;
  } else if (search.status === "ready") {
    renderSearchResults(resultsEl, search);
  }

  body.querySelector("#ytk-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const query = body.querySelector("#ytk-search-input").value.trim();
    if (query) runSearch(query);
  });
}

function renderSearchResults(el, search) {
  const matchesHtml = search.matches?.length
    ? search.matches
        .map(
          (m) => `
        <button class="ytk-timestamp-chip" data-seconds="${m.seconds ?? ""}">
          <span class="ytk-timestamp-time">${escapeHtml(m.time || "?")}</span>
          <span class="ytk-timestamp-snippet">${escapeHtml(m.snippet)}</span>
        </button>`
        )
        .join("")
    : `<p class="ytk-muted">No exact mentions of "${escapeHtml(search.query)}" found in the transcript text.</p>`;

  el.innerHTML = `
    <div class="ytk-search-summary">${escapeHtml(search.summary || "")}</div>
    ${
      search.matches?.length
        ? `<div class="ytk-group-header">Mentions (${search.matches.length})</div>`
        : ""
    }
    <div class="ytk-timestamp-list">${matchesHtml}</div>
  `;

  el.querySelectorAll(".ytk-timestamp-chip").forEach((btn) => {
    btn.addEventListener("click", () => seekVideoTo(parseFloat(btn.dataset.seconds)));
  });
}

// Fixed display order (People first, per the request that prompted this),
// independent of whatever order Gemini happened to return items in.
const CATEGORY_ORDER = ["Person", "Organization", "Place", "Event", "Concept", "Other"];
const CATEGORY_LABELS = {
  Person: "People",
  Organization: "Organizations",
  Place: "Places",
  Event: "Events",
  Concept: "Concepts",
  Other: "Other",
};

// Finds where a term first shows up in the transcript (its position in the
// joined text is a decent proxy for when it's first said in the video,
// since segments are joined in chronological order) and how many times it
// comes up overall. Also tries the term's parenthetical, if it has one
// (e.g. "United States Postal Service (USPS)"), since the video may say
// only the full name or only the abbreviation.
function analyzeOccurrences(transcript, term) {
  if (!transcript || !term) return { firstIndex: Infinity, count: 0 };

  const candidates = new Set([term]);
  const parenMatch = term.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    if (parenMatch[1].trim()) candidates.add(parenMatch[1].trim());
    if (parenMatch[2].trim()) candidates.add(parenMatch[2].trim());
  }

  const lowerTranscript = transcript.toLowerCase();
  let firstIndex = Infinity;
  let count = 0;
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    if (!needle) continue;
    let searchFrom = 0;
    while (true) {
      const idx = lowerTranscript.indexOf(needle, searchFrom);
      if (idx === -1) break;
      if (idx < firstIndex) firstIndex = idx;
      count++;
      searchFrom = idx + needle.length;
    }
  }
  return { firstIndex, count };
}

function groupKeywordsByCategory(keywords) {
  const buckets = new Map(CATEGORY_ORDER.map((c) => [c, []]));
  for (const kw of keywords) {
    const category = buckets.has(kw.category) ? kw.category : "Other";
    buckets.get(category).push(kw);
  }
  // Within a category: earliest first appearance in the video wins; ties
  // (or terms we couldn't locate at all) fall back to whichever is
  // mentioned more often.
  for (const items of buckets.values()) {
    items.sort((a, b) => {
      const aIdx = a.firstIndex ?? Infinity;
      const bIdx = b.firstIndex ?? Infinity;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return (b.count ?? 0) - (a.count ?? 0);
    });
  }
  return CATEGORY_ORDER.filter((c) => buckets.get(c).length > 0).map((c) => ({
    label: CATEGORY_LABELS[c],
    items: buckets.get(c),
  }));
}

function renderKeywordCard(kw) {
  const card = document.createElement("div");
  card.className = "ytk-card";
  card.innerHTML = `
    <div class="ytk-term">${escapeHtml(kw.term)}</div>
    <div class="ytk-blurb">${escapeHtml(kw.blurb || "")}</div>
    <button class="ytk-learn-btn">Learn more →</button>
    <div class="ytk-explanation ytk-hidden"></div>
  `;

  const button = card.querySelector(".ytk-learn-btn");
  const explanationEl = card.querySelector(".ytk-explanation");

  button.addEventListener("click", async () => {
    if (!explanationEl.classList.contains("ytk-hidden")) {
      explanationEl.classList.add("ytk-hidden");
      return;
    }
    explanationEl.classList.remove("ytk-hidden");

    if (explanationEl.dataset.loaded === "true") return;

    // Came back embedded in the same extraction call — the common case is
    // an instant, free lookup, no request needed.
    if (kw.explanation) {
      explanationEl.textContent = kw.explanation;
      explanationEl.dataset.loaded = "true";
      return;
    }

    // Gemini omitted it for this term — fall back to fetching just this one.
    explanationEl.textContent = "Thinking…";
    button.disabled = true;
    const res = await sendMessage({
      type: "EXPLAIN_KEYWORD",
      term: kw.term,
      transcript: state.transcript,
      videoTitle: state.videoTitle,
    });
    button.disabled = false;

    if (res?.ok) {
      explanationEl.textContent = res.explanation;
      explanationEl.dataset.loaded = "true";
    } else {
      explanationEl.textContent = `Error: ${res?.error || "unknown error"}`;
    }
  });

  return card;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// Each call to run() gets its own token; any call whose token has been
// superseded by a newer run() bails out instead of writing its (now stale)
// result into the shared `state`/UI. Comparing against `state.videoId`
// doesn't work here because `state` itself gets reassigned by the newer
// run() before the older one's pending promises resolve.
let currentRunId = 0;

// Only the transcript-panel click/close needs to be serialized (two runs
// clicking YouTube's own open/close toggle at the same time could leave it
// in the wrong final state — see getTranscriptFromDom). It must NOT
// serialize the rest of doRun (the Gemini calls): if it did, switching to a
// new video while an old video's Gemini request was still in flight (e.g.
// sitting in a 429 retry-wait, which can now take up to ~60s) would block
// the new video's UI reset from running at all, leaving the old video's
// stale keywords on screen the whole time.
let domQueue = Promise.resolve();
function queueDomWork(fn) {
  const result = domQueue.then(fn, fn);
  domQueue = result.catch(() => {});
  return result;
}

function run() {
  const videoId = currentVideoId();
  if (!videoId) return;
  // "yt-navigate-finish" fires on more than just actual video changes (and
  // our own transcript-panel click/close may itself trigger it) — without
  // this guard, a spurious re-fire for the SAME video restarts the whole
  // pipeline (resetting back to "not-started", discarding whatever the user
  // already had) for no reason.
  if (videoId === state.videoId) {
    debugLog(`run() SKIPPED — already on ${videoId}`);
    return;
  }
  debugLog(`run() STARTING for ${videoId} — was on ${state.videoId}`);
  const runId = ++currentRunId;
  doRun(runId, videoId).catch((err) => console.error("[ytk]", err));
}

function isRunStale(runId) {
  return runId !== currentRunId;
}

async function doRun(runId, videoId) {
  const isStale = () => isRunStale(runId);
  if (isStale()) return; // superseded before its turn even came up

  state = {
    videoId,
    videoTitle: getVideoTitle(),
    transcript: null,
    segments: null,
    keywords: null,
    words: null,
    status: "not-started",
    error: null,
    search: null,
    runId,
    onRequestInsights: null,
  };
  currentSearchRunId++; // invalidate any in-flight search from the previous video
  ensureUI();
  showUI();

  // Nothing that costs anything (transcript extraction — which visibly
  // manipulates YouTube's own transcript panel — or the Gemini call) runs
  // until the user opts in via the "Get Insights" button, on whichever tab
  // they happen to be looking at.
  await new Promise((resolve) => {
    state.onRequestInsights = resolve;
    render();
  });
  state.onRequestInsights = null;
  if (isStale()) return;

  await runInsightsPipeline(isStale);
}

async function runInsightsPipeline(isStale) {
  state.status = "loading-transcript";
  render();

  // Anything unexpected below (a rejected sendMessage — e.g. the background
  // service worker got killed mid-request — a malformed Gemini response,
  // whatever) must not just vanish: without this, an uncaught exception
  // here left the panel frozen on whatever it last rendered, with nothing
  // telling you it had died.
  try {
    const domResult = await queueDomWork(() => getTranscriptFromDom(isStale));
    if (isStale()) return;

    let transcript = domResult?.transcript || null;
    let segments = domResult?.segments || null;

    if (!transcript) {
      const tracks = findCaptionTracks();
      if (tracks) {
        const track = pickBestTrack(tracks);
        const transcriptRes = await sendMessage({ type: "FETCH_TRANSCRIPT", url: track.baseUrl });
        if (isStale()) return;
        if (transcriptRes?.ok) {
          transcript = transcriptRes.transcript;
          segments = transcriptRes.segments || null;
        } else {
          state.status = "error";
          state.error = transcriptRes?.error || "Failed to fetch transcript.";
          render();
          return;
        }
      }
    }

    if (!transcript) {
      state.status = "error";
      state.error =
        "No transcript is available for this video (checked both the on-page transcript panel and the caption file).";
      render();
      return;
    }

    state.transcript = transcript;
    state.segments = segments;
    state.status = "loading-keywords";
    render();

    const keywordsRes = await sendMessage({
      type: "EXTRACT_KEYWORDS",
      videoId: state.videoId,
      transcript: state.transcript,
      videoTitle: state.videoTitle,
    });
    if (isStale()) return;

    if (!keywordsRes?.ok) {
      state.status = "error";
      state.error = keywordsRes?.error || "Failed to extract keywords.";
      render();
      return;
    }

    // Each keyword's full "Learn more" explanation already came back
    // embedded in this same response (see EXTRACTION_SCHEMA in
    // background.js) — one call covers the whole automatic video-load
    // flow; only Search costs a second one.
    state.keywords = keywordsRes.keywords.map((kw) => ({
      ...kw,
      ...analyzeOccurrences(state.transcript, kw.term),
    }));
    state.words = keywordsRes.words || [];
    state.status = "ready";
    render();
  } catch (err) {
    console.error("[ytk]", err);
    if (isStale()) return;
    state.status = "error";
    state.error = err?.message || String(err);
    render();
  }
}

// Content scripts inject once and then keep running for the tab's whole
// life, even after YouTube's SPA routes away to a page that would never
// have matched this script's own injection pattern (e.g. the homepage).
// So leaving a video needs to be handled explicitly — otherwise the panel
// just sits there showing whatever the last video had.
function leaveVideo() {
  if (state.videoId === null) return; // already idle, nothing to do
  debugLog(`leaving video — was on ${state.videoId}`);
  currentRunId++; // invalidate any in-flight run for the video being left
  currentSearchRunId++;
  state = {
    videoId: null,
    videoTitle: null,
    transcript: null,
    segments: null,
    keywords: null,
    words: null,
    status: "idle",
    error: null,
    search: null,
    runId: null,
    onRequestInsights: null,
  };
  hideUI();
}

function checkNavigation() {
  const videoId = currentVideoId();
  if (videoId) {
    run();
  } else {
    leaveVideo();
  }
}

// YouTube is a single-page app; full reloads don't happen on navigation.
document.addEventListener("yt-navigate-finish", () => {
  debugLog(`yt-navigate-finish fired — currentVideoId=${currentVideoId()}, state.videoId=${state.videoId}`);
  checkNavigation();
});

checkNavigation();

// Backstop: if "yt-navigate-finish" fires before the URL has actually
// updated (or doesn't fire at all for some navigation path), the
// event-driven check above can miss it. This periodic check catches any
// navigation — to a new video OR away from one — within ~1s.
setInterval(() => {
  const videoId = currentVideoId();
  if (videoId !== state.videoId) {
    debugLog(`poll detected navigation change — currentVideoId=${videoId}, state.videoId=${state.videoId}`);
    checkNavigation();
  }
}, 1000);
