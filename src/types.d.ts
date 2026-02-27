declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

type AISource = 'claude-cli' | 'codex-cli' | 'api-key';

interface Workspace {
  id: string;
  name: string;
  paths: string[];
  protected: string[];
}

interface Config {
  port: number;
  password: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  aiSource: AISource;
  apiKey: string;
  apiProvider: string;
}

interface GatewaySession {
  id: string;
  status: 'busy' | 'idle';
  title: string;
  skill?: string;
  startedAt: number;
}

interface CLIStatus {
  openclaw: boolean;
  claude: boolean;
  codex: boolean;
}

interface ElectronAPI {
  loadConfig: () => Promise<Config>;
  startServer: () => Promise<void>;
  stopServer: () => Promise<void>;

  detectCLIs: () => Promise<CLIStatus>;
  setAISource: (aiSource: AISource, apiKey?: string, apiProvider?: string) => Promise<Config>;

  createWorkspace: () => Promise<Config>;
  renameWorkspace: (id: string, name: string) => Promise<Config>;
  deleteWorkspace: (id: string) => Promise<Config>;
  setActiveWorkspace: (id: string) => Promise<Config>;
  addProtectedPath: (workspaceId: string) => Promise<Config>;
  removeProtectedPath: (workspaceId: string, protectedPath: string) => Promise<Config>;

  getTunnelURL: () => Promise<string>;
  getTunnelHealth: () => Promise<string>;

  onStatusUpdate: (cb: (status: string) => void) => void;
  onTunnelURL: (cb: (url: string) => void) => void;
  onTunnelHealth: (cb: (status: string) => void) => void;
  onError: (cb: (msg: string) => void) => void;
  onClientConnected: (cb: () => void) => void;
  onClientAway: (cb: () => void) => void;
  onClientDisconnected: (cb: () => void) => void;
  onGatewayLog: (cb: (text: string) => void) => void;

  listSessions: () => Promise<GatewaySession[]>;
  onSessionsUpdated: (cb: (sessions: GatewaySession[]) => void) => void;
  onConfigChanged: (cb: (config: Config) => void) => void;
}

interface Window {
  api: ElectronAPI;
}
