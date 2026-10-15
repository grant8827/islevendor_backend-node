import { Router } from 'express';
import { z } from 'zod';
import { Prisma, UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';
import { assertApprovedSeller } from '../../lib/eligibility.js';
import { computeAffiliatePricing } from '../../lib/pricing.js';

// A warehouse's own storefront ("house store") — the dashboard's My Store
// tab. It works exactly like a reseller's store (same public page at
// /store/:slug, same pricing, same checkout and shipping), except the
// warehouse runs it and can list any of its own products directly, with no
// reseller authorization or per-item grant. On a sale the warehouse is paid
// both its wholesale price and the margin (see ledger.service.ts). It's a
// ResellerStore row with houseWarehouseId set instead of a user.
//
// Owner and warehouse admins only — like the commission %, this is the
// warehouse's commercial decision, not a staff task.

const createSchema = z.object({
  storeName: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens'),
});

const updateSchema = z.object({ storeName: z.string().trim().min(1).max(100) });
const listingSchema = z.object({ masterProductId: z.string().uuid() });

const LISTING_INCLUDE = {
  masterProduct: { include: { warehouse: { select: { resellerCommissionPercent: true } } } },
} as const;

type Listing = Prisma.StoreListingGetPayload<{ include: typeof LISTING_INCLUDE }>;

/** A house store listing as the dashboard shows it: the product, and what customers pay for one. */
function toListingView(listing: Listing) {
  const { retailTotalJmd } = computeAffiliatePricing({
    wholesalePriceJmd: listing.masterProduct.wholesalePriceJmd.toString(),
    discountPercent: listing.masterProduct.discountPercent,
    resellerCommissionPercent: listing.masterProduct.warehouse.resellerCommissionPercent,
  });
  const { warehouse: _warehouse, ...product } = listing.masterProduct;
  return { id: listing.id, isActive: listing.isActive, retailPriceJmd: retailTotalJmd.toFixed(2), masterProduct: product };
}

async function loadHouseStore(warehouseId: string) {
  return prisma.resellerStore.findUnique({
    where: { houseWarehouseId: warehouseId },
    select: {
      id: true,
      storeName: true,
      slug: true,
      applicantStatus: true,
      listings: { include: LISTING_INCLUDE, orderBy: { masterProduct: { createdAt: 'desc' } } },
    },
  });
}

async function requireHouseStore(warehouseId: string) {
  const store = await loadHouseStore(warehouseId);
  if (!store) throw new HttpError(404, "This warehouse hasn't opened its own store yet");
  return store;
}

export function registerHouseStoreRoutes(router: Router) {
  const guard = [requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN)];

  // The house store and everything listed on it, or null if there isn't one yet.
  router.get('/:warehouseId/store', ...guard, async (req, res, next) => {
    try {
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      const store = await loadHouseStore(warehouse.id);
      res.json(store ? { ...store, listings: store.listings.map(toListingView) } : null);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:warehouseId/store', ...guard, async (req, res, next) => {
    try {
      const input = createSchema.parse(req.body);
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      assertApprovedSeller(warehouse, 'warehouse');

      // Slugs are public URL paths shared by every store and shop (/store/:slug).
      const [store, shop] = await Promise.all([
        prisma.resellerStore.findUnique({ where: { slug: input.slug } }),
        prisma.shop.findUnique({ where: { slug: input.slug } }),
      ]);
      if (store || shop) throw new HttpError(409, 'That store address is already taken');
      if (await prisma.resellerStore.count({ where: { houseWarehouseId: warehouse.id } })) {
        throw new HttpError(409, 'This warehouse already has its own store');
      }

      // Approved from the start: it's the warehouse itself selling, and the
      // warehouse has already been through IsleVendor's review.
      const created = await prisma.resellerStore.create({
        data: { houseWarehouseId: warehouse.id, storeName: input.storeName, slug: input.slug, applicantStatus: 'APPROVED' },
      });
      res.status(201).json({ ...created, listings: [] });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:warehouseId/store', ...guard, async (req, res, next) => {
    try {
      const input = updateSchema.parse(req.body);
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      const store = await requireHouseStore(warehouse.id);
      res.json(await prisma.resellerStore.update({ where: { id: store.id }, data: input, select: { id: true, storeName: true, slug: true } }));
    } catch (err) {
      next(err);
    }
  });

  // List one of the warehouse's own products on its store — no grant needed.
  router.post('/:warehouseId/store/listings', ...guard, async (req, res, next) => {
    try {
      const { masterProductId } = listingSchema.parse(req.body);
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      assertApprovedSeller(warehouse, 'warehouse');
      const store = await requireHouseStore(warehouse.id);

      const product = await prisma.masterProduct.findUnique({ where: { id: masterProductId } });
      if (!product || product.warehouseId !== warehouse.id) throw new HttpError(404, 'Product not found in this warehouse');

      const { retailTotalJmd } = computeAffiliatePricing({
        wholesalePriceJmd: product.wholesalePriceJmd.toString(),
        discountPercent: product.discountPercent,
        resellerCommissionPercent: warehouse.resellerCommissionPercent,
      });
      // Re-listing something taken down before just turns it back on.
      const listing = await prisma.storeListing.upsert({
        where: { storeId_masterProductId: { storeId: store.id, masterProductId } },
        create: { storeId: store.id, masterProductId, retailPriceJmd: retailTotalJmd.toFixed(2) },
        update: { isActive: true },
        include: LISTING_INCLUDE,
      });
      res.status(201).json(toListingView(listing));
    } catch (err) {
      next(err);
    }
  });

  // Take a product off the store. The listing is deactivated, not deleted,
  // so past orders and ratings that point at it stay intact.
  router.delete('/:warehouseId/store/listings/:listingId', ...guard, async (req, res, next) => {
    try {
      const { warehouse } = await assertWarehouseAccess(String(req.params.warehouseId), req.user!, { adminOnly: true });
      const store = await requireHouseStore(warehouse.id);
      const result = await prisma.storeListing.updateMany({
        where: { id: String(req.params.listingId), storeId: store.id },
        data: { isActive: false },
      });
      if (result.count === 0) throw new HttpError(404, 'Listing not found on this store');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });
}
