import { Router } from 'express';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { computeAffiliatePricing, PLATFORM_COMMISSION_RATE } from '../../lib/pricing.js';
import { logTrackingEvent } from '../../lib/tracking.js';

export const ordersRouter = Router();

// MVP flat driver fee — will move to per-warehouse / distance-based values
// once the FastAPI routing service is wired up (Domain D, Phase 4).
const FLAT_DRIVER_FEE_JMD = new Decimal(300);

const checkoutSchema = z.object({
  // AFFILIATE: sellerId = ResellerStore.id, productId = MasterProduct.id (via that store's listing).
  // STORE: sellerId = Shop.id, productId = ShopProduct.id (the shop's own item, no listing indirection).
  kind: z.enum(['AFFILIATE', 'STORE']).default('AFFILIATE'),
  storeId: z.string().uuid(),
  masterProductId: z.string().uuid(),
  quantity: z.number().int().positive(),
  deliveryAddress: z.string().min(1),
});

async function checkoutAffiliate(tx: Prisma.TransactionClient, customerId: string, input: z.infer<typeof checkoutSchema>) {
  const listing = await tx.storeListing.findFirst({
    where: { storeId: input.storeId, masterProductId: input.masterProductId, isActive: true },
    include: { masterProduct: { include: { warehouse: { select: { resellerCommissionPercent: true } } } }, store: true },
  });
  if (!listing) throw new HttpError(404, 'Listing not found or inactive');

  // Row-lock the product so two concurrent checkouts can't both pass the
  // stock check and oversell the last unit.
  const [locked] = await tx.$queryRaw<{ stock_quantity: number }[]>`
    SELECT stock_quantity FROM master_products WHERE id = ${listing.masterProductId}::uuid FOR UPDATE
  `;
  if (!locked || locked.stock_quantity < input.quantity) {
    throw new HttpError(409, 'Not enough stock available');
  }

  const updated = await tx.$executeRaw`
    UPDATE master_products
    SET stock_quantity = stock_quantity - ${input.quantity}
    WHERE id = ${listing.masterProductId}::uuid AND stock_quantity >= ${input.quantity}
  `;
  if (updated === 0) throw new HttpError(409, 'Not enough stock available');

  // Priced live off the warehouse's current wholesale price/discount and
  // reseller commission %, not the (informational-only) snapshot stored on
  // the StoreListing at add-to-store time — see lib/pricing.ts and
  // commerce.routes.ts's normalizeAffiliateListing, which computes the same
  // way so what a customer is shown is always what they're charged.
  const { wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd, retailTotalJmd } = computeAffiliatePricing({
    wholesalePriceJmd: listing.masterProduct.wholesalePriceJmd.toString(),
    discountPercent: listing.masterProduct.discountPercent,
    resellerCommissionPercent: listing.masterProduct.warehouse.resellerCommissionPercent,
    quantity: input.quantity,
  });
  const driverFee = FLAT_DRIVER_FEE_JMD;
  const totalPaid = retailTotalJmd.plus(driverFee);

  const order = await tx.order.create({
    data: {
      customerId,
      resellerStoreId: input.storeId,
      warehouseId: listing.masterProduct.warehouseId,
      // Records exactly which listing this was for — the proof a DELIVERED
      // order later needs to unlock rating this item (see ratings.routes.ts).
      storeListingId: listing.id,
      quantity: input.quantity,
      totalPaidJmd: totalPaid.toFixed(2),
      wholesaleTotalJmd: wholesaleTotalJmd.toFixed(2),
      resellerMarginJmd: resellerMarginJmd.toFixed(2),
      driverFeeJmd: driverFee.toFixed(2),
      platformCommissionJmd: platformCommissionJmd.toFixed(2),
      deliveryAddress: input.deliveryAddress,
      // status defaults to AWAITING_PAYMENT — flips to PACKING only once
      // the WiPay webhook confirms payment (see ledger.service.ts).
    },
  });
  await logTrackingEvent(tx, order.id, 'AWAITING_PAYMENT', { note: 'Order placed — awaiting payment' });
  return order;
}

