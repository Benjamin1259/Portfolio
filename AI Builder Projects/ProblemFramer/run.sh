#!/bin/bash
# Builds ProblemFramer and runs it as a real .app bundle (proper Dock icon,
# focus behavior, etc.) instead of a bare command-line binary.
set -e

cd "$(dirname "$0")"

pkill -f "ProblemFramer.app/Contents/MacOS/ProblemFramer" 2>/dev/null || true

swift build

APP_BUNDLE="ProblemFramer.app"
BINARY_PATH=".build/debug/ProblemFramer"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$BINARY_PATH" "$APP_BUNDLE/Contents/MacOS/ProblemFramer"
cp Info.plist "$APP_BUNDLE/Contents/Info.plist"

# macOS tags freshly-created files/folders here with extended attributes
# (FinderInfo, fileprovider, provenance) that codesign refuses to sign over,
# and something keeps re-tagging the bundle between clearing and signing —
# so retry a few times instead of failing the whole build.
CERT_NAME="ProblemFramer Local Dev"

sign_app() {
    xattr -cr "$APP_BUNDLE"
    xattr -c "$APP_BUNDLE"
    if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
        codesign --force --deep --sign "$CERT_NAME" --identifier com.problemframer.app "$APP_BUNDLE"
    else
        echo "No local signing certificate found — run ./setup_codesigning.sh once to stop repeated Keychain prompts."
        codesign --force --deep --sign - "$APP_BUNDLE"
    fi
}

attempt=1
until sign_app; do
    if [ "$attempt" -ge 5 ]; then
        echo "codesign kept failing after $attempt attempts — giving up."
        exit 1
    fi
    echo "codesign attempt $attempt failed (stale Finder/provenance tags), retrying…"
    attempt=$((attempt + 1))
    sleep 0.5
done

open "$APP_BUNDLE"
