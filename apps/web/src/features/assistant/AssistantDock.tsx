// Floating TenderFlow Assistant (supervisor agent tenderflow_assistant on watsonx Orchestrate) on every signed-in page.
// The server builds the role-scoped context; this panel only sends the question, the current page and — on a tender
// page — the tender id from the URL. Not configured → a clear banner and no reply (nothing is simulated).
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { agentNameOf, ApiError, isAgentNotImported, isAiNotConfigured, type Citation } from '../../api';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { Citations } from '../../components/shared';
import { Button, ErrorBox, Spinner } from '../../components/ui';
import { assistantApi, type ChatReply, type Task } from './api-assistant';
import { AiInsightsCard } from './AiInsights';

type Msg =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'bot'; reply: ChatReply }
  | { id: number; role: 'notice'; text: string }
  | { id: number; role: 'local'; kind: 'tasks' | 'other'; tasks: Task[] };

/** Questions that the TenderFlow task list answers without AI ("what is waiting for me?"). */
const TASK_QUESTION = /(waiting|pending|to.?do|my tasks|what (do|should) i|ينتظر|المطلوب مني|مهامي|مهام)/i;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TENDER_PATH = new RegExp(`^/(?:procurement|vendor)/tenders/(${UUID})(?:/|$)`, 'i');

function Sparkle({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 2l1.8 5.4L19 9.2l-5.2 1.8L12 16.4l-1.8-5.4L5 9.2l5.2-1.8L12 2zM19 14l.9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14zM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15z" />
    </svg>
  );
}

