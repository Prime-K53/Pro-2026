import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ServerDatabase } from './db.ts';
import { logger, newCorrelationId } from './logger.ts';
import { rateLimit } from './rateLimiter.ts';
import { createAuthRouter } from './routes/authRoutes.ts';
import { createCompanyRouter } from './routes/companyRoutes.ts';
import { createUserRouter } from './routes/userRoutes.ts';
import { createAccountingRouter } from './routes/accountingRoutes.ts';
import { createFixedAssetRouter } from './routes/fixedAssetRoutes.ts';
import { createComplianceRouter } from './routes/complianceRoutes.ts';
import { createTaxRouter } from './routes/taxRoutes.ts';
import { createQuoteRouter } from './routes/quoteRoutes.ts';
import { createOcrRouter } from './routes/ocrRoutes.ts';
import { createSalesRouter } from './routes/salesRoutes.ts';
import { createPurchasingRouter } from './routes/purchasingRoutes.ts';
import { createBankingRouter } from './routes/bankingRoutes.ts';
import { createExpenseRouter } from './routes/expenseRoutes.ts';
import { createBankingControlsRouter } from './routes/bankingControlsRoutes.ts';
import { createTaxComplianceControlsRouter } from './routes/taxComplianceControlsRoutes.ts';
import { createReportingControlsRouter } from './routes/reportingControlsRoutes.ts';
import { createDocumentControlRouter } from './routes/documentControlRoutes.ts';
import { createAccountingControlsRouter } from './routes/accountingControlsRoutes.ts';
import { createFinancialManagementRouter } from './routes/financialManagementRoutes.ts';
import { createApprovalRouter } from './routes/approvalRoutes.ts';
import { createReportsRouter } from './routes/reportsRoutes.ts';
import { createBackupRouter } from './routes/backupRoutes.ts';
import { createReportSchedulingRouter } from './routes/reportSchedulingRoutes.ts';
import { createPrintingRouter } from './routes/printingRoutes.ts';
import { createProductionOpsRouter } from './routes/productionOpsRoutes.ts';
import { createWalletRouter } from './routes/walletRoutes.ts';
import { createMigrationRouter } from './routes/migrationRoutes.ts';
import { createDocumentsRouter } from './routes/documentsRoutes.ts';
import { createProtectedBusinessRouter } from './routes/protectedRoutes.ts';
import { createSmartOpsRouter } from './routes/smartOpsRoutes.ts';
import { createAiRoutes } from './routes/aiRoutes.ts';
import { createPayrollRoutes } from './routes/payrollRoutes.ts';
import { createDocumentQrRoutes } from './routes/documentQrRoutes.ts';
import { createCustomerRoutes } from './routes/customerRoutes.ts';
import { createTwoFactorRoutes } from './routes/twoFactorRoutes.ts';
import { createDeliveryRoutes } from './routes/deliveryRoutes.ts';
import { createLeaveRoutes } from './routes/leaveRoutes.ts';
import { createCommunicationsRoutes } from './routes/communicationsRoutes.ts';
import { createBiRoutes } from './routes/biRoutes.ts';
import { createAdminRoutes } from './routes/adminRoutes.ts';
import { csrfProtection, generateCsrfToken } from './middleware/csrf.ts';
import { createAuthMiddleware } from './middleware/auth.ts';
import { validateTwilioSignature, twilioRequestUrl } from './services/twilioSignature.ts';

