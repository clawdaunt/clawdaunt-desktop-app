import { useState, useEffect, useRef, useCallback } from 'react';
import { generateId } from '../utils';

interface UseChatSendArgs {
  config: Config;
  status: string;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  chatMessages: ChatMessage[];
  setChatMessages: (msgs: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  streamAccum: React.MutableRefObject<Map<string, string>>;
  currentAssistantId: React.MutableRefObject<string | null>;
  onConfigUpdate: (config: Config) => void;
}

export function useChatSend({
  config,
  status,
  isStreaming,
  setIsStreaming,
  setChatMessages,
  streamAccum,
  currentAssistantId,
  onConfigUpdate,
}: UseChatSendArgs) {
  const [chatInput, setChatInput] = useState('');
  const [chatSessionKey, setChatSessionKey] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<ChatAttachment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<FileReference[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [viewingPastSession, setViewingPastSession] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  }, [config.workspaces, config.activeWorkspaceId, setIsStreaming, setChatMessages, streamAccum, currentAssistantId]);

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

  return {
    chatInput,
    setChatInput,
    chatSessionKey,
    setChatSessionKey,
    pendingImages,
    setPendingImages,
    pendingFiles,
    setPendingFiles,
    isDragging,
    viewingPastSession,
    setViewingPastSession,
    chatInputRef,
    fileInputRef,
    handleSendMessage,
    handleAbort,
    handleNewChat,
    handleKeyDown,
    handleAddAttachment,
    handleFileInputChange,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    removePendingImage,
    removePendingFile,
    reloadWorkspaceChat,
  };
}
