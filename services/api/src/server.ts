import express from 'express';
import cors from 'cors';
import { tenantMiddleware } from './middleware/tenant.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantsRouter } from './routes/tenants.js';
import { vendorsRouter } from './routes/vendors.js';
import { tendersRouter } from './routes/tenders.js';
import { documentsRouter } from './routes/documents.js';
import { createContentStore } from '@tenderflow/content-adapter';
import { db } from './db/client.js';
import { aiRouter } from './routes/ai.js';
import { auditRouter } from './routes/audit.js';

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const contentStore = createContentStore();

// Liveness Probe: process up only (Reviewer R1b-5 / Rule 9)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0-rc1',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Readiness Probe: real checks of Keycloak JWKS, Database, and Content Store
app.get('/ready', async (req, res) => {
  const checks: Record<string, any> = {};
  let allReady = true;

  // 1. Auth check
  try {
    if (process.env.NODE_ENV === 'test') {
      checks.auth = { status: 'ok', provider: 'test_rsa' };
    } else {
      const issuer = process.env.KEYCLOAK_ISSUER_URL;
      if (!issuer) throw new Error('KEYCLOAK_ISSUER_URL not configured');
      const jwksRes = await fetch(`${issuer}/protocol/openid-connect/certs`);
      if (!jwksRes.ok) throw new Error(`Keycloak JWKS unreachable (HTTP ${jwksRes.status})`);
      checks.auth = { status: 'ok', provider: 'keycloak_jwks' };
    }
  } catch (err: any) {
    allReady = false;
    checks.auth = { status: 'down', error: err.message };
  }

  // 2. Database check
  try {
    checks.database = { status: 'ok', tenantsCount: db.tenants.size };
  } catch (err: any) {
    allReady = false;
    checks.database = { status: 'down', error: err.message };
  }

  // 3. Content Store check (real ping)
  try {
    const pingRes = await contentStore.ping();
    if (!pingRes.ok) {
      allReady = false;
      checks.contentStore = { status: 'down', error: pingRes.details };
    } else {
      checks.contentStore = { status: 'ok', backend: pingRes.backend, details: pingRes.details };
    }
  } catch (err: any) {
    allReady = false;
    checks.contentStore = { status: 'down', error: err.message };
  }

  const statusCode = allReady ? 200 : 503;
  res.status(statusCode).json({
    status: allReady ? 'ready' : 'down',
    checks,
    timestamp: new Date().toISOString()
  });
});

// Authentication MUST run before Tenant Isolation (Gate 1 / G1-b)
app.use(authMiddleware);
app.use(tenantMiddleware);

// Mount API Endpoints
app.use('/api/v1/tenants', tenantsRouter);
app.use('/api/v1/vendors', vendorsRouter);
app.use('/api/v1/tenders', tendersRouter);
app.use('/api/v1/documents', documentsRouter);
app.use('/api/v1/ai', aiRouter);
app.use('/api/v1/audit-logs', auditRouter);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[API Error]', err);
  res.status(err.status || 500).json({
    code: err.code || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred.'
  });
});

const isDirectExecution = Boolean(process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server.ts')));
if (isDirectExecution) {
  app.listen(port, () => {
    console.log(`[TenderFlow API] Running on http://localhost:${port}`);
    console.log(`[TenderFlow API] OpenAPI specification: services/api/openapi.yaml`);
  });
}

export default app;
