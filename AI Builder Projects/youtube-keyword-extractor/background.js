// Service worker: does every network call (Gemini API + caption fetches) so
// requests never run inside the YouTube page's isolated world and can't be
// blocked by the page's CSP.

const DEFAULT_MODEL = "gemini-3.6-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

async function getSettings() {
  const { geminiApiKey, geminiModel } = await chrome.storage.sync.get([
    "geminiApiKey",
    "geminiModel",
  ]);
  return { apiKey: geminiApiKey || "", model: geminiModel || DEFAULT_MODEL };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every actual network call to the Gemini API is counted and logged here —
// this is the single choke point all of them pass through, so it's the one
// place a call count can't lie. Filter the service worker's console for
// "[ytk-debug]" to see just this.
let apiCallCounter = 0;
function debugLog(...args) {
  console.log("[ytk-debug]", new Date().toISOString(), ...args);
}

async function callGeminiOnce({ prompt, responseSchema, label }) {
  const { apiKey, model } = await getSettings();
  if (!apiKey) {
    throw new Error(
      "No Gemini API key set. Click the extension icon and open Settings to add one."
    );
  }

  const generationConfig = { temperature: 0.2 };
  if (responseSchema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = responseSchema;
  }

  const callNumber = ++apiCallCounter;
  debugLog(`→ Gemini call #${callNumber} [${label || "unlabeled"}] — prompt ${prompt.length} chars`);

  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let message = `Gemini API error (${res.status})`;
    let retryDelayMs = null;
    try {
      const parsed = JSON.parse(body);
      if (parsed.error?.message) message = parsed.error.message;
      const retryInfo = parsed.error?.details?.find((d) =>
        (d["@type"] || "").includes("RetryInfo")
      );
      if (retryInfo?.retryDelay) {
        const secs = parseFloat(retryInfo.retryDelay);
        if (!Number.isNaN(secs)) retryDelayMs = secs * 1000;
      }
    } catch {
      // ignore parse failure, use generic message
    }
    // Fall back to parsing "...retry in 14.5s" out of the message text
    // itself, since not every 429 includes a structured RetryInfo block.
    if (retryDelayMs == null) {
      const match = message.match(/retry in ([\d.]+)\s*s/i);
      if (match) retryDelayMs = parseFloat(match[1]) * 1000;
    }
    debugLog(`✗ Gemini call #${callNumber} [${label || "unlabeled"}] FAILED — status ${res.status}: ${message}`);
    const error = new Error(message);
    error.status = res.status;
    error.retryDelayMs = retryDelayMs;
    throw error;
  }

  const raw = await res.text();
  if (!raw) throw new Error("Gemini API returned an empty response.");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini API returned an unparseable response: ${raw.slice(0, 200)}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new Error(
      finishReason ? `Gemini returned no text (finishReason: ${finishReason})` : "Gemini returned an empty response."
    );
  }
  debugLog(`✓ Gemini call #${callNumber} [${label || "unlabeled"}] OK — response ${text.length} chars`);
  return text;
}

// Retrying on 429 helps with a brief blip, but every attempt is itself
// another counted request — if the account is already deep in a quota hole
// (a long suggested delay is the tell), retrying just adds to the pile
// instead of helping, and compounds across repeated reloads during a
// testing session. Only auto-retry for short delays; a long one means back
// off and let the human decide via the Retry button instead of
// automatically making it worse.
const MAX_RETRIES = 1;
const AUTO_RETRY_MAX_DELAY_MS = 8000;

