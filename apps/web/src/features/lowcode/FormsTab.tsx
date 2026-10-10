// Forms tab: form builder for the tender, vendor and request forms — a palette of field types with descriptions,
// drag-and-drop ordering (with move up / down buttons for keyboard users), keys made from the English label
// (camelCase, as the server requires), a helper for calculated fields and a side-by-side live bilingual preview.
import { useMemo, useRef, useState } from 'react';
import { translate, useI18n, type TKey } from '../../i18n';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Spinner } from '../../components/ui';
import { DragHandle, moveItem, useDragOrder } from '../../components/ux';
import type { Catalog, Condition, FieldType, FormCode, FormDefinition, FormField } from './api';
import { CustomFieldsForm } from './CustomFields';
import { defaults, evalFormula, parseFormula, withComputed } from './engine';
import { History, VersionBar } from './Studio';
import { useDraft } from './useDraft';

const EMPTY: FormDefinition = { sections: [], fields: [] };
/** Same reserved words as the server (lowcode/forms.ts): they are formula names or system values. */
const RESERVED = new Set(['budget', 'id', 'status', 'tenant', 'min', 'max', 'round', 'abs']);
const FTYPE_ICON: Record<FieldType, string> = {
  text: 'Aa', textarea: '¶', number: '#', money: '¤', percent: '%', date: '📅', select: '◉', multiselect: '☑', checkbox: '✓', email: '@', phone: '☎', url: '🔗', computed: 'ƒ',
};
const NUMERIC: FieldType[] = ['number', 'money', 'percent', 'computed'];

/** camelCase key from an English label: "Budget line (KWD)" → "budgetLineKwd". Unique, not reserved, ≤ 40 chars. */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const words = label.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let k = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  if (!/^[a-z]/.test(k)) k = `field${k ? k[0].toUpperCase() + k.slice(1) : ''}`;
  k = k.slice(0, 36);
  const used = new Set(taken);
  let out = k;
  let n = 2;
  while (used.has(out) || RESERVED.has(out)) out = `${k}${n++}`;
  return out;
}

