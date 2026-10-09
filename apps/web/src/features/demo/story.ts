// The Demo Story: presenter-driven chapters over the seeded demo data. Pure data — the panel renders it.
// Every text is a locale key (typed), so a missing translation is a compile error.
import type { en } from '../../locales/demo';

export type DK = keyof typeof en;
export type EntityId = 'kea' | 'gcia' | 'moi';

export type Target =
  | { kind: 'tender'; number?: string; titleEn?: string }
  | { kind: 'request'; number: string }
  | { kind: 'path'; path: string };

/** One "Go": sign in as a persona of the chapter's entity, open a screen, spotlight an element. */
export interface Move {
  persona: string;
  target: Target;
  /** CSS selectors in priority order; the first one present on the page is highlighted. */
  spot: string[];
  label?: DK;
}

export interface Chapter {
  id: string;
  entity: EntityId;
  title: DK;
  why: DK;
  do: DK[];
  say: DK;
  moves: Move[];
  filenet?: DK;
  orch?: DK;
  /** Which live audit evidence proves the IBM value of this chapter. */
  evidence?: { actions?: string[]; ownerTypes?: string[]; aiKinds?: string[]; tender?: string };
  control?: { kind: 'expire-deadline'; tender: string };
}

const T101 = { kind: 'tender', number: 'KEA-2026-101' } as const;
const T102 = { kind: 'tender', number: 'KEA-2026-102' } as const;
const T088 = { kind: 'tender', number: 'KEA-2026-088' } as const;
// MOI seed (services/api/src/seed-moi.ts): request numbers follow the seed order; tenders are found by title.
const MOI_RASLNI = 'MOI-REQ-2026-0001';
const MOI_LETTER = 'MOI-REQ-2026-0002';
const MOI_PUBLISHED = 'Perimeter CCTV upgrade for border posts (fictitious)';
const MOI_DRAFT = 'Supply of patrol vehicle spare parts (fictitious)';

