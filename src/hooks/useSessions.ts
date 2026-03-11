import { useState, useEffect, useCallback } from 'react';

export function useSessions(status: string) {
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [pastSessions, setPastSessions] = useState<PersistentSession[]>([]);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<{ x: number; y: number; session: PersistentSession } | null>(null);

  // Load live sessions
  useEffect(() => {
    window.api.listSessions().then(setSessions);
    window.api.onSessionsUpdated(setSessions);
  }, []);

  // Poll persistent past sessions from gateway
  const refreshPastSessions = useCallback(() => {
    window.api.listPersistentSessions().then(sessions => {
      const seen = new Set<string>();
      setPastSessions(sessions.filter(s => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (status !== 'running') { setPastSessions([]); return; }
    refreshPastSessions();
    const interval = setInterval(refreshPastSessions, 5000);
    return () => clearInterval(interval);
  }, [status, refreshPastSessions]);

  // Close session context menu on click
  useEffect(() => {
    if (!sessionContextMenu) return;
    const handler = () => setSessionContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [sessionContextMenu]);

  const isMainSession = (s: PersistentSession) => s.gatewayKey === 'agent:main:main';

  const handleLoadPastSession = async (
    session: PersistentSession,
    callbacks: {
      setChatSessionKey: (key: string) => void;
      setViewingPastSession: (v: boolean) => void;
      setIsStreaming: (v: boolean) => void;
      clearStreaming: () => void;
      setPendingImages: (imgs: ChatAttachment[]) => void;
      setPendingFiles: (files: FileReference[]) => void;
      setChatMessages: (msgs: ChatMessage[]) => void;
    }
  ) => {
    callbacks.setChatSessionKey(session.id);
    callbacks.setViewingPastSession(true);
    callbacks.setIsStreaming(false);
    callbacks.clearStreaming();
    callbacks.setPendingImages([]);
    callbacks.setPendingFiles([]);
    callbacks.setChatMessages([]);
    try {
      const history = await window.api.loadSessionHistory(session.id);
      callbacks.setChatMessages(history);
    } catch { /* ignore */ }
  };

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

  return {
    sessions,
    pastSessions,
    selectedSessions,
    batchDeleting,
    sessionContextMenu,
    setSessionContextMenu,
    refreshPastSessions,
    isMainSession,
    handleLoadPastSession,
    handleDeletePastSession,
    handleBatchDeleteSessions,
    toggleSessionSelection,
    toggleSelectAllSessions,
    deletableSessions,
  };
}
