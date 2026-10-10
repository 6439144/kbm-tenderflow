// Renders an entity's custom form (from the Process Studio) inside the normal screens: tender form, vendor registration,
// departmental request, and the read-only view of saved values. The server validates and computes the stored values.
import { Fragment } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Field } from '../../components/ui';
import type { CustomValue, FormDefinition, FormField } from './api';
import { visible, withComputed } from './engine';

export function CustomFieldsForm({ definition, values, onChange, budget, editable, showAudience, errors }: {
  definition: FormDefinition; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; budget?: number | null;
  editable?: (f: FormField) => boolean; showAudience?: boolean; errors?: Record<string, string>;
}) {
  const { t, pick } = useI18n();
  const vals = withComputed(definition.fields, values, budget);
  const fields = definition.fields.filter((f) => (editable ? editable(f) || f.type === 'computed' : true));
  const groups: { key: string | null; title: string | null; fields: FormField[] }[] = [];
  for (const f of fields) {
    const key = f.section ?? null;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      const s = definition.sections.find((x) => x.key === key);
      g = { key, title: s ? pick(s.titleEn, s.titleAr) : null, fields: [] };
      groups.push(g);
    }
    g.fields.push(f);
  }
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <div className="lc-form">
      {groups.map((g) => (
        <fieldset key={g.key ?? '_'} className="lc-fieldset">
          {g.title && <legend>{g.title}</legend>}
          <div className="lc-grid">
            {g.fields.filter((f) => visible(f, vals)).map((f) => (
              <div key={f.key} className={f.type === 'textarea' ? 'lc-span2' : ''}>
                <Field
                  label={<>{pick(f.labelEn, f.labelAr)}{showAudience && <> <Badge tone={f.audience === 'PUBLIC' ? 'info' : 'neutral'} label={t(f.audience === 'PUBLIC' ? 'lc.field.public' : 'lc.field.internal')} /></>}
                    {f.type === 'computed' && <> <Badge tone="neutral" label={t('lc.field.calculated')} /></>}</>}
                  hint={pick(f.helpEn, f.helpAr) || undefined}
                  required={f.required}
                  error={errors?.[f.key]}
                >
                  {(id, describedBy) => <Input id={id} describedBy={describedBy} f={f} value={vals[f.key]} onChange={(v) => set(f.key, v)} />}
                </Field>
              </div>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function Input({ id, describedBy, f, value, onChange }: { id: string; describedBy?: string; f: FormField; value: unknown; onChange: (v: unknown) => void }) {
  const { t, pick } = useI18n();
  const common = { id, 'aria-describedby': describedBy };
  switch (f.type) {
    case 'computed':
      return <output {...common} className="lc-computed">{value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: f.decimals ?? 3 })}</output>;
    case 'textarea':
      return <textarea {...common} rows={3} maxLength={f.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'number': case 'money': case 'percent':
      return <input {...common} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.decimals ? 10 ** -f.decimals : 'any'}
        value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'date':
      return <input {...common} type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)} />;
    case 'checkbox':
      return (
        <label className="check">
          <input id={id} aria-describedby={describedBy} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {t('common.yes')}
        </label>
      );
    case 'select':
      return (
        <select {...common} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}
        </select>
      );
    case 'multiselect': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div {...common} className="row wrap" role="group">
          {f.options?.map((o) => (
            <label key={o.value} className="check">
              <input type="checkbox" checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} /> {pick(o.labelEn, o.labelAr)}
            </label>
          ))}
        </div>
      );
    }
    default:
      return <input {...common} type={f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : f.type === 'phone' ? 'tel' : 'text'} maxLength={f.maxLength}
        dir={f.format && f.format !== 'none' ? 'ltr' : undefined} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Saved values, read-only (the server already removed what this reader may not see). */
export function CustomValuesView({ values, sections, empty }: { values: CustomValue[]; sections?: FormDefinition['sections']; empty?: string }) {
  const { lang, pick } = useI18n();
  if (!values.length) return empty ? <p className="muted">{empty}</p> : null;
  const groups = [...new Set(values.map((v) => v.section ?? ''))];
  return (
    <div className="stack-sm">
      {groups.map((g) => {
        const s = sections?.find((x) => x.key === g);
        return (
          <Fragment key={g || '_'}>
            {s && <h4 className="lc-sub">{pick(s.titleEn, s.titleAr)}</h4>}
            <dl className="kv">
              {values.filter((v) => (v.section ?? '') === g).map((v) => (
                <div className="kv-row" key={v.key}>
                  <dt>{pick(v.labelEn, v.labelAr)}</dt>
                  <dd>{lang === 'ar' ? v.displayAr : v.displayEn}</dd>
                </div>
              ))}
            </dl>
          </Fragment>
        );
      })}
    </div>
  );
}
