// Vendor home: open tenders the vendor is ELIGIBLE for (rule-based: activity codes + grade, checked by TenderFlow),
// ranked by the relevance agent (tenderflow_relevance_matcher). The ranking is advisory; it never widens access.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { AiNotConfiguredBanner, Button, Card, ErrorBox, Spinner, useAsync } from '../../components/ui';
import { assistantApi, type TendersForMe } from './api-assistant';
import { ScoreBar } from './TenderAiExtras';

export function TendersForYou() {
  const { t, pick, fmtDate, lang } = useI18n();
  const state = useAsync<TendersForMe>(() => assistantApi.tendersForMe(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const refresh = async () => {
    setBusy(true); setErr(null);
    try { state.setData(await assistantApi.rankTendersForMe()); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  const notApproved = state.error instanceof ApiError && state.error.code === 'VENDOR_NOT_APPROVED';
  const d = state.data;
  return (
    <Card className="ast-card" title={<>{t('assistant.tfy.title')} <span className="ai-tag">{t('assistant.aiRanked')}</span></>}
      actions={d && d.configured && d.eligibleOpenCount > 0 ? <Button variant="secondary" busy={busy} onClick={() => void refresh()}>{t('assistant.tfy.refresh')}</Button> : undefined}>
      <p className="small muted">{t('assistant.tfy.hint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      {notApproved ? (
        <p className="muted">{t('assistant.tfy.notApproved')}</p>
      ) : state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : !d ? (
        <Spinner />
      ) : d.eligibleOpenCount === 0 ? (
        <p className="muted">{t('assistant.tfy.none')}</p>
      ) : (
        <>
          {!d.configured && <AiNotConfiguredBanner />}
          {d.run?.status === 'ERROR' && <div className="alert alert-danger">{t('ai.error')}: {d.run.error}</div>}
          {d.ranked.length === 0 ? (
            d.configured ? <p className="muted">{t('assistant.tfy.notRanked', { n: d.eligibleOpenCount })}</p> : null
          ) : (
            <>
              <div className="small muted">
                {t('assistant.tfy.ranked', { date: fmtDate(d.run?.createdAt) })} · {t('ai.agent')}: {d.run?.agent ?? '—'}
                {d.run?.model ? ` · ${d.run.model}` : ''}
              </div>
              <ol className="ast-ranked">
                {d.ranked.map((x) => (
                  <li key={x.tenderId}>
                    <div className="row spread">
                      <Link to={`/vendor/tenders/${x.tenderId}`}>
                        <span dir="ltr">{x.tenderNumber}</span> — {pick(x.titleEn, x.titleAr)}
                      </Link>
                      <ScoreBar score={x.score} />
                    </div>
                    <div className="small" lang={lang}>{pick(x.reasonsEn, x.reasonsAr)}</div>
                    <div className="small muted">{t('assistant.tfy.closes', { date: fmtDate(x.submissionDeadline) })}</div>
                  </li>
                ))}
              </ol>
              {d.ranked.length < d.eligibleOpenCount && <p className="small muted">{t('assistant.tfy.notRanked', { n: d.eligibleOpenCount })}</p>}
            </>
          )}
        </>
      )}
    </Card>
  );
}