export function FormsTab({ catalog, canEdit, onPublished }: { catalog: Catalog; canEdit: boolean; onPublished: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState<FormCode>('TENDER');
  return (
    <div className="stack">
      <div className="row wrap" role="group" aria-label={t('lc.tab.forms')}>
        {catalog.formCodes.map((c) => (
          <Button key={c} variant={code === c ? 'primary' : 'secondary'} aria-pressed={code === c} onClick={() => setCode(c)}>{t(`lc.form.code.${c}` as TKey)}</Button>
        ))}
      </div>
      <FormBuilder key={code} code={code} catalog={catalog} canEdit={canEdit} onPublished={onPublished} />
    </div>
  );
}

function FormBuilder({ code, catalog, canEdit, onPublished }: { code: FormCode; catalog: Catalog; canEdit: boolean; onPublished: () => void }) {
  const { t, pick, lang, setLang } = useI18n();
  const d = useDraft<FormDefinition>('FORM', code, EMPTY);
  const [sel, setSel] = useState<number | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const [budget, setBudget] = useState<number | null>(500000);
  const editable = canEdit && !!d.draft;
  const def = d.work ?? EMPTY;
  const liveKeys = useMemo(() => new Set((d.live?.definition.fields ?? []).map((f) => f.key)), [d.live]);
  const put = (next: FormDefinition) => d.edit(next);
  const setField = (i: number, f: FormField) => put({ ...def, fields: def.fields.map((x, j) => (j === i ? f : x)) });
  const move = (i: number, j: number) => {
    if (j < 0 || j >= def.fields.length) return;
    put({ ...def, fields: moveItem(def.fields, i, j) });
    setSel((s) => (s === null ? null : s === i ? j : i < j && s > i && s <= j ? s - 1 : i > j && s >= j && s < i ? s + 1 : s));
  };
  const dnd = useDragOrder(def.fields.length, move);
  const addField = (type: FieldType) => {
    const labelEn = translate('en', 'ux.form.newField').replace('{type}', translate('en', `lc.ftype.${type}` as TKey).toLowerCase());
    const labelAr = translate('ar', 'ux.form.newField').replace('{type}', translate('ar', `lc.ftype.${type}` as TKey));
    const key = keyFromLabel(labelEn, def.fields.map((f) => f.key));
    const numericKeys = def.fields.filter((f) => NUMERIC.includes(f.type)).map((f) => f.key);
    const f: FormField = { key, type, labelEn, labelAr, audience: 'INTERNAL', required: false,
      ...(type === 'select' || type === 'multiselect' ? { options: [{ value: 'A', labelEn: 'Option A', labelAr: 'الخيار أ' }, { value: 'B', labelEn: 'Option B', labelAr: 'الخيار ب' }] } : {}),
      ...(type === 'computed' ? { formula: code === 'TENDER' ? 'round(budget * 0.02, 3)' : numericKeys[0] ? `${numericKeys[0]} * 1` : '0', decimals: 3 } : {}) };
    put({ ...def, fields: [...def.fields, f] }); setSel(def.fields.length);
  };
  if (d.error) return <ErrorBox error={d.error} onRetry={d.reload} />;
  if (!d.defs) return <Spinner />;
  const publish = async () => { await d.publish(); onPublished(); };
  return (
    <Card title={t(`lc.form.code.${code}` as TKey)}>
      <p className="muted">{t(`lc.form.code.${code}.hint` as TKey)}</p>
      <VersionBar live={d.live} draft={d.draft} dirty={d.dirty} busy={d.busy} canEdit={canEdit} check={d.check}
        onStart={d.start} onSave={d.save} onCheck={d.runCheck} onPublish={publish} onDiscard={d.discard} />
      <div className="lc-builder">
        <div className="stack">
          {editable && (
            <section aria-labelledby="lc-palette-h">
              <h3 id="lc-palette-h">{t('ux.form.palette')}</h3>
              <p className="muted small">{t('ux.form.paletteHint')}</p>
              <div className="lc-palette">
                {catalog.fieldTypes.map((ty) => (
                  <button key={ty} type="button" onClick={() => addField(ty)} title={t(`ux.ftype.${ty}` as TKey)}>
                    <span className="lc-ficon" aria-hidden="true">{FTYPE_ICON[ty]}</span>
                    <span className="lc-ptext"><strong>{t(`lc.ftype.${ty}` as TKey)}</strong><span className="small muted">{t(`ux.ftype.${ty}` as TKey)}</span></span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <h3>{t('lc.form.fields')} <span className="muted small">({def.fields.length})</span></h3>
          {!def.fields.length && <EmptyState message={editable ? t('ux.form.noFieldsEdit') : t('lc.form.noFields')} />}
          {editable && def.fields.length > 1 && <p className="muted small">{t('ux.form.dragHint')}</p>}
          <ol className="lc-fields">
            {def.fields.map((f, i) => {
              const r = editable ? dnd.row(i) : null;
              return (
                <li key={i} {...(r ?? {})} className={`lc-field-row ${sel === i ? 'is-selected' : ''} ${r?.className ?? ''}`}>
                  <span className="lc-field-main">
                    {editable && <DragHandle label={t('ux.drag.hint')} {...dnd.handle(i)} />}
                    <span className="lc-ficon" aria-hidden="true">{FTYPE_ICON[f.type]}</span>
                    <button type="button" className="lc-field-pick" onClick={() => setSel(sel === i ? null : i)} aria-expanded={sel === i}>
                      <strong>{pick(f.labelEn, f.labelAr)}</strong>{' '}
                      <Badge tone="neutral" label={t(`lc.ftype.${f.type}` as TKey)} />{' '}
                      <Badge tone={f.audience === 'PUBLIC' ? 'info' : 'neutral'} label={t(f.audience === 'PUBLIC' ? 'lc.field.public' : 'lc.field.internal')} />
                      {f.required && <> <Badge tone="warn" label={t('lc.field.required')} /></>}
                      {f.visibleWhen && <> <Badge tone="neutral" label={t('ux.form.conditional')} /></>}
                      {!liveKeys.has(f.key) && d.live && <> <Badge tone="success" label={t('ux.form.new')} /></>}
                    </button>
                  </span>
                  {editable && (
                    <span className="row lc-field-btns">
                      <Button variant="ghost" className="btn-sm" aria-label={`${t('lc.form.moveUp')}: ${pick(f.labelEn, f.labelAr)}`} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</Button>
                      <Button variant="ghost" className="btn-sm" aria-label={`${t('lc.form.moveDown')}: ${pick(f.labelEn, f.labelAr)}`} disabled={i === def.fields.length - 1} onClick={() => move(i, i + 1)}>↓</Button>
                      <Button variant="ghost" className="btn-sm" aria-label={`${t('common.remove')}: ${pick(f.labelEn, f.labelAr)}`} onClick={() => { put({ ...def, fields: def.fields.filter((_, j) => j !== i) }); setSel(null); }}>×</Button>
                    </span>
                  )}
                  {sel === i && (
                    <FieldEditor f={f} def={def} code={code} catalog={catalog} disabled={!editable} isLive={liveKeys.has(f.key)} preview={preview} budget={budget}
                      onChange={(nf) => setField(i, nf)} />
                  )}
                </li>
              );
            })}
          </ol>

          <h3>{t('lc.form.sections')}</h3>
          <p className="muted small">{t('ux.form.sectionsHint')}</p>
          <ul className="lc-sections">
            {def.sections.map((s, i) => (
              <li key={i} className="lc-row4">
                <input aria-label={t('lc.field.key')} dir="ltr" className="lc-key" value={s.key} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^A-Za-z0-9]/g, '') } : x)) })} />
                <input aria-label={t('ux.form.sectionEn')} dir="ltr" value={s.titleEn} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, titleEn: e.target.value } : x)) })} />
                <input aria-label={t('ux.form.sectionAr')} dir="rtl" value={s.titleAr} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, titleAr: e.target.value } : x)) })} />
                {editable && <Button variant="ghost" className="btn-sm" aria-label={`${t('common.remove')}: ${pick(s.titleEn, s.titleAr)}`} onClick={() => put({ sections: def.sections.filter((_, j) => j !== i), fields: def.fields.map((f) => (f.section === s.key ? { ...f, section: undefined } : f)) })}>×</Button>}
              </li>
            ))}
          </ul>
          {editable && <Button variant="ghost" className="btn-sm" onClick={() => put({ ...def, sections: [...def.sections, { key: keyFromLabel(`section ${def.sections.length + 1}`, def.sections.map((x) => x.key)), titleEn: 'New section', titleAr: 'قسم جديد' }] })}>+ {t('lc.form.addSection')}</Button>}
          <History kind="FORM" code={code} />
        </div>
        <aside className="lc-preview" aria-label={t('lc.form.preview')}>
          <div className="row spread wrap">
            <h3>{t('lc.form.preview')}</h3>
            <Button variant="ghost" className="btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} aria-label={t('ux.form.switchLang')}>{lang === 'ar' ? 'EN' : 'ع'}</Button>
          </div>
          <p className="muted small">{t('lc.form.previewNote')}</p>
          {code === 'TENDER' && (
            <Field label={t('lc.form.previewBudget')}>{(id) => <input id={id} type="number" dir="ltr" value={budget ?? ''} onChange={(e) => setBudget(e.target.value === '' ? null : Number(e.target.value))} />}</Field>
          )}
          {def.fields.length ? <CustomFieldsForm definition={def} values={{ ...defaults(def.fields), ...preview }} onChange={setPreview} budget={budget} showAudience />
            : <p className="muted small">{t('ux.form.previewEmpty')}</p>}
        </aside>
      </div>
    </Card>
  );
}

