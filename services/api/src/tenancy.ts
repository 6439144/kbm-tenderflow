// Deployment model (docs/DEPLOYMENT-MODEL.md).
//
//   TENANCY_MODE=dedicated (default) — one installation serves ONE government entity (ENTITY_ID). Every request is
//     bound to that entity: login, vendor registration, the public tender board, its feeds and public forms answer only
//     for it, and any other entity id is refused with 404 (the same answer whether that entity exists or not). Tokens
//     carrying another entity are refused, background jobs touch only the entity, and no new entity can be created.
//   TENANCY_MODE=shared — several entities in one installation, separated by tenant_id (KBM's internal multi-entity
//     demo and the test suite). This is the pre-1.0 behaviour.
//
// The data model is unchanged in both modes (tenant_id everywhere); dedicated mode adds the guards below on top of
// the existing tenant scoping, which still applies to every authenticated query.
import type { Config } from './config.js';
import type { Ctx } from './ctx.js';
import { ApiError } from './util.js';

export const TENANCY_MODES = ['dedicated', 'shared'] as const;
export type TenancyMode = (typeof TENANCY_MODES)[number];
/** Entities the demo seed knows how to create (seed.ts / seed-moi.ts). */
export const DEMO_ENTITIES = ['kea', 'gcia', 'moi'] as const;
export type DemoEntity = (typeof DEMO_ENTITIES)[number];
export const ENTITY_ID_RE = /^[a-z0-9_-]{2,40}$/;

type TenancyConfig = Pick<Config, 'tenancyMode' | 'entityId'>;

export const isDedicated = (config: TenancyConfig) => config.tenancyMode === 'dedicated';

/** The entity this installation is bound to (dedicated mode), or null (shared mode, or dedicated before provisioning). */
export const boundEntity = (config: TenancyConfig): string | null => (isDedicated(config) ? config.entityId ?? null : null);

/** 404 that does not reveal whether the entity exists anywhere. */
export const entityNotFound = () => new ApiError(404, 'NOT_FOUND', 'Entity not found');

/**
 * Entity of a public (pre-login) request. Dedicated: the bound entity; a different requested id → 404, no id → the
 * bound entity. Shared: the requested id (required; `null` when absent so the caller keeps its own validation).
 */
export function publicEntity(config: TenancyConfig, requested: unknown): string | null {
  const req = typeof requested === 'string' && requested.trim() ? requested.trim() : null;
  if (!isDedicated(config)) return req;
  const bound = config.entityId ?? null;
  if (!bound) throw entityNotFound(); // dedicated installation without a provisioned entity yet
  if (req !== null && req !== bound) throw entityNotFound();
  return bound;
}

/** Dedicated mode with a bound entity: true when `tenantId` is another entity (tokens, background jobs). */
export function foreignEntity(config: TenancyConfig, tenantId: string | null | undefined): boolean {
  return isDedicated(config) && !!config.entityId && tenantId !== config.entityId;
}

/** Thrown at start-up when the database and ENTITY_ID do not fit together. */
export class TenancyStartupError extends Error {}

export interface TenancyResolution { mode: TenancyMode; entityId: string | null; warnings: string[] }

/**
 * Decide the installation's entity at start-up from the configuration and the entities already in the database
 * (`tenantIds`). Pure, so it is unit-tested directly. Rules:
 *   shared                         → shared, no entity
 *   dedicated + ENTITY_ID          → that entity; refused if the database holds entities but not this one;
 *                                    allowed (warning) on an empty database: provision it with `npm run entity:create`
 *   dedicated, no ENTITY_ID        → (refused in production by loadConfig)
 *       empty database             → DEMO_ENTITY when the demo seed runs now, otherwise none yet (warning)
 *       exactly one entity         → that entity
 *       several entities           → production: refused; elsewhere: warning and shared mode, so an existing
 *                                    multi-entity development database keeps working until ENTITY_ID is set
 */
