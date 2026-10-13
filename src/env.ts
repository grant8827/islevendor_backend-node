import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

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
  WIPAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  ENABLE_WIPAY_WEBHOOKS: booleanFromEnv,
  ENABLE_WITHDRAWALS: booleanFromEnv,
  ENABLE_INTERNAL_REFUNDS: booleanFromEnv,
  ENABLE_ESCROW_RELEASE: booleanFromEnv,
  SERVE_PUBLIC_UPLOADS: booleanFromEnv,
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
if (candidate.WIPAY_ENV === 'production' && candidate.NODE_ENV !== 'production') {
  safetyErrors.push('WIPAY_ENV=production is forbidden outside NODE_ENV=production');
}
if (candidate.ENABLE_WIPAY_WEBHOOKS && (!candidate.WIPAY_ACCOUNT_NUMBER || !candidate.WIPAY_API_KEY)) {
  safetyErrors.push('enabled WiPay webhooks require WIPAY_ACCOUNT_NUMBER and WIPAY_API_KEY');
}

if (safetyErrors.length > 0) {
  console.error('❌ Unsafe environment configuration:', safetyErrors);
  throw new Error('Unsafe environment configuration — startup stopped before connecting to dependencies');
}

export const env = candidate;
