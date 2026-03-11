import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { findBinary } from './binary';

// ── Protocol version ────────────────────────────────────────
// Bump this integer when a change to the desktop-mobile communication
// format would break older clients (new/removed endpoints, changed
// WebSocket message shapes, etc.).  The mobile app checks this on
// connect and tells the user to update whichever side is behind.
export const CLAWDAUNT_PROTOCOL_VERSION = 1;

// ── Config ─────────────────────────────────────────────────
export interface Workspace {
  id: string;
  name: string;
  paths: string[];       // single-element array for now, multi-repo ready
  protected: string[];   // absolute paths AI cannot access
  openclawSessionKey?: string;  // maps to desktop:{random} key used with gateway
}

export type AISource = 'claude-cli' | 'codex-cli' | 'api-key';

export interface Config {
  port: number;
  password: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  aiSource: AISource;
  apiKey: string;        // active key (for current apiProvider)
  apiProvider: string;   // e.g. 'anthropic', 'openai' — only used with api-key
  apiKeys: Record<string, string>;  // provider -> key
}

export const CONFIG_DIR = path.join(os.homedir(), '.clawdaunt');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const OPENCLAW_CONFIG_DIR = path.join(os.homedir(), '.openclaw');
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_CONFIG_DIR, 'openclaw.json');

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    const config: Config = {
      port: 4096,
      password: randomBytes(16).toString('base64url'),
      workspaces: [],
      activeWorkspaceId: null,
      aiSource: 'claude-cli',
      apiKey: '',
      apiProvider: 'anthropic',
      apiKeys: {},
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    return config;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Migrate from old repos[] format
  if (Array.isArray(raw.repos) && !Array.isArray(raw.workspaces)) {
    const workspaces: Workspace[] = (raw.repos as string[]).map((r) => ({
      id: randomBytes(8).toString('hex'),
      name: path.basename(r),
      paths: [r],
      protected: [] as string[],
    }));
    const config: Config = {
      port: raw.port ?? 4096,
      password: raw.password ?? randomBytes(16).toString('base64url'),
      workspaces,
      activeWorkspaceId: workspaces.length > 0 ? workspaces[0].id : null,
      aiSource: raw.aiSource ?? 'claude-cli',
      apiKey: raw.apiKey ?? '',
      apiProvider: raw.apiProvider ?? 'anthropic',
      apiKeys: raw.apiKeys ?? {},
    };
    delete (raw as Record<string, unknown>).repos;
    saveConfig(config);
    return config;
  }

  // Ensure new fields exist on old configs
  if (!raw.aiSource) raw.aiSource = 'claude-cli';
  if (!raw.apiKey) raw.apiKey = '';
  if (!raw.apiProvider) raw.apiProvider = 'anthropic';
  if (!raw.apiKeys) raw.apiKeys = {};

  // Migrate: if apiKey exists but apiKeys doesn't have it, store it
  if (raw.apiKey && raw.apiProvider && !raw.apiKeys[raw.apiProvider]) {
    raw.apiKeys[raw.apiProvider] = raw.apiKey;
  }

  return raw as Config;
}

