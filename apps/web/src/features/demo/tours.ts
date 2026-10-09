// Role tours: 4–7 spotlight steps over each role's real screens. Pure data; RoleTour renders it.
import type { Role } from '../../api';
import type { DK } from './story';

export interface TourStep {
  title: DK;
  body: DK;
  /** Navigate here first (client-side) if the current path differs. */
  path?: string;
  /** Selectors in priority order; none → the step is shown centred without a spotlight. */
  spot?: string[];
}
export type TourId = 'officer' | 'director' | 'chair' | 'evaluator' | 'auditor' | 'admin' | 'vendor';

const LANG = ['.lang-toggle'];
const END: TourStep = { title: 'demo.tour.end.t', body: 'demo.tour.end.b', spot: ['.demo-launch'] };

export const TOURS: Record<TourId, TourStep[]> = {
  officer: [
    { title: 'demo.tour.officer.1.t', body: 'demo.tour.officer.1.b', path: '/procurement', spot: ['main .tiles', 'main h1'] },
    { title: 'demo.tour.officer.2.t', body: 'demo.tour.officer.2.b', spot: ['a[href="/procurement/requests"]'] },
    { title: 'demo.tour.officer.3.t', body: 'demo.tour.officer.3.b', spot: ['a[href="/procurement/tenders"]'] },
    { title: 'demo.tour.officer.4.t', body: 'demo.tour.officer.4.b', spot: ['a[href="/procurement/tenders/new"]'] },
    { title: 'demo.tour.officer.5.t', body: 'demo.tour.officer.5.b', spot: ['a[href="/procurement/vendors"]'] },
    { title: 'demo.tour.officer.6.t', body: 'demo.tour.officer.6.b', spot: LANG },
    END,
  ],
  director: [
    { title: 'demo.tour.director.1.t', body: 'demo.tour.director.1.b', path: '/procurement', spot: ['main .tiles', 'main h1'] },
    { title: 'demo.tour.director.2.t', body: 'demo.tour.director.2.b', spot: ['a[href="/procurement/tenders"]'] },
    { title: 'demo.tour.director.3.t', body: 'demo.tour.director.3.b', spot: ['a[href="/procurement/requests"]'] },
    { title: 'demo.tour.director.4.t', body: 'demo.tour.director.4.b' },
    { title: 'demo.tour.director.5.t', body: 'demo.tour.director.5.b', spot: LANG },
    END,
  ],
  chair: [
    { title: 'demo.tour.chair.1.t', body: 'demo.tour.chair.1.b', path: '/procurement', spot: ['main .tiles', 'main h1'] },
    { title: 'demo.tour.chair.2.t', body: 'demo.tour.chair.2.b', spot: ['a[href="/procurement/tenders"]'] },
    { title: 'demo.tour.chair.3.t', body: 'demo.tour.chair.3.b' },
    { title: 'demo.tour.chair.4.t', body: 'demo.tour.chair.4.b' },
    { title: 'demo.tour.chair.5.t', body: 'demo.tour.chair.5.b', spot: LANG },
    END,
  ],
  evaluator: [
    { title: 'demo.tour.evaluator.1.t', body: 'demo.tour.evaluator.1.b', path: '/procurement', spot: ['main .tiles', 'main h1'] },
    { title: 'demo.tour.evaluator.2.t', body: 'demo.tour.evaluator.2.b', spot: ['a[href="/procurement/tenders"]'] },
    { title: 'demo.tour.evaluator.3.t', body: 'demo.tour.evaluator.3.b' },
    { title: 'demo.tour.evaluator.4.t', body: 'demo.tour.evaluator.4.b', spot: LANG },
    END,
  ],
  auditor: [
    { title: 'demo.tour.auditor.1.t', body: 'demo.tour.auditor.1.b', path: '/admin/audit', spot: ['main .card', 'main h1'] },
    { title: 'demo.tour.auditor.2.t', body: 'demo.tour.auditor.2.b', path: '/admin/audit', spot: ['[data-tour="audit-verify"]', 'main .page-head .btn'] },
    { title: 'demo.tour.auditor.3.t', body: 'demo.tour.auditor.3.b', path: '/admin/audit', spot: ['main .filters'] },
    { title: 'demo.tour.auditor.4.t', body: 'demo.tour.auditor.4.b', spot: ['a[href="/admin/filenet"]'] },
    { title: 'demo.tour.auditor.5.t', body: 'demo.tour.auditor.5.b', spot: ['a[href="/admin/system"]'] },
    END,
  ],
  admin: [
    { title: 'demo.tour.admin.1.t', body: 'demo.tour.admin.1.b', path: '/admin', spot: ['main .card', 'main h1'] },
    { title: 'demo.tour.admin.2.t', body: 'demo.tour.admin.2.b', spot: ['a[href="/admin/cycle"]'] },
    { title: 'demo.tour.admin.3.t', body: 'demo.tour.admin.3.b', spot: ['a[href="/admin/entity"]'] },
    { title: 'demo.tour.admin.4.t', body: 'demo.tour.admin.4.b', spot: ['a[href="/admin/audit"]'] },
    { title: 'demo.tour.admin.5.t', body: 'demo.tour.admin.5.b', spot: ['a[href="/admin/filenet"]'] },
    { title: 'demo.tour.admin.6.t', body: 'demo.tour.admin.6.b', spot: ['a[href="/admin/system"]'] },
    END,
  ],
  vendor: [
    { title: 'demo.tour.vendor.1.t', body: 'demo.tour.vendor.1.b', path: '/vendor', spot: ['main .stack > section.card:nth-of-type(1)'] },
    { title: 'demo.tour.vendor.2.t', body: 'demo.tour.vendor.2.b', path: '/vendor', spot: ['main .stack > section.card:nth-of-type(2)'] },
    { title: 'demo.tour.vendor.3.t', body: 'demo.tour.vendor.3.b', path: '/vendor', spot: ['main .stack > section.card:nth-of-type(3)'] },
    { title: 'demo.tour.vendor.4.t', body: 'demo.tour.vendor.4.b', spot: LANG },
    END,
  ],
};

const ROLE_TOUR: Record<Role, TourId> = {
  VENDOR: 'vendor', PROCUREMENT_OFFICER: 'officer', DIRECTOR: 'director', UNDERSECRETARY: 'director', COMMITTEE_CHAIR: 'chair',
  EVALUATOR: 'evaluator', AUDITOR: 'auditor', TENANT_ADMIN: 'admin',
};

/** The tour of a user's primary (first) role. */
export function tourFor(roles: Role[]): TourId | null {
  for (const r of roles) if (ROLE_TOUR[r]) return ROLE_TOUR[r];
  return null;
}
