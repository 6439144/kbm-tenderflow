// Cycle Designer (/admin/cycle): versioned tender-cycle templates with a live, server-validated preview.
import { useEffect, useMemo, useRef, useState } from 'react';
import { platform, type ApprovalLevel, type CycleConfig, type CycleTemplate, type StageInfo } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Badge, Button, Card, EmptyState, ErrorBox, Field, Modal, Spinner, useAsync, useToast } from '../../components/ui';
import {
  AI_KEYS,
  APPROVER_ROLES,
  GRADES,
  IntegrityRules,
  STAGE_TOGGLES,
  StageStrip,
  TPL_TONE,
  roleLabels,
} from './common';
import { DueHoursField, OutOfScopeNote, ScopeCard, bidsInScope } from '../moi';

interface Draft {
  id: string | null;
  code: string;
  version: number | null;
  status: CycleTemplate['status'] | 'NEW';
  isDefault: boolean;
  nameEn: string;
  nameAr: string;
  description: string;
  config: CycleConfig;
}

/** Starting values for a brand-new template (same as the server's v1 behaviour: one director approval, one envelope). */
const BLANK: CycleConfig = {
  scope: 'FULL_CYCLE',
  stages: { requestIntake: false, documentPurchase: false, gazette: false, capt: false, complianceScreening: true, recordsLock: false },
  approvals: {
    request: [{ role: 'DIRECTOR', ...roleLabels('DIRECTOR') }],
    publish: [{ role: 'DIRECTOR', ...roleLabels('DIRECTOR') }],
    award: [{ role: 'DIRECTOR', ...roleLabels('DIRECTOR') }],
  },
  envelopes: 'ONE',
  evaluation: { technicalPassMark: null, financialCriteria: [] },
  eligibility: { activityCodes: [], minGrade: null },
  fees: { documentPrice: 0, currency: 'KWD', exemptionAllowed: false },
  ai: { packCheck: true, clarification: true, compliance: true, gazette: true, relevance: true, narrative: true, requestClassify: true, documentIntelligence: true },
};

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const fromTemplate = (x: CycleTemplate): Draft => ({
  id: x.id,
  code: x.code,
  version: x.version,
  status: x.status,
  isDefault: x.isDefault,
  nameEn: x.nameEn,
  nameAr: x.nameAr,
  description: x.description ?? '',
  config: clone(x.config),
});
const fingerprint = (d: Draft) => JSON.stringify([d.code, d.nameEn, d.nameAr, d.description, d.config]);

