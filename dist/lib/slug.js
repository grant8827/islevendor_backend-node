import { prisma } from './prisma.js';
export function slugify(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'store';
}
// Slugs are public URL paths (/store/:slug, /shop/:slug) shared across two
// separate tables (reseller_stores, shops) — unique within each table, but
// nothing stops the same slug existing in both unless checked across both,
// same reasoning as commerce.routes.ts / shop.routes.ts's assertSlugAvailable.
async function isSlugTaken(slug) {
    const [store, shop] = await Promise.all([
        prisma.resellerStore.findUnique({ where: { slug }, select: { id: true } }),
        prisma.shop.findUnique({ where: { slug }, select: { id: true } }),
    ]);
    return Boolean(store || shop);
}
/**
 * Turns a chosen brand/store name into a unique slug — "Irie Finds" becomes
 * "irie-finds", or "irie-finds-2" etc. if that's already taken. Used by the
 * onboarding endpoints so applicants never have to think up a URL slug
 * themselves (contrast with the dashboard quick-setup forms, which still
 * ask the already-authenticated user to type + confirm one).
 */
export async function generateUniqueSlug(name) {
    const base = slugify(name);
    let candidate = base;
    let suffix = 2;
    while (await isSlugTaken(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}
//# sourceMappingURL=slug.js.map