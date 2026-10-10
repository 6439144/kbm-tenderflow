// Forms tab: drag-free form builder for the tender, vendor and request forms (sections, fields, choices, calculated
// fields, conditional visibility) with a live bilingual preview.
import { useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Spinner } from '../../components/ui';
import type { Catalog, Condition, FieldType, FormCode, FormDefinition, FormField } from './api';
import { CustomFieldsForm } from './CustomFields';
import { defaults } from './engine';
import { History, VersionBar } from './Studio';
import { useDraft } from './useDraft';

const EMPTY: FormDefinition = { sections: [], fields: [] };

export function FormsTab({ catalog, canEdit, onPublished }: { catalog: Catalog; canEdit: boolean; onPublished: () => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState<FormCode>('TENDER');
  return (
    <div className="stack">
      <div className="row wrap" role="group" aria-label={t('lc.tab.forms')}>
        {catalog.formCodes.map((c) => (
          <Button key={c} variant={code === c ? 'primary' : 'secondary'} onClick={() => setCode(c)}>{t(`lc.form.code.${c}` as TKey)}</Button>
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
  const put = (next: FormDefinition) => d.edit(next);
  const setField = (i: number, f: FormField) => put({ ...def, fields: def.fields.map((x, j) => (j === i ? f : x)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir; if (j < 0 || j >= def.fields.length) return;
    const fs = [...def.fields]; [fs[i], fs[j]] = [fs[j], fs[i]]; put({ ...def, fields: fs }); setSel(j);
  };
  const addField = (type: FieldType) => {
    let n = def.fields.length + 1; let key = `field${n}`;
    while (def.fields.some((f) => f.key === key)) key = `field${++n}`;
    const f: FormField = { key, type, labelEn: `New ${type} field`, labelAr: 'حقل جديد', audience: 'INTERNAL', required: false,
      ...(type === 'select' || type === 'multiselect' ? { options: [{ value: 'A', labelEn: 'Option A', labelAr: 'الخيار أ' }] } : {}),
      ...(type === 'computed' ? { formula: code === 'TENDER' ? 'budget * 0.02' : '0', decimals: 3 } : {}) };
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
          <h3>{t('lc.form.sections')}</h3>
          <ul className="lc-sections">
            {def.sections.map((s, i) => (
              <li key={i} className="lc-row4">
                <input aria-label={t('lc.field.key')} dir="ltr" className="lc-key" value={s.key} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                <input aria-label="EN" value={s.titleEn} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, titleEn: e.target.value } : x)) })} />
                <input aria-label="AR" dir="rtl" value={s.titleAr} disabled={!editable} onChange={(e) => put({ ...def, sections: def.sections.map((x, j) => (j === i ? { ...x, titleAr: e.target.value } : x)) })} />
                {editable && <Button variant="ghost" className="btn-sm" onClick={() => put({ sections: def.sections.filter((_, j) => j !== i), fields: def.fields.map((f) => (f.section === s.key ? { ...f, section: undefined } : f)) })}>×</Button>}
              </li>
            ))}
          </ul>
          {editable && <Button variant="ghost" className="btn-sm" onClick={() => put({ ...def, sections: [...def.sections, { key: `section${def.sections.length + 1}`, titleEn: 'New section', titleAr: 'قسم جديد' }] })}>+ {t('lc.form.addSection')}</Button>}

          <h3>{t('lc.form.fields')}</h3>
          {!def.fields.length && <EmptyState message={t('lc.form.noFields')} />}
          <ol className="lc-fields">
            {def.fields.map((f, i) => (
              <li key={i} className={`lc-field-row ${sel === i ? 'is-selected' : ''}`}>
                <button type="button" className="lc-field-pick" onClick={() => setSel(sel === i ? null : i)} aria-expanded={sel === i}>
                  <strong>{pick(f.labelEn, f.labelAr)}</strong> <code>{f.key}</code>{' '}
                  <Badge tone="neutral" label={t(`lc.ftype.${f.type}` as TKey)} />{' '}
                  <Badge tone={f.audience === 'PUBLIC' ? 'info' : 'neutral'} label={t(f.audience === 'PUBLIC' ? 'lc.field.public' : 'lc.field.internal')} />
                  {f.required && <> <Badge tone="warn" label={t('lc.field.required')} /></>}
                  {f.visibleWhen && <> <Badge tone="neutral" label="if…" /></>}
                </button>
                {editable && (
                  <span className="row">
                    <Button variant="ghost" className="btn-sm" aria-label={t('lc.form.moveUp')} onClick={() => move(i, -1)}>↑</Button>
                    <Button variant="ghost" className="btn-sm" aria-label={t('lc.form.moveDown')} onClick={() => move(i, 1)}>↓</Button>
                    <Button variant="ghost" className="btn-sm" aria-label={t('common.remove')} onClick={() => { put({ ...def, fields: def.fields.filter((_, j) => j !== i) }); setSel(null); }}>×</Button>
                  </span>
                )}
                {sel === i && <FieldEditor f={f} def={def} code={code} catalog={catalog} disabled={!editable} onChange={(nf) => setField(i, nf)} />}
              </li>
            ))}
          </ol>
          {editable && (
            <select aria-label={t('lc.form.addField')} value="" onChange={(e) => e.target.value && addField(e.target.value as FieldType)}>
              <option value="">+ {t('lc.form.addField')}</option>
              {catalog.fieldTypes.map((ty) => <option key={ty} value={ty}>{t(`lc.ftype.${ty}` as TKey)}</option>)}
            </select>
          )}
          <History kind="FORM" code={code} />
        </div>
        <aside className="lc-preview" aria-label={t('lc.form.preview')}>
          <div className="row spread wrap">
            <h3>{t('lc.form.preview')}</h3>
            <Button variant="ghost" className="btn-sm" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'EN' : 'ع'}</Button>
          </div>
          <p className="muted small">{t('lc.form.previewNote')}</p>
          {code === 'TENDER' && (
            <Field label={t('lc.form.previewBudget')}>{(id) => <input id={id} type="number" value={budget ?? ''} onChange={(e) => setBudget(e.target.value === '' ? null : Number(e.target.value))} />}</Field>
          )}
          <CustomFieldsForm definition={def} values={{ ...defaults(def.fields), ...preview }} onChange={setPreview} budget={budget} showAudience />
        </aside>
      </div>
    </Card>
  );
}

