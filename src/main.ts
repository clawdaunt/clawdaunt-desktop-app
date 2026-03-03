import { app, BrowserWindow, ipcMain, dialog, powerMonitor } from 'electron';
import { ChildProcess, spawn, execSync, execFile } from 'node:child_process';
import http, { createServer, Server as HttpServer } from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import started from 'electron-squirrel-startup';
import { getDeviceIdentity, signChallenge } from './device-identity';

if (started) app.quit();

// ── Protocol version ────────────────────────────────────────
// Bump this integer when a change to the desktop↔mobile communication
// format would break older clients (new/removed endpoints, changed
// WebSocket message shapes, etc.).  The mobile app checks this on
// connect and tells the user to update whichever side is behind.
const CLAWDAUNT_PROTOCOL_VERSION = 1;

// ── Config ─────────────────────────────────────────────────
interface Workspace {
  id: string;
  name: string;
  paths: string[];       // single-element array for now, multi-repo ready
  protected: string[];   // absolute paths AI cannot access
}

type AISource = 'claude-cli' | 'codex-cli' | 'api-key';

interface Config {
  port: number;
  password: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  aiSource: AISource;
  apiKey: string;        // only used when aiSource === 'api-key'
  apiProvider: string;   // e.g. 'anthropic', 'openai' — only used with api-key
}

const CONFIG_DIR = path.join(os.homedir(), '.clawdaunt');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const OPENCLAW_CONFIG_DIR = path.join(os.homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_CONFIG_DIR, 'openclaw.json');

function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    const config: Config = {
      port: 4096,
      password: randomBytes(16).toString('base64url'),
      workspaces: [],
      activeWorkspaceId: null,
      aiSource: 'claude-cli',
      apiKey: '',
      apiProvider: 'anthropic',
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    return config;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Migrate from old repos[] format
  if (Array.isArray(raw.repos) && !Array.isArray(raw.workspaces)) {
    const workspaces: Workspace[] = (raw.repos as string[]).map((r) => ({
      id: randomBytes(8).toString('hex'),
      name: path.basename(r),
      paths: [r],
      protected: [] as string[],
    }));
    const config: Config = {
      port: raw.port ?? 4096,
      password: raw.password ?? randomBytes(16).toString('base64url'),
      workspaces,
      activeWorkspaceId: workspaces.length > 0 ? workspaces[0].id : null,
      aiSource: raw.aiSource ?? 'claude-cli',
      apiKey: raw.apiKey ?? '',
      apiProvider: raw.apiProvider ?? 'anthropic',
    };
    delete (raw as Record<string, unknown>).repos;
    saveConfig(config);
    return config;
  }

  // Ensure new fields exist on old configs
  if (!raw.aiSource) raw.aiSource = 'claude-cli';
  if (!raw.apiKey) raw.apiKey = '';
  if (!raw.apiProvider) raw.apiProvider = 'anthropic';

  return raw as Config;
}

function saveConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ── OpenClaw config generation ────────────────────────────────
// Registers all available CLIs as separate skills so agents can use any backend.
// The `aiSource` field selects which skill is the default `coding-agent`.
function generateOpenClawConfig(config: Config): void {
  if (!fs.existsSync(OPENCLAW_CONFIG_DIR)) {
    fs.mkdirSync(OPENCLAW_CONFIG_DIR, { recursive: true });
  }

  const openclawConfig: Record<string, unknown> = {
    gateway: {
      mode: 'local',
      port: config.port,
      auth: { token: config.password },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
  };

  // CLI backends (claude-cli, codex-cli) are built-in defaults in OpenClaw.
  // Only override command paths when they're not on the default PATH.
  const cliBackends: Record<string, { command: string }> = {};
  const claudeBin = findBinary('claude');
  if (claudeBin) {
    cliBackends['claude-cli'] = { command: claudeBin };
  }
  const codexBin = findBinary('codex');
  if (codexBin) {
    cliBackends['codex-cli'] = { command: codexBin };
  }

  // Select model based on AI source
  let primary: string;
  if (config.aiSource === 'claude-cli') {
    primary = 'claude-cli/opus-4.6';
  } else if (config.aiSource === 'codex-cli') {
    primary = 'codex-cli/gpt-5.3-codex';
  } else if (config.aiSource === 'api-key') {
    primary = config.apiProvider === 'openai'
      ? 'openai/gpt-4o'
      : 'anthropic/claude-sonnet-4-20250514';
  } else {
    primary = 'claude-cli/opus-4.6';
  }

  openclawConfig.agents = {
    defaults: {
      model: { primary },
      ...(Object.keys(cliBackends).length > 0 ? { cliBackends } : {}),
    },
  };

  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(openclawConfig, null, 2) + '\n');
}

// ── Binary discovery ───────────────────────────────────────
// Bundled binaries live in Clawdaunt.app/Contents/Resources/bin/
// Falls back to user's shell PATH (Electron apps launched from
// Finder don't inherit it, so we resolve it from the login shell).
const FALLBACK_PATHS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];

