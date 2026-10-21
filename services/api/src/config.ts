// Environment configuration (docs/BUILD-SPEC.md §4). Fails fast with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionProblems, tfEnvOf, TF_ENVS, type TfEnv } from './ops/checks.js';
import { DEMO_ENTITIES, ENTITY_ID_RE, TENANCY_MODES, type DemoEntity, type TenancyMode } from './tenancy.js';

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(API_ROOT, '..', '..');

export interface Config {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  databaseUrl?: string;
  jwtPrivateKeyPem?: string;
  externalOidcIssuer?: string;
  externalOidcAudience?: string;
  bidMasterKey: Buffer;
  auditSigningKey: string;
  seedDemo: boolean;
  demoPassword?: string;
  /** Presenter controls (persona switch, deadline advance). Never enable in production. */
  demoMode: boolean;
  contentStoreType: 'filesystem' | 'filenet';
  corsOrigin?: string;
  webDistDir: string;
  closeJobIntervalMs: number;
  loginRateLimit: number;
  /** AI requests (POST to an AI route) per user and minute; 0 = no limit. */
  aiRateLimit: number;
  /**
   * DOC_AI_AUTO — automatic document intelligence after upload/opening (when Orchestrate is configured):
   * true → also vendor and request-letter uploads (unless the entity setting says otherwise); false → never automatic
   * (manual "Classify with Orchestrate" only); unset → tender documents per template, vendor/letters per entity setting.
   */
  docAiAuto: boolean | null;
  /** FILENET_AI_PROPERTIES — write TF_DocType / TF_ExpiryDate / TF_AIReviewed to the stored document on acceptance. */
  docAiProperties: boolean;
  // --- insight ---
  /** PUBLIC_BOARD_RATE_LIMIT_PER_MIN — requests per minute per client IP to the public tender board and its feeds. */
  publicBoardRateLimit: number;
  /** Notifications (SMTP / SMS HTTP), background jobs and delivery retries — see loadNotifyConfig below. */
  notify: NotifyConfig;
  // --- security (SEC workstream) ---
  /** MFA_ENC_KEY — base64 of 32 bytes; encrypts TOTP secrets at rest. Unset → derived from AUDIT_SIGNING_KEY (HKDF). */
  mfaEncKey?: string;
  /** STAFF_NETWORK_BREAK_GLASS=true — emergency switch: the staff network allowlist is not enforced (shown on the admin page). */
  staffNetworkBreakGlass: boolean;
  /** OIDC_ALLOW_HTTP=true — allow a plain-http OIDC issuer other than localhost (never in production). */
  oidcAllowHttp: boolean;
  // --- ops ---
  /** TF_ENV — development (default) | demo | test | production. production enforces ops/checks.ts at start-up. */
  tfEnv: TfEnv;
  /** SHUTDOWN_DELAY_MS — on SIGTERM, keep serving (answering /ready with 503) this long before closing the listener. */
  shutdownDelayMs: number;
  /** SHUTDOWN_TIMEOUT_MS — after this, connections still open are closed and the process exits. */
  shutdownTimeoutMs: number;
  // --- harden ---
  /** LOGIN_LOCKOUT_ATTEMPTS / _WINDOW_MIN / _MINUTES — N failed password/MFA attempts within the window lock the
   *  sign-in name for M minutes (attempts 0 = lockout off). */
  loginLockout: { attempts: number; windowMinutes: number; lockMinutes: number };
  /** TRUST_PROXY — Express 'trust proxy' (default false: X-Forwarded-For is ignored). A hop count such as 1 behind the
   *  OpenShift router, or a comma-separated list of proxy addresses / CIDRs / loopback|linklocal|uniquelocal. */
  trustProxy: false | number | string[];
  // --- deployment model (docs/DEPLOYMENT-MODEL.md) ---
  /** TENANCY_MODE — dedicated (default: one installation = one government entity) | shared (several entities). */
  tenancyMode: TenancyMode;
  /** ENTITY_ID — the entity a dedicated installation serves (required with TF_ENV=production). After start-up
   *  (createApp) this holds the resolved entity, which may come from the database when ENTITY_ID is unset. */
  entityId?: string;
  /** DEMO_ENTITY — the demo entity seeded in dedicated mode (kea | gcia | moi; default ENTITY_ID or kea). */
  demoEntity: DemoEntity;
}

export class ConfigError extends Error {}

