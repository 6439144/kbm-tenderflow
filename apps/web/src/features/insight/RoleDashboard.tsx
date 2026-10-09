// Role dashboards (MOI BRD FR-031). The server returns one section per role of the signed-in user; each panel
// below renders one section: tiles, one or two charts and the action lists for that role. All numbers come from
// GET /insight/dashboard; optional data from other workstreams (overdue approvals, vendor subscription) is shown only
// when that API exists.
import { Link } from 'react-router-dom';
import { ALL_TENDER_STATUSES } from '../../api';
import { useI18n, type TKey } from '../../i18n';
import { AsyncView, Badge, Button, Card, EmptyState, Hash, Table, useAsync } from '../../components/ui';
import { insight, type AdminSection, type ApproverSection, type AuditorSection, type CommitteeSection, type OfficerSection, type RoleDashboard, type VendorSection } from './api';
import { BarChart, DonutChart, LineChart, SERIES, Tile, useDuration } from './charts';

const STATUS_COLOR: Record<string, string> = Object.fromEntries(ALL_TENDER_STATUSES.map((s, i) => [s, SERIES[i % SERIES.length]]));

function useDash() {
  return useAsync(() => insight.dashboard(), []);
}

/** Staff dashboard body for /procurement (officer, director, undersecretary, chair, evaluator). */
export function StaffRoleDashboard() {
  const { t } = useI18n();
  const state = useDash();
  return (
    <AsyncView state={state} isEmpty={(d) => !d.officer && !d.approver && !d.committee && !d.auditor && !d.admin} empty={t('insight.dash.noSections')}>
      {(d) => <Sections d={d} onReload={state.reload} />}
    </AsyncView>
  );
}

