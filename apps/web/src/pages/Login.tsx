import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Tenant, type User } from '../api';
import { useI18n } from '../i18n';
import { applyTheme, homeFor, useSession } from '../session';
import { Header } from '../components/Layout';
import { Button, ErrorBox, Field, Spinner, useAsync, useToast } from '../components/ui';
import { Enrolment, RecoveryCodes, secApi, VerifyStep, type LoginResult } from '../features/security';

type TenantWithSso = Tenant & { sso?: { labelEn: string; labelAr: string } | null };
type Step = { kind: 'password' } | { kind: 'verify'; mfaToken: string } | { kind: 'enrol'; mfaToken: string } | { kind: 'codes'; codes: string[]; result: LoginResult };

export default function Login() {
  const { t, pick } = useI18n();
  const { signIn, session, expired } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const tenants = useAsync(() => api.tenants() as Promise<TenantWithSso[]>, []);
  // Optional prefill (guided demo switching entity, SSO return): tenant and username only — never a password.
  const [params, setParams] = useSearchParams();
  const [tenantId, setTenantId] = useState(() => (/^[a-z0-9_-]{2,40}$/.test(params.get('tenant') ?? '') ? params.get('tenant')! : ''));
  const [username, setUsername] = useState(() => (/^[a-z0-9._@-]{1,80}$/i.test(params.get('username') ?? '') ? params.get('username')! : ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [ssoBusy, setSsoBusy] = useState(false);
  const handoffDone = useRef(false);

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

  const finish = (res: LoginResult, tn: Tenant | null = tenant) => {
    if (!res.token || !res.user) return;
    const user = res.user as User;
    signIn({ token: res.token, user, tenant: tn });
    if (typeof res.recoveryCodesLeft === 'number' && res.recoveryCodesLeft <= 2) toast(t('security.login.fewCodesLeft', { n: res.recoveryCodesLeft }), 'info');
    navigate(homeFor(user), { replace: true });
  };

  // Return from the entity's Active Directory (OIDC): one-time hand-off → TenderFlow session; or a refusal code.
  const ssoHandoff = params.get('ssoHandoff');
  const ssoError = params.get('ssoError');
  useEffect(() => {
    if (!ssoHandoff || handoffDone.current || !tenants.data) return;
    handoffDone.current = true;
    const tn = tenants.data.find((x) => x.id === params.get('tenant')) ?? null;
    setSsoBusy(true);
    secApi
      .ssoExchange(ssoHandoff)
      .then((r) => finish(r, tn))
      .catch((e) => setErr(e))
      .finally(() => {
        setSsoBusy(false);
        setParams((p) => { p.delete('ssoHandoff'); return p; }, { replace: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssoHandoff, tenants.data]);
  useEffect(() => {
    if (ssoError) setErr(new ApiError(401, ssoError, params.get('ssoMessage') ?? ssoError));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssoError]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await secApi.login(tenantId, username.trim(), password);
      if (res.mfaRequired && res.mfaToken) {
        setPassword('');
        setStep(res.enrolRequired ? { kind: 'enrol', mfaToken: res.mfaToken } : { kind: 'verify', mfaToken: res.mfaToken });
      } else finish(res);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setStep({ kind: 'password' });
  };

  const sso = tenant?.sso ?? null;

  return (
    <>
      <Header />
      <main id="main" className="auth-page">
        <div className={`auth-card card ${step.kind === 'enrol' || step.kind === 'codes' ? 'security-auth-wide' : ''}`}>
          <div className="card-body">
            {step.kind === 'password' && (
              <>
                <h1>{t('login.title')}</h1>
                <p className="muted">{t('login.subtitle')}</p>
                {expired && (
                  <div className="alert alert-info" role="status">
                    {t('err.unauthorized')}
                  </div>
                )}
                {ssoBusy && <Spinner label={t('security.sso.completing')} />}
                {err ? <ErrorBox error={err} /> : null}
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
                  {sso && (
                    <div className="security-sso">
                      <a className="btn btn-secondary btn-block" href={secApi.ssoStartUrl(tenantId)}>
                        {t('security.sso.button', { name: pick(sso.labelEn, sso.labelAr) })}
                      </a>
                      <p className="muted small center">{t('security.sso.staffOnly')}</p>
                      <div className="security-or" aria-hidden="true">
                        <span>{t('security.sso.or')}</span>
                      </div>
                    </div>
                  )}
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
              </>
            )}
            {step.kind === 'verify' && (
              <>
                <h1>{t('security.login.verifyTitle')}</h1>
                <VerifyStep mfaToken={step.mfaToken} onDone={(r) => finish(r)} onRestart={restart} />
              </>
            )}
            {step.kind === 'enrol' && (
              <>
                <h1>{t('security.login.enrolTitle')}</h1>
                <p className="muted">{t('security.login.enrolRequired')}</p>
                <Enrolment
                  start={() => secApi.mfaLoginEnrolStart(step.mfaToken)}
                  confirm={(code) => secApi.mfaLoginEnrolConfirm(step.mfaToken, code)}
                  onConfirmed={(r) => setStep({ kind: 'codes', codes: r.recoveryCodes ?? [], result: r })}
                />
                <Button variant="ghost" onClick={restart}>
                  {t('security.login.startOver')}
                </Button>
              </>
            )}
            {step.kind === 'codes' && (
              <>
                <h1>{t('security.mfa.enrolled')}</h1>
                <RecoveryCodes codes={step.codes} onDone={() => finish(step.result)} />
              </>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
