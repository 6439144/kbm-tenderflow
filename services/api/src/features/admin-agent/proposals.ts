// AI admin builder — proposals. A TENANT_ADMIN describes a change in plain language; the watsonx Orchestrate agent
// tenderflow_admin_builder returns a structured plan (or the Orchestrate tool pack submits one directly); TenderFlow
// validates it with its own validators against this entity's configuration and stores it as a PROPOSAL. Nothing is
// written to the configuration until an administrator applies it, and applying only ever creates DRAFTS (publishing
// stays a human click in Cycle Designer / Process Studio, under the entity's four-eyes setting). Everything is scoped to
// the caller's entity (tenant_id from the token) and audited: ADMIN_AGENT_PROPOSED / _APPLIED / _DISCARDED.
import type { Ctx } from '../../ctx.js';
import { auditTx, hasRole } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import type { Queryable } from '../../db.js';
import { parseAdminOperations, type AdminOperation, type AdminPlan, type Bilingual } from '../../ai/index.js';
import { readAiConfig } from '../../ai/config.js';
import { ApiError, badRequest, conflict, isUuid, now, reqStr, str, uuid } from '../../util.js';
import { recordRun } from '../../services/ai-runs.js';
import { ensureCatalogue } from '../../services/doc-catalogue.js';
import { customFactLines, loadState, ruleContextOf, stateSections } from './state.js';
import { evaluatePlan, type Evaluation } from './ops.js';
import { applyPlan, type AppliedRef } from './apply.js';

export interface ProposalRow {
  id: string; tenant_id: string; created_by: string; source: 'CHAT' | 'TOOL'; thread_id: string | null; ai_run_id: string | null;
  status: 'PROPOSED' | 'APPLIED' | 'DISCARDED' | 'FAILED'; request_text: string; operations: AdminOperation[];
  validation: Omit<Evaluation, 'plan'> | Record<string, never>; summary: { reply?: Bilingual | null; questions?: Bilingual[] };
  messages: Message[]; revision: number; applied_refs: AppliedRef[] | null; applied_by: string | null; applied_at: Date | null;
  created_at: Date; updated_at: Date; created_by_name?: string | null; applied_by_name?: string | null;
}
type Message =
  | { role: 'admin'; text: string; at: string }
  | { role: 'agent'; reply: Bilingual; questions: Bilingual[]; operations: number; aiRunId: string | null; at: string };

const SELECT = `SELECT p.*, u.display_name AS created_by_name, a.display_name AS applied_by_name FROM admin_proposals p
  LEFT JOIN users u ON u.id::text = p.created_by AND u.tenant_id = p.tenant_id
  LEFT JOIN users a ON a.id::text = p.applied_by AND a.tenant_id = p.tenant_id`;

const reviewPath = (id: string) => `/admin/builder?proposal=${id}`;
const stripPlan = (e: Evaluation): Omit<Evaluation, 'plan'> => ({ valid: e.valid, results: e.results, errors: e.errors, notes: e.notes });

export function publicProposal(r: ProposalRow) {
  return {
    id: r.id, status: r.status, source: r.source, requestText: r.request_text, threadId: r.thread_id, aiRunId: r.ai_run_id, revision: r.revision,
    createdBy: r.created_by, createdByName: r.created_by_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    reply: r.summary?.reply ?? null, questions: r.summary?.questions ?? [],
    operations: r.operations, validation: r.validation, messages: r.messages,
    appliedRefs: r.applied_refs, appliedBy: r.applied_by, appliedByName: r.applied_by_name ?? null, appliedAt: r.applied_at,
    reviewPath: reviewPath(r.id),
  };
}

async function loadProposal(q: Queryable, tenantId: string, id: string): Promise<ProposalRow> {
  if (!isUuid(id)) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
  const r = (await q.query<ProposalRow>(`${SELECT} WHERE p.id=$1 AND p.tenant_id=$2`, [id, tenantId]))[0];
  if (!r) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found');
  return r;
}

// ---------------------------------------------------------------- status

export async function adminAgentStatus(ctx: Ctx, actor: Actor) {
  const configured = ctx.ai.isConfigured();
  const name = readAiConfig(process.env).agents.adminBuilder;
  const agent: { name: string; checked: boolean; imported: boolean | null; detail?: string } = { name, checked: false, imported: null };
  if (configured) {
    const st = await ctx.ai.agentStatus();
    agent.checked = st.checked;
    agent.imported = st.checked ? !st.missing.some((m) => m.role === 'adminBuilder') : null;
    if (st.detail) agent.detail = st.detail;
  }
  return { configured, agent, canApply: hasRole(actor, 'TENANT_ADMIN') };
}

