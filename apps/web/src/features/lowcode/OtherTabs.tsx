// Simulator, Integrations (webhooks), Activity (automation log) and Import / export tabs of the Process Studio.
import { useMemo, useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { api } from '../../api';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Modal, Table, errText, useAsync, useToast } from '../../components/ui';
import { lowcode, type Catalog, type Endpoint, type PackagePreview, type SimResult } from './api';
import { KIND_ICON } from './Studio';

const tone = (s: string) => (['OK', 'SENT', 'DONE', 'PUBLISHED'].includes(s) ? 'success' : ['ERROR', 'DEAD', 'BLOCKED'].includes(s) ? 'danger' : ['PARTIAL', 'FAILED', 'QUEUED', 'OPEN', 'DRAFT'].includes(s) ? 'warn' : 'neutral');

// ---------------------------------------------------------------- simulator
export function SimulatorTab({ catalog }: { catalog: Catalog }) {
  const { t, pick, lang } = useI18n();
  const [trigger, setTrigger] = useState('TENDER_SUBMIT');
  const [source, setSource] = useState<'SAMPLE' | 'TENDER'>('SAMPLE');
  const [tenderId, setTenderId] = useState('');
  const [which, setWhich] = useState<'live' | 'draft'>('live');
  const [facts, setFacts] = useState<Record<string, unknown>>({ 'tender.estimatedBudget': 750000, 'tender.category': 'IT' });
  const [res, setRes] = useState<SimResult | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const trig = catalog.triggers.find((x) => x.key === trigger)!;
  const defs = useAsync(() => lowcode.definitions('RULESET'), []);
  const draftId = defs.data?.find((d) => d.status === 'DRAFT')?.id;
  const tenders = useAsync(() => api.tenders(), []);
  const factList = catalog.facts[trig.scope].filter((f) => !f.key.startsWith('actor.'));
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      setRes(await lowcode.simulate({ trigger, ...(source === 'TENDER' ? { tenderId } : { facts }), ...(which === 'draft' && draftId ? { definitionId: draftId } : {}) }));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title={t('lc.tab.simulator')}>
      <p className="muted">{t('lc.sim.intro')}</p>
      <div className="grid-2">
        <Field label={t('lc.sim.trigger')}>{(id) => <select id={id} value={trigger} onChange={(e) => { setTrigger(e.target.value); setRes(null); }}>
          {catalog.triggers.map((x) => <option key={x.key} value={x.key}>{KIND_ICON[x.kind]} {pick(x.labelEn, x.labelAr)}</option>)}
        </select>}</Field>
        <Field label={t('lc.sim.ruleset')}>{(id) => <select id={id} value={which} onChange={(e) => setWhich(e.target.value as 'live' | 'draft')}>
          <option value="live">{t('lc.map.live')}</option>{draftId && <option value="draft">{t('lc.map.draft')}</option>}
        </select>}</Field>
        {(trig.scope === 'TENDER' || trig.scope === 'AWARD') && (
          <Field label={t('lc.sim.source')}>{(id) => <select id={id} value={source} onChange={(e) => setSource(e.target.value as 'SAMPLE' | 'TENDER')}>
            <option value="SAMPLE">{t('lc.sim.sample')}</option><option value="TENDER">{t('lc.sim.tender')}</option>
          </select>}</Field>
        )}
        {source === 'TENDER' && (trig.scope === 'TENDER' || trig.scope === 'AWARD') && (
          <Field label={t('lc.sim.pickTender')}>{(id) => <select id={id} value={tenderId} onChange={(e) => setTenderId(e.target.value)}>
            <option value="">—</option>{(tenders.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.tenderNumber} — {pick(x.titleEn, x.titleAr)}</option>)}
          </select>}</Field>
        )}
      </div>
      {(source === 'SAMPLE' || !(trig.scope === 'TENDER' || trig.scope === 'AWARD')) && (
        <div className="lc-facts">
          {factList.map((f) => (
            <Field key={f.key} label={pick(f.labelEn, f.labelAr)} hint={<code>{f.key}</code>}>
              {(id) => f.type === 'boolean'
                ? <select id={id} value={facts[f.key] === undefined ? '' : String(facts[f.key])} onChange={(e) => setFacts({ ...facts, [f.key]: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">—</option><option value="true">{t('common.yes')}</option><option value="false">{t('common.no')}</option></select>
                : f.options && f.type !== 'list'
                  ? <select id={id} value={String(facts[f.key] ?? '')} onChange={(e) => setFacts({ ...facts, [f.key]: e.target.value || undefined })}><option value="">—</option>{f.options.map((o) => <option key={o.value} value={o.value}>{pick(o.labelEn, o.labelAr)}</option>)}</select>
                  : <input id={id} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={String(facts[f.key] ?? '')}
                    onChange={(e) => setFacts({ ...facts, [f.key]: e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value })} />}
            </Field>
          ))}
        </div>
      )}
      <Button onClick={run} busy={busy} disabled={source === 'TENDER' && !tenderId && (trig.scope === 'TENDER' || trig.scope === 'AWARD')}>{t('lc.sim.run')}</Button>
      {err ? <ErrorBox error={err} /> : null}
      {res && (
        <div className="stack lc-sim">
          {!res.results.length && <p className="muted">{t('lc.sim.noRules')}</p>}
          <ul className="lc-rules">
            {res.results.map((r) => (
              <li key={r.ruleId} className={`lc-rule ${r.matched ? 'is-hit' : 'is-miss'}`}>
                <Badge tone={r.matched ? 'success' : 'neutral'} label={!r.enabled ? t('lc.sim.off') : r.matched ? t('lc.sim.matched') : t('lc.sim.notMatched')} />{' '}
                <strong>{pick(r.nameEn, r.nameAr)}</strong>
                <div className="small">{t('lc.rule.if')} {pick(r.whenEn, r.whenAr)}</div>
                {r.matched && <ul className="small lc-acts">{r.actions.map((a, i) => <li key={i}>→ {pick(a.summaryEn, a.summaryAr)}</li>)}</ul>}
              </li>
            ))}
          </ul>
          {res.gate && (
            <div className={`alert ${res.gate.passes ? 'alert-success' : 'alert-danger'}`} role="status">
              <div>
                <strong>{res.gate.passes ? t('lc.sim.passes') : t('lc.sim.blocked')}</strong>
                {res.gate.blocks.map((b) => <div key={b.ruleId}>⛔ {pick(b.messageEn, b.messageAr)}</div>)}
                {res.gate.requiredFields.map((f) => <div key={f.ruleId}>{t('lc.proc.missingFields', { list: f.fields.join(', ') })}</div>)}
              </div>
            </div>
          )}
          {res.gate && (
            <div>
              <h4>{t('lc.sim.chain')}</h4>
              <ol className="lc-chain" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                {res.gate.chain.map((l, i) => (
                  <li key={i} className={l.added ? 'is-added' : ''}>{pick(l.labelEn, l.labelAr) || t(`role.${l.role}` as TKey)}{l.added && <> <Badge tone="info" label={t('lc.sim.added')} /></>}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- integrations
export function IntegrationsTab({ catalog, canEdit, onChange }: { catalog: Catalog; canEdit: boolean; onChange: () => void }) {
  const { t, te, pick, fmtDate } = useI18n();
  const toast = useToast();
  const eps = useAsync(() => lowcode.endpoints(), []);
  const dels = useAsync(() => lowcode.deliveries(), []);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const events = catalog.triggers.filter((x) => x.kind !== 'GATE');
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); eps.reload(); dels.reload(); onChange(); } catch (e) { toast(errText(e), 'error'); } };
  return (
    <div className="stack">
      <Card title={t('lc.tab.integrations')} actions={canEdit ? <Button onClick={() => setAdding(true)}>+ {t('lc.hook.add')}</Button> : undefined}>
        <p className="muted">{t('lc.hook.intro')}</p>
        <AsyncView state={eps}>
          {(list) => (
            <ul className="lc-rules">
              {list.map((e: Endpoint) => (
                <li key={e.id} className="lc-rule">
                  <div className="row spread wrap">
                    <div>
                      <strong>{e.name}</strong> <code>{e.code}</code> <Badge tone={e.enabled ? 'success' : 'neutral'} label={e.enabled ? t('lc.hook.enabled') : t('lc.hook.disabled')} />
                      <div className="muted small mono" dir="ltr">{e.url}</div>
                      <div className="small">{e.events.map((ev) => pick(events.find((x) => x.key === ev)?.labelEn, events.find((x) => x.key === ev)?.labelAr)).join(' · ') || '—'}</div>
                      {e.stats && <div className="small muted">{t('lc.hook.stats', { sent: e.stats.sent, failed: e.stats.failed, queued: e.stats.queued })}</div>}
                    </div>
                    {canEdit && (
                      <div className="row wrap">
                        <Button variant="secondary" className="btn-sm" onClick={() => act(() => lowcode.updateEndpoint(e.id, { enabled: !e.enabled }))}>{e.enabled ? t('lc.hook.disabled') : t('lc.hook.enabled')}</Button>
                        <Button variant="secondary" className="btn-sm" onClick={() => act(async () => { const d = await lowcode.testEndpoint(e.id); toast(`${te('lc.status.', d.status)}${d.lastError ? ` — ${d.lastError}` : ''}`, d.status === 'SENT' ? 'success' : 'error'); })}>{t('lc.hook.test')}</Button>
                        <Button variant="ghost" className="btn-sm" onClick={() => act(async () => setSecret((await lowcode.rotateSecret(e.id)).secret))}>{t('lc.hook.rotate')}</Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </AsyncView>
      </Card>
      <Card title={t('lc.hook.deliveries')}>
        <AsyncView state={dels}>
          {(list) => (
            <Table head={[t('common.date'), t('lc.hook.code'), t('lc.act.trigger'), t('common.status'), t('lc.hook.attempts'), t('lc.hook.result'), '']}>
              {list.map((d) => (
                <tr key={d.id}>
                  <td>{fmtDate(d.createdAt)}</td><td><code>{d.code}</code></td><td>{d.event}</td>
                  <td><Badge tone={tone(d.status)} label={te('lc.status.', d.status)} /></td><td>{d.attempts}</td>
                  <td className="small">{d.lastStatus ?? ''} {d.lastError ?? ''}</td>
                  <td>{canEdit && d.status !== 'SENT' && <Button variant="ghost" className="btn-sm" onClick={() => act(() => lowcode.retryDelivery(d.id))}>{t('lc.hook.retry')}</Button>}</td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
      {adding && <AddEndpoint events={events.map((e) => ({ key: e.key, label: pick(e.labelEn, e.labelAr) }))} onClose={() => setAdding(false)}
        onCreated={(s) => { setAdding(false); setSecret(s); eps.reload(); onChange(); }} />}
      <Modal open={!!secret} title={t('lc.hook.secretTitle')} onClose={() => setSecret(null)} footer={<Button onClick={() => setSecret(null)}>{t('common.done')}</Button>}>
        <p>{t('lc.hook.secretNote')}</p>
        <pre className="lc-secret" dir="ltr">{secret}</pre>
      </Modal>
    </div>
  );
}

function AddEndpoint({ events, onClose, onCreated }: { events: { key: string; label: string }[]; onClose: () => void; onCreated: (secret: string) => void }) {
  const { t } = useI18n();
  const [b, setB] = useState({ code: '', name: '', url: 'https://', events: [] as string[] });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try { onCreated((await lowcode.createEndpoint(b)).secret); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open title={t('lc.hook.add')} onClose={onClose} footer={<div className="row"><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button busy={busy} onClick={save}>{t('common.save')}</Button></div>}>
      <div className="stack">
        <Field label={t('lc.hook.code')} required>{(id) => <input id={id} dir="ltr" value={b.code} onChange={(e) => setB({ ...b, code: e.target.value.toLowerCase() })} placeholder="finance-erp" />}</Field>
        <Field label={t('lc.hook.name')} required>{(id) => <input id={id} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />}</Field>
        <Field label={t('lc.hook.url')} required>{(id) => <input id={id} dir="ltr" type="url" value={b.url} onChange={(e) => setB({ ...b, url: e.target.value })} />}</Field>
        <fieldset><legend>{t('lc.hook.events')}</legend>
          <div className="lc-grid">{events.map((e) => (
            <label key={e.key} className="check small"><input type="checkbox" checked={b.events.includes(e.key)} onChange={(x) => setB({ ...b, events: x.target.checked ? [...b.events, e.key] : b.events.filter((k) => k !== e.key) })} /> {e.label}</label>
          ))}</div>
        </fieldset>
        {err ? <ErrorBox error={err} /> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- activity
export function ActivityTab({ canEdit }: { canEdit: boolean }) {
  const { t, te, fmtDate } = useI18n();
  const toast = useToast();
  const runs = useAsync(() => lowcode.runs(), []);
  return (
    <Card title={t('lc.tab.activity')} actions={canEdit ? <Button variant="secondary" onClick={async () => { try { await lowcode.runNow(); runs.reload(); } catch (e) { toast(errText(e), 'error'); } }}>{t('lc.act.runNow')}</Button> : undefined}>
      <p className="muted">{t('lc.act.log.intro')}</p>
      <AsyncView state={runs}>
        {(list) => (
          <Table head={[t('common.date'), t('lc.act.trigger'), t('lc.act.rule'), t('lc.act.subject'), t('common.status'), t('lc.act.outcome')]}>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.createdAt)}</td><td>{r.trigger}</td><td>{r.ruleName} <span className="muted small">v{r.rulesetVersion ?? '—'}</span></td>
                <td>{r.subjectRef}</td><td><Badge tone={tone(r.status)} label={te('lc.status.', r.status)} /></td>
                <td className="small">{Array.isArray(r.outcome) ? r.outcome.map((o: any, i: number) => <div key={i}>{o.ok ? '✓' : '✗'} {o.action}: {o.detail}</div>)
                  : Object.entries(r.outcome ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => <div key={k}>{k}: {JSON.stringify(v)}</div>)}</td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
    </Card>
  );
}

// ---------------------------------------------------------------- packages
export function PackagesTab({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [pkg, setPkg] = useState<unknown>(null);
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [done, setDone] = useState<{ created: { kind: string; code: string; version?: number }[]; integrationSecrets: { code: string; secret: string }[]; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const download = async () => {
    setBusy('export');
    try {
      const p = await lowcode.exportPackage();
      const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tenderflow-process-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); }
  };
  const onFile = async (f: File | undefined) => {
    setPreview(null); setDone(null);
    if (!f) return;
    try { setPkg(JSON.parse(await f.text())); } catch { toast(t('lc.pkg.badJson'), 'error'); setPkg(null); }
  };
  const items = useMemo(() => preview?.items ?? [], [preview]);
  if (!canEdit) return <Card title={t('lc.tab.packages')}><p className="muted">{t('lc.readOnly')}</p></Card>;
  return (
    <Card title={t('lc.tab.packages')}>
      <p className="muted">{t('lc.pkg.intro')}</p>
      <Button onClick={download} busy={busy === 'export'}>{t('lc.pkg.export')}</Button>
      <h3>{t('lc.pkg.import')}</h3>
      <Field label={t('lc.pkg.choose')}>{(id) => <input id={id} type="file" accept="application/json,.json" onChange={(e) => onFile(e.target.files?.[0])} />}</Field>
      <div className="row">
        <Button variant="secondary" disabled={!pkg} busy={busy === 'preview'} onClick={async () => { setBusy('preview'); try { setPreview(await lowcode.previewPackage(pkg)); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); } }}>{t('lc.pkg.preview')}</Button>
        <Button disabled={!preview?.valid} busy={busy === 'import'} onClick={async () => { setBusy('import'); try { setDone(await lowcode.importPackage(pkg)); setPreview(null); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); } }}>{t('lc.pkg.confirm')}</Button>
      </div>
      {preview && (
        <div className="stack-sm">
          {preview.source && <p>{t('lc.pkg.source', { name: String(preview.source.nameEn ?? preview.source.entity) })}</p>}
          {!preview.checksumOk && <div className="alert alert-warn">{t('lc.pkg.checksumBad')}</div>}
          {preview.errors.length > 0 && <div className="alert alert-danger"><ul className="alert-list">{preview.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
          <Table head={[t('common.type'), t('lc.hook.code'), t('common.actions'), t('common.notes')]}>
            {items.map((x, i) => <tr key={i}><td>{x.kind}</td><td><code>{x.code}</code></td><td>{x.action}</td><td className="small">{x.note ?? ''}</td></tr>)}
          </Table>
        </div>
      )}
      {done && (
        <div className="stack-sm">
          <div className="alert alert-success">{t('lc.pkg.done')}</div>
          <ul>{done.created.map((c, i) => <li key={i}>{c.kind} <code>{c.code}</code>{c.version ? ` v${c.version}` : ''}</li>)}</ul>
          {done.integrationSecrets.length > 0 && (<>
            <h4>{t('lc.pkg.secrets')}</h4>
            {done.integrationSecrets.map((s) => <div key={s.code}><code>{s.code}</code>: <pre className="lc-secret" dir="ltr">{s.secret}</pre></div>)}
          </>)}
        </div>
      )}
    </Card>
  );
}
