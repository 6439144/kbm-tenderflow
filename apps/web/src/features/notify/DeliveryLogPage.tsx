// Admin → Notifications → Delivery log: every notification per channel and recipient with its real status
// (in-app SENT; e-mail / SMS QUEUED → SENT / FAILED after retries, or SKIPPED when the channel is not configured).
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, Field, Table, useAsync, useToast, errText } from '../../components/ui';
import { DELIVERY_STATUSES, notifyApi, type Channel, type DeliveryLog, type DeliveryRow } from './api';
import { ChannelBadge, ChannelStatusRow, DeliveryStatusBadge, NotifySubnav } from './common';

const CHANNELS: Channel[] = ['IN_APP', 'EMAIL', 'SMS'];

export function DeliveryLogPage() {
  const { t, te } = useI18n();
  const [params, setParams] = useSearchParams();
  const f = {
    status: params.get('status') ?? '',
    channel: params.get('channel') ?? '',
    templateCode: params.get('templateCode') ?? '',
    q: params.get('q') ?? '',
  };
  const [q, setQ] = useState(f.q);
  const state = useAsync(() => notifyApi.deliveries(f), [f.status, f.channel, f.templateCode, f.q]);
  const setF = (k: keyof typeof f, v: string) =>
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true },
    );
  const any = f.status || f.channel || f.templateCode || f.q;
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('notify.l.title')}</h1>
          <p className="muted notify-lead">{t('notify.l.lead')}</p>
        </div>
        <Button variant="ghost" onClick={state.reload}>
          {t('common.refresh')}
        </Button>
      </header>
      <NotifySubnav />
      {state.data && <ChannelStatusRow channels={state.data.channels} />}
      {state.data && <Counts d={state.data} onPick={(status, channel) => setParams((p) => { p.set('status', status); p.set('channel', channel); return p; }, { replace: true })} />}
      <Card>
        <form
          className="row wrap filters"
          onSubmit={(e) => {
            e.preventDefault();
            setF('q', q.trim());
          }}
        >
          <Field label={t('notify.l.status')}>
            {(id) => (
              <select id={id} value={f.status} onChange={(e) => setF('status', e.target.value)}>
                <option value="">{t('notify.l.all')}</option>
                {DELIVERY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {te('notify.ds.', s)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('notify.l.channel')}>
            {(id) => (
              <select id={id} value={f.channel} onChange={(e) => setF('channel', e.target.value)}>
                <option value="">{t('notify.l.all')}</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {te('notify.ch.', c)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('notify.l.template')}>
            {(id) => (
              <select id={id} value={f.templateCode} onChange={(e) => setF('templateCode', e.target.value)} dir="ltr">
                <option value="">{t('notify.l.all')}</option>
                {(state.data?.templateCodes ?? (f.templateCode ? [f.templateCode] : [])).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('notify.l.search')}>
            {(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('notify.l.searchHint')} />}
          </Field>
          <Button type="submit" variant="secondary">
            {t('notify.l.apply')}
          </Button>
          {any && (
            <Button
              variant="ghost"
              onClick={() => {
                setQ('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              {t('notify.l.clear')}
            </Button>
          )}
        </form>
        <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={any ? t('notify.l.noMatch') : t('notify.l.empty')}>
          {(d) => <LogTable items={d.items} reload={state.reload} />}
        </AsyncView>
      </Card>
    </div>
  );
}

function Counts({ d, onPick }: { d: DeliveryLog; onPick: (status: string, channel: string) => void }) {
  const { t, te } = useI18n();
  if (!d.counts.length) return null;
  const statuses = DELIVERY_STATUSES.filter((s) => d.counts.some((c) => c.status === s));
  return (
    <div className="notify-counts" role="group" aria-label={t('notify.l.counts')}>
      {CHANNELS.map((ch) => {
        const xs = d.counts.filter((c) => c.channel === ch);
        if (!xs.length) return null;
        return (
          <div key={ch} className="notify-count-card">
            <div className="notify-count-ch">{te('notify.ch.', ch)}</div>
            <ul className="plain">
              {statuses.map((s) => {
                const n = xs.find((c) => c.status === s)?.n;
                return n ? (
                  <li key={s}>
                    <button type="button" className="notify-count-btn" onClick={() => onPick(s, ch)}>
                      <DeliveryStatusBadge status={s} /> <strong>{n}</strong>
                    </button>
                  </li>
                ) : null;
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function LogTable({ items, reload }: { items: DeliveryRow[]; reload: () => void }) {
  const { t, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const isAdmin = hasRole('TENANT_ADMIN');
  const [busy, setBusy] = useState<string | null>(null);
  const retry = async (id: string) => {
    setBusy(id);
    try {
      await notifyApi.retryDelivery(id);
      toast(t('notify.l.requeued'));
      reload();
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Table
      caption={t('notify.l.title')}
      head={[t('notify.l.when'), t('notify.l.template'), t('notify.l.channel'), t('notify.l.recipient'), t('notify.l.subject'), t('notify.l.status'), t('notify.l.attempts'), '']}
    >
      {items.map((d) => (
        <tr key={d.id} className={d.isTest ? 'notify-row-test' : undefined}>
          <td className="nowrap small">{fmtDate(d.createdAt)}</td>
          <td>
            <span className="notify-code" dir="ltr">
              {d.templateCode}
            </span>
            {d.isTest && <Badge tone="info" label={t('notify.l.test')} />}
          </td>
          <td>
            <ChannelBadge channel={d.channel} />
          </td>
          <td>
            <div>{d.recipientLabel ?? '—'}</div>
            {d.address && (
              <div className="muted small" dir="ltr">
                {d.address}
              </div>
            )}
          </td>
          <td className="notify-subj-cell" dir="auto">
            {d.subject}
          </td>
          <td>
            <DeliveryStatusBadge status={d.status} />
            {d.sentAt && d.channel !== 'IN_APP' && <div className="muted small">{fmtDate(d.sentAt)}</div>}
            {d.providerMessageId && (
              <div className="muted small notify-msgid" dir="ltr" title={d.providerMessageId}>
                {d.providerMessageId}
              </div>
            )}
            {d.error && <div className="field-error small notify-err">{d.error}</div>}
            {d.status === 'QUEUED' && d.nextAttemptAt && d.attempts > 0 && (
              <div className="muted small">{t('notify.l.nextAttempt', { at: fmtDate(d.nextAttemptAt) })}</div>
            )}
          </td>
          <td className="notify-num">{d.channel === 'IN_APP' ? '—' : `${d.attempts}/3`}</td>
          <td>
            {isAdmin && d.status === 'FAILED' && (
              <Button variant="secondary" busy={busy === d.id} onClick={() => retry(d.id)}>
                {t('notify.l.retry')}
              </Button>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}
