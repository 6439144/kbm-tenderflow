import { useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet } from 'react-router-dom';
import { downloadFile, openFile, type Role } from '../api';
import { useI18n, type TKey } from '../i18n';
import { useSession } from '../session';
import { useDeployment } from '../deployment';
import { Button, useToast, errText } from './ui';
import { NotificationsBell } from '../features/cycle';
import { DemoLauncher } from '../features/demo';

export interface NavItem {
  to: string;
  label: TKey;
  end?: boolean;
  roles?: Role[];
}

export function Header({ children }: { children?: ReactNode }) {
  const { t, te, lang, setLang, pick } = useI18n();
  const { user, tenant, signOut } = useSession();
  const { dedicated, entity, entityName } = useDeployment();
  // Dedicated installation: the entity's own brand (logo text, name, colour); TenderFlow is the product line below it.
  const own = dedicated && entity;
  return (
    <header className="topbar">
      <a className="skip" href="#main">
        {t('nav.skip')}
      </a>
      <div className={`brand ${own ? 'brand-own' : ''}`}>
        <span className={`brand-mark ${own && entity.logoText ? 'brand-mark-text' : ''}`} aria-hidden="true">
          {own && entity.logoText ? (
            <span dir="ltr">{entity.logoText}</span>
          ) : (
            <svg width="22" height="22" viewBox="0 0 32 32">
              <path d="M7 9h18M16 9v16" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" fill="none" />
            </svg>
          )}
        </span>
        {own ? (
          <div>
            <div className="brand-name">{entityName}</div>
            <div className="brand-tenant">{t('ded.brand.product')}</div>
          </div>
        ) : (
          <div>
            <div className="brand-name">{t('app.name')}</div>
            {tenant && <div className="brand-tenant">{pick(tenant.nameEn, tenant.nameAr)}</div>}
          </div>
        )}
      </div>
      {children}
      <div className="topbar-end">
        {user && <DemoLauncher />}
        {user && <NotificationsBell />}
        {user && (
          <div className="whoami" aria-label={t('header.signedInAs')}>
            <div className="whoami-name">{user.displayName || user.username}</div>
            <div className="whoami-roles">{user.roles.map((r) => te('role.', r)).join(' · ')}</div>
          </div>
        )}
        <button
          type="button"
          className="btn btn-ghost lang-toggle"
          onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          aria-label={t('header.languageLabel')}
          lang={lang === 'ar' ? 'en' : 'ar'}
        >
          {t('header.language')}
        </button>
        {user && (
          <Button variant="secondary" onClick={signOut}>
            {t('header.logout')}
          </Button>
        )}
      </div>
    </header>
  );
}

/** Authenticated portal shell: header + side navigation + routed content. */
export function Portal({ roles, nav }: { roles: Role[]; nav: NavItem[] }) {
  const { t } = useI18n();
  const { session, hasRole } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (!hasRole(...roles))
    return (
      <>
        <Header />
        <main id="main" className="page">
          <div className="alert alert-danger" role="alert">
            {t('err.forbidden')}
          </div>
        </main>
      </>
    );
  const items = nav.filter((n) => !n.roles || hasRole(...n.roles));
  return (
    <>
      <Header />
      <div className="shell">
        <nav className="sidenav" aria-label="Primary">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }: { isActive: boolean }) => `navlink ${isActive ? 'active' : ''}`}>
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
        <main id="main" className="page" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </>
  );
}

/** Button that fetches a protected document with the bearer token and downloads it. */
export function DocButton({
  path,
  name,
  label,
  mode = 'download',
  variant = 'ghost',
}: {
  path: string;
  name: string;
  label?: ReactNode;
  mode?: 'download' | 'open';
  variant?: 'ghost' | 'secondary' | 'primary';
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (mode === 'open') await openFile(path);
      else await downloadFile(path, name);
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant={variant} busy={busy} onClick={run} aria-label={`${t(mode === 'open' ? 'common.open' : 'common.download')}: ${name}`}>
      {label ?? t(mode === 'open' ? 'common.open' : 'common.download')}
    </Button>
  );
}