/** Load `.env` from the repo root (if present) without overriding variables already set. */
export function loadDotEnv(file = path.join(REPO_ROOT, '.env')): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const problems: string[] = [];

  const bidKeyRaw = opt(env.BID_MASTER_KEY);
  let bidMasterKey = Buffer.alloc(0);
  if (!bidKeyRaw) missing.push('BID_MASTER_KEY');
  else {
    bidMasterKey = Buffer.from(bidKeyRaw, 'base64');
    if (bidMasterKey.length !== 32) problems.push('BID_MASTER_KEY must be base64 of exactly 32 bytes (run `npm run gen-keys`)');
  }
  const auditSigningKey = opt(env.AUDIT_SIGNING_KEY);
  if (!auditSigningKey) missing.push('AUDIT_SIGNING_KEY');
  else if (auditSigningKey.length < 16) problems.push('AUDIT_SIGNING_KEY must be at least 16 characters');

  const seedDemo = (env.SEED_DEMO ?? 'false').trim().toLowerCase() === 'true';
  const demoPassword = opt(env.DEMO_PASSWORD);
  if (seedDemo && !demoPassword) missing.push('DEMO_PASSWORD (required because SEED_DEMO=true)');

  const cst = (opt(env.CONTENT_STORE_TYPE) ?? 'filesystem').toLowerCase();
  if (cst !== 'filesystem' && cst !== 'filenet') problems.push(`CONTENT_STORE_TYPE must be 'filesystem' or 'filenet' (got '${cst}')`);

  const issuer = opt(env.EXTERNAL_OIDC_ISSUER);
  const audience = opt(env.EXTERNAL_OIDC_AUDIENCE);
  if (issuer && !audience) missing.push('EXTERNAL_OIDC_AUDIENCE (required because EXTERNAL_OIDC_ISSUER is set)');

  // --- security (SEC workstream) ---
  const mfaEncKey = opt(env.MFA_ENC_KEY);
  if (mfaEncKey && Buffer.from(mfaEncKey, 'base64').length !== 32) problems.push('MFA_ENC_KEY must be base64 of exactly 32 bytes');

  // --- ops --- TF_ENV=production: refuse to start on any production-safety finding (all reasons listed at once).
  const tfEnv = tfEnvOf(env);
  if (!tfEnv) problems.push(`TF_ENV must be one of ${TF_ENVS.join(', ')}`);
  const refused = productionProblems(env);
  problems.push(...refused);
  // --- harden ---
  const lockNum = (name: string, def: number, min: number) => {
    const raw = opt(env[name]);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > 10_000) { problems.push(`${name} must be an integer between ${min} and 10000 (got '${raw}')`); return def; }
    return n;
  };
  const loginLockout = {
    attempts: lockNum('LOGIN_LOCKOUT_ATTEMPTS', 5, 0),
    windowMinutes: lockNum('LOGIN_LOCKOUT_WINDOW_MIN', 15, 1),
    lockMinutes: lockNum('LOGIN_LOCKOUT_MINUTES', 15, 1),
  };
  const trustProxy = parseTrustProxy(opt(env.TRUST_PROXY), problems);
  // --- deployment model ---
  const tenancy = parseTenancy(env, seedDemo, problems);

  if (missing.length || problems.length) {
    const lines = [
      ...missing.map((m) => `  - missing required environment variable: ${m}`),
      ...problems.map((p) => `  - ${p}`),
    ];
    const head = refused.length ? 'TenderFlow refuses to start with TF_ENV=production' : 'TenderFlow configuration error';
    throw new ConfigError(`${head}:\n${lines.join('\n')}\n(run \`npm run config:check\` for the full report)`);
  }

  const port = Number(opt(env.PORT) ?? 4000);
  const dataDir = path.resolve(REPO_ROOT, opt(env.DATA_DIR) ?? 'data'); // relative paths are relative to the repo root
  const pem = opt(env.JWT_PRIVATE_KEY_PEM)?.replace(/\\n/g, '\n');
  return {
    port,
    publicBaseUrl: (opt(env.PUBLIC_BASE_URL) ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir,
    databaseUrl: opt(env.DATABASE_URL),
    jwtPrivateKeyPem: pem,
    externalOidcIssuer: issuer,
    externalOidcAudience: audience,
    bidMasterKey,
    auditSigningKey: auditSigningKey!,
    seedDemo,
    demoPassword,
    demoMode: (env.DEMO_MODE ?? 'false').trim().toLowerCase() === 'true',
    contentStoreType: cst as 'filesystem' | 'filenet',
    corsOrigin: opt(env.CORS_ORIGIN),
    webDistDir: path.resolve(REPO_ROOT, opt(env.WEB_DIST_DIR) ?? path.join('apps', 'web', 'dist')),
    closeJobIntervalMs: Number(opt(env.CLOSE_JOB_INTERVAL_MS) ?? 60_000),
    loginRateLimit: Number(opt(env.LOGIN_RATE_LIMIT_PER_MIN) ?? 30),
    aiRateLimit: Math.max(0, Number(opt(env.AI_RATE_LIMIT_PER_MIN) ?? 20) || 0),
    docAiAuto: opt(env.DOC_AI_AUTO) === undefined ? null : ['true', '1', 'yes'].includes(opt(env.DOC_AI_AUTO)!.toLowerCase()),
    docAiProperties: ['true', '1', 'yes'].includes((opt(env.FILENET_AI_PROPERTIES) ?? 'false').toLowerCase()),
    // --- security (SEC workstream) ---
    mfaEncKey,
    staffNetworkBreakGlass: (opt(env.STAFF_NETWORK_BREAK_GLASS) ?? 'false').toLowerCase() === 'true',
    oidcAllowHttp: (opt(env.OIDC_ALLOW_HTTP) ?? 'false').toLowerCase() === 'true',
    // --- harden ---
    loginLockout,
    trustProxy,
    // --- insight ---
    publicBoardRateLimit: Math.max(1, Number(opt(env.PUBLIC_BOARD_RATE_LIMIT_PER_MIN) ?? 60) || 60),
    notify: loadNotifyConfig(env),
    // --- ops ---
    tfEnv: tfEnv!,
    shutdownDelayMs: nonNegative(opt(env.SHUTDOWN_DELAY_MS), 0),
    shutdownTimeoutMs: nonNegative(opt(env.SHUTDOWN_TIMEOUT_MS), 20_000),
    // --- deployment model ---
    ...tenancy,
  };
}

