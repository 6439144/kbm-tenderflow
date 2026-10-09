// Outbound channels: e-mail over SMTP (nodemailer) and SMS through a generic HTTP adapter.
// Neither is ever simulated: a channel that is not configured is reported as such and nothing is "sent".
//
// SMS adapter contract (Kuwaiti providers differ, so the request is configured, not coded):
//   SMS_HTTP_URL            provider endpoint (required to enable SMS)
//   SMS_HTTP_METHOD         POST (default) | PUT | GET
//   SMS_HTTP_AUTH_HEADER    one header line, e.g. "Authorization: Bearer <token>" or "X-API-Key: <key>"
//   SMS_HTTP_CONTENT_TYPE   application/json (default) | application/x-www-form-urlencoded | text/plain
//   SMS_HTTP_BODY_TEMPLATE  request body with {to} {text} {sender}; values are JSON-escaped for JSON bodies and
//                           URL-encoded for form bodies (for GET the template is appended to the URL as the query)
//   SMS_SENDER              sender id substituted for {sender}
//   SMS_HTTP_MESSAGE_ID_PATH dotted path of the provider message id in a JSON response (e.g. "data.messageId")
// Any 2xx response is a successful hand-over to the provider; anything else is a failure (retried by the job).
import nodemailer from 'nodemailer';
import type { NotifyConfig } from '../../config.js';

export const emailConfigured = (c: NotifyConfig) => Boolean(c.smtp.host && c.smtp.from);
export const smsConfigured = (c: NotifyConfig) => Boolean(c.sms.url);

const transports = new WeakMap<NotifyConfig['smtp'], nodemailer.Transporter>();
function transportFor(c: NotifyConfig): nodemailer.Transporter {
  let t = transports.get(c.smtp);
  if (!t) {
    t = nodemailer.createTransport({
      host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure,
      auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass ?? '' } : undefined,
      tls: { rejectUnauthorized: c.smtp.rejectUnauthorized },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
    transports.set(c.smtp, t);
  }
  return t;
}

export async function sendEmail(c: NotifyConfig, m: { to: string; subject: string; text: string; html: string }): Promise<{ messageId: string | null }> {
  if (!emailConfigured(c)) throw new Error('E-mail is not configured (SMTP_HOST / SMTP_FROM)');
  const info = await transportFor(c).sendMail({ from: c.smtp.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  if (info.rejected?.length) throw new Error(`SMTP server rejected recipient(s): ${info.rejected.join(', ')}`);
  return { messageId: info.messageId ?? null };
}

function fill(template: string, vals: Record<string, string>, enc: (s: string) => string) {
  return template.replace(/\{(to|text|sender)\}/g, (_, k: string) => enc(vals[k] ?? ''));
}

function dig(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
}

export async function sendSms(c: NotifyConfig, m: { to: string; text: string }): Promise<{ messageId: string | null }> {
  if (!smsConfigured(c)) throw new Error('SMS is not configured (SMS_HTTP_URL)');
  const vals = { to: m.to, text: m.text, sender: c.sms.sender ?? '' };
  const ct = c.sms.contentType.toLowerCase();
  const headers: Record<string, string> = {};
  if (c.sms.authHeader) {
    const i = c.sms.authHeader.indexOf(':');
    if (i > 0) headers[c.sms.authHeader.slice(0, i).trim()] = c.sms.authHeader.slice(i + 1).trim();
  }
  let url = c.sms.url!;
  let body: string | undefined;
  if (c.sms.method === 'GET') {
    url += (url.includes('?') ? '&' : '?') + fill(c.sms.bodyTemplate, vals, encodeURIComponent);
  } else {
    headers['content-type'] = c.sms.contentType;
    body = ct.includes('json') ? fill(c.sms.bodyTemplate, vals, (s) => JSON.stringify(s).slice(1, -1))
      : ct.includes('x-www-form-urlencoded') ? fill(c.sms.bodyTemplate, vals, encodeURIComponent)
        : fill(c.sms.bodyTemplate, vals, (s) => s);
  }
  const res = await fetch(url, { method: c.sms.method, headers, body, signal: AbortSignal.timeout(c.sms.timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`SMS provider returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  let messageId: string | null = null;
  if (c.sms.messageIdPath) {
    try { const v = dig(JSON.parse(text), c.sms.messageIdPath); if (v !== undefined && v !== null) messageId = String(v); } catch { /* not JSON */ }
  }
  return { messageId };
}

/** What the admin pages may show about the channels (no secrets). */
export function channelStatus(c: NotifyConfig) {
  let smsHost: string | null = null;
  try { smsHost = c.sms.url ? new URL(c.sms.url).host : null; } catch { smsHost = 'invalid URL'; }
  return {
    IN_APP: { configured: true, detail: 'TenderFlow notifications (bell)' },
    EMAIL: { configured: emailConfigured(c), detail: emailConfigured(c) ? `${c.smtp.host}:${c.smtp.port}${c.smtp.secure ? ' (TLS)' : ''} from ${c.smtp.from}` : 'SMTP_HOST / SMTP_FROM not set' },
    SMS: { configured: smsConfigured(c), detail: smsConfigured(c) ? `${c.sms.method} ${smsHost}` : 'SMS_HTTP_URL not set' },
  };
}
