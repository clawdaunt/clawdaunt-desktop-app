import https from 'node:https';
import { app, dialog } from 'electron';

export function checkForUpdates() {
  if (!app.isPackaged) return;
  const currentVersion = app.getVersion();
  const repo = 'clawdaunt/clawdaunt-desktop-app';
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  https.get(apiUrl, { headers: { 'User-Agent': 'Clawdaunt' } }, (res) => {
    let data = '';
    res.on('data', (chunk: Buffer) => { data += chunk; });
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const latestTag = (release.tag_name || '').replace(/^v/, '');
        if (!latestTag || latestTag === currentVersion) return;
        const cur = currentVersion.split('.').map(Number);
        const lat = latestTag.split('.').map(Number);
        const isNewer = lat[0] > cur[0] ||
          (lat[0] === cur[0] && lat[1] > cur[1]) ||
          (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);
        if (!isNewer) return;

        dialog.showMessageBox({
          type: 'info',
          buttons: ['Download', 'Later'],
          title: 'Update Available',
          message: `Clawdaunt v${latestTag}`,
          detail: `A new version is available. You are running v${currentVersion}.\nDownload the latest version to update.`,
        }).then(({ response }) => {
          if (response === 0) {
            const { shell } = require('electron');
            shell.openExternal(release.html_url);
          }
        });
      } catch { /* ignore parse errors */ }
    });
  }).on('error', () => { /* silently fail */ });
}
