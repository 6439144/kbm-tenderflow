// Sends QUEUED e-mail / SMS deliveries and retries failures with exponential back-off (max 3 attempts).
// Runs as the `notification-deliveries` job and right after a transaction queued something.
import type { Ctx } from '../../ctx.js';
import { escapeHtml, now } from '../../util.js';
import { emailConfigured, sendEmail, sendSms, smsConfigured } from './channels.js';

export const MAX_ATTEMPTS = 3;

interface Row {
  id: string; tenant_id: string; channel: 'EMAIL' | 'SMS' | 'IN_APP'; address: string | null; subject: string; body: string; attempts: number; is_test: boolean;
}

function html(subject: string, body: string) {
  const paras = body.split(/\n{2,}/).map((p) => (/^[—\s]+$/.test(p) ? '<hr>' : `<p dir="auto" style="white-space:pre-wrap;margin:0 0 12px">${escapeHtml(p)}</p>`)).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Tahoma,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1b2733">${paras}
<p style="color:#6b7785;font-size:12px" dir="auto">TenderFlow — automated message / رسالة آلية</p></body></html>`;
}

export async function dispatchDue(ctx: Ctx, opts: { tenantId?: string; ids?: string[]; limit?: number } = {}) {
  const at = now();
  const rows = await ctx.db.query<Row>(
    `UPDATE notification_deliveries SET locked_until=$1, updated_at=$2
      WHERE id IN (SELECT id FROM notification_deliveries
                    WHERE status='QUEUED' AND channel IN ('EMAIL','SMS') AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
                      AND (locked_until IS NULL OR locked_until < $2) AND ($3::text IS NULL OR tenant_id=$3)
                      AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
                    ORDER BY created_at LIMIT $5)
      RETURNING id, tenant_id, channel, address, subject, body, attempts, is_test`,
    [new Date(at.getTime() + 2 * 60_000), at, opts.tenantId ?? null, opts.ids ?? null, opts.limit ?? 100]);
  const out = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
  const cfg = ctx.config.notify;
  for (const d of rows) {
    const attempts = d.attempts + 1;
    const configured = d.channel === 'EMAIL' ? emailConfigured(cfg) : smsConfigured(cfg);
    if (!configured) {
      await ctx.db.query(`UPDATE notification_deliveries SET status='SKIPPED_NOT_CONFIGURED', locked_until=NULL, updated_at=$2,
                            error='channel is no longer configured' WHERE id=$1`, [d.id, now()]);
      out.skipped++;
      continue;
    }
    try {
      const r = d.channel === 'EMAIL'
        ? await sendEmail(cfg, { to: d.address!, subject: d.subject, text: d.body, html: html(d.subject, d.body) })
        : await sendSms(cfg, { to: d.address!, text: d.body });
      await ctx.db.query(`UPDATE notification_deliveries SET status='SENT', provider_message_id=$2, attempts=$3, sent_at=$4, updated_at=$4,
                            locked_until=NULL, error=NULL, next_attempt_at=NULL WHERE id=$1`, [d.id, r.messageId, attempts, now()]);
      out.sent++;
    } catch (err) {
      const msg = ((err as Error)?.message ?? String(err)).slice(0, 1000);
      const final = attempts >= MAX_ATTEMPTS;
      const next = final ? null : new Date(now().getTime() + cfg.retryBaseMs * 2 ** (attempts - 1));
      await ctx.db.query(`UPDATE notification_deliveries SET status=$2, attempts=$3, error=$4, next_attempt_at=$5, locked_until=NULL, updated_at=$6 WHERE id=$1`,
        [d.id, final ? 'FAILED' : 'QUEUED', attempts, msg, next, now()]);
      if (final) out.failed++; else out.retrying++;
    }
  }
  return { claimed: rows.length, ...out };
}
