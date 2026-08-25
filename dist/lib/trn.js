import { z } from 'zod';
// Jamaican TRN: 9 digits, either grouped (123-456-789) or bare (123456789).
// Per ISLE-105's spec: ^\d{3}-\d{3}-\d{3}$ or ^\d{9}$.
export const TRN_REGEX = /^(\d{3}-\d{3}-\d{3}|\d{9})$/;
export const trnSchema = z
    .string()
    .trim()
    .regex(TRN_REGEX, 'TRN must be 9 digits, as 123456789 or 123-456-789');
/** Strips formatting so every stored TRN is a bare 9-digit string. */
export function normalizeTrn(trn) {
    return trn.replace(/-/g, '');
}
//# sourceMappingURL=trn.js.map