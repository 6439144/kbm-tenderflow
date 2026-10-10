// Draft workflow shared by the rule and form editors: live version, open draft, working copy, save / check / publish / discard.
import { useCallback, useEffect, useState } from 'react';
import { lowcode, type Check, type Definition } from './api';
import { errText, useToast } from '../../components/ui';
import { useI18n } from '../../i18n';

export function useDraft<D>(kind: 'FORM' | 'RULESET', code: string, empty: D) {
  const { t } = useI18n();
  const toast = useToast();
  const [defs, setDefs] = useState<Definition<D>[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [work, setWork] = useState<D | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);

  const load = useCallback(async () => {
    try {
      const all = (await lowcode.definitions(kind)).filter((d) => d.code === code) as Definition<D>[];
      setDefs(all);
      const draft = all.find((d) => d.status === 'DRAFT');
      const live = all.find((d) => d.status === 'PUBLISHED');
      setWork(structuredClone((draft ?? live)?.definition ?? empty));
      setDirty(false);
      setCheck(null);
      setError(null);
    } catch (e) { setError(e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, code]);
  useEffect(() => { setDefs(null); void load(); }, [load]);

  const draft = defs?.find((d) => d.status === 'DRAFT') ?? null;
  const live = defs?.find((d) => d.status === 'PUBLISHED') ?? null;

  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    try { await fn(); if (ok) toast(ok, 'success'); } catch (e) { toast(errText(e), 'error'); } finally { setBusy(null); }
  };

  return {
    defs, error, draft, live, work, dirty, busy, check, reload: load,
    edit: (next: D) => { setWork(next); setDirty(true); setCheck(null); },
    start: () => run('start', async () => {
      await lowcode.createDraft({ kind, code, fromId: live?.id, definition: live ? undefined : empty });
      await load();
    }),
    save: () => run('save', async () => {
      if (!draft || !work) return;
      await lowcode.saveDraft(draft.id, work);
      await load();
    }, t('lc.ver.saved')),
    runCheck: () => run('check', async () => {
      if (!work) return;
      const c = await lowcode.check(kind, code, work);
      setCheck(c);
    }),
    publish: () => run('publish', async () => {
      if (!draft) return;
      if (dirty && work) await lowcode.saveDraft(draft.id, work);
      const p = await lowcode.publish(draft.id);
      await load();
      toast(t('lc.ver.published', { v: p.version }), 'success');
    }),
    discard: () => run('discard', async () => {
      if (!draft || !window.confirm(t('lc.ver.discardConfirm'))) return;
      await lowcode.discard(draft.id);
      await load();
    }),
  };
}