async function callGemini(args) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callGeminiOnce(args);
    } catch (err) {
      const canRetry =
        err.status === 429 &&
        err.retryDelayMs != null &&
        err.retryDelayMs <= AUTO_RETRY_MAX_DELAY_MS &&
        attempt < MAX_RETRIES;
      if (!canRetry) throw err;
      const waitMs = err.retryDelayMs + 250;
      debugLog(`⏳ [${args.label || "unlabeled"}] rate-limited, waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(waitMs);
    }
  }
}

function withParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return "";
  return await res.text();
}

function formatSeconds(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function segmentsToResult(segments) {
  if (!segments.length) return null;
  const transcript = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  return { transcript, segments };
}

function extractFromJson3(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const segments = [];
  for (const event of data.events || []) {
    if (!event.segs) continue;
    const text = event.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!text) continue;
    const seconds = (event.tStartMs || 0) / 1000;
    segments.push({ seconds, time: formatSeconds(seconds), text });
  }
  return segmentsToResult(segments);
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function extractFromXml(xml) {
  const segments = [];
  const re = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m;
  while ((m = re.exec(xml))) {
    const seconds = parseFloat(m[1]);
    const decoded = decodeEntities(m[2])
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .trim();
    if (decoded) segments.push({ seconds, time: formatSeconds(seconds), text: decoded });
  }
  return segmentsToResult(segments);
}

// YouTube's timedtext endpoint is unofficial: some caption tracks return an
// empty body for fmt=json3, so we fall back to the default XML format rather
// than assuming the response is always valid JSON. Returns
// { transcript, segments: [{ seconds, time, text }] } so callers can offer
// timestamped search alongside the flattened transcript.
async function fetchTranscript(captionUrl) {
  const jsonText = await fetchText(withParam(captionUrl, "fmt", "json3"));
  const fromJson = jsonText ? extractFromJson3(jsonText) : null;
  if (fromJson) return fromJson;

  const xmlText = await fetchText(captionUrl);
  const fromXml = xmlText ? extractFromXml(xmlText) : null;
  if (fromXml) return fromXml;

  throw new Error(
    "YouTube returned an empty transcript for this video's captions. Try reloading the page — some auto-generated caption tracks are flaky."
  );
}

const CATEGORIES = ["Person", "Organization", "Place", "Event", "Concept", "Other"];
const WORD_TYPES = ["slang", "vocabulary"];

// One combined schema/call for the "Key Concepts" list (including each
// keyword's full "Learn more" explanation, not just the short blurb) and
// the "Words ?" list — a single request handles everything the sidebar
// shows automatically on video load. Only Search still costs a second call.
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          blurb: { type: "string" },
          explanation: { type: "string" },
          category: { type: "string", enum: CATEGORIES },
        },
        required: ["term", "blurb", "explanation", "category"],
      },
    },
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          term: { type: "string" },
          definition: { type: "string" },
          type: { type: "string", enum: WORD_TYPES },
        },
        required: ["term", "definition", "type"],
      },
    },
  },
  required: ["keywords", "words"],
};

// Gemini's actual context window is well over a million tokens — 30k
// characters (roughly 7k tokens) was needlessly conservative and silently
// cut off anything discussed past the first ~25% of a longer video's
// transcript. This cap only exists to guard against pathological cases
// (multi-hour livestream VODs); it should almost never actually bind.
const MAX_TRANSCRIPT_CHARS = 300000;

function truncate(text, maxChars = MAX_TRANSCRIPT_CHARS) {
  return text.length > maxChars ? text.slice(0, maxChars) + " …[truncated]" : text;
}

// Extraction results are cached per video ID in chrome.storage.local. A
// video's transcript doesn't change, so there's no reason a re-visit (a
// hard refresh, reopening a tab, watching it again another day) should
// re-spend a Gemini call on identical content — this was the single
// biggest driver of daily request volume during heavy testing, since every
// reload was an uncached, from-scratch call for the same video.
const CACHE_KEY_PREFIX = "ytk_cache_";
const MAX_CACHE_ENTRIES = 200;

async function getCachedExtraction(videoId) {
  if (!videoId) return null;
  const key = CACHE_KEY_PREFIX + videoId;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

async function setCachedExtraction(videoId, data) {
  if (!videoId) return;
  const key = CACHE_KEY_PREFIX + videoId;
  await chrome.storage.local.set({ [key]: { ...data, cachedAt: Date.now() } });
  await pruneCacheIfNeeded();
}

// Simple bound on storage growth: once over the cap, drop the
// least-recently-cached entries first.
async function pruneCacheIfNeeded() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_KEY_PREFIX));
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  entries.sort((a, b) => (a[1]?.cachedAt || 0) - (b[1]?.cachedAt || 0));
  const toRemove = entries.slice(0, entries.length - MAX_CACHE_ENTRIES).map(([k]) => k);
  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

async function extractKeywordsAndWords(transcript, videoTitle) {
  const prompt = `You are helping a viewer study a YouTube video.

Video title: "${videoTitle || "Unknown"}"

Below is the video's FULL transcript, start to finish. Do TWO separate things:

1. KEYWORDS: Identify the 8-14 most important key terms, names, or concepts a viewer would want to look up or remember, drawn from ACROSS THE WHOLE VIDEO — don't cluster picks near the beginning just because it's first; if the video covers distinct topics or segments later on, make sure those are represented too. For each one:
   - Write a one-sentence blurb (max ~20 words) explaining why it matters in THIS video's context.
   - Write a separate, deeper explanation: 3-4 concise sentences aimed at someone who just watched this video and wants a fuller, plain-language understanding — connect it back to how it was used in the video where relevant. This is shown when the viewer clicks "Learn more," so it should add real depth beyond the one-line blurb, not just restate it.
   - Classify it into exactly one category: "Person" (a named individual), "Organization" (a company, agency, court, or institution), "Place" (a location), "Event" (a specific occurrence, ruling, or incident), "Concept" (a law, doctrine, term, or idea). Use "Other" only if truly none of those fit.
   Order them by importance within their category. Avoid generic filler words.

2. WORDS: Separately, pick out up to 10 words or short phrases actually said in the video that a typical viewer might NOT already know — either slang (internet, regional, or generational) or real English words that are just uncommon/advanced, NOT everyday vocabulary. Do not include ordinary, widely-known words just to hit a count. For each one, give a one-sentence plain-language definition matching how it was used in THIS video, and classify it as "slang" or "vocabulary". If the video genuinely doesn't have any standout words, return an empty list.

Transcript:
"""
${truncate(transcript)}
"""`;

  const text = await callGemini({ prompt, responseSchema: EXTRACTION_SCHEMA, label: "EXTRACT_KEYWORDS" });
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.keywords) || !Array.isArray(parsed.words)) {
    throw new Error("Unexpected extraction response shape.");
  }

  const keywords = parsed.keywords
    .filter((k) => k && k.term)
    .map((k) => ({ ...k, category: CATEGORIES.includes(k.category) ? k.category : "Other" }));
  const words = parsed.words
    .filter((w) => w && w.term && w.definition)
    .map((w) => ({ ...w, type: WORD_TYPES.includes(w.type) ? w.type : "vocabulary" }));

  return { keywords, words };
}

async function explainKeyword(term, transcript, videoTitle) {
  const prompt = `A viewer is watching the YouTube video "${videoTitle || "Unknown"}" and wants to learn more about the term/concept: "${term}".

Using the transcript below as context, explain "${term}" in 3-4 concise sentences aimed at someone who just watched this video and wants a deeper, plain-language understanding. If it's relevant, connect it back to how it was used in the video.

Transcript:
"""
${truncate(transcript)}
"""`;

  return (await callGemini({ prompt, label: `EXPLAIN_KEYWORD:${term}` })).trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  debugLog(`← message received: ${message.type}`, message.term || (message.terms ? `${message.terms.length} terms` : ""));
  (async () => {
    try {
      switch (message.type) {
        case "FETCH_TRANSCRIPT": {
          const { transcript, segments } = await fetchTranscript(message.url);
          sendResponse({ ok: true, transcript, segments });
          break;
        }
        case "EXTRACT_KEYWORDS": {
          const cached = await getCachedExtraction(message.videoId);
          if (cached) {
            debugLog(`✓ cache hit for ${message.videoId} — skipping Gemini call`);
            sendResponse({ ok: true, keywords: cached.keywords, words: cached.words, fromCache: true });
            break;
          }
          const { keywords, words } = await extractKeywordsAndWords(message.transcript, message.videoTitle);
          await setCachedExtraction(message.videoId, { keywords, words });
          sendResponse({ ok: true, keywords, words, fromCache: false });
          break;
        }
        case "EXPLAIN_KEYWORD": {
          const explanation = await explainKeyword(
            message.term,
            message.transcript,
            message.videoTitle
          );
          sendResponse({ ok: true, explanation });
          break;
        }
        case "CHECK_API_KEY": {
          const { apiKey } = await getSettings();
          sendResponse({ ok: true, hasKey: Boolean(apiKey) });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});