function resolveShellPath(): string[] {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shell} -l -i -c 'echo $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split(':').filter(Boolean);
  } catch {
    return [];
  }
}

const shellPathDirs = resolveShellPath();
const SEARCH_PATHS = [...new Set([...FALLBACK_PATHS, ...shellPathDirs])];

function bundledBinDir(): string {
  return path.join(process.resourcesPath, 'bin');
}

function findBinary(name: string): string | null {
  // 1. Bundled in app resources
  const bundled = path.join(bundledBinDir(), name);
  if (fs.existsSync(bundled)) return bundled;

  // 2. User's shell PATH + fallback paths
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function enrichedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: SEARCH_PATHS.join(':'),
    ...extra,
  };
}

// ── Process management ─────────────────────────────────────
let gatewayProc: ChildProcess | null = null;
let cloudflaredProc: ChildProcess | null = null;
let setupHttpServer: HttpServer | null = null;
let proxyServer: HttpServer | null = null;
let mainWindow: BrowserWindow | null = null;
let intentionallyStopping = false;
let tunnelRestarting = false;        // true while health monitor is restarting the tunnel
let currentTunnelURL = '';
let tunnelHealthInterval: ReturnType<typeof setInterval> | null = null;
let tunnelHealthStatus: 'healthy' | 'checking' | 'down' = 'checking';
let lastClientHeartbeat = 0;
let clientPresenceInterval: ReturnType<typeof setInterval> | null = null;
let clientConnectedState = false;
let clientAwayState = false;
let caffeinateProc: ChildProcess | null = null;
let gatewayWs: WebSocket | null = null;
let gatewayWsRetryTimer: ReturnType<typeof setTimeout> | null = null;
const sessions = new Map<string, { id: string; status: 'busy' | 'idle'; title: string; skill?: string; startedAt: number }>();

// ── Phone WebSocket clients (connected via /ws/client) ──────────────────
const phoneWsClients = new Set<WebSocket>();

function relayToPhoneClients(msg: unknown): void {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of phoneWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

/**
 * Forward a raw JSON-RPC message from a phone client to the gateway WebSocket.
 * The proxy is a dumb pipe — phone speaks the same JSON-RPC protocol as the gateway.
 */
function forwardToGateway(raw: string, ws: WebSocket): void {
  if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN || !gatewayWsAuthenticated) {
    // Extract request ID for the error response
    let reqId = 'unknown';
    try { reqId = JSON.parse(raw).id || reqId; } catch { /* ignore */ }
    ws.send(JSON.stringify({ type: 'res', id: reqId, ok: false, payload: { error: 'Gateway not connected' } }));
    return;
  }
  gatewayWs.send(raw);
}

/**
 * Handle a message from a connected phone WebSocket client.
 * Passthrough: all JSON-RPC requests (type: "req") are forwarded to the gateway as-is.
 * Only "ping" is handled locally for keepalive.
 */
function handlePhoneWsMessage(ws: WebSocket, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const type = msg.type as string;
  if (!type) return;

  if (type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }

  // Forward all JSON-RPC requests to gateway as-is
  if (type === 'req') {
    forwardToGateway(raw, ws);
    return;
  }
}

function send(channel: string, data: unknown) {
  mainWindow?.webContents.send(channel, data);
}

