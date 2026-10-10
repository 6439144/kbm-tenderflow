// AI admin builder UI: chat with the watsonx Orchestrate agent tenderflow_admin_builder on one side, the proposal that
// TenderFlow validated on the other (one card per operation: plain-language sentence, validation badge, reasons and
// the exact field-level change), then "Create drafts" / "Discard". Used full-page (/admin/builder) and compact in the
// DescribeChangeButton modal. Nothing here simulates AI: no configuration → banner and no reply.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api';
import { translate, useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { AgentNotImportedBanner, AiNotConfiguredBanner, Badge, Button, ErrorBox, Spinner, useToast } from '../../components/ui';
import { adminAgent, type AgentStatus, type AppliedRef, type Bilingual, type OpResult, type Proposal, type ProposalSummary } from './api';

export type BuilderScope = 'template' | 'process' | 'forms';

const CHIPS: Record<BuilderScope | 'all', TKey[]> = {
  all: ['aa.s.template', 'aa.s.approval', 'aa.s.field', 'aa.s.reminder', 'aa.s.risk', 'aa.s.docType'],
  template: ['aa.s.template', 'aa.s.templateFee', 'aa.s.templateApprovals'],
  process: ['aa.s.approval', 'aa.s.reminder', 'aa.s.risk'],
  forms: ['aa.s.field', 'aa.s.vendorField', 'aa.s.docType'],
};

function Sparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2l1.8 5.4L19 9.2l-5.2 1.8L12 16.4l-1.8-5.4L5 9.2l5.2-1.8L12 2zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z" />
    </svg>
  );
}
export { Sparkle };

// ---------------------------------------------------------------- state hook

export function useBuilder(opts: { initialId?: string | null; onProposal?: (p: Proposal | null) => void } = {}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [proposal, setProposalState] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<null | 'send' | 'apply' | 'discard' | 'load'>(null);
  const [error, setError] = useState<unknown>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const onProposal = useRef(opts.onProposal);
  onProposal.current = opts.onProposal;
  const currentId = useRef<string | null>(null);
  const setProposal = useCallback((p: Proposal | null) => { currentId.current = p?.id ?? null; setProposalState(p); onProposal.current?.(p); }, []);

  useEffect(() => {
    let alive = true;
    adminAgent.status().then((s) => alive && setStatus(s)).catch(() => alive && setStatus(null));
    return () => { alive = false; };
  }, []);

  const load = useCallback(async (id: string) => {
    setBusy('load'); setError(null);
    try { setProposal(await adminAgent.get(id)); } catch (e) { setError(e); } finally { setBusy(null); }
  }, [setProposal]);

  // Open the proposal named in the URL (not again when the URL only follows the proposal shown here).
  useEffect(() => { if (opts.initialId && opts.initialId !== currentId.current) void load(opts.initialId); }, [opts.initialId, load]);

  return {
    status, proposal, busy, error, historyTick, setError,
    load,
    reset: () => { setProposal(null); setError(null); },
    async send(message: string, mine: boolean) {
      setBusy('send'); setError(null);
      const refine = proposal && proposal.status === 'PROPOSED' && mine ? proposal.id : null;
      try {
        const p = await adminAgent.chat({ message, proposalId: refine });
        setProposal(p);
        setStatus((s) => (s ? { ...s, configured: true, agent: { ...s.agent, imported: true } } : s));
        setHistoryTick((x) => x + 1);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'AI_NOT_CONFIGURED') setStatus((s) => (s ? { ...s, configured: false } : s));
        if (e instanceof ApiError && e.code === 'AI_AGENT_NOT_IMPORTED') setStatus((s) => (s ? { ...s, agent: { ...s.agent, imported: false } } : s));
        setError(e);
        throw e;
      } finally { setBusy(null); }
    },
    async apply() {
      if (!proposal) return null;
      setBusy('apply'); setError(null);
      try {
        const p = await adminAgent.apply(proposal.id);
        setProposal(p); setHistoryTick((x) => x + 1);
        return p;
      } catch (e) {
        const v = e instanceof ApiError ? (e.details as { validation?: Proposal['validation'] } | undefined)?.validation : undefined;
        if (v) setProposal({ ...proposal, validation: v });
        setError(e);
        return null;
      } finally { setBusy(null); }
    },
    async discard() {
      if (!proposal) return;
      setBusy('discard'); setError(null);
      try { setProposal(await adminAgent.discard(proposal.id)); setHistoryTick((x) => x + 1); } catch (e) { setError(e); } finally { setBusy(null); }
    },
  };
}
export type Builder = ReturnType<typeof useBuilder>;

