// "New template" guided wizard of the Cycle Designer. Six short steps in plain language; the result is created as a
// DRAFT with the same API the editor uses (POST /templates) after the server has validated it (POST /templates/validate).
// Nothing is published here: the admin reviews the draft in the editor and publishes it from there.
import { useEffect, useMemo, useState } from 'react';
import { platform, type CycleConfig, type CycleTemplate, type StageInfo } from '../../api-platform';
import { translate, useI18n, type TKey } from '../../i18n';
import { Badge, Button, ErrorBox, Field, Modal, Spinner } from '../../components/ui';
import { StepNav } from '../../components/ux';
import { GRADES, STAGE_TOGGLES, StageStrip, roleLabels } from './common';
import { ChainEditor } from './chain';
import { usePlainSummary, useIssueReader } from './summary';
import { bidsInScope } from '../moi';

const D = (role: string) => ({ role, ...roleLabels(role) });
const AI_ON: CycleConfig['ai'] = { packCheck: true, clarification: true, compliance: true, gazette: true, relevance: true, narrative: true, requestClassify: true, documentIntelligence: true };
const BASE: CycleConfig = {
  scope: 'FULL_CYCLE',
  stages: { requestIntake: false, documentPurchase: false, gazette: false, capt: false, complianceScreening: true, recordsLock: false },
  approvals: { request: [D('DIRECTOR')], publish: [D('DIRECTOR')], award: [D('DIRECTOR')] },
  envelopes: 'ONE',
  evaluation: { technicalPassMark: null, financialCriteria: [] },
  eligibility: { activityCodes: [], minGrade: null },
  fees: { documentPrice: 0, currency: 'KWD', exemptionAllowed: false },
  ai: AI_ON,
};

/** Starting points offered by the wizard. Same settings as the server's starter templates (services/api templates.ts). */
const STARTERS: { key: string; code: string; icon: string; config: CycleConfig }[] = [
  { key: 'public', code: 'PUBLIC_TENDER', icon: '📢', config: { ...BASE, stages: { ...BASE.stages, requestIntake: true, gazette: true, recordsLock: true } } },
  { key: 'limited', code: 'LIMITED_TENDER', icon: '✉️', config: BASE },
  {
    key: 'rfp',
    code: 'RFP_TWO_ENVELOPE',
    icon: '📑',
    config: {
      scope: 'FULL_CYCLE',
      stages: { requestIntake: true, documentPurchase: true, gazette: true, capt: true, complianceScreening: true, recordsLock: true },
      approvals: { request: [D('DIRECTOR')], publish: [D('DIRECTOR'), D('UNDERSECRETARY')], award: [D('DIRECTOR'), D('UNDERSECRETARY')] },
      envelopes: 'TWO',
      evaluation: { technicalPassMark: 70, financialCriteria: ['price'] },
      eligibility: { activityCodes: [], minGrade: 2 },
      fees: { documentPrice: 50, currency: 'KWD', exemptionAllowed: true },
      ai: AI_ON,
    },
  },
  { key: 'sale', code: 'PUBLICATION_SALE', icon: '🏷️', config: { ...BASE, scope: 'PUBLICATION_AND_SALE', stages: { ...BASE.stages, documentPurchase: true, gazette: true }, fees: { documentPrice: 20, currency: 'KWD', exemptionAllowed: true } } },
];

// A template is always bilingual: both names are filled whatever the UI language.
const en = (k: string) => translate('en', k as TKey);
const ar = (k: string) => translate('ar', k as TKey);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
export const codeFromName = (s: string) =>
  s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

interface WizardProps {
  open: boolean;
  onClose: () => void;
  existing: CycleTemplate[];
  activityCodes: { code: string; nameEn: string; nameAr: string }[];
  onCreated: (id: string) => void;
}

