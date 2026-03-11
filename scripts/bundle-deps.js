#!/usr/bin/env node
/**
 * Downloads/installs openclaw + cloudflared binaries into resources/bin/.
 * Cross-platform replacement for bundle-deps.sh.
 * Called automatically by `npm run make`. Can also be run standalone.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'resources', 'bin');
const PLATFORM = process.platform;  // 'darwin', 'win32', 'linux'
const ARCH = process.arch;          // 'x64', 'arm64'
const IS_WINDOWS = PLATFORM === 'win32';
const EXE_EXT = IS_WINDOWS ? '.exe' : '';

fs.mkdirSync(BIN_DIR, { recursive: true });

console.log('=== Bundling dependencies ===');
console.log(`Platform: ${PLATFORM} / ${ARCH}`);
console.log('');

// ── Helpers ──────────────────────────────────────────────────

function fileExists(p) {
  return fs.existsSync(p);
}

/** Download a file from a URL, following redirects. */
function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'clawdaunt-bundler' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        return download(redirectUrl, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/** Extract a .tgz archive to a directory. */
function extractTgz(archivePath, destDir) {
  execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' });
}

/** Extract a .zip archive to a directory. */
function extractZip(archivePath, destDir) {
  if (IS_WINDOWS) {
    // Use PowerShell's Expand-Archive
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
  }
}

function which(name) {
  try {
    if (IS_WINDOWS) {
      return execSync(`where ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
    }
    return execSync(`which ${name}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// ── cloudflared ─────────────────────────────────────────────

async function bundleCloudflared() {
  const binName = 'cloudflared' + EXE_EXT;
  if (fileExists(path.join(BIN_DIR, binName))) {
    console.log('[ok] cloudflared already bundled');
    return;
  }

  console.log('[dl] Downloading cloudflared...');

  const archMap = { x64: 'amd64', arm64: 'arm64' };
  const cfArch = archMap[ARCH] || 'amd64';

  let cfUrl, archiveExt;
  if (PLATFORM === 'darwin') {
    cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${cfArch}.tgz`;
    archiveExt = '.tgz';
  } else if (IS_WINDOWS) {
    // Windows cloudflared is distributed as a standalone .exe
    cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${cfArch}.exe`;
    archiveExt = '.exe';
  } else {
    cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;
    archiveExt = '';
  }

  const tmpFile = path.join(os.tmpdir(), 'cloudflared-download' + archiveExt);
  await download(cfUrl, tmpFile);

  if (archiveExt === '.tgz') {
    extractTgz(tmpFile, BIN_DIR);
  } else {
    // Direct binary download (.exe or ELF)
    fs.copyFileSync(tmpFile, path.join(BIN_DIR, binName));
  }

  if (!IS_WINDOWS) {
    fs.chmodSync(path.join(BIN_DIR, binName), 0o755);
  }
  fs.rmSync(tmpFile, { force: true });
  console.log('[ok] cloudflared downloaded');
}

// ── node (standalone runtime for openclaw) ─────────────────

async function bundleNode() {
  const binName = 'node' + EXE_EXT;
  if (fileExists(path.join(BIN_DIR, binName))) {
    console.log('[ok] node already bundled');
    return;
  }

  console.log('[dl] Downloading Node.js...');

  const NODE_VERSION = '22.14.0';
  let nodeUrl, archiveName;

  if (PLATFORM === 'darwin') {
    const nodeArch = ARCH === 'arm64' ? 'arm64' : 'x64';
    archiveName = `node-v${NODE_VERSION}-darwin-${nodeArch}`;
    nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}.tar.gz`;
  } else if (IS_WINDOWS) {
    const nodeArch = ARCH === 'arm64' ? 'arm64' : 'x64';
    archiveName = `node-v${NODE_VERSION}-win-${nodeArch}`;
    nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}.zip`;
  } else {
    const nodeArch = ARCH === 'arm64' ? 'arm64' : 'x64';
    archiveName = `node-v${NODE_VERSION}-linux-${nodeArch}`;
    nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}.tar.gz`;
  }

  const tmpFile = path.join(os.tmpdir(), path.basename(nodeUrl));
  const tmpExtractDir = path.join(os.tmpdir(), 'node-extract');
  fs.rmSync(tmpExtractDir, { recursive: true, force: true });
  fs.mkdirSync(tmpExtractDir, { recursive: true });

  await download(nodeUrl, tmpFile);

  if (IS_WINDOWS) {
    extractZip(tmpFile, tmpExtractDir);
    fs.copyFileSync(path.join(tmpExtractDir, archiveName, 'node.exe'), path.join(BIN_DIR, 'node.exe'));
  } else {
    extractTgz(tmpFile, tmpExtractDir);
    fs.copyFileSync(path.join(tmpExtractDir, archiveName, 'bin', 'node'), path.join(BIN_DIR, 'node'));
    fs.chmodSync(path.join(BIN_DIR, 'node'), 0o755);
  }

  fs.rmSync(tmpFile, { force: true });
  fs.rmSync(tmpExtractDir, { recursive: true, force: true });
  console.log('[ok] node downloaded');
}

// ── openclaw ────────────────────────────────────────────────

async function bundleOpenclaw() {
  // On Windows we bundle the JS entry script as 'openclaw' (no .exe), so check
  // the actual bundled filename for idempotency, not the platform-suffixed name.
  const bundledName = IS_WINDOWS ? 'openclaw' : 'openclaw' + EXE_EXT;
  if (fileExists(path.join(BIN_DIR, bundledName)) && fileExists(path.join(BIN_DIR, 'node_modules'))) {
    console.log('[ok] openclaw already bundled');
    return;
  }

  // 1. Check if already installed on the system
  let openclawPath = which('openclaw');
  if (!openclawPath && !IS_WINDOWS) {
    for (const p of ['/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw']) {
      if (fileExists(p)) { openclawPath = p; break; }
    }
  }

  // 2. Not found — try to auto-install
  if (!openclawPath) {
    if (PLATFORM === 'darwin') {
      const brewPath = which('brew');
      if (!brewPath) {
        console.error('[!!] Homebrew not found. Install it from https://brew.sh');
        process.exit(1);
      }
      console.log('[..] openclaw not found \u2014 installing via Homebrew...');
      execSync('brew install openclaw-cli', { stdio: 'inherit' });
      openclawPath = which('openclaw');
    } else if (IS_WINDOWS) {
      // Try npm global install as fallback on Windows
      const npmPath = which('npm');
      if (npmPath) {
        console.log('[..] openclaw not found \u2014 installing via npm...');
        try {
          execSync('npm install -g openclaw-cli', { stdio: 'inherit' });
          openclawPath = which('openclaw');
        } catch {
          // npm install failed, continue to error
        }
      }
    }

    if (!openclawPath) {
      console.error('[!!] openclaw not found and could not be installed.');
      console.error(IS_WINDOWS
        ? '     Install it first: npm install -g openclaw-cli'
        : '     For DMG builds, install it first: brew install openclaw-cli');
      process.exit(1);
    }
  }

  // Resolve symlinks to find the real installation
  const realPath = fs.realpathSync(openclawPath);
  const openclawDir = path.dirname(realPath);

  // Find the openclaw package root
  let pkgDir = null;
  const libModules = path.join(openclawDir, '..', 'lib', 'node_modules', 'openclaw');
  if (fileExists(libModules)) {
    pkgDir = fs.realpathSync(libModules);
  } else if (fileExists(path.join(openclawDir, 'package.json'))) {
    pkgDir = openclawDir;
  }

  if (!pkgDir) {
    console.error('[!!] Could not find openclaw package directory.');
    process.exit(1);
  }

  console.log(`[cp] Copying openclaw from ${pkgDir}`);

  // On Windows, `where openclaw` resolves to an `openclaw.cmd` shim, not the
  // actual JS entry script. Prefer the entry script from package.json's "bin"
  // field so the runtime can invoke it via node directly.
  let srcBinPath = realPath;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (pkgJson && pkgJson.bin) {
      const binRel = typeof pkgJson.bin === 'string' ? pkgJson.bin : pkgJson.bin.openclaw;
      if (binRel) {
        const candidate = path.resolve(pkgDir, binRel);
        if (fileExists(candidate)) {
          srcBinPath = candidate;
        }
      }
    }
  } catch { /* fall back to realPath */ }

  // Bundle the entry script — always as 'openclaw' (no .exe) since it's a JS
  // file invoked via node. On macOS/Linux the original script is already extensionless.
  fs.copyFileSync(srcBinPath, path.join(BIN_DIR, bundledName));
  if (!IS_WINDOWS) {
    fs.chmodSync(path.join(BIN_DIR, bundledName), 0o755);
  }

  // Copy dist/ (built output)
  const destDist = path.join(BIN_DIR, 'dist');
  fs.rmSync(destDist, { recursive: true, force: true });
  fs.cpSync(path.join(pkgDir, 'dist'), destDist, { recursive: true });
  console.log('[ok] Copied dist/');

  // Copy node_modules/ (runtime dependencies)
  const destModules = path.join(BIN_DIR, 'node_modules');
  fs.rmSync(destModules, { recursive: true, force: true });
  fs.cpSync(path.join(pkgDir, 'node_modules'), destModules, { recursive: true });
  console.log('[ok] Copied node_modules/');

  // Copy package.json (needed for "type": "module")
  fs.copyFileSync(path.join(pkgDir, 'package.json'), path.join(BIN_DIR, 'package.json'));
  console.log('[ok] Copied package.json');

  console.log('[ok] openclaw bundled');
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  await bundleCloudflared();
  await bundleNode();
  await bundleOpenclaw();

  console.log('');
  console.log('=== Done! Bundled binaries ===');
  const files = fs.readdirSync(BIN_DIR);
  for (const f of files) {
    const stat = fs.statSync(path.join(BIN_DIR, f));
    if (stat.isFile()) {
      const sizeKB = (stat.size / 1024).toFixed(0);
      console.log(`  ${f} (${sizeKB}K)`);
    } else {
      console.log(`  ${f}/`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error('[!!] Bundle failed:', err.message);
  process.exit(1);
});
