import { VendorCyclePanel, vendorBidBlock } from '../../features/cycle';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Bid, type BidReceipt } from '../../api';
import { useI18n } from '../../i18n';
import { DocButton } from '../../components/Layout';
import { Countdown, DocList, Receipt } from '../../components/shared';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, FileInput, Spinner, useAsync, useToast } from '../../components/ui';

export default function VendorTender() {
  const { id = '' } = useParams();
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const toast = useToast();
  const tender = useAsync(() => api.tender(id), [id]);
  const me = useAsync(() => api.myVendor(), []);
  const bids = useAsync(() => api.bids(id), [id]);
  const [question, setQuestion] = useState('');
  const [qBusy, setQBusy] = useState(false);
  const [qErr, setQErr] = useState<unknown>(null);
  const [tech, setTech] = useState<File | null>(null);
  const [fin, setFin] = useState<File | null>(null);
  const [bBusy, setBBusy] = useState(false);
  const [bErr, setBErr] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<BidReceipt | null>(null);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    setQBusy(true);
    setQErr(null);
    try {
      await api.askClarification(id, question.trim());
      toast(t('vendor.questionSent'));
      setQuestion('');
      tender.reload();
    } catch (e2) {
      setQErr(e2);
    } finally {
      setQBusy(false);
    }
  };

  const submitBid = async (e: FormEvent) => {
    e.preventDefault();
    if (!tech || !fin) return;
    setBBusy(true);
    setBErr(null);
    try {
      const r = await api.submitBid(id, tech, fin);
      setReceipt(r);
      setTech(null);
      setFin(null);
      toast(t('vendor.bidSubmitted'));
      bids.reload();
    } catch (e2) {
      setBErr(e2);
    } finally {
      setBBusy(false);
    }
  };

  const existing: Bid | undefined = bids.data?.[0];
  const existingReceipt: BidReceipt | null = existing
    ? { bidId: existing.id, submittedAt: existing.submittedAt ?? '', receiptSha256: existing.receiptSha256 ?? '', files: existing.files ?? [] }
    : null;

  return (
    <div className="stack">
      <Link to="/vendor" className="backlink">
        ← {t('common.back')}
      </Link>
      <AsyncView state={tender}>
        {(td) => {
          const open = td.status === 'PUBLISHED' && new Date(td.submissionDeadline).getTime() > Date.now();
          const approved = me.data?.status === 'APPROVED';
          const packDocs = (td.documents ?? []).filter((d) => !d.ownerType || d.ownerType === 'TENDER_PACK' || d.ownerType === 'ADDENDUM');
          const clar = td.clarifications ?? [];
          const cycleBlock = vendorBidBlock(td);
          return (
            <>
              <header className="page-head">
                <div>
                  <div className="muted small" dir="ltr">
                    {td.tenderNumber}
                  </div>
                  <h1>{pick(td.titleEn, td.titleAr)}</h1>
                </div>
                <Badge value={td.status} label={te('st.', td.status)} />
              </header>
              <div className="grid-main">
                <div className="stack">
                  <Card title={t('td.overview')}>
                    <dl className="kv">
                      <dt>{t('common.category')}</dt>
                      <dd>{te('cat.', td.category)}</dd>
                      <dt>{t('common.budget')}</dt>
                      <dd>{fmtMoney(td.estimatedBudget, td.currency ?? 'KWD')}</dd>
                      <dt>{t('common.deadline')}</dt>
                      <dd>
                        {fmtDate(td.submissionDeadline)} · <Countdown deadline={td.submissionDeadline} />
                      </dd>
                    </dl>
                    {pick(td.descriptionEn, td.descriptionAr) && <p className="prewrap">{pick(td.descriptionEn, td.descriptionAr)}</p>}
                    {(td.requiredDocuments?.length ?? 0) > 0 && (
                      <>
                        <h3>{t('td.requiredDocs')}</h3>
                        <ul>
                          {td.requiredDocuments!.map((r) => (
                            <li key={r.key}>{pick(r.nameEn, r.nameAr)}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {(td.criteria?.length ?? 0) > 0 && (
                      <>
                        <h3>{t('td.criteria')}</h3>
                        <ul>
                          {td.criteria!.map((c) => (
                            <li key={c.key}>
                              {pick(c.nameEn, c.nameAr)} — {c.weight}%
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </Card>
                  <VendorCyclePanel td={td} onChange={tender.reload} />
                  <Card title={t('vendor.packDocs')}>
                    <DocList docs={packDocs} empty={t('vendor.noPackDocs')} />
                  </Card>
                  <Card title={t('vendor.clarifications')}>
                    {clar.length === 0 ? (
                      <p className="muted">{t('vendor.noClarifications')}</p>
                    ) : (
                      <ul className="qa-list">
                        {clar.map((c) => (
                          <li key={c.id} className="qa">
                            <div className="q">
                              <strong>Q.</strong> {c.question}
                            </div>
                            {c.answer ? (
                              <div className="a">
                                <strong>A.</strong> <span className="prewrap">{c.answer}</span>
                                <div className="muted small">{fmtDate(c.answeredAt)}</div>
                              </div>
                            ) : (
                              <div className="muted small">{t('vendor.yourQuestion')}</div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {open && (
                      <form onSubmit={ask} className="inline-form">
                        {qErr ? <ErrorBox error={qErr} /> : null}
                        <Field label={t('vendor.questionLabel')} required>
                          {(fid) => <textarea id={fid} rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} required />}
                        </Field>
                        <Button type="submit" busy={qBusy} disabled={!question.trim()}>
                          {t('vendor.askQuestion')}
                        </Button>
                      </form>
                    )}
                  </Card>
                </div>
                <div className="stack">
                  <Card title={t('vendor.submitBid')}>
                    {receipt ? (
                      <Receipt receipt={receipt} />
                    ) : bids.loading && !bids.data ? (
                      <Spinner />
                    ) : existingReceipt ? (
                      <>
                        <Receipt receipt={existingReceipt} />
                        {(existing?.documents?.length ?? 0) > 0 && (
                          <>
                            <h4>{t('vendor.yourFiles')}</h4>
                            <ul className="plain">
                              {existing!.documents!.map((d) => (
                                <li key={d.id} className="row">
                                  <span>{d.ownerType ? te('doc.', d.ownerType) : d.title}</span>
                                  <DocButton path={api.bidDocumentPath(existing!.id, d.id)} name={d.title} />
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </>
                    ) : null}
                    {bids.error ? <ErrorBox error={bids.error} onRetry={bids.reload} /> : null}
                    {!open ? (
                      <p className="muted">{t('vendor.biddingClosed')}</p>
                    ) : me.data && !approved ? (
                      <div className="alert alert-info">{t('vendor.notApprovedBid')}</div>
                    ) : cycleBlock ? (
                      <div className={`alert ${cycleBlock === 'NOT_ELIGIBLE' ? 'alert-danger' : 'alert-warn'}`} role="status">
                        <div>
                          <strong>{t(cycleBlock === 'NOT_ELIGIBLE' ? 'cycle.v.blockNotEligible' : 'cycle.v.blockPurchase')}</strong>
                          <div className="small">
                            {t(cycleBlock === 'NOT_ELIGIBLE' ? 'cycle.v.blockNotEligibleHint' : 'cycle.v.blockPurchaseHint')}{' '}
                            <a href={cycleBlock === 'NOT_ELIGIBLE' ? '#sec-eligibility' : '#sec-purchase'}>{t('cycle.v.blockLink')}</a>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={submitBid} className="inline-form">
                        {bErr ? <ErrorBox error={bErr} /> : null}
                        <FileInput label={t('vendor.technicalFile')} file={tech} onChange={setTech} required />
                        <FileInput label={t('vendor.financialFile')} file={fin} onChange={setFin} required />
                        {(existingReceipt || receipt) && <p className="muted small">{t('vendor.resubmitNote')}</p>}
                        <Button type="submit" busy={bBusy} disabled={!tech || !fin}>
                          {t('vendor.submitBid')}
                        </Button>
                      </form>
                    )}
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
