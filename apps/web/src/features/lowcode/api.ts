// Typed client for the low-code Process Studio (/api/v1/lowcode/*). Every call is a real request.
import { http } from '../../api';

export type FactType = 'number' | 'string' | 'boolean' | 'enum' | 'list' | 'date';
export type Scope = 'TENDER' | 'AWARD' | 'VENDOR' | 'REQUEST' | 'DOCUMENT';
export interface Option { value: string; labelEn: string; labelAr: string }
export interface FactDef { key: string; labelEn: string; labelAr: string; type: FactType; scopes: Scope[]; options?: Option[]; unit?: string }
export type TriggerKind = 'GATE' | 'EVENT' | 'SCHEDULE';
export interface TriggerDef { key: string; kind: TriggerKind; scope: Scope; labelEn: string; labelAr: string; stage: string }
export interface ActionDef { type: ActionType; kinds: TriggerKind[]; labelEn: string; labelAr: string; scopes?: Scope[] }
export type ActionType = 'ADD_APPROVER' | 'BLOCK' | 'REQUIRE_FIELDS' | 'REQUIRE_DOCUMENTS' | 'NOTIFY' | 'CREATE_TASK' | 'WEBHOOK' | 'SET_FIELD';

export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { fact: string; op: string; value?: unknown };
export interface Action {
  type: ActionType; role?: string; labelEn?: string; labelAr?: string; dueHours?: number; messageEn?: string; messageAr?: string;
  fields?: string[]; minCount?: number; titleContains?: string; to?: 'ROLE' | 'CREATOR' | 'SUBJECT_VENDOR'; titleEn?: string; titleAr?: string;
  blocksGate?: string | null; endpoint?: string; field?: string; value?: unknown;
}
export interface Rule { id: string; nameEn: string; nameAr: string; enabled: boolean; trigger: string; params?: { hoursBefore?: number }; when: Condition | null; actions: Action[] }
export interface RulesetDefinition { rules: Rule[] }

export type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'percent' | 'date' | 'select' | 'multiselect' | 'checkbox' | 'email' | 'phone' | 'url' | 'computed';
export interface FormField {
  key: string; type: FieldType; labelEn: string; labelAr: string; helpEn?: string; helpAr?: string; section?: string; required?: boolean;
  requiredAt?: 'SAVE' | 'SUBMIT'; audience?: 'PUBLIC' | 'INTERNAL'; min?: number; max?: number; maxLength?: number; decimals?: number; format?: string;
  options?: Option[]; formula?: string; visibleWhen?: Condition | null; defaultValue?: unknown;
}
export interface FormSection { key: string; titleEn: string; titleAr: string }
export interface FormDefinition { sections: FormSection[]; fields: FormField[] }
export type FormCode = 'TENDER' | 'REQUEST' | 'VENDOR';

export interface Definition<D = any> {
  id: string; kind: 'FORM' | 'RULESET'; code: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'RETIRED'; nameEn: string; nameAr: string;
  definition: D; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string; publishedBy: string | null; publishedAt: string | null;
}
export interface HistoryItem extends Omit<Definition, 'definition'> { changes: { added: string[]; removed: string[]; changed: string[] } }
export interface Catalog {
  facts: Record<Scope, FactDef[]>; ops: Record<FactType, string[]>; opLabels: Record<string, { en: string; ar: string }>; triggers: TriggerDef[]; actions: ActionDef[];
  approverRoles: string[]; staffRoles: string[]; blockableGates: string[]; webhooks: string[]; fieldTypes: FieldType[]; formats: string[]; formCodes: FormCode[];
  lockedControls: { key: string; en: string; ar: string }[]; placeholders: Record<string, string[]>; liveForms: string[];
}
export interface Check { valid: boolean; errors: string[]; warnings: string[] }
export interface ActionSummary { type: ActionType; summaryEn: string; summaryAr: string }
export interface SimResult {
  trigger: string; kind: TriggerKind; ruleset: { id: string; version: number; status: string } | null; source: { type: string; reference?: string };
  facts: Record<string, unknown>;
  results: { ruleId: string; nameEn: string; nameAr: string; enabled: boolean; matched: boolean; whenEn: string; whenAr: string; actions: ActionSummary[] }[];
  gate?: { chain: { role: string; labelEn: string; labelAr: string; added: boolean; ruleId?: string; ruleNameEn?: string; ruleNameAr?: string }[];
    blocks: { ruleId: string; messageEn: string; messageAr: string }[]; requiredFields: { ruleId: string; fields: string[] }[]; requiredDocuments: unknown[]; passes: boolean };
}
export interface MapStage {
  key: string; kind: string; enabled: boolean; detail?: string; locked: { key: string; en: string; ar: string } | null;
  rules: { id: string; nameEn: string; nameAr: string; enabled: boolean; trigger: string; kind: TriggerKind; whenEn: string; whenAr: string; actions: ActionSummary[] }[];
}
export interface ProcessMap { ruleset: { id: string; version: number; status: string } | null; stages: MapStage[]; lockedControls: { key: string; en: string; ar: string }[] }
export interface Task {
  id: string; titleEn: string; titleAr: string; role: string; blocksGate: string | null; dueAt: string | null; status: 'OPEN' | 'DONE' | 'CANCELLED';
  completedBy: string | null; completedAt: string | null; note: string | null; createdAt: string; subjectType?: string; subjectId?: string; subjectRef?: string; overdue?: boolean;
}
export interface Run { id: string; trigger: string; ruleId: string; ruleName: string; rulesetVersion: number | null; subjectType: string; subjectId: string; subjectRef: string; outcome: any; status: string; createdAt: string }
export interface Endpoint { id: string; code: string; name: string; url: string; events: string[]; enabled: boolean; createdAt: string; stats?: { sent: number; failed: number; queued: number } }
export interface Delivery { id: string; endpointId: string; code?: string; event: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; sentAt: string | null; createdAt: string; nextAttemptAt: string }
export interface CustomValue { key: string; type: FieldType; labelEn: string; labelAr: string; section: string | null; audience?: string; value: unknown; displayEn: string; displayAr: string }
export interface GateCheck {
  gate: string; passed: boolean; rulesetVersion: number | null;
  addLevels: { role: string; labelEn: string; labelAr: string; ruleId: string; ruleNameEn: string; ruleNameAr: string }[];
  blocks: { ruleId: string; ruleNameEn: string; ruleNameAr: string; messageEn: string; messageAr: string }[];
  missingFields: { key: string; labelEn: string; labelAr: string }[];
  missingDocuments: { ruleId: string; ruleNameEn: string; ruleNameAr: string; minCount: number; titleContains?: string; found: number }[];
  openTasks: { id: string; titleEn: string; titleAr: string; role: string }[];
  matched: { ruleId: string; nameEn: string; nameAr: string; whenEn: string; whenAr: string }[];
}
export interface TenderProcess {
  form: { id: string; version: number; definition: FormDefinition } | null; values: CustomValue[]; raw?: Record<string, unknown>;
  ruleset?: { definitionId: string; version: number; gateRules: number } | null; routing?: any; gates?: Record<string, GateCheck>; tasks?: Task[];
  runs?: { trigger: string; ruleId: string; ruleName: string; status: string; outcome: any; createdAt: string }[];
}
export interface PackagePreview { valid: boolean; items: { kind: string; code: string; action: string; note?: string }[]; errors: string[]; warnings: string[]; checksumOk: boolean; source: any }

