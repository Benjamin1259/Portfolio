#!/bin/bash
# Builds a release .app bundle and packages it into a .dmg installer you can
# hand to someone directly (drag ProblemFramer.app into Applications).
#
# This is signed with the local self-signed dev certificate, not a real
# Apple Developer ID — it is NOT notarized. Anyone opening it for the first
# time will need to right-click the app and choose "Open" (instead of just
# double-clicking) to get past Gatekeeper's "unidentified developer"
# warning. That's a one-time step per Mac, not a bug.
set -e

cd "$(dirname "$0")"

echo "Building release binary…"
swift build -c release

APP_BUNDLE="ProblemFramer.app"
BINARY_PATH=".build/release/ProblemFramer"
DMG_STAGING="dmg_staging"
DMG_NAME="ProblemFramer.dmg"
VOLUME_NAME="ProblemFramer"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$BINARY_PATH" "$APP_BUNDLE/Contents/MacOS/ProblemFramer"
cp Info.plist "$APP_BUNDLE/Contents/Info.plist"

CERT_NAME="ProblemFramer Local Dev"

sign_app() {
    xattr -cr "$APP_BUNDLE"
    xattr -c "$APP_BUNDLE"
    if security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
        codesign --force --deep --sign "$CERT_NAME" --identifier com.problemframer.app "$APP_BUNDLE"
    else
        echo "No local signing certificate found — run ./setup_codesigning.sh first."
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

echo "Building $DMG_NAME…"
rm -rf "$DMG_STAGING" "$DMG_NAME"
mkdir -p "$DMG_STAGING"
cp -R "$APP_BUNDLE" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create -volname "$VOLUME_NAME" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG_NAME"
rm -rf "$DMG_STAGING"

echo
echo "Done: $DMG_NAME"
echo "Open it and drag ProblemFramer.app into the Applications shortcut."
echo "First launch: right-click the app -> Open (not a double-click) to get past Gatekeeper."
