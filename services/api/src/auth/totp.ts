// TOTP (RFC 6238 / RFC 4226) with node:crypto only: HMAC-SHA1, 30-second steps, 6 digits, ±1 step window.
// Plus Base32 (RFC 4648), one-time recovery codes (only scrypt hashes are stored) and AES-256-GCM encryption
// of the shared secret at rest (key = MFA_ENC_KEY, or HKDF-derived from AUDIT_SIGNING_KEY).
import crypto from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226 §5.3) for a counter value; algorithm selectable for the RFC 6238 test vectors. */
export function hotp(secret: Buffer, counter: number | bigint, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (unixSeconds: number, step = TOTP_STEP_SECONDS) => Math.floor(unixSeconds / step);

export function totp(secret: Buffer, unixSeconds = Date.now() / 1000, opts: { digits?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {}): string {
  return hotp(secret, timeStep(unixSeconds), opts.digits ?? TOTP_DIGITS, opts.algorithm ?? 'sha1');
}

/**
 * Verify a 6-digit code within ±window steps. Returns the matched time step (for replay protection: the caller
 * stores it and refuses any step ≤ the last accepted one), or null.
 */
export function verifyTotp(secret: Buffer, code: string, unixSeconds = Date.now() / 1000, lastUsedStep: number | null = null, window = TOTP_WINDOW): number | null {
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = timeStep(unixSeconds);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

export const newTotpSecret = () => crypto.randomBytes(20); // 160 bits, as recommended by RFC 4226

export function otpauthUri(opts: { secret: Buffer; issuer: string; account: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const p = new URLSearchParams({ secret: base32Encode(opts.secret), issuer: opts.issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${p.toString()}`;
}

// ---------------- recovery codes ----------------
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i

export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(10);
    const s = Array.from(bytes, (b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5, 10)}`;
  });
}

export const normaliseRecoveryCode = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** scrypt hash "scrypt$<salt b64>$<hash b64>" of a normalised recovery code. */
export function hashRecoveryCode(code: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(normaliseRecoveryCode(code), salt, 32);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function matchRecoveryCode(code: string, hashes: string[]): number {
  const n = normaliseRecoveryCode(code);
  if (n.length !== 10) return -1;
  let found = -1;
  hashes.forEach((stored, i) => {
    const [alg, saltB64, hashB64] = stored.split('$');
    if (alg !== 'scrypt' || !saltB64 || !hashB64) return;
    const h = crypto.scryptSync(n, Buffer.from(saltB64, 'base64'), 32);
    if (crypto.timingSafeEqual(h, Buffer.from(hashB64, 'base64')) && found < 0) found = i;
  });
  return found;
}

// ---------------- secret encryption at rest ----------------
export function mfaKey(mfaEncKey: string | undefined, auditSigningKey: string): Buffer {
  if (mfaEncKey) {
    const k = Buffer.from(mfaEncKey, 'base64');
    if (k.length !== 32) throw new Error('MFA_ENC_KEY must be base64 of exactly 32 bytes');
    return k;
  }
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(auditSigningKey, 'utf8'), Buffer.from('tenderflow-mfa-salt'), Buffer.from('tenderflow/mfa-secret/v1'), 32));
}

export function encryptSecret(key: Buffer, secret: Buffer, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(secret), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

export function decryptSecret(key: Buffer, enc: string, aad: string): Buffer {
  const [v, iv, tag, data] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unknown MFA secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]);
}
