import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { computeAffiliatePricing } from '../../lib/pricing.js';
import { logTrackingEvent } from '../../lib/tracking.js';
import { assertOrderAccess, toOrderDto } from '../../lib/orderAccess.js';
import { APPROVED_SELLER } from '../../lib/eligibility.js';
import {
  DELIVERY_SETTINGS_SELECT,
  deliveryOptionsFor,
  perItemFees,
  pickupLocationOf,
  requireRate,
  type DeliverySettings,
} from '../../lib/deliveryOptions.js';
import { effectiveFeeStructure, getIsleDashRate, platformCommissionRate } from '../../lib/platformSettings.js';
import { CARD_FEE_PAID_BY, startCheckoutPayment } from '../payments/payments.service.js';
import { requestOrigin } from '../payments/payments.routes.js';
import { ITEMS_IN_ORDER, summarizeItems, toItemView } from '../../lib/orderItems.js';

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
type Line = z.infer<typeof lineSchema>;
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

/**
 * One cart line, looked up and priced: what the customer pays for the goods,
 * how that splits between warehouse/reseller/shop/platform, and — as
 * `sellerKey` — which business packs and ships it. That's the shop for a
 * shop item, and the warehouse behind a reseller's listing, whose delivery
 * options therefore apply.
 */
interface ResolvedLine {
  line: Line;
  sellerKey: string;
  /**
   * Which order this line belongs in: everything from one shop, or — since
   * a reseller is paid separately from the warehouse that ships for it —
   * everything from one reseller's store that one warehouse ships.
   */
  orderKey: string;
  title: string;
  imageUrl: string | null;
  sellerName: string;
  seller: DeliverySettings;
  stockQuantity: number;
  stock: { table: 'master_products' | 'shop_products'; id: string };
  goodsTotalJmd: Decimal;
  wholesaleTotalJmd: Decimal;
  resellerMarginJmd: Decimal;
  platformCommissionJmd: Decimal;
  orderFields: { resellerStoreId: string; warehouseId: string } | { shopId: string };
  itemFields: { storeListingId: string } | { shopProductId: string };
}

async function resolveLine(db: Db, line: Line): Promise<ResolvedLine | null> {
  if (line.kind === 'STORE') {
    const product = await findShopProduct(db, line);
    if (!product) return null;
    // No wholesale/margin split for a shop's own stock — it keeps the full
    // item price (via resellerMarginJmd, reused as "seller's take" — see the
    // Order model comment), and the platform's commission is added on top.
    const discountMultiplier = new Decimal(1).minus(new Decimal(product.discountPercent).dividedBy(100));
    const discountedUnitPrice = new Decimal(product.priceJmd.toString()).times(discountMultiplier).toDecimalPlaces(2);
    const itemTotal = discountedUnitPrice.times(line.quantity);
    const platformCommissionJmd = itemTotal.times(platformCommissionRate()).toDecimalPlaces(2);
    return {
      line,
      sellerKey: `shop:${product.shop.id}`,
      orderKey: `shop:${product.shop.id}`,
      title: product.title,
      imageUrl: product.imageUrl,
      sellerName: product.shop.shopName,
      seller: product.shop,
      stockQuantity: product.stockQuantity,
      stock: { table: 'shop_products', id: product.id },
      goodsTotalJmd: itemTotal.plus(platformCommissionJmd),
      wholesaleTotalJmd: new Decimal(0),
      resellerMarginJmd: itemTotal,
      platformCommissionJmd,
      orderFields: { shopId: line.storeId },
      // Which exact item this was — the proof a DELIVERED order later needs
      // to unlock rating it (ratings.routes.ts).
      itemFields: { shopProductId: product.id },
    };
  }

  const listing = await findAffiliateListing(db, line);
  if (!listing) return null;
  const { warehouse } = listing.masterProduct;
  // Priced live off the warehouse's current wholesale price/discount and
  // reseller commission %, not the informational snapshot on the
  // StoreListing — see lib/pricing.ts and commerce.routes.ts's
  // normalizeAffiliateListing, which computes the same way so what a
  // customer is shown is always what they're charged.
  const price = computeAffiliatePricing({
    wholesalePriceJmd: listing.masterProduct.wholesalePriceJmd.toString(),
    discountPercent: listing.masterProduct.discountPercent,
    resellerCommissionPercent: warehouse.resellerCommissionPercent,
    quantity: line.quantity,
  });
  return {
    line,
    sellerKey: `warehouse:${warehouse.id}`,
    orderKey: `warehouse:${warehouse.id}:store:${line.storeId}`,
    title: listing.masterProduct.title,
    imageUrl: listing.masterProduct.imageUrl,
    // Customers buy from the reseller; it ships from their supplier.
    sellerName: `${listing.store.storeName} (ships from ${warehouse.parish})`,
    seller: warehouse,
    stockQuantity: listing.masterProduct.stockQuantity,
    stock: { table: 'master_products', id: listing.masterProductId },
    goodsTotalJmd: price.retailTotalJmd,
    wholesaleTotalJmd: price.wholesaleTotalJmd,
    resellerMarginJmd: price.resellerMarginJmd,
    platformCommissionJmd: price.platformCommissionJmd,
    orderFields: { resellerStoreId: line.storeId, warehouseId: warehouse.id },
    itemFields: { storeListingId: listing.id },
  };
}

