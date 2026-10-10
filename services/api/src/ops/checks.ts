// Configuration checks shared by start-up (production safety, config.ts) and `npm run config:check`.
//
// Every check yields OK / WARN / FAIL with a message that NEVER contains a secret value: secrets are only described
// (present / missing / length / strength), URLs are reduced to scheme + host (+ port / path where harmless).
//
// `kind: 'production'` checks are the production-safety rules: with TF_ENV=production a failing rule is FAIL and the
// API refuses to start (loadConfig lists every reason); in any other environment the same finding is a WARN
// ("would refuse in production") so `config:check` shows what still has to change before go-live.
import crypto from 'node:crypto';

export type CheckLevel = 'OK' | 'WARN' | 'FAIL';
export interface ConfigCheck { id: string; level: CheckLevel; message: string; kind: 'base' | 'production' }

export const TF_ENVS = ['development', 'demo', 'test', 'production'] as const;
export type TfEnv = (typeof TF_ENVS)[number];

/**
 * Names of variables whose values are secret (never printed). `TF_OIDC_SECRET_*` (staff SSO client secrets) are
 * matched by prefix; DATABASE_URL is printed only without its credentials.
 */
export const SECRET_VARS = [
  'BID_MASTER_KEY', 'AUDIT_SIGNING_KEY', 'JWT_PRIVATE_KEY_PEM', 'MFA_ENC_KEY', 'DEMO_PASSWORD', 'FILENET_SERVICE_PASSWORD',
  'WXO_API_KEY', 'SMTP_PASS', 'SMS_HTTP_AUTH_HEADER', 'TF_ENTITY_ADMIN_PASSWORD',
] as const;
export const isSecretVar = (name: string) => (SECRET_VARS as readonly string[]).includes(name) || name.startsWith('TF_OIDC_SECRET_');

const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const yes = (v: string | undefined) => ['true', '1', 'yes'].includes((opt(v) ?? '').toLowerCase());

/** TF_ENV value (default development); `null` when the value is not one of TF_ENVS. */
export function tfEnvOf(env: NodeJS.ProcessEnv): TfEnv | null {
  const v = (opt(env.TF_ENV) ?? 'development').toLowerCase();
  return (TF_ENVS as readonly string[]).includes(v) ? (v as TfEnv) : null;
}

/** scheme://host[:port][/path] — never user, password, query or fragment. */
export function safeUrl(raw: string | undefined): string {
  if (!raw) return '(not set)';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '(not a valid URL)';
  }
}

/** Obvious placeholders copied from templates/docs instead of a generated value. */
const PLACEHOLDER = /change.?me|changeit|replace|placeholder|example|your[-_ ]|<[^>]*>|^(x+|0+|1234.*|secret|password|default|tenderflow|demo|test)$/i;
export const looksLikePlaceholder = (v: string) => PLACEHOLDER.test(v.trim());

/** Fewer distinct symbols than a random value of that length would practically always have. */
function lowEntropy(v: string | Buffer, minDistinct: number): boolean {
  const distinct = typeof v === 'string' ? new Set<string>(v).size : new Set<number>(v).size;
  return distinct < minDistinct;
}

const localhost = (u: URL) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);

