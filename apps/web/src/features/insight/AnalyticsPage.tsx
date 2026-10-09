// Procurement analytics (/procurement/analytics and /admin/analytics): DIRECTOR, UNDERSECRETARY, TENANT_ADMIN, AUDITOR.
// Every table can be exported as CSV; every number comes from GET /insight/analytics for the chosen date range.
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, EmptyState, Field, Table, fmtBytes, useAsync } from '../../components/ui';
import { insight, type Analytics } from './api';
import { BarChart, DonutChart, SERIES, Tile, downloadCsv, useDuration } from './charts';
import '../../styles/insight.css';

const kuwaitToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() + 3 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

function CsvButton({ name, head, rows }: { name: string; head: string[]; rows: (string | number | null | undefined)[][] }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost" onClick={() => downloadCsv(name, head, rows)} disabled={rows.length === 0} aria-label={`${t('insight.csv')}: ${name}`}>
      {t('insight.csv')}
    </Button>
  );
}

function Block({ title, hint, csv, children }: { title: string; hint?: string; csv?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} actions={csv}>
      {hint && <p className="muted small">{hint}</p>}
      {children}
    </Card>
  );
}

export function AnalyticsPage() {
  const { t } = useI18n();
  const [range, setRange] = useState({ from: daysAgo(365), to: kuwaitToday() });
  const [draft, setDraft] = useState(range);
  const state = useAsync(() => insight.analytics(range.from, range.to), [range.from, range.to]);
  const apply = (e: FormEvent) => { e.preventDefault(); setRange(draft); };
  const preset = (n: number) => { const r = { from: daysAgo(n), to: kuwaitToday() }; setDraft(r); setRange(r); };
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('insight.analytics.title')}</h1>
          <p className="muted">{t('insight.analytics.subtitle')}</p>
        </div>
      </header>
      <form className="insight-filters" onSubmit={apply} aria-label={t('insight.analytics.range')}>
        <Field label={t('insight.from')}>{(id) => <input id={id} type="date" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required />}</Field>
        <Field label={t('insight.to')}>{(id) => <input id={id} type="date" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} required />}</Field>
        <Button type="submit">{t('insight.apply')}</Button>
        <div className="segmented" role="group" aria-label={t('insight.presets')}>
          {[30, 90, 365].map((n) => <button type="button" key={n} onClick={() => preset(n)}>{t('insight.lastDays', { n })}</button>)}
        </div>
      </form>
      <AsyncView state={state}>{(a) => <AnalyticsBody a={a} />}</AsyncView>
    </div>
  );
}

