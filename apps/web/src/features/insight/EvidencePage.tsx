// Auditor evidence pack (/admin/evidence): AUDITOR and TENANT_ADMIN generate a verifiable ZIP for a tender or a date
// range; the pack is stored in the content store (FileNet) and listed here with its SHA-256 for download.
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Hash, Table, fmtBytes, useAsync, useToast, errText } from '../../components/ui';
import { insight, type EvidencePack } from './api';
import '../../styles/insight.css';

const kuwaitToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function EvidencePackPage() {
  const { t, te, pick, fmtDate } = useI18n();
  const toast = useToast();
  const tenders = useAsync(() => api.tenders(), []);
  const packs = useAsync(() => insight.packs(), []);
  const [mode, setMode] = useState<'TENDER' | 'RANGE'>('TENDER');
  const [params] = useSearchParams();
  const [tenderId, setTenderId] = useState(params.get('tenderId') ?? '');
  const [from, setFrom] = useState(kuwaitToday());
  const [to, setTo] = useState(kuwaitToday());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<EvidencePack | null>(null);

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await insight.generatePack(mode === 'TENDER' ? { tenderId } : { from, to });
      setResult(r);
      toast(t('insight.evidence.generated'));
      packs.reload();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  const download = async (p: EvidencePack) => {
    try { await insight.downloadPack(p); } catch (e2) { toast(errText(e2), 'error'); }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('insight.evidence.title')}</h1>
          <p className="muted">{t('insight.evidence.subtitle')}</p>
        </div>
      </header>
      <div className="insight-grid">
        <Card title={t('insight.evidence.generate')}>
          <form className="stack" onSubmit={generate}>
            <div className="segmented" role="radiogroup" aria-label={t('insight.evidence.scope')}>
              {(['TENDER', 'RANGE'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {t(m === 'TENDER' ? 'insight.evidence.byTender' : 'insight.evidence.byRange')}
                </button>
              ))}
            </div>
            {mode === 'TENDER' ? (
              <Field label={t('insight.evidence.tender')} required>
                {(id) => (
                  <select id={id} value={tenderId} onChange={(e) => setTenderId(e.target.value)} required>
                    <option value="">{t('insight.evidence.pickTender')}</option>
                    {(tenders.data ?? []).map((x) => (
                      <option key={x.id} value={x.id}>{`${x.tenderNumber ?? ''} — ${pick(x.titleEn, x.titleAr)} (${te('st.', x.status)})`}</option>
                    ))}
                  </select>
                )}
              </Field>
            ) : (
              <div className="grid-2">
                <Field label={t('insight.from')} required>{(id) => <input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />}</Field>
                <Field label={t('insight.to')} required>{(id) => <input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />}</Field>
              </div>
            )}
            <ul className="insight-checklist small">
              <li>{t('insight.evidence.c1')}</li>
              <li>{t('insight.evidence.c2')}</li>
              <li>{t('insight.evidence.c3')}</li>
              <li>{t('insight.evidence.c4')}</li>
            </ul>
            {err ? <ErrorBox error={err} /> : null}
            <div className="row-end">
              <Button type="submit" busy={busy} disabled={mode === 'TENDER' && !tenderId}>{t('insight.evidence.generateBtn')}</Button>
            </div>
          </form>
        </Card>
        {result ? (
          <Card title={t('insight.evidence.result')}>
            <div className="stack">
              <div className="row wrap">
                <strong dir="ltr">{result.tenderNumber ?? t('insight.evidence.rangePack')}</strong>
                <Badge tone={result.auditChain?.valid ? 'success' : 'danger'} label={`${t('insight.auditor.chain')}: ${result.auditChain?.valid ? t('insight.auditor.valid') : t('insight.auditor.broken', { seq: result.auditChain?.brokenAt ?? '?' })}`} />
              </div>
              {result.summary && (
                <dl className="kv">
                  <dt>{t('insight.evidence.docsIncluded')}</dt><dd>{result.summary.included} / {result.summary.documents}</dd>
                  <dt>{t('insight.evidence.sealedExcluded')}</dt><dd>{result.summary.sealedBidDocumentsExcluded}</dd>
                  <dt>{t('insight.evidence.mismatches')}</dt><dd>{result.summary.hashMismatches ? <Badge tone="danger" label={String(result.summary.hashMismatches)} /> : 0}</dd>
                  <dt>{t('insight.evidence.auditEvents')}</dt><dd>{result.summary.auditEvents}</dd>
                  <dt>{t('insight.evidence.approvals')}</dt><dd>{result.summary.approvals}</dd>
                  <dt>{t('insight.evidence.stored')}</dt><dd>{result.storeType === 'filenet' ? `IBM FileNet${result.objectId ? ` · ${result.objectId}` : ''}` : t('insight.admin.localStore')}</dd>
                  <dt>SHA-256</dt><dd><Hash value={result.sha256} /></dd>
                  <dt>{t('common.size')}</dt><dd>{fmtBytes(result.byteSize)}</dd>
                </dl>
              )}
              <div className="row-end"><Button onClick={() => download(result)}>{t('insight.evidence.download')}</Button></div>
            </div>
          </Card>
        ) : (
          <Card title={t('insight.evidence.howTo')}>
            <ol className="small insight-steps">
              <li>{t('insight.evidence.v1')}</li>
              <li>{t('insight.evidence.v2')}</li>
              <li>{t('insight.evidence.v3')}</li>
            </ol>
            <pre className="insight-code" dir="ltr">unzip evidence-pack-*.zip -d pack && cd pack{'\n'}sha256sum -c SHA256SUMS</pre>
          </Card>
        )}
      </div>
      <Card title={t('insight.evidence.previous')} actions={<Button variant="ghost" onClick={packs.reload}>{t('common.refresh')}</Button>}>
        <AsyncView state={packs} empty={t('insight.evidence.none')}>
          {(list) => (
            <Table head={[t('tenders.number'), t('insight.evidence.generatedAt'), t('insight.evidence.by'), t('insight.evidence.stored'), 'SHA-256', t('common.size'), '']}>
              {list.map((p) => (
                <tr key={p.documentId}>
                  <td dir="ltr">{p.tenderNumber ?? t('insight.evidence.rangePack')}</td>
                  <td>{fmtDate(p.createdAt)}</td>
                  <td>{p.generatedBy ?? '—'}</td>
                  <td>{p.storeType === 'filenet' ? 'IBM FileNet' : t('insight.admin.localStore')}</td>
                  <td><Hash value={p.sha256} /></td>
                  <td>{fmtBytes(p.byteSize)}</td>
                  <td><Button variant="secondary" onClick={() => download(p)}>{t('common.download')}</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
