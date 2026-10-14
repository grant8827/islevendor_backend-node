import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const ratingsRouter = Router();

// Matches an order item by its listing id — the same id space as
// /commerce/listings/:id: a StoreListing id for a reseller item, a
// ShopProduct id for a shop item.
const itemIs = (listingId: string) => ({ OR: [{ storeListingId: listingId }, { shopProductId: listingId }] });

// Is the current customer eligible to rate a given listing, and have they
// already rated it? Only a DELIVERED order containing this exact item earns
// the right — ratings can't be left without a completed purchase. Powers
// whether the product detail page shows a "rate this" widget at all.
ratingsRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const listingId = typeof req.query.listingId === 'string' ? req.query.listingId : '';
    if (!listingId) throw new HttpError(400, 'listingId is required');

    const order = await prisma.order.findFirst({
      where: { customerId: req.user!.sub, status: 'DELIVERED', items: { some: itemIs(listingId) } },
      orderBy: { createdAt: 'desc' },
      include: { ratings: { where: itemIs(listingId) } },
    });

    res.json({
      eligible: !!order,
      orderId: order?.id ?? null,
      myRating: order?.ratings[0]?.rating ?? null,
      myComment: order?.ratings[0]?.comment ?? null,
    });
  } catch (err) {
    next(err);
  }
});

const rateSchema = z.object({
  orderId: z.string().uuid(),
  // Which item in the order. Optional only for an order with a single item
  // — older clients don't send it.
  listingId: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  // Optional written half of the feedback — a buyer can leave just stars.
  comment: z.string().trim().max(1000).optional(),
});

// One rating per item per delivered order — buying the same item again earns
// another; re-submitting for the same item updates it in place rather than
// erroring, so a buyer can change their mind.
ratingsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const input = rateSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: input.orderId }, include: { items: true } });
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.customerId !== req.user!.sub) throw new HttpError(403, 'This is not your order');
    if (order.status !== 'DELIVERED') throw new HttpError(409, 'You can only rate an item after it has been delivered');

    const rateable = order.items.filter((item) => item.storeListingId || item.shopProductId);
    const item = input.listingId
      ? rateable.find((i) => i.storeListingId === input.listingId || i.shopProductId === input.listingId)
      : rateable.length === 1
        ? rateable[0]
        : undefined;
    if (!item) {
      throw new HttpError(input.listingId || rateable.length === 0 ? 409 : 400, input.listingId || rateable.length === 0 ? 'That item is not in this order' : 'Say which item in this order you are rating');
    }

    // Empty string means "clear the comment" on a re-submit, not "leave it
    // unchanged" — undefined (the field omitted entirely) is what leaves it
    // untouched on update, but create always wants null over undefined.
    const comment = input.comment || null;
    const where = item.storeListingId
      ? { orderId_storeListingId: { orderId: order.id, storeListingId: item.storeListingId } }
      : { orderId_shopProductId: { orderId: order.id, shopProductId: item.shopProductId! } };

    const saved = await prisma.productRating.upsert({
      where,
      create: {
        customerId: req.user!.sub,
        orderId: order.id,
        storeListingId: item.storeListingId,
        shopProductId: item.shopProductId,
        rating: input.rating,
        comment,
      },
      update: { rating: input.rating, ...(input.comment !== undefined ? { comment } : {}) },
    });

    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});
