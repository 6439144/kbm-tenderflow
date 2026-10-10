// Dev-only: start the built app in-process as a DEDICATED installation (one entity, DEMO_ENTITY seeded) and take
// screenshots of the screens that differ from the shared edition: login, supplier registration, public tender board,
// an officer dashboard, the vendor portal and the admin entity settings. Then stop.
// Usage: npx tsx scripts/dev/dedicated-shots.mts <outDir> [en|ar] [kea|gcia|moi]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { loadConfig, REPO_ROOT } from '../../services/api/src/config.js';
import { createApp } from '../../services/api/src/app.js';

const out = process.argv[2] ?? '/tmp/dedicated-shots';
const lang = (process.argv[3] ?? 'en') as 'en' | 'ar';
const entity = process.argv[4] ?? 'kea';
fs.mkdirSync(out, { recursive: true });
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-ded-shots-'));
const PASSWORD = 'Demo-Shots-2026!';
const config = loadConfig({
  BID_MASTER_KEY: crypto.randomBytes(32).toString('base64'), AUDIT_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
  DATA_DIR: dataDir, SEED_DEMO: 'true', DEMO_PASSWORD: PASSWORD, DEMO_MODE: 'false', CONTENT_STORE_TYPE: 'filesystem',
  PUBLIC_BASE_URL: 'http://localhost', WEB_DIST_DIR: path.join(REPO_ROOT, 'apps/web/dist'), LOGIN_RATE_LIMIT_PER_MIN: '1000',
  TENANCY_MODE: 'dedicated', DEMO_ENTITY: entity,
});
const handle = await createApp(config);
const server = handle.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log('entities in the database:', (await handle.ctx.db.query<{ id: string }>('SELECT id FROM tenants')).map((r) => r.id).join(', '));

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const init = (extra?: { token: string; user: unknown; tenant: unknown }) => [lang, extra ? JSON.stringify(extra) : ''] as const;
const newPage = async (session?: { token: string; user: unknown; tenant: unknown }) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: lang === 'ar' ? 'ar-KW' : 'en-GB' });
  await ctx.addInitScript(([lg, sess]: readonly [string, string]) => {
    (window as any).__name = (window as any).__name || ((f: unknown) => f);
    localStorage.setItem('tf.lang', lg);
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) { return k.startsWith('tf.tour.seen.') ? '1' : orig.call(this, k); };
    if (sess) {
      const s = JSON.parse(sess);
      sessionStorage.setItem('tf.token', s.token); sessionStorage.setItem('tf.user', JSON.stringify(s.user)); sessionStorage.setItem('tf.tenant', JSON.stringify(s.tenant));
    }
  }, init(session));
  const p = await ctx.newPage();
  p.on('pageerror', (e: Error) => console.error('[pageerror]', e.message));
  p.on('console', (m: any) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  return p;
};
const signIn = async (username: string) => {
  // no tenantId: a dedicated installation knows its entity
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const s = await r.json() as { token: string; user: unknown };
  const t = (await (await fetch(`${base}/api/v1/public/tenants`)).json() as unknown[])[0];
  return { ...s, tenant: t };
};
const shot = async (p: any, name: string, full = true) => { await p.waitForTimeout(900); await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: full }); console.log('shot', name); };

try {
  const anon = await newPage();
  await anon.goto(`${base}/login`); await shot(anon, '01-login', false);
  await anon.goto(`${base}/register`); await shot(anon, '02-vendor-registration');
  await anon.goto(`${base}/tenders`); await shot(anon, '03-public-board');

  const officer = await newPage(await signIn(entity === 'moi' ? 'tenderdept' : 'officer'));
  await officer.goto(`${base}/procurement`); await shot(officer, '04-officer-dashboard');

  const vendor = await newPage(await signIn('vendor1'));
  await vendor.goto(`${base}/vendor`); await shot(vendor, '05-vendor-portal');

  const admin = await newPage(await signIn('admin'));
  await admin.goto(`${base}/admin/entity`); await shot(admin, '06-admin-entity-settings');
  await admin.goto(`${base}/admin/jobs`); await shot(admin, '07-admin-jobs');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await handle.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
