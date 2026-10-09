// AI advisory runs. The API never produces AI text itself: it extracts document text from the content
// store, calls the AI service, and records request/response/citations in ai_runs (+ audit).
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import { AiNotConfiguredError, type DocText } from '../ai/index.js';
import { ApiError, badRequest, camel, conflict, isUuid, notFound, now, str, uuid } from '../util.js';
import { readPlain, type DocumentRow } from './documents.js';
import { extractText } from '../content/extract.js';
import { loadClarification, loadTender, type TenderRow } from './tenders.js';
import { decryptBidDocuments, financialSealed, type BidRow } from './bids.js';

type Kind = 'PACK_CHECK' | 'CLARIFICATION_DRAFT' | 'COMPLIANCE_SCREEN';

async function packDocTexts(ctx: Ctx, t: TenderRow): Promise<DocText[]> {
  const docs = await ctx.db.query<DocumentRow>(
    `SELECT * FROM documents WHERE tender_id=$1 AND owner_type IN ('TENDER_PACK','ADDENDUM') ORDER BY created_at`, [t.id]);
  const out: DocText[] = [];
  for (const d of docs) out.push(await extractText({ documentId: d.id, title: d.title, mimeType: d.mime_type }, await readPlain(ctx, d)));
  return out;
}

const docSummary = (docs: DocText[]) => docs.map((d) => ({ documentId: d.documentId, title: d.title, sections: d.sections.length }));

async function recordRun<T extends { agent: string; model?: string; output: unknown; citations: unknown[] }>(
  ctx: Ctx, actor: Actor, tenderId: string, kind: Kind, request: Record<string, unknown>, call: () => Promise<T>,
) {
  const id = uuid();
  try {
    const res = await call();
    const rows = await ctx.db.tx(async (q) => {
      const r = await q.query(
        `INSERT INTO ai_runs (id, tenant_id, tender_id, kind, agent, model, request, response, citations, status, requested_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'OK',$10,$11) RETURNING *`,
        [id, actor.tenantId, tenderId, kind, res.agent, res.model ?? null, JSON.stringify(request), JSON.stringify(res.output ?? null),
          JSON.stringify(res.citations ?? []), actor.id, now()]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AI_ADVISORY_GENERATED', resourceType: 'AI_RUN', resourceId: id,
        details: { kind, tenderId, agent: res.agent, citations: (res.citations ?? []).length } });
      return r;
    });
    return camel(rows[0]);
  } catch (err) {
    const notConfigured = err instanceof AiNotConfiguredError || (err as any)?.code === 'AI_NOT_CONFIGURED';
    const message = (err as Error).message ?? String(err);
    await ctx.db.tx(async (q) => {
      await q.query(
        `INSERT INTO ai_runs (id, tenant_id, tender_id, kind, request, status, error, requested_by, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,'ERROR',$6,$7,$8)`, [id, actor.tenantId, tenderId, kind, JSON.stringify(request), message, actor.id, now()]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AI_ADVISORY_FAILED', resourceType: 'AI_RUN', resourceId: id,
        details: { kind, tenderId, error: message.slice(0, 500) } });
    });
    if (notConfigured) throw new ApiError(503, 'AI_NOT_CONFIGURED', message, { aiRunId: id });
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'AI_ERROR', `AI service call failed: ${message}`, { aiRunId: id });
  }
}

export async function packCheck(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  const language = b?.language === 'ar' ? 'ar' : 'en';
  const documents = await packDocTexts(ctx, t);
  if (!documents.length) throw conflict('PACK_MISSING', 'The tender has no pack documents to check');
  return recordRun(ctx, actor, t.id, 'PACK_CHECK', { language, documents: docSummary(documents) }, () => ctx.ai.checkTenderPack({
    tender: { titleEn: t.title_en, titleAr: t.title_ar, category: t.category, deadline: new Date(t.submission_deadline).toISOString(),
      criteria: t.criteria, requiredDocuments: t.required_documents },
    documents, language,
  }));
}

