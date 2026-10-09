// Shared state of the demo feature (launcher in the header, overlay at the app root).
// A tiny external store + useSyncExternalStore; presenter progress is persisted in localStorage.
import { useEffect, useSyncExternalStore } from 'react';
import { loadSession } from '../../api';
import { demoApi, type DemoStatus } from './api';
import type { EntityId } from './story';
import type { TourId } from './tours';

export interface Spot { path: string; selectors: string[]; nonce: number }
export interface DemoState {
  open: boolean;
  collapsed: boolean;
  track: EntityId;
  chapter: Record<EntityId, number>;
  spot: Spot | null;
  tour: { id: TourId; step: number } | null;
}

const KEY = 'tf.demo.story.v1';
const DEFAULT: DemoState = { open: false, collapsed: false, track: 'kea', chapter: { kea: 0, gcia: 0, moi: 0 }, spot: null, tour: null };

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode): progress lives in memory only */
  }
}

function restore(): DemoState {
  const raw = lsGet(KEY);
  if (!raw) return DEFAULT;
  try {
    const p = JSON.parse(raw) as Partial<DemoState>;
    return {
      ...DEFAULT,
      open: Boolean(p.open),
      collapsed: Boolean(p.collapsed),
      track: p.track === 'gcia' || p.track === 'moi' ? p.track : 'kea',
      chapter: { kea: Number(p.chapter?.kea) || 0, gcia: Number(p.chapter?.gcia) || 0, moi: Number(p.chapter?.moi) || 0 },
      spot: p.spot && typeof p.spot.path === 'string' && Array.isArray(p.spot.selectors) ? p.spot : null,
    };
  } catch {
    return DEFAULT;
  }
}

let state: DemoState = restore();
const listeners = new Set<() => void>();

export function setDemo(patch: Partial<DemoState> | ((s: DemoState) => Partial<DemoState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  const { tour: _tour, ...persisted } = state;
  lsSet(KEY, JSON.stringify(persisted));
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useDemoState = (): DemoState => useSyncExternalStore(subscribe, () => state);

// ---------------------------------------------------------------- /demo/status (shared, per token)

interface StatusSnap { token: string | null; status: DemoStatus | null; enabled: boolean | null }
let snap: StatusSnap = { token: null, status: null, enabled: null };
let inflight: Promise<void> | null = null;
const statusListeners = new Set<() => void>();
const emitStatus = () => statusListeners.forEach((l) => l());

export function refreshDemoStatus(force = false): Promise<void> {
  const token = loadSession()?.token ?? null;
  if (!token) {
    snap = { token: null, status: null, enabled: null };
    emitStatus();
    return Promise.resolve();
  }
  if (!force && snap.token === token && snap.enabled !== null) return Promise.resolve();
  if (inflight && !force) return inflight;
  inflight = demoApi
    .status()
    .then((s) => {
      snap = { token, status: s, enabled: Boolean(s.enabled) };
    })
    .catch(() => {
      // 404 → demo mode is off on this server; any other error → treat as off (the launcher simply hides)
      snap = { token, status: null, enabled: false };
    })
    .finally(() => {
      inflight = null;
      emitStatus();
    });
  return inflight;
}

const subscribeStatus = (l: () => void) => {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
};

/** Demo status for the signed-in token; `enabled` is null while unknown. */
export function useDemoStatus(token: string | null | undefined): StatusSnap {
  const s = useSyncExternalStore(subscribeStatus, () => snap);
  useEffect(() => {
    void refreshDemoStatus();
  }, [token]);
  return s.token === (token ?? null) ? s : { token: token ?? null, status: null, enabled: null };
}

export const tourSeenKey = (tenantId: string, username: string, id: TourId) => `tf.tour.seen.${tenantId}.${username}.${id}`;
