import { app, BrowserWindow, powerMonitor } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { state } from './main/state';
import { loadConfig } from './main/config';
import { startServer, stopAll } from './main/gateway';
import { startTunnel } from './main/tunnel';
import { startProxyServer, startSetupServer, stopClientPresenceMonitor, startClientPresenceMonitor } from './main/proxy';
import { registerIpcHandlers } from './main/ipc';
import { checkForUpdates } from './main/update';

if (started) app.quit();

// ── Update check ─────────────────────────────────────────────
app.whenReady().then(() => {
  checkForUpdates();
});

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g. packaged app with no terminal)
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code === 'EPIPE') return; throw err; });
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code === 'EPIPE') return; throw err; });

// ── IPC handlers ───────────────────────────────────────────
registerIpcHandlers();

// ── Window ─────────────────────────────────────────────────
const createWindow = () => {
  state.mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 500,
    resizable: true,
    maximizable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  state.mainWindow.on('closed', () => {
    state.mainWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    state.mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    state.mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.on('ready', () => {
  createWindow();

  // Prevent macOS from sleeping while the app is running so the
  // Cloudflare tunnel (and gateway) stay alive for phone connections.
  // -d: prevent display sleep, -i: prevent idle sleep, -s: prevent system sleep
  state.caffeinateProc = spawn('caffeinate', ['-dis']);
  state.caffeinateProc.on('error', () => { state.caffeinateProc = null; });

  const config = loadConfig();
  // Start proxy before tunnel — cloudflared points to the proxy port
  startProxyServer(config.port, config.port + 1);
  startTunnel();
  if (config.workspaces.length > 0 && config.activeWorkspaceId) {
    startServer();
  } else {
    // Serve health checks so the mobile can connect while waiting for setup
    startSetupServer();
  }

  // ── Sleep / Wake ──────────────────────────────────────────
  powerMonitor.on('suspend', () => {
    stopClientPresenceMonitor();
  });

  powerMonitor.on('resume', () => {
    if (state.clientConnectedState) {
      state.lastClientHeartbeat = Date.now();
      startClientPresenceMonitor();
    }
  });
});

app.on('window-all-closed', () => {
  stopAll();
  app.quit();
});

app.on('before-quit', () => {
  stopAll();
});

app.on('activate', () => {
  if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
});
