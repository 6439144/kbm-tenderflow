import { useState, type FormEvent } from 'react';
import { auditLabel } from '../../locales/audit';
import { ALL_ROLES, api, type AuditVerify, type Role } from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Hash, Modal, Table, useAsync, useToast } from '../../components/ui';
import { SignInLockCell, type LockInfo } from '../../features/security/Lockout';

// ---------------------------------------------------------------- users

export function AdminUsers() {
  const { t, te, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const isAdmin = hasRole('TENANT_ADMIN');
  const users = useAsync(() => api.users(), []);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('admin.users')}</h1>
        {isAdmin && <Button onClick={() => setOpen(true)}>{t('admin.createUser')}</Button>}
      </header>
      <Card>
        <AsyncView state={users} empty={t('admin.noUsers')}>
          {(list) => (
            <Table head={[t('admin.username'), t('admin.displayName'), t('admin.roles'), t('admin.active'), t('harden.lock.column'), t('common.createdAt')]}>
              {list.map((u) => (
                <tr key={u.id}>
                  <td dir="ltr">{u.username}</td>
                  <td>{u.displayName}</td>
                  <td>
                    <div className="row wrap">
                      {(u.roles ?? []).map((r) => (
                        <Badge key={r} label={te('role.', r)} tone="info" />
                      ))}
                    </div>
                  </td>
                  <td>{u.active === false ? t('common.no') : t('common.yes')}</td>
                  <td>
                    <SignInLockCell user={u as LockInfo} canUnlock={isAdmin} onUnlocked={users.reload} />
                  </td>
                  <td>{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
      {isAdmin && <CreateUser open={open} onClose={() => setOpen(false)} onCreated={users.reload} />}
    </div>
  );
}

function CreateUser({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { t, te } = useI18n();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createUser({ username: username.trim(), displayName: displayName.trim(), roles, password });
      toast(t('admin.userCreated'));
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRoles([]);
      onCreated();
      onClose();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={t('admin.createUser')}>
      <form onSubmit={submit} className="stack">
        {err ? <ErrorBox error={err} /> : null}
        <Field label={t('admin.username')} required>
          {(id) => <input id={id} value={username} onChange={(e) => setUsername(e.target.value)} required dir="ltr" autoComplete="off" />}
        </Field>
        <Field label={t('admin.displayName')} required>
          {(id) => <input id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />}
        </Field>
        <Field label={t('admin.password')} required>
          {(id) => (
            <input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" autoComplete="new-password" />
          )}
        </Field>
        <fieldset>
          <legend>{t('admin.roles')}</legend>
          <div className="checks">
            {ALL_ROLES.filter((r) => r !== 'VENDOR').map((r) => (
              <label key={r} className="check">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={() => setRoles((xs) => (xs.includes(r) ? xs.filter((x) => x !== r) : [...xs, r]))}
                />
                {te('role.', r)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={roles.length === 0}>
            {t('admin.createUser')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- audit

export function AdminAudit() {
  const { t, te, fmtDate, lang } = useI18n();
  const [resourceId, setResourceId] = useState('');
  const [limit, setLimit] = useState(200);
  const [query, setQuery] = useState({ resourceId: '', limit: 200 });
  const [actionFilter, setActionFilter] = useState('');
  const events = useAsync(() => api.audit({ resourceId: query.resourceId || undefined, limit: query.limit }), [query]);
  const [verify, setVerify] = useState<AuditVerify | null>(null);
  const [vBusy, setVBusy] = useState(false);
  const [vErr, setVErr] = useState<unknown>(null);

  const runVerify = async () => {
    setVBusy(true);
    setVErr(null);
    setVerify(null);
    try {
      setVerify(await api.verifyAudit());
    } catch (e) {
      setVErr(e);
    } finally {
      setVBusy(false);
    }
  };

  const filtered = (events.data ?? []).filter((e) => !actionFilter || e.action.toLowerCase().includes(actionFilter.toLowerCase()));

  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('admin.audit')}</h1>
        <Button busy={vBusy} onClick={runVerify} data-tour="audit-verify">
          {t('admin.verify')}
        </Button>
      </header>
      {vErr ? <ErrorBox error={vErr} /> : null}
      {verify && (
        <div className={`alert ${verify.valid ? 'alert-success' : 'alert-danger'}`} role="status">
          <strong>
            {verify.valid
              ? t('admin.verifyValid', { count: verify.count })
              : t('admin.verifyInvalid', { count: verify.count, at: String(verify.brokenAt ?? '?') })}
          </strong>
        </div>
      )}
      <form
        className="row wrap filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ resourceId: resourceId.trim(), limit });
        }}
      >
        <Field label={t('admin.resourceId')}>
          {(id) => <input id={id} value={resourceId} onChange={(e) => setResourceId(e.target.value)} dir="ltr" />}
        </Field>
        <Field label={t('admin.limit')}>
          {(id) => (
            <select id={id} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t('common.filter')}
        </Button>
        <Field label={t('admin.actionFilter')}>
          {(id) => <input id={id} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} dir="ltr" />}
        </Field>
      </form>
      <Card>
        <AsyncView state={{ ...events, data: events.data ? filtered : undefined }} empty={t('admin.noEvents')}>
          {(list) => (
            <Table head={['#', t('admin.at'), t('admin.action'), t('admin.actor'), t('admin.resource'), t('admin.transition'), t('common.reason'), 'HMAC']}>
              {list.map((e) => (
                <tr key={e.id ?? String(e.seq)}>
                  <td dir="ltr">{e.seq ?? '—'}</td>
                  <td className="nowrap">{fmtDate(e.at)}</td>
                  <td>
                    {auditLabel(lang, e.action)}
                    <br />
                    <code className="small">{e.action}</code>
                  </td>
                  <td className="small">
                    {(e.actorRoles ?? []).map((r) => te('role.', r)).join(', ')}
                    <br />
                    <Hash value={e.actorId} />
                  </td>
                  <td className="small">
                    {e.resourceType}
                    <br />
                    <Hash value={e.resourceId} />
                  </td>
                  <td className="small">{e.prevState || e.newState ? `${e.prevState ?? '∅'} → ${e.newState ?? '∅'}` : '—'}</td>
                  <td className="small prewrap">{e.reason ?? '—'}</td>
                  <td>
                    <Hash value={e.hmac} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- system status (GET /ready)

type Check = Record<string, unknown>;

function okOf(c: unknown): boolean | undefined {
  if (typeof c === 'boolean') return c;
  if (c && typeof c === 'object') {
    const o = c as Check;
    if (typeof o.ok === 'boolean') return o.ok;
    if (typeof o.status === 'string') return ['ok', 'up', 'ready', 'healthy'].includes(o.status.toLowerCase());
  }
  if (typeof c === 'string') return ['ok', 'up', 'ready', 'healthy'].includes(c.toLowerCase());
  return undefined;
}

export function AdminSystem() {
  const { t } = useI18n();
  const ready = useAsync(() => api.ready(), []);
  return (
    <div className="stack">
      <header className="page-head">
        <h1>{t('admin.system')}</h1>
        <Button variant="ghost" onClick={ready.reload}>
          {t('common.refresh')}
        </Button>
      </header>
      <AsyncView state={ready} isEmpty={() => false}>
        {({ httpStatus, report }) => {
          const checks = (report.checks && typeof report.checks === 'object' ? report.checks : report) as Check;
          const overallOk = httpStatus >= 200 && httpStatus < 300;
          const label = (k: string) =>
            /^(db|database|postgres)/i.test(k) ? t('admin.db') : /content|store|filenet/i.test(k) ? t('admin.content') : /^ai|orchestrate|wxo/i.test(k) ? t('admin.ai') : k;
          return (
            <>
              <div className={`alert ${overallOk ? 'alert-success' : 'alert-danger'}`} role="status">
                <strong>
                  {t('admin.overall')}: {overallOk ? t('admin.ok') : t('admin.down')}
                </strong>{' '}
                <span className="muted small" dir="ltr">
                  HTTP {httpStatus}
                  {typeof report.status === 'string' ? ` · ${report.status}` : ''}
                </span>
              </div>
              <div className="tiles tiles-wide">
                {Object.entries(checks)
                  .filter(([k, v]) => v && typeof v === 'object' && k !== 'checks')
                  .map(([k, v]) => {
                    const c = v as Check;
                    const ok = okOf(c);
                    const configured = typeof c.configured === 'boolean' ? c.configured : undefined;
                    return (
                      <Card key={k} title={label(k)}>
                        <div className="row wrap">
                          {ok !== undefined && <Badge value={ok ? 'OK' : 'ERROR'} label={ok ? t('admin.ok') : t('admin.down')} />}
                          {configured !== undefined && (
                            <Badge tone={configured ? 'info' : 'warn'} label={configured ? t('admin.configured') : t('admin.notConfigured')} />
                          )}
                          {typeof c.type === 'string' && <Badge tone="neutral" label={c.type} />}
                        </div>
                        <dl className="kv small">
                          {Object.entries(c)
                            .filter(([kk]) => !['ok', 'configured', 'type'].includes(kk))
                            .map(([kk, vv]) => (
                              <div key={kk} className="kv-row">
                                <dt>{kk}</dt>
                                <dd dir="ltr">{typeof vv === 'object' ? JSON.stringify(vv) : String(vv)}</dd>
                              </div>
                            ))}
                        </dl>
                      </Card>
                    );
                  })}
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