/** Lines grouped by the business that ships them, in cart order. */
function groupBy(lines: ResolvedLine[], key: (line: ResolvedLine) => string): Map<string, ResolvedLine[]> {
  const groups = new Map<string, ResolvedLine[]>();
  for (const line of lines) groups.set(key(line), [...(groups.get(key(line)) ?? []), line]);
  return groups;
}
const groupBySeller = (lines: ResolvedLine[]) => groupBy(lines, (l) => l.sellerKey);

const sum = (values: Decimal[]) => values.reduce((total, v) => total.plus(v), new Decimal(0));

const unitsOf = (lines: ResolvedLine[]) => lines.reduce((sum, l) => sum + l.line.quantity, 0);

// Row-lock the product so two concurrent checkouts can't both pass the
// stock check and oversell the last unit.
async function reserveStock(tx: Prisma.TransactionClient, { table, id }: ResolvedLine['stock'], quantity: number) {
  const updated =
    table === 'master_products'
      ? await tx.$executeRaw`UPDATE master_products SET stock_quantity = stock_quantity - ${quantity} WHERE id = ${id}::uuid AND stock_quantity >= ${quantity}`
      : await tx.$executeRaw`UPDATE shop_products SET stock_quantity = stock_quantity - ${quantity} WHERE id = ${id}::uuid AND stock_quantity >= ${quantity}`;
  if (updated === 0) throw new HttpError(409, 'Not enough stock available');
}

const checkoutSchema = z
  .object({
    items: z.array(lineSchema).min(1).max(50),
    // One choice per business shipping something in this cart, keyed by the
    // sellerKey POST /orders/quote returns.
    deliveryMethods: z.record(z.string(), deliveryMethodSchema),
    deliveryAddress: z.string().trim().min(1).max(500).optional(),
  });
type CheckoutInput = z.infer<typeof checkoutSchema>;

/**
 * Places a whole cart, all or nothing, in a single transaction — a failure
 * anywhere (out of stock, a seller no longer approved, an option it doesn't
 * offer) leaves nothing behind.
 *
 * Everything bought from one business ships together as ONE order holding
 * several items: one label, one packing step, one driver trip. (A reseller
 * is paid separately from its warehouse, so items from two resellers that
 * share a warehouse become two orders.)
 *
 * Shipping is charged per business that ships, across all its items: the
 * first item at the full fee, every further unit at that rate's extra-item
 * fee (lib/deliveryOptions.ts). Orders sharing one charge carry the same
 * checkoutGroupId.
 */
