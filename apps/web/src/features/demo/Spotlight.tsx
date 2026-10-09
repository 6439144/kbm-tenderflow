// Minimal spotlight: finds the first matching selector, scrolls it into view and draws a ring around it,
// recomputed on resize, scroll (any container), element resize and a slow poll for layout shifts.
import { useEffect, useState } from 'react';

function findVisible(selectors: string[]): Element | null {
  for (const s of selectors) {
    let list: NodeListOf<Element>;
    try {
      list = document.querySelectorAll(s);
    } catch {
      continue; // invalid selector in data: skip it
    }
    for (const e of Array.from(list)) {
      if (e.closest('.demo-panel') && !s.startsWith('#demo-')) continue; // never match our own panel by accident
      if (e.getClientRects().length > 0) return e;
    }
  }
  return null;
}

export interface SpotTarget {
  el: Element | null;
  rect: DOMRect | null;
  missing: boolean;
}

/** Locate a target (waits up to ~8 s for the page to render it). `key` restarts the search. */
export function useSpotTarget(selectors: string[] | undefined, key: string, scroll = true): SpotTarget {
  const [el, setEl] = useState<Element | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [missing, setMissing] = useState(false);
  const [retry, setRetry] = useState(0);
  const sel = (selectors ?? []).join('\n');

  useEffect(() => {
    setEl(null);
    setRect(null);
    setMissing(false);
    const list = sel ? sel.split('\n') : [];
    if (!list.length) {
      setMissing(true);
      return;
    }
    let tries = 0;
    let timer: number | undefined;
    const attempt = () => {
      const found = findVisible(list);
      if (found) {
        setEl(found);
        if (scroll && retry === 0) {
          const r = found.getBoundingClientRect();
          if (r.top < 70 || r.bottom > window.innerHeight - 20) found.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        return;
      }
      if (++tries > 32) {
        setMissing(true);
        return;
      }
      timer = window.setTimeout(attempt, 250);
    };
    attempt();
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, key, retry]);

  useEffect(() => {
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!el.isConnected) {
          setRetry((n) => n + 1); // React replaced the node: look it up again
          return;
        }
        const r = el.getBoundingClientRect();
        setRect((prev) =>
          prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height ? prev : r,
        );
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    const poll = window.setInterval(update, 500);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      ro?.disconnect();
      window.clearInterval(poll);
    };
  }, [el]);

  return { el, rect, missing };
}

const PAD = 6;

/** The ring itself. Never intercepts clicks on the page (pointer-events: none), except its own label button. */
export function SpotRing({ rect, dim, label, onDismiss, dismissLabel }: {
  rect: DOMRect;
  dim?: boolean;
  label?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      className={`demo-ring ${dim ? 'demo-ring-dim' : ''}`}
      style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
      aria-hidden={label ? undefined : true}
    >
      {label && (
        <span className="demo-ring-label">
          {label}
          {onDismiss && (
            <button type="button" className="demo-ring-x" onClick={onDismiss} aria-label={dismissLabel}>
              ×
            </button>
          )}
        </span>
      )}
    </div>
  );
}