function AnalyticsBody({ a }: { a: Analytics }) {
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const dur = useDuration();
  const day = (d: number | null) => (d === null ? '' : d.toFixed(3));
  const stageLabel = (k: string) => te('insight.stage.', k);
  const gateLabel = (g: string) => te('insight.gate.', g);
  const p = a.participation;
  const sumBy = (cur: string, test: boolean) => a.revenue.filter((r) => r.currency === cur && r.testPayment === test).reduce((s, r) => s + r.amount, 0);
  const currencies = [...new Set(a.revenue.map((r) => r.currency))];
  const aiTotals = a.aiUsage.reduce((s, r) => ({ accepted: s.accepted + r.accepted, edited: s.edited + r.edited, ignored: s.ignored + r.ignored, unreviewed: s.unreviewed + r.unreviewed, error: s.error + r.error }),
    { accepted: 0, edited: 0, ignored: 0, unreviewed: 0, error: 0 });
  const range = `${a.range.from.slice(0, 10)}_${a.range.to.slice(0, 10)}`;
  return (
    <div className="stack insight-dash">
      <p className="muted small">{t('insight.analytics.rangeNote', { from: fmtDate(a.range.from), to: fmtDate(a.range.to) })}</p>

      {/* cycle time */}
      <Block title={t('insight.analytics.cycle')} hint={t('insight.analytics.cycleHint')}
        csv={<CsvButton name={`cycle-times_${range}`} head={['stage', 'from_event', 'to_event', 'n', 'median_days', 'p90_days', 'mean_days', 'min_days', 'max_days']}
          rows={a.cycleTimes.map((c) => [c.stage, c.fromEvent, c.toEvent, c.n, day(c.medianDays), day(c.p90Days), day(c.meanDays), day(c.minDays), day(c.maxDays)])} />}>
        <div className="insight-grid">
          <BarChart title={t('insight.analytics.cycleMedian')} digits={2} unit={` ${t('insight.dUnit')}`} valueLabel={t('insight.median')}
            data={a.cycleTimes.filter((c) => c.n > 0).map((c) => ({ key: c.stage, label: stageLabel(c.stage), value: c.medianDays ?? 0, hint: `p90 ${dur(c.p90Days)}` }))} />
          <Table head={[t('insight.stage'), 'n', t('insight.median'), 'p90', t('insight.mean')]}>
            {a.cycleTimes.map((c) => (
              <tr key={c.stage}>
                <td>{stageLabel(c.stage)}</td>
                <td>{c.n}</td>
                <td>{c.n ? dur(c.medianDays) : <span className="muted">{t('insight.noData')}</span>}</td>
                <td>{dur(c.p90Days)}</td>
                <td>{dur(c.meanDays)}</td>
              </tr>
            ))}
          </Table>
        </div>
      </Block>

      {/* status + category */}
      <div className="insight-grid">
        <Block title={t('insight.analytics.byStatus')} hint={t('insight.analytics.createdInRange')}
          csv={<CsvButton name={`tenders-by-status_${range}`} head={['status', 'tenders']} rows={a.tendersByStatus.map((r) => [r.status, r.count])} />}>
          <DonutChart hideTitle title={t('insight.analytics.byStatus')} valueLabel={t('insight.chart.tenders')}
            data={a.tendersByStatus.map((r) => ({ key: r.status, label: te('st.', r.status), value: r.count, color: SERIES[['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED', 'CANCELLED'].indexOf(r.status) % SERIES.length] }))} />
        </Block>
        <Block title={t('insight.analytics.byCategory')} hint={t('insight.analytics.createdInRange')}
          csv={<CsvButton name={`tenders-by-category_${range}`} head={['category', 'tenders']} rows={a.tendersByCategory.map((r) => [r.category, r.count])} />}>
          <BarChart hideTitle title={t('insight.analytics.byCategory')} valueLabel={t('insight.chart.tenders')} data={a.tendersByCategory.map((r) => ({ key: r.category, label: te('cat.', r.category), value: r.count }))} />
        </Block>
      </div>

      {/* participation */}
      <Block title={t('insight.analytics.participation')} hint={t('insight.analytics.participationHint')}
        csv={<CsvButton name={`participation_${range}`} head={['tender_number', 'title_en', 'title_ar', 'status', 'category', 'published_at', 'eligible_vendors', 'purchased', 'bids']}
          rows={p.tenders.map((x) => [x.tenderNumber, x.titleEn, x.titleAr, x.status, x.category, x.publishedAt, x.eligibleVendors, x.purchased ?? '', x.bids])} />}>
        <div className="tiles">
          <Tile value={p.summary.tenders} label={t('insight.analytics.publishedTenders')} />
          <Tile value={p.summary.bids} label={t('insight.analytics.bids')} />
          <Tile value={p.summary.meanBidsPerTender ?? '—'} label={t('insight.analytics.bidsPerTender')} hint={p.summary.medianBidsPerTender !== null ? t('insight.analytics.medianN', { n: p.summary.medianBidsPerTender }) : undefined} />
          <Tile value={p.summary.uniqueBidders} label={t('insight.analytics.uniqueBidders')} />
        </div>
        <div className="insight-grid">
          <BarChart title={t('insight.analytics.funnel')} subtitle={p.funnel.purchased === null ? t('insight.analytics.noPurchaseStage') : t('insight.analytics.purchaseTenders', { n: p.funnel.purchaseTenders })}
            valueLabel={t('insight.chart.vendors')} data={[
              { key: 'eligible', label: t('insight.analytics.eligible'), value: p.funnel.eligible, color: SERIES[0] },
              ...(p.funnel.purchased !== null ? [{ key: 'purchased', label: t('insight.analytics.purchased'), value: p.funnel.purchased, color: SERIES[1] }] : []),
              { key: 'bid', label: t('insight.analytics.bidders'), value: p.funnel.bid, color: SERIES[2] },
            ]} />
          {p.tenders.length === 0 ? <EmptyState message={t('insight.noData')} /> : (
            <Table head={[t('tenders.number'), t('common.title'), t('insight.analytics.eligible'), t('insight.analytics.purchased'), t('insight.analytics.bids')]}>
              {p.tenders.map((x) => (
                <tr key={x.tenderId}>
                  <td dir="ltr"><Link to={`/procurement/tenders/${x.tenderId}`}>{x.tenderNumber}</Link></td>
                  <td>{pick(x.titleEn, x.titleAr)}</td>
                  <td>{x.eligibleVendors}</td>
                  <td>{x.purchased ?? <span className="muted">{t('insight.na')}</span>}</td>
                  <td>{x.bids}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      </Block>

      {/* approvals */}
      <Block title={t('insight.analytics.approvals')} hint={t('insight.analytics.approvalsHint')}
        csv={<CsvButton name={`approval-turnaround_${range}`} head={['gate', 'level', 'role', 'n', 'median_days', 'p90_days', 'mean_days']}
          rows={a.approvalTurnaround.map((r) => [r.gate, r.level, r.role, r.n, day(r.medianDays), day(r.p90Days), day(r.meanDays)])} />}>
        {a.approvalTurnaround.length === 0 ? <EmptyState message={t('insight.noData')} /> : (
          <div className="insight-grid">
            <BarChart title={t('insight.analytics.approvalsMedian')} digits={2} unit={` ${t('insight.dUnit')}`} valueLabel={t('insight.median')}
              data={a.approvalTurnaround.map((r) => ({ key: `${r.gate}-${r.level}`, label: `${gateLabel(r.gate)} · ${t('insight.levelN', { n: r.level })}`, value: r.medianDays ?? 0, hint: te('role.', r.role) }))} />
            <Table head={[t('insight.gate'), t('insight.level'), t('insight.role'), 'n', t('insight.median'), 'p90']}>
              {a.approvalTurnaround.map((r) => (
                <tr key={`${r.gate}-${r.level}`}>
                  <td>{gateLabel(r.gate)}</td>
                  <td>{r.level}</td>
                  <td>{te('role.', r.role)}</td>
                  <td>{r.n}</td>
                  <td>{dur(r.medianDays)}</td>
                  <td>{dur(r.p90Days)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Block>

      {/* revenue */}
      <Block title={t('insight.analytics.revenue')} hint={t('insight.analytics.revenueHint')}
        csv={<CsvButton name={`document-sales_${range}`} head={['gateway', 'test_payment', 'currency', 'status', 'purchases', 'amount']}
          rows={a.revenue.map((r) => [r.gateway, r.testPayment ? 'yes' : 'no', r.currency, r.status, r.purchases, r.amount])} />}>
        {a.revenue.length === 0 ? <EmptyState message={t('insight.noData')} /> : (
          <>
            <div className="tiles">
              {currencies.map((c) => (
                <Tile key={`real-${c}`} value={fmtMoney(sumBy(c, false), c)} label={t('insight.analytics.revenueReal')} />
              ))}
              {currencies.filter((c) => sumBy(c, true) > 0).map((c) => (
                <Tile key={`test-${c}`} value={fmtMoney(sumBy(c, true), c)} label={<>{t('insight.analytics.revenueTest')} <Badge tone="warn" label={t('insight.testPayment')} /></>} tone="warn" />
              ))}
            </div>
            <Table head={[t('insight.analytics.gateway'), t('common.status'), t('insight.purchases'), t('insight.vendor.amount')]}>
              {a.revenue.map((r) => (
                <tr key={`${r.gateway}-${r.currency}-${r.status}`}>
                  <td>{r.gateway} {r.testPayment && <Badge tone="warn" label={t('insight.testPayment')} />}</td>
                  <td>{r.status}</td>
                  <td>{r.purchases}</td>
                  <td>{fmtMoney(r.amount, r.currency)}</td>
                </tr>
              ))}
            </Table>
          </>
        )}
      </Block>

      {/* AI */}
      <div className="insight-grid">
        <Block title={t('insight.analytics.ai')} hint={t('insight.analytics.aiHint')}
          csv={<CsvButton name={`ai-usage_${range}`} head={['kind', 'total', 'ok', 'error', 'accepted', 'edited', 'ignored', 'unreviewed']}
            rows={a.aiUsage.map((r) => [r.kind, r.total, r.ok, r.error, r.accepted, r.edited, r.ignored, r.unreviewed])} />}>
          <DonutChart title={t('insight.analytics.aiReview')} valueLabel={t('insight.chart.runs')} data={[
            { key: 'acc', label: t('insight.ai.accepted'), value: aiTotals.accepted, color: SERIES[2] },
            { key: 'edit', label: t('insight.ai.edited'), value: aiTotals.edited, color: SERIES[0] },
            { key: 'ign', label: t('insight.ai.ignored'), value: aiTotals.ignored, color: SERIES[3] },
            { key: 'unrev', label: t('insight.ai.unreviewed'), value: aiTotals.unreviewed, color: '#8a94a3' },
            { key: 'err', label: t('insight.ai.failed'), value: aiTotals.error, color: SERIES[7] },
          ]} />
          {a.aiUsage.length > 0 && (
            <Table head={[t('insight.kind'), t('insight.chart.total'), t('insight.ai.accepted'), t('insight.ai.ignored'), t('insight.ai.failed')]}>
              {a.aiUsage.map((r) => (
                <tr key={r.kind}>
                  <td>{te('insight.aiKind.', r.kind)}</td>
                  <td>{r.total}</td>
                  <td>{r.accepted + r.edited}</td>
                  <td>{r.ignored}</td>
                  <td>{r.error}</td>
                </tr>
              ))}
            </Table>
          )}
        </Block>
        <Block title={t('insight.analytics.documents')} hint={t('insight.analytics.documentsHint')}
          csv={<CsvButton name={`documents_${range}`} head={['owner_type', 'store_type', 'documents', 'records', 'bytes']}
            rows={a.documents.map((r) => [r.ownerType, r.storeType, r.count, r.records, r.bytes])} />}>
          {a.documents.length === 0 ? <EmptyState message={t('insight.noData')} /> : (
            <Table head={[t('insight.docType'), t('insight.store'), t('insight.chart.total'), t('insight.auditor.records'), t('common.size')]}>
              {a.documents.map((r) => (
                <tr key={`${r.ownerType}-${r.storeType}`}>
                  <td>{te('insight.owner.', r.ownerType)}</td>
                  <td>{r.storeType === 'filenet' ? 'IBM FileNet' : t('insight.admin.localStore')}</td>
                  <td>{r.count}</td>
                  <td>{r.records}</td>
                  <td>{fmtBytes(r.bytes)}</td>
                </tr>
              ))}
            </Table>
          )}
          {a.documentInsights.length > 0 && (
            <p className="small muted">{t('insight.analytics.insights')}: {a.documentInsights.map((d) => `${d.status} ${d.count}`).join(' · ')}</p>
          )}
        </Block>
      </div>
    </div>
  );
}