// ---------------------------------------------------------------- chat (agent) and tool submission

const historyOf = (msgs: Message[], lang: 'en' | 'ar') =>
  msgs.map((m) => (m.role === 'admin' ? { role: 'admin' as const, text: m.text } : { role: 'agent' as const, text: m.reply[lang] }));

async function store(ctx: Ctx, actor: Actor, prev: ProposalRow | null, row: {
  source: 'CHAT' | 'TOOL'; threadId: string | null; aiRunId: string | null; requestText: string; operations: AdminOperation[];
  ev: Evaluation; summary: ProposalRow['summary']; messages: Message[];
}): Promise<ProposalRow> {
  const id = prev?.id ?? uuid();
  const at = now();
  await ctx.db.tx(async (q) => {
    if (prev) {
      const u = await q.query(
        `UPDATE admin_proposals SET thread_id=$1, ai_run_id=$2, operations=$3::jsonb, validation=$4::jsonb, summary=$5::jsonb, messages=$6::jsonb,
           revision=revision+1, updated_at=$7 WHERE id=$8 AND tenant_id=$9 AND status='PROPOSED' RETURNING id`,
        [row.threadId, row.aiRunId, JSON.stringify(row.operations), JSON.stringify(stripPlan(row.ev)), JSON.stringify(row.summary),
          JSON.stringify(row.messages), at, id, actor.tenantId]);
      if (!u.length) throw conflict('PROPOSAL_NOT_OPEN', 'This proposal was applied or discarded meanwhile; start a new request');
    } else {
      await q.query(
        `INSERT INTO admin_proposals (id, tenant_id, created_by, source, thread_id, ai_run_id, status, request_text, operations, validation, summary, messages, revision, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PROPOSED',$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,1,$12,$12)`,
        [id, actor.tenantId, actor.id, row.source, row.threadId, row.aiRunId, row.requestText, JSON.stringify(row.operations),
          JSON.stringify(stripPlan(row.ev)), JSON.stringify(row.summary), JSON.stringify(row.messages), at]);
    }
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ADMIN_AGENT_PROPOSED', resourceType: 'ADMIN_PROPOSAL', resourceId: id, newState: 'PROPOSED',
      details: { source: row.source, revision: (prev?.revision ?? 0) + 1, operations: row.operations.map((o) => o.op), valid: row.ev.valid,
        invalidOperations: row.ev.results.filter((r) => r.status === 'error').map((r) => r.index), aiRunId: row.aiRunId } });
  });
  return loadProposal(ctx.db, actor.tenantId, id);
}

/** Thread ids are never shared: a thread continues only for the administrator whose proposals used it. */
async function ownThreadProposal(ctx: Ctx, actor: Actor, threadId: string): Promise<ProposalRow | null | undefined> {
  const rows = await ctx.db.query<ProposalRow>(`${SELECT} WHERE p.tenant_id=$1 AND p.created_by=$2 AND p.thread_id=$3 ORDER BY p.updated_at DESC LIMIT 1`,
    [actor.tenantId, actor.id, threadId]);
  return rows[0];
}

export async function chat(ctx: Ctx, actor: Actor, b: any) {
  const message = reqStr(b?.message, 'message', 2000);
  let prev: ProposalRow | null = null;
  let threadId: string | undefined;
  if (b?.proposalId !== undefined && b?.proposalId !== null && b?.proposalId !== '') {
    prev = await loadProposal(ctx.db, actor.tenantId, String(b.proposalId));
    if (prev.created_by !== actor.id) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'Proposal not found for this administrator; start a new request');
    if (prev.status !== 'PROPOSED') throw conflict('PROPOSAL_NOT_OPEN', `This proposal is ${prev.status}; start a new request`);
    threadId = prev.thread_id ?? undefined;
  } else if (b?.threadId) {
    const t = str(b.threadId, 'threadId', { max: 200 })!;
    if (!/^[A-Za-z0-9_.:-]+$/.test(t)) throw badRequest('threadId is invalid');
    const owner = await ownThreadProposal(ctx, actor, t);
    if (!owner) throw new ApiError(404, 'THREAD_NOT_FOUND', 'Conversation not found for this administrator; start a new one');
    threadId = t;
    if (owner.status === 'PROPOSED') prev = owner; // a follow-up refines the open proposal of this conversation
  }
  const lang: 'en' | 'ar' = /[؀-ۿ]/.test(message) ? 'ar' : 'en';
  const state = await loadState(ctx.db, actor.tenantId);
  const input = {
    message, threadId, state: stateSections(state), customFacts: customFactLines(ruleContextOf(state)),
    currentOperations: prev ? prev.operations : null, history: prev ? historyOf(prev.messages, lang) : [],
  };
  const got: { plan?: AdminPlan; threadId?: string } = {};
  const run = await recordRun(ctx, actor, null, 'ADMIN_BUILDER',
    { message, proposalId: prev?.id ?? null, threadIn: threadId ?? null, revising: prev ? prev.operations.length : null, context: input.state.map((s) => s.section) },
    async () => {
      const res = await ctx.ai.buildAdminProposal(input);
      got.plan = res.output;
      got.threadId = (res.raw as { threadId?: string } | undefined)?.threadId;
      return res;
    }, { subjectId: prev?.id ?? null });
  const plan = got.plan;
  if (!plan) throw new ApiError(502, 'AI_ERROR', 'The agent returned no plan');
  const outThread = got.threadId ?? threadId ?? null;
  const ev = evaluatePlan(state, plan.operations);
  const at = now().toISOString();
  const messages: Message[] = [...(prev?.messages ?? []), { role: 'admin', text: message, at },
    { role: 'agent', reply: plan.reply, questions: plan.questions, operations: plan.operations.length, aiRunId: run.id, at }];
  const row = await store(ctx, actor, prev, {
    source: prev?.source ?? 'CHAT', threadId: outThread, aiRunId: run.id, requestText: prev?.request_text ?? message,
    operations: plan.operations, ev, summary: { reply: plan.reply, questions: plan.questions }, messages,
  });
  return publicProposal(row);
}

