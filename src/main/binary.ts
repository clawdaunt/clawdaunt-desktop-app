import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

// ── Binary discovery ───────────────────────────────────────
// Bundled binaries live in Clawdaunt.app/Contents/Resources/bin/
// Falls back to user's shell PATH (Electron apps launched from
// Finder don't inherit it, so we resolve it from the login shell).
const FALLBACK_PATHS = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];

// Minimum openclaw version required for all Clawdaunt features (e.g. Gemini tool calling)
export const MIN_OPENCLAW_VERSION = '2026.3.2';

function resolveShellPath(): string[] {
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execSync(`${shell} -l -i -c 'echo $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split(':').filter(Boolean);
  } catch {
    return [];
  }
}

const shellPathDirs = resolveShellPath();
export const SEARCH_PATHS = [...new Set([...FALLBACK_PATHS, ...shellPathDirs])];

export function bundledBinDir(): string {
  return path.join(process.resourcesPath, 'bin');
}

// CLIs where user-installed version should take precedence over bundled,
// to avoid version/config conflicts.
const PREFER_SYSTEM = new Set(['openclaw', 'claude', 'codex']);

export function findBinary(name: string): string | null {
  if (PREFER_SYSTEM.has(name)) {
    // 1. User's shell PATH + fallback paths first
    for (const dir of SEARCH_PATHS) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
    // 2. Fall back to bundled
    const bundled = path.join(bundledBinDir(), name);
    if (fs.existsSync(bundled)) return bundled;
  } else {
    // Infrastructure binaries (node, cloudflared): prefer bundled for stability
    const bundled = path.join(bundledBinDir(), name);
    if (fs.existsSync(bundled)) return bundled;
    for (const dir of SEARCH_PATHS) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** Returns the bundled node binary, or falls back to system node. */
export function findNode(): string {
  const bundled = path.join(bundledBinDir(), 'node');
  if (fs.existsSync(bundled)) return bundled;
  return 'node';
}

/**
 * Returns the right node binary to run a given CLI binary.
 * System-installed CLIs (openclaw, claude, codex) have native addons compiled
 * against the system Node, so we must use system node to run them.
 * Bundled binaries use the bundled node.
 */
export function findNodeFor(binaryPath: string): string {
  const bundled = bundledBinDir();
  if (binaryPath.startsWith(bundled)) return findNode();
  // Binary is system-installed — prefer system node so native addons match,
  // but fall back to bundled node if no system node is available.
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, 'node');
    if (fs.existsSync(full)) return full;
  }
  return findNode();
}

export function enrichedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: SEARCH_PATHS.join(':'),
    NODE_PATH: path.join(bundledBinDir(), 'node_modules'),
    ...extra,
  };
}

// ── OpenClaw version helpers ────────────────────────────────

/** Run `openclaw --version` and return the version string, or null on failure. */
export function getOpenclawVersion(binaryPath: string): string | null {
  try {
    const node = findNodeFor(binaryPath);
    const out = execSync(`"${node}" "${binaryPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: enrichedEnv(),
    });
    // Output might be "openclaw 2026.3.8" or just "2026.3.8"
    const match = out.trim().match(/(\d{4}\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Compare two dot-separated version strings. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Pick the best openclaw binary considering versions.
 * Returns { path, version, source } for the chosen binary,
 * plus an optional `updateInfo` if the system copy is outdated.
 */
export function resolveOpenclaw(): {
  path: string | null;
  version: string | null;
  source: 'system' | 'bundled';
  updateInfo: { systemVersion: string; bundledVersion: string } | null;
} {
  // Find both candidates
  let systemPath: string | null = null;
  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, 'openclaw');
    if (fs.existsSync(full)) { systemPath = full; break; }
  }
  const bundledPath = path.join(bundledBinDir(), 'openclaw');
  const hasBundled = fs.existsSync(bundledPath);

  const systemVer = systemPath ? getOpenclawVersion(systemPath) : null;
  const bundledVer = hasBundled ? getOpenclawVersion(bundledPath) : null;

  let updateInfo: { systemVersion: string; bundledVersion: string } | null = null;

  // If only one exists, use it
  if (!systemPath && hasBundled) return { path: bundledPath, version: bundledVer, source: 'bundled', updateInfo: null };
  if (systemPath && !hasBundled) return { path: systemPath, version: systemVer, source: 'system', updateInfo: null };
  if (!systemPath && !hasBundled) return { path: null, version: null, source: 'system', updateInfo: null };

  // Both exist — compare versions and pick the newer one
  if (systemVer && bundledVer) {
    if (compareVersions(systemVer, bundledVer) < 0) {
      // System is older than bundled — use bundled, suggest update
      updateInfo = { systemVersion: systemVer, bundledVersion: bundledVer };
      return { path: bundledPath, version: bundledVer, source: 'bundled', updateInfo };
    }
    // System is same or newer — use system
    return { path: systemPath, version: systemVer, source: 'system', updateInfo: null };
  }

  // Couldn't determine one or both versions — prefer system (original behavior)
  return { path: systemPath, version: systemVer, source: 'system', updateInfo: null };
}
