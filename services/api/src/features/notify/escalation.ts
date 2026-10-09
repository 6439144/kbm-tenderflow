// Approval service levels (SLA): every WAITING approval level (tender publication, tender award, departmental request)
// gets a due time = the moment the level became WAITING + dueHours (cycle-template level `dueHours`, else the entity
// default). The `approval-escalation` job sends one reminder before the due time and, once overdue, records one
// escalation, notifies the escalation target and audits APPROVAL_ESCALATED. The approval itself is never changed:
// people still decide.
import type { Ctx } from '../../ctx.js';
import { auditTx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';
import { ROLES } from '../../auth/tokens.js';
import type { Queryable } from '../../db.js';
import { SYSTEM_ACTOR } from '../../services/audit.js';
import { badRequest, isUuid, now, uuid } from '../../util.js';
import { configOf, DEFAULT_CONFIG, type ApprovalLevel, type CycleConfig } from '../../services/templates.js';
import { currentRound } from '../../services/tenders.js';
import { notifyRole } from '../../services/notifications.js';

export type EscalateTo = 'NEXT_LEVEL_ROLE' | 'TENANT_ADMIN' | string;
export interface SlaSettings { defaultDueHours: number | null; escalateTo: EscalateTo; remindBeforeHours: number | null; updatedAt?: Date | null; updatedBy?: string | null }
export const DEFAULT_SLA: SlaSettings = { defaultDueHours: null, escalateTo: 'NEXT_LEVEL_ROLE', remindBeforeHours: null };
const STAFF_ROLE_NAMES = (ROLES as readonly string[]).filter((r) => r !== 'VENDOR');

export async function getSla(q: Queryable, tenantId: string): Promise<SlaSettings> {
  const r = (await q.query<any>('SELECT * FROM approval_sla_settings WHERE tenant_id=$1', [tenantId]))[0];
  if (!r) return { ...DEFAULT_SLA, updatedAt: null, updatedBy: null };
  return {
    defaultDueHours: r.default_due_hours === null ? null : Number(r.default_due_hours), escalateTo: r.escalate_to,
    remindBeforeHours: r.remind_before_hours === null ? null : Number(r.remind_before_hours), updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
}

const hoursOrNull = (v: unknown, field: string, min: number) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > 8760) throw badRequest(`${field} must be a number of hours between ${min} and 8760, or empty`);
  return n;
};

