// Staff tender page: the configured cycle of this tender (pinned template), approval chains, publication
// channels, document sales and the two-envelope financial opening.
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type AuditEvent, type TenderDetail } from '../../api';
import { platform, type FinancialOpening, type Publication, type Purchase } from '../../api-platform';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DocButton } from '../../components/Layout';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, Table, useAsync, useToast } from '../../components/ui';
import { ChainView, PUB_TONE, StageStrip, TemplateBadge, waitingStep, type CycleBid, type StageState, type Step } from './common';

const PUBLISHED_PLUS = ['PUBLISHED', 'CLOSED', 'OPENED', 'EVALUATION', 'AWARDED'];

/** Where the tender is in its own configured cycle. */
export function stageStates(td: TenderDetail): Record<string, StageState> {
  const stages = (td.stages ?? []).filter((s) => s.enabled);
  const awardPending = td.award?.status === 'RECOMMENDED' && td.status !== 'AWARDED';
  const cur: Record<string, string[]> = {
    DRAFT: ['DRAFT'],
    PENDING_APPROVAL: ['APPROVAL'],
    APPROVED: ['PUBLISH'],
    PUBLISHED: ['DOCUMENT_PURCHASE', 'CLARIFICATIONS', 'SEALED_BIDS'],
    CLOSED: ['OPENING'],
    OPENED: ['COMPLIANCE', 'EVALUATION'],
    EVALUATION: awardPending ? ['AWARD_APPROVAL'] : ['COMPLIANCE', 'EVALUATION'],
    AWARDED: td.cycle?.stages.recordsLock && !td.recordsLockedAt ? ['RECORDS_LOCK'] : [],
  };
  const out: Record<string, StageState> = {};
  if (td.status === 'CANCELLED') return out;
  const currentKeys = (cur[td.status] ?? []).filter((k) => stages.some((s) => s.key === k));
  const firstIdx = currentKeys.length ? stages.findIndex((s) => currentKeys.includes(s.key)) : stages.length;
  stages.forEach((s, i) => {
    let st: StageState = i < firstIdx ? 'done' : currentKeys.includes(s.key) ? 'current' : 'todo';
    if (st === 'done' && s.key === 'REQUEST_INTAKE' && !td.request) st = 'attention';
    if (st === 'done' && (s.key === 'GAZETTE' || s.key === 'CAPT')) {
      const ch = s.key === 'GAZETTE' ? 'KUWAIT_ALYOUM' : 'CAPT';
      st = td.publications?.some((p) => p.channel === ch && p.status === 'PUBLISHED') ? 'done' : 'attention';
    }
    out[s.key] = st;
  });
  return out;
}

export function TenderCyclePanel({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, fmtDate } = useI18n();
  const cfg = td.cycle;
  const states = useMemo(() => stageStates(td), [td]);
  const publishChain = (td.approvalChain ?? []) as Step[];
  const awardChain = (td.awardChain ?? null) as Step[] | null;
  const waiting = waitingStep(publishChain);
  return (
    <>
      <Card
        id="sec-cycle"
        title={t('cycle.p.title')}
        actions={
          <div className="row wrap">
            {td.recordsLockedAt && <Badge tone="success" label={t('cycle.p.recordsLocked', { at: fmtDate(td.recordsLockedAt) })} />}
            <TemplateBadge tpl={td.template} />
          </div>
        }
      >
        {!td.template && <p className="muted small">{t('cycle.p.noTemplateNote')}</p>}
        {td.request && (
          <p className="cyc-request-link">
            {t('cycle.p.fromRequest')}{' '}
            <Link to={`/procurement/requests/${td.request.id}`}>
              <span dir="ltr">{td.request.requestNumber}</span> — {td.request.subject}
            </Link>
          </p>
        )}
        <StageStrip stages={td.stages ?? []} cfg={cfg} states={states} hideOff />
        <div className="cyc-chains-view">
          <div>
            <h3>
              {t('cycle.gate.publish')}
              {waiting && ['DRAFT', 'PENDING_APPROVAL'].includes(td.status) && (
                <span className="muted small"> · {t('cycle.levelOf', { n: waiting.level, total: publishChain.length })}</span>
              )}
            </h3>
            {publishChain.length ? <ChainView steps={publishChain} /> : <ChainView levels={cfg?.approvals.publish} />}
          </div>
          {(awardChain || ['EVALUATION', 'AWARDED'].includes(td.status)) && (
            <div>
              <h3>{t('cycle.gate.award')}</h3>
              {awardChain ? <ChainView steps={awardChain} /> : <ChainView levels={cfg?.approvals.award} />}
            </div>
          )}
        </div>
      </Card>
      <PublicationsCard td={td} onChange={onChange} />
      {cfg?.stages.documentPurchase && <PurchasesCard td={td} onChange={onChange} />}
      {cfg?.envelopes === 'TWO' && <EnvelopesCard td={td} onChange={onChange} />}
    </>
  );
}

