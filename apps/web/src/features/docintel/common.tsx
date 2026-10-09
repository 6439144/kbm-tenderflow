// Shared bits of the document-intelligence UI: value formatting, status badge, flag chips, polling hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, type TKey } from '../../i18n';
import { docintelApi, type DocInsightState, type FieldValue, type Flag, type Insight } from './api';

export function useFmt() {
  const { lang, fmtMoney, pick } = useI18n();
  const day = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-KW' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  };
  const value = (v: FieldValue | null | undefined, type?: string): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return v.join(lang === 'ar' ? '، ' : ', ');
    if (typeof v === 'object') return v.currency ? fmtMoney(v.amount, v.currency) : v.amount.toLocaleString(lang === 'ar' ? 'ar-KW' : 'en-GB');
    if (type === 'date' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) return day(String(v));
    return String(v);
  };
  const typeName = (i: { docTypeNameEn?: string | null; docTypeNameAr?: string | null; docType?: string | null }) =>
    pick(i.docTypeNameEn ?? i.docType ?? '', i.docTypeNameAr ?? i.docType ?? '') || '—';
  return { day, value, typeName };
}

const STATUS_TONE: Record<string, string> = {
  PENDING_REVIEW: 'warn', ACCEPTED: 'success', CORRECTED: 'success', REJECTED: 'neutral', NOT_EXTRACTABLE: 'neutral', FAILED: 'danger',
};
const STATUS_KEY: Record<string, TKey> = {
  PENDING_REVIEW: 'docintel.badge.pending', ACCEPTED: 'docintel.badge.accepted', CORRECTED: 'docintel.badge.corrected',
  REJECTED: 'docintel.badge.rejected', NOT_EXTRACTABLE: 'docintel.badge.notExtractable', FAILED: 'docintel.badge.failed',
};

/** "Commercial registration · needs review" — or reading / not connected / not classified. */
export function InsightBadge({ state, reading }: { state: DocInsightState | undefined; reading?: boolean }) {
  const { t } = useI18n();
  const { typeName } = useFmt();
  if (!state) return null;
  const i = state.insight;
  let tone = 'neutral'; let text: string;
  if (state.queued || reading) { tone = 'info'; text = t('docintel.badge.reading'); }
  else if (i) {
    tone = STATUS_TONE[i.status] ?? 'neutral';
    const st = t(STATUS_KEY[i.status]);
    text = i.docType && !['NOT_EXTRACTABLE', 'FAILED'].includes(i.status) ? `${typeName(i)} · ${st}` : st;
  } else if (!state.configured) text = t('docintel.badge.notConnected');
  else text = t('docintel.badge.notClassified');
  return (
    <span className={`di-badge di-tone-${tone}`} title={t('docintel.badge.title')}>
      <OrchestrateIcon />
      {text}
      {(state.queued || reading) && <span className="spinner spinner-sm" aria-hidden="true" />}
    </span>
  );
}

export function flagText(t: (k: TKey, v?: Record<string, string | number>) => string, f: Flag, day: (s: string) => string, lang: 'ar' | 'en' = 'en'): string {
  const d = f.data ?? {};
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(d)) vars[k] = Array.isArray(v) ? v.join(', ') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? day(v) : v;
  if (f.code === 'TYPE_MISMATCH') {
    const L = lang === 'ar' ? 'Ar' : 'En';
    vars.expected = String(d[`expected${L}`] ?? d.expected ?? '');
    vars.found = String(d[`found${L}`] ?? d.found ?? '');
  }
  return t(`docintel.flag.${f.code}` as TKey, vars);
}

export function FlagChips({ flags, compact }: { flags: Flag[] | undefined; compact?: boolean }) {
  const { t, lang } = useI18n();
  const { day } = useFmt();
  if (!flags?.length) return null;
  return (
    <span className={`di-flags ${compact ? 'di-flags-compact' : ''}`}>
      {flags.map((f, i) => (
        <span key={i} className={`di-flag di-flag-${f.severity.toLowerCase()}`}>
          {flagText(t, f, day, lang)}
        </span>
      ))}
    </span>
  );
}

export function OrchestrateIcon() {
  return (
    <svg className="di-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <circle cx="4.5" cy="6" r="2" />
      <circle cx="19.5" cy="6" r="2" />
      <circle cx="12" cy="20.5" r="2" />
      <path d="M6.3 7.1 9.6 10.4M17.7 7.1l-3.3 3.3M12 15v3.5" />
    </svg>
  );
}

const POLL_MS = 2000;
const POLL_FOR_MS = 45000;
const FRESH_MS = 30000;

/**
 * Latest insight of a set of documents (one request), polling while Orchestrate is reading one of them — or while a
 * freshly uploaded document has no result yet — for at most 45 s; afterwards "check back later".
 */
export function useDocInsights(docs: { id: string; createdAt?: string }[]) {
  const ids = docs.map((d) => d.id).join(',');
  const [map, setMap] = useState<Record<string, DocInsightState>>({});
  const [timedOut, setTimedOut] = useState(false);
  const started = useRef<number | null>(null);
  const docsRef = useRef(docs);
  docsRef.current = docs;
  const load = useCallback(async () => {
    if (!ids) { setMap({}); return {}; }
    try {
      const r = await docintelApi.latest(ids.split(','));
      setMap(r.items ?? {});
      return r.items ?? {};
    } catch {
      return null; // badges are an enhancement: the document list stays usable
    }
  }, [ids]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    started.current = Date.now();
    setTimedOut(false);
    const tick = async () => {
      const items = await load();
      if (!alive || !items) return;
      const now = Date.now();
      const waiting = docsRef.current.some((d) => {
        const s = items[d.id];
        if (!s) return false;
        if (s.queued) return true;
        const fresh = d.createdAt ? now - new Date(d.createdAt).getTime() < FRESH_MS : false;
        return !s.insight && s.configured && s.classifiable && fresh;
      });
      if (!waiting) return;
      if (now - (started.current ?? now) > POLL_FOR_MS) { setTimedOut(true); return; }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);
  const update = (docId: string, insight: Insight | null, extra: Partial<DocInsightState> = {}) =>
    setMap((m) => ({ ...m, [docId]: { ...(m[docId] ?? { documentId: docId, configured: true, classifiable: true, queued: false, canClassify: false }), ...extra, insight } }));
  return { map, reload: load, update, timedOut };
}