export async function updateSla(ctx: Ctx, actor: Actor, b: any): Promise<SlaSettings> {
  const defaultDueHours = hoursOrNull(b?.defaultDueHours, 'defaultDueHours', 0.001);
  const remindBeforeHours = hoursOrNull(b?.remindBeforeHours, 'remindBeforeHours', 0);
  const escalateTo = b?.escalateTo ?? 'NEXT_LEVEL_ROLE';
  if (typeof escalateTo !== 'string' || !['NEXT_LEVEL_ROLE', 'TENANT_ADMIN', ...STAFF_ROLE_NAMES].includes(escalateTo))
    throw badRequest(`escalateTo must be NEXT_LEVEL_ROLE, TENANT_ADMIN or one of ${STAFF_ROLE_NAMES.join(', ')}`);
  await ctx.db.tx(async (q) => {
    const before = await getSla(q, actor.tenantId);
    await q.query(`INSERT INTO approval_sla_settings (tenant_id, default_due_hours, escalate_to, remind_before_hours, updated_by, updated_at)
                   VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id) DO UPDATE SET default_due_hours=EXCLUDED.default_due_hours,
                   escalate_to=EXCLUDED.escalate_to, remind_before_hours=EXCLUDED.remind_before_hours, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [actor.tenantId, defaultDueHours, escalateTo, remindBeforeHours, actor.id, now()]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'APPROVAL_SLA_UPDATED', resourceType: 'TENANT', resourceId: actor.tenantId,
      details: { before: { defaultDueHours: before.defaultDueHours, escalateTo: before.escalateTo, remindBeforeHours: before.remindBeforeHours },
        after: { defaultDueHours, escalateTo, remindBeforeHours } } });
  });
  return getSla(ctx.db, actor.tenantId);
}

// ------------------------------------------------------------------ waiting levels

const GATE_LABEL: Record<string, { en: string; ar: string }> = {
  PUBLISH: { en: 'publication', ar: 'اعتماد الطرح' },
  AWARD: { en: 'award', ar: 'اعتماد الترسية' },
  REQUEST: { en: 'request', ar: 'اعتماد الطلب' },
};

export interface WaitingLevel {
  subjectType: 'TENDER' | 'REQUEST'; subjectId: string; gate: 'PUBLISH' | 'AWARD' | 'REQUEST';
  reference: string; titleEn: string; titleAr: string; level: number; of: number; role: string; labelEn: string; labelAr: string;
  nextRole: string | null; waitingSince: Date; dueHours: number | null; dueAt: Date | null;
}

const maxDate = (...ds: (Date | null | undefined)[]) => {
  const xs = ds.filter((d): d is Date => d instanceof Date || typeof d === 'string').map((d) => new Date(d));
  return xs.length ? new Date(Math.max(...xs.map((d) => d.getTime()))) : null;
};

function due(level: ApprovalLevel, sla: SlaSettings, since: Date) {
  const raw: unknown = (level as { dueHours?: unknown }).dueHours;
  const lvl = raw === undefined || raw === null || raw === '' ? null : Number(raw);
  const h = lvl !== null && Number.isFinite(lvl) && lvl > 0 ? lvl : sla.defaultDueHours;
  return h && h > 0 ? { dueHours: h, dueAt: new Date(since.getTime() + h * 3_600_000) } : { dueHours: null, dueAt: null };
}

function mk(chain: ApprovalLevel[], doneCount: number, since: Date, sla: SlaSettings,
  base: Pick<WaitingLevel, 'subjectType' | 'subjectId' | 'gate' | 'reference' | 'titleEn' | 'titleAr'>): WaitingLevel | null {
  const level = chain[doneCount];
  if (!level) return null;
  return { ...base, level: doneCount + 1, of: chain.length, role: level.role, labelEn: level.labelEn, labelAr: level.labelAr,
    nextRole: chain[doneCount + 1]?.role ?? null, waitingSince: since, ...due(level, sla, since) };
}

/** Every approval level that is WAITING right now in one entity (optionally for one subject). */
export async function waitingLevels(q: Queryable, tenantId: string, opts: { subjectId?: string; sla?: SlaSettings } = {}): Promise<WaitingLevel[]> {
  const sla = opts.sla ?? await getSla(q, tenantId);
  const sid = opts.subjectId && isUuid(opts.subjectId) ? opts.subjectId : null;
  if (opts.subjectId && !sid) return [];
  const out: WaitingLevel[] = [];

  // Tender publication chain: PENDING_APPROVAL (level ≥ 2), or DRAFT with a pack (level 1; clock = pack upload or last return).
  const tenders = await q.query<any>(
    `SELECT * FROM tenders WHERE tenant_id=$1 AND status IN ('DRAFT','PENDING_APPROVAL','EVALUATION') AND ($2::uuid IS NULL OR id=$2::uuid)`, [tenantId, sid]);
  for (const t of tenders) {
    const cfg: CycleConfig = configOf(t);
    const base = { subjectType: 'TENDER' as const, subjectId: t.id, reference: t.tender_number, titleEn: t.title_en, titleAr: t.title_ar };
    if (t.status === 'DRAFT' || t.status === 'PENDING_APPROVAL') {
      const done = await currentRound(q, t.id, 'PUBLISH');
      let since: Date | null;
      if (done.length) since = new Date(done[done.length - 1].decided_at);
      else {
        const pack = (await q.query<any>(`SELECT min(created_at) AS at FROM documents WHERE tender_id=$1 AND owner_type='TENDER_PACK'`, [t.id]))[0]?.at ?? null;
        const ret = (await q.query<any>(`SELECT max(decided_at) AS at FROM approvals WHERE subject_id=$1 AND gate='PUBLISH' AND decision='RETURNED'`, [t.id]))[0]?.at ?? null;
        since = pack ? maxDate(pack, ret) : null;
      }
      const w = since ? mk(cfg.approvals.publish, done.length, since, sla, { ...base, gate: 'PUBLISH' }) : null;
      if (w) out.push(w);
    } else {
      const award = (await q.query<any>(`SELECT created_at FROM awards WHERE tender_id=$1 AND status='RECOMMENDED'`, [t.id]))[0];
      if (!award) continue;
      const from = new Date(award.created_at);
      const done = await currentRound(q, t.id, 'AWARD', from);
      const since = done.length ? new Date(done[done.length - 1].decided_at) : from;
      const w = mk(cfg.approvals.award, done.length, since, sla, { ...base, gate: 'AWARD' });
      if (w) out.push(w);
    }
  }

  // Departmental requests (chain of the entity's default published template, as in services/requests.ts).
  const reqs = await q.query<any>(
    `SELECT * FROM procurement_requests WHERE tenant_id=$1 AND status IN ('SUBMITTED','IN_APPROVAL') AND ($2::uuid IS NULL OR id=$2::uuid)`, [tenantId, sid]);
  if (reqs.length) {
    const tpl = (await q.query<{ config: CycleConfig }>(
      `SELECT config FROM cycle_templates WHERE tenant_id=$1 AND status='PUBLISHED' AND is_default LIMIT 1`, [tenantId]))[0];
    const chain = tpl?.config.approvals.request ?? DEFAULT_CONFIG.approvals.request;
    for (const r of reqs) {
      const done = await currentRound(q, r.id, 'REQUEST');
      let since: Date | null;
      if (done.length) since = new Date(done[done.length - 1].decided_at);
      else {
        const ret = (await q.query<any>(`SELECT max(decided_at) AS at FROM approvals WHERE subject_id=$1 AND gate='REQUEST' AND decision='RETURNED'`, [r.id]))[0]?.at ?? null;
        since = maxDate(r.created_at, ret);
      }
      const w = since ? mk(chain, done.length, since, sla, { subjectType: 'REQUEST', subjectId: r.id, gate: 'REQUEST', reference: r.request_number, titleEn: r.subject, titleAr: r.subject }) : null;
      if (w) out.push(w);
    }
  }
  return out;
}

// ------------------------------------------------------------------ the job

export function humanDuration(ms: number): { en: string; ar: string } {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mm = m % 60;
  const en = [d && `${d} d`, h && `${h} h`, !d && mm && `${mm} min`].filter(Boolean).join(' ');
  const ar = [d && `${d} يوم`, h && `${h} ساعة`, !d && mm && `${mm} دقيقة`].filter(Boolean).join(' ');
  return { en, ar };
}

function targetRole(sla: SlaSettings, w: WaitingLevel): string {
  if (sla.escalateTo === 'NEXT_LEVEL_ROLE') return w.nextRole ?? 'TENANT_ADMIN';
  return sla.escalateTo;
}

const subjectKey = (w: WaitingLevel) => (w.subjectType === 'TENDER' ? { tenderId: w.subjectId } : { requestId: w.subjectId });

/** One pass over the entities (or one entity): reminders before due, one escalation per overdue level. */
export async function runEscalation(ctx: Ctx, opts: { tenantId?: string } = {}) {
  const tenants = opts.tenantId ? [opts.tenantId] : (await ctx.db.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id`)).map((t) => t.id);
  const out = { entities: tenants.length, waiting: 0, withSla: 0, reminders: 0, escalations: 0 };
  for (const tenantId of tenants) {
    const sla = await getSla(ctx.db, tenantId);
    const levels = await waitingLevels(ctx.db, tenantId, { sla });
    out.waiting += levels.length;
    for (const w of levels) {
      if (!w.dueAt) continue;
      out.withSla++;
      const t = now();
      const overdue = t.getTime() >= w.dueAt.getTime();
      const remindAt = sla.remindBeforeHours !== null ? w.dueAt.getTime() - sla.remindBeforeHours * 3_600_000 : null;
      if (!overdue && (remindAt === null || t.getTime() < remindAt)) continue;
      const kind = overdue ? 'ESCALATION' : 'REMINDER';
      const target = overdue ? targetRole(sla, w) : w.role;
      const by = humanDuration(t.getTime() - w.dueAt.getTime());
      const gate = GATE_LABEL[w.gate];
      const created = await ctx.db.tx(async (q) => {
        const id = uuid();
        const ins = await q.query(`INSERT INTO approval_escalations (id, tenant_id, subject_type, subject_id, gate, level, role, kind, waiting_since, due_at, escalated_to, created_at)
                                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (tenant_id, subject_id, gate, level, waiting_since, kind) DO NOTHING RETURNING id`,
          [id, tenantId, w.subjectType, w.subjectId, w.gate, w.level, w.role, kind, w.waitingSince, w.dueAt, overdue ? target : null, t]);
        if (!ins.length) return false;
        const body = { ...subjectKey(w), escalationId: id, gate: w.gate, gateEn: gate.en, gateAr: gate.ar, level: w.level, role: w.role,
          roleEn: w.labelEn, roleAr: w.labelAr, dueAt: w.dueAt!.toISOString(), overdueEn: by.en, overdueAr: by.ar };
        let notified: number;
        let to = target;
        if (overdue) {
          notified = await notifyRole(q, tenantId, to, { kind: 'APPROVAL_ESCALATED', templateCode: 'APPROVAL_ESCALATED', body,
            titleEn: `Escalation: approval of ${w.reference} is overdue by ${by.en}`, titleAr: `تصعيد: تأخر اعتماد ${w.reference} بمقدار ${by.ar}` });
          if (!notified && to !== 'TENANT_ADMIN') {
            to = 'TENANT_ADMIN';
            notified = await notifyRole(q, tenantId, to, { kind: 'APPROVAL_ESCALATED', templateCode: 'APPROVAL_ESCALATED', body,
              titleEn: `Escalation: approval of ${w.reference} is overdue by ${by.en}`, titleAr: `تصعيد: تأخر اعتماد ${w.reference} بمقدار ${by.ar}` });
          }
        } else {
          notified = await notifyRole(q, tenantId, w.role, { kind: 'APPROVAL_REMINDER', templateCode: 'APPROVAL_REMINDER', body,
            titleEn: `Reminder: approval of ${w.reference} is due soon`, titleAr: `تذكير: اقترب موعد اعتماد ${w.reference}` });
        }
        await q.query('UPDATE approval_escalations SET notified=$2, escalated_to=$3 WHERE id=$1', [id, notified, overdue ? to : null]);
        await auditTx(ctx, q, { tenantId, actor: SYSTEM_ACTOR, action: overdue ? 'APPROVAL_ESCALATED' : 'APPROVAL_REMINDER_SENT',
          resourceType: w.subjectType, resourceId: w.subjectId,
          details: { escalationId: id, gate: w.gate, level: w.level, of: w.of, role: w.role, waitingSince: w.waitingSince, dueAt: w.dueAt,
            dueHours: w.dueHours, ...(overdue ? { escalatedTo: to, overdueBy: by.en } : {}), notified } });
        return true;
      });
      if (created) { if (overdue) out.escalations++; else out.reminders++; }
    }
  }
  return out;
}

// ------------------------------------------------------------------ read views

export type SlaState = 'NO_SLA' | 'ON_TIME' | 'DUE_SOON' | 'OVERDUE';

async function view(q: Queryable, tenantId: string, levels: WaitingLevel[], sla: SlaSettings) {
  const ids = [...new Set(levels.map((w) => w.subjectId))];
  const recs = ids.length ? await q.query<any>(
    `SELECT * FROM approval_escalations WHERE tenant_id=$1 AND subject_id = ANY($2::uuid[]) ORDER BY created_at`, [tenantId, ids]) : [];
  const t = now().getTime();
  return levels.map((w) => {
    const mine = recs.filter((r) => r.subject_id === w.subjectId && r.gate === w.gate && r.level === w.level && new Date(r.waiting_since).getTime() === w.waitingSince.getTime());
    const esc = mine.find((r) => r.kind === 'ESCALATION');
    const rem = mine.find((r) => r.kind === 'REMINDER');
    const overdueMs = w.dueAt ? t - w.dueAt.getTime() : null;
    const remindAt = w.dueAt && sla.remindBeforeHours !== null ? w.dueAt.getTime() - sla.remindBeforeHours * 3_600_000 : null;
    const state: SlaState = !w.dueAt ? 'NO_SLA' : overdueMs! >= 0 ? 'OVERDUE' : remindAt !== null && t >= remindAt ? 'DUE_SOON' : 'ON_TIME';
    return {
      ...w, state, overdueMs: overdueMs !== null && overdueMs > 0 ? overdueMs : 0, dueInMs: overdueMs !== null && overdueMs < 0 ? -overdueMs : 0,
      path: w.subjectType === 'TENDER' ? `/procurement/tenders/${w.subjectId}` : `/procurement/requests/${w.subjectId}`,
      reminder: rem ? { at: rem.created_at, notified: rem.notified } : null,
      escalation: esc ? { at: esc.created_at, escalatedTo: esc.escalated_to, notified: esc.notified } : null,
    };
  });
}

export async function overdueApprovals(ctx: Ctx, actor: Actor) {
  const sla = await getSla(ctx.db, actor.tenantId);
  const all = await view(ctx.db, actor.tenantId, await waitingLevels(ctx.db, actor.tenantId, { sla }), sla);
  return {
    sla: { defaultDueHours: sla.defaultDueHours, escalateTo: sla.escalateTo, remindBeforeHours: sla.remindBeforeHours },
    active: all.some((x) => x.dueAt),
    waiting: all.length,
    dueSoon: all.filter((x) => x.state === 'DUE_SOON').length,
    items: all.filter((x) => x.state === 'OVERDUE').sort((a, b) => b.overdueMs - a.overdueMs),
  };
}

export async function slaForSubject(ctx: Ctx, actor: Actor, subjectId: string) {
  const sla = await getSla(ctx.db, actor.tenantId);
  return { items: await view(ctx.db, actor.tenantId, await waitingLevels(ctx.db, actor.tenantId, { subjectId, sla }), sla) };
}
