// Request detail: the request classifier (tenderflow_request_classifier) proposes a cycle template, activity codes,
// urgency and the budget stated in the request, with bilingual summaries and citations of the GM letter text read
// from the content store. The officer accepts or ignores the suggestion (POST /ai-runs/:id/review); nothing changes
// on the request itself.
import { useState } from 'react';
import { api } from '../../api';
import { platform } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { Citations } from '../../components/shared';
import { AsyncView, Badge, Button, Card, ErrorBox, useAsync } from '../../components/ui';
import { assistantApi, type AgentRun } from './api-assistant';

interface Classification {
  tenderType: string;
  activityCodes: string[];
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedBudget: number | null;
  summaryEn: string;
  summaryAr: string;
}
const URGENCY_TONE = { LOW: 'info', MEDIUM: 'warn', HIGH: 'danger' } as const;
const CLASSIFIERS = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'] as const;
const REVIEWERS = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'COMMITTEE_CHAIR'] as const;

export function RequestAiExtras({ requestId, onChange }: { requestId: string; onChange: () => void }) {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const req = useAsync(() => platform.request(requestId), [requestId]);
  const codes = useAsync(() => platform.activityCodes(), []);
  const templates = useAsync(() => platform.templates(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [fresh, setFresh] = useState<AgentRun | null>(null);
  const [decision, setDecision] = useState<Record<string, string>>({});
  if (!hasRole(...CLASSIFIERS)) return null;

  const run = async () => {
    setBusy(true); setErr(null);
    try { setFresh(await assistantApi.classifyRequest(requestId)); req.reload(); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const review = async (r: AgentRun, d: 'ACCEPTED' | 'IGNORED') => {
    setErr(null);
    try { await api.reviewAiRun(r.id, d, `Request classification ${d.toLowerCase()}`); setDecision((x) => ({ ...x, [r.id]: d })); req.reload(); onChange(); } catch (e) { setErr(e); }
  };

  const codeName = (c: string) => {
    const x = codes.data?.find((k) => k.code === c);
    return x ? `${c} — ${pick(x.nameEn, x.nameAr)}` : c;
  };
  const tplName = (c: string) => {
    const x = templates.data?.find((k) => k.code === c);
    return x ? `${pick(x.nameEn, x.nameAr)} (${c})` : c;
  };

  return (
    <Card id="sec-classify" className="ast-card" title={<>{t('assistant.cls.title')} <span className="ai-tag">IBM watsonx Orchestrate</span></>}
      actions={<Button variant="secondary" busy={busy} onClick={() => void run()}>{t('assistant.cls.run')}</Button>}>
      <p className="small muted">{t('assistant.cls.hint')} {t('ai.advisory')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <AsyncView state={req}>
        {(r) => {
          const runs = ((r.aiRuns ?? []) as AgentRun[]).filter((x) => x.kind === 'REQUEST_CLASSIFY');
          const latest = fresh && !runs.some((x) => x.id === fresh.id) ? fresh : runs[0] ?? fresh;
          if (!latest) return <p className="small muted">{t('ai.noRuns')}</p>;
          if (latest.status === 'ERROR') return <div className="alert alert-danger">{t('ai.error')}: {latest.error}</div>;
          const c = (latest.response ?? {}) as Classification;
          const decided = decision[latest.id] ?? latest.reviewDecision;
          return (
            <div className="ai-box stack-sm">
              <div className="small muted">
                {t('assistant.lastRun', { date: fmtDate(latest.createdAt), agent: latest.agent ?? '—' })} {latest.model ? `· ${latest.model}` : ''} · {t('assistant.run')} <code>{latest.id.slice(0, 8)}</code>
              </div>
              <dl className="kv">
                <div className="kv-row"><dt>{t('assistant.cls.template')}</dt><dd>{tplName(c.tenderType)}</dd></div>
                <div className="kv-row"><dt>{t('assistant.cls.codes')}</dt><dd>{c.activityCodes?.length ? c.activityCodes.map(codeName).join(' · ') : '—'}</dd></div>
                <div className="kv-row"><dt>{t('assistant.cls.urgency')}</dt><dd><Badge tone={URGENCY_TONE[c.urgency]} label={t(`assistant.urgency.${c.urgency}` as TKey)} /></dd></div>
                <div className="kv-row"><dt>{t('assistant.cls.budget')}</dt><dd>{c.estimatedBudget === null || c.estimatedBudget === undefined ? t('assistant.cls.noBudget') : fmtMoney(c.estimatedBudget, 'KWD')}</dd></div>
              </dl>
              <h4>{t('assistant.cls.summary')}</h4>
              <p dir="ltr" lang="en">{c.summaryEn}</p>
              <p dir="rtl" lang="ar">{c.summaryAr}</p>
              <Citations items={latest.citations} />
              {decided ? (
                <p className="small"><Badge value={decided} label={t('assistant.cls.decided', { decision: decided })} /></p>
              ) : hasRole(...REVIEWERS) ? (
                <div className="row">
                  <Button onClick={() => void review(latest, 'ACCEPTED')}>{t('assistant.cls.accept')}</Button>
                  <Button variant="ghost" onClick={() => void review(latest, 'IGNORED')}>{t('assistant.cls.ignore')}</Button>
                </div>
              ) : null}
            </div>
          );
        }}
      </AsyncView>
    </Card>
  );
}
