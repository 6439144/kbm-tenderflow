// Plain-language helpers for the Cycle Designer: a live summary of a configuration in sentences, a setting-by-setting
// comparison with the live version, and a friendly, bilingual reading of the server's validation message (the server's
// own message is always shown too — it is the authority).
import type { ApprovalLevel, CycleConfig } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { useDurationText } from '../../components/ux';
import { AI_KEYS, STAGE_TOGGLES } from './common';
import { bidsInScope } from '../moi';

/** Ids of the editor's settings cards (used by the stage strip, the "jump to" list and inline errors). */
export type Section = 'identity' | 'scope' | 'stages' | 'envelopes' | 'approvals' | 'eligibility' | 'fees' | 'ai' | 'integrity';
export const sectionId = (s: Section) => `cyc-sec-${s}`;

/** Which settings card explains a stage of the strip. Fixed stages point to the integrity rules. */
export const STAGE_SECTION: Record<string, Section> = {
  REQUEST_INTAKE: 'stages', DRAFT: 'integrity', APPROVAL: 'approvals', PUBLISH: 'integrity', GAZETTE: 'stages', CAPT: 'stages',
  DOCUMENT_PURCHASE: 'fees', CLARIFICATIONS: 'integrity', SEALED_BIDS: 'integrity', CLOSE: 'integrity', OPENING: 'envelopes',
  COMPLIANCE: 'stages', EVALUATION: 'envelopes', AWARD_APPROVAL: 'approvals', RECORDS_LOCK: 'stages',
};

export function focusSection(s: Section) {
  const el = document.getElementById(sectionId(s));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
  el.classList.remove('ux-flash');
  void el.offsetWidth; // restart the highlight animation
  el.classList.add('ux-flash');
}

export interface Issue {
  section: Section;
  /** Friendly bilingual text (falls back to the server message). */
  text: string;
  /** The server's own message, when the issue came from the server. */
  server?: string;
}

/** Map the server's (English) validation message to the settings card it concerns and a friendly bilingual text. */
export function useIssueReader() {
  const { t } = useI18n();
  const chainName = (k: string) => (['request', 'publish', 'award'].includes(k) ? t(`cycle.gate.${k}` as TKey) : k);
  return (msg: string): Issue => {
    let m: RegExpExecArray | null;
    const server = msg;
    if (/Two-envelope templates need evaluation\.technicalPassMark/.test(msg)) return { section: 'envelopes', text: t('ux.err.passMarkMissing'), server };
    if (/technicalPassMark must be 0-100/.test(msg)) return { section: 'envelopes', text: t('ux.err.passMarkRange'), server };
    if (/financialCriteria/.test(msg)) return { section: 'envelopes', text: t('ux.err.finCrit'), server };
    if (/^envelopes/.test(msg)) return { section: 'envelopes', text: msg, server };
    if (/documentPurchase needs fees\.documentPrice/.test(msg)) return { section: 'fees', text: t('ux.err.feeNeeded'), server };
    if (/fees\./.test(msg)) return { section: 'fees', text: t('ux.err.feeRange'), server };
    if ((m = /approvals\.(\w+) needs at least/.exec(msg))) return { section: 'approvals', text: t('ux.err.chainEmpty', { chain: chainName(m[1]) }), server };
    if ((m = /approvals\.(\w+) allows at most/.exec(msg))) return { section: 'approvals', text: t('ux.err.chainMax', { chain: chainName(m[1]) }), server };
    if ((m = /approvals\.(\w+)\[(\d+)\]\.dueHours/.exec(msg))) return { section: 'approvals', text: t('ux.err.due', { chain: chainName(m[1]), n: Number(m[2]) + 1 }), server };
    if ((m = /approvals\.(\w+)\[(\d+)\]\.role/.exec(msg))) return { section: 'approvals', text: t('ux.err.role', { chain: chainName(m[1]), n: Number(m[2]) + 1 }), server };
    if ((m = /approvals\.(\w+)\[(\d+)\]\.label/.exec(msg))) return { section: 'approvals', text: t('ux.err.label', { chain: chainName(m[1]), n: Number(m[2]) + 1 }), server };
    if (/^approvals/.test(msg)) return { section: 'approvals', text: msg, server };
    if (/minGrade|eligibility/.test(msg)) return { section: 'eligibility', text: t('ux.err.grade'), server };
    if (/scope/.test(msg)) return { section: 'scope', text: t('ux.err.scope'), server };
    return { section: 'stages', text: msg, server };
  };
}

