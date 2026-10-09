// Notification engine: template lookup (installed lazily per entity), placeholder rendering in both languages,
// recipient resolution and the delivery log. Called inside the caller's transaction (`q`), so a notification is
// recorded atomically with the state change that caused it. E-mail / SMS are only QUEUED here; the delivery job
// (dispatcher.ts) sends them after commit and retries failures.
import type { Queryable } from '../../db.js';
import { loadNotifyConfig, type NotifyConfig } from '../../config.js';
import { isUuid, now, uuid } from '../../util.js';
import { COMMON_PLACEHOLDERS, DEFAULT_TEMPLATES, defaultTemplate, type Channel, type DefaultTemplate } from './defaults.js';
import { emailConfigured, smsConfigured } from './channels.js';

/** Set by the notify feature when the app starts (features/notify.ts); before that (demo seed) the environment is read. */
export const notifyRuntime: { config: NotifyConfig | null; publicBaseUrl: string; kick: (() => void) | null } = {
  config: null, publicBaseUrl: '', kick: null,
};
const runtimeConfig = (): NotifyConfig => notifyRuntime.config ?? loadNotifyConfig(process.env);
const baseUrl = () => notifyRuntime.publicBaseUrl || (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

export interface TemplateRow {
  id: string; tenant_id: string; code: string; audience: 'VENDOR' | 'STAFF'; channels: Channel[]; enabled: boolean;
  subject_en: string; subject_ar: string; body_en: string; body_ar: string; updated_by: string | null; updated_at: Date; created_at: Date;
}

async function insertDefault(q: Queryable, tenantId: string, d: DefaultTemplate) {
  await q.query(`INSERT INTO notification_templates (id, tenant_id, code, audience, channels, enabled, subject_en, subject_ar, body_en, body_ar, updated_by, updated_at, created_at)
                 VALUES ($1,$2,$3,$4,$5::text[],true,$6,$7,$8,$9,'SYSTEM',$10,$10) ON CONFLICT (tenant_id, code) DO NOTHING`,
    [uuid(), tenantId, d.code, d.audience, d.channels, d.subjectEn, d.subjectAr, d.bodyEn, d.bodyAr, now()]);
}

/** Install every default template the entity does not have yet (edited templates are never overwritten). */
export async function installDefaultTemplates(q: Queryable, tenantId: string): Promise<number> {
  const have = new Set((await q.query<{ code: string }>('SELECT code FROM notification_templates WHERE tenant_id=$1', [tenantId])).map((r) => r.code));
  let n = 0;
  for (const d of DEFAULT_TEMPLATES) if (!have.has(d.code)) { await insertDefault(q, tenantId, d); n++; }
  return n;
}

/** Resolve a code to the default it names: exact code, or the BRD short form "NOT-001" → "NOT-001_SUBSCRIPTION_RENEWAL". */
export function resolveCode(code: string): string {
  if (defaultTemplate(code)) return code;
  const short = /^NOT-\d{3}$/.test(code) ? DEFAULT_TEMPLATES.find((d) => d.code.startsWith(`${code}_`)) : undefined;
  return short?.code ?? code;
}

export async function findTemplate(q: Queryable, tenantId: string, rawCode: string): Promise<TemplateRow | null> {
  const code = resolveCode(rawCode);
  const sel = () => q.query<TemplateRow>('SELECT * FROM notification_templates WHERE tenant_id=$1 AND code=$2', [tenantId, code]);
  let rows = await sel();
  if (!rows[0]) {
    const d = defaultTemplate(code);
    if (!d) return null;
    await insertDefault(q, tenantId, d);
    rows = await sel();
  }
  return rows[0] ?? null;
}

export const placeholdersIn = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))];
export const allowedPlaceholders = (code: string) => [...COMMON_PLACEHOLDERS, ...(defaultTemplate(code)?.placeholders ?? [])];

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function fmtDateTime(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function fmtValue(v: unknown): string {
  if (v instanceof Date) return fmtDateTime(v);
  if (typeof v === 'string' && ISO_DT.test(v) && !Number.isNaN(Date.parse(v))) return fmtDateTime(new Date(v));
  if (Array.isArray(v)) return v.map(fmtValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Replace {name} with vars[name + 'En' | 'Ar'] ?? vars[name]; missing values render as "—" (never invented). */
export function render(text: string, vars: Record<string, unknown>, lang: 'en' | 'ar'): string {
  const suffix = lang === 'ar' ? 'Ar' : 'En';
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = vars[name + suffix] ?? vars[name];
    return v === undefined || v === null || v === '' ? '—' : fmtValue(v);
  });
}

interface Recipient {
  userId: string | null; vendorId: string | null; isVendor: boolean; label: string;
  nameEn: string; nameAr: string; email: string | null; phone: string | null;
}

async function recipientOf(q: Queryable, tenantId: string, n: { userId?: string | null; vendorId?: string | null }): Promise<Recipient> {
  const out: Recipient = { userId: n.userId ?? null, vendorId: n.vendorId ?? null, isVendor: Boolean(n.vendorId), label: '', nameEn: '', nameAr: '', email: null, phone: null };
  let vendorId = n.vendorId ?? null;
  if (n.userId && isUuid(n.userId)) {
    const u = (await q.query<any>(
      `SELECT u.display_name, u.username, u.vendor_id, to_jsonb(u)->>'email' AS u_email, to_jsonb(u)->>'phone' AS u_phone, c.email AS c_email, c.phone AS c_phone
         FROM users u LEFT JOIN notification_contacts c ON c.user_id=u.id AND c.tenant_id=u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2`, [n.userId, tenantId]))[0];
    if (u) {
      out.label = u.display_name; out.nameEn = u.display_name; out.nameAr = u.display_name;
      out.email = u.c_email || u.u_email || (String(u.username).includes('@') ? u.username : null);
      out.phone = u.c_phone || u.u_phone || null;
      if (u.vendor_id) { out.isVendor = true; vendorId = vendorId ?? u.vendor_id; }
    }
  }
  if (vendorId && isUuid(vendorId)) {
    const v = (await q.query<any>('SELECT legal_name_en, legal_name_ar, email, phone FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, tenantId]))[0];
    if (v) {
      if (!out.label) { out.label = v.legal_name_en; out.nameEn = v.legal_name_en; out.nameAr = v.legal_name_ar; }
      out.email = out.email ?? v.email ?? null;
      out.phone = out.phone ?? v.phone ?? null;
    }
  }
  return out;
}

/** Values every template can use, read from the records the event refers to (tender, request, document, vendor). */
async function enrich(q: Queryable, tenantId: string, body: Record<string, unknown>, r: Recipient): Promise<Record<string, unknown>> {
  const v: Record<string, unknown> = { recipientNameEn: r.nameEn, recipientNameAr: r.nameAr };
  const t = (await q.query<any>('SELECT name_en, name_ar FROM tenants WHERE id=$1', [tenantId]))[0];
  if (t) { v.entityNameEn = t.name_en; v.entityNameAr = t.name_ar; }
  let path = r.isVendor ? '/vendor' : '/procurement';
  if (isUuid(body.tenderId)) {
    const x = (await q.query<any>('SELECT tender_number, title_en, title_ar, submission_deadline FROM tenders WHERE id=$1 AND tenant_id=$2', [body.tenderId, tenantId]))[0];
    if (x) Object.assign(v, { tenderNumber: x.tender_number, tenderTitleEn: x.title_en, tenderTitleAr: x.title_ar, deadline: x.submission_deadline,
      reference: x.tender_number, subjectTitleEn: x.title_en, subjectTitleAr: x.title_ar });
    path = r.isVendor ? `/vendor/tenders/${body.tenderId}` : `/procurement/tenders/${body.tenderId}`;
  } else if (isUuid(body.requestId)) {
    const x = (await q.query<any>('SELECT request_number, subject FROM procurement_requests WHERE id=$1 AND tenant_id=$2', [body.requestId, tenantId]))[0];
    if (x) Object.assign(v, { requestNumber: x.request_number, reference: x.request_number, subjectTitle: x.subject });
    if (!r.isVendor) path = `/procurement/requests/${body.requestId}`;
  } else if (isUuid(body.documentId)) {
    if (!r.isVendor) path = '/procurement/documents';
  } else if (isUuid(body.vendorId) && !r.isVendor) path = '/procurement/vendors';
  if (isUuid(body.documentId)) {
    const x = (await q.query<any>('SELECT title FROM documents WHERE id=$1 AND tenant_id=$2', [body.documentId, tenantId]))[0];
    if (x) v.documentTitle = x.title;
  }
  const vendorId = isUuid(body.vendorId) ? body.vendorId : r.vendorId;
  if (vendorId && isUuid(vendorId)) {
    const x = (await q.query<any>('SELECT legal_name_en, legal_name_ar, cr_number FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, tenantId]))[0];
    if (x) Object.assign(v, { vendorNameEn: x.legal_name_en, vendorNameAr: x.legal_name_ar, crNumber: x.cr_number });
  }
  if (baseUrl()) v.link = baseUrl() + path;
  return v;
}

export interface NotifyInput {
  tenantId: string; userId?: string | null; vendorId?: string | null; kind: string; titleEn: string; titleAr: string;
  body?: Record<string, unknown>;
  /** Template to render (defaults to `kind`). BRD short codes ("NOT-001") resolve to the full code. */
  templateCode?: string;
  /** Test sends from the admin page: marked as such everywhere. */
  isTest?: boolean;
}
export interface DeliverResult {
  notificationId: string | null; templateCode: string | null; skipped?: 'TEMPLATE_DISABLED';
  deliveries: { id: string; channel: Channel; status: string }[];
}

const SEP = '\n\n— — —\n\n';

/** Record one notification for one recipient: in-app row + delivery log rows (e-mail / SMS queued or skipped). */
export async function deliver(q: Queryable, n: NotifyInput): Promise<DeliverResult> {
  const code = n.templateCode ?? n.kind;
  const tpl = await findTemplate(q, n.tenantId, code);
  if (tpl && !tpl.enabled) return { notificationId: null, templateCode: tpl.code, skipped: 'TEMPLATE_DISABLED', deliveries: [] };
  const body = n.body ?? {};
  const r = await recipientOf(q, n.tenantId, n);
  const vars = { ...(await enrich(q, n.tenantId, body, r)), ...body, titleEn: n.titleEn, titleAr: n.titleAr };
  const testEn = n.isTest ? '[TEST] ' : '';
  const testAr = n.isTest ? '[تجربة] ' : '';
  const subjectEn = testEn + (tpl ? render(tpl.subject_en, vars, 'en') : n.titleEn);
  const subjectAr = testAr + (tpl ? render(tpl.subject_ar, vars, 'ar') : n.titleAr);
  const bodyEn = tpl ? render(tpl.body_en, vars, 'en') : '';
  const bodyAr = tpl ? render(tpl.body_ar, vars, 'ar') : '';
  const at = now();
  const templateCode = tpl?.code ?? code;
  const notificationId = uuid();
  await q.query(`INSERT INTO notifications (id, tenant_id, user_id, vendor_id, kind, title_en, title_ar, body, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [notificationId, n.tenantId, n.userId ?? null, n.vendorId ?? null, n.kind, subjectEn, subjectAr,
      JSON.stringify({ ...body, ...(tpl ? { templateCode, messageEn: bodyEn, messageAr: bodyAr } : {}), ...(n.isTest ? { test: true } : {}) }), at]);
  const deliveries: DeliverResult['deliveries'] = [];
  const log = async (channel: Channel, status: string, address: string | null, lang: 'en' | 'ar', subject: string, text: string) => {
    const id = uuid();
    await q.query(`INSERT INTO notification_deliveries (id, tenant_id, notification_id, template_code, channel, recipient_user_id, recipient_vendor_id,
                     recipient_label, address, lang, subject, body, status, attempts, next_attempt_at, is_test, created_at, updated_at, sent_at)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,$16,$17)`,
      [id, n.tenantId, notificationId, templateCode, channel, n.userId && isUuid(n.userId) ? n.userId : null, n.vendorId ?? null, r.label || null, address, lang,
        subject, text, status, status === 'QUEUED' ? at : null, Boolean(n.isTest), at, status === 'SENT' ? at : null]);
    deliveries.push({ id, channel, status });
  };
  const cfg = runtimeConfig();
  const first: 'en' | 'ar' = cfg.defaultLang;
  await log('IN_APP', 'SENT', null, first, first === 'ar' ? subjectAr : subjectEn, first === 'ar' ? bodyAr : bodyEn);
  const channels = tpl?.channels ?? [];
  if (channels.includes('EMAIL')) {
    const subject = subjectAr === subjectEn ? subjectEn : first === 'ar' ? `${subjectAr} | ${subjectEn}` : `${subjectEn} | ${subjectAr}`;
    const ar = `${subjectAr}\n\n${bodyAr}`.trim();
    const en = `${subjectEn}\n\n${bodyEn}`.trim();
    const text = first === 'ar' ? ar + SEP + en : en + SEP + ar;
    await log('EMAIL', !emailConfigured(cfg) ? 'SKIPPED_NOT_CONFIGURED' : r.email ? 'QUEUED' : 'SKIPPED_NO_ADDRESS', r.email, first, subject, text);
  }
  if (channels.includes('SMS')) {
    const text = (first === 'ar' ? bodyAr || subjectAr : bodyEn || subjectEn).slice(0, 640);
    await log('SMS', !smsConfigured(cfg) ? 'SKIPPED_NOT_CONFIGURED' : r.phone ? 'QUEUED' : 'SKIPPED_NO_ADDRESS', r.phone, first, first === 'ar' ? subjectAr : subjectEn, text);
  }
  if (deliveries.some((d) => d.status === 'QUEUED')) notifyRuntime.kick?.();
  return { notificationId, templateCode, deliveries };
}

export const EMAIL_SEPARATOR = SEP;
