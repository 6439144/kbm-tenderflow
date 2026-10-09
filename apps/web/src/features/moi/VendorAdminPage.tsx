// Administrator: vendor lifecycle overview (/admin/vendor-lifecycle) — subscription state, grades, fee exemption
// (per vendor or vendor category, FR-018), blocking for a date range or permanently with automatic reinstatement
// (FR-013/014, BR-006), and the lifecycle jobs (expiry, NOT-001 reminders, reinstatement) with a "run now".
import { useEffect, useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Modal, ReasonDialog, Table, useAsync, useToast } from '../../components/ui';
import { moiApi, type AdminVendorRow, type EntityPolicies, type JobsResult, type VendorCategory } from './api';
import { GradeList, SubBadge } from './shared';

export function VendorLifecycleAdminPage() {
  const { t, te, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const isAdmin = hasRole('TENANT_ADMIN');
  const rows = useAsync(() => moiApi.adminVendors(), []);
  const pol = useAsync(() => moiApi.policies(), []);
  const [blockFor, setBlockFor] = useState<AdminVendorRow | null>(null);
  const [liftFor, setLiftFor] = useState<AdminVendorRow | null>(null);
  const [exFor, setExFor] = useState<AdminVendorRow | null>(null);
  const [jobs, setJobs] = useState<JobsResult | null>(null);
  const [jobBusy, setJobBusy] = useState(false);
  const [jobErr, setJobErr] = useState<unknown>(null);
  const p = pol.data?.policies;
  const canBlock = Boolean(p && hasRole(...(p.blockRoles as never[])));

  useEffect(() => {
    if (window.location.hash === '#categories') document.getElementById('categories')?.scrollIntoView();
  }, [pol.data]);

  const runJobs = async () => {
    setJobBusy(true);
    setJobErr(null);
    try {
      setJobs(await moiApi.runJobs());
      rows.reload();
    } catch (e) {
      setJobErr(e);
    } finally {
      setJobBusy(false);
    }
  };

  return (
    <div className="stack moi-admin-vendors">
      <header className="page-head">
        <div>
          <h1>{t('moi.va.title')}</h1>
          <p className="muted moi-lead">{t('moi.va.subtitle')}</p>
        </div>
        <Button variant="ghost" onClick={rows.reload}>
          {t('common.refresh')}
        </Button>
      </header>

      {isAdmin && (
        <Card title={t('moi.jobs.title')}>
          <p className="small muted">{t('moi.jobs.body', { days: p ? p.renewalReminderDays.join(', ') : '—' })}</p>
          {jobErr ? <ErrorBox error={jobErr} /> : null}
          <div className="row wrap">
            <Button variant="secondary" busy={jobBusy} onClick={runJobs} data-tour="run-jobs">
              {t('moi.jobs.run')}
            </Button>
            {jobs && (
              <span className="small" role="status">
                {t('moi.jobs.result', { reinstated: jobs.reinstated, expired: jobs.expired, reminders: jobs.reminders })}
              </span>
            )}
          </div>
        </Card>
      )}

      <Card title={t('moi.va.vendors')}>
        <AsyncView state={rows} empty={t('moi.va.none')}>
          {(list) => (
            <Table head={[t('moi.va.vendor'), t('common.status'), t('moi.grades'), t('moi.sub.title'), t('moi.va.exemption'), t('moi.va.block'), t('common.actions')]}>
              {list.map((v) => (
                <tr key={v.id} data-vendor={v.crNumber} className={v.block ? 'moi-row-blocked' : undefined}>
                  <td>
                    <strong>{pick(v.legalNameEn, v.legalNameAr)}</strong>
                    <div className="muted small" dir="ltr">
                      {v.crNumber}
                    </div>
                  </td>
                  <td>
                    <Badge value={v.status} label={te('vst.', v.status)} />
                  </td>
                  <td>
                    <GradeList items={v.classifications} companyGrade={v.companyGrade} />
                  </td>
                  <td>
                    <SubBadge status={v.subscription.status} />
                    {v.subscription.paidUntil && (
                      <div className="small muted">
                        {t('moi.sub.until', { date: fmtDate(v.subscription.paidUntil) })}
                        {v.subscription.daysLeft !== null && ` · ${t('moi.sub.daysLeft', { n: v.subscription.daysLeft })}`}
                      </div>
                    )}
                  </td>
                  <td>
                    {v.exemption ? (
                      <>
                        <Badge tone="info" label={t(`moi.ex.${v.exemption.basis}` as TKey)} />
                        <div className="small muted">{v.exemption.reason}</div>
                      </>
                    ) : (
                      <span className="muted small">{v.vendorCategory ? `${t('moi.cat.label')}: ${v.vendorCategory}` : '—'}</span>
                    )}
                  </td>
                  <td>
                    {v.block ? (
                      <>
                        <Badge tone="danger" label={v.block.mode === 'PERMANENT' ? t('moi.block.permanent') : t('moi.block.until', { date: fmtDate(v.block.endsAt) })} />
                        <div className="small muted">{v.block.reason}</div>
                      </>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                  <td>
                    <div className="row wrap moi-actions">
                      {canBlock && !v.block && (
                        <Button variant="secondary" onClick={() => setBlockFor(v)}>
                          {t('moi.block.action')}
                        </Button>
                      )}
                      {canBlock && v.block && (
                        <Button variant="secondary" onClick={() => setLiftFor(v)}>
                          {t('moi.block.lift')}
                        </Button>
                      )}
                      {isAdmin && (
                        <Button variant="ghost" onClick={() => setExFor(v)}>
                          {t('moi.ex.action')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>

      <Categories canEdit={isAdmin} mode={p?.exemptionMode} />

      {blockFor && p && (
        <BlockDialog
          vendor={blockFor}
          policies={p}
          onClose={() => setBlockFor(null)}
          onDone={() => {
            setBlockFor(null);
            toast(t('moi.block.done'));
            rows.reload();
          }}
        />
      )}
      <ReasonDialog
        open={Boolean(liftFor)}
        title={t('moi.block.liftTitle', { name: liftFor ? pick(liftFor.legalNameEn, liftFor.legalNameAr) : '' })}
        confirmLabel={t('moi.block.lift')}
        required
        onClose={() => setLiftFor(null)}
        onConfirm={async (reason) => {
          await moiApi.lift(liftFor!.id, liftFor!.block!.id, reason);
          toast(t('moi.block.lifted'));
          rows.reload();
        }}
      />
      {exFor && (
        <ExemptionDialog
          vendor={exFor}
          mode={p?.exemptionMode ?? 'PER_VENDOR'}
          onClose={() => setExFor(null)}
          onDone={() => {
            setExFor(null);
            toast(t('moi.ex.saved'));
            rows.reload();
          }}
        />
      )}
    </div>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function BlockDialog({ vendor, policies, onClose, onDone }: { vendor: AdminVendorRow; policies: EntityPolicies; onClose: () => void; onDone: () => void }) {
  const { t, pick } = useI18n();
  const [mode, setMode] = useState<'DATE_RANGE' | 'PERMANENT'>('DATE_RANGE');
  const [from, setFrom] = useState(toLocalInput(new Date()));
  const [to, setTo] = useState(toLocalInput(new Date(Date.now() + 7 * 86_400_000)));
  const [ground, setGround] = useState(policies.blockGrounds[0]?.code ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await moiApi.block(vendor.id, {
        mode,
        from: new Date(from).toISOString(),
        to: mode === 'DATE_RANGE' ? new Date(to).toISOString() : undefined,
        ground: ground || undefined,
        reason: reason.trim(),
      });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t('moi.block.title', { name: pick(vendor.legalNameEn, vendor.legalNameAr) })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" busy={busy} disabled={!reason.trim() || (mode === 'DATE_RANGE' && !to)} onClick={submit}>
            {t('moi.block.confirm')}
          </Button>
        </>
      }
    >
      {err ? <ErrorBox error={err} /> : null}
      <p className="small muted">{t('moi.block.effect', { effect: t(`moi.opt.blockEffectOnSubscription.${policies.blockEffectOnSubscription}` as TKey) })}</p>
      <div className="segmented" role="radiogroup" aria-label={t('moi.block.mode')}>
        {(['DATE_RANGE', 'PERMANENT'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {t(`moi.block.${m}` as TKey)}
          </button>
        ))}
      </div>
      <div className="grid-2">
        <Field label={t('moi.block.from')} required>
          {(id) => <input id={id} type="datetime-local" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </Field>
        {mode === 'DATE_RANGE' && (
          <Field label={t('moi.block.to')} required hint={t('moi.block.toHint')}>
            {(id, d) => <input id={id} aria-describedby={d} type="datetime-local" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        )}
      </div>
      <Field label={t('moi.block.ground')}>
        {(id) => (
          <select id={id} value={ground} onChange={(e) => setGround(e.target.value)}>
            {policies.blockGrounds.map((g) => (
              <option key={g.code} value={g.code}>
                {pick(g.en, g.ar)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('common.reason')} required>
        {(id) => <textarea id={id} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <p className="small muted">{t('moi.block.notice')}</p>
    </Modal>
  );
}

function ExemptionDialog({ vendor, mode, onClose, onDone }: { vendor: AdminVendorRow; mode: EntityPolicies['exemptionMode']; onClose: () => void; onDone: () => void }) {
  const { t, pick } = useI18n();
  const cats = useAsync(() => moiApi.categories(), []);
  const [exempt, setExempt] = useState(vendor.feeExempt);
  const [reason, setReason] = useState(vendor.exemption?.basis === 'PER_VENDOR' ? vendor.exemption.reason : '');
  const [category, setCategory] = useState(vendor.vendorCategory ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body: { feeExempt?: boolean; reason?: string; vendorCategory?: string | null } = { vendorCategory: category || null };
      if (exempt !== vendor.feeExempt || (exempt && reason.trim())) {
        body.feeExempt = exempt;
        if (reason.trim()) body.reason = reason.trim();
      }
      await moiApi.setExemption(vendor.id, body);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={t('moi.ex.title', { name: pick(vendor.legalNameEn, vendor.legalNameAr) })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={exempt && !vendor.feeExempt && !reason.trim()} onClick={submit}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {err ? <ErrorBox error={err} /> : null}
      <div className="alert alert-info small">{t(mode === 'PER_VENDOR' ? 'moi.ex.modeVendor' : 'moi.ex.modeCategory')}</div>
      <label className="check">
        <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
        <span>{t('moi.ex.flag')}</span>
      </label>
      {exempt && (
        <Field label={t('common.reason')} required={!vendor.feeExempt}>
          {(id) => <textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      )}
      <Field label={t('moi.cat.label')}>
        {(id) => (
          <select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">—</option>
            {(cats.data ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {pick(c.nameEn, c.nameAr)} {c.feeExempt ? `(${t('moi.cat.exempt')})` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
    </Modal>
  );
}

function Categories({ canEdit, mode }: { canEdit: boolean; mode?: EntityPolicies['exemptionMode'] }) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const list = useAsync(() => moiApi.categories(), []);
  const [draft, setDraft] = useState<VendorCategory>({ code: '', nameEn: '', nameAr: '', feeExempt: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async (c: VendorCategory) => {
    setBusy(true);
    setErr(null);
    try {
      list.setData(await moiApi.saveCategory(c));
      setDraft({ code: '', nameEn: '', nameAr: '', feeExempt: false });
      toast(t('moi.cat.saved'));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('moi.cat.title')} id="categories">
      <p className="small muted">{t(mode === 'CATEGORY' ? 'moi.cat.activeHint' : 'moi.cat.inactiveHint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <AsyncView state={list} empty={t('moi.cat.none')}>
        {(cs) => (
          <Table head={[t('moi.codes.code'), t('moi.codes.en'), t('moi.codes.ar'), t('moi.cat.exempt')]}>
            {cs.map((c) => (
              <tr key={c.code}>
                <td dir="ltr">
                  <code>{c.code}</code>
                </td>
                <td>{c.nameEn}</td>
                <td>{c.nameAr}</td>
                <td>
                  {canEdit ? (
                    <label className="check">
                      <input type="checkbox" checked={c.feeExempt} disabled={busy} onChange={(e) => save({ ...c, feeExempt: e.target.checked })} />
                      <span>{pick(c.nameEn, c.nameAr)}</span>
                    </label>
                  ) : (
                    t(c.feeExempt ? 'moi.on' : 'moi.off')
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
      {canEdit && (
        <div className="moi-cat-form">
          <input aria-label={t('moi.codes.code')} placeholder={t('moi.codes.code')} dir="ltr" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <input aria-label={t('moi.codes.en')} placeholder={t('moi.codes.en')} dir="ltr" value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} />
          <input aria-label={t('moi.codes.ar')} placeholder={t('moi.codes.ar')} dir="rtl" value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={draft.feeExempt} onChange={(e) => setDraft({ ...draft, feeExempt: e.target.checked })} />
            <span>{t('moi.cat.exempt')}</span>
          </label>
          <Button variant="secondary" busy={busy} disabled={!draft.code || !draft.nameEn.trim() || !draft.nameAr.trim()} onClick={() => save(draft)}>
            {t('moi.cat.add')}
          </Button>
        </div>
      )}
    </Card>
  );
}
