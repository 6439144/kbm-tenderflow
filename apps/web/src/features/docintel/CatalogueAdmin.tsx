// Admin page /admin/document-types (TENANT_ADMIN): the entity's document-type catalogue (types, upload contexts,
// fields with EN/AR labels, required, active) and the entity setting for automatic classification of vendor uploads.
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { platform } from '../../api-platform';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Modal, Table, useAsync, useToast } from '../../components/ui';
import { CONTEXTS, docintelApi, FIELD_TYPES, type DocTypeDef, type FieldType } from './api';
import { OrchestrateIcon } from './common';

type Draft = Omit<DocTypeDef, 'id' | 'updatedAt'> & { id?: string };
const EMPTY: Draft = { code: '', nameEn: '', nameAr: '', contexts: ['VENDOR'], active: true, fields: [] };

export function DocumentTypesPage() {
  const { t, pick } = useI18n();
  const types = useAsync(() => docintelApi.types(true), []);
  const [edit, setEdit] = useState<Draft | null>(null);
  return (
    <div className="stack di-admin">
      <div className="page-head">
        <h1 className="di-title"><OrchestrateIcon />{t('docintel.admin.title')}</h1>
        <Button onClick={() => setEdit({ ...EMPTY, fields: [] })}>{t('docintel.admin.new')}</Button>
      </div>
      <p className="muted">{t('docintel.admin.lead')}</p>
      <AutoSetting />
      <Card>
        <AsyncView state={types}>
          {(list) => (
            <Table head={[t('docintel.admin.code'), t('common.title'), t('docintel.admin.contexts'), t('docintel.admin.fields'), t('common.status'), t('common.actions')]}>
              {list.map((x) => (
                <tr key={x.id} className={x.active ? undefined : 'di-inactive'}>
                  <td><code dir="ltr">{x.code}</code></td>
                  <td>
                    <div>{pick(x.nameEn, x.nameAr)}</div>
                    <div className="small muted" dir="auto">{pick(x.nameAr, x.nameEn)}</div>
                  </td>
                  <td>
                    <span className="di-ctxs">{x.contexts.map((c) => <span key={c} className="di-ctx">{t(`dic.${c}` as TKey)}</span>)}</span>
                  </td>
                  <td className="small">
                    {x.fields.length ? x.fields.map((f) => `${pick(f.labelEn, f.labelAr)}${f.required ? '*' : ''}`).join(' · ') : <span className="muted">{t('docintel.admin.noFields')}</span>}
                  </td>
                  <td><Badge tone={x.active ? 'success' : 'neutral'} label={t(x.active ? 'docintel.admin.active' : 'docintel.admin.inactive')} /></td>
                  <td><Button variant="ghost" onClick={() => setEdit({ ...x, fields: x.fields.map((f) => ({ ...f })) })}>{t('docintel.admin.edit')}</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
      {edit && <TypeEditor initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); types.reload(); }} />}
    </div>
  );
}

function AutoSetting() {
  const { t } = useI18n();
  const toast = useToast();
  const profile = useAsync(() => platform.profile(), []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const p = profile.data as (typeof profile.data & { documentIntelligenceAuto?: boolean }) | undefined;
  const toggle = async (on: boolean) => {
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      profile.setData(await platform.saveProfile({ ...p, documentIntelligenceAuto: on } as never));
      toast(t('docintel.admin.autoSaved'));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      {err ? <ErrorBox error={err} /> : null}
      <label className="check di-auto">
        <input type="checkbox" disabled={!p || busy} checked={!!p?.documentIntelligenceAuto} onChange={(e) => void toggle(e.target.checked)} />
        <span>{t('docintel.admin.auto')}</span>
      </label>
      <p className="small muted">{t('docintel.admin.autoHint')}</p>
    </Card>
  );
}

function TypeEditor({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setD(initial), [initial]);
  const isNew = !initial.id;
  const isOther = d.code === 'OTHER';
  const setField = (i: number, patch: Partial<Draft['fields'][number]>) => setD((x) => ({ ...x, fields: x.fields.map((f, n) => (n === i ? { ...f, ...patch } : f)) }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = { nameEn: d.nameEn, nameAr: d.nameAr, contexts: d.contexts, fields: d.fields, active: d.active };
      if (isNew) await docintelApi.createType({ ...body, code: d.code.trim().toUpperCase() });
      else await docintelApi.patchType(initial.id!, body);
      toast(t('docintel.admin.saved'));
      onSaved();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open wide onClose={onClose} title={isNew ? t('docintel.admin.new') : `${t('docintel.admin.edit')} — ${initial.code}`}>
      <form className="stack di-editor" onSubmit={save}>
        {err ? <ErrorBox error={err} /> : null}
        <div className="grid-2">
          <Field label={t('docintel.admin.code')} required>
            {(id) => <input id={id} dir="ltr" value={d.code} disabled={!isNew} required pattern="[A-Za-z][A-Za-z0-9_]{1,59}" onChange={(e) => setD({ ...d, code: e.target.value.toUpperCase() })} />}
          </Field>
          <label className="check di-active">
            <input type="checkbox" checked={d.active} disabled={isOther} onChange={(e) => setD({ ...d, active: e.target.checked })} />
            <span>{t('docintel.admin.active')}</span>
          </label>
          <Field label={t('docintel.admin.nameEn')} required>{(id) => <input id={id} dir="ltr" value={d.nameEn} required onChange={(e) => setD({ ...d, nameEn: e.target.value })} />}</Field>
          <Field label={t('docintel.admin.nameAr')} required>{(id) => <input id={id} dir="rtl" value={d.nameAr} required onChange={(e) => setD({ ...d, nameAr: e.target.value })} />}</Field>
        </div>
        <fieldset className="di-fieldset">
          <legend>{t('docintel.admin.contexts')}</legend>
          <div className="checks">
            {CONTEXTS.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={d.contexts.includes(c)}
                  onChange={(e) => setD({ ...d, contexts: e.target.checked ? [...d.contexts, c] : d.contexts.filter((x) => x !== c) })} />
                <span>{t(`dic.${c}` as TKey)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {!isOther && (
          <fieldset className="di-fieldset">
            <legend>{t('docintel.admin.fields')}</legend>
            {d.fields.map((f, i) => (
              <div key={i} className="di-field-row">
                <Field label={t('docintel.admin.key')}>{(id) => <input id={id} dir="ltr" value={f.key} required pattern="[a-z][A-Za-z0-9]{0,59}" onChange={(e) => setField(i, { key: e.target.value })} />}</Field>
                <Field label={t('docintel.admin.labelEn')}>{(id) => <input id={id} dir="ltr" value={f.labelEn} required onChange={(e) => setField(i, { labelEn: e.target.value })} />}</Field>
                <Field label={t('docintel.admin.labelAr')}>{(id) => <input id={id} dir="rtl" value={f.labelAr} required onChange={(e) => setField(i, { labelAr: e.target.value })} />}</Field>
                <Field label={t('docintel.admin.type')}>
                  {(id) => (
                    <select id={id} value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldType })}>
                      {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{t(`dift.${ft}` as TKey)}</option>)}
                    </select>
                  )}
                </Field>
                <label className="check">
                  <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                  <span>{t('docintel.admin.required')}</span>
                </label>
                <Button variant="ghost" onClick={() => setD({ ...d, fields: d.fields.filter((_, n) => n !== i) })}>{t('docintel.admin.remove')}</Button>
              </div>
            ))}
            <Button variant="secondary" onClick={() => setD({ ...d, fields: [...d.fields, { key: '', labelEn: '', labelAr: '', type: 'text', required: false }] })}>
              {t('docintel.admin.addField')}
            </Button>
          </fieldset>
        )}
        <div className="row">
          <Button type="submit" busy={busy} disabled={!d.contexts.length}>{t('docintel.admin.save')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('docintel.cancel')}</Button>
        </div>
      </form>
    </Modal>
  );
}