async function placeCheckout(customerId: string, input: CheckoutInput) {
  return prisma.$transaction(async (tx) => {
    const isleDashRate = await getIsleDashRate(tx);
    const resolved: ResolvedLine[] = [];
    for (const line of input.items) {
      const r = await resolveLine(tx, line);
      if (!r) throw new HttpError(404, 'An item in your cart is no longer available — refresh your cart');
      resolved.push(r);
    }

    // Take stock in a fixed order (by product) so two checkouts holding the
    // same products can't deadlock each other.
    const byProduct = [...resolved].sort((a, b) => `${a.stock.table}:${a.stock.id}`.localeCompare(`${b.stock.table}:${b.stock.id}`));
    for (const r of byProduct) await reserveStock(tx, r.stock, r.line.quantity);

    const orders = [];
    for (const [sellerKey, sellerLines] of groupBySeller(resolved)) {
      const method = input.deliveryMethods[sellerKey];
      if (!method) throw new HttpError(400, `Choose how you want to get the items from ${sellerLines[0].sellerName}`);
      const rate = requireRate(sellerLines[0].seller, method, isleDashRate);
      if (method !== 'PICKUP' && !input.deliveryAddress) throw new HttpError(400, 'Enter a delivery address');

      // This seller's shipping, unit by unit in cart order, then summed per order.
      const unitFees = perItemFees(rate, unitsOf(sellerLines));
      const checkoutGroupId = randomUUID();

      for (const lines of groupBy(sellerLines, (l) => l.orderKey).values()) {
        const fee = sum(unitFees.splice(0, unitsOf(lines)));
        const driverFee = method === 'ISLEDASH' ? fee : new Decimal(0);
        const sellerDeliveryFee = method === 'SELLER_DELIVERY' ? fee : new Decimal(0);
        const goodsTotal = sum(lines.map((l) => l.goodsTotalJmd));

        const order = await tx.order.create({
          data: {
            customerId,
            ...lines[0].orderFields,
            // The first item and total units, for clients that still show one
            // product per order (see the Order model).
            ...lines[0].itemFields,
            quantity: unitsOf(lines),
            totalPaidJmd: goodsTotal.plus(fee).toFixed(2),
            wholesaleTotalJmd: sum(lines.map((l) => l.wholesaleTotalJmd)).toFixed(2),
            resellerMarginJmd: sum(lines.map((l) => l.resellerMarginJmd)).toFixed(2),
            driverFeeJmd: driverFee.toFixed(2),
            sellerDeliveryFeeJmd: sellerDeliveryFee.toFixed(2),
            platformCommissionJmd: sum(lines.map((l) => l.platformCommissionJmd)).toFixed(2),
            deliveryMethod: method,
            // A pickup records where to collect, so every seller view and
            // label shows it.
            deliveryAddress: method === 'PICKUP' ? `Customer pickup: ${pickupLocationOf(lines[0].seller)}` : input.deliveryAddress!,
            checkoutGroupId,
            items: {
              create: lines.map((l) => ({
                ...l.itemFields,
                title: l.title,
                imageUrl: l.imageUrl,
                quantity: l.line.quantity,
                goodsTotalJmd: l.goodsTotalJmd.toFixed(2),
                wholesaleTotalJmd: l.wholesaleTotalJmd.toFixed(2),
                resellerMarginJmd: l.resellerMarginJmd.toFixed(2),
                platformCommissionJmd: l.platformCommissionJmd.toFixed(2),
              })),
            },
            // status defaults to AWAITING_PAYMENT — flips to PACKING only once
            // the WiPay webhook confirms payment (see ledger.service.ts).
          },
          include: { items: true },
        });
        await logTrackingEvent(tx, order.id, 'AWAITING_PAYMENT', { note: 'Order placed — awaiting payment' });
        orders.push(order);
      }
    }
    return orders;
  });
}

// IsleVendor's current IsleDash pricing — shown to sellers on their
// Shipping tab so they know what customers pay when they pick IsleDash.
ordersRouter.get('/isledash-rate', async (_req, res, next) => {
  try {
    const rate = await getIsleDashRate();
    res.json({ baseFeeJmd: rate.baseFeeJmd.toFixed(2), extraItemPercent: rate.extraItemPercent });
  } catch (err) {
    next(err);
  }
});

/**
 * Starts the WiPay payment for just-placed orders, or explains why it
 * couldn't — payments switched off, or WiPay unreachable. Never throws: the
 * orders are already saved and payable later from the customer's account.
 */
async function paymentFor(req: Request, orderIds: string[]) {
  try {
    const payment = await startCheckoutPayment(req.user!.sub, orderIds, requestOrigin(req));
    return { id: payment.id, status: payment.status, checkoutUrl: payment.checkoutUrl, message: payment.message };
  } catch (err) {
    return { id: null, status: 'NOT_STARTED' as const, checkoutUrl: null, message: err instanceof HttpError ? err.message : 'Payment couldn’t be started' };
  }
}

const quoteSchema = z.object({ items: z.array(lineSchema).min(1).max(50) });

