# TenderFlow Architecture Overview

```mermaid
flowchart TD
    subgraph Clients["Presentation Layer (Next.js Apps)"]
        VP["apps/vendor-portal<br/>(Vendors: Registration, Discovery, Sealed Bids)"]
        PA["apps/procurement-app<br/>(Procurement: Drafting, Addenda, Opening, Eval, Award)"]
        CP["apps/control-panel<br/>(Admins: Tenant Config, Audit Logs, Branding)"]
        UI["packages/ui<br/>(Shared Design Tokens, Bilingual AR/EN, RTL Engine)"]
        VP --> UI
        PA --> UI
        CP --> UI
    end

    subgraph Gateway["Ingress & Identity"]
        Proxy["Reverse Proxy / NGINX (deploy/proxy)"]
        Keycloak["Keycloak OIDC (deploy/keycloak)"]
    end

    Clients --> Proxy
    Proxy --> Keycloak

    subgraph CoreServices["Backend & Services Layer"]
        API["services/api (Node.js REST API)<br/>OpenAPI 3.0 Contract"]
        AuthMiddleware["Tenant Isolation & RBAC Middleware"]
        SealedBidVault["Sealed Bids Cryptographic Vault<br/>(Rule 1 Enforcement)"]
        AuditEngine["Tamper-Evident Audit Logger<br/>(Rule 2 Enforcement)"]
        
        API --> AuthMiddleware
        API --> SealedBidVault
        API --> AuditEngine
    end

    Proxy --> API

    subgraph DataStorage["Data & Content Layer"]
        PG[("PostgreSQL 16<br/>(Tenant Metadata, State Models, Audit Chain)")]
        ContentAdapter["services/content-adapter<br/>(ContentStore Interface)"]
        FSStore["FileSystemStore<br/>(Local & CI Tests)"]
        FileNetStore["FileNet Store<br/>(GraphQL on TechZone)"]
        
        API --> PG
        API --> ContentAdapter
        ContentAdapter --> FSStore
        ContentAdapter --> FileNetStore
    end

    subgraph AIAssistant["AI Advisory Layer"]
        Orchestrate["watsonx Orchestrate ADK (agents/)"]
        Tools["OpenAPI Tool Contracts"]
        HumanGate["Human Approval Gatekeeper<br/>(Rule 7 Enforcement)"]
        
        Orchestrate --> Tools
        Tools --> API
        Orchestrate -.-> HumanGate
    end
```

## System Components

### 1. Presentation Layer (`apps/`)
- **Vendor Portal**: Responsive, public-facing portal allowing vendors to register, download public documents, submit questions, and upload cryptographically sealed bid dossiers.
- **Procurement App**: Dedicated workplace for buyers, procurement committees, and directors. Handles tender preparation, issuing addenda, hosting the bid opening ceremony, evaluating scorecards, and issuing awards.
- **Control Panel**: Central operational console for creating and managing multiple tenants, loading tenant configuration packages, and monitoring immutable audit logs.
- **Shared UI (`packages/ui`)**: Unified components supporting dark/light mode, full bidirectional layout (LTR and RTL), with localized English and Arabic strings.

### 2. Core API (`services/api`)
- OpenAPI-first architecture adhering to `services/api/openapi.yaml`.
- Enforces strict tenant isolation per request via JWT / bearer token context.
- Implements the state machine for tenders:
  `DRAFT` -> `PENDING_APPROVAL` -> `APPROVED_FOR_PUBLICATION` -> `PUBLISHED` -> `CLOSED` -> `BIDS_OPENED` -> `EVALUATED` -> `AWARDED` -> `ARCHIVED`.

### 3. Sealed Bid Vault
- Enforces Non-Negotiable Rule 1:
  - Bids uploaded by vendors receive envelope cryptographic verification (SHA-256 + symmetric key encryption).
  - Storage metadata records submission timestamps and hash receipts.
  - Bid files are locked. Any retrieval request before `TENDER.state == BIDS_OPENED` returns HTTP 403.
  - Bid Opening Ceremony requires authorized committee credential sign-off, which emits a certified opening audit event and releases the envelope key.

