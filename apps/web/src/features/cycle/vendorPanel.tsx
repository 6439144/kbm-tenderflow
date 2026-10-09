// Vendor tender page: eligibility result, paid tender documents (TEST gateway, clearly labelled), notices.
import { useState } from 'react';
import { api, type TenderDetail } from '../../api';
import { platform } from '../../api-platform';
import { useI18n } from '../../i18n';
import { DocButton } from '../../components/Layout';
import { Button, Card, ErrorBox, useToast } from '../../components/ui';
import { useCycleFmt } from './common';
import { GatewayBadge } from './tenderPanel';

/** Why the bid form is closed for this vendor (null = may bid as far as the cycle is concerned). */
export function vendorBidBlock(td: TenderDetail): 'NOT_ELIGIBLE' | 'PURCHASE_REQUIRED' | null {
  if (td.myEligibility && !td.myEligibility.eligible) return 'NOT_ELIGIBLE';
  if (td.cycle?.stages.documentPurchase && !td.myPurchase) return 'PURCHASE_REQUIRED';
  return null;
}

export function VendorCyclePanel({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const { grade } = useCycleFmt();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const cfg = td.cycle;
  const el = td.myEligibility;
  const rule = el?.rule ?? td.eligibilityRule;
  const hasRule = Boolean(rule && (rule.activityCodes.length || rule.minGrade !== null));
  const open = td.status === 'PUBLISHED' && new Date(td.submissionDeadline).getTime() > Date.now();
  const purchase = td.myPurchase;
  const notices = (td.publications ?? []).filter((p) => p.channel !== 'PORTAL' && p.status === 'PUBLISHED');

  const buy = async () => {
    setBusy(true);
    setErr(null);
    try {
      await platform.purchase(td.id, 'TEST');
      toast(t('cycle.v.bought'));
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card id="sec-eligibility" title={t('cycle.v.eligibility')}>
        {!el ? (
          <p className="muted">{t('cycle.v.noEligibility')}</p>
        ) : el.eligible ? (
          <div className="alert alert-success" role="status">
            <div>
              <strong>{t('cycle.v.eligible')}</strong>
              {!hasRule && <div className="small">{t('cycle.v.openToAll')}</div>}
            </div>
          </div>
        ) : (
          <div className="alert alert-danger" role="status">
            <div>
              <strong>{t('cycle.v.notEligible')}</strong>
              <ul className="cyc-reasons">
                {el.reasons.map((r) => (
                  <li key={r.code}>{pick(r.en, r.ar)}</li>
                ))}
              </ul>
              <div className="small">{t('cycle.v.notEligibleHint')}</div>
            </div>
          </div>
        )}
        {hasRule && rule && (
          <dl className="kv">
            <dt>{t('cycle.activityCodes')}</dt>
            <dd dir="ltr">{rule.activityCodes.length ? rule.activityCodes.join(', ') : t('cycle.anyCode')}</dd>
            <dt>{t('cycle.minGrade')}</dt>
            <dd>{grade(rule.minGrade)}</dd>
          </dl>
        )}
      </Card>

      {cfg?.stages.documentPurchase && (
        <Card id="sec-purchase" title={t('cycle.v.documents')}>
          {purchase ? (
            <div className="cyc-receipt" role="status">
              <div className="row spread wrap">
                <strong>{t(purchase.status === 'EXEMPTED' ? 'cycle.v.exempted' : 'cycle.v.purchased')}</strong>
                <GatewayBadge gateway={purchase.gateway} />
              </div>
              <dl className="kv">
                <dt>{t('cycle.receiptNo')}</dt>
                <dd dir="ltr">
                  <code>{purchase.receiptNumber}</code>
                </dd>
                <dt>{t('cycle.amount')}</dt>
                <dd>{fmtMoney(purchase.amount, purchase.currency)}</dd>
                <dt>{t('cycle.gateway')}</dt>
                <dd>{te('cycle.gwName.', purchase.gateway)}</dd>
                {purchase.paymentRef && (
                  <>
                    <dt>{t('cycle.paymentRef')}</dt>
                    <dd dir="ltr">
                      <code>{purchase.paymentRef}</code>
                    </dd>
                  </>
                )}
                <dt>{t('cycle.paidAt')}</dt>
                <dd>{fmtDate(purchase.paidAt)}</dd>
              </dl>
              {purchase.gateway === 'TEST' && <div className="cyc-test-banner small">{t('cycle.testBanner')}</div>}
            </div>
          ) : (
            <>
              <div className="cyc-price">
                <span className="muted">{t('cycle.v.price')}</span>
                <strong className="lg">{fmtMoney(cfg.fees.documentPrice, cfg.fees.currency || 'KWD')}</strong>
              </div>
              <p className="small">{t('cycle.v.purchaseRequired')}</p>
              <div className="cyc-test-banner" role="note">
                <strong>{t('cycle.testTitle')}</strong> {t('cycle.testBody')}
              </div>
              {err ? <ErrorBox error={err} /> : null}
              <Button
                busy={busy}
                onClick={buy}
                disabled={!open || (el ? !el.eligible : false)}
                disabledReason={!open ? t('vendor.biddingClosed') : el && !el.eligible ? t('cycle.v.notEligible') : undefined}
              >
                {t('cycle.v.buy')}
              </Button>
            </>
          )}
        </Card>
      )}

      {notices.length > 0 && (
        <Card title={t('cycle.v.notices')}>
          <ul className="plain cyc-notices">
            {notices.map((p) => (
              <li key={p.id} className="row spread wrap">
                <div>
                  <strong>{te('cycle.ch.', p.channel)}</strong>
                  <div className="small">
                    {t('cycle.p.reference')}: <code dir="ltr">{p.reference}</code> · {fmtDate(p.publishedOn)}
                  </div>
                </div>
                {p.documentId && (
                  <DocButton path={api.documentPath(p.documentId)} name={`notice-${p.channel}.html`} mode="open" variant="secondary" label={t('cycle.v.viewNotice')} />
                )}
              </li>
            ))}
          </ul>
          <p className="muted small">{t('cycle.v.noticesNote')}</p>
        </Card>
      )}
    </>
  );
}
