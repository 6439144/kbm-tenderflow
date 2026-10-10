// Admin → AI builder (/admin/builder): describe a configuration change, review the validated proposal, create drafts.
// TENANT_ADMIN chats and applies; AUDITOR reads proposals and history. ?proposal=<id> opens a proposal (the Orchestrate
// tool pack returns that link).
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { AgentBanners, AgentStatusLine, ChatPane, HistoryList, ProposalPane, useBuilder } from './Builder';
import type { Proposal } from './api';

export default function AdminBuilderPage() {
  const { t } = useI18n();
  const { hasRole } = useSession();
  const [params, setParams] = useSearchParams();
  const initialId = params.get('proposal');
  const onProposal = useCallback((p: Proposal | null) => {
    setParams((cur) => {
      const next = new URLSearchParams(cur);
      if (p) next.set('proposal', p.id); else next.delete('proposal');
      return next;
    }, { replace: true });
  }, [setParams]);
  const b = useBuilder({ initialId, onProposal });
  return (
    <div className="stack aa-page">
      <header className="page-head aa-page-head">
        <h1>{t('aa.title')}</h1>
        <AgentStatusLine status={b.status} />
      </header>
      <p className="lead">{t('aa.lead')}</p>
      {!hasRole('TENANT_ADMIN') && <div className="alert alert-info" role="status">{t('aa.readOnly')}</div>}
      <AgentBanners status={b.status} />
      <div className="aa-layout">
        <ChatPane b={b} />
        <ProposalPane b={b} />
      </div>
      <HistoryList b={b} currentId={b.proposal?.id ?? null} onPick={(id) => void b.load(id)} />
    </div>
  );
}
