import 'dotenv/config';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Build platform-appropriate makers list
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makers: any[] = [];

if (process.platform === 'darwin') {
  makers.push(
    new MakerDMG({ format: 'ULFO', name: 'Clawdaunt' }),
    new MakerZIP({}, ['darwin']),
  );
}

if (process.platform === 'win32') {
  makers.push(
    new MakerSquirrel({
      name: 'Clawdaunt',
      setupIcon: 'resources/icon.ico', // TODO: create icon.ico for Windows builds
    }),
    new MakerZIP({}, ['win32']),
  );
}

if (process.platform === 'linux') {
  makers.push(
    new MakerDeb({}),
    new MakerRpm({}),
    new MakerZIP({}, ['linux']),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Clawdaunt',
    executableName: 'Clawdaunt',
    icon: 'resources/icon',
    extraResource: ['resources/bin'],
    // macOS code signing
    ...(process.env.APPLE_SIGNING_IDENTITY ? {
      osxSign: {
        identity: process.env.APPLE_SIGNING_IDENTITY,
        optionsForFile: () => ({
          entitlements: 'entitlements.plist',
        }),
      },
    } : {}),
    ...(process.env.APPLE_ID ? {
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_ID_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    } : {}),
  },
  rebuildConfig: {},
  makers,
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'clawdaunt',
        name: 'clawdaunt-desktop-app',
      },
      prerelease: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
