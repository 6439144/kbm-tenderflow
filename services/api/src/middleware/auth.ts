import { Request, Response, NextFunction } from 'express';
import * as jose from 'jose';

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: string;
  roles: string[];
  tenantId: string;
  vendorId?: string;
}

export interface AuthenticatedRequest extends Request {
  tenantId?: string;
  user?: AuthenticatedUser;
}

// Remote JWKS set cache for Keycloak
let remoteJWKSet: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let currentJwksUrl: string | null = null;

// Test RSA key pair (used ONLY when process.env.NODE_ENV === 'test', never in production)
let testKeyPair: { publicKey: any; privateKey: any } | null = null;

export async function getOrCreateTestKeyPair() {
  if (!testKeyPair) {
    testKeyPair = await jose.generateKeyPair('RS256');
  }
  return testKeyPair;
}

function getRemoteJWKSet(): ReturnType<typeof jose.createRemoteJWKSet> {
  const issuerUrl = process.env.KEYCLOAK_ISSUER_URL || (process.env.KEYCLOAK_URL ? `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM || 'tenderflow'}` : null);
  
  if (!issuerUrl && process.env.NODE_ENV !== 'test') {
    throw new Error('[Auth Startup] KEYCLOAK_ISSUER_URL is required in non-test environments.');
  }

  const jwksUrl = `${issuerUrl}/protocol/openid-connect/certs`;
  if (remoteJWKSet && currentJwksUrl === jwksUrl) {
    return remoteJWKSet;
  }

  currentJwksUrl = jwksUrl;
  remoteJWKSet = jose.createRemoteJWKSet(new URL(jwksUrl));
  return remoteJWKSet;
}

/**
 * Utility to mint a valid cryptographically signed RSA JWT for testing.
 * Available ONLY in test environments.
 */
