import React, { useState, useEffect, useRef } from 'react';
import { formatTimeAgo, formatElapsed } from '../utils';

interface ContextMenu {
  x: number;
  y: number;
  wsId: string;
}

interface SessionSidebarProps {
  config: Config;
  sessions: GatewaySession[];
  pastSessions: PersistentSession[];
  selectedSessions: Set<string>;
  batchDeleting: boolean;
  sessionContextMenu: { x: number; y: number; session: PersistentSession } | null;
  setSessionContextMenu: (menu: { x: number; y: number; session: PersistentSession } | null) => void;
  deletableSessions: PersistentSession[];
  chatSessionKey: string | null;
  viewingPastSession: boolean;
  connectionClass: string;
  connectionLabel: string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarTab: 'workspaces' | 'sessions';
  setSidebarTab: (tab: 'workspaces' | 'sessions') => void;
  onConfigUpdate: (config: Config) => void;
  onShowQR: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onLoadPastSession: (session: PersistentSession) => void;
  onDeletePastSession: (session: PersistentSession) => void;
  onBatchDeleteSessions: () => void;
  toggleSessionSelection: (id: string) => void;
  toggleSelectAllSessions: () => void;
  isMainSession: (s: PersistentSession) => boolean;
  reloadWorkspaceChat: () => void;
}

export default function SessionSidebar({
  config,
  sessions,
  pastSessions,
  selectedSessions,
  batchDeleting,
  sessionContextMenu,
  setSessionContextMenu,
  deletableSessions,
  chatSessionKey,
  viewingPastSession,
  connectionClass,
  connectionLabel,
  sidebarOpen,
  setSidebarOpen,
  sidebarTab,
  setSidebarTab,
  onConfigUpdate,
  onShowQR,
  onOpenSettings,
  onNewChat,
  onLoadPastSession,
  onDeletePastSession,
  onBatchDeleteSessions,
  toggleSessionSelection,
  toggleSelectAllSessions,
  isMainSession,
  reloadWorkspaceChat,
}: SessionSidebarProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

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

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, wsId });
  };

  const toggleWorkspaceExpand = (wsId: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

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

  return (
    <>
      {/* Floating sidebar toggle when collapsed */}
      {!sidebarOpen && (
        <button className="floating-toggle" onClick={() => setSidebarOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      )}

      <div className={`sidebar${sidebarOpen ? '' : ' collapsed'}`}>
        <div className="sidebar-top">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          {sidebarTab === 'workspaces' ? (
            <button className="new-workspace-btn" onClick={handleCreateWorkspace}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New workspace
            </button>
          ) : (
            <button className="new-workspace-btn" onClick={onNewChat}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New chat
            </button>
          )}
        </div>

        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab${sidebarTab === 'sessions' ? ' active' : ''}`}
            onClick={() => setSidebarTab('sessions')}
          >
            Past Chats
            {pastSessions.length > 0 && (
              <span className="sidebar-tab-badge">{pastSessions.length}</span>
            )}
          </button>
          <button
            className={`sidebar-tab${sidebarTab === 'workspaces' ? ' active' : ''}`}
            onClick={() => {
              setSidebarTab('workspaces');
              if (viewingPastSession) {
                reloadWorkspaceChat();
              }
            }}
          >
            Workspaces
          </button>
        </div>

        {sidebarTab === 'workspaces' ? (
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
        ) : (
        <div className="workspace-list">
          {pastSessions.length === 0 ? (
            <div className="sessions-empty">
              <span className="sessions-empty-text">No past sessions</span>
            </div>
          ) : (
            <>
              {deletableSessions.length > 0 && (
                <div className="sessions-batch-bar">
                  <label className="session-checkbox-label" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedSessions.size === deletableSessions.length && deletableSessions.length > 0}
                      onChange={toggleSelectAllSessions}
                    />
                    <span className="session-select-text">
                      {selectedSessions.size > 0 ? `${selectedSessions.size} selected` : 'Select all'}
                    </span>
                  </label>
                  {selectedSessions.size > 0 && (
                    <button
                      className="sessions-batch-delete-btn"
                      onClick={onBatchDeleteSessions}
                      disabled={batchDeleting}
                    >
                      {batchDeleting ? 'Deleting...' : `Delete (${selectedSessions.size})`}
                    </button>
                  )}
                </div>
              )}
              {[...pastSessions].sort((a, b) => isMainSession(a) ? -1 : isMainSession(b) ? 1 : 0).map((s) => (
                <div
                  key={s.id}
                  className={`ws-session-item past-session${chatSessionKey === s.id ? ' active' : ''}${selectedSessions.has(s.id) ? ' selected' : ''}`}
                  onClick={() => onLoadPastSession(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSessionContextMenu({ x: e.clientX, y: e.clientY, session: s });
                  }}
                  title={s.title}
                >
                  <input
                    type="checkbox"
                    className="session-checkbox"
                    checked={selectedSessions.has(s.id)}
                    onChange={() => toggleSessionSelection(s.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="ws-session-dot idle" />
                  <span className="ws-session-title">{isMainSession(s) ? 'Main Session' : s.title}</span>
                  <span className="ws-session-time">{formatTimeAgo(s.updatedAt)}</span>
                </div>
              ))}
            </>
          )}
        </div>
        )}

        <div className="sidebar-bottom">
          <div className="sidebar-bottom-left">
            <button className="sidebar-icon-btn" onClick={onOpenSettings} title="Settings">
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

      {/* Workspace context menu */}
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

      {/* Session context menu */}
      {sessionContextMenu && (
        <div
          className="context-menu"
          style={{ top: sessionContextMenu.y, left: sessionContextMenu.x }}
          onClick={() => setSessionContextMenu(null)}
        >
          <div className="context-menu-item" onClick={() => onLoadPastSession(sessionContextMenu.session)}>
            Open
          </div>
          <div className="context-menu-item danger" onClick={() => onDeletePastSession(sessionContextMenu.session)}>
            {isMainSession(sessionContextMenu.session) ? 'Clear History' : 'Delete'}
          </div>
          {selectedSessions.size > 1 && (
            <div className="context-menu-item danger" onClick={onBatchDeleteSessions}>
              Delete Selected ({selectedSessions.size})
            </div>
          )}
        </div>
      )}
    </>
  );
}