export function createApiExpressApp(db: ServerDatabase): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const isProduction = process.env.NODE_ENV === 'production';

  // Security headers (HSTS, nosniff, etc.). Frameguard/COOP/CORP are disabled
  // so the app can run embedded inside the AI Studio preview iframe. CSP is
  // enabled in production (bundled assets) and disabled in dev for Vite.
  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      frameguard: false,
    })
  );

  // CORS: allow all in dev; in production allow APP_URL + CORS_ALLOWED_ORIGINS.
  const allowedOrigins = [
    process.env.APP_URL,
    ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  ].filter(Boolean) as string[];
  app.use(
    cors({
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || !isProduction) return cb(null, true);
        cb(null, allowedOrigins.includes(origin));
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: false, type: 'application/x-www-form-urlencoded' }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cid = (req.headers['x-request-id'] as string) || newCorrelationId();
    (req as any).correlationId = cid;
    res.setHeader('x-request-id', cid);
    const start = Date.now();
    res.on('finish', () => {
      logger.info('http_request', { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - start }, cid);
    });
    next();
  });

  // Public routes (no auth required) — registered first

  // NOTE: document QR verification lives in documentQrRoutes (/api/qr-verify/:token).

  app.post('/api/twilio-webhook', (req: Request, res: Response) => {
    const ok = validateTwilioSignature({
      url: twilioRequestUrl(req),
      form: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>,
      signature: (req.get('x-twilio-signature') as string) || null,
      authToken: db.config.twilioAuthToken,
      isProduction: db.config.isProduction,
    });
    if (!ok) {
      return res.status(403).json({ error: 'Invalid Twilio signature' });
    }
    return res.status(200).json({ received: true });
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await db.withSystemDb(async (tx: any) => {
        await tx.query('SELECT 1');
      });
      res.json({ status: 'ok', service: 'printing-management-system', database: 'ok' });
    } catch (err: any) {
      logger.error('health_db_failure', { error: err?.message || String(err) });
      res.status(503).json({ status: 'degraded', service: 'printing-management-system', database: 'error', error: err?.message });
    }
  });

  app.get('/api/auth/public-config', (_req: Request, res: Response) => {
    res.json({
      supabaseUrl: db.config.supabaseUrl || null,
      supabasePublishableKey: db.config.supabasePublishableKey || null,
    });
  });

  // CSRF token endpoint — authenticated, bound to the caller's server session.
  const { requireAuth: requireAuthForCsrf } = createAuthMiddleware(db);
  app.get('/api/auth/csrf-token', requireAuthForCsrf, (req: Request, res: Response) => {
    const sessionId = String(req.auth?.sessionId ?? 'anon');
    const token = generateCsrfToken(sessionId);
    res.setHeader('X-CSRF-Token', token);
    return res.json({ csrfToken: token });
  });

  if (db.config.isProduction) {
    app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), createAuthRouter(db));
    app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 600 }));
  } else {
    app.use('/api/auth', createAuthRouter(db));
  }
  app.use('/api', createCommunicationsRoutes(db));
  app.use('/api', createDocumentQrRoutes(db));
  app.use('/api', createUserRouter(db));
  app.use('/api', createDocumentsRouter(db));
  app.use('/api', createProtectedBusinessRouter(db));
  app.use('/api', createSmartOpsRouter(db));
  app.use('/api', createAiRoutes(db));
  app.use('/api', createPayrollRoutes(db));
  app.use('/api', createCustomerRoutes(db));
  app.use('/api', createTwoFactorRoutes(db));
  app.use('/api', createDeliveryRoutes(db));
  app.use('/api', createLeaveRoutes(db));
  app.use('/api', createBiRoutes(db));
  app.use('/api', createAdminRoutes(db));
  app.use('/api/companies', createCompanyRouter(db));
  app.use('/api', createAccountingRouter(db));
  app.use('/api', createFixedAssetRouter(db));
  app.use('/api', createTaxRouter(db));
  app.use('/api', createComplianceRouter(db));
  app.use('/api', createQuoteRouter(db));
  app.use('/api', createOcrRouter(db));
  app.use('/api', createSalesRouter(db));
  app.use('/api', createPurchasingRouter(db));
  app.use('/api', createBankingRouter(db));
  app.use('/api', createExpenseRouter(db));
  app.use('/api', createBankingControlsRouter(db));
  app.use('/api', createTaxComplianceControlsRouter(db));
  app.use('/api', createReportingControlsRouter(db));
  app.use('/api', createDocumentControlRouter(db));
  app.use('/api', createAccountingControlsRouter(db));
  app.use('/api', createFinancialManagementRouter(db));
  app.use('/api', createApprovalRouter(db));
  app.use('/api', createReportsRouter(db));
  app.use('/api', createBackupRouter(db));
  app.use('/api', createReportSchedulingRouter(db));
  app.use('/api', createPrintingRouter(db));
  app.use('/api', createProductionOpsRouter(db));
  app.use('/api', createWalletRouter(db));
  app.use('/api', createMigrationRouter(db));

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API route not found' });
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const cid = (req as any).correlationId;
    logger.error('unhandled_error', { path: req.path, method: req.method, error: err?.message || String(err) }, cid);
    res.status(500).json({ error: 'Internal server error', requestId: cid });
  });

  return app;
}