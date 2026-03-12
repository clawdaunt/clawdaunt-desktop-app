import React from 'react';
import { getToolSummary, formatToolArgs } from '../utils';

type Status = 'stopped' | 'starting' | 'running' | 'error';
type TunnelHealth = 'healthy' | 'checking' | 'down';

interface ChatViewProps {
  chatMessages: ChatMessage[];
  isStreaming: boolean;
  expandedTools: Set<string>;
  setExpandedTools: React.Dispatch<React.SetStateAction<Set<string>>>;
  status: Status;
  activeWs: Workspace | null;
  hasNoProvider: boolean;
  connectionClass: string;
  connectionLabel: string;
  tunnelHealth: TunnelHealth;
  chatEndRef: React.RefObject<HTMLDivElement>;
  onOpenSettings: () => void;
}

export default function ChatView({
  chatMessages,
  isStreaming,
  expandedTools,
  setExpandedTools,
  status,
  activeWs,
  hasNoProvider,
  connectionClass,
  connectionLabel,
  tunnelHealth,
  chatEndRef,
  onOpenSettings,
}: ChatViewProps) {
  if (!activeWs) {
    return (
      <div className="welcome-state">
        <div className="welcome-logo">clawdaunt<span>.</span></div>
        <p className="welcome-text">
          Select a workspace from the sidebar to get started.
        </p>
      </div>
    );
  }

  if (chatMessages.length === 0) {
    return (
      <div className="chat-empty-state">
        {status === 'starting' ? (
          <div className="spawning-indicator">
            <div className="spinner" />
            <p className="spawning-text">AI spawning...</p>
          </div>
        ) : status !== 'running' ? (
          <div className="spawning-indicator">
            <div className="spinner" />
            <p className="spawning-text">AI spawning...</p>
          </div>
        ) : (
          <>
            <div className="welcome-logo">clawdaunt<span>.</span></div>
            {hasNoProvider ? (
              <>
                <p className="welcome-text" style={{ color: 'var(--accent)' }}>
                  Set up at least one AI provider in settings to continue.
                </p>
                <button className="setup-provider-btn" onClick={onOpenSettings}>
                  Open Settings
                </button>
              </>
            ) : (
              <>
                <p className="welcome-text">
                  What can I help you with?
                </p>
                <div className="welcome-status">
                  <span className={`connection-dot ${connectionClass}`} />
                  {connectionLabel}
                  {tunnelHealth === 'healthy' && ' — Tunnel active'}
                  {tunnelHealth === 'checking' && ' — Connecting...'}
                </div>
              </>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="chat-messages">
      {chatMessages.map((msg, idx) => (
        <div key={`${msg.id}-${idx}`} className={`chat-msg chat-msg-${msg.role}`}>
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
            <span className="chat-msg-role">{msg.role === 'user' ? 'You' : 'AI'}</span>
            {msg.images && msg.images.length > 0 && (
              <div className="chat-msg-images">
                {msg.images.map((src, i) => (
                  <img key={i} src={src} className="chat-msg-image" alt="" />
                ))}
              </div>
            )}
            {msg.files && msg.files.length > 0 && (
              <div className="chat-msg-files">
                {msg.files.map((file, i) => (
                  <div key={i} className="chat-msg-file-chip">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span>{file.relativePath}</span>
                  </div>
                ))}
              </div>
            )}
            {msg.toolEvents && msg.toolEvents.length > 0 && (
              <div className="tool-events">
                {msg.toolEvents.map((tool) => {
                  const isExpanded = expandedTools.has(tool.id);
                  const summary = getToolSummary(tool);
                  return (
                    <div key={tool.id} className={`tool-block tool-${tool.status}`}>
                      <button
                        className="tool-header"
                        onClick={() => setExpandedTools(prev => {
                          const next = new Set(prev);
                          if (next.has(tool.id)) next.delete(tool.id);
                          else next.add(tool.id);
                          return next;
                        })}
                      >
                        <span className="tool-status-icon">
                          {tool.status === 'running' ? (
                            <svg className="tool-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                            </svg>
                          ) : tool.status === 'error' ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="15" y1="9" x2="9" y2="15" />
                              <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </span>
                        <span className="tool-name">{tool.toolName}</span>
                        <span className="tool-summary">{summary}</span>
                        <svg className={`tool-chevron${isExpanded ? ' expanded' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                      {isExpanded && (
                        <div className="tool-details">
                          {tool.args && Object.keys(tool.args).length > 0 && (
                            <pre className="tool-args">{formatToolArgs(tool)}</pre>
                          )}
                          {tool.result && (
                            <pre className="tool-result">{tool.result.length > 2000 ? tool.result.slice(0, 2000) + '...' : tool.result}</pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="chat-msg-content">
              {(msg.content && msg.content.trim()) || (msg.role === 'assistant' && isStreaming ? (
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
  );
}
