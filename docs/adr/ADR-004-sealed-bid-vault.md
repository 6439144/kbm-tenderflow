# ADR-004: Sealed-Bid Cryptographic Vault Architecture (T07)

## Status
Accepted (Non-negotiable Rule 1)

## Context
Public procurement regulations strictly mandate that bids submitted by vendors remain completely sealed and confidential until the formal, scheduled bid opening ceremony.
Rule 1 specifies: *"Sealed bids: no user, service or AI agent can read a bid before the opening event is recorded. Enforced on the server and proven by tests."*

## Decision
1. **Server-Side Enforcement**: The core API strictly blocks any request to retrieve bid contents (`GET /tenders/{tenderId}/bids/{bidId}/content`) while `tender.status !== 'BIDS_OPENED'`.
2. Any premature access attempt returns HTTP `403 Forbidden` with error code `BIDS_SEALED_UNTIL_OPENING_EVENT`.
3. Even Super Administrators and AI advisory agents are denied access; permissions do not override the sealed-state gate.
4. **Envelope Cryptography**: Bids submitted by vendors receive envelope key encryption. Keys are locked until the formal opening ceremony is recorded.
5. **Bid Opening Ceremony Gate**: Only an authorized committee member (`OPENING_COMMITTEE_CHAIR`) can execute the Bid Opening Event (`POST /tenders/{tenderId}/bids/opening-ceremony`), which:
   - Emits an immutable audit record with attendee list and timestamp.
   - Advances tender state to `BIDS_OPENED`.
   - Advances bid status to `OPENED`.
   - Releases the technical proposal envelopes for committee evaluation.

## Consequences
- Guaranteed compliance with regulatory procurement statutes.
- Proven mathematically and programmatically through automated tests (`tests/security/sealed-bid-security.test.ts`).
