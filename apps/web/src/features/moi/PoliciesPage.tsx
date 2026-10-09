// Entity policies (/admin/policies): the business rules an entity may still be deciding, as switches. For an entity
// configured from a requirements document (MOI BRD v0.1) each setting shows its BRD reference and whether the
// customer has confirmed it, KBM proposed it, or it is an open decision; plus the BRD's open items and which
// setting absorbs each one. Editing is TENANT_ADMIN only and audited (ENTITY_POLICIES_UPDATED with from/to).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Table, useAsync, useToast } from '../../components/ui';
import { moiApi, type Annotation, type Catalogue, type EntityPolicies, type LabelledCode, type OpenItem, type PolicyKey, type PoliciesResponse } from './api';

const FUNCTION_ROLES = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'TENANT_ADMIN', 'GRADING_AUTHORITY'];

type Kind = 'enum' | 'bool' | 'number' | 'currency' | 'days' | 'roles' | 'codes';
const SPEC: Record<PolicyKey, { kind: Kind; options?: string[] }> = {
  visibility: { kind: 'enum', options: ['CATEGORY', 'ELIGIBLE_ONLY'] },
  gradeMatch: { kind: 'enum', options: ['AT_LEAST', 'EXACT'] },
  gradeScope: { kind: 'enum', options: ['PER_ACTIVITY', 'COMPANY'] },
  subscriptionRequired: { kind: 'bool' },
  subscriptionFee: { kind: 'number' },
  subscriptionCurrency: { kind: 'currency' },
  subscriptionTermMonths: { kind: 'number' },
  subscriptionStart: { kind: 'enum', options: ['PAYMENT_DATE', 'APPROVAL_DATE'] },
  retainPurchasedAfterExpiry: { kind: 'bool' },
  renewalReminderDays: { kind: 'days' },
  exemptionMode: { kind: 'enum', options: ['PER_VENDOR', 'CATEGORY'] },
  exemptionWaives: { kind: 'enum', options: ['TENDER_DOCUMENTS', 'TENDER_DOCUMENTS_AND_SUBSCRIPTION'] },
  blockRoles: { kind: 'roles' },
  blockEffectOnSubscription: { kind: 'enum', options: ['CONTINUE', 'PAUSE'] },
  blockGrounds: { kind: 'codes' },
  gradingRoles: { kind: 'roles' },
  contentProtection: { kind: 'enum', options: ['NONE', 'VIEW_ONLY', 'WATERMARKED_DOWNLOAD'] },
  registrationDocuments: { kind: 'codes' },
  activityCodeSource: { kind: 'enum', options: ['MANUAL', 'FILE', 'MOC_API'] },
  accountProvisioning: { kind: 'enum', options: ['ADMIN_CREATED', 'AD_GROUPS'] },
};

const GROUPS: { key: string; title: TKey; keys: PolicyKey[] }[] = [
  { key: 'eligibility', title: 'moi.g.eligibility', keys: ['visibility', 'gradeMatch', 'gradeScope'] },
  { key: 'subscription', title: 'moi.g.subscription', keys: ['subscriptionRequired', 'subscriptionFee', 'subscriptionCurrency', 'subscriptionTermMonths', 'subscriptionStart', 'retainPurchasedAfterExpiry', 'renewalReminderDays'] },
  { key: 'exemption', title: 'moi.g.exemption', keys: ['exemptionMode', 'exemptionWaives'] },
  { key: 'blocking', title: 'moi.g.blocking', keys: ['blockRoles', 'blockEffectOnSubscription', 'blockGrounds'] },
  { key: 'functions', title: 'moi.g.functions', keys: ['gradingRoles', 'accountProvisioning'] },
  { key: 'content', title: 'moi.g.content', keys: ['contentProtection', 'registrationDocuments', 'activityCodeSource'] },
];

