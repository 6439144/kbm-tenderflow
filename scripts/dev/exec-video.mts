// Dev-only: record the app scenes of the executive demo video. Starts the built app in-process with the demo seed
// (all organisations and people are fictitious), prepares states through the real API (request → tender, approvals,
// bid opening, evaluation, award) and records each shot with the CDP screencast (JPEG frames + timing), so that the
// composer (scripts/dev/exec-video-compose.py) can build a crisp 1080p video.
// Usage: PW_EXE=… PW_FROM=… npx tsx scripts/dev/exec-video.mts <outDir> [--filenet]
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

const out = process.argv[2] ?? '/tmp/exec-video';
const useFileNet = process.argv.includes('--filenet');
const only = process.env.SHOTS ? new Set(process.env.SHOTS.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');

// ---------------- app ----------------
let fake: any = null;
let fnEnv: Record<string, string> = {};
if (useFileNet) {
  // FileNet stand-in (the test double of the Content Services GraphQL API) so the FileNet screens show real data flows.
  const { FakeFileNet, defineTfModel } = await import('../../services/api/test/fakes/fake-filenet.js');
  fake = new FakeFileNet();
  await fake.start();
  defineTfModel(fake, { withOptional: true });
  fnEnv = { ...(fake.env({ FILENET_CLASS_MODEL: 'subclasses', FILENET_SET_CUSTOM_PROPERTIES: 'true', FILENET_VERSIONING: 'true' }) as Record<string, string>) };
  Object.assign(process.env, fnEnv, { CONTENT_STORE_TYPE: 'filenet' }); // the FileNet store reads its settings from the environment
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-video-'));
const PASSWORD = 'Demo-Video-2026!';
const config = loadConfig({
  BID_MASTER_KEY: crypto.randomBytes(32).toString('base64'), AUDIT_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
  DATA_DIR: dataDir, SEED_DEMO: 'true', TENANCY_MODE: 'dedicated', ENTITY_ID: 'kea', DEMO_ENTITY: 'kea', // one installation = one entity
  DEMO_PASSWORD: PASSWORD, DEMO_MODE: 'false',
  CONTENT_STORE_TYPE: useFileNet ? 'filenet' : 'filesystem', ...fnEnv,
  PUBLIC_BASE_URL: 'http://localhost', WEB_DIST_DIR: path.join(REPO_ROOT, 'apps/web/dist'), LOGIN_RATE_LIMIT_PER_MIN: '1000',
});
const handle = await createApp(config);
const server = handle.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
await runJob(handle.ctx, 'lowcode-automation', { trigger: 'MANUAL' });

// ---------------- API helpers ----------------
type Sess = { token: string; user: unknown };
const sessions = new Map<string, Sess>();
const login = async (tenantId: string, username: string): Promise<Sess> => {
  const k = `${tenantId}/${username}`;
  if (sessions.has(k)) return sessions.get(k)!;
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, username, password: PASSWORD }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status} ${await r.text()}`);
  const s = await r.json() as Sess;
  sessions.set(k, s);
  return s;
};
const api = async (user: string, method: string, url: string, json?: unknown, tenant = 'kea') => {
  const s = await login(tenant, user);
  const r = await fetch(`${base}/api/v1${url}`, { method, headers: { authorization: `Bearer ${s.token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const text = await r.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* text */ }
  if (!r.ok) throw new Error(`${method} ${url} as ${user}: ${r.status} ${text.slice(0, 300)}`);
  return body;
};
const upload = async (user: string, url: string, name: string, content: string, fields: Record<string, string>) => {
  const s = await login('kea', user);
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/markdown' }), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${base}/api/v1${url}`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: fd });
  if (!r.ok) throw new Error(`upload ${url}: ${r.status} ${await r.text()}`);
  return r.json();
};
const tenderId = async (num: string) => (await handle.ctx.db.query<{ id: string }>('SELECT id FROM tenders WHERE tender_number=$1', [num]))[0]?.id;
const tenderStatus = async (id: string) => (await handle.ctx.db.query<{ status: string }>('SELECT status FROM tenders WHERE id=$1', [id]))[0]?.status;

