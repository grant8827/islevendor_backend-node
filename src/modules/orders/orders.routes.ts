import { Router } from 'express';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { computeAffiliatePricing, PLATFORM_COMMISSION_RATE } from '../../lib/pricing.js';
import { logTrackingEvent } from '../../lib/tracking.js';
import { assertOrderAccess, toOrderDto } from '../../lib/orderAccess.js';
import { APPROVED_SELLER } from '../../lib/eligibility.js';
import {
  DELIVERY_SETTINGS_SELECT,
  deliveryFeesFor,
  deliveryOptionsFor,
  pickupLocationOf,
  type DeliveryOption,
  type DeliverySettings,
} from '../../lib/deliveryOptions.js';

export const ordersRouter = Router();

const deliveryMethodSchema = z.enum(['ISLEDASH', 'SELLER_DELIVERY', 'PICKUP']);

const lineSchema = z.object({
  // AFFILIATE: sellerId = ResellerStore.id, productId = MasterProduct.id (via that store's listing).
  // STORE: sellerId = Shop.id, productId = ShopProduct.id (the shop's own item, no listing indirection).
  kind: z.enum(['AFFILIATE', 'STORE']).default('AFFILIATE'),
  storeId: z.string().uuid(),
  masterProductId: z.string().uuid(),
  quantity: z.number().int().positive().max(999),
});

