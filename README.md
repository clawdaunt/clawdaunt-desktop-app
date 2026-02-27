# Clawdaunt Desktop

macOS desktop app that connects your phone to [OpenClaw](https://github.com/openclaw) running on your Mac — one-click start, QR code pairing, zero config.

> **Companion app:** [clawdaunt-expo-app](https://github.com/clawdaunt/clawdaunt-expo-app) — the iOS/Android phone client.

## How It Works

```
┌─ Clawdaunt (Mac app) ─────────────────────┐
│                                             │
│  openclaw gateway  ←  your AI backend       │
│       ↕                                     │
│  cloudflared       →  public tunnel URL     │
│                                             │
└─────────────────────────────────────────────┘
                    │
              Cloudflare tunnel
                    │
              ┌─────▼─────┐
              │  iOS app   │
              │  scans QR  │
              └────────────┘
```

---

## For End Users (DMG Install)

### Requirements

- macOS 12+ (Monterey or later)
- For **Claude CLI** mode: Claude Code CLI installed with Max/Pro subscription
- For **Codex CLI** mode: Codex CLI installed with OpenAI subscription
- For **API Key** mode: An Anthropic or OpenAI API key

### Install

1. Download `Clawdaunt.dmg`
2. Double-click to open
3. Drag **Clawdaunt** into your **Applications** folder
4. Open **Clawdaunt** from Applications

> **First launch:** macOS may show "Clawdaunt can't be opened because it is from an unidentified developer." To fix: right-click the app > **Open** > click **Open** in the dialog. This only needs to be done once.

### What's inside the DMG

Everything is bundled — no Homebrew or terminal required:

| Component | Purpose |
|-----------|---------|
| `Clawdaunt.app` | The Electron app (UI + process manager) |
| `openclaw` | AI gateway with 5700+ skills |
| `cloudflared` | Cloudflare tunnel to expose the server to your phone |

Binaries live inside `Clawdaunt.app/Contents/Resources/bin/`.

### AI Source Setup

In the app sidebar, choose your AI source:

| Source | Setup |
|--------|-------|
| **Claude CLI** | Install `claude` CLI, log in with your Claude Max/Pro subscription |
| **Codex CLI** | Install `codex` CLI, log in with your OpenAI subscription |
| **API Key** | Paste your Anthropic or OpenAI API key in the app |

The app shows green/grey dots to indicate which CLIs are detected on your system.

### DMG Size

Expect ~250-350 MB total (Electron ~150 MB + bundled binaries).

---

## Usage

1. Open **Clawdaunt**
2. Choose your **AI Source** in the sidebar (Claude CLI, Codex CLI, or API Key)
3. Click **+** to add a project folder
4. The server starts automatically
5. Scan the QR code with your iOS app — or manually enter the tunnel URL and password
6. Start chatting from your phone

### QR Code

The QR code encodes a URL your iOS app can parse to auto-connect:

```
https://random-words.trycloudflare.com?password=YOUR_TOKEN
```

### Tunnel URL

The Cloudflare tunnel URL changes every restart (normal for free quick tunnels). Scan the new QR code each time.

### Password

A random token is generated on first launch and saved to `~/.clawdaunt/config.json`. It persists across sessions so your iOS app only needs to save it once.

---

## For Developers

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 18+
- `openclaw` and `cloudflared` installed:
  ```bash
  brew install openclaw-cli
  brew install cloudflare/cloudflare/cloudflared
  ```

### Development

```bash
# Install dependencies
npm install

# Run the app in dev mode
npm start
```

The app window will open. In dev mode, `openclaw` and `cloudflared` must be on your system PATH (Homebrew paths are checked automatically).

### Build DMG

```bash
# 1. Make sure openclaw is installed on your machine
brew install openclaw-cli

# 2. Bundle dependencies + build the DMG
bash scripts/bundle-deps.sh
npm run make
```

Output:

```
out/make/Clawdaunt.dmg
```

### What `npm run make` does

1. Runs `scripts/bundle-deps.sh` — downloads `cloudflared` and copies `openclaw` into `resources/bin/`
2. Builds the Electron app with Vite
3. Packages into `Clawdaunt.app` with binaries in `Contents/Resources/bin/`
4. Creates the `.dmg` installer

### Config

Settings are stored at `~/.clawdaunt/config.json`:

```json
{
  "port": 4096,
  "password": "auto-generated",
  "workspaces": [...],
  "activeWorkspaceId": "...",
  "aiSource": "claude-cli",
  "apiKey": "",
  "apiProvider": "anthropic"
}
```

OpenClaw config is generated at `~/.config/openclaw/openclaw.json` based on the AI source selection.

### Project Structure

```
├── src/
│   ├── main.ts              # Electron backend (process management, config, IPC)
│   ├── preload.ts           # IPC bridge between main and renderer
│   ├── renderer.tsx         # React entry point
│   ├── App.tsx              # QR screen UI
│   ├── QRScreen.tsx         # QR code display component
│   ├── WorkspaceConsole.tsx # Management console + AI source picker
│   ├── App.css              # Styles
│   └── types.d.ts           # TypeScript declarations
├── resources/bin/           # Bundled binaries (populated at build time)
├── scripts/
│   └── bundle-deps.sh      # Downloads/copies binaries for packaging
├── forge.config.ts          # Electron Forge config (DMG maker, bundling)
├── vite.*.config.ts         # Vite configs for main/preload/renderer
└── package.json
```

---

## Troubleshooting

**"openclaw not found"**
- Install: `brew install openclaw-cli`
- Or check that the binary is in `resources/bin/` for DMG builds

**"Connection failed" on phone**
- Make sure the desktop app is running and showing "Server running"
- Check that the tunnel status dot is green
- The Cloudflare URL changes every restart — scan the new QR code

**CLI not detected (grey dot)**
- The app checks for `claude` and `codex` in Homebrew paths and the bundled bin folder
- Install the CLI you want: `brew install claude` / `brew install codex`
- Restart the desktop app after installing

**"Unauthorized"**
- The password is auto-generated and stored in `~/.clawdaunt/config.json`
- Scanning the QR code handles this automatically

**API Key mode not working**
- Make sure you clicked "Save" after pasting the key
- Check that you selected the correct provider (Anthropic vs OpenAI)

---

## Contributing

Pull requests welcome! See [issues](https://github.com/clawdaunt/clawdaunt-desktop-app/issues) for open tasks.

## License

MIT
