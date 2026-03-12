import updateElectronApp from 'update-electron-app';

export function checkForUpdates() {
  updateElectronApp({
    repo: 'clawdaunt/clawdaunt-desktop-app',
    updateInterval: '4 hours',
  });
}
