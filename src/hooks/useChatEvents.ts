import { useState, useEffect, useRef, useCallback } from 'react';

export function useChatEvents(chatSessionKey: string | null) {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAccum = useRef<Map<string, string>>(new Map());
  const currentAssistantId = useRef<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const handleChatEvent = useCallback((event: ChatEvent) => {
    const { type, payload } = event;
    const sid = (payload.session_id || payload.sessionId || '') as string;

    console.log('[chatEvent]', type, 'sid:', sid, 'chatSessionKey:', chatSessionKey);
    if (chatSessionKey && sid && sid !== chatSessionKey) {
      console.log('[chatEvent] SKIPPED — session mismatch');
      return;
    }

    if (type === 'session.status' && (payload.status as string) === 'busy') {
      setIsStreaming(true);
    } else if (type === 'session.idle' || type === 'session.ended' || (type === 'session.status' && (payload.status as string) === 'idle')) {
      const wasStreaming = currentAssistantId.current !== null;
      const hadStreamedContent = streamAccum.current.size > 0;
      setIsStreaming(false);
      streamAccum.current.clear();
      currentAssistantId.current = null;
      // Only reload history if we didn't get content via SSE streaming
      // (CLI-backed agents don't stream via SSE, so we need to reload for those)
      if (wasStreaming && chatSessionKey && !hadStreamedContent) {
        const key = chatSessionKey;
        // Delay + retry: gateway may not have flushed session to disk yet
        const loadWithRetry = (attempt: number) => {
          window.api.loadSessionHistory(key)
            .then(history => {
              if (history.length > 0) {
                setChatMessages(history);
              } else if (attempt < 3) {
                setTimeout(() => loadWithRetry(attempt + 1), 1500);
              }
              // If all retries return empty, keep existing messages (don't wipe)
            })
            .catch(() => {});
        };
        setTimeout(() => loadWithRetry(0), 800);
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

  // Register/unregister chat event handler
  useEffect(() => {
    window.api.onChatEvent(handleChatEvent);
    return () => { window.api.offChatEvent(); };
  }, [handleChatEvent]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  return {
    chatMessages,
    setChatMessages,
    isStreaming,
    setIsStreaming,
    streamAccum,
    currentAssistantId,
    chatEndRef,
  };
}
