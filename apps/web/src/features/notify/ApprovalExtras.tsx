// Approval-chain extras shown on tender and request pages: the service-level badge of the WAITING level
// ("overdue by 5 h · escalated to Director", "due in 3 h") and the tender publication "Reject" path.
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Button, ReasonDialog, useToast } from '../../components/ui';
import { notifyApi, type Gate, type SlaItem } from './api';
import { useDuration } from './common';

// One request per subject even when several badges (publish / award) are on the same page.
const cache = new Map<string, { at: number; p: Promise<SlaItem[]> }>();
function slaItems(subjectId: string): Promise<SlaItem[]> {
  const hit = cache.get(subjectId);
  if (hit && Date.now() - hit.at < 5_000) return hit.p;
  const p = notifyApi.slaFor(subjectId).then((r) => r.items);
  cache.set(subjectId, { at: Date.now(), p });
  p.catch(() => cache.delete(subjectId));
  return p;
}

/** Service-level state of the waiting level of one chain; renders nothing when no service level applies. */
export function ApprovalSlaBadge({ subjectId, gate, version }: { subjectId: string; gate: Gate; version?: string | number }) {
  const { t, te, fmtDate } = useI18n();
  const dur = useDuration();
  const [item, setItem] = useState<SlaItem | null>(null);
  useEffect(() => {
    let live = true;
    slaItems(subjectId)
      .then((xs) => live && setItem(xs.find((x) => x.gate === gate) ?? null))
      .catch(() => live && setItem(null)); // the badge is an aid; the chain view stays authoritative
    return () => {
      live = false;
    };
  }, [subjectId, gate, version]);
  if (!item || item.state === 'NO_SLA' || !item.dueAt) return null;
  const due = fmtDate(item.dueAt);
  if (item.state === 'OVERDUE')
    return (
      <span className="notify-sla" title={t('notify.b.dueAt', { at: due })}>
        <Badge tone="danger" label={t('notify.o.overdueBy', { d: dur(item.overdueMs) })} />
        {item.escalation && (
          <span className="small notify-sla-esc">{t('notify.b.escalatedTo', { to: te('role.', item.escalation.escalatedTo ?? '') })}</span>
        )}
      </span>
    );
  return (
    <span className="notify-sla" title={t('notify.b.dueAt', { at: due })}>
      <Badge tone={item.state === 'DUE_SOON' ? 'warn' : 'neutral'} label={t('notify.b.dueIn', { d: dur(item.dueInMs) })} />
      {item.reminder && <span className="small muted">{t('notify.b.reminded')}</span>}
    </span>
  );
}

/** "Reject" for the approver of the waiting publication level: reason required; the tender is cancelled (audited). */
export function RejectTenderButton({ tenderId, onDone, disabledReason }: { tenderId: string; onDone: () => void; disabledReason?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} disabled={Boolean(disabledReason)} disabledReason={disabledReason}>
        {t('notify.r.reject')}
      </Button>
      <ReasonDialog
        open={open}
        title={t('notify.r.title')}
        confirmLabel={t('notify.r.confirm')}
        required
        variant="danger"
        onClose={() => setOpen(false)}
        onConfirm={async (reason) => {
          await notifyApi.rejectTender(tenderId, reason);
          cache.delete(tenderId);
          toast(t('notify.r.done'));
          onDone();
        }}
      />
    </>
  );
}
