// Departmental procurement requests (/procurement/requests): register (scanned GM letter or Raslni reference),
// approval chain, convert to a tender draft that pins a cycle template.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CATEGORIES } from '../../api';
import { platform, type ProcurementRequest } from '../../api-platform';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DocButton } from '../../components/Layout';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, FileInput, ReasonDialog, Spinner, Table, useAsync, useToast } from '../../components/ui';
import { RequestAiExtras } from '../assistant';
import { ChainView, REQUEST_TONE, StageStrip, TemplateBadge, waitingStep, type Step } from './common';

export function RequestsPage() {
  const { t, te, fmtDate, fmtMoney } = useI18n();
  const { hasRole } = useSession();
  const list = useAsync(() => platform.requests(), []);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState('');
  const isOfficer = hasRole('PROCUREMENT_OFFICER');
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('cycle.r.title')}</h1>
          <p className="muted cyc-lead">{t('cycle.r.subtitle')}</p>
        </div>
        {isOfficer && !showForm && <Button onClick={() => setShowForm(true)}>{t('cycle.r.register')}</Button>}
      </header>
      {showForm && <RegisterForm onCancel={() => setShowForm(false)} />}
      <div className="segmented" role="group" aria-label={t('common.filter')}>
        {['', 'SUBMITTED', 'IN_APPROVAL', 'APPROVED', 'CONVERTED', 'REJECTED'].map((f) => (
          <button key={f || 'all'} type="button" className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f ? te('cycle.rst.', f) : t('common.all')}
          </button>
        ))}
      </div>
      <Card>
        <AsyncView state={list} empty={t('cycle.r.empty')} isEmpty={(xs) => xs.filter((x) => !filter || x.status === filter).length === 0}>
          {(xs) => (
            <Table head={[t('cycle.r.number'), t('cycle.r.subject'), t('cycle.r.department'), t('cycle.r.source'), t('common.budget'), t('common.createdAt'), t('common.status')]}>
              {xs
                .filter((x) => !filter || x.status === filter)
                .map((x) => (
                  <tr key={x.id}>
                    <td dir="ltr" className="nowrap">
                      <Link to={`/procurement/requests/${x.id}`}>{x.requestNumber}</Link>
                    </td>
                    <td>
                      <Link to={`/procurement/requests/${x.id}`}>{x.subject}</Link>
                    </td>
                    <td>{x.department}</td>
                    <td>
                      {te('cycle.src.', x.source)}
                      {x.sourceReference && (
                        <div className="muted small" dir="ltr">
                          {x.sourceReference}
                        </div>
                      )}
                    </td>
                    <td>{fmtMoney(x.estimatedBudget)}</td>
                    <td className="nowrap">{fmtDate(x.createdAt)}</td>
                    <td>
                      <Badge tone={REQUEST_TONE[x.status]} label={te('cycle.rst.', x.status)} />
                    </td>
                  </tr>
                ))}
            </Table>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}

function RegisterForm({ onCancel }: { onCancel: () => void }) {
  const { t, te, pick } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const templates = useAsync(() => platform.templates(), []);
  const [source, setSource] = useState<'LETTER' | 'RASLNI'>('LETTER');
  const [letter, setLetter] = useState<File | null>(null);
  const [letterTitle, setLetterTitle] = useState('');
  const [reference, setReference] = useState('');
  const [department, setDepartment] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  const [suggested, setSuggested] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const sourceOk = source === 'LETTER' ? Boolean(letter) : Boolean(reference.trim());
  const ok = sourceOk && department.trim() && subject.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr(null);
    const f = new FormData();
    f.append('source', source);
    if (source === 'RASLNI') f.append('sourceReference', reference.trim());
    if (source === 'LETTER' && letter) {
      f.append('letter', letter);
      if (letterTitle.trim()) f.append('letterTitle', letterTitle.trim());
    }
    f.append('department', department.trim());
    f.append('subject', subject.trim());
    f.append('description', description.trim());
    if (budget.trim()) f.append('estimatedBudget', budget.trim());
    if (suggested) f.append('suggestedTemplate', suggested);
    try {
      const r = await platform.createRequest(f);
      toast(t('cycle.r.registered', { n: r.requestNumber }));
      navigate(`/procurement/requests/${r.id}`);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cycle.r.register')}>
      <form onSubmit={submit}>
        {err ? <ErrorBox error={err} /> : null}
        <div className="segmented" role="radiogroup" aria-label={t('cycle.r.source')}>
          {(['LETTER', 'RASLNI'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={source === s} className={source === s ? 'on' : ''} onClick={() => setSource(s)}>
              {te('cycle.src.', s)}
            </button>
          ))}
        </div>
        <p className="muted small">{t(source === 'LETTER' ? 'cycle.r.letterHint' : 'cycle.r.raslniHint')}</p>
        {source === 'LETTER' ? (
          <div className="grid-2">
            <FileInput label={t('cycle.r.letterFile')} file={letter} onChange={setLetter} required />
            <Field label={t('cycle.r.letterTitle')}>{(id) => <input id={id} value={letterTitle} onChange={(e) => setLetterTitle(e.target.value)} />}</Field>
          </div>
        ) : (
          <Field label={t('cycle.r.raslniRef')} required>
            {(id) => <input id={id} value={reference} onChange={(e) => setReference(e.target.value)} required dir="ltr" placeholder="RSL-2026-000123" />}
          </Field>
        )}
        <div className="grid-2">
          <Field label={t('cycle.r.department')} required>
            {(id) => <input id={id} value={department} onChange={(e) => setDepartment(e.target.value)} required />}
          </Field>
          <Field label={t('cycle.r.subject')} required>
            {(id) => <input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} required />}
          </Field>
          <Field label={t('common.budget')}>
            {(id) => <input id={id} type="number" min="0" step="0.001" dir="ltr" value={budget} onChange={(e) => setBudget(e.target.value)} />}
          </Field>
          <Field label={t('cycle.r.suggested')} hint={t('cycle.r.suggestedHint')}>
            {(id, d) => (
              <select id={id} aria-describedby={d} value={suggested} onChange={(e) => setSuggested(e.target.value)}>
                <option value="">{t('common.none')}</option>
                {(templates.data ?? []).map((x) => (
                  <option key={x.id} value={x.code}>
                    {pick(x.nameEn, x.nameAr)} ({x.code})
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('cycle.r.description')}>{(id) => <textarea id={id} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="row-end">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!ok} disabledReason={!sourceOk ? t(source === 'LETTER' ? 'cycle.r.needLetter' : 'cycle.r.needRef') : undefined}>
            {t('cycle.r.submit')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function RequestDetailPage() {
  const { id = '' } = useParams();
  const req = useAsync(() => platform.request(id), [id]);
  if (req.loading && !req.data) return <Spinner />;
  if (req.error) return <ErrorBox error={req.error} onRetry={req.reload} />;
  if (!req.data) return <Spinner />;
  return <RequestDetail r={req.data} reload={req.reload} />;
}

function RequestDetail({ r, reload }: { r: ProcurementRequest & { createdBy?: string }; reload: () => void }) {
  const { t, te, fmtDate, fmtMoney } = useI18n();
  const { user, hasRole } = useSession();
  const toast = useToast();
  const [dialog, setDialog] = useState<null | 'APPROVE' | 'RETURN' | 'REJECT'>(null);
  const chain = (r.approvalChain ?? []) as Step[];
  const waiting = waitingStep(chain);
  const inApproval = r.status === 'SUBMITTED' || r.status === 'IN_APPROVAL';
  const canDecide = inApproval && !!waiting && hasRole(waiting.role as never);
  const iAmCreator = Boolean(user && r.createdBy === user.id);
  const iApproved = Boolean(user && chain.some((s) => s.approverId === user.id));
  const blocked = iAmCreator ? t('cycle.r.creatorCannot') : iApproved ? t('cycle.r.twoLevels') : undefined;

  return (
    <div className="stack">
      <Link to="/procurement/requests" className="backlink">
        ← {t('cycle.r.title')}
      </Link>
      <header className="page-head">
        <div>
          <div className="muted small" dir="ltr">
            {r.requestNumber}
          </div>
          <h1>{r.subject}</h1>
          <div className="muted">{r.department}</div>
        </div>
        <Badge tone={REQUEST_TONE[r.status]} label={te('cycle.rst.', r.status)} />
      </header>

      {r.status === 'CONVERTED' && r.tenderId && (
        <div className="alert alert-success" role="status">
          <div>
            {t('cycle.r.converted')} <Link to={`/procurement/tenders/${r.tenderId}`}>{t('cycle.r.openTender')}</Link>
          </div>
        </div>
      )}
      {r.status === 'REJECTED' && (
        <div className="alert alert-danger" role="status">
          {t('cycle.r.rejectedNote')}
        </div>
      )}

      <Card title={t('cycle.r.approvalChain')} actions={waiting && inApproval ? <span className="muted small">{t('cycle.levelOf', { n: waiting.level, total: chain.length })}</span> : undefined}>
        <ChainView steps={chain} />
        {canDecide && (
          <div className="row wrap cyc-mt">
            <Button onClick={() => setDialog('APPROVE')} disabled={!!blocked} disabledReason={blocked}>
              {t('cycle.r.approve', { n: waiting!.level, total: chain.length })}
            </Button>
            <Button variant="secondary" onClick={() => setDialog('RETURN')} disabled={iAmCreator} disabledReason={iAmCreator ? blocked : undefined}>
              {t('cycle.r.return')}
            </Button>
            <Button variant="danger" onClick={() => setDialog('REJECT')} disabled={iAmCreator} disabledReason={iAmCreator ? blocked : undefined}>
              {t('cycle.r.reject')}
            </Button>
          </div>
        )}
        {inApproval && waiting && !canDecide && <p className="muted small cyc-mt">{t('cycle.waitingFor', { role: te('role.', waiting.role) })}</p>}
      </Card>

      <div className="grid-main">
        <div className="stack">
          <Card title={t('cycle.r.details')}>
            <dl className="kv">
              <dt>{t('cycle.r.source')}</dt>
              <dd>
                {te('cycle.src.', r.source)}
                {r.sourceReference && (
                  <span dir="ltr">
                    {' '}
                    · <code>{r.sourceReference}</code>
                  </span>
                )}
              </dd>
              <dt>{t('cycle.r.department')}</dt>
              <dd>{r.department}</dd>
              <dt>{t('common.budget')}</dt>
              <dd>{fmtMoney(r.estimatedBudget)}</dd>
              <dt>{t('cycle.r.suggested')}</dt>
              <dd dir="ltr">{r.suggestedTemplate ?? '—'}</dd>
              <dt>{t('common.createdAt')}</dt>
              <dd>{fmtDate(r.createdAt)}</dd>
            </dl>
            {r.description && <p className="prewrap">{r.description}</p>}
            {r.letterDocumentId && (
              <div className="cyc-letter">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M6 2h9l5 5v15H6z" />
                  <path d="M14 2v6h6M9 13h8M9 17h6" />
                </svg>
                <div>
                  <strong>{t('cycle.r.letter')}</strong>
                  <div className="muted small">{r.letter?.title ?? r.letterDocumentId}</div>
                </div>
                <DocButton path={`/documents/${r.letterDocumentId}`} name={r.letter?.title ?? 'letter'} variant="secondary" />
              </div>
            )}
          </Card>
          <RequestAiExtras requestId={r.id} onChange={reload} />
        </div>
        <aside className="stack side">
          {r.status === 'APPROVED' && hasRole('PROCUREMENT_OFFICER') && <ConvertForm r={r} />}
          {r.status === 'APPROVED' && !hasRole('PROCUREMENT_OFFICER') && (
            <Card>
              <p className="muted">{t('cycle.r.awaitConvert')}</p>
            </Card>
          )}
        </aside>
      </div>

      <ReasonDialog
        open={dialog !== null}
        title={dialog ? t(`cycle.r.${dialog === 'APPROVE' ? 'approveTitle' : dialog === 'RETURN' ? 'returnTitle' : 'rejectTitle'}`) : ''}
        confirmLabel={dialog === 'APPROVE' ? t('cycle.r.approveShort') : dialog === 'RETURN' ? t('cycle.r.return') : t('cycle.r.reject')}
        required={dialog !== 'APPROVE'}
        variant={dialog === 'REJECT' ? 'danger' : dialog === 'RETURN' ? 'secondary' : 'primary'}
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (!dialog) return;
          await platform.decideRequest(r.id, dialog, reason || undefined);
          toast(t(dialog === 'APPROVE' ? 'cycle.r.approved' : dialog === 'RETURN' ? 'cycle.r.returned' : 'cycle.r.rejected'));
          reload();
        }}
      />
    </div>
  );
}

const DEFAULT_CRITERIA = [
  { key: 'technical', nameEn: 'Technical solution', nameAr: 'الحل الفني', weight: 50 },
  { key: 'experience', nameEn: 'Experience & team', nameAr: 'الخبرة وفريق العمل', weight: 20 },
  { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 },
];

function ConvertForm({ r }: { r: ProcurementRequest }) {
  const { t, te, pick } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const templates = useAsync(() => platform.templates(), []);
  const [templateId, setTemplateId] = useState('');
  const [category, setCategory] = useState('');
  const [deadline, setDeadline] = useState('');
  const [titleEn, setTitleEn] = useState(r.subject);
  const [titleAr, setTitleAr] = useState(r.subject);
  const [weights, setWeights] = useState(DEFAULT_CRITERIA.map((c) => c.weight));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (templateId || !templates.data?.length) return;
    const bySuggestion = templates.data.find((x) => x.code === r.suggestedTemplate);
    setTemplateId((bySuggestion ?? templates.data.find((x) => x.isDefault) ?? templates.data[0]).id);
  }, [templates.data, templateId, r.suggestedTemplate]);
  const tpl = useMemo(() => templates.data?.find((x) => x.id === templateId), [templates.data, templateId]);
  const total = weights.reduce((a, w) => a + (Number(w) || 0), 0);
  const ok = templateId && category && deadline && titleEn.trim() && titleAr.trim() && Math.abs(total - 100) < 0.001;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const x = await platform.convertRequest(r.id, {
        templateId,
        category,
        submissionDeadline: new Date(deadline).toISOString(),
        titleEn: titleEn.trim(),
        titleAr: titleAr.trim(),
        currency: 'KWD',
        criteria: DEFAULT_CRITERIA.map((c, i) => ({ ...c, weight: Number(weights[i]) })).filter((c) => c.weight > 0),
      });
      toast(t('cycle.r.convertedToast', { n: x.tenderNumber }));
      navigate(`/procurement/tenders/${x.id}`);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('cycle.r.convert')}>
      <form onSubmit={submit}>
        <p className="muted small">{t('cycle.r.convertHint')}</p>
        {err ? <ErrorBox error={err} /> : null}
        <Field label={t('cycle.template')} required>
          {(id) => (
            <select id={id} value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              {(templates.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {pick(x.nameEn, x.nameAr)} · v{x.version}
                  {x.isDefault ? ` (${t('cycle.default')})` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
        {tpl && (
          <div className="cyc-mb">
            <TemplateBadge tpl={tpl} />
            <StageStrip stages={tpl.stages} cfg={tpl.config} hideOff compact />
          </div>
        )}
        <Field label={t('form.titleEn')} required>
          {(id) => <input id={id} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} required dir="ltr" />}
        </Field>
        <Field label={t('form.titleAr')} required>
          {(id) => <input id={id} value={titleAr} onChange={(e) => setTitleAr(e.target.value)} required dir="rtl" />}
        </Field>
        <Field label={t('common.category')} required>
          {(id) => (
            <select id={id} value={category} onChange={(e) => setCategory(e.target.value)} required>
              <option value="">{t('cycle.r.chooseCategory')}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {te('cat.', c)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('form.deadline')} required>
          {(id) => <input id={id} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} required dir="ltr" />}
        </Field>
        <fieldset className="cyc-fieldset">
          <legend>{t('form.criteria')}</legend>
          {DEFAULT_CRITERIA.map((c, i) => (
            <div key={c.key} className="row spread cyc-crit-row">
              <span>
                {pick(c.nameEn, c.nameAr)}
                {tpl?.config.envelopes === 'TWO' && tpl.config.evaluation.financialCriteria.includes(c.key) && (
                  <Badge tone="warn" label={t('cycle.financialEnvelope')} />
                )}
              </span>
              <input
                type="number"
                min={0}
                max={100}
                dir="ltr"
                className="score-input"
                aria-label={`${t('form.weight')} — ${pick(c.nameEn, c.nameAr)}`}
                value={weights[i]}
                onChange={(e) => setWeights((w) => w.map((x, j) => (j === i ? Number(e.target.value) : x)))}
              />
            </div>
          ))}
          <p className={Math.abs(total - 100) < 0.001 ? 'ok-text small' : 'field-error'}>{t('form.weightTotal', { total })}</p>
        </fieldset>
        <Button type="submit" busy={busy} disabled={!ok} className="btn-block">
          {t('cycle.r.convertBtn')}
        </Button>
      </form>
    </Card>
  );
}
