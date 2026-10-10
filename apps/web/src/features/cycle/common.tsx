// Shared building blocks of the cycle feature: stage flow strip, approval chain view, labels and helpers.
import type { ReactNode } from 'react';
import type { Bid, Role } from '../../api';
import type { ApprovalLevel, ChainStep, CycleConfig, StageInfo } from '../../api-platform';
import { translate, useI18n, type TKey } from '../../i18n';
import { Badge } from '../../components/ui';

export const APPROVER_ROLES: Role[] = ['DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'];
export const GRADES = [1, 2, 3] as const;
export const AI_KEYS: (keyof CycleConfig['ai'])[] = ['packCheck', 'clarification', 'compliance', 'gazette', 'relevance', 'narrative', 'requestClassify', 'documentIntelligence'];
export const STAGE_TOGGLES: (keyof CycleConfig['stages'])[] = ['requestIntake', 'documentPurchase', 'gazette', 'capt', 'complianceScreening', 'recordsLock'];

/** Bid row as returned to staff by GET /tenders/:id/bids (two-envelope fields included). */
export type CycleBid = Bid & {
  technicalResult?: 'PASSED' | 'FAILED' | null;
  technicalScore?: number | null;
  financialSealed?: boolean;
  financialOpenedAt?: string | null;
};
export type Step = ChainStep & { approverId?: string | null };

/** Default bilingual label of a role, used when an approval level is added in the designer. */
export function roleLabels(role: string): { labelEn: string; labelAr: string } {
  const k = `role.${role}` as TKey;
  return { labelEn: translate('en', k), labelAr: translate('ar', k) };
}

export function waitingStep(steps: Step[] | null | undefined): Step | undefined {
  return (steps ?? []).find((s) => s.decision === 'WAITING');
}

export function useCycleFmt() {
  const { t, te, lang, fmtMoney } = useI18n();
  const arrow = lang === 'ar' ? ' ← ' : ' → ';
  const chainText = (levels: ApprovalLevel[]) => levels.map((l) => te('role.', l.role)).join(arrow);
  const grade = (g: number | null | undefined) => (g === null || g === undefined ? t('cycle.grade.none') : t(`cycle.grade.${g}` as TKey));
  const stageDetail = (s: StageInfo, cfg?: CycleConfig | null): string | undefined => {
    if (!cfg) return s.detail;
    switch (s.key) {
      case 'REQUEST_INTAKE':
        return s.enabled ? chainText(cfg.approvals.request) : undefined;
      case 'APPROVAL':
        return chainText(cfg.approvals.publish);
      case 'AWARD_APPROVAL':
        return chainText(cfg.approvals.award);
      case 'OPENING':
        return cfg.envelopes === 'TWO' ? t('cycle.detail.two', { pass: cfg.evaluation.technicalPassMark ?? '—' }) : t('cycle.detail.one');
      case 'EVALUATION':
        return cfg.envelopes === 'TWO' ? t('cycle.detail.evalTwo') : t('cycle.detail.evalOne');
      case 'DOCUMENT_PURCHASE':
        return s.enabled ? fmtMoney(cfg.fees.documentPrice, cfg.fees.currency || 'KWD') : undefined;
      default:
        return undefined;
    }
  };
  return { chainText, grade, stageDetail, arrow };
}

export type StageState = 'done' | 'current' | 'todo' | 'attention';

