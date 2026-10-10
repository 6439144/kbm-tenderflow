// HARDEN: ships the pdf.js worker (and the standard-font / CMap data pdf.js fetches) as same-origin static files
// under /pdfjs/<version>/, so the protected viewer works under CSP `worker-src 'self'` / `connect-src 'self'` with
// no CDN and no blob: worker. Build: files are emitted into dist/pdfjs/<version>/. Dev server: served from
// node_modules. The viewer reads the base path from the compile-time constant __PDFJS_BASE__.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

export function pdfjsAssets(): Plugin {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const version: string = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const base = `/pdfjs/${version}/`;
  // published path (relative to base) → file in pdfjs-dist
  const files = new Map<string, string>([['pdf.worker.min.mjs', path.join(root, 'build', 'pdf.worker.min.mjs')]]);
  for (const dir of ['standard_fonts', 'cmaps']) {
    for (const f of fs.readdirSync(path.join(root, dir))) files.set(`${dir}/${f}`, path.join(root, dir, f));
  }
  const typeOf = (p: string) => (p.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream');
  return {
    name: 'tenderflow-pdfjs-assets',
    config() {
      return { define: { __PDFJS_BASE__: JSON.stringify(base) } };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(base)) return next();
        const file = files.get(decodeURIComponent(url.slice(base.length)));
        if (!file) return next();
        res.setHeader('Content-Type', typeOf(file));
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [rel, file] of files) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/${version}/${rel}`, source: fs.readFileSync(file) });
      }
    },
  };
}
