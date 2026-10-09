// Public tender board (TenderScout): the consolidated, cross-entity list of open tenders, readable without login.
// This is the ONLY cross-tenant read in TenderFlow, so it is deliberately narrow:
//   - only tenders in status PUBLISHED whose deadline has not passed,
//   - only of ACTIVE entities whose profile setting `publicBoard` is not false (default: on; MOI keeps it off
//     because it shows tenders only to eligible vendors),
//   - only public fields (entity name, number, titles, category, activity codes, deadline, document price,
//     official publication references). Never documents, descriptions, budgets, vendors, bids or internal ids.
import type express from 'express';
import rateLimit from 'express-rate-limit';
import type { Ctx } from '../../ctx.js';
import { h } from '../../routes.js';
import { configOf } from '../../services/templates.js';
import { escapeHtml, now } from '../../util.js';

export interface PublicTender {
  entity: { id: string; nameEn: string; nameAr: string };
  tenderNumber: string;
  titleEn: string;
  titleAr: string;
  category: string;
  activityCodes: { code: string; nameEn: string | null; nameAr: string | null }[];
  submissionDeadline: string;
  publishedAt: string | null;
  documentPrice: { amount: number; currency: string } | null;
  publications: { channel: 'KUWAIT_ALYOUM' | 'CAPT'; reference: string | null; publishedOn: string | null }[];
  url: string;
}

/** Entity profile setting `publicBoard`, read defensively: anything but an explicit "off" means on. */
export function publicBoardEnabled(profile: unknown): boolean {
  const v = (profile && typeof profile === 'object' ? (profile as Record<string, unknown>).publicBoard : undefined);
  if (v === undefined || v === null) return true;
  return !(v === false || v === 'false' || v === 0 || v === '0' || v === 'off');
}

const clean = (v: unknown, max: number, re?: RegExp): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  if (!s) return null;
  if (re && !re.test(s)) return null;
  return s;
};
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

interface Filters { entity: string | null; activity: string | null; q: string | null }

export function parseFilters(query: Record<string, unknown>): Filters {
  return {
    entity: clean(query.entity, 40, /^[A-Za-z0-9_-]+$/),
    activity: clean(query.activity, 40, /^[A-Za-z0-9_.-]+$/),
    q: clean(query.q, 100),
  };
}

async function boardEntities(ctx: Ctx) {
  const rows = await ctx.db.query<{ id: string; name_en: string; name_ar: string; profile: unknown }>(
    `SELECT id, name_en, name_ar, profile FROM tenants WHERE status='ACTIVE' ORDER BY id`);
  return rows.filter((r) => publicBoardEnabled(r.profile)).map((r) => ({ id: r.id, nameEn: r.name_en, nameAr: r.name_ar }));
}

export async function listPublicTenders(ctx: Ctx, f: Filters) {
  const entities = await boardEntities(ctx);
  const ids = entities.map((e) => e.id);
  const base = ctx.config.publicBaseUrl;
  if (!ids.length) return { generatedAt: now().toISOString(), count: 0, entities, activities: [], tenders: [] as PublicTender[] };
  const rows = await ctx.db.query<any>(
    `SELECT t.id, t.tenant_id, t.tender_number, t.title_en, t.title_ar, t.category, t.eligibility, t.submission_deadline, t.published_at,
            t.template_snapshot
       FROM tenders t
      WHERE t.tenant_id = ANY($1::text[]) AND t.status = 'PUBLISHED' AND t.submission_deadline > $2
      ORDER BY t.submission_deadline ASC, t.tender_number ASC LIMIT 500`, [ids, now()]);
  const tenderIds = rows.map((r) => r.id);
  const pubs = tenderIds.length ? await ctx.db.query<any>(
    `SELECT tender_id, channel, reference, published_on FROM publications
      WHERE tender_id = ANY($1::uuid[]) AND status='PUBLISHED' AND channel IN ('KUWAIT_ALYOUM','CAPT') ORDER BY channel`, [tenderIds]) : [];
  const codes = await ctx.db.query<any>('SELECT tenant_id, code, name_en, name_ar FROM activity_codes WHERE tenant_id = ANY($1::text[])', [ids]);
  const codeName = new Map(codes.map((c) => [`${c.tenant_id}|${c.code}`, c]));
  const ent = new Map(entities.map((e) => [e.id, e]));

  const all: PublicTender[] = rows.map((r) => {
    const cfg = configOf(r);
    const codesOf: string[] = Array.isArray(r.eligibility?.activityCodes) ? r.eligibility.activityCodes.filter((x: unknown) => typeof x === 'string') : [];
    const price = cfg.stages.documentPurchase ? { amount: Number(cfg.fees.documentPrice) || 0, currency: cfg.fees.currency || 'KWD' } : null;
    return {
      entity: ent.get(r.tenant_id)!,
      tenderNumber: r.tender_number,
      titleEn: r.title_en,
      titleAr: r.title_ar,
      category: r.category,
      activityCodes: codesOf.map((c) => {
        const n = codeName.get(`${r.tenant_id}|${c}`);
        return { code: c, nameEn: n?.name_en ?? null, nameAr: n?.name_ar ?? null };
      }),
      submissionDeadline: iso(r.submission_deadline)!,
      publishedAt: iso(r.published_at),
      documentPrice: price,
      publications: pubs.filter((p) => p.tender_id === r.id).map((p) => ({
        channel: p.channel, reference: p.reference ?? null,
        publishedOn: p.published_on ? (p.published_on instanceof Date ? p.published_on.toISOString().slice(0, 10) : String(p.published_on).slice(0, 10)) : null,
      })),
      url: `${base}/tenders?entity=${encodeURIComponent(r.tenant_id)}&q=${encodeURIComponent(r.tender_number)}`,
    };
  });

  const activityMap = new Map<string, { code: string; nameEn: string | null; nameAr: string | null }>();
  for (const t of all) for (const a of t.activityCodes) if (!activityMap.has(a.code)) activityMap.set(a.code, a);

  const needle = f.q ? f.q.toLowerCase() : null;
  const has = (s: string) => !!needle && s.toLowerCase().includes(needle);
  const tenders = all.filter((t) =>
    (!f.entity || t.entity.id === f.entity)
    && (!f.activity || t.activityCodes.some((a) => a.code === f.activity))
    && (!needle || has(t.tenderNumber) || has(t.titleEn) || has(t.titleAr)));
  return {
    generatedAt: now().toISOString(),
    count: tenders.length,
    entities,
    activities: [...activityMap.values()].sort((a, b) => a.code.localeCompare(b.code)),
    tenders,
  };
}

