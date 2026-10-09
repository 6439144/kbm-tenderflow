# ADR-006: Multi-Tenancy & Tenant Configuration Architecture (T07)

## Status
Accepted (Non-negotiable Rule 3)

## Context
TenderFlow is designed as a reusable, multi-tenant digital tendering platform presented to IBM for an Embedded Solution Agreement (ESA). Different customer entities (e.g. government authorities, regulated utilities, commercial enterprises) require strict data isolation and customized branding, workflows, and terminology.
Exit criterion: A second tenant can be provisioned from a configuration package in under 1 hour.

## Decision
1. **Server-Enforced Isolation**: Multi-tenancy is enforced at the server middleware (`services/api/src/middleware/tenant.ts`) and repository layer. Every database table includes a `tenant_id` column.
2. Cross-tenant queries are blocked at the API level. Requests lacking a valid tenant identifier return HTTP 400 (`MISSING_TENANT_ID`).
3. **Tenant Configuration Package**: Each tenant is instantiated from a standardized JSON/YAML configuration package matching `docs/architecture/tenant-config.schema.json`.
4. The package defines:
   - Organization legal names (English and Arabic).
   - Branding (primary/secondary color tokens, logos, layout direction `rtl`/`ltr`).
   - Currency parameters (e.g. `KWD`, decimal places, symbols).
   - Category taxonomies and approval role matrices.
   - Document store mappings (FileNet Object Store name and folder paths).
5. Seed data includes two complete synthetic packages:
   - `seed/tenants/kea.json`: Kuwait Energy Authority (Primary demo tenant).
   - `seed/tenants/gpc.json`: Gulf Petrochemical Corporation (Proves <1 hour secondary tenant provisioning).

## Consequences
- Guaranteed zero data leakage between customer tenants.
- Clean VM to fully branded multi-tenant instance in minutes.
