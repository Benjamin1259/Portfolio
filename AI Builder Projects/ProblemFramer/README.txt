ProblemFramer
=============

STATUS: Work in progress. This is an early, personal-use prototype, not a
finished or polished product. Expect rough edges, missing error handling in
places, and features that may change or move without notice.

WHAT THIS IS
------------
ProblemFramer is a native macOS app for product managers. Its purpose is NOT
to write documentation in general — it's specifically focused on helping a
PM correctly frame a business problem before any work (design, engineering,
prioritization) begins. The core belief behind it: better-framed problems
lead to better solutions, and most wasted work traces back to a problem that
was never clearly understood in the first place.

The app walks a PM through a guided, one-question-at-a-time wizard covering:
  - The context / current situation
  - When the problem is happening
  - Who is affected
  - Why it matters
  - The impact of not solving it
  - How success would be measured

It deliberately leaves out "solutioning" (hypotheses, proposed fixes) during
this phase — the goal is a clear problem statement that all downstream work
can build from, not a jump to solutions.

Once the wizard is complete, the app sends the draft to Google's Gemini API,
which:
  - Scores the clarity of the problem statement (0-100)
  - Suggests a tightened, well-formed problem statement
  - Gives section-by-section feedback, and can send you back into the
    wizard to revise just the sections that need work
  - Reasons using established PM frameworks (Jobs-to-be-Done, Five Whys,
    Working Backwards, How-Might-We) rather than generic commentary

Extras: tagging each section with quick metadata, voice dictation and
text-to-speech ("Voice Mode") for hands-free use, and Markdown export.

WHAT'S NEXT (not yet built)
----------------------------
The planned next phase is to have Gemini propose candidate solutions once a
problem is well-framed — each with a one-pager, a visual (flow diagram or
wireframe, depending on the solution type), and an effort-vs-impact score.
This is not implemented yet.

RUNNING IT
----------
This is a Swift Package Manager project (no Xcode project file). To build
and run it as a proper macOS app:

    ./run.sh

This builds the app, code-signs it with a local development identity (run
./setup_codesigning.sh once first, to avoid repeated Keychain prompts), and
launches it.

You'll need a Gemini API key (free at aistudio.google.com/apikey) — paste it
into the app's Settings after first launch. It's stored in a local file on
your Mac, not in the macOS Keychain.

BUILDING A SHAREABLE INSTALLER (.dmg)
--------------------------------------
To hand the app directly to someone else (rather than them building it from
source):

    ./build_installer.sh

This produces ProblemFramer.dmg — open it and drag ProblemFramer.app into
the Applications shortcut inside, same as any normal Mac app installer.

Caveat: this is signed with the same local, self-signed development
certificate as the dev build above — not a real Apple Developer ID. It is
NOT notarized by Apple. On first launch, macOS Gatekeeper will refuse a
normal double-click ("unidentified developer"); the person needs to
right-click the app and choose "Open" instead, once. After that it opens
normally. This is fine for sharing with people directly, but a real
Developer ID account ($99/year) would be needed to distribute it more
broadly without that warning.

REQUIREMENTS
------------
- macOS 14+
- Swift toolchain (Xcode Command Line Tools are enough; full Xcode not
  required to build/run, only recommended later for polish/App Store work)
