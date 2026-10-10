// Process Studio (/admin/studio): the low-code workspace of an entity. Tabs: process map, rules, forms, simulator,
// integrations, activity, import/export. Administrators edit drafts; auditors read everything.
import { useState, type ReactNode } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, useAsync } from '../../components/ui';
import { DescribeChangeSlot, GettingStarted, HelpButton, HelpDrawer, STUDIO_TOPICS, useGettingStarted } from '../../components/ux';
import { lowcode, type Catalog, type Check, type Definition, type TriggerKind } from './api';
import { RulesTab } from './RulesTab';
import { FormsTab } from './FormsTab';
import { ActivityTab, IntegrationsTab, PackagesTab, SimulatorTab } from './OtherTabs';

type Tab = 'map' | 'rules' | 'forms' | 'simulator' | 'integrations' | 'activity' | 'packages';
const TABS: Tab[] = ['map', 'rules', 'forms', 'simulator', 'integrations', 'activity', 'packages'];
export const KIND_ICON: Record<TriggerKind, string> = { GATE: '⛔', EVENT: '⚡', SCHEDULE: '⏰' };

export default function StudioPage({ headerExtras }: { /** Slot for the separately built "describe a change" feature. */ headerExtras?: ReactNode } = {}) {
  const { t, pick } = useI18n();
  const { hasRole } = useSession();
  const canEdit = hasRole('TENANT_ADMIN');
  const [tab, setTab] = useState<Tab>('map');
  const [newRuleStage, setNewRuleStage] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const gs = useGettingStarted('studio');
  const cat = useAsync(() => lowcode.catalog(), []);
  const rulesets = useAsync(() => (canEdit && !gs.hidden ? lowcode.definitions('RULESET') : Promise.resolve([])), [canEdit, gs.hidden, tab]);
  const go = (k: Tab) => {
    setTab(k);
    requestAnimationFrame(() => document.getElementById(`lc-tab-${k}`)?.focus());
  };
  const liveRules = (rulesets.data ?? []).find((d) => d.status === 'PUBLISHED')?.definition?.rules?.length ?? 0;
  return (
    <div className="stack lc-studio">
      <header className="page-head">
        <h1>{t('lc.title')}</h1>
        <div className="row wrap ux-head-actions">
          <DescribeChangeSlot>{headerExtras}</DescribeChangeSlot>
          <HelpButton onClick={() => setHelp(true)} />
        </div>
      </header>
      <p className="lead">{t('lc.intro')}</p>
      {!canEdit && <div className="alert alert-info" role="status">{t('lc.readOnly')}</div>}
      {canEdit && !gs.hidden && cat.data && (
        <GettingStarted
          title={t('ux.gs.studio.title')}
          intro={t('ux.gs.studio.intro')}
          onDismiss={gs.dismiss}
          items={[
            { key: 'map', label: t('ux.gs.studio.map'), hint: t('ux.gs.studio.mapHint'), action: { label: t('lc.tab.map'), onClick: () => go('map') } },
            { key: 'form', label: t('ux.gs.studio.form'), hint: t('ux.gs.studio.formHint'), done: cat.data.liveForms.includes('TENDER'), action: { label: t('lc.tab.forms'), onClick: () => go('forms') } },
            { key: 'rule', label: t('ux.gs.studio.rule'), hint: t('ux.gs.studio.ruleHint'), done: rulesets.data ? liveRules > 0 : undefined, action: { label: t('lc.tab.rules'), onClick: () => go('rules') } },
            { key: 'sim', label: t('ux.gs.studio.sim'), hint: t('ux.gs.studio.simHint'), action: { label: t('lc.tab.simulator'), onClick: () => go('simulator') } },
            { key: 'publish', label: t('ux.gs.studio.publish'), hint: t('ux.gs.studio.publishHint') },
          ]}
        />
      )}
      <HelpDrawer open={help} onClose={() => setHelp(false)} topics={STUDIO_TOPICS} intro={t('ux.help.studioIntro')} onShowGettingStarted={canEdit && gs.hidden ? gs.show : undefined} />
      <div className="lc-tabs" role="tablist" aria-label={t('lc.title')}>
        {TABS.map((k) => (
          <button key={k} type="button" role="tab" id={`lc-tab-${k}`} aria-selected={tab === k} aria-controls={`lc-panel-${k}`}
            className={`lc-tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>
            {t(`lc.tab.${k}` as TKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`lc-panel-${tab}`} aria-labelledby={`lc-tab-${tab}`}>
        <AsyncView state={cat}>
          {(c) => (
            <>
              {tab === 'map' && <MapTab catalog={c} canEdit={canEdit} onAddRule={(stage) => { setNewRuleStage(stage); setTab('rules'); }} />}
              {tab === 'rules' && <RulesTab catalog={c} canEdit={canEdit} newRuleStage={newRuleStage} onConsumed={() => setNewRuleStage(null)} onCatalogChange={cat.reload} />}
              {tab === 'forms' && <FormsTab catalog={c} canEdit={canEdit} onPublished={cat.reload} />}
              {tab === 'simulator' && <SimulatorTab catalog={c} />}
              {tab === 'integrations' && <IntegrationsTab catalog={c} canEdit={canEdit} onChange={cat.reload} />}
              {tab === 'activity' && <ActivityTab canEdit={canEdit} />}
              {tab === 'packages' && <PackagesTab canEdit={canEdit} />}
            </>
          )}
        </AsyncView>
      </div>
      <Card title={t('lc.locked.title')}>
        <AsyncView state={cat}>
          {(c) => (
            <ul className="lc-locked">
              {c.lockedControls.map((l) => <li key={l.key}><span aria-hidden="true">🔒</span> {pick(l.en, l.ar)}</li>)}
            </ul>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- version bar
export function VersionBar({ live, draft, dirty, busy, canEdit, check, onStart, onSave, onCheck, onPublish, onDiscard, extra }: {
  live: Definition | null; draft: Definition | null; dirty: boolean; busy: string | null; canEdit: boolean; check: Check | null;
  onStart: () => void; onSave: () => void; onCheck: () => void; onPublish: () => void; onDiscard: () => void; extra?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="lc-verbar">
      <div className="row wrap">
        {live ? <Badge tone="success" label={t('lc.ver.live', { v: live.version })} /> : <Badge tone="neutral" label={t('lc.ver.none')} />}
        {draft && <Badge tone="warn" label={t('lc.ver.draft', { v: draft.version })} />}
        {dirty && <Badge tone="warn" label={t('lc.ver.unsaved')} />}
        {extra}
      </div>
      {canEdit && (
        <div className="row wrap">
          {!draft && <Button onClick={onStart} busy={busy === 'start'}>{live ? t('lc.ver.edit') : t('lc.ver.start')}</Button>}
          {draft && (
            <>
              <Button variant="secondary" onClick={onSave} busy={busy === 'save'} disabled={!dirty}>{t('lc.ver.save')}</Button>
              <Button variant="secondary" onClick={onCheck} busy={busy === 'check'}>{t('lc.ver.check')}</Button>
              <Button onClick={onPublish} busy={busy === 'publish'}>{t('lc.ver.publish')}</Button>
              <Button variant="ghost" onClick={onDiscard} busy={busy === 'discard'}>{t('lc.ver.discard')}</Button>
            </>
          )}
        </div>
      )}
      {check && (
        <div className={`alert ${check.valid ? 'alert-success' : 'alert-danger'}`} role="status">
          <div>
            <strong>{check.valid ? t('lc.ver.valid') : t('common.error')}</strong>
            {[...check.errors, ...check.warnings].length > 0 && <ul className="alert-list">{[...check.errors, ...check.warnings].map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </div>
        </div>
      )}
      {draft && canEdit && <p className="muted small">{t('lc.ver.fourEyes')}</p>}
    </div>
  );
}

export function History({ kind, code }: { kind: 'FORM' | 'RULESET'; code: string }) {
  const { t, te, fmtDate } = useI18n();
  const [open, setOpen] = useState(false);
  const h = useAsync(() => (open ? lowcode.history(kind, code) : Promise.resolve([])), [open, kind, code]);
  return (
    <details className="lc-history" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t('lc.ver.history')}</summary>
      <AsyncView state={h}>
        {(items) => (
          <ol className="lc-hist-list">
            {[...items].reverse().map((x) => (
              <li key={x.id}>
                <strong>v{x.version}</strong> <Badge value={x.status} tone={x.status === 'PUBLISHED' ? 'success' : x.status === 'DRAFT' ? 'warn' : 'neutral'} label={te('lc.status.', x.status)} />{' '}
                <span className="muted small">{fmtDate(x.publishedAt ?? x.updatedAt)}</span>{' '}
                <span className="small">{t('lc.ver.changes', { a: x.changes.added.length, r: x.changes.removed.length, c: x.changes.changed.length })}</span>
                {(x.changes.added.length > 0 || x.changes.removed.length > 0 || x.changes.changed.length > 0) && (
                  <div className="muted small">
                    {x.changes.added.map((k) => <code key={`a${k}`} className="lc-add">+{k}</code>)}
                    {x.changes.removed.map((k) => <code key={`r${k}`} className="lc-del">−{k}</code>)}
                    {x.changes.changed.map((k) => <code key={`c${k}`}>~{k}</code>)}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </AsyncView>
    </details>
  );
}

// ---------------------------------------------------------------- process map
function MapTab({ catalog, canEdit, onAddRule }: { catalog: Catalog; canEdit: boolean; onAddRule: (stage: string) => void }) {
  const { t, te, pick, lang } = useI18n();
  const [which, setWhich] = useState<'live' | 'draft'>('live');
  const defs = useAsync(() => lowcode.definitions('RULESET'), []);
  const draftId = defs.data?.find((d) => d.status === 'DRAFT')?.id;
  const map = useAsync(() => lowcode.processMap(which === 'draft' ? draftId : undefined), [which, draftId]);
  return (
    <Card title={t('lc.tab.map')} actions={draftId ? (
      <div className="row" role="group" aria-label={t('lc.map.showing', { which: '' })}>
        <Button variant={which === 'live' ? 'primary' : 'secondary'} onClick={() => setWhich('live')}>{t('lc.map.live')}</Button>
        <Button variant={which === 'draft' ? 'primary' : 'secondary'} onClick={() => setWhich('draft')}>{t('lc.map.draft')}</Button>
      </div>) : undefined}>
      <p className="muted">{t('lc.map.intro')}</p>
      <div className="lc-legend row wrap">
        {(['GATE', 'EVENT', 'SCHEDULE'] as TriggerKind[]).map((k) => (
          <span key={k} className={`lc-chip lc-${k.toLowerCase()}`} title={t(`lc.kind.${k}.hint` as TKey)}>{KIND_ICON[k]} {t(`lc.kind.${k}` as TKey)}</span>
        ))}
      </div>
      <AsyncView state={map}>
        {(m) => (
          <ol className="lc-flow" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            {m.stages.map((s) => (
              <li key={s.key} className={`lc-stage ${s.locked ? 'is-locked' : ''} ${s.enabled ? '' : 'is-off'}`}>
                <div className="lc-stage-head">
                  <strong>{te('cycle.stage.', s.key)}</strong>
                  {s.locked && <span className="lc-lock" title={pick(s.locked.en, s.locked.ar)} aria-label={pick(s.locked.en, s.locked.ar)}>🔒</span>}
                </div>
                {s.detail && <div className="muted small">{s.detail}</div>}
                {s.locked && <div className="small lc-lock-note">{pick(s.locked.en, s.locked.ar)}</div>}
                <ul className="lc-rule-chips">
                  {s.rules.map((r) => (
                    <li key={r.id} className={`lc-chip lc-${r.kind.toLowerCase()} ${r.enabled ? '' : 'is-off'}`}>
                      <span aria-hidden="true">{KIND_ICON[r.kind]}</span> <strong>{pick(r.nameEn, r.nameAr)}</strong>
                      <div className="small">{t('lc.rule.if')} {pick(r.whenEn, r.whenAr)}</div>
                      <ul className="small lc-acts">{r.actions.map((a, i) => <li key={i}>→ {pick(a.summaryEn, a.summaryAr)}</li>)}</ul>
                    </li>
                  ))}
                  {!s.rules.length && <li className="muted small">{t('lc.map.noRules')}</li>}
                </ul>
                {canEdit && catalog.triggers.some((tr) => tr.stage === s.key) && (
                  <Button variant="ghost" className="btn-sm" onClick={() => onAddRule(s.key)}>+ {t('lc.map.addRule')}</Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </AsyncView>
    </Card>
  );
}
