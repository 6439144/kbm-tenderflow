// IPv4 + IPv6 address and CIDR matching (no dependencies). IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are
// treated as their IPv4 address, so "10.0.0.0/8" matches a socket address reported as "::ffff:10.1.2.3".

export interface ParsedIp { v: 4 | 6; bytes: Uint8Array }

function parseV4(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255 || (parts[i].length > 1 && parts[i].startsWith('0'))) return null;
    out[i] = n;
  }
  return out;
}

function parseV6(input: string): Uint8Array | null {
  let s = input;
  const pct = s.indexOf('%'); // zone id (fe80::1%eth0)
  if (pct >= 0) s = s.slice(0, pct);
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail: number[] = [];
  // embedded IPv4 in the last 32 bits
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const toGroups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = toGroups(dbl[0]);
  const rest = dbl.length === 2 ? toGroups(dbl[1]) : [];
  const groups: number[] = [];
  for (const g of [...head, ...rest]) if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  const total = head.length + rest.length + tail.length;
  if (dbl.length === 1 && total !== 8) return null;
  if (dbl.length === 2 && total > 7) return null;
  groups.push(...head.map((g) => parseInt(g, 16)));
  if (dbl.length === 2) for (let i = 0; i < 8 - total; i++) groups.push(0);
  groups.push(...rest.map((g) => parseInt(g, 16)), ...tail);
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
  return out;
}

/** Parse an IP address; IPv4-mapped IPv6 is returned as IPv4. */
export function parseIp(raw: string): ParsedIp | null {
  const s = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  const v4 = parseV4(s);
  if (v4) return { v: 4, bytes: v4 };
  const v6 = parseV6(s);
  if (!v6) return null;
  const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  if (mapped) return { v: 4, bytes: v6.slice(12) };
  return { v: 6, bytes: v6 };
}

export interface Cidr { v: 4 | 6; bytes: Uint8Array; prefix: number; text: string }

/** Parse "a.b.c.d/n", "x::/n" or a bare address (= /32 or /128). Throws with a clear message. */
export function parseCidr(raw: string): Cidr {
  const s = String(raw ?? '').trim();
  const [addr, pre, extra] = s.split('/');
  if (extra !== undefined) throw new Error(`Invalid CIDR '${s}'`);
  const ip = parseIp(addr);
  if (!ip) throw new Error(`Invalid IP address in '${s}'`);
  const max = ip.v === 4 ? 32 : 128;
  // An IPv4-mapped IPv6 CIDR (::ffff:10.0.0.0/104) is converted to the IPv4 prefix.
  let prefix = max;
  if (pre !== undefined) {
    if (!/^\d{1,3}$/.test(pre)) throw new Error(`Invalid prefix length in '${s}'`);
    prefix = Number(pre);
    if (ip.v === 4 && addr.includes(':')) prefix -= 96;
    if (prefix < 0 || prefix > max) throw new Error(`Prefix length out of range in '${s}'`);
  }
  return { v: ip.v, bytes: ip.bytes, prefix, text: `${formatIp(ip)}/${prefix}` };
}

export function formatIp(ip: ParsedIp): string {
  if (ip.v === 4) return Array.from(ip.bytes).join('.');
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((ip.bytes[i] << 8) | ip.bytes[i + 1]);
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export function cidrContains(c: Cidr, ip: ParsedIp): boolean {
  if (c.v !== ip.v) return false;
  let bits = c.prefix;
  for (let i = 0; i < c.bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((c.bytes[i] & mask) !== (ip.bytes[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

export function ipInList(ipRaw: string, cidrs: (string | Cidr)[]): boolean {
  const ip = parseIp(ipRaw);
  if (!ip) return false;
  return cidrs.some((c) => cidrContains(typeof c === 'string' ? parseCidr(c) : c, ip));
}
