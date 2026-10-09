// Sealed-bid envelope encryption: per-bid 32-byte data key wrapped by BID_MASTER_KEY (AES-256-GCM),
// each bid file encrypted with the data key (AES-256-GCM, per-file IV/tag).
import crypto from 'node:crypto';

export interface Sealed { data: Buffer; iv: string; tag: string }

export function encrypt(key: Buffer, plain: Buffer, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { data, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function decrypt(key: Buffer, data: Buffer, iv: string, tag: string, aad: string): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(data), d.final()]);
}

export function newDataKey(): Buffer { return crypto.randomBytes(32); }

export function wrapKey(master: Buffer, dataKey: Buffer, bidId: string) {
  const s = encrypt(master, dataKey, `bid-key:${bidId}`);
  return { wrappedKey: s.data.toString('base64'), wrapIv: s.iv, wrapTag: s.tag };
}

export function unwrapKey(master: Buffer, bid: { id: string; wrapped_key: string; wrap_iv: string; wrap_tag: string }): Buffer {
  return decrypt(master, Buffer.from(bid.wrapped_key, 'base64'), bid.wrap_iv, bid.wrap_tag, `bid-key:${bid.id}`);
}
