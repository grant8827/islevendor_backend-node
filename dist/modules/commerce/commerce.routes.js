import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
export const commerceRouter = Router();
const createStoreSchema = z.object({
    storeName: z.string().min(1),
    slug: z
        .string()
        .min(3)
        .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens'),
});
commerceRouter.post('/stores', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
    try {
        const input = createStoreSchema.parse(req.body);
        const existing = await prisma.resellerStore.findUnique({ where: { slug: input.slug } });
        if (existing)
            throw new HttpError(409, 'That store slug is already taken');
        const store = await prisma.resellerStore.create({
            data: { userId: req.user.sub, storeName: input.storeName, slug: input.slug },
        });
        res.status(201).json(store);
    }
    catch (err) {
        next(err);
    }
});
commerceRouter.get('/stores/:slug', async (req, res, next) => {
    try {
        const store = await prisma.resellerStore.findUnique({
            where: { slug: req.params.slug },
            include: {
                listings: {
                    where: { isActive: true },
                    include: { masterProduct: true },
                },
            },
        });
        if (!store)
            throw new HttpError(404, 'Store not found');
        res.json(store);
    }
    catch (err) {
        next(err);
    }
});
const createListingSchema = z.object({
    masterProductId: z.string().uuid(),
    retailPriceJmd: z.number().positive(),
});
// Reseller lists a master-warehouse SKU on their own storefront at their own
// retail price. Margin is `retailPriceJmd - wholesalePriceJmd`, enforced here
// and by the DB CHECK constraint (see prisma/migrations trigger).
commerceRouter.post('/stores/:storeId/listings', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
    try {
        const input = createListingSchema.parse(req.body);
        const store = await prisma.resellerStore.findUnique({ where: { id: String(req.params.storeId) } });
        if (!store)
            throw new HttpError(404, 'Store not found');
        if (store.userId !== req.user.sub && req.user.role !== UserRole.ADMIN) {
            throw new HttpError(403, 'You do not own this store');
        }
        const product = await prisma.masterProduct.findUnique({ where: { id: input.masterProductId } });
        if (!product)
            throw new HttpError(404, 'Master product not found');
        if (input.retailPriceJmd <= Number(product.wholesalePriceJmd)) {
            throw new HttpError(400, 'Retail price must exceed the wholesale price');
        }
        const listing = await prisma.storeListing.create({
            data: {
                storeId: store.id,
                masterProductId: product.id,
                retailPriceJmd: input.retailPriceJmd,
            },
        });
        res.status(201).json(listing);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=commerce.routes.js.map