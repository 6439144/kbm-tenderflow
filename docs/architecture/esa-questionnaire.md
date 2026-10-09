# IBM Embedded Solution Agreement (ESA) — Technical Questionnaire & Solution Pack

**Solution Name**: KBM TenderFlow  
**Solution Version**: v0.9.0 (Review Build)  
**Primary Partner**: Khorafi Business Machines (KBM)  
**Target Program**: IBM Embedded Solution Agreement (ESA)  
**Review Target Date**: October 2026  

---

## 1. Solution Overview & Commercial Value Proposition

### 1.1 What is the commercial purpose of TenderFlow?
TenderFlow is an enterprise digital tendering and procurement management platform engineered for government entities, public authorities, and regulated enterprises across Kuwait and the GCC region. It automates and governs the end-to-end tender lifecycle:
- Vendor registration, compliance verification, and dossier onboarding.
- Tender dossier preparation, bill of quantities (BOQ) assembly, and bilingual publication.
- Clarification Q&A management and formal addenda issuance.
- Cryptographically sealed bid submissions with zero pre-opening access (Rule 1).
- Multi-signatory bid opening ceremonies.
- Technical and commercial weighted evaluation scoring.
- Contract award sign-off and tamper-evident audit ledger preservation (Rule 2).

### 1.2 What is the target customer profile and market deployment model?
- **Target Customers**: Ministries, public authorities (e.g. energy, public works, communications), and regulated financial/industrial enterprises requiring strict adherence to public procurement laws (e.g., Kuwait Law No. 49 of 2016 on Public Tenders).
- **Deployment Model**: Multi-tenant SaaS or dedicated sovereign on-premises private cloud deployment. Each customer entity is provisioned as an isolated tenant via an automated configuration package in under one hour.

---

## 2. Embedded IBM Technology Architecture

### 2.1 Which IBM products are embedded into TenderFlow?
TenderFlow embeds two flagship IBM enterprise platforms:
1. **IBM FileNet Content Manager**:
   - Acts as the authoritative document management repository and digital archive for all tender dossiers, vendor submissions, technical specifications, clarification addenda, and signed opening records.
   - Accessed exclusively through the modern **Content Services GraphQL API**.
   - Decoupled behind KBM's authoritative `@tenderflow/content-adapter` (`ContentStore` interface). *Status: Interface contract defined with local FileSystemStore; live TechZone FileNet Content Services GraphQL store and ACCE provisioning are currently in active implementation (v1.0 Hardening: H-05, H-06, H-07).*
2. **IBM watsonx Orchestrate**:
   - Serves as the AI Advisory orchestration engine executing domain-specific agents built with the Agent Development Kit (ADK).
   - Operates in strict advisory mode (Rule 7): evaluates tender completeness, drafts clarification replies based on dossier contents, and suggests bid compliance scoring without autonomous approval authority.
   - Integrates via OpenAPI 3.0 tool declarations calling TenderFlow's secure REST endpoints. *Status: OpenAPI tool contracts and schema defined; live SaaS ADK YAML deployment and document-grounded evals are currently in active implementation (v1.0 Hardening: H-08, H-09, H-10, H-11).*

### 2.2 What constitutes KBM's Intellectual Property (Value-Add Layer)?
KBM has engineered the entire application, workflow, security, and presentation layers surrounding the embedded IBM engines:
- **TenderFlow Micro-Frontend Suite** (`apps/`): Three role-aware Next.js web applications (`vendor-portal`, `procurement-app`, and `control-panel`) with a shared bilingual design system (`packages/ui`) supporting real-time Arabic (RTL) and English (LTR) rendering.
- **Authoritative REST API Gateway** (`services/api`): Node.js/TypeScript REST service enforcing server-side tenant isolation, role-based access control (RBAC), and procurement workflow state machines. *(In progress for Gate 1: Cryptographic JWT verification via Keycloak JWKS `jose` and removal of header-based actor overrides under G1-b / H-01).*
- **Sealed Bid Cryptographic Vault** (`services/api/src/services/sealed-bid-vault.ts`): Implements client-side SHA-256 digest receipts and zero pre-opening read access enforcement. *(In progress for Gate 1: Real AES-256-GCM envelope encryption per bid wrapped with `BID_MASTER_KEY` under G1-c / H-03; v0.9 used an in-memory prototype without real ciphertext storage).*
- **Tamper-Evident Audit Ledger** (`services/api/src/services/audit.ts`): HMAC-SHA256 hash-chained immutable audit log providing non-repudiation and verification. *(In progress for Gate 3: Durable PostgreSQL append-only ledger under G3-d / H-15).*
- **Multi-Tenant Packaging Engine** (`packages/tenant-config`): Declarative JSON/YAML tenant configuration system allowing rapid instantiation of branding, currencies, categories, and approval thresholds in <1 hour.

