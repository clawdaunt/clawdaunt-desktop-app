/**
 * Smoke test for device-identity module.
 * Run with: npx tsx src/device-identity.test.ts
 *
 * Tests:
 * 1. Keypair generation produces valid fields
 * 2. Repeated calls return the same identity (persistence)
 * 3. signChallenge produces a signature that verifies with the public key
 * 4. Different nonces produce different signatures
 */

import { getDeviceIdentity, signChallenge } from './device-identity';
import { verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEVICE_PATH = path.join(os.homedir(), '.clawdaunt', 'device.json');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

// ── Clean slate ──
// Back up existing device.json if present, restore after tests
const hadExisting = fs.existsSync(DEVICE_PATH);
let backup: Buffer | null = null;
if (hadExisting) {
  backup = fs.readFileSync(DEVICE_PATH);
  fs.unlinkSync(DEVICE_PATH);
}

try {
  console.log('\n── Test 1: Keypair generation ──');
  const identity = getDeviceIdentity();
  assert(typeof identity.deviceId === 'string' && identity.deviceId.length === 16, 'deviceId is 16-char hex');
  assert(/^[0-9a-f]{16}$/.test(identity.deviceId), 'deviceId is valid hex');
  assert(typeof identity.publicKey === 'string' && identity.publicKey.length > 0, 'publicKey is non-empty base64');
  assert(typeof identity.privateKey === 'string' && identity.privateKey.length > 0, 'privateKey is non-empty base64');

  // Verify the base64 decodes cleanly
  const pubBytes = Buffer.from(identity.publicKey, 'base64');
  const privBytes = Buffer.from(identity.privateKey, 'base64');
  assert(pubBytes.length > 0, `publicKey decodes to ${pubBytes.length} bytes`);
  assert(privBytes.length > 0, `privateKey decodes to ${privBytes.length} bytes`);

  console.log('\n── Test 2: Persistence ──');
  assert(fs.existsSync(DEVICE_PATH), 'device.json was written to disk');
  const identity2 = getDeviceIdentity();
  assert(identity.deviceId === identity2.deviceId, 'second call returns same deviceId');
  assert(identity.publicKey === identity2.publicKey, 'second call returns same publicKey');

  console.log('\n── Test 3: Sign + verify ──');
  const nonce = 'test-nonce-12345';
  const sig = signChallenge(nonce);
  assert(typeof sig === 'string' && sig.length > 0, 'signature is non-empty base64');

  // Verify signature using Node.js crypto
  const sigBuf = Buffer.from(sig, 'base64');
  const valid = verify(null, Buffer.from(nonce), {
    key: privBytes,
    format: 'der',
    type: 'pkcs8',
  }, sigBuf);
  assert(valid === true, 'signature verifies against the public key');

  console.log('\n── Test 4: Different nonces → different signatures ──');
  const sig2 = signChallenge('different-nonce-67890');
  assert(sig !== sig2, 'different nonces produce different signatures');

  // Also verify sig2
  const sig2Valid = verify(null, Buffer.from('different-nonce-67890'), {
    key: privBytes,
    format: 'der',
    type: 'pkcs8',
  }, Buffer.from(sig2, 'base64'));
  assert(sig2Valid === true, 'second signature also verifies');

  // Wrong nonce should NOT verify
  const wrongValid = verify(null, Buffer.from('wrong-nonce'), {
    key: privBytes,
    format: 'der',
    type: 'pkcs8',
  }, sigBuf);
  assert(wrongValid === false, 'signature does NOT verify against wrong nonce');

} finally {
  // ── Restore original device.json ──
  if (backup) {
    fs.writeFileSync(DEVICE_PATH, backup);
  } else if (fs.existsSync(DEVICE_PATH)) {
    fs.unlinkSync(DEVICE_PATH);
  }
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
process.exit(failed > 0 ? 1 : 0);