export const TRACKS: Record<EntityId, Chapter[]> = {
  kea: [
    {
      id: 'kea1', entity: 'kea', title: 'demo.ch.kea1.title', why: 'demo.ch.kea1.why', say: 'demo.ch.kea1.say',
      do: ['demo.ch.kea1.do1', 'demo.ch.kea1.do2', 'demo.ch.kea1.do3'],
      moves: [{ persona: 'officer', target: { kind: 'request', number: 'KEA-REQ-2026-0001' },
        spot: ['[data-tour="request-letter"]', '[data-tour="request"]', 'main .card', 'a[href="/procurement/requests"]'] }],
      filenet: 'demo.ch.kea1.filenet', orch: 'demo.ch.kea1.orch',
      evidence: { actions: ['REQUEST_SUBMITTED'], ownerTypes: ['REQUEST_LETTER'], aiKinds: ['REQUEST_CLASSIFY'] },
    },
    {
      id: 'keaDI', entity: 'kea', title: 'demo.ch.keaDI.title', why: 'demo.ch.keaDI.why', say: 'demo.ch.keaDI.say',
      do: ['demo.ch.keaDI.do1', 'demo.ch.keaDI.do2', 'demo.ch.keaDI.do3'],
      moves: [
        { persona: 'vendor1', target: { kind: 'path', path: '/vendor' }, spot: ['.inline-form', 'main .card'], label: 'demo.ch.keaDI.m1' },
        { persona: 'officer', target: { kind: 'path', path: '/procurement/documents' }, spot: ['[data-tour="docintel-open"]', '.di-counts', 'main h1'], label: 'demo.ch.keaDI.m2' },
      ],
      filenet: 'demo.ch.keaDI.filenet', orch: 'demo.ch.keaDI.orch',
      evidence: { actions: ['VENDOR_DOCUMENT_UPLOADED'], ownerTypes: ['VENDOR'], aiKinds: ['DOCUMENT_INTELLIGENCE'] },
    },
    {
      id: 'kea2', entity: 'kea', title: 'demo.ch.kea2.title', why: 'demo.ch.kea2.why', say: 'demo.ch.kea2.say',
      do: ['demo.ch.kea2.do1', 'demo.ch.kea2.do2', 'demo.ch.kea2.do3'],
      moves: [{ persona: 'officer', target: T101, spot: ['#sec-docs'] }],
      filenet: 'demo.ch.kea2.filenet',
      evidence: { actions: ['TENDER_DOCUMENT_UPLOADED', 'ADDENDUM_ISSUED'], tender: 'KEA-2026-101' },
    },
    {
      id: 'kea3', entity: 'kea', title: 'demo.ch.kea3.title', why: 'demo.ch.kea3.why', say: 'demo.ch.kea3.say',
      do: ['demo.ch.kea3.do1', 'demo.ch.kea3.do2', 'demo.ch.kea3.do3'],
      moves: [{ persona: 'officer', target: T101, spot: ['#sec-pack'] }],
      orch: 'demo.ch.kea3.orch',
      evidence: { aiKinds: ['PACK_CHECK'], tender: 'KEA-2026-101' },
    },
    {
      id: 'kea4', entity: 'kea', title: 'demo.ch.kea4.title', why: 'demo.ch.kea4.why', say: 'demo.ch.kea4.say',
      do: ['demo.ch.kea4.do1', 'demo.ch.kea4.do2', 'demo.ch.kea4.do3'],
      moves: [{ persona: 'director', target: T101, spot: ['[data-tour="approval-chain"]', '.cyc-chains-view', '.next-action'] }],
      orch: 'demo.ch.kea4.orch',
      evidence: { aiKinds: ['PACK_CHECK'], tender: 'KEA-2026-101' },
    },
    {
      id: 'kea5', entity: 'kea', title: 'demo.ch.kea5.title', why: 'demo.ch.kea5.why', say: 'demo.ch.kea5.say',
      do: ['demo.ch.kea5.do1', 'demo.ch.kea5.do2', 'demo.ch.kea5.do3'],
      moves: [{ persona: 'officer', target: T102, spot: ['[data-tour="publications"]', '#sec-publications', '[data-tour="cycle-panel"]', '.next-action'] }],
      filenet: 'demo.ch.kea5.filenet', orch: 'demo.ch.kea5.orch',
      evidence: { actions: ['NOTICE_PUBLISHED'], ownerTypes: ['NOTICE'], aiKinds: ['GAZETTE_NOTICE'], tender: 'KEA-2026-102' },
    },
    {
      id: 'kea6', entity: 'kea', title: 'demo.ch.kea6.title', why: 'demo.ch.kea6.why', say: 'demo.ch.kea6.say',
      do: ['demo.ch.kea6.do1', 'demo.ch.kea6.do2', 'demo.ch.kea6.do3'],
      moves: [
        { persona: 'vendor1', target: T102, spot: ['#vendor-clar', '.qa-list'], label: 'demo.ch.kea6.m1' },
        { persona: 'officer', target: T102, spot: ['#sec-clar'], label: 'demo.ch.kea6.m2' },
      ],
      filenet: 'demo.ch.kea6.filenet', orch: 'demo.ch.kea6.orch',
      evidence: { actions: ['ADDENDUM_ISSUED'], aiKinds: ['CLARIFICATION_DRAFT'], tender: 'KEA-2026-102' },
    },
    {
      id: 'kea7', entity: 'kea', title: 'demo.ch.kea7.title', why: 'demo.ch.kea7.why', say: 'demo.ch.kea7.say',
      do: ['demo.ch.kea7.do1', 'demo.ch.kea7.do2', 'demo.ch.kea7.do3'],
      moves: [
        { persona: 'vendor1', target: T088, spot: ['#vendor-bid', '#receipt-h'], label: 'demo.ch.kea7.m1' },
        { persona: 'chair', target: T088, spot: ['#sec-bids'], label: 'demo.ch.kea7.m2' },
      ],
      filenet: 'demo.ch.kea7.filenet',
      evidence: { actions: ['BID_SUBMITTED', 'BID_RESUBMITTED'], tender: 'KEA-2026-088' },
    },
    {
      id: 'kea8', entity: 'kea', title: 'demo.ch.kea8.title', why: 'demo.ch.kea8.why', say: 'demo.ch.kea8.say',
      do: ['demo.ch.kea8.do1', 'demo.ch.kea8.do2', 'demo.ch.kea8.do3'],
      moves: [{ persona: 'officer', target: T102, spot: ['#demo-control'] }],
      control: { kind: 'expire-deadline', tender: 'KEA-2026-102' },
    },
    {
      id: 'kea9', entity: 'kea', title: 'demo.ch.kea9.title', why: 'demo.ch.kea9.why', say: 'demo.ch.kea9.say',
      do: ['demo.ch.kea9.do1', 'demo.ch.kea9.do2', 'demo.ch.kea9.do3'],
      moves: [{ persona: 'chair', target: T088, spot: ['#sec-opening'] }],
      filenet: 'demo.ch.kea9.filenet',
      evidence: { actions: ['TENDER_OPENED'], ownerTypes: ['OPENING_RECORD'], tender: 'KEA-2026-088' },
    },
    {
      id: 'kea10', entity: 'kea', title: 'demo.ch.kea10.title', why: 'demo.ch.kea10.why', say: 'demo.ch.kea10.say',
      do: ['demo.ch.kea10.do1', 'demo.ch.kea10.do2', 'demo.ch.kea10.do3'],
      moves: [{ persona: 'chair', target: T088, spot: ['#sec-compliance'] }],
      orch: 'demo.ch.kea10.orch',
      evidence: { aiKinds: ['COMPLIANCE_SCREEN'], tender: 'KEA-2026-088' },
    },
    {
      id: 'kea11', entity: 'kea', title: 'demo.ch.kea11.title', why: 'demo.ch.kea11.why', say: 'demo.ch.kea11.say',
      do: ['demo.ch.kea11.do1', 'demo.ch.kea11.do2', 'demo.ch.kea11.do3'],
      moves: [
        { persona: 'evaluator1', target: T088, spot: ['#sec-scoring'], label: 'demo.ch.kea11.m1' },
        { persona: 'chair', target: T088, spot: ['[data-tour="narrative"]', '#sec-orchestrate', '#sec-summary'], label: 'demo.ch.kea11.m2' },
      ],
      filenet: 'demo.ch.kea11.filenet', orch: 'demo.ch.kea11.orch',
      evidence: { ownerTypes: ['EVALUATION_NARRATIVE', 'COMMITTEE_REPORT'], aiKinds: ['EVALUATION_NARRATIVE'], tender: 'KEA-2026-088' },
    },
    {
      id: 'kea12', entity: 'kea', title: 'demo.ch.kea12.title', why: 'demo.ch.kea12.why', say: 'demo.ch.kea12.say',
      do: ['demo.ch.kea12.do1', 'demo.ch.kea12.do2', 'demo.ch.kea12.do3'],
      moves: [
        { persona: 'director', target: T088, spot: ['.next-action'], label: 'demo.ch.kea12.m1' },
        { persona: 'auditor', target: { kind: 'path', path: '/admin/audit' }, spot: ['[data-tour="audit-verify"]', 'main .page-head .btn'], label: 'demo.ch.kea12.m2' },
      ],
      filenet: 'demo.ch.kea12.filenet',
      evidence: { actions: ['AWARD_APPROVED', 'RECORDS_DECLARED'], ownerTypes: ['COMMITTEE_REPORT'], tender: 'KEA-2026-088' },
    },
  ],
  gcia: [
    {
      id: 'gcia1', entity: 'gcia', title: 'demo.ch.gcia1.title', why: 'demo.ch.gcia1.why', say: 'demo.ch.gcia1.say',
      do: ['demo.ch.gcia1.do1', 'demo.ch.gcia1.do2', 'demo.ch.gcia1.do3'],
      moves: [{ persona: 'undersecretary', target: { kind: 'tender', titleEn: 'Coastal Road Drainage Upgrade' },
        spot: ['[data-tour="approval-chain"]', '.cyc-chains-view', '.next-action'] }],
    },
    {
      id: 'gcia2', entity: 'gcia', title: 'demo.ch.gcia2.title', why: 'demo.ch.gcia2.why', say: 'demo.ch.gcia2.say',
      do: ['demo.ch.gcia2.do1', 'demo.ch.gcia2.do2', 'demo.ch.gcia2.do3'],
      moves: [{ persona: 'vendor3', target: { kind: 'tender', titleEn: 'Fishing Harbour Breakwater Repair' },
        spot: ['[data-tour="eligibility"]', '#sec-eligibility', '#vendor-bid'] }],
    },
    {
      id: 'gcia3', entity: 'gcia', title: 'demo.ch.gcia3.title', why: 'demo.ch.gcia3.why', say: 'demo.ch.gcia3.say',
      do: ['demo.ch.gcia3.do1', 'demo.ch.gcia3.do2', 'demo.ch.gcia3.do3'],
      moves: [{ persona: 'vendor2', target: { kind: 'tender', titleEn: 'Fishing Harbour Breakwater Repair' },
        spot: ['[data-tour="purchase"]', '#sec-purchase', '#vendor-bid'] }],
    },
    {
      id: 'gcia4', entity: 'gcia', title: 'demo.ch.gcia4.title', why: 'demo.ch.gcia4.why', say: 'demo.ch.gcia4.say',
      do: ['demo.ch.gcia4.do1', 'demo.ch.gcia4.do2', 'demo.ch.gcia4.do3'],
      moves: [{ persona: 'chair', target: { kind: 'tender', titleEn: 'Marine Jetty Rehabilitation' }, spot: ['#sec-opening'] }],
      filenet: 'demo.ch.gcia4.filenet',
      evidence: { actions: ['TENDER_OPENED', 'FINANCIAL_ENVELOPES_OPENED', 'BID_SUBMITTED'] },
    },
  ],
  // Track C — MOI reference configuration (BRD v0.1): Phase 1 ends at the document purchase.
  moi: [
    {
      id: 'moi1', entity: 'moi', title: 'demo.ch.moi1.title', why: 'demo.ch.moi1.why', say: 'demo.ch.moi1.say',
      do: ['demo.ch.moi1.do1', 'demo.ch.moi1.do2', 'demo.ch.moi1.do3'],
      moves: [
        { persona: 'tenderdept', target: { kind: 'request', number: MOI_LETTER }, spot: ['.cyc-letter', 'main .card'], label: 'demo.ch.moi1.m1' },
        { persona: 'tenderdept', target: { kind: 'request', number: MOI_RASLNI }, spot: ['.cyc-chain', 'main .card'], label: 'demo.ch.moi1.m2' },
      ],
      filenet: 'demo.ch.moi1.filenet',
      evidence: { actions: ['REQUEST_SUBMITTED'], ownerTypes: ['REQUEST_LETTER'] },
    },
    {
      id: 'moi2', entity: 'moi', title: 'demo.ch.moi2.title', why: 'demo.ch.moi2.why', say: 'demo.ch.moi2.say',
      do: ['demo.ch.moi2.do1', 'demo.ch.moi2.do2', 'demo.ch.moi2.do3'],
      moves: [
        { persona: 'director', target: { kind: 'request', number: MOI_LETTER }, spot: ['.cyc-chain', '.next-action', 'main .card'], label: 'demo.ch.moi2.m1' },
        { persona: 'auditor', target: { kind: 'path', path: '/admin/audit' }, spot: ['[data-tour="audit-verify"]', 'main .page-head .btn'], label: 'demo.ch.moi2.m2' },
      ],
      evidence: { actions: ['REQUEST_APPROVED', 'REQUEST_SUBMITTED'] },
    },
    {
      id: 'moi3', entity: 'moi', title: 'demo.ch.moi3.title', why: 'demo.ch.moi3.why', say: 'demo.ch.moi3.say',
      do: ['demo.ch.moi3.do1', 'demo.ch.moi3.do2', 'demo.ch.moi3.do3'],
      moves: [
        { persona: 'officer', target: { kind: 'tender', titleEn: MOI_DRAFT }, spot: ['#sec-cycle', '#sec-eligibility', '.next-action'], label: 'demo.ch.moi3.m1' },
        { persona: 'admin', target: { kind: 'path', path: '/admin/cycle' }, spot: ['[data-tour="cycle-scope"]', '.cyc-preview'], label: 'demo.ch.moi3.m2' },
      ],
    },
    {
      id: 'moi4', entity: 'moi', title: 'demo.ch.moi4.title', why: 'demo.ch.moi4.why', say: 'demo.ch.moi4.say',
      do: ['demo.ch.moi4.do1', 'demo.ch.moi4.do2', 'demo.ch.moi4.do3'],
      moves: [
        { persona: 'vendor1', target: { kind: 'path', path: '/vendor' }, spot: ['main .table-wrap', 'main .card'], label: 'demo.ch.moi4.m1' },
        { persona: 'vendor2', target: { kind: 'path', path: '/vendor' }, spot: ['main .empty', 'main .card'], label: 'demo.ch.moi4.m2' },
      ],
    },
    {
      id: 'moi5', entity: 'moi', title: 'demo.ch.moi5.title', why: 'demo.ch.moi5.why', say: 'demo.ch.moi5.say',
      do: ['demo.ch.moi5.do1', 'demo.ch.moi5.do2', 'demo.ch.moi5.do3'],
      moves: [
        { persona: 'vendor1', target: { kind: 'tender', titleEn: MOI_PUBLISHED }, spot: ['#sec-purchase', '#sec-eligibility'], label: 'demo.ch.moi5.m1' },
      ],
      evidence: { actions: ['TENDER_DOCUMENTS_PURCHASED', 'TENDER_FEE_EXEMPTED'] },
    },
    {
      id: 'moi6', entity: 'moi', title: 'demo.ch.moi6.title', why: 'demo.ch.moi6.why', say: 'demo.ch.moi6.say',
      do: ['demo.ch.moi6.do1', 'demo.ch.moi6.do2', 'demo.ch.moi6.do3'],
      moves: [
        { persona: 'grader', target: { kind: 'path', path: '/procurement/grading' }, spot: ['#grading-applications', 'main h1'], label: 'demo.ch.moi6.m1' },
        { persona: 'vendor2', target: { kind: 'path', path: '/vendor/subscription' }, spot: ['[data-tour="renewal-reminder"]', '#subscription'], label: 'demo.ch.moi6.m2' },
      ],
      orch: 'demo.ch.moi6.orch',
      evidence: { actions: ['VENDOR_GRADED', 'GRADE_UPGRADE_REQUESTED'], aiKinds: ['GRADE_REVIEW'] },
    },
    {
      id: 'moi7', entity: 'moi', title: 'demo.ch.moi7.title', why: 'demo.ch.moi7.why', say: 'demo.ch.moi7.say',
      do: ['demo.ch.moi7.do1', 'demo.ch.moi7.do2', 'demo.ch.moi7.do3'],
      moves: [
        { persona: 'admin', target: { kind: 'path', path: '/admin/vendor-lifecycle' }, spot: ['tr.moi-row-blocked', 'main .table-wrap'], label: 'demo.ch.moi7.m1' },
        { persona: 'admin', target: { kind: 'path', path: '/admin/vendor-lifecycle' }, spot: ['[data-tour="run-jobs"]'], label: 'demo.ch.moi7.m2' },
      ],
    },
    {
      id: 'moi8', entity: 'moi', title: 'demo.ch.moi8.title', why: 'demo.ch.moi8.why', say: 'demo.ch.moi8.say',
      do: ['demo.ch.moi8.do1', 'demo.ch.moi8.do2', 'demo.ch.moi8.do3'],
      moves: [
        { persona: 'admin', target: { kind: 'path', path: '/admin/policies' }, spot: ['.moi-ref-card', 'main h1'], label: 'demo.ch.moi8.m1' },
        { persona: 'admin', target: { kind: 'path', path: '/admin/policies' }, spot: ['#open-decisions'], label: 'demo.ch.moi8.m2' },
      ],
    },
  ],
};

export const ENTITY_NAME: Record<EntityId, DK> = { kea: 'demo.entity.kea', gcia: 'demo.entity.gcia', moi: 'demo.entity.moi' };
export const TRACK_LABEL: Record<EntityId, DK> = { kea: 'demo.track.kea', gcia: 'demo.track.gcia', moi: 'demo.track.moi' };
export const TRACK_HINT: Record<EntityId, DK> = { kea: 'demo.trackHint.kea', gcia: 'demo.trackHint.gcia', moi: 'demo.trackHint.moi' };
