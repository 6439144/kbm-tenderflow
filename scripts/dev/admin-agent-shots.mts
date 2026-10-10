// DEV SCREENSHOT HARNESS — NOT PART OF THE PRODUCT. Never imported by the app, never shipped in a build.
// Starts the built app in-process with demo data and points it at the TEST-ONLY fake watsonx Orchestrate server
// (services/api/test/fakes/orchestrate.ts) whose replies are scripted below, so the screenshots of Admin → AI builder
// show a proposal. In the product, replies come only from the real tenderflow_admin_builder agent; without Orchestrate
// the page shows the "not configured" banner and nothing is generated (AGENTS.md rules 9–11).
// Usage: PW_EXE=<headless_shell> PW_FROM=<dir with playwright>/x.js npx tsx scripts/dev/admin-agent-shots.mts <outDir> en|ar
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { loadConfig, REPO_ROOT } from '../../services/api/src/config.js';
import { createApp } from '../../services/api/src/app.js';
import { startFakeOrchestrate } from '../../services/api/test/fakes/orchestrate.js';

const out = process.argv[2] ?? '/tmp/admin-agent-shots';
const lang = (process.argv[3] ?? 'en') as 'en' | 'ar';
fs.mkdirSync(out, { recursive: true });
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');

// ---- scripted agent replies (dev harness only) ----
const J = (o: unknown) => JSON.stringify(o);
const rule = (amount: number) => ({ op: 'ADD_RULE', rule: {
  id: 'undersecretary-over-limit', nameEn: `Undersecretary approval above ${amount.toLocaleString('en-US')} KWD`, nameAr: `اعتماد الوكيل للمناقصات فوق ${amount.toLocaleString('en-US')} د.ك`,
  trigger: 'TENDER_SUBMIT', when: { fact: 'tender.estimatedBudget', op: 'gt', value: amount },
  actions: [{ type: 'ADD_APPROVER', role: 'UNDERSECRETARY', labelEn: 'Undersecretary', labelAr: 'الوكيل', dueHours: 72 }] } });
const PLAN = (amount: number) => [
  { op: 'CREATE_TEMPLATE', code: 'RFP_6040', nameEn: 'RFP — two envelopes (60/40)', nameAr: 'طلب عروض — مظروفان (60/40)', baseCode: 'RFP_TWO_ENVELOPE',
    description: 'Technical envelope scored first; pass mark 70.', changes: { envelopes: 'TWO', evaluation: { technicalPassMark: 70, financialCriteria: ['price'] } } },
  rule(amount),
  { op: 'ADD_FORM_FIELD', form: 'TENDER', field: { key: 'projectCode', type: 'text', section: 'funding', labelEn: 'Project code', labelAr: 'رمز المشروع',
    required: true, requiredAt: 'SAVE', audience: 'INTERNAL', maxLength: 40, helpEn: 'As in the annual project plan', helpAr: 'كما في خطة المشاريع السنوية' } },
  { op: 'ADD_RULE', rule: { id: 'deadline-72h', nameEn: 'Deadline in 72 hours', nameAr: 'الموعد النهائي خلال 72 ساعة', trigger: 'DEADLINE_APPROACHING', params: { hoursBefore: 72 }, when: null,
    actions: [{ type: 'NOTIFY', to: 'ROLE', role: 'PROCUREMENT_OFFICER', titleEn: 'Submission deadline within 72 hours: {{tender.number}}', titleAr: 'موعد التقديم خلال 72 ساعة: {{tender.number}}' }] } },
];
const REPLY1 = J({ reply: {
  en: 'I propose a new two-envelope RFP template with a technical pass mark of 70, an Undersecretary approval for tenders above 1,000,000 KWD, a required “Project code” field and a reminder to officers 72 hours before the deadline. The 60/40 weights are entered on each tender (Evaluation criteria).',
  ar: 'أقترح نموذج طلب عروض جديداً بمظروفين ودرجة نجاح فنية 70، واعتماد الوكيل للمناقصات التي تتجاوز 1,000,000 د.ك، وحقلاً إلزامياً «رمز المشروع»، وتذكيراً للموظفين قبل الموعد النهائي بـ 72 ساعة. أوزان 60/40 تُدخل في كل مناقصة (معايير التقييم).' },
  operations: PLAN(1000000), questions: [] });
const REPLY2 = J({ reply: {
  en: 'Updated: the Undersecretary approval now applies above 2,000,000 KWD. The other three changes are unchanged.',
  ar: 'تم التعديل: أصبح اعتماد الوكيل للمناقصات التي تتجاوز 2,000,000 د.ك. التغييرات الثلاثة الأخرى كما هي.' },
  operations: PLAN(2000000), questions: [] });
const REPLY_UNSAFE = J({ reply: {
  en: 'Opening bids before the deadline is a locked control; I can only propose rules that add controls. Below is the closest request as written, which TenderFlow refuses.',
  ar: 'فتح العطاءات قبل الموعد النهائي ضابط ثابت؛ يمكنني اقتراح قواعد تضيف ضوابط فقط. أدناه الطلب كما كُتب، ويرفضه TenderFlow.' },
  operations: [{ op: 'ADD_RULE', rule: { id: 'open-early', nameEn: 'Open bids when the committee is ready', nameAr: 'فتح العطاءات عند جاهزية اللجنة', trigger: 'TENDER_PUBLISHED', when: null,
    actions: [{ type: 'OPEN_BIDS' }] } }], questions: [] });

