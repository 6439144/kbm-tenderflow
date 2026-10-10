// Dev-only: start the built app in-process with demo data, take screenshots of the Process Studio and the low-code
// touch points, then stop. Usage: npx tsx scripts/dev/lowcode-shots.mts <outDir> [lang]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { loadConfig, REPO_ROOT } from '../../services/api/src/config.js';
import { createApp } from '../../services/api/src/app.js';
import { runJob } from '../../services/api/src/services/scheduler.js';

const out = process.argv[2] ?? '/tmp/lowcode-shots';
const lang = (process.argv[3] ?? 'en') as 'en' | 'ar';
fs.mkdirSync(out, { recursive: true });
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-shots-'));
const PASSWORD = 'Demo-Shots-2026!';
const config = loadConfig({
  BID_MASTER_KEY: crypto.randomBytes(32).toString('base64'), AUDIT_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
  DATA_DIR: dataDir, SEED_DEMO: 'true', DEMO_PASSWORD: PASSWORD, DEMO_MODE: 'false', CONTENT_STORE_TYPE: 'filesystem',
  PUBLIC_BASE_URL: 'http://localhost', WEB_DIST_DIR: path.join(REPO_ROOT, 'apps/web/dist'), LOGIN_RATE_LIMIT_PER_MIN: '1000',
});
const handle = await createApp(config);
const server = handle.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
await runJob(handle.ctx, 'lowcode-automation', { trigger: 'MANUAL' });

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const login = async (tenantId: string, username: string) => {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, username, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ token: string; user: unknown }>;
};
const page = async (tenantId: string, username: string) => {
  const s = await login(tenantId, username);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: lang === 'ar' ? 'ar-KW' : 'en-GB' });
  await ctx.addInitScript(([tk, us, lg]: string[]) => { sessionStorage.setItem('tf.token', tk); sessionStorage.setItem('tf.user', us); localStorage.setItem('tf.lang', lg); localStorage.setItem('tf.demo.tour.done', '1'); },
    [s.token, JSON.stringify(s.user), lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e: Error) => console.error('[pageerror]', e.message));
  p.on('console', (m: any) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  return p;
};
const shot = async (p: any, name: string, full = true) => { await p.waitForTimeout(700); await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: full }); console.log('shot', name); };
const tenderId = async (num: string) => {
  const r = await handle.ctx.db.query<{ id: string }>('SELECT id FROM tenders WHERE tender_number=$1', [num]);
  return r[0].id;
};

try {
  const admin = await page('kea', 'admin');
  await admin.goto(`${base}/admin/studio`); await shot(admin, '01-studio-map');
  await admin.getByRole('tab', { name: /^Rules$|^القواعد$/ }).click(); await shot(admin, '02-studio-rules');
  await admin.getByRole('button', { name: /Edit \(new draft\)|تعديل \(مسودة جديدة\)/ }).click(); await admin.waitForTimeout(800);
  await admin.getByRole('button', { name: /^Edit$|^تعديل$/ }).first().click(); await shot(admin, '03-rule-editor', false);
  await admin.keyboard.press('Escape');
  await admin.getByRole('tab', { name: /^Forms$|^النماذج$/ }).click(); await admin.waitForTimeout(600);
  await admin.getByRole('button', { name: /Edit \(new draft\)|تعديل \(مسودة جديدة\)/ }).click(); await admin.waitForTimeout(800);
  await admin.locator('.lc-field-pick').nth(4).click(); await shot(admin, '04-form-builder');
  await admin.getByRole('tab', { name: /^Simulator$|^المحاكي$/ }).click(); await admin.waitForTimeout(500);
  await admin.getByRole('button', { name: /^Simulate$|^محاكاة$/ }).click(); await shot(admin, '05-simulator');
  await admin.getByRole('tab', { name: /^Integrations$|^التكاملات$/ }).click(); await shot(admin, '06-integrations');
  await admin.getByRole('tab', { name: /^Activity$|^النشاط$/ }).click(); await shot(admin, '07-activity');
  await admin.getByRole('tab', { name: /Import|استيراد/ }).click(); await shot(admin, '08-packages');

  const officer = await page('kea', 'officer');
  const draft = await tenderId('KEA-2026-101');
  await officer.goto(`${base}/procurement/tenders/${draft}`); await officer.waitForSelector('#tender-process');
  await officer.locator('#tender-process').scrollIntoViewIfNeeded(); await officer.locator('#tender-process').screenshot({ path: path.join(out, '09-tender-process-panel.png') }); console.log('shot 09');
  await officer.goto(`${base}/procurement/tenders/${draft}/edit`); await officer.waitForTimeout(1200);
  await officer.getByText(/Additional information|معلومات إضافية/).first().scrollIntoViewIfNeeded(); await shot(officer, '10-tender-form-fields', false);
  await officer.goto(`${base}/procurement/tasks`); await shot(officer, '11-my-tasks');

  const vendor = await page('kea', 'vendor1');
  const pub = await tenderId('KEA-2026-102');
  await vendor.goto(`${base}/vendor/tenders/${pub}`); await vendor.waitForTimeout(1200);
  const vp = vendor.locator('#tender-process');
  if (await vp.count()) { await vp.scrollIntoViewIfNeeded(); await vp.screenshot({ path: path.join(out, '12-vendor-public-values.png') }); console.log('shot 12'); }
  const anon = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await anon.addInitScript((lg: string) => localStorage.setItem('tf.lang', lg), lang);
  await anon.goto(`${base}/register`); await anon.waitForTimeout(800); await anon.locator('select').first().selectOption('kea'); await anon.waitForTimeout(1200); await shot(anon, '13-vendor-registration');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await handle.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
