import { TenderCyclePanel } from '../../features/cycle';
import { TenderAiExtras } from '../../features/assistant';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  ApiError,
  clarificationDraft,
  complianceResults,
  LIFECYCLE,
  packFindings,
  type AiRun,
  type AuditEvent,
  type Award,
  type Bid,
  type Clarification,
  type ComplianceResult,
  type DocumentMeta,
  type Evaluation,
  type TenderDetail,
} from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DocButton } from '../../components/Layout';
import { CitationInline, Citations, Countdown, DocList } from '../../components/shared';
import {
  AsyncView,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  FileInput,
  Hash,
  ReasonDialog,
  Spinner,
  Table,
  useAsync,
  useToast,
  type Async,
} from '../../components/ui';

const POST_OPEN = ['OPENED', 'EVALUATION', 'AWARDED'];

export default function TenderDetailPage() {
  const { id = '' } = useParams();
  const { hasRole } = useSession();
  const tender = useAsync(() => api.tender(id), [id]);
  const canAudit = true; // all staff may read a tender's own timeline (server enforces)
  const audit = useAsync(() => (canAudit ? api.audit({ resourceId: id, limit: 200 }) : Promise.resolve<AuditEvent[]>([])), [id, canAudit]);
  const status = tender.data?.status;
  const needBids = Boolean(status && ['PUBLISHED', 'CLOSED', ...POST_OPEN].includes(status));
  const bids = useAsync(() => (needBids ? api.bids(id) : Promise.resolve<Bid[]>([])), [id, needBids, status]);
  const needEvals = Boolean(status && POST_OPEN.includes(status) && hasRole('COMMITTEE_CHAIR', 'DIRECTOR', 'EVALUATOR'));
  const evals = useAsync(() => (needEvals ? api.evaluations(id) : Promise.resolve<Evaluation[]>([])), [id, needEvals, status]);

  const refresh = () => {
    tender.reload();
    audit.reload();
    bids.reload();
    evals.reload();
  };

  if (tender.loading && !tender.data) return <Spinner />;
  if (tender.error) return <ErrorBox error={tender.error} onRetry={tender.reload} />;
  if (!tender.data) return <Spinner />;
  return <Detail td={tender.data} audit={audit} bids={bids} evals={evals} refresh={refresh} />;
}

function awardFrom(td: TenderDetail, events: AuditEvent[] | undefined): Award | null {
  if (td.award) return td.award;
  // Fallback when the detail payload carries no award: derive from the audit trail (directors can read it).
  const ev = [...(events ?? [])].reverse().find((e) => /AWARD/i.test(e.action) && /RECOMMEND/i.test(e.action));
  if (!ev) return null;
  const d = (ev.details ?? {}) as Record<string, unknown>;
  return {
    id: ev.id,
    tenderId: td.id,
    bidId: String(d.bidId ?? ''),
    recommendedBy: ev.actorId ?? undefined,
    justification: (d.justification as string) ?? ev.reason ?? undefined,
    status: td.status === 'AWARDED' ? 'APPROVED' : 'RECOMMENDED',
  };
}

