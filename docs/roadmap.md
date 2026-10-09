# TenderFlow Product Roadmap (Post v1.0.0-rc1)

**Guiding Principle**: Per Rule 13 and [`docs/agents/TONIGHT.md`](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/agents/TONIGHT.md), features and hardening items deferred from the immediate 23:59 release candidate are cleanly recorded here rather than faked or half-built.

---

## 1. Security & Infrastructure Hardening (Deferred from Tonight)

### 1.1 Production TLS for IBM FileNet Endpoint (R0b-3)
- **Current Limitation**: TechZone FileNet GraphQL endpoint is plain HTTP (`http://...:31413/content-services-graphql/graphql`), meaning Basic credentials travel unencrypted across the network link.
- **Production Target**: Enforce mutual TLS (mTLS) or HTTPS with verified enterprise CA certificate (`FILENET_CA_CERT`).

### 1.2 Dedicated Least-Privilege FileNet Service User (R0b-3)
- **Current Limitation**: Tonight's integration operates using the administrative account (`Administrator`) provisioned in the TechZone demo image.
- **Production Target**: Create a restricted `tf_content_svc` account in Active Directory / LDAP with write permissions scoped strictly to `/TenderFlow` object classes.

### 1.3 Database Row-Level Security (RLS)
- **Current Baseline**: Multi-tenant isolation is enforced strictly at the API and repository query layer (every query filters on `tenant_id`).
- **Production Target**: Add PostgreSQL Row-Level Security policies as defense-in-depth on the tenant table space.

### 1.4 Background Deadline Cron Scheduler
- **Current Baseline**: Submission deadline locks are enforced dynamically on incoming requests (server clock verification rejecting bids submitted after `submissionDeadline`).
- **Production Target**: Dedicated scheduler (`pg-boss` / cron worker) transitioning tenders from `PUBLISHED` to `CLOSED` asynchronously.

### 1.5 Automated SMTP Notifications
- **Current Baseline**: Workflow events generate audit records and state changes.
- **Production Target**: Real-time bilingual email dispatch for approvals, addenda, and awards.

### 1.6 Container Vulnerability Scanning & Prometheus Metrics
- **Current Baseline**: Build and security test suites, secret scanning, and CycloneDX SBOM.
- **Production Target**: Automated Trivy vulnerability scans in CI and `/metrics` Prometheus scrapers.

---

## 2. Advanced Procurement Modules (Post-ESA Review Build)

### 2.1 Multi-Signatory Cryptographic Quorum for Bid Opening
- **Description**: Requiring `m-of-n` Shamir Secret Sharing threshold decryption or multi-key signature by Bid Opening Committee members before unsealing bids.
- **Current Baseline**: Committee Chair authorization with recorded attendee log in audit trail.

### 2.2 Live Reverse Auction Module
- **Description**: Dynamic real-time downward price bidding clock with real-time WebSockets communication for financial rounds.
- **Current Baseline**: Static sealed financial bids opened in evaluation stage.

### 2.3 ERP / Financial Integration Connectors
- **Description**: Native SAP, Oracle, and Maximo connectors for automated purchase requisition to tender conversion and purchase order generation upon award.
- **Current Baseline**: REST API and Webhook endpoints with JSON export.

### 2.4 Direct Online Payment Gateway (KNET & Credit Cards)
- **Description**: Online collection of tender document purchase fees and bid bond validation via local payment switch.
- **Current Baseline**: Document fee tracking and manual payment proof attachment.

### 2.5 Multi-Version Bid Replacement
- **Description**: Formal vendor version management allowing tenderers to revise bids before deadline with cryptographic supersede chains.