const fake = await startFakeOrchestrate();
Object.assign(process.env, fake.env); // createAiService() reads process.env when the app is created

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-aa-shots-'));
const PASSWORD = 'Demo-Shots-2026!';
const config = loadConfig({
  BID_MASTER_KEY: crypto.randomBytes(32).toString('base64'), AUDIT_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
  DATA_DIR: dataDir, SEED_DEMO: 'true', DEMO_PASSWORD: PASSWORD, DEMO_MODE: 'false', CONTENT_STORE_TYPE: 'filesystem', DOC_AI_AUTO: 'false',
  PUBLIC_BASE_URL: 'http://localhost', WEB_DIST_DIR: path.join(REPO_ROOT, 'apps/web/dist'), LOGIN_RATE_LIMIT_PER_MIN: '1000',
});
const handle = await createApp(config);
const server = handle.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const login = async (tenantId: string, username: string) => {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, username, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<{ token: string; user: unknown }>;
};
const page = async (tenantId: string, username: string, height = 1000) => {
  const s = await login(tenantId, username);
  const ctx = await browser.newContext({ viewport: { width: 1440, height }, locale: lang === 'ar' ? 'ar-KW' : 'en-GB' });
  await ctx.addInitScript(() => { (window as any).__name = (window as any).__name || ((f: unknown) => f); });
  await ctx.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k: string) { return k.startsWith('tf.tour.seen.') ? '1' : orig.call(this, k); };
  });
  await ctx.addInitScript(([tk, us, lg]: string[]) => { sessionStorage.setItem('tf.token', tk); sessionStorage.setItem('tf.user', us); localStorage.setItem('tf.lang', lg); localStorage.setItem('tf.demo.tour.done', '1'); },
    [s.token, JSON.stringify(s.user), lang]);
  const p = await ctx.newPage();
  p.on('pageerror', (e: Error) => console.error('[pageerror]', e.message));
  p.on('console', (m: any) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  return p;
};
const shot = async (p: any, name: string, full = true) => {
  if (full) await p.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.aa-msgs').forEach((m) => { m.scrollTop = m.scrollHeight; }); (document.activeElement as HTMLElement | null)?.blur(); });
  await p.waitForTimeout(600); await p.screenshot({ path: path.join(out, `${name}.png`), fullPage: full }); console.log('shot', name); };
const ask = async (p: any, text: string) => {
  const box = p.locator('.aa-form textarea');
  await box.fill(text);
  await box.press('Enter');
  await p.waitForSelector('.aa-msg-agent .aa-reply >> nth=-1');
  await p.waitForFunction(() => !document.querySelector('.aa-msgs .spinner'));
  await p.waitForTimeout(400);
};
const T = (en: string, ar: string) => (lang === 'ar' ? ar : en);

try {
  const admin = await page('kea', 'admin');
  await admin.goto(`${base}/admin/builder`);
  await admin.waitForSelector('.aa-chat');
  await shot(admin, '01-builder-empty');

  fake.queue.push(REPLY1);
  await ask(admin, T('Create a two-envelope RFP template with a 60/40 technical/price split and a pass mark of 70. Tenders above 1,000,000 KWD need the Undersecretary. Add a required “Project code” field to the tender form and remind officers 72 hours before the deadline.',
    'أنشئ نموذج طلب عروض بمظروفين بنسبة 60/40 بين الفني والسعر ودرجة نجاح 70. المناقصات التي تتجاوز 1,000,000 د.ك تحتاج اعتماد الوكيل. أضف حقلاً إلزامياً «رمز المشروع» إلى نموذج المناقصة وذكّر الموظفين قبل الموعد النهائي بـ 72 ساعة.'));
  await shot(admin, '02-proposal');

  fake.queue.push(REPLY2);
  await ask(admin, T('Make it 2 million instead', 'اجعلها مليونين بدلاً من ذلك'));
  await admin.locator('.aa-op').nth(1).locator('details summary').click();
  await admin.locator('.aa-op').nth(0).locator('details summary').click();
  await shot(admin, '03-refined-with-diff');

  await admin.getByRole('button', { name: T('Create drafts', 'إنشاء المسودات') }).click();
  await admin.waitForSelector('.aa-applied');
  await shot(admin, '04-drafts-created');

  await admin.waitForTimeout(5200); // let the "drafts created" toast disappear
  await admin.getByRole('button', { name: T('New request', 'طلب جديد') }).click();
  fake.queue.push(REPLY_UNSAFE);
  await ask(admin, T('Let the committee open bids as soon as the tender is published', 'اسمح للجنة بفتح العطاءات فور نشر المناقصة'));
  await shot(admin, '05-refused-locked-control');

  // Assistant dock entry for administrators
  await admin.goto(`${base}/admin/studio`);
  await admin.waitForTimeout(800);
  await admin.locator('.ast-fab').click();
  await admin.waitForSelector('.aa-dock-link');
  await admin.locator('.ast-panel').screenshot({ path: path.join(out, '06-dock-entry.png') }); console.log('shot 06-dock-entry');

  // Auditor: read-only view of the history
  const auditor = await page('kea', 'auditor');
  await auditor.goto(`${base}/admin/builder`);
  await auditor.waitForSelector('.aa-hist-btn');
  await auditor.locator('.aa-hist-btn').last().click();
  await auditor.waitForSelector('.aa-applied');
  await shot(auditor, '07-auditor-read-only');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await handle.close();
  await fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
