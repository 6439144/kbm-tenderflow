// Entity administration of notifications: templates (EN + AR texts, channels, on/off, preview, test send),
// delivery log, staff notification contacts. Every change is audited in the same transaction.
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { badRequest, camel, conflict, isUuid, notFound, now, str } from '../../util.js';
import { CHANNELS, COMMON_PLACEHOLDERS, DEFAULT_TEMPLATES, defaultTemplate, OPTIONAL_CHANNELS, SAMPLE_VALUES, type Channel } from './defaults.js';
import { allowedPlaceholders, deliver, findTemplate, installDefaultTemplates, placeholdersIn, render, resolveCode, type TemplateRow } from './engine.js';
import { channelStatus } from './channels.js';
import { dispatchDue } from './dispatcher.js';

const pubTemplate = (t: TemplateRow) => {
  const d = defaultTemplate(t.code);
  return {
    code: t.code, audience: t.audience, channels: t.channels, enabled: t.enabled,
    subjectEn: t.subject_en, subjectAr: t.subject_ar, bodyEn: t.body_en, bodyAr: t.body_ar,
    source: d?.source ?? 'CUSTOM', mandatory: Boolean(d?.mandatory), placeholders: allowedPlaceholders(t.code),
    isDefaultText: Boolean(d && d.subjectEn === t.subject_en && d.subjectAr === t.subject_ar && d.bodyEn === t.body_en && d.bodyAr === t.body_ar),
    updatedBy: t.updated_by, updatedAt: t.updated_at,
  };
};

export async function listTemplates(ctx: Ctx, actor: Actor) {
  await ctx.db.tx((q) => installDefaultTemplates(q, actor.tenantId));
  const rows = await ctx.db.query<TemplateRow>('SELECT * FROM notification_templates WHERE tenant_id=$1', [actor.tenantId]);
  const order = (c: string) => { const i = DEFAULT_TEMPLATES.findIndex((d) => d.code === c); return i < 0 ? 999 : i; };
  return { channels: channelStatus(ctx.config.notify), templates: rows.sort((a, b) => order(a.code) - order(b.code)).map(pubTemplate) };
}

async function loadTpl(ctx: Ctx, actor: Actor, code: string) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{2,80}$/.test(code)) throw notFound('Notification template');
  const t = await ctx.db.tx((q) => findTemplate(q, actor.tenantId, code));
  if (!t) throw notFound('Notification template');
  return t;
}

export async function getTemplate(ctx: Ctx, actor: Actor, code: string) {
  return pubTemplate(await loadTpl(ctx, actor, code));
}

const TEXT_LIMITS = { subjectEn: 300, subjectAr: 300, bodyEn: 4000, bodyAr: 4000 } as const;

function parseTexts(b: any, cur: { subjectEn: string; subjectAr: string; bodyEn: string; bodyAr: string }, code: string) {
  const out = { ...cur };
  for (const k of Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[]) {
    if (b?.[k] === undefined) continue;
    const v = str(b[k], k, { max: TEXT_LIMITS[k], required: true })!;
    out[k] = v;
  }
  const allowed = new Set(allowedPlaceholders(code));
  const unknown = [...new Set(Object.values(out).flatMap(placeholdersIn))].filter((p) => !allowed.has(p));
  return { texts: out, unknown };
}

export async function previewTemplate(ctx: Ctx, actor: Actor, code: string, b: any) {
  const t = await loadTpl(ctx, actor, code);
  const { texts, unknown } = parseTexts(b, { subjectEn: t.subject_en, subjectAr: t.subject_ar, bodyEn: t.body_en, bodyAr: t.body_ar }, t.code);
  const ent = (await ctx.db.query<any>('SELECT name_en, name_ar FROM tenants WHERE id=$1', [actor.tenantId]))[0];
  const vars = { ...SAMPLE_VALUES, entityNameEn: ent?.name_en ?? SAMPLE_VALUES.entityNameEn, entityNameAr: ent?.name_ar ?? SAMPLE_VALUES.entityNameAr };
  return {
    en: { subject: render(texts.subjectEn, vars, 'en'), body: render(texts.bodyEn, vars, 'en') },
    ar: { subject: render(texts.subjectAr, vars, 'ar'), body: render(texts.bodyAr, vars, 'ar') },
    unknownPlaceholders: unknown, placeholders: allowedPlaceholders(t.code), sampleValues: vars,
  };
}

