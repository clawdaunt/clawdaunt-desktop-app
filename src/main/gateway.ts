import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { state, send } from './state';
import { loadConfig, generateOpenClawConfig, OPENCLAW_CONFIG_DIR } from './config';
import { findBinary, findNodeFor, resolveOpenclaw, enrichedEnv } from './binary';
import { relayToPhoneClients, stopProxyServer, stopSetupServer, stopClientPresenceMonitor } from './proxy';

// ── Gateway WebSocket observer ──────────────────────────────────
export function broadcastSessions(): void {
  send('sessions-updated', Array.from(state.sessions.values()));
}

function getDeviceToken(): string | null {
  const pairedPath = path.join(OPENCLAW_CONFIG_DIR, 'devices', 'paired.json');
  try {
    const data = JSON.parse(fs.readFileSync(pairedPath, 'utf-8'));
    for (const dev of Object.values(data) as Record<string, unknown>[]) {
      const tokens = dev.tokens as Record<string, { token: string }> | undefined;
      if (tokens?.operator?.token) return tokens.operator.token;
    }
  } catch { /* ignore */ }
  return null;
}

export function connectGatewayWs(port: number, token: string): void {
  closeGatewayWs();
  state.gatewayWsAuthenticated = false;

  const url = `ws://127.0.0.1:${port}/ws/client?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  state.gatewayWs = ws;

  ws.addEventListener('open', () => {
    console.log('[gatewayWs] connected to', url.replace(/token=[^&]+/, 'token=***'));
    state.gatewayWsAuthenticated = true;
    console.log('[gatewayWs] authenticated (client endpoint)');
    // Keepalive — use WebSocket-level ping, not JSON
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // No-op: gateway handles keepalive internally
      } else {
        clearInterval(pingTimer);
      }
    }, 25000);
  });

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(String(evt.data));

      if (msg.type === 'pong') return;

      // Handle challenge if server sends one — respond with gateway token
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        const { nonce } = msg.payload || {};
        if (!nonce) { ws.close(); return; }
        ws.send(JSON.stringify({
          type: 'req', id: 'connect-1', method: 'connect',
          params: {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'openclaw-macos', version: '1.0.0', platform: 'darwin', mode: 'ui' },
            role: 'operator',
            scopes: ['operator.read', 'operator.write', 'operator.approvals'],
            caps: ['tool-events'],
            auth: { token },
          },
        }));
        return;
      }
      if (msg.type === 'res' && msg.id === 'connect-1') {
        if (msg.ok) console.log('[gatewayWs] challenge handshake ok');
        return;
      }

      // Debug: log all post-auth messages
      const eventType_ = msg.event || msg.type;
      console.log('[gatewayWs] msg:', eventType_, 'sid:', (msg.payload || msg).session_id || (msg.payload || msg).sessionId || '(none)');
      if (eventType_ !== 'health') {
        console.log('[gatewayWs] FULL:', JSON.stringify(msg).slice(0, 500));
      }

      // Handle error responses from gateway (e.g. scope errors on chat.send)
      if (msg.type === 'res' && !msg.ok) {
        const errMsg = msg.error?.message || msg.errorMessage || JSON.stringify(msg.error || 'Unknown error');
        console.log('[gatewayWs] request error:', msg.id, errMsg);
        send('chat-event', { type: 'error', payload: { error: errMsg } });
        return;
      }

      // Gateway events come as { type: "event", event: "...", payload: { ... } }
      // or flat { type: "...", session_id: "..." } depending on protocol version.
      const eventType = msg.event || msg.type;
      const payload = msg.payload || msg;
      let sid: string = payload.session_id || payload.sessionId || payload.sessionKey || '';

      // For events without session IDs, use the active desktop session key
      if (!sid && state.activeDesktopSessionKey) {
        sid = state.activeDesktopSessionKey;
        payload.session_id = sid;
      }

      if (!sid && !['stream.delta', 'stream.end'].includes(eventType)) return;

      if (eventType === 'session.status') {
        const existing = state.sessions.get(sid);
        state.sessions.set(sid, {
          id: sid,
          status: payload.status === 'busy' ? 'busy' : 'idle',
          title: existing?.title ?? payload.title ?? 'New session',
          skill: payload.skill ?? existing?.skill,
          startedAt: existing?.startedAt ?? Date.now(),
          workspaceId: existing?.workspaceId ?? loadConfig().activeWorkspaceId ?? undefined,
        });
        broadcastSessions();
        relayToPhoneClients(msg);
        send('chat-event', { type: eventType, payload });
      } else if (eventType === 'session.idle') {
        const existing = state.sessions.get(sid);
        if (existing) {
          existing.status = 'idle';
          broadcastSessions();
        }
        relayToPhoneClients(msg);
        send('chat-event', { type: eventType, payload });
      } else if (eventType === 'session.error') {
        const existing = state.sessions.get(sid);
        if (existing) {
          existing.status = 'idle';
          existing.title = payload.error ? `Error: ${payload.error}` : existing.title;
          broadcastSessions();
        }
        relayToPhoneClients(msg);
        send('chat-event', { type: eventType, payload });
      } else if (eventType === 'message.updated') {
        const existing = state.sessions.get(sid);
        if (existing && payload.title) {
          existing.title = payload.title;
          broadcastSessions();
        }
        relayToPhoneClients(msg);
      } else if (eventType === 'session.ended') {
        state.sessions.delete(sid);
        broadcastSessions();
        relayToPhoneClients(msg);
        send('chat-event', { type: eventType, payload });
      } else if (eventType === 'chat') {
        relayToPhoneClients(msg);
        const chatState = payload.state as string;
        if (chatState === 'error') {
          send('chat-event', { type: 'error', payload: { session_id: sid, error: payload.errorMessage || 'Unknown error' } });
        } else if (chatState === 'delta' || chatState === 'final') {
          // Extract text from message.content[0].text
          const message = payload.message as Record<string, unknown> | undefined;
          const content = (message?.content as Array<Record<string, unknown>>) || [];
          const textPart = content.find(c => c.type === 'text');
          if (textPart?.text) {
            const runId = (payload.runId as string) || 'chat-part';
            send('chat-event', {
              type: 'message.part.updated',
              payload: {
                session_id: sid,
                part: { id: runId, type: 'text', text: textPart.text },
              },
            });
          }
          if (chatState === 'final') {
            send('chat-event', { type: 'session.idle', payload: { session_id: sid } });
            if (sid === state.activeDesktopSessionKey) state.activeDesktopSessionKey = null;
          }
        }
      } else if (eventType === 'agent') {
        relayToPhoneClients(msg);
        const data = payload.data as Record<string, unknown> | undefined;
        const stream = payload.stream as string;
        if (stream === 'lifecycle') {
          const phase = data?.phase as string;
          if (phase === 'start') {
            send('chat-event', { type: 'session.status', payload: { session_id: sid, status: 'busy' } });
          } else if (phase === 'end') {
            // Don't send session.idle here — chat 'final' event handles it.
            // Sending it here prematurely clears currentAssistantId before the
            // chat final response text arrives, causing the chat to "reset".
          } else if (phase === 'error') {
            send('chat-event', { type: 'error', payload: { session_id: sid, error: data?.error || 'Unknown error' } });
          }
        } else if (stream === 'tool') {
          send('chat-event', { type: 'agent.tool', payload: { session_id: sid, data } });
        } else if (stream === 'thinking') {
          send('chat-event', { type: 'agent.thinking', payload: { session_id: sid, data } });
        }
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
        relayToPhoneClients(msg);
        send('chat-event', { type: eventType, payload });
      }
    } catch {
      // Ignore non-JSON messages
    }
  });

  ws.addEventListener('close', (e) => {
    console.log('[gatewayWs] closed, code:', e.code, 'reason:', e.reason, 'wasAuthenticated:', state.gatewayWsAuthenticated);
    state.gatewayWs = null;
    state.gatewayWsAuthenticated = false;
    if (!state.intentionallyStopping) {
      console.log('[gatewayWs] will retry in 3s');
      state.gatewayWsRetryTimer = setTimeout(() => connectGatewayWs(port, token), 3000);
    }
  });

  ws.addEventListener('error', (e) => {
    console.log('[gatewayWs] error:', (e as ErrorEvent).message || 'unknown');
    // close event will fire after this, triggering reconnect
  });
}

export function closeGatewayWs(): void {
  if (state.gatewayWsRetryTimer) {
    clearTimeout(state.gatewayWsRetryTimer);
    state.gatewayWsRetryTimer = null;
  }
  if (state.gatewayWs) {
    state.gatewayWs.close();
    state.gatewayWs = null;
  }
  state.sessions.clear();
  broadcastSessions();
}

// ── OpenClaw gateway ──────────────────────────────────────────
export function startServer(): void {
  const config = loadConfig();
  state.intentionallyStopping = false;

  const resolved = resolveOpenclaw();
  const openclawBin = resolved.path;
  if (!openclawBin) {
    send('error', 'openclaw not found. Install with: brew install openclaw-cli');
    return;
  }

  // If system openclaw is outdated, notify the renderer
  if (resolved.updateInfo) {
    state.openclawUpdateInfo = resolved.updateInfo;
    send('openclaw-update', state.openclawUpdateInfo);
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
    } else if (config.apiProvider === 'minimax') {
      env.MINIMAX_API_KEY = config.apiKey;
    } else if (config.apiProvider === 'gemini' || config.apiProvider === 'gemini-flash') {
      env.GEMINI_API_KEY = config.apiKey;
    } else if (config.apiProvider === 'anthropic-sonnet-4-5') {
      env.ANTHROPIC_API_KEY = config.apiKey;
    }
  }

  state.gatewayProc = spawn(findNodeFor(openclawBin), [
    openclawBin,
    'gateway',
    '--port', String(config.port),
    '--token', config.password,
    '--allow-unconfigured',
    '--force',
    '--compact',
  ], {
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
  state.gatewayProc.stdout?.on('data', forwardLog);
  state.gatewayProc.stderr?.on('data', forwardLog);

  state.gatewayProc.on('error', (err) => {
    send('status', 'error');
    send('error', `openclaw error: ${err.message}`);
  });

  state.gatewayProc.on('exit', (code) => {
    if (!state.intentionallyStopping) {
      send('status', code === 0 ? 'stopped' : 'error');
      if (code !== 0) send('error', `openclaw exited with code ${code}`);
      state.clientConnectedState = false;
      state.clientAwayState = false;
      state.lastClientHeartbeat = 0;
      stopClientPresenceMonitor();
      send('client-disconnected', true);
    }
  });

  // Wait for gateway to be ready before connecting WS
  const port = config.port;
  const password = config.password;
  let attempts = 0;
  const maxAttempts = 15;
  const pollGateway = () => {
    if (!state.gatewayProc || state.intentionallyStopping) return;
    attempts++;
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      if (res.statusCode === 200) {
        send('status', 'running');
        connectGatewayWs(port, password);
      } else if (attempts < maxAttempts) {
        setTimeout(pollGateway, 500);
      }
      res.resume();
    });
    req.on('error', () => {
      if (attempts < maxAttempts) {
        setTimeout(pollGateway, 500);
      } else {
        // Fallback: try connecting anyway
        send('status', 'running');
        connectGatewayWs(port, password);
      }
    });
    req.end();
  };
  setTimeout(pollGateway, 1000);
}

export function stopServer(resetClient = true): Promise<void> {
  state.intentionallyStopping = true;
  closeGatewayWs();
  const proc = state.gatewayProc;
  state.gatewayProc = null;
  send('status', 'stopped');
  if (resetClient) {
    state.clientConnectedState = false;
    state.clientAwayState = false;
    state.lastClientHeartbeat = 0;
    stopClientPresenceMonitor();
    send('client-disconnected', true);
  }
  if (!proc || proc.killed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill();
    // Fallback in case exit event never fires
    setTimeout(resolve, 3000);
  });
}

export function stopAll(): void {
  state.intentionallyStopping = true;
  if (state.tunnelHealthInterval) { clearInterval(state.tunnelHealthInterval); state.tunnelHealthInterval = null; }
  closeGatewayWs();
  stopClientPresenceMonitor();
  stopProxyServer();
  stopSetupServer();
  state.caffeinateProc?.kill();
  state.caffeinateProc = null;
  state.cloudflaredProc?.kill();
  state.cloudflaredProc = null;
  state.gatewayProc?.kill();
  state.gatewayProc = null;
  state.clientConnectedState = false;
  state.clientAwayState = false;
  state.lastClientHeartbeat = 0;
  send('status', 'stopped');
  state.currentTunnelURL = '';
  send('tunnel-url', '');
}
