// SEC workstream: client for the identity, access and content-protection API (services/api/src/features/security.ts).
// Every call is a real request; nothing here fabricates data.
import { http, type Role, type User } from '../../api';

export type MfaPolicy = 'OFF' | 'OPTIONAL' | 'REQUIRED';
export type ContentMode = 'OFF' | 'VIEW_ONLY' | 'WATERMARKED_DOWNLOAD';
export type NetworkBasis = 'PREMISES_NETWORK' | 'VPN_ADDRESS_POOL' | 'PREMISES_AND_VPN';
export const MFA_POLICIES: MfaPolicy[] = ['OFF', 'OPTIONAL', 'REQUIRED'];
export const CONTENT_MODES: ContentMode[] = ['OFF', 'VIEW_ONLY', 'WATERMARKED_DOWNLOAD'];
export const NETWORK_BASES: NetworkBasis[] = ['PREMISES_NETWORK', 'VPN_ADDRESS_POOL', 'PREMISES_AND_VPN'];

export interface StaffNetwork { mode: 'OFF' | 'ALLOWLIST'; cidrs: string[]; trustProxyHeader: boolean; basis: NetworkBasis }
export interface OidcMapping { group: string; roles: Role[] }
export interface OidcConfig {
  enabled: boolean;
  displayNameEn: string;
  displayNameAr: string;
  issuer: string;
  clientId: string;
  clientSecretEnv: string;
  scopes: string;
  groupsClaim: string;
  usernameClaim: string;
  mappings: OidcMapping[];
  provisioning: 'JIT_FROM_GROUPS' | 'ADMIN_CREATED';
  clientSecretConfigured?: boolean;
}
export interface SecuritySettings {
  mfaVendors: MfaPolicy;
  mfaStaff: MfaPolicy;
  staffNetwork: StaffNetwork;
  contentProtection: ContentMode | null;
  oidc: OidcConfig | null;
  updatedAt: string | null;
  updatedBy: string | null;
  sso?: { redirectUri: string };
  breakGlass?: boolean;
  changed?: string[];
}
export interface NetworkStatus {
  ip: string;
  socketAddress: string | null;
  forwardedFor: string | null;
  mode: 'OFF' | 'ALLOWLIST';
  basis: NetworkBasis;
  trustProxyHeader: boolean;
  inside: boolean;
  insideList: boolean;
  breakGlass: boolean;
}
export interface SsoTest {
  ok: boolean; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; redirectUri: string;
  clientSecretConfigured: boolean; issuerMatches: boolean;
}

export interface LoginResult {
  token?: string;
  user?: User;
  mfaRequired?: boolean;
  enrolRequired?: boolean;
  mfaToken?: string;
  recoveryCodesLeft?: number;
  recoveryCodes?: string[];
}
export interface EnrolStart { otpauthUri: string; manualKey: string; qrDataUrl: string; algorithm: string; digits: number; periodSeconds: number }
export interface MfaStatus { policy: MfaPolicy; status: 'ACTIVE' | 'PENDING' | 'NOT_ENROLLED'; enrolledAt: string | null; recoveryCodesLeft: number; lockedUntil: string | null }

export interface Account extends User {
  kind: 'STAFF' | 'VENDOR';
  vendor: { id: string; legalNameEn: string | null; legalNameAr: string | null; status: string | null } | null;
  mfa: 'ACTIVE' | 'PENDING' | 'NOT_ENROLLED';
  mfaLocked: boolean;
  lastLoginAt: string | null;
  authSource: 'LOCAL' | 'OIDC';
  disabledAt: string | null;
  isSelf: boolean;
}
export interface RoleInfo { role: Role; kind: 'STAFF' | 'VENDOR'; en: string; ar: string }

