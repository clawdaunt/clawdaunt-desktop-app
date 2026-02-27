import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.clawdaunt');
const DEVICE_PATH = path.join(CONFIG_DIR, 'device.json');

interface DeviceIdentity {
  deviceId: string;
  publicKey: string;   // base64-encoded raw public key
  privateKey: string;  // base64-encoded raw private key
}

let cached: DeviceIdentity | null = null;

/**
 * Load or create an ed25519 device keypair.
 * Persisted to ~/.clawdaunt/device.json so the device ID is stable across restarts.
 */
export function getDeviceIdentity(): DeviceIdentity {
  if (cached) return cached;

  if (fs.existsSync(DEVICE_PATH)) {
    try {
      cached = JSON.parse(fs.readFileSync(DEVICE_PATH, 'utf-8')) as DeviceIdentity;
      return cached;
    } catch {
      // Corrupt file — regenerate
    }
  }

  // Generate new ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const pubBase64 = Buffer.from(publicKey).toString('base64');

  // deviceId = first 16 hex chars of SHA-256 fingerprint of raw public key
  const fingerprint = createHash('sha256').update(publicKey).digest('hex');
  const deviceId = fingerprint.slice(0, 16);

  const identity: DeviceIdentity = {
    deviceId,
    publicKey: pubBase64,
    privateKey: Buffer.from(privateKey).toString('base64'),
  };

  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(DEVICE_PATH, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600 });

  cached = identity;
  return identity;
}

/**
 * Sign a nonce challenge with the device's private key.
 * Returns a base64-encoded ed25519 signature.
 */
export function signChallenge(nonce: string): string {
  const identity = getDeviceIdentity();
  const privKeyDer = Buffer.from(identity.privateKey, 'base64');

  // Reconstruct the private key object from DER-encoded PKCS8
  const signature = sign(null, Buffer.from(nonce), {
    key: privKeyDer,
    format: 'der',
    type: 'pkcs8',
  });

  return signature.toString('base64');
}
