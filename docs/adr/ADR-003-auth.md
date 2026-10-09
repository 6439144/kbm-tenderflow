# ADR-003: Authentication & Identity Management Architecture (T07)

## Status
Accepted

## Context
TenderFlow requires centralized Identity & Access Management (IAM) supporting public vendor registration, procurement staff workflows, committee sessions, and platform administration across multiple isolated tenants.

## Decision
1. Standardize on **Keycloak (OIDC)** as the identity provider for TenderFlow v0.9.0.
2. Standard realm configuration exported at `deploy/keycloak/tenderflow-realm.json` and auto-imported upon container startup.
3. Every authenticated request to `services/api` carries a bearer JWT token or signed session context containing:
   - User ID (`sub`)
   - Assigned Tenant ID (`tenant_id`)
   - Role permissions (`roles`: `SUPER_ADMIN`, `DIRECTOR`, `PROCUREMENT_OFFICER`, `OPENING_COMMITTEE_CHAIR`, `EVALUATOR`, `VENDOR`).
4. In local developer/test environments, `services/api` middleware supports synthetic mock identity tokens to facilitate headless integration and CI testing without external OIDC server dependencies.

## Consequences
- Standard OIDC / OAuth2 compliance.
- Easy federation with government and enterprise SSO (Active Directory / Azure AD) in future releases.
