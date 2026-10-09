// TEST-ONLY minimal SMTP server (RFC 5321 subset: EHLO/HELO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, RSET, NOOP, QUIT).
// No TLS is offered, so the client sends in plain text on the loopback interface. Messages are captured for assertions.
// `failNext` makes the next N transactions fail with a temporary 451 at MAIL FROM (to exercise retries).
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface CapturedMail { from: string; to: string[]; data: string; auth: string | null; id: string }
export interface FakeSmtp {
  port: number; env: Record<string, string>; messages: CapturedMail[]; failNext: number; connections: number; close(): Promise<void>;
}

export async function startFakeSmtp(opts: { user?: string; pass?: string } = {}): Promise<FakeSmtp> {
  const fake: FakeSmtp = { port: 0, env: {}, messages: [], failNext: 0, connections: 0, close: async () => undefined };
  const server = net.createServer((sock) => {
    fake.connections++;
    let buf = '';
    let inData = false;
    let authUser: string | null = null;
    let loginStep: 0 | 1 | 2 = 0;
    let loginUser = '';
    let cur: { from: string; to: string[] } | null = null;
    const say = (s: string) => sock.write(`${s}\r\n`);
    say('220 fake-smtp.test ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buf = buf.slice(end + 5);
          inData = false;
          const id = `${randomUUID()}@fake-smtp.test`;
          fake.messages.push({ from: cur!.from, to: cur!.to, data, auth: authUser, id });
          cur = null;
          say(`250 2.0.0 OK queued as ${id}`);
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) {
          const pass = Buffer.from(line, 'base64').toString();
          loginStep = 0;
          if (loginUser === opts.user && pass === opts.pass) { authUser = loginUser; say('235 2.7.0 Authentication successful'); } else say('535 5.7.8 Authentication failed');
          continue;
        }
        const [cmdRaw, ...rest] = line.split(' ');
        const cmd = cmdRaw.toUpperCase();
        const arg = rest.join(' ');
        if (cmd === 'EHLO') { sock.write(`250-fake-smtp.test\r\n${opts.user ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 8BITMIME\r\n`); }
        else if (cmd === 'HELO') say('250 fake-smtp.test');
        else if (cmd === 'AUTH') {
          const [mech, payload] = arg.split(' ');
          if (mech?.toUpperCase() === 'PLAIN') {
            const [, u, p] = Buffer.from(payload ?? '', 'base64').toString().split('\u0000');
            if (u === opts.user && p === opts.pass) { authUser = u; say('235 2.7.0 Authentication successful'); } else say('535 5.7.8 Authentication failed');
          } else if (mech?.toUpperCase() === 'LOGIN') { loginStep = 1; say('334 VXNlcm5hbWU6'); }
          else say('504 5.5.4 Unrecognized authentication type');
        } else if (cmd === 'MAIL') {
          if (opts.user && !authUser) { say('530 5.7.0 Authentication required'); continue; }
          if (fake.failNext > 0) { fake.failNext--; say('451 4.3.0 Temporary failure, try again later'); continue; }
          cur = { from: /<([^>]*)>/.exec(arg)?.[1] ?? '', to: [] };
          say('250 2.1.0 OK');
        } else if (cmd === 'RCPT') {
          const to = /<([^>]*)>/.exec(arg)?.[1] ?? '';
          if (!cur) { say('503 5.5.1 MAIL first'); continue; }
          if (to.includes('reject')) { say('550 5.1.1 No such user'); continue; }
          cur.to.push(to);
          say('250 2.1.5 OK');
        } else if (cmd === 'DATA') {
          if (!cur?.to.length) { say('503 5.5.1 RCPT first'); continue; }
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'RSET') { cur = null; say('250 OK'); }
        else if (cmd === 'NOOP') say('250 OK');
        else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); return; }
        else say('502 5.5.2 Command not implemented');
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.port = (server.address() as AddressInfo).port;
  fake.env = {
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(fake.port), SMTP_SECURE: 'false', SMTP_FROM: 'TenderFlow <tenderflow@entity.test>',
    ...(opts.user ? { SMTP_USER: opts.user, SMTP_PASS: opts.pass ?? '' } : {}),
  };
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

/** Decode a captured message's quoted-printable / base64 text parts well enough for assertions. */
export function mailText(m: CapturedMail): string {
  const out: string[] = [];
  const parts = m.data.split(/\r\n--[^\r\n]+\r\n/);
  for (const p of parts) {
    const [head, ...body] = p.split('\r\n\r\n');
    const b = body.join('\r\n\r\n');
    if (/content-transfer-encoding:\s*base64/i.test(head)) out.push(Buffer.from(b.replace(/\s+/g, ''), 'base64').toString('utf8'));
    else if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      out.push(Buffer.from(b.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
    } else out.push(b);
  }
  return out.join('\n');
}
