// SEC unit tests: TOTP against RFC 6238 Appendix B, Base32, replay window, recovery codes, secret encryption,
// IPv4/IPv6 CIDR matching, text fingerprint and the PDF watermark stamp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, hashRecoveryCode, hotp, matchRecoveryCode, mfaKey, newRecoveryCodes,
  otpauthUri, totp, verifyTotp, timeStep,
} from '../src/auth/totp.js';
import { cidrContains, ipInList, parseCidr, parseIp, formatIp } from '../src/auth/cidr.js';
import { fingerprintText, readFingerprint, stampPdf, wrapFooter } from '../src/content/watermark.js';

test('TOTP: RFC 6238 Appendix B test vectors (SHA1, SHA256, SHA512, 8 digits)', () => {
  const s1 = Buffer.from('12345678901234567890', 'ascii');
  const s256 = Buffer.from('12345678901234567890123456789012', 'ascii');
  const s512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'ascii');
  const vectors: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [t, sha1, sha256, sha512] of vectors) {
    assert.equal(totp(s1, t, { digits: 8 }), sha1, `SHA1 T=${t}`);
    assert.equal(totp(s256, t, { digits: 8, algorithm: 'sha256' }), sha256, `SHA256 T=${t}`);
    assert.equal(totp(s512, t, { digits: 8, algorithm: 'sha512' }), sha512, `SHA512 T=${t}`);
  }
  // RFC 4226 Appendix D HOTP values (6 digits)
  assert.deepEqual([0, 1, 2, 9].map((c) => hotp(s1, c)), ['755224', '287082', '359152', '520489']);
});

test('TOTP: base32 round trip and RFC 4648 vector', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('MZXW 6YTB OI======').toString(), 'foobar');
  const b = Buffer.from('12345678901234567890');
  assert.ok(base32Decode(base32Encode(b)).equals(b));
  assert.match(otpauthUri({ secret: b, issuer: 'TenderFlow KEA', account: 'vendor1@kea' }), /^otpauth:\/\/totp\/TenderFlow%20KEA%3Avendor1%40kea\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=TenderFlow\+KEA&algorithm=SHA1&digits=6&period=30$/);
});

test('TOTP: ±1 step window, malformed codes, and replay of an already-used step refused', () => {
  const s = Buffer.from('12345678901234567890');
  const t = 1_700_000_000;
  const step = timeStep(t);
  assert.equal(verifyTotp(s, totp(s, t), t), step);
  assert.equal(verifyTotp(s, totp(s, t - 30), t), step - 1);
  assert.equal(verifyTotp(s, totp(s, t + 30), t), step + 1);
  assert.equal(verifyTotp(s, totp(s, t - 60), t), null, 'two steps old');
  assert.equal(verifyTotp(s, '12345', t), null);
  assert.equal(verifyTotp(s, 'abcdef', t), null);
  assert.equal(verifyTotp(s, totp(s, t), t, step), null, 'same step again → replay');
  assert.equal(verifyTotp(s, totp(s, t + 30), t, step), step + 1, 'next step still fine');
});

test('recovery codes: 8 distinct codes, only hashes stored, match ignores case and dashes', () => {
  const codes = newRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const c of codes) assert.match(c, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  const hashes = codes.map(hashRecoveryCode);
  for (const h of hashes) { assert.match(h, /^scrypt\$/); assert.ok(!h.includes(codes[0])); }
  assert.equal(matchRecoveryCode(codes[3].toUpperCase().replace('-', ' '), hashes), 3);
  assert.equal(matchRecoveryCode('aaaaa-bbbbb', hashes), -1);
});

test('MFA secret encryption: AES-256-GCM bound to the user (AAD); key from MFA_ENC_KEY or derived', () => {
  const k = mfaKey(undefined, 'dev-audit-key-0123456789');
  assert.equal(k.length, 32);
  const secret = Buffer.from('12345678901234567890');
  const enc = encryptSecret(k, secret, 'mfa:t:u1');
  assert.ok(!enc.includes(secret.toString('base64')));
  assert.ok(decryptSecret(k, enc, 'mfa:t:u1').equals(secret));
  assert.throws(() => decryptSecret(k, enc, 'mfa:t:u2'), 'other user (AAD) fails');
  const k2 = mfaKey(Buffer.alloc(32, 7).toString('base64'), 'x'.repeat(20));
  assert.throws(() => decryptSecret(k2, enc, 'mfa:t:u1'), 'other key fails');
  assert.throws(() => mfaKey('c2hvcnQ=', 'x'.repeat(20)), /32 bytes/);
});