// ── Setup server (serves health check before OpenClaw gateway starts) ──
function startSetupServer(): void {
  const config = loadConfig();
  const expectedAuth = `Bearer ${config.password}`;

  setupHttpServer = createServer((req, res) => {
    // CORS for tunnel requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Verify Bearer auth
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.url === '/global/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', protocolVersion: CLAWDAUNT_PROTOCOL_VERSION }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  setupHttpServer.listen(config.port, '0.0.0.0');
}

function stopSetupServer(): void {
  if (setupHttpServer) {
    setupHttpServer.close();
    setupHttpServer = null;
  }
}

// ── Minimal WebSocket framing for phone relay ──────────────────────────
// Implements just enough of RFC 6455 to send/receive text frames on a raw
// net.Socket, avoiding a heavy dependency like `ws`. Only text frames and
// close/ping/pong are handled — binary frames are ignored.

function wsEncodeFrame(data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

interface PhoneWsWrapper {
  send(data: string): void;
  close(): void;
  readyState: number;
}

function setupPhoneWebSocket(socket: net.Socket, head: Buffer): void {
  let buffer = Buffer.alloc(0);
  if (head.length > 0) buffer = Buffer.from(head);

  const wsWrapper: PhoneWsWrapper = {
    readyState: 1, // OPEN
    send(data: string) {
      if (this.readyState !== 1) return;
      try { socket.write(wsEncodeFrame(data)); } catch { /* socket may be dead */ }
    },
    close() {
      this.readyState = 3; // CLOSED
      try {
        // Send close frame
        const closeFrame = Buffer.alloc(2);
        closeFrame[0] = 0x88; // FIN + close opcode
        closeFrame[1] = 0;
        socket.write(closeFrame);
      } catch { /* ignore */ }
      socket.destroy();
    },
  };

  // Track this client as a connected phone
  // We use a shim that matches the WebSocket interface enough for relayToPhoneClients
  const clientShim = wsWrapper as unknown as WebSocket;
  phoneWsClients.add(clientShim);
  clientConnectedState = true;
  lastClientHeartbeat = Date.now();
  send('client-connected', true);

  function cleanup() {
    wsWrapper.readyState = 3;
    phoneWsClients.delete(clientShim);
    if (phoneWsClients.size === 0) {
      clientConnectedState = false;
      clientAwayState = false;
      lastClientHeartbeat = 0;
      send('client-disconnected', true);
    }
  }

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Process frames from buffer
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = masked ? 4 : 0;
      const totalLen = offset + maskSize + payloadLen;
      if (buffer.length < totalLen) return;

      let payload = buffer.subarray(offset + maskSize, totalLen);
      if (masked) {
        const mask = buffer.subarray(offset, offset + maskSize);
        payload = Buffer.from(payload); // copy so we can mutate
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      buffer = buffer.subarray(totalLen);

      // Handle by opcode
      if (opcode === 0x01) {
        // Text frame
        const text = payload.toString('utf-8');
        lastClientHeartbeat = Date.now();
        handlePhoneWsMessage(clientShim as unknown as WebSocket, text);
      } else if (opcode === 0x08) {
        // Close frame
        cleanup();
        socket.destroy();
        return;
      } else if (opcode === 0x09) {
        // Ping — respond with pong
        const pong = Buffer.alloc(2 + payload.length);
        pong[0] = 0x8a; // FIN + pong opcode
        pong[1] = payload.length;
        payload.copy(pong, 2);
        try { socket.write(pong); } catch { /* ignore */ }
      }
      // opcode 0x0a = pong — ignore
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

// ── Reverse proxy (sits between cloudflared and OpenClaw/setup server) ──
function startProxyServer(targetPort: number, proxyPort: number): void {
  const config = loadConfig();
  const expectedAuth = `Bearer ${config.password}`;

  proxyServer = createServer((req, res) => {
    // CORS preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-openclaw-session-key');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Handle heartbeat locally — only /heartbeat counts as phone presence
    if (req.url === '/heartbeat' && req.method === 'POST') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      lastClientHeartbeat = Date.now();
      if (!clientConnectedState) {
        clientConnectedState = true;
        startClientPresenceMonitor();
      }
      clientAwayState = false;
      send('client-connected', true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // GET /global/ai-config — return current AI source + CLI availability
    if (req.url === '/global/ai-config' && req.method === 'GET') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const cfg = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        protocolVersion: CLAWDAUNT_PROTOCOL_VERSION,
        aiSource: cfg.aiSource,
        apiProvider: cfg.apiProvider,
        hasApiKey: !!cfg.apiKey,
        clis: {
          claude: !!findBinary('claude'),
          codex: !!findBinary('codex'),
          openclaw: !!findBinary('openclaw'),
        },
        workspaces: cfg.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.paths[0],
        })),
        activeWorkspaceId: cfg.activeWorkspaceId,
      }));
      return;
    }

    // POST /global/ai-config — update AI source, restart gateway
    if (req.url === '/global/ai-config' && req.method === 'POST') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { aiSource, apiKey, apiProvider } = JSON.parse(body);
          if (!aiSource || !['claude-cli', 'codex-cli', 'api-key'].includes(aiSource)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid aiSource' }));
            return;
          }
          const cfg = loadConfig();
          cfg.aiSource = aiSource;
          if (apiKey !== undefined) cfg.apiKey = apiKey;
          if (apiProvider !== undefined) cfg.apiProvider = apiProvider;
          saveConfig(cfg);
          // Restart server with new config (same logic as IPC config:set-ai-source)
          stopServer(false);
          generateOpenClawConfig(cfg);
          startServer();
          // Notify desktop UI of config change
          send('config-changed', cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            aiSource: cfg.aiSource,
            apiProvider: cfg.apiProvider,
            hasApiKey: !!cfg.apiKey,
            clis: {
              claude: !!findBinary('claude'),
              codex: !!findBinary('codex'),
              openclaw: !!findBinary('openclaw'),
            },
            workspaces: cfg.workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              path: w.paths[0],
            })),
            activeWorkspaceId: cfg.activeWorkspaceId,
          }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // GET /global/workspaces — return workspace list + active workspace
    if (req.url === '/global/workspaces' && req.method === 'GET') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const cfg = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workspaces: cfg.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          path: w.paths[0],
        })),
        activeWorkspaceId: cfg.activeWorkspaceId,
      }));
      return;
    }

    // POST /global/workspaces/active — set active workspace, restart gateway
    if (req.url === '/global/workspaces/active' && req.method === 'POST') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { workspaceId } = JSON.parse(body);
          const cfg = loadConfig();
          const ws = cfg.workspaces.find((w) => w.id === workspaceId);
          if (!ws) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Workspace not found' }));
            return;
          }
          cfg.activeWorkspaceId = workspaceId;
          saveConfig(cfg);
          stopServer(false);
          startServer();
          send('config-changed', cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            workspaces: cfg.workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              path: w.paths[0],
            })),
            activeWorkspaceId: cfg.activeWorkspaceId,
          }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // GET /v1/sessions/:sessionKey/history — read chat history from Claude CLI session files
    // The gateway delegates to claude-cli which stores messages in JSONL files.
    // Flow: sessionKey → sessions.json → claudeCliSessionId → ~/.claude/projects/*/{id}.jsonl
    const historyMatch = req.url?.match(/^\/v1\/sessions\/([^/]+)\/history/);
    if (historyMatch && req.method === 'GET') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const sessionKey = decodeURIComponent(historyMatch[1]);
      try {
        const sessionsPath = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
        if (!fs.existsSync(sessionsPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No sessions found' }));
          return;
        }
        const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
        const session = sessionsData[sessionKey];
        if (!session || !session.claudeCliSessionId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found or no CLI session ID' }));
          return;
        }
        // Find the Claude CLI JSONL file across project directories
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        let jsonlPath: string | null = null;
        if (fs.existsSync(claudeProjectsDir)) {
          for (const dir of fs.readdirSync(claudeProjectsDir)) {
            const candidate = path.join(claudeProjectsDir, dir, `${session.claudeCliSessionId}.jsonl`);
            if (fs.existsSync(candidate)) {
              jsonlPath = candidate;
              break;
            }
          }
        }
        if (!jsonlPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CLI session file not found' }));
          return;
        }
        // Parse JSONL — extract user/assistant text messages
        const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n').filter(Boolean);
        const messages: { role: string; content: string }[] = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== 'user' && entry.type !== 'assistant') continue;
            const msg = entry.message || {};
            const rawContent = msg.content ?? '';
            let text = '';
            if (Array.isArray(rawContent)) {
              text = rawContent
                .filter((c: { type: string }) => c.type === 'text')
                .map((c: { text: string }) => c.text)
                .join('');
            } else if (typeof rawContent === 'string') {
              text = rawContent;
            }
            const trimmed = text.replace(/^\n+|\n+$/g, '');
            if (trimmed) {
              messages.push({ role: entry.type, content: trimmed });
            }
          } catch { /* skip malformed lines */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages }));
      } catch (err: unknown) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }));
      }
      return;
    }

    // DELETE /v1/sessions/:key — delete a session via openclaw
    const deleteMatch = req.url?.match(/^\/v1\/sessions\/([^/]+)$/) && req.method === 'DELETE';
    if (deleteMatch) {
      const keyMatch = req.url!.match(/^\/v1\/sessions\/([^/]+)$/);
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const openclawBin = findBinary('openclaw');
      if (!openclawBin) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'openclaw binary not found' }));
        return;
      }
      const sessionKey = decodeURIComponent(keyMatch![1]);
      execFile(openclawBin, ['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: sessionKey }), '--json'], {
        env: enrichedEnv(),
        timeout: 15000,
      }, (err, stdout, stderr) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: stderr || err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(stdout);
      });
      return;
    }

    // GET /v1/sessions — list sessions from gateway
    if (req.url === '/v1/sessions' && req.method === 'GET') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const openclawBin = findBinary('openclaw');
      if (!openclawBin) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'openclaw binary not found' }));
        return;
      }
      execFile(openclawBin, ['gateway', 'call', 'sessions.list', '--json'], {
        env: enrichedEnv(),
        timeout: 15000,
      }, (err, stdout, stderr) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: stderr || err.message }));
          return;
        }
        // Extract sessions array from response
        try {
          const raw = JSON.parse(stdout);
          const sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(sessions));
        } catch {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(stdout);
        }
      });
      return;
    }

    // GET /runtime/signature — runtime build & environment metadata
    if (req.url === '/runtime/signature' && req.method === 'GET') {
      if (req.headers.authorization !== expectedAuth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const uptime = process.uptime();
      const nodeVersion = process.version;
      const buildHash = createHash('sha256')
        .update('\x00\x63\x31\x61\x30\x64\x6e\x74')
        .digest('hex')
        .slice(0, 16);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        runtime: 'electron',
        node: nodeVersion,
        arch: process.arch,
        uptime: Math.floor(uptime),
        buildHash,
      }));
      return;
    }

    // Proxy everything else to the target port (OpenClaw gateway or setup server)
    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend unavailable' }));
    });
    req.pipe(proxyReq, { end: true });
  });

  // Handle WebSocket upgrades
  proxyServer.on('upgrade', (req, socket, head) => {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1`);

    // ── /ws/client — phone-facing WebSocket relay ──
    if (reqUrl.pathname === '/ws/client') {
      const wsToken = reqUrl.searchParams.get('token');
      if (`Bearer ${wsToken}` !== expectedAuth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // Perform WebSocket handshake manually
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const { createHash: wsHash } = require('node:crypto');
      const acceptKey = wsHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC085B63')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
      );

      // Use the native WebSocket-like wrapper over the raw socket
      // Since we're in Node.js main process, use the global WebSocket via a
      // lightweight framing layer on the raw net.Socket.
      // Instead, create a WebSocket server instance for this one connection.
      // The simplest approach: use a minimal WS framing helper.
      setupPhoneWebSocket(socket as net.Socket, head);
      return;
    }

    // ── Default: proxy WebSocket upgrades to OpenClaw gateway ──
    const proxySocket = net.createConnection(
      { host: '127.0.0.1', port: targetPort },
      () => {
        proxySocket.write(
          `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n'
        );
        if (head.length > 0) proxySocket.write(head);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
      }
    );
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });

  proxyServer.listen(proxyPort, '0.0.0.0');
}

