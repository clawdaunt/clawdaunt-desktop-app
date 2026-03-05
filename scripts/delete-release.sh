#!/usr/bin/env bash
# Deletes the current GitHub release and its git tag.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
TAG="v$VERSION"

echo "=== Deleting GitHub release $TAG ==="

if gh release view "$TAG" &>/dev/null; then
  gh release delete "$TAG" --yes --cleanup-tag
  echo "[ok] Release $TAG deleted"
else
  echo "[--] No release found for $TAG, nothing to delete"
fi
