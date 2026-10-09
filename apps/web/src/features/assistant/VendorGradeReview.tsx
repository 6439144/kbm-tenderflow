// Vendor grading (officer / tenant admin): the grade reviewer (tenderflow_grade_reviewer) checks the vendor's uploaded
// documents against the entity's configurable checklist for the requested grade — PRESENT / MISSING / UNCLEAR with
// evidence and citations. It never grants or refuses a grade; the officer sets the classification.
// Mount on the vendor review screen: <VendorGradeReview vendorId={v.id} />.
import { useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { CitationInline } from '../../components/shared';
import { Badge, Button, Card, ErrorBox, Field, useAsync } from '../../components/ui';
import type { ComplianceItem } from '../../api';
import { assistantApi, type AgentRun } from './api-assistant';

export function VendorGradeReview({ vendorId }: { vendorId: string }) {
  const { t, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const allowed = hasRole('PROCUREMENT_OFFICER', 'TENANT_ADMIN', 'GRADING_AUTHORITY');
  const hist = useAsync(() => (allowed ? assistantApi.gradeReviews(vendorId) : Promise.resolve(null)), [vendorId, allowed]);
  const [grade, setGrade] = useState<1 | 2 | 3>(2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!allowed) return null;

  const run = async () => {
    setBusy(true); setErr(null);
    try { await assistantApi.gradeReview(vendorId, grade); hist.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const latest: AgentRun | undefined = hist.data?.runs?.[0];
  const criteria = hist.data?.criteria?.[String(grade)] ?? [];
  const name = (key: string) => {
    const all = Object.values(hist.data?.criteria ?? {}).flat();
    const c = all.find((x) => x.key === key);
    return c ? pick(c.nameEn, c.nameAr) : key;
  };
  const items = latest?.status === 'OK' ? (((latest.response ?? {}) as { items?: ComplianceItem[] }).items ?? []) : [];
  const runGrade = (latest?.request as { grade?: number } | undefined)?.grade;

  return (
    <Card className="ast-card" title={<>{t('assistant.grade.title')} <span className="ai-tag">IBM watsonx Orchestrate</span></>}>
      <p className="small muted">{t('assistant.grade.hint')} {t('ai.advisory')}</p>
      <div className="row wrap">
        <Field label={t('assistant.grade.grade')}>
          {(id) => (
            <select id={id} value={grade} onChange={(e) => setGrade(Number(e.target.value) as 1 | 2 | 3)}>
              {[1, 2, 3].map((g) => <option key={g} value={g}>{t(`assistant.grade.${g}` as TKey)}</option>)}
            </select>
          )}
        </Field>
        <Button variant="secondary" busy={busy} onClick={() => void run()}>{t('assistant.grade.run')}</Button>
      </div>
      {criteria.length > 0 && <p className="small muted">{criteria.map((c) => pick(c.nameEn, c.nameAr)).join(' · ')}</p>}
      {err ? <ErrorBox error={err} /> : null}
      {hist.error ? <ErrorBox error={hist.error} onRetry={hist.reload} /> : null}
      {latest && (
        <div className="ai-box stack-sm">
          <div className="small muted">
            {t('assistant.lastRun', { date: fmtDate(latest.createdAt), agent: latest.agent ?? '—' })}
            {runGrade ? ` · ${t(`assistant.grade.${runGrade}` as TKey)}` : ''}
          </div>
          {latest.status === 'ERROR' ? (
            <div className="alert alert-danger">{t('ai.error')}: {latest.error}</div>
          ) : (
            <div className="ast-table-wrap">
              <table className="ast-table">
                <thead><tr><th scope="col">{t('assistant.grade.requirement')}</th><th scope="col">{t('assistant.grade.status')}</th><th scope="col">{t('assistant.grade.evidence')}</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.requirement}>
                      <th scope="row">{name(i.requirement)}</th>
                      <td><Badge value={i.status} label={i.status} /></td>
                      <td><div dir="auto">{i.evidence ?? '—'}</div><CitationInline c={i.citation} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
