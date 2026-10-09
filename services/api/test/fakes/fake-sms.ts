// TEST-ONLY fake SMS HTTP provider: records every request; `statuses` scripts the HTTP status of the next calls
// (default 200 with {"data":{"messageId":"sms-<n>"}}).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SmsCall { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
export interface FakeSms { base: string; calls: SmsCall[]; statuses: number[]; env: Record<string, string>; close(): Promise<void> }

export async function startFakeSms(): Promise<FakeSms> {
  const fake: FakeSms = { base: '', calls: [], statuses: [], env: {}, close: async () => undefined };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fake.calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const status = fake.statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status < 300 ? JSON.stringify({ data: { messageId: `sms-${fake.calls.length}` } }) : JSON.stringify({ error: 'provider unavailable' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.env = {
    SMS_HTTP_URL: `${fake.base}/v1/sms/send`, SMS_HTTP_METHOD: 'POST', SMS_HTTP_AUTH_HEADER: 'Authorization: Bearer sms-test-token',
    SMS_HTTP_CONTENT_TYPE: 'application/json', SMS_HTTP_BODY_TEMPLATE: '{"recipient":"{to}","sender":"{sender}","message":"{text}"}',
    SMS_SENDER: 'TENDERFLOW', SMS_HTTP_MESSAGE_ID_PATH: 'data.messageId',
  };
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
