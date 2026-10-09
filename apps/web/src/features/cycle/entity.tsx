// Entity settings (/admin/entity): profile, numbering patterns, channels, identity provider, activity codes.
import { useEffect, useState, type FormEvent } from 'react';
import { platform, type ActivityCode, type EntityProfile } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { applyTheme } from '../../session';
import { AsyncView, Button, Card, ErrorBox, Field, Spinner, Table, useAsync, useToast } from '../../components/ui';
import { applyPattern } from './common';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function EntitySettingsPage() {
  const { t } = useI18n();
  const profile = useAsync(() => platform.profile(), []);
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('cycle.e.title')}</h1>
          <p className="muted cyc-lead">{t('cycle.e.subtitle')}</p>
        </div>
      </header>
      <AsyncView state={profile}>{(p) => <ProfileForm initial={p} onSaved={profile.setData} />}</AsyncView>
      <ActivityCodes />
    </div>
  );
}

function ProfileForm({ initial, onSaved }: { initial: EntityProfile; onSaved: (p: EntityProfile) => void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [p, setP] = useState<EntityProfile>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setP(initial), [initial]);
  const set = <K extends keyof EntityProfile>(k: K, v: EntityProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const ch = p.channels ?? {};
  const patOk = (s?: string) => !s || /^[A-Za-z0-9_{}-]+$/.test(s);
  const colorOk = /^#[0-9a-fA-F]{6}$/.test(p.primaryColor ?? '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const saved = await platform.saveProfile({
        nameEn: p.nameEn.trim(),
        nameAr: p.nameAr.trim(),
        primaryColor: p.primaryColor,
        sector: p.sector?.trim() || undefined,
        logoText: p.logoText?.trim() || undefined,
        numberingPattern: p.numberingPattern?.trim() || undefined,
        receiptPattern: p.receiptPattern?.trim() || undefined,
        identityProvider: p.identityProvider ?? 'LOCAL',
        channels: { knet: !!ch.knet, gazette: !!ch.gazette, capt: !!ch.capt },
        fiscalYearStartMonth: p.fiscalYearStartMonth,
      });
      applyTheme(saved.primaryColor);
      onSaved(saved);
      toast(t('cycle.e.saved'));
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const monthName = (m: number) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-KW' : 'en-GB', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m - 1, 1)));

  return (
    <form className="stack" onSubmit={submit}>
      {err ? <ErrorBox error={err} /> : null}
      <div className="cyc-config-grid">
        <Card title={t('cycle.e.profile')}>
          <Field label={t('cycle.e.nameEn')} required>
            {(id) => <input id={id} value={p.nameEn} onChange={(e) => set('nameEn', e.target.value)} required dir="ltr" lang="en" />}
          </Field>
          <Field label={t('cycle.e.nameAr')} required>
            {(id) => <input id={id} value={p.nameAr} onChange={(e) => set('nameAr', e.target.value)} required dir="rtl" lang="ar" />}
          </Field>
          <div className="grid-2">
            <Field label={t('cycle.e.sector')}>{(id) => <input id={id} value={p.sector ?? ''} onChange={(e) => set('sector', e.target.value)} />}</Field>
            <Field label={t('cycle.e.logoText')} hint={t('cycle.e.logoTextHint')}>
              {(id, d) => <input id={id} aria-describedby={d} maxLength={12} value={p.logoText ?? ''} onChange={(e) => set('logoText', e.target.value)} dir="ltr" />}
            </Field>
          </div>
          <Field label={t('cycle.e.color')} error={!colorOk ? t('cycle.e.colorInvalid') : undefined}>
            {(id) => (
              <div className="row">
                <input
                  type="color"
                  aria-label={t('cycle.e.color')}
                  value={colorOk ? p.primaryColor : '#0f4c81'}
                  onChange={(e) => set('primaryColor', e.target.value)}
                  className="cyc-color"
                />
                <input id={id} value={p.primaryColor ?? ''} onChange={(e) => set('primaryColor', e.target.value)} dir="ltr" className="cyc-color-text" />
                <span className="cyc-color-chip" style={{ background: colorOk ? p.primaryColor : 'transparent' }} aria-hidden="true" />
              </div>
            )}
          </Field>
        </Card>

        <Card title={t('cycle.e.numbering')}>
          <p className="muted small">{t('cycle.e.patternHint')}</p>
          <Field label={t('cycle.e.tenderPattern')} error={!patOk(p.numberingPattern) ? t('cycle.e.patternInvalid') : undefined}>
            {(id) => <input id={id} value={p.numberingPattern ?? ''} onChange={(e) => set('numberingPattern', e.target.value)} dir="ltr" placeholder="KEA-{YYYY}-{SEQ3}" />}
          </Field>
          <div className="cyc-example">
            {t('cycle.e.example')}: <code dir="ltr">{p.numberingPattern ? applyPattern(p.numberingPattern, 7) : '—'}</code>
          </div>
          <Field label={t('cycle.e.receiptPattern')} error={!patOk(p.receiptPattern) ? t('cycle.e.patternInvalid') : undefined}>
            {(id) => <input id={id} value={p.receiptPattern ?? ''} onChange={(e) => set('receiptPattern', e.target.value)} dir="ltr" placeholder="KEA-R-{YYYY}-{SEQ5}" />}
          </Field>
          <div className="cyc-example">
            {t('cycle.e.example')}: <code dir="ltr">{p.receiptPattern ? applyPattern(p.receiptPattern, 42) : '—'}</code>
          </div>
          <Field label={t('cycle.e.fiscal')}>
            {(id) => (
              <select id={id} value={p.fiscalYearStartMonth ?? ''} onChange={(e) => set('fiscalYearStartMonth', e.target.value === '' ? undefined : Number(e.target.value))}>
                <option value="">{t('common.none')}</option>
                {MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {monthName(m)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </Card>

        <Card title={t('cycle.e.channels')}>
          <p className="muted small">{t('cycle.e.channelsHint')}</p>
          <ul className="cyc-toggles">
            {(['knet', 'gazette', 'capt'] as const).map((k) => (
              <li key={k}>
                <label className="cyc-switch">
                  <input type="checkbox" checked={!!ch[k]} onChange={(e) => set('channels', { ...ch, [k]: e.target.checked })} />
                  <span>
                    <strong>{t(`cycle.e.ch.${k}` as TKey)}</strong>
                    <span className="muted small">{t(`cycle.e.chHint.${k}` as TKey)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t('cycle.e.idp')}>
          <div className="segmented" role="radiogroup" aria-label={t('cycle.e.idp')}>
            {(['LOCAL', 'OIDC'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={(p.identityProvider ?? 'LOCAL') === v}
                className={(p.identityProvider ?? 'LOCAL') === v ? 'on' : ''}
                onClick={() => set('identityProvider', v)}
              >
                {t(`cycle.e.idp.${v}` as TKey)}
              </button>
            ))}
          </div>
          <p className="muted small">{t('cycle.e.idpHint')}</p>
        </Card>
      </div>
      <div className="row-end">
        <Button type="submit" busy={busy} disabled={!colorOk || !patOk(p.numberingPattern) || !patOk(p.receiptPattern)}>
          {t('cycle.e.save')}
        </Button>
      </div>
    </form>
  );
}

function ActivityCodes() {
  const { t } = useI18n();
  const toast = useToast();
  const list = useAsync(() => platform.activityCodes(), []);
  const [edit, setEdit] = useState<ActivityCode>({ code: '', nameEn: '', nameAr: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await platform.saveActivityCode({ code: edit.code.trim(), nameEn: edit.nameEn.trim(), nameAr: edit.nameAr.trim() });
      toast(t('cycle.e.codeSaved'));
      setEdit({ code: '', nameEn: '', nameAr: '' });
      setEditing(false);
      list.reload();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('cycle.activityCodes')}>
      <p className="muted small">{t('cycle.e.codesHint')}</p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <AsyncView state={list} empty={t('cycle.e.noCodes')}>
          {(xs) => (
            <Table head={[t('cycle.e.code'), t('cycle.e.codeNameEn'), t('cycle.e.codeNameAr'), t('common.actions')]}>
              {xs.map((a) => (
                <tr key={a.code}>
                  <td dir="ltr">
                    <code>{a.code}</code>
                  </td>
                  <td dir="ltr">{a.nameEn}</td>
                  <td dir="rtl">{a.nameAr}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEdit(a);
                        setEditing(true);
                      }}
                    >
                      {t('cycle.e.edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      )}
      <form className="inline-form" onSubmit={submit}>
        <h3>{editing ? t('cycle.e.editCode', { code: edit.code }) : t('cycle.e.addCode')}</h3>
        {err ? <ErrorBox error={err} /> : null}
        <div className="cyc-code-grid">
          <Field label={t('cycle.e.code')} required>
            {(id) => <input id={id} value={edit.code} readOnly={editing} onChange={(e) => setEdit({ ...edit, code: e.target.value })} required dir="ltr" placeholder="IT-03" />}
          </Field>
          <Field label={t('cycle.e.codeNameEn')} required>
            {(id) => <input id={id} value={edit.nameEn} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} required dir="ltr" />}
          </Field>
          <Field label={t('cycle.e.codeNameAr')} required>
            {(id) => <input id={id} value={edit.nameAr} onChange={(e) => setEdit({ ...edit, nameAr: e.target.value })} required dir="rtl" />}
          </Field>
        </div>
        <div className="row">
          <Button type="submit" busy={busy} disabled={!edit.code.trim() || !edit.nameEn.trim() || !edit.nameAr.trim()}>
            {t('common.save')}
          </Button>
          {editing && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setEdit({ code: '', nameEn: '', nameAr: '' });
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
