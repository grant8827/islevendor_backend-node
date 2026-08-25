import { randomBytes } from 'node:crypto';

/**
 * Auto-generates a human-scannable SKU (e.g. "BEVE-4F9A2C1B") so sellers
 * never have to type one — the letters just help someone recognize it in a
 * list, the suffix is what actually guarantees uniqueness.
 */
export function generateSku(hint: string): string {
  const clean = (hint.match(/[A-Za-z0-9]/g) || []).join('').slice(0, 4).toUpperCase() || 'SKU';
  const suffix = randomBytes(4).toString('hex').toUpperCase();
  return `${clean}-${suffix}`;
}

/**
 * Prisma's `sku` columns are UNIQUE — collisions are astronomically unlikely
 * (4 random bytes = 4 billion combinations per hint prefix) but a retry loop
 * costs nothing and turns "astronomically unlikely" into "impossible in
 * practice" rather than a rare 500 for whoever hits it.
 */
export async function createWithGeneratedSku<T>(
  hint: string,
  attempt: (sku: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt(generateSku(hint));
    } catch (err) {
      const isUniqueViolation = typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
      if (!isUniqueViolation) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
