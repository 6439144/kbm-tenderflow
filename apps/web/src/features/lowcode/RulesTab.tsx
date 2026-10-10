// Rules tab: the rule list of the entity's rule set and a visual rule builder (When → If → Then) with a live
// plain-language sentence. No code: every choice comes from the server's catalogue and is re-validated on save.
import { useEffect, useMemo, useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Modal, Spinner } from '../../components/ui';
import type { Action, ActionType, Catalog, Condition, FactDef, Rule, RulesetDefinition, TriggerDef } from './api';
import { describe } from './engine';
import { History, KIND_ICON, VersionBar } from './Studio';
import { useDraft } from './useDraft';

const EMPTY: RulesetDefinition = { rules: [] };

export function RulesTab({ catalog, canEdit, newRuleStage, onConsumed }: { catalog: Catalog; canEdit: boolean; newRuleStage: string | null; onConsumed: () => void; onCatalogChange: () => void }) {
  const { t, pick } = useI18n();
  const d = useDraft<RulesetDefinition>('RULESET', 'PROCESS', EMPTY);
  const [editing, setEditing] = useState<{ rule: Rule; index: number | null } | null>(null);
  const editable = canEdit && !!d.draft;

  useEffect(() => {
    if (!newRuleStage || !d.work) return;
    if (!d.draft && canEdit && !d.busy) { void d.start(); return; }
    if (d.draft) {
      const trig = catalog.triggers.find((x) => x.stage === newRuleStage);
      if (trig) setEditing({ rule: blankRule(trig, d.work.rules), index: null });
      onConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRuleStage, d.draft?.id, d.work]);

  const rules = d.work?.rules ?? [];
  const put = (rs: Rule[]) => d.edit({ rules: rs });
  return (
    <Card title={t('lc.tab.rules')} actions={editable ? <Button onClick={() => setEditing({ rule: blankRule(catalog.triggers[0], rules), index: null })}>+ {t('lc.rule.new')}</Button> : undefined}>
      {d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : !d.defs ? <Spinner /> : (
          <div className="stack">
            <VersionBar live={d.live} draft={d.draft} dirty={d.dirty} busy={d.busy} canEdit={canEdit} check={d.check}
              onStart={d.start} onSave={d.save} onCheck={d.runCheck} onPublish={d.publish} onDiscard={d.discard} />
            {!rules.length ? <EmptyState message={t('lc.rule.none')} /> : (
              <ul className="lc-rules">
                {rules.map((r, i) => {
                  const trig = catalog.triggers.find((x) => x.key === r.trigger);
                  const facts = trig ? catalog.facts[trig.scope] : [];
                  return (
                    <li key={r.id} className={`lc-rule ${r.enabled ? '' : 'is-off'}`}>
                      <div className="row spread wrap">
                        <div>
                          <span className={`lc-chip lc-${trig?.kind.toLowerCase()}`}>{trig && KIND_ICON[trig.kind]} {trig && t(`lc.kind.${trig.kind}` as TKey)}</span>{' '}
                          <strong>{pick(r.nameEn, r.nameAr)}</strong> {!r.enabled && <Badge tone="neutral" label={t('lc.sim.off')} />}
                          <div className="muted small"><code>{r.id}</code></div>
                        </div>
                        {editable && (
                          <div className="row">
                            <label className="check small"><input type="checkbox" checked={r.enabled} onChange={(e) => put(rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} /> {t('lc.rule.enabled')}</label>
                            <Button variant="secondary" className="btn-sm" onClick={() => setEditing({ rule: structuredClone(r), index: i })}>{t('lc.edit')}</Button>
                            <Button variant="ghost" className="btn-sm" onClick={() => put([...rules, { ...structuredClone(r), id: uniqueId(`${r.id}-copy`, rules), nameEn: `${r.nameEn} (copy)`, nameAr: `${r.nameAr} (نسخة)` }])}>{t('lc.rule.duplicate')}</Button>
                            <Button variant="ghost" className="btn-sm" onClick={() => put(rules.filter((_, j) => j !== i))}>{t('lc.rule.delete')}</Button>
                          </div>
                        )}
                      </div>
                      <RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} />
                    </li>
                  );
                })}
              </ul>
            )}
            <History kind="RULESET" code="PROCESS" />
          </div>
      )}
      {editing && (
        <RuleEditor catalog={catalog} initial={editing.rule} existing={rules} onClose={() => setEditing(null)}
          onSave={(r) => { put(editing.index === null ? [...rules, r] : rules.map((x, j) => (j === editing.index ? r : x))); setEditing(null); }} />
      )}
    </Card>
  );
}

function uniqueId(base: string, rules: Rule[]) {
  let id = base.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z]+/, 'r').slice(0, 36) || 'rule';
  let n = 1;
  const taken = new Set(rules.map((r) => r.id));
  while (taken.has(id)) id = `${base.slice(0, 34)}-${++n}`;
  return id;
}
function blankRule(trig: TriggerDef, rules: Rule[]): Rule {
  return { id: uniqueId('rule', rules), nameEn: '', nameAr: '', enabled: true, trigger: trig.key, when: null, actions: [],
    ...(trig.kind === 'SCHEDULE' ? { params: { hoursBefore: 48 } } : {}) };
}

