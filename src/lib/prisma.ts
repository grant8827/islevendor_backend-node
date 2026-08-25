import { PrismaClient } from '@prisma/client';
import { env } from '../env.js';

// Single shared Prisma client. In dev with tsx watch, stash it on globalThis
// so a hot-reload doesn't open a fresh pool of Postgres connections every save.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