export async function updateTemplate(ctx: Ctx, actor: Actor, code: string, b: any) {
  const t = await loadTpl(ctx, actor, code);
  const { texts, unknown } = parseTexts(b, { subjectEn: t.subject_en, subjectAr: t.subject_ar, bodyEn: t.body_en, bodyAr: t.body_ar }, t.code);
  if (unknown.length) throw badRequest(`Unknown placeholder(s): ${unknown.map((p) => `{${p}}`).join(', ')}. Allowed: ${allowedPlaceholders(t.code).map((p) => `{${p}}`).join(' ')}`, 'UNKNOWN_PLACEHOLDER');
  let channels = t.channels;
  if (b?.channels !== undefined) {
    if (!Array.isArray(b.channels) || b.channels.some((c: unknown) => !CHANNELS.includes(c as Channel))) throw badRequest(`channels must be a subset of ${CHANNELS.join(', ')}`);
    channels = ['IN_APP', ...OPTIONAL_CHANNELS.filter((c) => b.channels.includes(c))];
  }
  const enabled = b?.enabled === undefined ? t.enabled : b.enabled;
  if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false');
  if (b?.reset === true) {
    const d = defaultTemplate(t.code);
    if (!d) throw conflict('NO_DEFAULT', 'This template has no default text');
    Object.assign(texts, { subjectEn: d.subjectEn, subjectAr: d.subjectAr, bodyEn: d.bodyEn, bodyAr: d.bodyAr });
  }
  const before = { subjectEn: t.subject_en, subjectAr: t.subject_ar, bodyEn: t.body_en, bodyAr: t.body_ar, channels: t.channels, enabled: t.enabled };
  const after = { ...texts, channels, enabled };
  const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (!changed.length) return pubTemplate(t);
  const row = await ctx.db.tx(async (q) => {
    const rows = await q.query<TemplateRow>(
      `UPDATE notification_templates SET subject_en=$1, subject_ar=$2, body_en=$3, body_ar=$4, channels=$5::text[], enabled=$6, updated_by=$7, updated_at=$8
        WHERE id=$9 AND tenant_id=$10 RETURNING *`,
      [texts.subjectEn, texts.subjectAr, texts.bodyEn, texts.bodyAr, channels, enabled, actor.id, now(), t.id, actor.tenantId]);
    const clip = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, typeof o[k] === 'string' ? (o[k] as string).slice(0, 600) : o[k]]));
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'NOTIFICATION_TEMPLATE_UPDATED', resourceType: 'NOTIFICATION_TEMPLATE', resourceId: t.code,
      details: { code: t.code, changed, before: clip(before), after: clip(after), reset: b?.reset === true } });
    return rows[0];
  });
  return pubTemplate(row);
}

/** Send the template (sample values, marked TEST) to the signed-in admin on every enabled channel, and send it now. */
export async function sendTest(ctx: Ctx, actor: Actor, code: string) {
  const t = await loadTpl(ctx, actor, code);
  if (!t.enabled) throw conflict('TEMPLATE_DISABLED', 'Enable the template before sending a test');
  const res = await ctx.db.tx(async (q) => {
    const r = await deliver(q, { tenantId: actor.tenantId, userId: actor.id, vendorId: null, kind: 'NOTIFICATION_TEST', templateCode: t.code, isTest: true,
      titleEn: SAMPLE_VALUES.titleEn, titleAr: SAMPLE_VALUES.titleAr,
      body: Object.fromEntries(Object.entries(SAMPLE_VALUES).filter(([k]) => !/^(entityName|recipientName|link)/.test(k))) });
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'NOTIFICATION_TEST_SENT', resourceType: 'NOTIFICATION_TEMPLATE', resourceId: t.code,
      details: { code: t.code, deliveries: r.deliveries.map((d) => ({ channel: d.channel, status: d.status })) } });
    return r;
  });
  const queued = res.deliveries.filter((d) => d.status === 'QUEUED').map((d) => d.id);
  if (queued.length) await dispatchDue(ctx, { tenantId: actor.tenantId, ids: queued });
  const rows = await ctx.db.query<any>(
    `SELECT id, channel, status, address, error, provider_message_id, attempts FROM notification_deliveries WHERE id = ANY($1::uuid[]) AND tenant_id=$2 ORDER BY channel`,
    [res.deliveries.map((d) => d.id), actor.tenantId]);
  return { templateCode: t.code, deliveries: camel(rows) };
}

// ------------------------------------------------------------------ delivery log

const STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED_NOT_CONFIGURED', 'SKIPPED_NO_ADDRESS'];