/** Live, plain-language description of what a configuration does, one sentence per topic. */
export function usePlainSummary() {
  const { t, te, pick, lang, fmtMoney } = useI18n();
  const dur = useDurationText();
  const sep = lang === 'ar' ? '، ثم ' : ', then ';
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(lang === 'ar' ? '، ' : ', ')}${lang === 'ar' ? ' و' : ' and '}${xs[xs.length - 1]}`);
  const chain = (ls: ApprovalLevel[]) =>
    ls.map((l) => `${pick(l.labelEn, l.labelAr) || te('role.', l.role)}${l.dueHours ? ` (${t('ux.sum.within', { d: dur(l.dueHours) })})` : ''}`).join(sep);
  return (c: CycleConfig, activityCodes: { code: string; nameEn: string; nameAr: string }[] = []): { key: string; icon: string; text: string }[] => {
    const out: { key: string; icon: string; text: string }[] = [];
    const full = bidsInScope(c);
    out.push({ key: 'scope', icon: '🧭', text: t(full ? 'ux.sum.scopeFull' : 'ux.sum.scopeSale') });
    out.push({ key: 'request', icon: '📨', text: c.stages.requestIntake ? t('ux.sum.requestOn', { chain: chain(c.approvals.request) }) : t('ux.sum.requestOff') });
    out.push({ key: 'publish', icon: '✅', text: t('ux.sum.publish', { chain: chain(c.approvals.publish) }) });
    const notices = [c.stages.gazette ? t('cycle.stage.GAZETTE') : '', c.stages.capt ? t('cycle.stage.CAPT') : ''].filter(Boolean);
    out.push({ key: 'notices', icon: '📰', text: notices.length ? t('ux.sum.notices', { list: list(notices) }) : t('ux.sum.noNotices') });
    out.push({
      key: 'fee',
      icon: '💳',
      text: c.stages.documentPurchase
        ? t(c.fees.exemptionAllowed ? 'ux.sum.feeExempt' : 'ux.sum.fee', { price: fmtMoney(c.fees.documentPrice, c.fees.currency || 'KWD') })
        : t('ux.sum.free'),
    });
    if (full) {
      out.push({
        key: 'envelopes',
        icon: '✉️',
        text: c.envelopes === 'TWO' ? t('ux.sum.two', { pass: c.evaluation.technicalPassMark ?? '—' }) : t('ux.sum.one'),
      });
      if (c.stages.complianceScreening) out.push({ key: 'compliance', icon: '🔎', text: t('ux.sum.compliance') });
      out.push({ key: 'award', icon: '🏆', text: t('ux.sum.award', { chain: chain(c.approvals.award) }) });
      if (c.stages.recordsLock) out.push({ key: 'records', icon: '🗄️', text: t('ux.sum.records') });
    }
    const codes = c.eligibility.activityCodes.map((k) => {
      const a = activityCodes.find((x) => x.code === k);
      return a ? pick(a.nameEn, a.nameAr) : k;
    });
    const grade = c.eligibility.minGrade ? t(`cycle.grade.${c.eligibility.minGrade}` as TKey) : '';
    out.push({
      key: 'eligibility',
      icon: '🏢',
      text: !codes.length && !grade ? t('ux.sum.openToAll')
        : codes.length && grade ? t('ux.sum.eligCodesGrade', { codes: list(codes), grade })
          : codes.length ? t('ux.sum.eligCodes', { codes: list(codes) }) : t('ux.sum.eligGrade', { grade }),
    });
    const aiOff = AI_KEYS.filter((k) => c.ai[k] === false).length;
    out.push({ key: 'ai', icon: '🤖', text: aiOff ? t('ux.sum.aiSome', { n: AI_KEYS.length - aiOff, total: AI_KEYS.length }) : t('ux.sum.aiAll') });
    return out;
  };
}

export interface DiffRow { key: string; label: string; before: string; after: string; kind: 'changed' | 'added' | 'removed' }

/** Setting-by-setting comparison of two configurations, in the admin's words. */
export function useConfigDiff() {
  const { t, te, pick, lang, fmtMoney } = useI18n();
  const yes = t('common.yes');
  const no = t('common.no');
  const sep = lang === 'ar' ? ' ← ' : ' → ';
  const chainText = (ls: ApprovalLevel[]) => ls.map((l) => `${pick(l.labelEn, l.labelAr) || te('role.', l.role)}${l.dueHours ? ` (${l.dueHours}h)` : ''}`).join(sep);
  const settings: { key: string; label: string; get: (c: CycleConfig) => string }[] = [
    { key: 'scope', label: t('moi.scope.title'), get: (c) => t(c.scope === 'PUBLICATION_AND_SALE' ? 'moi.scope.PUBLICATION_AND_SALE' : 'moi.scope.FULL_CYCLE') },
    ...STAGE_TOGGLES.map((k) => ({ key: `stages.${k}`, label: t(`cycle.toggle.${k}` as TKey), get: (c: CycleConfig) => (c.stages[k] ? yes : no) })),
    { key: 'envelopes', label: t('cycle.d.envelopes'), get: (c) => te('cycle.env.', c.envelopes) },
    { key: 'passMark', label: t('cycle.d.passMark'), get: (c) => (c.envelopes === 'TWO' ? String(c.evaluation.technicalPassMark ?? '—') : '—') },
    { key: 'finCrit', label: t('cycle.d.finKeys'), get: (c) => (c.envelopes === 'TWO' ? c.evaluation.financialCriteria.join(', ') || '—' : '—') },
    ...(['request', 'publish', 'award'] as const).map((k) => ({ key: `approvals.${k}`, label: t(`cycle.gate.${k}` as TKey), get: (c: CycleConfig) => chainText(c.approvals[k]) })),
    { key: 'codes', label: t('cycle.activityCodes'), get: (c) => c.eligibility.activityCodes.join(', ') || '—' },
    { key: 'grade', label: t('cycle.minGrade'), get: (c) => (c.eligibility.minGrade ? t(`cycle.grade.${c.eligibility.minGrade}` as TKey) : t('cycle.grade.none')) },
    { key: 'price', label: t('cycle.d.price'), get: (c) => (c.stages.documentPurchase ? fmtMoney(c.fees.documentPrice, c.fees.currency || 'KWD') : '—') },
    { key: 'exempt', label: t('cycle.d.exemption'), get: (c) => (c.fees.exemptionAllowed ? yes : no) },
    ...AI_KEYS.map((k) => ({ key: `ai.${k}`, label: `${t('cycle.d.ai')}: ${t(`cycle.ai.${k}` as TKey)}`, get: (c: CycleConfig) => (c.ai[k] === false ? no : yes) })),
  ];
  return (live: CycleConfig, draft: CycleConfig): DiffRow[] =>
    settings
      .map((s) => ({ key: s.key, label: s.label, before: s.get(live), after: s.get(draft) }))
      .filter((r) => r.before !== r.after)
      .map((r) => ({ ...r, kind: r.before === '—' ? 'added' : r.after === '—' ? 'removed' : 'changed' }));
}