function RuleSentence({ rule, trig, facts, catalog }: { rule: Rule; trig?: TriggerDef; facts: FactDef[]; catalog: Catalog }) {
  const { t, pick, lang } = useI18n();
  return (
    <p className="lc-sentence">
      <span className="lc-kw">{t('lc.rule.when')}</span> {trig ? pick(trig.labelEn, trig.labelAr) : rule.trigger}
      {rule.params?.hoursBefore ? ` (${rule.params.hoursBefore}h)` : ''}{' '}
      <span className="lc-kw">{t('lc.rule.if')}</span> {describe(rule.when, facts, catalog.opLabels, lang)}{' '}
      <span className="lc-kw">{t('lc.rule.then')}</span> {rule.actions.map((a) => actionText(a, catalog, pick, t)).join(lang === 'ar' ? '؛ ' : '; ') || '—'}
    </p>
  );
}

function actionText(a: Action, c: Catalog, pick: (e?: string | null, a?: string | null) => string, t: (k: TKey, v?: Record<string, string | number>) => string): string {
  const def = c.actions.find((x) => x.type === a.type);
  const name = def ? pick(def.labelEn, def.labelAr) : a.type;
  const role = a.role ? t(`role.${a.role}` as TKey) : '';
  switch (a.type) {
    case 'ADD_APPROVER': return `${name}: ${pick(a.labelEn, a.labelAr) || role}`;
    case 'BLOCK': return `${name}: “${pick(a.messageEn, a.messageAr)}”`;
    case 'REQUIRE_FIELDS': return `${name}: ${(a.fields ?? []).join(', ')}`;
    case 'REQUIRE_DOCUMENTS': return `${name}: ≥ ${a.minCount ?? 1}${a.titleContains ? ` “${a.titleContains}”` : ''}`;
    case 'NOTIFY': return `${name} → ${a.to === 'ROLE' ? role : t(`lc.act.to.${a.to}` as TKey)}`;
    case 'CREATE_TASK': return `${name} → ${role}${a.blocksGate ? ` (${t('lc.task.blocks', { gate: t(`lc.proc.gate.${a.blocksGate}` as TKey) })})` : ''}`;
    case 'WEBHOOK': return `${name}: ${a.endpoint}`;
    case 'SET_FIELD': return `${name}: ${a.field} = ${JSON.stringify(a.value)}`;
  }
}