// ---------------- browser + recorder ----------------
const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const VIEW = { width: 1440, height: 810 };
const DSF = 1920 / 1440;

const OVERLAY = `
window.__name = window.__name || ((f) => f); // esbuild keepNames helper used by evaluated functions
// the page scroller: the document, or the main content area — never the side navigation
window.__tfvScroller = () => {
  const ok = (e) => e && e.scrollHeight > e.clientHeight + 40 && !e.closest('nav, aside');
  if (ok(document.scrollingElement)) return document.scrollingElement;
  const main = document.getElementById('main');
  for (let e = main; e; e = e.parentElement) if (ok(e) && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) return e;
  if (main) for (const e of main.querySelectorAll('*')) if (ok(e) && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > 300) return e;
  return null;
};
// the role tours are for people, not recordings
{ const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return String(k).startsWith('tf.tour.seen.') ? '1' : g.call(this, k); }; }
(() => {
  if (window.__tfv) return; window.__tfv = true;
  const css = document.createElement('style');
  css.textContent = \`
    #tfv-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transition:transform .7s cubic-bezier(.4,.0,.2,1);transform:translate(1500px,700px)}
    #tfv-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    .tfv-ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #f5a524;border-radius:10px;box-shadow:0 0 0 6px rgba(245,165,36,.22);opacity:0;transition:opacity .35s ease}
    .tfv-ring.on{opacity:1}
    .tfv-click{position:fixed;z-index:2147483646;pointer-events:none;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #f5a524;animation:tfvc .6s ease-out forwards}
    @keyframes tfvc{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
    html{scroll-behavior:auto !important}
  \`;
  const add = () => {
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = 'tfv-cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.4-7.6L20.5 11z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const last = sessionStorage.getItem('tfv.cur'); if (last) c.style.transition = 'none', c.style.transform = last, c.offsetWidth, c.style.transition = '';
  };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;

const newPage = async (tenantId: string | null, username: string | null, lang: 'en' | 'ar' = 'en') => {
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DSF, locale: lang === 'ar' ? 'ar-KW' : 'en-GB', timezoneId: 'Asia/Kuwait' });
  const s = tenantId && username ? await login(tenantId, username) : null;
  await ctx.addInitScript(([tk, us, lg]: (string | null)[]) => {
    if (tk) { sessionStorage.setItem('tf.token', tk); sessionStorage.setItem('tf.user', us!); }
    localStorage.setItem('tf.lang', lg!); localStorage.setItem('tf.demo.tour.done', '1');
  }, [s?.token ?? null, s ? JSON.stringify(s.user) : null, lang]);
  await ctx.addInitScript(OVERLAY);
  const p = await ctx.newPage();
  p.on('pageerror', (e: Error) => console.error('[pageerror]', e.message));
  return p;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const go = async (p: any, url: string) => {
  await p.goto(`${base}${url}`, { waitUntil: 'networkidle' }).catch(() => p.waitForTimeout(1500));
  await p.waitForTimeout(900);
};

/** Smoothly scroll the main scroller to an absolute Y (or by a delta) over `ms`. */
const scrollTo = async (p: any, y: number | { by: number }, ms = 1600) => {
  await p.evaluate(async ([target, dur]: [any, number]) => {
    const el = (window as any).__tfvScroller();
    if (!el) return;
    const from = el.scrollTop; const max = el.scrollHeight - el.clientHeight;
    const to = Math.max(0, Math.min(max, typeof target === 'number' ? target : from + target.by));
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / dur); const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        el.scrollTop = from + (to - from) * e; if (k < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }, [y, ms]);
  await p.waitForTimeout(250);
};
/** Scroll so that the element sits at ~30% from the top. */
const scrollToEl = async (p: any, loc: any, ms = 1500) => {
  const box = await loc.boundingBox(); if (!box) return;
  const cur = await p.evaluate(() => (window as any).__tfvScroller()?.scrollTop ?? 0);
  await scrollTo(p, cur + box.y - VIEW.height * 0.22, ms);
};
const cursorTo = async (p: any, loc: any) => {
  const b = await loc.boundingBox(); if (!b) return;
  const x = b.x + Math.min(b.width / 2, 60); const y = b.y + b.height / 2;
  await p.evaluate(([x, y]: number[]) => { const c = document.getElementById('tfv-cursor'); if (c) { const tr = `translate(${x}px,${y}px)`; c.style.transform = tr; sessionStorage.setItem('tfv.cur', tr); } }, [x, y]);
  await p.waitForTimeout(800);
  return { x, y };
};
const click = async (p: any, loc: any, after = 1200) => {
  const pt = await cursorTo(p, loc);
  if (pt) await p.evaluate(([x, y]: number[]) => { const d = document.createElement('div'); d.className = 'tfv-click'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d); setTimeout(() => d.remove(), 700); }, [pt.x, pt.y]);
  await loc.click();
  await p.waitForTimeout(after);
};
/** Draw a highlight ring around an element for `ms`. */
const spot = async (p: any, loc: any, ms = 2200) => {
  const b = await loc.boundingBox(); if (!b) return;
  await p.evaluate(([x, y, w, h, d]: number[]) => {
    const r = document.createElement('div'); r.className = 'tfv-ring';
    Object.assign(r.style, { left: x - 8 + 'px', top: y - 8 + 'px', width: w + 16 + 'px', height: h + 16 + 'px' });
    document.body.appendChild(r); requestAnimationFrame(() => r.classList.add('on'));
    setTimeout(() => { r.classList.remove('on'); setTimeout(() => r.remove(), 400); }, d);
  }, [b.x, b.y, b.width, b.height, ms]);
  await p.waitForTimeout(ms + 300);
};

type Frame = { file: string; ts: number };
const manifest: { id: string; dir: string; frames: number; duration: number }[] = [];
/** Record one shot: the page must already be on its starting state. */
const shot = async (id: string, p: any, act: () => Promise<void>, hold = 1200) => {
  if (only && !only.has(id)) return;
  const dir = path.join(out, id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cdp = await p.context().newCDPSession(p);
  const frames: Frame[] = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async (f: any) => {
    const file = `${String(++n).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, ts: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  // nudge a repaint so the first frame arrives immediately
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;width:1px;height:1px;left:0;top:0;opacity:.01'; document.body.appendChild(d); setTimeout(() => d.remove(), 50); });
  const t0 = Date.now() / 1000;
  try { await p.waitForTimeout(700); await act(); await p.waitForTimeout(hold); }
  catch (e) { console.error(`[shot ${id}] action failed:`, (e as Error).message); }
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;width:1px;height:1px;left:1px;top:0;opacity:.01'; document.body.appendChild(d); setTimeout(() => d.remove(), 50); });
  await p.waitForTimeout(150);
  const tEnd = Date.now() / 1000;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
  if (!frames.length) { console.error(`[shot ${id}] no frames`); return; }
  // ffconcat with per-frame durations (screencast only sends frames on change)
  const lines = ['ffconcat version 1.0'];
  const startTs = frames[0].ts;
  const endTs = startTs + (tEnd - t0);
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : Math.max(endTs, f.ts + 0.04);
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(path.join(dir, 'frames.ffconcat'), lines.join('\n') + '\n');
  const duration = endTs - startTs;
  manifest.push({ id, dir, frames: frames.length, duration });
  console.log(`shot ${id}: ${frames.length} frames, ${duration.toFixed(1)}s`);
};