/** Horizontal, wrapping flow of the cycle's stages in order: FIXED / CONFIGURED / OPTIONAL (off = greyed + struck). */
export function StageStrip({
  stages,
  cfg,
  states,
  hideOff,
  compact,
  legend,
  label,
  onStageClick,
}: {
  stages: StageInfo[];
  cfg?: CycleConfig | null;
  states?: Record<string, StageState>;
  hideOff?: boolean;
  compact?: boolean;
  legend?: boolean;
  label?: string;
  /** Designer: makes each stage a button that jumps to the settings that shape it. */
  onStageClick?: (key: string) => void;
}) {
  const { t, te } = useI18n();
  const { stageDetail } = useCycleFmt();
  const list = hideOff ? stages.filter((s) => s.enabled) : stages;
  return (
    <div className="cyc-flow-wrap">
      <ol className={`cyc-flow ${compact ? 'cyc-flow-compact' : ''}`} aria-label={label ?? t('cycle.flow')}>
        {list.map((s) => {
          const st = states?.[s.key];
          const detail = stageDetail(s, cfg);
          const body = (
            <>
              <span className="cyc-chip-label">
                {st === 'done' && (
                  <span className="cyc-tick" aria-hidden="true">
                    ✓
                  </span>
                )}
                {te('cycle.stage.', s.key)}
              </span>
              {detail && !compact && <span className="cyc-chip-detail">{detail}</span>}
              <span className="sr-only">
                {' '}
                ({te('cycle.kind.', s.kind)}
                {s.enabled ? '' : `, ${t('cycle.kind.OFF')}`}
                {st ? `, ${te('cycle.state.', st)}` : ''})
              </span>
            </>
          );
          return (
            <li
              key={s.key}
              className={`cyc-chip cyc-${s.kind.toLowerCase()} ${s.enabled ? '' : 'cyc-off'} ${st ? `cyc-st-${st}` : ''}`}
              aria-current={st === 'current' ? 'step' : undefined}
              title={`${te('cycle.kind.', s.kind)}${s.enabled ? '' : ` — ${t('cycle.kind.OFF')}`}`}
            >
              {onStageClick ? (
                <button type="button" className="cyc-chip-btn" onClick={() => onStageClick(s.key)} title={t('ux.stage.jump')}>
                  {body}
                </button>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
      {legend && <StageLegend />}
    </div>
  );
}

export function StageLegend() {
  const { t } = useI18n();
  return (
    <ul className="cyc-legend" aria-label={t('cycle.legend')}>
      <li>
        <span className="cyc-swatch cyc-fixed" aria-hidden="true" /> <strong>{t('cycle.kind.FIXED')}</strong> — {t('cycle.kindHint.FIXED')}
      </li>
      <li>
        <span className="cyc-swatch cyc-configured" aria-hidden="true" /> <strong>{t('cycle.kind.CONFIGURED')}</strong> — {t('cycle.kindHint.CONFIGURED')}
      </li>
      <li>
        <span className="cyc-swatch cyc-optional" aria-hidden="true" /> <strong>{t('cycle.kind.OPTIONAL')}</strong> — {t('cycle.kindHint.OPTIONAL')}
      </li>
      <li>
        <span className="cyc-swatch cyc-optional cyc-off" aria-hidden="true" /> <strong>{t('cycle.kind.OFF')}</strong> — {t('cycle.kindHint.OFF')}
      </li>
    </ul>
  );
}

const DECISION_TONE: Record<string, string> = { APPROVED: 'success', WAITING: 'warn', PENDING: 'neutral' };

/** Approval chain as a row of level cards. With `steps` it shows decisions; with `levels` only the configuration. */
export function ChainView({ steps, levels, label }: { steps?: Step[] | null; levels?: ApprovalLevel[]; label?: string }) {
  const { t, te, pick, fmtDate } = useI18n();
  const items: Step[] =
    steps ?? (levels ?? []).map((l, i) => ({ level: i + 1, role: l.role, labelEn: l.labelEn, labelAr: l.labelAr, decision: 'PENDING', approverName: null, decidedAt: null, reason: null }));
  const total = items.length;
  return (
    <ol className="cyc-chain" aria-label={label ?? t('cycle.chain')}>
      {items.map((s) => (
        <li key={s.level} className={`cyc-level ${steps ? `cyc-level-${s.decision.toLowerCase()}` : ''}`}>
          <div className="cyc-level-head">
            <span className="cyc-level-n">{t('cycle.levelOf', { n: s.level, total })}</span>
            {steps && <Badge tone={DECISION_TONE[s.decision]} label={te('cycle.decision.', s.decision)} />}
          </div>
          <div className="cyc-level-role">{pick(s.labelEn, s.labelAr) || te('role.', s.role)}</div>
          <div className="muted small">{te('role.', s.role)}</div>
          {steps && s.decision === 'APPROVED' && (
            <div className="small cyc-level-who">
              {s.approverName ?? '—'}
              <br />
              <span className="muted">{fmtDate(s.decidedAt)}</span>
              {s.reason && <div className="cyc-level-reason">“{s.reason}”</div>}
            </div>
          )}
          {steps && s.decision === 'WAITING' && <div className="small cyc-level-who">{t('cycle.waitingFor', { role: te('role.', s.role) })}</div>}
        </li>
      ))}
    </ol>
  );
}

export function TemplateBadge({ tpl }: { tpl?: { code: string; version: number; nameEn: string; nameAr: string } | null }) {
  const { t, pick } = useI18n();
  if (!tpl) return <Badge tone="neutral" label={t('cycle.noTemplate')} />;
  return (
    <span className="cyc-tpl-badge" title={tpl.code}>
      <span className="cyc-tpl-name">{pick(tpl.nameEn, tpl.nameAr)}</span>
      <span className="cyc-tpl-ver" dir="ltr">
        {tpl.code} · v{tpl.version}
      </span>
    </span>
  );
}

export function IntegrityRules() {
  const { t } = useI18n();
  const keys: TKey[] = ['cycle.rule.sealed', 'cycle.rule.opening', 'cycle.rule.sod', 'cycle.rule.award', 'cycle.rule.audit', 'cycle.rule.snapshot'];
  return (
    <ul className="cyc-rules">
      {keys.map((k) => (
        <li key={k}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>{t(k)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="cyc-section">
      <legend>{title}</legend>
      {hint && <p className="hint cyc-section-hint">{hint}</p>}
      {children}
    </fieldset>
  );
}

export const REQUEST_TONE: Record<string, string> = { SUBMITTED: 'warn', IN_APPROVAL: 'info', APPROVED: 'success', REJECTED: 'danger', CONVERTED: 'primary' };
export const PUB_TONE: Record<string, string> = { DRAFT: 'neutral', APPROVED: 'info', PUBLISHED: 'success' };
export const TPL_TONE: Record<string, string> = { DRAFT: 'warn', PUBLISHED: 'success', RETIRED: 'neutral' };

/** Apply an entity numbering pattern exactly as the server does ({YYYY}, {SEQ3}..{SEQ6}). */
export function applyPattern(pattern: string, seq: number, date = new Date()): string {
  return pattern.replace(/\{YYYY\}/g, String(date.getUTCFullYear())).replace(/\{SEQ([3-6])\}/g, (_, n: string) => String(seq).padStart(Number(n), '0'));
}
