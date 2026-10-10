// Low-code in the daily screens: the tender "process" panel (custom values, gate readiness, rule-added approvers,
// tasks, recent automation), the vendor's view of public custom values, and "My tasks".
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, Field, Modal, errText, useAsync, useToast } from '../../components/ui';
import { lowcode, type GateCheck, type Task, type TenderProcess } from './api';
import { CustomFieldsForm, CustomValuesView } from './CustomFields';

export function TenderProcessPanel({ tenderId, staff, reloadKey }: { tenderId: string; staff: boolean; reloadKey?: unknown }) {
  const { t } = useI18n();
  const p = useAsync(() => lowcode.tenderProcess(tenderId), [tenderId, reloadKey]);
  return (
    <AsyncView state={p}>
      {(d) => (!staff && !d.values.length ? null : (
        <Card title={staff ? t('lc.proc.title') : t('lc.proc.values')} id="tender-process">
          <ProcessBody d={d} staff={staff} onChanged={p.reload} />
        </Card>
      ))}
    </AsyncView>
  );
}

function ProcessBody({ d, staff, onChanged }: { d: TenderProcess; staff: boolean; onChanged: () => void }) {
  const { t, te, fmtDate } = useI18n();
  return (
    <div className="stack">
      <CustomValuesView values={d.values} sections={d.form?.definition.sections} empty={t('lc.proc.noValues')} />
      {staff && (
        <>
          <p className="muted small">{d.ruleset ? t('lc.proc.rules', { v: d.ruleset.version }) : t('lc.proc.noRules')}</p>
          {d.gates && Object.entries(d.gates).map(([g, c]) => <GateView key={g} gate={g} c={c} />)}
          {!!d.tasks?.length && (
            <div>
              <h4>{t('lc.proc.tasks')}</h4>
              <TaskList tasks={d.tasks} onChanged={onChanged} />
            </div>
          )}
          {!!d.runs?.length && (
            <details>
              <summary>{t('lc.proc.recent')}</summary>
              <ul className="small">
                {d.runs.map((r, i) => <li key={i}>{fmtDate(r.createdAt)} · {r.trigger} · {r.ruleName} · <Badge tone={r.status === 'OK' ? 'success' : r.status === 'BLOCKED' ? 'danger' : 'warn'} label={te('lc.status.', r.status)} /></li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function GateView({ gate, c }: { gate: string; c: GateCheck }) {
  const { t, pick, lang } = useI18n();
  return (
    <div className={`lc-gatebox ${c.passed ? 'is-ok' : 'is-blocked'}`}>
      <div className="row wrap">
        <strong>{t(`lc.proc.gate.${gate}` as TKey)}</strong>
        <Badge tone={c.passed ? 'success' : 'danger'} label={c.passed ? t('lc.proc.ready') : t('lc.proc.notReady')} />
      </div>
      <ul className="small">
        {c.blocks.map((b) => <li key={b.ruleId}>⛔ {t('lc.proc.blockedBy', { rule: pick(b.ruleNameEn, b.ruleNameAr), msg: pick(b.messageEn, b.messageAr) })}</li>)}
        {c.missingFields.length > 0 && <li>✎ {t('lc.proc.missingFields', { list: c.missingFields.map((f) => pick(f.labelEn, f.labelAr)).join(lang === 'ar' ? '، ' : ', ') })}</li>}
        {c.missingDocuments.map((x) => <li key={x.ruleId}>📄 {t('lc.proc.missingDocs', { rule: pick(x.ruleNameEn, x.ruleNameAr), n: x.minCount, title: x.titleContains ? ` «${x.titleContains}»` : '', found: x.found })}</li>)}
        {c.openTasks.length > 0 && <li>☐ {t('lc.proc.openTasks', { list: c.openTasks.map((x) => pick(x.titleEn, x.titleAr)).join('; ') })}</li>}
        {c.addLevels.map((l) => <li key={l.ruleId + l.role}>➕ {t('lc.proc.extraApprover', { label: pick(l.labelEn, l.labelAr), rule: pick(l.ruleNameEn, l.ruleNameAr) })}</li>)}
      </ul>
    </div>
  );
}

function TaskList({ tasks, onChanged, showSubject }: { tasks: Task[]; onChanged: () => void; showSubject?: boolean }) {
  const { t, te, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const [closing, setClosing] = useState<Task | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <ul className="lc-tasks">
        {tasks.map((x) => (
          <li key={x.id} className={`lc-task ${x.status === 'OPEN' ? '' : 'is-closed'} ${x.overdue ? 'is-overdue' : ''}`}>
            <div className="row spread wrap">
              <div>
                <strong>{pick(x.titleEn, x.titleAr)}</strong>{' '}
                <Badge tone={x.status === 'OPEN' ? (x.overdue ? 'danger' : 'warn') : x.status === 'DONE' ? 'success' : 'neutral'} label={x.overdue ? t('lc.task.overdue') : te('lc.status.', x.status)} />
                <div className="muted small">
                  {t(`role.${x.role}` as TKey)}
                  {x.blocksGate && <> · {t('lc.task.blocks', { gate: t(`lc.proc.gate.${x.blocksGate}` as TKey) })}</>}
                  {x.dueAt && <> · {t('lc.task.due', { date: fmtDate(x.dueAt) })}</>}
                  {showSubject && x.subjectRef && <> · {t('lc.task.about')}: {x.subjectType === 'TENDER' && x.subjectId ? <Link to={`/procurement/tenders/${x.subjectId}`}>{x.subjectRef}</Link> : x.subjectRef}</>}
                </div>
                {x.note && <div className="small">“{x.note}”</div>}
              </div>
              {x.status === 'OPEN' && hasRole(x.role as never, 'TENANT_ADMIN') && (
                <Button variant="secondary" className="btn-sm" onClick={() => { setClosing(x); setNote(''); }}>{t('lc.proc.complete')}</Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Modal open={!!closing} title={closing ? pick(closing.titleEn, closing.titleAr) : ''} onClose={() => setClosing(null)}
        footer={<div className="row"><Button variant="secondary" onClick={() => setClosing(null)}>{t('common.cancel')}</Button>
          <Button busy={busy} disabled={!!closing?.blocksGate && !note.trim()} onClick={async () => {
            if (!closing) return;
            setBusy(true);
            try { await lowcode.completeTask(closing.id, note); setClosing(null); onChanged(); toast(t('common.done')); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
          }}>{t('lc.proc.complete')}</Button></div>}>
        <Field label={t('lc.proc.note')} hint={closing?.blocksGate ? t('lc.proc.noteRequired') : undefined} required={!!closing?.blocksGate}>
          {(id, dsc) => <textarea id={id} aria-describedby={dsc} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </Modal>
    </>
  );
}

export function MyTasksPage() {
  const { t } = useI18n();
  const tasks = useAsync(() => lowcode.tasks({ status: 'OPEN' }), []);
  return (
    <div className="stack">
      <header className="page-head"><h1>{t('lc.task.myTitle')}</h1></header>
      <p className="lead">{t('lc.task.intro')}</p>
      <Card>
        <AsyncView state={tasks} empty={t('lc.task.none')}>{(list) => <TaskList tasks={list} onChanged={tasks.reload} showSubject />}</AsyncView>
      </Card>
    </div>
  );
}

/** Compact list for dashboards (renders nothing when there are no open tasks). */
export function MyTasksWidget() {
  const { t } = useI18n();
  const tasks = useAsync(() => lowcode.tasks({ status: 'OPEN' }).catch(() => [] as Task[]), []);
  if (!tasks.data?.length) return null;
  return (
    <Card title={`${t('lc.task.myTitle')} (${tasks.data.length})`} actions={<Link to="/procurement/tasks">{t('common.view')}</Link>}>
      <TaskList tasks={tasks.data.slice(0, 5)} onChanged={tasks.reload} showSubject />
    </Card>
  );
}


/** Staff view of a vendor's custom fields, with editing of all fields (incl. internal ones such as a risk rating). */
export function VendorCustomFields({ vendorId, custom, canEdit, onSaved }: {
  vendorId: string; canEdit: boolean; onSaved?: () => void;
  custom: { form: { definition: import('./api').FormDefinition } | null; values: import('./api').CustomValue[]; raw?: Record<string, unknown> } | null | undefined;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!custom?.form) return null;
  const def = custom.form.definition;
  return (
    <section className="stack-sm">
      <div className="row spread"><h3>{t('lc.proc.values')}</h3>
        {canEdit && !edit && <Button variant="ghost" className="btn-sm" onClick={() => setEdit({ ...(custom.raw ?? {}) })}>{t('lc.edit')}</Button>}</div>
      {edit ? (
        <>
          <CustomFieldsForm definition={def} values={edit} onChange={setEdit} showAudience />
          <div className="row">
            <Button variant="secondary" onClick={() => setEdit(null)}>{t('common.cancel')}</Button>
            <Button busy={busy} onClick={async () => {
              setBusy(true);
              try {
                await lowcode.updateVendorCustom(vendorId, Object.fromEntries(Object.entries(edit).filter(([k]) => def.fields.some((f) => f.key === k && f.type !== 'computed'))));
                setEdit(null); toast(t('common.saved')); onSaved?.();
              } catch (e) { toast(errText(e), 'error'); } finally { setBusy(false); }
            }}>{t('common.save')}</Button>
          </div>
        </>
      ) : <CustomValuesView values={custom.values} sections={def.sections} empty={t('lc.proc.noValues')} />}
    </section>
  );
}
