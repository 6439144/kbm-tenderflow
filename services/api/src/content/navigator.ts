// IBM Content Navigator deep links for FileNet P8 documents.
//
// ASSUMED (not verified live): the bookmark format below. IBM documents bookmark.jsp with the parameters desktop,
// repositoryId, docid, template_name and an optional version ("Constructing a URL for IBM Content Navigator"); the P8 docid
// value "<class>,<objectStoreGuid>,<documentGuid>" and repositoryType=p8 follow the links Navigator itself
// produces with "Copy link". If the live Navigator answers with an error, change only this function.
import type { RepositoryDescription } from './types.js';

export interface NavigatorConfig { baseUrl: string; desktop: string; repositoryId: string }

/** Reads FILENET_NAVIGATOR_URL / _DESKTOP / _REPOSITORY. Returns null when no Navigator URL is configured. */
export function navigatorConfig(env: NodeJS.ProcessEnv = process.env): NavigatorConfig | null {
  const raw = env.FILENET_NAVIGATOR_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return {
    baseUrl: raw.replace(/\/+$/, '').replace(/\/bookmark\.jsp$/, ''),
    desktop: env.FILENET_NAVIGATOR_DESKTOP?.trim() || 'ICN',
    repositoryId: env.FILENET_NAVIGATOR_REPOSITORY?.trim() || env.FILENET_OBJECT_STORE?.trim() || '',
  };
}

/** Bookmark URL for one document version, or null when Navigator is not configured or the description is incomplete. */
export function navigatorUrl(cfg: NavigatorConfig | null, d: Pick<RepositoryDescription, 'type' | 'className' | 'objectStoreId' | 'id' | 'versionSeriesId'>): string | null {
  if (!cfg || d.type !== 'filenet' || !d.id || !d.className || !d.objectStoreId || !cfg.repositoryId) return null;
  const q = new URLSearchParams({
    desktop: cfg.desktop,
    repositoryId: cfg.repositoryId,
    repositoryType: 'p8',
    docid: `${d.className},${d.objectStoreId},${d.id}`,
    template_name: d.className,
  });
  // No `version` parameter: the docid names one exact version (so v1 evidence opens v1, not the released v2).
  if (d.versionSeriesId) q.set('vsId', d.versionSeriesId);
  return `${cfg.baseUrl}/bookmark.jsp?${q.toString()}`;
}
