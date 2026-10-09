// SEC: TOTP second factor UI — enrolment (scan → confirm → recovery codes shown once), the sign-in code step, and
// the "Two-step verification" page every user reaches from their portal.
import { useState, type FormEvent } from 'react';
import type { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, useAsync, useToast } from '../../components/ui';
import { secApi, type EnrolStart, type LoginResult } from './api';

const cleanCode = (s: string) => s.replace(/\D/g, '').slice(0, 6);

/** 6-digit code input (one-time-code autocomplete, numeric keypad on phones, LTR digits in Arabic too). */
export function CodeInput({ value, onChange, label, autoFocus }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  return (
    <Field label={label} required>
      {(id) => (
        <input
          id={id}
          className="security-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={value}
          onChange={(e) => onChange(cleanCode(e.target.value))}
          required
          dir="ltr"
          autoFocus={autoFocus}
        />
      )}
    </Field>
  );
}

/** Recovery codes, shown exactly once after enrolment. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast(t('security.mfa.codesCopied'));
    } catch {
      toast(t('security.mfa.copyFailed'), 'error');
    }
  };
  return (
    <div className="stack security-recovery">
      <div className="alert alert-warn" role="status">
        <div>
          <strong>{t('security.mfa.codesTitle')}</strong>
          <div className="small">{t('security.mfa.codesHint')}</div>
        </div>
      </div>
      <ol className="security-codes" dir="ltr" aria-label={t('security.mfa.codesTitle')}>
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="row wrap">
        <Button variant="secondary" onClick={copy}>
          {t('security.mfa.copyCodes')}
        </Button>
      </div>
      <label className="row security-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t('security.mfa.codesSaved')}</span>
      </label>
      <Button disabled={!saved} onClick={onDone} className="btn-block">
        {t('security.mfa.continue')}
      </Button>
    </div>
  );
}

/**
 * Enrolment: shows the QR code / manual key from `start`, asks for the current code and calls `confirm`.
 * The parent receives the recovery codes (and, during sign-in, the session).
 */
export function Enrolment<R extends { recoveryCodes?: string[] }>({
  start,
  confirm,
  onConfirmed,
}: {
  start: () => Promise<EnrolStart>;
  confirm: (code: string) => Promise<R>;
  onConfirmed: (r: R) => void;
}) {
  const { t } = useI18n();
  const setup = useAsync(start, []);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [showKey, setShowKey] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onConfirmed(await confirm(code));
    } catch (e2) {
      setErr(e2);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <AsyncView state={setup}>
      {(s) => (
        <form className="stack security-enrol" onSubmit={submit}>
          <ol className="security-steps">
            <li>{t('security.mfa.step1')}</li>
            <li>{t('security.mfa.step2')}</li>
            <li>{t('security.mfa.step3')}</li>
          </ol>
          <div className="security-qr-row">
            <img className="security-qr" src={s.qrDataUrl} alt={t('security.mfa.qrAlt')} width={200} height={200} />
            <div className="stack-sm">
              <Button variant="ghost" onClick={() => setShowKey((x) => !x)} aria-expanded={showKey}>
                {t('security.mfa.cantScan')}
              </Button>
              {showKey && (
                <dl className="kv small">
                  <dt>{t('security.mfa.manualKey')}</dt>
                  <dd>
                    <code dir="ltr" className="security-key">
                      {s.manualKey}
                    </code>
                  </dd>
                  <dt>{t('security.mfa.params')}</dt>
                  <dd dir="ltr">
                    TOTP · {s.algorithm} · {s.digits} · {s.periodSeconds}s
                  </dd>
                </dl>
              )}
            </div>
          </div>
          {err ? <ErrorBox error={err} /> : null}
          <CodeInput value={code} onChange={setCode} label={t('security.mfa.enterCode')} />
          <Button type="submit" busy={busy} disabled={code.length !== 6}>
            {t('security.mfa.activate')}
          </Button>
        </form>
      )}
    </AsyncView>
  );
}

