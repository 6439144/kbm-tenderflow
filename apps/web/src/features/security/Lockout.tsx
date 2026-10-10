// HARDEN: sign-in lockout on the admin users page — "Locked until …" (and recent failed sign-ins) per user, and the
// administrator's Unlock action (POST /admin/users/:id/unlock, audited; also clears a second-factor lock).
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Button, errText, useToast } from '../../components/ui';
import { secApi } from './api';

export interface LockInfo { id: string; username: string; lockedUntil?: string | null; failedSignIns?: number }

export function SignInLockCell({ user, canUnlock, onUnlocked }: { user: LockInfo; canUnlock: boolean; onUnlocked: () => void }) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const locked = !!user.lockedUntil && new Date(user.lockedUntil) > new Date();
  if (!locked && !user.failedSignIns) return <span className="muted small">—</span>;
  const unlock = async () => {
    setBusy(true);
    try {
      await secApi.unlockUser(user.id);
      toast(t('harden.lock.unlocked', { user: user.username }));
      onUnlocked();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="row wrap">
      {locked ? (
        <Badge tone="danger" label={t('harden.lock.lockedUntil', { time: fmtDate(user.lockedUntil!) })} />
      ) : (
        <span className="muted small">{t('harden.lock.failures', { n: user.failedSignIns ?? 0 })}</span>
      )}
      {locked && canUnlock && (
        <Button variant="secondary" busy={busy} onClick={unlock} aria-label={`${t('harden.lock.unlock')}: ${user.username}`}>
          {t('harden.lock.unlock')}
        </Button>
      )}
    </span>
  );
}
