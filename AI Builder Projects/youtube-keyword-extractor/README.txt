YouTube Transcript Keywords (Gemini) — Chrome Extension
=========================================================

WHY I BUILT THIS
----------------
You know the moment: someone in a video drops a name, a slang term, or
a phrase you've never heard, and you either break concentration trying
to place it, or you pause, alt-tab out to Google it, and lose your spot
in the video entirely. I wanted that answer to show up right next to
the video instead, so I built this.

STATUS: PROTOTYPE (built for fun, still rough around the edges)
This is something I put together for my own use and to experiment with
the Gemini API — not a polished, published product. It hasn't been
through a formal security review, isn't on the Chrome Web Store, and
things may change or break as I keep tinkering with it. Poke around,
use it, and just know it's a prototype, not a finished product.


WHAT IT DOES
------------
This extension reads the transcript of the YouTube video you're watching
and uses the Gemini API to help you understand it faster:

  - Key Concepts: the 8-14 most important people, organizations, places,
    events, and concepts mentioned in the video, grouped by category,
    each with a short blurb and a full "Learn more" explanation.

  - Word Bank: slang and uncommon vocabulary actually used in the video,
    each with a plain-language definition.

  - Search: type any word or phrase and get a Gemini-written summary of
    it in the video's context, plus a list of every timestamp where it's
    mentioned — click a timestamp to jump the video there.

Nothing runs automatically. When a video loads, a sidebar appears with a
"Get Video Insights" button — the transcript is only read and the Gemini
API is only called once you click it, so you control when (and whether)
each video costs an API call. Results are cached per video, so revisiting
a video you've already analyzed doesn't call the API again.


REQUIREMENTS
------------
  1. Google Chrome (or another Chromium-based browser that supports
     Manifest V3 extensions, e.g. Edge, Brave).

  2. A Gemini API key. Get a free one at:
         https://aistudio.google.com/apikey
     This extension calls the Gemini API directly with your own key —
     nothing is sent to any server besides Google's.

  3. This extension is not published to the Chrome Web Store, so it must
     be loaded manually as an "unpacked" extension (see below).


INSTALLATION
------------
  1. Open chrome://extensions in Chrome.
  2. Enable "Developer mode" (toggle in the top right).
  3. Click "Load unpacked" and select this folder.
  4. Click the extension's icon in the toolbar, then "Open settings".
  5. Paste your Gemini API key, choose a model (gemini-3.6-flash is the
     recommended default), and click Save.


USAGE
-----
  1. Open any YouTube video.
  2. A sidebar panel appears automatically (toggle it with the small
     "🔑 Keywords" button if you close it).
  3. Click "Get Video Insights" to read the transcript and call Gemini.
  4. Browse the Key Concepts and Word Bank tabs, or use Search to look
     up a specific word or phrase.


NOTES ON API USAGE
-------------------
Google's free Gemini API tier has fairly tight rate limits (as of this
writing, roughly 5 requests/minute and 20 requests/day per model on the
free tier). Each video you analyze costs 1 API call; each search you run
costs 1 more. If you hit a rate-limit error, either wait for the limit to
reset or enable billing on your Google Cloud project to raise it.