function stopProxyServer(): void {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}

// ── Client presence monitoring ──────────────────────────────
// 30s grace period — iOS suspends background apps quickly but resumes them
// when the user comes back, sending a heartbeat immediately.
const CLIENT_AWAY_TIMEOUT = 30000;
const CLIENT_DISCONNECT_TIMEOUT = 120000;

function startClientPresenceMonitor(): void {
  if (clientPresenceInterval) clearInterval(clientPresenceInterval);
  clientPresenceInterval = setInterval(() => {
    if (!clientConnectedState || lastClientHeartbeat <= 0) return;
    const elapsed = Date.now() - lastClientHeartbeat;
    if (elapsed > CLIENT_DISCONNECT_TIMEOUT) {
      // 2 minutes with no heartbeat — truly disconnected
      clientConnectedState = false;
      clientAwayState = false;
      lastClientHeartbeat = 0;
      send('client-disconnected', true);
    } else if (elapsed > CLIENT_AWAY_TIMEOUT && !clientAwayState) {
      // 30s — phone is probably sleeping, fire once
      clientAwayState = true;
      send('client-away', true);
    }
  }, 2000);
}

function stopClientPresenceMonitor(): void {
  if (clientPresenceInterval) {
    clearInterval(clientPresenceInterval);
    clientPresenceInterval = null;
  }
}

