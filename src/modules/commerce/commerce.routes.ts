import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { computeAffiliatePricing } from '../../lib/pricing.js';

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
    // Slugs are public URL paths shared with shops (/store/:slug resolves
    // against both tables) — check both so the two can't collide.
    const [existingStore, existingShop] = await Promise.all([
      prisma.resellerStore.findUnique({ where: { slug: input.slug } }),
      prisma.shop.findUnique({ where: { slug: input.slug } }),
    ]);
    if (existingStore || existingShop) throw new HttpError(409, 'That store slug is already taken');

    const store = await prisma.resellerStore.create({
      data: { userId: req.user!.sub, storeName: input.storeName, slug: input.slug },
    });
    res.status(201).json(store);
  } catch (err) {
    next(err);
  }
});

// Shop products have no separate "listing" indirection the way affiliate
// StoreListings do (a shop's product IS its listing), so this reshapes one
// into the same { masterProduct, store, retailPriceJmd, kind } envelope an
// affiliate listing already has — every frontend read site (ProductCard,
// cart, checkout, this file's own /listings/:id) can then treat both kinds
// identically and only branch on `kind` where it actually matters.
function normalizeShopProduct(p: {
  id: string;
  shopId: string;
  priceJmd: unknown;
  isActive: boolean;
  discountPercent: number;
  isFeatured: boolean;
  shop: { shopName: string; slug: string; parish: string };
  [key: string]: unknown;
}) {
  const originalPrice = Number(p.priceJmd);
  const salePrice = originalPrice * (1 - p.discountPercent / 100);
  return {
    id: p.id,
    storeId: p.shopId,
    masterProductId: p.id,
    retailPriceJmd: salePrice.toFixed(2),
    originalPriceJmd: originalPrice.toFixed(2),
    discountPercent: p.discountPercent,
    isFeatured: p.isFeatured,
    isActive: p.isActive,
    kind: 'STORE' as const,
    shipFromParish: p.shop.parish,
    masterProduct: { ...p, wholesalePriceJmd: p.priceJmd },
    store: { storeName: p.shop.shopName, slug: p.shop.slug, parish: p.shop.parish },
  };
}

// The customer-facing price is computed live from the warehouse's current
// wholesale price/discount and reseller commission %, never trusted from
// the (informational-only) retailPriceJmd snapshot stored on the
// StoreListing — see lib/pricing.ts and orders.routes.ts's checkoutAffiliate,
// which prices a purchase the exact same way so what's shown is what's charged.
// originalPriceJmd (the "was" price for a discount badge) is the same
// formula with the warehouse's own discount zeroed out, so a warehouse
// discount lowers the reseller's and platform's cut too, not just the "now"
// price — see MasterProduct.discountPercent's doc comment.
function normalizeAffiliateListing<
  T extends {
    storeId: string;
    masterProduct: { wholesalePriceJmd: unknown; discountPercent: number; warehouse: { parish: string; resellerCommissionPercent: number } };
  },
>(l: T) {
  const { retailTotalJmd } = computeAffiliatePricing({
    wholesalePriceJmd: String(l.masterProduct.wholesalePriceJmd),
    discountPercent: l.masterProduct.discountPercent,
    resellerCommissionPercent: l.masterProduct.warehouse.resellerCommissionPercent,
  });
  const { retailTotalJmd: originalRetailJmd } = computeAffiliatePricing({
    wholesalePriceJmd: String(l.masterProduct.wholesalePriceJmd),
    discountPercent: 0,
    resellerCommissionPercent: l.masterProduct.warehouse.resellerCommissionPercent,
  });

  return {
    ...l,
    kind: 'AFFILIATE' as const,
    shipFromParish: l.masterProduct.warehouse.parish,
    retailPriceJmd: retailTotalJmd.toFixed(2),
    originalPriceJmd: originalRetailJmd.toFixed(2),
    discountPercent: l.masterProduct.discountPercent,
    isFeatured: false,
  };
}