export async function deliveries(ctx: Ctx, actor: Actor, f: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const status = s(f.status); const channel = s(f.channel); const code = s(f.templateCode); const qtext = s(f.q);
  if (status && !STATUSES.includes(status)) throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  if (channel && !CHANNELS.includes(channel as Channel)) throw badRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  const limit = Math.min(Math.max(Number(f.limit) || 100, 1), 500);
  const rows = await ctx.db.query<any>(
    `SELECT id, notification_id, template_code, channel, recipient_user_id, recipient_vendor_id, recipient_label, address, lang, subject, status,
            provider_message_id, error, attempts, next_attempt_at, is_test, created_at, updated_at, sent_at
       FROM notification_deliveries
      WHERE tenant_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR channel=$3) AND ($4::text IS NULL OR template_code=$4)
        AND ($5::text IS NULL OR recipient_label ILIKE '%' || $5 || '%' OR address ILIKE '%' || $5 || '%' OR subject ILIKE '%' || $5 || '%')
      ORDER BY created_at DESC, channel LIMIT $6`, [actor.tenantId, status, channel, code ? resolveCode(code) : null, qtext, limit]);
  const counts = await ctx.db.query<{ status: string; channel: string; n: string }>(
    `SELECT status, channel, count(*)::text AS n FROM notification_deliveries WHERE tenant_id=$1 GROUP BY status, channel`, [actor.tenantId]);
  const codes = await ctx.db.query<{ template_code: string }>(`SELECT DISTINCT template_code FROM notification_deliveries WHERE tenant_id=$1 ORDER BY 1`, [actor.tenantId]);
  return {
    channels: channelStatus(ctx.config.notify),
    counts: counts.map((c) => ({ status: c.status, channel: c.channel, n: Number(c.n) })),
    templateCodes: codes.map((c) => c.template_code),
    items: camel(rows),
  };
}

/** Put a FAILED e-mail / SMS back in the queue (fresh 3 attempts). */
export async function retryDelivery(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Delivery');
  return ctx.db.tx(async (q) => {
    const rows = await q.query<any>(
      `UPDATE notification_deliveries SET status='QUEUED', attempts=0, next_attempt_at=$1, locked_until=NULL, updated_at=$1
        WHERE id=$2 AND tenant_id=$3 AND status='FAILED' AND channel IN ('EMAIL','SMS') RETURNING id, channel, template_code`, [now(), id, actor.tenantId]);
    if (!rows[0]) throw conflict('INVALID_STATE', 'Only a FAILED e-mail or SMS delivery can be retried');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'NOTIFICATION_DELIVERY_REQUEUED', resourceType: 'NOTIFICATION_DELIVERY', resourceId: id,
      prevState: 'FAILED', newState: 'QUEUED', details: { channel: rows[0].channel, templateCode: rows[0].template_code } });
    return { ok: true, id };
  });
}

// ------------------------------------------------------------------ contacts (staff users)

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const PHONE_RE = /^\+?[0-9 ()-]{6,20}$/;

export async function myContact(ctx: Ctx, actor: Actor) {
  const r = (await ctx.db.query<any>('SELECT email, phone, updated_at FROM notification_contacts WHERE tenant_id=$1 AND user_id=$2', [actor.tenantId, actor.id]))[0];
  return { email: r?.email ?? null, phone: r?.phone ?? null, updatedAt: r?.updated_at ?? null };
}

export async function setContact(ctx: Ctx, actor: Actor, userId: string, b: any) {
  if (!isUuid(userId)) throw notFound('User');
  const u = (await ctx.db.query<any>('SELECT id, vendor_id FROM users WHERE id=$1 AND tenant_id=$2', [userId, actor.tenantId]))[0];
  if (!u) throw notFound('User');
  if (u.vendor_id) throw conflict('VENDOR_USER', 'Vendor users are notified at the e-mail / phone of their vendor record');
  const email = str(b?.email, 'email', { max: 200 }) ?? null;
  const phone = str(b?.phone, 'phone', { max: 30 }) ?? null;
  if (email && !EMAIL_RE.test(email)) throw badRequest('email is not a valid address');
  if (phone && !PHONE_RE.test(phone)) throw badRequest('phone must be digits, optionally with +, spaces, () or -');
  await ctx.db.tx(async (q) => {
    await q.query(`INSERT INTO notification_contacts (tenant_id, user_id, email, phone, updated_at) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (tenant_id, user_id) DO UPDATE SET email=EXCLUDED.email, phone=EXCLUDED.phone, updated_at=EXCLUDED.updated_at`,
      [actor.tenantId, userId, email, phone, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'NOTIFICATION_CONTACT_UPDATED', resourceType: 'USER', resourceId: userId,
      details: { email: Boolean(email), phone: Boolean(phone) } });
  });
  return { email, phone };
}

export const PLACEHOLDER_HELP = COMMON_PLACEHOLDERS;