// ---------------------------------------------------------------- rule editor
function RuleEditor({ catalog, initial, existing, onClose, onSave }: { catalog: Catalog; initial: Rule; existing: Rule[]; onClose: () => void; onSave: (r: Rule) => void }) {
  const { t, pick, lang } = useI18n();
  const [r, setR] = useState<Rule>(initial);
  const trig = catalog.triggers.find((x) => x.key === r.trigger)!;
  const facts = catalog.facts[trig.scope];
  const allowed = catalog.actions.filter((a) => a.kinds.includes(trig.kind) && (!a.scopes || a.scopes.includes(trig.scope)));
  const idTaken = existing.some((x) => x.id === r.id && x !== initial && x.id !== initial.id);
  const valid = r.nameEn.trim() && r.nameAr.trim() && r.actions.length && !idTaken && /^[a-z][a-z0-9_-]{1,40}$/.test(r.id);
  const setTrigger = (key: string) => {
    const nt = catalog.triggers.find((x) => x.key === key)!;
    const keep = r.actions.filter((a) => catalog.actions.find((d) => d.type === a.type)?.kinds.includes(nt.kind));
    setR({ ...r, trigger: key, when: nt.scope === trig.scope ? r.when : null, actions: keep, params: nt.kind === 'SCHEDULE' ? { hoursBefore: r.params?.hoursBefore ?? 48 } : undefined });
  };
  const groups: TriggerDef['kind'][] = ['GATE', 'EVENT', 'SCHEDULE'];
  return (
    <Modal open wide title={initial.nameEn ? t('lc.rule.edit') : t('lc.rule.new')} onClose={onClose}
      footer={<div className="row"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button disabled={!valid} onClick={() => onSave(r)}>{t('common.done')}</Button></div>}>
      <div className="stack">
        <div className="grid-2">
          <Field label={t('lc.rule.name') + ' (EN)'} required>{(id) => <input id={id} value={r.nameEn} maxLength={120} onChange={(e) => setR({ ...r, nameEn: e.target.value })} />}</Field>
          <Field label={t('lc.rule.name') + ' (AR)'} required>{(id) => <input id={id} dir="rtl" value={r.nameAr} maxLength={120} onChange={(e) => setR({ ...r, nameAr: e.target.value })} />}</Field>
          <Field label={t('lc.rule.id')} error={idTaken ? 'id already used' : undefined}>{(id) => <input id={id} dir="ltr" value={r.id} maxLength={41} onChange={(e) => setR({ ...r, id: e.target.value.toLowerCase() })} />}</Field>
          <label className="check"><input type="checkbox" checked={r.enabled} onChange={(e) => setR({ ...r, enabled: e.target.checked })} /> {t('lc.rule.enabled')}</label>
        </div>
        <section className="lc-step">
          <h3><span className="lc-kw">{t('lc.rule.when')}</span></h3>
          <select aria-label={t('lc.rule.when')} value={r.trigger} onChange={(e) => setTrigger(e.target.value)}>
            {groups.map((g) => (
              <optgroup key={g} label={`${KIND_ICON[g]} ${t(`lc.kind.${g}` as TKey)}`}>
                {catalog.triggers.filter((x) => x.kind === g).map((x) => <option key={x.key} value={x.key}>{pick(x.labelEn, x.labelAr)}</option>)}
              </optgroup>
            ))}
          </select>
          <p className="muted small">{t(`lc.kind.${trig.kind}.hint` as TKey)}</p>
          {trig.kind === 'SCHEDULE' && (
            <Field label={t('lc.rule.hoursBefore')}>{(id) => <input id={id} type="number" min={1} max={720} value={r.params?.hoursBefore ?? 48} onChange={(e) => setR({ ...r, params: { hoursBefore: Number(e.target.value) } })} />}</Field>
          )}
        </section>
        <section className="lc-step">
          <h3><span className="lc-kw">{t('lc.rule.if')}</span></h3>
          {r.when === null ? (
            <div className="row wrap">
              <span className="muted">{t('lc.rule.always')}</span>
              <Button variant="secondary" className="btn-sm" onClick={() => setR({ ...r, when: { all: [{ fact: facts[0].key, op: catalog.ops[facts[0].type][0] }] } })}>+ {t('lc.rule.addCondition')}</Button>
            </div>
          ) : (
            <ConditionGroup cond={r.when} facts={facts} catalog={catalog} onChange={(c) => setR({ ...r, when: c })} depth={0} />
          )}
        </section>
        <section className="lc-step">
          <h3><span className="lc-kw">{t('lc.rule.then')}</span></h3>
          {r.actions.map((a, i) => (
            <ActionEditor key={i} a={a} catalog={catalog} scope={trig.scope} onChange={(na) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? na : x)) })}
              onRemove={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })} />
          ))}
          <div className="row wrap">
            <select aria-label={t('lc.rule.addAction')} value="" onChange={(e) => e.target.value && setR({ ...r, actions: [...r.actions, newAction(e.target.value as ActionType, catalog)] })}>
              <option value="">+ {t('lc.rule.addAction')}</option>
              {allowed.map((a) => <option key={a.type} value={a.type}>{pick(a.labelEn, a.labelAr)}</option>)}
            </select>
          </div>
          {['NOTIFY', 'CREATE_TASK'].some((x) => r.actions.some((a) => a.type === x)) && (
            <p className="muted small">{t('lc.rule.placeholders', { list: (catalog.placeholders[trig.scope] ?? []).map((p) => `{{${p}}}`).join('  ') })}</p>
          )}
        </section>
        <div className="lc-preview-sentence" aria-live="polite">
          <strong>{t('lc.rule.sentence')}:</strong> <RuleSentence rule={r} trig={trig} facts={facts} catalog={catalog} />
          <span className="muted small">{describe(r.when, facts, catalog.opLabels, lang === 'ar' ? 'en' : 'ar')}</span>
        </div>
      </div>
    </Modal>
  );
}

