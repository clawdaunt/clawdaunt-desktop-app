export const generateId = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
};

export const formatTimeAgo = (unixSecs: number) => {
  const secs = Math.floor(Date.now() / 1000 - unixSecs);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export const formatElapsed = (startedAt: number) => {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
};

export const getToolSummary = (tool: ToolEvent): string => {
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

export const formatToolArgs = (tool: ToolEvent): string => {
  if (!tool.args) return '';
  try {
    return JSON.stringify(tool.args, null, 2);
  } catch {
    return String(tool.args);
  }
};
