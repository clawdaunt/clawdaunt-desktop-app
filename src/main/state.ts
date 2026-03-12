import { ChildProcess } from 'node:child_process';
import { Server as HttpServer } from 'node:http';
import { BrowserWindow } from 'electron';

export interface SessionInfo {
  id: string;
  status: 'busy' | 'idle';
  title: string;
  skill?: string;
  startedAt: number;
  workspaceId?: string;
}

export const state = {
  gatewayProc: null as ChildProcess | null,
  cloudflaredProc: null as ChildProcess | null,
  mainWindow: null as BrowserWindow | null,
  proxyServer: null as HttpServer | null,
  setupHttpServer: null as HttpServer | null,
  tunnelHealthInterval: null as ReturnType<typeof setInterval> | null,
  currentTunnelURL: '',
  tunnelHealthStatus: 'checking' as 'healthy' | 'checking' | 'down',
  clientConnectedState: false,
  clientAwayState: false,
  lastClientHeartbeat: 0,
  clientPresenceInterval: null as ReturnType<typeof setInterval> | null,
  caffeinateProc: null as ChildProcess | null,
  gatewayWs: null as WebSocket | null,
  gatewayWsRetryTimer: null as ReturnType<typeof setTimeout> | null,
  gatewayWsAuthenticated: false,
  activeDesktopSessionKey: null as string | null,
  sessions: new Map<string, SessionInfo>(),
  phoneWsClients: new Set<WebSocket>(),
  openclawUpdateInfo: null as { systemVersion: string; bundledVersion: string } | null,
  openclawUpdateInProgress: false,
  intentionallyStopping: false,
  tunnelRestarting: false,
};

export function send(channel: string, data: unknown) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, data);
  }
}
