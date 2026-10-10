// Public tender board (/tenders, no login). Dedicated installation: the open tenders of this entity, titled with its
// name, no entity filter. Shared installation: open tenders of every participating entity in one place.
// Shows only what the server publishes: entity, number, titles, category, activity codes, deadline, document price
// and the official publication references.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { Header } from '../../components/Layout';
import { AsyncView, Badge, Button, EmptyState, Field, useAsync } from '../../components/ui';
import { insight, type PublicTender } from './api';
import '../../styles/insight.css';
import { useDeployment } from '../../deployment';

const DAY = 86_400_000;

export function PublicBoardPage() {
  const { t, pick } = useI18n();
  const { dedicated, entityName } = useDeployment();
  const [params, setParams] = useSearchParams();
  const entity = dedicated ? '' : params.get('entity') ?? '';
  const activity = params.get('activity') ?? '';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const state = useAsync(() => insight.board({ entity, activity, q }), [entity, activity, q]);
  const facets = useAsync(() => insight.board({}), []);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const search = (e: FormEvent) => { e.preventDefault(); set('q', text.trim()); };
  const feedQs = params.toString() ? `?${params.toString()}` : '';
  return (
    <>
      <Header />
      <main id="main" className="page insight-board" tabIndex={-1}>
        <header className="insight-board-head">
          <div>
            <h1>{dedicated && entityName ? t('ded.board.title', { entity: entityName }) : t('insight.board.title')}</h1>
            <p className="muted">{dedicated && entityName ? t('ded.board.subtitle', { entity: entityName }) : t('insight.board.subtitle')}</p>
          </div>
          <div className="row wrap">
            <a className="btn btn-ghost" href={`/api/v1/public/tenders.rss${feedQs}`} type="application/rss+xml">{t('insight.board.rss')}</a>
            <a className="btn btn-ghost" href={`/api/v1/public/tenders.json${feedQs}`} type="application/feed+json">{t('insight.board.json')}</a>
            <Link className="btn btn-secondary" to="/login">{t('insight.board.signIn')}</Link>
          </div>
        </header>
        <form className="insight-filters" onSubmit={search} role="search" aria-label={t('insight.board.filters')}>
          {!dedicated && (
            <Field label={t('insight.board.entity')}>
              {(id) => (
                <select id={id} value={entity} onChange={(e) => set('entity', e.target.value)}>
                  <option value="">{t('common.all')}</option>
                  {(facets.data?.entities ?? []).map((x) => <option key={x.id} value={x.id}>{pick(x.nameEn, x.nameAr)}</option>)}
                </select>
              )}
            </Field>
          )}
          <Field label={t('insight.board.activity')}>
            {(id) => (
              <select id={id} value={activity} onChange={(e) => set('activity', e.target.value)}>
                <option value="">{t('common.all')}</option>
                {(facets.data?.activities ?? []).map((x) => <option key={x.code} value={x.code}>{`${x.code}${x.nameEn || x.nameAr ? ` — ${pick(x.nameEn ?? '', x.nameAr ?? '')}` : ''}`}</option>)}
              </select>
            )}
          </Field>
          <Field label={t('insight.board.search')}>
            {(id) => <input id={id} type="search" value={text} maxLength={100} onChange={(e) => setText(e.target.value)} placeholder={t('insight.board.searchPh')} />}
          </Field>
          <Button type="submit">{t('insight.board.searchBtn')}</Button>
          {(entity || activity || q) && <Button variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>{t('insight.board.clear')}</Button>}
        </form>
        <AsyncView state={state}>
          {(b) => (
            <>
              <p className="muted small" aria-live="polite">{t('insight.board.count', { n: b.count })}</p>
              {b.tenders.length === 0 ? <EmptyState message={t('insight.board.empty')} /> : (
                <ul className="insight-board-list">
                  {b.tenders.map((x) => <BoardItem key={`${x.entity.id}-${x.tenderNumber}`} x={x} showEntity={!dedicated} />)}
                </ul>
              )}
              <p className="muted small">{dedicated && entityName ? t('ded.board.note', { entity: entityName }) : t('insight.board.note')}</p>
            </>
          )}
        </AsyncView>
      </main>
    </>
  );
}

function BoardItem({ x, showEntity }: { x: PublicTender; showEntity: boolean }) {
  const { t, te, pick, fmtDate, fmtMoney } = useI18n();
  const left = (new Date(x.submissionDeadline).getTime() - Date.now()) / DAY;
  return (
    <li className="insight-board-item card">
      {showEntity && <div className="insight-board-entity">{pick(x.entity.nameEn, x.entity.nameAr)}</div>}
      <h2 className="insight-board-title">
        <span dir="ltr" className="insight-board-num">{x.tenderNumber}</span> {pick(x.titleEn, x.titleAr)}
      </h2>
      <div className="row wrap small">
        <Badge tone="primary" label={te('cat.', x.category)} />
        {x.activityCodes.map((a) => (
          <span key={a.code} className="insight-chip" title={pick(a.nameEn ?? '', a.nameAr ?? '')}>{a.code}{a.nameEn || a.nameAr ? ` · ${pick(a.nameEn ?? '', a.nameAr ?? '')}` : ''}</span>
        ))}
      </div>
      <dl className="insight-board-facts">
        <div>
          <dt>{t('common.deadline')}</dt>
          <dd>{fmtDate(x.submissionDeadline)} <Badge tone={left < 3 ? 'warn' : 'neutral'} label={t('insight.board.daysLeft', { n: Math.max(0, Math.floor(left)) })} /></dd>
        </div>
        <div>
          <dt>{t('insight.board.price')}</dt>
          <dd>{x.documentPrice ? fmtMoney(x.documentPrice.amount, x.documentPrice.currency) : t('insight.vendor.free')}</dd>
        </div>
        {x.publishedAt && (
          <div>
            <dt>{t('insight.board.published')}</dt>
            <dd>{fmtDate(x.publishedAt)}</dd>
          </div>
        )}
        {x.publications.map((p) => (
          <div key={p.channel}>
            <dt>{t(p.channel === 'KUWAIT_ALYOUM' ? 'insight.board.gazette' : 'insight.board.capt')}</dt>
            <dd><span dir="ltr">{p.reference ?? '—'}</span>{p.publishedOn ? ` · ${p.publishedOn}` : ''}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