function TaskList({ tasks, onNavigate }: { tasks: Task[]; onNavigate: () => void }) {
  const { t, pick, fmtDate } = useI18n();
  if (!tasks.length) return <p className="muted">{t('assistant.tasks.none')}</p>;
  return (
    <>
      <p className="small muted">{t('assistant.tasks.count', { n: tasks.length })}</p>
      <ul className="ast-tasks">
        {tasks.map((x, i) => (
          <li key={i}>
            <Link to={x.link} onClick={onNavigate}>
              {pick(x.titleEn, x.titleAr)}
            </Link>
            {x.dueAt && <div className="small muted">{t('assistant.tasks.due', { date: fmtDate(x.dueAt) })}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

export function AssistantDock() {
  const { user, hasRole } = useSession();
  const { t, lang } = useI18n();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'chat' | 'tasks' | 'insights'>('chat');
  const [configured, setConfigured] = useState<boolean | null>(null);
  /** Name of the supervisor agent when Orchestrate is connected but that agent is not imported on the instance. */
  const [missingAgent, setMissingAgent] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [tasksErr, setTasksErr] = useState<unknown>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tenderId = TENDER_PATH.exec(location.pathname)?.[1] ?? null;
  const canInsights = hasRole('TENANT_ADMIN', 'AUDITOR');

  // A different user (sign-out / sign-in) never sees the previous conversation.
  useEffect(() => {
    setMsgs([]); setThreadId(null); setTasks(null); setConfigured(null); setMissingAgent(null); setOpen(false); setTab('chat');
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    assistantApi.status().then((s) => {
      if (!alive) return;
      setConfigured(s.configured);
      const sup = s.agents?.checked ? s.agents.missing.find((m) => m.role === 'assistant') : undefined;
      setMissingAgent(sup ? sup.name : null);
    }).catch(() => alive && setConfigured(null));
    setTasksErr(null);
    assistantApi.myTasks().then((x) => alive && setTasks(x)).catch((e) => alive && setTasksErr(e));
    return () => { alive = false; };
  }, [open, user?.id, location.pathname]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, busy]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const chips = useMemo(() => {
    const k: TKey[] = ['assistant.s.waiting'];
    if (lang === 'en') k.push('assistant.s.waitingAr');
    if (tenderId) k.push('assistant.s.summarise', 'assistant.s.nextStep');
    if (hasRole('VENDOR')) k.push('assistant.s.closingSoon');
    if (hasRole('PROCUREMENT_OFFICER')) k.push('assistant.s.clarifications');
    if (hasRole('COMMITTEE_CHAIR')) k.push('assistant.s.opening');
    if (hasRole('TENANT_ADMIN', 'AUDITOR', 'DIRECTOR', 'UNDERSECRETARY')) k.push('assistant.s.rules');
    if (!tenderId) k.push('assistant.s.sealed');
    return [...new Set(k.map((x) => t(x)))];
  }, [lang, tenderId, hasRole, t]);

  if (!user || location.pathname === '/login' || location.pathname === '/register') return null;

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setErr(null);
    setInput('');
    setMsgs((m) => [...m, { id: ++seq.current, role: 'user', text: message }]);
    // The supervisor agent is not on the instance: answer task questions from TenderFlow's own task list (no AI).
    const answerLocally = async () => {
      let list = tasks;
      if (!list) { try { list = await assistantApi.myTasks(); setTasks(list); } catch { list = []; } }
      const kind = TASK_QUESTION.test(message) ? 'tasks' : 'other';
      setMsgs((m) => [...m, { id: ++seq.current, role: 'local', kind, tasks: list ?? [] }]);
    };
    if (missingAgent) { await answerLocally(); inputRef.current?.focus(); return; }
    setBusy(true);
    try {
      let reply: ChatReply;
      try {
        reply = await assistantApi.chat({ message, threadId, page: location.pathname, tenderId });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'THREAD_NOT_FOUND')) throw e;
        setMsgs((m) => [...m, { id: ++seq.current, role: 'notice', text: t('assistant.threadLost') }]);
        setThreadId(null);
        reply = await assistantApi.chat({ message, page: location.pathname, tenderId });
      }
      setConfigured(true);
      setThreadId(reply.threadId);
      setMsgs((m) => [...m, { id: ++seq.current, role: 'bot', reply }]);
    } catch (e) {
      if (isAiNotConfigured(e)) setConfigured(false);
      else if (isAgentNotImported(e)) { setMissingAgent(agentNameOf(e)); await answerLocally(); }
      else setErr(e);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const reset = () => { setMsgs([]); setThreadId(null); setErr(null); };
  const notConfigured = configured === false;

  return (
    <div className="ast-dock no-print">
      {open && (
        <section className="ast-panel" role="dialog" aria-modal="false" aria-labelledby="ast-title">
          <header className="ast-head">
            <span className="ast-logo" aria-hidden="true"><Sparkle /></span>
            <div className="ast-head-text">
              <h2 id="ast-title">{t('assistant.title')}</h2>
              <div className="ast-powered">{t('assistant.poweredBy')}</div>
            </div>
            <button type="button" className="ast-icon-btn" onClick={reset} title={t('assistant.newChat')} aria-label={t('assistant.newChat')}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            <button type="button" className="ast-icon-btn" onClick={() => setOpen(false)} title={t('assistant.close')} aria-label={t('assistant.close')}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          <div className="ast-tabs" role="tablist">
            {(['chat', 'tasks', ...(canInsights ? ['insights'] : [])] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`ast-tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k as typeof tab)}>
                {t(`assistant.tab.${k}` as TKey)}
                {k === 'tasks' && tasks && tasks.length > 0 && <span className="ast-count">{tasks.length}</span>}
              </button>
            ))}
          </div>

          {tab === 'chat' && (
            <>
              <div className="ast-body" ref={listRef} aria-live="polite">
                {!notConfigured && missingAgent && (
                  <div className="alert alert-warn ast-banner" role="status">
                    <div>
                      <strong>{t('assistant.notImported')}</strong>
                      <div className="small">{t('assistant.notImportedDetail', { agent: missingAgent })}</div>
                    </div>
                  </div>
                )}
                {notConfigured && (
                  <div className="alert alert-info ast-banner" role="status">
                    <div>
                      <strong>{t('assistant.notConfigured')}</strong>
                      <div className="small">{t('assistant.notConfiguredDetail')}</div>
                    </div>
                  </div>
                )}
                {hasRole('TENANT_ADMIN') && (
                  <Link to="/admin/builder" className="aa-dock-link" onClick={() => setOpen(false)}>
                    <Sparkle size={16} />
                    <span><strong>{t('aa.dock.link')}</strong><br />{t('aa.dock.hint')}</span>
                  </Link>
                )}
                <div className="ast-context small">{tenderId ? t('assistant.contextTender') : t('assistant.contextGeneral')}</div>
                {msgs.length === 0 && <p className="small muted">{t('assistant.intro')}</p>}
                {msgs.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="ast-msg ast-user"><div className="ast-bubble" dir="auto">{m.text}</div></div>
                  ) : m.role === 'notice' ? (
                    <div key={m.id} className="ast-note small">{m.text}</div>
                  ) : m.role === 'local' ? (
                    <div key={m.id} className="ast-msg ast-bot">
                      <div className="ast-bubble ast-local">
                        <div className="ast-local-tag small">{t('assistant.local.label')}</div>
                        {m.kind === 'tasks' ? (
                          <>
                            <p className="small">{t('assistant.local.tasksIntro')}</p>
                            <TaskList tasks={m.tasks} onNavigate={() => setOpen(false)} />
                          </>
                        ) : (
                          <>
                            <p className="small">{t('assistant.local.other')}</p>
                            <Button variant="secondary" onClick={() => setTab('tasks')}>{t('assistant.local.openTasks')}</Button>
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <BotMessage key={m.id} reply={m.reply} />
                  ),
                )}
                {busy && <div className="ast-msg ast-bot"><div className="ast-bubble"><Spinner label={t('assistant.thinking')} /></div></div>}
                {err ? <ErrorBox error={err} /> : null}
              </div>
              <div className="ast-chips" aria-label={t('assistant.suggestions')}>
                {chips.map((c) => (
                  <button key={c} type="button" className="ast-chip" dir="auto" disabled={busy || notConfigured} onClick={() => void send(c)}>{c}</button>
                ))}
              </div>
              <form className="ast-form" onSubmit={onSubmit}>
                <textarea
                  ref={inputRef}
                  rows={2}
                  dir="auto"
                  value={input}
                  maxLength={2000}
                  placeholder={t('assistant.placeholder')}
                  aria-label={t('assistant.placeholder')}
                  disabled={notConfigured}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
                />
                <Button type="submit" busy={busy} disabled={!input.trim() || notConfigured}>{t('assistant.send')}</Button>
              </form>
              <div className="ast-foot small muted">{t('assistant.advisory')}</div>
            </>
          )}

          {tab === 'tasks' && (
            <div className="ast-body">
              <p className="small muted">{t('assistant.tasks.source')}</p>
              {tasksErr ? <ErrorBox error={tasksErr} /> : tasks === null ? <Spinner /> : <TaskList tasks={tasks} onNavigate={() => setOpen(false)} />}
            </div>
          )}

          {tab === 'insights' && canInsights && (
            <div className="ast-body"><AiInsightsCard compact /></div>
          )}
        </section>
      )}
      <button type="button" className={`ast-fab ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={t('assistant.open')}>
        <Sparkle size={20} />
        <span>{t('assistant.fab')}</span>
        {!open && tasks && tasks.length > 0 && <span className="ast-count">{tasks.length}</span>}
      </button>
    </div>
  );
}

function BotMessage({ reply }: { reply: ChatReply }) {
  const { t } = useI18n();
  const cites: Citation[] = reply.citations ?? [];
  return (
    <div className="ast-msg ast-bot">
      <div className="ast-bubble">
        <div className="ast-answer" dir="auto">{reply.answer}</div>
        {reply.notFound && <div className="ast-flag small">{t('assistant.notFound')}</div>}
        {!reply.structured && <div className="ast-flag small">{t('assistant.plainText')}</div>}
        {cites.length > 0 && <Citations items={cites} />}
        <div className="ast-meta">
          {t('assistant.runFooter', { agent: reply.agent ?? '—', model: reply.model ?? '—', run: reply.runId.slice(0, 8) })}
        </div>
      </div>
    </div>
  );
}
