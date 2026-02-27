#!/usr/bin/env bash
# Downloads/installs openclaw + cloudflared binaries into resources/bin/
# Called automatically by `npm run make`. Can also be run standalone.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$ROOT_DIR/resources/bin"

mkdir -p "$BIN_DIR"

ARCH="$(uname -m)"
echo "=== Bundling dependencies ==="
echo "Platform: darwin / $ARCH"
echo ""

# Helper: check if Homebrew is available
ensure_brew() {
  if ! command -v brew &>/dev/null; then
    echo "[!!] Homebrew not found. Install it from https://brew.sh"
    echo '     /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    exit 1
  fi
}

# ── cloudflared ─────────────────────────────────────────────
if [ -f "$BIN_DIR/cloudflared" ]; then
  echo "[ok] cloudflared already bundled"
else
  echo "[dl] Downloading cloudflared..."
  if [ "$ARCH" = "arm64" ]; then
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  else
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
  fi
  curl -fSL "$CF_URL" -o /tmp/cloudflared.tgz
  tar -xzf /tmp/cloudflared.tgz -C "$BIN_DIR"
  chmod +x "$BIN_DIR/cloudflared"
  rm -f /tmp/cloudflared.tgz
  echo "[ok] cloudflared downloaded"
fi

# ── openclaw ────────────────────────────────────────────────
if [ -f "$BIN_DIR/openclaw" ]; then
  echo "[ok] openclaw already bundled"
else
  # 1. Check if already installed on the system
  OPENCLAW_PATH="$(which openclaw 2>/dev/null || true)"
  if [ -z "$OPENCLAW_PATH" ]; then
    for p in /opt/homebrew/bin/openclaw /usr/local/bin/openclaw; do
      if [ -f "$p" ]; then
        OPENCLAW_PATH="$p"
        break
      fi
    done
  fi

  # 2. Not found — auto-install via Homebrew
  if [ -z "$OPENCLAW_PATH" ]; then
    echo "[..] openclaw not found — installing via Homebrew..."
    ensure_brew
    brew install openclaw-cli
    OPENCLAW_PATH="$(which openclaw 2>/dev/null || true)"
    if [ -z "$OPENCLAW_PATH" ]; then
      for p in /opt/homebrew/bin/openclaw /usr/local/bin/openclaw; do
        if [ -f "$p" ]; then
          OPENCLAW_PATH="$p"
          break
        fi
      done
    fi
  fi

  if [ -n "$OPENCLAW_PATH" ]; then
    echo "[cp] Copying openclaw from $OPENCLAW_PATH"
    cp "$OPENCLAW_PATH" "$BIN_DIR/openclaw"
    chmod +x "$BIN_DIR/openclaw"
    echo "[ok] openclaw bundled"
  else
    echo "[!!] openclaw not found and could not be installed."
    echo "     The app will still work in dev mode if openclaw is on your PATH."
    echo "     For DMG builds, install it first: brew install openclaw-cli"
  fi
fi

echo ""
echo "=== Done! Bundled binaries ==="
ls -lh "$BIN_DIR/"
echo ""
