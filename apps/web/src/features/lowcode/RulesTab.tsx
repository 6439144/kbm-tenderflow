// Rules tab: the rule list of the entity's rule set (search, filters, "where it applies", undo after delete), a recipe
// gallery for new rules and a step-by-step rule editor (1 When → 2 If → 3 Then → 4 Name & review) with a live
// plain-language sentence. No code: every choice comes from the server's catalogue and is re-validated on save.
import { useEffect, useMemo, useRef, useState } from 'react';
import { translate, useI18n, type TKey } from '../../i18n';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Modal, Spinner, useToast } from '../../components/ui';
import { StepNav } from '../../components/ux';
import type { Action, ActionType, Catalog, Condition, FactDef, Rule, RulesetDefinition, TriggerDef, TriggerKind } from './api';
import { describe } from './engine';
import { History, KIND_ICON, VersionBar } from './Studio';
import { useDraft } from './useDraft';
import { RecipeGallery, uniqueId } from './recipes';

const EMPTY: RulesetDefinition = { rules: [] };
const KINDS: TriggerKind[] = ['GATE', 'EVENT', 'SCHEDULE'];
const NO_VALUE = ['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'];

/** Everyday words for the operators (both languages), used in the editor and the sentences. */
export function useFriendlyOps(catalog: Catalog) {
  return useMemo(() => {
    const out: Record<string, { en: string; ar: string }> = {};
    for (const op of Object.keys(catalog.opLabels)) {
      const k = `ux.op.${op}` as TKey;
      const e = translate('en', k);
      out[op] = e === k ? catalog.opLabels[op] : { en: e, ar: translate('ar', k) };
    }
    return out;
  }, [catalog]);
}

type Filter = { q: string; kind: 'ALL' | TriggerKind; on: 'ALL' | 'ON' | 'OFF' };