const checkoutSchema = lineSchema
  .extend({
    // Defaults to IsleDash so a client that predates delivery options keeps
    // working — every business offered IsleDash before they existed.
    deliveryMethod: deliveryMethodSchema.default('ISLEDASH'),
    deliveryAddress: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.deliveryMethod === 'PICKUP' || !!v.deliveryAddress, {
    message: 'Enter a delivery address',
    path: ['deliveryAddress'],
  });

type Line = z.infer<typeof lineSchema>;
type CheckoutInput = z.infer<typeof checkoutSchema>;
type Db = Prisma.TransactionClient | typeof prisma;

// Only from businesses IsleVendor has approved — the same rule the
// marketplace uses to decide what to show (see lib/eligibility.ts).
function findAffiliateListing(db: Db, line: Line) {
  return db.storeListing.findFirst({
    where: {
      storeId: line.storeId,
      masterProductId: line.masterProductId,
      isActive: true,
      store: APPROVED_SELLER,
      masterProduct: { isActive: true, warehouse: APPROVED_SELLER },
    },
    include: {
      masterProduct: { include: { warehouse: { select: { id: true, name: true, resellerCommissionPercent: true, ...DELIVERY_SETTINGS_SELECT } } } },
      store: { select: { storeName: true } },
    },
  });
}

function findShopProduct(db: Db, line: Line) {
  return db.shopProduct.findFirst({
    where: { id: line.masterProductId, shopId: line.storeId, isActive: true, shop: APPROVED_SELLER },
    include: { shop: { select: { id: true, shopName: true, pickupAddress: true, ...DELIVERY_SETTINGS_SELECT } } },
  });
}

type AffiliateListing = NonNullable<Awaited<ReturnType<typeof findAffiliateListing>>>;
type ShopProductRow = NonNullable<Awaited<ReturnType<typeof findShopProduct>>>;

// Priced live off the warehouse's current wholesale price/discount and
// reseller commission %, not the (informational-only) snapshot stored on the
// StoreListing at add-to-store time — see lib/pricing.ts and
// commerce.routes.ts's normalizeAffiliateListing, which computes the same way
// so what a customer is shown is always what they're charged.
function priceAffiliate(listing: AffiliateListing, quantity: number) {
  const { wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd, retailTotalJmd } = computeAffiliatePricing({
    wholesalePriceJmd: listing.masterProduct.wholesalePriceJmd.toString(),
    discountPercent: listing.masterProduct.discountPercent,
    resellerCommissionPercent: listing.masterProduct.warehouse.resellerCommissionPercent,
    quantity,
  });
  return { goodsTotalJmd: retailTotalJmd, wholesaleTotalJmd, resellerMarginJmd, platformCommissionJmd };
}

// No wholesale/margin split for a shop's own stock — it keeps the full item
// price (via resellerMarginJmd, reused as "seller's take" — see the Order
// model comment), and the platform's commission is added on top.
function priceShopProduct(product: ShopProductRow, quantity: number) {
  const discountMultiplier = new Decimal(1).minus(new Decimal(product.discountPercent).dividedBy(100));
  const discountedUnitPrice = new Decimal(product.priceJmd.toString()).times(discountMultiplier).toDecimalPlaces(2);
  const itemTotal = discountedUnitPrice.times(quantity);
  const platformCommissionJmd = itemTotal.times(PLATFORM_COMMISSION_RATE).toDecimalPlaces(2);
  return {
    goodsTotalJmd: itemTotal.plus(platformCommissionJmd),
    wholesaleTotalJmd: new Decimal(0),
    resellerMarginJmd: itemTotal,
    platformCommissionJmd,
  };
}

/** Where a pickup order is collected, recorded as its delivery address so every seller view and label shows it. */
function addressFor(input: CheckoutInput, seller: DeliverySettings): string {
  return input.deliveryMethod === 'PICKUP' ? `Customer pickup: ${pickupLocationOf(seller)}` : input.deliveryAddress!;
}

// Row-lock the product so two concurrent checkouts can't both pass the
// stock check and oversell the last unit.
async function reserveStock(tx: Prisma.TransactionClient, table: 'master_products' | 'shop_products', productId: string, quantity: number) {
  const [locked] =
    table === 'master_products'
      ? await tx.$queryRaw<{ stock_quantity: number }[]>`SELECT stock_quantity FROM master_products WHERE id = ${productId}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ stock_quantity: number }[]>`SELECT stock_quantity FROM shop_products WHERE id = ${productId}::uuid FOR UPDATE`;
  if (!locked || locked.stock_quantity < quantity) {
    throw new HttpError(409, 'Not enough stock available');
  }
  const updated =
    table === 'master_products'
      ? await tx.$executeRaw`UPDATE master_products SET stock_quantity = stock_quantity - ${quantity} WHERE id = ${productId}::uuid AND stock_quantity >= ${quantity}`
      : await tx.$executeRaw`UPDATE shop_products SET stock_quantity = stock_quantity - ${quantity} WHERE id = ${productId}::uuid AND stock_quantity >= ${quantity}`;
  if (updated === 0) throw new HttpError(409, 'Not enough stock available');
}

async function checkoutAffiliate(tx: Prisma.TransactionClient, customerId: string, input: CheckoutInput) {
  const listing = await findAffiliateListing(tx, input);
  if (!listing) throw new HttpError(404, 'Listing not found or inactive');
  // The warehouse packs and ships a reseller's orders, so its delivery
  // options are the ones that apply.
  const fees = deliveryFeesFor(listing.masterProduct.warehouse, input.deliveryMethod);

  await reserveStock(tx, 'master_products', listing.masterProductId, input.quantity);
  const price = priceAffiliate(listing, input.quantity);

  const order = await tx.order.create({
    data: {
      customerId,
      resellerStoreId: input.storeId,
      warehouseId: listing.masterProduct.warehouseId,
      // Records exactly which listing this was for — the proof a DELIVERED
      // order later needs to unlock rating this item (see ratings.routes.ts).
      storeListingId: listing.id,
      quantity: input.quantity,
      totalPaidJmd: price.goodsTotalJmd.plus(fees.driverFeeJmd).plus(fees.sellerDeliveryFeeJmd).toFixed(2),
      wholesaleTotalJmd: price.wholesaleTotalJmd.toFixed(2),
      resellerMarginJmd: price.resellerMarginJmd.toFixed(2),
      driverFeeJmd: fees.driverFeeJmd.toFixed(2),
      sellerDeliveryFeeJmd: fees.sellerDeliveryFeeJmd.toFixed(2),
      platformCommissionJmd: price.platformCommissionJmd.toFixed(2),
      deliveryMethod: input.deliveryMethod,
      deliveryAddress: addressFor(input, listing.masterProduct.warehouse),
      // status defaults to AWAITING_PAYMENT — flips to PACKING only once
      // the WiPay webhook confirms payment (see ledger.service.ts).
    },
  });
  await logTrackingEvent(tx, order.id, 'AWAITING_PAYMENT', { note: 'Order placed — awaiting payment' });
  return order;
}

async function checkoutStore(tx: Prisma.TransactionClient, customerId: string, input: CheckoutInput) {
  const product = await findShopProduct(tx, input);
  if (!product) throw new HttpError(404, 'Product not found or inactive');
  const fees = deliveryFeesFor(product.shop, input.deliveryMethod);

  await reserveStock(tx, 'shop_products', product.id, input.quantity);
  const price = priceShopProduct(product, input.quantity);

  const order = await tx.order.create({
    data: {
      customerId,
      shopId: input.storeId,
      // Records exactly which product this was for — see checkoutAffiliate's
      // storeListingId comment above.
      shopProductId: product.id,
      quantity: input.quantity,
      totalPaidJmd: price.goodsTotalJmd.plus(fees.driverFeeJmd).plus(fees.sellerDeliveryFeeJmd).toFixed(2),
      wholesaleTotalJmd: '0.00',
      resellerMarginJmd: price.resellerMarginJmd.toFixed(2),
      driverFeeJmd: fees.driverFeeJmd.toFixed(2),
      sellerDeliveryFeeJmd: fees.sellerDeliveryFeeJmd.toFixed(2),
      platformCommissionJmd: price.platformCommissionJmd.toFixed(2),
      deliveryMethod: input.deliveryMethod,
      deliveryAddress: addressFor(input, product.shop),
    },
  });
  await logTrackingEvent(tx, order.id, 'AWAITING_PAYMENT', { note: 'Order placed — awaiting payment' });
  return order;
}

const quoteSchema = z.object({ items: z.array(lineSchema).min(1).max(50) });

// The cart's view of itself, priced by the server: what each line costs
// today, whether it's still in stock, and the delivery options each seller
// offers. Customers choose one option per seller from `sellers`, then check
// out. Public, like the marketplace — a guest can build a cart.
//
// A seller here is whoever packs and ships the order: the shop for a shop
// item, the warehouse behind a reseller's listing.
ordersRouter.post('/quote', async (req, res, next) => {
  try {
    const { items } = quoteSchema.parse(req.body);
    const sellers = new Map<string, { key: string; name: string; options: DeliveryOption[] }>();

    const lines = await Promise.all(
      items.map(async (line) => {
        const unavailable = (reason: string) => ({ ...line, available: false as const, reason });

        if (line.kind === 'STORE') {
          const product = await findShopProduct(prisma, line);
          if (!product) return unavailable('No longer available');
          const key = `shop:${product.shop.id}`;
          sellers.set(key, { key, name: product.shop.shopName, options: deliveryOptionsFor(product.shop) });
          if (product.stockQuantity < line.quantity) return { ...unavailable(`Only ${product.stockQuantity} left`), sellerKey: key };
          const price = priceShopProduct(product, line.quantity);
          return { ...line, available: true as const, sellerKey: key, goodsTotalJmd: price.goodsTotalJmd.toFixed(2), serviceFeeJmd: price.platformCommissionJmd.toFixed(2) };
        }

        const listing = await findAffiliateListing(prisma, line);
        if (!listing) return unavailable('No longer available');
        const { warehouse } = listing.masterProduct;
        const key = `warehouse:${warehouse.id}`;
        // Customers buy from the reseller; it ships from their supplier.
        sellers.set(key, { key, name: `${listing.store.storeName} (ships from ${warehouse.parish})`, options: deliveryOptionsFor(warehouse) });
        if (listing.masterProduct.stockQuantity < line.quantity) {
          return { ...unavailable(`Only ${listing.masterProduct.stockQuantity} left`), sellerKey: key };
        }
        const price = priceAffiliate(listing, line.quantity);
        return { ...line, available: true as const, sellerKey: key, goodsTotalJmd: price.goodsTotalJmd.toFixed(2), serviceFeeJmd: '0.00' };
      }),
    );

    res.json({ items: lines, sellers: [...sellers.values()] });
  } catch (err) {
    next(err);
  }
});

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

// Participants only (customer, assigned driver, the selling warehouse/
// reseller/shop, or an admin), each with their own slice of the order — see
// lib/orderAccess.ts.
ordersRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { order, access } = await assertOrderAccess(String(req.params.id), req.user!);
    res.json(toOrderDto(order, access));
  } catch (err) {
    next(err);
  }
});