/**
 * TENANCY_MODE / ENTITY_ID / DEMO_ENTITY. Default mode is dedicated everywhere (one installation per entity); the test
 * suite and KBM's multi-entity demo set TENANCY_MODE=shared explicitly. ENTITY_ID is required in production when
 * dedicated (the production rule lives in ops/checks.ts so `config:check` shows it too); outside production it may be
 * left empty and is then taken from the database at start-up (see tenancy.ts resolveTenancy).
 */
export function parseTenancy(env: NodeJS.ProcessEnv, seedDemo: boolean, problems: string[]):
  { tenancyMode: TenancyMode; entityId?: string; demoEntity: DemoEntity } {
  const rawMode = (opt(env.TENANCY_MODE) ?? 'dedicated').toLowerCase();
  let tenancyMode: TenancyMode = 'dedicated';
  if ((TENANCY_MODES as readonly string[]).includes(rawMode)) tenancyMode = rawMode as TenancyMode;
  else problems.push(`TENANCY_MODE must be one of ${TENANCY_MODES.join(', ')} (got '${rawMode.slice(0, 20)}')`);
  const rawEntity = opt(env.ENTITY_ID)?.toLowerCase();
  let entityId: string | undefined;
  if (rawEntity !== undefined) {
    if (ENTITY_ID_RE.test(rawEntity)) entityId = rawEntity;
    else problems.push(`ENTITY_ID must be an entity code of 2-40 characters a-z, 0-9, _ or - (got '${rawEntity.slice(0, 40)}')`);
  }
  if (tenancyMode === 'shared' && entityId) problems.push('ENTITY_ID is only used with TENANCY_MODE=dedicated; remove it or set TENANCY_MODE=dedicated');
  const rawDemo = opt(env.DEMO_ENTITY)?.toLowerCase();
  let demoEntity: DemoEntity = entityId && (DEMO_ENTITIES as readonly string[]).includes(entityId) ? entityId as DemoEntity : 'kea';
  if (rawDemo !== undefined) {
    if ((DEMO_ENTITIES as readonly string[]).includes(rawDemo)) demoEntity = rawDemo as DemoEntity;
    else problems.push(`DEMO_ENTITY must be one of ${DEMO_ENTITIES.join(', ')} (got '${rawDemo.slice(0, 20)}')`);
  }
  if (tenancyMode === 'dedicated' && seedDemo && entityId && entityId !== demoEntity)
    problems.push(`SEED_DEMO=true in a dedicated installation seeds DEMO_ENTITY (${demoEntity}), but ENTITY_ID is '${entityId}': `
      + `set both to the same demo entity (${DEMO_ENTITIES.join(' | ')})`);
  return { tenancyMode, entityId, demoEntity };
}

