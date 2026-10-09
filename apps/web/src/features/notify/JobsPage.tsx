// Admin → Background jobs: the durable scheduler's jobs (last run, result, error, "Run now"), the entity's approval
// service levels (due hours, reminder, escalation target) and the approvals that are overdue right now.
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Spinner, Table, useAsync, useToast } from '../../components/ui';
import { notifyApi, type Job, type JobRunResult, type SlaSettings } from './api';
import { everyLabel, NotifySubnav } from './common';
import { OverdueApprovalsCard } from './OverdueApprovalsCard';

const ESCALATE_TO = ['NEXT_LEVEL_ROLE', 'TENANT_ADMIN', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'PROCUREMENT_OFFICER'];

export function JobsPage() {
  const { t } = useI18n();
  const [tick, setTick] = useState(0);
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('notify.j.title')}</h1>
          <p className="muted notify-lead">{t('notify.j.lead')}</p>
        </div>
      </header>
      <NotifySubnav />
      <JobsCard onRan={() => setTick((x) => x + 1)} />
      <div className="notify-two">
        <SlaCard />
        <OverdueApprovalsCard key={tick} showSettingsHint={false} />
      </div>
    </div>
  );
}

function resultText(r: Record<string, unknown> | null | undefined, t: (k: TKey, v?: Record<string, string | number>) => string, te: (p: string, v: string) => string) {
  if (!r) return '—';
  if (r.scope === 'OTHER_ENTITY') return t('notify.j.otherEntity');
  const parts = Object.entries(r)
    .filter(([k, v]) => !['trigger', 'scope'].includes(k) && (typeof v === 'number' || typeof v === 'string'))
    .map(([k, v]) => `${te('notify.jr.', k)}: ${v}`);
  const scope = r.scope === 'ENTITY' ? t('notify.j.scopeEntity') : r.scope === 'ALL' ? t('notify.j.scopeAll') : '';
  const trig = typeof r.trigger === 'string' ? te('notify.jt.', r.trigger) : '';
  return [parts.join(' · '), [trig, scope].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
}

function JobsCard({ onRan }: { onRan: () => void }) {
  const { t, te, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const isAdmin = hasRole('TENANT_ADMIN');
  const jobs = useAsync(() => notifyApi.jobs(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<JobRunResult | null>(null);
  const run = async (j: Job) => {
    setBusy(j.name);
    setLast(null);
    try {
      const r = await notifyApi.runJob(j.name);
      setLast(r);
      toast(r.status === 'OK' ? t('notify.j.ranOk') : r.status === 'SKIPPED_RUNNING' ? t('notify.j.ranBusy') : t('notify.j.ranErr'), r.status === 'ERROR' ? 'error' : 'success');
      jobs.reload();
      onRan();
    } catch (e) {
      toast(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title={t('notify.j.jobs')} actions={<Button variant="ghost" onClick={jobs.reload}>{t('common.refresh')}</Button>}>
      <AsyncView state={jobs} empty={t('notify.j.none')}>
        {(xs) => (
          <>
            {!xs.some((j) => j.scheduled) && <div className="alert alert-info small">{t('notify.j.timersOff')}</div>}
            <Table head={[t('notify.j.job'), t('notify.j.every'), t('notify.j.lastRun'), t('notify.j.status'), t('notify.j.result'), t('notify.j.runs'), '']}>
              {xs.map((j) => (
                <tr key={j.name}>
                  <td>
                    <div>{pick(j.labelEn, j.labelAr)}</div>
                    <div className="muted small notify-code" dir="ltr">
                      {j.name}
                    </div>
                  </td>
                  <td className="small">
                    {everyLabel(j.everyMs, t)}
                    <div className="muted small">{j.scheduled ? t('notify.j.scheduled') : t('notify.j.manualOnly')}</div>
                  </td>
                  <td className="small nowrap">{j.lastFinishedAt ? fmtDate(j.lastFinishedAt) : j.lastStartedAt ? fmtDate(j.lastStartedAt) : t('notify.j.never')}</td>
                  <td>
                    {j.running ? (
                      <Badge tone="info" label={t('notify.j.running')} />
                    ) : j.lastStatus ? (
                      <Badge tone={j.lastStatus === 'OK' ? 'success' : 'danger'} label={te('notify.js.', j.lastStatus)} />
                    ) : (
                      '—'
                    )}
                    {j.lastError && <div className="field-error small notify-err">{j.lastError}</div>}
                  </td>
                  <td className="small">{resultText(j.lastResult, t, te)}</td>
                  <td className="notify-num">{j.runCount}</td>
                  <td>
                    {isAdmin && (
                      <Button variant="secondary" busy={busy === j.name} disabled={busy !== null || j.running} onClick={() => run(j)}>
                        {t('notify.j.runNow')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {last && (
              <p className="small notify-lastrun" role="status">
                <strong dir="ltr">{last.name}</strong>: {te('notify.js.', last.status)}
                {last.result ? ` — ${resultText(last.result, t, te)}` : ''}
                {last.error ? ` — ${last.error}` : ''}
                {typeof last.durationMs === 'number' ? ` (${last.durationMs} ms)` : ''}
              </p>
            )}
            {isAdmin && <p className="muted small">{t('notify.j.runNowNote')}</p>}
          </>
        )}
      </AsyncView>
    </Card>
  );
}

function SlaCard() {
  const { t, te, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const isAdmin = hasRole('TENANT_ADMIN');
  const sla = useAsync(() => notifyApi.sla(), []);
  const [due, setDue] = useState('');
  const [remind, setRemind] = useState('');
  const [to, setTo] = useState('NEXT_LEVEL_ROLE');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    const s: SlaSettings | undefined = sla.data;
    if (!s) return;
    setDue(s.defaultDueHours === null ? '' : String(s.defaultDueHours));
    setRemind(s.remindBeforeHours === null ? '' : String(s.remindBeforeHours));
    setTo(s.escalateTo);
  }, [sla.data]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await notifyApi.saveSla({ defaultDueHours: due.trim() ? Number(due) : null, remindBeforeHours: remind.trim() ? Number(remind) : null, escalateTo: to });
      toast(t('notify.s.saved'));
      sla.reload();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  const escLabel = (v: string) => (v === 'NEXT_LEVEL_ROLE' ? t('notify.s.nextLevel') : te('role.', v));
  return (
    <Card title={t('notify.s.title')}>
      <p className="muted small">{t('notify.s.lead')}</p>
      {sla.loading && !sla.data ? (
        <Spinner />
      ) : sla.error ? (
        <ErrorBox error={sla.error} onRetry={sla.reload} />
      ) : (
        <form onSubmit={submit}>
          {err ? <ErrorBox error={err} /> : null}
          <Field label={t('notify.s.due')} hint={t('notify.s.dueHint')}>
            {(id, d) => <input id={id} aria-describedby={d} type="number" min="0.01" step="any" inputMode="decimal" value={due} readOnly={!isAdmin} onChange={(e) => setDue(e.target.value)} />}
          </Field>
          <Field label={t('notify.s.remind')} hint={t('notify.s.remindHint')}>
            {(id, d) => <input id={id} aria-describedby={d} type="number" min="0" step="any" inputMode="decimal" value={remind} readOnly={!isAdmin} onChange={(e) => setRemind(e.target.value)} />}
          </Field>
          <Field label={t('notify.s.escalateTo')} hint={t('notify.s.escalateHint')}>
            {(id, d) => (
              <select id={id} aria-describedby={d} value={to} disabled={!isAdmin} onChange={(e) => setTo(e.target.value)}>
                {(ESCALATE_TO.includes(to) ? ESCALATE_TO : [...ESCALATE_TO, to]).map((v) => (
                  <option key={v} value={v}>
                    {escLabel(v)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {isAdmin && (
            <Button type="submit" busy={busy}>
              {t('common.save')}
            </Button>
          )}
          {sla.data?.updatedAt && <p className="muted small">{t('notify.s.updated', { at: fmtDate(sla.data.updatedAt) })}</p>}
        </form>
      )}
    </Card>
  );
}
