import { useState } from 'react';
import { ClassificationsEditor } from '../../features/cycle';
import { VendorGradeReview } from '../../features/assistant';
import { api, type Vendor } from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DocList } from '../../components/shared';
import { VerifiedDocuments } from '../../features/docintel';
import { AsyncView, Badge, Button, Card, Modal, ReasonDialog, Table, useAsync, useToast } from '../../components/ui';
import { VendorCustomFields } from '../../features/lowcode';

const FILTERS = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', ''];

export default function VendorsQueue() {
  const { t, te, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState('PENDING_REVIEW');
  // §1 names the state PENDING_REVIEW while §6 says "PENDING": for the pending queue fetch all and match both.
  const list = useAsync(
    () =>
      status === 'PENDING_REVIEW'
        ? api.vendors().then((vs) => vs.filter((v) => v.status === 'PENDING_REVIEW' || v.status === 'PENDING'))
        : api.vendors(status || undefined),
    [status],
  );
  const [viewId, setViewId] = useState<string | null>(null);
  const [decide, setDecide] = useState<{ v: Vendor; d: 'APPROVE' | 'REJECT' } | null>(null);
  const detail = useAsync(() => (viewId ? api.vendor(viewId) : Promise.resolve(null)), [viewId]);
  const canDecide = hasRole('PROCUREMENT_OFFICER');

  return (
    <div className="stack">
      <h1>{t('vendors.title')}</h1>
      <div className="segmented" role="group" aria-label={t('common.filter')}>
        {FILTERS.map((f) => (
          <button key={f || 'all'} type="button" className={status === f ? 'on' : ''} aria-pressed={status === f} onClick={() => setStatus(f)}>
            {f ? te('vst.', f) : t('common.all')}
          </button>
        ))}
      </div>
      <Card>
        <AsyncView state={list} empty={t('vendors.empty')}>
          {(vs) => (
            <Table head={[t('vendors.name'), t('vendors.cr'), t('common.categories'), t('vendors.contact'), t('common.createdAt'), t('common.status'), t('common.actions')]}>
              {vs.map((v) => (
                <tr key={v.id}>
                  <td>
                    <div>{pick(v.legalNameEn, v.legalNameAr)}</div>
                    <div className="muted small">{pick(v.legalNameAr, v.legalNameEn)}</div>
                  </td>
                  <td dir="ltr">{v.crNumber}</td>
                  <td>{(v.categories ?? []).map((c) => te('cat.', c)).join('، ')}</td>
                  <td dir="ltr" className="small">
                    {v.email}
                    <br />
                    {v.phone}
                  </td>
                  <td>{fmtDate(v.createdAt)}</td>
                  <td>
                    <Badge value={v.status} label={te('vst.', v.status)} />
                  </td>
                  <td>
                    <div className="row">
                      <Button variant="ghost" onClick={() => setViewId(v.id)}>
                        {t('common.view')}
                      </Button>
                      {canDecide && v.status !== 'APPROVED' && v.status !== 'REJECTED' && (
                        <>
                          <Button onClick={() => setDecide({ v, d: 'APPROVE' })}>{t('vendors.approve')}</Button>
                          <Button variant="danger" onClick={() => setDecide({ v, d: 'REJECT' })}>
                            {t('vendors.reject')}
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </AsyncView>
      </Card>

      <Modal open={Boolean(viewId)} onClose={() => setViewId(null)} title={t('vendors.details')} wide>
        <AsyncView state={detail} isEmpty={(d) => !d}>
          {(v) =>
            v && (
              <div className="stack">
                <div className="row wrap">
                  <strong className="lg">{pick(v.legalNameEn, v.legalNameAr)}</strong>
                  <Badge value={v.status} label={te('vst.', v.status)} />
                </div>
                <dl className="kv">
                  <dt>{t('reg.legalNameEn')}</dt>
                  <dd dir="ltr">{v.legalNameEn}</dd>
                  <dt>{t('reg.legalNameAr')}</dt>
                  <dd dir="rtl">{v.legalNameAr}</dd>
                  <dt>{t('vendors.cr')}</dt>
                  <dd dir="ltr">{v.crNumber}</dd>
                  <dt>{t('reg.email')}</dt>
                  <dd dir="ltr">{v.email}</dd>
                  <dt>{t('reg.phone')}</dt>
                  <dd dir="ltr">{v.phone}</dd>
                  {v.decisionReason && (
                    <>
                      <dt>{t('vendors.decisionReason')}</dt>
                      <dd>{v.decisionReason}</dd>
                    </>
                  )}
                </dl>
                <VendorCustomFields vendorId={v.id} custom={(v as any).custom} canEdit={hasRole('PROCUREMENT_OFFICER', 'TENANT_ADMIN', 'GRADING_AUTHORITY')} onSaved={detail.reload} />
                <h3>{t('vendor.documents')}</h3>
                <DocList docs={v.documents ?? []} empty={t('vendor.noDocs')} />
                <VerifiedDocuments vendorId={v.id} />
                <ClassificationsEditor vendorId={v.id} canEdit={hasRole('PROCUREMENT_OFFICER', 'TENANT_ADMIN')} />
                <VendorGradeReview vendorId={v.id} />
              </div>
            )
          }
        </AsyncView>
      </Modal>

      <ReasonDialog
        open={Boolean(decide)}
        title={decide?.d === 'REJECT' ? t('vendors.rejectTitle') : t('vendors.approveTitle')}
        confirmLabel={decide?.d === 'REJECT' ? t('vendors.reject') : t('vendors.approve')}
        variant={decide?.d === 'REJECT' ? 'danger' : 'primary'}
        required={decide?.d === 'REJECT'}
        onClose={() => setDecide(null)}
        onConfirm={async (reason) => {
          if (!decide) return;
          await api.decideVendor(decide.v.id, decide.d, reason);
          toast(t('vendors.decided'));
          list.reload();
        }}
      />
    </div>
  );
}
