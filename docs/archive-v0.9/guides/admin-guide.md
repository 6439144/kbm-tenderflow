# TenderFlow v0.9.0 — Administrator Guide

This guide describes operational administration, multi-tenant provisioning, and compliance monitoring for TenderFlow.

---

## 1. Multi-Tenant Architecture & Configuration Packages

Each customer organization operates as an isolated tenant. To provision a new tenant in under one hour:
1. Prepare a JSON configuration package matching `docs/architecture/tenant-config.schema.json`. See `seed/tenants/kea.json` as a reference.
2. Submit the configuration package via the Control Panel or the API:
   ```bash
   curl -X POST http://localhost:4000/api/v1/tenants \
     -H "Content-Type: application/json" \
     -d @seed/tenants/kea.json
   ```
3. The platform dynamically instantiates branding, categories, currency formatting, and role permissions.

---

## 2. Managing Role-Based Access Control (RBAC)

TenderFlow defines six core personas:
- `SUPER_ADMIN`: System-wide settings and tenant configuration.
- `DIRECTOR`: Authorized official who approves tender publication and final contract award.
- `PROCUREMENT_OFFICER`: Buyers managing drafting, clarifications, and dossier assembly.
- `OPENING_COMMITTEE_CHAIR`: Authorized to convene and execute the Bid Opening Ceremony.
- `EVALUATOR`: Technical and financial scoring committee members.
- `VENDOR`: External bidders submitting sealed tenders and inquiries.

---

## 3. Cryptographic Sealed Bid Vault Operations

### Rule 1 Non-Negotiable Enforcement
- All bids submitted by vendors receive envelope cryptographic hash receipts (`hashDigest`).
- Bid file payloads are strictly inaccessible to all actors (including Super Admins and AI agents) while `tender.status !== 'BIDS_OPENED'`.
- Attempts to query bid contents return HTTP `403 Forbidden` (`code: BIDS_SEALED_UNTIL_OPENING_EVENT`).

### Convening the Bid Opening Ceremony
Once the submission deadline passes:
1. The Bid Opening Committee convenes.
2. Committee Chairperson authenticates and submits attendee credentials to `/api/v1/tenders/{tenderId}/bids/opening-ceremony`.
3. The system creates an immutable opening record and transitions bids to `OPENED`.

---

## 4. Tamper-Evident Audit Ledger (Rule 2)

All state changes and privileged operations write an HMAC SHA-256 chained audit record.

### Verifying Audit Log Integrity
Run the integrity verification check at any time:
```bash
curl -X GET http://localhost:4000/api/v1/audit-logs/verify-integrity \
  -H "X-Tenant-ID: kea"
```
Returns:
```json
{
  "chainIntegrityValid": true,
  "totalEventsVerified": 12,
  "algorithm": "HMAC-SHA256"
}
```
If any database row has been tampered with or modified out of band, `chainIntegrityValid` returns `false`.
