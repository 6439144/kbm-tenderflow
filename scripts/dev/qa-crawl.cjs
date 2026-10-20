// TenderFlow release QA crawler (dev tool, not shipped).
// Signs in as each user (API), opens every menu entry and one record of every list, in each language, and records:
// page errors, console errors, failed API calls (>=400 except 401), error boxes, raw i18n keys, nearly empty pages and
// horizontal overflow. Screenshots and report.json go to OUT.
//   BASE=http://127.0.0.1:8080 DEMO_PW=... OUT=/tmp/qa USERS=admin,officer,vendor1 [LANGS=en,ar] [EXTRA=/path,/path] [TENANT=kea (shared mode)]
//   [PW_EXE=<chromium>] [PW_FROM=<file inside a project that has playwright>] node scripts/dev/qa-crawl.cjs
// Exit code 1 when any issue is found.
const { chromium } = require(process.env.PW_FROM ? require('module').createRequire(process.env.PW_FROM).resolve('playwright') : 'playwright');
const fs = require('fs'); const path = require('path');
const BASE = process.env.BASE; const PW = process.env.DEMO_PW; const OUT = process.env.OUT; const USERS = process.env.USERS.split(',');
const LANGS = (process.env.LANGS || 'en,ar').split(',');
const EXTRA = (process.env.EXTRA || '').split(',').filter(Boolean); // deep links every user opens (e.g. a record URL from an e-mail)
fs.mkdirSync(OUT, { recursive: true });
const report = [];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
  for (const lang of LANGS) for (const user of USERS) {
    const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: PW, ...(process.env.TENANT ? { tenantId: process.env.TENANT } : {}) }) });
    if (!r.ok) { report.push({ user, lang, page: 'LOGIN', issue: `login ${r.status}` }); continue; }
    const s = await r.json();
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await ctx.addInitScript(([tk, us, lg]) => { window.__name = window.__name || (f => f); sessionStorage.setItem('tf.token', tk); sessionStorage.setItem('tf.user', us); localStorage.setItem('tf.lang', lg); localStorage.setItem('tf.demo.tour.done', '1');
      const g = Storage.prototype.getItem; Storage.prototype.getItem = function (k) { return String(k).startsWith('tf.tour.seen.') ? '1' : g.call(this, k); }; }, [s.token, JSON.stringify(s.user), lang]);
    const p = await ctx.newPage();
    let cur = '';
    p.on('pageerror', e => report.push({ user, lang, page: cur, issue: 'pageerror: ' + e.message.slice(0, 200) }));
    p.on('console', m => { if (m.type() === 'error') report.push({ user, lang, page: cur, issue: 'console: ' + m.text().slice(0, 200) }); });
    p.on('response', res => { const u = res.url(); if (u.includes('/api/') && res.status() >= 400 && ![401].includes(res.status())) report.push({ user, lang, page: cur, issue: `api ${res.status()} ${res.request().method()} ${u.replace(BASE, '')}` }); });
    await p.goto(BASE + '/', { waitUntil: 'networkidle' }).catch(() => {});
    await p.waitForTimeout(800);
    const links = await p.$$eval('nav a[href], aside a[href]', as => [...new Set(as.map(a => a.getAttribute('href')).filter(h => h && h.startsWith('/')))]);
    const visit = async (href, tag) => {
      cur = href;
      await p.goto(BASE + href, { waitUntil: 'networkidle' }).catch(e => report.push({ user, lang, page: href, issue: 'goto ' + e.message.slice(0, 100) }));
      await p.waitForTimeout(700);
      const info = await p.evaluate(() => {
        const txt = document.body.innerText || '';
        const errs = [...document.querySelectorAll('.error, .err, [role=alert]')].map(e => e.innerText.trim()).filter(Boolean).slice(0, 3);
        const overflow = document.documentElement.scrollWidth > window.innerWidth + 4;
        const keys = (txt.match(/\b[a-z]+(\.[a-zA-Z0-9]+){2,}\b/g) || []).filter(k => !k.includes('@') && !/\.(com|kw|net|org|md|ts|js|json|docx|pdf|png|enc|txt|csv|xlsx)$/.test(k)).slice(0, 5); // untranslated i18n keys
        const empty = txt.trim().length < 40;
        return { errs, overflow, keys, empty, title: (document.querySelector('h1')||{}).innerText || '' };
      });
      if (info.errs.length) report.push({ user, lang, page: href, issue: 'error box: ' + info.errs.join(' | ').slice(0, 200) });
      if (info.overflow) report.push({ user, lang, page: href, issue: 'horizontal overflow' });
      if (info.keys.length) report.push({ user, lang, page: href, issue: 'raw i18n keys: ' + info.keys.join(', ') });
      if (info.empty) report.push({ user, lang, page: href, issue: 'page nearly empty' });
      await p.screenshot({ path: path.join(OUT, `${lang}-${user}-${tag}.png`), fullPage: false });
    };
    let i = 0;
    for (const href of links) { await visit(href, String(++i).padStart(2, '0') + href.replace(/\W+/g, '_')); }
    for (const href of EXTRA) { await visit(href, 'extra' + String(++i).padStart(2, '0')); report.push({ user, lang, page: href, issue: `deep link landed on ${new URL(p.url()).pathname}`, info: true }); }
    // one detail page per entity list found on visited pages
    const seen = new Set();
    for (const href of links) {
      await p.goto(BASE + href, { waitUntil: 'networkidle' }).catch(() => {});
      const det = await p.$$eval('main a[href]', as => as.map(a => a.getAttribute('href')).filter(h => h && /^\/[a-z-]+\/.+\/[0-9a-f-]{8,}/.test(h)));
      for (const d of det.slice(0, 1)) { const key = d.replace(/[0-9a-f-]{8,}.*/, ''); if (seen.has(key)) continue; seen.add(key); await visit(d, 'detail' + String(++i).padStart(2, '0') + key.replace(/\W+/g, '_')); }
    }
    report.push({ user, lang, page: '-', issue: `visited ${i} pages`, info: true });
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const real = report.filter(r => !r.info);
  console.log('issues', real.length);
  const agg = {}; for (const r of real) { const k = r.issue.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'); (agg[k] = agg[k] || []).push(`${r.lang}/${r.user}${r.page}`); }
  for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].length - a[1].length)) console.log(`${v.length}x ${k}\n     e.g. ${v.slice(0, 3).join('  ')}`);
  for (const r of report.filter(r => r.info)) console.log(r.lang, r.user, r.issue);
  process.exitCode = real.length ? 1 : 0;
})();