// ---------------------------------------------------------------- publication channels

type Channel = 'KUWAIT_ALYOUM' | 'CAPT';

function PublicationsCard({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, te, fmtDate } = useI18n();
  const { user, hasRole } = useSession();
  const toast = useToast();
  const cfg = td.cycle;
  const enabled: Channel[] = [...(cfg?.stages.gazette ? (['KUWAIT_ALYOUM'] as const) : []), ...(cfg?.stages.capt ? (['CAPT'] as const) : [])];
  const pubs = td.publications ?? [];
  // The author of each notice comes from the tender's audit trail (segregation of duties: author ≠ approver).
  const audit = useAsync(() => (enabled.length ? api.audit({ resourceId: td.id, limit: 200 }) : Promise.resolve<AuditEvent[]>([])), [td.id, td.updatedAt, pubs.length]);
  const authorOf = (pubId: string) => {
    const ev = [...(audit.data ?? [])]
      .filter((e) => e.action === 'NOTICE_DRAFTED' && (e.details as Record<string, unknown> | undefined)?.publicationId === pubId)
      .sort((a, b) => Number(b.seq ?? 0) - Number(a.seq ?? 0))[0];
    return ev?.actorId ?? null;
  };
  const isOfficer = hasRole('PROCUREMENT_OFFICER');
  const canApprove = hasRole('DIRECTOR', 'UNDERSECRETARY');
  const draftable = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'].includes(td.status);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const approve = async (p: Publication) => {
    setBusy(p.id);
    setErr(null);
    try {
      await platform.approveNotice(p.id);
      toast(t('cycle.p.noticeApproved'));
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const rows: { channel: Publication['channel']; p?: Publication }[] = [
    { channel: 'PORTAL', p: pubs.find((x) => x.channel === 'PORTAL') },
    ...enabled.map((c) => ({ channel: c, p: pubs.find((x) => x.channel === c) })),
  ];

  return (
    <Card id="sec-publications" title={t('cycle.p.publications')}>
      <p className="muted small">{t('cycle.p.publicationsHint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <Table head={[t('cycle.p.channel'), t('common.status'), t('cycle.p.reference'), t('cycle.p.publishedOn'), t('cycle.p.notice'), t('common.actions')]}>
        {rows.map(({ channel, p }) => {
          const author = p ? authorOf(p.id) : null;
          const mine = Boolean(user && author && author === user.id);
          return (
            <tr key={channel}>
              <th scope="row">{te('cycle.ch.', channel)}</th>
              <td>{p ? <Badge tone={PUB_TONE[p.status]} label={te('cycle.pst.', p.status)} /> : <Badge tone="neutral" label={t('cycle.p.notDrafted')} />}</td>
              <td dir="ltr">{p?.reference ?? '—'}</td>
              <td>{p?.publishedOn ? fmtDate(p.publishedOn) : '—'}</td>
              <td>
                {p?.documentId ? (
                  <DocButton path={api.documentPath(p.documentId)} name={`notice-${channel}.html`} mode="open" variant="secondary" label={t('common.open')} />
                ) : p && channel !== 'PORTAL' ? (
                  <details className="cyc-notice">
                    <summary>{t('cycle.p.viewText')}</summary>
                    <div className="cyc-notice-text" dir="ltr" lang="en">
                      {p.noticeEn}
                    </div>
                    <div className="cyc-notice-text" dir="rtl" lang="ar">
                      {p.noticeAr}
                    </div>
                  </details>
                ) : (
                  '—'
                )}
              </td>
              <td>
                {channel !== 'PORTAL' && (
                  <div className="row wrap">
                    {isOfficer && draftable && p?.status !== 'PUBLISHED' && (
                      <Button variant="secondary" onClick={() => setEditing(channel as Channel)}>
                        {p ? t('cycle.p.editNotice') : t('cycle.p.draftNotice')}
                      </Button>
                    )}
                    {canApprove && p?.status === 'DRAFT' && (
                      <Button busy={busy === p.id} onClick={() => approve(p)} disabled={mine} disabledReason={mine ? t('cycle.p.authorCannotApprove') : undefined}>
                        {t('cycle.p.approveNotice')}
                      </Button>
                    )}
                    {isOfficer && p?.status === 'APPROVED' && (
                      <Button
                        onClick={() => setRecording(p.id)}
                        disabled={!PUBLISHED_PLUS.includes(td.status)}
                        disabledReason={!PUBLISHED_PLUS.includes(td.status) ? t('cycle.p.publishFirst') : undefined}
                      >
                        {t('cycle.p.record')}
                      </Button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
      {enabled.length === 0 && <p className="muted small">{t('cycle.p.noChannels')}</p>}
      {editing && (
        <NoticeForm
          key={editing}
          tenderId={td.id}
          channels={enabled.filter((c) => pubs.find((x) => x.channel === c)?.status !== 'PUBLISHED')}
          initial={editing}
          existing={pubs}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}
      {recording && (
        <RecordForm
          pub={pubs.find((x) => x.id === recording)!}
          onClose={() => setRecording(null)}
          onSaved={() => {
            setRecording(null);
            onChange();
          }}
        />
      )}
    </Card>
  );
}

function NoticeForm({
  tenderId,
  channels,
  initial,
  existing,
  onClose,
  onSaved,
}: {
  tenderId: string;
  channels: Channel[];
  initial: Channel;
  existing: Publication[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, te } = useI18n();
  const toast = useToast();
  const [channel, setChannel] = useState<Channel>(initial);
  const prev = (c: Channel) => existing.find((x) => x.channel === c);
  const [en, setEn] = useState(prev(initial)?.noticeEn ?? '');
  const [ar, setAr] = useState(prev(initial)?.noticeAr ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await platform.saveNotice(tenderId, { channel, noticeEn: en.trim(), noticeAr: ar.trim() });
      toast(t('cycle.p.noticeSaved'));
      onSaved();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>{t('cycle.p.noticeFormTitle')}</h3>
      <p className="muted small">{t('cycle.p.noticeFormHint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <Field label={t('cycle.p.channel')} required>
        {(id) => (
          <select
            id={id}
            value={channel}
            onChange={(e) => {
              const c = e.target.value as Channel;
              setChannel(c);
              setEn(prev(c)?.noticeEn ?? '');
              setAr(prev(c)?.noticeAr ?? '');
            }}
          >
            {channels.map((c) => (
              <option key={c} value={c}>
                {te('cycle.ch.', c)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="grid-2">
        <Field label={t('cycle.p.noticeEn')} required>
          {(id) => <textarea id={id} rows={7} value={en} onChange={(e) => setEn(e.target.value)} required dir="ltr" lang="en" />}
        </Field>
        <Field label={t('cycle.p.noticeAr')} required>
          {(id) => <textarea id={id} rows={7} value={ar} onChange={(e) => setAr(e.target.value)} required dir="rtl" lang="ar" />}
        </Field>
      </div>
      <div className="row">
        <Button type="submit" busy={busy} disabled={!en.trim() || !ar.trim()}>
          {t('cycle.p.saveNotice')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function RecordForm({ pub, onClose, onSaved }: { pub: Publication; onClose: () => void; onSaved: () => void }) {
  const { t, te } = useI18n();
  const toast = useToast();
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await platform.recordNotice(pub.id, reference.trim(), date);
      toast(t('cycle.p.recorded'));
      onSaved();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>{t('cycle.p.recordTitle', { channel: te('cycle.ch.', pub.channel) })}</h3>
      <p className="muted small">{t('cycle.p.recordHint')}</p>
      {err ? <ErrorBox error={err} /> : null}
      <div className="grid-2">
        <Field label={t('cycle.p.reference')} required>
          {(id) => <input id={id} value={reference} onChange={(e) => setReference(e.target.value)} required dir="ltr" placeholder="KA-2026-1234" />}
        </Field>
        <Field label={t('cycle.p.publishedOn')} required>
          {(id) => <input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required dir="ltr" />}
        </Field>
      </div>
      <div className="row">
        <Button type="submit" busy={busy} disabled={!reference.trim() || !date}>
          {t('cycle.p.record')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- document sales (staff)

export function GatewayBadge({ gateway }: { gateway: Purchase['gateway'] }) {
  const { t } = useI18n();
  if (gateway === 'TEST') return <Badge tone="warn" label={t('cycle.gw.TEST')} />;
  if (gateway === 'EXEMPT') return <Badge tone="info" label={t('cycle.gw.EXEMPT')} />;
  return <Badge tone="success" label={t('cycle.gw.KNET')} />;
}

function PurchasesCard({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, pick, fmtDate, fmtMoney } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const cfg = td.cycle!;
  const list = useAsync(async () => {
    const r = await platform.purchases(td.id);
    return Array.isArray(r) ? r : r ? [r] : [];
  }, [td.id, td.purchaseCount]);
  const canExempt = cfg.fees.exemptionAllowed && hasRole('PROCUREMENT_OFFICER', 'DIRECTOR') && td.status === 'PUBLISHED';
  const vendors = useAsync(() => (canExempt ? api.vendors('APPROVED') : Promise.resolve([])), [canExempt]);
  const [vendorId, setVendorId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const bought = new Set((list.data ?? []).map((p) => p.vendorId));
  const candidates = (vendors.data ?? []).filter((v) => !bought.has(v.id) && (v.categories ?? []).includes(td.category));

  const exempt = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await platform.exempt(td.id, vendorId, reason.trim());
      toast(t('cycle.p.exempted'));
      setVendorId('');
      setReason('');
      list.reload();
      onChange();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      id="sec-purchases"
      title={t('cycle.p.purchases')}
      actions={<Badge tone="info" label={t('cycle.p.purchaseCount', { n: list.data?.length ?? td.purchaseCount ?? 0 })} />}
    >
      <p className="muted small">
        {t('cycle.p.purchasesHint', { price: fmtMoney(cfg.fees.documentPrice, cfg.fees.currency || 'KWD') })} {t('cycle.testNote')}
      </p>
      <AsyncView state={list} empty={t('cycle.p.noPurchases')}>
        {(xs) => (
          <Table head={[t('td.vendor'), t('cycle.receiptNo'), t('cycle.amount'), t('cycle.gateway'), t('cycle.paidAt')]}>
            {xs.map((p) => (
              <tr key={p.id}>
                <td>{pick(p.legalNameEn, p.legalNameAr)}</td>
                <td dir="ltr">
                  <code>{p.receiptNumber}</code>
                </td>
                <td>{fmtMoney(p.amount, p.currency)}</td>
                <td>
                  <GatewayBadge gateway={p.gateway} />
                </td>
                <td className="nowrap">{fmtDate(p.paidAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
      {canExempt && (
        <form className="inline-form" onSubmit={exempt}>
          <h3>{t('cycle.p.exemptTitle')}</h3>
          <p className="muted small">{t('cycle.p.exemptHint')}</p>
          {err ? <ErrorBox error={err} /> : null}
          <div className="grid-2">
            <Field label={t('td.vendor')} required>
              {(id) => (
                <select id={id} value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
                  <option value="">{t('cycle.p.chooseVendor')}</option>
                  {candidates.map((v) => (
                    <option key={v.id} value={v.id}>
                      {pick(v.legalNameEn, v.legalNameAr)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('common.reason')} required>
              {(id) => <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} required />}
            </Field>
          </div>
          <Button type="submit" variant="secondary" busy={busy} disabled={!vendorId || !reason.trim()}>
            {t('cycle.p.exemptBtn')}
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- two envelopes

function EnvelopesCard({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const cfg = td.cycle!;
  const pass = cfg.evaluation.technicalPassMark;
  const opened = ['OPENED', 'EVALUATION', 'AWARDED'].includes(td.status);
  const bids = useAsync(() => (opened ? (api.bids(td.id) as Promise<CycleBid[]>) : Promise.resolve<CycleBid[]>([])), [td.id, opened, td.financialOpenedAt]);
  const [result, setResult] = useState<FinancialOpening | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const canOpen = hasRole('COMMITTEE_CHAIR') && ['OPENED', 'EVALUATION'].includes(td.status) && !td.financialOpenedAt;
  const finRecordId =
    result?.recordDocumentId ??
    (td.documents ?? []).find((d) => d.ownerType === 'OPENING_RECORD' && d.id !== td.opening?.recordDocumentId && td.financialOpenedAt)?.id ??
    null;

  const openFin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await platform.openFinancial(td.id, notes.trim() || undefined);
      setResult(r);
      toast(t('cycle.p.finOpened'));
      onChange();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  const rows = result
    ? result.results.map((r) => ({ id: r.bidId, name: pick(r.vendorNameEn, r.vendorNameAr), score: r.technicalScore, res: r.result }))
    : (bids.data ?? [])
        .filter((b) => b.technicalResult)
        .map((b) => ({ id: b.id, name: pick(b.vendorNameEn, b.vendorNameAr), score: b.technicalScore ?? null, res: b.technicalResult! }));

  return (
    <Card id="sec-envelopes" title={t('cycle.p.envelopes')}>
      <ol className="cyc-env">
        <li className={opened ? 'cyc-env-open' : 'cyc-env-sealed'}>
          <span className="cyc-env-icon" aria-hidden="true">
            {opened ? '✓' : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>}
          </span>
          <div>
            <strong>{t('cycle.p.techEnv')}</strong>
            <div className="small">{opened ? t('cycle.p.techOpened', { at: fmtDate(td.opening?.openedAt ?? td.openedAt) }) : t('cycle.p.techSealed')}</div>
          </div>
        </li>
        <li className={td.financialOpenedAt ? 'cyc-env-open' : 'cyc-env-sealed'}>
          <span className="cyc-env-icon" aria-hidden="true">
            {td.financialOpenedAt ? '✓' : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>}
          </span>
          <div>
            <strong>{t('cycle.p.finEnv')}</strong>
            <div className="small">
              {td.financialOpenedAt ? t('cycle.p.finOpenedAt', { at: fmtDate(td.financialOpenedAt), pass: pass ?? '—' }) : t('cycle.p.finSealed', { pass: pass ?? '—' })}
            </div>
          </div>
        </li>
      </ol>
      {err ? <ErrorBox error={err} /> : null}
      {canOpen && (
        <form className="inline-form" onSubmit={openFin}>
          <p className="small">{t('cycle.p.finOpenHint', { pass: pass ?? '—' })}</p>
          <Field label={t('common.notes')}>{(id) => <textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <Button type="submit" busy={busy}>
            {t('cycle.p.openFinancial')}
          </Button>
        </form>
      )}
      {rows.length > 0 && (
        <>
          <h3 className="cyc-mt">{t('cycle.p.finResults')}</h3>
          <Table head={[t('td.vendor'), t('cycle.p.techScore'), t('cycle.p.result'), t('cycle.p.finEnvState')]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td dir="ltr">
                  <strong>{r.score ?? '—'}</strong> <span className="muted small">/ 100</span>
                </td>
                <td>
                  <Badge tone={r.res === 'PASSED' ? 'success' : 'danger'} label={t(r.res === 'PASSED' ? 'cycle.passed' : 'cycle.failed')} />
                </td>
                <td className="small">{t(r.res === 'PASSED' ? 'cycle.p.finOpenedShort' : 'cycle.p.finStaysSealed')}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {finRecordId && (
        <div className="row cyc-mt">
          <strong>{t('cycle.p.finRecord')}</strong>
          <DocButton path={api.documentPath(finRecordId)} name="financial-opening-record.html" mode="open" variant="secondary" />
        </div>
      )}
    </Card>
  );
}