function Detail({
  td,
  audit,
  bids,
  evals,
  refresh,
}: {
  td: TenderDetail;
  audit: Async<AuditEvent[]>;
  bids: Async<Bid[]>;
  evals: Async<Evaluation[]>;
  refresh: () => void;
}) {
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const { user, hasRole } = useSession();
  const toast = useToast();
  const isOfficer = hasRole('PROCUREMENT_OFFICER');
  const isDirector = hasRole('DIRECTOR');
  const isChair = hasRole('COMMITTEE_CHAIR');
  const isEvaluator = hasRole('EVALUATOR');
  const [dialog, setDialog] = useState<null | 'approve' | 'return' | 'cancel' | 'approveAward'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<unknown>(null);
  const [localAward, setLocalAward] = useState<Award | null>(null);
  const [extraDocs, setExtraDocs] = useState<DocumentMeta[]>([]);

  const award = localAward ?? awardFrom(td, audit.data);
  const awardPending = award?.status === 'RECOMMENDED' && td.status !== 'AWARDED';
  const docs = useMemo(() => {
    const all = [...(td.documents ?? [])];
    for (const d of extraDocs) if (!all.some((x) => x.id === d.id)) all.push(d);
    return all;
  }, [td.documents, extraDocs]);
  const packDocs = docs.filter((d) => !d.ownerType || d.ownerType === 'TENDER_PACK' || d.ownerType === 'ADDENDUM');
  const openingDocId =
    td.opening?.recordDocumentId ?? docs.find((d) => d.ownerType === 'OPENING_RECORD')?.id ?? null;
  const reportDocId = award?.reportDocumentId ?? docs.find((d) => d.ownerType === 'COMMITTEE_REPORT')?.id ?? null;
  const vendorName = (bidId: string | undefined) => {
    const b = bids.data?.find((x) => x.id === bidId);
    return b ? bidVendor(b, pick) : bidId ?? '—';
  };

  const doAction = async (key: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(key);
    setActionErr(null);
    try {
      await fn();
      toast(okMsg);
      refresh();
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(null);
    }
  };

  const creatorIsMe = Boolean(user && td.createdBy && td.createdBy === user.id);
  const recommenderIsMe = Boolean(user && award?.recommendedBy && award.recommendedBy === user.id);

  // ---- next action buttons for the current state + role
  const actions: JSX.Element[] = [];
  const jump = (key: string, target: string, label: string, variant: 'primary' | 'secondary' = 'primary') => (
    <Button
      key={key}
      variant={variant}
      onClick={() => {
        const el = document.getElementById(target);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el?.focus({ preventScroll: true });
      }}
    >
      {label}
    </Button>
  );
  if (td.status === 'DRAFT') {
    if (isOfficer)
      actions.push(
        jump('goDocs', 'sec-docs', t('td.goDocs'), 'secondary'),
        jump('goPack', 'sec-pack', t('td.goPackCheck')),
        <Link key="edit" className="btn btn-secondary" to={`/procurement/tenders/${td.id}/edit`}>
          {t('td.edit')}
        </Link>,
      );
    if (isDirector) {
      actions.push(
        <Button key="approve" onClick={() => setDialog('approve')} disabled={creatorIsMe} disabledReason={creatorIsMe ? t('td.creatorCannotApprove') : undefined}>
          {t('td.approve')}
        </Button>,
        <Button key="return" variant="secondary" onClick={() => setDialog('return')}>
          {t('td.return')}
        </Button>,
      );
    }
  }
  if (td.status === 'APPROVED' && isOfficer)
    actions.push(
      <Button key="publish" busy={busy === 'publish'} onClick={() => doAction('publish', () => api.publishTender(td.id), t('td.published'))}>
        {t('td.publish')}
      </Button>,
    );
  if (td.status === 'PUBLISHED' && isOfficer)
    actions.push(jump('goClar', 'sec-clar', t('td.goClar')), jump('goAdd', 'sec-docs', t('td.goAddendum'), 'secondary'));
  if (td.status === 'CLOSED' && isChair) actions.push(jump('goOpen', 'sec-opening', t('td.goOpen')));
  if ((td.status === 'OPENED' || td.status === 'EVALUATION') && !awardPending) {
    if (isEvaluator) actions.push(jump('goScore', 'sec-scoring', t('td.goScore')));
    if (isChair || isEvaluator) actions.push(jump('goCmp', 'sec-compliance', t('td.goCompliance'), 'secondary'));
    if (isChair) actions.push(jump('goRec', 'sec-summary', t('td.goRecommend')));
  }
  if (awardPending && isDirector)
    actions.push(
      <Button
        key="approveAward"
        onClick={() => setDialog('approveAward')}
        disabled={recommenderIsMe}
        disabledReason={recommenderIsMe ? t('td.recommenderCannotApprove') : undefined}
      >
        {t('td.approveAward')}
      </Button>,
    );
  if (['DRAFT', 'APPROVED', 'PUBLISHED'].includes(td.status) && isDirector)
    actions.push(
      <Button key="cancel" variant="danger" onClick={() => setDialog('cancel')}>
        {t('td.cancel')}
      </Button>,
    );

  return (
    <div className="stack">
      <Link to="/procurement/tenders" className="backlink">
        ← {t('nav.tenders')}
      </Link>
      <header className="page-head">
        <div>
          <div className="muted small" dir="ltr">
            {td.tenderNumber}
          </div>
          <h1>{pick(td.titleEn, td.titleAr)}</h1>
          <div className="muted">{pick(td.titleAr, td.titleEn)}</div>
        </div>
        <Badge value={td.status} label={te('st.', td.status)} />
      </header>

      <Stepper status={td.status} awardPending={awardPending} />

      {td.status === 'CANCELLED' && (
        <div className="alert alert-danger" role="status">
          {t('td.cancelledBanner')}
        </div>
      )}
      {td.status === 'AWARDED' && (
        <div className="winner" role="status">
          <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="9" r="6" />
            <path d="M8.5 14 7 22l5-3 5 3-1.5-8" />
          </svg>
          <div>
            <div className="small">{t('td.winner')}</div>
            <strong className="lg">{award ? vendorName(award.bidId) : '—'}</strong>
            {award?.justification && <div className="small">{award.justification}</div>}
          </div>
          {reportDocId && <DocButton path={api.documentPath(reportDocId)} name="committee-report.html" mode="open" variant="secondary" label={t('td.committeeReport')} />}
        </div>
      )}
      {awardPending && (
        <div className="alert alert-warn" role="status">
          <div>
            <strong>{t('td.awardPending')}</strong>
            <div className="small">
              {t('td.recommendedBid')}: {vendorName(award?.bidId)}
              {award?.justification ? ` — ${award.justification}` : ''}
            </div>
          </div>
        </div>
      )}

      <Card title={t('td.nextAction')} className="next-action">
        {actionErr ? <ErrorBox error={actionErr} /> : null}
        {actions.length > 0 ? <div className="row wrap">{actions}</div> : <p className="muted">{stageHint(td.status, { isOfficer, isChair, isEvaluator, t })}</p>}
      </Card>

      <div className="grid-main">
        <div className="stack">
          {td.status === 'PUBLISHED' && (
            <div className="tiles">
              <div className="tile">
                <div className="tile-num">
                  <Countdown deadline={td.submissionDeadline} />
                </div>
                <div className="tile-label">{t('td.countdown')}</div>
              </div>
              <div className="tile">
                <div className="tile-num">{td.bidCount ?? bids.data?.length ?? '—'}</div>
                <div className="tile-label">{t('td.bidsReceived')}</div>
                <div className="muted small">{t('td.bidsSealedNote')}</div>
              </div>
            </div>
          )}

          <Card title={t('td.overview')}>
            <dl className="kv">
              <dt>{t('common.category')}</dt>
              <dd>{te('cat.', td.category)}</dd>
              <dt>{t('common.budget')}</dt>
              <dd>{fmtMoney(td.estimatedBudget, td.currency ?? 'KWD')}</dd>
              <dt>{t('common.deadline')}</dt>
              <dd>{fmtDate(td.submissionDeadline)}</dd>
            </dl>
            {pick(td.descriptionEn, td.descriptionAr) && <p className="prewrap">{pick(td.descriptionEn, td.descriptionAr)}</p>}
            <div className="grid-2">
              <div>
                <h3>{t('td.criteria')}</h3>
                {(td.criteria ?? []).length === 0 ? (
                  <p className="muted">—</p>
                ) : (
                  <ul className="plain">
                    {td.criteria!.map((c) => (
                      <li key={c.key} className="row spread">
                        <span>{pick(c.nameEn, c.nameAr)}</span>
                        <Badge label={`${c.weight}%`} tone="info" />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3>{t('td.requiredDocs')}</h3>
                {(td.requiredDocuments ?? []).length === 0 ? (
                  <p className="muted">—</p>
                ) : (
                  <ul>
                    {td.requiredDocuments!.map((d) => (
                      <li key={d.key}>{pick(d.nameEn, d.nameAr)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          <TenderCyclePanel td={td} onChange={refresh} />
          <TenderAiExtras td={td} onChange={refresh} />

          <Card id="sec-docs" title={t('td.documents')}>
            <DocList docs={packDocs} empty={t('td.noDocuments')} />
            {isOfficer && (td.status === 'DRAFT' || td.status === 'PUBLISHED') && (
              <UploadDoc
                tenderId={td.id}
                addendum={td.status === 'PUBLISHED'}
                onDone={(d) => {
                  if (d?.id) setExtraDocs((xs) => [...xs, d]);
                  refresh();
                }}
              />
            )}
            {openingDocId && (
              <div className="row">
                <strong>{t('td.openingRecord')}</strong>
                <DocButton path={api.documentPath(openingDocId)} name="opening-record.html" mode="open" variant="secondary" />
              </div>
            )}
          </Card>

          {td.status === 'DRAFT' && <PackCheck td={td} canRun={isOfficer} onChange={refresh} />}

          {td.status === 'PUBLISHED' && <ClarificationsInbox td={td} canAnswer={isOfficer} onChange={refresh} />}

          {td.status === 'CLOSED' && (
            <OpeningSession
              tenderId={td.id}
              canOpen={isChair}
              deadline={td.submissionDeadline}
              bidCount={td.bidCount ?? bids.data?.length}
              onOpened={(doc) => {
                if (doc) setExtraDocs((xs) => [...xs, doc]);
                refresh();
              }}
            />
          )}

          {POST_OPEN.includes(td.status) && (
            <>
              <BidsTable bids={bids} canDownload={hasRole('COMMITTEE_CHAIR', 'EVALUATOR', 'DIRECTOR')} />
              <Compliance td={td} bids={bids.data ?? []} canRun={hasRole('COMMITTEE_CHAIR', 'EVALUATOR')} onChange={refresh} />
              {isEvaluator && td.status !== 'AWARDED' && (
                <Scoring td={td} bids={bids.data ?? []} evals={evals.data ?? []} userId={user?.id} onSaved={refresh} />
              )}
              {hasRole('COMMITTEE_CHAIR', 'DIRECTOR') && (
                <EvaluationSummary
                  td={td}
                  evals={evals}
                  bids={bids.data ?? []}
                  canRecommend={isChair && td.status !== 'AWARDED' && !awardPending}
                  onRecommended={(a) => {
                    setLocalAward(a);
                    refresh();
                  }}
                />
              )}
            </>
          )}
        </div>

        <aside className="stack side">
          <Timeline audit={audit} />
          <AiHistory runs={td.aiRuns ?? []} />
        </aside>
      </div>

      <ReasonDialog
        open={dialog === 'approve'}
        title={t('td.approveTitle')}
        confirmLabel={t('td.approve')}
        onClose={() => setDialog(null)}
        onConfirm={async (r) => {
          await api.approveTender(td.id, r);
          toast(t('td.approved'));
          refresh();
        }}
      />
      <ReasonDialog
        open={dialog === 'return'}
        title={t('td.returnTitle')}
        confirmLabel={t('td.return')}
        required
        variant="secondary"
        onClose={() => setDialog(null)}
        onConfirm={async (r) => {
          await api.returnTender(td.id, r);
          toast(t('td.returned'));
          refresh();
        }}
      />
      <ReasonDialog
        open={dialog === 'cancel'}
        title={t('td.cancelTitle')}
        confirmLabel={t('td.cancel')}
        required
        variant="danger"
        onClose={() => setDialog(null)}
        onConfirm={async (r) => {
          await api.cancelTender(td.id, r);
          toast(t('td.cancelled'));
          refresh();
        }}
      />
      <ReasonDialog
        open={dialog === 'approveAward'}
        title={t('td.approveAwardTitle')}
        confirmLabel={t('td.approveAward')}
        onClose={() => setDialog(null)}
        onConfirm={async (r) => {
          const a = await api.approveAward(td.id, r);
          if (a) setLocalAward({ ...a, status: 'APPROVED' });
          if (a?.reportDocument) setExtraDocs((xs) => [...xs, a.reportDocument!]);
          toast(t('td.awarded'));
          refresh();
        }}
      />
    </div>
  );
}

function stageHint(
  status: string,
  r: { isOfficer: boolean; isChair: boolean; isEvaluator: boolean; t: ReturnType<typeof useI18n>['t'] },
): string {
  if (status === 'CLOSED' && !r.isChair) return r.t('td.openNotYet');
  return r.t('td.noAction');
}

function bidVendor(b: Bid, pick: (e?: string | null, a?: string | null) => string): string {
  return b.vendorName || pick(b.vendorNameEn, b.vendorNameAr) || b.vendorId || b.id;
}

// ---------------------------------------------------------------- stepper

function Stepper({ status, awardPending }: { status: string; awardPending: boolean }) {
  const { t, te } = useI18n();
  const idx = LIFECYCLE.indexOf(status as (typeof LIFECYCLE)[number]);
  return (
    <nav aria-label={t('td.lifecycle')} className="stepper-wrap">
      <ol className={`stepper ${status === 'CANCELLED' ? 'stepper-cancelled' : ''}`}>
        {LIFECYCLE.map((s, i) => {
          const state = idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? (s === 'AWARDED' ? 'done current' : 'current') : 'todo';
          return (
            <li key={s} className={`step ${state}`} aria-current={i === idx ? 'step' : undefined}>
              <span className="step-dot" aria-hidden="true">
                {i < idx || (i === idx && s === 'AWARDED') ? '✓' : i + 1}
              </span>
              <span className="step-label">{te('st.', s)}</span>
              {i === idx && s === 'EVALUATION' && awardPending && <span className="step-sub">{t('td.awardPending')}</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------- documents

function UploadDoc({ tenderId, addendum, onDone }: { tenderId: string; addendum: boolean; onDone: (d: DocumentMeta | undefined) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const d = await api.uploadTenderDocument(tenderId, file, title.trim() || file.name, addendum);
      toast(t(addendum ? 'td.addendumIssued' : 'td.uploaded'));
      setFile(null);
      setTitle('');
      onDone(d);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <h3>{t(addendum ? 'td.uploadAddendum' : 'td.uploadPack')}</h3>
      {err ? <ErrorBox error={err} /> : null}
      <div className="grid-2">
        <Field label={t('common.title')}>{(id) => <input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <FileInput label={t('common.file')} file={file} onChange={setFile} required />
      </div>
      <Button type="submit" busy={busy} disabled={!file}>
        {t(addendum ? 'td.uploadAddendum' : 'common.upload')}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------- AI pack check

function PackCheck({ td, canRun, onChange }: { td: TenderDetail; canRun: boolean; onChange: () => void }) {
  const { t, te, fmtDate } = useI18n();
  const [run, setRun] = useState<AiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [reviewErr, setReviewErr] = useState<unknown>(null);
  const latest =
    run ??
    [...(td.aiRuns ?? [])]
      .filter((r) => r.kind === 'PACK_CHECK')
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .pop() ??
    null;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.packCheck(td.id);
      setRun(r);
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const review = async (r: AiRun, i: number, item: string, decision: 'ACCEPTED' | 'IGNORED') => {
    setReviewErr(null);
    try {
      await api.reviewAiRun(r.id, decision, `Finding ${i + 1}: ${item}`, i);
      setDecisions((d) => ({ ...d, [`${r.id}:${i}`]: decision }));
    } catch (e) {
      setReviewErr(e);
    }
  };

  const { findings, summary } = latest ? packFindings(latest) : { findings: [], summary: undefined };
  return (
    <Card
      id="sec-pack"
      title={
        <>
          {t('td.packFindings')} <span className="ai-tag">{t('ai.name')}</span>
        </>
      }
      actions={
        canRun ? (
          <Button busy={busy} onClick={start}>
            {t('td.runPackCheck')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted small">{t('ai.advisory')}</p>
      {err ? <ErrorBox error={err} /> : null}
      {reviewErr ? <ErrorBox error={reviewErr} /> : null}
      {busy && <Spinner />}
      {!latest ? (
        <EmptyState message={t('ai.noRuns')} />
      ) : latest.status === 'ERROR' ? (
        <div className="alert alert-danger">
          {t('ai.error')}: {latest.error}
        </div>
      ) : (
        <div className="stack">
          <div className="muted small">
            {fmtDate(latest.createdAt)} · {t('ai.agent')}: {latest.agent ?? '—'}
            {latest.model ? ` · ${t('ai.model')}: ${latest.model}` : ''}
            {latest.reviewDecision ? ` · ${t('ai.reviewDecision')}: ${latest.reviewDecision}` : ''}
          </div>
          {summary && <p className="prewrap">{summary}</p>}
          {findings.length === 0 ? (
            <EmptyState message={t('td.noFindings')} />
          ) : (
            <Table head={[t('td.severity'), t('td.finding'), t('td.detail'), t('ai.citation'), t('ai.review')]}>
              {findings.map((f, i) => {
                const dec = decisions[`${latest.id}:${i}`];
                return (
                  <tr key={i}>
                    <td>
                      <Badge value={f.severity} label={te('sev.', f.severity)} />
                    </td>
                    <td>{f.item}</td>
                    <td className="prewrap">{f.detail}</td>
                    <td>
                      <CitationInline c={f.citation} />
                    </td>
                    <td>
                      {dec ? (
                        <Badge value={dec} label={dec === 'ACCEPTED' ? t('td.accepted') : t('td.ignored')} />
                      ) : canRun ? (
                        <div className="row">
                          <Button variant="secondary" onClick={() => review(latest, i, f.item, 'ACCEPTED')}>
                            {t('td.accept')}
                          </Button>
                          <Button variant="ghost" onClick={() => review(latest, i, f.item, 'IGNORED')}>
                            {t('td.ignore')}
                          </Button>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- clarifications

function ClarificationsInbox({ td, canAnswer, onChange }: { td: TenderDetail; canAnswer: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const list = td.clarifications ?? [];
  return (
    <Card id="sec-clar" title={t('td.clarInbox')}>
      {list.length === 0 ? (
        <EmptyState message={t('td.noClarifications')} />
      ) : (
        <ul className="qa-list">
          {[...list]
            .sort((a, b) => (a.status === b.status ? 0 : a.status === 'OPEN' ? -1 : 1))
            .map((c) => (
              <ClarificationItem key={c.id} c={c} canAnswer={canAnswer} onChange={onChange} />
            ))}
        </ul>
      )}
    </Card>
  );
}

function ClarificationItem({ c, canAnswer, onChange }: { c: Clarification; canAnswer: boolean; onChange: () => void }) {
  const { t, te, fmtDate } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const [draftRun, setDraftRun] = useState<AiRun | null>(null);
  const [busy, setBusy] = useState<null | 'ai' | 'publish'>(null);
  const [err, setErr] = useState<unknown>(null);
  const draft = draftRun ? clarificationDraft(draftRun) : null;

  const runDraft = async () => {
    setBusy('ai');
    setErr(null);
    try {
      const r = await api.draftClarification(c.id);
      setDraftRun(r);
      const d = clarificationDraft(r);
      if (r.status === 'ERROR') setErr(new ApiError(502, 'AI_RUN_ERROR', r.error ?? t('ai.error')));
      else if (d && !d.notFound) setText(d.answer);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const publish = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('publish');
    setErr(null);
    try {
      await api.answerClarification(c.id, text.trim());
      toast(t('td.answerPublished'));
      onChange();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="qa">
      <div className="row spread">
        <div className="q">
          <strong>Q.</strong> <span className="prewrap">{c.question}</span>
        </div>
        <Badge value={c.status} label={te('cst.', c.status)} />
      </div>
      <div className="muted small">{fmtDate(c.createdAt)}</div>
      {c.status === 'ANSWERED' ? (
        <div className="a">
          <strong>A.</strong> <span className="prewrap">{c.answer}</span>
        </div>
      ) : canAnswer ? (
        <form className="inline-form" onSubmit={publish}>
          {err ? <ErrorBox error={err} /> : null}
          {draft?.notFound && <div className="alert alert-info">{t('td.aiDraftNotFound')}</div>}
          <Field label={t('td.answer')} required>
            {(id) => <textarea id={id} rows={5} value={text} onChange={(e) => setText(e.target.value)} required />}
          </Field>
          {draft && (
            <div className="ai-box">
              <div className="small">
                <span className="ai-tag">{t('ai.name')}</span> {t('ai.advisory')}
              </div>
              <strong className="small">{t('ai.citations')}</strong>
              <Citations items={draft.citations} />
            </div>
          )}
          <div className="row">
            <Button variant="secondary" busy={busy === 'ai'} onClick={runDraft}>
              {t('td.draftWithAi')}
            </Button>
            <Button type="submit" busy={busy === 'publish'} disabled={!text.trim()}>
              {t('td.publishAnswer')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- opening

function OpeningSession({
  tenderId,
  canOpen,
  deadline,
  bidCount,
  onOpened,
}: {
  tenderId: string;
  canOpen: boolean;
  deadline: string;
  bidCount?: number;
  onOpened: (doc?: DocumentMeta) => void;
}) {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const [attendees, setAttendees] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.openBids(
        tenderId,
        attendees
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        notes.trim(),
      );
      toast(t('td.opened'));
      const doc = r?.recordDocument ?? (r?.recordDocumentId ? ({ id: r.recordDocumentId, title: 'Opening record', ownerType: 'OPENING_RECORD', mimeType: 'text/html' } as DocumentMeta) : undefined);
      onOpened(doc);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card id="sec-opening" title={t('td.openSession')}>
      <dl className="kv">
        <dt>{t('common.deadline')}</dt>
        <dd>{fmtDate(deadline)}</dd>
        <dt>{t('td.bidsReceived')}</dt>
        <dd>{bidCount ?? '—'}</dd>
      </dl>
      {!canOpen ? (
        <p className="muted">{t('td.openNotYet')}</p>
      ) : (
        <form className="inline-form" onSubmit={submit}>
          {err ? <ErrorBox error={err} /> : null}
          <Field label={t('td.attendees')} required>
            {(id) => <textarea id={id} rows={4} value={attendees} onChange={(e) => setAttendees(e.target.value)} required />}
          </Field>
          <Field label={t('td.openingNotes')}>{(id) => <textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <Button type="submit" busy={busy} disabled={!attendees.trim()}>
            {t('td.openBids')}
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- bids

function BidsTable({ bids, canDownload }: { bids: Async<Bid[]>; canDownload: boolean }) {
  const { t, te, pick, fmtDate } = useI18n();
  return (
    <Card title={t('td.bids')}>
      <AsyncView state={bids} empty={t('td.noBids')}>
        {(list) => (
          <Table head={[t('td.vendor'), t('td.receiptHash'), t('td.submittedAt'), t('common.status'), t('td.files')]}>
            {list.map((b) => (
              <tr key={b.id}>
                <td>{bidVendor(b, pick)}</td>
                <td>
                  <Hash value={b.receiptSha256} />
                </td>
                <td>{fmtDate(b.submittedAt)}</td>
                <td>
                  <Badge value={b.status} label={te('bst.', b.status)} />
                </td>
                <td>
                  {canDownload && (b.documents?.length ?? 0) > 0 ? (
                    <div className="row wrap">
                      {b.documents!.map((d) => (
                        <DocButton
                          key={d.id}
                          path={api.bidDocumentPath(b.id, d.id)}
                          name={d.title}
                          label={d.ownerType ? te('doc.', d.ownerType) : d.title}
                          variant="secondary"
                        />
                      ))}
                    </div>
                  ) : (
                    <span className="muted small">{t('td.noFileAccess')}</span>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
    </Card>
  );
}

// ---------------------------------------------------------------- compliance

function Compliance({ td, bids, canRun, onChange }: { td: TenderDetail; bids: Bid[]; canRun: boolean; onChange: () => void }) {
  const { t, te, pick, fmtDate } = useI18n();
  const [local, setLocal] = useState<AiRun | AiRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const stored = (td.aiRuns ?? []).filter((r) => r.kind === 'COMPLIANCE_SCREEN');
  // latest batch: the most recent run per bid
  const runs: AiRun[] = local ? (Array.isArray(local) ? local : [local]) : latestPerBid(stored);
  const results: ComplianceResult[] = runs.flatMap((r) => (r.status === 'OK' ? complianceResults(r) : []));
  const failed = runs.filter((r) => r.status === 'ERROR');
  const nameOf = (r: ComplianceResult) => {
    const b = bids.find((x) => x.id === r.bidId);
    return b ? bidVendor(b, pick) : r.vendorName ?? r.bidId ?? '—';
  };

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      setLocal(await api.complianceScreen(td.id));
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      id="sec-compliance"
      title={
        <>
          {t('td.compliance')} <span className="ai-tag">{t('ai.name')}</span>
        </>
      }
      actions={
        canRun ? (
          <Button busy={busy} onClick={start}>
            {t('td.runCompliance')}
          </Button>
        ) : undefined
      }
    >
      <p className="muted small">
        {t('td.complianceNote')} {t('ai.advisory')}
      </p>
      {err ? <ErrorBox error={err} /> : null}
      {failed.map((r) => (
        <div key={r.id} className="alert alert-danger">
          {t('ai.error')}: {r.error}
        </div>
      ))}
      {runs.length === 0 && !busy ? (
        <EmptyState message={t('ai.noRuns')} />
      ) : (
        results.map((res, i) => (
          <div key={`${res.bidId ?? i}`} className="stack-sm">
            <h3>
              {nameOf(res)} <span className="muted small">{fmtDate(runs[0]?.createdAt)}</span>
            </h3>
            {res.error && <div className="alert alert-danger">{res.error}</div>}
            {res.items.length === 0 ? (
              <p className="muted">{t('common.empty')}</p>
            ) : (
              <Table head={[t('td.requirement'), t('common.status'), t('td.evidence'), t('ai.citation')]}>
                {res.items.map((it, j) => (
                  <tr key={j}>
                    <td>{it.requirement}</td>
                    <td>
                      <Badge value={it.status} label={te('cmp.', it.status)} />
                    </td>
                    <td className="prewrap">{it.evidence ?? '—'}</td>
                    <td>
                      <CitationInline c={it.citation} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        ))
      )}
    </Card>
  );
}

function latestPerBid(runs: AiRun[]): AiRun[] {
  const sorted = [...runs].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const seen = new Set<string>();
  const out: AiRun[] = [];
  for (const r of sorted) {
    const req = (r.request ?? {}) as Record<string, unknown>;
    const key = String(req.bidId ?? (req.bid as Record<string, unknown> | undefined)?.bidId ?? 'all');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (key === 'all') break;
  }
  return out;
}

// ---------------------------------------------------------------- scoring (evaluator)

function Scoring({
  td,
  bids,
  evals,
  userId,
  onSaved,
}: {
  td: TenderDetail;
  bids: Bid[];
  evals: Evaluation[];
  userId?: string;
  onSaved: () => void;
}) {
  const { t, pick } = useI18n();
  if (bids.length === 0) return null;
  return (
    <Card id="sec-scoring" title={t('td.scoring')}>
      <div className="stack">
        {bids.map((b) => (
          <ScoreForm
            key={b.id}
            td={td}
            bid={b}
            vendor={bidVendor(b, pick)}
            existing={evals.find((e) => e.bidId === b.id && (!userId || e.evaluatorId === userId))}
            onSaved={onSaved}
          />
        ))}
      </div>
    </Card>
  );
}

function ScoreForm({
  td,
  bid,
  vendor,
  existing,
  onSaved,
}: {
  td: TenderDetail;
  bid: Bid;
  vendor: string;
  existing?: Evaluation;
  onSaved: () => void;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const criteria = td.criteria ?? [];
  const init = () =>
    Object.fromEntries(
      criteria.map((c) => {
        const s = existing?.scores.find((x) => x.criterion === c.key);
        return [c.key, { score: s ? String(s.score) : '', comment: s?.comment ?? '' }];
      }),
    ) as Record<string, { score: string; comment: string }>;
  const [vals, setVals] = useState(init);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    setVals(init());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id, existing?.submittedAt]);

  const valid = criteria.every((c) => {
    const n = Number(vals[c.key]?.score);
    return vals[c.key]?.score !== '' && n >= 0 && n <= 100;
  });
  const total = criteria.reduce((s, c) => s + ((Number(vals[c.key]?.score) || 0) * Number(c.weight)) / 100, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      await api.submitEvaluation(
        bid.id,
        criteria.map((c) => ({ criterion: c.key, score: Number(vals[c.key].score), comment: vals[c.key].comment.trim() })),
      );
      toast(t('td.scoresSaved'));
      onSaved();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="score-form" onSubmit={submit} aria-label={`${t('td.scoring')}: ${vendor}`}>
      <div className="row spread">
        <h3>{vendor}</h3>
        {existing && <Badge value="OK" label={t('td.alreadyScored')} />}
      </div>
      {err ? <ErrorBox error={err} /> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('td.criteria')}</th>
              <th scope="col">{t('form.weight')}</th>
              <th scope="col">{t('td.score')}</th>
              <th scope="col">{t('td.comment')}</th>
            </tr>
          </thead>
          <tbody>
            {criteria.map((c) => (
              <tr key={c.key}>
                <th scope="row">{pick(c.nameEn, c.nameAr)}</th>
                <td>{c.weight}%</td>
                <td>
                  <input
                    className="score-input"
                    type="number"
                    min={0}
                    max={100}
                    required
                    aria-label={`${t('td.score')} — ${pick(c.nameEn, c.nameAr)}`}
                    value={vals[c.key]?.score ?? ''}
                    onChange={(e) => setVals((v) => ({ ...v, [c.key]: { ...v[c.key], score: e.target.value } }))}
                    dir="ltr"
                  />
                </td>
                <td>
                  <input
                    aria-label={`${t('td.comment')} — ${pick(c.nameEn, c.nameAr)}`}
                    value={vals[c.key]?.comment ?? ''}
                    onChange={(e) => setVals((v) => ({ ...v, [c.key]: { ...v[c.key], comment: e.target.value } }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row spread">
        <div>
          {t('td.weightedTotal')}: <strong className="lg" aria-live="polite">{total.toFixed(2)}</strong>
        </div>
        <Button type="submit" busy={busy} disabled={!valid}>
          {t('td.submitScores')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- summary + recommend (chair / director)

function EvaluationSummary({
  td,
  evals,
  bids,
  canRecommend,
  onRecommended,
}: {
  td: TenderDetail;
  evals: Async<Evaluation[]>;
  bids: Bid[];
  canRecommend: boolean;
  onRecommended: (a: Award) => void;
}) {
  const { t, pick } = useI18n();
  const toast = useToast();
  const ranked = useMemo(() => {
    const by = new Map<string, Evaluation[]>();
    for (const e of evals.data ?? []) by.set(e.bidId, [...(by.get(e.bidId) ?? []), e]);
    return [...by.entries()]
      .map(([bidId, es]) => ({
        bidId,
        count: es.length,
        avg: es.reduce((s, e) => s + Number(e.weightedTotal), 0) / es.length,
      }))
      .sort((a, b) => b.avg - a.avg);
  }, [evals.data]);
  const [bidId, setBidId] = useState('');
  const [just, setJust] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (!bidId && ranked[0]) setBidId(ranked[0].bidId);
  }, [ranked, bidId]);
  const nameOf = (id: string) => {
    const b = bids.find((x) => x.id === id);
    return b ? bidVendor(b, pick) : id;
  };

  const recommend = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const a = await api.recommendAward(td.id, bidId, just.trim());
      toast(t('td.recommended'));
      onRecommended({ ...(a ?? { id: '', tenderId: td.id }), bidId: a?.bidId ?? bidId, status: 'RECOMMENDED', justification: a?.justification ?? just.trim() } as Award);
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="sec-summary" title={t('td.evaluations')} actions={<Button variant="ghost" onClick={evals.reload}>{t('common.refresh')}</Button>}>
      <AsyncView state={evals} empty={t('td.noEvaluations')}>
        {() => (
          <Table head={[t('td.rank'), t('td.vendor'), t('td.avgTotal'), t('td.evaluators')]}>
            {ranked.map((r, i) => (
              <tr key={r.bidId} className={i === 0 ? 'row-top' : ''}>
                <td>{i + 1}</td>
                <td>{nameOf(r.bidId)}</td>
                <td>
                  <strong>{r.avg.toFixed(2)}</strong>
                </td>
                <td>{r.count}</td>
              </tr>
            ))}
          </Table>
        )}
      </AsyncView>
      {canRecommend && ranked.length > 0 && (
        <form className="inline-form" onSubmit={recommend}>
          <h3>{t('td.recommendTitle')}</h3>
          {err ? <ErrorBox error={err} /> : null}
          <Field label={t('td.bid')} required>
            {(id) => (
              <select id={id} value={bidId} onChange={(e) => setBidId(e.target.value)} required>
                <option value="">{t('td.selectBid')}</option>
                {bids.map((b) => (
                  <option key={b.id} value={b.id}>
                    {bidVendor(b, pick)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('td.justification')} required>
            {(id) => <textarea id={id} rows={4} value={just} onChange={(e) => setJust(e.target.value)} required />}
          </Field>
          <Button type="submit" busy={busy} disabled={!bidId || !just.trim()}>
            {t('td.recommend')}
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- side panel

function Timeline({ audit }: { audit: Async<AuditEvent[]> }) {
  const { t, te, fmtDate } = useI18n();
  const forbidden = audit.error instanceof ApiError && audit.error.status === 403;
  const events = [...(audit.data ?? [])].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return Number(a.seq) - Number(b.seq);
    return a.at.localeCompare(b.at);
  });
  return (
    <Card title={t('td.timeline')} actions={<Button variant="ghost" onClick={audit.reload}>{t('common.refresh')}</Button>}>
      {forbidden ? (
        <p className="muted small">{t('common.notPermitted')}</p>
      ) : (
        <AsyncView state={audit} empty={t('td.noTimeline')}>
          {() => (
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id ?? String(e.seq)}>
                  <div className="tl-action">{e.action}</div>
                  {(e.prevState || e.newState) && (
                    <div className="small">
                      {te('st.', e.prevState)} → {te('st.', e.newState)}
                    </div>
                  )}
                  {e.reason && <div className="small prewrap">{e.reason}</div>}
                  <div className="muted small">
                    {fmtDate(e.at)} · {(e.actorRoles ?? []).map((r) => te('role.', r)).join(', ') || e.actorId}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </AsyncView>
      )}
    </Card>
  );
}

function AiHistory({ runs }: { runs: AiRun[] }) {
  const { t, te, fmtDate } = useI18n();
  const sorted = [...runs].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return (
    <Card title={t('ai.runs')}>
      {sorted.length === 0 ? (
        <p className="muted small">{t('ai.noRuns')}</p>
      ) : (
        <ul className="plain ai-runs">
          {sorted.map((r) => (
            <li key={r.id}>
              <div className="row spread">
                <strong className="small">{te('ai.kind.', r.kind)}</strong>
                <Badge value={r.status} label={te('ai.status.', r.status)} />
              </div>
              <div className="muted small">
                {fmtDate(r.createdAt)}
                {r.agent ? ` · ${r.agent}` : ''}
                {r.reviewDecision ? ` · ${r.reviewDecision}` : ''}
              </div>
              {r.error && <div className="small field-error">{r.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
