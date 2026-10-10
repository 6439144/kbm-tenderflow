// Usability helpers shared by the admin configuration screens (Cycle Designer, Process Studio): contextual help
// drawer with a glossary, a dismissible "Getting started" checklist, an unsaved-changes guard, drag-and-drop list
// ordering (always with a keyboard alternative), a friendly days + hours input and the extension slot where a
// separate team will mount the "describe a change" feature. Nothing here talks to the server.
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useI18n, type TKey } from '../i18n';
import { Button } from './ui';
import '../styles/ux.css';

// ---------------------------------------------------------------- storage (per-viewer conveniences only)
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* private mode / blocked storage: the preference is simply not remembered */
    }
  },
};

// ---------------------------------------------------------------- extension slot
/**
 * Mount point for the "describe a change" feature that another team is building. It renders nothing of its own;
 * pass the feature's element as `children` (screens expose it as their `headerExtras` prop).
 */
export function DescribeChangeSlot({ children }: { children?: ReactNode }) {
  return (
    <div className="ux-slot" data-slot="describe-change">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- glossary / help drawer
export type HelpTopic =
  | 'gate' | 'event' | 'schedule' | 'rule' | 'condition' | 'draft' | 'fourEyes' | 'simulator' | 'customField' | 'calculated'
  | 'pinning' | 'envelopes' | 'passMark' | 'chain' | 'eligibility' | 'fee' | 'scope' | 'stageKinds' | 'integrity' | 'template';

export const STUDIO_TOPICS: HelpTopic[] = ['rule', 'gate', 'event', 'schedule', 'condition', 'customField', 'calculated', 'simulator', 'draft', 'fourEyes', 'pinning', 'integrity'];
export const CYCLE_TOPICS: HelpTopic[] = ['template', 'stageKinds', 'envelopes', 'passMark', 'chain', 'fourEyes', 'eligibility', 'fee', 'scope', 'draft', 'pinning', 'integrity'];

export function HelpButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <Button variant="secondary" onClick={onClick} aria-haspopup="dialog">
      <span aria-hidden="true" className="ux-help-q">?</span> {t('ux.help.open')}
    </Button>
  );
}