export function resolveTenancy(config: Pick<Config, 'tenancyMode' | 'entityId' | 'tfEnv' | 'seedDemo' | 'demoEntity'>, tenantIds: string[]): TenancyResolution {
  const warnings: string[] = [];
  if (config.tenancyMode === 'shared') return { mode: 'shared', entityId: null, warnings };
  const ids = [...tenantIds].sort();
  if (config.entityId) {
    if (ids.length && !ids.includes(config.entityId))
      throw new TenancyStartupError(`ENTITY_ID '${config.entityId}' is not an entity in this database (it holds: ${ids.join(', ')}). `
        + 'A dedicated installation serves exactly one entity: point ENTITY_ID at it, or use this entity\'s own database.');
    if (!ids.length && !config.seedDemo)
      warnings.push(`entity '${config.entityId}' is not provisioned yet: run \`npm run entity:create -- --code ${config.entityId} …\``);
    const others = ids.filter((id) => id !== config.entityId);
    if (others.length)
      warnings.push(`this database also holds other entities (${others.join(', ')}): this installation never serves them, `
        + 'but a dedicated installation should have a database of its own (docs/DEPLOYMENT-MODEL.md)');
    return { mode: 'dedicated', entityId: config.entityId, warnings };
  }
  if (config.tfEnv === 'production') throw new TenancyStartupError('ENTITY_ID is required with TENANCY_MODE=dedicated and TF_ENV=production');
  if (!ids.length) {
    if (config.seedDemo) return { mode: 'dedicated', entityId: config.demoEntity, warnings };
    warnings.push('no entity in the database yet: run `npm run entity:create -- --code <code> …`, set ENTITY_ID=<code> and restart');
    return { mode: 'dedicated', entityId: null, warnings };
  }
  if (ids.length === 1) return { mode: 'dedicated', entityId: ids[0], warnings };
  warnings.push(`TENANCY_MODE=dedicated but ENTITY_ID is not set and this database holds ${ids.length} entities (${ids.join(', ')}): `
    + 'running in SHARED mode. Set ENTITY_ID=<id> for a dedicated installation, or TENANCY_MODE=shared to silence this warning. '
    + 'TF_ENV=production refuses to start in this situation.');
  return { mode: 'shared', entityId: null, warnings };
}

/**
 * Creating a government entity is a platform-level, cross-entity operation: a dedicated installation may only hold
 * its own entity (ENTITY_ID). Without ENTITY_ID (development) the first entity may be created, never a second one.
 */
export async function assertMayCreateEntity(ctx: Pick<Ctx, 'config' | 'db'>, id: string): Promise<void> {
  if (!isDedicated(ctx.config)) return;
  const bound = ctx.config.entityId;
  const refused = bound ? id !== bound : (await ctx.db.query<{ id: string }>('SELECT id FROM tenants WHERE id<>$1 LIMIT 1', [id])).length > 0;
  if (refused)
    throw new ApiError(403, 'ENTITY_CREATION_DISABLED', bound
      ? `This is a dedicated installation for entity '${bound}': other entities cannot be created here. Each government entity gets its own installation and database (docs/DEPLOYMENT-MODEL.md).`
      : 'This is a dedicated installation and it already holds an entity: other entities cannot be created here. Set ENTITY_ID, or TENANCY_MODE=shared for a multi-entity demo.');
}

export interface DeploymentInfo {
  mode: TenancyMode;
  /** Dedicated: this installation's entity (null until it is provisioned). Shared: always null. */
  entity: { id: string; nameEn: string; nameAr: string; primaryColor: string | null; logoText: string | null } | null;
}

/** GET /api/v1/public/deployment — what the web app needs to brand itself and hide multi-entity UI. Public fields only. */
export async function deploymentInfo(ctx: Pick<Ctx, 'config' | 'db'>): Promise<DeploymentInfo> {
  const bound = boundEntity(ctx.config);
  if (!isDedicated(ctx.config)) return { mode: 'shared', entity: null };
  if (!bound) return { mode: 'dedicated', entity: null };
  const r = (await ctx.db.query<{ id: string; name_en: string; name_ar: string; primary_color: string | null; profile: Record<string, unknown> | null; status: string }>(
    'SELECT id, name_en, name_ar, primary_color, profile, status FROM tenants WHERE id=$1', [bound]))[0];
  if (!r || r.status !== 'ACTIVE') return { mode: 'dedicated', entity: null };
  const logo = typeof r.profile?.logoText === 'string' && r.profile.logoText.trim() ? r.profile.logoText.trim().slice(0, 12) : null;
  return { mode: 'dedicated', entity: { id: r.id, nameEn: r.name_en, nameAr: r.name_ar, primaryColor: r.primary_color, logoText: logo } };
}
