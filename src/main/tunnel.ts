import dns from 'node:dns';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { state, send } from './state';
import { loadConfig } from './config';
import { findBinary, enrichedEnv } from './binary';

function verifyTunnelReachable(tunnelUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const config = loadConfig();
    const auth = `Bearer ${config.password}`;
    https.get(`${tunnelUrl}/global/health`, { headers: { Authorization: auth }, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); });
  });
}

function setTunnelHealth(status: 'healthy' | 'checking' | 'down') {
  state.tunnelHealthStatus = status;
  send('tunnel-health', status);
}

function startTunnelHealthMonitor(): void {
  if (state.tunnelHealthInterval) clearInterval(state.tunnelHealthInterval);
  let failCount = 0;
  setTunnelHealth('healthy');
  state.tunnelHealthInterval = setInterval(async () => {
    if (!state.currentTunnelURL || state.intentionallyStopping) return;
    const ok = await verifyTunnelReachable(state.currentTunnelURL);
    if (ok) {
      failCount = 0;
      if (state.tunnelHealthStatus !== 'healthy') setTunnelHealth('healthy');
    } else {
      failCount++;
      if (failCount === 1) setTunnelHealth('checking');
      if (failCount >= 3) {
        failCount = 0;
        setTunnelHealth('down');
        state.currentTunnelURL = '';
        send('tunnel-url', '');
        // Flag prevents the exit handler from also calling startTunnel
        state.tunnelRestarting = true;
        state.cloudflaredProc?.kill();
        state.cloudflaredProc = null;
        startTunnel();
      }
    }
  }, 10000);
}

export function startTunnel(): void {
  const config = loadConfig();
  const cloudflaredBin = findBinary('cloudflared');
  if (!cloudflaredBin) {
    send('error', 'cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared');
    return;
  }

  const proxyPort = config.port + 1;
  state.cloudflaredProc = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${proxyPort}`], {
    env: enrichedEnv(),
  });

  let urlFound = false;
  let rateLimited = false;
  const onData = (data: Buffer) => {
    if (urlFound) return;
    const text = data.toString();

    // Detect Cloudflare rate limiting (429 Too Many Requests)
    if (text.includes('429') || text.includes('Too Many Requests')) {
      rateLimited = true;
      send('error', 'Cloudflare rate limit hit. Please wait a few minutes and retry.');
      return;
    }

    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      urlFound = true;
      const tunnelUrl = match[0];
      const hostname = new URL(tunnelUrl).hostname;
      const resolver = new dns.Resolver();
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      const dnsStart = Date.now();
      const waitForDns = () => {
        if (state.intentionallyStopping) return;
        if (Date.now() - dnsStart > 30000) {
          // DNS never resolved — kill and let the exit handler retry
          state.cloudflaredProc?.kill();
          return;
        }
        resolver.resolve4(hostname, (err) => {
          if (err) {
            setTimeout(waitForDns, 1000);
          } else {
            state.currentTunnelURL = tunnelUrl;
            send('tunnel-url', tunnelUrl);
            startTunnelHealthMonitor();
          }
        });
      };
      waitForDns();
    }
  };

  state.cloudflaredProc.stdout?.on('data', onData);
  state.cloudflaredProc.stderr?.on('data', onData);

  state.cloudflaredProc.on('error', (err) => {
    send('error', `cloudflared error: ${err.message}`);
  });

  state.cloudflaredProc.on('exit', () => {
    if (state.intentionallyStopping) return;
    // Health monitor already killed us and called startTunnel — don't double-restart
    if (state.tunnelRestarting) {
      state.tunnelRestarting = false;
      return;
    }
    state.currentTunnelURL = '';
    send('tunnel-url', '');
    // If rate limited, wait longer before retrying (60s instead of 2s)
    const delay = rateLimited ? 60000 : 2000;
    setTimeout(() => startTunnel(), delay);
  });
}
