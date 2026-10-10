// SEC-001/002, FR-023: protected tender-document viewer for vendors, and the DocList row actions that replace the
// plain download for protected documents. The server sends the page text (with an invisible per-view fingerprint)
// and the watermark lines; text and a tiled watermark are painted into the same <canvas> pixels, so the text is
// never in the DOM (no selection/copy) and any screenshot carries the vendor's identity. Deterrents: no download
// button in VIEW_ONLY mode, right-click/copy/print/save blocked, content blurred when the window loses focus,
// PrintScreen → blur + audit event, @media print hides the content. A browser cannot technically prevent screenshots
// or phone cameras — the UI says so.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type DocumentMeta } from '../../api';
import { useI18n } from '../../i18n';
import { useSession } from '../../session';
import { DocButton } from '../../components/Layout';
import { Badge, Button, ErrorBox, Spinner } from '../../components/ui';
import { secApi, VIEWABLE_MIME, type DocAccess, type ViewEvent, type ViewGrant, type ViewPage, type ViewSession } from './api';
import { PdfPages } from './PdfViewer';

/** HARDEN: server answers on which the pdf.js viewer falls back to the text viewer. */
const TEXT_FALLBACK = ['VIEWER_FORMAT_UNSUPPORTED', 'PDF_ENCRYPTED', 'PDF_UNREADABLE', 'IMAGE_UNREADABLE'];
export const isViewable = (mimeType?: string) => !!mimeType && VIEWABLE_MIME.includes(mimeType.toLowerCase());

const PROTECTABLE = ['TENDER_PACK', 'ADDENDUM'];

/** One request for all rows of a DocList (vendors only; staff always see originals). */
export function useContentAccess(docs: DocumentMeta[]) {
  const { hasRole } = useSession();
  const vendor = hasRole('VENDOR');
  const ids = docs.filter((d) => !d.ownerType || PROTECTABLE.includes(d.ownerType)).map((d) => d.id);
  const key = vendor ? ids.join(',') : '';
  const [map, setMap] = useState<Record<string, DocAccess>>({});
  const [loading, setLoading] = useState(Boolean(key));
  useEffect(() => {
    if (!key) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    secApi
      .documentAccess(key.split(','))
      .then((list) => alive && setMap(Object.fromEntries(list.map((a) => [a.documentId, a]))))
      .catch(() => alive && setMap({})) // the original-download route still enforces protection on the server
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [key]);
  /** 'protected' → viewer actions; 'plain' → the normal download; 'loading' → nothing yet (avoid a refused click). */
  const decide = (d: DocumentMeta): 'protected' | 'plain' | 'loading' => {
    if (!vendor || !ids.includes(d.id)) return 'plain';
    if (loading) return 'loading';
    return map[d.id]?.protected ? 'protected' : 'plain';
  };
  return { map, decide };
}
export type ContentAccessHook = ReturnType<typeof useContentAccess>;

/** Row actions for a protected document: protected viewer + (when allowed) the watermarked PDF. */
export function ProtectedDocActions({ doc, access }: { doc: DocumentMeta; access: DocAccess | undefined }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!access) return null;
  return (
    <span className="security-doc-actions">
      <Button variant="ghost" onClick={() => setOpen(true)} aria-label={`${t('security.viewer.view')}: ${doc.title}`} title={t('security.viewer.honest')}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        {t('security.viewer.view')}
      </Button>
      {access.download === 'WATERMARKED' && (
        <DocButton path={secApi.watermarkedPath(doc.id)} name={doc.title} label={t('security.viewer.downloadWatermarked')} />
      )}
      {access.download === 'PURCHASE_REQUIRED' && <span className="muted small">{t('security.viewer.purchaseFirst')}</span>}
      {access.download === 'VIEW_ONLY_FORMAT' && <span className="muted small">{t('security.viewer.viewOnlyFormat')}</span>}
      {access.download === 'NONE' && <Badge label={t('security.viewer.viewOnly')} tone="warn" />}
      {open && <ProtectedViewer documentId={doc.id} mimeType={doc.mimeType} onClose={() => setOpen(false)} />}
    </span>
  );
}

/** HARDEN: "View" for any readable PDF / image (staff and vendors): the protected pdf.js viewer, watermarked, audited. */
export function ViewDocButton({ documentId, mimeType, title }: { documentId: string; mimeType?: string; title: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!isViewable(mimeType)) return null;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} aria-label={`${t('harden.viewer.view')}: ${title}`} title={t('harden.viewer.viewHint')}>
        {t('harden.viewer.view')}
      </Button>
      {open && <ProtectedViewer documentId={documentId} mimeType={mimeType} onClose={() => setOpen(false)} />}
    </>
  );
}

// ---------------------------------------------------------------- canvas painting

