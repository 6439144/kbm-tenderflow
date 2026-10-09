// AI value meter for administrators and auditors — computed only from recorded data (ai_runs, review decisions,
// documents and records that cite an AI run). No estimates, no invented "hours saved".
import type { Ctx } from '../../ctx.js';
import type { Actor } from '../../auth/tokens.js';

const KINDS = ['REQUEST_CLASSIFY', 'PACK_CHECK', 'GAZETTE_NOTICE', 'RELEVANCE_MATCH', 'CLARIFICATION_DRAFT', 'COMPLIANCE_SCREEN',
  'EVALUATION_NARRATIVE', 'GRADE_REVIEW', 'ASSISTANT_CHAT'] as const;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function insights(ctx: Ctx, actor: Actor) {
  const rows = await ctx.db.query<{ kind: string; status: string; review_decision: string | null; duration: string | null; agent: string | null; created_at: Date }>(
    `SELECT kind, status, review_decision, request->'orchestrate'->>'durationMs' AS duration, agent, created_at FROM ai_runs WHERE tenant_id=$1`, [actor.tenantId]);
  const byKind = KINDS.map((kind) => {
    const rs = rows.filter((r) => r.kind === kind);
    const ok = rs.filter((r) => r.status === 'OK');
    const durations = ok.map((r) => Number(r.duration)).filter((n) => Number.isFinite(n) && n >= 0);
    return {
      kind, total: rs.length, ok: ok.length, error: rs.length - ok.length,
      accepted: ok.filter((r) => r.review_decision === 'ACCEPTED').length,
      edited: ok.filter((r) => r.review_decision === 'EDITED').length,
      ignored: ok.filter((r) => r.review_decision === 'IGNORED').length,
      unreviewed: ok.filter((r) => !r.review_decision).length,
      medianDurationMs: median(durations), timedRuns: durations.length,
      agents: [...new Set(rs.map((r) => r.agent).filter(Boolean))],
    };
  });
  const one = async (sql: string) => Number((await ctx.db.query<{ n: string }>(sql, [actor.tenantId]))[0].n);
  const okRuns = rows.filter((r) => r.status === 'OK');
  const allDurations = okRuns.map((r) => Number(r.duration)).filter((n) => Number.isFinite(n) && n >= 0);
  const dates = rows.map((r) => new Date(r.created_at).getTime()).sort((a, b) => a - b);
  return {
    generatedAt: new Date().toISOString(),
    configured: ctx.ai.isConfigured(),
    totals: {
      runs: rows.length, ok: okRuns.length, error: rows.length - okRuns.length,
      accepted: okRuns.filter((r) => r.review_decision === 'ACCEPTED').length,
      edited: okRuns.filter((r) => r.review_decision === 'EDITED').length,
      ignored: okRuns.filter((r) => r.review_decision === 'IGNORED').length,
      medianDurationMs: median(allDurations), timedRuns: allDurations.length,
    },
    // Human outcomes that reference an AI run (each one was saved by a person).
    adoption: {
      clarificationsAnsweredFromDraft: await one(`SELECT count(*)::text AS n FROM clarifications WHERE tenant_id=$1 AND status='ANSWERED' AND ai_run_id IS NOT NULL`),
      noticesSavedFromDraft: await one(`SELECT count(*)::text AS n FROM publications WHERE tenant_id=$1 AND ai_run_id IS NOT NULL`),
      narrativesSaved: await one(`SELECT count(*)::text AS n FROM documents WHERE tenant_id=$1 AND owner_type='EVALUATION_NARRATIVE'`),
    },
    byKind,
    firstRunAt: dates.length ? new Date(dates[0]).toISOString() : null,
    lastRunAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
  };
}