function FieldEditor({ f, def, code, catalog, disabled, onChange }: { f: FormField; def: FormDefinition; code: FormCode; catalog: Catalog; disabled: boolean; onChange: (f: FormField) => void }) {
  const { t, pick } = useI18n();
  const set = (p: Partial<FormField>) => onChange({ ...f, ...p });
  const isNum = ['number', 'money', 'percent'].includes(f.type);
  const isText = ['text', 'textarea', 'email', 'phone', 'url'].includes(f.type);
  const others = def.fields.filter((x) => x.key !== f.key && x.type !== 'computed' && ['checkbox', 'select', 'number', 'money', 'percent'].includes(x.type));
  const vw = f.visibleWhen && 'fact' in f.visibleWhen ? f.visibleWhen : null;
  const target = others.find((x) => `self.${x.key}` === vw?.fact);
  const setVisible = (c: Condition | null) => set({ visibleWhen: c });
  return (
    <fieldset className="lc-field-editor" disabled={disabled}>
      <div className="grid-2">
        <Field label={t('lc.field.key')}>{(id) => <input id={id} dir="ltr" value={f.key} pattern="[a-z][A-Za-z0-9]*" onChange={(e) => set({ key: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} />}</Field>
        <Field label={t('lc.field.type')}>{(id) => <select id={id} value={f.type} onChange={(e) => set({ type: e.target.value as FieldType })}>{catalog.fieldTypes.map((ty) => <option key={ty} value={ty}>{t(`lc.ftype.${ty}` as TKey)}</option>)}</select>}</Field>
        <Field label={t('lc.field.labelEn')} required>{(id) => <input id={id} value={f.labelEn} onChange={(e) => set({ labelEn: e.target.value })} />}</Field>
        <Field label={t('lc.field.labelAr')} required>{(id) => <input id={id} dir="rtl" value={f.labelAr} onChange={(e) => set({ labelAr: e.target.value })} />}</Field>
        <Field label={t('lc.field.helpEn')}>{(id) => <input id={id} value={f.helpEn ?? ''} onChange={(e) => set({ helpEn: e.target.value || undefined })} />}</Field>
        <Field label={t('lc.field.helpAr')}>{(id) => <input id={id} dir="rtl" value={f.helpAr ?? ''} onChange={(e) => set({ helpAr: e.target.value || undefined })} />}</Field>
        <Field label={t('lc.field.section')}>{(id) => <select id={id} value={f.section ?? ''} onChange={(e) => set({ section: e.target.value || undefined })}>
          <option value="">{t('lc.field.noSection')}</option>{def.sections.map((s) => <option key={s.key} value={s.key}>{pick(s.titleEn, s.titleAr)}</option>)}</select>}</Field>
        <Field label={t('lc.field.audience')}>{(id) => <select id={id} value={f.audience ?? 'INTERNAL'} onChange={(e) => set({ audience: e.target.value as FormField['audience'] })}>
          <option value="INTERNAL">{t('lc.field.audience.INTERNAL')}</option><option value="PUBLIC">{t('lc.field.audience.PUBLIC')}</option></select>}</Field>
        {f.type !== 'computed' && <label className="check"><input type="checkbox" checked={!!f.required} onChange={(e) => set({ required: e.target.checked })} /> {t('lc.field.required')}</label>}
        {f.type !== 'computed' && f.required && code === 'TENDER' && (
          <Field label={t('lc.field.requiredAt')}>{(id) => <select id={id} value={f.requiredAt ?? 'SUBMIT'} onChange={(e) => set({ requiredAt: e.target.value as FormField['requiredAt'] })}>
            <option value="SUBMIT">{t('lc.field.requiredAt.SUBMIT')}</option><option value="SAVE">{t('lc.field.requiredAt.SAVE')}</option></select>}</Field>
        )}
        {isNum && <>
          <Field label={t('lc.field.min')}>{(id) => <input id={id} type="number" value={f.min ?? ''} onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
          <Field label={t('lc.field.max')}>{(id) => <input id={id} type="number" value={f.max ?? ''} onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
        </>}
        {(isNum || f.type === 'computed') && <Field label={t('lc.field.decimals')}>{(id) => <input id={id} type="number" min={0} max={6} value={f.decimals ?? ''} onChange={(e) => set({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>}
        {isText && <Field label={t('lc.field.maxLength')}>{(id) => <input id={id} type="number" min={1} value={f.maxLength ?? ''} onChange={(e) => set({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>}
        {f.type === 'text' && <Field label={t('lc.field.format')}>{(id) => <select id={id} value={f.format ?? 'none'} onChange={(e) => set({ format: e.target.value })}>{catalog.formats.map((x) => <option key={x} value={x}>{t(`lc.fmt.${x}` as TKey)}</option>)}</select>}</Field>}
        {f.type !== 'computed' && f.type !== 'multiselect' && (
          <Field label={t('lc.field.default')}>{(id) => f.type === 'checkbox'
            ? <select id={id} value={f.defaultValue === undefined ? '' : String(f.defaultValue)} onChange={(e) => set({ defaultValue: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">—</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
            : f.type === 'select'
              ? <select id={id} value={String(f.defaultValue ?? '')} onChange={(e) => set({ defaultValue: e.target.value || undefined })}><option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}</select>
              : <input id={id} type={isNum ? 'number' : f.type === 'date' ? 'date' : 'text'} value={f.defaultValue === undefined ? '' : String(f.defaultValue)} onChange={(e) => set({ defaultValue: e.target.value === '' ? undefined : isNum ? Number(e.target.value) : e.target.value })} />}</Field>
        )}
      </div>
      {f.type === 'computed' && (
        <Field label={t('lc.field.formula')} hint={t('lc.field.formulaHint', { budget: code === 'TENDER' ? t('lc.field.formulaBudget') : '' })}>
          {(id, dsc) => <input id={id} aria-describedby={dsc} dir="ltr" className="mono" value={f.formula ?? ''} onChange={(e) => set({ formula: e.target.value })} />}
        </Field>
      )}
      {(f.type === 'select' || f.type === 'multiselect') && (
        <div className="stack-sm">
          <strong>{t('lc.field.options')}</strong>
          {(f.options ?? []).map((o, j) => (
            <div key={j} className="lc-row4">
              <input aria-label={t('lc.field.optValue')} dir="ltr" className="lc-key" value={o.value} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)) })} />
              <input aria-label="EN" value={o.labelEn} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, labelEn: e.target.value } : x)) })} />
              <input aria-label="AR" dir="rtl" value={o.labelAr} onChange={(e) => set({ options: f.options!.map((x, k) => (k === j ? { ...x, labelAr: e.target.value } : x)) })} />
              <Button variant="ghost" className="btn-sm" onClick={() => set({ options: f.options!.filter((_, k) => k !== j) })}>×</Button>
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
        {target?.type === 'select' && vw && (
          <select aria-label={t('lc.rule.value')} value={String(vw.value ?? '')} onChange={(e) => setVisible({ fact: vw.fact, op: 'eq', value: e.target.value })}>
            {target.options?.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}
          </select>
        )}
        {target && ['number', 'money', 'percent'].includes(target.type) && vw && (
          <span className="row">&gt; <input type="number" aria-label={t('lc.rule.value')} value={String(vw.value ?? 0)} onChange={(e) => setVisible({ fact: vw.fact, op: 'gt', value: Number(e.target.value) })} /></span>
        )}
      </div>
    </fieldset>
  );
}
