// FileNet workstream: /procurement/filenet-search and /admin/filenet-search — search IBM FileNet (Content Engine SQL),
// results filtered again by TenderFlow's access rules; each row opens the evidence panel (and from there Navigator / ACCE).
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Table } from '../../components/ui';
import type { DocumentMeta } from '../../api';
import { docTypeLabel, filenetApi, SEARCH_DOCUMENT_TYPES, type SearchResponse } from './api';
import { DocumentBadges, DocumentEvidence, RepoIcon } from './Evidence';

export function FileNetSearchPage() {
  const { t, te, fmtDate } = useI18n();
  const [form, setForm] = useState({ q: '', tenderNumber: '', documentType: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [res, setRes] = useState<SearchResponse | null>(null);

  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setRes(await filenetApi.search(form));
    } catch (e) {
      setError(e);
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack fn-search">
      <header className="page-head">
        <h1 className="fn-page-title">
          <RepoIcon />
          {t('filenet.search.title')}
        </h1>
      </header>
      <p className="muted">{t('filenet.search.intro')}</p>

      <Card>
        <form className="fn-search-form" onSubmit={(e) => void submit(e)} role="search" aria-label={t('filenet.search.title')}>
          <Field label={t('filenet.search.q')} hint={t('filenet.search.qHint')}>
            {(id, d) => <input id={id} aria-describedby={d} value={form.q} maxLength={64} onChange={(e) => setForm({ ...form, q: e.target.value })} />}
          </Field>
          <Field label={t('filenet.search.tenderNumber')}>
            {(id) => <input id={id} dir="ltr" value={form.tenderNumber} maxLength={64} placeholder="KEA-2026-102" onChange={(e) => setForm({ ...form, tenderNumber: e.target.value })} />}
          </Field>
          <Field label={t('filenet.search.documentType')}>
            {(id) => (
              <select id={id} value={form.documentType} onChange={(e) => setForm({ ...form, documentType: e.target.value })}>
                <option value="">{t('filenet.search.anyType')}</option>
                {SEARCH_DOCUMENT_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {docTypeLabel(te, d)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="fn-search-actions">
            <Button type="submit" busy={busy}>
              {t('filenet.search.run')}
            </Button>
          </div>
        </form>
      </Card>

      {!!error && <ErrorBox error={error} onRetry={() => void submit()} />}

      {res && (
        <Card
          title={t('filenet.search.results', { n: res.results.length })}
          actions={res.hidden > 0 ? <span className="muted small">{t('filenet.search.hidden', { n: res.hidden })}</span> : undefined}
        >
          {res.where && (
            <p className="small fn-cesql">
              <span className="muted">{t('filenet.search.ceSql')}</span>{' '}
              <code dir="ltr">
                SELECT … FROM {res.from} WHERE {res.where}
              </code>
            </p>
          )}
          {res.results.length === 0 ? (
            <EmptyState message={res.note ?? t('filenet.search.none')} />
          ) : (
            <Table head={[t('common.title'), t('common.type'), t('filenet.search.tender'), t('filenet.evidence.className'), t('filenet.evidence.version'), t('filenet.evidence.objectId'), '']}>
              {res.results.map((r) => {
                const doc: DocumentMeta = {
                  id: r.documentId, title: r.title, ownerType: r.ownerType as DocumentMeta['ownerType'], tenderId: r.tenderId, storeType: r.storeType,
                  encrypted: r.encrypted, createdAt: r.createdAt, versionNo: r.versionNo, isRecord: r.isRecord, recordDeclaredAt: r.recordDeclaredAt, supersedesId: r.supersedesId,
                };
                return (
                  <tr key={r.documentId}>
                    <td>
                      <span className="fn-doc-cell">
                        {r.title}
                        <DocumentBadges doc={doc} />
                      </span>
                      <div className="muted small">{fmtDate(r.createdAt)}</div>
                    </td>
                    <td>
                      {docTypeLabel(te, r.ownerType)}
                      {r.encrypted && (
                        <>
                          {' '}
                          <Badge tone="warn" label={t('filenet.evidence.encrypted')} />
                        </>
                      )}
                    </td>
                    <td dir="ltr">{r.tenderNumber ?? '—'}</td>
                    <td dir="ltr">{r.className}</td>
                    <td dir="ltr">{r.repositoryVersion ?? r.versionNo}</td>
                    <td className="small fn-ref-cell" dir="ltr">
                      <code>{r.objectId}</code>
                    </td>
                    <td>
                      <DocumentEvidence doc={doc} />
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
          {res.more && <p className="muted small">{t('filenet.search.more')}</p>}
        </Card>
      )}
    </div>
  );
}
