// Dev-only: start the built app in-process with demo data and screenshot the usability features of the Cycle Designer
// and the Process Studio (wizard steps, plain-language summary, compare, inline errors, help drawer, rule recipes,
// rule stepper, form builder palette). Nothing is mocked: every screen talks to the real API.
// Usage: npx tsx scripts/dev/designer-shots.mts <outDir> [en|ar] [all|cycle|studio]
// Env: PW_EXE (chromium headless shell), PW_FROM (a file inside a folder whose node_modules has playwright).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { loadConfig, REPO_ROOT } from '../../services/api/src/config.js';
import { createApp } from '../../services/api/src/app.js';

const out = process.argv[2] ?? '/tmp/designer-shots';
const lang = (process.argv[3] ?? 'en') as 'en' | 'ar';
const only = process.argv[4] ?? 'all';
fs.mkdirSync(out, { recursive: true });
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-dshots-'));
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

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const L = (en: string, ar: string) => (lang === 'ar' ? ar : en);
const login = async (tenantId: string, username: string) => {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, username, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ token: string; user: unknown }>;
};
const page = async (tenantId: string, username: string, viewport = { width: 1400, height: 900 }) => {
  const s = await login(tenantId, username);
  const ctx = await browser.newContext({ viewport, locale: lang === 'ar' ? 'ar-KW' : 'en-GB' });
  await ctx.addInitScript(([tk, us, lg]: string[]) => {
    (window as any).__name = (window as any).__name || ((f: unknown) => f);
    sessionStorage.setItem('tf.token', tk);
    sessionStorage.setItem('tf.user', us);
    localStorage.setItem('tf.lang', lg);
    localStorage.setItem('tf.demo.tour.done', '1');
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) {
      return k.startsWith('tf.tour.seen.') ? '1' : get.call(this, k);
    };
  }, [s.token, JSON.stringify(s.user), lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e: Error) => console.error('[pageerror]', e.message));
  p.on('console', (m: any) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  p.on('dialog', (d: any) => { console.log('[dialog]', d.message()); void d.dismiss(); });
  return p;
};
const shot = async (p: any, name: string, full = false) => { await p.waitForTimeout(700); await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: full }); console.log('shot', name); };
const btn = (p: any, en: RegExp, ar: RegExp) => p.getByRole('button', { name: lang === 'ar' ? ar : en });