// The cart's view of itself, priced by the server: what each line costs
// today, whether it's still in stock, and — per business shipping something
// — the delivery options it offers, each priced for all of that business's
// items together. Customers choose one option per seller, then check out.
// Public, like the marketplace — a guest can build a cart.
ordersRouter.post('/quote', async (req, res, next) => {
  try {
    const { items } = quoteSchema.parse(req.body);
    const isleDashRate = await getIsleDashRate();
    const resolved = await Promise.all(items.map((line) => resolveLine(prisma, line)));

    const lines = items.map((line, i) => {
      const r = resolved[i];
      if (!r) return { ...line, available: false as const, reason: 'No longer available' };
      if (r.stockQuantity < line.quantity) return { ...line, available: false as const, reason: `Only ${r.stockQuantity} left`, sellerKey: r.sellerKey };
      return {
        ...line,
        available: true as const,
        sellerKey: r.sellerKey,
        goodsTotalJmd: r.goodsTotalJmd.toFixed(2),
        serviceFeeJmd: line.kind === 'STORE' ? r.platformCommissionJmd.toFixed(2) : '0.00',
      };
    });

    const available = resolved.filter((r, i): r is ResolvedLine => r !== null && lines[i].available);
    const sellers = [...groupBySeller(resolved.filter((r): r is ResolvedLine => r !== null))].map(([key, group]) => {
      const units = unitsOf(available.filter((r) => r.sellerKey === key));
      return { key, name: group[0].sellerName, units, options: deliveryOptionsFor(group[0].seller, isleDashRate, Math.max(units, 1)) };
    });

    // Who pays WiPay's card fee (WIPAY_FEE_STRUCTURE) — the cart says so
    // before the customer leaves for WiPay, where any fee is added.
    res.json({ items: lines, sellers, cardFeePaidBy: CARD_FEE_PAID_BY[await effectiveFeeStructure()] });
  } catch (err) {
    next(err);
  }
});

// Places the whole cart — see placeCheckout.
ordersRouter.post('/checkout', requireAuth, requireRole(UserRole.CUSTOMER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const orders = await placeCheckout(req.user!.sub, checkoutSchema.parse(req.body));
    // One WiPay payment for the whole cart. The orders are placed either way:
    // if paying can't start, the customer can pay for them later.
    res.status(201).json({ orders, payment: await paymentFor(req, orders.map((o) => o.id)) });
  } catch (err) {
    next(err);
  }
});

// One item on its own — kept for clients that predate whole-cart checkout
// (the IsleVendor mobile app). The same as /checkout with a single line.
const singleCheckoutSchema = lineSchema
  .extend({
    // Defaults to IsleDash: every business offered it before delivery
    // options existed.
    deliveryMethod: deliveryMethodSchema.default('ISLEDASH'),
    deliveryAddress: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.deliveryMethod === 'PICKUP' || !!v.deliveryAddress, {
    message: 'Enter a delivery address',
    path: ['deliveryAddress'],
  });

ordersRouter.post('/', requireAuth, requireRole(UserRole.CUSTOMER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { deliveryMethod, deliveryAddress, ...line } = singleCheckoutSchema.parse(req.body);
    const resolved = await resolveLine(prisma, line);
    if (!resolved) throw new HttpError(404, line.kind === 'STORE' ? 'Product not found or inactive' : 'Listing not found or inactive');

    const [order] = await placeCheckout(req.user!.sub, {
      items: [line],
      deliveryMethods: { [resolved.sellerKey]: deliveryMethod },
      deliveryAddress,
    });
    const payment = await paymentFor(req, [order.id]);
    res.status(201).json({ ...order, checkoutUrl: payment?.checkoutUrl ?? null, paymentId: payment?.id ?? null });
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
        items: ITEMS_IN_ORDER,
        ratings: true,
        resellerStore: { select: { storeName: true } },
        shop: { select: { shopName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      orders.map((o) => {
        const ratingOf = (listingId: string | null) => o.ratings.find((r) => (r.storeListingId ?? r.shopProductId) === listingId);
        return {
          id: o.id,
          status: o.status,
          createdAt: o.createdAt,
          quantity: o.quantity,
          totalPaidJmd: o.totalPaidJmd,
          deliveryMethod: o.deliveryMethod,
          deliveryAddress: o.deliveryAddress,
          // Where an unpaid order's "Pay now" goes (the payment status page).
          checkoutPaymentId: o.checkoutPaymentId,
          sellerName: o.resellerStore?.storeName ?? o.shop?.shopName ?? null,
          items: o.items.map((item) => {
            const rating = ratingOf(item.storeListingId ?? item.shopProductId);
            return { ...toItemView(item), myRating: rating?.rating ?? null, myComment: rating?.comment ?? null };
          }),
          // A one-line summary and the first item, for clients that show one
          // product per order. listingId doubles as the /product/:id route param.
          itemTitle: summarizeItems(o.items),
          itemImageUrl: o.items[0]?.imageUrl ?? null,
          listingId: o.items[0] ? (o.items[0].storeListingId ?? o.items[0].shopProductId) : null,
        };
      }),
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
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, ...ITEMS_IN_ORDER });
    res.json({ ...toOrderDto(order, access), items: items.map(toItemView) });
  } catch (err) {
    next(err);
  }
});
