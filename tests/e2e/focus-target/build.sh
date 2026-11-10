#!/usr/bin/env bash
# build.sh <out dir> -> <out dir>/LensE2EFocus.app (ad-hoc signed)
set -euo pipefail
OUT="$1"; APP="$OUT/LensE2EFocus.app"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.navalia.e2e.focus</string>
  <key>CFBundleName</key><string>LensE2EFocus</string>
  <key>CFBundleExecutable</key><string>LensE2EFocus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><false/>
</dict></plist>
PLIST
swiftc -O -o "$APP/Contents/MacOS/LensE2EFocus" "$(dirname "${BASH_SOURCE[0]}")/FocusTarget.swift"
codesign --force -s - "$APP" >/dev/null 2>&1
echo "$APP"