### 4. Content Adapter (`services/content-adapter`)
- Decouples file storage from core business logic.
- Implements `ContentStore` with two interchangeable drivers:
  - `FileSystemContentStore`: Used for lightning-fast unit tests and offline demonstration.
  - `FileNetGraphQLContentStore`: Integrates with IBM FileNet Content Services GraphQL API for production TechZone reservations.

### 5. Multi-Tenant Configuration Architecture
- Tenants are instantiated via YAML/JSON packages containing:
  - Organization metadata (name, logos, contact info, language preference).
  - Tender category taxonomy (IT, Works, Consulting, Supplies).
  - Approval threshold matrix (e.g. tenders above 100,000 KWD require Director sign-off).
  - Localized terminology overrides.

---

## Key Sequence Workflows

### 1. Sealed Bid Submission & Opening Ceremony (Rule 1 Enforcement)

```mermaid
sequenceDiagram
    autonumber
    actor Vendor as Vendor Representative
    actor Officer as Procurement Officer
    actor Chair as Opening Committee Chair
    participant VP as Vendor Portal (UI)
    participant API as REST API Gateway
    participant Vault as Sealed Bid Vault
    participant Ledger as HMAC Audit Ledger

    Note over Vendor,Vault: Step 7: Sealed Bid Submission
    Vendor->>VP: Upload Technical & Financial Envelopes
    VP->>VP: Compute SHA-256 Digest
    VP->>API: POST /api/v1/tenders/{id}/bids (with Hash)
    API->>Vault: Encrypt Envelope & Lock Status: SEALED
    API->>Ledger: Log Event: BID_SUBMITTED_SEALED
    API-->>VP: Digital Receipt (hashDigest)

    Note over Officer,Vault: Unauthorized Attempt Prior to Opening
    Officer->>API: GET /bids/{id}/content
    API->>Vault: Query Bid Payload
    Vault-->>API: Rejected: SealedBidAccessViolation
    API-->>Officer: HTTP 403 Forbidden (BIDS_SEALED_UNTIL_OPENING_EVENT)

    Note over Chair,Vault: Step 8: Formal Bid Opening Ceremony
    Chair->>API: POST /bids/opening-ceremony (Attendees, Minutes)
    API->>Vault: executeOpeningCeremony()
    Vault->>Vault: Transition Bids to OPENED
    API->>Ledger: Log Event: BID_OPENING_RECORDED
    API-->>Chair: Opening Record Generated

    Note over Officer,Vault: Technical Access Granted After Ceremony
    Officer->>API: GET /bids/{id}/content
    API->>Vault: Query Bid Payload
    Vault-->>API: Return Unsealed Technical Payload
    API-->>Officer: HTTP 200 OK
```

### 2. AI Advisory Workflow with Human Approval Gate (Rule 7 Enforcement)

```mermaid
sequenceDiagram
    autonumber
    actor Buyer as Procurement Officer
    actor Director as Procurement Director
    participant PA as Procurement App
    participant API as REST API Gateway
    participant AI as watsonx Orchestrate Agent
    participant Ledger as HMAC Audit Ledger

    Buyer->>PA: Click "Run AI Completeness Check"
    PA->>API: POST /api/v1/ai/advisory/tender-completeness-check
    API->>AI: Invoke ADK Advisory Tool
    AI->>AI: Screen Specs, Budget, Terms
    AI-->>API: Return Advisory Recommendations (Draft Only)
    API-->>PA: Display Advisory Scorecard

    Note over Director,API: Mandatory Human Gate (Rule 7)
    Director->>PA: Review AI Score & Enter Justification
    Director->>PA: Click "Authorize Publication"
    PA->>API: POST /tenders/{id}/approve-publish
    API->>API: Validate Role: DIRECTOR
    API->>Ledger: Log Event: TENDER_APPROVED_FOR_PUBLISH
    API-->>PA: Status: APPROVED_FOR_PUBLICATION

    Buyer->>PA: Click "Publish to Vendor Portal"
    PA->>API: POST /tenders/{id}/publish
    API->>Ledger: Log Event: TENDER_PUBLISHED
    API-->>PA: Status: PUBLISHED (Visible to Vendors)
```

