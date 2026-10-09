import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useI18n } from '../i18n';
import { applyTheme, homeFor, useSession } from '../session';
import { Header } from '../components/Layout';
import { Button, ErrorBox, Field, Spinner, useAsync } from '../components/ui';
import { isSuspendedError, SuspendedNotice } from '../features/moi';

export default function Login() {
  const { t, pick } = useI18n();
  const { signIn, session, expired } = useSession();
  const navigate = useNavigate();
  const tenants = useAsync(() => api.tenants(), []);
  // Optional prefill (guided demo switching entity): tenant and username only — never a password.
  const [params] = useSearchParams();
  const [tenantId, setTenantId] = useState(() => (/^[a-z0-9_-]{2,40}$/.test(params.get('tenant') ?? '') ? params.get('tenant')! : ''));
  const [username, setUsername] = useState(() => (/^[a-z0-9._@-]{1,80}$/i.test(params.get('username') ?? '') ? params.get('username')! : ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    if (session) navigate(homeFor(session.user), { replace: true });
  }, [session, navigate]);

  useEffect(() => {
    if (tenants.data && tenants.data.length > 0 && (!tenantId || !tenants.data.some((x) => x.id === tenantId))) setTenantId(tenants.data[0].id);
  }, [tenants.data, tenantId]);

  const tenant = tenants.data?.find((x) => x.id === tenantId) ?? null;
  useEffect(() => {
    applyTheme(tenant?.primaryColor);
  }, [tenant?.primaryColor]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.login(tenantId, username.trim(), password);
      signIn({ token: res.token, user: res.user, tenant });
      navigate(homeFor(res.user), { replace: true });
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
        <div className="auth-card card">
          <div className="card-body">
            <h1>{t('login.title')}</h1>
            <p className="muted">{t('login.subtitle')}</p>
            {expired && (
              <div className="alert alert-info" role="status">
                {t('err.unauthorized')}
              </div>
            )}
            {err ? isSuspendedError(err) ? <SuspendedNotice error={err} /> : <ErrorBox error={err} /> : null}
            <form onSubmit={submit} noValidate={false}>
              <Field label={t('login.tenant')} required>
                {(id) =>
                  tenants.loading && !tenants.data ? (
                    <Spinner />
                  ) : tenants.error ? (
                    <ErrorBox error={tenants.error} onRetry={tenants.reload} />
                  ) : tenants.data && tenants.data.length === 0 ? (
                    <p className="muted">{t('login.noTenants')}</p>
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
              <Field label={t('login.username')} required>
                {(id) => (
                  <input id={id} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required dir="ltr" />
                )}
              </Field>
              <Field label={t('login.password')} required>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    dir="ltr"
                  />
                )}
              </Field>
              <Button type="submit" busy={busy} disabled={!tenantId || !username || !password} className="btn-block">
                {t('login.submit')}
              </Button>
            </form>
            <p className="center">
              <Link to="/register">{t('login.registerLink')}</Link>
            </p>
            <p className="demo-hint small muted" dir="auto">
              {t('login.demoHint')}
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
