// SEC admin page /admin/identity: second-factor policy, content protection, staff network allowlist ("premises
// restriction", SEC-003) and staff single sign-on with the entity's Active Directory (OIDC). The client secret is
// never shown or stored — only the NAME of the server environment variable that holds it.
import { useEffect, useState } from 'react';
import { ApiError, type Role } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Modal, useAsync, useToast } from '../../components/ui';
import {
  CONTENT_MODES, MFA_POLICIES, NETWORK_BASES, secApi,
  type ContentMode, type MfaPolicy, type NetworkStatus, type OidcConfig, type SecuritySettings, type SsoTest, type StaffNetwork,
} from './api';

const STAFF_ROLES: Role[] = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'EVALUATOR', 'TENANT_ADMIN', 'AUDITOR'];

export function AdminIdentityPage() {
  const { t } = useI18n();
  const settings = useAsync(() => secApi.settings(), []);
  return (
    <div className="stack security-page">
      <header className="page-head">
        <h1>{t('security.admin.title')}</h1>
      </header>
      <p className="muted">{t('security.admin.intro')}</p>
      <AsyncView state={settings}>
        {(s) => (
          <>
            {s.breakGlass && (
              <div className="alert alert-warn" role="status">
                {t('security.network.breakGlass')}
              </div>
            )}
            <PoliciesCard s={s} onSaved={settings.setData} />
            <NetworkCard s={s} onSaved={settings.setData} />
            <SsoCard s={s} onSaved={settings.setData} />
          </>
        )}
      </AsyncView>
    </div>
  );
}

function useSaver(onSaved: (s: SecuritySettings) => void) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async (body: Parameters<typeof secApi.saveSettings>[0]) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await secApi.saveSettings(body);
      onSaved(r);
      toast(r.changed && r.changed.length === 0 ? t('security.admin.noChange') : t('security.admin.saved'));
      return r;
    } catch (e) {
      setErr(e);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, save, setErr };
}

// ---------------------------------------------------------------- MFA policy + content protection

