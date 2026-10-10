import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearSession, loadSession, saveSession, UNAUTHORIZED_EVENT, type Role, type Session, type Tenant, type User } from './api';

interface SessionCtx {
  session: Session | null;
  user: User | null;
  tenant: Tenant | null;
  hasRole: (...roles: Role[]) => boolean;
  signIn: (s: Session) => void;
  signOut: () => void;
  expired: boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function homeFor(user: User): string {
  if (user.roles.includes('VENDOR')) return '/vendor';
  if (user.roles.includes('GRADING_AUTHORITY') && !user.roles.some((r) => r === 'PROCUREMENT_OFFICER' || r === 'DIRECTOR')) return '/procurement/grading';
  if (user.roles.some((r) => r === 'PROCUREMENT_OFFICER' || r === 'DIRECTOR' || r === 'UNDERSECRETARY' || r === 'COMMITTEE_CHAIR' || r === 'EVALUATOR'))
    return '/procurement';
  if (user.roles.includes('TENANT_ADMIN') || user.roles.includes('AUDITOR')) return '/admin/overview';
  return '/procurement';
}

/** Colour used when no entity colour is given: a dedicated installation's own colour (deployment.tsx). */
let defaultColor: string | null = null;
export function setDefaultTheme(color: string | null | undefined): void {
  defaultColor = color ?? null;
  applyTheme(null);
}

export function applyTheme(color: string | null | undefined): void {
  const v = color || defaultColor;
  const c = v && /^#?[0-9a-fA-F]{3,8}$/.test(v) ? (v.startsWith('#') ? v : `#${v}`) : null;
  const root = document.documentElement;
  if (c) root.style.setProperty('--primary', c);
  else root.style.removeProperty('--primary');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [expired, setExpired] = useState(false);
  const navigate = useNavigate();

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    applyTheme(null);
    navigate('/login');
  }, [navigate]);

  const signIn = useCallback((s: Session) => {
    saveSession(s);
    setSession(s);
    setExpired(false);
    applyTheme(s.tenant?.primaryColor);
  }, []);

  useEffect(() => {
    applyTheme(session?.tenant?.primaryColor);
  }, [session?.tenant?.primaryColor]);

  // Any 401 from the API ends the session and returns to /login.
  useEffect(() => {
    const onUnauthorized = () => {
      setSession(null);
      setExpired(true);
      navigate('/login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate]);

  // Validate a restored token once (also refreshes roles/display name).
  useEffect(() => {
    if (!session) return;
    let alive = true;
    api
      .me()
      .then((u) => {
        if (alive && u && u.id) {
          const next = { ...session, user: { ...session.user, ...u } };
          saveSession(next);
          setSession(next);
        }
      })
      .catch(() => {
        /* 401 handled globally; other errors leave the stored session as is */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const value = useMemo<SessionCtx>(
    () => ({
      session,
      user: session?.user ?? null,
      tenant: session?.tenant ?? null,
      hasRole: (...roles) => Boolean(session?.user.roles.some((r) => roles.includes(r))),
      signIn,
      signOut,
      expired,
    }),
    [session, signIn, signOut, expired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