export function evaluateConfig(env: NodeJS.ProcessEnv): ConfigCheck[] {
  const tfEnv = tfEnvOf(env);
  const production = tfEnv === 'production';
  const out: ConfigCheck[] = [];
  const ok = (id: string, message: string, kind: ConfigCheck['kind'] = 'base') => out.push({ id, level: 'OK', message, kind });
  const warn = (id: string, message: string, kind: ConfigCheck['kind'] = 'base') => out.push({ id, level: 'WARN', message, kind });
  const fail = (id: string, message: string) => out.push({ id, level: 'FAIL', message, kind: 'base' });
  /** A production-safety rule: FAIL (start-up refused) in production, WARN elsewhere. */
  const rule = (id: string, message: string) =>
    out.push({ id, level: production ? 'FAIL' : 'WARN', message: production ? message : `${message} (would refuse to start with TF_ENV=production)`, kind: 'production' });

  // --- environment ---
  if (tfEnv === null) fail('TF_ENV', `TF_ENV must be one of ${TF_ENVS.join(', ')} (got '${String(env.TF_ENV).slice(0, 20)}')`);
  else ok('TF_ENV', `TF_ENV=${tfEnv}${production ? ' (production safety rules enforced at start-up)' : ''}`);

  // --- keys ---
  const bidRaw = opt(env.BID_MASTER_KEY);
  const auditKey = opt(env.AUDIT_SIGNING_KEY);
  if (!bidRaw) fail('BID_MASTER_KEY', 'BID_MASTER_KEY is missing (run `npm run gen-keys`)');
  else {
    const bytes = Buffer.from(bidRaw, 'base64');
    if (bytes.length !== 32) fail('BID_MASTER_KEY', 'BID_MASTER_KEY must be base64 of exactly 32 bytes (run `npm run gen-keys`)');
    else if (looksLikePlaceholder(bidRaw) || lowEntropy(bytes, 16)) rule('BID_MASTER_KEY', 'BID_MASTER_KEY is a weak or placeholder value (not 32 random bytes); generate one with `npm run gen-keys`');
    else ok('BID_MASTER_KEY', 'BID_MASTER_KEY set (32 bytes, value hidden)');
  }
  if (!auditKey) fail('AUDIT_SIGNING_KEY', 'AUDIT_SIGNING_KEY is missing (run `npm run gen-keys`)');
  else if (auditKey.length < 16) fail('AUDIT_SIGNING_KEY', 'AUDIT_SIGNING_KEY must be at least 16 characters');
  else if (auditKey.length < 32 || looksLikePlaceholder(auditKey) || lowEntropy(auditKey, 10))
    rule('AUDIT_SIGNING_KEY', 'AUDIT_SIGNING_KEY is weak or a placeholder (use at least 32 random characters, e.g. from `npm run gen-keys`)');
  else ok('AUDIT_SIGNING_KEY', `AUDIT_SIGNING_KEY set (${auditKey.length} characters, value hidden)`);
  if (bidRaw && auditKey && bidRaw === auditKey) rule('KEY_REUSE', 'BID_MASTER_KEY and AUDIT_SIGNING_KEY are the same value; use independent keys');

  const pem = opt(env.JWT_PRIVATE_KEY_PEM)?.replace(/\\n/g, '\n');
  if (!pem) rule('JWT_PRIVATE_KEY_PEM', 'JWT_PRIVATE_KEY_PEM is not set: the token signing key would be generated and kept in the database; provide an RSA key (>= 2048 bits) from a Secret');
  else {
    let key: crypto.KeyObject | null = null;
    try { key = crypto.createPrivateKey(pem); } catch { /* reported below */ }
    if (!key) fail('JWT_PRIVATE_KEY_PEM', 'JWT_PRIVATE_KEY_PEM is not a readable PEM private key');
    else if (key.asymmetricKeyType !== 'rsa') fail('JWT_PRIVATE_KEY_PEM', 'JWT_PRIVATE_KEY_PEM must be an RSA private key');
    else {
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
      if (bits < 2048) rule('JWT_PRIVATE_KEY_PEM', `JWT_PRIVATE_KEY_PEM is a ${bits}-bit RSA key; use at least 2048 bits`);
      else ok('JWT_PRIVATE_KEY_PEM', `JWT_PRIVATE_KEY_PEM set (RSA ${bits} bits, value hidden)`);
    }
  }

  const mfa = opt(env.MFA_ENC_KEY);
  if (!mfa) ok('MFA_ENC_KEY', 'MFA_ENC_KEY not set: TOTP secrets are encrypted with a key derived from AUDIT_SIGNING_KEY (HKDF)');
  else {
    const b = Buffer.from(mfa, 'base64');
    if (b.length !== 32) fail('MFA_ENC_KEY', 'MFA_ENC_KEY must be base64 of exactly 32 bytes');
    else if (looksLikePlaceholder(mfa) || lowEntropy(b, 16)) rule('MFA_ENC_KEY', 'MFA_ENC_KEY is a weak or placeholder value (not 32 random bytes)');
    else ok('MFA_ENC_KEY', 'MFA_ENC_KEY set (32 bytes, value hidden)');
  }

  // --- demo switches ---
  if (yes(env.DEMO_MODE)) rule('DEMO_MODE', 'DEMO_MODE=true enables presenter controls (persona switch, deadline advance)');
  else ok('DEMO_MODE', 'DEMO_MODE off');
  const seed = yes(env.SEED_DEMO);
  if (seed) rule('SEED_DEMO', 'SEED_DEMO=true would create fictitious demo entities and users');
  else ok('SEED_DEMO', 'SEED_DEMO off');
  if (seed && !opt(env.DEMO_PASSWORD)) fail('DEMO_PASSWORD', 'DEMO_PASSWORD is required because SEED_DEMO=true');
  else if (opt(env.DEMO_PASSWORD)) rule('DEMO_PASSWORD', 'DEMO_PASSWORD is set (shared password of the demo users; value hidden)');
  else ok('DEMO_PASSWORD', 'DEMO_PASSWORD not set');

  // --- database ---
  const dbUrl = opt(env.DATABASE_URL);
  if (!dbUrl) rule('DATABASE_URL', 'DATABASE_URL is not set: embedded PGlite (single process, no replicas, no managed backups) instead of PostgreSQL');
  else {
    let u: URL | null = null;
    try { u = new URL(dbUrl); } catch { /* below */ }
    if (!u || !/^postgres(ql)?:$/.test(u.protocol)) fail('DATABASE_URL', 'DATABASE_URL must be a postgres:// or postgresql:// URL');
    else ok('DATABASE_URL', `PostgreSQL at ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname} (credentials hidden)`);
  }

  // --- public URL / proxy ---
  const base = opt(env.PUBLIC_BASE_URL);
  let baseUrl: URL | null = null;
  try { baseUrl = base ? new URL(base) : null; } catch { /* below */ }
  if (base && !baseUrl) fail('PUBLIC_BASE_URL', 'PUBLIC_BASE_URL is not a valid URL');
  else if (!baseUrl || baseUrl.protocol !== 'https:') rule('PUBLIC_BASE_URL', `PUBLIC_BASE_URL must be https (got ${base ? safeUrl(base) : 'the default http://localhost'})`);
  else ok('PUBLIC_BASE_URL', `PUBLIC_BASE_URL ${safeUrl(base)}`);
  if (production && opt(env.TRUST_PROXY) === undefined) warn('TRUST_PROXY', 'TRUST_PROXY not set: X-Forwarded-For is ignored, so behind the OpenShift router every client looks like the router; set TRUST_PROXY=1');
  else ok('TRUST_PROXY', `TRUST_PROXY=${opt(env.TRUST_PROXY) ?? 'off (default)'}`);
  if (opt(env.CORS_ORIGIN)?.split(',').some((o) => o.trim() === '*')) warn('CORS_ORIGIN', 'CORS_ORIGIN contains * (any web origin may call the API)', 'production');

  // --- content store ---
  const cst = (opt(env.CONTENT_STORE_TYPE) ?? 'filesystem').toLowerCase();
  if (cst !== 'filesystem' && cst !== 'filenet') fail('CONTENT_STORE_TYPE', `CONTENT_STORE_TYPE must be 'filesystem' or 'filenet' (got '${cst.slice(0, 20)}')`);
  else if (cst === 'filesystem') {
    if (production) warn('CONTENT_STORE_TYPE', 'CONTENT_STORE_TYPE=filesystem: documents are kept on the /data volume, not in IBM FileNet (the system of record)');
    else ok('CONTENT_STORE_TYPE', 'CONTENT_STORE_TYPE=filesystem (DATA_DIR/content)');
  } else {
    const missing = ['FILENET_GRAPHQL_URL', 'FILENET_OBJECT_STORE', 'FILENET_SERVICE_USER', 'FILENET_SERVICE_PASSWORD'].filter((k) => !opt(env[k]));
    if (missing.length) fail('FILENET', `CONTENT_STORE_TYPE=filenet but missing: ${missing.join(', ')}`);
    else {
      let u: URL | null = null;
      try { u = new URL(opt(env.FILENET_GRAPHQL_URL)!); } catch { /* below */ }
      if (!u || !/^https?:$/.test(u.protocol)) fail('FILENET', 'FILENET_GRAPHQL_URL must be an http(s) URL');
      else if (u.username || u.password) fail('FILENET', 'FILENET_GRAPHQL_URL must not contain credentials; use FILENET_SERVICE_USER / FILENET_SERVICE_PASSWORD');
      else if (u.protocol === 'http:' && !yes(env.ALLOW_INSECURE_FILENET))
        rule('FILENET', `FileNet over plain http (${safeUrl(u.href)}): the service password and documents travel unencrypted; use https or set ALLOW_INSECURE_FILENET=true explicitly`);
      else if (u.protocol === 'http:') warn('FILENET', `FileNet over plain http (${safeUrl(u.href)}) allowed by ALLOW_INSECURE_FILENET=true`);
      else ok('FILENET', `FileNet ${safeUrl(u.href)}, object store ${opt(env.FILENET_OBJECT_STORE)} (password hidden)`);
    }
  }

  // --- identity / network ---
  if (yes(env.OIDC_ALLOW_HTTP)) rule('OIDC_ALLOW_HTTP', 'OIDC_ALLOW_HTTP=true allows a plain-http identity provider');
  const issuer = opt(env.EXTERNAL_OIDC_ISSUER);
  if (issuer) {
    let u: URL | null = null;
    try { u = new URL(issuer); } catch { /* below */ }
    if (!u) fail('EXTERNAL_OIDC_ISSUER', 'EXTERNAL_OIDC_ISSUER is not a valid URL');
    else if (u.protocol !== 'https:' && !localhost(u)) rule('EXTERNAL_OIDC_ISSUER', `EXTERNAL_OIDC_ISSUER must be https (${safeUrl(issuer)})`);
    else ok('EXTERNAL_OIDC_ISSUER', `external OIDC issuer ${safeUrl(issuer)}`);
    if (!opt(env.EXTERNAL_OIDC_AUDIENCE)) fail('EXTERNAL_OIDC_AUDIENCE', 'EXTERNAL_OIDC_AUDIENCE is required because EXTERNAL_OIDC_ISSUER is set');
  }
  if (yes(env.STAFF_NETWORK_BREAK_GLASS)) warn('STAFF_NETWORK_BREAK_GLASS', 'STAFF_NETWORK_BREAK_GLASS=true: the staff network allowlist is NOT enforced', 'production');

  // --- integrations (informational) ---
  if (opt(env.WXO_INSTANCE_URL) && opt(env.WXO_API_KEY)) ok('WXO', `watsonx Orchestrate ${safeUrl(env.WXO_INSTANCE_URL)} (API key hidden)`);
  else ok('WXO', 'watsonx Orchestrate not configured: AI features answer "not connected" (503 AI_NOT_CONFIGURED)');
  if (opt(env.SMTP_HOST) && opt(env.SMTP_FROM)) {
    ok('SMTP', `e-mail via ${opt(env.SMTP_HOST)}${opt(env.SMTP_PASS) ? ' (password hidden)' : ''}`);
    if ((opt(env.SMTP_TLS_REJECT_UNAUTHORIZED) ?? 'true').toLowerCase() === 'false') warn('SMTP_TLS', 'SMTP_TLS_REJECT_UNAUTHORIZED=false: the mail relay certificate is not verified', 'production');
  } else ok('SMTP', 'e-mail not configured (deliveries recorded as SKIPPED_NOT_CONFIGURED)');
  if (opt(env.SMS_HTTP_URL)) {
    const u = (() => { try { return new URL(opt(env.SMS_HTTP_URL)!); } catch { return null; } })();
    if (!u) fail('SMS', 'SMS_HTTP_URL is not a valid URL');
    else if (u.protocol !== 'https:') warn('SMS', `SMS gateway over plain http (${safeUrl(u.href)})`, 'production');
    else ok('SMS', `SMS gateway ${safeUrl(u.href)}${opt(env.SMS_HTTP_AUTH_HEADER) ? ' (auth header hidden)' : ''}`);
  } else ok('SMS', 'SMS not configured');
  if (production && (opt(env.SCHEDULER_ENABLED) ?? 'true').toLowerCase() === 'false')
    warn('SCHEDULER_ENABLED', 'SCHEDULER_ENABLED=false: notification retries and approval escalation do not run on this instance');
  return out;
}

/** Production-safety reasons to refuse start-up (empty unless TF_ENV=production). */
export function productionProblems(env: NodeJS.ProcessEnv): string[] {
  if (tfEnvOf(env) !== 'production') return [];
  return evaluateConfig(env).filter((c) => c.kind === 'production' && c.level === 'FAIL').map((c) => c.message);
}
