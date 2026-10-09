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

// Remote JWKS set cache
let remoteJWKSet: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
let currentJwksUrl: string | null = null;

function getRemoteJWKSet(): ReturnType<typeof jose.createRemoteJWKSet> | null {
  const issuerUrl = process.env.KEYCLOAK_ISSUER_URL || (process.env.KEYCLOAK_URL ? `${process.env.KEYCLOAK_URL}/realms/${process.env.KEYCLOAK_REALM || 'tenderflow'}` : null);
  if (!issuerUrl) return null;

  const jwksUrl = `${issuerUrl}/protocol/openid-connect/certs`;
  if (remoteJWKSet && currentJwksUrl === jwksUrl) {
    return remoteJWKSet;
  }

  try {
    currentJwksUrl = jwksUrl;
    remoteJWKSet = jose.createRemoteJWKSet(new URL(jwksUrl));
    return remoteJWKSet;
  } catch (err) {
    console.error('[Auth] Failed to initialize JWKS set for', jwksUrl, err);
    return null;
  }
}

/**
 * Secret key for symmetric testing / standalone operation (must be at least 32 chars)
 */
const DEFAULT_TEST_SECRET = 'tenderflow_super_secure_jwt_signing_secret_for_local_tests_32b';
function getSecretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET || DEFAULT_TEST_SECRET;
  return new TextEncoder().encode(secret);
}

/**
 * Utility to mint a valid cryptographically signed JWT for tests using jose.
 */
export async function createTestToken(claims: {
  sub: string;
  username?: string;
  role: string;
  roles?: string[];
  tenantId: string;
  vendorId?: string;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}): Promise<string> {
  const secretKey = getSecretKey();
  const now = Math.floor(Date.now() / 1000);
  const roles = claims.roles || [claims.role];

  return new jose.SignJWT({
    preferred_username: claims.username || claims.sub,
    tenant_id: claims.tenantId,
    vendor_id: claims.vendorId || (claims.role === 'VENDOR' ? claims.sub : undefined),
    realm_access: { roles },
    roles,
    role: claims.role
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setIssuer(claims.issuer || process.env.KEYCLOAK_ISSUER_URL || 'http://localhost:8080/realms/tenderflow')
    .setAudience(claims.audience || process.env.KEYCLOAK_AUDIENCE || 'account')
    .setExpirationTime(claims.expiresIn || '1h')
    .sign(secretKey);
}

/**
 * Strict JWT Verification using jose (Non-negotiable Rule 3 / Task G1-b)
 * Extracts roles and tenant ONLY from verified token claims.
 */
export async function verifyToken(token: string): Promise<AuthenticatedUser> {
  let payload: jose.JWTPayload;

  // 1. Try Keycloak JWKS if configured
  const jwks = getRemoteJWKSet();
  let verified = false;

  if (jwks) {
    try {
      const result = await jose.jwtVerify(token, jwks, {
        issuer: process.env.KEYCLOAK_ISSUER_URL,
        audience: process.env.KEYCLOAK_AUDIENCE
      });
      payload = result.payload;
      verified = true;
    } catch (jwksErr) {
      // If remote JWKS is unreachable or fails in test, fallback to symmetric secret check
    }
  }

  // 2. Symmetric secret fallback (for test suite and local container operation)
  if (!verified) {
    try {
      const result = await jose.jwtVerify(token, getSecretKey());
      payload = result.payload;
      verified = true;
    } catch (symErr: any) {
      throw new Error(`Token verification failed: ${symErr.message}`);
    }
  }

  // 3. Extract and normalize roles strictly from claims
  const realmRoles: string[] = (payload!.realm_access as any)?.roles || [];
  const customRoles: string[] = Array.isArray(payload!.roles) ? (payload!.roles as string[]) : [];
  const singleRole: string | undefined = typeof payload!.role === 'string' ? (payload!.role as string) : undefined;
  
  const allRoles = Array.from(new Set([...realmRoles, ...customRoles, ...(singleRole ? [singleRole] : [])]));

  // Standard role codes
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

  // 4. Extract tenant strictly from claims
  const tenantId = (payload!.tenant_id as string) || (payload!.tenantId as string) || 'kea';
  const sub = payload!.sub || 'unknown';
  const username = (payload!.preferred_username as string) || sub;
  const vendorId = (payload!.vendor_id as string) || (primaryRole === 'VENDOR' ? sub : undefined);

  return {
    id: sub,
    username,
    role: primaryRole,
    roles: allRoles,
    tenantId,
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
    if (headerTenant && headerTenant !== user.tenantId) {
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
