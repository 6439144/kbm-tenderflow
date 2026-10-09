// Environment configuration (docs/BUILD-SPEC.md §4). Fails fast with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /**
   * DOC_AI_AUTO — automatic document intelligence after upload/opening (when Orchestrate is configured):
   * true → also vendor and request-letter uploads (unless the entity setting says otherwise); false → never automatic
   * (manual "Classify with Orchestrate" only); unset → tender documents per template, vendor/letters per entity setting.
   */
  docAiAuto: boolean | null;
  /** FILENET_AI_PROPERTIES — write TF_DocType / TF_ExpiryDate / TF_AIReviewed to the stored document on acceptance. */
  docAiProperties: boolean;
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

  if (missing.length || problems.length) {
    const lines = [
      ...missing.map((m) => `  - missing required environment variable: ${m}`),
      ...problems.map((p) => `  - ${p}`),
    ];
    throw new ConfigError(`TenderFlow configuration error:\n${lines.join('\n')}`);
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
    docAiAuto: opt(env.DOC_AI_AUTO) === undefined ? null : ['true', '1', 'yes'].includes(opt(env.DOC_AI_AUTO)!.toLowerCase()),
    docAiProperties: ['true', '1', 'yes'].includes((opt(env.FILENET_AI_PROPERTIES) ?? 'false').toLowerCase()),
  };
}
