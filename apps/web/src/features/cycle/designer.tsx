// Cycle Designer (/admin/cycle): versioned tender-cycle templates with a live, server-validated preview.
// Usability layer for non-technical procurement administrators: a guided "new template" wizard, a plain-language
// summary, stages that jump to their settings, inline validation next to the setting it concerns, a sticky action bar,
// an unsaved-changes guard and a comparison with the live version. Every save still goes through the server's
// single validator (parseConfig); nothing here relaxes an integrity control.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { platform, type CycleConfig, type CycleTemplate, type StageInfo } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Badge, Button, Card, EmptyState, ErrorBox, Field, Modal, Spinner, Table, useAsync, useToast } from '../../components/ui';
import {
  CYCLE_TOPICS,
  DescribeChangeSlot,
  GettingStarted,
  HelpButton,
  HelpDrawer,
  useGettingStarted,
  useUnsavedGuard,
} from '../../components/ux';
import { AI_KEYS, IntegrityRules, StageStrip, TPL_TONE, roleLabels } from './common';
import { ChainEditor } from './chain';
import { STAGE_SECTION, focusSection, sectionId, useConfigDiff, useIssueReader, usePlainSummary, type Issue, type Section } from './summary';
import { EligibilityEditor, FeeEditor, NewTemplateWizard, PassMarkInput, StageToggleCards } from './wizard';
import { OutOfScopeNote, ScopeCard, bidsInScope } from '../moi';

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