const STATUS_TONE: Record<string, string> = { CONFIRMED: 'success', PROPOSED: 'info', OPEN: 'warn', CONFIGURABLE: 'primary', AVAILABLE: 'info', IMPLEMENTED: 'success', NEEDS_MOI_INPUT: 'danger' };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function EntityPoliciesPage() {
  const { t } = useI18n();
  const state = useAsync(() => moiApi.policies(), []);
  return (
    <div className="stack moi-policies">
      <header className="page-head">
        <div>
          <h1>{t('moi.policies.title')}</h1>
          <p className="muted moi-lead">{t('moi.policies.subtitle')}</p>
        </div>
      </header>
      <AsyncView state={state}>{(d) => <PoliciesEditor data={d} onSaved={(x) => state.setData(x)} />}</AsyncView>
    </div>
  );
}

function PoliciesEditor({ data, onSaved }: { data: PoliciesResponse; onSaved: (d: PoliciesResponse) => void }) {
  const { t, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const canEdit = hasRole('TENANT_ADMIN');
  const [draft, setDraft] = useState<EntityPolicies>(() => clone(data.policies));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => setDraft(clone(data.policies)), [data]);
  const changed = useMemo(
    () => (Object.keys(draft) as PolicyKey[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(data.policies[k])),
    [draft, data.policies],
  );
  const cat = data.catalogue;
  const set = <K extends PolicyKey>(k: K, v: EntityPolicies[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, draft[k]])) as Partial<EntityPolicies>;
      const res = await moiApi.savePolicies(patch);
      onSaved(res);
      toast(t('moi.policies.saved', { n: changed.length }));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const counts = cat
    ? (Object.keys(SPEC) as PolicyKey[]).reduce<Record<string, number>>((m, k) => {
        const s = cat.annotations[k]?.status;
        if (s) m[s] = (m[s] ?? 0) + 1;
        return m;
      }, {})
    : null;

  return (
    <>
      {cat ? (
        <Card className="moi-ref-card">
          <div className="moi-ref">
            <div>
              <div className="muted small">{t('moi.policies.annotatedAgainst')}</div>
              <strong>{pick(cat.titleEn, cat.titleAr)}</strong>
            </div>
            <ul className="moi-legend" aria-label={t('moi.policies.legend')}>
              {(['CONFIRMED', 'PROPOSED', 'OPEN'] as const).map((s) => (
                <li key={s}>
                  <Badge tone={STATUS_TONE[s]} label={t(`moi.status.${s}` as TKey)} /> <span className="muted small">× {counts?.[s] ?? 0}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="small muted">{t('moi.policies.switchesNote')}</p>
        </Card>
      ) : (
        <p className="muted small">{t('moi.policies.noCatalogue')}</p>
      )}

      <div className="moi-savebar" data-tour="policies-save">
        <span className="small muted">
          {data.updatedAt ? t('moi.policies.lastChange', { date: fmtDate(data.updatedAt) }) : t('moi.policies.defaults')}
          {' · '}
          {t('moi.policies.audited')}
        </span>
        {canEdit ? (
          <div className="row wrap">
            {changed.length > 0 && <Badge tone="warn" label={t('moi.policies.unsaved', { n: changed.length })} />}
            <Button variant="secondary" disabled={!changed.length || busy} onClick={() => setDraft(clone(data.policies))}>
              {t('moi.policies.discard')}
            </Button>
            <Button busy={busy} disabled={!changed.length} onClick={save}>
              {t('common.save')}
            </Button>
          </div>
        ) : (
          <Badge tone="neutral" label={t('moi.policies.readOnly')} />
        )}
      </div>
      {err ? <ErrorBox error={err} /> : null}

      <div className="moi-groups">
        {GROUPS.map((g) => (
          <Card key={g.key} title={t(g.title)} id={`pol-${g.key}`}>
            <ul className="moi-settings">
              {g.keys.map((k) => (
                <SettingRow key={k} k={k} ann={cat?.annotations[k]} dirty={changed.includes(k)}>
                  <Control k={k} value={draft[k]} disabled={!canEdit} onChange={(v) => set(k, v as never)} />
                </SettingRow>
              ))}
            </ul>
            {g.key === 'exemption' && (
              <p className="small">
                <Link to="/admin/vendor-lifecycle#categories">{t('moi.policies.manageCategories')}</Link>
              </p>
            )}
            {g.key === 'content' && canEdit && <ActivityImport />}
          </Card>
        ))}
      </div>

      {cat && <OpenDecisions cat={cat} />}
    </>
  );
}

function SettingRow({ k, ann, dirty, children }: { k: PolicyKey; ann?: Annotation; dirty: boolean; children: ReactNode }) {
  const { t, pick } = useI18n();
  return (
    <li className={`moi-setting ${dirty ? 'moi-dirty' : ''}`} data-setting={k}>
      <div className="moi-setting-text">
        <div className="row wrap moi-setting-head">
          <strong>{t(`moi.p.${k}` as TKey)}</strong>
          {ann && <Badge tone={STATUS_TONE[ann.status]} label={t(`moi.status.${ann.status}` as TKey)} />}
        </div>
        {ann && (
          <div className="moi-ref-chip" dir="ltr">
            {ann.ref}
          </div>
        )}
        <p className="small muted">{ann ? pick(ann.en, ann.ar) : t(`moi.p.${k}.help` as TKey)}</p>
      </div>
      <div className="moi-setting-ctl">{children}</div>
    </li>
  );
}

function Control({ k, value, disabled, onChange }: { k: PolicyKey; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const { t, te } = useI18n();
  const spec = SPEC[k];
  const label = t(`moi.p.${k}` as TKey);
  switch (spec.kind) {
    case 'enum':
      return (
        <select aria-label={label} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {spec.options!.map((o) => (
            <option key={o} value={o}>
              {te(`moi.opt.${k}.`, o)}
            </option>
          ))}
        </select>
      );
    case 'bool':
      return (
        <label className="moi-switch">
          <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span>{t(value ? 'moi.on' : 'moi.off')}</span>
        </label>
      );
    case 'number':
      return (
        <input
          aria-label={label}
          type="number"
          dir="ltr"
          min={k === 'subscriptionTermMonths' ? 1 : 0}
          step={k === 'subscriptionTermMonths' ? 1 : 0.001}
          value={String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
      );
    case 'currency':
      return <input aria-label={label} dir="ltr" maxLength={3} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value.toUpperCase())} />;
    case 'days':
      return <DaysInput label={label} value={value as number[]} disabled={disabled} onChange={onChange} />;
    case 'roles':
      return (
        <div className="checks moi-roles" role="group" aria-label={label}>
          {FUNCTION_ROLES.map((r) => {
            const list = value as string[];
            return (
              <label key={r} className="check">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={list.includes(r)}
                  onChange={(e) => onChange(e.target.checked ? [...list, r] : list.filter((x) => x !== r))}
                />
                <span>{te('role.', r)}</span>
              </label>
            );
          })}
        </div>
      );
    case 'codes':
      return <CodesEditor label={label} value={value as LabelledCode[]} disabled={disabled} onChange={onChange} />;
  }
}

function DaysInput({ label, value, disabled, onChange }: { label: string; value: number[]; disabled: boolean; onChange: (v: unknown) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return (
    <div>
      <input
        aria-label={label}
        dir="ltr"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          const days = e.target.value
            .split(/[,\s،]+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map(Number);
          if (days.every((d) => Number.isInteger(d) && d > 0)) onChange(days);
        }}
      />
      <div className="muted small">{t('moi.daysHint')}</div>
    </div>
  );
}

function CodesEditor({ label, value, disabled, onChange }: { label: string; value: LabelledCode[]; disabled: boolean; onChange: (v: unknown) => void }) {
  const { t, pick } = useI18n();
  const [open, setOpen] = useState(false);
  const set = (i: number, patch: Partial<LabelledCode>) => onChange(value.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  if (!open)
    return (
      <div className="moi-codes-summary">
        <ul className="plain small">
          {value.map((c) => (
            <li key={c.code}>
              <code dir="ltr">{c.code}</code> — {pick(c.en, c.ar)}
            </li>
          ))}
        </ul>
        {!disabled && (
          <Button variant="ghost" onClick={() => setOpen(true)}>
            {t('moi.codes.edit')}
          </Button>
        )}
      </div>
    );
  return (
    <div className="moi-codes" role="group" aria-label={label}>
      {value.map((c, i) => (
        <div key={i} className="moi-code-row">
          <input aria-label={t('moi.codes.code')} dir="ltr" value={c.code} onChange={(e) => set(i, { code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <input aria-label={t('moi.codes.en')} dir="ltr" lang="en" value={c.en} onChange={(e) => set(i, { en: e.target.value })} />
          <input aria-label={t('moi.codes.ar')} dir="rtl" lang="ar" value={c.ar} onChange={(e) => set(i, { ar: e.target.value })} />
          <button type="button" className="btn btn-ghost" aria-label={t('moi.codes.remove', { code: c.code })} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row wrap">
        <Button variant="secondary" onClick={() => onChange([...value, { code: `NEW_${value.length + 1}`, en: '', ar: '' }])}>
          {t('moi.codes.add')}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t('common.close')}
        </Button>
      </div>
    </div>
  );
}

function absorbedLabel(ref: string, t: (k: TKey) => string): ReactNode {
  if (ref.startsWith('template:')) return <Link to="/admin/cycle">{t('moi.absorbed.template')} · <code dir="ltr">{ref.slice(9)}</code></Link>;
  if (ref.startsWith('profile:')) return <Link to="/admin/entity">{t('moi.absorbed.profile')} · <code dir="ltr">{ref.slice(8)}</code></Link>;
  return <a href={`#setting-${ref}`} onClick={(e) => {
    e.preventDefault();
    document.querySelector(`[data-setting="${ref}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }}>{t(`moi.p.${ref}` as TKey)}</a>;
}

function OpenDecisions({ cat }: { cat: Catalogue }) {
  const { t, pick } = useI18n();
  const byStatus = cat.openItems.reduce<Record<string, number>>((m, o) => ({ ...m, [o.status]: (m[o.status] ?? 0) + 1 }), {});
  return (
    <Card title={t('moi.open.title')} id="open-decisions">
      <p className="small muted">{t('moi.open.subtitle')}</p>
      <ul className="moi-legend">
        {(['CONFIGURABLE', 'AVAILABLE', 'IMPLEMENTED', 'NEEDS_MOI_INPUT'] as const).map((s) => (
          <li key={s}>
            <Badge tone={STATUS_TONE[s]} label={t(`moi.oi.${s}` as TKey)} /> <span className="muted small">× {byStatus[s] ?? 0}</span>
          </li>
        ))}
      </ul>
      <Table head={[t('moi.open.item'), t('common.status'), t('moi.open.absorbedBy'), t('moi.open.note')]}>
        {cat.openItems.map((o: OpenItem) => (
          <tr key={o.key}>
            <td>{pick(o.en, o.ar)}</td>
            <td>
              <Badge tone={STATUS_TONE[o.status]} label={t(`moi.oi.${o.status}` as TKey)} />
            </td>
            <td>
              {o.absorbedBy.length ? (
                <ul className="plain small">
                  {o.absorbedBy.map((r) => (
                    <li key={r}>{absorbedLabel(r, t)}</li>
                  ))}
                </ul>
              ) : (
                <span className="small muted">{t(o.status === 'NEEDS_MOI_INPUT' ? 'moi.open.notConfigurable' : 'moi.open.builtIn')}</span>
              )}
            </td>
            <td className="small">{pick(o.noteEn, o.noteAr)}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function ActivityImport() {
  const { t } = useI18n();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await moiApi.importActivityCodes(csv);
      toast(t('moi.import.done', { n: r.imported }));
      setCsv('');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="moi-import">
      <summary>{t('moi.import.title')}</summary>
      {err ? <ErrorBox error={err} /> : null}
      <Field label={t('moi.import.label')} hint={t('moi.import.hint')}>
        {(id, d) => <textarea id={id} aria-describedby={d} dir="ltr" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="SEC-101, Security systems, أنظمة الأمن" />}
      </Field>
      <Button variant="secondary" busy={busy} disabled={!csv.trim()} onClick={run}>
        {t('moi.import.run')}
      </Button>
    </details>
  );
}
