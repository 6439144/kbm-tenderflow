// Demo workstream: role tours, presenter Demo Story, persona switcher, deadline control, IBM callouts.
// DemoLauncher is mounted in the header; DemoOverlay once at the app root.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DemoPanel } from './DemoPanel';
import { RoleTour } from './RoleTour';
import { SpotRing, useSpotTarget } from './Spotlight';
import { lsGet, lsSet, setDemo, tourSeenKey, useDemoState, useDemoStatus, type Spot } from './state';
import { tourFor } from './tours';

/** Header control: "Guided demo" (demo mode only) with a menu item "Replay my tour"; otherwise a small "Tour" button. */
export function DemoLauncher() {
  const { t } = useI18n();
  const { session, user } = useSession();
  const { enabled } = useDemoStatus(session?.token);
  const st = useDemoState();
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!user || enabled === null) return null;
  const tourId = tourFor(user.roles);
  const replay = () => {
    setMenu(false);
    if (tourId) setDemo({ tour: { id: tourId, step: 0 } });
  };

  if (!enabled) {
    return tourId ? (
      <button type="button" className="btn btn-ghost demo-launch" onClick={replay} aria-label={t('demo.tourButtonLabel')} title={t('demo.tourButtonLabel')}>
        {t('demo.tourButton')}
      </button>
    ) : null;
  }

  return (
    <div className="demo-launcher" ref={wrap}>
      <button
        type="button"
        className={`btn ${st.open ? 'btn-primary' : 'btn-secondary'} demo-launch`}
        aria-pressed={st.open}
        onClick={() => setDemo((s) => ({ open: !s.open, collapsed: false, tour: null }))}
      >
        <span className="demo-play" aria-hidden="true" />
        {t('demo.launch')}
      </button>
      <button type="button" className="btn btn-ghost demo-launch-more" aria-haspopup="menu" aria-expanded={menu} aria-label={t('demo.menu')} onClick={() => setMenu((m) => !m)}>
        <span aria-hidden="true">▾</span>
      </button>
      {menu && (
        <div className="demo-menu" role="menu">
          <button type="button" role="menuitem" onClick={replay} disabled={!tourId}>
            {t('demo.replayTour')}
          </button>
        </div>
      )}
    </div>
  );
}

function StorySpot({ spot }: { spot: Spot }) {
  const { t } = useI18n();
  const target = useSpotTarget(spot.selectors, String(spot.nonce));
  if (!target.rect) return null;
  return <SpotRing rect={target.rect} label={t('demo.spot.here')} onDismiss={() => setDemo({ spot: null })} dismissLabel={t('demo.spot.dismiss')} />;
}

/** App-root overlay: first-login role tour, the presenter panel and its spotlight. */
export function DemoOverlay() {
  const { session, user } = useSession();
  const { enabled, status } = useDemoStatus(session?.token);
  const st = useDemoState();
  const { pathname } = useLocation();
  const showPanel = Boolean(user && enabled && st.open && status);

  // First login per user + role: start that role's tour (not while the presenter panel drives the screen).
  const roles = user?.roles.join(',') ?? '';
  useEffect(() => {
    if (!user || enabled === null) return;
    if (enabled && st.open) return;
    const id = tourFor(user.roles);
    if (!id) return;
    const key = tourSeenKey(user.tenantId, user.username, id);
    if (lsGet(key)) return;
    lsSet(key, '1');
    setDemo({ tour: { id, step: 0 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.tenantId, roles, enabled]);

  // Sign-out ends a running tour.
  useEffect(() => {
    if (!user && st.tour) setDemo({ tour: null });
  }, [user, st.tour]);

  const docked = showPanel && !st.collapsed;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('demo-docked', docked);
    return () => root.classList.remove('demo-docked');
  }, [docked]);

  return (
    <>
      {user && st.tour && <RoleTour />}
      {showPanel && st.spot && st.spot.path === pathname && !st.tour && <StorySpot key={st.spot.nonce} spot={st.spot} />}
      {showPanel && status && <DemoPanel status={status} />}
    </>
  );
}