const PAGE_W = 794; // A4 at 96 dpi
const PAGE_H = 1123;
const MARGIN = 64;
const FONT_PX = 15;
const LINE_H = 23;
const FONT = `${FONT_PX}px 'Segoe UI', 'Noto Sans Arabic', 'Noto Sans', Tahoma, Arial, sans-serif`;
const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxW && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Split one server page into canvas-sized sheets of wrapped lines. */
function sheetsOf(text: string): string[][] {
  const c = document.createElement('canvas').getContext('2d')!;
  c.font = FONT;
  const lines = wrap(c, text, PAGE_W - 2 * MARGIN);
  const perSheet = Math.floor((PAGE_H - 2 * MARGIN - 40) / LINE_H);
  const sheets: string[][] = [];
  for (let i = 0; i < lines.length; i += perSheet) sheets.push(lines.slice(i, i + perSheet));
  return sheets.length ? sheets : [[]];
}

function paintWatermark(ctx: CanvasRenderingContext2D, lines: string[], footer: string) {
  ctx.save();
  ctx.globalAlpha = 0.14;
  ctx.fillStyle = '#a3121b';
  ctx.font = `600 15px 'Segoe UI', 'Noto Sans Arabic', Tahoma, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.direction = 'ltr';
  ctx.translate(PAGE_W / 2, PAGE_H / 2);
  ctx.rotate(-Math.PI / 6);
  const block = lines.length * 20 + 50;
  for (let y = -PAGE_H; y < PAGE_H; y += block) {
    for (let x = -PAGE_W; x < PAGE_W * 1.1; x += 330) {
      lines.forEach((l, i) => {
        ctx.direction = ARABIC.test(l) ? 'rtl' : 'ltr';
        ctx.fillText(l, x + ((Math.round(y / block) % 2) * 165), y + i * 20);
      });
    }
  }
  ctx.restore();
  // Footer band on every sheet.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillRect(0, PAGE_H - 30, PAGE_W, 30);
  ctx.fillStyle = '#7a1016';
  ctx.font = `11px 'Segoe UI', 'Noto Sans Arabic', Tahoma, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(footer, PAGE_W / 2, PAGE_H - 11, PAGE_W - 24);
  ctx.restore();
}

type Sheet = { kind: 'text'; lines: string[] } | { kind: 'image'; dataUrl: string } | { kind: 'empty'; reason: string; pageNumber: number };

