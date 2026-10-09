// Staff tender page: the specialist Orchestrate agents that apply to this tender's status, the caller's role and the
// cycle template (td.cycle): gazette/CAPT notice drafter (officer), vendor relevance ranking (PUBLISHED) and the
// committee evaluation narrative (chair). Every result is an advisory AI run; saving is a separate human action.
import { useState } from 'react';
import type { DocumentMeta, TenderDetail } from '../../api';
import { api } from '../../api';
import { platform } from '../../api-platform';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { Citations, DocList } from '../../components/shared';
import { Badge, Button, Card, ErrorBox, Field, useAsync, useToast } from '../../components/ui';
import { assistantApi, type AgentRun } from './api-assistant';

type Channel = 'KUWAIT_ALYOUM' | 'CAPT';
const NOTICE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'];
const RANKERS = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'TENANT_ADMIN'] as const;

const latestOf = (td: TenderDetail, kind: string): AgentRun | null =>
  ((td.aiRuns ?? []) as unknown as AgentRun[]).filter((r) => r.kind === kind).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0] ?? null;

function RunMeta({ run }: { run: AgentRun }) {
  const { t, fmtDate } = useI18n();
  return (
    <div className="small muted">
      {t('assistant.lastRun', { date: fmtDate(run.createdAt), agent: run.agent ?? '—' })}
      {run.model ? ` · ${run.model}` : ''} · {t('assistant.run')} <code>{run.id.slice(0, 8)}</code>
      {run.reviewDecision ? ` · ${run.reviewDecision}` : ''}
    </div>
  );
}