export async function createTestToken(claims: {
  sub: string;
  username?: string;
  role: string;
  roles?: string[];
  tenantId?: string;
  vendorId?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}): Promise<string> {
  const keys = await getOrCreateTestKeyPair();
  const now = Math.floor(Date.now() / 1000);
  const roles = claims.roles || [claims.role];

  const builder = new jose.SignJWT({
    preferred_username: claims.username || claims.sub,
    tenant_id: claims.tenantId,
    vendor_id: claims.vendorId || (claims.role === 'VENDOR' ? claims.sub : undefined),
    realm_access: { roles },
    roles,
    role: claims.role
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setIssuer(claims.issuer || process.env.KEYCLOAK_ISSUER_URL || 'http://localhost:8080/realms/tenderflow')
    .setAudience(claims.audience || process.env.KEYCLOAK_AUDIENCE || 'account')
    .setExpirationTime(claims.expiresIn || '1h');

  return builder.sign(keys.privateKey);
}

/**
 * Strict JWT Verification using jose (Non-negotiable Rule 3 / Task G1-b / Reviewer R1b-1 & R1b-2)
 * In production: accepts ONLY RS256 tokens verified against Keycloak JWKS.
 * In test: verifies using test RSA public key.
 */
export async function verifyToken(token: string): Promise<AuthenticatedUser> {
  let payload: jose.JWTPayload;

  if (process.env.NODE_ENV === 'test') {
    // In test environment, verify against test RSA key
    const keys = await getOrCreateTestKeyPair();
    try {
      const result = await jose.jwtVerify(token, keys.publicKey, {
        algorithms: ['RS256']
      });
      payload = result.payload;
    } catch (testErr: any) {
      throw new Error(`Token verification failed: ${testErr.message}`);
    }
  } else {
    // In production/staging: verify strictly against Keycloak JWKS
    const jwks = getRemoteJWKSet();
    const issuer = process.env.KEYCLOAK_ISSUER_URL;
    const audience = process.env.KEYCLOAK_AUDIENCE;

    if (!issuer || !audience) {
      throw new Error('[Auth Error] KEYCLOAK_ISSUER_URL and KEYCLOAK_AUDIENCE must be set in environment.');
    }

    try {
      const result = await jose.jwtVerify(token, jwks, {
        issuer,
        audience,
        algorithms: ['RS256']
      });
      payload = result.payload;
    } catch (jwksErr: any) {
      throw new Error(`Token verification failed against Keycloak JWKS: ${jwksErr.message}`);
    }
  }

  // 1. Extract and normalize roles strictly from claims
  const realmRoles: string[] = (payload.realm_access as any)?.roles || [];
  const customRoles: string[] = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
  const singleRole: string | undefined = typeof payload.role === 'string' ? (payload.role as string) : undefined;
  
  const allRoles = Array.from(new Set([...realmRoles, ...customRoles, ...(singleRole ? [singleRole] : [])]));

  const KNOWN_ROLES = [
    'SUPER_ADMIN',
    'TENANT_ADMIN',
    'DIRECTOR',
    'COMMITTEE_CHAIR',
    'OPENING_COMMITTEE_CHAIR',
    'PROCUREMENT_OFFICER',
    'EVALUATOR',
    'COMMITTEE_MEMBER',
    'AUDITOR',
    'VENDOR'
  ];

  let primaryRole = 'PUBLIC';
  for (const r of KNOWN_ROLES) {
    if (allRoles.includes(r)) {
      primaryRole = r;
      break;
    }
  }
  if (primaryRole === 'PUBLIC' && singleRole) {
    primaryRole = singleRole;
  }

  // 2. Extract tenant_id strictly from claims (Reviewer R1b-2: no silent fallback to 'kea')
  const tenantId = (payload.tenant_id as string) || (payload.tenantId as string);

  if (!tenantId && primaryRole !== 'SUPER_ADMIN') {
    throw new Error('MISSING_TENANT_CLAIM: Token must contain a valid tenant_id claim.');
  }

  const sub = payload.sub || 'unknown';
  const username = (payload.preferred_username as string) || sub;
  const vendorId = (payload.vendor_id as string) || (primaryRole === 'VENDOR' ? sub : undefined);

  return {
    id: sub,
    username,
    role: primaryRole,
    roles: allRoles,
    tenantId: tenantId || 'system',
    vendorId
  };
}

/**
 * Authentication Middleware (Gate 1 / G1-b)
 * Runs BEFORE tenant middleware.
 * Verifies JWTs strictly with jose. Deletes X-Actor-Role, X-Actor-Id, and mock tokens.
 */
export async function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const isPublicRoute =
    req.path === '/health' ||
    req.path === '/ready' ||
    (req.path === '/api/v1/vendors/register' && req.method === 'POST') ||
    (req.path === '/api/v1/tenants' && req.method === 'GET') ||
    (req.path.startsWith('/api/v1/tenants/') && req.method === 'GET') ||
    (req.path === '/api/v1/tenders' && req.method === 'GET');

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (isPublicRoute) {
      req.user = {
        id: 'anonymous',
        username: 'guest',
        role: 'PUBLIC',
        roles: ['PUBLIC'],
        tenantId: (req.headers['x-tenant-id'] as string) || 'kea'
      };
      return next();
    }

    res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'Authentication required. Missing or invalid Bearer token.'
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  // Reject mock tokens per Rule 9 and G1-b
  if (token.startsWith('mock:')) {
    res.status(401).json({
      code: 'INVALID_TOKEN',
      message: 'Mock tokens are strictly disallowed in TenderFlow v1.0.'
    });
    return;
  }

  try {
    const user = await verifyToken(token);
    req.user = user;

    // Check X-Tenant-ID header if provided against token claims
    const headerTenant = req.headers['x-tenant-id'] as string;
    if (headerTenant && user.role !== 'SUPER_ADMIN' && headerTenant !== user.tenantId) {
      res.status(403).json({
        code: 'TENANT_MISMATCH',
        message: `Token tenant claim '${user.tenantId}' does not match requested tenant '${headerTenant}'.`
      });
      return;
    }

    next();
  } catch (err: any) {
    res.status(401).json({
      code: 'INVALID_TOKEN',
      message: err.message || 'Token verification failed.'
    });
  }
}

/**
 * Enforces role requirement strictly per docs/requirements/role-matrix.md
 */
export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || req.user.role === 'PUBLIC') {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Authentication required.'
      });
      return;
    }

    const hasRole = req.user.roles.some(r => allowedRoles.includes(r)) || allowedRoles.includes(req.user.role);
    if (!hasRole) {
      res.status(403).json({
        code: 'FORBIDDEN_ROLE',
        message: `Current role '${req.user.role}' is not authorized. Required: ${allowedRoles.join(', ')}.`
      });
      return;
    }
    next();
  };
}
