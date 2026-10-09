// Notifications (BRD NOT-001..005 + TenderFlow events). Every call is rendered from the entity's notification
// template (EN + AR, admin-editable) and delivered in-app; e-mail / SMS are queued when the template enables them and
// the channel is configured (features/notify/*, docs/NOTIFICATIONS-AND-ESCALATION.md). The exported signatures below
// are the stable API other features call.
// Tender alerts are rule-based (category + eligibility rule); the Orchestrate relevance agent may add a ranked
// "tenders for you" list on top, but notifications never depend on AI.
import type { Ctx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { camel, isUuid, notFound, now } from '../util.js';
import { checkEligibility } from './eligibility.js';
import type { TenderRow } from './tenders.js';
import { deliver, type DeliverResult } from '../features/notify/engine.js';

export type { DeliverResult };

/**
 * Notify one user or one vendor. `kind` is the event; `templateCode` (optional, defaults to `kind`) selects the
 * notification template — e.g. 'NOT-001_SUBSCRIPTION_RENEWAL' or the short form 'NOT-001'. titleEn/titleAr are used
 * as the {title} placeholder and as the in-app title when no template exists for the code. `body` values are
 * available as placeholders ({expiryDate}, {knetLink} …; `xEn` / `xAr` give language-specific values).
 */
export async function notify(q: Queryable, n: { tenantId: string; userId?: string | null; vendorId?: string | null; kind: string; titleEn: string; titleAr: string; body?: Record<string, unknown>; templateCode?: string }): Promise<DeliverResult> {
  return deliver(q, n);
}

/** Notify approved vendors in the tender's category who meet its eligibility rule. Returns the count. */
export async function notifyVendorsOfTender(_ctx: Ctx, q: Queryable, t: TenderRow): Promise<number> {
  const vendors = await q.query<{ id: string }>(
    `SELECT id FROM vendors WHERE tenant_id=$1 AND status='APPROVED' AND $2 = ANY(categories)`, [t.tenant_id, t.category]);
  let n = 0;
  for (const v of vendors) {
    const e = await checkEligibility(q, t, v.id);
    if (!e.eligible) continue;
    await notify(q, { tenantId: t.tenant_id, vendorId: v.id, kind: 'TENDER_PUBLISHED',
      titleEn: `New tender for your activity: ${t.tender_number} — ${t.title_en}`, titleAr: `مناقصة جديدة ضمن نشاطك: ${t.tender_number} — ${t.title_ar}`,
      body: { tenderId: t.id, deadline: new Date(t.submission_deadline).toISOString() } });
    n++;
  }
  return n;
}

/** Notify every active user holding a role (e.g. the next approver in a chain). */
export async function notifyRole(q: Queryable, tenantId: string, role: string, n: { kind: string; titleEn: string; titleAr: string; body?: Record<string, unknown>; templateCode?: string }) {
  const users = await q.query<{ id: string }>(`SELECT id FROM users WHERE tenant_id=$1 AND active AND $2 = ANY(roles)`, [tenantId, role]);
  for (const u of users) await notify(q, { tenantId, userId: u.id, ...n });
  return users.length;
}

export async function myNotifications(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db.query(
    `SELECT id, kind, title_en, title_ar, body, read_at, created_at FROM notifications
      WHERE tenant_id=$1 AND (user_id=$2 OR ($3::uuid IS NOT NULL AND vendor_id=$3::uuid)) ORDER BY created_at DESC LIMIT 50`,
    [actor.tenantId, actor.id, actor.vendorId ?? null]);
  return camel(rows);
}

export async function markRead(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Notification');
  const rows = await ctx.db.query(
    `UPDATE notifications SET read_at=$1 WHERE id=$2 AND tenant_id=$3 AND (user_id=$4 OR ($5::uuid IS NOT NULL AND vendor_id=$5::uuid)) RETURNING id`,
    [now(), id, actor.tenantId, actor.id, actor.vendorId ?? null]);
  if (!rows.length) throw notFound('Notification');
  return { ok: true };
}
