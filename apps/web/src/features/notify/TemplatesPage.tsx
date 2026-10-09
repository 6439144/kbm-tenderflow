// Admin → Notifications: the entity's notification templates (MOI BRD NOT-001..005 + TenderFlow events).
// Edit subject/body in English and Arabic with a live preview on sample values, choose channels, enable/disable,
// reset to the default text, and send a test to yourself. Every save is audited by the API.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AsyncView, Badge, Button, Card, ErrorBox, Field, errText, useAsync, useToast } from '../../components/ui';
import { notifyApi, OPTIONAL_CHANNELS, type Channel, type ChannelStatus, type NotificationTemplate, type TemplatePreview, type TemplateTexts, type TestSendResult } from './api';
import { ChannelBadge, ChannelStatusRow, DeliveryStatusBadge, NotifySubnav } from './common';
import { MyContactCard } from './MyContact';

export function NotificationTemplatesPage() {
  const { t } = useI18n();
  const state = useAsync(() => notifyApi.templates(), []);
  const [params, setParams] = useSearchParams();
  const selected = params.get('code');
  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{t('notify.t.title')}</h1>
          <p className="muted notify-lead">{t('notify.t.lead')}</p>
        </div>
      </header>
      <NotifySubnav />
      <AsyncView state={state}>
        {(d) => {
          const current = d.templates.find((x) => x.code === selected) ?? d.templates[0];
          return (
            <>
              <ChannelStatusRow channels={d.channels} />
              <div className="notify-layout">
                <TemplateList
                  items={d.templates}
                  current={current?.code}
                  onPick={(code) => setParams((p) => { p.set('code', code); return p; }, { replace: true })}
                />
                <div className="stack">
                  {current && (
                    <TemplateEditor
                      key={`${current.code}:${current.updatedAt}`}
                      tpl={current}
                      channels={d.channels}
                      onSaved={state.reload}
                    />
                  )}
                  <MyContactCard />
                </div>
              </div>
            </>
          );
        }}
      </AsyncView>
    </div>
  );
}

