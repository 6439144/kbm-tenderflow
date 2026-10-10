// Approval chain editor for the Cycle Designer and the new-template wizard: one card per level, decided in order.
// Levels can be reordered by drag and drop (handle) or with the move up / down buttons (keyboard). Quick presets
// cover the common chains; the server (parseConfig) still validates every chain (1–5 levels, allowed roles, hours).
import type { ApprovalLevel } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { Button, Field } from '../../components/ui';
import { DragHandle, DurationInput, moveItem, useDragOrder } from '../../components/ux';
import { APPROVER_ROLES, roleLabels } from './common';

export const CHAIN_PRESETS: { key: string; roles: string[] }[] = [
  { key: 'director', roles: ['DIRECTOR'] },
  { key: 'directorUnder', roles: ['DIRECTOR', 'UNDERSECRETARY'] },
  { key: 'under', roles: ['UNDERSECRETARY'] },
];

const sameRoles = (a: ApprovalLevel[], roles: string[]) => a.length === roles.length && a.every((l, i) => l.role === roles[i]);

export function ChainPresets({ value, onChange }: { value: ApprovalLevel[]; onChange: (v: ApprovalLevel[]) => void }) {
  const { t } = useI18n();
  return (
    <div className="cyc-presets" role="group" aria-label={t('ux.chain.presets')}>
      <span className="muted small">{t('ux.chain.presets')}:</span>
      {CHAIN_PRESETS.map((p) => {
        const on = sameRoles(value, p.roles);
        return (
          <button
            key={p.key}
            type="button"
            className={`ux-pill ${on ? 'on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(p.roles.map((role, i) => ({ role, ...roleLabels(role), ...(value[i]?.role === role && value[i].dueHours ? { dueHours: value[i].dueHours } : {}) })))}
          >
            {t(`ux.chain.preset.${p.key}` as TKey)}
          </button>
        );
      })}
    </div>
  );
}

export function ChainEditor({ title, hint, value, onChange, invalid }: {
  title: string; hint?: string; value: ApprovalLevel[]; onChange: (v: ApprovalLevel[]) => void; invalid?: boolean;
}) {
  const { t, te, pick } = useI18n();
  const set = (i: number, patch: Partial<ApprovalLevel>) => onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, j: number) => onChange(moveItem(value, i, j));
  const dnd = useDragOrder(value.length, move);
  return (
    <div className={`cyc-chain-editor ${invalid ? 'is-invalid' : ''}`}>
      <div className="row spread">
        <h3>{title}</h3>
        <span className="muted small">{t('cycle.levels', { n: value.length })}</span>
      </div>
      {hint && <p className="muted small cyc-chain-hint">{hint}</p>}
      <ChainPresets value={value} onChange={onChange} />
      <ol className="cyc-chain-rows">
        {value.map((l, i) => {
          const r = dnd.row(i);
          return (
            <li key={i} {...r} className={`cyc-chain-row ${r.className}`}>
              <div className="cyc-level-top">
                <DragHandle label={t('ux.drag.hint')} {...dnd.handle(i)} />
                <span className="cyc-chain-idx" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="cyc-level-title">
                  <strong>{pick(l.labelEn, l.labelAr) || te('role.', l.role)}</strong>
                  <span className="muted small">
                    {value.length === 1 ? t('ux.chain.only') : i === 0 ? t('ux.chain.first') : i === value.length - 1 ? t('ux.chain.last') : t('ux.chain.next')}
                  </span>
                </span>
                <span className="cyc-chain-btns">
                  <button type="button" className="btn btn-ghost cyc-icon" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={t('cycle.d.moveUp', { n: i + 1 })}>
                    ▲
                  </button>
                  <button type="button" className="btn btn-ghost cyc-icon" onClick={() => move(i, i + 1)} disabled={i === value.length - 1} aria-label={t('cycle.d.moveDown', { n: i + 1 })}>
                    ▼
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost cyc-icon"
                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                    disabled={value.length <= 1}
                    aria-label={t('cycle.d.removeLevel', { n: i + 1 })}
                    title={value.length <= 1 ? t('ux.chain.needOne') : undefined}
                  >
                    ✕
                  </button>
                </span>
              </div>
              <div className="cyc-chain-fields">
                <Field label={t('ux.chain.who')}>
                  {(id) => (
                    <select
                      id={id}
                      value={l.role}
                      onChange={(e) => {
                        const role = e.target.value;
                        const prev = roleLabels(l.role);
                        const autoLabels = l.labelEn === prev.labelEn && l.labelAr === prev.labelAr;
                        set(i, autoLabels ? { role, ...roleLabels(role) } : { role });
                      }}
                    >
                      {APPROVER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {te('role.', r)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <DurationInput label={t('ux.chain.due')} hint={t('moi.dueHoursHint')} value={l.dueHours} onChange={(h) => set(i, { dueHours: h })} />
                <details className="cyc-level-labels">
                  <summary>{t('ux.chain.labels')}</summary>
                  <div className="grid-2">
                    <Field label={t('cycle.d.labelEn')}>{(id) => <input id={id} value={l.labelEn} onChange={(e) => set(i, { labelEn: e.target.value })} dir="ltr" lang="en" />}</Field>
                    <Field label={t('cycle.d.labelAr')}>{(id) => <input id={id} value={l.labelAr} onChange={(e) => set(i, { labelAr: e.target.value })} dir="rtl" lang="ar" />}</Field>
                  </div>
                </details>
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        variant="secondary"
        disabled={value.length >= 5}
        disabledReason={value.length >= 5 ? t('ux.chain.max') : undefined}
        onClick={() => onChange([...value, { role: 'UNDERSECRETARY', ...roleLabels('UNDERSECRETARY') }])}
      >
        + {t('cycle.d.addLevel')}
      </Button>
      <p className="muted small cyc-chain-sod">{t('ux.chain.sod')}</p>
    </div>
  );
}
