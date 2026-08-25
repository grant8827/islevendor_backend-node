import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
export const ratingsRouter = Router();
// Is the current customer eligible to rate a given listing (affiliate or
// store — same id space as /commerce/listings/:id), and have they already
// rated it? Only a DELIVERED order for this exact item earns the right —
// ratings can't be left without a completed purchase. Powers whether the
// product detail page shows a "rate this" widget at all.
ratingsRouter.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const listingId = typeof req.query.listingId === 'string' ? req.query.listingId : '';
        if (!listingId)
            throw new HttpError(400, 'listingId is required');
        const order = await prisma.order.findFirst({
            where: {
                customerId: req.user.sub,
                status: 'DELIVERED',
                OR: [{ storeListingId: listingId }, { shopProductId: listingId }],
            },
            orderBy: { createdAt: 'desc' },
            include: { rating: true },
        });
        res.json({
            eligible: !!order,
            orderId: order?.id ?? null,
            myRating: order?.rating?.rating ?? null,
        });
    }
    catch (err) {
        next(err);
    }
});
const rateSchema = z.object({
    orderId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
});
// One rating per delivered order — buying the same item twice (two orders)
// earns two ratings; re-submitting for the same order updates it in place
// rather than erroring, so a buyer can change their mind.
ratingsRouter.post('/', requireAuth, async (req, res, next) => {
    try {
        const input = rateSchema.parse(req.body);
        const order = await prisma.order.findUnique({ where: { id: input.orderId } });
        if (!order)
            throw new HttpError(404, 'Order not found');
        if (order.customerId !== req.user.sub)
            throw new HttpError(403, 'This is not your order');
        if (order.status !== 'DELIVERED')
            throw new HttpError(409, 'You can only rate an item after it has been delivered');
        if (!order.storeListingId && !order.shopProductId) {
            throw new HttpError(409, 'This order has no rateable item');
        }
        const saved = await prisma.productRating.upsert({
            where: { orderId: order.id },
            create: {
                customerId: req.user.sub,
                orderId: order.id,
                storeListingId: order.storeListingId,
                shopProductId: order.shopProductId,
                rating: input.rating,
            },
            update: { rating: input.rating },
        });
        res.status(201).json(saved);
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=ratings.routes.js.map