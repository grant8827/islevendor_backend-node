import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

// An empty variable means "not set" — so a blank entry in a hosting
// dashboard behaves the same as a missing one.
const optionalString = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  DATABASE_ENVIRONMENT: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  ALLOW_REMOTE_DATABASE: booleanFromEnv,
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  WIPAY_ACCOUNT_NUMBER: z.string().optional(),
  WIPAY_API_KEY: z.string().optional(),
  // WiPay calls its live environment "live"; "production" is accepted too.
  WIPAY_ENV: z
    .enum(['sandbox', 'live', 'production'])
    .default('sandbox')
    .transform((value) => (value === 'production' ? 'live' : value)),
  ENABLE_WIPAY_WEBHOOKS: booleanFromEnv,
  ENABLE_WITHDRAWALS: booleanFromEnv,
  ENABLE_INTERNAL_REFUNDS: booleanFromEnv,
  ENABLE_ESCROW_RELEASE: booleanFromEnv,
  SERVE_PUBLIC_UPLOADS: booleanFromEnv,
  // Encrypts bank account and ID numbers at rest (lib/crypto.ts): 32 random
  // bytes, base64. Without it, payout details can't be saved.
  PAYOUT_DATA_KEY: optionalString(
    z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'PAYOUT_DATA_KEY must be 32 bytes, base64-encoded'),
  ),
  // Automated payouts through WiPay's withdrawal API (lib/wipayPayouts.ts).
  // Off by default; manual payouts work either way.
  ENABLE_AUTOMATED_PAYOUTS: booleanFromEnv,
  // e.g. https://jmsb.wipayfinancial.com/wapi (sandbox) or https://jm.wipayfinancial.com/wapi (live)
  WIPAY_PAYOUT_API_URL: optionalString(z.string().url()),
  WIPAY_PAYOUT_API_KEY: optionalString(z.string()),
  WIPAY_PAYOUT_WEBHOOK_SECRET: optionalString(z.string()),
  // Must be set to true, deliberately, before automated payouts may use
  // WiPay's live API — only once WiPay has confirmed IsleVendor's account is
  // authorised for sub_banked withdrawals.
  WIPAY_PAYOUTS_LIVE_AUTHORIZED: booleanFromEnv,
  AI_SERVICE_URL: z.string().default('http://localhost:8001'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration — check backend-node/.env against .env.example');
}

const candidate = parsed.data;
const databaseUrl = new URL(candidate.DATABASE_URL);
const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1']);
const isRemoteDatabase = !localDatabaseHosts.has(databaseUrl.hostname);
const safetyErrors: string[] = [];

if (candidate.NODE_ENV !== 'production' && candidate.DATABASE_ENVIRONMENT === 'production') {
  safetyErrors.push('non-production processes may not use a production database');
}
if (candidate.NODE_ENV === 'production' && candidate.DATABASE_ENVIRONMENT !== 'production') {
  safetyErrors.push('production processes must declare DATABASE_ENVIRONMENT=production');
}
if (candidate.NODE_ENV !== 'production' && isRemoteDatabase && !candidate.ALLOW_REMOTE_DATABASE) {
  safetyErrors.push('remote databases are blocked outside production; use local Postgres or explicitly allow isolated staging');
}
if (candidate.WIPAY_ENV === 'live' && candidate.NODE_ENV !== 'production') {
  safetyErrors.push('WIPAY_ENV=live is forbidden outside NODE_ENV=production');
}
if (candidate.ENABLE_AUTOMATED_PAYOUTS) {
  if (!candidate.WIPAY_PAYOUT_API_URL || !candidate.WIPAY_PAYOUT_API_KEY || !candidate.WIPAY_PAYOUT_WEBHOOK_SECRET || !candidate.PAYOUT_DATA_KEY) {
    safetyErrors.push('automated payouts require WIPAY_PAYOUT_API_URL, WIPAY_PAYOUT_API_KEY, WIPAY_PAYOUT_WEBHOOK_SECRET and PAYOUT_DATA_KEY');
  }
  const liveHost = candidate.WIPAY_PAYOUT_API_URL && !new URL(candidate.WIPAY_PAYOUT_API_URL).hostname.includes('sb.');
  if (liveHost && !candidate.WIPAY_PAYOUTS_LIVE_AUTHORIZED) {
    safetyErrors.push("automated payouts against WiPay's live API need WIPAY_PAYOUTS_LIVE_AUTHORIZED=true, set only after WiPay confirms the account is authorised");
  }
  if (liveHost && candidate.NODE_ENV !== 'production') {
    safetyErrors.push("WiPay's live payout API is forbidden outside NODE_ENV=production");
  }
}
if (candidate.ENABLE_WIPAY_WEBHOOKS && (!candidate.WIPAY_ACCOUNT_NUMBER || !candidate.WIPAY_API_KEY)) {
  safetyErrors.push('enabled WiPay webhooks require WIPAY_ACCOUNT_NUMBER and WIPAY_API_KEY');
}

if (safetyErrors.length > 0) {
  console.error('❌ Unsafe environment configuration:', safetyErrors);
  throw new Error('Unsafe environment configuration — startup stopped before connecting to dependencies');
}

export const env = candidate;
