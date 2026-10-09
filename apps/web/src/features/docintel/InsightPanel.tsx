// "Data" panel of one document: what Orchestrate extracted (with the exact quote and section for every value), the
// rule-based flags computed by TenderFlow, and the human review (accept / correct inline / reject). For an accepted
// MOCI classification certificate the officer can create the vendor classification from it (confirmed, never automatic).
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { platform } from '../../api-platform';
import { AsyncView, Badge, Button, ErrorBox, Field, Modal, ReasonDialog, Table, useAsync, useToast, errText } from '../../components/ui';
import { docintelApi, type DocInsightState, type Insight, type InsightField } from './api';
import { FlagChips, OrchestrateIcon, useFmt } from './common';

export function InsightModal({
  documentId,
  title,
  storeType,
  initial,
  onClose,
  onChanged,
}: {
  documentId: string;
  title: string;
  storeType?: string;
  initial?: DocInsightState;
  onClose: () => void;
  onChanged?: (s: DocInsightState) => void;
}) {
  const { t } = useI18n();
  const state = useAsync(() => docintelApi.insight(documentId), [documentId]);
  const s = state.data ?? initial;
  // Keep polling while Orchestrate is reading the document.
  useEffect(() => {
    if (!state.data?.queued) return;
    const h = setTimeout(state.reload, 2000);
    return () => clearTimeout(h);
  }, [state.data, state.reload]);
  useEffect(() => { if (state.data) onChanged?.(state.data); }, [state.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: Insight) => { if (s) state.setData({ ...s, queued: false, insight: i }); };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={
        <span className="di-modal-title">
          <OrchestrateIcon />
          {t('docintel.panel.title')} — <span className="di-doc-name">{title}</span>
        </span>
      }
    >
      <AsyncView state={{ ...state, data: s }} isEmpty={() => false}>
        {(d) => <InsightBody s={d} storeType={storeType} onInsight={set} onReload={state.reload} />}
      </AsyncView>
    </Modal>
  );
}

function InsightBody({ s, storeType, onInsight, onReload }: { s: DocInsightState; storeType?: string; onInsight: (i: Insight) => void; onReload: () => void }) {
  const { t, te, pick, fmtDate } = useI18n();
  const { typeName } = useFmt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const i = s.insight;

  const classify = async () => {
    setBusy(true);
    setErr(null);
    try {
      onInsight(await docintelApi.classify(s.documentId));
      toast(t('docintel.classified'));
    } catch (e) {
      setErr(e);
      onReload();
    } finally {
      setBusy(false);
    }
  };

  const head = (
    <div className="alert alert-info di-advisory" role="note">
      <OrchestrateIcon />
      <span>{t('docintel.panel.advisory')}</span>
    </div>
  );
  const classifyBtn = s.canClassify && !s.queued && (
    <Button variant={i ? 'ghost' : 'primary'} busy={busy} onClick={classify} className="di-classify">
      <OrchestrateIcon />
      {t(i ? 'docintel.reclassify' : 'docintel.classify')}
    </Button>
  );

  if (!s.classifiable) return <p className="muted">{t('docintel.panel.notClassifiable')}</p>;
  if (!s.configured && !i) {
    return (
      <div className="stack">
        <div className="alert alert-warn" role="status">{t('docintel.panel.notConnected')}</div>
      </div>
    );
  }
  return (
    <div className="stack di-panel">
      {head}
      {err ? <ErrorBox error={err} /> : null}
      {s.queued && (
        <div className="alert alert-info di-reading" role="status" aria-live="polite">
          <span className="spinner spinner-sm" aria-hidden="true" /> {t('docintel.panel.queued')}
        </div>
      )}
      {!i && !s.queued && (
        <div className="row wrap">
          <p className="muted">{t('docintel.panel.notYet')}</p>
          {classifyBtn}
        </div>
      )}
      {i && (
        <>
          <div className="di-head">
            <div>
              <div className="muted small">{t('docintel.panel.type')}</div>
              <strong className="lg">{i.status === 'NOT_EXTRACTABLE' || i.status === 'FAILED' ? '—' : typeName(i)}</strong>
              {i.aiDocType && i.aiDocType !== i.docType && (
                <div className="muted small">{t('docintel.panel.aiType', { type: pick(i.aiDocTypeNameEn ?? i.aiDocType, i.aiDocTypeNameAr ?? i.aiDocType) })}</div>
              )}
            </div>
            <div className="row wrap">
              <Badge tone={i.status === 'PENDING_REVIEW' ? 'warn' : i.status === 'FAILED' ? 'danger' : i.status === 'REJECTED' || i.status === 'NOT_EXTRACTABLE' ? 'neutral' : 'success'} label={te('dis.', i.status)} />
              <span className="muted small">{te('dit.', i.trigger)}</span>
              {i.language && <span className="muted small">{t('docintel.panel.language')}: {i.language.toUpperCase()}</span>}
              {classifyBtn}
            </div>
          </div>

          {i.status === 'NOT_EXTRACTABLE' && <div className="alert alert-warn" role="status">{pick(i.notExtractable?.en, i.notExtractable?.ar)}</div>}
          {i.status === 'FAILED' && <div className="alert alert-danger" role="status">{t('docintel.panel.failed', { error: i.error ?? '' })}</div>}

          {!['NOT_EXTRACTABLE', 'FAILED'].includes(i.status) && <ReviewableData i={i} onInsight={onInsight} />}

          {i.reviewedAt && (
            <p className="small muted">
              {t('docintel.panel.reviewed', { status: te('dis.', i.status), date: fmtDate(i.reviewedAt) })}
              {i.reviewReason ? ` · ${t('docintel.panel.reason', { reason: i.reviewReason })}` : ''}
            </p>
          )}
          {i.filenet && (
            <p className={`small di-filenet di-filenet-${i.filenet.status.toLowerCase()}`}>
              {t(`docintel.panel.filenet.${i.filenet.status}` as 'docintel.panel.filenet.WRITTEN', { detail: i.filenet.detail })}
            </p>
          )}
          {i.applied?.map((a, n) => (
            <p key={n} className="small di-applied">{t('docintel.apply.applied', { code: a.activityCode ?? '', grade: a.grade ?? '' })}</p>
          ))}
          {i.classificationSuggestion && <ApplyClassification i={i} />}

          <footer className="di-footer">
            <strong>{t(storeType === 'filenet' ? 'docintel.panel.footer' : 'docintel.panel.footerDev')}</strong>
            {i.agent && (
              <span dir="ltr" className="di-run">
                {t('docintel.panel.run', { agent: i.agent, model: i.model ?? '—', run: i.orchestrateRunId ?? i.aiRunId ?? '—' })}
              </span>
            )}
            {i.repaired && <span className="muted">{t('docintel.panel.repaired')}</span>}
          </footer>
        </>
      )}
    </div>
  );
}