export function NewTemplateWizard({ open, onClose, existing, activityCodes, onCreated }: WizardProps) {
  const { t, te, pick } = useI18n();
  const plain = usePlainSummary();
  const readIssue = useIssueReader();
  const [step, setStep] = useState(0);
  const [from, setFrom] = useState<string | null>(null);
  const [cfg, setCfg] = useState<CycleConfig>(clone(BASE));
  const [names, setNames] = useState({ nameEn: '', nameAr: '', description: '', code: '' });
  const [codeTouched, setCodeTouched] = useState(false);
  const [check, setCheck] = useState<{ valid: boolean; error?: string; stages?: StageInfo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setFrom(null);
    setCfg(clone(BASE));
    setNames({ nameEn: '', nameAr: '', description: '', code: '' });
    setCodeTouched(false);
    setErr(null);
  }, [open]);

  // live server validation (the same parser that enforces templates)
  const key = JSON.stringify(cfg);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const h = setTimeout(() => {
      platform.validateTemplate(cfg).then((r) => alive && setCheck(r)).catch((e: unknown) => alive && setCheck({ valid: false, error: e instanceof Error ? e.message : String(e) }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const latest = useMemo(() => {
    const m = new Map<string, CycleTemplate>();
    for (const x of existing) if (!m.has(x.code) || (m.get(x.code)!.version < x.version)) m.set(x.code, x);
    return [...m.values()];
  }, [existing]);
  const takenCodes = useMemo(() => new Set(existing.map((x) => x.code)), [existing]);
  const uniqueCode = (base: string) => {
    let c = base || 'TEMPLATE';
    let n = 2;
    while (takenCodes.has(c)) c = `${base.slice(0, 56)}_${n++}`;
    return c;
  };
  const setName = (patch: Partial<typeof names>) => {
    const next = { ...names, ...patch };
    if (patch.nameEn !== undefined && !codeTouched) next.code = uniqueCode(codeFromName(patch.nameEn));
    setNames(next);
  };

  const choose = (id: string, c: CycleConfig, nameEn: string, nameAr: string, description: string) => {
    setFrom(id);
    setCfg(clone(c));
    setCodeTouched(false);
    setNames({ nameEn, nameAr, description, code: uniqueCode(codeFromName(nameEn)) });
  };
  const set = (patch: (c: CycleConfig) => void) => {
    const next = clone(cfg);
    patch(next);
    setCfg(next);
  };

  // ---- client-side checks per step (hints only; the server decides)
  const codeOk = /^[A-Z0-9_]{2,60}$/.test(names.code);
  const codeTaken = takenCodes.has(names.code);
  const stepIssues: string[][] = [
    from ? [] : [t('ux.wiz.pickStart')],
    cfg.envelopes === 'TWO'
      ? [
          ...(cfg.evaluation.technicalPassMark === null || cfg.evaluation.technicalPassMark < 0 || cfg.evaluation.technicalPassMark > 100 ? [t('ux.err.passMarkMissing')] : []),
          ...(!cfg.evaluation.financialCriteria.length ? [t('ux.err.finCrit')] : []),
        ]
      : [],
    (['request', 'publish', 'award'] as const).filter((k) => !cfg.approvals[k].length).map((k) => t('ux.err.chainEmpty', { chain: t(`cycle.gate.${k}` as TKey) })),
    [],
    cfg.stages.documentPurchase && !(cfg.fees.documentPrice > 0) ? [t('ux.err.feeNeeded')] : [],
    [
      ...(!names.nameEn.trim() || !names.nameAr.trim() ? [t('ux.wiz.namesNeeded')] : []),
      ...(!codeOk ? [t('cycle.d.codeHint')] : codeTaken ? [t('ux.wiz.codeTaken', { code: names.code })] : []),
    ],
  ];
  const serverIssue = check && !check.valid && check.error ? readIssue(check.error) : null;
  const canCreate = stepIssues.every((x) => !x.length) && check?.valid === true;
  const steps = [t('ux.wiz.s1'), t('ux.wiz.s2'), t('ux.wiz.s3'), t('ux.wiz.s4'), t('ux.wiz.s5'), t('ux.wiz.s6')];
  const status = stepIssues.map((x, i) => (i < step && x.length ? ('error' as const) : undefined));

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const x = await platform.createTemplate({ code: names.code, nameEn: names.nameEn.trim(), nameAr: names.nameAr.trim(), description: names.description.trim(), config: cfg });
      onCreated(x.id);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const full = bidsInScope(cfg);
  return (
    <Modal
      open={open}
      wide
      title={t('ux.wiz.title')}
      onClose={onClose}
      footer={
        <div className="ux-wiz-foot">
          <span className="muted small" aria-live="polite">
            {stepIssues[step].length ? `⚠ ${stepIssues[step][0]}` : t('ux.wiz.stepOf', { n: step + 1, total: steps.length })}
          </span>
          <span className="row">
            <Button variant="secondary" onClick={step === 0 ? onClose : () => setStep(step - 1)}>
              {step === 0 ? t('common.cancel') : t('ux.back')}
            </Button>
            {step < steps.length - 1 ? (
              <Button onClick={() => setStep(step + 1)} disabled={step === 0 && !from} disabledReason={step === 0 && !from ? t('ux.wiz.pickStart') : undefined}>
                {t('ux.next')}
              </Button>
            ) : (
              <Button busy={busy} onClick={create} disabled={!canCreate} disabledReason={!canCreate ? t('ux.wiz.fixFirst') : undefined}>
                {t('ux.wiz.create')}
              </Button>
            )}
          </span>
        </div>
      }
    >
      <div className="ux-wiz">
        <StepNav steps={steps} current={step} onGo={(i) => (i === 0 || from ? setStep(i) : undefined)} label={t('ux.wiz.title')} status={status} />
        <div className="ux-wiz-body">
          {step === 0 && (
            <div className="stack">
              <p className="muted">{t('ux.wiz.s1.intro')}</p>
              <h3>{t('ux.wiz.starters')}</h3>
              <div className="ux-cards" role="radiogroup" aria-label={t('ux.wiz.starters')}>
                {STARTERS.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    role="radio"
                    aria-checked={from === `starter:${s.key}`}
                    className={`ux-card ${from === `starter:${s.key}` ? 'on' : ''}`}
                    onClick={() => choose(`starter:${s.key}`, s.config, en(`ux.starter.${s.key}.name`), ar(`ux.starter.${s.key}.name`), t(`ux.starter.${s.key}.desc` as TKey))}
                  >
                    <span className="ux-card-icon" aria-hidden="true">
                      {s.icon}
                    </span>
                    <strong>{t(`ux.starter.${s.key}.name` as TKey)}</strong>
                    <span className="small muted">{t(`ux.starter.${s.key}.desc` as TKey)}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={from === 'blank'}
                  className={`ux-card ${from === 'blank' ? 'on' : ''}`}
                  onClick={() => choose('blank', BASE, '', '', '')}
                >
                  <span className="ux-card-icon" aria-hidden="true">
                    ＋
                  </span>
                  <strong>{t('ux.wiz.blank')}</strong>
                  <span className="small muted">{t('ux.wiz.blankDesc')}</span>
                </button>
              </div>
              {latest.length > 0 && (
                <>
                  <h3>{t('ux.wiz.copy')}</h3>
                  <div className="ux-cards ux-cards-sm" role="radiogroup" aria-label={t('ux.wiz.copy')}>
                    {latest.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        role="radio"
                        aria-checked={from === x.id}
                        className={`ux-card ${from === x.id ? 'on' : ''}`}
                        onClick={() => choose(x.id, x.config, `${en('ux.wiz.copyOf')} ${x.nameEn}`.slice(0, 200), `${ar('ux.wiz.copyOf')} ${x.nameAr}`.slice(0, 200), x.description ?? '')}
                      >
                        <strong>{pick(x.nameEn, x.nameAr)}</strong>
                        <span className="small muted" dir="ltr">
                          {x.code} · v{x.version}
                        </span>
                        <Badge tone={x.status === 'PUBLISHED' ? 'success' : x.status === 'DRAFT' ? 'warn' : 'neutral'} label={te('cycle.tplStatus.', x.status)} />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <p className="muted">{t('ux.wiz.s2.intro')}</p>
              {!full && <div className="alert alert-info">{t('ux.wiz.outOfScope')}</div>}
              <div className="ux-cards" role="radiogroup" aria-label={t('cycle.d.envelopes')}>
                {(['ONE', 'TWO'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={cfg.envelopes === v}
                    className={`ux-card ${cfg.envelopes === v ? 'on' : ''}`}
                    onClick={() =>
                      set((x) => {
                        x.envelopes = v;
                        if (v === 'TWO') {
                          if (x.evaluation.technicalPassMark === null) x.evaluation.technicalPassMark = 70;
                          if (!x.evaluation.financialCriteria.length) x.evaluation.financialCriteria = ['price'];
                        }
                      })
                    }
                  >
                    <span className="ux-card-icon" aria-hidden="true">
                      {v === 'ONE' ? '✉️' : '✉️✉️'}
                    </span>
                    <strong>{te('cycle.env.', v)}</strong>
                    <span className="small muted">{t(v === 'ONE' ? 'ux.env.oneLong' : 'ux.env.twoLong')}</span>
                    <span className="small">{t(v === 'ONE' ? 'ux.env.oneWhen' : 'ux.env.twoWhen')}</span>
                  </button>
                ))}
              </div>
              {cfg.envelopes === 'TWO' && <PassMarkInput cfg={cfg} set={set} />}
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <p className="muted">{t('ux.wiz.s3.intro')}</p>
              <div className="cyc-chains">
                <ChainEditor title={t('cycle.gate.publish')} hint={t('ux.chain.hint.publish')} value={cfg.approvals.publish} onChange={(v) => set((x) => void (x.approvals.publish = v))} />
                {full && <ChainEditor title={t('cycle.gate.award')} hint={t('ux.chain.hint.award')} value={cfg.approvals.award} onChange={(v) => set((x) => void (x.approvals.award = v))} />}
                {cfg.stages.requestIntake && (
                  <ChainEditor title={t('cycle.gate.request')} hint={t('ux.chain.hint.request')} value={cfg.approvals.request} onChange={(v) => set((x) => void (x.approvals.request = v))} />
                )}
              </div>
              {!cfg.stages.requestIntake && <p className="muted small">{t('ux.wiz.requestLater')}</p>}
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <p className="muted">{t('ux.wiz.s4.intro')}</p>
              <fieldset className="ux-fieldset">
                <legend>{t('moi.scope.title')}</legend>
                <div className="ux-cards ux-cards-sm" role="radiogroup" aria-label={t('moi.scope.title')}>
                  {(['FULL_CYCLE', 'PUBLICATION_AND_SALE'] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={(cfg.scope ?? 'FULL_CYCLE') === s} className={`ux-card ${(cfg.scope ?? 'FULL_CYCLE') === s ? 'on' : ''}`} onClick={() => set((x) => void (x.scope = s))}>
                      <strong>{t(s === 'FULL_CYCLE' ? 'moi.scope.FULL_CYCLE' : 'moi.scope.PUBLICATION_AND_SALE')}</strong>
                      <span className="small muted">{t(s === 'FULL_CYCLE' ? 'moi.scope.hint.FULL_CYCLE' : 'moi.scope.hint.PUBLICATION_AND_SALE')}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <StageToggleCards cfg={cfg} set={set} />
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              <p className="muted">{t('ux.wiz.s5.intro')}</p>
              <EligibilityEditor cfg={cfg} set={set} activityCodes={activityCodes} />
              <FeeEditor cfg={cfg} set={set} />
            </div>
          )}

          {step === 5 && (
            <div className="stack">
              <div className="grid-2">
                <Field label={t('cycle.d.nameEn')} required>
                  {(id) => <input id={id} value={names.nameEn} maxLength={200} onChange={(e) => setName({ nameEn: e.target.value })} dir="ltr" lang="en" />}
                </Field>
                <Field label={t('cycle.d.nameAr')} required>
                  {(id) => <input id={id} value={names.nameAr} maxLength={200} onChange={(e) => setName({ nameAr: e.target.value })} dir="rtl" lang="ar" />}
                </Field>
                <Field label={t('cycle.d.code')} required hint={t('ux.wiz.codeHint')} error={names.code && (!codeOk || codeTaken) ? (codeTaken ? t('ux.wiz.codeTaken', { code: names.code }) : t('cycle.d.codeHint')) : undefined}>
                  {(id, d) => (
                    <input
                      id={id}
                      aria-describedby={d}
                      dir="ltr"
                      value={names.code}
                      onChange={(e) => {
                        setCodeTouched(true);
                        setNames({ ...names, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') });
                      }}
                    />
                  )}
                </Field>
                <Field label={t('cycle.d.description')}>
                  {(id) => <input id={id} value={names.description} maxLength={2000} onChange={(e) => setNames({ ...names, description: e.target.value })} />}
                </Field>
              </div>
              <section className="ux-summary" aria-labelledby="ux-wiz-sum">
                <h3 id="ux-wiz-sum">{t('ux.sum.title')}</h3>
                <ul className="ux-summary-list">
                  {plain(cfg, activityCodes).map((x) => (
                    <li key={x.key}>
                      <span aria-hidden="true" className="ux-sum-icon">
                        {x.icon}
                      </span>
                      <span>{x.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
              {check?.stages && <StageStrip stages={check.stages} cfg={check.valid ? cfg : null} />}
              {!check ? (
                <Spinner />
              ) : check.valid ? (
                <div className="alert alert-success" role="status">
                  {t('ux.wiz.serverOk')}
                </div>
              ) : (
                <div className="alert alert-danger" role="alert">
                  <div>
                    <strong>{serverIssue?.text}</strong>
                    <div className="muted small" dir="ltr" lang="en">
                      {t('ux.err.serverSays')} {check.error}
                    </div>
                  </div>
                </div>
              )}
              {stepIssues.flat().length > 0 && (
                <ul className="ux-issues">
                  {stepIssues.map((xs, i) =>
                    xs.map((x) => (
                      <li key={`${i}${x}`}>
                        <button type="button" className="ux-link" onClick={() => setStep(i)}>
                          {steps[i]}
                        </button>
                        : {x}
                      </li>
                    )),
                  )}
                </ul>
              )}
              <p className="muted small">{t('ux.wiz.afterCreate')}</p>
              {err ? <ErrorBox error={err} /> : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- shared setting editors (wizard + editor)
export function PassMarkInput({ cfg, set }: { cfg: CycleConfig; set: (p: (c: CycleConfig) => void) => void }) {
  const { t } = useI18n();
  const pass = cfg.evaluation.technicalPassMark ?? 70;
  return (
    <div className="ux-passmark">
      <Field label={t('cycle.d.passMark')} required hint={t('ux.pass.explain', { pass })}>
        {(id, d) => (
          <div className="ux-range-row">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              aria-describedby={d}
              aria-label={t('cycle.d.passMark')}
              value={pass}
              onChange={(e) => set((x) => void (x.evaluation.technicalPassMark = Number(e.target.value)))}
            />
            <input
              id={id}
              aria-describedby={d}
              type="number"
              min={0}
              max={100}
              dir="ltr"
              className="ux-num"
              value={cfg.evaluation.technicalPassMark ?? ''}
              onChange={(e) => set((x) => void (x.evaluation.technicalPassMark = e.target.value === '' ? null : Number(e.target.value)))}
            />
            <span className="muted small">/ 100</span>
          </div>
        )}
      </Field>
      <Field label={t('ux.fin.label')} required hint={t('ux.fin.hint')}>
        {(id, d) => (
          <input
            id={id}
            aria-describedby={d}
            dir="ltr"
            value={cfg.evaluation.financialCriteria.join(', ')}
            onChange={(e) =>
              set(
                (x) =>
                  void (x.evaluation.financialCriteria = e.target.value
                    .split(/[,\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean)),
              )
            }
          />
        )}
      </Field>
    </div>
  );
}

const STAGE_ICON: Record<string, string> = { requestIntake: '📨', documentPurchase: '💳', gazette: '📰', capt: '🏛️', complianceScreening: '🔎', recordsLock: '🗄️' };

export function StageToggleCards({ cfg, set }: { cfg: CycleConfig; set: (p: (c: CycleConfig) => void) => void }) {
  const { t } = useI18n();
  const full = bidsInScope(cfg);
  return (
    <ul className="ux-toggle-cards">
      {STAGE_TOGGLES.map((k) => {
        const notApplicable = !full && (k === 'complianceScreening' || k === 'recordsLock');
        return (
          <li key={k}>
            <label className={`ux-toggle-card ${cfg.stages[k] ? 'on' : ''} ${notApplicable ? 'is-na' : ''}`}>
              <input type="checkbox" checked={cfg.stages[k]} onChange={(e) => set((x) => void (x.stages[k] = e.target.checked))} />
              <span className="ux-card-icon" aria-hidden="true">
                {STAGE_ICON[k]}
              </span>
              <span className="ux-toggle-text">
                <strong>{t(`cycle.toggle.${k}` as TKey)}</strong>
                <span className="small muted">{t(`cycle.toggleHint.${k}` as TKey)}</span>
                {notApplicable && <span className="small">{t('ux.stage.na')}</span>}
              </span>
              <span className="ux-switch" aria-hidden="true" />
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export function EligibilityEditor({ cfg, set, activityCodes, bare }: { cfg: CycleConfig; set: (p: (c: CycleConfig) => void) => void; activityCodes: { code: string; nameEn: string; nameAr: string }[]; bare?: boolean }) {
  const { t, pick } = useI18n();
  return (
    <fieldset className={bare ? 'ux-bare' : 'ux-fieldset'}>
      <legend className={bare ? 'sr-only' : undefined}>{t('cycle.d.eligibility')}</legend>
      <p className="muted small">{t('cycle.d.eligibilityHint')}</p>
      <h4>{t('cycle.minGrade')}</h4>
      <div className="segmented" role="radiogroup" aria-label={t('cycle.minGrade')}>
        {[null, ...GRADES].map((g) => (
          <button
            key={String(g)}
            type="button"
            role="radio"
            aria-checked={cfg.eligibility.minGrade === g}
            className={cfg.eligibility.minGrade === g ? 'on' : ''}
            onClick={() => set((x) => void (x.eligibility.minGrade = g))}
          >
            {g === null ? t('cycle.grade.none') : t(`cycle.grade.${g}` as TKey)}
          </button>
        ))}
      </div>
      <p className="muted small">{t('ux.grade.explain')}</p>
      <h4>{t('cycle.activityCodes')}</h4>
      {activityCodes.length === 0 ? (
        <p className="muted small">{t('cycle.e.noCodes')}</p>
      ) : (
        <div className="checks">
          {activityCodes.map((a) => (
            <label key={a.code} className="check">
              <input
                type="checkbox"
                checked={cfg.eligibility.activityCodes.includes(a.code)}
                onChange={(e) =>
                  set((x) => {
                    const s = new Set(x.eligibility.activityCodes);
                    if (e.target.checked) s.add(a.code);
                    else s.delete(a.code);
                    x.eligibility.activityCodes = [...s].sort();
                  })
                }
              />
              <span>
                <span dir="ltr">{a.code}</span> — {pick(a.nameEn, a.nameAr)}
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function FeeEditor({ cfg, set, bare }: { cfg: CycleConfig; set: (p: (c: CycleConfig) => void) => void; bare?: boolean }) {
  const { t, fmtMoney } = useI18n();
  const on = cfg.stages.documentPurchase;
  const missing = on && !(cfg.fees.documentPrice > 0);
  return (
    <fieldset className={bare ? 'ux-bare' : 'ux-fieldset'}>
      <legend className={bare ? 'sr-only' : undefined}>{t('cycle.d.fees')}</legend>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) =>
            set((x) => {
              x.stages.documentPurchase = e.target.checked;
              if (e.target.checked && !(x.fees.documentPrice > 0)) x.fees.documentPrice = 10;
            })
          }
        />
        <span>
          <strong>{t('cycle.toggle.documentPurchase')}</strong> — {t('cycle.toggleHint.documentPurchase')}
        </span>
      </label>
      {on && (
        <div className="grid-2">
          <Field label={t('cycle.d.price')} required error={missing ? t('ux.err.feeNeeded') : undefined} hint={!missing ? fmtMoney(cfg.fees.documentPrice, cfg.fees.currency || 'KWD') : undefined}>
            {(id, d) => (
              <span className="ux-money">
                <input
                  id={id}
                  aria-describedby={d}
                  type="number"
                  min={0}
                  step="0.001"
                  dir="ltr"
                  value={cfg.fees.documentPrice}
                  onChange={(e) => set((x) => void (x.fees.documentPrice = e.target.value === '' ? 0 : Number(e.target.value)))}
                />
                <span className="ux-unit" dir="ltr">
                  {cfg.fees.currency || 'KWD'}
                </span>
              </span>
            )}
          </Field>
          <Field label={t('cycle.d.currency')} hint={t('ux.fee.currencyHint')}>
            {(id, d) => <input id={id} aria-describedby={d} maxLength={3} dir="ltr" value={cfg.fees.currency} onChange={(e) => set((x) => void (x.fees.currency = e.target.value.toUpperCase()))} />}
          </Field>
          <label className="check">
            <input type="checkbox" checked={cfg.fees.exemptionAllowed} onChange={(e) => set((x) => void (x.fees.exemptionAllowed = e.target.checked))} />
            <span>{t('cycle.d.exemption')}</span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
