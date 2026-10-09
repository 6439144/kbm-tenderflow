// Presenter panel: docked (not modal), collapsible, RTL-aware. Runs the Demo Story chapters with persona
// switching, navigation, spotlight, the deadline demo control and IBM callouts backed by live evidence.
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearSession, saveSession, type Role } from '../../api';
import { translate, useI18n, type Lang } from '../../i18n';
import { useSession } from '../../session';
import { errText } from '../../components/ui';
import { demoApi, type DemoIntegrations, type DemoStatus, type EvidenceEvent, type ExpireResult } from './api';
import { refreshDemoStatus, setDemo, useDemoState } from './state';
import { ENTITY_NAME, TRACK_HINT, TRACK_LABEL, TRACKS, type Chapter, type DK, type EntityId, type Move, type Target } from './story';
import { tourFor } from './tours';

const EVIDENCE_POLL_MS = 10_000;
const STATUS_POLL_MS = 30_000;
const EXPIRE_KEY = 'tf.demo.lastExpire';

const isStaffRoles = (roles: Role[]) => roles.some((r) => r !== 'VENDOR');

type T = ReturnType<typeof useI18n>['t'];

async function getWithToken(path: string, token: string): Promise<any[]> {
  const res = await fetch(`/api/v1${path}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
}

/** Resolve a chapter target to a route, with the token of the persona that will open it. */
async function resolveTarget(target: Target, roles: Role[], token: string, persona: string, t: T): Promise<string> {
  if (target.kind === 'path') return target.path;
  if (target.kind === 'request') {
    try {
      const list = await getWithToken('/requests', token);
      const hit = list.find((r) => (r.requestNumber ?? r.request_number) === target.number);
      if (hit) return `/procurement/requests/${hit.id}`;
    } catch {
      /* requests list unavailable: open the list page */
    }
    return '/procurement/requests';
  }
  const vendor = roles.includes('VENDOR') && !isStaffRoles(roles);
  const list = await getWithToken('/tenders', token);
  const hit = list.find((x) =>
    target.number ? (x.tenderNumber ?? x.tender_number) === target.number : (x.titleEn ?? x.title_en) === target.titleEn,
  );
  const what = target.number ?? target.titleEn ?? '';
  if (!hit) throw new Error(vendor ? t('demo.err.notVisible', { what, user: persona }) : t('demo.err.notFound', { what }));
  return vendor ? `/vendor/tenders/${hit.id}` : `/procurement/tenders/${hit.id}`;
}

function ago(iso: string, lang: Lang): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  if (s < 60) return rtf.format(-Math.round(s), 'second');
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

const shortRef = (ref: string) => (ref.length > 44 ? `${ref.slice(0, 26)}…${ref.slice(-14)}` : ref);

function matchEvidence(ch: Chapter, kind: 'filenet' | 'orchestrate', events: EvidenceEvent[] | null): EvidenceEvent[] {
  const ev = ch.evidence;
  if (!ev || !events) return [];
  const m = events.filter((e) =>
    kind === 'filenet'
      ? e.integration === 'filenet' && ((ev.actions ?? []).includes(e.action) || (ev.ownerTypes ?? []).includes(e.store?.ownerType ?? ''))
      : e.integration === 'orchestrate' && (ev.aiKinds ?? []).includes(e.ai?.kind ?? ''),
  );
  const own = ev.tender ? m.filter((e) => e.tenderNumber === ev.tender) : [];
  return (own.length ? own : m).slice(0, 3);
}

function liveState(kind: 'filenet' | 'orchestrate', integ: DemoIntegrations | undefined, t: T): { tone: 'ok' | 'down' | 'off' | 'wait'; text: string } {
  if (!integ) return { tone: 'wait', text: t('demo.live.checking') };
  if (kind === 'filenet') {
    const c = integ.contentStore;
    if (c.type !== 'filenet') return { tone: 'off', text: t('demo.live.filenetOff') };
    return c.ok ? { tone: 'ok', text: t('demo.live.filenetOk', { detail: c.detail }) } : { tone: 'down', text: t('demo.live.filenetDown', { detail: c.detail }) };
  }
  const a = integ.ai;
  if (!a.configured) return { tone: 'off', text: t('demo.live.aiOff') };
  return a.ok ? { tone: 'ok', text: t('demo.live.aiOk', { detail: a.detail }) } : { tone: 'down', text: t('demo.live.aiDown', { detail: a.detail }) };
}

function EvidenceLine({ e }: { e: EvidenceEvent }) {
  const { t, lang } = useI18n();
  const parts: ReactNode[] = [];
  if (e.integration === 'orchestrate') {
    if (e.action === 'AI_ADVISORY_FAILED') parts.push(t('demo.ev.aiFailed', { error: e.ai?.error ?? '—' }));
    else {
      if (e.action === 'AI_ADVISORY_REVIEWED') parts.push(t('demo.ev.aiReviewed'));
      parts.push(t('demo.ev.aiRun', { agent: e.ai?.agent ?? t('demo.ev.unknownAgent') }));
      if (e.ai?.model) parts.push(t('demo.ev.aiModel', { model: e.ai.model }));
      if (e.action === 'AI_ADVISORY_GENERATED') parts.push(t('demo.ev.aiCitations', { n: e.ai?.citations ?? 0 }));
    }
  } else if (e.action === 'RECORDS_DECLARED') {
    parts.push(t('demo.ev.records', { n: e.store?.declared ?? 0, ok: e.store?.repositoryDeclared ?? 0, failed: e.store?.repositoryFailed ?? 0 }));
  } else if (e.store) {
    parts.push(e.store.type === 'filenet' ? t('demo.ev.storedFileNet') : t('demo.ev.storedFs'));
    if (e.store.ref) parts.push(<code key="ref" dir="ltr">{shortRef(e.store.ref)}</code>);
    if (e.store.encrypted) parts.push(t('demo.ev.encrypted'));
    if (e.store.versionNo && e.store.versionNo > 1) parts.push(t('demo.ev.version', { n: e.store.versionNo }));
    if (e.store.isRecord) parts.push(t('demo.ev.record'));
  }
  return (
    <li className={`demo-ev-item ${e.action === 'AI_ADVISORY_FAILED' ? 'demo-ev-failed' : ''}`}>
      <div className="demo-ev-main">
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {p}
          </span>
        ))}
      </div>
      <div className="demo-ev-meta">
        <code dir="ltr">{e.action}</code>
        {e.tenderNumber && <span dir="ltr"> · {e.tenderNumber}</span>}
        <span> · {ago(e.at, lang)}</span>
      </div>
    </li>
  );
}

function IbmCallout({ kind, text, integ, events, staff }: {
  kind: 'filenet' | 'orchestrate';
  text: string;
  integ: DemoIntegrations | undefined;
  events: EvidenceEvent[];
  staff: boolean;
}) {
  const { t } = useI18n();
  const live = liveState(kind, integ, t);
  return (
    <section className={`demo-ibm demo-ibm-${kind}`} aria-label={t(kind === 'filenet' ? 'demo.ibm.filenet' : 'demo.ibm.orchestrate')}>
      <header className="demo-ibm-head">
        <span className="demo-ibm-mark" aria-hidden="true">
          IBM
        </span>
        <strong>{t(kind === 'filenet' ? 'demo.ibm.filenet' : 'demo.ibm.orchestrate')}</strong>
      </header>
      <p className="demo-ibm-text">{text}</p>
      <div className={`demo-live demo-live-${live.tone}`} role="status">
        <span className="demo-dot" aria-hidden="true" />
        <span>{live.text}</span>
      </div>
      <div className="demo-ev">
        <div className="demo-ev-title">{t('demo.ev.title')}</div>
        {!staff ? (
          <p className="demo-ev-none">{t('demo.ev.staffOnly')}</p>
        ) : events.length ? (
          <ul className="demo-ev-list">
            {events.map((e) => (
              <EvidenceLine key={e.seq} e={e} />
            ))}
          </ul>
        ) : (
          <p className="demo-ev-none">{t('demo.ev.none')}</p>
        )}
      </div>
    </section>
  );
}

function DemoControl({ tender, staff }: { tender: string; staff: boolean }) {
  const { t, te, fmtDate } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The result survives the page reload below (the tender screen must re-read the CLOSED tender).
  const [result, setResult] = useState<ExpireResult | null>(() => {
    try {
      const r = JSON.parse(sessionStorage.getItem(EXPIRE_KEY) ?? 'null') as ExpireResult | null;
      return r && r.tenderNumber === tender ? r : null;
    } catch {
      return null;
    }
  });
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const hit = (await api.tenders()).find((x) => x.tenderNumber === tender);
      if (!hit) throw new Error(t('demo.err.notFound', { what: tender }));
      const res = await demoApi.expireDeadline(hit.id);
      setResult(res);
      setConfirm(false);
      try {
        sessionStorage.setItem(EXPIRE_KEY, JSON.stringify(res));
      } catch {
        /* storage unavailable: the result stays visible until the reload */
      }
      const path = `/procurement/tenders/${hit.id}`;
      setDemo({ spot: { path, selectors: ['main .page-head', 'main h1'], nonce: Date.now() } });
      // Full reload so every panel of the tender screen shows the real CLOSED state from the server.
      window.location.assign(path);
    } catch (e) {
      setErr(errText(e));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="demo-control" className="demo-control" aria-labelledby="demo-control-h">
      <h3 id="demo-control-h">
        <span className="demo-tag">{t('demo.control.title')}</span>
      </h3>
      <p className="small">{t('demo.control.help')}</p>
      {!staff ? (
        <p className="small demo-warn">{t('demo.control.needsStaff')}</p>
      ) : confirm ? (
        <div className="demo-row">
          <button type="button" className="btn btn-danger" onClick={run} disabled={busy} aria-busy={busy || undefined}>
            {t('demo.control.confirm', { tender })}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)} disabled={busy}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => setConfirm(true)}>
          {t('demo.control.expire', { tender })}
        </button>
      )}
      {result && (
        <div className="alert alert-success small" role="status">
          {t('demo.control.done', { tender: result.tenderNumber, status: te('st.', result.status), orig: fmtDate(result.originalDeadline) })}
        </div>
      )}
      {err && (
        <div className="alert alert-danger small" role="alert">
          {err}
        </div>
      )}
    </section>
  );
}

function StatusFooter({ status }: { status: DemoStatus }) {
  const { t } = useI18n();
  const c = status.integrations.contentStore;
  const a = status.integrations.ai;
  const store = c.type === 'filenet' ? (c.ok ? ['ok', t('demo.status.filenetOk')] : ['down', t('demo.status.filenetDown')]) : ['off', t('demo.status.filesystem')];
  const ai = a.configured ? (a.ok ? ['ok', t('demo.status.aiOk')] : ['down', t('demo.status.aiDown')]) : ['off', t('demo.status.aiOff')];
  return (
    <div className="demo-status">
      <div className="demo-status-title">{t('demo.status.title')}</div>
      <div className={`demo-live demo-live-${store[0]}`} title={c.detail}>
        <span className="demo-dot" aria-hidden="true" />
        <span>
          {t('demo.status.store')}: {store[1]}
        </span>
      </div>
      <div className={`demo-live demo-live-${ai[0]}`} title={a.detail}>
        <span className="demo-dot" aria-hidden="true" />
        <span>
          {t('demo.status.ai')}: {ai[1]}
        </span>
      </div>
      <details className="demo-reset">
        <summary>{t('demo.reset.title')}</summary>
        <p className="small">{t('demo.reset.body')}</p>
        <code className="demo-cmd" dir="ltr">
          {status.resetCommand}
        </code>
        <p className="small">{t('demo.reset.after')}</p>
      </details>
    </div>
  );
}

export function DemoPanel({ status }: { status: DemoStatus }) {
  const { t, te, lang } = useI18n();
  const { user, session } = useSession();
  const navigate = useNavigate();
  const st = useDemoState();
  const chapters = TRACKS[st.track];
  const idx = Math.min(Math.max(st.chapter[st.track] ?? 0, 0), chapters.length - 1);
  const ch = chapters[idx];
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [events, setEvents] = useState<EvidenceEvent[] | null>(null);
  const staff = Boolean(user && isStaffRoles(user.roles));
  const token = session?.token;

  useEffect(() => {
    if (!staff) {
      setEvents(null);
      return;
    }
    let alive = true;
    const load = () =>
      demoApi
        .evidence(60)
        .then((e) => alive && setEvents(e))
        .catch(() => {
          /* evidence is best-effort; the callout says when nothing matched */
        });
    void load();
    const iv = window.setInterval(load, EVIDENCE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [staff, token]);

  useEffect(() => {
    const iv = window.setInterval(() => void refreshDemoStatus(true), STATUS_POLL_MS);
    return () => window.clearInterval(iv);
  }, []);

  useEffect(() => setErr(null), [st.track, idx]);

  if (!user || !session) return null;
  const wrongEntity = ch.entity !== user.tenantId;
  const otherLang: Lang = lang === 'ar' ? 'en' : 'ar';
  const setChapter = (n: number) => setDemo((s) => ({ chapter: { ...s.chapter, [s.track]: n }, spot: null }));
  const setTrack = (tr: EntityId) => setDemo({ track: tr, spot: null });

  const go = async (m: Move, i: number) => {
    setBusy(i);
    setErr(null);
    try {
      const switching = user.username !== m.persona;
      let tok = session.token;
      let next = user;
      if (switching) {
        const res = await demoApi.persona(m.persona);
        tok = res.token;
        next = res.user;
      }
      const path = await resolveTarget(m.target, next.roles, tok, m.persona, t);
      setDemo({ spot: { path, selectors: m.spot, nonce: Date.now() } });
      if (switching) {
        // A fresh page load gives every screen (and the session context) the new persona's token.
        saveSession({ token: tok, user: next, tenant: session.tenant });
        window.location.assign(path);
        return;
      }
      navigate(path);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const signInOther = () => {
    clearSession();
    setDemo({ spot: null });
    const q = new URLSearchParams({ tenant: ch.entity, username: ch.moves[0]?.persona ?? '' });
    window.location.assign(`/login?${q.toString()}`);
  };

  if (st.collapsed) {
    return (
      <button type="button" className="demo-tab" onClick={() => setDemo({ collapsed: false })} aria-label={t('demo.expand')}>
        <span className="demo-tab-title">{t('demo.panelTitle')}</span>
        <span className="demo-tab-n" dir="ltr">
          {idx + 1}/{chapters.length}
        </span>
      </button>
    );
  }

  const evFor = (kind: 'filenet' | 'orchestrate') => (wrongEntity ? [] : matchEvidence(ch, kind, events));
  const myTour = tourFor(user.roles);

  return (
    <aside className="demo-panel" aria-label={t('demo.panelLabel')}>
      <header className="demo-head">
        <div className="demo-head-text">
          <div className="demo-title">{t('demo.panelTitle')}</div>
          <div className="demo-subtitle">{t('demo.panelSubtitle')}</div>
        </div>
        <button type="button" className="demo-icon-btn" onClick={() => setDemo({ collapsed: true })} aria-label={t('demo.collapse')} title={t('demo.collapse')}>
          <span aria-hidden="true">–</span>
        </button>
        <button type="button" className="demo-icon-btn" onClick={() => setDemo({ open: false, spot: null })} aria-label={t('demo.close')} title={t('demo.close')}>
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="demo-tracks" role="group" aria-label={t('demo.chapters')}>
        {(Object.keys(TRACKS) as EntityId[]).map((tr) => (
          <button key={tr} type="button" className={`demo-track ${st.track === tr ? 'on' : ''}`} aria-pressed={st.track === tr} onClick={() => setTrack(tr)}>
            {t(TRACK_LABEL[tr])}
          </button>
        ))}
      </div>
      <p className="demo-track-hint">{t(TRACK_HINT[st.track])}</p>

      <nav className="demo-steps" aria-label={t('demo.chapters')}>
        {chapters.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={`demo-step ${i === idx ? 'on' : ''} ${c.filenet || c.orch ? 'ibm' : ''}`}
            aria-current={i === idx ? 'step' : undefined}
            title={t(c.title)}
            onClick={() => setChapter(i)}
          >
            {i + 1}
          </button>
        ))}
      </nav>

      <div className="demo-body">
        <div className="demo-chapter-meta">{t('demo.chapterOf', { n: idx + 1, total: chapters.length })}</div>
        <h2 className="demo-chapter-title">{t(ch.title)}</h2>
        <p className="demo-why">{t(ch.why)}</p>

        <div className="demo-whoami small">{t('demo.youAre', { user: `${user.username}@${user.tenantId}`, roles: user.roles.map((r) => te('role.', r)).join(', ') })}</div>

        {wrongEntity ? (
          <div className="demo-other" role="note">
            <strong>{t('demo.otherEntity.title')}</strong>
            <p className="small">{t('demo.otherEntity.body', { entity: t(ENTITY_NAME[ch.entity]) })}</p>
            <button type="button" className="btn btn-primary" onClick={signInOther}>
              {t('demo.otherEntity.button', { entity: t(ENTITY_NAME[ch.entity]) })}
            </button>
          </div>
        ) : (
          <div className="demo-moves">
            {ch.moves.map((m, i) => (
              <div key={i} className="demo-move">
                <div className="demo-move-text">
                  {m.label ? <span>{t(m.label)}</span> : <span className="muted small">{t('demo.personaLabel')}</span>}
                  <span className="demo-persona" dir="ltr">
                    {m.persona}@{ch.entity}
                  </span>
                </div>
                <button type="button" className="btn btn-primary demo-go" onClick={() => go(m, i)} disabled={busy !== null} aria-busy={busy === i || undefined} title={t('demo.goHint')}>
                  {busy === i && <span className="spinner spinner-sm" aria-hidden="true" />}
                  {m.persona === user.username ? t('demo.go') : t('demo.goAs', { user: m.persona })}
                </button>
              </div>
            ))}
            <p className="demo-go-hint small muted">{t('demo.goHint')}</p>
          </div>
        )}
        {err && (
          <div className="alert alert-danger small" role="alert">
            {err}
          </div>
        )}
        {!wrongEntity && st.spot && (
          <button type="button" className="btn btn-ghost demo-link" onClick={() => setDemo((s) => ({ spot: s.spot ? { ...s.spot, nonce: Date.now() } : null }))}>
            {t('demo.highlightAgain')}
          </button>
        )}

        {ch.control && !wrongEntity && <DemoControl tender={ch.control.tender} staff={staff} />}

        <section className="demo-do">
          <h3>{t('demo.doTitle')}</h3>
          <ol>
            {ch.do.map((k: DK) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ol>
        </section>
        <section className="demo-say">
          <h3>{t('demo.sayTitle')}</h3>
          <blockquote>{t(ch.say)}</blockquote>
          <details>
            <summary>{otherLang === 'ar' ? 'العربية' : 'English'}</summary>
            <blockquote lang={otherLang} dir={otherLang === 'ar' ? 'rtl' : 'ltr'}>
              {translate(otherLang, ch.say)}
            </blockquote>
          </details>
        </section>

        {ch.filenet && <IbmCallout kind="filenet" text={t(ch.filenet)} integ={status.integrations} events={evFor('filenet')} staff={staff} />}
        {ch.orch && <IbmCallout kind="orchestrate" text={t(ch.orch)} integ={status.integrations} events={evFor('orchestrate')} staff={staff} />}

        {myTour && (
          <button type="button" className="btn btn-ghost demo-link" onClick={() => setDemo({ tour: { id: myTour, step: 0 } })}>
            {t('demo.roleTourNow')}
          </button>
        )}
      </div>

      <footer className="demo-foot">
        <div className="demo-row">
          <button type="button" className="btn btn-secondary" onClick={() => setChapter(idx - 1)} disabled={idx === 0}>
            {t('demo.prev')}
          </button>
          <span className="demo-grow" />
          <button type="button" className="btn btn-primary" onClick={() => setChapter(idx + 1)} disabled={idx === chapters.length - 1}>
            {t('demo.next')}
          </button>
        </div>
        <StatusFooter status={status} />
      </footer>
    </aside>
  );
}
