import http, { createServer, Server as HttpServer } from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { state, send } from './state';
import { loadConfig, CLAWDAUNT_PROTOCOL_VERSION } from './config';
import { findBinary, findNodeFor, enrichedEnv } from './binary';
// Lazy imports to avoid circular dependency — gateway.ts imports from proxy.ts
// and proxy.ts needs startServer/stopServer from gateway.ts
let _gateway: typeof import('./gateway') | null = null;
function getGateway() {
  if (!_gateway) _gateway = require('./gateway');
  return _gateway!;
}

// ── Phone WebSocket clients (connected via /ws/client) ──────────────────
export function relayToPhoneClients(msg: unknown): void {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of state.phoneWsClients) {
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
  if (!state.gatewayWs || state.gatewayWs.readyState !== WebSocket.OPEN || !state.gatewayWsAuthenticated) {
    // Extract request ID for the error response
    let reqId = 'unknown';
    try { reqId = JSON.parse(raw).id || reqId; } catch { /* ignore */ }
    ws.send(JSON.stringify({ type: 'res', id: reqId, ok: false, payload: { error: 'Gateway not connected' } }));
    return;
  }
  state.gatewayWs.send(raw);
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

// ── Setup server (serves health check before OpenClaw gateway starts) ──
export function startSetupServer(): void {
  const config = loadConfig();
  const expectedAuth = `Bearer ${config.password}`;

  state.setupHttpServer = createServer((req, res) => {
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

  state.setupHttpServer.listen(config.port, '0.0.0.0');
}

export function stopSetupServer(): void {
  if (state.setupHttpServer) {
    state.setupHttpServer.close();
    state.setupHttpServer = null;
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
  state.phoneWsClients.add(clientShim);
  state.clientConnectedState = true;
  state.lastClientHeartbeat = Date.now();
  send('client-connected', true);

  function cleanup() {
    wsWrapper.readyState = 3;
    state.phoneWsClients.delete(clientShim);
    if (state.phoneWsClients.size === 0) {
      state.clientConnectedState = false;
      state.clientAwayState = false;
      state.lastClientHeartbeat = 0;
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
        state.lastClientHeartbeat = Date.now();
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
export function startProxyServer(targetPort: number, proxyPort: number): void {
  const config = loadConfig();
  const expectedAuth = `Bearer ${config.password}`;

  state.proxyServer = createServer((req, res) => {
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
      state.lastClientHeartbeat = Date.now();
      if (!state.clientConnectedState) {
        state.clientConnectedState = true;
        startClientPresenceMonitor();
      }
      state.clientAwayState = false;
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
      req.on('end', async () => {
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
          const { saveConfig } = require('./config');
          saveConfig(cfg);
          // Restart server with new config (same logic as IPC config:set-ai-source)
          const { stopServer, startServer } = getGateway();
          await stopServer(false);
          const { generateOpenClawConfig } = require('./config');
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

    // POST /global/workspaces/active — set active workspace via config hot-reload
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
          const { saveConfig, generateOpenClawConfig } = require('./config');
          saveConfig(cfg);
          // Rewrite openclaw.json — gateway file watcher will hot-reload the workspace
          generateOpenClawConfig(cfg);
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
        // Look up by direct key first, then fall back to searching by sessionId
        let session = sessionsData[sessionKey];
        if (!session) {
          for (const entry of Object.values(sessionsData) as Record<string, unknown>[]) {
            if (entry.sessionId === sessionKey) {
              session = entry;
              break;
            }
          }
        }
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
      execFile(findNodeFor(openclawBin), [openclawBin, 'gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: sessionKey }), '--json'], {
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
      execFile(findNodeFor(openclawBin), [openclawBin, 'gateway', 'call', 'sessions.list', '--json'], {
        env: enrichedEnv(),
        timeout: 15000,
      }, (err, stdout, stderr) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: stderr || err.message }));
          return;
        }
        // Extract sessions array and enrich with first user message
        try {
          const raw = JSON.parse(stdout);
          const sessions: Record<string, unknown>[] = Array.isArray(raw) ? raw : (raw.sessions || []);
          const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId);

          // Read sessions.json to map keys -> claudeCliSessionId
          const sessionsPath = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
          let sessionsData: Record<string, { claudeCliSessionId?: string }> = {};
          try { sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch { /* ignore */ }

          const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
          const projectDirs = fs.existsSync(claudeProjectsDir) ? fs.readdirSync(claudeProjectsDir) : [];

          for (const s of sessions) {
            const fullKey = (s.key || '') as string;
            const shortKey = fullKey.includes(':') ? fullKey.split(':').pop()! : fullKey;
            const entry = sessionsData[shortKey] || sessionsData[fullKey];
            if (!entry?.claudeCliSessionId) continue;
            // Find JSONL and extract first user message
            for (const dir of projectDirs) {
              const candidate = path.join(claudeProjectsDir, dir, `${entry.claudeCliSessionId}.jsonl`);
              if (!fs.existsSync(candidate)) continue;
              try {
                const content = fs.readFileSync(candidate, 'utf-8');
                // Read only enough lines to find first user message
                for (const line of content.split('\n')) {
                  if (!line) continue;
                  const parsed = JSON.parse(line);
                  if (parsed.type !== 'user') continue;
                  const rawContent = parsed.message?.content ?? '';
                  let text = '';
                  if (Array.isArray(rawContent)) {
                    text = rawContent.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
                  } else if (typeof rawContent === 'string') {
                    text = rawContent;
                  }
                  const trimmed = text.replace(/^\n+|\n+$/g, '');
                  if (trimmed) {
                    s.firstMessage = trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed;
                  }
                  break;
                }
              } catch { /* skip */ }
              break;
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            sessions,
            activeWorkspaceName: activeWs?.name || null,
          }));
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
  state.proxyServer.on('upgrade', (req, socket, head) => {
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

  state.proxyServer.listen(proxyPort, '0.0.0.0');
}

export function stopProxyServer(): void {
  if (state.proxyServer) {
    state.proxyServer.close();
    state.proxyServer = null;
  }
}

// ── Client presence monitoring ──────────────────────────────
// 30s grace period — iOS suspends background apps quickly but resumes them
// when the user comes back, sending a heartbeat immediately.
const CLIENT_AWAY_TIMEOUT = 30000;
const CLIENT_DISCONNECT_TIMEOUT = 120000;

export function startClientPresenceMonitor(): void {
  if (state.clientPresenceInterval) clearInterval(state.clientPresenceInterval);
  state.clientPresenceInterval = setInterval(() => {
    if (!state.clientConnectedState || state.lastClientHeartbeat <= 0) return;
    const elapsed = Date.now() - state.lastClientHeartbeat;
    if (elapsed > CLIENT_DISCONNECT_TIMEOUT) {
      // 2 minutes with no heartbeat — truly disconnected
      state.clientConnectedState = false;
      state.clientAwayState = false;
      state.lastClientHeartbeat = 0;
      send('client-disconnected', true);
    } else if (elapsed > CLIENT_AWAY_TIMEOUT && !state.clientAwayState) {
      // 30s — phone is probably sleeping, fire once
      state.clientAwayState = true;
      send('client-away', true);
    }
  }, 2000);
}

export function stopClientPresenceMonitor(): void {
  if (state.clientPresenceInterval) {
    clearInterval(state.clientPresenceInterval);
    state.clientPresenceInterval = null;
  }
}
