// Vendor side of the lifecycle: the "Subscription & grade" page (/vendor/subscription) — annual subscription with
// the payment link (TEST gateway, labelled; KNET refused until configured), renewal, receipts, grades, grade upgrade
// request with documents (FR-010), exemption and suspension notices — and a compact summary card for the vendor home.
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Table, useAsync, useToast } from '../../components/ui';
import { linkToken, moiApi, type Lifecycle, type Subscription } from './api';
import { GradeList, gradeName, SubBadge } from './shared';

const MAX_FILES = 5;

export function VendorSubscriptionPage() {
  const { t } = useI18n();
  const life = useAsync(() => moiApi.myLifecycle(), []);
  const pol = useAsync(() => moiApi.policies(), []);
  return (
    <div className="stack moi-vendor">
      <header className="page-head">
        <div>
          <h1>{t('moi.vs.title')}</h1>
          <p className="muted moi-lead">{t('moi.vs.subtitle')}</p>
        </div>
      </header>
      <AsyncView state={life}>
        {(l) => (
          <>
            <SubscriptionCard l={l} reminderDays={pol.data?.policies.renewalReminderDays ?? [30]} onChange={life.reload} />
            {l.exemption && (
              <Card title={t('moi.va.exemption')}>
                <p>
                  <Badge tone="info" label={t(`moi.ex.${l.exemption.basis}` as TKey)} /> {l.exemption.reason}
                </p>
                <p className="small muted">{t(`moi.opt.exemptionWaives.${l.exemption.waives}` as TKey)}</p>
              </Card>
            )}
            <div className="grid-2 moi-vendor-grid">
              <Card title={t('moi.grades')} id="my-grades">
                <GradeList items={l.classifications} companyGrade={l.companyGrade} />
              </Card>
              <Card title={t('moi.vs.regDocs')}>
                <ul className="small">
                  {l.registrationDocuments.map((r) => (
                    <RegDoc key={r.code} code={r.code} en={r.en} ar={r.ar} />
                  ))}
                </ul>
                <p className="small">
                  <Link to="/vendor">{t('moi.vs.uploadOnHome')}</Link>
                </p>
              </Card>
            </div>
            <UpgradeCard l={l} gradeScope={pol.data?.policies.gradeScope ?? 'PER_ACTIVITY'} onChange={life.reload} />
          </>
        )}
      </AsyncView>
    </div>
  );
}

function RegDoc({ code, en, ar }: { code: string; en: string; ar: string }) {
  const { pick } = useI18n();
  return (
    <li>
      <code dir="ltr">{code}</code> — {pick(en, ar)}
    </li>
  );
}

