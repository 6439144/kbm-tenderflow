// AI service contract (see docs/BUILD-SPEC.md §8). Re-exported unchanged from ./index.ts.
export interface DocText { documentId: string; title: string; sections: { section: string; text: string }[] }
export interface Citation { documentId: string; title: string; section: string; quote?: string }
export interface AiResult<T> { ok: true; agent: string; model?: string; output: T; citations: Citation[]; raw?: unknown }
export interface PackFinding { severity: 'HIGH' | 'MEDIUM' | 'LOW'; item: string; detail: string; citation?: Citation }
export interface ClarificationDraft { answer: string; language: 'ar' | 'en'; citations: Citation[]; notFound: boolean }
export interface ComplianceItem { requirement: string; status: 'PRESENT' | 'MISSING' | 'UNCLEAR'; evidence?: string; citation?: Citation }
export interface AiService {
  isConfigured(): boolean;
  ping(): Promise<{ ok: boolean; detail: string }>;
  checkTenderPack(input: { tender: { titleEn: string; titleAr: string; category: string; deadline: string; criteria: unknown; requiredDocuments: unknown }; documents: DocText[]; language: 'ar' | 'en' }): Promise<AiResult<{ findings: PackFinding[]; summary: string }>>;
  draftClarification(input: { tender: { titleEn: string; titleAr: string }; question: string; documents: DocText[]; priorAnswers: { question: string; answer: string }[] }): Promise<AiResult<ClarificationDraft>>;
  screenCompliance(input: { requiredDocuments: { key: string; nameEn: string; nameAr: string }[]; bid: { bidId: string; vendorName: string; documents: DocText[] } }): Promise<AiResult<{ items: ComplianceItem[] }>>;
}
export class AiNotConfiguredError extends Error { code = 'AI_NOT_CONFIGURED'; constructor(msg = 'watsonx Orchestrate is not configured (WXO_INSTANCE_URL / WXO_API_KEY).') { super(msg); } }
