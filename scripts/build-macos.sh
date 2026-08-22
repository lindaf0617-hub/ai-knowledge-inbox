#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: build-macos.sh VERSION [NODE_VERSION]}"
NODE_VERSION="${2:-24.13.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/AI Knowledge Companion.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

rm -rf "$APP" "$DIST/macos-build"
mkdir -p "$MACOS" "$RESOURCES" "$DIST/macos-build"

swiftc \
  -O \
  -target arm64-apple-macos12.0 \
  -framework AppKit \
  -framework Carbon \
  "$ROOT/macos/Sources/AIKnowledgeCompanion/main.swift" \
  -o "$DIST/macos-build/AIKnowledgeCompanion-arm64"

swiftc \
  -O \
  -target x86_64-apple-macos12.0 \
  -framework AppKit \
  -framework Carbon \
  "$ROOT/macos/Sources/AIKnowledgeCompanion/main.swift" \
  -o "$DIST/macos-build/AIKnowledgeCompanion-x64"

lipo -create \
  "$DIST/macos-build/AIKnowledgeCompanion-arm64" \
  "$DIST/macos-build/AIKnowledgeCompanion-x64" \
  -output "$MACOS/AIKnowledgeCompanion"

for ARCH in arm64 x64; do
  ARCHIVE="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"
  curl --fail --location "$URL" --output "$DIST/macos-build/$ARCHIVE"
  curl --fail --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    --output "$DIST/macos-build/SHASUMS256.txt"
  (
    cd "$DIST/macos-build"
    grep " ${ARCHIVE}$" SHASUMS256.txt | shasum -a 256 -c -
  )
  tar -xzf "$DIST/macos-build/$ARCHIVE" -C "$DIST/macos-build"
  cp "$DIST/macos-build/node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" "$RESOURCES/node-${ARCH}"
done

chmod +x "$MACOS/AIKnowledgeCompanion" "$RESOURCES/node-arm64" "$RESOURCES/node-x64"
cp "$ROOT/desktop/server.js" "$RESOURCES/server.js"
cp "$DIST/macos-build/node-v${NODE_VERSION}-darwin-arm64/LICENSE" "$RESOURCES/NODE-LICENSE.txt"
sed -e "s/__VERSION__/${VERSION}/g" -e "s/__BUILD__/1/g" \
  "$ROOT/macos/Info.plist" > "$CONTENTS/Info.plist"

codesign --force --deep --sign - "$APP"

DMG="$DIST/AI-Knowledge-Inbox-${VERSION}-macOS-unsigned.dmg"
rm -f "$DMG"
hdiutil create \
  -volname "AI Knowledge Inbox ${VERSION}" \
  -srcfolder "$APP" \
  -ov \
  -format UDZO \
  "$DMG"

rm -rf "$DIST/macos-build"
echo "Created $DMG"