const enc = encodeURIComponent;
export const lowcode = {
  catalog: () => http.get<Catalog>('/lowcode/catalog'),
  definitions: (kind?: 'FORM' | 'RULESET') => http.get<Definition[]>(`/lowcode/definitions${kind ? `?kind=${kind}` : ''}`),
  history: (kind: string, code: string) => http.get<HistoryItem[]>(`/lowcode/history/${kind}/${enc(code)}`),
  createDraft: (b: { kind: 'FORM' | 'RULESET'; code?: string; fromId?: string; definition?: unknown; nameEn?: string; nameAr?: string }) => http.post<Definition>('/lowcode/definitions', b),
  saveDraft: (id: string, definition: unknown) => http.patch<Definition>(`/lowcode/definitions/${id}`, { definition }),
  discard: (id: string) => http.del<{ discarded: boolean }>(`/lowcode/definitions/${id}`),
  publish: (id: string) => http.post<Definition>(`/lowcode/definitions/${id}/publish`),
  check: (kind: 'FORM' | 'RULESET', code: string, definition: unknown) => http.post<Check>('/lowcode/check', { kind, code, definition }),
  simulate: (b: { trigger: string; facts?: Record<string, unknown>; tenderId?: string; definitionId?: string }) => http.post<SimResult>('/lowcode/simulate', b),
  processMap: (definitionId?: string) => http.get<ProcessMap>(`/lowcode/process-map${definitionId ? `?definitionId=${definitionId}` : ''}`),
  runs: () => http.get<Run[]>('/lowcode/runs'),
  runNow: () => http.post<unknown>('/lowcode/run-now'),
  form: (code: FormCode) => http.get<{ form: { id: string; version: number; definition: FormDefinition } | null }>(`/lowcode/forms/${code}`),
  publicVendorForm: (tenant: string) => http.get<{ form: { id: string; version: number; definition: FormDefinition } | null }>(`/public/forms/vendor?tenant=${enc(tenant)}`),
  tenderProcess: (id: string) => http.get<TenderProcess>(`/tenders/${id}/process`),
  tasks: (q: { subjectId?: string; status?: string; scope?: 'all' } = {}) => http.get<Task[]>(`/lowcode/tasks?${new URLSearchParams(q as Record<string, string>).toString()}`),
  completeTask: (id: string, note: string) => http.post<Task>(`/lowcode/tasks/${id}/complete`, { note }),
  cancelTask: (id: string, reason: string) => http.post<Task>(`/lowcode/tasks/${id}/cancel`, { reason }),
  endpoints: () => http.get<Endpoint[]>('/lowcode/webhooks'),
  createEndpoint: (b: { code: string; name: string; url: string; events: string[] }) => http.post<Endpoint & { secret: string }>('/lowcode/webhooks', b),
  updateEndpoint: (id: string, b: Partial<{ name: string; url: string; events: string[]; enabled: boolean }>) => http.patch<Endpoint>(`/lowcode/webhooks/${id}`, b),
  rotateSecret: (id: string) => http.post<{ secret: string }>(`/lowcode/webhooks/${id}/rotate-secret`),
  testEndpoint: (id: string) => http.post<Delivery>(`/lowcode/webhooks/${id}/test`),
  deliveries: () => http.get<Delivery[]>('/lowcode/webhook-deliveries'),
  retryDelivery: (id: string) => http.post<Delivery>(`/lowcode/webhook-deliveries/${id}/retry`),
  exportPackage: () => http.get<unknown>('/lowcode/package'),
  previewPackage: (pkg: unknown) => http.post<PackagePreview>('/lowcode/package/preview', { package: pkg }),
  importPackage: (pkg: unknown) => http.post<{ created: { kind: string; code: string; version?: number }[]; integrationSecrets: { code: string; secret: string }[]; warnings: string[]; next: string }>(
    '/lowcode/package/import', { package: pkg, confirm: true }),
  updateVendorCustom: (vendorId: string, customFields: Record<string, unknown>) => http.patch<{ custom: unknown }>(`/vendors/${vendorId}/custom-fields`, { customFields }),
};
