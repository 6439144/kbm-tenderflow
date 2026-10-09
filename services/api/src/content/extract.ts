// Text extraction for AI grounding: PDF (unpdf, one section per page), DOCX (mammoth),
// TXT/MD/HTML (tags stripped, split by headings or ~1500-char chunks). Images yield no sections.
import type { DocText } from '../ai/index.js';

const CHUNK = 1500;

function chunk(text: string, label: string): { section: string; text: string }[] {
  const out: { section: string; text: string }[] = [];
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let buf = '';
  const flush = () => { if (buf.trim()) out.push({ section: `${label} ${out.length + 1}`, text: buf.trim() }); buf = ''; };
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > CHUNK) flush();
    if (p.length > CHUNK) {
      for (let i = 0; i < p.length; i += CHUNK) { buf = p.slice(i, i + CHUNK); flush(); }
    } else buf += (buf ? '\n\n' : '') + p;
  }
  flush();
  return out;
}

/** Split text on markdown headings (## ...) or, if there are none, on top-level numbered headings
 * ("1. Scope"). Sub-items ("3.2 ...") stay inside their section. Falls back to ~1500-char chunks. */
export function splitByHeadings(text: string): { section: string; text: string }[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const mdRe = /^\s*#{1,6}\s+\S/;
  const numRe = /^\s*\d+[.)]\s+\S.{0,120}$/;
  const headingRe = lines.filter((l) => mdRe.test(l)).length >= 2 ? mdRe : lines.filter((l) => numRe.test(l)).length >= 2 ? numRe : null;
  if (!headingRe) return chunk(text, 'part');
  const sections: { section: string; lines: string[] }[] = [];
  const pre: string[] = [];
  for (const line of lines) {
    if (headingRe.test(line) && line.trim().length <= 160) sections.push({ section: line.replace(/^\s*#+\s*/, '').trim(), lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else pre.push(line);
  }
  const result = sections
    .map((s) => ({ section: s.section, text: s.lines.join('\n').trim() || s.section }))
    .flatMap((s) => (s.text.length > CHUNK * 2 ? chunk(s.text, s.section) : [s]));
  const intro = pre.join('\n').trim();
  if (intro) result.unshift({ section: 'introduction', text: intro });
  return result;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

export async function extractText(doc: { documentId: string; title: string; mimeType: string }, bytes: Buffer): Promise<DocText> {
  const base = { documentId: doc.documentId, title: doc.title };
  const mt = doc.mimeType.toLowerCase();
  if (mt === 'application/pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await pdfText(pdf, { mergePages: false });
    return { ...base, sections: text.map((t, i) => ({ section: `page ${i + 1}`, text: t.trim() })).filter((s) => s.text) };
  }
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    return { ...base, sections: splitByHeadings(value) };
  }
  if (mt === 'text/html') return { ...base, sections: splitByHeadings(stripHtml(bytes.toString('utf8'))) };
  if (mt.startsWith('text/')) return { ...base, sections: splitByHeadings(bytes.toString('utf8')) };
  return { ...base, sections: [] };
}