export function CycleDesignerPage({ headerExtras }: { /** Slot for the separately built "describe a change" feature. */ headerExtras?: ReactNode } = {}) {
  const { t } = useI18n();
  const toast = useToast();
  const list = useAsync(() => platform.templates(true), []);
  const codes = useAsync(() => platform.activityCodes(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<string>('');
  const [installing, setInstalling] = useState(false);
  const [installErr, setInstallErr] = useState<unknown>(null);
  const [wizard, setWizard] = useState(false);
  const [help, setHelp] = useState(false);
  const gs = useGettingStarted('cycle');
  const pendingSelect = useRef<string | null>(null);
  const dirty = !!draft && fingerprint(draft) !== base;
  const guard = useUnsavedGuard(dirty, t('ux.unsaved.confirm'));

  const select = (x: CycleTemplate) => {
    const d = fromTemplate(x);
    setDraft(d);
    setBase(fingerprint(d));
  };
  const pick = (x: CycleTemplate) => {
    if (x.id === draft?.id || !guard.confirmLeave()) return;
    select(x);
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

  /** Advanced: start a new template from the settings currently on screen (the wizard is the guided way). */
  const startFromCurrent = () => {
    if (!guard.confirmLeave()) return;
    const d: Draft = { id: null, code: '', version: null, status: 'NEW', isDefault: false, nameEn: '', nameAr: '', description: '', config: clone(draft?.config ?? BLANK) };
    setDraft(d);
    setBase('');
  };
  const openWizard = () => {
    if (guard.confirmLeave()) setWizard(true);
  };

  const afterSave = (id: string) => {
    pendingSelect.current = id;
    list.reload();
  };

  const templates = list.data ?? [];
  const live = draft ? templates.find((x) => x.code === draft.code && x.status === 'PUBLISHED') ?? null : null;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('cycle.d.title')}</h1>
          <p className="muted cyc-lead">{t('cycle.d.subtitle')}</p>
        </div>
        <div className="row wrap ux-head-actions">
          <DescribeChangeSlot>{headerExtras}</DescribeChangeSlot>
          <HelpButton onClick={() => setHelp(true)} />
          <Button onClick={openWizard} disabled={!list.data}>
            + {t('cycle.d.new')}
          </Button>
        </div>
      </header>

      {!gs.hidden && list.data && (
        <GettingStarted
          title={t('ux.gs.cycle.title')}
          intro={t('ux.gs.cycle.intro')}
          onDismiss={gs.dismiss}
          items={[
            {
              key: 'have',
              label: t('ux.gs.cycle.have'),
              hint: t('ux.gs.cycle.haveHint'),
              done: templates.length > 0,
              action: templates.length ? undefined : { label: t('cycle.d.install'), onClick: install },
            },
            { key: 'wizard', label: t('ux.gs.cycle.wizard'), hint: t('ux.gs.cycle.wizardHint'), action: { label: t('cycle.d.new'), onClick: openWizard } },
            { key: 'read', label: t('ux.gs.cycle.read'), hint: t('ux.gs.cycle.readHint') },
            { key: 'publish', label: t('ux.gs.cycle.publish'), hint: t('ux.gs.cycle.publishHint'), done: templates.some((x) => x.isDefault) },
          ]}
        />
      )}

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
              {(xs) => <TemplateList items={xs} selectedId={draft?.id ?? null} onSelect={pick} />}
            </AsyncView>
            {templates.length > 0 && (
              <Button variant="ghost" className="btn-sm cyc-mt" onClick={startFromCurrent} title={t('ux.d.fromCurrentHint')}>
                {t('ux.d.fromCurrent')}
              </Button>
            )}
          </Card>
          <Card title={t('cycle.d.integrity')} id={sectionId('integrity')}>
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
              dirty={dirty}
              live={live}
              activityCodes={codes.data ?? []}
              onSaved={afterSave}
            />
          )}
        </div>
      </div>

      <NewTemplateWizard
        open={wizard}
        onClose={() => setWizard(false)}
        existing={templates}
        activityCodes={codes.data ?? []}
        onCreated={(id) => {
          setWizard(false);
          toast(t('ux.wiz.created'));
          afterSave(id);
        }}
      />
      <HelpDrawer open={help} onClose={() => setHelp(false)} topics={CYCLE_TOPICS} intro={t('ux.help.cycleIntro')} onShowGettingStarted={gs.hidden ? gs.show : undefined} />
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

/** Inline problem shown at the top of the settings card it concerns. */
function SectionIssues({ issues, section }: { issues: Issue[]; section: Section }) {
  const { t } = useI18n();
  const xs = issues.filter((x) => x.section === section);
  if (!xs.length) return null;
  return (
    <div className="alert alert-danger ux-inline-issue" role="alert">
      <div>
        {xs.map((x, i) => (
          <div key={i}>
            <strong>{x.text}</strong>
            {x.server && x.server !== x.text && (
              <div className="muted small" dir="ltr" lang="en">
                {t('ux.err.serverSays')} {x.server}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Editor({
  draft,
  setDraft,
  dirty,
  live,
  activityCodes,
  onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  dirty: boolean;
  live: CycleTemplate | null;
  activityCodes: { code: string; nameEn: string; nameAr: string }[];
  onSaved: (id: string) => void;
}) {
  const { t, te, pick } = useI18n();
  const toast = useToast();
  const plain = usePlainSummary();
  const readIssue = useIssueReader();
  const diff = useConfigDiff();
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
  const [compareOpen, setCompareOpen] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  useEffect(() => setValidation(null), [cfgKey]);

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

  const codeOk = /^[A-Za-z0-9_]{2,60}$/.test(draft.code.trim());
  const namesOk = !!(draft.nameEn.trim() && draft.nameAr.trim() && codeOk);
  const stages = preview?.valid ? preview.stages ?? lastGood : lastGood;

  // ---- problems: names / code (checked here, before saving) + the live server validation
  const issues: Issue[] = [
    ...(!draft.nameEn.trim() || !draft.nameAr.trim() ? [{ section: 'identity' as const, text: t('ux.wiz.namesNeeded') }] : []),
    ...(isNew && !codeOk ? [{ section: 'identity' as const, text: t('cycle.d.codeHint') }] : []),
    ...(preview && !preview.valid && preview.error ? [readIssue(preview.error)] : []),
  ];
  const sectionTitle: Record<Section, string> = {
    identity: t('cycle.d.identity'), scope: t('moi.scope.title'), stages: t('cycle.d.stages'), envelopes: t('cycle.d.envelopes'), approvals: t('cycle.d.approvals'),
    eligibility: t('cycle.d.eligibility'), fees: t('cycle.d.fees'), ai: t('cycle.d.ai'), integrity: t('cycle.d.integrity'),
  };
  const canCompare = !!live && (live.id !== draft.id || dirty);
  const changes = canCompare && live ? diff(live.config, c) : null;
  const summary = plain(c, activityCodes);

  return (
    <>
      <div className="cyc-actionbar" role="region" aria-label={t('ux.d.actions')}>
        <div className="cyc-actionbar-title">
          <div className="row wrap">
            <h2 className="cyc-h2">{isNew ? t('cycle.d.newTitle') : pick(draft.nameEn, draft.nameAr)}</h2>
            {!isNew && <Badge tone={TPL_TONE[draft.status]} label={te('cycle.tplStatus.', draft.status)} />}
            {draft.isDefault && <Badge tone="primary" label={t('cycle.default')} />}
            {dirty && <Badge tone="warn" label={t('cycle.d.unsaved')} />}
          </div>
          <div className="muted small">
            {!isNew && (
              <span dir="ltr">
                {draft.code} · v{draft.version}
              </span>
            )}{' '}
            {previewBusy ? (
              <span>{t('ux.d.checking')}</span>
            ) : issues.length ? (
              <a href={`#${sectionId(issues[0].section)}`} className="ux-problem-link" onClick={(e) => { e.preventDefault(); focusSection(issues[0].section); }}>
                ⚠ {t('ux.d.problems', { n: issues.length })}
              </a>
            ) : (
              <span className="ux-ok">✓ {t('ux.d.noProblems')}</span>
            )}
          </div>
        </div>
        <div className="row wrap cyc-actions">
          {canCompare && (
            <Button variant="ghost" onClick={() => setCompareOpen(true)}>
              {t('ux.cmp.open', { v: live!.version })}
            </Button>
          )}
          <Button variant="secondary" busy={busy === 'validate'} onClick={validate}>
            {t('cycle.d.validate')}
          </Button>
          {isDraftVersion && (
            <Button variant="secondary" busy={busy === 'draft'} onClick={saveDraft} disabled={!dirty} disabledReason={!dirty ? t('ux.d.nothingToSave') : undefined}>
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

      {(err || validation || (!isNew && draft.status !== 'DRAFT')) && (
        <Card className="cyc-editor-head">
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
                  <div className="alert-msg">{readIssue(validation.error ?? '').text}</div>
                  <div className="muted small" dir="ltr" lang="en">
                    {t('ux.err.serverSays')} {validation.error}
                  </div>
                </div>
              </div>
            ))}
          {!isNew && draft.status !== 'DRAFT' && <p className="muted small">{t('cycle.d.publishedNote')}</p>}
        </Card>
      )}

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
              <div className="alert-msg">{readIssue(preview.error ?? '').text}</div>
            </div>
          </div>
        )}
        <p className="muted small">{t('ux.d.stripHint')}</p>
        {stages ? (
          <StageStrip stages={stages} cfg={preview?.valid ? c : null} legend onStageClick={(k) => focusSection(STAGE_SECTION[k] ?? 'stages')} />
        ) : (
          <Spinner />
        )}
      </Card>

      <div className="cyc-overview">
        <Card title={t('ux.sum.title')} className="ux-summary-card">
          <ul className="ux-summary-list" aria-live="polite">
            {summary.map((x) => (
              <li key={x.key}>
                <span aria-hidden="true" className="ux-sum-icon">
                  {x.icon}
                </span>
                <span>{x.text}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('ux.d.jump')} className="ux-jump-card">
          {issues.length > 0 && (
            <ul className="ux-issues" aria-label={t('ux.d.problems', { n: issues.length })}>
              {issues.map((x, i) => (
                <li key={i}>
                  <button type="button" className="ux-link" onClick={() => focusSection(x.section)}>
                    {sectionTitle[x.section]}
                  </button>
                  : {x.text}
                </li>
              ))}
            </ul>
          )}
          <nav aria-label={t('ux.d.jump')}>
            <ul className="ux-jump-list">
              {(['identity', 'scope', 'stages', 'envelopes', 'approvals', 'eligibility', 'fees', 'ai'] as Section[]).map((s) => (
                <li key={s}>
                  <button type="button" className={`ux-link ${issues.some((x) => x.section === s) ? 'has-issue' : ''}`} onClick={() => focusSection(s)}>
                    {issues.some((x) => x.section === s) ? '⚠ ' : ''}
                    {sectionTitle[s]}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
      </div>

      <Card title={t('cycle.d.identity')} id={sectionId('identity')}>
        <SectionIssues issues={issues} section="identity" />
        <div className="grid-2">
          <Field label={t('cycle.d.nameEn')} required>
            {(id) => <input id={id} value={draft.nameEn} onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })} dir="ltr" lang="en" />}
          </Field>
          <Field label={t('cycle.d.nameAr')} required>
            {(id) => <input id={id} value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} dir="rtl" lang="ar" />}
          </Field>
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
        </div>
      </Card>

      <div id={sectionId('scope')} tabIndex={-1} className="ux-section-anchor">
        <SectionIssues issues={issues} section="scope" />
        <ScopeCard value={c.scope} onChange={(v) => setCfg((x) => void (x.scope = v))} />
      </div>

      <div className="cyc-config-grid">
        <Card title={t('cycle.d.stages')} id={sectionId('stages')} className="cyc-span-2">
          <SectionIssues issues={issues} section="stages" />
          <p className="muted small">{t('cycle.d.stagesHint')}</p>
          <StageToggleCards cfg={c} set={setCfg} />
        </Card>

        <Card title={t('cycle.d.envelopes')} id={sectionId('envelopes')}>
          <SectionIssues issues={issues} section="envelopes" />
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
          {c.envelopes === 'TWO' && <PassMarkInput cfg={c} set={setCfg} />}
        </Card>

        <Card title={t('cycle.d.fees')} id={sectionId('fees')}>
          <SectionIssues issues={issues} section="fees" />
          <FeeEditor cfg={c} set={setCfg} bare />
        </Card>

        <Card title={t('cycle.d.approvals')} className="cyc-span-2" id={sectionId('approvals')}>
          <SectionIssues issues={issues} section="approvals" />
          <p className="muted small">{t('cycle.d.approvalsHint')}</p>
          <div className="cyc-chains">
            {(['request', 'publish', 'award'] as const)
              .filter((k) => k !== 'award' || bidsInScope(c))
              .map((k) => (
                <ChainEditor
                  key={k}
                  title={t(`cycle.gate.${k}` as TKey)}
                  hint={t(`ux.chain.hint.${k}` as TKey) + (k === 'request' && !c.stages.requestIntake ? ` ${t('ux.chain.requestOff')}` : '')}
                  value={c.approvals[k]}
                  invalid={issues.some((x) => x.section === 'approvals' && x.server?.includes(`approvals.${k}`))}
                  onChange={(v) => setCfg((x) => void (x.approvals[k] = v))}
                />
              ))}
          </div>
        </Card>

        <Card title={t('cycle.d.eligibility')} id={sectionId('eligibility')}>
          <SectionIssues issues={issues} section="eligibility" />
          <EligibilityEditor cfg={c} set={setCfg} activityCodes={activityCodes} bare />
        </Card>

        <Card title={t('cycle.d.ai')} id={sectionId('ai')}>
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
        {changes && (
          <p className="muted small">{changes.length ? t('ux.cmp.count', { n: changes.length, v: live!.version }) : t('ux.cmp.none', { v: live!.version })}</p>
        )}
        <label className="check">
          <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
          <span>{t('cycle.d.makeDefault')}</span>
        </label>
      </Modal>

      <Modal open={compareOpen && !!live} wide title={t('ux.cmp.title', { v: live?.version ?? '' })} onClose={() => setCompareOpen(false)}>
        {live && changes && (
          <div className="stack">
            <p className="muted">{t('ux.cmp.intro', { code: live.code, v: live.version })}</p>
            {(live.nameEn !== draft.nameEn || live.nameAr !== draft.nameAr) && (
              <p className="small">
                {t('ux.cmp.renamed', { before: pick(live.nameEn, live.nameAr), after: pick(draft.nameEn, draft.nameAr) })}
              </p>
            )}
            {!changes.length ? (
              <EmptyState message={t('ux.cmp.none', { v: live.version })} />
            ) : (
              <Table head={[t('ux.cmp.setting'), t('ux.cmp.live', { v: live.version }), t('ux.cmp.this'), '']} caption={t('ux.cmp.title', { v: live.version })}>
                {changes.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.label}</th>
                    <td className={r.kind === 'added' ? 'muted' : 'ux-before'}>{r.before}</td>
                    <td className={r.kind === 'removed' ? 'muted' : 'ux-after'}>{r.after}</td>
                    <td>
                      <Badge tone={r.kind === 'added' ? 'success' : r.kind === 'removed' ? 'danger' : 'warn'} label={t(`ux.cmp.kind.${r.kind}` as TKey)} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
