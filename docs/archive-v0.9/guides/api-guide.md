# TenderFlow v0.9.0 — API Guide

The TenderFlow API is an OpenAPI 3.0-first REST service (`services/api/openapi.yaml`).

## Base URLs
- Local Development: `http://localhost:4000/api/v1`
- Review Environment: `https://tenderflow-api.example.com/api/v1`

## Required Headers
Every API request must include the tenant scoping header:
- `X-Tenant-ID`: The tenant unique slug (e.g. `kea`, `gpc`).
- `Authorization`: `Bearer <token>` (JWT issued by Keycloak).

---

## Core Endpoints Summary

| Method | Path | Summary | Notes |
|---|---|---|---|
| `GET` | `/tenants` | List all active tenants | Public / Admin |
| `POST` | `/tenants` | Provision tenant from config package | Super Admin |
| `POST` | `/vendors/register` | Vendor self-registration | Public |
| `POST` | `/vendors/{vendorId}/approve` | Approve registered vendor | Requires Procurement Officer |
| `GET` | `/tenders` | List tenders | Filtered by tenant & role |
| `POST` | `/tenders` | Create new tender in `DRAFT` | Buyer |
| `POST` | `/tenders/{id}/approve-publish` | Director authorization to publish | Rule 7 Human Gate |
| `POST` | `/tenders/{id}/publish` | Publish tender to Vendor Portal | Buyer |
| `POST` | `/tenders/{id}/clarifications` | Submit clarification inquiry | Vendor |
| `POST` | `/tenders/{id}/bids` | Submit sealed bid package | Sealed until opening |
| `GET` | `/tenders/{id}/bids/{bidId}/content` | Retrieve bid payload | **HTTP 403 before opening** |
| `POST` | `/tenders/{id}/bids/opening-ceremony` | Execute Bid Opening Event | Committee Chairperson |
| `POST` | `/tenders/{id}/evaluations/scorecard` | Submit signed evaluator scorecard | Evaluator |
| `POST` | `/tenders/{id}/evaluations/award` | Issue final contract award | Authorized Director |
| `GET` | `/audit-logs/verify-integrity` | Verify HMAC chain integrity | Auditor |

See `services/api/openapi.yaml` for full schemas and parameters.
