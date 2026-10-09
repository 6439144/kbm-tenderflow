// Small display helpers shared by the vendor-lifecycle screens.
import type { Classification } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { Badge } from '../../components/ui';
import type { SubscriptionStatus } from './api';

const SUB_TONE: Record<SubscriptionStatus, string> = { ACTIVE: 'success', EXEMPT: 'info', PENDING_PAYMENT: 'warn', EXPIRED: 'danger', NONE: 'neutral' };

export function SubBadge({ status }: { status: SubscriptionStatus }) {
  const { t } = useI18n();
  return <Badge tone={SUB_TONE[status]} label={t(`moi.sub.st.${status}` as TKey)} />;
}

export function gradeName(t: (k: TKey) => string, g: number | null | undefined): string {
  return g === null || g === undefined ? '—' : t(`cycle.grade.${g}` as TKey);
}

export function GradeList({ items, companyGrade }: { items: Classification[]; companyGrade?: number | null }) {
  const { t, pick } = useI18n();
  if (!items.length && !companyGrade) return <span className="muted small">—</span>;
  return (
    <ul className="plain small moi-grades">
      {companyGrade ? (
        <li>
          <strong>{t('moi.companyGrade')}:</strong> {gradeName(t, companyGrade)}
        </li>
      ) : null}
      {items.map((c) => (
        <li key={c.activityCode}>
          <code dir="ltr">{c.activityCode}</code> {c.nameEn ? `${pick(c.nameEn, c.nameAr)} · ` : ''}
          <strong>{gradeName(t, c.grade)}</strong>
        </li>
      ))}
    </ul>
  );
}
