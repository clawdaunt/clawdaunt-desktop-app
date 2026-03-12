import { ipcMain, dialog, desktopCapturer } from 'electron';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { state, send } from './state';
import { loadConfig, saveConfig, generateOpenClawConfig, type Config, type Workspace, type AISource } from './config';
import { findBinary, findNodeFor, enrichedEnv, getOpenclawVersion, SEARCH_PATHS } from './binary';
import { startServer, stopServer } from './gateway';
import { stopSetupServer } from './proxy';

export function registerIpcHandlers(): void {
  ipcMain.handle('config:load', () => loadConfig());
  ipcMain.handle('tunnel:url', () => state.currentTunnelURL);
  ipcMain.handle('tunnel:health', () => state.tunnelHealthStatus);
  ipcMain.handle('server:start', () => startServer());
  ipcMain.handle('server:stop', () => stopServer());

  ipcMain.handle('sessions:list', () => Array.from(state.sessions.values()));

  ipcMain.handle('sessions:list-persistent', () => {
    return new Promise((resolve) => {
      const openclawBin = findBinary('openclaw');
      if (!openclawBin) { console.log('[sessions:list-persistent] openclaw binary not found'); return resolve([]); }
      console.log('[sessions:list-persistent] calling:', findNodeFor(openclawBin), openclawBin);
      execFile(findNodeFor(openclawBin), [openclawBin, 'gateway', 'call', 'sessions.list', '--json'], {
        env: enrichedEnv(),
        timeout: 15000,
      }, (err, stdout, stderr) => {
        if (err) { console.log('[sessions:list-persistent] error:', err.message, stderr); return resolve([]); }
        console.log('[sessions:list-persistent] raw output length:', stdout.length);
        try {
          const raw = JSON.parse(stdout);
          const list: Record<string, unknown>[] = Array.isArray(raw) ? raw : (raw.sessions || []);
          const sessionsPath = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
          let sessionsData: Record<string, { sessionId?: string; claudeCliSessionId?: string }> = {};
          try { sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch { /* ignore */ }
          const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
          const projectDirs = fs.existsSync(claudeProjectsDir) ? fs.readdirSync(claudeProjectsDir) : [];

          const result = list.map((s) => {
            const fullKey = (s.key || '') as string;
            const shortKey = fullKey.includes(':') ? fullKey.split(':').pop()! : fullKey;
            const updatedAt = typeof s.updatedAt === 'number' ? s.updatedAt
              : typeof s.updatedAt === 'string' ? new Date(s.updatedAt as string).getTime() / 1000
              : Date.now() / 1000;

            // Try to get first user message as title
            let title = (s.title as string) || shortKey;
            // sessions.json uses keys like "desktop:abc123" while gateway uses "agent:main:desktop:abc123"
            const strippedKey = fullKey.replace(/^agent:main:/, '');
            const entry = sessionsData[strippedKey] || sessionsData[shortKey] || sessionsData[fullKey];
            // Helper to extract first user message text as title
            const extractTitleFromContent = (rawContent: unknown): string => {
              let text = '';
              if (Array.isArray(rawContent)) {
                text = rawContent.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('');
              } else if (typeof rawContent === 'string') {
                text = rawContent;
              }
              const trimmed = text.replace(/^\n+|\n+$/g, '');
              return trimmed.length > 80 ? trimmed.slice(0, 80) + '...' : trimmed;
            };

            let titleFound = false;

            // Try claude CLI session logs first
            if (entry?.claudeCliSessionId) {
              for (const dir of projectDirs) {
                const candidate = path.join(claudeProjectsDir, dir, `${entry.claudeCliSessionId}.jsonl`);
                if (!fs.existsSync(candidate)) continue;
                try {
                  const content = fs.readFileSync(candidate, 'utf-8');
                  for (const line of content.split('\n')) {
                    if (!line) continue;
                    const parsed = JSON.parse(line);
                    if (parsed.type !== 'user') continue;
                    const extracted = extractTitleFromContent(parsed.message?.content ?? '');
                    if (extracted) { title = extracted; titleFound = true; }
                    break;
                  }
                } catch { /* skip */ }
                break;
              }
            }

            // Fallback: try gateway session JSONL
            if (!titleFound && entry?.sessionId) {
              const gwFile = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', `${entry.sessionId}.jsonl`);
              if (fs.existsSync(gwFile)) {
                try {
                  const content = fs.readFileSync(gwFile, 'utf-8');
                  for (const line of content.split('\n')) {
                    if (!line) continue;
                    const parsed = JSON.parse(line);
                    if (parsed.type !== 'message' || parsed.message?.role !== 'user') continue;
                    const extracted = extractTitleFromContent(parsed.message?.content ?? '');
                    if (extracted) { title = extracted; }
                    break;
                  }
                } catch { /* skip */ }
              }
            }
            return { id: shortKey, gatewayKey: fullKey, title, updatedAt };
          });
          // Deduplicate by shortKey — gateway may return same session under different key formats
          const deduped = new Map<string, typeof result[0]>();
          for (const s of result) {
            const existing = deduped.get(s.id);
            if (!existing || s.updatedAt > existing.updatedAt) {
              deduped.set(s.id, s);
            }
          }
          const finalResult = Array.from(deduped.values()).sort((a, b) => b.updatedAt - a.updatedAt);
          console.log('[sessions:list-persistent] returning', finalResult.length, 'sessions');
          resolve(finalResult);
        } catch (e) { console.log('[sessions:list-persistent] parse error:', e); resolve([]); }
      });
    });
  });

  ipcMain.handle('sessions:clear-history', (_, sessionKey: string) => {
    return new Promise((resolve) => {
      const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
      const sessionsPath = path.join(sessionsDir, 'sessions.json');
      let sessionsData: Record<string, { sessionId?: string; claudeCliSessionId?: string }> = {};
      try { sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch { /* ok */ }

      const strippedKey = sessionKey.replace(/^agent:main:/, '');
      const entry = sessionsData[strippedKey] || sessionsData[sessionKey];

      // Delete JSONL files
      if (entry?.sessionId) {
        const gwFile = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
        try { fs.unlinkSync(gwFile); } catch { /* ok */ }
      }
      if (entry?.claudeCliSessionId) {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        const projectDirs = fs.existsSync(claudeProjectsDir) ? fs.readdirSync(claudeProjectsDir) : [];
        for (const dir of projectDirs) {
          const candidate = path.join(claudeProjectsDir, dir, `${entry.claudeCliSessionId}.jsonl`);
          try { fs.unlinkSync(candidate); break; } catch { /* ok */ }
        }
      }

      // Remove entry from sessions.json so gateway gets a fresh session ID
      const matchKey = sessionsData[strippedKey] ? strippedKey : sessionsData[sessionKey] ? sessionKey : null;
      if (matchKey) {
        delete sessionsData[matchKey];
        try { fs.writeFileSync(sessionsPath, JSON.stringify(sessionsData, null, 2)); } catch { /* ok */ }
      }

      // Tell gateway to drop its in-memory state — it'll recreate on next message
      const openclawBin = findBinary('openclaw');
      if (openclawBin) {
        execFile(findNodeFor(openclawBin), [openclawBin, 'gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: strippedKey }), '--json'], {
          env: enrichedEnv(),
          timeout: 15000,
        }, () => resolve(true)); // resolve regardless of error — files are already cleaned
      } else {
        resolve(true);
      }
    });
  });

  ipcMain.handle('sessions:delete', (_, gatewayKey: string) => {
    return new Promise((resolve, reject) => {
      const openclawBin = findBinary('openclaw');
      if (!openclawBin) return reject(new Error('openclaw not found'));
      const shortKey = gatewayKey.replace(/^agent:main:/, '');
      execFile(findNodeFor(openclawBin), [openclawBin, 'gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key: shortKey }), '--json'], {
        env: enrichedEnv(),
        timeout: 15000,
      }, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  });

  // Helper to extract text from message content (array or string)
  function extractMessageText(rawContent: unknown): string {
    if (Array.isArray(rawContent)) {
      return rawContent.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('\n');
    } else if (typeof rawContent === 'string') {
      return rawContent;
    }
    return '';
  }

  // Parse gateway JSONL (type:"message" with message.role)
  function parseGatewayJSONL(content: string): { id: string; role: string; content: string; timestamp: number }[] {
    const messages: { id: string; role: string; content: string; timestamp: number }[] = [];
    let msgIndex = 0;
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'message') continue;
        const role = parsed.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = extractMessageText(parsed.message?.content ?? '');
        if (!text) continue;
        messages.push({
          id: `hist-${msgIndex++}`,
          role,
          content: text,
          timestamp: parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now(),
        });
      } catch { /* skip malformed lines */ }
    }
    return messages;
  }

  ipcMain.handle('sessions:load-history', (_, sessionKey: string) => {
    return new Promise((resolve) => {
      const sessionsDir = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions');
      const sessionsPath = path.join(sessionsDir, 'sessions.json');
      let sessionsData: Record<string, { sessionId?: string; claudeCliSessionId?: string }> = {};
      try { sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')); } catch { /* ok */ }

      // Try multiple key formats: exact, with desktop: prefix, with agent:main: prefix
      const entry = sessionsData[sessionKey]
        || sessionsData[`desktop:${sessionKey}`]
        || sessionsData[`agent:main:${sessionKey}`];

      // 1. Try claude CLI session logs (if entry has claudeCliSessionId)
      if (entry?.claudeCliSessionId) {
        const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
        const projectDirs = fs.existsSync(claudeProjectsDir) ? fs.readdirSync(claudeProjectsDir) : [];
        for (const dir of projectDirs) {
          const candidate = path.join(claudeProjectsDir, dir, `${entry.claudeCliSessionId}.jsonl`);
          if (!fs.existsSync(candidate)) continue;
          try {
            const content = fs.readFileSync(candidate, 'utf-8');
            const messages: { id: string; role: string; content: string; timestamp: number }[] = [];
            let msgIndex = 0;
            for (const line of content.split('\n')) {
              if (!line) continue;
              const parsed = JSON.parse(line);
              if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
              const text = extractMessageText(parsed.message?.content ?? '');
              if (!text) continue;
              messages.push({
                id: `hist-${msgIndex++}`,
                role: parsed.type,
                content: text,
                timestamp: parsed.timestamp || Date.now(),
              });
            }
            if (messages.length > 0) return resolve(messages);
          } catch { /* skip */ }
        }
      }

      // 2. Try gateway JSONL via sessionId from sessions.json
      if (entry?.sessionId) {
        const gwFile = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
        if (fs.existsSync(gwFile)) {
          try {
            const messages = parseGatewayJSONL(fs.readFileSync(gwFile, 'utf-8'));
            if (messages.length > 0) return resolve(messages);
          } catch { /* skip */ }
        }
      }

      // 3. Last resort: scan all gateway JSONL files for one whose session header matches the key
      try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(sessionsDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const firstLine = content.split('\n')[0];
            if (!firstLine) continue;
            const header = JSON.parse(firstLine);
            if (header.type === 'session') {
              const fileSessionId = header.id || file.replace('.jsonl', '');
              for (const [k, v] of Object.entries(sessionsData)) {
                if (v.sessionId === fileSessionId && (k === sessionKey || k === `desktop:${sessionKey}` || k.endsWith(`:${sessionKey}`))) {
                  const messages = parseGatewayJSONL(content);
                  if (messages.length > 0) return resolve(messages);
                }
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }

      resolve([]);
    });
  });

  ipcMain.handle('chat:send', (_, sessionKey: string, message: string, attachments?: { type: string; mimeType: string; fileName: string; content: string }[], fileRefs?: string[]) => {
    const config = loadConfig();
    console.log('[chat:send] sessionKey:', sessionKey, 'via HTTP', 'fileRefs:', fileRefs, 'attachments:', attachments?.length);

    let finalMessage = message;
    if (fileRefs && fileRefs.length > 0) {
      const refList = fileRefs.map(fp => `- ${fp}`).join('\n');
      finalMessage = `Referenced files:\n${refList}\n\n${message}`;
    }

    const body = JSON.stringify({
      model: 'default',
      messages: [{ role: 'user', content: finalMessage }],
      stream: true,
    }, null, 0);

    const url = `http://127.0.0.1:${config.port}/v1/chat/completions`;
    console.log('[chat:send] POST', url);

    // Track this session key so WS events without session IDs can be matched
    state.activeDesktopSessionKey = sessionKey;

    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.password}`,
        'Content-Type': 'application/json',
        'x-openclaw-session-key': sessionKey,
      },
    }, (res) => {
      console.log('[chat:send] response status:', res.statusCode);
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
        res.on('end', () => {
          console.log('[chat:send] error body:', errBody.slice(0, 300));
          send('chat-event', { type: 'error', payload: { error: `Gateway error: ${res.statusCode}` } });
        });
        return;
      }
      // Parse SSE stream from the HTTP response for content delivery
      let sseBuf = '';
      res.on('data', (chunk: Buffer) => {
        sseBuf += chunk.toString();
        const lines = sseBuf.split('\n');
        sseBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            console.log('[chat:sse] event:', JSON.stringify(parsed).slice(0, 300));
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              send('chat-event', {
                type: 'message.part.updated',
                payload: {
                  session_id: sessionKey,
                  delta: delta.content,
                  part: { id: parsed.id || 'sse-part', type: 'text', text: delta.content },
                },
              });
            }
          } catch { /* ignore non-JSON SSE lines */ }
        }
      });
      res.on('end', () => {
        console.log('[chat:sse] stream ended');
      });
    });

    req.on('error', (err) => {
      console.log('[chat:send] request error:', err.message);
      send('chat-event', { type: 'error', payload: { error: `Connection failed: ${err.message}` } });
    });

    req.write(body);
    req.end();
  });

  ipcMain.handle('chat:abort', (_, sessionKey: string) => {
    if (!state.gatewayWs || state.gatewayWs.readyState !== WebSocket.OPEN || !state.gatewayWsAuthenticated) return;
    state.gatewayWs.send(JSON.stringify({
      type: 'req',
      id: `abort-${Date.now()}`,
      method: 'session.abort',
      params: { sessionId: sessionKey, sessionKey },
    }));
  });

  ipcMain.handle('chat:pick-image', async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    const base64 = buffer.toString('base64');
    return {
      type: 'image',
      mimeType,
      fileName: path.basename(filePath),
      content: base64,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  });

  ipcMain.handle('chat:screenshot', async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return null;
    // Hide our window so it doesn't appear in the screenshot
    state.mainWindow.hide();
    // Small delay to let the window fully hide
    await new Promise(r => setTimeout(r, 300));
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (sources.length === 0) return null;
      const source = sources[0];
      const nativeImage = source.thumbnail;
      const png = nativeImage.toPNG();
      const base64 = png.toString('base64');
      const mimeType = 'image/png';
      return {
        type: 'image' as const,
        mimeType,
        fileName: `screenshot-${Date.now()}.png`,
        content: base64,
        dataUrl: `data:${mimeType};base64,${base64}`,
      };
    } finally {
      state.mainWindow?.show();
    }
  });

  ipcMain.handle('chat:pick-file', async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return null;
    const config = loadConfig();
    const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId);
    const defaultPath = activeWs?.paths[0] ?? undefined;
    const result = await dialog.showOpenDialog(state.mainWindow, {
      properties: ['openFile', 'multiSelections'],
      defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const IMAGE_EXTS: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    return result.filePaths.map((fp) => {
      const ext = path.extname(fp).toLowerCase().slice(1);
      const mimeType = IMAGE_EXTS[ext];
      let imageData: { mimeType: string; content: string; dataUrl: string } | undefined;
      if (mimeType) {
        try {
          const buffer = fs.readFileSync(fp);
          const base64 = buffer.toString('base64');
          imageData = { mimeType, content: base64, dataUrl: `data:${mimeType};base64,${base64}` };
        } catch { /* ignore read errors for images */ }
      }
      return {
        path: fp,
        fileName: path.basename(fp),
        relativePath: defaultPath ? path.relative(defaultPath, fp) : path.basename(fp),
        imageData,
      };
    });
  });

  ipcMain.handle('cli:detect', () => ({
    openclaw: !!findBinary('openclaw'),
    claude: !!findBinary('claude'),
    codex: !!findBinary('codex'),
  }));

  ipcMain.handle('openclaw:update-info', () => state.openclawUpdateInfo);

  ipcMain.handle('openclaw:update', async () => {
    if (state.openclawUpdateInProgress) return { success: false, error: 'Update already in progress' };
    state.openclawUpdateInProgress = true;
    send('openclaw-update-progress', { status: 'updating' });
    try {
      // Find brew
      let brewPath = '';
      for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
        const full = path.join(dir, 'brew');
        if (fs.existsSync(full)) { brewPath = full; break; }
      }
      if (!brewPath) {
        send('openclaw-update-progress', { status: 'error', error: 'Homebrew not found' });
        return { success: false, error: 'Homebrew not found. Install from https://brew.sh' };
      }

      // Run brew upgrade openclaw-cli
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(brewPath, ['upgrade', 'openclaw-cli'], {
          env: { ...process.env, PATH: SEARCH_PATHS.join(':') },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        proc.stdout?.on('data', (data: Buffer) => {
          send('openclaw-update-progress', { status: 'updating', log: data.toString() });
        });
        proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
        proc.on('error', (err) => reject(err));
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr || `brew upgrade exited with code ${code}`));
        });
      });

      // Verify new version
      const systemPath = (() => {
        for (const dir of SEARCH_PATHS) {
          const full = path.join(dir, 'openclaw');
          if (fs.existsSync(full)) return full;
        }
        return null;
      })();
      const newVersion = systemPath ? getOpenclawVersion(systemPath) : null;

      // Clear the update banner
      state.openclawUpdateInfo = null;
      send('openclaw-update-progress', { status: 'done', newVersion });
      send('openclaw-update', null);

      // Restart the server so it picks up the new binary
      await stopServer(false);
      startServer();

      return { success: true, newVersion };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      send('openclaw-update-progress', { status: 'error', error: msg });
      return { success: false, error: msg };
    } finally {
      state.openclawUpdateInProgress = false;
    }
  });

  ipcMain.handle('config:set-ai-source', async (_, aiSource: AISource, apiKey?: string, apiProvider?: string) => {
    const config = loadConfig();
    const changed = config.aiSource !== aiSource
      || (apiKey !== undefined && config.apiKey !== apiKey)
      || (apiProvider !== undefined && config.apiProvider !== apiProvider);
    config.aiSource = aiSource;
    if (apiProvider !== undefined) config.apiProvider = apiProvider;
    if (apiKey !== undefined && apiKey) {
      config.apiKey = apiKey;
      // Store per-provider
      if (config.apiProvider) config.apiKeys[config.apiProvider] = apiKey;
    } else if (apiProvider !== undefined) {
      // Switching provider without new key — load stored key for this provider
      config.apiKey = config.apiKeys[apiProvider] || '';
    }
    saveConfig(config);
    if (changed) {
      // Only restart when the config actually changed
      await stopServer(false);
      generateOpenClawConfig(config);
      startServer();
    }
    return config;
  });

  ipcMain.handle('workspace:create', async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return loadConfig();
    const result = await dialog.showOpenDialog(state.mainWindow, {
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

  ipcMain.handle('workspace:delete', async (_, id: string) => {
    const config = loadConfig();
    config.workspaces = config.workspaces.filter((w) => w.id !== id);
    if (config.activeWorkspaceId === id) {
      config.activeWorkspaceId = config.workspaces.length > 0 ? config.workspaces[0].id : null;
      if (config.activeWorkspaceId) {
        // Hot-reload to the fallback workspace
        saveConfig(config);
        generateOpenClawConfig(config);
      } else {
        // No workspaces left — stop the gateway
        await stopServer(true);
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
    // Rewrite openclaw.json — the gateway's config file watcher will hot-reload the workspace
    generateOpenClawConfig(config);
    return config;
  });

  ipcMain.handle('workspace:add-protected', async (_, workspaceId: string) => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return loadConfig();
    const config = loadConfig();
    const ws = config.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return config;

    const result = await dialog.showOpenDialog(state.mainWindow, {
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

  ipcMain.handle('workspace:set-session-key', (_, workspaceId: string, sessionKey: string) => {
    const config = loadConfig();
    const ws = config.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return config;
    ws.openclawSessionKey = sessionKey;
    saveConfig(config);
    return config;
  });
}