function ReviewableData({ i, onInsight }: { i: Insight; onInsight: (i: Insight) => void }) {
  const { t, pick, lang } = useI18n();
  const { value } = useFmt();
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'correct'>('view');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const editable = useMemo(
    () => [...i.fields.map((f) => ({ key: f.key, labelEn: f.labelEn, labelAr: f.labelAr, type: f.type })), ...i.missingFields],
    [i],
  );
  const asInput = (f?: InsightField) => {
    if (!f) return '';
    const v = f.value;
    if (Array.isArray(v)) return v.join(', ');
    if (v && typeof v === 'object') return `${v.amount}${v.currency ? ` ${v.currency}` : ''}`;
    return String(v);
  };
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft(Object.fromEntries(editable.map((f) => [f.key, asInput(i.fields.find((x) => x.key === f.key))]))), [editable, i.fields]);
  const [reason, setReason] = useState('');

  const decide = async (decision: 'ACCEPT' | 'CORRECT' | 'REJECT', why?: string) => {
    setBusy(true);
    setErr(null);
    try {
      let fields: { key: string; value: string | null }[] | undefined;
      if (decision === 'CORRECT') {
        fields = editable
          .filter((f) => (draft[f.key] ?? '') !== asInput(i.fields.find((x) => x.key === f.key)))
          .map((f) => ({ key: f.key, value: draft[f.key]?.trim() ? draft[f.key].trim() : null }));
      }
      onInsight(await docintelApi.review(i.id, { decision, fields, reason: why ?? (reason.trim() || undefined) }));
      toast(t('docintel.reviewed'));
      setMode('view');
    } catch (e) {
      setErr(e);
      if (decision === 'REJECT') throw e;
    } finally {
      setBusy(false);
    }
  };

  const submitCorrection = (e: FormEvent) => {
    e.preventDefault();
    void decide('CORRECT');
  };

  return (
    <div className="stack">
      <section aria-labelledby="di-flags-h" className="di-flag-box">
        <h3 id="di-flags-h" className="di-h">{t('docintel.flags')}</h3>
        {i.flags.length ? <FlagChips flags={i.flags} /> : <span className="muted small">{t('docintel.flagsNone')}</span>}
        {i.flags.filter((f) => f.code === 'NAME_MISMATCH').map((f, n) => (
          <div key={n} className="small muted">
            {t('docintel.flagNameDetail', { found: String(f.data.found), registered: pick(String(f.data.registeredEn), String(f.data.registeredAr)) })}
          </div>
        ))}
      </section>

      <h3 className="di-h">{t('docintel.panel.fields')}</h3>
      {err ? <ErrorBox error={err} /> : null}
      {mode === 'view' ? (
        i.fields.length ? (
          <Table head={[t('docintel.panel.field'), t('docintel.panel.value'), t('docintel.panel.evidence')]}>
            {i.fields.map((f) => (
              <tr key={f.key} className={f.corrected ? 'di-corrected' : undefined}>
                <th scope="row" className="di-label">{pick(f.labelEn, f.labelAr)}</th>
                <td>
                  <span className="di-value">{value(f.value, f.type)}</span>
                  {f.corrected && f.aiValue !== undefined && (
                    <div className="small muted">{t('docintel.panel.correctedFrom', { value: value(f.aiValue ?? null, f.type) })}</div>
                  )}
                </td>
                <td className="di-evidence">
                  {f.citation?.quote ? (
                    <>
                      <q className="cite-quote" dir="auto">{f.citation.quote}</q>
                      <div className="small muted" dir="auto">{f.citation.section}</div>
                    </>
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="muted">{t('docintel.panel.noFields')}</p>
        )
      ) : (
        <form className="stack di-correct" onSubmit={submitCorrection}>
          <p className="small muted">{t('docintel.correctHint')}</p>
          <div className="grid-2">
            {editable.map((f) => (
              <Field key={f.key} label={pick(f.labelEn, f.labelAr)}>
                {(id) => (
                  <input
                    id={id}
                    value={draft[f.key] ?? ''}
                    dir={f.type === 'date' || f.type === 'amount' || f.type === 'number' ? 'ltr' : 'auto'}
                    placeholder={f.type === 'date' ? 'YYYY-MM-DD' : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <Field label={t('docintel.reasonOptional')}>{(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="row">
            <Button type="submit" busy={busy}>{t('docintel.saveCorrection')}</Button>
            <Button variant="ghost" onClick={() => setMode('view')}>{t('docintel.cancel')}</Button>
          </div>
        </form>
      )}
      {mode === 'view' && i.missingFields.length > 0 && (
        <p className="small muted">{t('docintel.panel.notFoundFields', { list: i.missingFields.map((f) => pick(f.labelEn, f.labelAr)).join(lang === 'ar' ? '، ' : ', ') })}</p>
      )}
      {(i.summaryEn || i.summaryAr) && (
        <div className="di-summary">
          <h3 className="di-h">{t('docintel.panel.summary')}</h3>
          <p dir="auto">{pick(i.summaryEn, i.summaryAr)}</p>
          <p dir="auto" className="muted small">{lang === 'ar' ? i.summaryEn : i.summaryAr}</p>
        </div>
      )}
      {i.canReview && mode === 'view' && (
        <div className="row wrap di-actions">
          <Button busy={busy} onClick={() => void decide('ACCEPT')}>{t('docintel.accept')}</Button>
          <Button variant="secondary" onClick={() => setMode('correct')}>{t('docintel.correct')}</Button>
          <Button variant="danger" onClick={() => setRejecting(true)}>{t('docintel.reject')}</Button>
        </div>
      )}
      <ReasonDialog
        open={rejecting}
        title={t('docintel.rejectTitle')}
        confirmLabel={t('docintel.reject')}
        variant="danger"
        required
        onClose={() => setRejecting(false)}
        onConfirm={async (why) => { await decide('REJECT', why); }}
      />
    </div>
  );
}

function ApplyClassification({ i }: { i: Insight }) {
  const { t, pick } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const sug = i.classificationSuggestion!;
  const codes = useAsync(() => platform.activityCodes(), []);
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(sug.activityCodes[0] ?? '');
  const [grade, setGrade] = useState(String(sug.grade ?? ''));
  const [until, setUntil] = useState(sug.validUntil ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!hasRole('PROCUREMENT_OFFICER', 'TENANT_ADMIN')) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await docintelApi.applyClassification(i.id, { activityCode: code, grade: Number(grade), validUntil: until || null, confirm: true });
      toast(t('docintel.apply.done'));
      window.dispatchEvent(new CustomEvent('tf:classifications-changed'));
      setOpen(false);
    } catch (e2) {
      setErr(e2);
      toast(errText(e2), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="di-apply" data-tour="docintel-apply">
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>{t('docintel.apply.button')}</Button>
      ) : (
        <form className="stack" onSubmit={save}>
          <h3 className="di-h">{t('docintel.apply.title')}</h3>
          <p className="small muted">{t('docintel.apply.hint')}</p>
          {sug.unmatched.length > 0 && <p className="small">{t('docintel.apply.unmatched', { list: sug.unmatched.join(', ') })}</p>}
          {err ? <ErrorBox error={err} /> : null}
          <div className="grid-2">
            <Field label={t('docintel.apply.code')} required>
              {(id) => (
                <select id={id} value={code} onChange={(e) => setCode(e.target.value)} required>
                  <option value="">—</option>
                  {(codes.data ?? []).map((c) => (
                    <option key={c.code} value={c.code}>{c.code} — {pick(c.nameEn, c.nameAr)}{sug.activityCodes.includes(c.code) ? ' ✓' : ''}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('docintel.apply.grade')} required>
              {(id) => (
                <select id={id} value={grade} onChange={(e) => setGrade(e.target.value)} required>
                  <option value="">—</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              )}
            </Field>
            <Field label={t('docintel.apply.validUntil')}>
              {(id) => <input id={id} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
            </Field>
          </div>
          <div className="row">
            <Button type="submit" busy={busy} disabled={!code || !grade}>{t('docintel.apply.confirm')}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t('docintel.cancel')}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