// ---------------- state preparation ----------------
const prep: Record<string, string> = {};
async function prepare() {
  // 1) Departmental request (smart meters, 650,000 KWD) → approvals → converted into a tender
  const reqs = await api('officer', 'GET', '/requests');
  const list = Array.isArray(reqs) ? reqs : reqs.items ?? reqs.rows ?? [];
  const smart = list.find((r: any) => /smart meter/i.test(r.subject));
  if (!smart) throw new Error('smart-meter request not found');
  prep.requestId = smart.id;
  for (const who of ['director', 'undersecretary', 'chair', 'admin']) {
    const r = await api('officer', 'GET', `/requests/${smart.id}`);
    const st = r.status ?? r.request?.status;
    if (st === 'APPROVED') break;
    try { await api(who, 'POST', `/requests/${smart.id}/decision`, { decision: 'APPROVE', reason: 'Within the approved capital plan (demo)' }); } catch (e) { console.warn('[prep] request decision', who, (e as Error).message); }
  }
  const deadline = new Date(Date.now() + 30 * 86400_000).toISOString();
  const t = await api('officer', 'POST', `/requests/${smart.id}/convert`, {
    titleEn: 'Smart Meter Data Management Platform', titleAr: 'منصة إدارة بيانات العدادات الذكية', category: 'IT',
    descriptionEn: 'Meter data management platform for 120,000 smart meters with head-end integration, billing interface and an outage dashboard.',
    descriptionAr: 'منصة لإدارة بيانات 120,000 عداد ذكي مع التكامل مع أنظمة الاستقبال وواجهة الفوترة ولوحة الأعطال.',
    estimatedBudget: 650000, currency: 'KWD', submissionDeadline: deadline,
    criteria: [
      { key: 'technical', nameEn: 'Technical solution', nameAr: 'الحل الفني', weight: 50 },
      { key: 'experience', nameEn: 'Experience & team', nameAr: 'الخبرة وفريق العمل', weight: 20 },
      { key: 'price', nameEn: 'Price', nameAr: 'السعر', weight: 30 },
    ],
    requiredDocuments: [
      { key: 'CR', nameEn: 'Commercial registration certificate', nameAr: 'شهادة السجل التجاري' },
      { key: 'TECH_PROPOSAL', nameEn: 'Technical proposal', nameAr: 'العرض الفني' },
      { key: 'FIN_PROPOSAL', nameEn: 'Financial proposal (priced BOQ)', nameAr: 'العرض المالي (جدول الكميات المسعّر)' },
    ],
    eligibility: { activityCodes: ['IT-01'], minGrade: null },
    customFields: { fundingSource: 'CAPEX', budgetLine: 'CPX-2026-044', strategicProject: true, localContentPercent: 30, bidBondPercent: 2, securityClearance: false },
  });
  prep.smartTender = t.id;
  await upload('officer', `/tenders/${t.id}/documents`, 'smart-meter-rfp-pack.md',
    '# Smart Meter Data Management Platform — RFP pack (fictitious demo)\n\nScope, technical requirements and the bill of quantities for the demo tender.\n', { title: 'Smart meter MDM — tender pack (EN/AR)' });
  // level 1: the director approves; the over-500k rule adds the Undersecretary level
  try { await api('director', 'POST', `/tenders/${t.id}/approve`, { reason: 'Scope and budget confirmed (demo)' }); } catch (e) { console.warn('[prep] director approve', (e as Error).message); }

  // 2) KEA-2026-088: sealed bids — opening happens on camera (API call between two recorded shots)
  prep.t088 = await tenderId('KEA-2026-088');
  prep.t101 = await tenderId('KEA-2026-101');
  prep.t102 = await tenderId('KEA-2026-102');
  await runJob(handle.ctx, 'lowcode-automation', { trigger: 'MANUAL' });
}

