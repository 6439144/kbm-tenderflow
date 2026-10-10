import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, CATEGORIES, type Criterion, type RequiredDocument, type Tender, type TenderDetail } from '../../api';
import type { CycleConfig } from '../../api-platform';
import { useI18n } from '../../i18n';
import { Button, Card, ErrorBox, Field, Spinner, useToast } from '../../components/ui';
import { TenderCycleFields, type TenderCycleValue } from '../../features/cycle';
import { CustomFieldsForm, lowcode } from '../../features/lowcode';
import { defaults as cfDefaults } from '../../features/lowcode/engine';
import type { FormDefinition } from '../../features/lowcode/api';

function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function slug(s: string, i: number, prefix: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || `${prefix}${i + 1}`;
}

interface Form {
  tenderNumber: string;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  category: string;
  estimatedBudget: string;
  deadline: string;
  criteria: Criterion[];
  requiredDocuments: RequiredDocument[];
}

const EMPTY: Form = {
  tenderNumber: '',
  titleEn: '',
  titleAr: '',
  descriptionEn: '',
  descriptionAr: '',
  category: 'IT',
  estimatedBudget: '',
  deadline: '',
  criteria: [
    { key: '', nameEn: '', nameAr: '', weight: 60 },
    { key: '', nameEn: '', nameAr: '', weight: 40 },
  ],
  requiredDocuments: [{ key: '', nameEn: '', nameAr: '' }],
};

/** Criteria preset for a two-envelope template (technical / experience / price). */
const TWO_ENVELOPE_CRITERIA: Criterion[] = [
  { key: 'technical', nameEn: 'Technical solution', nameAr: 'الحل الفني', weight: 50 },
  { key: 'experience', nameEn: 'Experience & team', nameAr: 'الخبرة وفريق العمل', weight: 20 },
  { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 },
];

function fromTender(x: Tender): Form {
  return {
    tenderNumber: x.tenderNumber ?? '',
    titleEn: x.titleEn ?? '',
    titleAr: x.titleAr ?? '',
    descriptionEn: x.descriptionEn ?? '',
    descriptionAr: x.descriptionAr ?? '',
    category: x.category ?? 'IT',
    estimatedBudget: x.estimatedBudget === null || x.estimatedBudget === undefined ? '' : String(x.estimatedBudget),
    deadline: toLocalInput(x.submissionDeadline),
    criteria: (x.criteria ?? []).map((c) => ({ ...c, weight: Number(c.weight) })),
    requiredDocuments: x.requiredDocuments ?? [],
  };
}