// Marketplace-wide browse: every active affiliate listing PLUS every active
// shop product, optionally filtered by category/search text. Powers the
// public home page — deliberately has no auth requirement, same as a
// storefront page.
commerceRouter.get('/listings', async (req, res, next) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;

    const [affiliateListings, shopProducts] = await Promise.all([
      prisma.storeListing.findMany({
        where: {
          isActive: true,
          // A suspended master product shouldn't be buyable even if an
          // affiliate still has it listed — the warehouse isn't selling it.
          masterProduct: {
            isActive: true,
            ...(category && category !== 'All' ? { category } : {}),
            ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
          },
        },
        include: {
          masterProduct: { include: { warehouse: { select: { parish: true, resellerCommissionPercent: true } } } },
          store: { select: { storeName: true, slug: true } },
        },
        orderBy: { masterProduct: { createdAt: 'desc' } },
      }),
      prisma.shopProduct.findMany({
        where: {
          isActive: true,
          ...(category && category !== 'All' ? { category } : {}),
          ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
        },
        include: { shop: { select: { shopName: true, slug: true, parish: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json([...affiliateListings.map(normalizeAffiliateListing), ...shopProducts.map(normalizeShopProduct)]);
  } catch (err) {
    next(err);
  }
});

// Single-item product page: the exact listing (affiliate or shop, tried in
// that order — ids can't collide between the two tables), its rating
// summary, a "More from this seller" rail, and a "Similar Items" rail
// (same category, any seller). Public, same as /listings.
commerceRouter.get('/listings/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);

    const affiliateListing = await prisma.storeListing.findUnique({
      where: { id },
      include: {
        masterProduct: { include: { warehouse: { select: { parish: true, resellerCommissionPercent: true } } } },
        store: { select: { storeName: true, slug: true } },
      },
    });

    let listing: ReturnType<typeof normalizeAffiliateListing> | ReturnType<typeof normalizeShopProduct>;
    let category: string;

    if (affiliateListing) {
      if (!affiliateListing.isActive || !affiliateListing.masterProduct.isActive) {
        throw new HttpError(404, 'This item is no longer available');
      }
      listing = normalizeAffiliateListing(affiliateListing);
      category = affiliateListing.masterProduct.category;
    } else {
      const shopProduct = await prisma.shopProduct.findUnique({
        where: { id },
        include: { shop: { select: { shopName: true, slug: true, parish: true } } },
      });
      if (!shopProduct || !shopProduct.isActive) throw new HttpError(404, 'This item is no longer available');
      listing = normalizeShopProduct(shopProduct);
      category = shopProduct.category;
    }

    const RAIL_LIMIT = 8;
    const [recommendedAffiliate, recommendedShop, sellerAffiliate, sellerShop, ratingRow] = await Promise.all([
      prisma.storeListing.findMany({
        where: { isActive: true, id: { not: id }, masterProduct: { isActive: true, category } },
        include: {
          masterProduct: { include: { warehouse: { select: { parish: true, resellerCommissionPercent: true } } } },
          store: { select: { storeName: true, slug: true } },
        },
        orderBy: { masterProduct: { createdAt: 'desc' } },
        take: RAIL_LIMIT,
      }),
      prisma.shopProduct.findMany({
        where: { isActive: true, id: { not: id }, category },
        include: { shop: { select: { shopName: true, slug: true, parish: true } } },
        orderBy: { createdAt: 'desc' },
        take: RAIL_LIMIT,
      }),
      // "More from this seller" — same storeId, any category, only queried
      // for the kind this listing actually is (the other findMany below
      // stays empty by construction since listing.storeId can't match rows
      // in the other table).
      listing.kind === 'AFFILIATE'
        ? prisma.storeListing.findMany({
            where: { isActive: true, id: { not: id }, storeId: listing.storeId, masterProduct: { isActive: true } },
            include: {
              masterProduct: { include: { warehouse: { select: { parish: true, resellerCommissionPercent: true } } } },
              store: { select: { storeName: true, slug: true } },
            },
            orderBy: { masterProduct: { createdAt: 'desc' } },
            take: RAIL_LIMIT,
          })
        : Promise.resolve([]),
      listing.kind === 'STORE'
        ? prisma.shopProduct.findMany({
            where: { isActive: true, id: { not: id }, shopId: listing.storeId },
            include: { shop: { select: { shopName: true, slug: true, parish: true } } },
            orderBy: { createdAt: 'desc' },
            take: RAIL_LIMIT,
          })
        : Promise.resolve([]),
      prisma.$queryRaw<{ average: number | null; count: bigint }[]>`
        SELECT AVG(rating)::float AS average, COUNT(*)::int AS count
        FROM product_ratings
        WHERE store_listing_id = ${id}::uuid OR shop_product_id = ${id}::uuid
      `,
    ]);

    const recommended = [
      ...recommendedAffiliate.map(normalizeAffiliateListing),
      ...recommendedShop.map(normalizeShopProduct),
    ].slice(0, RAIL_LIMIT);
    const moreFromSeller = [
      ...sellerAffiliate.map(normalizeAffiliateListing),
      ...sellerShop.map(normalizeShopProduct),
    ].slice(0, RAIL_LIMIT);
    const rating = { average: ratingRow[0]?.average ?? null, count: Number(ratingRow[0]?.count ?? 0) };

    res.json({ ...listing, rating, moreFromSeller, recommended });
  } catch (err) {
    next(err);
  }
});

// The reseller dashboard's landing check: does the current user already have
// a store, or do they need to create one first? Registered before the
// `/stores/:slug` route below — otherwise Express would match "mine" as a slug.
commerceRouter.get('/stores/mine', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const store = await prisma.resellerStore.findUnique({ where: { userId: req.user!.sub } });
    res.json(store);
  } catch (err) {
    next(err);
  }
});

// Public storefront lookup — checks reseller stores first, then shops
// (slugs can't collide between the two tables, see assertSlugAvailable-style
// checks above and in shop.routes.ts). A shop's response is normalized to
// the same { storeName, slug, listings: [...] } shape so StorefrontPage.jsx
// doesn't need to know which kind of seller it's rendering.
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
    if (store) return res.json({ ...store, kind: 'AFFILIATE' });

    const shop = await prisma.shop.findUnique({
      where: { slug: req.params.slug },
      include: { products: { where: { isActive: true } } },
    });
    if (shop) {
      return res.json({
        id: shop.id,
        storeName: shop.shopName,
        slug: shop.slug,
        kind: 'STORE',
        listings: shop.products.map((p) => ({
          id: p.id,
          retailPriceJmd: p.priceJmd,
          isActive: p.isActive,
          masterProduct: { ...p, wholesalePriceJmd: p.priceJmd },
        })),
      });
    }

    throw new HttpError(404, 'Store not found');
  } catch (err) {
    next(err);
  }
});

