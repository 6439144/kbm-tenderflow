// "Overdue approvals" card (staff dashboards, Admin → Background jobs): approval levels waiting past their service
// level (GET /approvals/overdue). The approval itself is never changed by an escalation — people still decide.
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, useAsync } from '../../components/ui';
import { notifyApi } from './api';
import { useDuration } from './common';

export function OverdueApprovalsCard({ showSettingsHint = true }: { showSettingsHint?: boolean }) {
  const { t, te, pick, fmtDate } = useI18n();
  const { user } = useSession();
  const dur = useDuration();
  const state = useAsync(() => notifyApi.overdue(), [user?.id]);
  const n = state.data?.items.length ?? 0;
  return (
    <Card
      className="notify-overdue"
      title={
        <span className="row">
          {t('notify.o.title')}
          {n > 0 && <Badge tone="danger" label={String(n)} />}
        </span>
      }
      actions={
        <Button variant="ghost" onClick={state.reload}>
          {t('common.refresh')}
        </Button>
      }
    >
      <AsyncView state={state}>
        {(d) =>
          !d.active ? (
            <p className="muted small">
              {t('notify.o.noSla')} {showSettingsHint && t('notify.o.noSlaHint')}
            </p>
          ) : (
            <>
              {d.items.length === 0 ? (
                <p className="muted">{t('notify.o.none')}</p>
              ) : (
                <ul className="notify-overdue-list">
                  {d.items.map((x) => (
                    <li key={`${x.subjectId}-${x.gate}-${x.level}`}>
                      <Link to={x.path} className="notify-overdue-item">
                        <Badge tone="danger" label={t('notify.o.overdueBy', { d: dur(x.overdueMs) })} />
                        <span className="notify-overdue-text">
                          <span className="small muted" dir="ltr">
                            {x.reference}
                          </span>
                          <span>{pick(x.titleEn, x.titleAr)}</span>
                          <span className="small">
                            {te('notify.gate.', x.gate)} · {t('notify.o.level', { n: x.level, total: x.of })} · {pick(x.labelEn, x.labelAr) || te('role.', x.role)}
                          </span>
                          <span className="small muted">
                            {x.escalation
                              ? t('notify.o.escalated', { to: te('role.', x.escalation.escalatedTo ?? ''), at: fmtDate(x.escalation.at) })
                              : t('notify.o.notEscalatedYet')}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted small notify-overdue-foot">{t('notify.o.foot', { waiting: d.waiting, soon: d.dueSoon })}</p>
            </>
          )
        }
      </AsyncView>
    </Card>
  );
}
