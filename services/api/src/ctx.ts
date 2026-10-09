import type { Db, Queryable } from './db.js';
import type { Config } from './config.js';
import type { ContentStore } from './content/types.js';
import type { AiService } from './ai/index.js';
import type { TokenService, Actor } from './auth/tokens.js';
import { appendAudit, type AuditInput } from './services/audit.js';
import { forbidden } from './util.js';

export interface Ctx {
  db: Db;
  config: Config;
  store: ContentStore;
  ai: AiService;
  tokens: TokenService;
}

export const STAFF_ROLES = ['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'EVALUATOR', 'TENANT_ADMIN', 'AUDITOR'];
export const isStaff = (a: Actor) => a.roles.some((r) => STAFF_ROLES.includes(r));
export const isVendor = (a: Actor) => a.roles.includes('VENDOR') && !isStaff(a);
export const hasRole = (a: Actor, ...roles: string[]) => a.roles.some((r) => roles.includes(r));
export function assertRole(a: Actor, ...roles: string[]) {
  if (!hasRole(a, ...roles)) throw forbidden(`Requires one of roles: ${roles.join(', ')}`);
}

/** Audit inside an existing transaction. */
export const auditTx = (ctx: Ctx, q: Queryable, e: Omit<AuditInput, 'actor'> & { actor: { id: string; roles: string[] } }) =>
  appendAudit(q, ctx.config.auditSigningKey, e);
