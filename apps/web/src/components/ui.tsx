import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { agentNameOf, ApiError, isAgentNotImported, isAiNotConfigured, isEmptyAiReply } from '../api';
import { useI18n } from '../i18n';

// ---------------------------------------------------------------- data hook

export interface Async<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((x) => x + 1), []), setData };
}

// ---------------------------------------------------------------- primitives

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  variant = 'primary',
  busy,
  children,
  disabledReason,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; disabledReason?: string }) {
  const disabled = rest.disabled || busy;
  const btn = (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} ${className ?? ''}`}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={disabledReason && disabled ? disabledReason : rest.title}
    >
      {busy && <span className="spinner spinner-sm" aria-hidden="true" />}
      {children}
    </button>
  );
  if (disabledReason && disabled) {
    return (
      <span className="tooltip-wrap" tabIndex={0} aria-label={disabledReason}>
        {btn}
        <span role="tooltip" className="tooltip">
          {disabledReason}
        </span>
      </span>
    );
  }
  return btn;
}

export function Card({
  title,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

const TONE: Record<string, string> = {
  DRAFT: 'neutral',
  APPROVED: 'info',
  PUBLISHED: 'primary',
  CLOSED: 'warn',
  OPENED: 'info',
  EVALUATION: 'info',
  AWARDED: 'success',
  CANCELLED: 'danger',
  PENDING_REVIEW: 'warn',
  PENDING: 'warn',
  REJECTED: 'danger',
  SEALED: 'neutral',
  OPEN: 'warn',
  ANSWERED: 'success',
  HIGH: 'danger',
  MEDIUM: 'warn',
  LOW: 'info',
  PRESENT: 'success',
  MISSING: 'danger',
  UNCLEAR: 'warn',
  OK: 'success',
  ERROR: 'danger',
  ACCEPTED: 'success',
  IGNORED: 'neutral',
};

export function Badge({ value, label, tone }: { value?: string; label: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone ?? TONE[value ?? ''] ?? 'neutral'}`}>{label}</span>;
}

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="spinner-row" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}

