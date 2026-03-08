import React, { useState, useEffect, useRef, useCallback } from 'react';

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
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSessionKey, setChatSessionKey] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamAccum = useRef<Map<string, string>>(new Map());
  const currentAssistantId = useRef<string | null>(null);

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
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  // Chat event handling
  const handleChatEvent = useCallback((event: ChatEvent) => {
    const { type, payload } = event;
    const sid = (payload.session_id || payload.sessionId || '') as string;

    if (chatSessionKey && sid && sid !== chatSessionKey) return;

    if (type === 'session.status') {
      const status = payload.status as string;
      if (status === 'busy') {
        setIsStreaming(true);
      } else if (status === 'idle') {
        setIsStreaming(false);
        streamAccum.current.clear();
        currentAssistantId.current = null;
      }
    } else if (type === 'session.idle' || type === 'session.ended') {
      setIsStreaming(false);
      streamAccum.current.clear();
      currentAssistantId.current = null;
    } else if (type === 'session.error') {
      setIsStreaming(false);
      streamAccum.current.clear();
      const errorText = (payload.error as string) || 'An error occurred';
      if (currentAssistantId.current) {
        setChatMessages(prev => prev.map(m =>
          m.id === currentAssistantId.current
            ? { ...m, content: m.content + `\n\n_Error: ${errorText}_` }
            : m
        ));
      }
      currentAssistantId.current = null;
    } else if (type === 'message.part.updated') {
      const part = payload.part as Record<string, unknown> | undefined;
      const delta = payload.delta as string | undefined;
      if (!part || part.type !== 'text') return;

      const partId = part.id as string;
      if (delta) {
        const existing = streamAccum.current.get(partId) || '';
        const newText = existing + delta;
        streamAccum.current.set(partId, newText);

        if (currentAssistantId.current) {
          setChatMessages(prev => prev.map(m =>
            m.id === currentAssistantId.current ? { ...m, content: newText } : m
          ));
        }
      } else if (part.text) {
        const text = part.text as string;
        streamAccum.current.set(partId, text);
        if (currentAssistantId.current) {
          setChatMessages(prev => prev.map(m =>
            m.id === currentAssistantId.current ? { ...m, content: text } : m
          ));
        }
      }
    }
  }, [chatSessionKey]);

  useEffect(() => {
    window.api.onChatEvent(handleChatEvent);
    return () => { window.api.offChatEvent(); };
  }, [handleChatEvent]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Reset chat when active workspace changes
  useEffect(() => {
    setChatMessages([]);
    setChatSessionKey(null);
    setChatInput('');
    setPendingImages([]);
    setIsStreaming(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;
  }, [config.activeWorkspaceId]);

  const generateId = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 16; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  };

  const handleSendMessage = async () => {
    const text = chatInput.trim();
    const images = [...pendingImages];
    if ((!text && images.length === 0) || isStreaming) return;

    let sessionKey = chatSessionKey;
    if (!sessionKey) {
      sessionKey = `desktop:${generateId()}`;
      setChatSessionKey(sessionKey);
    }

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      images: images.map(img => img.dataUrl),
      timestamp: Date.now(),
    };

    const assistantId = generateId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    currentAssistantId.current = assistantId;
    setChatMessages(prev => [...prev, userMsg, assistantMsg]);
    setChatInput('');
    setPendingImages([]);
    setIsStreaming(true);

    await window.api.sendChatMessage(
      sessionKey,
      text || '(image attached)',
      images.length > 0 ? images : undefined,
    );
  };

  const handleAbort = async () => {
    if (chatSessionKey) {
      await window.api.abortChat(chatSessionKey);
      setIsStreaming(false);
    }
  };

  const handleNewChat = () => {
    setChatMessages([]);
    setChatSessionKey(null);
    setChatInput('');
    setPendingImages([]);
    setIsStreaming(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;
    chatInputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handlePickImage = () => {
    fileInputRef.current?.click();
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        setPendingImages(prev => [...prev, {
          type: 'image',
          mimeType: file.type,
          fileName: file.name,
          content: base64,
          dataUrl,
        }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removePendingImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        setPendingImages(prev => [...prev, {
          type: 'image',
          mimeType: file.type,
          fileName: file.name,
          content: base64,
          dataUrl,
        }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        setPendingImages(prev => [...prev, {
          type: 'image',
          mimeType: file.type,
          fileName: `pasted-image.${file.type.split('/')[1]}`,
          content: base64,
          dataUrl,
        }]);
      };
      reader.readAsDataURL(file);
    }
  };

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
        <div className="main-header" style={!sidebarOpen ? { paddingLeft: 68 } : undefined}>
          <div>
            {activeWs ? (
              <span className="main-title">{activeWs.name}</span>
            ) : (
              <span className="main-title" style={{ color: 'var(--text-tertiary)' }}>No workspace selected</span>
            )}
          </div>
          {chatMessages.length > 0 && (
            <button className="new-chat-btn" onClick={handleNewChat}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New chat
            </button>
          )}
        </div>

        <div className="main-body">
          {errorMsg && <div className="error-banner">{errorMsg}</div>}

          {!activeWs ? (
            <div className="welcome-state">
              <div className="welcome-logo">clawdaunt<span>.</span></div>
              <p className="welcome-text">
                Select a workspace from the sidebar to get started.
              </p>
            </div>
          ) : chatMessages.length === 0 ? (
            <div className="chat-empty-state">
              <div className="welcome-logo">clawdaunt<span>.</span></div>
              <p className="welcome-text">
                What can I help you with?
              </p>
              <div className="welcome-status">
                <span className={`connection-dot ${connectionClass}`} />
                {connectionLabel}
                {tunnelHealth === 'healthy' && ' — Tunnel active'}
                {tunnelHealth === 'checking' && ' — Connecting...'}
              </div>
            </div>
          ) : (
            <div className="chat-messages">
              {chatMessages.map((msg) => (
                <div key={msg.id} className={`chat-msg chat-msg-${msg.role}`}>
                  <div className="chat-msg-avatar">
                    {msg.role === 'user' ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2L2 7l10 5 10-5-10-5z" />
                        <path d="M2 17l10 5 10-5" />
                        <path d="M2 12l10 5 10-5" />
                      </svg>
                    )}
                  </div>
                  <div className="chat-msg-body">
                    <span className="chat-msg-role">{msg.role === 'user' ? 'You' : 'Clawdaunt'}</span>
                    {msg.images && msg.images.length > 0 && (
                      <div className="chat-msg-images">
                        {msg.images.map((src, i) => (
                          <img key={i} src={src} className="chat-msg-image" alt="" />
                        ))}
                      </div>
                    )}
                    <div className="chat-msg-content">
                      {msg.content || (msg.role === 'assistant' && isStreaming ? (
                        <span className="chat-typing-indicator">
                          <span /><span /><span />
                        </span>
                      ) : null)}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Chat input */}
          {activeWs && (
            <div
              className={`chat-input-area${isDragging ? ' dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileInput}
              />
              <div className="chat-input-container">
                {/* Attachment chips inside the container */}
                {pendingImages.length > 0 && (
                  <div className="chat-attachment-chips">
                    {pendingImages.map((img, i) => (
                      <div key={i} className="chat-attachment-chip">
                        <img className="chat-attachment-chip-thumb" src={img.dataUrl} alt={img.fileName} />
                        <span className="chat-attachment-chip-name">{img.fileName}</span>
                        <button className="chat-attachment-chip-remove" onClick={() => removePendingImage(i)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Textarea */}
                <textarea
                  ref={chatInputRef}
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={pendingImages.length > 0 ? 'Reply...' : 'Reply...'}
                  rows={1}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                  }}
                />

                {/* Bottom toolbar: + button on left, send on right */}
                <div className="chat-input-toolbar">
                  <button
                    className="chat-attach-btn"
                    onClick={handlePickImage}
                    title="Attach image"
                    disabled={isStreaming}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <div className="chat-input-toolbar-right">
                    {isStreaming ? (
                      <button className="chat-stop-btn" onClick={handleAbort} title="Stop generating">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="chat-send-btn"
                        onClick={handleSendMessage}
                        disabled={!chatInput.trim() && pendingImages.length === 0}
                        title="Send message"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="19" x2="12" y2="5" />
                          <polyline points="5 12 12 5 19 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {isDragging && (
                <div className="chat-drop-overlay">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  Drop image here
                </div>
              )}
            </div>
          )}
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
                  <option value="minimax">MiniMax</option>
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
