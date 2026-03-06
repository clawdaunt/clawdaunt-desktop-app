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
  const logRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logExpanded, setLogExpanded] = useState(false);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [apiProvider, setApiProvider] = useState(config.apiProvider || 'anthropic');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({ openclaw: false, claude: false, codex: false });
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    window.api.detectCLIs().then(setCLIStatus);
  }, []);

  useEffect(() => {
    window.api.listSessions().then(setSessions);
    window.api.onSessionsUpdated(setSessions);
  }, []);

  // Auto-expand active workspace
  useEffect(() => {
    if (config.activeWorkspaceId) {
      setExpandedWorkspaces((prev) => new Set(prev).add(config.activeWorkspaceId!));
    }
  }, [config.activeWorkspaceId]);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [gatewayLog]);

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

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    onConfigUpdate(await window.api.setAISource(config.aiSource, apiKey.trim(), apiProvider));
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

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

  const toggleWorkspaceExpand = (wsId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? null;

  // Group sessions by workspace
  const sessionsByWorkspace = new Map<string, GatewaySession[]>();
  const orphanedSessions: GatewaySession[] = [];
  for (const s of sessions) {
    if (s.workspaceId) {
      const list = sessionsByWorkspace.get(s.workspaceId) || [];
      list.push(s);
      sessionsByWorkspace.set(s.workspaceId, list);
    } else {
      orphanedSessions.push(s);
    }
  }

  const connectionLabel = clientConnected
    ? clientAway ? 'Away' : 'Connected'
    : 'Phone Offline';
  const connectionClass = clientConnected
    ? clientAway ? 'away' : 'connected'
    : 'disconnected';

  return (
    <div className="app-shell">
      <div className="drag-region" />

      {/* Floating sidebar toggle when collapsed */}
      {!sidebarOpen && (
        <button className="floating-toggle" onClick={() => setSidebarOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      )}

      {/* Sidebar */}
      <div className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-top">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <button className="new-workspace-btn" onClick={handleCreateWorkspace}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New workspace
          </button>
        </div>

        <div className="workspace-list">
          {config.workspaces.map((ws) => {
            const wsSessions = sessionsByWorkspace.get(ws.id) || [];
            const isActive = ws.id === config.activeWorkspaceId;
            const isExpanded = expandedWorkspaces.has(ws.id);
            const hasSessions = wsSessions.length > 0;

            return (
              <div key={ws.id} className="ws-group" onContextMenu={(e) => handleContextMenu(e, ws.id)}>
                {renaming === ws.id ? (
                  <div className="ws-item selected">
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
                    className={`ws-item${isActive ? ' selected' : ''}`}
                    onClick={() => handleSetActive(ws.id)}
                  >
                    {hasSessions && (
                      <span
                        className={`ws-expand-btn${isExpanded ? ' expanded' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWorkspaceExpand(ws.id);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    )}
                    <span className="ws-item-name">{ws.name}</span>
                    {hasSessions && (
                      <span className="ws-session-count">{wsSessions.length}</span>
                    )}
                    {isActive && (
                      <span className="ws-active-indicator" style={{ background: 'var(--green)' }} />
                    )}
                  </button>
                )}

                {/* Nested sessions */}
                {hasSessions && isExpanded && (
                  <div className="ws-sessions">
                    {wsSessions.map((s) => (
                      <div key={s.id} className="ws-session-item">
                        <span className={`ws-session-dot ${s.status}`} />
                        <span className="ws-session-title" title={s.title}>{s.title}</span>
                        <span className="ws-session-time">{formatElapsed(s.startedAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* Orphaned sessions (no workspace association) */}
          {orphanedSessions.length > 0 && (
            <div className="ws-group">
              <div className="ws-orphan-label">Other sessions</div>
              <div className="ws-sessions">
                {orphanedSessions.map((s) => (
                  <div key={s.id} className="ws-session-item">
                    <span className={`ws-session-dot ${s.status}`} />
                    <span className="ws-session-title" title={s.title}>{s.title}</span>
                    <span className="ws-session-time">{formatElapsed(s.startedAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-bottom-left">
            <button className="sidebar-icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button className="sidebar-icon-btn" onClick={onShowQR} title="Connect device">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="8" height="8" rx="1" />
                <rect x="14" y="2" width="8" height="8" rx="1" />
                <rect x="2" y="14" width="8" height="8" rx="1" />
                <rect x="14" y="14" width="4" height="4" rx="0.5" />
                <line x1="22" y1="14" x2="22" y2="18" />
                <line x1="18" y1="22" x2="22" y2="22" />
              </svg>
            </button>
          </div>
          <div className="connection-pill">
            <span className={`connection-dot ${connectionClass}`} />
            {connectionLabel}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="main-content">
        <div className="main-header">
          <div>
            {activeWs ? (
              <span className="main-title">{activeWs.name}</span>
            ) : (
              <span className="main-title" style={{ color: 'var(--text-tertiary)' }}>No workspace selected</span>
            )}
          </div>
        </div>

        <div className="main-body">
          {sessions.length === 0 && gatewayLog.length === 0 ? (
            <div className="welcome-state">
              <div className="welcome-logo">clawdaunt<span>.</span></div>
              <p className="welcome-text">
                Your AI workspace is ready. Connect your device to get started, or select a workspace from the sidebar.
              </p>
              <div className="welcome-status">
                <span className={`connection-dot ${connectionClass}`} />
                {connectionLabel}
                {tunnelHealth === 'healthy' && ' — Tunnel active'}
                {tunnelHealth === 'checking' && ' — Connecting...'}
              </div>
            </div>
          ) : (
            /* Activity Log */
            <div className="activity-section">
              <button className="activity-toggle" onClick={() => setLogExpanded(!logExpanded)}>
                <span className="section-title">Activity</span>
                <span className={`activity-chevron${logExpanded ? ' expanded' : ''}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </span>
              </button>
              {logExpanded && (
                <div className="activity-log" ref={logRef}>
                  {gatewayLog.length === 0 ? (
                    <div className="activity-log-empty">No activity yet</div>
                  ) : (
                    gatewayLog.map((line, i) => (
                      <div key={i} className="activity-log-line">{line}</div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}

          {errorMsg && <div className="error-banner">{errorMsg}</div>}
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
              <div className="context-menu-item" onClick={() => handleSetActive(ws.id)}>
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
            <div className="context-menu-item danger" onClick={() => handleDelete(ws.id)}>
              Delete
            </div>
          </div>
        );
      })()}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSettingsOpen(false)}>×</button>
            <h2 className="modal-title">Settings</h2>

            <div className="settings-section">
              <span className="settings-label">CLI Status</span>
              {!cliStatus.openclaw && (
                <p className="cli-warning">openclaw CLI not found — install it to enable full functionality</p>
              )}
              <div className="cli-list">
                <div className="cli-row">
                  <span className={`cli-dot ${cliStatus.claude ? 'installed' : 'missing'}`} />
                  <span className="cli-name">Claude CLI</span>
                  <span className={`cli-status-text ${cliStatus.claude ? 'available' : 'unavailable'}`}>
                    {cliStatus.claude ? 'Installed' : 'Not found'}
                  </span>
                </div>
                <div className="cli-row">
                  <span className={`cli-dot ${cliStatus.codex ? 'installed' : 'missing'}`} />
                  <span className="cli-name">Codex CLI</span>
                  <span className={`cli-status-text ${cliStatus.codex ? 'available' : 'unavailable'}`}>
                    {cliStatus.codex ? 'Installed' : 'Not found'}
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-section">
              <span className="settings-label">API Key</span>
              <div className="api-form">
                <select
                  className="form-select"
                  value={apiProvider}
                  onChange={(e) => setApiProvider(e.target.value)}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
                <input
                  className="form-input"
                  type="password"
                  placeholder={config.apiKey ? 'Key saved — enter new to replace' : 'Paste API key'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveApiKey();
                  }}
                />
                <button className="save-btn" onClick={handleSaveApiKey} disabled={!apiKey.trim()}>
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