export type DownloadState = 'ORIGINAL' | 'WATERMARKED' | 'PURCHASE_REQUIRED' | 'VIEW_ONLY_FORMAT' | 'NONE';
export interface DocAccess {
  documentId: string; mode: ContentMode; source: string; protected: boolean; viewer: boolean; download: DownloadState;
  purchaseRequired: boolean; purchased: boolean;
}
export type ViewPage = { kind: 'text'; text: string } | { kind: 'image'; dataUrl: string } | { kind: 'empty'; reason: string; pageNumber: number };
export interface ViewSession {
  viewId: string; documentId: string; title: string; mimeType: string; mode: ContentMode; source: string; download: DownloadState;
  watermark: { lines: string[]; linesAr: string[] };
  pages: ViewPage[];
}
export type ViewEvent = 'PRINTSCREEN_KEY' | 'PRINT_ATTEMPT' | 'COPY_ATTEMPT' | 'SAVE_ATTEMPT' | 'CONTEXT_MENU';

const enc = encodeURIComponent;

export const secApi = {
  // sign-in steps (public)
  login: (tenantId: string, username: string, password: string) => http.post<LoginResult>('/auth/login', { tenantId, username, password }),
  mfaVerify: (mfaToken: string, body: { code?: string; recoveryCode?: string }) => http.post<LoginResult>('/auth/mfa/verify', { mfaToken, ...body }),
  mfaLoginEnrolStart: (mfaToken: string) => http.post<EnrolStart>('/auth/mfa/enrol/start', { mfaToken }),
  mfaLoginEnrolConfirm: (mfaToken: string, code: string) => http.post<LoginResult>('/auth/mfa/enrol/confirm', { mfaToken, code }),
  ssoStartUrl: (tenantId: string) => `/api/v1/auth/oidc/${enc(tenantId)}/start`,
  ssoExchange: (handoff: string) => http.post<LoginResult>('/auth/oidc/exchange', { handoff }),

  // my second factor
  mfaMe: () => http.get<MfaStatus>('/security/mfa/me'),
  mfaEnrolStart: () => http.post<EnrolStart>('/security/mfa/enrol/start'),
  mfaEnrolConfirm: (code: string) => http.post<{ recoveryCodes: string[] }>('/security/mfa/enrol/confirm', { code }),
  mfaDisable: (code: string) => http.post<{ status: string }>('/security/mfa/disable', { code }),

  // entity settings (admin)
  settings: () => http.get<SecuritySettings>('/security/settings'),
  saveSettings: (body: Partial<SecuritySettings> & { confirmSelfLockout?: boolean; reason?: string }) => http.put<SecuritySettings>('/security/settings', body),
  whoami: () => http.get<NetworkStatus>('/security/network/whoami'),
  checkNetwork: (net: StaffNetwork) => http.post<NetworkStatus>('/security/network/check', net),
  ssoTest: () => http.post<SsoTest>('/security/sso/test'),

  // accounts (admin)
  roles: () => http.get<RoleInfo[]>('/security/roles'),
  users: (kind?: 'STAFF' | 'VENDOR') => http.get<Account[]>(`/security/users${kind ? `?kind=${kind}` : ''}`),
  disable: (id: string, reason: string) => http.post<User>(`/security/users/${enc(id)}/disable`, { reason }),
  enable: (id: string, reason: string) => http.post<User>(`/security/users/${enc(id)}/enable`, { reason }),
  setRoles: (id: string, roles: Role[], reason?: string) => http.put<User>(`/security/users/${enc(id)}/roles`, { roles, reason }),
  amend: (id: string, body: { displayName?: string; password?: string }) => http.patch<User>(`/security/users/${enc(id)}`, body),
  resetMfa: (id: string, reason: string) => http.post<{ status: string }>(`/security/users/${enc(id)}/mfa-reset`, { reason }),

  // content protection
  documentAccess: (ids: string[]) => http.get<DocAccess[]>(`/security/content/documents?ids=${ids.map(enc).join(',')}`),
  openView: (id: string) => http.post<ViewSession>(`/security/content/documents/${enc(id)}/view`),
  viewEvent: (viewId: string, type: ViewEvent) => http.post<{ recorded: boolean }>(`/security/content/views/${enc(viewId)}/events`, { type }),
  watermarkedPath: (id: string) => `/api/v1/security/content/documents/${enc(id)}/download`,
};
