// <DescribeChangeButton scope="template" | "process" | "forms" /> — a compact version of the AI builder in a modal, for
// the Cycle Designer and Process Studio headers. Shown only to TENANT_ADMIN (auditors get nothing). The modal chats with
// the same agent, shows the validated proposal and creates DRAFTS only; `onApplied` lets the host page reload its drafts.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n, type TKey } from '../../i18n';
import { useSession } from '../../session';
import { Button, Modal } from '../../components/ui';
import { AgentBanners, AgentStatusLine, ChatPane, ProposalPane, Sparkle, useBuilder, type BuilderScope } from './Builder';
import type { AppliedRef } from './api';

export interface DescribeChangeButtonProps {
  /** Which examples and title the modal shows; the agent can still propose any catalogue operation. */
  scope: BuilderScope;
  /** Called after drafts were created, with what was created (e.g. to reload the designer's draft list). */
  onApplied?: (refs: AppliedRef[]) => void;
  /** Button text (default: "Describe a change" / «صِف تغييراً»). */
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}

export function DescribeChangeButton({ scope, onApplied, label, variant = 'secondary' }: DescribeChangeButtonProps) {
  const { t } = useI18n();
  const { hasRole } = useSession();
  const [open, setOpen] = useState(false);
  if (!hasRole('TENANT_ADMIN')) return null;
  return (
    <>
      <Button variant={variant} className="aa-describe-btn" onClick={() => setOpen(true)}>
        <Sparkle /> {label ?? t('aa.btn.describe')}
      </Button>
      {open && <DescribeChangeModal scope={scope} onClose={() => setOpen(false)} onApplied={onApplied} />}
    </>
  );
}

function DescribeChangeModal({ scope, onClose, onApplied }: { scope: BuilderScope; onClose: () => void; onApplied?: (refs: AppliedRef[]) => void }) {
  const { t } = useI18n();
  const b = useBuilder();
  return (
    <Modal open wide title={t(`aa.btn.title.${scope}` as TKey)} onClose={onClose}
      footer={<Link to="/admin/builder" className="btn btn-ghost" onClick={onClose}>{t('aa.btn.fullPage')}</Link>}>
      <div className="aa-modal">
        <AgentStatusLine status={b.status} />
        <AgentBanners status={b.status} />
        <div className="aa-layout is-compact">
          <ChatPane b={b} scope={scope} compact />
          <ProposalPane b={b} compact onNavigate={onClose} onApplied={onApplied} />
        </div>
      </div>
    </Modal>
  );
}
