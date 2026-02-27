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

# ── node (standalone runtime for openclaw) ─────────────────
if [ -f "$BIN_DIR/node" ]; then
  echo "[ok] node already bundled"
else
  echo "[dl] Downloading Node.js..."
  if [ "$ARCH" = "arm64" ]; then
    NODE_URL="https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz"
  else
    NODE_URL="https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-x64.tar.gz"
  fi
  curl -fSL "$NODE_URL" -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C /tmp
  cp /tmp/node-v22.14.0-darwin-${ARCH}/bin/node "$BIN_DIR/node"
  chmod +x "$BIN_DIR/node"
  rm -rf /tmp/node.tar.gz /tmp/node-v22.14.0-darwin-${ARCH}
  echo "[ok] node downloaded"
fi

# ── openclaw ────────────────────────────────────────────────
if [ -f "$BIN_DIR/openclaw" ] && [ -d "$BIN_DIR/node_modules" ]; then
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
    # Resolve symlinks to find the real installation
    REAL_PATH="$(readlink -f "$OPENCLAW_PATH" 2>/dev/null || realpath "$OPENCLAW_PATH" 2>/dev/null || echo "$OPENCLAW_PATH")"
    OPENCLAW_DIR="$(dirname "$REAL_PATH")"

    # Find the openclaw package root (Homebrew layout: libexec/bin/openclaw)
    PKG_DIR=""
    if [ -d "$OPENCLAW_DIR/../lib/node_modules/openclaw" ]; then
      PKG_DIR="$(cd "$OPENCLAW_DIR/../lib/node_modules/openclaw" && pwd)"
    elif [ -f "$OPENCLAW_DIR/package.json" ]; then
      PKG_DIR="$OPENCLAW_DIR"
    fi

    if [ -z "$PKG_DIR" ]; then
      echo "[!!] Could not find openclaw package directory."
      exit 1
    fi

    echo "[cp] Copying openclaw from $PKG_DIR"
    cp "$REAL_PATH" "$BIN_DIR/openclaw"
    chmod +x "$BIN_DIR/openclaw"

    # Copy dist/ (built output)
    rm -rf "$BIN_DIR/dist"
    cp -R "$PKG_DIR/dist" "$BIN_DIR/dist"
    echo "[ok] Copied dist/"

    # Copy node_modules/ (runtime dependencies)
    rm -rf "$BIN_DIR/node_modules"
    cp -R "$PKG_DIR/node_modules" "$BIN_DIR/node_modules"
    echo "[ok] Copied node_modules/"

    # Copy package.json (needed for "type": "module" — without it Node
    # treats the openclaw ESM entry script as CommonJS and crashes)
    cp "$PKG_DIR/package.json" "$BIN_DIR/package.json"
    echo "[ok] Copied package.json"

    echo "[ok] openclaw bundled"
  else
    echo "[!!] openclaw not found and could not be installed."
    echo "     For DMG builds, install it first: brew install openclaw-cli"
    exit 1
  fi
fi

echo ""
echo "=== Done! Bundled binaries ==="
ls -lh "$BIN_DIR/"
echo ""
