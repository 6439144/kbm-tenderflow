// Test helpers: start the real app on a random port with PGlite in a temp DATA_DIR and the filesystem store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createApp, type AppHandle } from '../src/app.js';
import { createTenant, createUser } from '../src/services/identity.js';
import { SYSTEM_ACTOR } from '../src/services/audit.js';

export const BID_MASTER_KEY = crypto.randomBytes(32).toString('base64');
export const AUDIT_SIGNING_KEY = crypto.randomBytes(32).toString('hex');
export const PASSWORD = 'Test-Passw0rd!';

export interface Running { handle: AppHandle; base: string; dataDir: string; stop(): Promise<void> }

export async function startApp(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-test-')), extraEnv: Record<string, string> = {}): Promise<Running> {
  const config = loadConfig({
    BID_MASTER_KEY, AUDIT_SIGNING_KEY, DATA_DIR: dataDir, SEED_DEMO: 'false', CONTENT_STORE_TYPE: 'filesystem',
    PUBLIC_BASE_URL: 'http://tenderflow.test', LOGIN_RATE_LIMIT_PER_MIN: '1000', AI_RATE_LIMIT_PER_MIN: '0', WEB_DIST_DIR: path.join(dataDir, 'no-web'),
    // The suite creates several entities per app (cross-entity isolation tests): shared mode unless a test says otherwise.
    // Dedicated mode (one installation = one entity, the product default) is covered by dedicated-mode.test.ts.
    TENANCY_MODE: 'shared', ...extraEnv,
  });
  const handle = await createApp(config);
  const server = handle.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    handle, base, dataDir,
    async stop() { await new Promise<void>((r) => server.close(() => r())); await handle.close(); },
  };
}

export async function makeTenant(run: Running, id: string) {
  await createTenant(run.handle.ctx, { id, nameEn: `Tenant ${id} (fictitious)`, nameAr: `جهة ${id} (وهمية)` });
}

export async function makeUser(run: Running, tenantId: string, username: string, roles: string[]) {
  return createUser(run.handle.ctx, SYSTEM_ACTOR, { tenantId, username, password: PASSWORD, displayName: `${username} (test)`, roles });
}

export interface Res { status: number; body: any; text: string; headers: Headers }

export async function api(run: Running, method: string, p: string, opts: { token?: string; json?: unknown; form?: FormData } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: any;
  if (opts.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.form) body = opts.form;
  const res = await fetch(run.base + p, { method, headers, body });
  const text = await res.text();
  let parsed: any = undefined;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

export async function login(run: Running, tenantId: string, username: string, password = PASSWORD): Promise<string> {
  const r = await api(run, 'POST', '/api/v1/auth/login', { json: { tenantId, username, password } });
  if (r.status !== 200) throw new Error(`login ${tenantId}/${username} failed: ${r.status} ${r.text}`);
  return r.body.token;
}

export function fileForm(fields: Record<string, { name: string; content: string | Buffer; type?: string } | string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') f.append(k, v);
    else f.append(k, new Blob([v.content], { type: v.type ?? 'text/plain' }), v.name);
  }
  return f;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

export const CRITERIA = [
  { key: 'technical', nameEn: 'Technical', nameAr: 'فني', weight: 60 },
  { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 40 },
];
export const REQUIRED_DOCS = [{ key: 'CR', nameEn: 'Commercial registration', nameAr: 'السجل التجاري' }];

export function tenderBody(deadlineMs: number, extra: Record<string, unknown> = {}) {
  return {
    titleEn: 'Test Tender', titleAr: 'مناقصة اختبار', category: 'IT', estimatedBudget: 1000, currency: 'KWD',
    submissionDeadline: new Date(Date.now() + deadlineMs).toISOString(), criteria: CRITERIA, requiredDocuments: REQUIRED_DOCS, ...extra,
  };
}
