# TenderFlow v0.9.0 — User Guide

> **Language Editions**:  
> 🇬🇧 [English User Quick Guide](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/guides/user-guide-en.md) | 🇰🇼 [دليل المستخدم السريع باللغة العربية](file:///c:/Users/kabed/Downloads/KBM_Tender_Product/docs/guides/user-guide-ar.md)

This guide covers workflows for Buyers (Procurement App) and Bidders (Vendor Portal).

---

## 1. Vendor Portal Workflows

### 1.1 Vendor Registration
1. Navigate to the Vendor Portal (`http://localhost:3000/register`).
2. Enter company name (Arabic and English), Commercial Registration (CR) number, and authorized contact email.
3. Upload commercial licenses and tax clearance documents.
4. An acknowledgement email is dispatched via Mailpit (`http://localhost:8025`).

### 1.2 Browsing Tenders & Submitting Inquiries
1. Browse active opportunities on the Tenders page.
2. Filter by sector or tender category.
3. Download published tender dossier files.
4. Submit clarification questions prior to the clarification closing date.

### 1.3 Submitting a Sealed Bid Package
1. Open the target published tender.
2. Select **Submit Sealed Bid**.
3. Upload the **Technical Proposal** and **Financial Proposal** documents.
4. The system calculates client-side cryptographic SHA-256 digests and locks the envelopes.
5. Receive your immutable digital bid receipt.

---

## 2. Procurement App Workflows

### 2.1 Preparing a Tender Dossier
1. Navigate to **Tenders > Create New Tender**.
2. Specify tender number, bilingual titles, estimated budget, and submission deadline.
3. Attach technical specifications, terms of reference, and bill of quantities.
4. Click **Run AI Completeness Check** to receive automated completeness advice.

### 2.2 Human Approval & Publishing (Rule 7)
1. The Procurement Director reviews the AI advisory score and recommendations.
2. Enter authorization rationale and click **Authorize Publication**.
3. The Procurement Specialist clicks **Publish Tender**. The opportunity becomes visible to registered vendors immediately.

### 2.3 Responding to Clarifications
1. Review vendor inquiries in the **Clarifications** tab.
2. Review the AI-generated draft response.
3. Edit as needed and click **Approve & Publish Response**.

### 2.4 Bid Opening Ceremony
1. When the submission deadline closes, open the **Bid Opening** tab.
2. Record attendee committee members.
3. Chairperson clicks **Execute Opening Ceremony**. Technical envelopes are unsealed for committee evaluation.

### 2.5 Technical Evaluation & Award
1. Evaluators review unsealed proposals and submit individual scorecards.
2. The consensus score and vendor ranking table update automatically.
3. The Authorized Officer signs off on the final contract award and issues formal award notices.
