// Grading authority (ACT-005): the grading queue (applications + grade-upgrade requests), the application review
// (documents, Orchestrate grade reviewer, grades per activity or for the company per entity policy, approve →
// subscription payment link) and the upgrade decision (FR-010, NOT-003). Roles come from the entity policy and are
// checked by the server.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { platform, type ActivityCode } from '../../api-platform';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { DocList } from '../../components/shared';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, ReasonDialog, Table, useAsync, useToast } from '../../components/ui';
import { VendorGradeReview } from '../assistant';
import { moiApi, type GradingVendor, type UpgradeRequest } from './api';
import { GradeList, gradeName, SubBadge } from './shared';

const UP_TONE: Record<string, string> = { SUBMITTED: 'warn', APPROVED: 'success', REJECTED: 'danger' };

export function GradingQueuePage() {
  const { t, pick, fmtDate } = useI18n();
  const q = useAsync(() => moiApi.gradingQueue(), []);
  return (
    <div className="stack moi-grading">
      <header className="page-head">
        <div>
          <h1>{t('moi.gr.title')}</h1>
          <p className="muted moi-lead">{t('moi.gr.subtitle')}</p>
        </div>
        <Button variant="ghost" onClick={q.reload}>
          {t('common.refresh')}
        </Button>
      </header>
      <AsyncView state={q}>
        {(d) => (
          <>
            <p className="small">
              <Badge tone="info" label={t(`moi.opt.gradeScope.${d.gradeScope}` as TKey)} /> <span className="muted">{t('moi.gr.scopeNote')}</span>
            </p>
            <Card title={t('moi.gr.applications', { n: d.applications.length })} id="grading-applications">
              {d.applications.length === 0 ? (
                <p className="muted">{t('moi.gr.noApplications')}</p>
              ) : (
                <Table head={[t('moi.va.vendor'), t('reg.crNumber'), t('moi.gr.received'), t('moi.gr.documents'), t('common.actions')]}>
                  {d.applications.map((a) => (
                    <tr key={a.id}>
                      <td>{pick(a.legalNameEn, a.legalNameAr)}</td>
                      <td dir="ltr">{a.crNumber}</td>
                      <td>{fmtDate(a.createdAt)}</td>
                      <td>{a.documentCount ?? 0}</td>
                      <td>
                        <Link className="btn btn-primary" to={`/procurement/grading/vendors/${a.id}`} data-tour="grade-open">
                          {t('moi.gr.review')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title={t('moi.gr.upgrades')} id="grading-upgrades">
              {d.upgradeRequests.length === 0 ? (
                <p className="muted">{t('moi.gr.noUpgrades')}</p>
              ) : (
                <UpgradeTable rows={d.upgradeRequests} />
              )}
            </Card>
            <Card title={t('moi.gr.recent')}>
              {d.recentlyGraded.length === 0 ? (
                <p className="muted">—</p>
              ) : (
                <ul className="plain small">
                  {d.recentlyGraded.map((v) => (
                    <li key={v.id}>
                      <Link to={`/procurement/grading/vendors/${v.id}`}>{pick(v.legalNameEn, v.legalNameAr)}</Link> · {fmtDate(v.gradedAt)}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </div>
  );
}

function UpgradeTable({ rows }: { rows: UpgradeRequest[] }) {
  const { t, pick, fmtDate } = useI18n();
  return (
    <Table head={[t('moi.up.number'), t('moi.va.vendor'), t('moi.up.activity'), t('moi.up.change'), t('common.date'), t('common.status')]}>
      {rows.map((g) => (
        <tr key={g.id}>
          <td dir="ltr">
            <Link to={`/procurement/grading/upgrades/${g.id}`}>{g.requestNumber}</Link>
          </td>
          <td>{pick(g.legalNameEn, g.legalNameAr)}</td>
          <td dir="ltr">{g.activityCode ?? t('moi.companyGrade')}</td>
          <td>
            {gradeName(t, g.currentGrade)} → <strong>{gradeName(t, g.requestedGrade)}</strong>
          </td>
          <td>{fmtDate(g.createdAt)}</td>
          <td>
            <Badge tone={UP_TONE[g.status]} label={t(`moi.up.st.${g.status}` as TKey)} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------- application review

export function GradingVendorPage() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const st = useAsync(() => moiApi.gradingVendor(id), [id]);
  const codes = useAsync(() => platform.activityCodes(), []);
  return (
    <div className="stack moi-grading">
      <Link to="/procurement/grading" className="backlink">
        ← {t('moi.gr.title')}
      </Link>
      <AsyncView state={st}>{(d) => <ApplicationReview d={d} codes={codes.data ?? []} onChange={st.reload} />}</AsyncView>
    </div>
  );
}

interface Row { activityCode: string; grade: number }

function ApplicationReview({ d, codes, onChange }: { d: GradingVendor; codes: ActivityCode[]; onChange: () => void }) {
  const { t, te, pick, fmtDate } = useI18n();
  const toast = useToast();
  const v = d.vendor;
  const pending = v.status === 'PENDING_REVIEW';
  const company = d.gradeScope === 'COMPANY';
  const [rows, setRows] = useState<Row[]>([{ activityCode: '', grade: 2 }]);
  const [companyGrade, setCompanyGrade] = useState(2);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const valid = rows.length > 0 && rows.every((r) => r.activityCode) && new Set(rows.map((r) => r.activityCode)).size === rows.length;

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await moiApi.gradeVendor(v.id, {
        decision: 'APPROVE',
        reason: note.trim() || undefined,
        activities: rows.map((r) => (company ? { activityCode: r.activityCode } : r)),
        companyGrade: company ? companyGrade : undefined,
      });
      setIssued(res.subscription ? t('moi.gr.linkIssued', { amount: `${res.subscription.amount} ${res.subscription.currency}` }) : t('moi.gr.approvedNoSub'));
      toast(t('moi.gr.approved'));
      onChange();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <div className="muted small" dir="ltr">
            {v.crNumber}
          </div>
          <h1>{pick(v.legalNameEn, v.legalNameAr)}</h1>
        </div>
        <Badge value={v.status} label={te('vst.', v.status)} />
      </header>
      {issued && (
        <div className="alert alert-success" role="status">
          {issued}
        </div>
      )}
      <div className="grid-main">
        <div className="stack">
          <Card title={t('moi.gr.documents')}>
            <h3 className="small">{t('moi.gr.expected')}</h3>
            <ul className="small">
              {d.registrationDocuments.map((r) => (
                <li key={r.code}>
                  <code dir="ltr">{r.code}</code> — {pick(r.en, r.ar)}
                </li>
              ))}
            </ul>
            <DocList docs={d.documents} empty={t('vendor.noDocs')} />
          </Card>
          <VendorGradeReview vendorId={v.id} />
          {pending ? (
            <Card title={t('moi.gr.decide')} id="grading-decision">
              {err ? <ErrorBox error={err} /> : null}
              <p className="small muted">{t(company ? 'moi.gr.companyHint' : 'moi.gr.perActivityHint')}</p>
              {company && (
                <Field label={t('moi.companyGrade')} required>
                  {(fid) => (
                    <select id={fid} value={companyGrade} onChange={(e) => setCompanyGrade(Number(e.target.value))}>
                      {[1, 2, 3].map((g) => (
                        <option key={g} value={g}>
                          {gradeName(t, g)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              <ol className="moi-grade-rows">
                {rows.map((r, i) => (
                  <li key={i} className="moi-grade-row">
                    <Field label={t('moi.up.activity')} required>
                      {(fid) => (
                        <select id={fid} value={r.activityCode} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, activityCode: e.target.value } : x)))}>
                          <option value="">—</option>
                          {codes.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code} — {pick(c.nameEn, c.nameAr)}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    {!company && (
                      <Field label={t('moi.grade')} required>
                        {(fid) => (
                          <select id={fid} value={r.grade} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, grade: Number(e.target.value) } : x)))}>
                            {[1, 2, 3].map((g) => (
                              <option key={g} value={g}>
                                {gradeName(t, g)}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={rows.length <= 1}
                      aria-label={t('moi.gr.removeRow', { n: i + 1 })}
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
              <Button variant="secondary" onClick={() => setRows([...rows, { activityCode: '', grade: 2 }])}>
                {t('moi.gr.addRow')}
              </Button>
              <Field label={t('common.notes')}>
                {(fid) => <textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <div className="row wrap">
                <Button busy={busy} disabled={!valid} disabledReason={!valid ? t('moi.gr.needActivity') : undefined} onClick={approve} data-tour="grade-approve">
                  {t('moi.gr.approve')}
                </Button>
                <Button variant="danger" onClick={() => setRejectOpen(true)}>
                  {t('moi.gr.reject')}
                </Button>
              </div>
              <p className="small muted">{t('moi.gr.approveNote')}</p>
            </Card>
          ) : (
            <Card title={t('moi.gr.decided')}>
              <p>
                {te('vst.', v.status)} · {fmtDate(v.gradedAt ?? null)}
              </p>
              {v.decisionReason && <p className="small">{v.decisionReason}</p>}
            </Card>
          )}
        </div>
        <aside className="stack side">
          <Card title={t('moi.grades')}>
            <GradeList items={d.lifecycle.classifications} companyGrade={d.lifecycle.companyGrade} />
          </Card>
          <Card title={t('moi.sub.title')}>
            <SubBadge status={d.lifecycle.subscription.status} />
            {d.lifecycle.subscription.paidUntil && <p className="small">{t('moi.sub.until', { date: fmtDate(d.lifecycle.subscription.paidUntil) })}</p>}
          </Card>
        </aside>
      </div>
      <ReasonDialog
        open={rejectOpen}
        title={t('moi.gr.rejectTitle')}
        confirmLabel={t('moi.gr.reject')}
        variant="danger"
        required
        onClose={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          await moiApi.gradeVendor(v.id, { decision: 'REJECT', reason });
          toast(t('moi.gr.rejected'));
          onChange();
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- upgrade decision

export function UpgradeRequestPage() {
  const { id = '' } = useParams();
  const { t, pick, fmtDate } = useI18n();
  const { user } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const st = useAsync(() => moiApi.upgrade(id), [id]);
  const [grade, setGrade] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  return (
    <div className="stack moi-grading">
      <Link to="/procurement/grading" className="backlink">
        ← {t('moi.gr.title')}
      </Link>
      <AsyncView state={st}>
        {(g) => {
          const mine = g.requestedBy === user?.id;
          const options = [1, 2, 3].filter((x) => g.currentGrade === null || x < g.currentGrade);
          const chosen = grade ?? g.requestedGrade;
          const approve = async () => {
            setBusy(true);
            setErr(null);
            try {
              await moiApi.decideUpgrade(g.id, { decision: 'APPROVE', grade: chosen, reason: note.trim() || undefined });
              toast(t('moi.up.approved'));
              st.reload();
            } catch (e) {
              setErr(e);
            } finally {
              setBusy(false);
            }
          };
          return (
            <>
              <header className="page-head">
                <div>
                  <div className="muted small" dir="ltr">
                    {g.requestNumber}
                  </div>
                  <h1>{t('moi.up.titleFor', { name: pick(g.legalNameEn, g.legalNameAr) })}</h1>
                </div>
                <Badge tone={UP_TONE[g.status]} label={t(`moi.up.st.${g.status}` as TKey)} />
              </header>
              <div className="grid-main">
                <div className="stack">
                  <Card title={t('moi.up.request')}>
                    <dl className="kv">
                      <dt>{t('moi.up.activity')}</dt>
                      <dd dir="ltr">{g.activityCode ?? t('moi.companyGrade')}</dd>
                      <dt>{t('moi.up.change')}</dt>
                      <dd>
                        {gradeName(t, g.currentGrade)} → <strong>{gradeName(t, g.requestedGrade)}</strong>
                      </dd>
                      <dt>{t('common.date')}</dt>
                      <dd>{fmtDate(g.createdAt)}</dd>
                      {g.justification && (
                        <>
                          <dt>{t('moi.up.justification')}</dt>
                          <dd className="prewrap">{g.justification}</dd>
                        </>
                      )}
                    </dl>
                    <h3>{t('moi.up.documents')}</h3>
                    <DocList docs={g.documents ?? []} empty={t('vendor.noDocs')} />
                  </Card>
                  <VendorGradeReview vendorId={g.vendorId} />
                  {g.status === 'SUBMITTED' ? (
                    <Card title={t('moi.gr.decide')} id="upgrade-decision">
                      {err ? <ErrorBox error={err} /> : null}
                      {mine && <div className="alert alert-warn">{t('moi.up.ownRequest')}</div>}
                      <Field label={t('moi.up.grant')}>
                        {(fid) => (
                          <select id={fid} value={chosen} onChange={(e) => setGrade(Number(e.target.value))}>
                            {options.map((x) => (
                              <option key={x} value={x}>
                                {gradeName(t, x)}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                      <Field label={t('common.notes')}>
                        {(fid) => <textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
                      </Field>
                      <div className="row wrap">
                        <Button busy={busy} onClick={approve} data-tour="upgrade-approve">
                          {t('moi.up.approve')}
                        </Button>
                        <Button variant="danger" onClick={() => setRejectOpen(true)}>
                          {t('moi.up.reject')}
                        </Button>
                      </div>
                      <p className="small muted">{t('moi.up.note')}</p>
                    </Card>
                  ) : (
                    <Card title={t('moi.gr.decided')}>
                      <p>
                        {t(`moi.up.st.${g.status}` as TKey)} · {fmtDate(g.decidedAt)}
                        {g.grantedGrade ? ` · ${gradeName(t, g.grantedGrade)}` : ''}
                      </p>
                      {g.decisionReason && <p className="small">{g.decisionReason}</p>}
                    </Card>
                  )}
                </div>
                <aside className="stack side">
                  <Card title={t('moi.grades')}>
                    <GradeList items={g.classifications ?? []} />
                  </Card>
                </aside>
              </div>
              <ReasonDialog
                open={rejectOpen}
                title={t('moi.up.reject')}
                confirmLabel={t('moi.up.reject')}
                variant="danger"
                required
                onClose={() => setRejectOpen(false)}
                onConfirm={async (reason) => {
                  await moiApi.decideUpgrade(g.id, { decision: 'REJECT', reason });
                  toast(t('moi.up.rejected'));
                  navigate('/procurement/grading');
                }}
              />
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}
