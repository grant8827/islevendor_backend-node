import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('1d'),
  WIPAY_ACCOUNT_NUMBER: z.string().optional(),
  WIPAY_API_KEY: z.string().optional(),
  WIPAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  AI_SERVICE_URL: z.string().default('http://localhost:8000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration — check backend-node/.env against .env.example');
}

export const env = parsed.data;