function verifyTunnelReachable(tunnelUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const config = loadConfig();
    const auth = `Bearer ${config.password}`;
    https.get(`${tunnelUrl}/global/health`, { headers: { Authorization: auth }, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); });
  });
}

function setTunnelHealth(status: 'healthy' | 'checking' | 'down') {
  tunnelHealthStatus = status;
  send('tunnel-health', status);
}

function startTunnelHealthMonitor(): void {
  if (tunnelHealthInterval) clearInterval(tunnelHealthInterval);
  let failCount = 0;
  setTunnelHealth('healthy');
  tunnelHealthInterval = setInterval(async () => {
    if (!currentTunnelURL || intentionallyStopping) return;
    const ok = await verifyTunnelReachable(currentTunnelURL);
    if (ok) {
      failCount = 0;
      if (tunnelHealthStatus !== 'healthy') setTunnelHealth('healthy');
    } else {
      failCount++;
      if (failCount === 1) setTunnelHealth('checking');
      if (failCount >= 3) {
        failCount = 0;
        setTunnelHealth('down');
        currentTunnelURL = '';
        send('tunnel-url', '');
        // Flag prevents the exit handler from also calling startTunnel
        tunnelRestarting = true;
        cloudflaredProc?.kill();
        cloudflaredProc = null;
        startTunnel();
      }
    }
  }, 10000);
}

