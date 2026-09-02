#!/bin/bash
# Finds the most recent ProblemFramer crash report and prints a short,
# readable summary instead of the raw multi-thousand-line .ips JSON.
set -e

REPORT=$(ls -t ~/Library/Logs/DiagnosticReports/ProblemFramer-*.ips 2>/dev/null | head -1)

if [ -z "$REPORT" ]; then
    echo "No ProblemFramer crash reports found."
    exit 0
fi

echo "Latest crash report: $REPORT"
echo

python3 - "$REPORT" <<'EOF'
import json
import sys

path = sys.argv[1]
with open(path) as f:
    lines = f.read().split("\n", 1)
    header = json.loads(lines[0])
    body = json.loads(lines[1])

print(f"Time:      {header.get('timestamp')}")
print(f"Exception: {body.get('exception', {}).get('type')} ({body.get('termination', {}).get('indicator')})")

asi = body.get("asi", {})
for lib, messages in asi.items():
    for m in messages:
        print(f"Reason:    {m}")

print()
print("App frames in the crashing thread:")
threads = body.get("threads", [])
faulting_index = body.get("faultingThread", 0)
frames = threads[faulting_index].get("frames", []) if faulting_index < len(threads) else []
used_images = body.get("usedImages", [])

found_app_frame = False
for frame in frames:
    if "sourceFile" in frame and "imageIndex" in frame:
        image = used_images[frame["imageIndex"]] if frame["imageIndex"] < len(used_images) else {}
        if image.get("name") == "ProblemFramer":
            found_app_frame = True
            print(f"  {frame.get('sourceFile')}:{frame.get('sourceLine', '?')}  {frame.get('symbol', '')}")

if not found_app_frame:
    print("  (crash happened inside a system framework, not our own code — showing top 6 frames instead)")
    for frame in frames[:6]:
        print(f"  {frame.get('symbol', '?')}")
EOF
