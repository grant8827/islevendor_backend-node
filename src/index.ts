import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { env } from './env.js';
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

const app = express();

// Railway terminates TLS at its edge and forwards over plain HTTP — without
// this, req.protocol (used by uploads.routes.ts to build absolute image URLs)
// would always read "http", producing mixed-content URLs on the https site.
app.set('trust proxy', true);

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'backend-node' }));

// Uploaded images — same-origin in normal use (frontend proxies /uploads to
// here), but relax helmet's default CORP so an <img> tag can also load these
// directly cross-origin if something ever points at the API host instead.
app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  }),
);

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
// Versioned per ISLE-105's spec (the rest of the API is unversioned) — the
// four public onboarding portals + admin review queue.
app.use('/api/v1/onboarding', onboardingRouter);

app.use(errorHandler);

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGIN, credentials: true } });
setSocketServer(io);
registerDispatchGateway(io);

httpServer.listen(env.PORT, () => {
  console.log(`IsleVendor API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