export function CycleDesignerPage() {
  const { t } = useI18n();
  const toast = useToast();
  const list = useAsync(() => platform.templates(true), []);
  const codes = useAsync(() => platform.activityCodes(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<string>('');
  const [installing, setInstalling] = useState(false);
  const [installErr, setInstallErr] = useState<unknown>(null);
  const pendingSelect = useRef<string | null>(null);

  const select = (x: CycleTemplate) => {
    const d = fromTemplate(x);
    setDraft(d);
    setBase(fingerprint(d));
  };

  // First load: open the entity's default template; after a save, open the saved version.
  useEffect(() => {
    if (!list.data) return;
    const want = pendingSelect.current;
    pendingSelect.current = null;
    const target = (want && list.data.find((x) => x.id === want)) || (!draft ? list.data.find((x) => x.isDefault) ?? list.data[0] : null);
    if (target) select(target);
    else if (draft?.id) {
      const fresh = list.data.find((x) => x.id === draft.id);
      if (fresh) select(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  const install = async () => {
    setInstalling(true);
    setInstallErr(null);
    try {
      await platform.installStarters();
      toast(t('cycle.d.installed'));
      list.reload();
    } catch (e) {
      setInstallErr(e);
    } finally {
      setInstalling(false);
    }
  };

  const startNew = () => {
    const d: Draft = {
      id: null,
      code: '',
      version: null,
      status: 'NEW',
      isDefault: false,
      nameEn: '',
      nameAr: '',
      description: '',
      config: clone(draft?.config ?? BLANK),
    };
    setDraft(d);
    setBase('');
  };

  const afterSave = (id: string) => {
    pendingSelect.current = id;
    list.reload();
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('cycle.d.title')}</h1>
          <p className="muted cyc-lead">{t('cycle.d.subtitle')}</p>
        </div>
        <Button variant="secondary" onClick={startNew} disabled={!list.data || list.data.length === 0}>
          {t('cycle.d.new')}
        </Button>
      </header>
      <div className="cyc-designer">
        <aside className="stack">
          <Card title={t('cycle.d.templates')} actions={<Button variant="ghost" onClick={list.reload}>{t('common.refresh')}</Button>}>
            {installErr ? <ErrorBox error={installErr} /> : null}
            <AsyncView
              state={list}
              empty={
                <>
                  {t('cycle.d.noTemplates')}
                  <div className="cyc-mt">
                    <Button busy={installing} onClick={install}>
                      {t('cycle.d.install')}
                    </Button>
                  </div>
                </>
              }
            >
              {(xs) => <TemplateList items={xs} selectedId={draft?.id ?? null} onSelect={select} />}
            </AsyncView>
          </Card>
          <Card title={t('cycle.d.integrity')}>
            <p className="muted small">{t('cycle.d.integrityHint')}</p>
            <IntegrityRules />
          </Card>
        </aside>
        <div className="stack">
          {!draft ? (
            list.loading ? (
              <Spinner />
            ) : (
              <Card>
                <EmptyState message={t('cycle.d.pick')} />
              </Card>
            )
          ) : (
            <Editor
              key={draft.id ?? 'new'}
              draft={draft}
              setDraft={setDraft}
              dirty={fingerprint(draft) !== base}
              activityCodes={codes.data ?? []}
              onSaved={afterSave}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateList({ items, selectedId, onSelect }: { items: CycleTemplate[]; selectedId: string | null; onSelect: (x: CycleTemplate) => void }) {
  const { t, te, pick } = useI18n();
  const groups = useMemo(() => {
    const m = new Map<string, CycleTemplate[]>();
    for (const x of items) m.set(x.code, [...(m.get(x.code) ?? []), x]);
    return [...m.entries()];
  }, [items]);
  return (
    <ul className="cyc-tpl-list">
      {groups.map(([code, versions]) => (
        <li key={code} className="cyc-tpl-group">
          <div className="cyc-tpl-code" dir="ltr">
            {code}
          </div>
          <ul>
            {versions.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className={`cyc-tpl-item ${x.id === selectedId ? 'on' : ''} ${x.status === 'RETIRED' ? 'cyc-retired' : ''}`}
                  aria-pressed={x.id === selectedId}
                  onClick={() => onSelect(x)}
                >
                  <span className="cyc-tpl-item-name">{pick(x.nameEn, x.nameAr)}</span>
                  <span className="cyc-tpl-item-meta">
                    <span dir="ltr">v{x.version}</span>
                    <Badge tone={TPL_TONE[x.status]} label={te('cycle.tplStatus.', x.status)} />
                    {x.isDefault && <Badge tone="primary" label={t('cycle.default')} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function Editor({
  draft,
  setDraft,
  dirty,
  activityCodes,
  onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  dirty: boolean;
  activityCodes: { code: string; nameEn: string; nameAr: string }[];
  onSaved: (id: string) => void;
}) {
  const { t, te, pick } = useI18n();
  const toast = useToast();
  const c = draft.config;
  const setCfg = (patch: (cfg: CycleConfig) => void) => {
    const next = clone(c);
    patch(next);
    setDraft({ ...draft, config: next });
  };
  const isNew = draft.status === 'NEW';
  const isDraftVersion = draft.status === 'DRAFT';

  // ---- live preview: every change is validated by the server (the same parser that enforces it)
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; stages?: StageInfo[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [lastGood, setLastGood] = useState<StageInfo[] | null>(null);
  const cfgKey = JSON.stringify(c);
  useEffect(() => {
    let alive = true;
    setPreviewBusy(true);
    const h = setTimeout(() => {
      platform
        .validateTemplate(c)
        .then((r) => {
          if (!alive) return;
          setPreview(r);
          if (r.valid && r.stages) setLastGood(r.stages);
        })
        .catch((e: unknown) => alive && setPreview({ valid: false, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => alive && setPreviewBusy(false));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgKey]);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [validation, setValidation] = useState<{ valid: boolean; error?: string } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const validate = () =>
    run('validate', async () => {
      const r = await platform.validateTemplate(c);
      setValidation(r);
    });
  const saveNewVersion = () =>
    run('version', async () => {
      const x = await platform.createTemplate({ code: draft.code.trim().toUpperCase(), nameEn: draft.nameEn.trim(), nameAr: draft.nameAr.trim(), description: draft.description.trim(), config: c });
      toast(t('cycle.d.savedVersion', { code: x.code, version: x.version }));
      onSaved(x.id);
    });
  const saveDraft = () =>
    run('draft', async () => {
      const x = await platform.updateTemplate(draft.id!, { nameEn: draft.nameEn.trim(), nameAr: draft.nameAr.trim(), description: draft.description.trim(), config: c });
      toast(t('cycle.d.savedDraft'));
      onSaved(x.id);
    });
  const publish = () =>
    run('publish', async () => {
      const x = await platform.publishTemplate(draft.id!, makeDefault);
      setPublishOpen(false);
      toast(t('cycle.d.published', { code: x.code, version: x.version }));
      onSaved(x.id);
    });
  const setDefault = () =>
    run('default', async () => {
      const x = await platform.setDefaultTemplate(draft.id!);
      toast(t('cycle.d.defaultSet'));
      onSaved(x.id);
    });

  const namesOk = draft.nameEn.trim() && draft.nameAr.trim() && /^[A-Za-z0-9_]{2,60}$/.test(draft.code.trim());
  const stages = preview?.valid ? preview.stages ?? lastGood : lastGood;

  return (
    <>
      <Card className="cyc-editor-head">
        <div className="row spread wrap">
          <div>
            <div className="row wrap">
              <h2 className="cyc-h2">{isNew ? t('cycle.d.newTitle') : pick(draft.nameEn, draft.nameAr)}</h2>
              {!isNew && <Badge tone={TPL_TONE[draft.status]} label={te('cycle.tplStatus.', draft.status)} />}
              {draft.isDefault && <Badge tone="primary" label={t('cycle.default')} />}
              {dirty && <Badge tone="warn" label={t('cycle.d.unsaved')} />}
            </div>
            {!isNew && (
              <div className="muted small" dir="ltr">
                {draft.code} · v{draft.version}
              </div>
            )}
          </div>
          <div className="row wrap cyc-actions">
            <Button variant="secondary" busy={busy === 'validate'} onClick={validate}>
              {t('cycle.d.validate')}
            </Button>
            {isDraftVersion && (
              <Button variant="secondary" busy={busy === 'draft'} onClick={saveDraft} disabled={!dirty}>
                {t('cycle.d.saveDraft')}
              </Button>
            )}
            <Button
              variant={isDraftVersion ? 'secondary' : 'primary'}
              busy={busy === 'version'}
              onClick={saveNewVersion}
              disabled={!namesOk}
              disabledReason={!namesOk ? t('cycle.d.namesRequired') : undefined}
            >
              {isNew ? t('cycle.d.create') : t('cycle.d.saveVersion')}
            </Button>
            {isDraftVersion && (
              <Button
                onClick={() => {
                  setMakeDefault(false);
                  setPublishOpen(true);
                }}
                disabled={dirty}
                disabledReason={dirty ? t('cycle.d.saveFirst') : undefined}
              >
                {t('cycle.d.publish')}
              </Button>
            )}
            {draft.status === 'PUBLISHED' && !draft.isDefault && (
              <Button variant="secondary" busy={busy === 'default'} onClick={setDefault}>
                {t('cycle.d.setDefault')}
              </Button>
            )}
          </div>
        </div>
        {err ? <ErrorBox error={err} /> : null}
        {validation &&
          (validation.valid ? (
            <div className="alert alert-success" role="status">
              {t('cycle.d.valid')}
            </div>
          ) : (
            <div className="alert alert-danger" role="alert">
              <div>
                <strong>{t('cycle.d.invalid')}</strong>
                <div className="alert-msg">{validation.error}</div>
              </div>
            </div>
          ))}
        {!isNew && draft.status !== 'DRAFT' && <p className="muted small cyc-mt">{t('cycle.d.publishedNote')}</p>}
      </Card>

      <Card
        title={
          <>
            {t('cycle.d.preview')} {previewBusy && <span className="spinner spinner-sm" aria-hidden="true" />}
          </>
        }
        className="cyc-preview"
      >
        {preview && !preview.valid && (
          <div className="alert alert-danger" role="alert">
            <div>
              <strong>{t('cycle.d.previewInvalid')}</strong>
              <div className="alert-msg">{preview.error}</div>
            </div>
          </div>
        )}
        {stages ? <StageStrip stages={stages} cfg={preview?.valid ? c : null} legend /> : <Spinner />}
      </Card>

      <Card title={t('cycle.d.identity')}>
        <div className="grid-2">
          <Field label={t('cycle.d.code')} required hint={isNew ? t('cycle.d.codeHint') : t('cycle.d.codeLocked')}>
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                value={draft.code}
                readOnly={!isNew}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                dir="ltr"
              />
            )}
          </Field>
          <Field label={t('cycle.d.description')}>
            {(id) => <input id={id} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
          </Field>
          <Field label={t('cycle.d.nameEn')} required>
            {(id) => <input id={id} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} dir="ltr" lang="en" />}
          </Field>
          <Field label={t('cycle.d.nameAr')} required>
            {(id) => <input id={id} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} dir="rtl" lang="ar" />}
          </Field>
        </div>
      </Card>

      <ScopeCard value={c.scope} onChange={(v) => setCfg((x) => void (x.scope = v))} />

      <div className="cyc-config-grid">
        <Card title={t('cycle.d.stages')}>
          <p className="muted small">{t('cycle.d.stagesHint')}</p>
          <ul className="cyc-toggles">
            {STAGE_TOGGLES.map((k) => (
              <li key={k}>
                <label className="cyc-switch">
                  <input type="checkbox" checked={c.stages[k]} onChange={(e) => setCfg((x) => void (x.stages[k] = e.target.checked))} />
                  <span>
                    <strong>{t(`cycle.toggle.${k}` as TKey)}</strong>
                    <span className="muted small">{t(`cycle.toggleHint.${k}` as TKey)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t('cycle.d.envelopes')}>
          {!bidsInScope(c) && <OutOfScopeNote />}
          <div className="segmented" role="radiogroup" aria-label={t('cycle.d.envelopes')}>
            {(['ONE', 'TWO'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={c.envelopes === v}
                className={c.envelopes === v ? 'on' : ''}
                onClick={() =>
                  setCfg((x) => {
                    x.envelopes = v;
                    if (v === 'TWO') {
                      if (x.evaluation.technicalPassMark === null) x.evaluation.technicalPassMark = 70;
                      if (!x.evaluation.financialCriteria.length) x.evaluation.financialCriteria = ['price'];
                    }
                  })
                }
              >
                {te('cycle.env.', v)}
              </button>
            ))}
          </div>
          <p className="muted small">{t(c.envelopes === 'TWO' ? 'cycle.envHint.TWO' : 'cycle.envHint.ONE')}</p>
          {c.envelopes === 'TWO' && (
            <div className="grid-2">
              <Field label={t('cycle.d.passMark')} required hint={t('cycle.d.passMarkHint')}>
                {(id, d) => (
                  <input
                    id={id}
                    aria-describedby={d}
                    type="number"
                    min={0}
                    max={100}
                    dir="ltr"
                    value={c.evaluation.technicalPassMark ?? ''}
                    onChange={(e) => setCfg((x) => void (x.evaluation.technicalPassMark = e.target.value === '' ? null : Number(e.target.value)))}
                  />
                )}
              </Field>
              <Field label={t('cycle.d.finKeys')} required hint={t('cycle.d.finKeysHint')}>
                {(id, d) => (
                  <input
                    id={id}
                    aria-describedby={d}
                    dir="ltr"
                    value={c.evaluation.financialCriteria.join(', ')}
                    onChange={(e) =>
                      setCfg(
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
          )}
        </Card>

        <Card title={t('cycle.d.approvals')} className="cyc-span-2">
          <p className="muted small">{t('cycle.d.approvalsHint')}</p>
          <div className="cyc-chains">
            {(['request', 'publish', 'award'] as const).filter((k) => k !== 'award' || bidsInScope(c)).map((k) => (
              <ChainEditor key={k} title={t(`cycle.gate.${k}` as TKey)} value={c.approvals[k]} onChange={(v) => setCfg((x) => void (x.approvals[k] = v))} />
            ))}
          </div>
        </Card>

        <Card title={t('cycle.d.eligibility')}>
          <p className="muted small">{t('cycle.d.eligibilityHint')}</p>
          <fieldset className="cyc-fieldset">
            <legend>{t('cycle.activityCodes')}</legend>
            {activityCodes.length === 0 ? (
              <p className="muted small">{t('cycle.e.noCodes')}</p>
            ) : (
              <div className="checks">
                {activityCodes.map((a) => (
                  <label key={a.code} className="check">
                    <input
                      type="checkbox"
                      checked={c.eligibility.activityCodes.includes(a.code)}
                      onChange={(e) =>
                        setCfg((x) => {
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
          <Field label={t('cycle.minGrade')}>
            {(id) => (
              <select
                id={id}
                value={c.eligibility.minGrade ?? ''}
                onChange={(e) => setCfg((x) => void (x.eligibility.minGrade = e.target.value === '' ? null : Number(e.target.value)))}
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
        </Card>

        <Card title={t('cycle.d.fees')}>
          {!c.stages.documentPurchase && <p className="muted small">{t('cycle.d.feesOff')}</p>}
          <div className="grid-2">
            <Field label={t('cycle.d.price')} required={c.stages.documentPurchase}>
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min={0}
                  step="0.001"
                  dir="ltr"
                  disabled={!c.stages.documentPurchase}
                  value={c.fees.documentPrice}
                  onChange={(e) => setCfg((x) => void (x.fees.documentPrice = e.target.value === '' ? 0 : Number(e.target.value)))}
                />
              )}
            </Field>
            <Field label={t('cycle.d.currency')}>
              {(id) => (
                <input
                  id={id}
                  maxLength={3}
                  dir="ltr"
                  disabled={!c.stages.documentPurchase}
                  value={c.fees.currency}
                  onChange={(e) => setCfg((x) => void (x.fees.currency = e.target.value.toUpperCase()))}
                />
              )}
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              disabled={!c.stages.documentPurchase}
              checked={c.fees.exemptionAllowed}
              onChange={(e) => setCfg((x) => void (x.fees.exemptionAllowed = e.target.checked))}
            />
            <span>{t('cycle.d.exemption')}</span>
          </label>
        </Card>

        <Card title={t('cycle.d.ai')} className="cyc-span-2">
          <p className="muted small">{t('cycle.d.aiHint')}</p>
          <div className="checks">
            {AI_KEYS.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={c.ai[k] ?? true} onChange={(e) => setCfg((x) => void (x.ai[k] = e.target.checked))} />
                <span>{t(`cycle.ai.${k}` as TKey)}</span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      <Modal
        open={publishOpen}
        title={t('cycle.d.publishTitle')}
        onClose={() => setPublishOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPublishOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button busy={busy === 'publish'} onClick={publish}>
              {t('cycle.d.publish')}
            </Button>
          </>
        }
      >
        {err ? <ErrorBox error={err} /> : null}
        <p>{t('cycle.d.publishBody', { code: draft.code, version: draft.version ?? '' })}</p>
        <label className="check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>{t('cycle.d.makeDefault')}</span>
        </label>
      </Modal>
    </>
  );
}

function ChainEditor({ title, value, onChange }: { title: string; value: ApprovalLevel[]; onChange: (v: ApprovalLevel[]) => void }) {
  const { t, te } = useI18n();
  const set = (i: number, patch: Partial<ApprovalLevel>) => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="cyc-chain-editor">
      <div className="row spread">
        <h3>{title}</h3>
        <span className="muted small">{t('cycle.levels', { n: value.length })}</span>
      </div>
      <ol className="cyc-chain-rows">
        {value.map((l, i) => (
          <li key={i} className="cyc-chain-row">
            <span className="cyc-chain-idx" aria-hidden="true">
              {i + 1}
            </span>
            <div className="cyc-chain-fields">
              <Field label={t('cycle.d.role')}>
                {(id) => (
                  <select
                    id={id}
                    value={l.role}
                    onChange={(e) => {
                      const role = e.target.value;
                      const prev = roleLabels(l.role);
                      const autoLabels = l.labelEn === prev.labelEn && l.labelAr === prev.labelAr;
                      set(i, autoLabels ? { role, ...roleLabels(role) } : { role });
                    }}
                  >
                    {APPROVER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {te('role.', r)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('cycle.d.labelEn')}>{(id) => <input id={id} value={l.labelEn} onChange={(e) => set(i, { labelEn: e.target.value })} dir="ltr" />}</Field>
              <Field label={t('cycle.d.labelAr')}>{(id) => <input id={id} value={l.labelAr} onChange={(e) => set(i, { labelAr: e.target.value })} dir="rtl" />}</Field>
              <DueHoursField value={l.dueHours} onChange={(h) => set(i, { dueHours: h })} />
            </div>
            <div className="cyc-chain-btns">
              <button type="button" className="btn btn-ghost cyc-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('cycle.d.moveUp', { n: i + 1 })}>
                ▲
              </button>
              <button
                type="button"
                className="btn btn-ghost cyc-icon"
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                aria-label={t('cycle.d.moveDown', { n: i + 1 })}
              >
                ▼
              </button>
              <button
                type="button"
                className="btn btn-ghost cyc-icon"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                disabled={value.length <= 1}
                aria-label={t('cycle.d.removeLevel', { n: i + 1 })}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ol>
      <Button variant="secondary" disabled={value.length >= 5} onClick={() => onChange([...value, { role: 'UNDERSECRETARY', ...roleLabels('UNDERSECRETARY') }])}>
        {t('cycle.d.addLevel')}
      </Button>
    </div>
  );
}
