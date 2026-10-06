#!/bin/bash
# Build the Appliance Timer menu bar app from the extension's files (needs only the Xcode command-line tools).
#
#   ./build.sh            → build/Appliance Timer.app
#   ./build.sh install    → also copies it to /Applications and opens it
set -euo pipefail
cd "$(dirname "$0")"
EXT=../extension
APP="build/Appliance Timer.app"
WEB="$APP/Contents/Resources/web"

rm -rf "$APP" build/AppIcon.iconset
mkdir -p "$APP/Contents/MacOS" "$WEB"

# The panel: the extension's own files, plus the Mac shim and menu bar title
cp "$EXT"/popup.css "$EXT"/popup.js "$EXT"/core.js "$EXT"/model.json "$EXT"/scores.json shim.js badge.js "$WEB"/
cp -R "$EXT"/icons "$WEB"/
perl -pe 's#(<script type="module" src="popup.js"></script>)#$1\n<script type="module" src="badge.js"></script>#' "$EXT"/popup.html > "$WEB"/popup.html

swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos13.0" main.swift -o "$APP/Contents/MacOS/Appliance Timer"

python3 make_icon.py build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

VERSION=$(python3 -c "import json; print(json.load(open('$EXT/manifest.json'))['version'])")
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Appliance Timer</string>
  <key>CFBundleDisplayName</key><string>Appliance Timer</string>
  <key>CFBundleIdentifier</key><string>com.appliance-timer.mac</string>
  <key>CFBundleExecutable</key><string>Appliance Timer</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

xattr -cr "$APP"      # iCloud-synced folders attach Finder metadata that codesign refuses
codesign --force --deep --sign - "$APP"
echo "built $APP"

if [[ "${1:-}" == "install" ]]; then
  osascript -e 'quit app "Appliance Timer"' 2>/dev/null || true
  rm -rf "/Applications/Appliance Timer.app"
  cp -R "$APP" /Applications/
  open "/Applications/Appliance Timer.app"

  # Let the Chrome extension share settings with the app (native messaging). An unpacked extension's ID comes from
  # its folder's path, so moving the extension folder means running this again.
  EXT_ID=$(python3 -c "import hashlib,os; h=hashlib.sha256(os.path.realpath('$EXT').encode()).hexdigest()[:32]; print(''.join(chr(97+int(c,16)) for c in h))")
  HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  mkdir -p "$HOSTS"
  cat > "$HOSTS/com.appliance_timer.settings.json" <<EOF
{
  "name": "com.appliance_timer.settings",
  "description": "Appliance Timer: settings shared between the Mac app and the Chrome extension",
  "path": "/Applications/Appliance Timer.app/Contents/MacOS/Appliance Timer",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "registered Chrome native messaging host for extension $EXT_ID"
  echo "installed /Applications/Appliance Timer.app"
fi
