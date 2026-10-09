import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, CATEGORIES, type Vendor } from '../api';
import { useI18n } from '../i18n';
import { applyTheme } from '../session';
import { Header } from '../components/Layout';
import { Badge, Button, ErrorBox, Field, Spinner, useAsync } from '../components/ui';

export default function Register() {
  const { t, te, pick } = useI18n();
  const tenants = useAsync(() => api.tenants(), []);
  const [tenantId, setTenantId] = useState('');
  const [f, setF] = useState({ legalNameEn: '', legalNameAr: '', crNumber: '', email: '', phone: '', username: '', password: '' });
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<Vendor | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!tenantId && tenants.data?.length) setTenantId(tenants.data[0].id);
  }, [tenants.data, tenantId]);
  const tenant = tenants.data?.find((x) => x.id === tenantId);
  useEffect(() => applyTheme(tenant?.primaryColor), [tenant?.primaryColor]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggle = (c: string) => setCats((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (cats.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const v = await api.registerVendor({ tenantId, ...f, categories: cats });
      setDone(v);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header />
      <main id="main" className="auth-page">
        <div className="auth-card auth-card-wide card">
          <div className="card-body">
            <h1>{t('reg.title')}</h1>
            <p className="muted">{t('reg.subtitle')}</p>
            {done ? (
              <div className="stack">
                <div className="alert alert-success" role="status">
                  <div>
                    <strong>{t('reg.success')}</strong>
                    <div className="small">
                      {pick(done.legalNameEn, done.legalNameAr)} · <Badge value={done.status} label={te('vst.', done.status)} />
                    </div>
                  </div>
                </div>
                <Link className="btn btn-primary" to="/login">
                  {t('reg.toLogin')}
                </Link>
              </div>
            ) : (
              <form onSubmit={submit}>
                {err ? <ErrorBox error={err} /> : null}
                <Field label={t('login.tenant')} required>
                  {(id) =>
                    tenants.loading && !tenants.data ? (
                      <Spinner />
                    ) : tenants.error ? (
                      <ErrorBox error={tenants.error} onRetry={tenants.reload} />
                    ) : (
                      <select id={id} value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
                        {(tenants.data ?? []).map((x) => (
                          <option key={x.id} value={x.id}>
                            {pick(x.nameEn, x.nameAr)}
                          </option>
                        ))}
                      </select>
                    )
                  }
                </Field>
                <fieldset>
                  <legend>{t('reg.company')}</legend>
                  <div className="grid-2">
                    <Field label={t('reg.legalNameEn')} required>
                      {(id) => <input id={id} value={f.legalNameEn} onChange={set('legalNameEn')} required dir="ltr" />}
                    </Field>
                    <Field label={t('reg.legalNameAr')} required>
                      {(id) => <input id={id} value={f.legalNameAr} onChange={set('legalNameAr')} required dir="rtl" lang="ar" />}
                    </Field>
                    <Field label={t('reg.crNumber')} required>
                      {(id) => <input id={id} value={f.crNumber} onChange={set('crNumber')} required dir="ltr" />}
                    </Field>
                    <Field label={t('reg.email')} required>
                      {(id) => <input id={id} type="email" value={f.email} onChange={set('email')} required dir="ltr" autoComplete="email" />}
                    </Field>
                    <Field label={t('reg.phone')} required>
                      {(id) => <input id={id} type="tel" value={f.phone} onChange={set('phone')} required dir="ltr" autoComplete="tel" />}
                    </Field>
                  </div>
                </fieldset>
                <fieldset className={touched && cats.length === 0 ? 'field-invalid' : ''}>
                  <legend>
                    {t('reg.categories')} <span className="req">*</span>
                  </legend>
                  <div className="checks">
                    {CATEGORIES.map((c) => (
                      <label key={c} className="check">
                        <input type="checkbox" checked={cats.includes(c)} onChange={() => toggle(c)} />
                        {te('cat.', c)}
                      </label>
                    ))}
                  </div>
                  {touched && cats.length === 0 && <div className="field-error">{t('reg.categoriesHint')}</div>}
                </fieldset>
                <fieldset>
                  <legend>{t('reg.account')}</legend>
                  <div className="grid-2">
                    <Field label={t('reg.username')} required>
                      {(id) => <input id={id} value={f.username} onChange={set('username')} required dir="ltr" autoComplete="username" />}
                    </Field>
                    <Field label={t('reg.password')} required>
                      {(id) => (
                        <input
                          id={id}
                          type="password"
                          value={f.password}
                          onChange={set('password')}
                          required
                          dir="ltr"
                          autoComplete="new-password"
                        />
                      )}
                    </Field>
                  </div>
                </fieldset>
                <div className="row-end">
                  <Link to="/login" className="btn btn-ghost">
                    {t('common.back')}
                  </Link>
                  <Button type="submit" busy={busy} disabled={!tenantId}>
                    {t('reg.submit')}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