function newAction(type: ActionType, c: Catalog): Action {
  switch (type) {
    case 'ADD_APPROVER': return { type, role: c.approverRoles[1] ?? c.approverRoles[0], labelEn: '', labelAr: '' };
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
function ConditionGroup({ cond, facts, catalog, onChange, depth, onRemove }: { cond: Condition; facts: FactDef[]; catalog: Catalog; onChange: (c: Condition | null) => void; depth: number; onRemove?: () => void }) {
  const { t } = useI18n();
  const group = 'all' in cond ? { k: 'all' as const, items: cond.all } : 'any' in cond ? { k: 'any' as const, items: cond.any } : { k: 'all' as const, items: [cond] };
  const set = (k: 'all' | 'any', items: Condition[]) => onChange(items.length ? ({ [k]: items } as Condition) : null);
  return (
    <div className={`lc-group depth-${depth}`}>
      <div className="row wrap">
        <select aria-label="all / any" value={group.k} onChange={(e) => set(e.target.value as 'all' | 'any', group.items)}>
          <option value="all">{t('lc.rule.all')}</option>
          <option value="any">{t('lc.rule.any')}</option>
        </select>
        {onRemove && <Button variant="ghost" className="btn-sm" onClick={onRemove}>{t('common.remove')}</Button>}
      </div>
      <ul className="lc-conds">
        {group.items.map((c, i) => (
          <li key={i}>
            {'all' in c || 'any' in c ? (
              <ConditionGroup cond={c} facts={facts} catalog={catalog} depth={depth + 1}
                onChange={(nc) => set(group.k, nc ? group.items.map((x, j) => (j === i ? nc : x)) : group.items.filter((_, j) => j !== i))}
                onRemove={() => set(group.k, group.items.filter((_, j) => j !== i))} />
            ) : 'not' in c ? null : (
              <LeafEditor leaf={c} facts={facts} catalog={catalog} onChange={(nc) => set(group.k, group.items.map((x, j) => (j === i ? nc : x)))}
                onRemove={() => set(group.k, group.items.filter((_, j) => j !== i))} />
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <Button variant="ghost" className="btn-sm" onClick={() => set(group.k, [...group.items, { fact: facts[0].key, op: catalog.ops[facts[0].type][0] }])}>+ {t('lc.rule.addCondition')}</Button>
        {depth < 2 && <Button variant="ghost" className="btn-sm" onClick={() => set(group.k, [...group.items, { any: [{ fact: facts[0].key, op: catalog.ops[facts[0].type][0] }] }])}>+ {t('lc.rule.addGroup')}</Button>}
      </div>
    </div>
  );
}

function LeafEditor({ leaf, facts, catalog, onChange, onRemove }: { leaf: { fact: string; op: string; value?: unknown }; facts: FactDef[]; catalog: Catalog; onChange: (c: Condition) => void; onRemove: () => void }) {
  const { t, pick, lang } = useI18n();
  const f = facts.find((x) => x.key === leaf.fact) ?? facts[0];
  const ops = catalog.ops[f.type];
  const needs = !['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse'].includes(leaf.op);
  const grouped = useMemo(() => {
    const g: Record<string, FactDef[]> = {};
    for (const x of facts) (g[x.key.split('.').slice(0, x.key.includes('.custom.') ? 2 : 1).join('.')] ??= []).push(x);
    return g;
  }, [facts]);
  return (
    <div className="lc-leaf">
      <select aria-label={t('lc.rule.chooseFact')} value={f.key} onChange={(e) => { const nf = facts.find((x) => x.key === e.target.value)!; onChange({ fact: nf.key, op: catalog.ops[nf.type][0] }); }}>
        {Object.entries(grouped).map(([g, xs]) => (
          <optgroup key={g} label={g}>{xs.map((x) => <option key={x.key} value={x.key}>{pick(x.labelEn, x.labelAr)}</option>)}</optgroup>
        ))}
      </select>
      <select aria-label="operator" value={leaf.op} onChange={(e) => onChange({ fact: f.key, op: e.target.value, ...(leaf.value !== undefined ? { value: leaf.value } : {}) })}>
        {ops.map((o) => <option key={o} value={o}>{catalog.opLabels[o]?.[lang] ?? o}</option>)}
      </select>
      {needs && <ValueInput f={f} op={leaf.op} value={leaf.value} onChange={(v) => onChange({ fact: f.key, op: leaf.op, value: v })} />}
      <Button variant="ghost" className="btn-sm" aria-label={t('common.remove')} onClick={onRemove}>×</Button>
    </div>
  );
}

function ValueInput({ f, op, value, onChange }: { f: FactDef; op: string; value: unknown; onChange: (v: unknown) => void }) {
  const { t, pick } = useI18n();
  if (op === 'between') {
    const [a, b] = Array.isArray(value) ? value : ['', ''];
    return <span className="row">{t('lc.rule.from')} <input type="number" aria-label={t('lc.rule.from')} value={String(a ?? '')} onChange={(e) => onChange([e.target.value === '' ? '' : Number(e.target.value), b])} />
      {t('lc.rule.to')} <input type="number" aria-label={t('lc.rule.to')} value={String(b ?? '')} onChange={(e) => onChange([a, e.target.value === '' ? '' : Number(e.target.value)])} /></span>;
  }
  if (f.options) {
    if (op === 'in' || op === 'notIn') {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return <span className="row wrap">{f.options.map((o) => (
        <label key={o.value} className="check small"><input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} /> {pick(o.labelEn, o.labelAr)}</label>))}</span>;
    }
    return <select aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{f.options.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}</select>;
  }
  if (f.type === 'boolean') return <select aria-label={t('lc.rule.value')} value={String(value === true || value === 'true')} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>;
  if (f.type === 'number' || op === 'withinDays') return <input type="number" aria-label={t('lc.rule.value')} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  if (f.type === 'date') return <input type="date" aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  if (op === 'in' || op === 'notIn') return <input aria-label={t('lc.rule.value')} placeholder="IT, WORKS" value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} onChange={(e) => onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />;
  return <input aria-label={t('lc.rule.value')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
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
      <Field label={t(lEn)} required>{(id) => <input id={id} maxLength={max} value={String(a[kEn] ?? '')} onChange={(e) => set({ [kEn]: e.target.value } as Partial<Action>)} />}</Field>
      <Field label={t(lAr)} required>{(id) => <input id={id} dir="rtl" maxLength={max} value={String(a[kAr] ?? '')} onChange={(e) => set({ [kAr]: e.target.value } as Partial<Action>)} />}</Field>
    </>
  );
  const formCode = scope === 'TENDER' || scope === 'AWARD' ? 'tender' : scope === 'VENDOR' ? 'vendor' : scope === 'REQUEST' ? 'request' : null;
  const customFacts = formCode ? catalog.facts[scope as 'TENDER'].filter((f) => f.key.startsWith(`${formCode}.custom.`)) : [];
  return (
    <div className="lc-action">
      <div className="row spread"><strong>→ {pick(def.labelEn, def.labelAr)}</strong><Button variant="ghost" className="btn-sm" onClick={onRemove}>{t('common.remove')}</Button></div>
      <div className="grid-2">
        {a.type === 'ADD_APPROVER' && <>{roleSel(catalog.approverRoles)}<Field label={t('lc.act.dueHours')}>{(id) => <input id={id} type="number" min={1} value={a.dueHours ?? ''} onChange={(e) => set({ dueHours: e.target.value ? Number(e.target.value) : undefined })} />}</Field>{pair('labelEn', 'labelAr', 'lc.act.labelEn', 'lc.act.labelAr', 120)}</>}
        {a.type === 'BLOCK' && pair('messageEn', 'messageAr', 'lc.act.messageEn', 'lc.act.messageAr', 400)}
        {a.type === 'REQUIRE_FIELDS' && (
          <Field label={t('lc.act.fields')}>{() => <div className="row wrap">{customFacts.filter((f) => f.type !== 'number' || true).map((f) => {
            const k = f.key.replace('tender.custom.', '');
            const on = (a.fields ?? []).includes(k);
            return <label key={k} className="check small"><input type="checkbox" checked={on} onChange={(e) => set({ fields: e.target.checked ? [...(a.fields ?? []), k] : (a.fields ?? []).filter((x) => x !== k) })} /> {pick(f.labelEn, f.labelAr)}</label>;
          })}</div>}</Field>
        )}
        {a.type === 'REQUIRE_DOCUMENTS' && <>
          <Field label={t('lc.act.minCount')}>{(id) => <input id={id} type="number" min={1} max={50} value={a.minCount ?? 1} onChange={(e) => set({ minCount: Number(e.target.value) })} />}</Field>
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
          <Field label={t('lc.act.dueHours')}>{(id) => <input id={id} type="number" min={1} value={a.dueHours ?? ''} onChange={(e) => set({ dueHours: e.target.value ? Number(e.target.value) : undefined })} />}</Field>
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
            <option value="">—</option>
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