test('CIDR: IPv4 matching incl. prefixes 0/8/24/32 and IPv4-mapped IPv6 addresses', () => {
  assert.ok(ipInList('10.1.2.3', ['10.0.0.0/8']));
  assert.ok(!ipInList('11.1.2.3', ['10.0.0.0/8']));
  assert.ok(ipInList('192.168.5.77', ['192.168.5.0/24']));
  assert.ok(!ipInList('192.168.6.1', ['192.168.5.0/24']));
  assert.ok(ipInList('203.0.113.9', ['203.0.113.9']));
  assert.ok(ipInList('203.0.113.9', ['203.0.113.9/32']));
  assert.ok(!ipInList('203.0.113.10', ['203.0.113.9/32']));
  assert.ok(ipInList('8.8.8.8', ['0.0.0.0/0']));
  assert.ok(ipInList('172.16.31.200', ['172.16.0.0/12']));
  assert.ok(!ipInList('172.32.0.1', ['172.16.0.0/12']));
  assert.ok(ipInList('::ffff:10.9.8.7', ['10.0.0.0/8']), 'mapped address');
  assert.ok(ipInList('10.9.8.7', ['::ffff:10.0.0.0/104']), 'mapped CIDR');
  assert.ok(!ipInList('not-an-ip', ['0.0.0.0/0']));
  assert.ok(!ipInList('256.1.1.1', ['0.0.0.0/0']));
  assert.equal(parseCidr('10.1.2.3/8').text, '10.1.2.3/8');
  assert.throws(() => parseCidr('10.0.0.0/33'), /range/);
  assert.throws(() => parseCidr('10.0.0/8'), /Invalid/);
});

test('CIDR: IPv6 matching, compression, embedded IPv4 and zone ids', () => {
  assert.ok(ipInList('2001:db8::1', ['2001:db8::/32']));
  assert.ok(ipInList('2001:0db8:0000:0000:0000:ff00:0042:8329', ['2001:db8::/32']));
  assert.ok(!ipInList('2001:db9::1', ['2001:db8::/32']));
  assert.ok(ipInList('fe80::1%eth0', ['fe80::/10']));
  assert.ok(ipInList('fd12:3456:789a:1::5', ['fd12:3456:789a::/48']));
  assert.ok(!ipInList('fd12:3456:789b::5', ['fd12:3456:789a::/48']));
  assert.ok(ipInList('::1', ['::1/128']));
  assert.ok(!ipInList('::2', ['::1/128']));
  assert.ok(ipInList('64:ff9b::192.0.2.33', ['64:ff9b::/96']));
  assert.ok(!ipInList('10.0.0.1', ['::/0']), 'IPv4 never matches an IPv6 range');
  assert.equal(formatIp(parseIp('2001:0db8:0:0:0:0:0:1')!), '2001:db8::1');
  assert.equal(formatIp(parseIp('::')!), '::');
  assert.equal(parseIp('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(parseIp('1::2::3'), null);
  const c = parseCidr('2001:db8:abcd::/47');
  assert.ok(cidrContains(c, parseIp('2001:db8:abcd:1::1')!));
  assert.ok(!cidrContains(c, parseIp('2001:db8:abcf::1')!));
});

test('viewer text fingerprint: invisible, survives in the text and decodes to the view id prefix', () => {
  const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') + ' نطاق العمل والتوريد';
  const fp = fingerprintText(text, '9f8e7d6c-1111-2222-3333-444455556666');
  assert.equal(fp.replace(/[​⁠]/g, ''), text, 'visible text unchanged');
  assert.equal(readFingerprint(fp), '9f8e7d6c');
  assert.equal(readFingerprint('short text'), null);
});

test('stampPdf: every page carries the diagonal stamp and footer; original untouched; encrypted/garbage refused', async () => {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawText(`Section ${i + 1} — scope of work`, { x: 50, y: 780, size: 14, font: f });
  const original = Buffer.from(await doc.save());
  const copy = Buffer.from(original);
  const stamped = await stampPdf(original, { lines: ['ACME Trading (fictitious)', 'Vendor 1a2b3c4d · CR 77', 'user vendor1', '2026-10-10 09:00:00 UTC', 'ref deadbeef'],
    footer: 'Licensed to ACME Trading (fictitious) · vendor1 · ref deadbeef · receipt R-1' }, { id: 'deadbeef-0000' });
  assert.ok(original.equals(copy), 'input buffer not modified');
  const { extractText, getDocumentProxy } = await import('unpdf');
  const { text, totalPages } = await extractText(await getDocumentProxy(new Uint8Array(stamped)), { mergePages: false });
  assert.equal(totalPages, 3);
  for (const [i, pageText] of text.entries()) {
    assert.match(pageText, new RegExp(`Section ${i + 1}`), 'original content kept');
    assert.match(pageText, /ACME Trading \(fictitious\)/);
    assert.match(pageText, /Vendor 1a2b3c4d/);
    assert.match(pageText, /receipt R-1/);
  }
  const loaded = await PDFDocument.load(stamped);
  assert.match(loaded.getSubject() ?? '', /Licensed copy deadbeef-0000/);
  await assert.rejects(stampPdf(Buffer.from('%PDF-1.4 garbage'), { lines: ['x'], footer: 'x' }, { id: 'x' }), (e: any) => e.code === 'PDF_UNREADABLE' || e.code === 'PDF_ENCRYPTED');
});

test('wrapFooter: long footers wrap at separators and are never cut off', () => {
  const w = (s: string) => s.length;
  const footer = 'Licensed to A Very Long Vendor Name W.L.L. (fictitious) · Vendor 1a2b3c4d · CR-100001 · vendor1 · 2026-10-10 09:00:00 UTC · ref deadbeef · receipt GCIA-R-2026-00001';
  const lines = wrapFooter(footer, w, 60);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 60));
  assert.equal(lines.join(' · '), footer, 'nothing lost');
  assert.deepEqual(wrapFooter('x'.repeat(25), w, 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
});
