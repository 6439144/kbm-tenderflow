import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { I18nContext, makeI18n, type Lang } from './i18n';
import { homeFor, SessionProvider, useSession } from './session';
import { ToastProvider } from './components/ui';
import { Portal, type NavItem } from './components/Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import VendorHome from './pages/vendor/VendorHome';
import VendorTender from './pages/vendor/VendorTender';
import Dashboard from './pages/procurement/Dashboard';
import VendorsQueue from './pages/procurement/VendorsQueue';
import TendersList from './pages/procurement/TendersList';
import TenderForm from './pages/procurement/TenderForm';
import TenderDetailPage from './pages/procurement/TenderDetail';
import { AdminUsers, AdminAudit, AdminSystem } from './pages/admin/Admin';
import { CycleDesignerPage, EntitySettingsPage, RequestDetailPage, RequestsPage } from './features/cycle';
import { DemoOverlay } from './features/demo';
import { FileNetHealthPage } from './features/filenet';
import { AssistantDock } from './features/assistant';
import { DocumentQueuePage, DocumentTypesPage } from './features/docintel';
import { AdminOverviewPage, AnalyticsPage, EvidencePackPage, PublicBoardPage } from './features/insight';
import { DeliveryLogPage, JobsPage, NotificationTemplatesPage } from './features/notify';

const LANG_KEY = 'tf.lang';

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'en' || v === 'ar') return v;
  } catch {
    /* ignore */
  }
  return 'ar';
}

const PROCUREMENT_NAV: NavItem[] = [
  { to: '/procurement', label: 'nav.dashboard', end: true },
  { to: '/procurement/requests', label: 'nav.requests' },
  { to: '/procurement/tenders', label: 'nav.tenders' },
  { to: '/procurement/tenders/new', label: 'nav.newTender', roles: ['PROCUREMENT_OFFICER'] },
  { to: '/procurement/vendors', label: 'nav.vendors', roles: ['PROCUREMENT_OFFICER', 'DIRECTOR'] },
  { to: '/procurement/documents', label: 'nav.documentIntelligence' },
  { to: '/procurement/analytics', label: 'insight.nav.analytics', roles: ['DIRECTOR', 'UNDERSECRETARY'] },
];
const VENDOR_NAV: NavItem[] = [{ to: '/vendor', label: 'nav.myCompany', end: true }];
const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'nav.users', end: true, roles: ['TENANT_ADMIN'] },
  { to: '/admin/cycle', label: 'nav.cycleDesigner', roles: ['TENANT_ADMIN'] },
  { to: '/admin/entity', label: 'nav.entity', roles: ['TENANT_ADMIN'] },
  { to: '/admin/document-types', label: 'nav.documentTypes', roles: ['TENANT_ADMIN'] },
  { to: '/admin/documents', label: 'nav.documentIntelligence' },
  { to: '/admin/audit', label: 'nav.audit' },
  { to: '/admin/filenet', label: 'nav.filenet' },
  { to: '/admin/system', label: 'nav.system' },
  { to: '/admin/overview', label: 'insight.nav.overview' },
  { to: '/admin/analytics', label: 'insight.nav.analytics' },
  { to: '/admin/evidence', label: 'insight.nav.evidence' },
  { to: '/admin/notifications', label: 'nav.notifications', end: true },
  { to: '/admin/notifications/log', label: 'nav.deliveryLog' },
  { to: '/admin/jobs', label: 'nav.jobs' },
];

function Home() {
  const { user } = useSession();
  return <Navigate to={user ? homeFor(user) : '/login'} replace />;
}

function NotFound() {
  return (
    <main className="page" id="main">
      <h1>404</h1>
    </main>
  );
}

export default function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const i18n = useMemo(() => makeI18n(lang, setLang), [lang]);

  return (
    <I18nContext.Provider value={i18n}>
      <ToastProvider>
        <SessionProvider>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            {/* insight routes */}
            <Route path="/tenders" element={<PublicBoardPage />} />
            <Route path="/vendor" element={<Portal roles={['VENDOR']} nav={VENDOR_NAV} />}>
              <Route index element={<VendorHome />} />
              <Route path="tenders/:id" element={<VendorTender />} />
            </Route>
            <Route
              path="/procurement"
              element={<Portal roles={['PROCUREMENT_OFFICER', 'DIRECTOR', 'UNDERSECRETARY', 'COMMITTEE_CHAIR', 'EVALUATOR']} nav={PROCUREMENT_NAV} />}
            >
              <Route index element={<Dashboard />} />
              <Route path="vendors" element={<VendorsQueue />} />
              <Route path="requests" element={<RequestsPage />} />
              <Route path="requests/:id" element={<RequestDetailPage />} />
              <Route path="tenders" element={<TendersList />} />
              <Route path="tenders/new" element={<TenderForm />} />
              <Route path="tenders/:id" element={<TenderDetailPage />} />
              <Route path="tenders/:id/edit" element={<TenderForm />} />
              <Route path="documents" element={<DocumentQueuePage />} />
              {/* insight routes */}
              <Route path="analytics" element={<AnalyticsPage />} />
            </Route>
            <Route path="/admin" element={<Portal roles={['TENANT_ADMIN', 'AUDITOR']} nav={ADMIN_NAV} />}>
              <Route index element={<AdminUsers />} />
              <Route path="audit" element={<AdminAudit />} />
              <Route path="cycle" element={<CycleDesignerPage />} />
              <Route path="entity" element={<EntitySettingsPage />} />
              <Route path="document-types" element={<DocumentTypesPage />} />
              <Route path="documents" element={<DocumentQueuePage />} />
              <Route path="filenet" element={<FileNetHealthPage />} />
              <Route path="system" element={<AdminSystem />} />
              {/* insight routes */}
              <Route path="overview" element={<AdminOverviewPage />} />
              <Route path="analytics" element={<AnalyticsPage />} />
              <Route path="evidence" element={<EvidencePackPage />} />
              {/* notify routes */}
              <Route path="notifications" element={<NotificationTemplatesPage />} />
              <Route path="notifications/log" element={<DeliveryLogPage />} />
              <Route path="jobs" element={<JobsPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          <DemoOverlay />
          <AssistantDock />
        </SessionProvider>
      </ToastProvider>
    </I18nContext.Provider>
  );
}
