import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';

/**
 * "← Tenders" back link of a record page. Administrators and auditors open the same record read-only under /admin/…;
 * there the link goes back to where they came from (dashboard, audit log, evidence pack), or to the admin overview.
 */
export function RecordBackLink({ to, label }: { to: string; label: string }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (!pathname.startsWith('/admin/')) {
    return <Link to={to} className="backlink">← {label}</Link>;
  }
  return (
    <Link
      to="/admin/overview"
      className="backlink"
      onClick={(e) => {
        // history.state.idx is set by the router: > 0 means there is a page of this app to go back to
        const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (idx > 0) { e.preventDefault(); navigate(-1); }
      }}
    >
      ← {t('common.back')}
    </Link>
  );
}
