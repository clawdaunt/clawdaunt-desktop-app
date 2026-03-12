import React, { useState, useEffect, useRef } from 'react';

interface SettingsModalProps {
  settingsOpen: boolean;
  config: Config;
  onConfigUpdate: (config: Config) => void;
  onClose: () => void;
}

const PROVIDERS: { id: string; aiSource: AISource; apiProvider?: string; label: string; description: string }[] = [
  { id: 'claude-cli', aiSource: 'claude-cli', label: 'Claude Code', description: 'Via Claude CLI' },
  { id: 'codex-cli', aiSource: 'codex-cli', label: 'Codex', description: 'Via Codex CLI' },
  { id: 'anthropic', aiSource: 'api-key', apiProvider: 'anthropic', label: 'Anthropic API', description: 'Claude Opus 4' },
  { id: 'anthropic-sonnet-4-5', aiSource: 'api-key', apiProvider: 'anthropic-sonnet-4-5', label: 'Anthropic API', description: 'Claude Sonnet 4.5' },
  { id: 'openai', aiSource: 'api-key', apiProvider: 'openai', label: 'OpenAI API', description: 'GPT-4o' },
  { id: 'minimax', aiSource: 'api-key', apiProvider: 'minimax', label: 'MiniMax API', description: 'MiniMax M2.5' },
  { id: 'gemini', aiSource: 'api-key', apiProvider: 'gemini', label: 'Gemini API', description: 'Gemini 2.5 Pro' },
  { id: 'gemini-flash', aiSource: 'api-key', apiProvider: 'gemini-flash', label: 'Gemini Flash', description: 'Gemini 2.5 Flash' },
];

export { PROVIDERS };

export default function SettingsModal({
  settingsOpen,
  config,
  onConfigUpdate,
  onClose,
}: SettingsModalProps) {
  const [apiKey, setApiKey] = useState(config.apiKey || '');
  const [apiProvider, setApiProvider] = useState(config.apiProvider || 'anthropic');
  const [cliStatus, setCLIStatus] = useState<CLIStatus>({ openclaw: false, claude: false, codex: false });
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    window.api.detectCLIs().then(setCLIStatus);
  }, []);

  useEffect(() => {
    const provider = config.apiProvider || 'anthropic';
    setApiProvider(provider);
    setApiKey(config.apiKeys?.[provider] || config.apiKey || '');
  }, [config.apiKey, config.apiProvider, config.apiKeys]);

  const handleSwitchProvider = async (aiSource: AISource, provider?: string) => {
    const newApiKey = aiSource === 'api-key' ? config.apiKey : undefined;
    onConfigUpdate(await window.api.setAISource(aiSource, newApiKey, provider));
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return;
    // Save the key without switching away from the current provider (e.g. claude-cli)
    onConfigUpdate(await window.api.setAISource(config.aiSource, apiKey.trim(), apiProvider));
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 2000);
  };

  if (!settingsOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>
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
  );
}
