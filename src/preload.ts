import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  loadConfig: () => ipcRenderer.invoke('config:load'),
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),

  detectCLIs: () => ipcRenderer.invoke('cli:detect'),
  setAISource: (aiSource: string, apiKey?: string, apiProvider?: string) =>
    ipcRenderer.invoke('config:set-ai-source', aiSource, apiKey, apiProvider),

  createWorkspace: () => ipcRenderer.invoke('workspace:create'),
  renameWorkspace: (id: string, name: string) => ipcRenderer.invoke('workspace:rename', id, name),
  deleteWorkspace: (id: string) => ipcRenderer.invoke('workspace:delete', id),
  setActiveWorkspace: (id: string) => ipcRenderer.invoke('workspace:set-active', id),
  addProtectedPath: (workspaceId: string) => ipcRenderer.invoke('workspace:add-protected', workspaceId),
  removeProtectedPath: (workspaceId: string, protectedPath: string) =>
    ipcRenderer.invoke('workspace:remove-protected', workspaceId, protectedPath),

  getTunnelURL: () => ipcRenderer.invoke('tunnel:url'),
  getTunnelHealth: () => ipcRenderer.invoke('tunnel:health'),

  onStatusUpdate: (cb: (status: string) => void) => {
    ipcRenderer.on('status', (_, s) => cb(s));
  },
  onTunnelURL: (cb: (url: string) => void) => {
    ipcRenderer.on('tunnel-url', (_, url) => cb(url));
  },
  onTunnelHealth: (cb: (status: string) => void) => {
    ipcRenderer.on('tunnel-health', (_, s) => cb(s));
  },
  onError: (cb: (msg: string) => void) => {
    ipcRenderer.on('error', (_, msg) => cb(msg));
  },
  onClientConnected: (cb: () => void) => {
    ipcRenderer.on('client-connected', () => cb());
  },
  onClientAway: (cb: () => void) => {
    ipcRenderer.on('client-away', () => cb());
  },
  onClientDisconnected: (cb: () => void) => {
    ipcRenderer.on('client-disconnected', () => cb());
  },
  onGatewayLog: (cb: (text: string) => void) => {
    ipcRenderer.on('gateway-log', (_, text) => cb(text));
  },

  listSessions: () => ipcRenderer.invoke('sessions:list'),
  onSessionsUpdated: (cb: (sessions: GatewaySession[]) => void) => {
    ipcRenderer.on('sessions-updated', (_, sessions) => cb(sessions));
  },
  onConfigChanged: (cb: (config: Config) => void) => {
    ipcRenderer.on('config-changed', (_, config) => cb(config));
  },
});