// --- ops ---
const nonNegative = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && Number.isFinite(n) && n >= 0 ? n : d; };
// --- harden --- TRUST_PROXY → app.set('trust proxy', …). 'true' (trust every hop) is refused: the client could then
// choose its own address by sending X-Forwarded-For.
const PROXY_NAMES = ['loopback', 'linklocal', 'uniquelocal'];
export function parseTrustProxy(raw: string | undefined, problems: string[] = []): false | number | string[] {
  if (raw === undefined || ['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
  if (/^[1-9]\d?$/.test(raw)) return Number(raw);
  if (raw.toLowerCase() === 'true') {
    problems.push("TRUST_PROXY=true would let any client choose its address; use the number of proxy hops (e.g. 1) or the proxy addresses");
    return false;
  }
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  const bad = parts.filter((p) => !PROXY_NAMES.includes(p.toLowerCase()) && !/^[0-9a-f.:]+(\/\d{1,3})?$/i.test(p));
  if (!parts.length || bad.length) {
    problems.push(`TRUST_PROXY must be off, a hop count (1-99) or a comma list of proxy addresses/CIDRs/${PROXY_NAMES.join('/')} (bad: ${bad.join(', ') || raw})`);
    return false;
  }
  return parts.map((p) => (PROXY_NAMES.includes(p.toLowerCase()) ? p.toLowerCase() : p));
}

// --- notify --- (docs/NOTIFICATIONS-AND-ESCALATION.md)
export interface NotifyConfig {
  /** SMTP e-mail channel; configured when SMTP_HOST and SMTP_FROM are set. */
  smtp: { host?: string; port: number; secure: boolean; user?: string; pass?: string; from?: string; rejectUnauthorized: boolean };
  /** Generic HTTP SMS adapter; configured when SMS_HTTP_URL is set. */
  sms: { url?: string; method: string; authHeader?: string; contentType: string; bodyTemplate: string; sender?: string; messageIdPath?: string; timeoutMs: number };
  /** Language of SMS texts and of the first part of bilingual e-mails ('ar' | 'en'). */
  defaultLang: 'ar' | 'en';
  /** Background jobs on/off (default on, off under `node --test` unless SCHEDULER_ENABLED=true). */
  schedulerEnabled: boolean;
  deliveryJobMs: number;
  escalationJobMs: number;
  /** First retry delay; the n-th retry waits base × 2^(n-1). */
  retryBaseMs: number;
  /** Send queued e-mail / SMS right after the transaction that created them (in addition to the job). */
  sendImmediately: boolean;
}

export function loadNotifyConfig(env: NodeJS.ProcessEnv): NotifyConfig {
  const yes = (v: string | undefined, d: boolean) => (opt(v) === undefined ? d : ['true', '1', 'yes'].includes(opt(v)!.toLowerCase()));
  const num = (v: string | undefined, d: number) => { const n = Number(opt(v)); return Number.isFinite(n) && n > 0 ? n : d; };
  const secure = yes(env.SMTP_SECURE, false);
  return {
    smtp: { host: opt(env.SMTP_HOST), port: num(env.SMTP_PORT, secure ? 465 : 587), secure, user: opt(env.SMTP_USER), pass: opt(env.SMTP_PASS),
      from: opt(env.SMTP_FROM), rejectUnauthorized: yes(env.SMTP_TLS_REJECT_UNAUTHORIZED, true) },
    sms: { url: opt(env.SMS_HTTP_URL), method: (opt(env.SMS_HTTP_METHOD) ?? 'POST').toUpperCase(), authHeader: opt(env.SMS_HTTP_AUTH_HEADER),
      contentType: opt(env.SMS_HTTP_CONTENT_TYPE) ?? 'application/json',
      bodyTemplate: opt(env.SMS_HTTP_BODY_TEMPLATE) ?? '{"to":"{to}","from":"{sender}","text":"{text}"}',
      sender: opt(env.SMS_SENDER), messageIdPath: opt(env.SMS_HTTP_MESSAGE_ID_PATH), timeoutMs: num(env.SMS_HTTP_TIMEOUT_MS, 15_000) },
    defaultLang: opt(env.NOTIFY_DEFAULT_LANG) === 'en' ? 'en' : 'ar',
    schedulerEnabled: yes(env.SCHEDULER_ENABLED, !process.env.NODE_TEST_CONTEXT),
    deliveryJobMs: num(env.NOTIFY_DELIVERY_JOB_MS, 30_000),
    escalationJobMs: num(env.APPROVAL_ESCALATION_JOB_MS, 300_000),
    retryBaseMs: num(env.NOTIFY_RETRY_BASE_MS, 60_000),
    sendImmediately: yes(env.NOTIFY_SEND_IMMEDIATELY, true),
  };
}
