#!/bin/bash
set -euo pipefail

VERSION="${1:?Usage: build-macos.sh VERSION [NODE_VERSION]}"
NODE_VERSION="${2:-24.13.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
BUILD="$DIST/macos-build"
SIGN_IDENTITY="${APPLE_SIGN_IDENTITY:-}"
NOTARIZE="${APPLE_NOTARIZE:-0}"
NOTARY_MODE=""
NODE_ENTITLEMENTS="$ROOT/macos/node-entitlements.plist"

if [[ "$NOTARIZE" == "1" ]]; then
  if [[ -z "$SIGN_IDENTITY" ]]; then
    echo "Notarization requested but APPLE_SIGN_IDENTITY is missing." >&2
    exit 1
  fi
  if [[ -n "${APPLE_NOTARY_KEY:-}" || -n "${APPLE_NOTARY_KEY_ID:-}" ||
        -n "${APPLE_NOTARY_ISSUER_ID:-}" ]]; then
    if [[ -z "${APPLE_NOTARY_KEY:-}" || -z "${APPLE_NOTARY_KEY_ID:-}" ||
          -z "${APPLE_NOTARY_ISSUER_ID:-}" || ! -f "${APPLE_NOTARY_KEY:-}" ]]; then
      echo "Notarization API credentials are incomplete or APPLE_NOTARY_KEY is missing." >&2
      exit 1
    fi
    NOTARY_MODE="api-key"
  elif [[ -n "${APPLE_ID:-}" || -n "${APPLE_TEAM_ID:-}" ||
          -n "${APPLE_APP_PASSWORD:-}" ]]; then
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_TEAM_ID:-}" ||
          -z "${APPLE_APP_PASSWORD:-}" ]]; then
      echo "Apple ID notarization credentials are incomplete." >&2
      exit 1
    fi
    NOTARY_MODE="apple-id"
  else
    echo "Notarization requested but no complete credential set was supplied." >&2
    exit 1
  fi
elif [[ "$NOTARIZE" != "0" ]]; then
  echo "APPLE_NOTARIZE must be 0 or 1." >&2
  exit 1
fi

rm -rf "$BUILD"
mkdir -p "$BUILD" "$DIST"
rm -f "$DIST/AI-Knowledge-Inbox-${VERSION}-macOS-"*.dmg

curl --fail --location "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
  --output "$BUILD/SHASUMS256.txt"

notarize_dmg() {
  local dmg="$1"
  if [[ "$NOTARY_MODE" == "api-key" ]]; then
    xcrun notarytool submit "$dmg" --wait \
      --key "$APPLE_NOTARY_KEY" \
      --key-id "$APPLE_NOTARY_KEY_ID" \
      --issuer "$APPLE_NOTARY_ISSUER_ID"
  else
    xcrun notarytool submit "$dmg" --wait \
      --apple-id "$APPLE_ID" \
      --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_PASSWORD"
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
}

build_arch() {
  local arch="$1"
  local swift_arch="$2"
  local archive="node-v${NODE_VERSION}-darwin-${arch}.tar.gz"
  local app="$BUILD/AI Knowledge Companion-${arch}.app"
  local contents="$app/Contents"
  local macos="$contents/MacOS"
  local resources="$contents/Resources"
  local suffix="unsigned"
  if [[ -n "$SIGN_IDENTITY" ]]; then
    suffix="signed"
    if [[ "$NOTARIZE" == "1" ]]; then suffix="signed-notarized"; fi
  fi
  local dmg="$DIST/AI-Knowledge-Inbox-${VERSION}-macOS-${arch}-${suffix}.dmg"

  mkdir -p "$macos" "$resources"
  swiftc \
    -O \
    -target "${swift_arch}-apple-macos12.0" \
    -framework AppKit \
    -framework Carbon \
    -framework CryptoKit \
    -framework Security \
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

  if [[ -n "$SIGN_IDENTITY" ]]; then
    [[ -f "$NODE_ENTITLEMENTS" ]] || {
      echo "Node signing entitlements are missing: $NODE_ENTITLEMENTS" >&2
      exit 1
    }
    codesign --force --options runtime --timestamp \
      --entitlements "$NODE_ENTITLEMENTS" --sign "$SIGN_IDENTITY" \
      "$resources/node-${arch}"
    local signed_entitlements="$BUILD/node-${arch}-signed-entitlements.plist"
    codesign -d --entitlements :- "$resources/node-${arch}" \
      > "$signed_entitlements" 2>/dev/null
    for entitlement in \
      com.apple.security.cs.allow-jit \
      com.apple.security.cs.allow-unsigned-executable-memory \
      com.apple.security.cs.disable-library-validation; do
      if [[ "$(/usr/libexec/PlistBuddy -c "Print :${entitlement}" \
          "$signed_entitlements" 2>/dev/null)" != "true" ]]; then
        echo "Signed Node runtime is missing required entitlement: $entitlement" >&2
        exit 1
      fi
    done
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
      "$macos/AIKnowledgeCompanion"
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"
    codesign --verify --deep --strict --verbose=2 "$app"
  else
    codesign --force --deep --sign - "$app"
  fi
  if [[ "$("$resources/node-${arch}" --version)" != "v${NODE_VERSION}" ]]; then
    echo "Bundled Node runtime failed its post-signing smoke test (${arch})." >&2
    exit 1
  fi

  rm -f "$BUILD/$archive"
  rm -rf "$BUILD/node-v${NODE_VERSION}-darwin-${arch}"
  rm -f "$dmg"
  hdiutil create \
    -volname "AI Knowledge Inbox ${VERSION} ${arch}" \
    -srcfolder "$app" \
    -ov \
    -format UDZO \
    "$dmg"
  if [[ -n "$SIGN_IDENTITY" ]]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$dmg"
    codesign --verify --strict --verbose=2 "$dmg"
  fi
  if [[ "$NOTARIZE" == "1" ]]; then notarize_dmg "$dmg"; fi
  rm -rf "$app"
}

build_arch arm64 arm64
build_arch x64 x86_64

python3 - "$DIST" "$VERSION" "$SIGN_IDENTITY" "$NOTARIZE" <<'PY'
import hashlib
import json
import pathlib
import sys

dist = pathlib.Path(sys.argv[1])
version = sys.argv[2]
files = sorted(dist.glob(f"AI-Knowledge-Inbox-{version}-macOS-*.dmg"))
manifest = {
    "schemaVersion": 1,
    "version": version,
    "platform": "macos",
    "signed": bool(sys.argv[3]),
    "notarized": sys.argv[4] == "1",
    "artifacts": [
        {
            "file": item.name,
            "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
            "bytes": item.stat().st_size,
        }
        for item in files
    ],
}
(dist / "artifact-manifest-macos.json").write_text(
    json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
)
PY

rm -rf "$BUILD"
echo "Created architecture-specific macOS DMGs in $DIST"