function Sections({ d, onReload }: { d: RoleDashboard; onReload: () => void }) {
  const { t, fmtDate } = useI18n();
  return (
    <div className="stack insight-dash">
      <div className="row spread muted small">
        <span>{t('insight.dash.generated', { at: fmtDate(d.generatedAt) })}</span>
        <Button variant="ghost" onClick={onReload}>{t('common.refresh')}</Button>
      </div>
      {d.officer && <OfficerPanel s={d.officer} />}
      {d.approver && <ApproverPanel s={d.approver} />}
      {d.committee && <CommitteePanel s={d.committee} />}
      {d.auditor && <AuditorPanel s={d.auditor} />}
      {d.admin && <AdminPanel s={d.admin} />}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="insight-section" aria-label={title}>
      <h2 className="insight-section-title">{title}</h2>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ officer
function OfficerPanel({ s }: { s: OfficerSection }) {
  const { t, te, pick, fmtDate } = useI18n();
  const stages = ALL_TENDER_STATUSES.map((st) => ({ key: st, label: te('st.', st), value: s.tendersByStatus[st] ?? 0, color: STATUS_COLOR[st] }));
  return (
    <Section title={t('insight.officer.title')}>
      <div className="tiles">
        <Tile value={s.myDrafts.length} label={t('insight.officer.myDrafts')} />
        <Tile value={s.clarificationsWaiting.total} label={<Link to="/procurement/tenders?status=PUBLISHED">{t('insight.officer.clarifications')}</Link>} tone={s.clarificationsWaiting.total ? 'warn' : undefined} />
        <Tile value={s.documentsNeedingReview} label={<Link to="/procurement/documents">{t('insight.officer.docsReview')}</Link>} tone={s.documentsNeedingReview ? 'warn' : undefined} />
        <Tile value={s.upcomingDeadlines.length} label={t('insight.officer.deadlines14')} />
        <Tile value={s.requestsReadyToConvert} label={<Link to="/procurement/requests">{t('insight.officer.requestsReady')}</Link>} />
        <Tile value={s.vendorsPendingReview} label={<Link to="/procurement/vendors">{t('vst.PENDING_REVIEW')}</Link>} tone={s.vendorsPendingReview ? 'warn' : undefined} />
      </div>
      <div className="insight-grid">
        <Card title={t('insight.officer.byStage')}>
          <BarChart title={t('insight.officer.byStage')} data={stages.filter((x) => x.value > 0)} valueLabel={t('insight.chart.tenders')} />
        </Card>
        <Card title={t('insight.officer.myDrafts')}>
          {s.myDrafts.length === 0 ? <EmptyState message={t('insight.officer.noDrafts')} /> : (
            <Table head={[t('tenders.number'), t('common.title'), t('insight.officer.packDocs'), t('insight.updated')]}>
              {s.myDrafts.map((x) => (
                <tr key={x.id}>
                  <td dir="ltr"><Link to={`/procurement/tenders/${x.id}`}>{x.tenderNumber}</Link></td>
                  <td>{pick(x.titleEn, x.titleAr)}</td>
                  <td>{x.packDocuments === 0 ? <Badge tone="warn" label={t('insight.officer.packMissing')} /> : x.packDocuments}</td>
                  <td>{fmtDate(x.updatedAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <div className="insight-grid">
        <Card title={t('insight.officer.clarifications')}>
          {s.clarificationsWaiting.items.length === 0 ? <EmptyState message={t('insight.officer.noClarifications')} /> : (
            <Table head={[t('tenders.number'), t('common.title'), t('insight.asked'), t('insight.age')]}>
              {s.clarificationsWaiting.items.map((c) => (
                <tr key={c.id}>
                  <td dir="ltr"><Link to={`/procurement/tenders/${c.tenderId}`}>{c.tenderNumber}</Link></td>
                  <td>{pick(c.titleEn, c.titleAr)}</td>
                  <td>{fmtDate(c.askedAt)}</td>
                  <td><Age days={c.ageDays} warnAt={2} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title={t('insight.officer.deadlines14')}>
          {s.upcomingDeadlines.length === 0 ? <EmptyState message={t('insight.officer.noDeadlines')} /> : (
            <Table head={[t('tenders.number'), t('common.title'), t('common.deadline'), t('insight.daysLeft'), t('insight.purchases')]}>
              {s.upcomingDeadlines.map((x) => (
                <tr key={x.id}>
                  <td dir="ltr"><Link to={`/procurement/tenders/${x.id}`}>{x.tenderNumber}</Link></td>
                  <td>{pick(x.titleEn, x.titleAr)}</td>
                  <td>{fmtDate(x.deadline)}</td>
                  <td><Days n={x.daysLeft} /></td>
                  <td>{x.purchases}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </Section>
  );
}

function Days({ n }: { n: number }) {
  const dur = useDuration();
  return <span className="insight-num">{dur(n)}</span>;
}
function Age({ days, warnAt }: { days: number; warnAt: number }) {
  const dur = useDuration();
  return <Badge tone={days >= warnAt ? 'warn' : 'neutral'} label={dur(days)} />;
}

// ------------------------------------------------------------------ approvers
function ApproverPanel({ s }: { s: ApproverSection }) {
  const { t, te, pick, fmtDate } = useI18n();
  const dur = useDuration();
  const overdue = useAsync(() => insight.overdueApprovals(), []);
  const link = (w: ApproverSection['waiting'][number]) => (w.kind === 'REQUEST' ? `/procurement/requests/${w.id}` : `/procurement/tenders/${w.tenderId}`);
  return (
    <Section title={t('insight.approver.title')}>
      <div className="tiles">
        <Tile value={s.waitingCount} label={t('insight.approver.waiting')} tone={s.waitingCount ? 'warn' : 'ok'} />
        <Tile value={dur(s.oldestWaitingDays)} label={t('insight.approver.oldest')} />
        <Tile value={dur(s.medianWaitingDays)} label={t('insight.approver.median')} />
        {overdue.data && Array.isArray(overdue.data) ? (
          <Tile value={overdue.data.length} label={t('insight.approver.overdue')} tone={overdue.data.length ? 'danger' : 'ok'} />
        ) : null}
        <Tile value={s.publishedThisMonth.count} label={t('insight.approver.publishedMonth')} hint={t('insight.since', { date: fmtDate(s.publishedThisMonth.since) })} />
      </div>
      <div className="insight-grid">
        <Card title={t('insight.approver.waitingAge')}>
          <BarChart title={t('insight.approver.waitingAge')} subtitle={t('insight.approver.waitingAgeHint')}
            data={s.waiting.map((w) => ({ key: `${w.kind}-${w.id}`, label: w.number, value: w.ageDays, hint: pick(w.titleEn, w.titleAr) }))}
            valueLabel={t('insight.age')} digits={1} unit={` ${t('insight.dUnit')}`} />
        </Card>
        <Card title={t('insight.approver.list')}>
          {s.waiting.length === 0 ? <EmptyState message={t('insight.approver.none')} /> : (
            <Table head={[t('insight.kind'), t('tenders.number'), t('common.title'), t('insight.level'), t('insight.waitingSince'), t('insight.age')]}>
              {s.waiting.map((w) => (
                <tr key={`${w.kind}-${w.id}`}>
                  <td><Badge tone="info" label={te('insight.wait.', w.kind)} /></td>
                  <td dir="ltr"><Link to={link(w)}>{w.number}</Link></td>
                  <td>{pick(w.titleEn, w.titleAr)}</td>
                  <td>{t('insight.levelOf', { n: w.level, of: w.of })}</td>
                  <td>{fmtDate(w.waitingSince)}</td>
                  <td><Age days={w.ageDays} warnAt={3} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ committee
function CommitteePanel({ s }: { s: CommitteeSection }) {
  const { t, te, pick, fmtDate } = useI18n();
  return (
    <Section title={t('insight.committee.title')}>
      <div className="tiles">
        {s.openingsDue && <Tile value={s.openingsDue.length} label={t('insight.committee.openingsDue')} tone={s.openingsDue.length ? 'warn' : undefined} />}
        {s.financialOpeningsDue && <Tile value={s.financialOpeningsDue.length} label={t('insight.committee.financialDue')} />}
        {s.awardsToRecommend && <Tile value={s.awardsToRecommend.length} label={t('insight.committee.toRecommend')} />}
        <Tile value={s.evaluations.length} label={t('insight.committee.inEvaluation')} />
        {s.myScoring && <Tile value={s.myScoring.remaining} label={t('insight.committee.myRemaining')} hint={t('insight.committee.myScored', { n: s.myScoring.scored })} tone={s.myScoring.remaining ? 'warn' : 'ok'} />}
      </div>
      <div className="insight-grid">
        <Card title={t('insight.committee.progress')}>
          <BarChart title={t('insight.committee.progress')} subtitle={t('insight.committee.progressHint')}
            data={s.evaluations.map((e) => ({ key: e.id, label: e.tenderNumber, value: e.evaluationsSubmitted, hint: t('insight.committee.progressItem', { bids: e.scorableBids, evaluators: e.evaluators }) }))}
            valueLabel={t('insight.committee.evaluationsSubmitted')} />
        </Card>
        {s.openingsDue && (
          <Card title={t('insight.committee.openingsDue')}>
            {s.openingsDue.length === 0 ? <EmptyState message={t('insight.committee.noOpenings')} /> : (
              <Table head={[t('tenders.number'), t('common.title'), t('common.deadline'), t('insight.committee.sealed')]}>
                {s.openingsDue.map((x) => (
                  <tr key={x.id}>
                    <td dir="ltr"><Link to={`/procurement/tenders/${x.id}`}>{x.tenderNumber}</Link></td>
                    <td>{pick(x.titleEn, x.titleAr)}</td>
                    <td>{fmtDate(x.deadline)}</td>
                    <td>{x.sealedBids}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </div>
      {s.evaluations.length > 0 && (
        <Card title={t('insight.committee.inEvaluation')}>
          <Table head={[t('tenders.number'), t('common.title'), t('common.status'), t('insight.committee.phase'), t('insight.committee.bids'), t('insight.committee.evaluationsSubmitted'),
            ...(s.myScoring ? [t('insight.committee.mine')] : [])]}>
            {s.evaluations.map((e) => (
              <tr key={e.id}>
                <td dir="ltr"><Link to={`/procurement/tenders/${e.id}`}>{e.tenderNumber}</Link></td>
                <td>{pick(e.titleEn, e.titleAr)}</td>
                <td><Badge value={e.status} label={te('st.', e.status)} /></td>
                <td>{te('insight.phase.', e.phase)}</td>
                <td>{e.scorableBids}</td>
                <td>{e.evaluationsSubmitted}</td>
                {s.myScoring && <td>{e.myScored} / {e.scorableBids}</td>}
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {s.financialOpeningsDue && s.financialOpeningsDue.length > 0 && (
        <Card title={t('insight.committee.financialDue')}>
          <ul className="plain">
            {s.financialOpeningsDue.map((x) => (
              <li key={x.id}>
                <Link to={`/procurement/tenders/${x.id}`} dir="ltr">{x.tenderNumber}</Link> — {pick(x.titleEn, x.titleAr)}{' '}
                <span className="muted small">{t('insight.committee.techEvaluated', { n: x.technicalEvaluated, of: x.openedBids })}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ auditor
export function AuditorPanel({ s }: { s: AuditorSection }) {
  const { t, lang, fmtDate } = useI18n();
  const dayLabel = (d: string) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-KW' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  const ai = s.aiRuns;
  return (
    <Section title={t('insight.auditor.title')}>
      <div className="tiles">
        <Tile value={s.auditChain.valid ? t('insight.auditor.valid') : t('insight.auditor.broken', { seq: s.auditChain.brokenAt ?? '?' })}
          label={t('insight.auditor.chain')} tone={s.auditChain.valid ? 'ok' : 'danger'} hint={t('insight.auditor.events', { n: s.auditChain.count })} />
        <Tile value={s.eventsThisMonth} label={t('insight.auditor.eventsMonth')} />
        <Tile value={s.records.documents} label={t('insight.auditor.records')} hint={t('insight.auditor.inRepository', { n: s.records.inRepository })} />
        <Tile value={s.records.tendersLocked} label={t('insight.auditor.tendersLocked')} />
        <Tile value={ai.accepted + ai.edited} label={t('insight.auditor.aiAccepted')} hint={t('insight.auditor.aiIgnored', { n: ai.ignored })} />
      </div>
      <div className="insight-grid">
        <Card title={t('insight.auditor.perDay')}>
          <LineChart title={t('insight.auditor.perDay')} subtitle={t('insight.auditor.perDayHint')}
            points={s.eventsPerDay.map((p) => ({ x: p.day, label: dayLabel(p.day), y: p.count }))} valueLabel={t('insight.auditor.eventsCol')} />
        </Card>
        <Card title={t('insight.auditor.aiRuns')}>
          <DonutChart title={t('insight.auditor.aiRuns')} subtitle={t('insight.auditor.aiRunsHint')} valueLabel={t('insight.chart.runs')} data={[
            { key: 'acc', label: t('insight.ai.accepted'), value: ai.accepted, color: SERIES[2] },
            { key: 'edit', label: t('insight.ai.edited'), value: ai.edited, color: SERIES[0] },
            { key: 'ign', label: t('insight.ai.ignored'), value: ai.ignored, color: SERIES[3] },
            { key: 'unrev', label: t('insight.ai.unreviewed'), value: ai.unreviewed, color: '#8a94a3' },
            { key: 'err', label: t('insight.ai.failed'), value: ai.failed, color: SERIES[7] },
          ]} />
        </Card>
      </div>
      <div className="insight-grid">
        <Card title={t('insight.auditor.topActions')}>
          <BarChart title={t('insight.auditor.topActions')} data={s.topActions.map((a) => ({ key: a.action, label: a.action, value: a.count }))} valueLabel={t('insight.auditor.eventsCol')} />
        </Card>
        <Card title={t('insight.evidence.recent')} actions={<Link className="btn btn-secondary" to="/admin/evidence">{t('insight.evidence.open')}</Link>}>
          {s.evidencePacks.length === 0 ? <EmptyState message={t('insight.evidence.none')} /> : (
            <ul className="plain insight-list">
              {s.evidencePacks.map((p) => (
                <li key={p.id}>
                  <strong dir="ltr">{p.tenderNumber ?? t('insight.evidence.rangePack')}</strong> <span className="muted small">{fmtDate(p.createdAt)}</span>
                  <div><Hash value={p.sha256} /></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ tenant admin
export function AdminPanel({ s }: { s: AdminSection }) {
  const { t, te, pick, fmtDate } = useI18n();
  const users = s.usersByRole.reduce((a, r) => a + r.active, 0);
  const grades: Record<number, TKey> = { 1: 'insight.grade.1', 2: 'insight.grade.2', 3: 'insight.grade.3' };
  return (
    <Section title={t('insight.admin.title')}>
      <div className="tiles">
        <Tile value={users} label={t('insight.admin.activeUsers')} />
        <Tile value={s.vendorsByStatus.APPROVED ?? 0} label={t('dash.vendorsApproved')} hint={t('insight.admin.pending', { n: s.vendorsByStatus.PENDING_REVIEW ?? 0 })} />
        <Tile value={s.fileNet.ok ? t('insight.admin.reachable') : t('insight.admin.unreachable')} tone={s.fileNet.ok ? 'ok' : 'danger'}
          label={<Link to="/admin/filenet">{s.fileNet.storeType === 'filenet' ? t('insight.admin.filenet') : t('insight.admin.localStore')}</Link>}
          hint={t('insight.admin.docs', { n: s.fileNet.documents.total, f: s.fileNet.documents.inFileNet })} />
        <Tile value={!s.orchestrate.configured ? t('insight.admin.notConfigured') : s.orchestrate.missingAgents.length ? t('insight.admin.missing', { n: s.orchestrate.missingAgents.length }) : s.orchestrate.agentsChecked ? t('insight.admin.agentsOk') : t('insight.admin.notChecked')}
          tone={!s.orchestrate.configured ? undefined : s.orchestrate.missingAgents.length || !s.orchestrate.agentsChecked ? 'warn' : 'ok'}
          label={t('insight.admin.orchestrate')} hint={s.orchestrate.lastSuccessfulRun ? t('insight.admin.lastRun', { at: fmtDate(s.orchestrate.lastSuccessfulRun) }) : t('insight.admin.noRuns')} />
        <Tile value={s.templates.filter((x) => x.status === 'PUBLISHED').length} label={<Link to="/admin/cycle">{t('insight.admin.templates')}</Link>} />
      </div>
      <div className="insight-grid">
        <Card title={t('insight.admin.usersByRole')}>
          <DonutChart title={t('insight.admin.usersByRole')} valueLabel={t('insight.chart.users')}
            data={s.usersByRole.map((r, i) => ({ key: r.role, label: te('role.', r.role), value: r.active, color: SERIES[i % SERIES.length] }))} />
        </Card>
        <Card title={t('insight.admin.vendorsByGrade')}>
          <BarChart title={t('insight.admin.vendorsByGrade')} subtitle={t('insight.admin.vendorsByGradeHint')} valueLabel={t('insight.chart.vendors')}
            data={s.vendorsByGrade.map((g) => ({ key: String(g.grade), label: g.grade ? t(grades[g.grade] ?? 'insight.grade.none') : t('insight.grade.none'), value: g.vendors }))} />
        </Card>
      </div>
      <div className="insight-grid">
        <Card title={t('insight.admin.vendorsByStatus')}>
          <DonutChart title={t('insight.admin.vendorsByStatus')} valueLabel={t('insight.chart.vendors')}
            data={['APPROVED', 'PENDING_REVIEW', 'REJECTED'].map((k, i) => ({ key: k, label: te('vst.', k), value: s.vendorsByStatus[k] ?? 0, color: [SERIES[2], SERIES[3], SERIES[7]][i] }))} />
        </Card>
        <Card title={t('insight.admin.templateVersions')}>
          {s.templates.length === 0 ? <EmptyState message={t('insight.noData')} /> : (
            <Table head={[t('insight.admin.code'), t('common.title'), t('insight.admin.version'), t('common.status')]}>
              {s.templates.map((x) => (
                <tr key={`${x.code}-${x.version}`}>
                  <td dir="ltr">{x.code}</td>
                  <td>{pick(x.nameEn, x.nameAr)} {x.isDefault && <Badge tone="primary" label={t('insight.admin.default')} />}</td>
                  <td>v{x.version}</td>
                  <td><Badge tone={x.status === 'PUBLISHED' ? 'success' : 'neutral'} label={te('insight.tpl.', x.status)} /></td>
                </tr>
              ))}
            </Table>
          )}
          {s.orchestrate.missingAgents.length > 0 && (
            <p className="small muted">{t('insight.admin.missingList')}: <code dir="ltr">{s.orchestrate.missingAgents.map((m) => m.name).join(', ')}</code></p>
          )}
        </Card>
      </div>
    </Section>
  );
}

/** /admin/overview — tenant admin and auditor dashboards (they sign in to the admin portal). */
export function AdminOverviewPage() {
  const { t } = useI18n();
  const state = useDash();
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('insight.overview.title')}</h1>
          <p className="muted">{t('insight.overview.subtitle')}</p>
        </div>
        <Button variant="ghost" onClick={state.reload}>{t('common.refresh')}</Button>
      </header>
      <AsyncView state={state} isEmpty={(d) => !d.auditor && !d.admin} empty={t('insight.dash.noSections')}>
        {(d) => (
          <div className="stack insight-dash">
            {d.admin && <AdminPanel s={d.admin} />}
            {d.auditor && <AuditorPanel s={d.auditor} />}
          </div>
        )}
      </AsyncView>
    </div>
  );
}

// ------------------------------------------------------------------ vendor
/** Vendor home summary: eligible open tenders, purchases and receipts, bids and outcomes, expiring documents. */
export function VendorDashboard() {
  const { t } = useI18n();
  const state = useDash();
  const sub = useAsync(() => insight.mySubscription(), []);
  return (
    <AsyncView state={state} isEmpty={(d) => !d.vendor} empty={t('insight.dash.noSections')}>
      {(d) => <VendorPanel s={d.vendor!} subscription={sub.data ?? null} />}
    </AsyncView>
  );
}

const OUTCOMES = ['AWARDED', 'UNDER_EVALUATION', 'SEALED', 'NOT_AWARDED', 'TECHNICAL_FAILED', 'TENDER_CANCELLED'] as const;
const OUTCOME_COLOR = [SERIES[2], SERIES[0], '#8a94a3', SERIES[3], SERIES[7], SERIES[4]];
const OUTCOME_TONE: Record<string, string> = { AWARDED: 'success', NOT_AWARDED: 'neutral', TECHNICAL_FAILED: 'danger', TENDER_CANCELLED: 'danger', SEALED: 'neutral', UNDER_EVALUATION: 'info' };

function VendorPanel({ s, subscription }: { s: VendorSection; subscription: Record<string, unknown> | null }) {
  const { t, te, pick, fmtDate, fmtMoney, lang } = useI18n();
  const subStatus = subscription && typeof subscription.status === 'string' ? subscription.status : null;
  return (
    <Section title={t('insight.vendor.title')}>
      <div className="tiles">
        <Tile value={s.eligibleCount} label={t('insight.vendor.eligibleOpen')} hint={t('insight.vendor.ofOpen', { n: s.eligibleOpenTenders.length })} />
        <Tile value={s.purchases.length} label={t('insight.vendor.purchases')} />
        <Tile value={s.bids.length} label={t('insight.vendor.bids')} />
        <Tile value={s.expiring.length} label={t('insight.vendor.expiring')} tone={s.expiring.some((e) => e.expired) ? 'danger' : s.expiring.length ? 'warn' : 'ok'} />
        {subStatus && <Tile value={subStatus} label={t('insight.vendor.subscription')} />}
      </div>
      <Card title={t('insight.vendor.openTenders')}>
        {s.eligibleOpenTenders.length === 0 ? <EmptyState message={s.vendorStatus === 'APPROVED' ? t('insight.vendor.noOpen') : t('insight.vendor.notApproved')} /> : (
          <Table head={[t('tenders.number'), t('common.title'), t('common.deadline'), t('insight.vendor.eligibility'), t('insight.vendor.documents'), t('insight.vendor.yourBid')]}>
            {s.eligibleOpenTenders.map((x) => (
              <tr key={x.id}>
                <td dir="ltr"><Link to={`/vendor/tenders/${x.id}`}>{x.tenderNumber}</Link></td>
                <td>{pick(x.titleEn, x.titleAr)}</td>
                <td>{fmtDate(x.deadline)}</td>
                <td>
                  {x.eligible ? <Badge tone="success" label={t('insight.vendor.eligible')} /> : (
                    <span title={x.reasons.map((r) => (lang === 'ar' ? r.ar : r.en)).join(' · ')}>
                      <Badge tone="danger" label={t('insight.vendor.notEligible')} />
                      <span className="muted small"> {x.reasons.map((r) => (lang === 'ar' ? r.ar : r.en)).join(' · ')}</span>
                    </span>
                  )}
                </td>
                <td>{!x.purchaseRequired ? <span className="muted">{t('insight.vendor.free')}</span> : x.purchased ? <Badge tone="success" label={t('insight.vendor.purchased')} /> : fmtMoney(x.documentPrice?.amount ?? null, x.documentPrice?.currency)}</td>
                <td>{x.bidSubmitted ? <Badge tone="success" label={t('insight.vendor.submitted')} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="insight-grid">
        <Card title={t('insight.vendor.purchases')}>
          {s.purchases.length === 0 ? <EmptyState message={t('insight.vendor.noPurchases')} /> : (
            <Table head={[t('insight.vendor.receipt'), t('tenders.number'), t('insight.vendor.amount'), t('insight.vendor.paidAt')]}>
              {s.purchases.map((p) => (
                <tr key={p.receiptNumber}>
                  <td dir="ltr">{p.receiptNumber} {p.testPayment && <Badge tone="warn" label={t('insight.testPayment')} />}</td>
                  <td dir="ltr"><Link to={`/vendor/tenders/${p.tenderId}`}>{p.tenderNumber}</Link></td>
                  <td>{p.status === 'EXEMPTED' ? t('insight.vendor.exempted') : fmtMoney(p.amount, p.currency)}</td>
                  <td>{fmtDate(p.paidAt)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title={t('insight.vendor.bids')}>
          {s.bids.length === 0 ? <EmptyState message={t('vendor.noBids')} /> : (
            <Table head={[t('tenders.number'), t('common.title'), t('td.submittedAt'), t('insight.vendor.receiptHash'), t('insight.vendor.outcome')]}>
              {s.bids.map((b) => (
                <tr key={b.id}>
                  <td dir="ltr"><Link to={`/vendor/tenders/${b.tenderId}`}>{b.tenderNumber}</Link></td>
                  <td>{pick(b.titleEn, b.titleAr)}</td>
                  <td>{fmtDate(b.submittedAt)}</td>
                  <td><Hash value={b.receiptSha256} /></td>
                  <td><Badge tone={OUTCOME_TONE[b.outcome] ?? 'neutral'} label={te('insight.outcome.', b.outcome)} /></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <div className="insight-grid">
        <Card title={t('insight.vendor.bidOutcomes')}>
          <DonutChart title={t('insight.vendor.bidOutcomes')} valueLabel={t('insight.chart.bids')}
            data={OUTCOMES.map((o, i) => ({ key: o, label: te('insight.outcome.', o), value: s.bids.filter((b) => b.outcome === o).length, color: OUTCOME_COLOR[i] }))} />
        </Card>
      <Card title={t('insight.vendor.expiring')}>
        {s.expiring.length === 0 ? <EmptyState message={t('insight.vendor.noExpiring')} /> : (
          <Table head={[t('insight.kind'), t('common.title'), t('insight.vendor.expires')]}>
            {s.expiring.map((e) => (
              <tr key={`${e.kind}-${e.id}`}>
                <td>{te('insight.exp.', e.kind)}</td>
                <td>{pick(e.titleEn, e.titleAr)}</td>
                <td><Badge tone={e.expired ? 'danger' : 'warn'} label={`${e.expired ? t('insight.vendor.expired') : t('insight.vendor.expiresOn')} ${e.date}`} /></td>
              </tr>
            ))}
          </Table>
        )}
        <p className="muted small">{t('insight.vendor.expiringHint')}</p>
      </Card>
      </div>
    </Section>
  );
}
