/* Password hashing — PBKDF2-HMAC-SHA256 via WebCrypto.
 *
 * The old scrypt hashes cannot be verified on the Free plan (noble scrypt
 * exceeds the 1102 CPU limit), so Sold accounts are re-hashed to this format
 * during the R2 data migration. Hash format:
 *   pbkdf2$<iterations>$<saltHex>$<hashHex>
 */
import { PBKDF2_ITERATIONS, toHex, timingSafeEqualStr } from './const.js';

const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
    key,
    256
  );
  return toHex(new Uint8Array(bits));
}

export async function hashPassword(password, saltHex) {
  const hash = await pbkdf2Hex(password, saltHex, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hash}`;
}

export async function verifyPassword(password, account) {
  const stored = String((account && account.hash) || '');
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false; // legacy hash — unsupported on the edge
  const iterations = Number(parts[1]) || PBKDF2_ITERATIONS;
  const actual = await pbkdf2Hex(password, parts[2], iterations);
  return timingSafeEqualStr(actual, parts[3]);
}
