// AI value meter (GET /assistant/insights, TENANT_ADMIN and AUDITOR): runs per agent task, completed vs failed, the
// human review decisions and the drafts people saved. Computed only from recorded data — no estimates.
// Shown in the assistant dock ("AI insights" tab) for admins/auditors; can also be mounted on an admin page.
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Card, useAsync } from '../../components/ui';
import { assistantApi } from './api-assistant';

function secs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function AiInsightsCard({ compact }: { compact?: boolean }) {
  const { t, fmtDate } = useI18n();
  const state = useAsync(() => assistantApi.insights(), []);
  const body = (
    <AsyncView state={state}>
      {(d) => (
        <div className="stack-sm">
          <p className="small muted">{t('assistant.insights.source')}</p>
          {!d.configured && d.totals.runs > 0 && <p className="small muted">{t('assistant.insights.notConnected')}</p>}
          {d.totals.runs === 0 ? (
            <p className="muted">{t('assistant.insights.none')}</p>
          ) : (
            <>
              <div className="ast-stats">
                <Stat label={t('assistant.insights.runs')} value={d.totals.runs} />
                <Stat label={t('assistant.insights.ok')} value={d.totals.ok} />
                <Stat label={t('assistant.insights.error')} value={d.totals.error} />
                <Stat label={t('assistant.insights.accepted')} value={d.totals.accepted} />
                <Stat label={t('assistant.insights.edited')} value={d.totals.edited} />
                <Stat label={t('assistant.insights.median')} value={secs(d.totals.medianDurationMs)} />
              </div>
              <div className="ast-table-wrap">
                <table className="ast-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('assistant.insights.kind')}</th>
                      <th scope="col">{t('assistant.insights.ok')}</th>
                      <th scope="col">{t('assistant.insights.error')}</th>
                      <th scope="col">{t('assistant.insights.accepted')}</th>
                      <th scope="col">{t('assistant.insights.edited')}</th>
                      <th scope="col">{t('assistant.insights.ignored')}</th>
                      <th scope="col">{t('assistant.insights.median')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byKind.filter((k) => k.total > 0).map((k) => (
                      <tr key={k.kind}>
                        <th scope="row" title={k.agents.join(', ')}>{t(`assistant.kind.${k.kind}` as TKey)}</th>
                        <td>{k.ok}</td>
                        <td>{k.error}</td>
                        <td>{k.accepted}</td>
                        <td>{k.edited}</td>
                        <td>{k.ignored}</td>
                        <td>{secs(k.medianDurationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>{t('assistant.insights.adoption')}</h3>
              <div className="ast-stats">
                <Stat label={t('assistant.insights.clarifications')} value={d.adoption.clarificationsAnsweredFromDraft} />
                <Stat label={t('assistant.insights.notices')} value={d.adoption.noticesSavedFromDraft} />
                <Stat label={t('assistant.insights.narratives')} value={d.adoption.narrativesSaved} />
              </div>
              <p className="small muted">
                {fmtDate(d.firstRunAt)} – {fmtDate(d.lastRunAt)}
              </p>
            </>
          )}
        </div>
      )}
    </AsyncView>
  );
  if (compact) return body;
  return (
    <Card title={<>{t('assistant.insights.title')} <span className="ai-tag">watsonx Orchestrate</span></>} actions={undefined}>
      {body}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="ast-stat">
      <div className="ast-stat-v">{value}</div>
      <div className="ast-stat-l">{label}</div>
    </div>
  );
}
