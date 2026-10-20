// Build identity for GET /api/v1/version and the start-up log. The version comes from TF_VERSION (set by the
// container build) or services/api/package.json; TF_COMMIT and TF_BUILD_TIME are passed as build arguments. A release
// package (scripts/release/build-azure-package.sh) carries them in services/api/build-info.json instead.
import fs from 'node:fs';
import path from 'node:path';
import { API_ROOT } from '../config.js';

export interface VersionInfo { name: string; version: string; commit: string | null; buildTime: string | null }

const clean = (v: string | undefined, max: number, re: RegExp) => {
  const s = v?.trim();
  return s && s.length <= max && re.test(s) ? s : null;
};

export function versionInfo(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  let pkgVersion = 'unknown';
  try { pkgVersion = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'package.json'), 'utf8')).version ?? 'unknown'; } catch { /* keep unknown */ }
  let file: { commit?: string; buildTime?: string } = {};
  try { file = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'build-info.json'), 'utf8')) ?? {}; } catch { /* not a release package */ }
  env = { ...env, TF_COMMIT: env.TF_COMMIT ?? file.commit, TF_BUILD_TIME: env.TF_BUILD_TIME ?? file.buildTime };
  return {
    name: 'TenderFlow',
    version: clean(env.TF_VERSION, 64, /^[0-9A-Za-z.+_-]+$/) ?? pkgVersion,
    commit: clean(env.TF_COMMIT, 64, /^[0-9a-fA-F]{7,64}$/),
    buildTime: (() => { const t = clean(env.TF_BUILD_TIME, 40, /^[0-9T:.Z+-]+$/); return t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : null; })(),
  };
}