try {
  if (only === 'all' || only === 'cycle') {
    const a = await page('kea', 'admin');
    await a.goto(`${base}/admin/cycle`);
    await a.waitForSelector('.cyc-actionbar');
    await shot(a, 'c01-designer-overview', true);
    // stage strip → settings
    await a.locator('.cyc-chip-btn').filter({ hasText: L('Award approval', 'اعتماد الترسية') }).first().click();
    await a.waitForTimeout(900);
    await shot(a, 'c02-stage-jump-approvals');
    // inline error: two envelopes with no pass mark
    await a.locator('#cyc-sec-envelopes').scrollIntoViewIfNeeded();
    await a.locator('#cyc-sec-envelopes [role="radio"]').nth(1).click();
    await a.locator('#cyc-sec-envelopes input[type="number"]').fill('');
    await a.waitForTimeout(1200);
    await a.locator('#cyc-sec-envelopes').scrollIntoViewIfNeeded();
    await shot(a, 'c03-inline-error');
    await a.locator('#cyc-sec-envelopes input[type="number"]').fill('75');
    await a.waitForTimeout(900);
    // compare with live
    await btn(a, /Compare with live/, /قارن بالإصدار الساري/).click();
    await shot(a, 'c04-compare-live');
    await a.keyboard.press('Escape');
    // unsaved guard on in-app navigation (dialog is dismissed → stays on page)
    await a.locator('a[href="/admin/studio"]').first().click();
    await a.waitForTimeout(400);
    console.log('still on designer after guarded nav:', a.url().endsWith('/admin/cycle'));
    // help drawer
    await btn(a, /^Help$/, /^مساعدة$/).click();
    await shot(a, 'c05-help-drawer');
    await a.keyboard.press('Escape');
    // reload to drop the unsaved change, then the wizard
    a.removeAllListeners('dialog');
    a.on('dialog', (d: any) => void d.accept());
    await a.goto(`${base}/admin/cycle`);
    await a.waitForSelector('.cyc-actionbar');
    await btn(a, /\+ New template/, /\+ نموذج جديد/).first().click();
    await a.waitForSelector('.ux-wiz');
    await shot(a, 'c06-wizard-1-start');
    await a.locator('.ux-wiz .ux-card').nth(2).click();
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 'c07-wizard-2-envelopes');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 'c08-wizard-3-approvals');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 'c09-wizard-4-stages');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 'c10-wizard-5-eligibility');
    await btn(a, /^Next$/, /^التالي$/).click(); await a.waitForTimeout(800); await shot(a, 'c11-wizard-6-review');
    await btn(a, /^Create draft$/, /^إنشاء مسودة$/).click();
    await a.waitForTimeout(1500);
    await shot(a, 'c12-created-draft');
    // phone width
    const m = await page('kea', 'admin', { width: 390, height: 844 });
    await m.goto(`${base}/admin/cycle`); await m.waitForSelector('.cyc-actionbar'); await shot(m, 'c13-designer-phone');
  }

  if (only === 'all' || only === 'studio') {
    const a = await page('kea', 'admin');
    await a.goto(`${base}/admin/studio`);
    await a.waitForSelector('.lc-tabs');
    await shot(a, 's01-studio-start', true);
    await a.getByRole('tab', { name: /^Rules$|^القواعد$/ }).click();
    await a.waitForTimeout(600);
    await btn(a, /Edit \(new draft\)/, /تعديل \(مسودة جديدة\)/).click();
    await a.waitForTimeout(900);
    await shot(a, 's02-rules-list', true);
    // filters
    await a.locator('.lc-filters [role="radio"]').nth(1).click();
    await a.waitForTimeout(300);
    await shot(a, 's03-rules-filter-gates');
    await a.locator('.lc-filters [role="radio"]').nth(0).click();
    // recipes
    await btn(a, /\+ New rule/, /\+ قاعدة جديدة/).click();
    await a.waitForSelector('.lc-recipes');
    await shot(a, 's04-recipes-gallery');
    await a.locator('.lc-recipes .ux-card').first().click();
    await a.waitForSelector('.lc-stepper');
    await shot(a, 's05-rule-step1-when');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 's06-rule-step2-if');
    await a.locator('.lc-fact-btn').first().click(); await a.waitForTimeout(300); await shot(a, 's07-fact-picker');
    await a.keyboard.press('Escape');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 's08-rule-step3-then');
    await btn(a, /^Next$/, /^التالي$/).click(); await shot(a, 's09-rule-step4-review');
    await btn(a, /^Save rule$/, /^حفظ القاعدة$/).click();
    await a.waitForTimeout(500);
    // delete + undo
    await a.locator('.lc-rule').first().getByRole('button', { name: /^Delete$|^حذف$/ }).click();
    await a.waitForTimeout(300);
    await shot(a, 's10-delete-undo-toast');
    await a.locator('.toast-action').first().click();
    // forms
    await a.getByRole('tab', { name: /^Forms$|^النماذج$/ }).click();
    await a.waitForTimeout(600);
    await btn(a, /Edit \(new draft\)/, /تعديل \(مسودة جديدة\)/).click();
    await a.waitForTimeout(900);
    await shot(a, 's11-form-builder', true);
    await a.locator('.lc-palette button').filter({ hasText: L('Calculated', 'محسوب') }).first().click();
    await a.waitForTimeout(500);
    await a.locator('.lc-field-row.is-selected').scrollIntoViewIfNeeded();
    await shot(a, 's12-form-calculated-helper');
    await btn(a, /^Help$/, /^مساعدة$/).click();
    await shot(a, 's13-studio-help');
  }
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await handle.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
