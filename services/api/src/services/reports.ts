// Bilingual (Arabic RTL + English) HTML reports: opening record and committee report.
import { escapeHtml as e } from '../util.js';
import type { TenderRow } from './tenders.js';

const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');

function page(title: string, ar: string, en: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;margin:2rem;color:#1a1a1a}
section{border:1px solid #ccc;border-radius:6px;padding:1rem 1.5rem;margin-bottom:2rem}
table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border:1px solid #bbb;padding:.35rem .5rem;text-align:start;vertical-align:top}
th{background:#f0f3f5}code{font-size:.8em;word-break:break-all}
</style></head><body>
<section dir="rtl" lang="ar">${ar}</section>
<section dir="ltr" lang="en">${en}</section>
</body></html>`;
}

export interface OpeningBidSummary {
  bidId: string; vendorNameEn: string; vendorNameAr: string; submittedAt: Date; receiptSha256: string; integrity: string;
  files: { title: string; type: string; sha256: string }[];
}

export function openingRecordHtml(i: { tender: TenderRow; openedAt: Date; chair: string; attendees: string[]; notes: string | null; bids: OpeningBidSummary[] }): string {
  const t = i.tender;
  const rows = (lang: 'ar' | 'en') => i.bids.map((b, n) => `<tr><td>${n + 1}</td><td>${e(lang === 'ar' ? b.vendorNameAr : b.vendorNameEn)}</td>
<td>${fmt(b.submittedAt)}</td><td><code>${e(b.receiptSha256)}</code></td><td>${e(b.integrity)}</td>
<td>${b.files.map((f) => `${e(f.type)}: ${e(f.title)}<br><code>${e(f.sha256)}</code>`).join('<br>')}</td></tr>`).join('\n');
  const att = i.attendees.map((a) => `<li>${e(a)}</li>`).join('');
  const ar = `<h1>محضر فتح المظاريف</h1>
<p><b>المناقصة:</b> ${e(t.tender_number)} — ${e(t.title_ar)}</p>
<p><b>الموعد النهائي لتقديم العطاءات:</b> ${fmt(t.submission_deadline)}<br><b>وقت الفتح:</b> ${fmt(i.openedAt)}<br><b>رئيس اللجنة:</b> ${e(i.chair)}</p>
<h2>الحضور</h2><ul>${att}</ul>
<h2>العطاءات المستلمة (${i.bids.length})</h2>
<table><tr><th>#</th><th>المورد</th><th>وقت التقديم</th><th>بصمة الإيصال SHA-256</th><th>التحقق من السلامة</th><th>الملفات</th></tr>${rows('ar')}</table>
${i.notes ? `<h2>ملاحظات</h2><p>${e(i.notes)}</p>` : ''}`;
  const en = `<h1>Bid Opening Record</h1>
<p><b>Tender:</b> ${e(t.tender_number)} — ${e(t.title_en)}</p>
<p><b>Submission deadline:</b> ${fmt(t.submission_deadline)}<br><b>Opened at:</b> ${fmt(i.openedAt)}<br><b>Committee chair:</b> ${e(i.chair)}</p>
<h2>Attendees</h2><ul>${att}</ul>
<h2>Bids received (${i.bids.length})</h2>
<table><tr><th>#</th><th>Vendor</th><th>Submitted</th><th>Receipt SHA-256</th><th>Integrity check</th><th>Files</th></tr>${rows('en')}</table>
${i.notes ? `<h2>Notes</h2><p>${e(i.notes)}</p>` : ''}`;
  return page(`Opening record ${t.tender_number}`, ar, en);
}

export interface ReportBid {
  bidId: string; vendorNameEn: string; vendorNameAr: string; receiptSha256: string; averageScore: number | null;
  evaluations: { evaluator: string; weightedTotal: number }[];
  compliance: { requirement: string; status: string; evidence?: string }[] | null;
}

export function committeeReportHtml(i: {
  tender: TenderRow; bids: ReportBid[]; awardedBidId: string; recommendedBy: string; justification: string; approvedBy: string;
  approvalReason: string | null; approvedAt: Date;
}): string {
  const t = i.tender;
  const crit = t.criteria;
  const winner = i.bids.find((b) => b.bidId === i.awardedBidId);
  const table = (lang: 'ar' | 'en') => i.bids.map((b) => `<tr${b.bidId === i.awardedBidId ? ' style="background:#e8f5e9"' : ''}>
<td>${e(lang === 'ar' ? b.vendorNameAr : b.vendorNameEn)}</td><td><code>${e(b.receiptSha256)}</code></td>
<td>${b.evaluations.map((x) => `${e(x.evaluator)}: ${x.weightedTotal.toFixed(2)}`).join('<br>') || '—'}</td>
<td>${b.averageScore === null ? '—' : b.averageScore.toFixed(2)}</td>
<td>${b.compliance ? b.compliance.map((c) => `${e(c.requirement)}: <b>${e(c.status)}</b>`).join('<br>') : (lang === 'ar' ? 'لم يتم الفحص' : 'Not screened')}</td></tr>`).join('\n');
  const critList = (lang: 'ar' | 'en') => crit.map((c) => `<li>${e(lang === 'ar' ? c.name_ar : c.name_en)} — ${c.weight}%</li>`).join('');
  const ar = `<h1>تقرير لجنة التقييم والترسية</h1>
<p><b>المناقصة:</b> ${e(t.tender_number)} — ${e(t.title_ar)}</p>
<h2>معايير التقييم</h2><ul>${critList('ar')}</ul>
<h2>العطاءات والدرجات</h2>
<table><tr><th>المورد</th><th>بصمة الإيصال</th><th>درجات المقيّمين (مرجحة)</th><th>المتوسط</th><th>فحص الامتثال (استرشادي)</th></tr>${table('ar')}</table>
<h2>القرار</h2>
<p>ترسية المناقصة على <b>${e(winner?.vendorNameAr ?? i.awardedBidId)}</b>.</p>
<p><b>التوصية من:</b> ${e(i.recommendedBy)} — ${e(i.justification)}</p>
<p><b>الاعتماد من:</b> ${e(i.approvedBy)} في ${fmt(i.approvedAt)}${i.approvalReason ? ` — ${e(i.approvalReason)}` : ''}</p>
<p><small>نتائج فحص الامتثال الآلي استرشادية فقط؛ القرار للجنة.</small></p>`;
  const en = `<h1>Evaluation Committee &amp; Award Report</h1>
<p><b>Tender:</b> ${e(t.tender_number)} — ${e(t.title_en)}</p>
<h2>Evaluation criteria</h2><ul>${critList('en')}</ul>
<h2>Bids and scores</h2>
<table><tr><th>Vendor</th><th>Receipt hash</th><th>Evaluator scores (weighted)</th><th>Average</th><th>Compliance screening (advisory)</th></tr>${table('en')}</table>
<h2>Decision</h2>
<p>Tender awarded to <b>${e(winner?.vendorNameEn ?? i.awardedBidId)}</b>.</p>
<p><b>Recommended by:</b> ${e(i.recommendedBy)} — ${e(i.justification)}</p>
<p><b>Approved by:</b> ${e(i.approvedBy)} at ${fmt(i.approvedAt)}${i.approvalReason ? ` — ${e(i.approvalReason)}` : ''}</p>
<p><small>Automated compliance screening results are advisory only; the decision is the committee's.</small></p>`;
  return page(`Committee report ${t.tender_number}`, ar, en);
}
