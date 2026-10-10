// Dev-only: render the executive video's title/explainer cards (animated, recorded with the CDP screencast) and the
// caption overlays (transparent 1920x1080 PNGs) from storyboard.json.
// Usage: PW_EXE=… PW_FROM=… node scripts/dev/video/render-cards.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? '/tmp/exec-video';
const req = createRequire(process.env.PW_FROM ?? import.meta.url);
const { chromium } = req('playwright');
const board = JSON.parse(fs.readFileSync(path.join(here, 'storyboard.json'), 'utf8'));
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_EXE });

// ---- cards ----
const cardsUrl = pathToFileURL(path.join(here, 'cards.html')).href;
for (const seg of board.segments.filter((s) => s.card)) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const p = await ctx.newPage();
  const dir = path.join(out, seg.id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(p);
  const frames = []; let n = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    const file = `${String(++n).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, ts: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await p.goto('about:blank');
  await p.evaluate(() => { document.body.style.background = '#0a1a2b'; });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  await p.waitForTimeout(150);
  const t0 = Date.now() / 1000;
  await p.goto(`${cardsUrl}?card=${seg.card}`);
  await p.waitForTimeout(seg.seconds * 1000);
  const t1 = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  // drop the about:blank frames before the card navigation
  const startTs = frames.find((f, i) => i > 0)?.ts ?? frames[0].ts;
  const keep = frames.filter((f) => f.ts >= startTs - 0.001);
  const endTs = keep[0].ts + (t1 - t0);
  const lines = ['ffconcat version 1.0'];
  keep.forEach((f, i) => {
    const next = i + 1 < keep.length ? keep[i + 1].ts : Math.max(endTs, f.ts + 0.04);
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
  });
  lines.push(`file '${keep[keep.length - 1].file}'`);
  fs.writeFileSync(path.join(dir, 'frames.ffconcat'), lines.join('\n') + '\n');
  console.log(`card ${seg.id}: ${keep.length} frames, ${(endTs - keep[0].ts).toFixed(1)}s`);
  await ctx.close();
}

// ---- caption overlays ----
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const overlayHtml = (seg) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box} html,body{width:1440px;height:810px;background:transparent;font-family:Inter,system-ui,sans-serif}
  .band{position:absolute;left:0;right:0;bottom:0;height:150px;background:linear-gradient(180deg,rgba(6,18,31,0) 0%,rgba(6,18,31,.78) 38%,rgba(6,18,31,.92) 100%)}
  .cap{position:absolute;left:54px;right:300px;bottom:30px;display:flex;gap:18px;align-items:flex-start}
  .acc{width:5px;align-self:stretch;background:#f5a524;border-radius:3px;flex:none}
  .t{color:#fff;font-size:28px;font-weight:700;letter-spacing:-.01em;line-height:1.2}
  .s{color:#c9d6e3;font-size:19px;line-height:1.4;margin-top:6px}
  .tag{position:absolute;right:40px;bottom:34px;text-align:right;color:#c9d6e3;font-size:14px;line-height:1.5}
  .tag b{display:inline-block;padding:4px 12px;border:1px solid rgba(255,255,255,.3);border-radius:999px;color:#fff;font-weight:600;font-size:14px}
  .chap{position:absolute;left:54px;bottom:118px;color:#f5a524;font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
</style></head><body>
  <div class="band"></div>
  <div class="cap"><div class="acc"></div><div><div class="t">${esc(seg.title)}</div>${seg.sub ? `<div class="s">${esc(seg.sub)}</div>` : ''}</div></div>
  <div class="tag"><b>${esc(seg.tag ?? 'Demo data · fictitious')}</b>${seg.note ? `<br>${esc(seg.note)}` : ''}</div>
</body></html>`;
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1920 / 1440 });
  const p = await ctx.newPage();
  fs.mkdirSync(path.join(out, 'overlays'), { recursive: true });
  for (const seg of board.segments.filter((s) => s.shot)) {
    await p.setContent(overlayHtml(seg));
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, 'overlays', `${seg.id}.png`), omitBackground: true });
  }
  console.log('overlays done');
  await ctx.close();
}
await browser.close();