export function EmptyState({ message, children }: { message: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </svg>
      <p>{message}</p>
      {children}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, te, pick, lang } = useI18n();
  if (isAiNotConfigured(error)) return <AiNotConfiguredBanner />;
  if (isAgentNotImported(error)) return <AgentNotImportedBanner agent={agentNameOf(error)} />;
  if (isEmptyAiReply(error)) {
    return (
      <div className="alert alert-warn" role="status">
        <div>
          <strong>{t('ai.emptyReply', { agent: agentNameOf(error) })}</strong>
          <div className="small">{t('ai.emptyReplyDetail')}</div>
          {onRetry && <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}
        </div>
      </div>
    );
  }
  const code = error instanceof ApiError ? error.code : 'CLIENT_ERROR';
  const raw = error instanceof Error ? error.message : String(error);
  const message = te('security.err.', code) !== code ? te('security.err.', code) // SEC: bilingual security refusals
    : te('lowcode.err.', code) !== code ? te('lowcode.err.', code) : raw; // low-code: bilingual process-rule refusals
  const d = error instanceof ApiError && code === 'PROCESS_RULE_BLOCKED' ? (error.details as any) : null;
  const reasons: string[] = d ? [
    ...((d.blocks ?? []) as any[]).map((b) => pick(b.messageEn, b.messageAr)),
    ...(d.missingFields?.length ? [t('lc.proc.missingFields', { list: (d.missingFields as any[]).map((f) => pick(f.labelEn, f.labelAr)).join(lang === 'ar' ? '، ' : ', ') })] : []),
    ...((d.missingDocuments ?? []) as any[]).map((x) => t('lc.proc.missingDocs', { rule: pick(x.ruleNameEn, x.ruleNameAr), n: x.minCount, title: x.titleContains ? ` «${x.titleContains}»` : '', found: x.found })),
    ...(d.openTasks?.length ? [t('lc.proc.openTasks', { list: (d.openTasks as any[]).map((x) => pick(x.titleEn, x.titleAr)).join('; ') })] : []),
  ] : [];
  const forbidden = error instanceof ApiError && error.status === 403 && message === raw;
  return (
    <div className="alert alert-danger" role="alert">
      <div>
        <strong>{forbidden ? t('common.notPermitted') : t('common.error')}</strong>
        <div className="alert-msg">{message}</div>
        {reasons.length > 0 && <ul className="alert-list">{reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        <div className="muted small">
          {t('common.errorCode')}: <code>{code}</code>
        </div>
      </div>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function AgentNotImportedBanner({ agent }: { agent: string }) {
  const { t } = useI18n();
  return (
    <div className="alert alert-warn" role="status">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <div>
        <strong>{t('ai.agentNotImported', { agent })}</strong>
        <div className="small">{t('ai.agentNotImportedDetail')}</div>
      </div>
    </div>
  );
}

export function AiNotConfiguredBanner() {
  const { t } = useI18n();
  return (
    <div className="alert alert-info" role="status">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <div>
        <strong>{t('ai.notConfigured')}</strong>
        <div className="small">{t('ai.notConfiguredDetail')}</div>
      </div>
    </div>
  );
}

/** Loading / error / empty switch for a useAsync result. */
export function AsyncView<T>({
  state,
  empty,
  isEmpty,
  children,
}: {
  state: Async<T>;
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  const { t } = useI18n();
  if (state.loading && state.data === undefined) return <Spinner />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Spinner />;
  const emptyNow = isEmpty ? isEmpty(state.data) : Array.isArray(state.data) && state.data.length === 0;
  if (emptyNow) return <EmptyState message={empty ?? t('common.empty')} />;
  return <>{children(state.data)}</>;
}

export function Table({ head, children, caption }: { head: ReactNode[]; children: ReactNode; caption?: string }) {
  return (
    <div className="table-wrap">
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (id: string, describedBy?: string) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children(id, describedBy)}
      {hint && (
        <div id={hintId} className="hint">
          {hint}
        </div>
      )}
      {error && (
        <div id={errId} className="field-error">
          {error}
        </div>
      )}
    </div>
  );
}

export function FileInput({
  label,
  file,
  onChange,
  required,
  accept,
}: {
  label: ReactNode;
  file: File | null;
  onChange: (f: File | null) => void;
  required?: boolean;
  accept?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file && ref.current) ref.current.value = '';
  }, [file]);
  return (
    <Field label={label} required={required}>
      {(id, describedBy) => (
        <div className="file-input">
          <input
            ref={ref}
            id={id}
            type="file"
            accept={accept}
            required={required}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.files?.[0] ?? null)}
          />
          <span className="muted small">{file ? `${file.name} · ${fmtBytes(file.size)}` : t('common.noFile')}</span>
        </div>
      )}
    </Field>
  );
}

export function fmtBytes(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Modal({
  title,
  open,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, textarea, select, button:not(.modal-x)');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && el) {
        const items = Array.from(
          el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex="0"]'),
        );
        if (items.length === 0) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="modal-x" onClick={onClose} aria-label={t('common.close')}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Small modal asking for a reason, used for approve / return / reject / cancel actions. */
export function ReasonDialog({
  open,
  title,
  confirmLabel,
  required,
  variant = 'primary',
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  required?: boolean;
  variant?: Variant;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setReason('');
      setErr(null);
      setTouched(false);
    }
  }, [open]);
  const invalid = Boolean(required && !reason.trim());
  const submit = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant={variant} busy={busy} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {err ? <ErrorBox error={err} /> : null}
      <Field label={t('common.reason')} required={required} error={touched && invalid ? t('common.reasonRequired') : undefined}>
        {(id, d) => (
          <textarea id={id} aria-describedby={d} rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- toasts

interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
  action?: ToastAction;
}
/** Optional button on a toast (e.g. "Undo" after a delete). The toast stays a little longer when it has one. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
type PushToast = (text: string, kind?: ToastItem['kind'], action?: ToastAction) => void;
const ToastCtx = createContext<PushToast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const drop = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback<PushToast>((text, kind = 'success', action) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, kind, text, action }]);
    setTimeout(() => drop(id), action ? 10000 : 5000);
  }, [drop]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {items.map((x) => (
          <div key={x.id} className={`toast toast-${x.kind} ${x.action ? 'toast-has-action' : ''}`}>
            <span>{x.text}</span>
            {x.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  x.action?.onClick();
                  drop(x.id);
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function errText(e: unknown): string {
  if (e instanceof ApiError) return `${e.message} (${e.code})`;
  return e instanceof Error ? e.message : String(e);
}

export function Hash({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <code className="hash" title={value}>
      {value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value}
    </code>
  );
}
