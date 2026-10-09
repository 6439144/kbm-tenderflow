import { TendersForYou } from '../../features/assistant';
import { VerifiedDocuments } from '../../features/docintel';
import { VendorLifecycleSummary } from '../../features/moi';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { VendorDashboard } from '../../features/insight';
import { useI18n } from '../../i18n';
import { DocList } from '../../components/shared';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, FileInput, Table, useAsync, useToast } from '../../components/ui';

export default function VendorHome() {
  const { t, te, pick, fmtDate } = useI18n();
  const toast = useToast();
  const me = useAsync(() => api.myVendor(), []);
  const tenders = useAsync(() => api.tenders(), []);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      await api.uploadVendorDocument(file, title.trim() || file.name);
      toast(t('vendor.uploaded'));
      setFile(null);
      setTitle('');
      me.reload();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('nav.myCompany')}</h1>
      <VendorDashboard />
      <Card title={t('vendor.companyStatus')}>
        <AsyncView state={me}>
          {(v) => (
            <div className="stack">
              <div className="row wrap">
                <strong className="lg">{pick(v.legalNameEn, v.legalNameAr)}</strong>
                <Badge value={v.status} label={te('vst.', v.status)} />
              </div>
              <dl className="kv">
                <dt>{t('reg.crNumber')}</dt>
                <dd dir="ltr">{v.crNumber}</dd>
                <dt>{t('reg.email')}</dt>
                <dd dir="ltr">{v.email}</dd>
                <dt>{t('common.categories')}</dt>
                <dd>{(v.categories ?? []).map((c) => te('cat.', c)).join('، ')}</dd>
                {v.decisionReason && (
                  <>
                    <dt>{t('vendors.decisionReason')}</dt>
                    <dd>{v.decisionReason}</dd>
                  </>
                )}
              </dl>
              <div className={`alert ${v.status === 'APPROVED' ? 'alert-success' : v.status === 'REJECTED' ? 'alert-danger' : 'alert-info'}`}>
                {v.status === 'APPROVED' ? t('vendor.approvedNote') : v.status === 'REJECTED' ? t('vendor.rejectedNote') : t('vendor.pendingNote')}
              </div>
              <h3>{t('vendor.documents')}</h3>
              <DocList docs={v.documents ?? []} empty={t('vendor.noDocs')} />
              <form className="inline-form" onSubmit={upload}>
                <h3>{t('vendor.uploadDoc')}</h3>
                {err ? <ErrorBox error={err} /> : null}
                <div className="grid-2">
                  <Field label={t('vendor.docTitle')}>
                    {(id) => <input id={id} value={title} placeholder={t('vendor.docTitlePh')} onChange={(e) => setTitle(e.target.value)} />}
                  </Field>
                  <FileInput label={t('common.file')} file={file} onChange={setFile} required />
                </div>
                <Button type="submit" busy={busy} disabled={!file}>
                  {t('common.upload')}
                </Button>
              </form>
            </div>
          )}
        </AsyncView>
      </Card>

      <VendorLifecycleSummary />
      <TendersForYou />
      <Card title={t('nav.availableTenders')} actions={<Button variant="ghost" onClick={tenders.reload}>{t('common.refresh')}</Button>}>
        <AsyncView state={tenders} empty={t('vendor.noTenders')}>
          {(list) => (
            <Table head={[t('tenders.number'), t('common.title'), t('common.category'), t('common.deadline'), t('common.status')]}>
              {list.map((x) => (
                <tr key={x.id}>
                  <td dir="ltr">{x.tenderNumber ?? '—'}</td>
                  <td>
                    <Link to={`/vendor/tenders/${x.id}`}>{pick(x.titleEn, x.titleAr)}</Link>
                  </td>
                  <td>{te('cat.', x.category)}</td>
                  <td>{fmtDate(x.submissionDeadline)}</td>
                  <td>
                    <Badge value={x.status} label={te('st.', x.status)} />
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>

      <VerifiedDocuments />
    </div>
  );
}