async function checkoutStore(tx: Prisma.TransactionClient, customerId: string, input: z.infer<typeof checkoutSchema>) {
  const product = await tx.shopProduct.findFirst({
    where: { id: input.masterProductId, shopId: input.storeId, isActive: true },
  });
  if (!product) throw new HttpError(404, 'Product not found or inactive');

  const [locked] = await tx.$queryRaw<{ stock_quantity: number }[]>`
    SELECT stock_quantity FROM shop_products WHERE id = ${product.id}::uuid FOR UPDATE
  `;
  if (!locked || locked.stock_quantity < input.quantity) {
    throw new HttpError(409, 'Not enough stock available');
  }

  const updated = await tx.$executeRaw`
    UPDATE shop_products
    SET stock_quantity = stock_quantity - ${input.quantity}
    WHERE id = ${product.id}::uuid AND stock_quantity >= ${input.quantity}
  `;
  if (updated === 0) throw new HttpError(409, 'Not enough stock available');

  // No wholesale/margin split for a shop's own stock — it keeps the full
  // item price (via resellerMarginJmd, reused here as "seller's take" — see
  // the Order model comment). wholesaleTotalJmd is 0 for a STORE order.
  const discountMultiplier = new Decimal(1).minus(new Decimal(product.discountPercent).dividedBy(100));
  const discountedUnitPrice = new Decimal(product.priceJmd.toString()).times(discountMultiplier).toDecimalPlaces(2);
  const itemTotal = discountedUnitPrice.times(input.quantity);
  const driverFee = FLAT_DRIVER_FEE_JMD;
  const platformCommission = itemTotal.times(PLATFORM_COMMISSION_RATE).toDecimalPlaces(2);
  const totalPaid = itemTotal.plus(driverFee).plus(platformCommission);

  const order = await tx.order.create({
    data: {
      customerId,
      shopId: input.storeId,
      // Records exactly which product this was for — see checkoutAffiliate's
      // storeListingId comment above.
      shopProductId: product.id,
      quantity: input.quantity,
      totalPaidJmd: totalPaid.toFixed(2),
      wholesaleTotalJmd: '0.00',
      resellerMarginJmd: itemTotal.toFixed(2),
      driverFeeJmd: driverFee.toFixed(2),
      platformCommissionJmd: platformCommission.toFixed(2),
      deliveryAddress: input.deliveryAddress,
    },
  });
  await logTrackingEvent(tx, order.id, 'AWAITING_PAYMENT', { note: 'Order placed — awaiting payment' });
  return order;
}

ordersRouter.post('/', requireAuth, requireRole(UserRole.CUSTOMER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = checkoutSchema.parse(req.body);

    const order = await prisma.$transaction((tx) =>
      input.kind === 'STORE' ? checkoutStore(tx, req.user!.sub, input) : checkoutAffiliate(tx, req.user!.sub, input),
    );

    // TODO(Phase 3): initiate the WiPay hosted-fields checkout session here and
    // return its redirect/session URL alongside the order id.
    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

// The customer's own order history — powers the Account page's Orders tab.
// Registered before `/:id` below, otherwise Express would match "mine" as an id.
// Normalized into a flat, display-ready shape (one item per order, same
// "one product per order" assumption as checkout) rather than making the
// frontend reach into storeListing vs. shopProduct itself.
ordersRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId: req.user!.sub },
      include: {
        storeListing: { include: { masterProduct: true, store: { select: { storeName: true } } } },
        shopProduct: { include: { shop: { select: { shopName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      orders.map((o) => ({
        id: o.id,
        status: o.status,
        createdAt: o.createdAt,
        quantity: o.quantity,
        totalPaidJmd: o.totalPaidJmd,
        deliveryAddress: o.deliveryAddress,
        // Listing id doubles as the /product/:id route param — same id
        // space the marketplace and ratings already use.
        listingId: o.storeListingId ?? o.shopProductId ?? null,
        itemTitle: o.storeListing?.masterProduct.title ?? o.shopProduct?.title ?? 'Item no longer available',
        itemImageUrl: o.storeListing?.masterProduct.imageUrl ?? o.shopProduct?.imageUrl ?? null,
        sellerName: o.storeListing?.store.storeName ?? o.shopProduct?.shop.shopName ?? null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: String(req.params.id) } });
    if (!order) throw new HttpError(404, 'Order not found');
    res.json(order);
  } catch (err) {
    next(err);
  }
});
