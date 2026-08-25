import { randomInt } from 'node:crypto';
/**
 * Generates the applicant-facing reference id shown on each onboarding
 * portal's success screen — "IV-WH-482913", "IV-DRV-009214", etc. Six random
 * digits (not sequential) so an applicant can't guess how many applications
 * came before/after theirs.
 */
export function generateReferenceId(prefix) {
    const digits = Array.from({ length: 6 }, () => randomInt(0, 10)).join('');
    return `IV-${prefix}-${digits}`;
}
/**
 * Retries `attempt` with a freshly generated reference id on a unique-
 * constraint violation — same pattern as lib/sku.ts's createWithGeneratedSku.
 * 1M possible ids per prefix makes a collision rare but not impossible.
 */
export async function createWithGeneratedReferenceId(prefix, attempt, maxAttempts = 5) {
    let lastErr;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            return await attempt(generateReferenceId(prefix));
        }
        catch (err) {
            const isUniqueViolation = typeof err === 'object' && err !== null && err.code === 'P2002';
            if (!isUniqueViolation)
                throw err;
            lastErr = err;
        }
    }
    throw lastErr;
}
//# sourceMappingURL=referenceId.js.map