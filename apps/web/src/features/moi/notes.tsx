// Small, generic pieces the MOI workstream mounts on shared screens: cycle scope (designer + tender pages),
// approval service level, the vendor tender notes (pack after purchase, printable receipt) and the login
// "account suspended" message. Each one is a single import + one line on the host screen.
import { Link } from 'react-router-dom';
import { ApiError, type TenderDetail } from '../../api';
import type { CycleConfig } from '../../api-platform';
import { useI18n } from '../../i18n';
import { Field } from '../../components/ui';

export type Scope = NonNullable<CycleConfig['scope']>;
export const scopeOf = (cfg: { scope?: Scope } | null | undefined): Scope => (cfg?.scope === 'PUBLICATION_AND_SALE' ? 'PUBLICATION_AND_SALE' : 'FULL_CYCLE');
export const bidsInScope = (cfg: { scope?: Scope } | null | undefined) => scopeOf(cfg) === 'FULL_CYCLE';

/** Cycle Designer: where the cycle ends (generic; MOI Phase 1 ends at the document purchase). */
export function ScopeCard({ value, onChange }: { value: Scope | undefined; onChange: (s: Scope) => void }) {
  const { t } = useI18n();
  const v = value ?? 'FULL_CYCLE';
  return (
    <section className="card moi-scope-card" data-tour="cycle-scope">
      <header className="card-head">
        <h2 className="card-title">{t('moi.scope.title')}</h2>
      </header>
      <div className="card-body">
        <div className="segmented" role="radiogroup" aria-label={t('moi.scope.title')}>
          {(['FULL_CYCLE', 'PUBLICATION_AND_SALE'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={v === s} className={v === s ? 'on' : ''} onClick={() => onChange(s)}>
              {t(s === 'FULL_CYCLE' ? 'moi.scope.FULL_CYCLE' : 'moi.scope.PUBLICATION_AND_SALE')}
            </button>
          ))}
        </div>
        <p className="muted small">{t(v === 'FULL_CYCLE' ? 'moi.scope.hint.FULL_CYCLE' : 'moi.scope.hint.PUBLICATION_AND_SALE')}</p>
        {v === 'PUBLICATION_AND_SALE' && <OutOfScopeNote />}
      </div>
    </section>
  );
}

/** Approval level: optional service level in hours (stored with the template; escalation is a notifications feature). */
export function DueHoursField({ value, onChange }: { value: number | undefined; onChange: (h: number | undefined) => void }) {
  const { t } = useI18n();
  return (
    <Field label={t('moi.dueHours')} hint={t('moi.dueHoursHint')}>
      {(id, d) => (
        <input
          id={id}
          aria-describedby={d}
          type="number"
          min={1}
          max={8760}
          step={1}
          dir="ltr"
          className="moi-hours"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Math.max(1, Math.round(Number(e.target.value))))}
        />
      )}
    </Field>
  );
}

export function OutOfScopeNote({ id }: { id?: string }) {
  const { t } = useI18n();
  return (
    <div id={id} className="moi-scope-note" role="note" data-tour="out-of-scope">
      <strong>{t('moi.scope.outTitle')}</strong>
      <span>{t('moi.scope.outBody')}</span>
    </div>
  );
}

/** Vendor tender page: purchase-then-read (PUBLICATION_AND_SALE), printable receipt link (FR-007 / FR-022). */
export function VendorTenderNotes({ td }: { td: TenderDetail }) {
  const { t } = useI18n();
  const sale = !bidsInScope(td.cycle) && td.cycle?.stages.documentPurchase;
  const receipt = td.myPurchase?.receiptNumber;
  if (!sale && !receipt) return null;
  return (
    <div className="moi-tender-notes">
      {sale && !td.myPurchase && (
        <div className="alert alert-info" role="status">
          {t('moi.packLocked')}
        </div>
      )}
      {receipt && (
        <p className="row wrap">
          <Link className="btn btn-secondary" to={`/receipt/${encodeURIComponent(receipt)}`} data-tour="moi-receipt-link">
            {t('moi.receipt.open')}
          </Link>
          <span className="muted small">{t('moi.receipt.openHint')}</span>
        </p>
      )}
    </div>
  );
}

/** Login: a blocked vendor (FR-013 / FR-024) — shown only after the password was verified by the server. */
export function SuspendedNotice({ error }: { error: unknown }) {
  const { t, fmtDate } = useI18n();
  if (!(error instanceof ApiError) || error.code !== 'ACCOUNT_SUSPENDED') return null;
  const until = /until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(error.message)?.[1] ?? null;
  return (
    <div className="alert alert-danger moi-suspended" role="alert">
      <div>
        <strong>{until ? t('moi.suspended.until', { date: fmtDate(until) }) : t('moi.suspended.permanent')}</strong>
        <div className="small">{t('moi.suspended.body')}</div>
      </div>
    </div>
  );
}
export const isSuspendedError = (e: unknown) => e instanceof ApiError && e.code === 'ACCOUNT_SUSPENDED';
