import { useEffect, useState } from 'react';
import { api, type BidReceipt, type Citation, type DocumentMeta } from '../api';
import { useI18n } from '../i18n';
import { DocButton } from './Layout';
import { Badge, Button, EmptyState, fmtBytes, Hash, Table } from './ui';
import { DocumentBadges, DocumentEvidence } from '../features/filenet';
import { ReadingNotice, RowBadge, RowDataButton, useDocListInsights } from '../features/docintel';

export function DocList({ docs, empty, pathFor }: { docs: DocumentMeta[]; empty: string; pathFor?: (d: DocumentMeta) => string }) {
  const { t, te, fmtDate } = useI18n();
  const di = useDocListInsights(docs); // document intelligence: one request for all rows, polls while Orchestrate reads
  if (docs.length === 0) return <EmptyState message={empty} />;
  return (
    <>
    <ReadingNotice docs={docs} hook={di} />
    <Table head={[t('common.title'), t('common.type'), t('common.size'), t('common.sha256'), t('common.date'), t('common.actions')]}>
      {docs.map((d) => (
        <tr key={d.id}>
          <td>
            <span className="fn-doc-cell">
              <span>{d.title}</span>
              <DocumentBadges doc={d} />
            </span>
            <RowBadge doc={d} hook={di} />
          </td>
          <td>
            {d.ownerType ? <Badge label={te('doc.', d.addendum ? 'ADDENDUM' : d.ownerType)} tone={d.ownerType === 'ADDENDUM' || d.addendum ? 'warn' : 'neutral'} /> : '—'}
          </td>
          <td>{fmtBytes(d.byteSize)}</td>
          <td>
            <Hash value={d.sha256Plain} />
          </td>
          <td>{fmtDate(d.createdAt)}</td>
          <td>
            <DocButton
              path={pathFor ? pathFor(d) : api.documentPath(d.id)}
              name={d.title}
              mode={d.mimeType?.includes('html') ? 'open' : 'download'}
            />
            <DocumentEvidence doc={d} />
            <RowDataButton doc={d} hook={di} />
          </td>
        </tr>
      ))}
    </Table>
    </>
  );
}

export function Citations({ items }: { items: Citation[] | null | undefined }) {
  const { t } = useI18n();
  if (!items || items.length === 0) return <span className="muted small">{t('ai.noCitations')}</span>;
  return (
    <ul className="citations">
      {items.map((c, i) => (
        <li key={i}>
          <span className="cite-doc">{c.title ?? c.documentId ?? '—'}</span>
          {c.section && <span className="cite-sec"> · {c.section}</span>}
          {c.quote && <q className="cite-quote">{c.quote}</q>}
        </li>
      ))}
    </ul>
  );
}

export function CitationInline({ c }: { c?: Citation }) {
  if (!c) return <span className="muted">—</span>;
  return (
    <span className="small">
      <span className="cite-doc">{c.title ?? c.documentId}</span>
      {c.section && <span className="cite-sec"> · {c.section}</span>}
      {c.quote && (
        <>
          <br />
          <q className="cite-quote">{c.quote}</q>
        </>
      )}
    </span>
  );
}

export function Receipt({ receipt }: { receipt: BidReceipt }) {
  const { t, fmtDate } = useI18n();
  return (
    <div className="receipt" aria-labelledby="receipt-h">
      <div className="receipt-head">
        <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        <h3 id="receipt-h">{t('vendor.receipt')}</h3>
        <Button variant="ghost" className="no-print" onClick={() => window.print()}>
          {t('vendor.printReceipt')}
        </Button>
      </div>
      <dl className="kv">
        <dt>{t('vendor.receiptId')}</dt>
        <dd>
          <code dir="ltr">{receipt.bidId}</code>
        </dd>
        <dt>{t('vendor.receiptTime')}</dt>
        <dd>
          {fmtDate(receipt.submittedAt)} <span className="muted small" dir="ltr">({receipt.submittedAt})</span>
        </dd>
        <dt>{t('vendor.receiptHash')}</dt>
        <dd>
          <code className="hash-full" dir="ltr">
            {receipt.receiptSha256}
          </code>
        </dd>
      </dl>
      {receipt.files?.length > 0 && (
        <>
          <h4>{t('vendor.receiptFiles')}</h4>
          <ul className="hash-list">
            {receipt.files.map((f, i) => (
              <li key={i}>
                <span>{f.title}</span>
                <code className="hash-full" dir="ltr">
                  {f.sha256}
                </code>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="sealed-note">{t('vendor.sealedExplain')}</p>
    </div>
  );
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(h);
  }, [intervalMs]);
  return now;
}

export function Countdown({ deadline }: { deadline: string }) {
  const { t } = useI18n();
  const now = useNow(1000);
  const ms = new Date(deadline).getTime() - now;
  if (Number.isNaN(ms)) return <span>—</span>;
  if (ms <= 0) return <Badge value="CLOSED" label={t('td.deadlinePassed')} />;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    <span className="countdown" dir="ltr" aria-live="off">
      {d > 0 ? `${d}d ` : ''}
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}
    </span>
  );
}