export function TenderAiExtras({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t } = useI18n();
  const { hasRole } = useSession();
  const cfg = td.cycle;
  if (!cfg) return null;
  const isOfficer = hasRole('PROCUREMENT_OFFICER');
  const channels = (['KUWAIT_ALYOUM', 'CAPT'] as Channel[]).filter((c) => (c === 'KUWAIT_ALYOUM' ? cfg.stages.gazette : cfg.stages.capt));
  const showNotice = isOfficer && cfg.ai.gazette && channels.length > 0 && NOTICE_STATUSES.includes(td.status);
  const showRelevance = hasRole(...RANKERS) && cfg.ai.relevance && td.status === 'PUBLISHED';
  const showNarrative = hasRole('COMMITTEE_CHAIR') && cfg.ai.narrative && (td.status === 'EVALUATION' || td.status === 'AWARDED');
  if (!showNotice && !showRelevance && !showNarrative) return null;
  return (
    <Card id="sec-orchestrate" className="ast-card" title={<>{t('assistant.agents')} <span className="ai-tag">IBM watsonx Orchestrate</span></>}>
      <p className="small muted">{t('assistant.agentsHint')}</p>
      <div className="stack">
        {showNotice && <NoticeDrafter td={td} channels={channels} onChange={onChange} />}
        {showRelevance && <VendorRanking td={td} onChange={onChange} />}
        {showNarrative && <Narrative td={td} onChange={onChange} />}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ notice drafter

function NoticeDrafter({ td, channels, onChange }: { td: TenderDetail; channels: Channel[]; onChange: () => void }) {
  const { t, te } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<Channel | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ channel: Channel; run: AgentRun; ar: string; en: string } | null>(null);
  const pubs = td.publications ?? [];

  const run = async (channel: Channel) => {
    setBusy(channel); setErr(null);
    try {
      const r = await assistantApi.draftNotice(td.id, channel);
      const out = (r.response ?? {}) as { noticeAr?: string; noticeEn?: string };
      setDraft({ channel, run: r, ar: out.noticeAr ?? '', en: out.noticeEn ?? '' });
      onChange();
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true); setErr(null);
    try {
      const out = (draft.run.response ?? {}) as { noticeAr?: string; noticeEn?: string };
      const edited = draft.ar !== out.noticeAr || draft.en !== out.noticeEn;
      await platform.saveNotice(td.id, { channel: draft.channel, noticeAr: draft.ar, noticeEn: draft.en, aiRunId: draft.run.id });
      await api.reviewAiRun(draft.run.id, edited ? 'EDITED' : 'ACCEPTED', `Saved as DRAFT ${draft.channel} notice`).catch(() => undefined);
      toast(t('assistant.notice.saved', { channel: t(`assistant.notice.${draft.channel}`) }), 'success');
      setDraft(null);
      onChange();
    } catch (e) { setErr(e); } finally { setSaving(false); }
  };

  return (
    <section className="ast-agent">
      <h3>{t('assistant.notice.title')}</h3>
      <p className="small muted">{t('assistant.notice.facts')}</p>
      <div className="row wrap">
        {channels.map((c) => {
          const p = pubs.find((x) => x.channel === c);
          if (p?.status === 'PUBLISHED') return <Badge key={c} value="PUBLISHED" label={t('assistant.notice.already', { channel: t(`assistant.notice.${c}`), status: te('st.', p.status) })} />;
          return (
            <span key={c} className="row">
              <Button variant="secondary" busy={busy === c} disabled={busy !== null} onClick={() => void run(c)}>
                {t('assistant.notice.draft', { channel: t(`assistant.notice.${c}`) })}
              </Button>
              {p && <Badge value={p.status} label={t('assistant.notice.already', { channel: t(`assistant.notice.${c}`), status: te('st.', p.status) })} />}
            </span>
          );
        })}
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {draft && (
        <div className="ai-box stack-sm">
          <RunMeta run={draft.run} />
          <div className="grid-2">
            <Field label={t('assistant.notice.ar')}>
              {(id) => <textarea id={id} dir="rtl" lang="ar" rows={9} value={draft.ar} onChange={(e) => setDraft({ ...draft, ar: e.target.value })} />}
            </Field>
            <Field label={t('assistant.notice.en')}>
              {(id) => <textarea id={id} dir="ltr" lang="en" rows={9} value={draft.en} onChange={(e) => setDraft({ ...draft, en: e.target.value })} />}
            </Field>
          </div>
          <Citations items={draft.run.citations} />
          <div className="row">
            <Button busy={saving} disabled={!draft.ar.trim() || !draft.en.trim()} onClick={() => void save()}>{t('assistant.notice.save')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ vendor relevance

interface RankedVendor { id: string; score: number; reasonsEn: string; reasonsAr: string; nameEn?: string; nameAr?: string }

function VendorRanking({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t, pick } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [fresh, setFresh] = useState<AgentRun | null>(null);
  const latest = fresh ?? latestOf(td, 'RELEVANCE_MATCH');
  const ranked = latest?.status === 'OK' ? (((latest.response ?? {}) as { ranked?: RankedVendor[] }).ranked ?? []) : [];

  const run = async () => {
    setBusy(true); setErr(null);
    try { setFresh(await assistantApi.rankVendors(td.id)); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <section className="ast-agent">
      <div className="row spread">
        <h3>{t('assistant.rel.title')} <span className="ai-tag">{t('assistant.aiRanked')}</span></h3>
        <Button variant="secondary" busy={busy} onClick={() => void run()}>{t('assistant.rel.run')}</Button>
      </div>
      <p className="small muted">{t('assistant.rel.rules')}</p>
      {err ? <ErrorBox error={err} /> : null}
      {!latest ? (
        <p className="small muted">{t('assistant.rel.none')}</p>
      ) : latest.status === 'ERROR' ? (
        <div className="alert alert-danger">{t('ai.error')}: {latest.error}</div>
      ) : (
        <>
          <RunMeta run={latest} />
          <ol className="ast-ranked">
            {ranked.map((r) => (
              <li key={r.id}>
                <div className="row spread">
                  <strong>{pick(r.nameEn, r.nameAr) || r.id}</strong>
                  <ScoreBar score={r.score} />
                </div>
                <div className="small" dir="auto">{pick(r.reasonsEn, r.reasonsAr)}</div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const { t } = useI18n();
  const s = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <span className="ast-score" title={`${t('assistant.rel.score')}: ${s}/100`}>
      <span className="ast-score-track" aria-hidden="true"><span className="ast-score-fill" style={{ inlineSize: `${s}%` }} /></span>
      <span className="ast-score-n">{s}</span>
    </span>
  );
}

// ------------------------------------------------------------------ committee narrative

function Narrative({ td, onChange }: { td: TenderDetail; onChange: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [fresh, setFresh] = useState<AgentRun | null>(null);
  const [edit, setEdit] = useState<{ runId: string; en: string; ar: string } | null>(null);
  const saved = useAsync<DocumentMeta[]>(() => assistantApi.narratives(td.id), [td.id]);
  const latest = fresh ?? latestOf(td, 'EVALUATION_NARRATIVE');
  const out = (latest?.response ?? {}) as { narrativeEn?: string; narrativeAr?: string };
  const cur = latest && edit?.runId === latest.id ? edit : latest ? { runId: latest.id, en: out.narrativeEn ?? '', ar: out.narrativeAr ?? '' } : null;
  const locked = Boolean(td.recordsLockedAt);

  const run = async () => {
    setBusy(true); setErr(null);
    try { const r = await assistantApi.draftNarrative(td.id); setFresh(r); setEdit(null); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!cur) return;
    setSaving(true); setErr(null);
    try {
      await assistantApi.saveNarrative(cur.runId, { narrativeEn: cur.en, narrativeAr: cur.ar });
      toast(t('assistant.narr.saved'), 'success');
      setFresh(null); setEdit(null); saved.reload(); onChange();
    } catch (e) { setErr(e); } finally { setSaving(false); }
  };

  return (
    <section className="ast-agent">
      <div className="row spread">
        <h3>{t('assistant.narr.title')}</h3>
        <Button variant="secondary" busy={busy} disabled={locked} onClick={() => void run()}>{t('assistant.narr.run')}</Button>
      </div>
      <p className="small muted">{t('assistant.narr.rules')}</p>
      {err ? <ErrorBox error={err} /> : null}
      {latest?.status === 'ERROR' && <div className="alert alert-danger">{t('ai.error')}: {latest.error}</div>}
      {latest?.status === 'OK' && cur && (
        <div className="ai-box stack-sm">
          <RunMeta run={latest} />
          {latest.reviewDecision ? (
            <p className="small">{t('assistant.narr.reviewed', { decision: latest.reviewDecision })}</p>
          ) : (
            <>
              <Field label={t('assistant.narr.en')}>
                {(id) => <textarea id={id} dir="ltr" lang="en" rows={8} value={cur.en} onChange={(e) => setEdit({ ...cur, en: e.target.value })} />}
              </Field>
              <Field label={t('assistant.narr.ar')}>
                {(id) => <textarea id={id} dir="rtl" lang="ar" rows={8} value={cur.ar} onChange={(e) => setEdit({ ...cur, ar: e.target.value })} />}
              </Field>
              <div className="row">
                <Button busy={saving} disabled={locked || !cur.en.trim() || !cur.ar.trim()} onClick={() => void save()}>{t('assistant.narr.save')}</Button>
              </div>
            </>
          )}
        </div>
      )}
      {saved.data && saved.data.length > 0 && (
        <>
          <h4>{t('assistant.narr.savedList')}</h4>
          <DocList docs={saved.data} empty="" />
        </>
      )}
    </section>
  );
}
