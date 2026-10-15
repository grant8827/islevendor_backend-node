import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { corsOrigins, env } from './env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { setSocketServer } from './lib/socket.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { warehouseRouter } from './modules/warehouse/warehouse.routes.js';
import { commerceRouter } from './modules/commerce/commerce.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { ledgerRouter } from './modules/ledger/ledger.routes.js';
import { dispatchRouter } from './modules/dispatch/dispatch.routes.js';
import { registerDispatchGateway } from './modules/dispatch/dispatch.gateway.js';
import { authorizationRouter } from './modules/authorization/authorization.routes.js';
import { deliveryRouter } from './modules/delivery/delivery.routes.js';
import { uploadsRouter, UPLOADS_DIR } from './modules/uploads/uploads.routes.js';
import { shopRouter } from './modules/shop/shop.routes.js';
import { ratingsRouter } from './modules/ratings/ratings.routes.js';
import { onboardingRouter } from './modules/onboarding/onboarding.routes.js';
import { driversRouter } from './modules/drivers/drivers.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { paymentsRouter, wipayWebhookRouter } from './modules/payments/payments.routes.js';
import { internalPayRouter } from './modules/payments/internal.routes.js';

const app = express();

// Railway terminates TLS at its edge and forwards over plain HTTP — without
// this, req.protocol (used by uploads.routes.ts to build absolute image URLs)
// would always read "http", producing mixed-content URLs on the https site.
app.set('trust proxy', true);

app.use(helmet());
app.use(cors({ origin: corsOrigins, credentials: true }));
// The raw bytes are kept alongside the parsed body: a webhook signature is
// computed over exactly what was sent (see ledger.service.ts's
// processWiPayPayoutWebhook), not over a re-serialised object.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'backend-node' }));

// Legacy local product media. Disabled by default because this directory
// historically also received KYC files; never enable it until those objects
// have been classified and migrated out.
if (env.SERVE_PUBLIC_UPLOADS) {
  app.use(
    '/uploads',
    express.static(UPLOADS_DIR, {
      setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
    }),
  );
}

app.use('/api/auth', authRouter);
app.use('/api/warehouse', warehouseRouter);
app.use('/api/commerce', commerceRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/ledger', ledgerRouter);
app.use('/api/dispatch', dispatchRouter);
app.use('/api/authorizations', authorizationRouter);
app.use('/api/delivery-applications', deliveryRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/shop', shopRouter);
app.use('/api/ratings', ratingsRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/admin', adminRouter);
app.use('/api/payments', paymentsRouter);
app.use('/internal/pay', internalPayRouter);
// WIPAY_RESPONSE_URL points here (see modules/payments).
app.use('/api/webhooks/wipay', wipayWebhookRouter);
// Versioned per ISLE-105's spec (the rest of the API is unversioned) — the
// four public onboarding portals + admin review queue.
app.use('/api/v1/onboarding', onboardingRouter);

app.use(errorHandler);

/**
 * Builds the HTTP + Socket.IO server without binding a port, so index.ts can
 * listen on env.PORT and the integration tests can listen on an ephemeral one.
 */
export function createServer() {
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { cors: { origin: corsOrigins, credentials: true } });
  setSocketServer(io);
  registerDispatchGateway(io);
  return { app, httpServer, io };
}
