// Routing of FileNet evidence links into IBM Content Navigator (and ACCE).
//
// Where Navigator lives:
//   FILENET_NAVIGATOR_URL=<url>   configured (one candidate)
//   FILENET_NAVIGATOR_URL unset   derived from the GraphQL endpoint origin: <origin>/navigator, then <origin>/icn/navigator
//   FILENET_NAVIGATOR_URL=off     no Navigator links at all
// probeNavigator() asks each candidate once (HEAD, GET when HEAD is refused; 5 s timeout; no credentials, no cookies;
// redirects not followed) and takes the first that answers 2xx/3xx/401 — Navigator redirects or asks for a login when it
// is there. The result is cached for 5 minutes. An unreachable Navigator still yields its link, flagged reachable:false,
// so the UI can warn and offer the object id and ACCE instead (never a dead link presented as working).
//
// ACCE: FILENET_ACCE_URL, else <origin>/acce; FILENET_ACCE_URL=off disables it.
import type { RepositoryDescription } from './types.js';

export interface NavigatorConfig { baseUrl: string; desktop: string; repositoryId: string }

export interface NavigatorSettings {
  mode: 'configured' | 'derived';
  /** Base URLs to try, in order (no trailing slash, no bookmark.jsp). */
  candidates: string[];
  desktop: string;
  repositoryId: string;
}

export interface ResolvedNavigator {
  url: string;
  source: 'configured' | 'derived';
  reachable: boolean;
  checkedAt: string;
  /** HTTP status of the chosen candidate (null when it did not answer). */
  status: number | null;
  desktop: string;
  repositoryId: string;
  tried: { url: string; status: number | null; error?: string; ms: number }[];
}

const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_CACHE_MS = 5 * 60_000;

const httpUrl = (raw: string): URL | null => {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u;
};
const cleanBase = (raw: string) => raw.trim().replace(/\/+$/, '').replace(/\/bookmark\.jsp$/, '');
const isOff = (v: string | undefined) => /^(off|false|none|disabled)$/i.test((v ?? '').trim());

/** Reads FILENET_NAVIGATOR_URL / _DESKTOP / _REPOSITORY. Returns null when no Navigator URL is configured (explicitly). */
export function navigatorConfig(env: NodeJS.ProcessEnv = process.env): NavigatorConfig | null {
  const raw = env.FILENET_NAVIGATOR_URL?.trim();
  if (!raw || isOff(raw) || !httpUrl(raw)) return null;
  return {
    baseUrl: cleanBase(raw),
    desktop: env.FILENET_NAVIGATOR_DESKTOP?.trim() || 'ICN',
    repositoryId: env.FILENET_NAVIGATOR_REPOSITORY?.trim() || env.FILENET_OBJECT_STORE?.trim() || '',
  };
}

/**
 * Navigator settings: the configured URL, or candidates derived from the GraphQL endpoint origin. Null when
 * FILENET_NAVIGATOR_URL=off, when the configured value is not a usable http(s) URL, or when nothing can be derived.
 */
export function navigatorSettings(env: NodeJS.ProcessEnv, graphqlUrl?: string | null): NavigatorSettings | null {
  const raw = env.FILENET_NAVIGATOR_URL?.trim();
  if (isOff(raw)) return null;
  const desktop = env.FILENET_NAVIGATOR_DESKTOP?.trim() || 'ICN';
  const repositoryId = env.FILENET_NAVIGATOR_REPOSITORY?.trim() || env.FILENET_OBJECT_STORE?.trim() || '';
  if (raw) {
    if (!httpUrl(raw)) return null;
    return { mode: 'configured', candidates: [cleanBase(raw)], desktop, repositoryId };
  }
  const g = graphqlUrl ? httpUrl(graphqlUrl) : null;
  if (!g) return null;
  return { mode: 'derived', candidates: [`${g.origin}/navigator`, `${g.origin}/icn/navigator`], desktop, repositoryId };
}

/** ACCE base URL (FILENET_ACCE_URL or <graphql origin>/acce); null when off or not derivable. */
export function acceUrl(env: NodeJS.ProcessEnv, graphqlUrl?: string | null): string | null {
  const raw = env.FILENET_ACCE_URL?.trim();
  if (isOff(raw)) return null;
  if (raw) return httpUrl(raw) ? raw.replace(/\/+$/, '') : null;
  const g = graphqlUrl ? httpUrl(graphqlUrl) : null;
  return g ? `${g.origin}/acce` : null;
}

