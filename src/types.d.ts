declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

type AISource = 'claude-cli' | 'codex-cli' | 'api-key';

interface Workspace {
  id: string;
  name: string;
  paths: string[];
  protected: string[];
  openclawSessionKey?: string;  // maps to desktop:{random} key used with gateway
}

interface Config {
  port: number;
  password: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  aiSource: AISource;
  apiKey: string;
  apiProvider: string;
  apiKeys: Record<string, string>;  // provider → key
}

interface GatewaySession {
  id: string;
  status: 'busy' | 'idle';
  title: string;
  skill?: string;
  startedAt: number;
  workspaceId?: string;
}

interface PersistentSession {
  id: string;
  gatewayKey: string;
  title: string;
  updatedAt: number;
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
  setWorkspaceSessionKey: (workspaceId: string, sessionKey: string) => Promise<Config>;

  getTunnelURL: () => Promise<string>;
  getTunnelHealth: () => Promise<string>;

  onStatusUpdate: (cb: (status: string) => void) => void;
  waitForRunning: () => Promise<boolean>;
  onTunnelURL: (cb: (url: string) => void) => void;
  onTunnelHealth: (cb: (status: string) => void) => void;
  onError: (cb: (msg: string) => void) => void;
  onClientConnected: (cb: () => void) => void;
  onClientAway: (cb: () => void) => void;
  onClientDisconnected: (cb: () => void) => void;
  onGatewayLog: (cb: (text: string) => void) => void;

  listSessions: () => Promise<GatewaySession[]>;
  listPersistentSessions: () => Promise<PersistentSession[]>;
  deleteSession: (gatewayKey: string) => Promise<boolean>;
  clearSessionHistory: (sessionKey: string) => Promise<boolean>;
  loadSessionHistory: (sessionKey: string) => Promise<ChatMessage[]>;
  onSessionsUpdated: (cb: (sessions: GatewaySession[]) => void) => void;
  onConfigChanged: (cb: (config: Config) => void) => void;

  sendChatMessage: (sessionKey: string, message: string, attachments?: ChatAttachment[], fileRefs?: string[]) => Promise<void>;
  abortChat: (sessionKey: string) => Promise<void>;
  pickImage: () => Promise<ChatAttachment | null>;
  pickFile: () => Promise<FileReference[] | null>;
  checkScreenPermission: () => Promise<string>;
  captureScreenshot: () => Promise<ChatAttachment | null>;
  onChatEvent: (cb: (event: ChatEvent) => void) => void;
  offChatEvent: () => void;

  getOpenclawUpdateInfo: () => Promise<OpenclawUpdateInfo | null>;
  updateOpenclaw: () => Promise<{ success: boolean; error?: string; newVersion?: string }>;
  onOpenclawUpdate: (cb: (info: OpenclawUpdateInfo | null) => void) => void;
  onOpenclawUpdateProgress: (cb: (progress: OpenclawUpdateProgress) => void) => void;
}

interface ChatEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface ChatAttachment {
  type: 'image';
  mimeType: string;
  fileName: string;
  content: string;
  dataUrl: string;
}

interface FileReference {
  path: string;
  fileName: string;
  relativePath: string;
  imageData?: { mimeType: string; content: string; dataUrl: string };
}

interface ToolEvent {
  id: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: string;
  status: 'running' | 'done' | 'error';
  startedAt: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  files?: FileReference[];
  toolEvents?: ToolEvent[];
  timestamp: number;
}

interface OpenclawUpdateInfo {
  systemVersion: string;
  bundledVersion: string;
}

interface OpenclawUpdateProgress {
  status: 'updating' | 'done' | 'error';
  log?: string;
  error?: string;
  newVersion?: string;
}

interface Window {
  api: ElectronAPI;
}