export async function clarificationDraft(ctx: Ctx, actor: Actor, clarificationId: string) {
  const c = await loadClarification(ctx, actor, clarificationId);
  const t = await loadTender(ctx, actor, c.tender_id);
  const documents = await packDocTexts(ctx, t);
  const prior = await ctx.db.query<{ question: string; answer: string }>(
    `SELECT question, answer FROM clarifications WHERE tender_id=$1 AND status='ANSWERED' ORDER BY answered_at`, [t.id]);
  return recordRun(ctx, actor, t.id, 'CLARIFICATION_DRAFT', { clarificationId: c.id, documents: docSummary(documents) }, () => ctx.ai.draftClarification({
    tender: { titleEn: t.title_en, titleAr: t.title_ar }, question: c.question, documents, priorAnswers: prior,
  }));
}

export async function complianceScreen(ctx: Ctx, actor: Actor, tenderId: string, b: any) {
  const t = await loadTender(ctx, actor, tenderId);
  if (!['OPENED', 'EVALUATION', 'AWARDED'].includes(t.status)) throw conflict('INVALID_STATE', 'Compliance screening is available only after opening');
  const onlyBid = b?.bidId ? String(b.bidId) : null;
  const bids = await ctx.db.query<BidRow & { legal_name_en: string }>(
    `SELECT b.*, v.legal_name_en FROM bids b JOIN vendors v ON v.id=b.vendor_id
      WHERE b.tender_id=$1 AND b.status='OPENED' AND ($2::uuid IS NULL OR b.id=$2::uuid) ORDER BY b.submitted_at`,
    [t.id, onlyBid && isUuid(onlyBid) ? onlyBid : null]);
  if (onlyBid && !bids.length) throw notFound('Bid');
  if (!bids.length) throw conflict('NO_BIDS', 'No opened bids to screen');
  const requiredDocuments = t.required_documents.map((d) => ({ key: d.key, nameEn: d.name_en, nameAr: d.name_ar }));
  const runs = [];
  for (const bid of bids) {
    const files = await decryptBidDocuments(ctx, bid, { technicalOnly: financialSealed(t, bid) });
    const documents: DocText[] = [];
    for (const f of files) documents.push(await extractText({ documentId: f.doc.id, title: f.doc.title, mimeType: f.doc.mime_type }, f.bytes));
    runs.push(await recordRun(ctx, actor, t.id, 'COMPLIANCE_SCREEN', { bidId: bid.id, documents: docSummary(documents) }, () => ctx.ai.screenCompliance({
      requiredDocuments, bid: { bidId: bid.id, vendorName: bid.legal_name_en, documents },
    })));
  }
  return { runs };
}

export async function reviewRun(ctx: Ctx, actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('AI run');
  const decision = b?.decision;
  if (!['ACCEPTED', 'IGNORED', 'EDITED'].includes(decision)) throw badRequest("decision must be 'ACCEPTED', 'IGNORED' or 'EDITED'");
  const note = str(b?.note, 'note', { max: 4000 }) ?? null;
  const run = (await ctx.db.query<any>('SELECT * FROM ai_runs WHERE id=$1 AND tenant_id=$2', [id, actor.tenantId]))[0];
  if (!run) throw notFound('AI run');
  if (run.status !== 'OK') throw conflict('INVALID_STATE', 'Only successful AI runs can be reviewed');
  return ctx.db.tx(async (q) => {
    const rows = await q.query(`UPDATE ai_runs SET reviewed_by=$1, review_decision=$2 WHERE id=$3 RETURNING *`, [actor.id, decision, id]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'AI_ADVISORY_REVIEWED', resourceType: 'AI_RUN', resourceId: id,
      newState: decision, reason: note, details: { kind: run.kind, tenderId: run.tender_id } });
    return camel(rows[0]);
  });
}