// ------------------------------------------------------------------ probe (cached)

interface CacheEntry { at: number; value: Promise<ResolvedNavigator> }
const cache = new Map<string, CacheEntry>();
/** Tests: forget earlier probe results. */
export function resetNavigatorProbeCache(): void { cache.clear(); }

async function probeOne(url: string): Promise<{ url: string; status: number | null; error?: string; ms: number }> {
  const t0 = Date.now();
  const ask = async (method: 'HEAD' | 'GET') => {
    // No Authorization header and no cookies: the probe proves the server is there, it never logs in.
    const res = await fetch(`${url}/`, { method, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { Accept: 'text/html' } });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return res.status;
  };
  try {
    let status = await ask('HEAD');
    if (status === 405 || status === 501) status = await ask('GET');
    return { url, status, ms: Date.now() - t0 };
  } catch (e: any) {
    const cause = e?.cause?.code || e?.cause?.message || e?.name || '';
    return { url, status: null, error: `${e?.message ?? e}${cause ? ` (${cause})` : ''}`.slice(0, 300), ms: Date.now() - t0 };
  }
}

const answers = (s: number | null) => s !== null && ((s >= 200 && s < 400) || s === 401);

/** Probes the candidates (in parallel) and picks the first, in order, that answers. Cached for 5 minutes. */
export function probeNavigator(s: NavigatorSettings, opts: { force?: boolean } = {}): Promise<ResolvedNavigator> {
  const key = `${s.mode}|${s.candidates.join('|')}|${s.desktop}|${s.repositoryId}`;
  const hit = cache.get(key);
  if (hit && !opts.force && Date.now() - hit.at < PROBE_CACHE_MS) return hit.value;
  const value = (async (): Promise<ResolvedNavigator> => {
    const tried = await Promise.all(s.candidates.map(probeOne));
    const ok = tried.find((t) => answers(t.status));
    const chosen = ok ?? tried[0];
    return {
      url: chosen.url, source: s.mode, reachable: !!ok, checkedAt: new Date().toISOString(), status: chosen.status,
      desktop: s.desktop, repositoryId: s.repositoryId, tried,
    };
  })();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Resolved Navigator for an environment + GraphQL endpoint, or null when Navigator links are off / not derivable. */
export async function resolveNavigator(env: NodeJS.ProcessEnv, graphqlUrl?: string | null, opts: { force?: boolean } = {}): Promise<ResolvedNavigator | null> {
  const s = navigatorSettings(env, graphqlUrl);
  return s ? probeNavigator(s, opts) : null;
}

// ------------------------------------------------------------------ bookmark format (ASSUMED)

/**
 * ASSUMED (not verified live): the Navigator bookmark format below. IBM documents bookmark.jsp with the parameters desktop,
 * repositoryId, docid, template_name and an optional version ("Constructing a URL for IBM Content Navigator"); the P8
 * docid value "<class>,<objectStoreGuid>,<documentGuid>" and repositoryType=p8 follow the links Navigator itself produces
 * with "Copy link". If the live Navigator answers with an error, change only this function.
 */
export function bookmarkUrl(baseUrl: string, desktop: string, repositoryId: string, d: { className: string; objectStoreId: string; id: string; versionSeriesId?: string | null }): string {
  const q = new URLSearchParams({
    desktop,
    repositoryId,
    repositoryType: 'p8',
    docid: `${d.className},${d.objectStoreId},${d.id}`,
    template_name: d.className,
  });
  // No `version` parameter: the docid names one exact version (so v1 evidence opens v1, not the released v2).
  if (d.versionSeriesId) q.set('vsId', d.versionSeriesId);
  return `${baseUrl}/bookmark.jsp?${q.toString()}`;
}

/** Bookmark URL for one document version, or null when Navigator is not configured or the description is incomplete. */
export function navigatorUrl(cfg: NavigatorConfig | null, d: Pick<RepositoryDescription, 'type' | 'className' | 'objectStoreId' | 'id' | 'versionSeriesId'>): string | null {
  if (!cfg || d.type !== 'filenet' || !d.id || !d.className || !d.objectStoreId || !cfg.repositoryId) return null;
  return bookmarkUrl(cfg.baseUrl, cfg.desktop, cfg.repositoryId, { className: d.className, objectStoreId: d.objectStoreId, id: d.id, versionSeriesId: d.versionSeriesId });
}