---

## 3. Technical Integration & Architectural Boundaries

### 3.1 Content & Storage Integration (IBM FileNet Content Manager)
- **Interface Boundary**: All document operations pass through the `ContentStore` abstraction (`services/content-adapter/src/types.ts`). In v0.9, testing ran against local `FileSystemContentStore`. Live IBM FileNet Content Services GraphQL integration (`FileNetGraphQLContentStore`) is in active implementation for Gate 2 (G2-a / H-05).
- **Database Boundary (Rule)**: Zero document binary bodies are stored in the PostgreSQL database. PostgreSQL holds metadata, workflow state, and document IDs (`docId`).
- **TechZone Provisioning Automation**: Provisioning runbook (`ACCE-RUNBOOK.md`) and schema verification script (`provision/verify.js`) are in active implementation for Gate 2 (G2-b / H-06).

### 3.2 AI & Automation Integration (IBM watsonx Orchestrate)
- **ADK Agent Definitions**: Defined in YAML format. Native ADK v1 agent definitions and IBM IAM connectivity are in active development for Gate 2 (G2-d / H-09).
- **Tool Calling Architecture**: OpenAPI 3.0 tool declarations ([`agents/tools/`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/agents/tools)) and short-lived `ai_session` token propagation are in active implementation for Gate 2 (G2-c / H-08).
- **Rule 7 Compliance (Advisory Only)**: AI tools produce advisory drafts and compliance checklists requiring formal human sign-off; the API strictly blocks state mutations by AI actors.
- **Rapid Rebuild Script**: Automation script (`agents/import.sh`) is in development for native ADK CLI without mock mode (G2-d / H-09).

---

## 4. Security, Isolation & Compliance Non-Negotiables

| Non-Negotiable Rule | Architecture Enforcement Mechanism | Current Verification / Hardening Status |
|---|---|---|
| **Rule 1: Sealed Bids Zero Access** | Client-side SHA-256 digest receipt; API rejects pre-opening read requests. Real AES-256-GCM envelope encryption wrapped with `BID_MASTER_KEY` is in active development. | Pre-opening read block verified; real AES-256-GCM envelope encryption in progress (G1-c / H-03). |
| **Rule 2: Immutable Audit Trail** | State transitions and privileged actions log actor, tenant, timestamp, and changes into HMAC-SHA256 hash chain. | In-memory HMAC hash chain verified; durable PostgreSQL append-only persistence in progress (G3-d / H-15). |
| **Rule 3: Tenant & Role Isolation** | Server-side middleware validates tenant binding on every query; RBAC checks user roles. Real Keycloak JWKS token verification via `jose` and header override removal are in active development. | Route access checks defined; real JWKS token verification and removal of header overrides in progress (G1-b / H-01). |
| **Rule 4: Synthetic Data Only** | Seed datasets in `seed/` use fictitious entities ("Ministry A", "Ministry B") and vendors; zero customer/MOI data. | `npm run seed` verified clean. |
| **Rule 5: Zero Secrets in Repo** | Environment variables only; `.env.example` placeholders; pre-commit scanner. | [`scripts/secret-scan.js`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/scripts/secret-scan.js) scans 126 files with 0 findings. |
| **Rule 7: Advisory AI Gatekeepers** | AI agents advise; human Director/Officer sign-off required for all state transitions. | Advisory state gating active in API; real evaluations against live Orchestrate models and FileNet documents not yet run (in progress under G2-f / H-11). |
| **Rule 8: Neutral Branding** | UI text and public documentation use generic enterprise terminology without vendor branding. | Audited across all presentation components and user guides. |

---

## 5. Deployment Repeatability & Portability

### 5.1 What is the installation mechanism on clean environments?
TenderFlow installs from scratch via a single command:
```bash
bash deploy/install.sh
```
The script:
1. Validates Docker and Docker Compose prerequisites.
2. Generates or injects TLS certificates for reverse proxy security.
3. Builds container images for the three Next.js apps, REST API, Keycloak, PostgreSQL 16, Mailpit, and NGINX.
4. Boots the stack and polls the readiness endpoint (`http://localhost:4000/health`).
5. Verifies HTTPS reverse proxy health (`https://localhost/health`).

### 5.2 What is the backup and disaster recovery model?
- Nightly automated PostgreSQL snapshot utility: [`deploy/scripts/backup-db.sh`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/deploy/scripts/backup-db.sh).
- Immutable FileNet object stores backed up via standard storage snapshot policies.
- Full Software Bill of Materials (SBOM) generated in CycloneDX 1.5 standard via [`scripts/generate-sbom.js`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/scripts/generate-sbom.js).
