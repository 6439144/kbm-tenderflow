// Shared bits of the NOTIFY admin pages: sub-navigation, channel status, delivery status badges, durations.
import { NavLink } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { Badge } from '../../components/ui';
import type { Channel, ChannelStatus, DeliveryStatus } from './api';

export function NotifySubnav() {
  const { t } = useI18n();
  const items: [string, TKey][] = [
    ['/admin/notifications', 'notify.sub.templates'],
    ['/admin/notifications/log', 'notify.sub.log'],
    ['/admin/jobs', 'notify.sub.jobs'],
  ];
  return (
    <nav className="notify-subnav" aria-label={t('notify.sub.label')}>
      {items.map(([to, k]) => (
        <NavLink key={to} to={to} end className={({ isActive }) => (isActive ? 'on' : '')}>
          {t(k)}
        </NavLink>
      ))}
    </nav>
  );
}

const STATUS_TONE: Record<DeliveryStatus, string> = {
  QUEUED: 'info',
  SENT: 'success',
  FAILED: 'danger',
  SKIPPED_NOT_CONFIGURED: 'neutral',
  SKIPPED_NO_ADDRESS: 'warn',
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const { te } = useI18n();
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'} label={te('notify.ds.', status)} />;
}

export function ChannelBadge({ channel }: { channel: Channel }) {
  const { te } = useI18n();
  return <span className={`notify-ch notify-ch-${channel.toLowerCase()}`}>{te('notify.ch.', channel)}</span>;
}

/** One line per channel: configured on this server or not (never pretends). */
export function ChannelStatusRow({ channels }: { channels: ChannelStatus }) {
  const { t, te } = useI18n();
  return (
    <ul className="notify-chstatus" aria-label={t('notify.chstatus.label')}>
      {(['IN_APP', 'EMAIL', 'SMS'] as Channel[]).map((c) => {
        const s = channels[c];
        return (
          <li key={c} className={s?.configured ? 'ok' : 'off'}>
            <span className="notify-chstatus-dot" aria-hidden="true" />
            <span>
              <strong>{te('notify.ch.', c)}</strong>{' '}
              <span className="small">{s?.configured ? t('notify.chstatus.on') : t('notify.chstatus.off')}</span>
              <span className="muted small notify-chstatus-detail" dir="ltr">
                {s?.detail}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "3 d 4 h", "5 h 10 min", "12 min" — in the UI language. */
export function useDuration() {
  const { t } = useI18n();
  return (ms: number) => {
    const m = Math.max(1, Math.round(Math.abs(ms) / 60_000));
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    const parts: string[] = [];
    if (d) parts.push(t('notify.dur.d', { n: d }));
    if (h) parts.push(t('notify.dur.h', { n: h }));
    if (!d && mm) parts.push(t('notify.dur.m', { n: mm }));
    return parts.join(' ');
  };
}

export function everyLabel(ms: number, t: (k: TKey, v?: Record<string, string | number>) => string) {
  if (ms % 3_600_000 === 0) return t('notify.jobs.everyH', { n: ms / 3_600_000 });
  if (ms % 60_000 === 0) return t('notify.jobs.everyM', { n: ms / 60_000 });
  return t('notify.jobs.everyS', { n: Math.round(ms / 1000) });
}
