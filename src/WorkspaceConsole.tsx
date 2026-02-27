import React, { useState, useEffect, useRef } from 'react';

type Status = 'stopped' | 'starting' | 'running' | 'error';
type TunnelHealth = 'healthy' | 'checking' | 'down';

interface ContextMenu {
  x: number;
  y: number;
  wsId: string;
}

interface WorkspaceConsoleProps {
  config: Config;
  status: Status;
  tunnelHealth: TunnelHealth;
  clientConnected: boolean;
  clientAway: boolean;
  errorMsg: string;
  gatewayLog: string[];
  onConfigUpdate: (config: Config) => void;
  onShowQR: () => void;
}

export default function WorkspaceConsole({
  config,
  status,
  tunnelHealth,
  clientConnected,
  clientAway,
  errorMsg,
  gatewayLog,
  onConfigUpdate,
  onShowQR,
}: WorkspaceConsoleProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [apiProvider, setApiProvider] = useState(config.apiProvider || 'anthropic');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({ openclaw: false, claude: false, codex: false });
  const [keySaved, setKeySaved] = useState(false);

  // Detect installed CLIs on mount
  useEffect(() => {
    window.api.detectCLIs().then(setCLIStatus);
  }, []);

  // Load sessions and listen for updates
  useEffect(() => {
    window.api.listSessions().then(setSessions);
    window.api.onSessionsUpdated(setSessions);
  }, []);

  const shortenPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

  // Focus rename input
  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [gatewayLog]);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleCreateWorkspace = async () => {
    onConfigUpdate(await window.api.createWorkspace());
  };

  const handleRenameSubmit = async (wsId: string) => {
    if (!renameValue.trim()) {
      setRenaming(null);
      return;
    }
    onConfigUpdate(await window.api.renameWorkspace(wsId, renameValue.trim()));
    setRenaming(null);
  };

  const handleDelete = async (id: string) => {
    onConfigUpdate(await window.api.deleteWorkspace(id));
  };

  const handleSetActive = async (id: string) => {
    onConfigUpdate(await window.api.setActiveWorkspace(id));
  };

  const handleAddProtected = async (wsId: string) => {
    onConfigUpdate(await window.api.addProtectedPath(wsId));
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    onConfigUpdate(await window.api.setAISource(config.aiSource, apiKey.trim(), apiProvider));
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  // Sync local state when config changes externally
  useEffect(() => {
    setApiKey(config.apiKey || '');
    setApiProvider(config.apiProvider || 'anthropic');
  }, [config.apiKey, config.apiProvider]);

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, wsId });
  };

  const formatElapsed = (startedAt: number) => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? null;

  return (
    <div className="console">
      <div className="drag-region" />

      {/* Top bar */}
      <div className="console-topbar">
        <h1 className="title">clawdaunt.ai</h1>
        <div className="topbar-indicators">
          <div className="tunnel-status">
            <span className="tunnel-label">Phone</span>
            <span className={`status-dot ${clientConnected ? (clientAway ? 'checking' : 'healthy') : 'stopped'}`} />
          </div>
          <div className="tunnel-status">
            <span className="tunnel-label">Tunnel</span>
            <span className={`status-dot ${tunnelHealth}`} />
          </div>
          <button className="text-btn show-qr-btn" onClick={onShowQR}>Show QR Code</button>
        </div>
      </div>

      <div className="console-body">
        {/* Sidebar */}
        <div className="console-sidebar">
          <div className="sidebar-header">
            <span className="sidebar-label">Workspaces</span>
            <button className="sidebar-add-btn" onClick={handleCreateWorkspace}>+</button>
          </div>
          <div className="workspace-list">
            {config.workspaces.map((ws) => (
              <div key={ws.id} onContextMenu={(e) => handleContextMenu(e, ws.id)}>
                {renaming === ws.id ? (
                  <div className="ws-item selected">
                    <span
                      className="ws-active-dot status-dot"
                      style={{
                        background: ws.id === config.activeWorkspaceId ? 'var(--green)' : 'transparent',
                      }}
                    />
                    <input
                      ref={renameRef}
                      className="ws-rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRenameSubmit(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit(ws.id);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  </div>
                ) : (
                  <button
                    className={`ws-item${ws.id === config.activeWorkspaceId ? ' selected' : ''}`}
                    onClick={() => handleSetActive(ws.id)}
                  >
                    <span
                      className="ws-active-dot status-dot"
                      style={{
                        background: ws.id === config.activeWorkspaceId ? 'var(--green)' : 'transparent',
                      }}
                    />
                    <span className="ws-item-name">{ws.name}</span>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Settings */}
          <div className="sidebar-settings">
            <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
        </div>

        {/* Main panel — terminal log viewer */}
        <div className="console-main">
          <div className="terminal-status-bar">
            {activeWs ? (
              <>
                <span className={`status-dot ${status}`} />
                <span className="terminal-ws-name">{activeWs.name}</span>
                <span className="terminal-ws-path">{shortenPath(activeWs.paths[0])}</span>
              </>
            ) : (
              <span className="terminal-ws-path">No active workspace</span>
            )}
          </div>

          {/* Active Sessions */}
          <div className="sessions-panel">
            <button
              className="sessions-header"
              onClick={() => setSessionsCollapsed(!sessionsCollapsed)}
            >
              <span className="sessions-chevron">{sessionsCollapsed ? '\u25B6' : '\u25BC'}</span>
              <span className="sessions-label">Active Sessions</span>
              {sessions.length > 0 && (
                <span className="sessions-count">{sessions.length}</span>
              )}
            </button>
            {!sessionsCollapsed && (
              <div className="sessions-list">
                {sessions.length === 0 ? (
                  <div className="sessions-empty">No active sessions</div>
                ) : (
                  sessions.map((s) => (
                    <div key={s.id} className="session-row">
                      <span className={`status-dot ${s.status === 'busy' ? 'running' : 'stopped'}`} />
                      <span className="session-title" title={s.title}>{s.title}</span>
                      {s.skill && <span className="session-skill">{s.skill}</span>}
                      <span className="session-time">{formatElapsed(s.startedAt)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="terminal" ref={terminalRef}>
            {gatewayLog.length === 0 ? (
              <div className="terminal-empty">No output yet</div>
            ) : (
              gatewayLog.map((line, i) => (
                <div key={i} className="terminal-line">{line}</div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (() => {
        const ws = config.workspaces.find((w) => w.id === contextMenu.wsId);
        if (!ws) return null;
        const isActive = ws.id === config.activeWorkspaceId;
        return (
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={() => setContextMenu(null)}
          >
            {!isActive && (
              <div
                className="context-menu-item"
                onClick={() => handleSetActive(ws.id)}
              >
                Set Active
              </div>
            )}
            <div
              className="context-menu-item"
              onClick={() => {
                setRenameValue(ws.name);
                setRenaming(ws.id);
              }}
            >
              Rename
            </div>
            <div
              className="context-menu-item danger"
              onClick={() => handleDelete(ws.id)}
            >
              Delete
            </div>
          </div>
        );
      })()}

      {errorMsg && <p className="error-msg">{errorMsg}</p>}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="settings-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <button className="settings-modal-close" onClick={() => setSettingsOpen(false)}>×</button>
            <h2 className="settings-modal-title">Settings</h2>

            <div className="settings-section">
              <span className="settings-section-label">CLI Status</span>
              {!cliStatus.openclaw && (
                <p className="cli-warning">openclaw not found</p>
              )}
              <div className="cli-status-list">
                <div className="cli-status-row">
                  <span className={`cli-dot ${cliStatus.claude ? 'installed' : 'missing'}`} />
                  <span className="cli-status-name">Claude CLI</span>
                  <span className={`cli-status-label ${cliStatus.claude ? 'available' : 'unavailable'}`}>
                    {cliStatus.claude ? 'Installed' : 'Not found'}
                  </span>
                </div>
                <div className="cli-status-row">
                  <span className={`cli-dot ${cliStatus.codex ? 'installed' : 'missing'}`} />
                  <span className="cli-status-name">Codex CLI</span>
                  <span className={`cli-status-label ${cliStatus.codex ? 'available' : 'unavailable'}`}>
                    {cliStatus.codex ? 'Installed' : 'Not found'}
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <span className="settings-section-label">API Key</span>
              <div className="api-key-form">
                <select
                  className="provider-select"
                  value={apiProvider}
                  onChange={(e) => setApiProvider(e.target.value)}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
                <input
                  className="api-key-input"
                  type="password"
                  placeholder={config.apiKey ? 'Key saved — enter new to replace' : 'Paste API key'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveApiKey();
                  }}
                />
                <button className="save-key-btn" onClick={handleSaveApiKey} disabled={!apiKey.trim()}>
                  {keySaved ? 'Saved!' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
