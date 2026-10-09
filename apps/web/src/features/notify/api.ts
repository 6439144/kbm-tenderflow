// NOTIFY client (services/api/src/features/notify.ts): notification templates, delivery log, background jobs,
// approval service levels (SLA) and the tender reject path. Every call is a real API call; nothing is simulated.
import { http } from '../../api';

export type Channel = 'IN_APP' | 'EMAIL' | 'SMS';
export const OPTIONAL_CHANNELS: Channel[] = ['EMAIL', 'SMS'];
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED_NOT_CONFIGURED' | 'SKIPPED_NO_ADDRESS';
export const DELIVERY_STATUSES: DeliveryStatus[] = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED_NOT_CONFIGURED', 'SKIPPED_NO_ADDRESS'];

export type ChannelStatus = Record<Channel, { configured: boolean; detail: string }>;

export interface NotificationTemplate {
  code: string;
  audience: 'VENDOR' | 'STAFF';
  channels: Channel[];
  enabled: boolean;
  subjectEn: string;
  subjectAr: string;
  bodyEn: string;
  bodyAr: string;
  source: 'BRD' | 'SYSTEM' | 'CUSTOM';
  mandatory: boolean;
  placeholders: string[];
  isDefaultText: boolean;
  updatedBy: string | null;
  updatedAt: string;
}
export interface TemplateTexts {
  subjectEn: string;
  subjectAr: string;
  bodyEn: string;
  bodyAr: string;
}
export interface TemplatePreview {
  en: { subject: string; body: string };
  ar: { subject: string; body: string };
  unknownPlaceholders: string[];
  placeholders: string[];
  sampleValues: Record<string, unknown>;
}
export interface DeliveryRow {
  id: string;
  notificationId: string | null;
  templateCode: string;
  channel: Channel;
  recipientUserId: string | null;
  recipientVendorId: string | null;
  recipientLabel: string | null;
  address: string | null;
  lang: 'en' | 'ar';
  subject: string;
  status: DeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}
export interface DeliveryLog {
  channels: ChannelStatus;
  counts: { status: DeliveryStatus; channel: Channel; n: number }[];
  templateCodes: string[];
  items: DeliveryRow[];
}
export interface TestSendResult {
  templateCode: string;
  deliveries: { id: string; channel: Channel; status: DeliveryStatus; address: string | null; error: string | null; providerMessageId: string | null; attempts: number }[];
}
export interface Job {
  name: string;
  labelEn: string;
  labelAr: string;
  everyMs: number;
  scheduled: boolean;
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: 'OK' | 'ERROR' | null;
  lastResult: Record<string, unknown> | null;
  lastError: string | null;
  runCount: number;
}
export interface JobRunResult {
  name: string;
  status: 'OK' | 'ERROR' | 'SKIPPED_RUNNING';
  result?: Record<string, unknown> | null;
  error?: string;
  durationMs?: number;
}
export interface SlaSettings {
  defaultDueHours: number | null;
  escalateTo: string;
  remindBeforeHours: number | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}
export type SlaState = 'NO_SLA' | 'ON_TIME' | 'DUE_SOON' | 'OVERDUE';
export type Gate = 'PUBLISH' | 'AWARD' | 'REQUEST';
export interface SlaItem {
  subjectType: 'TENDER' | 'REQUEST';
  subjectId: string;
  gate: Gate;
  reference: string;
  titleEn: string;
  titleAr: string;
  level: number;
  of: number;
  role: string;
  labelEn: string;
  labelAr: string;
  nextRole: string | null;
  waitingSince: string;
  dueHours: number | null;
  dueAt: string | null;
  state: SlaState;
  overdueMs: number;
  dueInMs: number;
  path: string;
  reminder: { at: string; notified: number } | null;
  escalation: { at: string; escalatedTo: string | null; notified: number } | null;
}
export interface OverdueSummary {
  sla: { defaultDueHours: number | null; escalateTo: string; remindBeforeHours: number | null };
  active: boolean;
  waiting: number;
  dueSoon: number;
  items: SlaItem[];
}
export interface Contact {
  email: string | null;
  phone: string | null;
  updatedAt?: string | null;
}

const enc = encodeURIComponent;
function qs(p: Record<string, string | undefined>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const notifyApi = {
  templates: () => http.get<{ channels: ChannelStatus; templates: NotificationTemplate[] }>('/admin/notification-templates'),
  preview: (code: string, texts: Partial<TemplateTexts>) => http.post<TemplatePreview>(`/admin/notification-templates/${enc(code)}/preview`, texts),
  updateTemplate: (code: string, b: Partial<TemplateTexts> & { channels?: Channel[]; enabled?: boolean; reset?: boolean }) =>
    http.patch<NotificationTemplate>(`/admin/notification-templates/${enc(code)}`, b),
  sendTest: (code: string) => http.post<TestSendResult>(`/admin/notification-templates/${enc(code)}/test`, {}),

  deliveries: (f: { status?: string; channel?: string; templateCode?: string; q?: string }) => http.get<DeliveryLog>(`/admin/notification-deliveries${qs(f)}`),
  retryDelivery: (id: string) => http.post<{ ok: true }>(`/admin/notification-deliveries/${enc(id)}/retry`, {}),

  myContact: () => http.get<Contact>('/notifications/contact'),
  setMyContact: (c: { email: string | null; phone: string | null }) => http.put<Contact>('/notifications/contact', c),

  jobs: () => http.get<Job[]>('/admin/jobs'),
  runJob: (name: string) => http.post<JobRunResult>(`/admin/jobs/${enc(name)}/run`, {}),

  sla: () => http.get<SlaSettings>('/admin/approval-sla'),
  saveSla: (s: { defaultDueHours: number | null; escalateTo: string; remindBeforeHours: number | null }) => http.put<SlaSettings>('/admin/approval-sla', s),
  overdue: () => http.get<OverdueSummary>('/approvals/overdue'),
  slaFor: (subjectId: string) => http.get<{ items: SlaItem[] }>(`/approvals/sla?subjectId=${enc(subjectId)}`),

  rejectTender: (id: string, reason: string) => http.post<unknown>(`/tenders/${enc(id)}/reject`, { reason }),
};