export function saveConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ── OpenClaw config generation ────────────────────────────────
// Registers all available CLIs as separate skills so agents can use any backend.
// The `aiSource` field selects which skill is the default `coding-agent`.
export function generateOpenClawConfig(config: Config): void {
  if (!fs.existsSync(OPENCLAW_CONFIG_DIR)) {
    fs.mkdirSync(OPENCLAW_CONFIG_DIR, { recursive: true });
  }

  const openclawConfig: Record<string, unknown> = {
    gateway: {
      mode: 'local',
      port: config.port,
      auth: { token: config.password },
      http: {
        endpoints: {
          chatCompletions: { enabled: true },
        },
      },
    },
    tools: {
      profile: 'full',
    },
  };

  // CLI backends (claude-cli, codex-cli) are built-in defaults in OpenClaw.
  // Only override command paths when they're not on the default PATH.
  const cliBackends: Record<string, { command: string }> = {};
  const claudeBin = findBinary('claude');
  if (claudeBin) {
    cliBackends['claude-cli'] = { command: claudeBin };
  }
  const codexBin = findBinary('codex');
  if (codexBin) {
    cliBackends['codex-cli'] = { command: codexBin };
  }

  // Select model based on AI source
  // For api-key providers, check if openclaw has auth registered. If not, fall back to claude-cli.
  let primary: string;
  if (config.aiSource === 'claude-cli') {
    primary = 'claude-cli/opus-4.6';
  } else if (config.aiSource === 'codex-cli') {
    primary = 'codex-cli/gpt-5.3-codex';
  } else if (config.aiSource === 'api-key') {
    const providerModelMap: Record<string, string> = {
      openai: 'openai/gpt-4o',
      minimax: 'minimax/MiniMax-M2.5',
      gemini: 'google/gemini-2.5-pro',
      'gemini-flash': 'google/gemini-2.5-flash',
      anthropic: 'anthropic/claude-opus-4-20250514',
      'anthropic-sonnet-4-5': 'anthropic/claude-sonnet-4-5-20250514',
    };
    const desired = providerModelMap[config.apiProvider] || 'anthropic/claude-opus-4-20250514';

    // Check if provider has auth in openclaw's auth-profiles
    const authProfilesPath = path.join(OPENCLAW_CONFIG_DIR, 'agents', 'main', 'agent', 'auth-profiles.json');
    let hasProviderAuth = false;
    try {
      const profiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf-8'));
      hasProviderAuth = Object.values(profiles).some(
        (p: unknown) => (p as Record<string, unknown>).provider === config.apiProvider
      );
    } catch { /* no auth profiles */ }

    // Always write the API key to openclaw auth-profiles (updates existing keys too)
    // Map our provider names to openclaw's internal provider names
    const openclawProviderMap: Record<string, string> = {
      gemini: 'google',
      'gemini-flash': 'google',
      'anthropic-sonnet-4-5': 'anthropic',
    };
    const openclawProvider = openclawProviderMap[config.apiProvider] || config.apiProvider;
    if (config.apiKey) {
      try {
        const dir = path.dirname(authProfilesPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let profiles: Record<string, unknown> = {};
        try { profiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf-8')); } catch { /* new file */ }
        profiles[`${openclawProvider}:manual`] = {
          id: `${openclawProvider}:manual`,
          provider: openclawProvider,
          token: config.apiKey,
          createdAtMs: Date.now(),
        };
        fs.writeFileSync(authProfilesPath, JSON.stringify(profiles, null, 2) + '\n');
        hasProviderAuth = true;
      } catch { /* ignore write errors */ }
    }

    primary = desired;
  } else {
    primary = 'claude-cli/opus-4.6';
  }

  const activeWs = config.workspaces.find((w) => w.id === config.activeWorkspaceId);

  openclawConfig.agents = {
    defaults: {
      model: { primary },
      verboseDefault: 'on',
      ...(activeWs ? { workspace: activeWs.paths[0] } : {}),
      ...(Object.keys(cliBackends).length > 0 ? { cliBackends } : {}),
    },
  };

  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(openclawConfig, null, 2) + '\n');

  // Ensure all paired devices have operator.write scope (required for chat.send).
  // The default openclaw setup/configure flow may omit this scope.
  ensureDeviceWriteScope();
}

export function ensureDeviceWriteScope(): void {
  const pairedPath = path.join(OPENCLAW_CONFIG_DIR, 'devices', 'paired.json');
  if (!fs.existsSync(pairedPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(pairedPath, 'utf-8'));
    let changed = false;
    for (const dev of Object.values(data) as Record<string, unknown>[]) {
      const addScope = (arr: string[] | undefined, scope: string): string[] => {
        if (!arr) return [scope];
        if (arr.includes(scope)) return arr;
        changed = true;
        return [...arr, scope];
      };
      dev.scopes = addScope(dev.scopes as string[], 'operator.write');
      dev.approvedScopes = addScope(dev.approvedScopes as string[], 'operator.write');
      const tokens = dev.tokens as Record<string, { scopes: string[] }> | undefined;
      if (tokens) {
        for (const tok of Object.values(tokens)) {
          tok.scopes = addScope(tok.scopes, 'operator.write');
        }
      }
    }
    if (changed) {
      fs.writeFileSync(pairedPath, JSON.stringify(data, null, 2) + '\n');
    }
  } catch {
    // Don't block startup if paired.json is malformed
  }
}