async function openAndAward() {
  const id = prep.t088;
  await api('chair', 'POST', `/tenders/${id}/open`, { attendees: ['Chair Mariam Al-Demo', 'Evaluator Hamad Testa', 'Evaluator Lulwa Exampli'], notes: 'All envelopes intact (demo)' });
}
async function evaluateAndRecommend() {
  const id = prep.t088;
  const bids = await api('chair', 'GET', `/tenders/${id}/bids`);
  const list = (Array.isArray(bids) ? bids : bids.items ?? bids.bids ?? []) as any[];
  const scores: Record<number, [number, number, number]> = { 0: [88, 85, 78], 1: [74, 70, 92], 2: [66, 72, 81] };
  for (const ev of ['evaluator1', 'evaluator2']) {
    for (const [i, b] of list.entries()) {
      const [t, x, pr] = scores[i] ?? [70, 70, 70];
      const d = ev === 'evaluator2' ? 2 : 0;
      try {
        await api(ev, 'POST', `/bids/${b.id ?? b.bidId}/evaluation`, { scores: [
          { criterion: 'technical', score: t - d, comment: 'Meets the ITIL scope (demo)' },
          { criterion: 'experience', score: x + d, comment: 'Relevant references (demo)' },
          { criterion: 'price', score: pr, comment: 'Per the opened financial proposal (demo)' }] });
      } catch (e) { console.warn('[prep] evaluation', ev, (e as Error).message); }
    }
  }
  const evals = await api('chair', 'GET', `/tenders/${id}/evaluations`);
  const rows = (Array.isArray(evals) ? evals : evals.items ?? []) as any[];
  const byBid = new Map<string, number[]>();
  for (const r of rows) { const k = r.bidId ?? r.bid_id; byBid.set(k, [...(byBid.get(k) ?? []), Number(r.weightedTotal ?? r.weighted_total ?? 0)]); }
  const best = [...byBid.entries()].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1])[0];
  prep.bestBid = best?.[0] ?? (list[0]?.id ?? list[0]?.bidId);
  // complete any open tasks that block the recommendation
  const tasks = await api('admin', 'GET', '/lowcode/tasks?status=OPEN').catch(() => []);
  for (const tk of (Array.isArray(tasks) ? tasks : []) as any[]) {
    if (tk.subjectId === id && tk.blocksGate) await api('admin', 'POST', `/lowcode/tasks/${tk.id}/complete`, { note: 'Done (demo)' }).catch(() => {});
  }
  await api('chair', 'POST', `/tenders/${id}/award/recommend`, { bidId: prep.bestBid, justification: 'Highest weighted score of the committee (demo)' });
}
async function approveAward() {
  const id = prep.t088;
  for (const who of ['director', 'undersecretary', 'admin']) {
    if (await tenderStatus(id) === 'AWARDED') break;
    try { await api(who, 'POST', `/tenders/${id}/award/approve`, { reason: 'Approved per the committee recommendation (demo)' }); } catch (e) { console.warn('[prep] award approve', who, (e as Error).message); }
  }
  console.log('088 status', await tenderStatus(id));
}