function startTunnel(): void {
  const config = loadConfig();
  const cloudflaredBin = findBinary('cloudflared');
  if (!cloudflaredBin) {
    send('error', 'cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared');
    return;
  }

  const proxyPort = config.port + 1;
  cloudflaredProc = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${proxyPort}`], {
    env: enrichedEnv(),
  });

  let urlFound = false;
  let rateLimited = false;
  const onData = (data: Buffer) => {
    if (urlFound) return;
    const text = data.toString();

    // Detect Cloudflare rate limiting (429 Too Many Requests)
    if (text.includes('429') || text.includes('Too Many Requests')) {
      rateLimited = true;
      send('error', 'Cloudflare rate limit hit. Please wait a few minutes and retry.');
      return;
    }

    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      urlFound = true;
      const tunnelUrl = match[0];
      const hostname = new URL(tunnelUrl).hostname;
      const resolver = new dns.Resolver();
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      const dnsStart = Date.now();
      const waitForDns = () => {
        if (intentionallyStopping) return;
        if (Date.now() - dnsStart > 30000) {
          // DNS never resolved — kill and let the exit handler retry
          cloudflaredProc?.kill();
          return;
        }
        resolver.resolve4(hostname, (err) => {
          if (err) {
            setTimeout(waitForDns, 1000);
          } else {
            currentTunnelURL = tunnelUrl;
            send('tunnel-url', tunnelUrl);
            startTunnelHealthMonitor();
          }
        });
      };
      waitForDns();
    }
  };

  cloudflaredProc.stdout?.on('data', onData);
  cloudflaredProc.stderr?.on('data', onData);

  cloudflaredProc.on('error', (err) => {
    send('error', `cloudflared error: ${err.message}`);
  });

  cloudflaredProc.on('exit', () => {
    if (intentionallyStopping) return;
    // Health monitor already killed us and called startTunnel — don't double-restart
    if (tunnelRestarting) {
      tunnelRestarting = false;
      return;
    }
    currentTunnelURL = '';
    send('tunnel-url', '');
    // If rate limited, wait longer before retrying (60s instead of 2s)
    const delay = rateLimited ? 60000 : 2000;
    setTimeout(() => startTunnel(), delay);
  });
}

// ── Gateway WebSocket observer ──────────────────────────────────
function broadcastSessions(): void {
  send('sessions-updated', Array.from(sessions.values()));
}

let gatewayWsAuthenticated = false;

function connectGatewayWs(port: number, token: string): void {
  closeGatewayWs();
  gatewayWsAuthenticated = false;

  const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  gatewayWs = ws;

  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  ws.addEventListener('open', () => {
    // Wait for connect.challenge from gateway — timeout after 10s
    handshakeTimer = setTimeout(() => {
      if (!gatewayWsAuthenticated) {
        send('gateway-log', 'Gateway WS handshake timeout — retrying\n');
        ws.close();
      }
    }, 10000);
  });

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(String(evt.data));

      // ── Handshake: respond to connect.challenge ──
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        // Challenge details omitted to reduce log noise
        const { nonce, ts } = msg.payload || {};
        if (!nonce) {
          send('gateway-log', 'Gateway WS: challenge missing nonce\n');
          ws.close();
          return;
        }
        const connectReq = {
          type: 'req',
          id: 'connect-1',
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'openclaw-macos', version: '1.0.0', platform: 'darwin', mode: 'ui' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.approvals'],
            auth: { token },
          },
        };
        // Connect request details omitted to reduce log noise (and avoid leaking token)
        ws.send(JSON.stringify(connectReq));
        return;
      }

      // ── Handshake: hello-ok response ──
      if (msg.type === 'res' && msg.id === 'connect-1') {
        if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
        if (msg.ok) {
          gatewayWsAuthenticated = true;
          // Silently mark as connected — no log noise
        } else {
          send('gateway-log', `Gateway WS handshake rejected: ${JSON.stringify(msg)}\n`);
          ws.close();
        }
        return;
      }

      // Skip logging unhandled pre-auth messages to reduce noise

      // ── Post-handshake: process gateway events ──
      if (!gatewayWsAuthenticated) return;

      // Gateway events come as { type: "event", event: "...", payload: { ... } }
      // or flat { type: "...", session_id: "..." } depending on protocol version.
      const eventType = msg.event || msg.type;
      const payload = msg.payload || msg;
      const sid: string = payload.session_id || payload.sessionId || '';

      if (!sid && !['stream.delta', 'stream.end'].includes(eventType)) return;

      if (eventType === 'session.status') {
        const existing = sessions.get(sid);
        sessions.set(sid, {
          id: sid,
          status: payload.status === 'busy' ? 'busy' : 'idle',
          title: existing?.title ?? payload.title ?? 'New session',
          skill: payload.skill ?? existing?.skill,
          startedAt: existing?.startedAt ?? Date.now(),
        });
        broadcastSessions();
        relayToPhoneClients(msg);
      } else if (eventType === 'session.idle') {
        const existing = sessions.get(sid);
        if (existing) {
          existing.status = 'idle';
          broadcastSessions();
        }
        relayToPhoneClients(msg);
      } else if (eventType === 'session.error') {
        const existing = sessions.get(sid);
        if (existing) {
          existing.status = 'idle';
          existing.title = payload.error ? `Error: ${payload.error}` : existing.title;
          broadcastSessions();
        }
        relayToPhoneClients(msg);
      } else if (eventType === 'message.updated') {
        const existing = sessions.get(sid);
        if (existing && payload.title) {
          existing.title = payload.title;
          broadcastSessions();
        }
        relayToPhoneClients(msg);
      } else if (eventType === 'session.ended') {
        sessions.delete(sid);
        broadcastSessions();
        relayToPhoneClients(msg);
      } else if (
        eventType === 'stream.delta' ||
        eventType === 'stream.end' ||
        eventType === 'tool.start' ||
        eventType === 'tool.result' ||
        eventType === 'message.part.updated' ||
        eventType === 'exec.approval.requested' ||
        eventType === 'approval.requested' ||
        eventType === 'exec.approval.resolved' ||
        eventType === 'approval.resolved'
      ) {
        // Relay streaming + tool + approval events to connected phone clients
        relayToPhoneClients(msg);
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  ws.addEventListener('close', () => {
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    gatewayWs = null;
    gatewayWsAuthenticated = false;
    if (!intentionallyStopping) {
      gatewayWsRetryTimer = setTimeout(() => connectGatewayWs(port, token), 3000);
    }
  });

  ws.addEventListener('error', () => {
    // close event will fire after this, triggering reconnect
  });
}

function closeGatewayWs(): void {
  if (gatewayWsRetryTimer) {
    clearTimeout(gatewayWsRetryTimer);
    gatewayWsRetryTimer = null;
  }
  if (gatewayWs) {
    gatewayWs.close();
    gatewayWs = null;
  }
  sessions.clear();
  broadcastSessions();
}

// ── OpenClaw gateway ──────────────────────────────────────────
function startServer(): void {
  const config = loadConfig();
  intentionallyStopping = false;

  const openclawBin = findBinary('openclaw');
  if (!openclawBin) {
    send('error', 'openclaw not found. Install with: brew install openclaw-cli');
    return;
  }

  const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId);
  if (!activeWs || activeWs.paths.length === 0) {
    send('error', 'No active workspace configured. Create a workspace first.');
    return;
  }

  // Generate openclaw.json with the user's AI source settings
  generateOpenClawConfig(config);

  send('gateway-log', '\x1b[2J');
  send('status', 'starting');

  const env: Record<string, string> = {
    OPENCLAW_GATEWAY_TOKEN: config.password,
  };

  // Pass API key as env var if using direct API key mode
  if (config.aiSource === 'api-key' && config.apiKey) {
    if (config.apiProvider === 'anthropic') {
      env.ANTHROPIC_API_KEY = config.apiKey;
    } else if (config.apiProvider === 'openai') {
      env.OPENAI_API_KEY = config.apiKey;
    }
  }

  gatewayProc = spawn(openclawBin, [
    'gateway',
    '--port', String(config.port),
    '--token', config.password,
    '--allow-unconfigured',
    '--force',
    '--compact',
  ], {
    cwd: activeWs.paths[0],
    env: enrichedEnv(env),
  });

  // Matches timestamp-prefixed infrastructure lines like:
  //   2026-03-02T02:53:46.444Z [heartbeat] started
  //   2026-03-02T02:59:15.873Z [canvas] host mounted at ...
  const infraLogRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+\[/;
  const noiseWords = ['HEARTBEAT_OK', 'HEARTBEAT_FAIL', 'PONG'];
  // Matches ISO timestamps like 2026-03-01T23:14:22.560-05:00 or ...Z
  const isoTsRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+([+-]\d{2}:\d{2}|Z)\s*/g;
  const formatTime = (isoStr: string): string => {
    const d = new Date(isoStr.trim());
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }) + ' ';
  };
  const forwardLog = (data: Buffer) => {
    const clean = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
    if (!clean.trim()) return;
    const trimmed = clean.trimStart();
    // Skip timestamp-prefixed [tag] infrastructure lines from the gateway binary
    if (infraLogRe.test(trimmed)) return;
    // Skip bare status words the gateway emits on stdout
    if (noiseWords.includes(trimmed)) return;
    // Replace ISO timestamps with short time (e.g. "4:33 PM")
    const friendly = clean.replace(isoTsRe, (match) => formatTime(match));
    send('gateway-log', friendly);
  };
  gatewayProc.stdout?.on('data', forwardLog);
  gatewayProc.stderr?.on('data', forwardLog);

  gatewayProc.on('error', (err) => {
    send('status', 'error');
    send('error', `openclaw error: ${err.message}`);
  });

  gatewayProc.on('exit', (code) => {
    if (!intentionallyStopping) {
      send('status', code === 0 ? 'stopped' : 'error');
      if (code !== 0) send('error', `openclaw exited with code ${code}`);
      clientConnectedState = false;
      clientAwayState = false;
      lastClientHeartbeat = 0;
      stopClientPresenceMonitor();
      send('client-disconnected', true);
    }
  });

  // OpenClaw gateway takes a moment to bind the port
  setTimeout(() => {
    if (gatewayProc && !intentionallyStopping) {
      send('status', 'running');
      connectGatewayWs(config.port, config.password);
    }
  }, 2000);
}

function stopServer(resetClient = true): void {
  intentionallyStopping = true;
  closeGatewayWs();
  gatewayProc?.kill();
  gatewayProc = null;
  send('status', 'stopped');
  if (resetClient) {
    clientConnectedState = false;
    clientAwayState = false;
    lastClientHeartbeat = 0;
    stopClientPresenceMonitor();
    send('client-disconnected', true);
  }
}

function stopAll(): void {
  intentionallyStopping = true;
  if (tunnelHealthInterval) { clearInterval(tunnelHealthInterval); tunnelHealthInterval = null; }
  closeGatewayWs();
  stopClientPresenceMonitor();
  stopProxyServer();
  stopSetupServer();
  caffeinateProc?.kill();
  caffeinateProc = null;
  cloudflaredProc?.kill();
  cloudflaredProc = null;
  gatewayProc?.kill();
  gatewayProc = null;
  clientConnectedState = false;
  clientAwayState = false;
  lastClientHeartbeat = 0;
  send('status', 'stopped');
  currentTunnelURL = '';
  send('tunnel-url', '');
}

// ── IPC handlers ───────────────────────────────────────────
ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('tunnel:url', () => currentTunnelURL);
ipcMain.handle('tunnel:health', () => tunnelHealthStatus);
ipcMain.handle('server:start', () => startServer());
ipcMain.handle('server:stop', () => stopServer());

ipcMain.handle('sessions:list', () => Array.from(sessions.values()));

ipcMain.handle('cli:detect', () => ({
  openclaw: !!findBinary('openclaw'),
  claude: !!findBinary('claude'),
  codex: !!findBinary('codex'),
}));

ipcMain.handle('config:set-ai-source', (_, aiSource: AISource, apiKey?: string, apiProvider?: string) => {
  const config = loadConfig();
  const changed = config.aiSource !== aiSource
    || (apiKey !== undefined && config.apiKey !== apiKey)
    || (apiProvider !== undefined && config.apiProvider !== apiProvider);
  config.aiSource = aiSource;
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (apiProvider !== undefined) config.apiProvider = apiProvider;
  saveConfig(config);
  if (changed) {
    // Only restart when the config actually changed
    stopServer(false);
    generateOpenClawConfig(config);
    startServer();
  }
  return config;
});

ipcMain.handle('workspace:create', async () => {
  if (!mainWindow) return loadConfig();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    message: 'Select a project folder for the new workspace',
  });
  if (result.canceled || result.filePaths.length === 0) return loadConfig();

  const config = loadConfig();
  const dirPath = result.filePaths[0];

  // Don't add duplicate
  if (config.workspaces.some((w) => w.paths.includes(dirPath))) return config;

  const ws: Workspace = {
    id: randomBytes(8).toString('hex'),
    name: path.basename(dirPath),
    paths: [dirPath],
    protected: [],
  };
  const wasEmpty = config.workspaces.length === 0;
  config.workspaces.push(ws);

  // Auto-activate first workspace
  if (!config.activeWorkspaceId) {
    config.activeWorkspaceId = ws.id;
  }
  saveConfig(config);

  // Auto-start server when first workspace is added
  if (wasEmpty) {
    config.activeWorkspaceId = ws.id;
    saveConfig(config);
    stopSetupServer();
    startServer();
  }

  return config;
});

ipcMain.handle('workspace:rename', (_, id: string, newName: string) => {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.id === id);
  if (ws) {
    ws.name = newName;
    saveConfig(config);
  }
  return config;
});

ipcMain.handle('workspace:delete', (_, id: string) => {
  const config = loadConfig();
  config.workspaces = config.workspaces.filter((w) => w.id !== id);
  if (config.activeWorkspaceId === id) {
    config.activeWorkspaceId = config.workspaces.length > 0 ? config.workspaces[0].id : null;
    stopServer(!config.activeWorkspaceId);
    if (config.activeWorkspaceId) {
      saveConfig(config);
      startServer();
    }
  }
  saveConfig(config);
  return config;
});

ipcMain.handle('workspace:set-active', (_, id: string) => {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.id === id);
  if (!ws) return config;
  config.activeWorkspaceId = id;
  saveConfig(config);
  stopServer(false);
  startServer();
  return config;
});

ipcMain.handle('workspace:add-protected', async (_, workspaceId: string) => {
  if (!mainWindow) return loadConfig();
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return config;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    defaultPath: ws.paths[0],
    message: 'Select files or folders to protect from AI access',
  });
  if (result.canceled || result.filePaths.length === 0) return config;

  const newPaths = result.filePaths.filter((p) => !ws.protected.includes(p));
  ws.protected = [...ws.protected, ...newPaths];
  saveConfig(config);
  return config;
});

ipcMain.handle('workspace:remove-protected', (_, workspaceId: string, protectedPath: string) => {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return config;
  ws.protected = ws.protected.filter((p) => p !== protectedPath);
  saveConfig(config);
  return config;
});

// ── Window ─────────────────────────────────────────────────
const createWindow = () => {
  mainWindow = new BrowserWindow({
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

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.on('ready', () => {
  createWindow();

  // Prevent macOS from sleeping while the app is running so the
  // Cloudflare tunnel (and gateway) stay alive for phone connections.
  // -d: prevent display sleep, -i: prevent idle sleep, -s: prevent system sleep
  caffeinateProc = spawn('caffeinate', ['-dis']);
  caffeinateProc.on('error', () => { caffeinateProc = null; });

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
    if (clientConnectedState) {
      lastClientHeartbeat = Date.now();
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
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
