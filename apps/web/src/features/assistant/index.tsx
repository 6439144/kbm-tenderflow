// Orchestrate workstream: supervisor chat dock, new advisory agents on tender/request/vendor pages.
import type { TenderDetail } from '../../api';

export function AssistantDock() { return null; }
export function TenderAiExtras(_: { td: TenderDetail; onChange: () => void }) { return null; }
export function TendersForYou() { return null; }
export function RequestAiExtras(_: { requestId: string; onChange: () => void }) { return null; }
