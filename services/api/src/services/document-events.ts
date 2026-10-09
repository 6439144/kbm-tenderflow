// Document lifecycle events for features that react to stored documents (document intelligence auto-queue).
// Emitted AFTER the database transaction committed; listeners run asynchronously and can never fail or slow
// down the request that emitted the event (errors are logged, not thrown).
import type { Ctx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';

export type DocumentEvent =
  /** Plain (non-sealed) documents were stored by an upload. Sealed bid documents are never announced here. */
  | { type: 'UPLOADED'; tenantId: string; documentIds: string[]; actor: Actor }
  /** The chair opened the bids (technical envelope, or the single envelope). */
  | { type: 'BIDS_OPENED'; tenantId: string; tenderId: string; actor: Actor }
  /** Two-envelope: the chair opened the financial envelopes of the bids that passed. */
  | { type: 'FINANCIAL_OPENED'; tenantId: string; tenderId: string; actor: Actor };

type Listener = (ctx: Ctx, e: DocumentEvent) => Promise<void> | void;
const listeners = new WeakMap<Ctx, Listener[]>();

export function onDocumentEvent(ctx: Ctx, l: Listener): void {
  listeners.set(ctx, [...(listeners.get(ctx) ?? []), l]);
}

export function emitDocumentEvent(ctx: Ctx, e: DocumentEvent): void {
  for (const l of listeners.get(ctx) ?? []) {
    queueMicrotask(() => {
      Promise.resolve()
        .then(() => l(ctx, e))
        .catch((err) => console.error(`[document-events] ${e.type} listener failed:`, (err as Error)?.message ?? err));
    });
  }
}