// ---------------- scenes ----------------
const H = (re: RegExp) => re;
try {
  await prepare();
  console.log('prepared', prep);

  // S1 Dashboard (director)
  {
    const p = await newPage('kea', 'director'); await go(p, '/procurement');
    await shot('s01-dashboard', p, async () => { await p.waitForTimeout(1500); await scrollTo(p, { by: 520 }, 2600); await p.waitForTimeout(1200); await scrollTo(p, 0, 1800); }, 800);
    await p.context().close();
  }
  // S2 Request → tender
  {
    const p = await newPage('kea', 'officer'); await go(p, `/procurement/requests/${prep.requestId}`);
    await shot('s02-request', p, async () => { await p.waitForTimeout(1500); await scrollTo(p, { by: 420 }, 2400); await p.waitForTimeout(1500); });
    await go(p, `/procurement/tenders/${prep.smartTender}`);
    await shot('s03-tender', p, async () => {
      await p.waitForTimeout(1500);
      const panel = p.locator('#tender-process');
      if (await panel.count()) { await scrollToEl(p, panel, 2200); await spot(p, panel, 2600); }
      await p.waitForTimeout(800);
    });
    await p.context().close();
  }
  // S3 Low-code Process Studio (admin)
  {
    const w = await newPage('kea', 'admin'); await go(w, '/admin/cycle');
    await shot('s04w-wizard', w, async () => {
      await w.waitForTimeout(1200);
      await click(w, w.getByRole('button', { name: /New template/ }).first(), 2200);
      const dlg = w.locator('[role="dialog"]').last();
      await click(w, dlg.getByText('RFP — two envelopes').first(), 1600);
      await click(w, dlg.getByRole('button', { name: /^Next$/ }).first(), 2200);
      await click(w, dlg.getByRole('button', { name: /^Next$/ }).first(), 1600);
      const preset = dlg.getByText('Director → Undersecretary').first();
      if (await preset.count()) await click(w, preset, 1600);
      for (let i = 0; i < 3; i++) await click(w, dlg.getByRole('button', { name: /^Next$/ }).first(), 1800);
      await w.waitForTimeout(1500);
      const create = dlg.getByRole('button', { name: /Create draft/ }).first();
      if (await create.count()) await click(w, create, 2600);
    });
    await w.context().close();
    const p = await newPage('kea', 'admin'); await go(p, '/admin/studio');
    await shot('s04-studio-map', p, async () => { await p.waitForTimeout(1800); await scrollTo(p, { by: 380 }, 2400); await p.waitForTimeout(1600); });
    await shot('s05-studio-rules', p, async () => {
      await click(p, p.getByRole('tab', { name: /^Rules$/ }), 1300);
      await click(p, p.getByRole('button', { name: /Edit \(new draft\)/ }).first(), 1500);
      await click(p, p.getByRole('button', { name: /New rule/ }).first(), 2600);
      const dlg = p.locator('[role="dialog"]').last();
      await click(p, dlg.getByText('Extra approval above an amount').first(), 2200);
      for (let i = 0; i < 3; i++) await click(p, dlg.getByRole('button', { name: /^Next$/ }).first(), 2300);
      await p.waitForTimeout(1200);
      const cancel = dlg.getByRole('button', { name: /^Cancel$|^Close$/ }).first();
      if (await cancel.count()) await cancel.click(); else await p.keyboard.press('Escape');
      await p.waitForTimeout(500);
    });
    await shot('s06-studio-sim', p, async () => {
      await click(p, p.getByRole('tab', { name: /^Simulator$/ }), 1200);
      await click(p, p.getByRole('button', { name: /^Simulate$/ }), 1800);
      await scrollTo(p, { by: 420 }, 2400); await p.waitForTimeout(1600);
    });
    await p.context().close();
  }
  // S4 Gate not ready (KEA-2026-101) + approval chain with the rule-added Undersecretary
  {
    const p = await newPage('kea', 'officer'); await go(p, `/procurement/tenders/${prep.t101}`);
    await shot('s07-gate', p, async () => {
      const panel = p.locator('#tender-process');
      if (await panel.count()) { await scrollToEl(p, panel, 2000); const g = p.locator('.lc-gatebox.is-blocked').first(); if (await g.count()) await spot(p, g, 2800); else await p.waitForTimeout(2500); }
    });
    await p.context().close();
    const u = await newPage('kea', 'undersecretary'); await go(u, `/procurement/tenders/${prep.smartTender}`);
    await shot('s08-chain', u, async () => {
      const chain = u.getByText(/Approval chain|Approvals|Publication approval/i).first();
      if (await chain.count()) { await scrollToEl(u, chain, 2000); } else await scrollTo(u, { by: 500 }, 2000);
      await u.waitForTimeout(2600);
    });
    await u.context().close();
  }
  // S5 Vendor side, bilingual: public board (EN) and vendor tender view (AR)
  {
    const a = await newPage(null, null, 'en'); await go(a, '/tenders');
    await shot('s09-board', a, async () => { await a.waitForTimeout(1500); await scrollTo(a, { by: 360 }, 2200); await a.waitForTimeout(1000); });
    await a.context().close();
    const v = await newPage('kea', 'vendor1', 'ar'); await go(v, `/vendor/tenders/${prep.t102}`);
    await shot('s10-vendor-ar', v, async () => { await v.waitForTimeout(1600); await scrollTo(v, { by: 520 }, 2600); await v.waitForTimeout(1400); });
    await v.context().close();
  }
  // S6 Sealed bids → opening by the chair
  {
    const p = await newPage('kea', 'chair'); await go(p, `/procurement/tenders/${prep.t088}`);
    await shot('s11-sealed', p, async () => {
      const b = p.getByText(/sealed|encrypted/i).first();
      if (await b.count()) { await scrollToEl(p, b, 2000); await spot(p, b, 2400); } else { await scrollTo(p, { by: 500 }, 2000); await p.waitForTimeout(2000); }
    });
    await openAndAward();
    await go(p, `/procurement/tenders/${prep.t088}`);
    await shot('s12-opened', p, async () => {
      const b = p.getByText(/^Bids$|Opening record|Bids received/).first();
      if (await b.count()) await scrollToEl(p, b, 2000); else await scrollTo(p, { by: 500 }, 2000);
      await p.waitForTimeout(2600);
    });
    // evaluation + recommendation, then the award approval (segregation of duties)
    await evaluateAndRecommend();
    await go(p, `/procurement/tenders/${prep.t088}`);
    await shot('s13-evaluation', p, async () => {
      const b = p.getByText(/Evaluation|Award/i).first();
      if (await b.count()) await scrollToEl(p, b, 2000); else await scrollTo(p, { by: 700 }, 2000);
      await p.waitForTimeout(1200); await scrollTo(p, { by: 380 }, 2200); await p.waitForTimeout(1600);
    });
    await p.context().close();
    await approveAward();
    const d = await newPage('kea', 'director'); await go(d, `/procurement/tenders/${prep.t088}`);
    await shot('s14-awarded', d, async () => { await d.waitForTimeout(1600); await scrollTo(d, { by: 600 }, 2600); await d.waitForTimeout(1600); });
    await d.context().close();
    // FileNet evidence of a stored document (object id, class, version, hash) — officer view of the same tender
    const e = await newPage('kea', 'officer'); await go(e, `/procurement/tenders/${prep.t088}`);
    await shot('s14b-fn-evidence', e, async () => {
      const btn = e.locator('.fn-evidence-btn').first();
      if (await btn.count()) { await scrollToEl(e, btn, 1800); await click(e, btn, 2400); await e.waitForTimeout(2600); }
    });
    await e.context().close();
  }
  // S7 IBM FileNet
  {
    const p = await newPage('kea', 'admin'); await go(p, '/admin/filenet');
    await shot('s15-filenet', p, async () => { await p.waitForTimeout(1800); await scrollTo(p, { by: 480 }, 2400); await p.waitForTimeout(1400); });
    await go(p, '/admin/filenet-search');
    await shot('s16-filenet-search', p, async () => {
      const inp = p.getByLabel(/Tender number/).first();
      if (await inp.count()) { await cursorTo(p, inp); await inp.click(); await inp.pressSequentially('KEA-2026-088', { delay: 80 }); await p.waitForTimeout(400); }
      const btn = p.getByRole('button', { name: /Search FileNet/ }).first();
      if (await btn.count()) await click(p, btn, 2600);
      await scrollTo(p, { by: 360 }, 2000); await p.waitForTimeout(1400);
    });
    await p.context().close();
  }
  // S8 Governance: audit chain verification and evidence pack
  {
    const p = await newPage('kea', 'auditor'); await go(p, '/admin/audit');
    await shot('s17-audit', p, async () => {
      const v = p.getByRole('button', { name: /Verify integrity/ }).first();
      if (await v.count()) { await click(p, v, 2200); const ok = p.getByText(/Audit chain verified/).first(); if (await ok.count()) await spot(p, ok, 2400); }
      await scrollTo(p, { by: 420 }, 2200); await p.waitForTimeout(1200);
    });
    await go(p, '/admin/evidence');
    await shot('s18-evidence', p, async () => {
      await p.waitForTimeout(1200);
      const sel = p.getByLabel(/^Tender/).first();
      if (await sel.count()) {
        await cursorTo(p, sel);
        const opt = await sel.locator('option').filter({ hasText: 'KEA-2026-088' }).first().getAttribute('value').catch(() => null);
        if (opt) await sel.selectOption(opt);
        await p.waitForTimeout(700);
        const gen = p.getByRole('button', { name: /Generate evidence pack/ }).first();
        if (await gen.count()) await click(p, gen, 3500);
      }
      await scrollTo(p, { by: 420 }, 2200); await p.waitForTimeout(1600);
    });
    await p.context().close();
  }
  // S9 Executive overview / analytics
  {
    const p = await newPage('kea', 'admin'); await go(p, '/admin/analytics');
    await shot('s19-analytics', p, async () => { await p.waitForTimeout(1800); await scrollTo(p, { by: 560 }, 2800); await p.waitForTimeout(1400); });
    await p.context().close();
  }
} finally {
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ filenet: useFileNet, shots: manifest }, null, 2));
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  await handle.close();
  if (fake) await fake.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