export default function TenderForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const { t, te } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [f, setF] = useState<Form>(EMPTY);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [loading, setLoading] = useState(editing);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [cyc, setCyc] = useState<TenderCycleValue>({ templateId: '', eligibility: { activityCodes: [], minGrade: null } });
  const [pinned, setPinned] = useState<Pick<TenderDetail, 'template' | 'cycle' | 'stages'> | null>(null);
  const [tplCfg, setTplCfg] = useState<CycleConfig | null>(null);
  const [critTouched, setCritTouched] = useState(false);
  // Low-code: the entity's custom tender fields (live form for a new tender, the pinned version when editing).
  const [cf, setCf] = useState<{ def: FormDefinition; values: Record<string, unknown> } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = id
      ? lowcode.tenderProcess(id).then((p) => (p.form ? { def: p.form.definition, values: { ...(p.raw ?? {}) } } : null))
      : lowcode.form('TENDER').then((r) => (r.form ? { def: r.form.definition, values: cfDefaults(r.form.definition.fields) } : null));
    load.then((x) => { if (alive) setCf(x); }).catch(() => undefined);
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .tender(id)
      .then((x) => {
        setF(fromTender(x));
        setStatus(x.status);
        setCyc({ templateId: x.template?.id ?? '', eligibility: { activityCodes: x.eligibility?.activityCodes ?? [], minGrade: x.eligibility?.minGrade ?? null } });
        setPinned({ template: x.template ?? null, cycle: x.cycle, stages: x.stages });
      })
      .catch(setLoadErr)
      .finally(() => setLoading(false));
  }, [id]);

  const total = f.criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const weightsOk = Math.abs(total - 100) < 0.001 && f.criteria.length > 0;
  // Two-envelope rule (enforced by the server too): ≥1 financial criterion (template keys) and ≥1 technical criterion.
  const two = tplCfg?.envelopes === 'TWO';
  const finKeys = two ? tplCfg!.evaluation.financialCriteria : [];
  const effKey = (c: Criterion, i: number) => c.key || slug(c.nameEn, i, 'c');
  const isFin = (c: Criterion, i: number) => finKeys.includes(effKey(c, i));
  const finCount = f.criteria.filter(isFin).length;
  const envelopeOk = !two || (finCount > 0 && finCount < f.criteria.length);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const setCrit = (i: number, patch: Partial<Criterion>) => {
    setCritTouched(true);
    set('criteria', f.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  };
  const toggleFin = (i: number, on: boolean) => {
    const c = f.criteria[i];
    if (on) {
      const used = new Set(f.criteria.map((x, j) => (j === i ? '' : effKey(x, j))));
      const key = finKeys.find((k) => !used.has(k));
      if (key) setCrit(i, { key });
    } else {
      const base = slug(c.nameEn, i, 'c');
      setCrit(i, { key: finKeys.includes(base) ? `${base}_tech` : base });
    }
  };
  const onTemplate = (cfg: CycleConfig | null) => {
    setTplCfg(cfg);
    if (!editing && !critTouched && cfg?.envelopes === 'TWO') setF((x) => ({ ...x, criteria: TWO_ENVELOPE_CRITERIA.map((c) => ({ ...c })) }));
  };
  const setDoc = (i: number, patch: Partial<RequiredDocument>) =>
    set('requiredDocuments', f.requiredDocuments.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!weightsOk || !envelopeOk) return;
    setBusy(true);
    setErr(null);
    const body = {
      ...(f.tenderNumber.trim() ? { tenderNumber: f.tenderNumber.trim() } : {}),
      titleEn: f.titleEn.trim(),
      titleAr: f.titleAr.trim(),
      descriptionEn: f.descriptionEn.trim(),
      descriptionAr: f.descriptionAr.trim(),
      category: f.category,
      estimatedBudget: Number(f.estimatedBudget),
      currency: 'KWD',
      submissionDeadline: new Date(f.deadline).toISOString(),
      criteria: f.criteria.map((c, i) => ({ ...c, key: c.key || slug(c.nameEn, i, 'c'), weight: Number(c.weight) })),
      requiredDocuments: f.requiredDocuments
        .filter((d) => d.nameEn.trim() || d.nameAr.trim())
        .map((d, i) => ({ ...d, key: d.key || slug(d.nameEn, i, 'd') })),
      ...(cf ? { customFields: Object.fromEntries(Object.entries(cf.values).filter(([k, v]) => cf.def.fields.some((x) => x.key === k && x.type !== 'computed') && v !== undefined)) } : {}),
    };
    const full = id
      ? { ...body, eligibility: cyc.eligibility }
      : { ...body, eligibility: cyc.eligibility, ...(cyc.templateId ? { templateId: cyc.templateId } : {}) };
    try {
      const saved = id ? await api.updateTender(id, full) : await api.createTender(full);
      toast(t(id ? 'form.updated' : 'form.created'));
      navigate(`/procurement/tenders/${saved?.id ?? id}`);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (loadErr) return <ErrorBox error={loadErr} />;
  if (editing && status && status !== 'DRAFT')
    return (
      <div className="alert alert-info">
        {t('form.onlyDraft')} <Link to={`/procurement/tenders/${id}`}>{t('common.back')}</Link>
      </div>
    );

  return (
    <form className="stack" onSubmit={submit}>
      <header className="page-head">
        <h1>{t(editing ? 'form.editTitle' : 'form.createTitle')}</h1>
      </header>
      {err ? <ErrorBox error={err} /> : null}
      <Card title={t('td.overview')}>
        <div className="grid-2">
          <Field label={t('form.tenderNumber')} hint={t('form.tenderNumberHint')}>
            {(fid, d) => <input id={fid} aria-describedby={d} value={f.tenderNumber} onChange={(e) => set('tenderNumber', e.target.value)} dir="ltr" />}
          </Field>
          <Field label={t('common.category')} required>
            {(fid) => (
              <select id={fid} value={f.category} onChange={(e) => set('category', e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {te('cat.', c)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('form.titleEn')} required>
            {(fid) => <input id={fid} value={f.titleEn} onChange={(e) => set('titleEn', e.target.value)} required dir="ltr" lang="en" />}
          </Field>
          <Field label={t('form.titleAr')} required>
            {(fid) => <input id={fid} value={f.titleAr} onChange={(e) => set('titleAr', e.target.value)} required dir="rtl" lang="ar" />}
          </Field>
          <Field label={t('form.descEn')}>
            {(fid) => <textarea id={fid} rows={4} value={f.descriptionEn} onChange={(e) => set('descriptionEn', e.target.value)} dir="ltr" lang="en" />}
          </Field>
          <Field label={t('form.descAr')}>
            {(fid) => <textarea id={fid} rows={4} value={f.descriptionAr} onChange={(e) => set('descriptionAr', e.target.value)} dir="rtl" lang="ar" />}
          </Field>
          <Field label={t('form.budget')} required>
            {(fid) => (
              <input
                id={fid}
                type="number"
                min="0"
                step="0.001"
                value={f.estimatedBudget}
                onChange={(e) => set('estimatedBudget', e.target.value)}
                required
                dir="ltr"
              />
            )}
          </Field>
          <Field label={t('form.deadline')} required>
            {(fid) => <input id={fid} type="datetime-local" value={f.deadline} onChange={(e) => set('deadline', e.target.value)} required dir="ltr" />}
          </Field>
        </div>
      </Card>

      <TenderCycleFields value={cyc} onChange={setCyc} pinned={editing ? pinned : null} onTemplate={onTemplate} />

      <Card
        title={t('form.criteria')}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              setCritTouched(true);
              set('criteria', [...f.criteria, { key: '', nameEn: '', nameAr: '', weight: 0 }]);
            }}
          >
            {t('common.add')}
          </Button>
        }
      >
        {two && (
          <div className={`alert ${envelopeOk ? 'alert-info' : 'alert-warn'}`} role="note">
            <div>
              {t('cycle.f.finRule', { keys: finKeys.join(', ') })}
              {!envelopeOk && <div className="field-error">{t('cycle.f.finMissing')}</div>}
            </div>
          </div>
        )}
        <div className="rows">
          {f.criteria.map((c, i) => (
            <div className={`row-grid row-grid-crit ${two ? 'cyc-crit-two' : ''}`} key={i}>
              <Field label={t('form.criterionEn')} required>
                {(fid) => <input id={fid} value={c.nameEn} onChange={(e) => setCrit(i, { nameEn: e.target.value })} required dir="ltr" />}
              </Field>
              <Field label={t('form.criterionAr')} required>
                {(fid) => <input id={fid} value={c.nameAr} onChange={(e) => setCrit(i, { nameAr: e.target.value })} required dir="rtl" />}
              </Field>
              <Field label={t('form.weight')} required>
                {(fid) => (
                  <input
                    id={fid}
                    type="number"
                    min="0"
                    max="100"
                    value={Number.isNaN(c.weight) ? '' : c.weight}
                    onChange={(e) => setCrit(i, { weight: e.target.value === '' ? NaN : Number(e.target.value) })}
                    required
                    dir="ltr"
                  />
                )}
              </Field>
              {two && (
                <label className="check cyc-fin-check">
                  <input type="checkbox" checked={isFin(c, i)} onChange={(e) => toggleFin(i, e.target.checked)} />
                  <span>{t('cycle.f.finCheckbox')}</span>
                </label>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setCritTouched(true);
                  set('criteria', f.criteria.filter((_, j) => j !== i));
                }}
                disabled={f.criteria.length <= 1}
              >
                {t('common.remove')}
              </Button>
            </div>
          ))}
        </div>
        <p className={weightsOk ? 'ok-text' : 'field-error'} role="status">
          {t('form.weightTotal', { total: Number.isNaN(total) ? 0 : total })} {!weightsOk && `— ${t('form.weightMustBe100')}`}
        </p>
      </Card>

      {cf && cf.def.fields.length > 0 && (
        <Card title={t('lc.proc.editFields')}>
          <CustomFieldsForm definition={cf.def} values={cf.values} onChange={(v) => setCf({ ...cf, values: v })}
            budget={f.estimatedBudget === '' ? null : Number(f.estimatedBudget)} showAudience />
        </Card>
      )}

      <Card
        title={t('form.requiredDocs')}
        actions={
          <Button variant="secondary" onClick={() => set('requiredDocuments', [...f.requiredDocuments, { key: '', nameEn: '', nameAr: '' }])}>
            {t('common.add')}
          </Button>
        }
      >
        <div className="rows">
          {f.requiredDocuments.map((d, i) => (
            <div className="row-grid row-grid-doc" key={i}>
              <Field label={t('form.docEn')}>
                {(fid) => <input id={fid} value={d.nameEn} onChange={(e) => setDoc(i, { nameEn: e.target.value })} dir="ltr" />}
              </Field>
              <Field label={t('form.docAr')}>
                {(fid) => <input id={fid} value={d.nameAr} onChange={(e) => setDoc(i, { nameAr: e.target.value })} dir="rtl" />}
              </Field>
              <Button variant="ghost" onClick={() => set('requiredDocuments', f.requiredDocuments.filter((_, j) => j !== i))}>
                {t('common.remove')}
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <div className="row-end">
        <Link className="btn btn-ghost" to={id ? `/procurement/tenders/${id}` : '/procurement/tenders'}>
          {t('common.cancel')}
        </Link>
        <Button type="submit" busy={busy} disabled={!weightsOk || !envelopeOk}>
          {t('form.save')}
        </Button>
      </div>
    </form>
  );
}