/** Orchestrate tool path (POST /admin-agent/proposals): a structured plan, validated exactly like the agent's. Never applies. */
export async function submitPlan(ctx: Ctx, actor: Actor, b: any) {
  const parsed = parseAdminOperations(b?.operations);
  if (!parsed.operations) throw new ApiError(400, 'VALIDATION_ERROR', `The plan is not valid: ${parsed.problems.slice(0, 8).join('; ')}`, { problems: parsed.problems });
  if (!parsed.operations.length) throw badRequest('operations must list at least one operation');
  const requestText = str(b?.request, 'request', { max: 2000 }) ?? '(submitted through the TenderFlow tool pack in watsonx Orchestrate)';
  let reply: Bilingual | null = null;
  if (b?.reply !== undefined && b?.reply !== null) {
    const en = str(b.reply?.en, 'reply.en', { required: true, max: 2000 })!; const ar = str(b.reply?.ar, 'reply.ar', { required: true, max: 2000 })!;
    reply = { en, ar };
  }
  const state = await loadState(ctx.db, actor.tenantId);
  const ev = evaluatePlan(state, parsed.operations);
  const at = now().toISOString();
  const row = await store(ctx, actor, null, {
    source: 'TOOL', threadId: null, aiRunId: null, requestText, operations: parsed.operations, ev,
    summary: { reply, questions: [] }, messages: [{ role: 'admin', text: requestText, at }],
  });
  return { ...publicProposal(row), applied: false,
    next: { en: 'Proposal stored. Nothing was changed: an administrator reviews it in TenderFlow (AI builder) and clicks "Create drafts"; publishing stays a separate human step.',
      ar: 'تم حفظ الاقتراح. لم يتغير شيء: يراجعه المسؤول في TenderFlow (المنشئ الذكي) ثم ينقر «إنشاء المسودات»؛ ويبقى النشر خطوة بشرية منفصلة.' } };
}

// ---------------------------------------------------------------- read

export async function listProposals(ctx: Ctx, actor: Actor, query: Record<string, unknown>) {
  const st = typeof query.status === 'string' && ['PROPOSED', 'APPLIED', 'DISCARDED', 'FAILED'].includes(query.status) ? query.status : null;
  const rows = await ctx.db.query<ProposalRow>(`${SELECT} WHERE p.tenant_id=$1 AND ($2::text IS NULL OR p.status=$2) ORDER BY p.updated_at DESC LIMIT 50`, [actor.tenantId, st]);
  return rows.map((r) => ({
    id: r.id, status: r.status, source: r.source, requestText: r.request_text, revision: r.revision, operations: r.operations.length,
    valid: (r.validation as any)?.valid === true, createdByName: r.created_by_name ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
    reply: r.summary?.reply ?? null, appliedAt: r.applied_at,
  }));
}

export async function getProposal(ctx: Ctx, actor: Actor, id: string) {
  return publicProposal(await loadProposal(ctx.db, actor.tenantId, id));
}

// ---------------------------------------------------------------- apply / discard

