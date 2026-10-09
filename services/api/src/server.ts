import express from 'express';
import cors from 'cors';
import { tenantMiddleware } from './middleware/tenant.js';
import { authMiddleware } from './middleware/auth.js';
import { tenantsRouter } from './routes/tenants.js';
import { vendorsRouter } from './routes/vendors.js';
import { tendersRouter } from './routes/tenders.js';
import { documentsRouter } from './routes/documents.js';
import { aiRouter } from './routes/ai.js';
import { auditRouter } from './routes/audit.js';

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Liveness & Readiness Probe
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.9.0',
    timestamp: new Date().toISOString(),
    services: {
      api: 'healthy',
      database: 'connected',
      contentAdapter: 'ready'
    }
  });
});

// Tenant Isolation & Authentication Middlewares
app.use(tenantMiddleware);
app.use(authMiddleware);

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
