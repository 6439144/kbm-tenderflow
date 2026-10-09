// Printable receipt (/receipt/:number) — FR-007 printable receipt; FR-022 (proposed) the entity's own number series
// referencing the payment gateway's transaction id. Tender-document purchases and subscription payments share the
// series. A TEST-gateway receipt says so in large type; it is never presented as a real payment.
import { Link, Navigate, useParams } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { homeFor, useSession } from '../../session';
import { Header } from '../../components/Layout';
import { AsyncView, Button, useAsync } from '../../components/ui';
import { moiApi } from './api';

export function ReceiptPage() {
  const { number = '' } = useParams();
  const { t, pick, fmtDate, fmtMoney, lang } = useI18n();
  const { user } = useSession();
  const st = useAsync(() => (user ? moiApi.receipt(number) : Promise.resolve(null)), [number, user?.id]);
  if (!user) return <Navigate to="/login" replace />;
  const other = lang === 'ar' ? 'en' : 'ar';
  return (
    <>
      <Header />
      <main id="main" className="page moi-receipt-page">
        <div className="row spread wrap moi-noprint">
          <Link to={homeFor(user)} className="backlink">
            ← {t('common.back')}
          </Link>
          <Button onClick={() => window.print()}>{t('moi.receipt.print')}</Button>
        </div>
        <AsyncView state={st}>
          {(r) =>
            r && (
              <article className="moi-receipt" aria-labelledby="moi-receipt-title">
                <header className="moi-receipt-head">
                  <span className="moi-mark" aria-hidden="true">
                    {r.entity.logoText ?? '—'}
                  </span>
                  <div>
                    <div className="moi-receipt-entity">{pick(r.entity.nameEn, r.entity.nameAr)}</div>
                    <div className="muted small" lang={other}>
                      {lang === 'ar' ? r.entity.nameEn : r.entity.nameAr}
                    </div>
                  </div>
                </header>
                <h1 id="moi-receipt-title">{t(r.kind === 'SUBSCRIPTION' ? 'moi.receipt.subTitle' : 'moi.receipt.docTitle')}</h1>
                {r.test && (
                  <div className="moi-receipt-test" role="note">
                    {t('moi.receipt.test')}
                  </div>
                )}
                <dl className="kv moi-receipt-kv">
                  <dt>{t('cycle.receiptNo')}</dt>
                  <dd dir="ltr">
                    <code>{r.receiptNumber}</code>
                  </dd>
                  <dt>{t('moi.receipt.vendor')}</dt>
                  <dd>
                    {pick(r.vendor.nameEn, r.vendor.nameAr)} · <span dir="ltr">{r.vendor.crNumber}</span>
                  </dd>
                  {r.tender && (
                    <>
                      <dt>{t('moi.receipt.tender')}</dt>
                      <dd>
                        <span dir="ltr">{r.tender.number}</span> — {pick(r.tender.titleEn, r.tender.titleAr)}
                      </dd>
                    </>
                  )}
                  {r.period && (
                    <>
                      <dt>{t('moi.sub.period')}</dt>
                      <dd>
                        {fmtDate(r.period.startsAt)} → {fmtDate(r.period.endsAt)}
                      </dd>
                    </>
                  )}
                  <dt>{t('cycle.amount')}</dt>
                  <dd>
                    <strong>{fmtMoney(r.amount, r.currency)}</strong>
                  </dd>
                  <dt>{t('cycle.gateway')}</dt>
                  <dd>{r.gateway ? t(`cycle.gwName.${r.gateway}` as TKey) : '—'}</dd>
                  <dt>{t('moi.receipt.txn')}</dt>
                  <dd dir="ltr">{r.gatewayTransactionId ? <code>{r.gatewayTransactionId}</code> : t('moi.receipt.noTxn')}</dd>
                  <dt>{t('cycle.paidAt')}</dt>
                  <dd>{fmtDate(r.paidAt)}</dd>
                </dl>
                <footer className="small muted">{t('moi.receipt.footer')}</footer>
              </article>
            )
          }
        </AsyncView>
      </main>
    </>
  );
}