function FieldEditor({ f, def, code, catalog, disabled, isLive, preview, budget, onChange }: {
  f: FormField; def: FormDefinition; code: FormCode; catalog: Catalog; disabled: boolean; isLive: boolean; preview: Record<string, unknown>; budget: number | null; onChange: (f: FormField) => void;
}) {
  const { t, pick } = useI18n();
  const [editKey, setEditKey] = useState(false);
  const set = (p: Partial<FormField>) => onChange({ ...f, ...p });
  const isNum = ['number', 'money', 'percent'].includes(f.type);
  const isText = ['text', 'textarea', 'email', 'phone', 'url'].includes(f.type);
  const others = def.fields.filter((x) => x.key !== f.key && x.type !== 'computed' && ['checkbox', 'select', 'number', 'money', 'percent'].includes(x.type));
  const vw = f.visibleWhen && 'fact' in f.visibleWhen ? f.visibleWhen : null;
  const target = others.find((x) => `self.${x.key}` === vw?.fact);
  const setVisible = (c: Condition | null) => set({ visibleWhen: c });
  const otherKeys = def.fields.filter((x) => x !== f).map((x) => x.key);
  const keyOk = /^[a-z][A-Za-z0-9]{0,39}$/.test(f.key) && !RESERVED.has(f.key) && !otherKeys.includes(f.key);
  const setLabelEn = (labelEn: string) => {
    // the key follows the English label until the field is published or the admin edits the key
    const auto = !isLive && !editKey && (f.key === keyFromLabel(f.labelEn, otherKeys) || /^field\d*$/.test(f.key) || /^new[A-Z]/.test(f.key));
    set(auto && labelEn.trim() ? { labelEn, key: keyFromLabel(labelEn, otherKeys) } : { labelEn });
  };
  return (
    <fieldset className="lc-field-editor" disabled={disabled}>
      <legend className="sr-only">{pick(f.labelEn, f.labelAr)}</legend>
      <div className="grid-2">
        <Field label={t('lc.field.labelEn')} required>{(id) => <input id={id} dir="ltr" lang="en" value={f.labelEn} onChange={(e) => setLabelEn(e.target.value)} />}</Field>
        <Field label={t('lc.field.labelAr')} required>{(id) => <input id={id} dir="rtl" lang="ar" value={f.labelAr} onChange={(e) => set({ labelAr: e.target.value })} />}</Field>
      </div>
      <div className="lc-keyline">
        {editKey ? (
          <Field label={t('lc.field.key')} hint={isLive ? t('ux.form.keyLive') : t('ux.form.keyRule')} error={!keyOk ? t('ux.form.keyBad') : undefined}>
            {(id, dsc) => <input id={id} aria-describedby={dsc} dir="ltr" className="lc-key" value={f.key} onChange={(e) => set({ key: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />}
          </Field>
        ) : (
          <span className="small">
            {t('ux.form.keyIs')} <code dir="ltr">{f.key}</code> <span className="muted">{isLive ? t('ux.form.keyLocked') : t('ux.form.keyAuto')}</span>{' '}
            <button type="button" className="ux-link small" onClick={() => setEditKey(true)}>{t('ux.form.keyEdit')}</button>
            {!keyOk && <span className="field-error"> {t('ux.form.keyBad')}</span>}
          </span>
        )}
      </div>
      <div className="grid-2">
        <Field label={t('lc.field.type')}>{(id) => <select id={id} value={f.type} onChange={(e) => set({ type: e.target.value as FieldType })}>{catalog.fieldTypes.map((ty) => <option key={ty} value={ty}>{t(`lc.ftype.${ty}` as TKey)}</option>)}</select>}</Field>
        <Field label={t('lc.field.audience')}>{(id) => <select id={id} value={f.audience ?? 'INTERNAL'} onChange={(e) => set({ audience: e.target.value as FormField['audience'] })}>
          <option value="INTERNAL">{t('lc.field.audience.INTERNAL')}</option><option value="PUBLIC">{t('lc.field.audience.PUBLIC')}</option></select>}</Field>
        <Field label={t('lc.field.helpEn')}>{(id) => <input id={id} dir="ltr" value={f.helpEn ?? ''} onChange={(e) => set({ helpEn: e.target.value || undefined })} />}</Field>
        <Field label={t('lc.field.helpAr')}>{(id) => <input id={id} dir="rtl" value={f.helpAr ?? ''} onChange={(e) => set({ helpAr: e.target.value || undefined })} />}</Field>
        <Field label={t('lc.field.section')}>{(id) => <select id={id} value={f.section ?? ''} onChange={(e) => set({ section: e.target.value || undefined })}>
          <option value="">{t('lc.field.noSection')}</option>{def.sections.map((s) => <option key={s.key} value={s.key}>{pick(s.titleEn, s.titleAr)}</option>)}</select>}</Field>
        {f.type !== 'computed' && <label className="check"><input type="checkbox" checked={!!f.required} onChange={(e) => set({ required: e.target.checked })} /> {t('lc.field.required')}</label>}
        {f.type !== 'computed' && f.required && code === 'TENDER' && (
          <Field label={t('lc.field.requiredAt')}>{(id) => <select id={id} value={f.requiredAt ?? 'SUBMIT'} onChange={(e) => set({ requiredAt: e.target.value as FormField['requiredAt'] })}>
            <option value="SUBMIT">{t('lc.field.requiredAt.SUBMIT')}</option><option value="SAVE">{t('lc.field.requiredAt.SAVE')}</option></select>}</Field>
        )}
        {isNum && <>
          <Field label={t('lc.field.min')}>{(id) => <input id={id} type="number" dir="ltr" value={f.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
          <Field label={t('lc.field.max')}>{(id) => <input id={id} type="number" dir="ltr" value={f.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
        </>}
        {(isNum || f.type === 'computed') && <Field label={t('lc.field.decimals')}>{(id) => <input id={id} type="number" dir="ltr" min={0} max={6} value={f.decimals ?? ''} onChange={(e) => set({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>}
        {isText && <Field label={t('lc.field.maxLength')}>{(id) => <input id={id} type="number" dir="ltr" min={1} value={f.maxLength ?? ''} onChange={(e) => set({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>}
        {f.type === 'text' && <Field label={t('lc.field.format')}>{(id) => <select id={id} value={f.format ?? 'none'} onChange={(e) => set({ format: e.target.value })}>{catalog.formats.map((x) => <option key={x} value={x}>{t(`lc.fmt.${x}` as TKey)}</option>)}</select>}</Field>}
        {f.type !== 'computed' && f.type !== 'multiselect' && (
          <Field label={t('lc.field.default')}>{(id) => f.type === 'checkbox'
            ? <select id={id} value={f.defaultValue === undefined ? '' : String(f.defaultValue)} onChange={(e) => set({ defaultValue: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">—</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
            : f.type === 'select'
              ? <select id={id} value={String(f.defaultValue ?? '')} onChange={(e) => set({ defaultValue: e.target.value || undefined })}><option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}</select>
              : <input id={id} type={isNum ? 'number' : f.type === 'date' ? 'date' : 'text'} value={f.defaultValue === undefined ? '' : String(f.defaultValue)} onChange={(e) => set({ defaultValue: e.target.value === '' ? undefined : isNum ? Number(e.target.value) : e.target.value })} />}</Field>
        )}
      </div>
      {f.type === 'computed' && <FormulaHelper f={f} def={def} code={code} preview={preview} budget={budget} onChange={(formula) => set({ formula })} />}
      {(f.type === 'select' || f.type === 'multiselect') && (
        <div className="stack-sm">
          <strong>{t('lc.field.options')}</strong>
          {(f.options ?? []).map((o, j) => (
            <div key={j} className="lc-row4">
              <input aria-label={t('lc.field.optValue')} dir="ltr" className="lc-key" value={o.value} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
              <input aria-label={t('ux.form.optEn')} dir="ltr" value={o.labelEn} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, labelEn: e.target.value } : x)) })} />
              <input aria-label={t('ux.form.optAr')} dir="rtl" value={o.labelAr} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, labelAr: e.target.value } : x)) })} />
              <Button variant="ghost" className="btn-sm" aria-label={`${t('common.remove')}: ${pick(o.labelEn, o.labelAr)}`} onClick={() => set({ options: f.options!.filter((_, k) => k !== j) })}>×</Button>
            </div>
          ))}
          <Button variant="ghost" className="btn-sm" onClick={() => set({ options: [...(f.options ?? []), { value: `OPT${(f.options?.length ?? 0) + 1}`, labelEn: 'New option', labelAr: 'خيار جديد' }] })}>+ {t('lc.field.addOption')}</Button>
        </div>
      )}
      <div className="row wrap lc-visible">
        <strong>{t('lc.field.visibleWhen')}</strong>
        <select aria-label={t('lc.field.visibleWhen')} value={target?.key ?? ''} onChange={(e) => {
          const x = others.find((o) => o.key === e.target.value);
          if (!x) return setVisible(null);
          setVisible(x.type === 'checkbox' ? { fact: `self.${x.key}`, op: 'isTrue' } : x.type === 'select' ? { fact: `self.${x.key}`, op: 'eq', value: x.options?.[0]?.value } : { fact: `self.${x.key}`, op: 'gt', value: 0 });
        }}>
          <option value="">{t('lc.field.alwaysVisible')}</option>
          {others.map((o) => <option key={o.key} value={o.key}>{pick(o.labelEn, o.labelAr)}</option>)}
        </select>
        {target?.type === 'checkbox' && <span className="small muted">{t('ux.form.isYes')}</span>}
        {target?.type === 'select' && vw && (
          <><span className="small">{t('ux.op.eq')}</span>
          <select aria-label={t('lc.rule.value')} value={String(vw.value ?? '')} onChange={(e) => setVisible({ fact: vw.fact, op: 'eq', value: e.target.value })}>
            {target.options?.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}
          </select></>
        )}
        {target && ['number', 'money', 'percent'].includes(target.type) && vw && (
          <span className="row"><span className="small">{t('ux.op.gt')}</span> <input type="number" dir="ltr" className="ux-num" aria-label={t('lc.rule.value')} value={String(vw.value ?? 0)} onChange={(e) => setVisible({ fact: vw.fact, op: 'gt', value: Number(e.target.value) })} /></span>
        )}
      </div>
    </fieldset>
  );
}

/** Calculated fields: insert other number fields and operators, see whether the formula is complete and its result. */
function FormulaHelper({ f, def, code, preview, budget, onChange }: { f: FormField; def: FormDefinition; code: FormCode; preview: Record<string, unknown>; budget: number | null; onChange: (formula: string) => void }) {
  const { t, pick } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  const formula = f.formula ?? '';
  const numFields = def.fields.filter((x) => x.key !== f.key && NUMERIC.includes(x.type));
  const insert = (s: string) => {
    const el = ref.current;
    const a = el?.selectionStart ?? formula.length;
    const b = el?.selectionEnd ?? formula.length;
    const needsSpace = a > 0 && /[A-Za-z0-9)]$/.test(formula.slice(0, a)) && /^[A-Za-z0-9(]/.test(s);
    const piece = (needsSpace ? ' ' : '') + s;
    const next = formula.slice(0, a) + piece + formula.slice(b);
    onChange(next);
    requestAnimationFrame(() => { el?.focus(); const p = a + piece.length - (s.endsWith('()') ? 1 : 0); el?.setSelectionRange(p, p); });
  };
  const known = new Set([...numFields.map((x) => x.key), ...(code === 'TENDER' ? ['budget'] : [])]);
  const refs = (formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((r) => !['min', 'max', 'round', 'abs'].includes(r.toLowerCase()));
  const unknown = [...new Set(refs.filter((r) => !known.has(r)))];
  const parsed = parseFormula(formula);
  const sample = withComputed(def.fields, preview, budget)[f.key];
  const vars: Record<string, number | null> = { budget };
  for (const [k, v] of Object.entries(withComputed(def.fields, preview, budget))) vars[k] = typeof v === 'number' ? v : v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
  const value = parsed ? evalFormula(parsed, vars) : null;
  return (
    <div className="lc-formula">
      <Field label={t('lc.field.formula')} hint={t('lc.field.formulaHint', { budget: code === 'TENDER' ? t('lc.field.formulaBudget') : '' })}
        error={!formula.trim() ? t('ux.formula.empty') : !parsed ? t('ux.formula.incomplete') : unknown.length ? t('ux.formula.unknown', { list: unknown.join(', ') }) : undefined}>
        {(id, dsc) => <input ref={ref} id={id} aria-describedby={dsc} dir="ltr" className="mono" value={formula} onChange={(e) => onChange(e.target.value)} />}
      </Field>
      <div className="lc-insert" role="group" aria-label={t('ux.formula.insert')}>
        <span className="small muted">{t('ux.formula.insert')}:</span>
        {code === 'TENDER' && <button type="button" className="ux-pill" onClick={() => insert('budget')}>{t('ux.formula.budget')}</button>}
        {numFields.map((x) => <button key={x.key} type="button" className="ux-pill" onClick={() => insert(x.key)} title={x.key}>{pick(x.labelEn, x.labelAr)}</button>)}
        {!numFields.length && code !== 'TENDER' && <span className="small muted">{t('ux.formula.noFields')}</span>}
      </div>
      <div className="lc-insert" role="group" aria-label={t('ux.formula.ops')}>
        <span className="small muted">{t('ux.formula.ops')}:</span>
        {[['+', '+'], ['-', '−'], ['*', '×'], ['/', '÷'], ['(', '('], [')', ')']].map(([s, l]) => (
          <button key={s} type="button" className="ux-pill mono" onClick={() => insert(s === '(' || s === ')' ? s : ` ${s} `)} aria-label={t(`ux.formula.op.${s === '+' ? 'plus' : s === '-' ? 'minus' : s === '*' ? 'times' : s === '/' ? 'div' : s === '(' ? 'open' : 'close'}` as TKey)}>{l}</button>
        ))}
        {['round(, 3)', 'min(, )', 'max(, )', 'abs()'].map((fn) => (
          <button key={fn} type="button" dir="ltr" className="ux-pill mono" onClick={() => insert(fn.replace(/\(.*$/, '()'))} title={t(`ux.formula.fn.${fn.split('(')[0]}` as TKey)}>{fn.split('(')[0]}( )</button>
        ))}
      </div>
      <p className="small lc-formula-result" aria-live="polite">
        {parsed && !unknown.length
          ? value === null ? t('ux.formula.needValues') : t('ux.formula.result', { v: Number((sample as number) ?? value).toLocaleString('en-US', { maximumFractionDigits: f.decimals ?? 3 }) })
          : ''}
      </p>
    </div>
  );
}
