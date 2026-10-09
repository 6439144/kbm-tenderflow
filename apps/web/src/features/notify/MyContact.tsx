// The signed-in staff user's e-mail / mobile for notifications (vendors use their vendor record's contact details).
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { Button, Card, ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { notifyApi } from './api';

export function MyContactCard() {
  const { t, fmtDate } = useI18n();
  const toast = useToast();
  const state = useAsync(() => notifyApi.myContact(), []);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (state.data) {
      setEmail(state.data.email ?? '');
      setPhone(state.data.phone ?? '');
    }
  }, [state.data]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await notifyApi.setMyContact({ email: email.trim() || null, phone: phone.trim() || null });
      toast(t('notify.c.saved'));
      state.reload();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('notify.c.title')}>
      <p className="muted small">{t('notify.c.lead')}</p>
      {state.loading && !state.data ? (
        <Spinner />
      ) : state.error ? (
        <ErrorBox error={state.error} onRetry={state.reload} />
      ) : (
        <form onSubmit={submit} className="notify-contact">
          {err ? <ErrorBox error={err} /> : null}
          <Field label={t('notify.c.email')}>
            {(id, d) => <input id={id} aria-describedby={d} type="email" dir="ltr" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label={t('notify.c.phone')} hint={t('notify.c.phoneHint')}>
            {(id, d) => <input id={id} aria-describedby={d} type="tel" dir="ltr" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
          </Field>
          <div className="row wrap">
            <Button type="submit" busy={busy}>
              {t('common.save')}
            </Button>
            {state.data?.updatedAt && <span className="muted small">{t('notify.c.updated', { at: fmtDate(state.data.updatedAt) })}</span>}
          </div>
        </form>
      )}
    </Card>
  );
}