function SheetCanvas({ sheet, wm, footer, label, emptyText }: { sheet: Sheet; wm: string[]; footer: string; label: string; emptyText: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = PAGE_W * dpr;
    canvas.height = PAGE_H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    let cancelled = false;
    const finish = () => !cancelled && paintWatermark(ctx, wm, footer);
    if (sheet.kind === 'text') {
      ctx.fillStyle = '#18212f';
      ctx.font = FONT;
      ctx.textBaseline = 'alphabetic';
      sheet.lines.forEach((l, i) => {
        const rtl = ARABIC.test(l);
        ctx.direction = rtl ? 'rtl' : 'ltr';
        ctx.textAlign = rtl ? 'right' : 'left';
        ctx.fillText(l, rtl ? PAGE_W - MARGIN : MARGIN, MARGIN + (i + 1) * LINE_H);
      });
      finish();
    } else if (sheet.kind === 'image') {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const s = Math.min((PAGE_W - 2 * MARGIN) / img.width, (PAGE_H - 2 * MARGIN) / img.height, 1);
        ctx.drawImage(img, (PAGE_W - img.width * s) / 2, MARGIN, img.width * s, img.height * s);
        finish();
      };
      img.onerror = finish;
      img.src = sheet.dataUrl;
    } else {
      ctx.fillStyle = '#6b7686';
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.fillText(emptyText, PAGE_W / 2, PAGE_H / 2, PAGE_W - 2 * MARGIN);
      finish();
    }
    return () => {
      cancelled = true;
    };
  }, [sheet, wm, footer, emptyText]);
  return <canvas ref={ref} className="security-sheet" role="img" aria-label={label} style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}` }} />;
}

// ---------------------------------------------------------------- viewer

export function ProtectedViewer({ documentId, mimeType, onClose }: { documentId: string; mimeType?: string; onClose: () => void }) {
  const { t, te, lang } = useI18n();
  const isVendorUser = useSession().hasRole('VENDOR');
  const [view, setView] = useState<ViewSession | null>(null);
  const [err, setErr] = useState<unknown>(null);
  // HARDEN: PDFs and images → pdf.js on canvas with the server-stamped watermark; other formats (and PDFs that
  // cannot be stamped) → the text viewer below.
  const [textMode, setTextMode] = useState(!isViewable(mimeType));
  const [grant, setGrant] = useState<ViewGrant | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const onPdfOpened = useCallback((g: ViewGrant, n: number) => {
    setGrant(g);
    setPdfPages(n);
  }, []);
  const onPdfError = useCallback((e: unknown) => {
    if (e instanceof ApiError && TEXT_FALLBACK.includes(e.code)) setTextMode(true);
    else setErr(e);
  }, []);
  const pageLabel = useCallback((n: number, total: number) => t('security.viewer.pageLabel', { n, total }), [t]);
  const viewId = view?.viewId ?? grant?.viewId ?? null;
  const title = view?.title ?? grant?.title;
  const mode = view?.mode ?? grant?.mode;
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sent = useRef<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!textMode) return;
    let alive = true;
    secApi
      .openView(documentId)
      .then((v) => alive && setView(v))
      .catch((e) => alive && setErr(e));
    return () => {
      alive = false;
    };
  }, [documentId, textMode]);

  const report = useCallback(
    (type: ViewEvent) => {
      if (!viewId) return;
      const n = sent.current[type] ?? 0;
      if (n >= 3) return; // the server also caps events per view
      sent.current[type] = n + 1;
      secApi.viewEvent(viewId, type).catch(() => undefined);
    },
    [viewId],
  );

  useEffect(() => {
    rootRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('security-viewing');
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') onClose();
      if (e.key === 'PrintScreen') {
        setHidden(true);
        setNotice(t('security.viewer.printScreen'));
        report('PRINTSCREEN_KEY');
        try {
          void navigator.clipboard?.writeText(' ');
        } catch {
          /* clipboard not available */
        }
      }
      if ((e.ctrlKey || e.metaKey) && ['p', 's', 'c', 'a'].includes(k)) {
        e.preventDefault();
        setNotice(t('security.viewer.blocked'));
        report(k === 'p' ? 'PRINT_ATTEMPT' : k === 's' ? 'SAVE_ATTEMPT' : 'COPY_ATTEMPT');
      }
    };
    const onBlur = () => setHidden(true);
    const onVis = () => document.visibilityState === 'hidden' && setHidden(true);
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      report('COPY_ATTEMPT');
    };
    const onPrint = () => report('PRINT_ATTEMPT');
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true); // Windows delivers PrintScreen on key-up only
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('copy', onCopy);
    window.addEventListener('beforeprint', onPrint);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.classList.remove('security-viewing');
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('copy', onCopy);
      window.removeEventListener('beforeprint', onPrint);
    };
  }, [onClose, report, t]);

  const wm = view ? (lang === 'ar' ? view.watermark.linesAr : view.watermark.lines) : [];
  const footer = view ? `${wm.join(' · ')} · ${t('security.viewer.footer')}` : '';
  const sheets: Sheet[] = [];
  if (view) {
    for (const p of view.pages as ViewPage[]) {
      if (p.kind === 'text') for (const lines of sheetsOf(p.text)) sheets.push({ kind: 'text', lines });
      else sheets.push(p);
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className="security-viewer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-viewer-title"
      onContextMenu={(e) => {
        e.preventDefault();
        report('CONTEXT_MENU');
      }}
      onDragStart={(e) => e.preventDefault()}
    >
      <header className="security-viewer-head">
        <div className="security-viewer-title">
          <h2 id="security-viewer-title">{title ?? t('security.viewer.title')}</h2>
          {(view || grant) && (
            <span className="row wrap">
              {mode && mode !== 'OFF' && <Badge label={te('security.content.', mode)} tone="warn" />}
              {grant && <Badge label={t('harden.viewer.watermarked')} tone="info" />}
              {grant && pdfPages > 0 && <span className="muted small">{t('harden.viewer.pages', { n: pdfPages })}</span>}
              <span className="muted small">{t('security.viewer.audited')}</span>
            </span>
          )}
        </div>
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      </header>
      <p className="security-viewer-honest small">{t(isVendorUser ? 'security.viewer.honest' : 'harden.viewer.honestStaff')}</p>
      {notice && (
        <div className="alert alert-warn security-viewer-notice" role="status">
          {notice}
        </div>
      )}
      <div className={`security-viewer-body ${hidden ? 'security-hidden' : ''}`}>
        {err ? <ErrorBox error={err} /> : textMode ? (!view ? <Spinner label={t('security.viewer.preparing')} /> : null) : !grant ? <Spinner label={t('security.viewer.preparing')} /> : null}
        {!textMode && !err && <PdfPages documentId={documentId} pageLabel={pageLabel} onOpened={onPdfOpened} onError={onPdfError} />}
        {textMode && view &&
          sheets.map((s, i) => (
            <SheetCanvas
              key={`${view.viewId}-${i}`}
              sheet={s}
              wm={wm}
              footer={footer}
              label={t('security.viewer.pageLabel', { n: i + 1, total: sheets.length })}
              emptyText={s.kind === 'empty' ? te('security.viewer.empty.', s.reason) : ''}
            />
          ))}
      </div>
      {hidden && (
        <div className="security-veil" role="status">
          <p>{t('security.viewer.hidden')}</p>
          <Button
            onClick={() => {
              setHidden(false);
              setNotice(null);
            }}
          >
            {t('security.viewer.resume')}
          </Button>
        </div>
      )}
      <div className="security-print-block">{t('security.viewer.printBlocked')}</div>
    </div>,
    document.body,
  );
}