// ---------------------------------------------------------------- status line + banners

export function AgentStatusLine({ status }: { status: AgentStatus | null }) {
  const { t } = useI18n();
  if (!status) return null;
  const tone = !status.configured ? 'neutral' : status.agent.imported === false ? 'warn' : status.agent.imported ? 'success' : 'neutral';
  const label = !status.configured ? t('aa.status.notConfigured') : status.agent.imported === false ? t('aa.status.notImported')
    : status.agent.imported ? t('aa.status.connected') : t('aa.status.unchecked');
  return (
    <div className="aa-statusline small">
      <Badge tone={tone} label={label} />
      <span className="muted">{t('aa.poweredBy', { agent: status.agent.name })}</span>
    </div>
  );
}

export function AgentBanners({ status }: { status: AgentStatus | null }) {
  if (!status) return null;
  if (!status.configured) return <AiNotConfiguredBanner />;
  if (status.agent.imported === false) return <AgentNotImportedBanner agent={status.agent.name} />;
  return null;
}

// ---------------------------------------------------------------- chat

export function ChatPane({ b, scope, compact }: { b: Builder; scope?: BuilderScope; compact?: boolean }) {
  const { t, pick, lang } = useI18n();
  const { user, hasRole } = useSession();
  const canAsk = hasRole('TENANT_ADMIN');
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const p = b.proposal;
  const mine = Boolean(p && user && p.createdBy === user.id);
  const blocked = !canAsk || b.status?.configured === false || b.status?.agent.imported === false;
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [p?.messages.length, b.busy]);

  const chips = useMemo(() => {
    const own = CHIPS[scope ?? 'all'].map((k) => t(k));
    const other = translate(lang === 'ar' ? 'en' : 'ar', CHIPS[scope ?? 'all'][scope ? 0 : 1]);
    return [...own, other];
  }, [scope, lang, t]);

  const send = async (text: string) => {
    const m = text.trim();
    if (!m || b.busy || blocked) return;
    setInput('');
    try { await b.send(m, mine); } catch { setInput(m); }
    inputRef.current?.focus();
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const refining = p && p.status === 'PROPOSED' && mine;

  return (
    <section className={`aa-chat card ${compact ? 'is-compact' : ''}`} aria-label={t('aa.chat.title')}>
      <header className="aa-chat-head">
        <h2 className="card-title"><Sparkle /> {t('aa.chat.title')}</h2>
        {p && canAsk && <Button variant="ghost" onClick={b.reset} disabled={!!b.busy}>{t('aa.chat.new')}</Button>}
      </header>
      <div className="aa-msgs" ref={listRef} aria-live="polite">
        {!p && <p className="small muted aa-intro">{t('aa.chat.intro')}</p>}
        {p?.messages.map((m, i) => (m.role === 'admin' ? (
          <div key={i} className="aa-msg aa-msg-admin">
            <div className="aa-who small">{p.createdByName ?? t('aa.chat.you')}</div>
            <div className="aa-bubble" dir="auto">{m.text}</div>
          </div>
        ) : (
          <div key={i} className="aa-msg aa-msg-agent">
            <div className="aa-who small"><Sparkle size={12} /> {t('aa.chat.agent')}</div>
            <div className="aa-bubble">
              <p className="aa-reply">{pick(m.reply.en, m.reply.ar)}</p>
              {m.questions.length > 0 && (
                <div className="aa-questions">
                  <div className="small"><strong>{t('aa.chat.questions')}</strong></div>
                  <ul>{m.questions.map((q, j) => <li key={j}>{pick(q.en, q.ar)}</li>)}</ul>
                </div>
              )}
              <div className="aa-meta small">{m.operations ? t('aa.chat.ops', { n: m.operations }) : t('aa.chat.noOps')}</div>
            </div>
          </div>
        )))}
        {b.busy === 'send' && <div className="aa-msg aa-msg-agent"><div className="aa-bubble"><Spinner label={t('aa.chat.thinking')} /></div></div>}
      </div>
      {p && canAsk && <div className="aa-chat-state small muted">{refining ? t('aa.chat.refining') : p.status !== 'PROPOSED' ? t('aa.chat.closed', { status: t(`aa.st.${p.status}` as TKey) }) : null}</div>}
      {canAsk && (
        <>
          <div className="aa-chips" aria-label={t('aa.chat.suggestions')}>
            {chips.map((c) => <button key={c} type="button" className="aa-chip" dir="auto" disabled={!!b.busy || blocked} onClick={() => void send(c)}>{c}</button>)}
          </div>
          <form className="aa-form" onSubmit={onSubmit}>
            <textarea ref={inputRef} rows={compact ? 2 : 3} dir="auto" value={input} maxLength={2000} disabled={blocked}
              placeholder={t('aa.chat.placeholder')} aria-label={t('aa.chat.placeholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
            <Button type="submit" busy={b.busy === 'send'} disabled={!input.trim() || blocked}>{t('aa.chat.send')}</Button>
          </form>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- proposal

function show(v: unknown, pick: (en?: string | null, ar?: string | null) => string, none: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">{none}</span>;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return <span dir="auto">{String(v)}</span>;
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return <span>{v.length ? v.join(', ') : none}</span>;
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && 'role' in x && !('type' in x))) {
    return <span>{(v as { role: string; labelEn?: string; labelAr?: string }[]).map((l) => pick(l.labelEn, l.labelAr) || l.role).join(' → ')}</span>;
  }
  return <pre className="aa-json" dir="ltr">{JSON.stringify(v, null, 1)}</pre>;
}

function targetText(r: OpResult, t: (k: TKey, v?: Record<string, string | number>) => string, pick: (e?: string | null, a?: string | null) => string) {
  if (!r.target) return null;
  const what = t(`aa.tgt.${r.target.type}` as TKey, { code: r.target.code, label: pick(r.target.label.en, r.target.label.ar) });
  return `${what} · ${t(`aa.tgt.${r.target.action}` as TKey, { v: r.target.draftVersion ?? '' })}`;
}

export function OpCard({ r, n }: { r: OpResult; n: number }) {
  const { t, te, pick } = useI18n();
  const ok = r.status === 'ok';
  return (
    <li className={`aa-op ${ok ? 'is-ok' : 'is-error'}`}>
      <div className="aa-op-head">
        <span className="aa-op-n" aria-hidden="true">{n}</span>
        <strong className="aa-op-kind">{t(`aa.op.${r.op}` as TKey)}</strong>
        {r.target && <span className="aa-target small">{targetText(r, t, pick)}</span>}
        <Badge tone={ok ? 'success' : 'danger'} label={ok ? `✓ ${t('aa.op.ok')}` : `✕ ${t('aa.op.error')}`} />
      </div>
      <p className="aa-op-sentence" dir="auto">{pick(r.summary.en, r.summary.ar)}</p>
      {r.errors.length > 0 && <ul className="aa-reasons is-error">{r.errors.map((e, i) => <li key={i} dir="auto">{pick(e.en, e.ar)}</li>)}</ul>}
      {r.warnings.length > 0 && <ul className="aa-reasons is-warn">{r.warnings.map((e, i) => <li key={i} dir="auto">{pick(e.en, e.ar)}</li>)}</ul>}
      {r.diff.length > 0 && (
        <details className="aa-diff">
          <summary>{t('aa.op.changes', { n: r.diff.length })}</summary>
          <div className="table-wrap">
            <table className="table aa-diff-table">
              <thead><tr><th scope="col">{t('aa.op.path')}</th><th scope="col">{t('aa.op.before')}</th><th scope="col">{t('aa.op.after')}</th></tr></thead>
              <tbody>
                {r.diff.map((d, i) => (
                  <tr key={i}>
                    <th scope="row">
                      {te('aa.path.', d.path) !== d.path && <span className="aa-path-label">{te('aa.path.', d.path)}</span>}
                      <code dir="ltr">{d.path}</code>
                    </th>
                    <td className="aa-before">{show(d.before, pick, t('aa.op.none'))}</td>
                    <td className="aa-after">{show(d.after, pick, t('aa.op.none'))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </li>
  );
}

function refText(r: AppliedRef, t: (k: TKey, v?: Record<string, string | number>) => string, pick: (e?: string | null, a?: string | null) => string) {
  const name = pick(r.label.en, r.label.ar);
  const what = `${name.charAt(0).toUpperCase()}${name.slice(1)} (${r.code})`;
  if (r.status === 'INACTIVE') return t('aa.p.inactiveCreated', { what });
  return t(r.action === 'UPDATED' ? 'aa.p.draftUpdated' : 'aa.p.draftCreated', { what, v: r.version ?? '' });
}
const REF_OPEN: Record<AppliedRef['type'], TKey> = { TEMPLATE: 'aa.p.openCycle', FORM: 'aa.p.openStudio', RULESET: 'aa.p.openStudio', DOCUMENT_TYPE: 'aa.p.openDocTypes' };

export function ProposalPane({ b, compact, onNavigate, onApplied }: { b: Builder; compact?: boolean; onNavigate?: () => void; onApplied?: (refs: AppliedRef[]) => void }) {
  const { t, pick, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const canApply = hasRole('TENANT_ADMIN');
  const p = b.proposal;
  const v = p?.validation;
  const results = v?.results ?? [];
  const errCode = b.error instanceof ApiError ? b.error.code : null;
  const knownErr = errCode && ['PROPOSAL_INVALID', 'PROPOSAL_ALREADY_APPLIED', 'PROPOSAL_NOT_OPEN'].includes(errCode);

  const apply = async () => {
    const out = await b.apply();
    if (out) { toast(t('aa.p.applied'), 'success'); onApplied?.(out.appliedRefs ?? []); }
  };
  const discard = async () => {
    if (!window.confirm(t('aa.p.discardConfirm'))) return;
    await b.discard();
    toast(t('aa.p.discarded'), 'info');
  };

  return (
    <section className={`aa-proposal card ${compact ? 'is-compact' : ''}`} aria-label={t('aa.p.title')}>
      <header className="aa-p-head">
        <h2 className="card-title">{t('aa.p.title')}</h2>
        {p && (
          <div className="row wrap aa-p-badges">
            <Badge tone={p.status === 'APPLIED' ? 'success' : p.status === 'PROPOSED' ? 'info' : p.status === 'FAILED' ? 'danger' : 'neutral'} label={t(`aa.st.${p.status}` as TKey)} />
            {p.status === 'PROPOSED' && <Badge tone={v?.valid ? 'success' : results.length ? 'danger' : 'neutral'} label={v?.valid ? t('aa.p.valid') : results.length ? t('aa.p.invalid') : t('aa.p.noOps')} />}
            {p.revision > 1 && <span className="small muted">{t('aa.p.revision', { n: p.revision })}</span>}
          </div>
        )}
      </header>
      {b.busy === 'load' && <Spinner />}
      {!p && b.busy !== 'load' && <p className="muted aa-p-empty">{t('aa.p.empty')}</p>}
      {p && (
        <>
          <div className="aa-p-meta small muted">
            <span>{t(`aa.p.source.${p.source}` as TKey)}</span>
            <span>·</span>
            <span>{fmtDate(p.updatedAt)}</span>
          </div>
          {p.reply && <p className="aa-p-reply" dir="auto">{pick(p.reply.en, p.reply.ar)}</p>}
          {p.source === 'TOOL' && <p className="small"><strong>{t('aa.p.request')}:</strong> <span dir="auto">{p.requestText}</span></p>}
          {knownErr && <div className="alert alert-danger" role="alert"><div>{t(`aa.err.${errCode}` as TKey)}</div></div>}
          {b.error && !knownErr ? <ErrorBox error={b.error} /> : null}
          {results.length > 0 && <ol className="aa-ops">{results.map((r, i) => <OpCard key={r.index} r={r} n={i + 1} />)}</ol>}
          {(v?.errors.length ?? 0) > 0 && (
            <div className="alert alert-danger" role="alert"><div><strong>{t('aa.p.errors')}</strong><ul className="alert-list">{v!.errors.map((e, i) => <li key={i}>{pick(e.en, e.ar)}</li>)}</ul></div></div>
          )}
          {(v?.notes.length ?? 0) > 0 && p.status === 'PROPOSED' && (
            <div className="aa-notes small"><strong>{t('aa.p.notes')}</strong><ul>{v!.notes.map((e, i) => <li key={i}>{pick(e.en, e.ar)}</li>)}</ul></div>
          )}
          {p.status === 'PROPOSED' && canApply && results.length > 0 && (
            <div className="aa-actions">
              <div className="row wrap">
                <Button busy={b.busy === 'apply'} disabled={!v?.valid || !!b.busy} disabledReason={!v?.valid ? t('aa.p.applyDisabled') : undefined} onClick={() => void apply()}>
                  {t('aa.p.apply')}
                </Button>
                <Button variant="secondary" busy={b.busy === 'discard'} disabled={!!b.busy} onClick={() => void discard()}>{t('aa.p.discard')}</Button>
              </div>
              <div className="small muted">{t('aa.p.applyHint')}</div>
            </div>
          )}
          {p.status === 'PROPOSED' && canApply && results.length === 0 && (
            <div className="aa-actions"><Button variant="secondary" busy={b.busy === 'discard'} onClick={() => void discard()}>{t('aa.p.discard')}</Button></div>
          )}
          {p.status === 'APPLIED' && p.appliedRefs && (
            <div className="aa-applied">
              <div className="alert alert-success" role="status"><div>{t('aa.p.applied')}</div></div>
              <h3>{t('aa.p.created')}</h3>
              <ul className="aa-refs">
                {p.appliedRefs.map((r) => (
                  <li key={r.id}>
                    <span dir="auto">{refText(r, t, pick)}</span>
                    {/* Cycle Designer and Document types are administrator pages; auditors read the drafts in Process Studio / audit log. */}
                    {(canApply || r.type === 'FORM' || r.type === 'RULESET') && (
                      <Link className="btn btn-secondary aa-open" to={r.link} onClick={onNavigate}>{r.type === 'TEMPLATE' ? t('aa.p.open') : t(REF_OPEN[r.type])}</Link>
                    )}
                  </li>
                ))}
              </ul>
              {p.appliedAt && <div className="small muted">{t('aa.p.appliedBy', { name: p.appliedByName ?? '—', date: fmtDate(p.appliedAt) })}</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- history

export function HistoryList({ b, currentId, onPick }: { b: Builder; currentId: string | null; onPick: (id: string) => void }) {
  const { t, pick, fmtDate } = useI18n();
  const [items, setItems] = useState<ProposalSummary[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    adminAgent.list().then((x) => alive && setItems(x)).catch((e) => alive && setErr(e));
    return () => { alive = false; };
  }, [b.historyTick]);
  return (
    <section className="card aa-history" aria-label={t('aa.hist.title')}>
      <header className="card-head"><h2 className="card-title">{t('aa.hist.title')}</h2></header>
      <div className="card-body">
        {err ? <ErrorBox error={err} /> : items === null ? <Spinner /> : items.length === 0 ? <p className="muted">{t('aa.hist.empty')}</p> : (
          <ul className="aa-hist">
            {items.map((x) => (
              <li key={x.id} className={x.id === currentId ? 'is-current' : ''}>
                <button type="button" className="aa-hist-btn" onClick={() => onPick(x.id)} aria-current={x.id === currentId ? 'true' : undefined}>
                  <span className="aa-hist-req" dir="auto">{x.requestText}</span>
                  <span className="aa-hist-meta small muted">
                    <Badge tone={x.status === 'APPLIED' ? 'success' : x.status === 'PROPOSED' ? (x.valid ? 'info' : 'warn') : 'neutral'} label={t(`aa.st.${x.status}` as TKey)} />
                    <span>{t('aa.hist.ops', { n: x.operations })}</span>
                    {x.createdByName && <span>{t('aa.hist.by', { name: x.createdByName })}</span>}
                    <span>{fmtDate(x.updatedAt)}</span>
                  </span>
                  {x.reply && <span className="aa-hist-reply small" dir="auto">{pick(x.reply.en, x.reply.ar)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export type { Bilingual };
