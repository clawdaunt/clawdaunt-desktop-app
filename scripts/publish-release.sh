#!/usr/bin/env bash
# Builds the app and publishes it as a GitHub release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
PRODUCT_NAME="$(node -p "require('./package.json').productName")"

echo "=== Building $PRODUCT_NAME $TAG ==="
npm run make

# Find the built DMG
DMG_PATH="$(find out/make -name '*.dmg' -type f | head -1)"
if [ -z "$DMG_PATH" ]; then
  echo "[!!] No DMG found in out/make/. Build may have failed."
  exit 1
fi
echo "[ok] Built: $DMG_PATH"

echo ""
echo "=== Publishing GitHub release $TAG ==="

if gh release view "$TAG" &>/dev/null; then
  echo "[!!] Release $TAG already exists. Run scripts/delete-release.sh first."
  exit 1
fi

gh release create "$TAG" \
  --title "$PRODUCT_NAME $TAG" \
  --notes "Release $TAG" \
  "$DMG_PATH"

echo "[ok] Release $TAG published"
