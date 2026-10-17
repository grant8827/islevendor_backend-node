// Loaded with `node --import` before anything else (see package.json's
// "test" script), so these are in place before src/env.ts runs dotenv —
// dotenv never overrides a variable that's already set, which is what keeps
// a developer's .env (and whatever database it points at) out of test runs.
import os from 'node:os';

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? `postgresql://${os.userInfo().username}@localhost:5432/islevendor_test?schema=public`;

// Tests create and delete rows freely. Refuse to start against anything that
// isn't unmistakably a local, throwaway database.
const { hostname, pathname } = new URL(databaseUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(hostname) || !pathname.endsWith('_test')) {
  throw new Error(`Refusing to run tests against ${hostname}${pathname} — the test database must be local and named *_test`);
}

// Each test file is its own process with its own Prisma pool. They run one
// at a time (package.json's --test-concurrency=1, because some change shared
// platform settings), but cap the pool anyway so a parallel run can't exceed
// Postgres's max_connections.
const pooledUrl = new URL(databaseUrl);
if (!pooledUrl.searchParams.has('connection_limit')) pooledUrl.searchParams.set('connection_limit', '8');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: pooledUrl.toString(),
  DATABASE_ENVIRONMENT: 'test',
  ALLOW_REMOTE_DATABASE: 'false',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
  JWT_SECRET: 'test-only-secret',
  JWT_EXPIRES_IN: '1h',
  CORS_ORIGIN: 'http://localhost:5173, https://islevendor.test/',
  WIPAY_ENV: 'sandbox',
  WIPAY_ACCOUNT_NUMBER: '',
  WIPAY_API_KEY: '',
  ENABLE_WIPAY_WEBHOOKS: 'false',
  // Nothing listens here: a test that starts a payment without its own fake
  // WiPay gets a quick connection failure, never a call to WiPay's real sandbox.
  WIPAY_PAYMENT_URL: 'http://127.0.0.1:9/plugins/payments/request',
  WIPAY_RESPONSE_URL: 'http://localhost/api/webhooks/wipay',
  WIPAY_WEBHOOK_SECRET: '',
  PUBLIC_WEB_URL: 'http://localhost:5173',
  ENABLE_WITHDRAWALS: 'false',
  ENABLE_INTERNAL_REFUNDS: 'false',
  ENABLE_ESCROW_RELEASE: 'false',
  SERVE_PUBLIC_UPLOADS: 'false',
  // A fixed test-only key, so encrypted payout details round-trip in tests.
  PAYOUT_DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
  ENABLE_AUTOMATED_PAYOUTS: 'false',
  WIPAY_PAYOUT_API_URL: '',
  WIPAY_PAYOUT_API_KEY: '',
  WIPAY_PAYOUT_WEBHOOK_SECRET: '',
  WIPAY_PAYOUTS_LIVE_AUTHORIZED: 'false',
  // The AI service (backend-fastapi). Nothing listens here unless a test
  // starts its own fake on this port (see delivery.proof.test.ts), so no
  // test ever reaches a real OCR service running on the developer's machine.
  AI_SERVICE_URL: 'http://127.0.0.1:18001',
  PAYMENTS_PROVIDER: 'node',
  ISLEVENDOR_PAY_INTERNAL_URL: '',
  ISLEVENDOR_PAY_SERVICE_TOKEN: '',
});
