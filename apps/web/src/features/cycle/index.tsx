// Cycle workstream: Cycle Designer, entity settings, requests, tender cycle panel, vendor eligibility/purchase,
// notifications bell. Components below are mounted by the app shell and tender pages.
import type { TenderDetail } from '../../api';

export function TenderCyclePanel(_: { td: TenderDetail; onChange: () => void }) { return null; }
export function VendorCyclePanel(_: { td: TenderDetail; onChange: () => void }) { return null; }
export function NotificationsBell() { return null; }
export function CycleDesignerPage() { return null; }
export function EntitySettingsPage() { return null; }
export function RequestsPage() { return null; }
export function RequestDetailPage() { return null; }