// A reseller's own view of exactly what's been added to their account —
// drives the reseller Products page (browsing the full catalog isn't
// possible; only granted items are, since that's all they can sell anyway).
commerceRouter.get('/grants/mine', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const store = await prisma.resellerStore.findUnique({ where: { userId: req.user!.sub } });
    if (!store) return res.json([]);

    const grants = await prisma.resellerProductGrant.findMany({
      where: { storeId: store.id },
      include: { masterProduct: { include: { warehouse: { select: { id: true, name: true, resellerCommissionPercent: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(grants);
  } catch (err) {
    next(err);
  }
});

const createListingSchema = z.object({
  masterProductId: z.string().uuid(),
});

// Reseller adds a master-warehouse SKU to their storefront — the retail
// price is no longer something a reseller sets: it's the warehouse's
// (post-discount) wholesale price plus the warehouse's own reseller
// commission % plus the platform's cut, computed live wherever it's shown
// or charged (see lib/pricing.ts). retailPriceJmd is still stored on the
// row as an informational snapshot only — never trusted for money math.
commerceRouter.post('/stores/:storeId/listings', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = createListingSchema.parse(req.body);
    const store = await prisma.resellerStore.findUnique({ where: { id: String(req.params.storeId) } });
    if (!store) throw new HttpError(404, 'Store not found');
    if (store.userId !== req.user!.sub && req.user!.role !== UserRole.ADMIN) {
      throw new HttpError(403, 'You do not own this store');
    }

    const product = await prisma.masterProduct.findUnique({
      where: { id: input.masterProductId },
      include: { warehouse: { select: { resellerCommissionPercent: true } } },
    });
    if (!product) throw new HttpError(404, 'Master product not found');

    const { retailTotalJmd } = computeAffiliatePricing({
      wholesalePriceJmd: product.wholesalePriceJmd.toString(),
      discountPercent: product.discountPercent,
      resellerCommissionPercent: product.warehouse.resellerCommissionPercent,
    });

    // Domain B, two gates: (1) the warehouse has approved this reseller at
    // all, and (2) the warehouse has specifically granted this SKU to them —
    // approval alone no longer opens the whole catalog (see authorization.routes.ts
    // for approvals, warehouse.routes.ts for per-item grants). Admins bypass both.
    if (req.user!.role !== UserRole.ADMIN) {
      const authorization = await prisma.resellerAuthorization.findUnique({
        where: { storeId_warehouseId: { storeId: store.id, warehouseId: product.warehouseId } },
      });
      if (authorization?.status !== 'APPROVED') {
        throw new HttpError(403, 'You are not approved to sell stock from this warehouse yet');
      }

      const grant = await prisma.resellerProductGrant.findUnique({
        where: { storeId_masterProductId: { storeId: store.id, masterProductId: product.id } },
      });
      if (!grant) {
        throw new HttpError(403, 'This warehouse has not added this item to your account yet');
      }
    }

    // Upsert, not create: the unique (storeId, masterProductId) constraint means
    // "add this item" is idempotent — re-adding (or re-adding after removal)
    // reactivates the same row and refreshes the price snapshot, rather than
    // erroring.
    const listing = await prisma.storeListing.upsert({
      where: { storeId_masterProductId: { storeId: store.id, masterProductId: product.id } },
      create: { storeId: store.id, masterProductId: product.id, retailPriceJmd: retailTotalJmd.toFixed(2) },
      update: { retailPriceJmd: retailTotalJmd.toFixed(2), isActive: true },
    });
    res.status(201).json(listing);
  } catch (err) {
    next(err);
  }
});

async function assertOwnsStore(storeId: string, userId: string, isAdmin: boolean) {
  const store = await prisma.resellerStore.findUnique({ where: { id: storeId } });
  if (!store) throw new HttpError(404, 'Store not found');
  if (store.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this store');
  return store;
}

// The "Orders" dashboard tab's full order history for this reseller store,
// each row including its item title and rating/feedback if the customer has
// left one — mirrors warehouse.routes.ts / shop.routes.ts's GET .../orders.
commerceRouter.get('/stores/:storeId/orders', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsStore(String(req.params.storeId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const orders = await prisma.order.findMany({
      where: {
        resellerStoreId: String(req.params.storeId),
        ...(status ? { status: status as 'PACKING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'DELIVERED' } : {}),
      },
      include: {
        storeListing: { select: { masterProduct: { select: { title: true } } } },
        rating: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// Feedback (rating + optional written comment) left on this reseller's
// storefront — an AFFILIATE order's item is a StoreListing, which both the
// reseller who sold it and the warehouse that supplied it can see feedback
// for (see warehouse.routes.ts's GET /:warehouseId/feedback for the same
// rows filtered from the warehouse's side).
commerceRouter.get('/stores/:storeId/feedback', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsStore(String(req.params.storeId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const feedback = await prisma.productRating.findMany({
      where: { storeListing: { storeId: String(req.params.storeId) } },
      include: {
        customer: { select: { fullName: true } },
        storeListing: { select: { masterProduct: { select: { title: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(feedback);
  } catch (err) {
    next(err);
  }
});

// A reseller removes an item from their storefront (soft delete — keeps the
// row/history, just stops it showing in the marketplace or their own store page).
commerceRouter.delete('/stores/:storeId/listings/:listingId', requireAuth, requireRole(UserRole.RESELLER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const store = await prisma.resellerStore.findUnique({ where: { id: String(req.params.storeId) } });
    if (!store) throw new HttpError(404, 'Store not found');
    if (store.userId !== req.user!.sub && req.user!.role !== UserRole.ADMIN) {
      throw new HttpError(403, 'You do not own this store');
    }

    const listing = await prisma.storeListing.findUnique({ where: { id: String(req.params.listingId) } });
    if (!listing || listing.storeId !== store.id) throw new HttpError(404, 'Listing not found');

    await prisma.storeListing.update({ where: { id: listing.id }, data: { isActive: false } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
