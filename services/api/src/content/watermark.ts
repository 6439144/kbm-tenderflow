// Watermarking for protected tender documents (MOI SEC-001/002, FR-023).
// - stampPdf: a NEW PDF with a diagonal tiled stamp and a footer on every page (pdf-lib). The stored original is
//   never modified. Standard PDF fonts are Latin-only, so the stamp uses the vendor's English legal name; characters
//   outside Latin-1 are replaced with '?'.
// - fingerprintText / readFingerprint: the text sent to the protected viewer carries the view id as invisible
//   zero-width characters after spaces, so text scraped from the API (bypassing the canvas) is still traceable.
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { ApiError } from '../util.js';

export interface Watermark {
  /** e.g. ["ACME Trading Co.", "Vendor 1a2b3c4d · CR-12345", "user vendor1", "2026-10-10 09:12 UTC", "ref 9f8e7d6c"] */
  lines: string[];
  /** One-line footer stamped at the bottom of each page. */
  footer: string;
}

const latin1 = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

export async function stampPdf(original: Buffer, wm: Watermark, meta: { id: string; title?: string }): Promise<Buffer> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
    if (doc.getPageCount() < 1) throw new Error('no pages');
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/encrypt/i.test(msg)) throw new ApiError(409, 'PDF_ENCRYPTED', 'This PDF is encrypted and cannot be watermarked; it is available in the protected viewer only');
    throw new ApiError(409, 'PDF_UNREADABLE', 'This PDF could not be read for watermarking; it is available in the protected viewer only');
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const stamp = latin1(wm.lines.join('  ·  '));
  const footer = latin1(wm.footer);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(9, Math.min(16, width / 45));
    const textW = bold.widthOfTextAtSize(stamp, size);
    const angle = 35;
    const rad = (angle * Math.PI) / 180;
    const stepX = textW * Math.cos(rad) + 60;
    const stepY = size * 7;
    // Tiled diagonal stamp across the whole page (start outside the page so rotated rows cover the corners).
    for (let y = -height; y < height * 1.5; y += stepY) {
      for (let x = -width; x < width * 1.2; x += stepX) {
        page.drawText(stamp, { x, y, size, font: bold, color: rgb(0.75, 0.1, 0.1), opacity: 0.16, rotate: degrees(angle) });
      }
    }
    // Footer band.
    const fs = Math.max(6, Math.min(8, width / 80));
    page.drawRectangle({ x: 0, y: 0, width, height: fs * 2.6, color: rgb(1, 1, 1), opacity: 0.85 });
    let f = footer;
    while (f.length > 10 && font.widthOfTextAtSize(f, fs) > width - 24) f = f.slice(0, -2);
    page.drawText(f, { x: 12, y: fs * 0.9, size: fs, font, color: rgb(0.45, 0.05, 0.05) });
  }
  doc.setSubject(latin1(`Licensed copy ${meta.id} — ${wm.lines.join(' / ')}`));
  doc.setKeywords(['TenderFlow', 'watermarked', meta.id]);
  doc.setProducer('TenderFlow watermark (pdf-lib)');
  doc.setModificationDate(new Date());
  return Buffer.from(await doc.save());
}

// ---------------- invisible text fingerprint ----------------
const ZERO = '​'; // zero width space
const ONE = '⁠';  // word joiner
const FP_BITS = 32;

function bitsOf(id: string): string {
  const hex = id.replace(/[^0-9a-f]/gi, '').slice(0, 8).padEnd(8, '0');
  return parseInt(hex, 16).toString(2).padStart(FP_BITS, '0');
}

/** Insert the first 32 bits of `id` (hex) as zero-width characters after spaces, repeating from the start of the text. */
export function fingerprintText(text: string, id: string): string {
  const bits = bitsOf(id);
  let k = 0;
  const out = text.replace(/ /g, () => ` ${bits[k++ % FP_BITS] === '1' ? ONE : ZERO}`);
  // Short pages (fewer than 32 spaces): the remaining bits go invisibly at the end of the page.
  let tail = '';
  while (k < FP_BITS) tail += bits[k++] === '1' ? ONE : ZERO;
  return out + tail;
}

/** Recover the 8-hex-digit id prefix from a fingerprinted page (or a fragment that starts at the page start and has ≥ 32 spaces). */
export function readFingerprint(text: string): string | null {
  const bits = Array.from(text.matchAll(/[​⁠]/g), (m) => (m[0] === ONE ? '1' : '0')).join('');
  if (bits.length < FP_BITS) return null;
  return parseInt(bits.slice(0, FP_BITS), 2).toString(16).padStart(8, '0');
}