/** Side drawer with plain-language explanations of the words used on the screen. Esc or the close button closes it. */
export function HelpDrawer({ open, onClose, topics, intro, onShowGettingStarted }: {
  open: boolean; onClose: () => void; topics: HelpTopic[]; intro?: ReactNode; onShowGettingStarted?: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return topics
      .map((k) => ({ k, title: t(`ux.g.${k}.t` as TKey), body: t(`ux.g.${k}.d` as TKey) }))
      .filter((x) => !needle || x.title.toLowerCase().includes(needle) || x.body.toLowerCase().includes(needle));
  }, [q, topics, t]);
  if (!open) return null;
  return (
    <div className="ux-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="ux-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="ux-drawer-head">
          <h2 id={titleId}>{t('ux.help.title')}</h2>
          <button type="button" className="modal-x" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>
        <div className="ux-drawer-body">
          {intro && <p className="muted">{intro}</p>}
          <label className="sr-only" htmlFor={`${titleId}-q`}>
            {t('ux.help.search')}
          </label>
          <input id={`${titleId}-q`} type="search" placeholder={t('ux.help.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <dl className="ux-glossary">
            {items.map((x) => (
              <div key={x.k} className="ux-gloss-item">
                <dt>{x.title}</dt>
                <dd>{x.body}</dd>
              </div>
            ))}
          </dl>
          {!items.length && <p className="muted">{t('ux.help.noMatch')}</p>}
          {onShowGettingStarted && (
            <Button variant="ghost" onClick={() => { onShowGettingStarted(); onClose(); }}>
              {t('ux.gs.show')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- getting started checklist
export interface ChecklistItem {
  key: string;
  label: string;
  hint?: string;
  /** Only set from real data (e.g. "a form is published"); undefined means "not tracked". */
  done?: boolean;
  action?: { label: string; onClick: () => void };
}

const gsKey = (id: string) => `tf.ux.gettingStarted.${id}.dismissed`;
export function useGettingStarted(id: string) {
  const [hidden, setHidden] = useState(() => safeStorage.get(gsKey(id)) === '1');
  return {
    hidden,
    dismiss: () => {
      safeStorage.set(gsKey(id), '1');
      setHidden(true);
    },
    show: () => {
      safeStorage.set(gsKey(id), null);
      setHidden(false);
    },
  };
}

export function GettingStarted({ title, intro, items, onDismiss }: { title: string; intro?: string; items: ChecklistItem[]; onDismiss: () => void }) {
  const { t } = useI18n();
  const done = items.filter((x) => x.done).length;
  const tracked = items.filter((x) => x.done !== undefined).length;
  return (
    <section className="card ux-gs" aria-labelledby="ux-gs-title">
      <header className="card-head">
        <h2 className="card-title" id="ux-gs-title">
          <span aria-hidden="true">🧭</span> {title}
        </h2>
        <div className="card-actions">
          {tracked > 0 && <span className="muted small">{t('ux.gs.progress', { n: done, total: tracked })}</span>}
          <Button variant="ghost" onClick={onDismiss}>
            {t('ux.gs.dismiss')}
          </Button>
        </div>
      </header>
      <div className="card-body">
        {intro && <p className="muted small">{intro}</p>}
        <ol className="ux-gs-list">
          {items.map((x, i) => (
            <li key={x.key} className={x.done ? 'is-done' : ''}>
              <span className="ux-gs-n" aria-hidden="true">
                {x.done ? '✓' : i + 1}
              </span>
              <span className="ux-gs-text">
                <strong>{x.label}</strong>
                {x.done && <span className="sr-only"> ({t('ux.gs.done')})</span>}
                {x.hint && <span className="muted small">{x.hint}</span>}
              </span>
              {x.action && (
                <Button variant="secondary" className="btn-sm" onClick={x.action.onClick}>
                  {x.action.label}
                </Button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- unsaved changes guard
/**
 * Warns before leaving with unsaved changes: closing / reloading the tab (browser prompt) and clicking an in-app link
 * (confirm dialog). Switching items inside a screen should call `confirmLeave()` itself.
 */
export function useUnsavedGuard(dirty: boolean, message: string) {
  const ref = useRef({ dirty, message });
  ref.current = { dirty, message };
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (!ref.current.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (!ref.current.dirty || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      if (!window.confirm(ref.current.message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBefore);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
  return { confirmLeave: () => !ref.current.dirty || window.confirm(ref.current.message) };
}

// ---------------------------------------------------------------- drag and drop ordering
/** Move an item from one index to another (pure). */
export function moveItem<T>(xs: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= xs.length || to >= xs.length) return xs;
  const next = [...xs];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

/**
 * Native HTML5 drag-and-drop for a vertical list. Drag starts only from the handle (so text fields in the row keep
 * working); keyboard users use the move up / down buttons each list keeps.
 */
export function useDragOrder(count: number, onMove: (from: number, to: number) => void) {
  const [from, setFrom] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const end = () => {
    setFrom(null);
    setOver(null);
  };
  return {
    dragging: from,
    over,
    handle: (i: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        setFrom(i);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        const row = (e.currentTarget as HTMLElement).closest('[data-drag-row]');
        if (row) e.dataTransfer.setDragImage(row, 20, 20);
      },
      onDragEnd: end,
    }),
    row: (i: number) => ({
      'data-drag-row': true,
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (from === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (over !== i) setOver(i);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        if (from !== null && from !== i && i < count) onMove(from, i);
        end();
      },
      className: `${from === i ? 'ux-dragging' : ''} ${over === i && from !== null && from !== i ? (from < i ? 'ux-drop-after' : 'ux-drop-before') : ''}`,
    }),
  };
}

export function DragHandle({ label, ...rest }: { label: string } & ReturnType<ReturnType<typeof useDragOrder>['handle']>) {
  return (
    <span className="ux-handle" title={label} aria-hidden="true" {...rest}>
      ⠿
    </span>
  );
}

// ---------------------------------------------------------------- duration (days + hours)
/** Hours entered as days + hours (stored as whole hours, like the server expects). Empty = no time limit. */
export function DurationInput({ label, hint, value, onChange, max = 8760 }: {
  label: string; hint?: string; value: number | undefined; onChange: (h: number | undefined) => void; max?: number;
}) {
  const { t } = useI18n();
  const id = useId();
  const days = value ? Math.floor(value / 24) : '';
  const hours = value ? value % 24 : '';
  const set = (d: number, h: number) => {
    const total = Math.max(0, Math.round(d)) * 24 + Math.max(0, Math.round(h));
    onChange(total <= 0 ? undefined : Math.min(max, total));
  };
  return (
    <fieldset className="ux-duration" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend>{label}</legend>
      <div className="ux-duration-row">
        <label>
          <input type="number" min={0} max={365} dir="ltr" value={days} onChange={(e) => set(Number(e.target.value || 0), Number(hours || 0))} />
          <span>{t('ux.dur.days')}</span>
        </label>
        <label>
          <input type="number" min={0} max={23} dir="ltr" value={hours} onChange={(e) => set(Number(days || 0), Number(e.target.value || 0))} />
          <span>{t('ux.dur.hours')}</span>
        </label>
        {value ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(undefined)}>
            {t('ux.dur.clear')}
          </button>
        ) : (
          <span className="muted small">{t('ux.dur.none')}</span>
        )}
      </div>
      {hint && (
        <div id={`${id}-hint`} className="hint">
          {hint}
        </div>
      )}
    </fieldset>
  );
}

/** "2 days 4 hours" / "يومان و4 ساعات" style text for a number of hours. */
export function useDurationText() {
  const { t } = useI18n();
  return (h: number | undefined | null) => {
    if (!h) return t('ux.dur.none');
    const d = Math.floor(h / 24);
    const r = h % 24;
    if (d && r) return t('ux.dur.dh', { d, h: r });
    if (d) return t('ux.dur.d', { d });
    return t('ux.dur.h', { h: r });
  };
}

// ---------------------------------------------------------------- stepper navigation
export function StepNav({ steps, current, onGo, label, status }: {
  steps: string[]; current: number; onGo: (i: number) => void; label: string; status?: ('ok' | 'error' | undefined)[];
}) {
  const { t } = useI18n();
  return (
    <nav aria-label={label}>
      <ol className="ux-steps">
        {steps.map((s, i) => (
          <li key={i} className={`${i === current ? 'is-current' : ''} ${i < current ? 'is-past' : ''} ${status?.[i] === 'error' ? 'is-error' : ''}`}>
            <button type="button" onClick={() => onGo(i)} aria-current={i === current ? 'step' : undefined}>
              <span className="ux-step-n" aria-hidden="true">
                {status?.[i] === 'error' ? '!' : i + 1}
              </span>
              <span className="ux-step-label">{s}</span>
              {status?.[i] === 'error' && <span className="sr-only"> ({t('ux.step.needsAttention')})</span>}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