function PoliciesCard({ s, onSaved }: { s: SecuritySettings; onSaved: (s: SecuritySettings) => void }) {
  const { t, te } = useI18n();
  const [mfaVendors, setMfaVendors] = useState<MfaPolicy>(s.mfaVendors);
  const [mfaStaff, setMfaStaff] = useState<MfaPolicy>(s.mfaStaff);
  const [content, setContent] = useState<ContentMode | ''>(s.contentProtection ?? '');
  const { busy, err, save } = useSaver(onSaved);
  const dirty = mfaVendors !== s.mfaVendors || mfaStaff !== s.mfaStaff || (content || null) !== s.contentProtection;
  return (
    <Card title={t('security.admin.policies')}>
      <div className="stack">
        {err ? <ErrorBox error={err} /> : null}
        <div className="grid-2">
          <Field label={t('security.admin.mfaVendors')} hint={te('security.policyHint.', mfaVendors)}>
            {(id) => (
              <select id={id} value={mfaVendors} onChange={(e) => setMfaVendors(e.target.value as MfaPolicy)}>
                {MFA_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {te('security.policy.', p)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('security.admin.mfaStaff')} hint={te('security.policyHint.', mfaStaff)}>
            {(id) => (
              <select id={id} value={mfaStaff} onChange={(e) => setMfaStaff(e.target.value as MfaPolicy)}>
                {MFA_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {te('security.policy.', p)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('security.admin.contentProtection')} hint={content ? te('security.contentHint.', content) : t('security.contentHint.UNSET')}>
          {(id) => (
            <select id={id} value={content} onChange={(e) => setContent(e.target.value as ContentMode | '')}>
              <option value="">{t('security.content.UNSET')}</option>
              {CONTENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {te('security.content.', m)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <p className="muted small">{t('security.admin.contentPrecedence')}</p>
        <div className="row-end">
          <Button busy={busy} disabled={!dirty} onClick={() => save({ mfaVendors, mfaStaff, contentProtection: content || null }).catch(() => undefined)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- staff network allowlist

function NetworkCard({ s, onSaved }: { s: SecuritySettings; onSaved: (s: SecuritySettings) => void }) {
  const { t, te } = useI18n();
  const [mode, setMode] = useState(s.staffNetwork.mode);
  const [cidrs, setCidrs] = useState(s.staffNetwork.cidrs.join('\n'));
  const [basis, setBasis] = useState(s.staffNetwork.basis);
  const [trust, setTrust] = useState(s.staffNetwork.trustProxyHeader);
  const [who, setWho] = useState<NetworkStatus | null>(null);
  const [whoErr, setWhoErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const { busy, err, save, setErr } = useSaver(onSaved);
  const candidate = (): StaffNetwork => ({ mode, cidrs: cidrs.split(/[\s,;]+/).filter(Boolean), basis, trustProxyHeader: trust });

  const check = async () => {
    setWhoErr(null);
    try {
      const c = candidate();
      // "Would I be inside?" — evaluate the typed list as an allowlist even while the mode is still OFF.
      setWho(await secApi.checkNetwork({ ...c, mode: c.cidrs.length ? 'ALLOWLIST' : 'OFF' }));
    } catch (e) {
      setWhoErr(e);
    }
  };
  useEffect(() => {
    secApi.whoami().then(setWho).catch(setWhoErr);
  }, [s.updatedAt]);

  const doSave = async (confirmSelfLockout = false) => {
    try {
      await save({ staffNetwork: candidate(), confirmSelfLockout });
      setConfirm(null);
      secApi.whoami().then(setWho).catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SELF_LOCKOUT') {
        setErr(null);
        setConfirm(e.message);
      }
    }
  };
  const addMine = () => who && setCidrs((c) => (c.trim() ? `${c.trim()}\n${who.ip}` : who.ip));

  return (
    <Card title={t('security.network.title')}>
      <div className="stack">
        <p className="muted">{t('security.network.intro')}</p>
        {err ? <ErrorBox error={err} /> : null}
        <div className="security-whoami" aria-live="polite">
          {whoErr ? (
            <ErrorBox error={whoErr} />
          ) : who ? (
            <dl className="kv">
              <dt>{t('security.network.yourIp')}</dt>
              <dd>
                <code dir="ltr">{who.ip}</code>{' '}
                {who.mode === 'ALLOWLIST' || who.insideList ? (
                  <Badge label={who.insideList ? t('security.network.inside') : t('security.network.outside')} tone={who.insideList ? 'success' : 'danger'} />
                ) : (
                  <Badge label={t('security.network.notEnforced')} tone="neutral" />
                )}
              </dd>
              <dt>{t('security.network.seenAs')}</dt>
              <dd className="small" dir="ltr">
                socket {who.socketAddress ?? '—'} · X-Forwarded-For {who.forwardedFor ?? '—'}
              </dd>
            </dl>
          ) : null}
        </div>
        <div className="grid-2">
          <Field label={t('security.network.mode')}>
            {(id) => (
              <select id={id} value={mode} onChange={(e) => setMode(e.target.value as StaffNetwork['mode'])}>
                <option value="OFF">{t('security.network.modeOFF')}</option>
                <option value="ALLOWLIST">{t('security.network.modeALLOWLIST')}</option>
              </select>
            )}
          </Field>
          <Field label={t('security.network.basis')} hint={t('security.network.basisHint')}>
            {(id) => (
              <select id={id} value={basis} onChange={(e) => setBasis(e.target.value as StaffNetwork['basis'])}>
                {NETWORK_BASES.map((b) => (
                  <option key={b} value={b}>
                    {te('security.basis.', b)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field label={t('security.network.cidrs')} hint={t('security.network.cidrsHint')}>
          {(id, d) => (
            <textarea id={id} aria-describedby={d} rows={5} dir="ltr" value={cidrs} onChange={(e) => setCidrs(e.target.value)} spellCheck={false} />
          )}
        </Field>
        <label className="row security-check">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} />
          <span>{t('security.network.trustProxy')}</span>
        </label>
        <p className="muted small">{t('security.network.trustProxyHint')}</p>
        <div className="row wrap row-end">
          <Button variant="ghost" onClick={addMine} disabled={!who}>
            {t('security.network.addMine')}
          </Button>
          <Button variant="secondary" onClick={check}>
            {t('security.network.check')}
          </Button>
          <Button busy={busy} onClick={() => doSave(false)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t('security.network.lockoutTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => doSave(true)}>
              {t('security.network.lockoutConfirm')}
            </Button>
          </>
        }
      >
        <p>{t('security.network.lockoutBody', { ip: who?.ip ?? '?' })}</p>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- staff single sign-on (OIDC)

const EMPTY_OIDC: OidcConfig = {
  enabled: false, displayNameEn: 'Active Directory', displayNameAr: 'الدليل النشط', issuer: '', clientId: '', clientSecretEnv: '',
  scopes: 'openid profile email', groupsClaim: 'groups', usernameClaim: 'preferred_username', mappings: [], provisioning: 'ADMIN_CREATED',
};

function SsoCard({ s, onSaved }: { s: SecuritySettings; onSaved: (s: SecuritySettings) => void }) {
  const { t, te } = useI18n();
  const [o, setO] = useState<OidcConfig>(() => ({ ...EMPTY_OIDC, ...(s.oidc ?? {}) }));
  const [test, setTest] = useState<SsoTest | null>(null);
  const [testErr, setTestErr] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const { busy, err, save } = useSaver(onSaved);
  const set = <K extends keyof OidcConfig>(k: K, v: OidcConfig[K]) => setO((x) => ({ ...x, [k]: v }));
  const setMap = (i: number, m: Partial<OidcConfig['mappings'][number]>) =>
    setO((x) => ({ ...x, mappings: x.mappings.map((r, j) => (j === i ? { ...r, ...m } : r)) }));
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setTestErr(null);
    try {
      setTest(await secApi.ssoTest());
    } catch (e) {
      setTestErr(e);
    } finally {
      setTesting(false);
    }
  };
  const payload = () => {
    const { clientSecretConfigured: _c, ...rest } = o;
    return { ...rest, mappings: o.mappings.filter((m) => m.group.trim()) };
  };
  return (
    <Card title={t('security.sso.title')}>
      <div className="stack">
        <p className="muted">{t('security.sso.intro')}</p>
        {err ? <ErrorBox error={err} /> : null}
        <dl className="kv small">
          <dt>{t('security.sso.redirectUri')}</dt>
          <dd>
            <code dir="ltr">{s.sso?.redirectUri ?? '—'}</code>
          </dd>
          <dt>{t('security.sso.secretStatus')}</dt>
          <dd>
            {s.oidc ? (
              <Badge label={s.oidc.clientSecretConfigured ? t('security.sso.secretSet') : t('security.sso.secretMissing')} tone={s.oidc.clientSecretConfigured ? 'success' : 'warn'} />
            ) : (
              '—'
            )}
          </dd>
        </dl>
        <label className="row security-check">
          <input type="checkbox" checked={o.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          <span>{t('security.sso.enabled')}</span>
        </label>
        <div className="grid-2">
          <Field label={t('security.sso.labelEn')}>{(id) => <input id={id} value={o.displayNameEn} onChange={(e) => set('displayNameEn', e.target.value)} dir="ltr" />}</Field>
          <Field label={t('security.sso.labelAr')}>{(id) => <input id={id} value={o.displayNameAr} onChange={(e) => set('displayNameAr', e.target.value)} dir="rtl" />}</Field>
        </div>
        <Field label={t('security.sso.issuer')} hint={t('security.sso.issuerHint')} required>
          {(id, d) => <input id={id} aria-describedby={d} value={o.issuer} onChange={(e) => set('issuer', e.target.value)} dir="ltr" placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" />}
        </Field>
        <div className="grid-2">
          <Field label={t('security.sso.clientId')} required>{(id) => <input id={id} value={o.clientId} onChange={(e) => set('clientId', e.target.value)} dir="ltr" />}</Field>
          <Field label={t('security.sso.secretEnv')} hint={t('security.sso.secretEnvHint')}>
            {(id, d) => <input id={id} aria-describedby={d} value={o.clientSecretEnv} onChange={(e) => set('clientSecretEnv', e.target.value.toUpperCase())} dir="ltr" placeholder="TF_OIDC_SECRET_MOI" />}
          </Field>
          <Field label={t('security.sso.scopes')}>{(id) => <input id={id} value={o.scopes} onChange={(e) => set('scopes', e.target.value)} dir="ltr" />}</Field>
          <Field label={t('security.sso.groupsClaim')} hint={t('security.sso.groupsClaimHint')}>
            {(id, d) => <input id={id} aria-describedby={d} value={o.groupsClaim} onChange={(e) => set('groupsClaim', e.target.value)} dir="ltr" />}
          </Field>
          <Field label={t('security.sso.usernameClaim')}>{(id) => <input id={id} value={o.usernameClaim} onChange={(e) => set('usernameClaim', e.target.value)} dir="ltr" />}</Field>
          <Field label={t('security.sso.provisioning')} hint={te('security.provHint.', o.provisioning)}>
            {(id) => (
              <select id={id} value={o.provisioning} onChange={(e) => set('provisioning', e.target.value as OidcConfig['provisioning'])}>
                <option value="ADMIN_CREATED">{t('security.prov.ADMIN_CREATED')}</option>
                <option value="JIT_FROM_GROUPS">{t('security.prov.JIT_FROM_GROUPS')}</option>
              </select>
            )}
          </Field>
        </div>
        <fieldset className="security-mappings">
          <legend>{t('security.sso.mappings')}</legend>
          <p className="muted small">{t('security.sso.mappingsHint')}</p>
          {o.mappings.length === 0 && <p className="muted small">{t('security.sso.noMappings')}</p>}
          {o.mappings.map((m, i) => (
            <div key={i} className="security-map-row">
              <Field label={t('security.sso.group')}>
                {(id) => <input id={id} value={m.group} onChange={(e) => setMap(i, { group: e.target.value })} dir="ltr" placeholder="MOI-Tender-Officers / 3f2a…" />}
              </Field>
              <div className="security-role-checks" role="group" aria-label={t('security.sso.roles')}>
                {STAFF_ROLES.map((r) => (
                  <label key={r} className="row security-check">
                    <input
                      type="checkbox"
                      checked={m.roles.includes(r)}
                      onChange={(e) => setMap(i, { roles: e.target.checked ? [...m.roles, r] : m.roles.filter((x) => x !== r) })}
                    />
                    <span>{te('role.', r)}</span>
                  </label>
                ))}
              </div>
              <Button variant="ghost" onClick={() => setO((x) => ({ ...x, mappings: x.mappings.filter((_, j) => j !== i) }))}>
                {t('security.sso.removeRow')}
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setO((x) => ({ ...x, mappings: [...x.mappings, { group: '', roles: [] }] }))}>
            {t('security.sso.addRow')}
          </Button>
        </fieldset>
        {testErr ? <ErrorBox error={testErr} /> : null}
        {test && (
          <div className={`alert ${test.issuerMatches ? 'alert-success' : 'alert-warn'}`} role="status">
            <div>
              <strong>{test.issuerMatches ? t('security.sso.testOk') : t('security.sso.testIssuerMismatch')}</strong>
              <div className="small" dir="ltr">
                {test.issuer} · {test.authorizationEndpoint}
              </div>
              {!test.clientSecretConfigured && <div className="small">{t('security.sso.secretMissing')}</div>}
            </div>
          </div>
        )}
        <div className="row wrap row-end">
          <Button variant="secondary" busy={testing} onClick={runTest} disabled={!s.oidc}>
            {t('security.sso.test')}
          </Button>
          {s.oidc && (
            <Button variant="ghost" onClick={() => save({ oidc: null }).then((r) => setO({ ...EMPTY_OIDC, ...(r.oidc ?? {}) })).catch(() => undefined)}>
              {t('security.sso.remove')}
            </Button>
          )}
          <Button busy={busy} disabled={!o.issuer || !o.clientId} onClick={() => save({ oidc: payload() }).catch(() => undefined)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}