export async function applyProposal(ctx: Ctx, actor: Actor, id: string) {
  const p = await loadProposal(ctx.db, actor.tenantId, id);
  if (p.status === 'APPLIED') throw conflict('PROPOSAL_ALREADY_APPLIED', 'This proposal was already applied; its drafts exist');
  if (p.status !== 'PROPOSED') throw conflict('PROPOSAL_NOT_OPEN', `This proposal is ${p.status}`);
  if (p.operations.some((o) => o.op === 'ADD_DOCUMENT_TYPE')) await ensureCatalogue(ctx, actor.tenantId); // before the transaction (own tx)
  const failed: { ev?: Evaluation } = {};
  try {
    const row = await ctx.db.tx(async (q) => {
      const at = now();
      // Claim first: a concurrent second apply waits on this row and then finds it APPLIED (idempotent).
      const claim = await q.query(`UPDATE admin_proposals SET status='APPLIED', applied_by=$1, applied_at=$2, updated_at=$2 WHERE id=$3 AND tenant_id=$4 AND status='PROPOSED' RETURNING id`,
        [actor.id, at, id, actor.tenantId]);
      if (!claim.length) throw conflict('PROPOSAL_ALREADY_APPLIED', 'This proposal was already applied or discarded');
      // Re-validate against the configuration as it is NOW, inside the transaction that writes.
      const state = await loadState(q, actor.tenantId);
      const ev = evaluatePlan(state, p.operations);
      if (!ev.valid) { failed.ev = ev; throw new ApiError(409, 'PROPOSAL_INVALID', 'The proposal does not validate against the current configuration; nothing was created'); }
      const refs = await applyPlan(ctx, q, actor, state, ev.plan, id);
      await q.query(`UPDATE admin_proposals SET applied_refs=$1::jsonb, validation=$2::jsonb WHERE id=$3`, [JSON.stringify(refs), JSON.stringify(stripPlan(ev)), id]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ADMIN_AGENT_APPLIED', resourceType: 'ADMIN_PROPOSAL', resourceId: id,
        prevState: 'PROPOSED', newState: 'APPLIED',
        details: { source: p.source, aiRunId: p.ai_run_id, operations: p.operations.map((o) => o.op), drafts: refs.map((r) => ({ type: r.type, id: r.id, code: r.code, version: r.version, status: r.status })) } });
      return loadProposal(q, actor.tenantId, id);
    });
    return publicProposal(row);
  } catch (e) {
    if (failed.ev) {
      const ev = failed.ev;
      await ctx.db.query(`UPDATE admin_proposals SET validation=$1::jsonb, updated_at=$2 WHERE id=$3 AND tenant_id=$4 AND status='PROPOSED'`,
        [JSON.stringify(stripPlan(ev)), now(), id, actor.tenantId]);
      throw new ApiError(409, 'PROPOSAL_INVALID', 'The proposal does not validate against the current configuration; nothing was created', { validation: stripPlan(ev) });
    }
    if (e instanceof ApiError) throw e; // rolled back; the proposal stays PROPOSED
    const message = (e as Error).message ?? String(e);
    await ctx.db.tx(async (q) => {
      await q.query(`UPDATE admin_proposals SET status='FAILED', updated_at=$1 WHERE id=$2 AND tenant_id=$3 AND status='PROPOSED'`, [now(), id, actor.tenantId]);
      await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ADMIN_AGENT_APPLY_FAILED', resourceType: 'ADMIN_PROPOSAL', resourceId: id,
        prevState: 'PROPOSED', newState: 'FAILED', details: { error: message.slice(0, 500) } });
    });
    throw new ApiError(500, 'APPLY_FAILED', `Applying the proposal failed and was rolled back: ${message}`);
  }
}

export async function discardProposal(ctx: Ctx, actor: Actor, id: string, b: any) {
  const p = await loadProposal(ctx.db, actor.tenantId, id);
  if (p.status !== 'PROPOSED') throw conflict('PROPOSAL_NOT_OPEN', `This proposal is ${p.status}`);
  const reason = str(b?.reason, 'reason', { max: 500 }) ?? null;
  await ctx.db.tx(async (q) => {
    const u = await q.query(`UPDATE admin_proposals SET status='DISCARDED', updated_at=$1 WHERE id=$2 AND tenant_id=$3 AND status='PROPOSED' RETURNING id`, [now(), id, actor.tenantId]);
    if (!u.length) throw conflict('PROPOSAL_NOT_OPEN', 'This proposal was applied or discarded meanwhile');
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'ADMIN_AGENT_DISCARDED', resourceType: 'ADMIN_PROPOSAL', resourceId: id,
      prevState: 'PROPOSED', newState: 'DISCARDED', reason, details: { operations: p.operations.map((o) => o.op) } });
  });
  return publicProposal(await loadProposal(ctx.db, actor.tenantId, id));
}
