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
  const [pastSessions, setPastSessions] = useState<PersistentSession[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<'workspaces' | 'sessions'>('sessions');
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number; session: PersistentSession } | null>(null);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSessionKey, setChatSessionKey] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [viewingPastSession, setViewingPastSession] = useState(false);
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<FileReference[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamAccum = useRef<Map<string, string>>(new Map());
  const currentAssistantId = useRef<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // Settings modal state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [apiProvider, setApiProvider] = useState(config.apiProvider || 'anthropic');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({ openclaw: false, claude: false, codex: false });
  const [keySaved, setKeySaved] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.detectCLIs().then(setCLIStatus);
  }, []);

  useEffect(() => {
    window.api.listSessions().then(setSessions);
    window.api.onSessionsUpdated(setSessions);
  }, []);

  // Poll persistent past sessions from gateway
  const refreshPastSessions = useCallback(() => {
    window.api.listPersistentSessions().then(setPastSessions).catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== 'running') { setPastSessions([]); return; }
    refreshPastSessions();
    const interval = setInterval(refreshPastSessions, 5000);
    return () => clearInterval(interval);
  }, [status, refreshPastSessions]);

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

  useEffect(() => {
    if (!sessionContextMenu) return;
    const handler = () => setSessionContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [sessionContextMenu]);

  // Chat event handling
  const handleChatEvent = useCallback((event: ChatEvent) => {
    const { type, payload } = event;
    const sid = (payload.session_id || payload.sessionId || '') as string;

    console.log('[chatEvent]', type, 'sid:', sid, 'chatSessionKey:', chatSessionKey);
    if (chatSessionKey && sid && sid !== chatSessionKey) {
      console.log('[chatEvent] SKIPPED — session mismatch');
      return;
    }

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
      const wasStreaming = currentAssistantId.current !== null;
      const hadStreamedContent = streamAccum.current.size > 0;
      setIsStreaming(false);
      streamAccum.current.clear();
      currentAssistantId.current = null;
      // Only reload history if we didn't get content via SSE streaming
      // (CLI-backed agents don't stream via SSE, so we need to reload for those)
      if (wasStreaming && chatSessionKey && !hadStreamedContent) {
        window.api.loadSessionHistory(chatSessionKey)
          .then(history => setChatMessages(history))
          .catch(() => {});
      }
    } else if (type === 'session.error' || type === 'error') {
      const errorText = (payload.error as string) || 'An error occurred';
      console.log('[chatEvent] error detail:', errorText);
      // Don't clear streaming state or assistant ID — SSE content may still arrive
      if (currentAssistantId.current) {
        setChatMessages(prev => prev.map(m =>
          m.id === currentAssistantId.current
            ? { ...m, content: m.content + `\n\n_Error: ${errorText}_` }
            : m
        ));
      }
    } else if (type === 'tool.start' || type === 'agent.tool') {
      const data = (payload.data || payload) as Record<string, unknown>;
      const toolName = (data.tool || data.toolName || data.name || 'Tool') as string;
      const toolId = (data.toolUseId || data.id || data.runId || `tool-${Date.now()}`) as string;
      const args = (data.args || data.input || data.params || {}) as Record<string, unknown>;
      const newTool: ToolEvent = {
        id: toolId,
        toolName,
        args,
        status: 'running',
        startedAt: Date.now(),
      };
      setChatMessages(prev => {
        const targetId = currentAssistantId.current;
        if (!targetId) return prev;
        return prev.map(m => {
          if (m.id !== targetId) return m;
          const existing = m.toolEvents || [];
          if (existing.some(t => t.id === toolId)) return m;
          return { ...m, toolEvents: [...existing, newTool] };
        });
      });
    } else if (type === 'tool.result') {
      const data = (payload.data || payload) as Record<string, unknown>;
      const toolId = (data.toolUseId || data.id || data.runId || '') as string;
      const result = (data.result || data.output || data.text || '') as string;
      const isError = !!(data.is_error || data.isError || data.error);
      setChatMessages(prev => {
        const targetId = currentAssistantId.current;
        if (!targetId) return prev;
        return prev.map(m => {
          if (m.id !== targetId) return m;
          const tools = m.toolEvents || [];
          const updated = tools.map(t =>
            t.id === toolId
              ? { ...t, result: typeof result === 'string' ? result : JSON.stringify(result), status: (isError ? 'error' : 'done') as ToolEvent['status'] }
              : t
          );
          return { ...m, toolEvents: updated };
        });
      });
    } else if (type === 'message.part.updated') {
      const part = payload.part as Record<string, unknown> | undefined;
      const delta = payload.delta as string | undefined;
      if (!part || part.type !== 'text') return;

      const partId = part.id as string;
      if (delta) {
        const existing = streamAccum.current.get(partId) || '';
        const newText = existing + delta;
        streamAccum.current.set(partId, newText);

        setChatMessages(prev => {
          const targetId = currentAssistantId.current;
          if (targetId) {
            return prev.map(m => m.id === targetId ? { ...m, content: newText } : m);
          }
          // Fallback: update the last assistant message
          const lastIdx = prev.findLastIndex(m => m.role === 'assistant');
          if (lastIdx >= 0) {
            return prev.map((m, i) => i === lastIdx ? { ...m, content: newText } : m);
          }
          return prev;
        });
      } else if (part.text) {
        const text = part.text as string;
        streamAccum.current.set(partId, text);
        setChatMessages(prev => {
          const targetId = currentAssistantId.current;
          if (targetId) {
            return prev.map(m => m.id === targetId ? { ...m, content: text } : m);
          }
          const lastIdx = prev.findLastIndex(m => m.role === 'assistant');
          if (lastIdx >= 0) {
            return prev.map((m, i) => i === lastIdx ? { ...m, content: text } : m);
          }
          return prev;
        });
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

  // Reload workspace chat from gateway JSONL
  const reloadWorkspaceChat = useCallback(() => {
    const ws = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    setChatInput('');
    setPendingImages([]);
    setPendingFiles([]);
    setViewingPastSession(false);
    setIsStreaming(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;
    if (ws?.openclawSessionKey) {
      setChatSessionKey(ws.openclawSessionKey);
      window.api.loadSessionHistory(ws.openclawSessionKey)
        .then(history => setChatMessages(history))
        .catch(() => setChatMessages([]));
    } else {
      setChatMessages([]);
      setChatSessionKey(null);
    }
  }, [config.workspaces, config.activeWorkspaceId]);

  // Load workspace chat when active workspace changes
  useEffect(() => {
    const ws = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    setChatInput('');
    setPendingImages([]);
    setPendingFiles([]);
    setViewingPastSession(false);
    setIsStreaming(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;

    if (!ws?.openclawSessionKey) {
      setChatMessages([]);
      setChatSessionKey(null);
      return;
    }
    // Restore the session key so new messages continue the same session
    setChatSessionKey(ws.openclawSessionKey);
    // Load history from disk
    window.api.loadSessionHistory(ws.openclawSessionKey)
      .then(history => setChatMessages(history))
      .catch(() => setChatMessages([]));
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
    const files = [...pendingFiles];
    console.log('[handleSendMessage] text:', text, 'isStreaming:', isStreaming, 'chatSessionKey:', chatSessionKey);
    if ((!text && images.length === 0 && files.length === 0) || isStreaming || status !== 'running') return;

    let sessionKey = chatSessionKey;
    if (!sessionKey) {
      sessionKey = `desktop:${generateId()}`;
      setChatSessionKey(sessionKey);
      // Persist session key on the active workspace
      if (config.activeWorkspaceId) {
        window.api.setWorkspaceSessionKey(config.activeWorkspaceId, sessionKey).then(onConfigUpdate);
      }
    }
    console.log('[handleSendMessage] sending with sessionKey:', sessionKey);

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      images: images.map(img => img.dataUrl),
      files: files.length > 0 ? files : undefined,
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
    setPendingFiles([]);
    setIsStreaming(true);

    const filePaths = files.map(f => f.path).filter(Boolean);
    await window.api.sendChatMessage(
      sessionKey,
      text || (images.length > 0 ? '(image attached)' : '(files attached)'),
      images.length > 0 ? images : [],
      filePaths.length > 0 ? filePaths : [],
    );
  };

  const handleAbort = async () => {
    if (chatSessionKey) {
      try {
        await window.api.abortChat(chatSessionKey);
      } catch {
        // Abort may fail if gateway disconnected
      }
      setIsStreaming(false);
      streamAccum.current.clear();
      currentAssistantId.current = null;
    }
  };

  const handleNewChat = () => {
    setChatMessages([]);
    setChatSessionKey(null);
    setChatInput('');
    setPendingImages([]);
    setPendingFiles([]);
    setIsStreaming(false);
    setViewingPastSession(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;
    chatInputRef.current?.focus();
  };

  const handleLoadPastSession = async (session: PersistentSession) => {
    setChatSessionKey(session.id);
    setViewingPastSession(true);
    setIsStreaming(false);
    streamAccum.current.clear();
    currentAssistantId.current = null;
    setPendingImages([]);
    setPendingFiles([]);
    setChatMessages([]);
    try {
      const history = await window.api.loadSessionHistory(session.id);
      setChatMessages(history);
    } catch { /* ignore */ }
  };

  const isMainSession = (s: PersistentSession) => s.gatewayKey === 'agent:main:main';

  const handleDeletePastSession = async (session: PersistentSession) => {
    if (isMainSession(session)) return;
    try {
      await window.api.deleteSession(session.gatewayKey);
      setSelectedSessions(prev => { const next = new Set(prev); next.delete(session.id); return next; });
      refreshPastSessions();
    } catch { /* ignore */ }
    setSessionContextMenu(null);
  };

  const handleBatchDeleteSessions = async () => {
    if (selectedSessions.size === 0) return;
    setBatchDeleting(true);
    const toDelete = pastSessions.filter(s => selectedSessions.has(s.id) && !isMainSession(s));
    await Promise.allSettled(toDelete.map(s => window.api.deleteSession(s.gatewayKey)));
    setSelectedSessions(new Set());
    setBatchDeleting(false);
    refreshPastSessions();
  };

  const toggleSessionSelection = (id: string) => {
    const sess = pastSessions.find(s => s.id === id);
    if (sess && isMainSession(sess)) return;
    setSelectedSessions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deletableSessions = pastSessions.filter(s => !isMainSession(s));

  const toggleSelectAllSessions = () => {
    if (selectedSessions.size === deletableSessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(deletableSessions.map(s => s.id)));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleAddAttachment = async () => {
    // Use pickFile IPC to get absolute paths (File.path unavailable with contextIsolation)
    const refs = await window.api.pickFile();
    if (!refs) return;
    refs.forEach(ref => {
      if (ref.imageData) {
        setPendingImages(prev => [...prev, {
          type: 'image',
          mimeType: ref.imageData!.mimeType,
          fileName: ref.fileName,
          content: ref.imageData!.content,
          dataUrl: ref.imageData!.dataUrl,
        }]);
      } else {
        setPendingFiles(prev => {
          if (prev.some(f => f.path === ref.path)) return prev;
          return [...prev, ref];
        });
      }
    });
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // File input kept for image paste/drag — non-images should use handleAddAttachment
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

  const removePendingFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
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
    // Save the key without switching away from the current provider (e.g. claude-cli)
    onConfigUpdate(await window.api.setAISource(config.aiSource, apiKey.trim(), apiProvider));
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  useEffect(() => {
    const provider = config.apiProvider || 'anthropic';
    setApiProvider(provider);
    setApiKey(config.apiKeys?.[provider] || config.apiKey || '');
  }, [config.apiKey, config.apiProvider, config.apiKeys]);

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, wsId });
  };

  const formatTimeAgo = (unixSecs: number) => {
    const secs = Math.floor(Date.now() / 1000 - unixSecs);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
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

  // Provider display info
  const PROVIDERS: { id: string; aiSource: AISource; apiProvider?: string; label: string; description: string; available: boolean }[] = [
    { id: 'claude-cli', aiSource: 'claude-cli', label: 'Claude Code', description: 'Via Claude CLI', available: cliStatus.claude },
    { id: 'codex-cli', aiSource: 'codex-cli', label: 'Codex', description: 'Via Codex CLI', available: cliStatus.codex },
    { id: 'anthropic', aiSource: 'api-key', apiProvider: 'anthropic', label: 'Anthropic API', description: 'Claude Opus 4', available: !!(config.apiKeys?.['anthropic'] || (config.apiKey && config.apiProvider === 'anthropic')) },
    { id: 'anthropic-sonnet-4-5', aiSource: 'api-key', apiProvider: 'anthropic-sonnet-4-5', label: 'Anthropic API', description: 'Claude Sonnet 4.5', available: !!(config.apiKeys?.['anthropic-sonnet-4-5'] || config.apiKeys?.['anthropic'] || (config.apiKey && (config.apiProvider === 'anthropic-sonnet-4-5' || config.apiProvider === 'anthropic'))) },
    { id: 'openai', aiSource: 'api-key', apiProvider: 'openai', label: 'OpenAI API', description: 'GPT-4o', available: !!(config.apiKeys?.['openai'] || (config.apiKey && config.apiProvider === 'openai')) },
    { id: 'minimax', aiSource: 'api-key', apiProvider: 'minimax', label: 'MiniMax API', description: 'MiniMax M2.5', available: !!(config.apiKeys?.['minimax'] || (config.apiKey && config.apiProvider === 'minimax')) },
    { id: 'gemini', aiSource: 'api-key', apiProvider: 'gemini', label: 'Gemini API', description: 'Gemini 2.5 Pro', available: !!(config.apiKeys?.['gemini'] || (config.apiKey && config.apiProvider === 'gemini')) },
    { id: 'gemini-flash', aiSource: 'api-key', apiProvider: 'gemini-flash', label: 'Gemini Flash', description: 'Gemini 2.5 Flash', available: !!(config.apiKeys?.['gemini-flash'] || config.apiKeys?.['gemini'] || (config.apiKey && (config.apiProvider === 'gemini-flash' || config.apiProvider === 'gemini'))) },
  ];

  const currentProviderId = config.aiSource === 'api-key' ? config.apiProvider : config.aiSource;
  const currentProvider = PROVIDERS.find(p => p.id === currentProviderId) || PROVIDERS[0];

  // True when no CLI is installed and no API key is configured
  const hasNoProvider = !cliStatus.claude && !cliStatus.codex && !config.apiKey;

  const getToolSummary = (tool: ToolEvent): string => {
    if (!tool.args) return '';
    const a = tool.args;
    const name = tool.toolName.toLowerCase();
    if (name === 'read' || name === 'readfile') {
      return (a.file_path || a.path || '') as string;
    }
    if (name === 'write' || name === 'writefile') {
      return (a.file_path || a.path || '') as string;
    }
    if (name === 'edit') {
      return (a.file_path || a.path || '') as string;
    }
    if (name === 'bash' || name === 'execute' || name === 'shell') {
      const cmd = (a.command || a.cmd || '') as string;
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (name === 'grep' || name === 'search') {
      return `"${a.pattern || a.query || ''}"`;
    }
    if (name === 'glob') {
      return (a.pattern || '') as string;
    }
    if (name === 'agent') {
      return (a.description || '') as string;
    }
    // Generic: show first string arg
    for (const v of Object.values(a)) {
      if (typeof v === 'string' && v.length > 0) {
        return v.length > 60 ? v.slice(0, 60) + '...' : v;
      }
    }
    return '';
  };

  const formatToolArgs = (tool: ToolEvent): string => {
    if (!tool.args) return '';
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args);
    }
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
          {sidebarTab === 'workspaces' ? (
            <button className="new-workspace-btn" onClick={handleCreateWorkspace}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New workspace
            </button>
          ) : (
            <button className="new-workspace-btn" onClick={handleNewChat}>
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
                      onClick={handleBatchDeleteSessions}
                      disabled={batchDeleting}
                    >
                      {batchDeleting ? 'Deleting...' : `Delete (${selectedSessions.size})`}
                    </button>
                  )}
                </div>
              )}
              {pastSessions.map((s) => (
                <div
                  key={s.id}
                  className={`ws-session-item past-session${chatSessionKey === s.id ? ' active' : ''}${selectedSessions.has(s.id) ? ' selected' : ''}`}
                  onClick={() => handleLoadPastSession(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSessionContextMenu({ x: e.clientX, y: e.clientY, session: s });
                  }}
                  title={s.title}
                >
                  {isMainSession(s) ? (
                    <span className="ws-session-dot active" />
                  ) : (
                    <input
                      type="checkbox"
                      className="session-checkbox"
                      checked={selectedSessions.has(s.id)}
                      onChange={() => toggleSessionSelection(s.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
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
                    {PROVIDERS.filter(p => p.aiSource !== 'api-key').map((p) => (
                      <button
                        key={p.id}
                        className={`provider-menu-item${p.id === currentProviderId ? ' active' : ''}`}
                        onClick={() => {
                          if (p.available) handleSwitchProvider(p.aiSource, p.apiProvider);
                        }}
                        disabled={!p.available}
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
                        {!p.available && (
                          <span className="provider-menu-item-badge">Not installed</span>
                        )}
                      </button>
                    ))}
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
                              setApiProvider(p.apiProvider || 'anthropic');
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
          {chatMessages.length > 0 && (
            <button className="new-chat-btn" onClick={sidebarTab === 'workspaces' ? handleCreateWorkspace : handleNewChat}>
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

          {!activeWs ? (
            <div className="welcome-state">
              <div className="welcome-logo">clawdaunt<span>.</span></div>
              <p className="welcome-text">
                Select a workspace from the sidebar to get started.
              </p>
            </div>
          ) : chatMessages.length === 0 ? (
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
                      <button className="setup-provider-btn" onClick={() => setSettingsOpen(true)}>
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
          ) : (
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
          )}

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
              className={`chat-input-area${isDragging ? ' dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
              />
              <div className="chat-input-container">
                {(pendingImages.length > 0 || pendingFiles.length > 0) && (
                  <div className="chat-attachment-chips">
                    {pendingImages.map((img, i) => (
                      <div key={`img-${i}`} className="chat-attachment-chip">
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
                    {pendingFiles.map((file, i) => (
                      <div key={`file-${i}`} className="chat-attachment-chip chat-attachment-chip-file">
                        <svg className="chat-attachment-chip-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span className="chat-attachment-chip-name">{file.relativePath}</span>
                        <button className="chat-attachment-chip-remove" onClick={() => removePendingFile(i)}>
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
                  ref={chatInputRef}
                  className="chat-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
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
                    onClick={handleAddAttachment}
                    title="Add file or image"
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
                        disabled={status !== 'running' || (!chatInput.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
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

      {/* Session context menu */}
      {sessionContextMenu && (
        <div
          className="context-menu"
          style={{ top: sessionContextMenu.y, left: sessionContextMenu.x }}
          onClick={() => setSessionContextMenu(null)}
        >
          <div className="context-menu-item" onClick={() => handleLoadPastSession(sessionContextMenu.session)}>
            Open
          </div>
          {!isMainSession(sessionContextMenu.session) && (
            <div className="context-menu-item danger" onClick={() => handleDeletePastSession(sessionContextMenu.session)}>
              Delete
            </div>
          )}
          {selectedSessions.size > 1 && (
            <div className="context-menu-item danger" onClick={handleBatchDeleteSessions}>
              Delete Selected ({selectedSessions.size})
            </div>
          )}
        </div>
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setSettingsOpen(false)}>×</button>
            <h2 className="modal-title">Settings</h2>

            <div className="settings-section">
              <span className="settings-label">AI Provider</span>
              {!cliStatus.openclaw && (
                <p className="cli-warning">openclaw CLI not found — install it to enable full functionality</p>
              )}

              {/* CLI options */}
              <div className="provider-options">
                <button
                  className={`provider-option${config.aiSource === 'claude-cli' ? ' active' : ''}`}
                  onClick={() => cliStatus.claude && handleSwitchProvider('claude-cli')}
                  disabled={!cliStatus.claude}
                >
                  <span className={`provider-option-radio${config.aiSource === 'claude-cli' ? ' selected' : ''}`} />
                  <div className="provider-option-info">
                    <span className="provider-option-name">Claude Code</span>
                    <span className="provider-option-detail">Uses your Claude CLI login</span>
                  </div>
                  {!cliStatus.claude && <span className="provider-menu-item-badge">Not installed</span>}
                </button>
                <button
                  className={`provider-option${config.aiSource === 'codex-cli' ? ' active' : ''}`}
                  onClick={() => cliStatus.codex && handleSwitchProvider('codex-cli')}
                  disabled={!cliStatus.codex}
                >
                  <span className={`provider-option-radio${config.aiSource === 'codex-cli' ? ' selected' : ''}`} />
                  <div className="provider-option-info">
                    <span className="provider-option-name">Codex</span>
                    <span className="provider-option-detail">Uses your Codex CLI login</span>
                  </div>
                  {!cliStatus.codex && <span className="provider-menu-item-badge">Not installed</span>}
                </button>

                {/* API key option */}
                <button
                  className={`provider-option${config.aiSource === 'api-key' ? ' active' : ''}`}
                  onClick={() => {
                    if (config.apiKey) {
                      handleSwitchProvider('api-key', apiProvider);
                    }
                  }}
                >
                  <span className={`provider-option-radio${config.aiSource === 'api-key' ? ' selected' : ''}`} />
                  <div className="provider-option-info">
                    <span className="provider-option-name">API Key</span>
                    <span className="provider-option-detail">Use an API key directly</span>
                  </div>
                </button>
              </div>
            </div>

            {/* API key config — always visible so users can set up keys */}
            <div className="settings-section">
              <span className="settings-label">API Key Configuration</span>
              <div className="api-form">
                <select
                  className="form-select"
                  value={apiProvider}
                  onChange={(e) => {
                    const provider = e.target.value;
                    setApiProvider(provider);
                    setApiKey(config.apiKeys?.[provider] || '');
                  }}
                >
                  <option value="anthropic">Anthropic — Claude Opus 4</option>
                  <option value="anthropic-sonnet-4-5">Anthropic — Claude Sonnet 4.5</option>
                  <option value="openai">OpenAI — GPT-4o</option>
                  <option value="minimax">MiniMax — M2.5</option>
                  <option value="gemini">Google Gemini — 2.5 Pro</option>
                  <option value="gemini-flash">Google Gemini — 2.5 Flash</option>
                </select>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Paste API key"
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
