// HARDEN: pdf.js rendering for the protected viewer (PDFs and images). The server stamps the watermark (user, time,
// entity / vendor, reference) into the PDF before it leaves (GET /documents/:id/view-bytes, single-use 60-second
// grant), so what is painted here already carries it. Pages are painted into <canvas> only: no text layer (nothing to
// select or copy), no annotation layer, no pdf.js toolbar, no download or print UI. The bytes stay in memory and are
// handed to the pdf.js worker; nothing is written to a blob: URL or the cache (the response is no-store).
// pdf.js is loaded lazily (its own chunk) and its worker, fonts and CMaps are same-origin files (vite-plugin-pdfjs.ts),
// so the page works under the strict CSP (script-src 'self', worker-src 'self', no eval: isEvalSupported=false).
import { useEffect, useRef } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { secApi, type ViewGrant } from './api';

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${__PDFJS_BASE__}pdf.worker.min.mjs`;
    return m;
  });
  return pdfjsPromise;
}

const MAX_CSS_WIDTH = 900;

export function PdfPages({
  documentId,
  pageLabel,
  onOpened,
  onError,
}: {
  documentId: string;
  pageLabel: (n: number, total: number) => string;
  onOpened: (g: ViewGrant, pages: number) => void;
  onError: (e: unknown) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const cb = useRef({ onOpened, onError, pageLabel });
  cb.current = { onOpened, onError, pageLabel };

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    let doc: PDFDocumentProxy | null = null;
    const el = holder.current;
    (async () => {
      const grant = await secApi.viewGrant(documentId);
      if (cancelled) return; // never spend a grant for a viewer that is already closed
      const [pdfjs, bytes] = await Promise.all([loadPdfJs(), secApi.viewBytes(documentId, grant.grant)]);
      if (cancelled) return;
      task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        enableXfa: false,
        standardFontDataUrl: `${__PDFJS_BASE__}standard_fonts/`,
        cMapUrl: `${__PDFJS_BASE__}cmaps/`,
        cMapPacked: true,
      });
      doc = await task.promise;
      if (cancelled || !el) return;
      cb.current.onOpened(grant, doc.numPages);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n);
        const unit = page.getViewport({ scale: 1 });
        const cssWidth = Math.min(MAX_CSS_WIDTH, Math.max(320, (el.clientWidth || MAX_CSS_WIDTH) - 8));
        const viewport = page.getViewport({ scale: (cssWidth / unit.width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.className = 'security-sheet';
        canvas.dir = 'ltr'; // pdf.js positions every glyph run itself; an inherited RTL canvas direction would reorder them
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', cb.current.pageLabel(n, doc.numPages));
        el.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
        page.cleanup();
      }
    })().catch((e) => {
      if (!cancelled) cb.current.onError(e);
    });
    return () => {
      cancelled = true;
      void task?.destroy();
      void doc?.destroy();
      if (el) el.replaceChildren();
    };
  }, [documentId]);

  return <div ref={holder} className="security-pdf-pages" dir="ltr" />;
}