function rss(ctx: Ctx, list: PublicTender[]): string {
  const base = ctx.config.publicBaseUrl;
  const x = escapeHtml;
  const items = list.map((t) => {
    const price = t.documentPrice ? `${t.documentPrice.amount} ${t.documentPrice.currency}` : 'free / مجاناً';
    const desc = [
      `${t.entity.nameEn} — ${t.entity.nameAr}`,
      `${t.titleEn} — ${t.titleAr}`,
      `Category / الفئة: ${t.category}`,
      `Activity codes / رموز النشاط: ${t.activityCodes.map((a) => a.code).join(', ') || '—'}`,
      `Submission deadline / آخر موعد لتقديم العطاءات: ${t.submissionDeadline}`,
      `Tender documents / وثائق المناقصة: ${price}`,
      ...t.publications.map((p) => `${p.channel === 'KUWAIT_ALYOUM' ? 'Kuwait Al-Youm / الكويت اليوم' : 'CAPT / الجهاز المركزي للمناقصات العامة'}: ${p.reference ?? '—'} (${p.publishedOn ?? '—'})`),
    ].join('\n');
    return `    <item>
      <title>${x(`${t.tenderNumber} — ${t.titleEn} / ${t.titleAr}`)}</title>
      <link>${x(t.url)}</link>
      <guid isPermaLink="false">${x(`tenderflow:${t.entity.id}:${t.tenderNumber}`)}</guid>
      ${t.publishedAt ? `<pubDate>${new Date(t.publishedAt).toUTCString()}</pubDate>` : ''}
      <category>${x(t.category)}</category>
      <description>${x(desc)}</description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>TenderFlow — Public tenders / المناقصات العامة</title>
    <link>${x(`${base}/tenders`)}</link>
    <atom:link href="${x(`${base}/api/v1/public/tenders.rss`)}" rel="self" type="application/rss+xml"/>
    <description>Open tenders published by participating government entities / المناقصات المفتوحة المنشورة من الجهات المشاركة</description>
    <lastBuildDate>${now().toUTCString()}</lastBuildDate>
    <ttl>15</ttl>
${items}
  </channel>
</rss>
`;
}

function jsonFeed(ctx: Ctx, list: PublicTender[]) {
  const base = ctx.config.publicBaseUrl;
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'TenderFlow — Public tenders / المناقصات العامة',
    home_page_url: `${base}/tenders`,
    feed_url: `${base}/api/v1/public/tenders.json`,
    language: 'ar-KW',
    items: list.map((t) => ({
      id: `tenderflow:${t.entity.id}:${t.tenderNumber}`,
      url: t.url,
      title: `${t.tenderNumber} — ${t.titleEn} / ${t.titleAr}`,
      content_text: `${t.entity.nameEn} / ${t.entity.nameAr}. Deadline / الموعد النهائي: ${t.submissionDeadline}.`,
      date_published: t.publishedAt ?? undefined,
      tags: [t.category, ...t.activityCodes.map((a) => a.code)],
      _tenderflow: t,
    })),
  };
}

/** Registered BEFORE the authentication middleware (see features/index.ts registerPublicFeatureRoutes). */
export function registerPublicBoardRoutes(r: express.Router, ctx: Ctx): void {
  const limiter = rateLimit({
    windowMs: 60_000, limit: ctx.config.publicBoardRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => { res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests to the public tender board, try again later' }); },
  });
  const cache = (res: express.Response) => { res.setHeader('Cache-Control', 'public, max-age=60'); res.setHeader('X-Content-Type-Options', 'nosniff'); };
  r.get('/public/tenders', limiter, h(async (req, res) => { cache(res); return listPublicTenders(ctx, parseFilters(req.query as Record<string, unknown>)); }));
  r.get('/public/tenders.rss', limiter, h(async (req, res) => {
    const out = await listPublicTenders(ctx, parseFilters(req.query as Record<string, unknown>));
    cache(res);
    res.type('application/rss+xml; charset=utf-8').send(rss(ctx, out.tenders));
  }));
  r.get('/public/tenders.json', limiter, h(async (req, res) => {
    const out = await listPublicTenders(ctx, parseFilters(req.query as Record<string, unknown>));
    cache(res);
    res.type('application/feed+json; charset=utf-8').send(JSON.stringify(jsonFeed(ctx, out.tenders)));
  }));
}
