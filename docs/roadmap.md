# TenderFlow Product Roadmap (Post v0.9.0)

**Guiding Principle**: If a feature cannot be product-grade by the code freeze (Wed 14 Oct 2026, 18:00 Kuwait time), it is cleanly cut to this roadmap rather than shipped half-built.

---

## Planned for v1.0.0 (Post-ESA Review Build)

### 1. Multi-Signatory Cryptographic Quorum for Bid Opening
- **Description**: Requiring `m-of-n` Shamir Secret Sharing threshold decryption or multi-key signature by Bid Opening Committee members before unsealing bids.
- **Current v0.9.0 Baseline**: Committee Chair authorization with recorded attendee log in audit trail.

### 2. Live Reverse Auction Module
- **Description**: Dynamic real-time downward price bidding clock with real-time WebSockets communication for financial rounds.
- **Current v0.9.0 Baseline**: Static sealed financial bids opened in evaluation stage.

### 3. ERP / Financial Integration Connectors
- **Description**: Native SAP, Oracle, and Maximo connectors for automated purchase requisition to tender conversion and purchase order generation upon award.
- **Current v0.9.0 Baseline**: REST API and Webhook endpoints with JSON export.

### 4. Direct Online Payment Gateway (KNET & Credit Cards)
- **Description**: Online collection of tender document purchase fees and bid bond validation via local payment switch.
- **Current v0.9.0 Baseline**: Document fee tracking and manual payment proof attachment.

### 5. Advanced Contract Lifecycle Management (CLM)
- **Description**: Post-award contract drafting, milestone tracking, and performance bond release workflows.
- **Current v0.9.0 Baseline**: Lifecycle concludes at Award notification and Letter of Intent issuance.
