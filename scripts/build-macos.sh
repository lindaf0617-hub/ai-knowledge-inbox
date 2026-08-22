#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: build-macos.sh VERSION [NODE_VERSION]}"
NODE_VERSION="${2:-24.13.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
BUILD="$DIST/macos-build"

rm -rf "$BUILD"
mkdir -p "$BUILD"

curl --fail --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  --output "$BUILD/SHASUMS256.txt"

build_arch() {
  local arch="$1"
  local swift_arch="$2"
  local archive="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  local app="$BUILD/AI Knowledge Companion-${arch}.app"
  local contents="$app/Contents"
  local macos="$contents/MacOS"
  local resources="$contents/Resources"
  local dmg="$DIST/AI-Knowledge-Inbox-${VERSION}-macOS-${arch}-unsigned.dmg"

  mkdir -p "$macos" "$resources"

  swiftc \
    -O \
    -target "${swift_arch}-apple-macos12.0" \
    -framework AppKit \
    -framework Carbon \
    "$ROOT/macos/Sources/AIKnowledgeCompanion/main.swift" \
    -o "$macos/AIKnowledgeCompanion"

  curl --fail --location \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
    --output "$BUILD/$archive"
  (
    cd "$BUILD"
    grep " ${archive}$" SHASUMS256.txt | shasum -a 256 -c -
  )
  tar -xzf "$BUILD/$archive" -C "$BUILD"
  cp "$BUILD/node-v${NODE_VERSION}-darwin-${arch}/bin/node" "$resources/node-${arch}"
  cp "$BUILD/node-v${NODE_VERSION}-darwin-${arch}/LICENSE" "$resources/NODE-LICENSE.txt"
  cp "$ROOT/desktop/server.js" "$resources/server.js"
  chmod +x "$macos/AIKnowledgeCompanion" "$resources/node-${arch}"

  sed -e "s/__VERSION__/${VERSION}/g" -e "s/__BUILD__/1/g" \
    "$ROOT/macos/Info.plist" > "$contents/Info.plist"

  codesign --force --deep --sign - "$app"

  rm -f "$BUILD/$archive"
  rm -rf "$BUILD/node-v${NODE_VERSION}-darwin-${arch}"
  rm -f "$dmg"
  hdiutil create \
    -volname "AI Knowledge Inbox ${VERSION} ${arch}" \
    -srcfolder "$app" \
    -ov \
    -format UDZO \
    "$dmg"
  rm -rf "$app"
}

build_arch arm64 arm64
build_arch x64 x86_64

rm -rf "$BUILD"
echo "Created architecture-specific macOS DMGs in $DIST"
