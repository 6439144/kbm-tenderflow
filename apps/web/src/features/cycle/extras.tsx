// Cycle pieces mounted on existing pages: tender form cycle fields, vendor classifications, dashboard cards.
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type Role, type Tender } from '../../api';
import { platform, type CycleTemplate, type StageInfo, type CycleConfig } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Spinner, Table, useAsync, useToast } from '../../components/ui';
import { APPROVER_ROLES, GRADES, REQUEST_TONE, StageStrip, TemplateBadge, useCycleFmt, waitingStep, type Step } from './common';

// ---------------------------------------------------------------- tender form: template + eligibility

export interface TenderCycleValue {
  templateId: string;
  eligibility: { activityCodes: string[]; minGrade: number | null };
}

/**
 * Template selector (create) or pinned template (edit) with its stage strip, plus the per-tender eligibility rule.
 * `onTemplate` reports the chosen template's config so the form can apply the two-envelope criteria rule.
 */
export function TenderCycleFields({
  value,
  onChange,
  pinned,
  onTemplate,
}: {
  value: TenderCycleValue;
  onChange: (v: TenderCycleValue) => void;
  pinned?: { template?: Tender['template']; cycle?: CycleConfig; stages?: StageInfo[] } | null;
  onTemplate?: (cfg: CycleConfig | null) => void;
}) {
  const { t, pick } = useI18n();
  const templates = useAsync(() => (pinned ? Promise.resolve<CycleTemplate[]>([]) : platform.templates()), [Boolean(pinned)]);
  const codes = useAsync(() => platform.activityCodes(), []);
  const tpl = templates.data?.find((x) => x.id === value.templateId) ?? null;

  // Preselect the entity's default template on create.
  useEffect(() => {
    if (pinned || value.templateId || !templates.data?.length) return;
    const d = templates.data.find((x) => x.isDefault) ?? templates.data[0];
    onChange({ templateId: d.id, eligibility: { activityCodes: [...d.config.eligibility.activityCodes], minGrade: d.config.eligibility.minGrade } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.data, pinned]);

  useEffect(() => {
    onTemplate?.(pinned ? pinned.cycle ?? null : tpl?.config ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl?.id, pinned?.cycle]);

  const choose = (id: string) => {
    const x = templates.data?.find((y) => y.id === id);
    onChange({ templateId: id, eligibility: x ? { activityCodes: [...x.config.eligibility.activityCodes], minGrade: x.config.eligibility.minGrade } : value.eligibility });
  };
  const toggleCode = (code: string, on: boolean) => {
    const s = new Set(value.eligibility.activityCodes);
    if (on) s.add(code);
    else s.delete(code);
    onChange({ ...value, eligibility: { ...value.eligibility, activityCodes: [...s].sort() } });
  };

  return (
    <Card title={t('cycle.f.title')}>
      {pinned ? (
        <div className="stack-sm">
          <div className="row wrap">
            <TemplateBadge tpl={pinned.template} />
            <span className="muted small">{t('cycle.f.pinned')}</span>
          </div>
          {pinned.stages && <StageStrip stages={pinned.stages} cfg={pinned.cycle} hideOff compact />}
        </div>
      ) : templates.loading && !templates.data ? (
        <Spinner />
      ) : templates.error ? (
        <ErrorBox error={templates.error} onRetry={templates.reload} />
      ) : (templates.data ?? []).length === 0 ? (
        <div className="alert alert-info">{t('cycle.f.noTemplates')}</div>
      ) : (
        <>
          <Field label={t('cycle.template')} required hint={t('cycle.f.templateHint')}>
            {(id, d) => (
              <select id={id} aria-describedby={d} value={value.templateId} onChange={(e) => choose(e.target.value)} required>
                {(templates.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {pick(x.nameEn, x.nameAr)} · v{x.version}
                    {x.isDefault ? ` (${t('cycle.default')})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {tpl && <StageStrip stages={tpl.stages} cfg={tpl.config} hideOff compact />}
        </>
      )}
      <fieldset className="cyc-fieldset cyc-mt">
        <legend>{t('cycle.f.eligibility')}</legend>
        <p className="hint">{t('cycle.f.eligibilityHint')}</p>
        {codes.data && codes.data.length > 0 ? (
          <div className="checks">
            {codes.data.map((a) => (
              <label key={a.code} className="check">
                <input type="checkbox" checked={value.eligibility.activityCodes.includes(a.code)} onChange={(e) => toggleCode(a.code, e.target.checked)} />
                <span>
                  <span dir="ltr">{a.code}</span> — {pick(a.nameEn, a.nameAr)}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="muted small">{t('cycle.e.noCodes')}</p>
        )}
        <Field label={t('cycle.minGrade')}>
          {(id) => (
            <select
              id={id}
              value={value.eligibility.minGrade ?? ''}
              onChange={(e) => onChange({ ...value, eligibility: { ...value.eligibility, minGrade: e.target.value === '' ? null : Number(e.target.value) } })}
            >
              <option value="">{t('cycle.grade.none')}</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {t(`cycle.grade.${g}` as TKey)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </fieldset>
    </Card>
  );
}

// ---------------------------------------------------------------- vendor classifications (activity code + grade)

export function ClassificationsEditor({ vendorId, canEdit }: { vendorId: string; canEdit: boolean }) {
  const { t, pick, fmtDate } = useI18n();
  const { grade } = useCycleFmt();
  const toast = useToast();
  const list = useAsync(() => platform.classifications(vendorId), [vendorId]);
  const codes = useAsync(() => (canEdit ? platform.activityCodes() : Promise.resolve([])), [canEdit]);
  const [code, setCode] = useState('');
  const [g, setG] = useState('2');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const today = new Date().toISOString().slice(0, 10);
  // A classification created from an accepted MOCI certificate (document intelligence) refreshes this list.
  useEffect(() => {
    const on = () => list.reload();
    window.addEventListener('tf:classifications-changed', on);
    return () => window.removeEventListener('tf:classifications-changed', on);
  }, [list.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setErr(null);
    try {
      list.setData(await platform.setClassification(vendorId, { activityCode: code, grade: Number(g), ...(until ? { validUntil: until } : {}) }));
      toast(t('cycle.c.saved'));
      setCode('');
      setUntil('');
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (c: string) => {
    setBusy(c);
    setErr(null);
    try {
      list.setData(await platform.setClassification(vendorId, { activityCode: c, remove: true }));
      toast(t('cycle.c.removed'));
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack-sm">
      <h3>{t('cycle.c.title')}</h3>
      <p className="muted small">{t('cycle.c.hint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <AsyncView state={list} empty={t('cycle.c.none')}>
        {(xs) => (
          <Table head={[t('cycle.e.code'), t('cycle.c.grade'), t('cycle.c.validUntil'), ...(canEdit ? [t('common.actions')] : [])]}>
            {xs.map((c) => {
              const expired = Boolean(c.validUntil && c.validUntil.slice(0, 10) < today);
              return (
                <tr key={c.activityCode}>
                  <td>
                    <code dir="ltr">{c.activityCode}</code> <span className="small">{pick(c.nameEn, c.nameAr)}</span>
                  </td>
                  <td>
                    <Badge tone={c.grade === 1 ? 'success' : c.grade === 2 ? 'info' : 'neutral'} label={grade(c.grade)} />
                  </td>
                  <td>
                    {c.validUntil ? fmtDate(c.validUntil).split(',')[0] : t('cycle.c.noExpiry')}
                    {expired && <Badge tone="danger" label={t('cycle.c.expired')} />}
                  </td>
                  {canEdit && (
                    <td>
                      <Button variant="ghost" busy={busy === c.activityCode} onClick={() => remove(c.activityCode)}>
                        {t('common.remove')}
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </Table>
        )}
      </AsyncView>
      {canEdit && (
        <form className="cyc-class-form" onSubmit={save}>
          <Field label={t('cycle.e.code')} required>
            {(id) => (
              <select id={id} value={code} onChange={(e) => setCode(e.target.value)} required>
                <option value="">{t('cycle.c.chooseCode')}</option>
                {(codes.data ?? []).map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} — {pick(a.nameEn, a.nameAr)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('cycle.c.grade')} required>
            {(id) => (
              <select id={id} value={g} onChange={(e) => setG(e.target.value)}>
                {GRADES.map((x) => (
                  <option key={x} value={x}>
                    {t(`cycle.grade.${x}` as TKey)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('cycle.c.validUntil')}>{(id) => <input id={id} type="date" value={until} onChange={(e) => setUntil(e.target.value)} dir="ltr" />}</Field>
          <Button type="submit" busy={busy === 'save'} disabled={!code}>
            {t('cycle.c.save')}
          </Button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- dashboard: waiting for my approval

interface WaitingItem {
  kind: 'TENDER' | 'AWARD' | 'REQUEST';
  id: string;
  number: string;
  title: string;
  level: number;
  total: number;
  to: string;
}

export function ApprovalsWaitingCard() {
  const { t, te, pick } = useI18n();
  const { user, hasRole } = useSession();
  const approver = hasRole(...APPROVER_ROLES);
  const state = useAsync(async (): Promise<WaitingItem[]> => {
    if (!user || !approver) return [];
    const mine = (s: Step | undefined) => Boolean(s && user.roles.includes(s.role as Role));
    const out: WaitingItem[] = [];
    const tenders = (await api.tenders()).filter((x) => ['DRAFT', 'PENDING_APPROVAL', 'EVALUATION'].includes(x.status));
    const details = await Promise.all(tenders.map((x) => api.tender(x.id).catch(() => null)));
    for (const d of details) {
      if (!d) continue;
      if (d.status === 'EVALUATION') {
        const w = waitingStep(d.awardChain as Step[] | null);
        if (d.award?.status === 'RECOMMENDED' && mine(w) && d.award.recommendedBy !== user.id && !(d.awardChain as Step[]).some((s) => s.approverId === user.id))
          out.push({ kind: 'AWARD', id: d.id, number: d.tenderNumber ?? '', title: pick(d.titleEn, d.titleAr), level: w!.level, total: d.awardChain!.length, to: `/procurement/tenders/${d.id}` });
        continue;
      }
      const chain = (d.approvalChain ?? []) as Step[];
      const w = waitingStep(chain);
      if (mine(w) && d.createdBy !== user.id && !chain.some((s) => s.approverId === user.id))
        out.push({ kind: 'TENDER', id: d.id, number: d.tenderNumber ?? '', title: pick(d.titleEn, d.titleAr), level: w!.level, total: chain.length, to: `/procurement/tenders/${d.id}` });
    }
    const reqs = (await platform.requests()).filter((r) => r.status === 'SUBMITTED' || r.status === 'IN_APPROVAL');
    const rd = await Promise.all(reqs.map((r) => platform.request(r.id).catch(() => null)));
    for (const r of rd) {
      if (!r) continue;
      const chain = (r.approvalChain ?? []) as Step[];
      const w = waitingStep(chain);
      if (mine(w) && (r as { createdBy?: string }).createdBy !== user.id && !chain.some((s) => s.approverId === user.id))
        out.push({ kind: 'REQUEST', id: r.id, number: r.requestNumber, title: r.subject, level: w!.level, total: chain.length, to: `/procurement/requests/${r.id}` });
    }
    return out;
  }, [user?.id, approver]);
  if (!approver) return null;
  return (
    <Card title={t('cycle.w.title')} actions={<Button variant="ghost" onClick={state.reload}>{t('common.refresh')}</Button>}>
      <AsyncView state={state} empty={t('cycle.w.empty')}>
        {(xs) => (
          <ul className="plain cyc-waiting">
            {xs.map((x) => (
              <li key={`${x.kind}-${x.id}`}>
                <Link to={x.to} className="cyc-waiting-item">
                  <Badge tone={x.kind === 'REQUEST' ? REQUEST_TONE.IN_APPROVAL : x.kind === 'AWARD' ? 'success' : 'warn'} label={te('cycle.w.kind.', x.kind)} />
                  <span className="cyc-waiting-text">
                    <span className="small muted" dir="ltr">
                      {x.number}
                    </span>
                    <span>{x.title}</span>
                  </span>
                  <span className="small nowrap">{t('cycle.levelOf', { n: x.level, total: x.total })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

export function DefaultCycleCard() {
  const { t } = useI18n();
  const list = useAsync(() => platform.templates(), []);
  const def = list.data?.find((x) => x.isDefault) ?? null;
  return (
    <Card title={t('cycle.w.defaultCycle')} actions={def ? <TemplateBadge tpl={def} /> : undefined}>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : def ? (
        <StageStrip stages={def.stages} cfg={def.config} hideOff compact />
      ) : (
        <p className="muted">{t('cycle.w.noDefault')}</p>
      )}
    </Card>
  );
}
