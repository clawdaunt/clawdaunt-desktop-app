import React, { useState, useEffect, useRef } from 'react';
import { useChatEvents } from './hooks/useChatEvents';
import { useSessions } from './hooks/useSessions';
import { useChatSend } from './hooks/useChatSend';
import ChatView from './components/ChatView';
import SessionSidebar from './components/SessionSidebar';
import SettingsModal, { PROVIDERS } from './components/SettingsModal';

type Status = 'stopped' | 'starting' | 'running' | 'error';
type TunnelHealth = 'healthy' | 'checking' | 'down';

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
  openclawUpdate: OpenclawUpdateInfo | null;
  openclawUpdateStatus: 'idle' | 'updating' | 'done' | 'error';
  openclawUpdateError: string;
  onDismissUpdate: () => void;
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
  openclawUpdate,
  openclawUpdateStatus,
  openclawUpdateError,
  onDismissUpdate,
}: WorkspaceConsoleProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'workspaces' | 'sessions'>('sessions');
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  // --- Hooks ---

  const sessionsHook = useSessions(status);

  // useChatSend needs chatSessionKey from its own state, but useChatEvents needs it too.
  // We wire useChatEvents with the chatSessionKey from useChatSend.
  // To break the circular dep, useChatSend creates chatSessionKey state internally,
  // and useChatEvents receives it.

  // We need a temporary ref to hold chatSessionKey for useChatEvents since useChatSend
  // hasn't been created yet. Instead, we'll create a shared state here.
  const [chatSessionKeyShared, setChatSessionKeyShared] = useState<string | null>(null);

  const chatEvents = useChatEvents(chatSessionKeyShared);

  const chatSend = useChatSend({
    config,
    status,
    isStreaming: chatEvents.isStreaming,
    setIsStreaming: chatEvents.setIsStreaming,
    chatMessages: chatEvents.chatMessages,
    setChatMessages: chatEvents.setChatMessages,
    streamAccum: chatEvents.streamAccum,
    currentAssistantId: chatEvents.currentAssistantId,
    onConfigUpdate,
  });

  // Sync chatSessionKey from chatSend to the shared state used by chatEvents
  useEffect(() => {
    setChatSessionKeyShared(chatSend.chatSessionKey);
  }, [chatSend.chatSessionKey]);

  // CLI status for provider availability
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({ openclaw: false, claude: false, codex: false });
  useEffect(() => {
    window.api.detectCLIs().then(setCLIStatus);
  }, []);

  // Close provider menu on outside click
  useEffect(() => {
    if (!providerMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target as Node)) {
        setProviderMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [providerMenuOpen]);

  const handleSwitchProvider = async (aiSource: AISource, provider?: string) => {
    const newApiKey = aiSource === 'api-key' ? config.apiKey : undefined;
    onConfigUpdate(await window.api.setAISource(aiSource, newApiKey, provider));
    setProviderMenuOpen(false);
  };

  // Provider display
  const currentProviderId = config.aiSource === 'api-key' ? config.apiProvider : config.aiSource;
  const currentProvider = PROVIDERS.find(p => p.id === currentProviderId) || PROVIDERS[0];
  const hasNoProvider = !cliStatus.claude && !cliStatus.codex && !config.apiKey;

  const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? null;

  const connectionLabel = clientConnected
    ? clientAway ? 'Away' : 'Connected'
    : 'Phone Offline';
  const connectionClass = clientConnected
    ? clientAway ? 'away' : 'connected'
    : 'disconnected';

  // Wrap handleLoadPastSession to pass callbacks
  const handleLoadPastSession = (session: PersistentSession) => {
    sessionsHook.handleLoadPastSession(session, {
      setChatSessionKey: chatSend.setChatSessionKey,
      setViewingPastSession: chatSend.setViewingPastSession,
      setIsStreaming: chatEvents.setIsStreaming,
      clearStreaming: () => {
        chatEvents.streamAccum.current.clear();
        chatEvents.currentAssistantId.current = null;
      },
      setPendingImages: chatSend.setPendingImages,
      setPendingFiles: chatSend.setPendingFiles,
      setChatMessages: chatEvents.setChatMessages,
    });
  };

  const handleCreateWorkspace = async () => {
    onConfigUpdate(await window.api.createWorkspace());
  };

  return (
    <div className="app-shell">
      <div className="drag-region" />

      <SessionSidebar
        config={config}
        sessions={sessionsHook.sessions}
        pastSessions={sessionsHook.pastSessions}
        selectedSessions={sessionsHook.selectedSessions}
        batchDeleting={sessionsHook.batchDeleting}
        sessionContextMenu={sessionsHook.sessionContextMenu}
        setSessionContextMenu={sessionsHook.setSessionContextMenu}
        deletableSessions={sessionsHook.deletableSessions}
        chatSessionKey={chatSend.chatSessionKey}
        viewingPastSession={chatSend.viewingPastSession}
        connectionClass={connectionClass}
        connectionLabel={connectionLabel}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        sidebarTab={sidebarTab}
        setSidebarTab={setSidebarTab}
        onConfigUpdate={onConfigUpdate}
        onShowQR={onShowQR}
        onOpenSettings={() => setSettingsOpen(true)}
        onNewChat={chatSend.handleNewChat}
        onLoadPastSession={handleLoadPastSession}
        onDeletePastSession={sessionsHook.handleDeletePastSession}
        onBatchDeleteSessions={sessionsHook.handleBatchDeleteSessions}
        toggleSessionSelection={sessionsHook.toggleSessionSelection}
        toggleSelectAllSessions={sessionsHook.toggleSelectAllSessions}
        isMainSession={sessionsHook.isMainSession}
        reloadWorkspaceChat={chatSend.reloadWorkspaceChat}
      />

      {/* Main content */}
      <div className="main-content">
        {openclawUpdate && (
          <div className={`update-banner${openclawUpdateStatus === 'error' ? ' update-banner-error' : openclawUpdateStatus === 'done' ? ' update-banner-done' : ''}`}>
            <div className="update-banner-text">
              {openclawUpdateStatus === 'updating' ? (
                <>
                  <span className="update-spinner" />
                  Updating openclaw...
                </>
              ) : openclawUpdateStatus === 'done' ? (
                'openclaw updated successfully!'
              ) : openclawUpdateStatus === 'error' ? (
                <>Update failed: {openclawUpdateError}</>
              ) : (
                <>
                  System openclaw <strong>v{openclawUpdate.systemVersion}</strong> is outdated.
                  Using bundled <strong>v{openclawUpdate.bundledVersion}</strong>.
                </>
              )}
            </div>
            <div className="update-banner-actions">
              {openclawUpdateStatus === 'idle' && (
                <button className="update-btn" onClick={() => window.api.updateOpenclaw()}>
                  Update Now
                </button>
              )}
              {openclawUpdateStatus === 'error' && (
                <button className="update-btn" onClick={() => window.api.updateOpenclaw()}>
                  Retry
                </button>
              )}
              {openclawUpdateStatus !== 'updating' && (
                <button className="update-dismiss" onClick={onDismissUpdate}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
        <div className="main-header" style={!sidebarOpen ? { paddingLeft: 68 } : undefined}>
          <div className="main-header-left">
            {/* Provider picker */}
            <div className="provider-picker" ref={providerMenuRef}>
              <button
                className="provider-picker-btn"
                onClick={() => setProviderMenuOpen(!providerMenuOpen)}
              >
                <span className="provider-picker-label">{currentProvider.label}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {providerMenuOpen && (
                <div className="provider-menu">
                  <div className="provider-menu-group">
                    <span className="provider-menu-group-label">Local CLI</span>
                    {PROVIDERS.filter(p => p.aiSource !== 'api-key').map((p) => {
                      const available = p.id === 'claude-cli' ? cliStatus.claude : p.id === 'codex-cli' ? cliStatus.codex : false;
                      return (
                        <button
                          key={p.id}
                          className={`provider-menu-item${p.id === currentProviderId ? ' active' : ''}`}
                          onClick={() => {
                            if (available) handleSwitchProvider(p.aiSource, p.apiProvider);
                          }}
                          disabled={!available}
                        >
                          <div className="provider-menu-item-info">
                            <span className="provider-menu-item-label">{p.label}</span>
                            <span className="provider-menu-item-desc">{p.description}</span>
                          </div>
                          {p.id === currentProviderId && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                          {!available && (
                            <span className="provider-menu-item-badge">Not installed</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div className="provider-menu-divider" />
                  <div className="provider-menu-group">
                    <span className="provider-menu-group-label">API Providers</span>
                    {PROVIDERS.filter(p => p.aiSource === 'api-key').map((p) => {
                      const hasKey = !!(config.apiKey && config.apiProvider === p.apiProvider);
                      return (
                        <button
                          key={p.id}
                          className={`provider-menu-item${p.id === currentProviderId ? ' active' : ''}`}
                          onClick={() => {
                            if (hasKey) {
                              handleSwitchProvider(p.aiSource, p.apiProvider);
                            } else {
                              setSettingsOpen(true);
                              setProviderMenuOpen(false);
                            }
                          }}
                        >
                          <div className="provider-menu-item-info">
                            <span className="provider-menu-item-label">{p.label}</span>
                            <span className="provider-menu-item-desc">{p.description}</span>
                          </div>
                          {p.id === currentProviderId && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                          {!hasKey && (
                            <span className="provider-menu-item-badge setup">Add key</span>
                          )}
                          {hasKey && p.id !== currentProviderId && (
                            <span className="provider-menu-item-badge ready">Ready</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
          {chatEvents.chatMessages.length > 0 && (
            <button className="new-chat-btn" onClick={sidebarTab === 'workspaces' ? handleCreateWorkspace : chatSend.handleNewChat}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {sidebarTab === 'workspaces' ? 'New workspace' : 'New chat'}
            </button>
          )}
        </div>

        <div className="main-body">
          {errorMsg && <div className="error-banner">{errorMsg}</div>}

          <ChatView
            chatMessages={chatEvents.chatMessages}
            isStreaming={chatEvents.isStreaming}
            expandedTools={expandedTools}
            setExpandedTools={setExpandedTools}
            status={status}
            activeWs={activeWs}
            hasNoProvider={hasNoProvider}
            connectionClass={connectionClass}
            connectionLabel={connectionLabel}
            tunnelHealth={tunnelHealth}
            chatEndRef={chatEvents.chatEndRef}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {/* Chat input */}
          {activeWs && hasNoProvider && (
            <div className="chat-input-area">
              <div className="chat-no-provider-banner" onClick={() => setSettingsOpen(true)}>
                No AI provider configured — click here to open settings
              </div>
            </div>
          )}
          {activeWs && !hasNoProvider && (
            <div
              className={`chat-input-area${chatSend.isDragging ? ' dragging' : ''}`}
              onDragOver={chatSend.handleDragOver}
              onDragLeave={chatSend.handleDragLeave}
              onDrop={chatSend.handleDrop}
            >
              <input
                ref={chatSend.fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={chatSend.handleFileInputChange}
              />
              <div className="chat-input-container">
                {(chatSend.pendingImages.length > 0 || chatSend.pendingFiles.length > 0) && (
                  <div className="chat-attachment-chips">
                    {chatSend.pendingImages.map((img, i) => (
                      <div key={`img-${i}`} className="chat-attachment-chip">
                        <img className="chat-attachment-chip-thumb" src={img.dataUrl} alt={img.fileName} />
                        <span className="chat-attachment-chip-name">{img.fileName}</span>
                        <button className="chat-attachment-chip-remove" onClick={() => chatSend.removePendingImage(i)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    {chatSend.pendingFiles.map((file, i) => (
                      <div key={`file-${i}`} className="chat-attachment-chip chat-attachment-chip-file">
                        <svg className="chat-attachment-chip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span className="chat-attachment-chip-name">{file.relativePath}</span>
                        <button className="chat-attachment-chip-remove" onClick={() => chatSend.removePendingFile(i)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <textarea
                  ref={chatSend.chatInputRef}
                  className="chat-input"
                  value={chatSend.chatInput}
                  onChange={(e) => chatSend.setChatInput(e.target.value)}
                  onKeyDown={chatSend.handleKeyDown}
                  onPaste={chatSend.handlePaste}
                  placeholder="Reply..."
                  rows={1}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = 'auto';
                    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                  }}
                />

                <div className="chat-input-toolbar">
                  <button
                    className="chat-attach-btn"
                    onClick={chatSend.handleAddAttachment}
                    title="Add file or image"
                    disabled={chatEvents.isStreaming}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <div className="chat-input-toolbar-right">
                    {chatEvents.isStreaming ? (
                      <button className="chat-stop-btn" onClick={chatSend.handleAbort} title="Stop generating">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="6" width="12" height="12" rx="2" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        className="chat-send-btn"
                        onClick={chatSend.handleSendMessage}
                        disabled={status !== 'running' || (!chatSend.chatInput.trim() && chatSend.pendingImages.length === 0 && chatSend.pendingFiles.length === 0)}
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
              {chatSend.isDragging && (
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

      <SettingsModal
        settingsOpen={settingsOpen}
        config={config}
        onConfigUpdate={onConfigUpdate}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