/** Sign-in step 2: TOTP code, or a one-time recovery code. */
export function VerifyStep({ mfaToken, onDone, onRestart }: { mfaToken: string; onDone: (r: LoginResult) => void; onRestart: () => void }) {
  const { t } = useI18n();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [rc, setRc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      onDone(await secApi.mfaVerify(mfaToken, useRecovery ? { recoveryCode: rc.trim() } : { code }));
    } catch (e2) {
      setErr(e2);
      setCode('');
      if ((e2 as ApiError)?.code === 'MFA_TOKEN_INVALID') onRestart();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <p className="muted">{useRecovery ? t('security.login.recoveryHint') : t('security.login.codeHint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      {useRecovery ? (
        <Field label={t('security.login.recoveryCode')} required>
          {(id) => <input id={id} value={rc} onChange={(e) => setRc(e.target.value)} dir="ltr" autoComplete="off" required autoFocus />}
        </Field>
      ) : (
        <CodeInput value={code} onChange={setCode} label={t('security.login.code')} autoFocus />
      )}
      <Button type="submit" busy={busy} disabled={useRecovery ? rc.trim().length < 10 : code.length !== 6} className="btn-block">
        {t('security.login.verify')}
      </Button>
      <div className="row spread wrap">
        <Button variant="ghost" onClick={() => { setUseRecovery((x) => !x); setErr(null); }}>
          {useRecovery ? t('security.login.useApp') : t('security.login.useRecovery')}
        </Button>
        <Button variant="ghost" onClick={onRestart}>
          {t('security.login.startOver')}
        </Button>
      </div>
    </form>
  );
}

/** "Two-step verification" page (vendor, procurement and admin portals). */
export function MyMfaPage() {
  const { t, te, fmtDate } = useI18n();
  const toast = useToast();
  const status = useAsync(() => secApi.mfaMe(), []);
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await secApi.mfaDisable(disableCode);
      toast(t('security.mfa.disabled'));
      setDisableCode('');
      status.reload();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack security-page">
      <header className="page-head">
        <h1>{t('security.mfa.title')}</h1>
      </header>
      <Card>
        <AsyncView state={status}>
          {(s) => (
            <div className="stack">
              <p className="muted">{t('security.mfa.intro')}</p>
              <dl className="kv">
                <dt>{t('security.mfa.policy')}</dt>
                <dd>
                  <Badge label={te('security.policy.', s.policy)} tone={s.policy === 'REQUIRED' ? 'warn' : s.policy === 'OPTIONAL' ? 'info' : 'neutral'} />
                </dd>
                <dt>{t('common.status')}</dt>
                <dd>
                  <Badge label={te('security.mfaState.', s.status)} tone={s.status === 'ACTIVE' ? 'success' : 'neutral'} />
                </dd>
                {s.enrolledAt && (
                  <>
                    <dt>{t('security.mfa.enrolledAt')}</dt>
                    <dd>{fmtDate(s.enrolledAt)}</dd>
                    <dt>{t('security.mfa.codesLeft')}</dt>
                    <dd>{s.recoveryCodesLeft}</dd>
                  </>
                )}
                {s.lockedUntil && (
                  <>
                    <dt>{t('security.mfa.lockedUntil')}</dt>
                    <dd>{fmtDate(s.lockedUntil)}</dd>
                  </>
                )}
              </dl>
              {codes ? (
                <RecoveryCodes codes={codes} onDone={() => { setCodes(null); status.reload(); }} />
              ) : s.policy === 'OFF' ? (
                <div className="alert alert-info" role="status">{t('security.mfa.offForYou')}</div>
              ) : s.status !== 'ACTIVE' ? (
                enrolling ? (
                  <Enrolment
                    start={secApi.mfaEnrolStart}
                    confirm={secApi.mfaEnrolConfirm}
                    onConfirmed={(r) => { setEnrolling(false); setCodes(r.recoveryCodes); toast(t('security.mfa.enrolled')); }}
                  />
                ) : (
                  <Button onClick={() => setEnrolling(true)}>{t('security.mfa.setUp')}</Button>
                )
              ) : s.policy === 'REQUIRED' ? (
                <p className="muted small">{t('security.mfa.requiredCannotDisable')}</p>
              ) : (
                <form className="stack security-narrow" onSubmit={disable}>
                  <h2 className="h3">{t('security.mfa.disableTitle')}</h2>
                  {err ? <ErrorBox error={err} /> : null}
                  <CodeInput value={disableCode} onChange={setDisableCode} label={t('security.mfa.enterCode')} />
                  <Button type="submit" variant="danger" busy={busy} disabled={disableCode.length !== 6}>
                    {t('security.mfa.disable')}
                  </Button>
                </form>
              )}
            </div>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