function TemplateList({ items, current, onPick }: { items: NotificationTemplate[]; current?: string; onPick: (code: string) => void }) {
  const { t, lang } = useI18n();
  const groups: [string, NotificationTemplate[]][] = [
    [t('notify.t.groupBrd'), items.filter((x) => x.source === 'BRD')],
    [t('notify.t.groupSystem'), items.filter((x) => x.source !== 'BRD')],
  ];
  return (
    <nav className="notify-list card" aria-label={t('notify.t.listLabel')}>
      {groups.map(([title, xs]) =>
        xs.length ? (
          <div key={title}>
            <h2 className="notify-list-h">{title}</h2>
            <ul>
              {xs.map((x) => (
                <li key={x.code}>
                  <button
                    type="button"
                    className={`notify-list-item ${x.code === current ? 'on' : ''}`}
                    aria-current={x.code === current ? 'true' : undefined}
                    onClick={() => onPick(x.code)}
                  >
                    <span className="notify-code" dir="ltr">
                      {x.code}
                    </span>
                    <span className="notify-list-subj">{lang === 'ar' ? x.subjectAr : x.subjectEn}</span>
                    <span className="notify-list-tags">
                      {x.channels.map((c) => (
                        <ChannelBadge key={c} channel={c} />
                      ))}
                      {!x.enabled && <Badge tone="danger" label={t('notify.t.disabled')} />}
                      {!x.isDefaultText && <Badge tone="info" label={t('notify.t.edited')} />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </nav>
  );
}

type FieldKey = keyof TemplateTexts;

function TemplateEditor({ tpl, channels: chStatus, onSaved }: { tpl: NotificationTemplate; channels: ChannelStatus; onSaved: () => void }) {
  const { t, te, fmtDate } = useI18n();
  const { hasRole } = useSession();
  const toast = useToast();
  const isAdmin = hasRole('TENANT_ADMIN');
  const initial: TemplateTexts = { subjectEn: tpl.subjectEn, subjectAr: tpl.subjectAr, bodyEn: tpl.bodyEn, bodyAr: tpl.bodyAr };
  const [texts, setTexts] = useState<TemplateTexts>(initial);
  const [channels, setChannels] = useState<Channel[]>(tpl.channels);
  const [enabled, setEnabled] = useState(tpl.enabled);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'reset' | 'test'>(null);
  const [err, setErr] = useState<unknown>(null);
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const lastField = useRef<{ key: FieldKey; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  const dirtyTexts = (Object.keys(initial) as FieldKey[]).some((k) => texts[k] !== initial[k]);
  const dirty = dirtyTexts || enabled !== tpl.enabled || channels.join() !== tpl.channels.join();

  // live preview (sample values), debounced; admins only (the preview endpoint is admin-only)
  const textsKey = JSON.stringify(texts);
  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    const h = setTimeout(() => {
      notifyApi
        .preview(tpl.code, texts)
        .then((p) => live && (setPreview(p), setPreviewErr(null)))
        .catch((e: unknown) => live && setPreviewErr(errText(e)));
    }, 350);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [tpl.code, textsKey, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: FieldKey, v: string) => setTexts((x) => ({ ...x, [k]: v }));
  const insert = (name: string) => {
    const f = lastField.current;
    const token = `{${name}}`;
    if (!f) {
      set('bodyEn', texts.bodyEn + token);
      return;
    }
    const el = f.el;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    const v = el.value.slice(0, s) + token + el.value.slice(e);
    set(f.key, v);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };
  const track = (key: FieldKey) => (ev: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    lastField.current = { key, el: ev.currentTarget };
  };

  const save = async (reset = false) => {
    setBusy(reset ? 'reset' : 'save');
    setErr(null);
    try {
      await notifyApi.updateTemplate(tpl.code, reset ? { reset: true } : { ...texts, channels, enabled });
      toast(reset ? t('notify.t.resetDone') : t('notify.t.saved'));
      onSaved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const sendTest = async () => {
    setBusy('test');
    setErr(null);
    setTestResult(null);
    try {
      setTestResult(await notifyApi.sendTest(tpl.code));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const unknown = preview?.unknownPlaceholders ?? [];
  const readOnly = !isAdmin;
  const textField = (k: FieldKey, label: string, dir: 'ltr' | 'rtl', multiline: boolean) => (
    <Field label={label} required>
      {(id, d) =>
        multiline ? (
          <textarea id={id} aria-describedby={d} dir={dir} rows={6} value={texts[k]} readOnly={readOnly} maxLength={4000}
            onChange={(e) => set(k, e.target.value)} onFocus={track(k)} onSelect={track(k)} />
        ) : (
          <input id={id} aria-describedby={d} dir={dir} value={texts[k]} readOnly={readOnly} maxLength={300}
            onChange={(e) => set(k, e.target.value)} onFocus={track(k)} onSelect={track(k)} />
        )
      }
    </Field>
  );

  return (
    <Card
      className="notify-editor"
      title={
        <span className="notify-editor-title">
          <span dir="ltr" className="notify-code">
            {tpl.code}
          </span>
          <Badge tone={tpl.audience === 'VENDOR' ? 'primary' : 'info'} label={te('notify.aud.', tpl.audience)} />
          {tpl.source === 'BRD' && <Badge tone="warn" label={tpl.mandatory ? t('notify.t.brdMandatory') : t('notify.t.brd')} />}
        </span>
      }
      actions={
        <label className="notify-switch">
          <input type="checkbox" checked={enabled} disabled={readOnly} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{enabled ? t('notify.t.enabled') : t('notify.t.disabled')}</span>
        </label>
      }
    >
      <p className="muted small">
        {t('notify.t.lastChange', { at: fmtDate(tpl.updatedAt), by: tpl.updatedBy === 'SYSTEM' || !tpl.updatedBy ? t('notify.t.system') : t('notify.t.anAdmin') })}
        {tpl.isDefaultText ? ` · ${t('notify.t.defaultText')}` : ` · ${t('notify.t.editedText')}`}
      </p>
      {!enabled && <div className="alert alert-warn small">{t('notify.t.disabledNote')}</div>}

      <fieldset className="notify-channels">
        <legend>{t('notify.t.channels')}</legend>
        <label>
          <input type="checkbox" checked disabled /> {te('notify.ch.', 'IN_APP')} <span className="muted small">— {t('notify.t.inAppAlways')}</span>
        </label>
        {OPTIONAL_CHANNELS.map((c) => (
          <label key={c}>
            <input
              type="checkbox"
              checked={channels.includes(c)}
              disabled={readOnly}
              onChange={(e) => setChannels((xs) => (e.target.checked ? ['IN_APP', ...OPTIONAL_CHANNELS.filter((y) => y === c || xs.includes(y))] : xs.filter((y) => y !== c)))}
            />{' '}
            {te('notify.ch.', c)}
            {!chStatus[c]?.configured && <span className="muted small"> — {t('notify.t.notConfiguredNote')}</span>}
          </label>
        ))}
      </fieldset>

      <div className="notify-langs">
        <div className="notify-lang" lang="en">
          <h3>{t('notify.t.english')}</h3>
          {textField('subjectEn', t('notify.t.subject'), 'ltr', false)}
          {textField('bodyEn', t('notify.t.body'), 'ltr', true)}
        </div>
        <div className="notify-lang" lang="ar">
          <h3>{t('notify.t.arabic')}</h3>
          {textField('subjectAr', t('notify.t.subject'), 'rtl', false)}
          {textField('bodyAr', t('notify.t.body'), 'rtl', true)}
        </div>
      </div>

      <div className="notify-ph">
        <span className="small">{t('notify.t.placeholders')}</span>
        {tpl.placeholders.map((p) => (
          <button key={p} type="button" className="notify-ph-chip" dir="ltr" disabled={readOnly} onClick={() => insert(p)} title={t('notify.t.insert')}>
            {`{${p}}`}
          </button>
        ))}
      </div>
      {unknown.length > 0 && (
        <div className="alert alert-danger small" role="alert">
          {t('notify.t.unknown', { list: unknown.map((p) => `{${p}}`).join(' ') })}
        </div>
      )}

      {isAdmin && (
        <section className="notify-preview" aria-live="polite">
          <h3>{t('notify.t.preview')}</h3>
          <p className="muted small">{t('notify.t.previewNote')}</p>
          {previewErr && <div className="field-error small">{previewErr}</div>}
          {preview ? (
            <div className="notify-langs">
              <PreviewBox lang="en" subject={preview.en.subject} body={preview.en.body} label={t('notify.t.english')} />
              <PreviewBox lang="ar" subject={preview.ar.subject} body={preview.ar.body} label={t('notify.t.arabic')} />
            </div>
          ) : (
            !previewErr && <p className="muted small">{t('common.loading')}</p>
          )}
        </section>
      )}

      {err ? <ErrorBox error={err} /> : null}
      {isAdmin ? (
        <div className="row wrap notify-actions">
          <Button busy={busy === 'save'} disabled={!dirty || unknown.length > 0 || busy !== null} onClick={() => save(false)}>
            {t('common.save')}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => { setTexts(initial); setChannels(tpl.channels); setEnabled(tpl.enabled); }}>
              {t('notify.t.discard')}
            </Button>
          )}
          {!tpl.isDefaultText && tpl.source !== 'CUSTOM' && (
            <Button variant="secondary" busy={busy === 'reset'} disabled={busy !== null} onClick={() => save(true)}>
              {t('notify.t.reset')}
            </Button>
          )}
          <Button
            variant="secondary"
            busy={busy === 'test'}
            disabled={busy !== null || dirty || !tpl.enabled}
            disabledReason={dirty ? t('notify.t.saveFirst') : !tpl.enabled ? t('notify.t.enableFirst') : undefined}
            onClick={sendTest}
          >
            {t('notify.t.sendTest')}
          </Button>
        </div>
      ) : (
        <p className="muted small">{t('notify.t.readOnly')}</p>
      )}
      {testResult && <TestResult r={testResult} />}
    </Card>
  );
}

function PreviewBox({ lang, subject, body, label }: { lang: 'en' | 'ar'; subject: string; body: string; label: string }) {
  return (
    <div className="notify-preview-box" lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-label={label}>
      <div className="notify-preview-subj">{subject}</div>
      <div className="notify-preview-body">{body}</div>
    </div>
  );
}

function TestResult({ r }: { r: TestSendResult }) {
  const { t, te } = useI18n();
  const order = useMemo(() => ['IN_APP', 'EMAIL', 'SMS'], []);
  const items = [...r.deliveries].sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));
  return (
    <div className="notify-test" role="status">
      <strong>{t('notify.t.testResult')}</strong>
      <ul className="plain">
        {items.map((d) => (
          <li key={d.id} className="row wrap">
            <span className="notify-test-ch">{te('notify.ch.', d.channel)}</span>
            <DeliveryStatusBadge status={d.status} />
            {d.address && (
              <span className="muted small" dir="ltr">
                {d.address}
              </span>
            )}
            {d.providerMessageId && (
              <span className="muted small" dir="ltr">
                id {d.providerMessageId}
              </span>
            )}
            {d.error && <span className="field-error small">{d.error}</span>}
          </li>
        ))}
      </ul>
      <Link to={`/admin/notifications/log?templateCode=${encodeURIComponent(r.templateCode)}`}>{t('notify.t.openLog')}</Link>
    </div>
  );
}
