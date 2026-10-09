// Publication channels (Eiman): the TenderFlow portal (automatic at publish), Kuwait Al-Youm (official gazette)
// and CAPT. For gazette/CAPT the officer drafts the notice (by hand or from the Orchestrate notice drafter), a
// different approver approves the text, and the officer records the publication reference and date. The approved
// notice is stored as a NOTICE document in the content store (FileNet). TenderFlow does not claim to submit to
// those bodies electronically: it produces the ready-to-file notice and records the outcome.
import type { Ctx } from '../ctx.js';
import { auditTx, hasRole } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { badRequest, camel, conflict, escapeHtml, forbidden, isUuid, notFound, now, reqStr, uuid } from '../util.js';
import { configOf } from './templates.js';
import { loadTender } from './tenders.js';
import { insertDocument, putDocument } from './documents.js';

const CHANNELS = ['KUWAIT_ALYOUM', 'CAPT'] as const;
type Channel = (typeof CHANNELS)[number];

function channelEnabled(cfg: ReturnType<typeof configOf>, c: Channel) {
  return c === 'KUWAIT_ALYOUM' ? cfg.stages.gazette : cfg.stages.capt;
}

async function loadPub(ctx: Ctx, actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Publication');
  const p = (await ctx.db.query<any>('SELECT * FROM publications WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!p) throw notFound('Publication');
  return p;
}

export async function saveNotice(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  const channel = b?.channel as Channel;
  if (!CHANNELS.includes(channel)) throw badRequest(`channel must be one of ${CHANNELS.join(', ')}`);
  if (!channelEnabled(configOf(t), channel)) throw conflict('CHANNEL_DISABLED', `The cycle template of this tender does not use ${channel}`);
  if (!['APPROVED', 'PUBLISHED', 'PENDING_APPROVAL', 'DRAFT'].includes(t.status)) throw conflict('INVALID_STATE', `Notices cannot be drafted for a ${t.status} tender`);
  const noticeEn = reqStr(b?.noticeEn, 'noticeEn', 8000);
  const noticeAr = reqStr(b?.noticeAr, 'noticeAr', 8000);
  const aiRunId = b?.aiRunId && isUuid(b.aiRunId) ? b.aiRunId : null;
  return ctx.db.tx(async (q) => {
    const ex = (await q.query<any>('SELECT * FROM publications WHERE tender_id=$1 AND channel=$2', [t.id, channel]))[0];
    if (ex && ex.status === 'PUBLISHED') throw conflict('INVALID_STATE', 'This notice is already published');
    const rows = ex
      ? await q.query(`UPDATE publications SET notice_en=$1, notice_ar=$2, ai_run_id=COALESCE($3, ai_run_id), status='DRAFT', approved_by=NULL, created_by=$4, updated_at=$5 WHERE id=$6 RETURNING *`,
        [noticeEn, noticeAr, aiRunId, actor.id, now(), ex.id])
      : await q.query(`INSERT INTO publications (id, tenant_id, tender_id, channel, status, notice_en, notice_ar, ai_run_id, created_by, created_at, updated_at)
                       VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$9) RETURNING *`, [uuid(), t.tenant_id, t.id, channel, noticeEn, noticeAr, aiRunId, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: t.tenant_id, actor, action: 'NOTICE_DRAFTED', resourceType: 'TENDER', resourceId: t.id, newState: 'DRAFT',
      details: { channel, publicationId: rows[0].id, aiRunId } });
    return camel(rows[0]);
  });
}

export async function approveNotice(ctx: Ctx, actor: Actor, id: string) {
  const p = await loadPub(ctx, actor, id);
  if (p.status !== 'DRAFT') throw conflict('INVALID_STATE', `Notice is ${p.status}`);
  if (p.created_by === actor.id) throw forbidden('Segregation of duties: the author of a notice cannot approve it');
  if (!hasRole(actor, 'DIRECTOR', 'UNDERSECRETARY')) throw forbidden('Notices are approved by a director or undersecretary');
  return ctx.db.tx(async (q) => {
    const rows = await q.query(`UPDATE publications SET status='APPROVED', approved_by=$1, updated_at=$2 WHERE id=$3 AND status='DRAFT' RETURNING *`, [actor.id, now(), id]);
    await auditTx(ctx, q, { tenantId: p.tenant_id, actor, action: 'NOTICE_APPROVED', resourceType: 'TENDER', resourceId: p.tender_id,
      prevState: 'DRAFT', newState: 'APPROVED', details: { channel: p.channel, publicationId: id } });
    return camel(rows[0]);
  });
}

export async function recordPublication(ctx: Ctx, actor: Actor, id: string, b: any) {
  const p = await loadPub(ctx, actor, id);
  if (p.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved notice can be recorded as published');
  const t = await loadTender(ctx, actor, p.tender_id);
  if (!['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'].includes(t.status)) throw conflict('INVALID_STATE', 'Publish the tender on the portal first');
  const reference = reqStr(b?.reference, 'reference', 120);
  const publishedOn = reqStr(b?.publishedOn, 'publishedOn', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedOn)) throw badRequest('publishedOn must be YYYY-MM-DD');
  const label = p.channel === 'KUWAIT_ALYOUM' ? 'Kuwait Al-Youm / الكويت اليوم' : 'CAPT / الجهاز المركزي للمناقصات العامة';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Notice ${escapeHtml(t.tender_number)}</title>
<style>body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;margin:32px;max-width:820px}.ar{direction:rtl;text-align:right}</style></head><body>
<h1>${escapeHtml(label)}</h1><p>Tender ${escapeHtml(t.tender_number)} · Reference ${escapeHtml(reference)} · Published ${escapeHtml(publishedOn)}</p>
<h2>English</h2><div>${escapeHtml(p.notice_en).replace(/\n/g, '<br>')}</div>
<h2 class="ar">العربية</h2><div class="ar">${escapeHtml(p.notice_ar).replace(/\n/g, '<br>')}</div></body></html>`;
  const prepared = await putDocument(ctx, {
    tenantId: actor.tenantId, ownerType: 'NOTICE', ownerId: p.id, tenderId: t.id, tenderNumber: t.tender_number,
    title: `${p.channel === 'KUWAIT_ALYOUM' ? 'Kuwait Al-Youm' : 'CAPT'} notice ${t.tender_number}`, fileName: `notice-${p.channel.toLowerCase()}-${t.tender_number}.html`,
    mimeType: 'text/html', bytes: Buffer.from(html, 'utf8'), uploadedBy: actor.id,
  });
  return ctx.db.tx(async (q) => {
    const doc = await insertDocument(q, prepared);
    const rows = await q.query(`UPDATE publications SET status='PUBLISHED', reference=$1, published_on=$2, document_id=$3, updated_at=$4 WHERE id=$5 RETURNING *`,
      [reference, publishedOn, doc.id, now(), id]);
    await auditTx(ctx, q, { tenantId: p.tenant_id, actor, action: 'NOTICE_PUBLISHED', resourceType: 'TENDER', resourceId: p.tender_id,
      prevState: 'APPROVED', newState: 'PUBLISHED', details: { channel: p.channel, reference, publishedOn, documentId: doc.id, storeRef: doc.store_ref } });
    return camel(rows[0]);
  });
}

