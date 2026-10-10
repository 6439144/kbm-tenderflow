// Custom fields on vendors and departmental requests (the tender side lives in gates.ts / services/tenders.ts).
import type { Ctx } from '../ctx.js';
import { auditTx } from '../ctx.js';
import type { Actor } from '../auth/tokens.js';
import type { Queryable } from '../db.js';
import { badRequest, isUuid, notFound } from '../util.js';
import { formById, liveForm, type PinnedForm } from './gates.js';
import { presentValues, publicDefinition, validateValues, type FormDefinition } from './forms.js';

/** Parse customFields from JSON bodies or multipart forms (where it arrives as a JSON string). */
export function customInput(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { throw badRequest('customFields must be a JSON object'); }
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('customFields must be an object');
  return v as Record<string, unknown>;
}

/** Values for a new object from the live form of its kind (null pin when the entity has no such form). */
export async function newObjectCustom(q: Queryable, tenantId: string, code: 'VENDOR' | 'REQUEST', input: unknown, opts: { vendorSelf?: boolean } = {}) {
  const f = await liveForm(q, tenantId, code);
  const given = customInput(input);
  if (!f) {
    if (given && Object.keys(given).length) throw badRequest('This entity has no custom fields for this form');
    return { values: {}, pin: null as PinnedForm | null };
  }
  const values = validateValues(f.def, given, { mode: 'SAVE', editable: opts.vendorSelf ? (x) => x.audience === 'PUBLIC' : undefined });
  return { values, pin: f.pin };
}

/** Strip raw custom columns from an API object and add a `custom` block (vendors see PUBLIC fields only). */
export async function withCustom<T extends Record<string, any>>(q: Queryable, row: { custom_fields?: any; custom_form?: any }, obj: T, publicOnly: boolean) {
  const out: any = { ...obj };
  delete out.customFields; delete out.customForm;
  const form: FormDefinition | null = await formById(q, row.custom_form?.id);
  out.custom = form ? {
    form: { id: row.custom_form.id, version: row.custom_form.version, definition: publicOnly ? publicDefinition(form) : form },
    values: presentValues(form, row.custom_fields, { publicOnly }),
    ...(publicOnly ? {} : { raw: row.custom_fields ?? {} }),
  } : null;
  return out as T & { custom: unknown };
}

/** Staff edit of a vendor's custom fields (incl. INTERNAL ones such as a risk rating). Pins the live form if none. */
export async function updateVendorCustom(ctx: Ctx, actor: Actor, vendorId: string, b: any) {
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = (await ctx.db.query<any>('SELECT id, custom_fields, custom_form FROM vendors WHERE id=$1 AND tenant_id=$2', [vendorId, actor.tenantId]))[0];
  if (!v) throw notFound('Vendor');
  let pin: PinnedForm | null = v.custom_form ?? null;
  let form = await formById(ctx.db, pin?.id);
  if (!form) {
    const live = await liveForm(ctx.db, actor.tenantId, 'VENDOR');
    if (!live) throw badRequest('This entity has no vendor form');
    pin = live.pin; form = live.def;
  }
  const values = validateValues(form, customInput(b?.customFields), { previous: v.custom_fields ?? {}, mode: 'SAVE' });
  const changed = Object.keys(values).filter((k) => JSON.stringify(values[k]) !== JSON.stringify((v.custom_fields ?? {})[k]));
  await ctx.db.tx(async (q) => {
    await q.query('UPDATE vendors SET custom_fields=$1::jsonb, custom_form=$2::jsonb WHERE id=$3', [JSON.stringify(values), JSON.stringify(pin), vendorId]);
    await auditTx(ctx, q, { tenantId: actor.tenantId, actor, action: 'VENDOR_CUSTOM_FIELDS_UPDATED', resourceType: 'VENDOR', resourceId: vendorId,
      details: { fields: changed, formVersion: pin!.version } });
  });
  const row = { custom_fields: values, custom_form: pin };
  return { custom: (await withCustom(ctx.db, row, {}, false)).custom };
}
