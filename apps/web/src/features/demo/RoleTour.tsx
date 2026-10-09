// First-login role tour: data-driven spotlight steps (tours.ts), bilingual, skippable, replayable.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { setDemo, useDemoState } from './state';
import { SpotRing, useSpotTarget } from './Spotlight';
import { TOURS } from './tours';

const W = 340;
const GAP = 14;

export function RoleTour() {
  const { t } = useI18n();
  const { tour } = useDemoState();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const steps = tour ? TOURS[tour.id] : [];
  const step = tour ? steps[tour.step] : undefined;
  const popRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [popH, setPopH] = useState(200);

  // navigate to the step's screen first
  useEffect(() => {
    if (step?.path && pathname !== step.path) navigate(step.path);
  }, [step, pathname, navigate]);

  const waitingForPath = Boolean(step?.path && pathname !== step.path);
  const target = useSpotTarget(waitingForPath ? undefined : step?.spot, `${tour?.id}-${tour?.step}-${waitingForPath}`);

  useLayoutEffect(() => {
    if (popRef.current) setPopH(popRef.current.offsetHeight);
  });
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [tour?.id, tour?.step]);

  useEffect(() => {
    if (!tour) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDemo({ tour: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour]);

  if (!tour || !step) return null;
  const last = tour.step === steps.length - 1;
  const go = (n: number) => setDemo({ tour: n < 0 || n >= steps.length ? null : { id: tour.id, step: n } });

  const rect = target.rect;
  let style: CSSProperties;
  if (rect && !waitingForPath) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(W, vw - 24);
    let top = rect.bottom + GAP;
    if (top + popH > vh - 12) top = rect.top - GAP - popH;
    if (top < 12) top = Math.min(Math.max(12, rect.top), vh - popH - 12);
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, vw - width - 12));
    style = { top, left, width };
  } else {
    style = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: Math.min(W, window.innerWidth - 24) };
  }

  return (
    <>
      {rect && !waitingForPath ? <SpotRing rect={rect} dim /> : <div className="demo-tour-backdrop" aria-hidden="true" />}
      <div ref={popRef} className="demo-tour-pop" style={style} role="dialog" aria-modal="false" aria-labelledby="demo-tour-title">
        <div className="demo-tour-kicker">
          {t('demo.tour.label')} · {t('demo.tour.step', { n: tour.step + 1, total: steps.length })}
        </div>
        <h2 id="demo-tour-title" ref={titleRef} tabIndex={-1}>
          {t(step.title)}
        </h2>
        <p>{t(step.body)}</p>
        {step.spot && target.missing && !waitingForPath && <p className="small muted">{t('demo.tour.missing')}</p>}
        <div className="demo-tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={i === tour.step ? 'on' : ''} />
          ))}
        </div>
        <div className="demo-tour-actions">
          <button type="button" className="btn btn-ghost" onClick={() => go(-1)}>
            {t('demo.tour.skip')}
          </button>
          <span className="demo-grow" />
          {tour.step > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => go(tour.step - 1)}>
              {t('demo.tour.back')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => go(last ? -1 : tour.step + 1)}>
            {last ? t('demo.tour.done') : t('demo.tour.next')}
          </button>
        </div>
      </div>
    </>
  );
}
