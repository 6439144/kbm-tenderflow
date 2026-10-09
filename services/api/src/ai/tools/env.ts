// Helpers for the AI CLI tools (verify-ai, run-evals): locate the repo root and load its .env.
// Values from .env never override variables already set in the process environment.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isRepoRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try { return Array.isArray((JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown }).workspaces); } catch { return false; }
}

/** Finds the monorepo root (package.json with "workspaces") walking up from cwd, then from this module. */
export function findRepoRoot(): string {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      if (isRepoRoot(dir)) return dir;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('Could not locate the repository root (package.json with "workspaces"). Run from inside the repo.');
}

/** Parses KEY=VALUE lines (comments, blank lines, optional quotes, "export " prefix). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/** Loads <repoRoot>/.env into process.env (without overriding). Returns the path loaded, or undefined if absent. */
export function loadRepoEnv(root = findRepoRoot()): string | undefined {
  const p = join(root, '.env');
  if (!existsSync(p)) return undefined;
  const vars = parseDotEnv(readFileSync(p, 'utf8'));
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return p;
}
