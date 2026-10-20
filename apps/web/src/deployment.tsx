// Deployment model of the installation (GET /api/v1/public/deployment, docs/DEPLOYMENT-MODEL.md).
// Dedicated (one installation = one government entity): no entity picker, the entity's own name and colour as the
// brand, no cross-entity wording. Shared (several entities): the original multi-entity screens. The server enforces
// the separation either way; this only decides what the screens show.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { http } from './api';
import { useI18n } from './i18n';
import { setDefaultTheme } from './session';

export interface DeploymentEntity {
  id: string;
  nameEn: string;
  nameAr: string;
  primaryColor: string | null;
  logoText: string | null;
}
export interface Deployment {
  mode: 'dedicated' | 'shared';
  entity: DeploymentEntity | null;
  /** Demo installations only: the entity's demo user names (sign-in hint). */
  demoUsers?: string[];
}

interface DeploymentCtx {
  /** null while loading */
  deployment: Deployment | null;
  dedicated: boolean;
  entity: DeploymentEntity | null;
  /** The entity's name in the current language ('' when none). */
  entityName: string;
}

const Ctx = createContext<DeploymentCtx | null>(null);

let cached: Promise<Deployment> | null = null;
export function loadDeployment(): Promise<Deployment> {
  if (!cached) {
    cached = http.get<Deployment>('/public/deployment').then(
      (d) => (d && (d.mode === 'dedicated' || d.mode === 'shared') ? { mode: d.mode, entity: d.entity ?? null, demoUsers: Array.isArray(d.demoUsers) ? d.demoUsers : undefined } : { mode: 'shared', entity: null }),
      () => {
        cached = null; // try again on the next screen
        return { mode: 'shared', entity: null };
      },
    );
  }
  return cached;
}

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const { pick } = useI18n();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  useEffect(() => {
    let alive = true;
    void loadDeployment().then((d) => {
      if (!alive) return;
      setDeployment(d);
      // The entity's colour from the first screen on (the session applies the same colour after sign-in).
      if (d.mode === 'dedicated' && d.entity?.primaryColor) setDefaultTheme(d.entity.primaryColor);
    });
    return () => {
      alive = false;
    };
  }, []);
  const value = useMemo<DeploymentCtx>(() => {
    const dedicated = deployment?.mode === 'dedicated';
    const entity = dedicated ? deployment?.entity ?? null : null;
    return { deployment, dedicated, entity, entityName: entity ? pick(entity.nameEn, entity.nameAr) : '' };
  }, [deployment, pick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeployment(): DeploymentCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('DeploymentProvider missing');
  return c;
}
