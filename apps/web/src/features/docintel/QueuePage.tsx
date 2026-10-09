// Staff page /procurement/documents: every classified document (latest result per document), counts per status,
// filters, link to the owner, and the review panel.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { AiNotConfiguredBanner, AsyncView, Badge, Button, Card, Field, Table, useAsync } from '../../components/ui';
import { docintelApi, type QueueItem } from './api';
import { FlagChips, OrchestrateIcon, useFmt } from './common';
import { InsightModal } from './InsightPanel';

const STATUSES = ['PENDING_REVIEW', 'ACCEPTED', 'CORRECTED', 'REJECTED', 'NOT_EXTRACTABLE', 'FAILED'];
const OWNER_TYPES = ['VENDOR', 'TENDER_PACK', 'ADDENDUM', 'REQUEST_LETTER', 'BID_TECHNICAL', 'BID_FINANCIAL'];

export function DocumentQueuePage() {
  const { t, te, pick, fmtDate } = useI18n();
  const { typeName } = useFmt();
  const [status, setStatus] = useState('PENDING_REVIEW');
  const [ownerType, setOwnerType] = useState('');
  const [docType, setDocType] = useState('');
  const [open, setOpen] = useState<QueueItem | null>(null);
  const state = useAsync(() => docintelApi.queue({ status, ownerType, docType }), [status, ownerType, docType]);
  const counts = state.data?.counts ?? {};
  const total = Object.values(counts).reduce((a, n) => a + n, 0);

  const ownerLink = (x: QueueItem) => {
    const label = pick(x.owner.labelEn, x.owner.labelAr) || '—';
    if (x.owner.kind === 'TENDER' && x.owner.id) return (
      <>
        <Link to={`/procurement/tenders/${x.owner.id}`}>{label}</Link>
        {x.owner.vendorEn && <div className="small muted">{pick(x.owner.vendorEn, x.owner.vendorAr)}</div>}
      </>
    );
    if (x.owner.kind === 'REQUEST' && x.owner.id) return <Link to={`/procurement/requests/${x.owner.id}`}>{label}</Link>;
    if (x.owner.kind === 'VENDOR') return <Link to="/procurement/vendors">{label}</Link>;
    return label;
  };

  return (
    <div className="stack di-queue">
      <div className="page-head">
        <h1 className="di-title"><OrchestrateIcon />{t('docintel.queue.title')}</h1>
        <Button variant="ghost" onClick={state.reload}>{t('common.refresh')}</Button>
      </div>
      <p className="muted">{t('docintel.queue.lead')}</p>
      {state.data && !state.data.configured && <AiNotConfiguredBanner />}

      <div className="di-counts" role="group" aria-label={t('docintel.queue.status')}>
        <button type="button" className={`di-count ${status === '' ? 'on' : ''}`} onClick={() => setStatus('')} aria-pressed={status === ''}>
          <span className="di-count-n">{total}</span>
          <span>{t('docintel.queue.all')}</span>
        </button>
        {STATUSES.map((s) => (
          <button key={s} type="button" className={`di-count di-count-${s.toLowerCase()} ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)} aria-pressed={status === s}>
            <span className="di-count-n">{counts[s] ?? 0}</span>
            <span>{te('dis.', s)}</span>
          </button>
        ))}
      </div>

      <Card>
        <div className="filters di-filters">
          <Field label={t('docintel.queue.ownerType')}>
            {(id) => (
              <select id={id} value={ownerType} onChange={(e) => setOwnerType(e.target.value)}>
                <option value="">{t('docintel.queue.all')}</option>
                {OWNER_TYPES.map((o) => <option key={o} value={o}>{t(`dic.${o}` as TKey)}</option>)}
              </select>
            )}
          </Field>
          <Field label={t('docintel.queue.docType')}>
            {(id) => (
              <select id={id} value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="">{t('docintel.queue.all')}</option>
                {(state.data?.docTypes ?? []).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </Field>
        </div>
        <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={t('docintel.queue.empty')}>
          {(d) => (
            <Table head={[t('common.title'), t('docintel.queue.docType'), t('common.status'), t('docintel.flags'), t('docintel.queue.owner'), t('common.date'), t('common.actions')]}>
              {d.items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <div>{x.title}</div>
                    <div className="small muted">{t(`dic.${x.ownerType}` as TKey)} · {te('dit.', x.trigger)}</div>
                  </td>
                  <td>
                    {['NOT_EXTRACTABLE', 'FAILED'].includes(x.status) ? '—' : typeName(x)}
                    {x.fieldCount > 0 && <div className="small muted">{t('docintel.queue.fields', { n: x.fieldCount })}</div>}
                  </td>
                  <td><Badge tone={x.status === 'PENDING_REVIEW' ? 'warn' : x.status === 'FAILED' ? 'danger' : ['ACCEPTED', 'CORRECTED'].includes(x.status) ? 'success' : 'neutral'} label={te('dis.', x.status)} /></td>
                  <td>{x.flags.length ? <FlagChips flags={x.flags} compact /> : <span className="muted small">—</span>}</td>
                  <td>{ownerLink(x)}</td>
                  <td>{fmtDate(x.createdAt)}</td>
                  <td>
                    <Button variant={x.canReview ? 'primary' : 'ghost'} onClick={() => setOpen(x)} data-tour="docintel-open">
                      {x.canReview ? t('docintel.queue.review') : t('docintel.queue.open')}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
      {open && (
        <InsightModal documentId={open.documentId} title={open.title} onClose={() => { setOpen(null); state.reload(); }} />
      )}
    </div>
  );
}
