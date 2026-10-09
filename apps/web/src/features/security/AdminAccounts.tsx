// SEC admin page /admin/accounts (MOI FR-035/036): every entity and vendor user with status, roles, second factor,
// sign-in source and last sign-in; enable/disable (reason, audited), assign roles, amend, reset the second factor.
// New staff users are still created on the Users page; vendor users come from vendor registration.
import { useState } from 'react';
import type { Role } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Modal, ReasonDialog, Table, useAsync, useToast } from '../../components/ui';
import { secApi, type Account } from './api';

type Action = { kind: 'disable' | 'enable' | 'mfa' | 'roles' | 'amend'; user: Account } | null;

export function AdminAccountsPage() {
  const { t, te, fmtDate, pick } = useI18n();
  const toast = useToast();
  const [kind, setKind] = useState<'' | 'STAFF' | 'VENDOR'>('');
  const [q, setQ] = useState('');
  const users = useAsync(() => secApi.users(kind || undefined), [kind]);
  const roles = useAsync(() => secApi.roles(), []);
  const [action, setAction] = useState<Action>(null);
  const close = () => setAction(null);
  const done = (msg: string) => {
    toast(msg);
    users.reload();
  };
  const needle = q.trim().toLowerCase();
  return (
    <div className="stack security-page">
      <header className="page-head">
        <h1>{t('security.accounts.title')}</h1>
      </header>
      <p className="muted">{t('security.accounts.intro')}</p>
      <Card>
        <div className="row wrap security-filters">
          <Field label={t('security.accounts.kind')}>
            {(id) => (
              <select id={id} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="">{t('common.all')}</option>
                <option value="STAFF">{t('security.accounts.staff')}</option>
                <option value="VENDOR">{t('security.accounts.vendors')}</option>
              </select>
            )}
          </Field>
          <Field label={t('security.accounts.search')}>{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        </div>
        <AsyncView state={users} empty={t('security.accounts.none')}>
          {(list) => (
            <Table
              head={[
                t('admin.username'), t('security.accounts.nameCol'), t('admin.roles'), t('common.status'), t('security.accounts.mfa'),
                t('security.accounts.lastLogin'), t('common.actions'),
              ]}
            >
              {list
                .filter((u) => !needle || u.username.includes(needle) || u.displayName.toLowerCase().includes(needle) || (u.vendor?.legalNameEn ?? '').toLowerCase().includes(needle))
                .map((u) => (
                  <tr key={u.id} className={u.active === false ? 'security-row-disabled' : ''}>
                    <td dir="ltr">
                      {u.username}
                      {u.authSource === 'OIDC' && (
                        <>
                          {' '}
                          <Badge label={t('security.accounts.directory')} tone="info" />
                        </>
                      )}
                    </td>
                    <td>
                      {u.displayName}
                      {u.vendor && <div className="muted small">{pick(u.vendor.legalNameEn, u.vendor.legalNameAr)}</div>}
                    </td>
                    <td>
                      <div className="row wrap">
                        {u.roles.map((r) => (
                          <Badge key={r} label={te('role.', r)} tone={r === 'VENDOR' ? 'neutral' : 'info'} />
                        ))}
                      </div>
                    </td>
                    <td>
                      {u.active === false ? (
                        <Badge label={t('security.accounts.disabled')} tone="danger" />
                      ) : (
                        <Badge label={t('security.accounts.enabled')} tone="success" />
                      )}
                      {u.disabledAt && <div className="muted small">{fmtDate(u.disabledAt)}</div>}
                    </td>
                    <td>
                      <Badge label={te('security.mfaState.', u.mfa)} tone={u.mfa === 'ACTIVE' ? 'success' : 'neutral'} />
                      {u.mfaLocked && <Badge label={t('security.accounts.locked')} tone="warn" />}
                    </td>
                    <td>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : <span className="muted">{t('security.accounts.never')}</span>}</td>
                    <td>
                      <div className="row wrap security-actions">
                        {u.active === false ? (
                          <Button variant="secondary" onClick={() => setAction({ kind: 'enable', user: u })}>
                            {t('security.accounts.enable')}
                          </Button>
                        ) : (
                          <Button variant="ghost" disabled={u.isSelf} disabledReason={u.isSelf ? t('security.accounts.selfHint') : undefined} onClick={() => setAction({ kind: 'disable', user: u })}>
                            {t('security.accounts.disable')}
                          </Button>
                        )}
                        {u.kind === 'STAFF' && (
                          <Button variant="ghost" onClick={() => setAction({ kind: 'roles', user: u })}>
                            {t('security.accounts.roles')}
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setAction({ kind: 'amend', user: u })}>
                          {t('security.accounts.amend')}
                        </Button>
                        {u.mfa !== 'NOT_ENROLLED' && (
                          <Button variant="ghost" onClick={() => setAction({ kind: 'mfa', user: u })}>
                            {t('security.accounts.resetMfa')}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </Table>
          )}
        </AsyncView>
      </Card>
      <ReasonDialog
        open={action?.kind === 'disable'}
        title={t('security.accounts.disableTitle', { user: action?.user.username ?? '' })}
        confirmLabel={t('security.accounts.disable')}
        variant="danger"
        required
        onClose={close}
        onConfirm={async (reason) => {
          await secApi.disable(action!.user.id, reason);
          done(t('security.accounts.disabledToast'));
        }}
      />
      <ReasonDialog
        open={action?.kind === 'enable'}
        title={t('security.accounts.enableTitle', { user: action?.user.username ?? '' })}
        confirmLabel={t('security.accounts.enable')}
        required
        onClose={close}
        onConfirm={async (reason) => {
          await secApi.enable(action!.user.id, reason);
          done(t('security.accounts.enabledToast'));
        }}
      />
      <ReasonDialog
        open={action?.kind === 'mfa'}
        title={t('security.accounts.resetTitle', { user: action?.user.username ?? '' })}
        confirmLabel={t('security.accounts.resetMfa')}
        variant="danger"
        required
        onClose={close}
        onConfirm={async (reason) => {
          await secApi.resetMfa(action!.user.id, reason);
          done(t('security.accounts.resetToast'));
        }}
      />
      {action?.kind === 'roles' && (
        <RolesDialog user={action.user} catalogue={roles.data ?? []} onClose={close} onSaved={() => done(t('security.accounts.rolesToast'))} />
      )}
      {action?.kind === 'amend' && <AmendDialog user={action.user} onClose={close} onSaved={() => done(t('security.accounts.amendToast'))} />}
    </div>
  );
}

function RolesDialog({ user, catalogue, onClose, onSaved }: { user: Account; catalogue: { role: Role; kind: string; en: string; ar: string }[]; onClose: () => void; onSaved: () => void }) {
  const { t, te, pick } = useI18n();
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await secApi.setRoles(user.id, roles, reason.trim() || undefined);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('security.accounts.rolesTitle', { user: user.username })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={roles.length === 0} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {err ? <ErrorBox error={err} /> : null}
        {user.authSource === 'OIDC' && <p className="alert alert-info small">{t('security.accounts.rolesFromDirectory')}</p>}
        <fieldset className="security-role-list">
          <legend>{t('admin.roles')}</legend>
          {catalogue
            .filter((c) => c.kind === 'STAFF')
            .map((c) => (
              <label key={c.role} className="security-role-item">
                <input
                  type="checkbox"
                  checked={roles.includes(c.role)}
                  onChange={(e) => setRoles((r) => (e.target.checked ? [...r, c.role] : r.filter((x) => x !== c.role)))}
                />
                <span>
                  <strong>{te('role.', c.role)}</strong>
                  <span className="muted small"> — {pick(c.en, c.ar)}</span>
                </span>
              </label>
            ))}
        </fieldset>
        <Field label={t('common.reason')}>{(id) => <textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

function AmendDialog({ user, onClose, onSaved }: { user: Account; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await secApi.amend(user.id, { displayName: displayName.trim() !== user.displayName ? displayName.trim() : undefined, password: password || undefined });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('security.accounts.amendTitle', { user: user.username })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={displayName.trim() === user.displayName && !password} onClick={save}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {err ? <ErrorBox error={err} /> : null}
        <Field label={t('admin.displayName')}>{(id) => <input id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
        {user.authSource !== 'OIDC' && (
          <Field label={t('security.accounts.newPassword')} hint={t('security.accounts.newPasswordHint')}>
            {(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />}
          </Field>
        )}
      </div>
    </Modal>
  );
}
