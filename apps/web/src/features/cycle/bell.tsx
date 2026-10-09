// In-app notifications bell (header): unread count, dropdown list, mark read, open the tender or request.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { platform, type Notification } from '../../api-platform';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { errText } from '../../components/ui';

const POLL_MS = 60_000;

export function NotificationsBell() {
  const { t, pick, fmtDate } = useI18n();
  const { user, hasRole } = useSession();
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isVendor = hasRole('VENDOR');

  const load = useCallback(() => {
    platform
      .notifications()
      .then((xs) => {
        setItems(xs);
        setErr(null);
      })
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const h = setInterval(load, POLL_MS);
    return () => clearInterval(h);
  }, [user?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const unread = items.filter((n) => !n.readAt).length;

  const markRead = async (n: Notification) => {
    if (n.readAt) return;
    try {
      await platform.markRead(n.id);
      setItems((xs) => xs.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    } catch (e) {
      setErr(errText(e));
    }
  };
  const markAll = async () => {
    for (const n of items.filter((x) => !x.readAt)) await markRead(n);
  };
  const target = (n: Notification): string | null => {
    const b = (n.body ?? {}) as Record<string, unknown>;
    if (typeof b.tenderId === 'string') return isVendor ? `/vendor/tenders/${b.tenderId}` : `/procurement/tenders/${b.tenderId}`;
    if (typeof b.requestId === 'string' && !isVendor) return `/procurement/requests/${b.requestId}`;
    return null;
  };
  const go = async (n: Notification) => {
    await markRead(n);
    const to = target(n);
    setOpen(false);
    if (to) navigate(to);
  };

  return (
    <div className="cyc-bell" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost cyc-bell-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={unread ? t('cycle.n.labelUnread', { n: unread }) : t('cycle.n.label')}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="cyc-bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="cyc-bell-panel" role="dialog" aria-label={t('cycle.n.title')}>
          <div className="cyc-bell-head">
            <strong>{t('cycle.n.title')}</strong>
            {unread > 0 && (
              <button type="button" className="cyc-link" onClick={markAll}>
                {t('cycle.n.markAll')}
              </button>
            )}
          </div>
          {err && <div className="field-error small cyc-bell-err">{err}</div>}
          {!loaded ? (
            <div className="muted small cyc-bell-empty">{t('common.loading')}</div>
          ) : items.length === 0 ? (
            <div className="muted small cyc-bell-empty">{t('cycle.n.empty')}</div>
          ) : (
            <ul className="cyc-bell-list">
              {items.map((n) => (
                <li key={n.id} className={n.readAt ? '' : 'unread'}>
                  <button type="button" className="cyc-bell-item" onClick={() => go(n)}>
                    {!n.readAt && <span className="cyc-dot" aria-label={t('cycle.n.unread')} />}
                    <span className="cyc-bell-text">
                      <span className="cyc-bell-title">{pick(n.titleEn, n.titleAr)}</span>
                      {typeof n.body?.messageEn === 'string' && <span className="small notify-bell-msg">{pick(n.body.messageEn as string, n.body.messageAr as string)}</span>}
                      <span className="muted small">{fmtDate(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