function SubscriptionCard({ l, reminderDays, onChange }: { l: Lifecycle; reminderDays: number[]; onChange: () => void }) {
  const { t, fmtDate, fmtMoney } = useI18n();
  const toast = useToast();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const s = l.subscription;
  const pending = s.pending;
  const token = linkToken(pending?.payLink);
  const fromLink = params.get('link');
  const renewWindow = Math.max(30, ...reminderDays);
  const renewDue = s.required && !pending && (s.status === 'EXPIRED' || s.status === 'NONE' || (s.daysLeft !== null && s.daysLeft <= renewWindow));

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      toast(ok);
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t('moi.sub.title')} id="subscription">
      {err ? <ErrorBox error={err} /> : null}
      {!s.required && <p className="muted small">{t('moi.sub.notRequired')}</p>}
      <div className="moi-sub-head">
        <SubBadge status={s.status} />
        {s.paidUntil && <strong>{t('moi.sub.until', { date: fmtDate(s.paidUntil) })}</strong>}
        {s.daysLeft !== null && <span className={`moi-days ${s.daysLeft <= 7 ? 'moi-days-low' : ''}`}>{t('moi.sub.daysLeft', { n: s.daysLeft })}</span>}
      </div>
      <dl className="kv">
        <dt>{t('moi.sub.fee')}</dt>
        <dd>
          {fmtMoney(s.fee, s.currency)} · {t('moi.sub.term', { n: s.termMonths })}
        </dd>
        <dt>{t('moi.sub.startRule')}</dt>
        <dd>{t(`moi.opt.subscriptionStart.${s.startRule}` as TKey)}</dd>
      </dl>
      {s.required && (s.status === 'EXPIRED' || s.status === 'NONE') && (
        <div className="alert alert-danger" role="status">
          {t('moi.sub.blockedNote')}
        </div>
      )}
      {s.status === 'ACTIVE' && s.daysLeft !== null && s.daysLeft <= renewWindow && (
        <div className="alert alert-warn" role="status" data-tour="renewal-reminder">
          {t('moi.sub.reminder', { date: fmtDate(s.paidUntil), n: s.daysLeft })}
        </div>
      )}

      {pending && token && (
        <div className={`moi-paylink ${fromLink === token ? 'moi-paylink-hot' : ''}`} data-tour="pay-link">
          <div className="row spread wrap">
            <strong>{t(pending.kind === 'NEW' ? 'moi.sub.payNew' : 'moi.sub.payRenewal', { amount: fmtMoney(pending.amount, pending.currency) })}</strong>
            <span className="muted small">{t('moi.sub.issued', { date: fmtDate(pending.createdAt) })}</span>
          </div>
          <div className="cyc-test-banner" role="note">
            <strong>{t('cycle.testTitle')}</strong> {t('cycle.testBody')}
          </div>
          <div className="row wrap">
            <Button busy={busy === 'test'} onClick={() => run('test', () => moiApi.paySubscription(token, 'TEST'), t('moi.sub.paid'))}>
              {t('moi.sub.payTest')}
            </Button>
            <Button variant="secondary" busy={busy === 'knet'} onClick={() => run('knet', () => moiApi.paySubscription(token, 'KNET'), t('moi.sub.paid'))}>
              {t('moi.sub.payKnet')}
            </Button>
          </div>
          <p className="small muted">{t('moi.sub.knetNote')}</p>
        </div>
      )}
      {renewDue && (
        <Button variant="secondary" busy={busy === 'renew'} onClick={() => run('renew', () => moiApi.renew(), t('moi.sub.linkReady'))} data-tour="renew">
          {t(s.status === 'ACTIVE' ? 'moi.sub.renew' : 'moi.sub.requestLink')}
        </Button>
      )}

      {s.history.length > 0 && (
        <>
          <h3>{t('moi.sub.history')}</h3>
          <Table head={[t('moi.sub.kind'), t('common.status'), t('moi.sub.period'), t('cycle.amount'), t('cycle.gateway'), t('cycle.receiptNo')]}>
            {s.history.map((h: Subscription) => (
              <tr key={h.id}>
                <td>{t(`moi.sub.k.${h.kind}` as TKey)}</td>
                <td>
                  <Badge tone={h.status === 'ACTIVE' ? 'success' : h.status === 'PENDING_PAYMENT' ? 'warn' : 'neutral'} label={t(`moi.sub.hs.${h.status}` as TKey)} />
                  {h.pausedDays > 0 && <div className="small muted">{t('moi.sub.paused', { n: h.pausedDays })}</div>}
                </td>
                <td className="small">{h.startsAt ? `${fmtDate(h.startsAt)} → ${fmtDate(h.endsAt)}` : '—'}</td>
                <td>{fmtMoney(h.amount, h.currency)}</td>
                <td>{h.gateway ? t(`cycle.gwName.${h.gateway}` as TKey) : '—'}</td>
                <td dir="ltr">{h.receiptNumber ? <Link to={`/receipt/${encodeURIComponent(h.receiptNumber)}`}>{h.receiptNumber}</Link> : '—'}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </Card>
  );
}

function UpgradeCard({ l, gradeScope, onChange }: { l: Lifecycle; gradeScope: 'COMPANY' | 'PER_ACTIVITY'; onChange: () => void }) {
  const { t, pick, fmtDate } = useI18n();
  const toast = useToast();
  const company = gradeScope === 'COMPANY';
  const [activity, setActivity] = useState(l.classifications[0]?.activityCode ?? '');
  const current = company ? l.companyGrade : l.classifications.find((c) => c.activityCode === activity)?.grade ?? null;
  const options = [1, 2, 3].filter((g) => current === null || current === undefined || g < current);
  const [requested, setRequested] = useState<number | null>(null);
  const [justification, setJustification] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const grade = requested !== null && options.includes(requested) ? requested : options[options.length - 1] ?? null;
  const open = l.upgradeRequests.some((u) => u.status === 'SUBMITTED' && (company || u.activityCode === activity));
  const approved = l.vendorStatus === 'APPROVED';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!grade || !files.length) return;
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      if (!company) form.append('activityCode', activity);
      form.append('requestedGrade', String(grade));
      form.append('justification', justification.trim());
      for (const f of files) form.append('files', f);
      await moiApi.requestUpgrade(form);
      toast(t('moi.up.sent'));
      setFiles([]);
      setJustification('');
      onChange();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('moi.up.vendorTitle')} id="grade-upgrade">
      {l.upgradeRequests.length > 0 && (
        <Table head={[t('moi.up.number'), t('moi.up.activity'), t('moi.up.change'), t('common.date'), t('common.status')]}>
          {l.upgradeRequests.map((u) => (
            <tr key={u.id}>
              <td dir="ltr">{u.requestNumber}</td>
              <td dir="ltr">{u.activityCode ?? t('moi.companyGrade')}</td>
              <td>
                {gradeName(t, u.currentGrade)} → {gradeName(t, u.grantedGrade ?? u.requestedGrade)}
              </td>
              <td>{fmtDate(u.createdAt)}</td>
              <td>
                <Badge tone={u.status === 'APPROVED' ? 'success' : u.status === 'REJECTED' ? 'danger' : 'warn'} label={t(`moi.up.st.${u.status}` as TKey)} />
                {u.decisionReason && <div className="small muted">{u.decisionReason}</div>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {!approved ? (
        <p className="muted">{t('moi.up.onlyApproved')}</p>
      ) : !company && l.classifications.length === 0 ? (
        <p className="muted">{t('moi.up.noActivities')}</p>
      ) : (
        <form className="inline-form" onSubmit={submit}>
          <h3>{t('moi.up.new')}</h3>
          {err ? <ErrorBox error={err} /> : null}
          <div className="grid-2">
            {!company && (
              <Field label={t('moi.up.activity')} required>
                {(id) => (
                  <select id={id} value={activity} onChange={(e) => setActivity(e.target.value)}>
                    {l.classifications.map((c) => (
                      <option key={c.activityCode} value={c.activityCode}>
                        {c.activityCode} — {pick(c.nameEn, c.nameAr)} ({gradeName(t, c.grade)})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <Field label={t('moi.up.requested')} required>
              {(id) =>
                options.length ? (
                  <select id={id} value={grade ?? ''} onChange={(e) => setRequested(Number(e.target.value))}>
                    {options.map((g) => (
                      <option key={g} value={g}>
                        {gradeName(t, g)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p id={id} className="muted small">
                    {t('moi.up.highest')}
                  </p>
                )
              }
            </Field>
          </div>
          <Field label={t('moi.up.justification')}>
            {(id) => <textarea id={id} rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} />}
          </Field>
          <Field label={t('moi.up.files', { n: MAX_FILES })} required hint={t('moi.up.filesHint')}>
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                type="file"
                multiple
                onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, MAX_FILES))}
              />
            )}
          </Field>
          {open && <div className="alert alert-info small">{t('moi.up.openExists')}</div>}
          <Button type="submit" busy={busy} disabled={!grade || !files.length}>
            {t('moi.up.submit')}
          </Button>
        </form>
      )}
    </Card>
  );
}

/** Vendor home: one-glance subscription / suspension / exemption state with a link to the full page. */
export function VendorLifecycleSummary() {
  const { t, fmtDate } = useI18n();
  const life = useAsync(() => moiApi.myLifecycle(), []);
  const l = life.data;
  if (!l || (!l.subscription.required && !l.exemption && !l.upgradeRequests.length)) return null;
  const s = l.subscription;
  const low = s.status === 'ACTIVE' && s.daysLeft !== null && s.daysLeft <= 30;
  return (
    <Card className="moi-summary" title={t('moi.vs.title')} actions={<Link to="/vendor/subscription">{t('moi.vs.manage')}</Link>}>
      <div className="moi-sub-head">
        <SubBadge status={s.status} />
        {s.paidUntil && <span>{t('moi.sub.until', { date: fmtDate(s.paidUntil) })}</span>}
        {s.daysLeft !== null && <span className={`moi-days ${s.daysLeft <= 7 ? 'moi-days-low' : ''}`}>{t('moi.sub.daysLeft', { n: s.daysLeft })}</span>}
        {l.exemption && <Badge tone="info" label={t(`moi.ex.${l.exemption.basis}` as TKey)} />}
      </div>
      {s.required && (s.status === 'EXPIRED' || s.status === 'NONE' || s.status === 'PENDING_PAYMENT') && (
        <div className="alert alert-danger small" role="status">
          {t(s.status === 'PENDING_PAYMENT' ? 'moi.sub.payToActivate' : 'moi.sub.blockedNote')}
        </div>
      )}
      {low && (
        <div className="alert alert-warn small" role="status">
          {t('moi.sub.reminder', { date: fmtDate(s.paidUntil), n: s.daysLeft ?? 0 })}
        </div>
      )}
    </Card>
  );
}