export function RulesTab({ catalog, canEdit, newRuleStage, onConsumed }: { catalog: Catalog; canEdit: boolean; newRuleStage: string | null; onConsumed: () => void; onCatalogChange: () => void }) {
  const { t, te, pick, lang } = useI18n();
  const toast = useToast();
  const d = useDraft<RulesetDefinition>('RULESET', 'PROCESS', EMPTY);
  const [editing, setEditing] = useState<{ rule: Rule; index: number | null } | null>(null);
  const [gallery, setGallery] = useState<{ stage: string | null } | null>(null);
  const [f, setF] = useState<Filter>({ q: '', kind: 'ALL', on: 'ALL' });
  const ops = useFriendlyOps(catalog);
  const editable = canEdit && !!d.draft;

  useEffect(() => {
    if (!newRuleStage || !d.work) return;
    if (!d.draft && canEdit && !d.busy) { void d.start(); return; }
    if (d.draft) {
      setGallery({ stage: newRuleStage });
      onConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRuleStage, d.draft?.id, d.work]);

  const rules = d.work?.rules ?? [];
  const latest = useRef(rules);
  latest.current = rules;
  const put = (rs: Rule[]) => d.edit({ rules: rs });
  const remove = (i: number) => {
    const gone = rules[i];
    put(rules.filter((_, j) => j !== i));
    toast(t('ux.rules.deleted', { name: pick(gone.nameEn, gone.nameAr) }), 'info', {
      label: t('ux.undo'),
      onClick: () => {
        const now = latest.current;
        if (now.some((x) => x.id === gone.id)) return;
        const next = [...now];
        next.splice(Math.min(i, next.length), 0, gone);
        put(next);
      },
    });
  };

  const shown = rules
    .map((r, i) => ({ r, i, trig: catalog.triggers.find((x) => x.key === r.trigger) }))
    .filter(({ r, trig }) => {
      if (f.kind !== 'ALL' && trig?.kind !== f.kind) return false;
      if (f.on === 'ON' && !r.enabled) return false;
      if (f.on === 'OFF' && r.enabled) return false;
      const q = f.q.trim().toLowerCase();
      if (!q) return true;
      const facts = trig ? catalog.facts[trig.scope] : [];
      return [r.nameEn, r.nameAr, r.id, trig?.labelEn, trig?.labelAr, describe(r.when, facts, ops, lang)].some((x) => x?.toLowerCase().includes(q));
    });
  const counts = Object.fromEntries(KINDS.map((k) => [k, rules.filter((r) => catalog.triggers.find((x) => x.key === r.trigger)?.kind === k).length]));

  return (
    <Card title={t('lc.tab.rules')} actions={editable ? <Button onClick={() => setGallery({ stage: null })}>+ {t('lc.rule.new')}</Button> : undefined}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !d.defs ? <Spinner /> : (
          <div className="stack">
            <VersionBar live={d.live} draft={d.draft} dirty={d.dirty} busy={d.busy} canEdit={canEdit} check={d.check}
              onStart={d.start} onSave={d.save} onCheck={d.runCheck} onPublish={d.publish} onDiscard={d.discard} />
            {canEdit && !d.draft && rules.length > 0 && <p className="muted small">{t('ux.rules.startDraftHint')}</p>}
            {rules.length > 0 && (
              <div className="lc-filters" role="search">
                <label className="sr-only" htmlFor="lc-rule-q">{t('ux.rules.search')}</label>
                <input id="lc-rule-q" type="search" placeholder={t('ux.rules.search')} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
                <div className="segmented" role="radiogroup" aria-label={t('ux.rules.kind')}>
                  {(['ALL', ...KINDS] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? 'on' : ''} onClick={() => setF({ ...f, kind: k })}>
                      {k === 'ALL' ? `${t('common.all')} (${rules.length})` : `${KIND_ICON[k]} ${t(`lc.kind.${k}` as TKey)} (${counts[k]})`}
                    </button>
                  ))}
                </div>
                <div className="segmented" role="radiogroup" aria-label={t('ux.rules.state')}>
                  {(['ALL', 'ON', 'OFF'] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={f.on === k} className={f.on === k ? 'on' : ''} onClick={() => setF({ ...f, on: k })}>
                      {t(`ux.rules.on.${k}` as TKey)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!rules.length ? <EmptyState message={t('lc.rule.none')}>{editable && <Button onClick={() => setGallery({ stage: null })}>+ {t('lc.rule.new')}</Button>}</EmptyState>
              : !shown.length ? <EmptyState message={t('ux.rules.noMatch')}><Button variant="secondary" onClick={() => setF({ q: '', kind: 'ALL', on: 'ALL' })}>{t('ux.rules.clear')}</Button></EmptyState> : (
              <ul className="lc-rules" aria-live="polite">
                {shown.map(({ r, i, trig }) => {
                  const facts = trig ? catalog.facts[trig.scope] : [];
                  return (
                    <li key={r.id} className={`lc-rule ${r.enabled ? '' : 'is-off'}`}>
                      <div className="row spread wrap">
                        <div className="lc-rule-head">
                          <strong>{pick(r.nameEn, r.nameAr)}</strong> {!r.enabled && <Badge tone="neutral" label={t('lc.sim.off')} />}
                          <ul className="lc-where" aria-label={t('ux.rules.where')}>
                            {trig && <li className={`lc-chip lc-${trig.kind.toLowerCase()}`} title={t(`lc.kind.${trig.kind}.hint` as TKey)}><span aria-hidden="true">{KIND_ICON[trig.kind]}</span> {t(`lc.kind.${trig.kind}` as TKey)}</li>}
                            {trig && <li className="lc-chip"><span aria-hidden="true">📍</span> {te('cycle.stage.', trig.stage)}</li>}
                            {trig && <li className="lc-chip"><span aria-hidden="true">🗂</span> {t(`ux.scope.${trig.scope}` as TKey)}</li>}
                          </ul>
                        </div>
                        {editable && (
                          <div className="row wrap lc-rule-actions">
                            <label className="check small"><input type="checkbox" checked={r.enabled} onChange={(e) => put(rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} /> {t('lc.rule.enabled')}</label>
                            <Button variant="secondary" className="btn-sm" onClick={() => setEditing({ rule: structuredClone(r), index: i })}>{t('lc.edit')}</Button>
                            <Button variant="ghost" className="btn-sm" onClick={() => put([...rules, { ...structuredClone(r), id: uniqueId(`${r.id}-copy`, rules), nameEn: `${r.nameEn} (copy)`, nameAr: `${r.nameAr} (نسخة)` }])}>{t('lc.rule.duplicate')}</Button>
                            <Button variant="ghost" className="btn-sm" onClick={() => remove(i)}>{t('lc.rule.delete')}</Button>
                          </div>
                        )}
                      </div>
                      <RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} ops={ops} />
                    </li>
                  );
                })}
              </ul>
            )}
            <History kind="RULESET" code="PROCESS" />
          </div>
      )}
      {gallery && (
        <RecipeGallery catalog={catalog} rules={rules} stage={gallery.stage} onClose={() => setGallery(null)}
          onPick={(rule) => { setGallery(null); setEditing({ rule, index: null }); }} />
      )}
      {editing && (
        <RuleEditor catalog={catalog} initial={editing.rule} isNew={editing.index === null} existing={rules} ops={ops} onClose={() => setEditing(null)}
          onSave={(r) => { put(editing.index === null ? [...rules, r] : rules.map((x, j) => (j === editing.index ? r : x))); setEditing(null); toast(t(editing.index === null ? 'ux.rules.added' : 'ux.rules.savedLocal')); }} />
      )}
    </Card>
  );
}

function RuleSentence({ rule, trig, facts, catalog, ops, forceLang }: { rule: Rule; trig?: TriggerDef; facts: FactDef[]; catalog: Catalog; ops: Record<string, { en: string; ar: string }>; forceLang?: 'en' | 'ar' }) {
  const i18n = useI18n();
  const lang = forceLang ?? i18n.lang;
  const t = (k: TKey, v?: Record<string, string | number>) => translate(lang, k, v);
  const pick = (e?: string | null, a?: string | null) => (lang === 'ar' ? a || e || '' : e || a || '');
  return (
    <p className="lc-sentence" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <span className="lc-kw">{t('lc.rule.when')}</span> {trig ? pick(trig.labelEn, trig.labelAr) : rule.trigger}
      {rule.params?.hoursBefore ? ` (${t('ux.rule.hoursBefore', { h: rule.params.hoursBefore })})` : ''}{' '}
      <span className="lc-kw">{t('lc.rule.if')}</span> {describe(rule.when, facts, ops, lang)}{' '}
      <span className="lc-kw">{t('lc.rule.then')}</span> {rule.actions.map((a) => actionText(a, catalog, pick, t, facts)).join(lang === 'ar' ? '؛ ' : '; ') || '…'}
    </p>
  );
}

function actionText(a: Action, c: Catalog, pick: (e?: string | null, a?: string | null) => string, t: (k: TKey, v?: Record<string, string | number>) => string, facts: FactDef[]): string {
  const def = c.actions.find((x) => x.type === a.type);
  const name = def ? pick(def.labelEn, def.labelAr) : a.type;
  const role = a.role ? t(`role.${a.role}` as TKey) : '';
  const field = (k: string) => { const f = facts.find((x) => x.key.endsWith(`.custom.${k}`)); return f ? pick(f.labelEn, f.labelAr) : k; };
  switch (a.type) {
    case 'ADD_APPROVER': return `${name}: ${pick(a.labelEn, a.labelAr) || role}`;
    case 'BLOCK': return `${name}: “${pick(a.messageEn, a.messageAr) || '…'}”`;
    case 'REQUIRE_FIELDS': return `${name}: ${(a.fields ?? []).map(field).join(', ') || '…'}`;
    case 'REQUIRE_DOCUMENTS': return `${name}: ≥ ${a.minCount ?? 1}${a.titleContains ? ` “${a.titleContains}”` : ''}`;
    case 'NOTIFY': return `${name} → ${a.to === 'ROLE' ? role : t(`lc.act.to.${a.to}` as TKey)}`;
    case 'CREATE_TASK': return `${name} → ${role}${a.blocksGate ? ` (${t('lc.task.blocks', { gate: t(`lc.proc.gate.${a.blocksGate}` as TKey) })})` : ''}`;
    case 'WEBHOOK': return `${name}: ${a.endpoint || '…'}`;
    case 'SET_FIELD': return `${name}: ${a.field ? field(a.field) : '…'} = ${JSON.stringify(a.value)}`;
  }
}

// ---------------------------------------------------------------- client checks (hints only; the server decides)
interface RuleIssue { step: number; text: string }
function useRuleIssues() {
  const { t, pick } = useI18n();
  return (r: Rule, trig: TriggerDef, facts: FactDef[], existing: Rule[], initial: Rule): RuleIssue[] => {
    const out: RuleIssue[] = [];
    if (trig.kind === 'SCHEDULE') {
      const h = Number(r.params?.hoursBefore);
      if (!Number.isInteger(h) || h < 1 || h > 720) out.push({ step: 0, text: t('ux.rv.hours') });
    }
    const leaves: { fact: string; op: string; value?: unknown }[] = [];
    const walk = (c: Condition | null) => {
      if (!c) return;
      if ('all' in c) c.all.forEach(walk);
      else if ('any' in c) c.any.forEach(walk);
      else if ('not' in c) walk(c.not);
      else leaves.push(c);
    };
    walk(r.when);
    for (const l of leaves) {
      const f = facts.find((x) => x.key === l.fact);
      const label = f ? pick(f.labelEn, f.labelAr) : l.fact;
      if (!f) { out.push({ step: 1, text: t('ux.rv.fact', { fact: l.fact }) }); continue; }
      if (NO_VALUE.includes(l.op)) continue;
      const v = l.value;
      const num = (x: unknown) => x !== '' && x !== null && x !== undefined && Number.isFinite(Number(x));
      if (l.op === 'between') {
        if (!Array.isArray(v) || !num(v[0]) || !num(v[1])) out.push({ step: 1, text: t('ux.rv.between', { fact: label }) });
        else if (Number(v[0]) > Number(v[1])) out.push({ step: 1, text: t('ux.rv.order', { fact: label }) });
      } else if (l.op === 'in' || l.op === 'notIn') {
        if (!Array.isArray(v) || !v.length) out.push({ step: 1, text: t('ux.rv.pickOne', { fact: label }) });
      } else if (f.type === 'number' || l.op === 'withinDays') {
        if (!num(v)) out.push({ step: 1, text: t('ux.rv.number', { fact: label }) });
      } else if (v === undefined || v === null || String(v).trim() === '') out.push({ step: 1, text: t('ux.rv.value', { fact: label }) });
    }
    if (!r.actions.length) out.push({ step: 2, text: t('ux.rv.noAction') });
    r.actions.forEach((a, i) => {
      const n = i + 1;
      const both = (x?: string, y?: string) => !!x?.trim() && !!y?.trim();
      if (a.type === 'ADD_APPROVER' && !both(a.labelEn, a.labelAr)) out.push({ step: 2, text: t('ux.rv.labels', { n }) });
      if (a.type === 'BLOCK' && !both(a.messageEn, a.messageAr)) out.push({ step: 2, text: t('ux.rv.message', { n }) });
      if (a.type === 'REQUIRE_FIELDS' && !(a.fields ?? []).length) out.push({ step: 2, text: t('ux.rv.fields', { n }) });
      if ((a.type === 'NOTIFY' || a.type === 'CREATE_TASK') && !both(a.titleEn, a.titleAr)) out.push({ step: 2, text: t('ux.rv.title', { n }) });
      if (a.type === 'WEBHOOK' && !a.endpoint) out.push({ step: 2, text: t('ux.rv.endpoint', { n }) });
      if (a.type === 'SET_FIELD' && !a.field) out.push({ step: 2, text: t('ux.rv.field', { n }) });
    });
    if (!r.nameEn.trim() || !r.nameAr.trim()) out.push({ step: 3, text: t('ux.rv.names') });
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(r.id)) out.push({ step: 3, text: t('ux.rv.id') });
    else if (existing.some((x) => x.id === r.id && x.id !== initial.id)) out.push({ step: 3, text: t('ux.rv.idTaken') });
    return out;
  };
}

// ---------------------------------------------------------------- rule editor (stepper)
function RuleEditor({ catalog, initial, isNew, existing, ops, onClose, onSave }: {
  catalog: Catalog; initial: Rule; isNew: boolean; existing: Rule[]; ops: Record<string, { en: string; ar: string }>; onClose: () => void; onSave: (r: Rule) => void;
}) {
  const { t, pick } = useI18n();
  const [r, setR] = useState<Rule>(initial);
  const [step, setStep] = useState(0);
  const [idTouched, setIdTouched] = useState(!isNew);
  const trig = catalog.triggers.find((x) => x.key === r.trigger)!;
  const facts = catalog.facts[trig.scope];
  const allowed = catalog.actions.filter((a) => a.kinds.includes(trig.kind) && (!a.scopes || a.scopes.includes(trig.scope)));
  const issues = useRuleIssues()(r, trig, facts, existing, initial);
  const steps = [t('ux.rule.s1'), t('ux.rule.s2'), t('ux.rule.s3'), t('ux.rule.s4')];
  const status = steps.map((_, i) => (issues.some((x) => x.step === i) && (i < step || step === 3) ? ('error' as const) : undefined));
  const setTrigger = (key: string) => {
    const nt = catalog.triggers.find((x) => x.key === key)!;
    const keep = r.actions.filter((a) => {
      const def = catalog.actions.find((d) => d.type === a.type);
      return def?.kinds.includes(nt.kind) && (!def.scopes || def.scopes.includes(nt.scope));
    });
    setR({ ...r, trigger: key, when: nt.scope === trig.scope ? r.when : null, actions: keep, params: nt.kind === 'SCHEDULE' ? { hoursBefore: r.params?.hoursBefore ?? 48 } : undefined });
  };
  const setNameEn = (v: string) => setR({ ...r, nameEn: v, ...(idTouched ? {} : { id: uniqueId(v || 'rule', existing.filter((x) => x.id !== initial.id)) }) });
  const firstFact = facts[0];
  const newLeaf = (): Condition => ({ fact: firstFact.key, op: catalog.ops[firstFact.type][0] });
  const stepIssues = issues.filter((x) => x.step === step);
  return (
    <Modal open wide title={isNew ? t('lc.rule.new') : t('lc.rule.edit')} onClose={onClose}
      footer={
        <div className="ux-wiz-foot">
          <span className="muted small" aria-live="polite">{stepIssues.length ? `⚠ ${stepIssues[0].text}` : t('ux.wiz.stepOf', { n: step + 1, total: 4 })}</span>
          <span className="row">
            <Button variant="secondary" onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? t('common.cancel') : t('ux.back')}</Button>
            {step < 3 ? <Button onClick={() => setStep(step + 1)}>{t('ux.next')}</Button>
              : <Button disabled={issues.length > 0} disabledReason={issues.length ? t('ux.wiz.fixFirst') : undefined} onClick={() => onSave(r)}>{t('ux.rule.save')}</Button>}
          </span>
        </div>
      }>
      <div className="stack lc-stepper">
        <StepNav steps={steps} current={step} onGo={setStep} label={t('lc.rule.edit')} status={status} />
        <div className="lc-preview-sentence" aria-live="polite">
          <strong>{t('lc.rule.sentence')}:</strong> <RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} ops={ops} />
        </div>

        {step === 0 && (
          <section className="lc-step-body" aria-label={steps[0]}>
            <p className="muted">{t('ux.rule.s1.intro')}</p>
            <div className="lc-trigger-cols">
              {KINDS.map((k) => (
                <fieldset key={k} className={`lc-trigger-col lc-col-${k.toLowerCase()}`}>
                  <legend><span aria-hidden="true">{KIND_ICON[k]}</span> {t(`lc.kind.${k}` as TKey)}</legend>
                  <p className="small muted">{t(`lc.kind.${k}.hint` as TKey)}</p>
                  <div role="radiogroup" aria-label={t(`lc.kind.${k}` as TKey)} className="lc-trigger-list">
                    {catalog.triggers.filter((x) => x.kind === k).map((x) => (
                      <button key={x.key} type="button" role="radio" aria-checked={r.trigger === x.key} className={`lc-trigger ${r.trigger === x.key ? 'on' : ''}`} onClick={() => setTrigger(x.key)}>
                        {pick(x.labelEn, x.labelAr)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
            {trig.kind === 'SCHEDULE' && (
              <Field label={t('lc.rule.hoursBefore')} hint={t('ux.rule.hoursHint', { d: Math.round(((r.params?.hoursBefore ?? 48) / 24) * 10) / 10 })}>
                {(id, dsc) => <input id={id} aria-describedby={dsc} type="number" min={1} max={720} dir="ltr" className="ux-num" value={r.params?.hoursBefore ?? 48} onChange={(e) => setR({ ...r, params: { hoursBefore: Number(e.target.value) } })} />}
              </Field>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="lc-step-body" aria-label={steps[1]}>
            <p className="muted">{t('ux.rule.s2.intro')}</p>
            {r.when === null ? (
              <div className="lc-empty-hint">
                <p><strong>{t('ux.rule.noCond')}</strong> {t('ux.rule.noCondHint')}</p>
                <Button variant="secondary" onClick={() => setR({ ...r, when: { all: [newLeaf()] } })}>+ {t('lc.rule.addCondition')}</Button>
              </div>
            ) : (
              <ConditionGroup cond={r.when} facts={facts} catalog={catalog} ops={ops} onChange={(c) => setR({ ...r, when: c })} depth={0} />
            )}
          </section>
        )}

        {step === 2 && (
          <section className="lc-step-body" aria-label={steps[2]}>
            <p className="muted">{t(trig.kind === 'GATE' ? 'ux.rule.s3.gate' : 'ux.rule.s3.event')}</p>
            {!r.actions.length && <div className="lc-empty-hint"><p>{t('ux.rule.noAction')}</p></div>}
            {r.actions.map((a, i) => (
              <ActionEditor key={i} a={a} catalog={catalog} scope={trig.scope} onChange={(na) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? na : x)) })}
                onRemove={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })} />
            ))}
            {r.actions.length < 8 && (
              <div className="lc-add-actions" role="group" aria-label={t('lc.rule.addAction')}>
                <span className="small muted">{t('lc.rule.addAction')}:</span>
                {allowed.map((a) => (
                  <button key={a.type} type="button" className="ux-pill" onClick={() => setR({ ...r, actions: [...r.actions, newAction(a.type, catalog)] })}>
                    + {pick(a.labelEn, a.labelAr)}
                  </button>
                ))}
              </div>
            )}
            {['NOTIFY', 'CREATE_TASK'].some((x) => r.actions.some((a) => a.type === x)) && (
              <p className="muted small">{t('lc.rule.placeholders', { list: (catalog.placeholders[trig.scope] ?? []).map((p) => `{{${p}}}`).join('  ') })}</p>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="lc-step-body" aria-label={steps[3]}>
            <div className="grid-2">
              <Field label={t('lc.rule.name') + ' (EN)'} required>{(id) => <input id={id} dir="ltr" lang="en" value={r.nameEn} maxLength={120} onChange={(e) => setNameEn(e.target.value)} />}</Field>
              <Field label={t('lc.rule.name') + ' (AR)'} required>{(id) => <input id={id} dir="rtl" lang="ar" value={r.nameAr} maxLength={120} onChange={(e) => setR({ ...r, nameAr: e.target.value })} />}</Field>
            </div>
            <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> {t('lc.rule.enabled')}</label>
            <details className="lc-advanced">
              <summary>{t('ux.rule.advanced')}</summary>
              <Field label={t('lc.rule.id')} hint={t('ux.rule.idHint')}>{(id, dsc) => <input id={id} aria-describedby={dsc} dir="ltr" value={r.id} maxLength={41} onChange={(e) => { setIdTouched(true); setR({ ...r, id: e.target.value.toLowerCase() }); }} />}</Field>
            </details>
            <div className="lc-both">
              <div><span className="muted small">English</span><RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} ops={ops} forceLang="en" /></div>
              <div><span className="muted small">العربية</span><RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} ops={ops} forceLang="ar" /></div>
            </div>
            {issues.length > 0 ? (
              <ul className="ux-issues" aria-label={t('ux.rule.issues')}>
                {issues.map((x, i) => <li key={i}><button type="button" className="ux-link" onClick={() => setStep(x.step)}>{steps[x.step]}</button>: {x.text}</li>)}
              </ul>
            ) : <div className="alert alert-success" role="status">{t('ux.rule.ready')}</div>}
            <p className="muted small">{t('ux.rule.afterSave')}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}

function newAction(type: ActionType, c: Catalog): Action {
  switch (type) {
    case 'ADD_APPROVER': { const role = c.approverRoles.includes('UNDERSECRETARY') ? 'UNDERSECRETARY' : c.approverRoles[0]; return { type, role, labelEn: translate('en', `role.${role}` as TKey), labelAr: translate('ar', `role.${role}` as TKey) }; }
    case 'BLOCK': return { type, messageEn: '', messageAr: '' };
    case 'REQUIRE_FIELDS': return { type, fields: [] };
    case 'REQUIRE_DOCUMENTS': return { type, minCount: 1 };
    case 'NOTIFY': return { type, to: 'ROLE', role: 'PROCUREMENT_OFFICER', titleEn: '', titleAr: '' };
    case 'CREATE_TASK': return { type, role: 'PROCUREMENT_OFFICER', titleEn: '', titleAr: '', dueHours: 48, blocksGate: null };
    case 'WEBHOOK': return { type, endpoint: c.webhooks[0] ?? '' };
    case 'SET_FIELD': return { type, field: '', value: '' };
  }
}

// ---------------------------------------------------------------- conditions
function ConditionGroup({ cond, facts, catalog, ops, onChange, depth, onRemove }: {
  cond: Condition; facts: FactDef[]; catalog: Catalog; ops: Record<string, { en: string; ar: string }>; onChange: (c: Condition | null) => void; depth: number; onRemove?: () => void;
}) {
  const { t } = useI18n();
  const group = 'all' in cond ? { k: 'all' as const, items: cond.all } : 'any' in cond ? { k: 'any' as const, items: cond.any } : { k: 'all' as const, items: [cond] };
  const set = (k: 'all' | 'any', items: Condition[]) => onChange(items.length ? ({ [k]: items } as Condition) : null);
  const leaf = (): Condition => ({ fact: facts[0].key, op: catalog.ops[facts[0].type][0] });
  return (
    <div className={`lc-group depth-${depth}`}>
      <div className="row wrap lc-group-head">
        <span className="small">{t('ux.rule.match')}</span>
        <div className="segmented" role="radiogroup" aria-label={t('ux.rule.match')}>
          {(['all', 'any'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={group.k === k} className={group.k === k ? 'on' : ''} onClick={() => set(k, group.items)}>
              {t(k === 'all' ? 'lc.rule.all' : 'lc.rule.any')}
            </button>
          ))}
        </div>
        {onRemove && <Button variant="ghost" className="btn-sm" onClick={onRemove}>{t('ux.rule.removeGroup')}</Button>}
      </div>
      <ul className="lc-conds">
        {group.items.map((c, i) => (
          <li key={i}>
            {i > 0 && <span className="lc-joiner" aria-hidden="true">{t(group.k === 'all' ? 'ux.rule.and' : 'ux.rule.or')}</span>}
            {'all' in c || 'any' in c ? (
              <ConditionGroup cond={c} facts={facts} catalog={catalog} ops={ops} depth={depth + 1}
                onChange={(nc) => set(group.k, nc ? group.items.map((x, j) => (j === i ? nc : x)) : group.items.filter((_, j) => j !== i))}
                onRemove={() => set(group.k, group.items.filter((_, j) => j !== i))} />
            ) : 'not' in c ? null : (
              <LeafEditor leaf={c} facts={facts} catalog={catalog} ops={ops} onChange={(nc) => set(group.k, group.items.map((x, j) => (j === i ? nc : x)))}
                onRemove={() => set(group.k, group.items.filter((_, j) => j !== i))} />
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <Button variant="ghost" className="btn-sm" onClick={() => set(group.k, [...group.items, leaf()])}>+ {t('lc.rule.addCondition')}</Button>
        {depth < 2 && <Button variant="ghost" className="btn-sm" onClick={() => set(group.k, [...group.items, { any: [leaf()] }])}>+ {t('lc.rule.addGroup')}</Button>}
      </div>
    </div>
  );
}

const FACT_GROUPS = ['tender', 'tender.custom', 'award', 'vendor', 'vendor.custom', 'request', 'request.custom', 'document', 'actor'];
const groupOf = (key: string) => (key.includes('.custom.') ? key.split('.').slice(0, 2).join('.') : key.split('.')[0]);

/** Searchable, grouped picker of "what to test", with a one-line description of each fact. */
function FactPicker({ value, facts, onPick }: { value: FactDef; facts: FactDef[]; onPick: (f: FactDef) => void }) {
  const { t, pick } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector('input')?.focus();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const desc = (f: FactDef) => {
    const k = `ux.fact.${f.key}` as TKey;
    const d = t(k);
    return d !== k ? d : f.key.includes('.custom.') ? t('ux.fact.custom') : '';
  };
  const needle = q.trim().toLowerCase();
  const groups = FACT_GROUPS.map((g) => ({ g, xs: facts.filter((f) => groupOf(f.key) === g && (!needle || `${f.labelEn} ${f.labelAr} ${desc(f)}`.toLowerCase().includes(needle))) })).filter((x) => x.xs.length);
  const close = () => { setOpen(false); setQ(''); btn.current?.focus(); };
  return (
    <div className="lc-fact">
      <button ref={btn} type="button" className="lc-fact-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title={desc(value)}>
        <span>{pick(value.labelEn, value.labelAr)}</span><span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={ref} className="lc-fact-pop" role="dialog" aria-label={t('lc.rule.chooseFact')}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <input type="search" aria-label={t('ux.rule.searchFacts')} placeholder={t('ux.rule.searchFacts')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="lc-fact-list">
            {groups.map(({ g, xs }) => (
              <div key={g} role="group" aria-label={t(`ux.fg.${g}` as TKey)}>
                <div className="lc-fact-group">{t(`ux.fg.${g}` as TKey)}</div>
                {xs.map((f) => (
                  <button key={f.key} type="button" className={`lc-fact-opt ${f.key === value.key ? 'on' : ''}`} aria-current={f.key === value.key || undefined} onClick={() => { onPick(f); close(); }}>
                    <strong>{pick(f.labelEn, f.labelAr)}</strong>
                    {desc(f) && <span className="small muted">{desc(f)}</span>}
                  </button>
                ))}
              </div>
            ))}
            {!groups.length && <p className="muted small">{t('ux.help.noMatch')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function LeafEditor({ leaf, facts, catalog, ops, onChange, onRemove }: {
  leaf: { fact: string; op: string; value?: unknown }; facts: FactDef[]; catalog: Catalog; ops: Record<string, { en: string; ar: string }>; onChange: (c: Condition) => void; onRemove: () => void;
}) {
  const { t, lang } = useI18n();
  const f = facts.find((x) => x.key === leaf.fact) ?? facts[0];
  const opList = catalog.ops[f.type];
  const needs = !NO_VALUE.includes(leaf.op);
  return (
    <div className="lc-leaf">
      <FactPicker value={f} facts={facts} onPick={(nf) => onChange({ fact: nf.key, op: catalog.ops[nf.type][0] })} />
      <select aria-label={t('ux.rule.operator')} value={leaf.op} onChange={(e) => onChange({ fact: f.key, op: e.target.value, ...(leaf.value !== undefined && !NO_VALUE.includes(e.target.value) ? { value: leaf.value } : {}) })}>
        {opList.map((o) => <option key={o} value={o}>{ops[o]?.[lang] ?? o}</option>)}
      </select>
      {needs ? <ValueInput f={f} op={leaf.op} value={leaf.value} onChange={(v) => onChange({ fact: f.key, op: leaf.op, value: v })} /> : <span />}
      <Button variant="ghost" className="btn-sm" aria-label={t('ux.rule.removeCond')} title={t('ux.rule.removeCond')} onClick={onRemove}>×</Button>
    </div>
  );
}

function ValueInput({ f, op, value, onChange }: { f: FactDef; op: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t, te, pick, lang } = useI18n();
  const unit = f.unit === 'currency' ? 'KWD' : f.unit === 'days' || op === 'withinDays' ? t('ux.dur.days') : '';
  const fmt = (v: unknown) => (typeof v === 'number' && Math.abs(v) >= 1000 ? v.toLocaleString(lang === 'ar' ? 'ar-KW' : 'en-GB') : '');
  const numInput = (v: unknown, set: (n: unknown) => void, label: string) => (
    <span className="lc-num">
      <input type="number" dir="ltr" aria-label={label} value={v === undefined || v === null ? '' : String(v)} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} />
      {unit && <span className="ux-unit">{unit}</span>}
    </span>
  );
  if (op === 'between') {
    const [a, b] = Array.isArray(value) ? value : ['', ''];
    return <span className="row wrap lc-between">{numInput(a, (n) => onChange([n, b]), t('lc.rule.from'))} {t('ux.rule.and')} {numInput(b, (n) => onChange([a, n]), t('lc.rule.to'))}</span>;
  }
  if (f.options) {
    if (op === 'in' || op === 'notIn') {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return <span className="row wrap">{f.options.map((o) => (
        <label key={o.value} className="check small"><input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} /> {pick(o.labelEn, o.labelAr)}</label>))}</span>;
    }
    return <select aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">{t('ux.rule.choose')}</option>{f.options.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}</select>;
  }
  if (f.type === 'boolean') {
    return <select aria-label={t('lc.rule.value')} value={String(value === true || value === 'true')} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>;
  }
  if (f.key === 'actor.roles') {
    return <select aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">{t('ux.rule.choose')}</option>
      {['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'EVALUATOR', 'TENANT_ADMIN', 'AUDITOR', 'VENDOR'].map((r) => <option key={r} value={r}>{te('role.', r)}</option>)}</select>;
  }
  if (f.type === 'number' || op === 'withinDays') {
    return <span className="lc-num-wrap">{numInput(value, onChange, t('lc.rule.value'))}{fmt(value) && <span className="muted small">= {fmt(value)}</span>}</span>;
  }
  if (f.type === 'date') return <input type="date" aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  if (op === 'in' || op === 'notIn') return <input aria-label={t('lc.rule.value')} placeholder={t('ux.rule.commaList')} value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
  return <input aria-label={t('lc.rule.value')} placeholder={t('ux.rule.typeValue')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}

// ---------------------------------------------------------------- actions
function ActionEditor({ a, catalog, scope, onChange, onRemove }: { a: Action; catalog: Catalog; scope: string; onChange: (a: Action) => void; onRemove: () => void }) {
  const { t, pick } = useI18n();
  const def = catalog.actions.find((x) => x.type === a.type)!;
  const set = (p: Partial<Action>) => onChange({ ...a, ...p });
  const roleSel = (roles: string[]) => (
    <Field label={t('lc.act.role')}>{(id) => <select id={id} value={a.role ?? ''} onChange={(e) => set({ role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{t(`role.${r}` as TKey)}</option>)}</select>}</Field>
  );
  const pair = (kEn: keyof Action, kAr: keyof Action, lEn: TKey, lAr: TKey, max = 200) => (
    <>
      <Field label={t(lEn)} required>{(id) => <input id={id} dir="ltr" lang="en" maxLength={max} value={String(a[kEn] ?? '')} onChange={(e) => set({ [kEn]: e.target.value } as Partial<Action>)} />}</Field>
      <Field label={t(lAr)} required>{(id) => <input id={id} dir="rtl" lang="ar" maxLength={max} value={String(a[kAr] ?? '')} onChange={(e) => set({ [kAr]: e.target.value } as Partial<Action>)} />}</Field>
    </>
  );
  const formCode = scope === 'TENDER' || scope === 'AWARD' ? 'tender' : scope === 'VENDOR' ? 'vendor' : scope === 'REQUEST' ? 'request' : null;
  const customFacts = formCode ? catalog.facts[scope as 'TENDER'].filter((f) => f.key.startsWith(`${formCode}.custom.`)) : [];
  return (
    <div className="lc-action">
      <div className="row spread"><strong>→ {pick(def.labelEn, def.labelAr)}</strong><Button variant="ghost" className="btn-sm" onClick={onRemove}>{t('common.remove')}</Button></div>
      <p className="small muted lc-action-hint">{t(`ux.act.${a.type}` as TKey)}</p>
      <div className="grid-2">
        {a.type === 'ADD_APPROVER' && <>{roleSel(catalog.approverRoles)}<Field label={t('lc.act.dueHours')}>{(id) => <input id={id} type="number" dir="ltr" min={1} value={a.dueHours ?? ''} onChange={(e) => set({ dueHours: e.target.value ? Number(e.target.value) : undefined })} />}</Field>{pair('labelEn', 'labelAr', 'lc.act.labelEn', 'lc.act.labelAr', 120)}</>}
        {a.type === 'BLOCK' && pair('messageEn', 'messageAr', 'lc.act.messageEn', 'lc.act.messageAr', 400)}
        {a.type === 'REQUIRE_FIELDS' && (
          customFacts.length ? (
            <fieldset className="ux-bare lc-span2"><legend className="small">{t('lc.act.fields')}</legend><div className="row wrap">{customFacts.map((f) => {
              const k = f.key.replace('tender.custom.', '');
              const on = (a.fields ?? []).includes(k);
              return <label key={k} className="check small"><input type="checkbox" checked={on} onChange={(e) => set({ fields: e.target.checked ? [...(a.fields ?? []), k] : (a.fields ?? []).filter((x) => x !== k) })} /> {pick(f.labelEn, f.labelAr)}</label>;
            })}</div></fieldset>
          ) : <p className="muted lc-span2">{t('ux.act.noFields')}</p>
        )}
        {a.type === 'REQUIRE_DOCUMENTS' && <>
          <Field label={t('lc.act.minCount')}>{(id) => <input id={id} type="number" dir="ltr" min={1} max={50} value={a.minCount ?? 1} onChange={(e) => set({ minCount: Number(e.target.value) })} />}</Field>
          <Field label={t('lc.act.titleContains')}>{(id) => <input id={id} maxLength={80} value={a.titleContains ?? ''} onChange={(e) => set({ titleContains: e.target.value || undefined })} />}</Field>
        </>}
        {a.type === 'NOTIFY' && <>
          <Field label={t('lc.act.to')}>{(id) => <select id={id} value={a.to} onChange={(e) => set({ to: e.target.value as Action['to'] })}>
            <option value="ROLE">{t('lc.act.to.ROLE')}</option>
            {['TENDER', 'AWARD', 'REQUEST'].includes(scope) && <option value="CREATOR">{t('lc.act.to.CREATOR')}</option>}
            {['VENDOR', 'DOCUMENT'].includes(scope) && <option value="SUBJECT_VENDOR">{t('lc.act.to.SUBJECT_VENDOR')}</option>}
          </select>}</Field>
          {a.to === 'ROLE' ? roleSel(catalog.staffRoles) : <span />}
          {pair('titleEn', 'titleAr', 'lc.act.titleEn', 'lc.act.titleAr')}
        </>}
        {a.type === 'CREATE_TASK' && <>
          {roleSel(catalog.staffRoles)}
          <Field label={t('lc.act.dueHours')}>{(id) => <input id={id} type="number" dir="ltr" min={1} value={a.dueHours ?? ''} onChange={(e) => set({ dueHours: e.target.value ? Number(e.target.value) : undefined })} />}</Field>
          {pair('titleEn', 'titleAr', 'lc.act.titleEn', 'lc.act.titleAr')}
          {(scope === 'TENDER' || scope === 'AWARD') && (
            <Field label={t('lc.act.blocksGate')}>{(id) => <select id={id} value={a.blocksGate ?? ''} onChange={(e) => set({ blocksGate: e.target.value || null })}>
              <option value="">{t('lc.act.blocksNone')}</option>
              {catalog.blockableGates.map((g) => <option key={g} value={g}>{t(`lc.proc.gate.${g}` as TKey)}</option>)}
            </select>}</Field>
          )}
        </>}
        {a.type === 'WEBHOOK' && (catalog.webhooks.length
          ? <Field label={t('lc.act.endpoint')}>{(id) => <select id={id} value={a.endpoint} onChange={(e) => set({ endpoint: e.target.value })}>{catalog.webhooks.map((w) => <option key={w} value={w}>{w}</option>)}</select>}</Field>
          : <p className="muted">{t('lc.act.noWebhooks')}</p>)}
        {a.type === 'SET_FIELD' && <>
          <Field label={t('lc.act.field')}>{(id) => <select id={id} value={a.field ?? ''} onChange={(e) => set({ field: e.target.value })}>
            <option value="">{t('ux.rule.choose')}</option>
            {customFacts.map((f) => <option key={f.key} value={f.key.split('.custom.')[1]}>{pick(f.labelEn, f.labelAr)}</option>)}
          </select>}</Field>
          {(() => {
            const f = customFacts.find((x) => x.key.endsWith(`.custom.${a.field}`));
            if (!f) return <span />;
            return <Field label={t('lc.act.value')}>{() => <ValueInput f={f} op="eq" value={a.value} onChange={(v) => set({ value: f.type === 'boolean' ? v === true || v === 'true' : v })} />}</Field>;
          })()}
        </>}
      </div>
    </div>
  );
}
