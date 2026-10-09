// Per-document pieces mounted in existing screens: the DocList row badge + "Data" button, the reading notice after an
// upload, a single-document badge (bid envelopes, GM letter), vendor "My documents" / staff "Verified documents",
// the extracted financial totals in the evaluation view, and the GM-letter prefill for the tender draft.
import { useEffect, useState } from 'react';
import type { DocumentMeta } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, Table, useAsync } from '../../components/ui';
import { docintelApi, type DocInsightState, type ExtractedTotal, type Insight } from './api';
import { FlagChips, InsightBadge, OrchestrateIcon, useDocInsights, useFmt } from './common';
import { InsightModal } from './InsightPanel';

type InsightsHook = ReturnType<typeof useDocInsights>;

/** Hook + notice for DocList: one request for all rows, polling while Orchestrate reads a new upload. */
export function useDocListInsights(docs: DocumentMeta[]) {
  return useDocInsights(docs.map((d) => ({ id: d.id, createdAt: d.createdAt })));
}

/** aria-live notice above the list while Orchestrate reads a document, then the outcome. */
export function ReadingNotice({ docs, hook }: { docs: DocumentMeta[]; hook: InsightsHook }) {
  const { t } = useI18n();
  const { typeName } = useFmt();
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  const reading = docs.filter((d) => hook.map[d.id]?.queued);
  useEffect(() => {
    if (reading.length) setSeen((s) => ({ ...s, ...Object.fromEntries(reading.map((d) => [d.id, true])) }));
  }, [reading.map((d) => d.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const finished = docs.filter((d) => seen[d.id] && !hook.map[d.id]?.queued && hook.map[d.id]?.insight);
  if (reading.length) {
    return (
      <div className="alert alert-info di-reading" role="status" aria-live="polite">
        <span className="spinner spinner-sm" aria-hidden="true" />
        <span>{hook.timedOut ? t('docintel.upload.later') : t('docintel.upload.reading')}</span>
      </div>
    );
  }
  if (!finished.length) return null;
  const last = hook.map[finished[finished.length - 1].id]!.insight!;
  return (
    <div className={`alert ${last.status === 'NOT_EXTRACTABLE' || last.status === 'FAILED' ? 'alert-warn' : 'alert-success'} di-reading`} role="status" aria-live="polite">
      <OrchestrateIcon />
      <span>{last.status === 'NOT_EXTRACTABLE' ? t('docintel.upload.notExtractable') : t('docintel.upload.done', { type: typeName(last) })}</span>
    </div>
  );
}

/** Badge (+ flags) under the title of a DocList row. */
export function RowBadge({ doc, hook }: { doc: DocumentMeta; hook: InsightsHook }) {
  const s = hook.map[doc.id];
  if (!s || !s.classifiable) return null;
  return (
    <span className="di-row">
      <InsightBadge state={s} />
      {s.insight && ['PENDING_REVIEW', 'ACCEPTED', 'CORRECTED'].includes(s.insight.status) && <FlagChips flags={s.insight.flags} compact />}
    </span>
  );
}

/** "Data" button of a DocList row (opens the panel). */
export function RowDataButton({ doc, hook }: { doc: DocumentMeta; hook: InsightsHook }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const s = hook.map[doc.id];
  if (!s || !s.classifiable) return null;
  return (
    <>
      <Button variant="ghost" className="di-data-btn" onClick={() => setOpen(true)} aria-label={t('docintel.dataAria', { name: doc.title })}>
        <OrchestrateIcon />
        {t('docintel.data')}
      </Button>
      {open && (
        <InsightModal
          documentId={doc.id}
          title={doc.title}
          storeType={doc.storeType}
          initial={s}
          onClose={() => { setOpen(false); void hook.reload(); }}
          onChanged={(x) => hook.update(doc.id, x.insight, { queued: x.queued, canClassify: x.canClassify, configured: x.configured })}
        />
      )}
    </>
  );
}

/** Badge + Data button for one document outside a DocList (opened bid envelopes, the GM letter). */
export function DocInsightInline({ documentId, title, storeType }: { documentId: string; title: string; storeType?: string }) {
  const hook = useDocInsights([{ id: documentId }]);
  const doc = { id: documentId, title, storeType } as DocumentMeta;
  if (!hook.map[documentId]) return null;
  return (
    <span className="di-inline">
      <RowBadge doc={doc} hook={hook} />
      <RowDataButton doc={doc} hook={hook} />
    </span>
  );
}

function expiryOf(i: Insight): string | null {
  const f = i.fields.find((x) => x.key === 'expiryDate' || x.key === 'validUntil');
  return typeof f?.value === 'string' ? f.value : null;
}

/** Verified (accepted) data of a vendor's company documents. vendorId omitted → the signed-in vendor ("My documents"). */
export function VerifiedDocuments({ vendorId }: { vendorId?: string }) {
  const { t, te, pick } = useI18n();
  const { value, day, typeName } = useFmt();
  const state = useAsync(() => (vendorId ? docintelApi.vendorVerified(vendorId) : docintelApi.myVerified()), [vendorId]);
  const body = (
    <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={t('docintel.my.empty')}>
      {(d) => (
        <Table head={[t('common.title'), t('docintel.panel.type'), t('docintel.panel.fields'), t('docintel.verified.expiry'), t('common.status')]}>
          {d.items.map((x) => {
            const v = x.verified;
            const exp = v ? expiryOf(v) : null;
            return (
              <tr key={x.documentId}>
                <td>{x.title}</td>
                <td>{v ? typeName(v) : '—'}</td>
                <td className="di-kv-cell">
                  {v ? (
                    <dl className="di-kv">
                      {v.fields.filter((f) => f.key !== 'expiryDate' && f.key !== 'validUntil').slice(0, 4).map((f) => (
                        <div key={f.key}>
                          <dt>{pick(f.labelEn, f.labelAr)}</dt>
                          <dd>{value(f.value, f.type)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <span className="muted small">{x.latestStatus === 'PENDING_REVIEW' ? t('docintel.my.waiting') : x.latestStatus ? te('dis.', x.latestStatus) : t('docintel.my.none')}</span>
                  )}
                </td>
                <td>
                  {exp ? day(exp) : '—'}
                  {v && <FlagChips flags={v.flags.filter((f) => f.code === 'EXPIRED' || f.code === 'EXPIRING_SOON')} compact />}
                </td>
                <td>{v ? <Badge tone="success" label={te('dis.', v.status)} /> : <span className="muted small">—</span>}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </AsyncView>
  );
  if (vendorId) {
    return (
      <section className="di-verified" aria-labelledby="di-verified-h">
        <h3 id="di-verified-h">{t('docintel.verified.title')}</h3>
        {body}
      </section>
    );
  }
  return (
    <Card title={<span className="di-card-title"><OrchestrateIcon />{t('docintel.my.title')}</span>} className="di-my-docs">
      <p className="muted small">{t('docintel.my.lead')}</p>
      {body}
    </Card>
  );
}

/** Extracted financial totals per opened bid ("verify against the document"; never used for scoring). */
export function ExtractedTotalsCard({ tenderId, vendorName }: { tenderId: string; vendorName: (bidId: string) => string }) {
  const { t, te } = useI18n();
  const { value } = useFmt();
  const state = useAsync(() => docintelApi.extractedTotals(tenderId), [tenderId]);
  const queued = state.data?.items.some((x) => x.queued);
  useEffect(() => {
    if (!queued) return;
    const h = setTimeout(state.reload, 2500);
    return () => clearTimeout(h);
  }, [queued, state.data, state.reload]);
  if (state.data && !state.data.items.length) return null;
  return (
    <Card id="sec-extracted" title={<span className="di-card-title"><OrchestrateIcon />{t('docintel.totals.title')}</span>}
      actions={<Button variant="ghost" onClick={state.reload}>{t('common.refresh')}</Button>}>
      <p className="alert alert-warn di-verify-note" role="note">{t('docintel.totals.note')}</p>
      <AsyncView state={state} isEmpty={() => false}>
        {(d) => (
          <Table head={[t('docintel.totals.bid'), t('docintel.totals.total'), t('common.status'), '']}>
            {d.items.map((x: ExtractedTotal) => (
              <tr key={x.bidId}>
                <td>{vendorName(x.bidId)}</td>
                <td>
                  {x.sealed ? (
                    <span className="muted small">{t('docintel.totals.sealed')}</span>
                  ) : x.insight?.totalAmount ? (
                    <>
                      <strong className="di-value">{value(x.insight.totalAmount, 'amount')}</strong>
                      {x.insight.citation?.quote && <div className="small muted"><q className="cite-quote" dir="auto">{x.insight.citation.quote}</q></div>}
                    </>
                  ) : (
                    <span className="muted small">{x.queued ? t('docintel.badge.reading') : !d.configured ? t('docintel.badge.notConnected') : t('docintel.totals.none')}</span>
                  )}
                  <FlagChips flags={x.insight?.flags.filter((f) => f.code === 'CURRENCY_MISMATCH')} compact />
                </td>
                <td>{x.insight ? <Badge tone={x.insight.status === 'PENDING_REVIEW' ? 'warn' : 'success'} label={te('dis.', x.insight.status)} /> : '—'}</td>
                <td>{x.documentId && <DocInsightInline documentId={x.documentId} title={x.title ?? ''} />}</td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
    </Card>
  );
}

/** Accepted GM-letter data offered as prefill for the tender draft (the officer applies it to the convert form). */
export function LetterPrefill({ documentId }: { documentId: string }) {
  const { t, pick } = useI18n();
  const { value } = useFmt();
  const [s, setS] = useState<DocInsightState | null>(null);
  useEffect(() => { docintelApi.insight(documentId).then(setS).catch(() => setS(null)); }, [documentId]);
  const i = s?.insight;
  if (!i || !['ACCEPTED', 'CORRECTED'].includes(i.status) || i.docType !== 'GM_LETTER') return null;
  const by = Object.fromEntries(i.fields.map((f) => [f.key, f]));
  const budget = by.estimatedBudget?.value;
  const use = () => window.dispatchEvent(new CustomEvent('tf:request-prefill', { detail: {
    subject: typeof by.subject?.value === 'string' ? by.subject.value : undefined,
    estimatedBudget: budget && typeof budget === 'object' && !Array.isArray(budget) ? budget.amount : undefined,
  } }));
  return (
    <div className="di-prefill" data-tour="docintel-prefill">
      <h3 className="di-h"><OrchestrateIcon />{t('docintel.prefill.title')}</h3>
      <dl className="di-kv">
        {i.fields.map((f) => (
          <div key={f.key}>
            <dt>{pick(f.labelEn, f.labelAr)}</dt>
            <dd>{value(f.value, f.type)}</dd>
          </div>
        ))}
      </dl>
      <p className="small muted">{t('docintel.prefill.hint')}</p>
      <Button variant="secondary" onClick={use}>{t('docintel.prefill.use')}</Button>
    </div>
  );
}
