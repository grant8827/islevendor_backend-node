import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { imageUrlSchema } from '../../lib/validation.js';
import { createWithGeneratedSku } from '../../lib/sku.js';

export const shopRouter = Router();

const createShopSchema = z.object({
  shopName: z.string().min(1),
  slug: z
    .string()
    .min(3)
    .regex(/^[a-z0-9\-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens'),
  addressLine: z.string().min(1),
  parish: z.string().default('Kingston'),
  lat: z.number(),
  lng: z.number(),
});

// Slugs are public URL paths (/shop/:slug, /store/:slug) shared across two
// separate tables (shops, reseller_stores) — each is unique within its own
// table, but nothing stops the same slug existing in both unless we check
// here too.
async function assertSlugAvailable(slug: string) {
  const [shop, resellerStore] = await Promise.all([
    prisma.shop.findUnique({ where: { slug } }),
    prisma.resellerStore.findUnique({ where: { slug } }),
  ]);
  if (shop || resellerStore) throw new HttpError(409, 'That store slug is already taken');
}

// A shop owner registers their small business, including its spatial point
// (needed for driver dispatch, same as a warehouse) — written via raw SQL
// since Prisma can't set a `geometry` column directly.
shopRouter.post('/', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = createShopSchema.parse(req.body);
    await assertSlugAvailable(input.slug);

    const id = randomUUID();
    const [shop] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO shops (id, user_id, shop_name, slug, address_line, parish, location)
      VALUES (${id}::uuid, ${req.user!.sub}::uuid, ${input.shopName}, ${input.slug}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326))
      RETURNING id
    `;

    res.status(201).json({ id: shop.id });
  } catch (err) {
    next(err);
  }
});

// Browse all registered shops — used by drivers deciding who to apply to
// deliver for (mirrors warehouseRouter's GET '/').
shopRouter.get('/', async (req, res, next) => {
  try {
    const shops = await prisma.shop.findMany({
      select: { id: true, shopName: true, addressLine: true, parish: true, _count: { select: { products: true } } },
    });
    res.json(shops);
  } catch (err) {
    next(err);
  }
});

// The shop dashboard's landing check: every shop this user owns (an owner
// can run more than one), so the dashboard can offer a selector — or the
// "create your first shop" form if this is empty.
shopRouter.get('/mine', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const shops = await prisma.shop.findMany({
      where: { userId: req.user!.sub },
      orderBy: { shopName: 'asc' },
    });
    res.json(shops);
  } catch (err) {
    next(err);
  }
});

async function assertOwnsShop(shopId: string, userId: string, isAdmin: boolean) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new HttpError(404, 'Shop not found');
  if (shop.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this shop');
  return shop;
}

const createProductSchema = z.object({
  shopId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  priceJmd: z.number().positive(),
  discountPercent: z.number().int().min(0).max(90).default(0),
  stockQuantity: z.number().int().min(0).default(0),
  // images[0] is the main photo; the rest are gallery-only. SKU is no
  // longer taken from the seller — it's generated server-side below.
  images: z.array(imageUrlSchema).min(1),
});

shopRouter.post('/products', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = createProductSchema.parse(req.body);
    await assertOwnsShop(input.shopId, req.user!.sub, req.user!.role === UserRole.ADMIN);

    const product = await createWithGeneratedSku(input.category, (sku) =>
      prisma.shopProduct.create({
        data: {
          shopId: input.shopId,
          sku,
          title: input.title,
          description: input.description,
          category: input.category,
          priceJmd: input.priceJmd,
          discountPercent: input.discountPercent,
          stockQuantity: input.stockQuantity,
          imageUrl: input.images[0],
          images: input.images,
        },
      }),
    );

    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

shopRouter.get('/products', async (req, res, next) => {
  try {
    const products = await prisma.shopProduct.findMany({
      where: { shopId: req.query.shopId as string | undefined },
      orderBy: { createdAt: 'desc' },
    });
    res.json(products);
  } catch (err) {
    next(err);
  }
});

async function assertOwnsProduct(productId: string, userId: string, isAdmin: boolean) {
  const product = await prisma.shopProduct.findUnique({ where: { id: productId }, include: { shop: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.shop.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this product');
  return product;
}

const updateProductSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  category: z.string().min(1).optional(),
  priceJmd: z.number().positive().optional(),
  discountPercent: z.number().int().min(0).max(90).optional(),
  stockQuantity: z.number().int().min(0).optional(),
  images: z.array(imageUrlSchema).min(1).optional(),
  isActive: z.boolean().optional(),
});

// Edit a product's fields, and/or suspend/unsuspend it — one endpoint for
// both, mirroring warehouse.routes.ts's PATCH /products/:id.
shopRouter.patch('/products/:id', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { images, ...rest } = updateProductSchema.parse(req.body);
    const product = await assertOwnsProduct(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    // imageUrl always mirrors images[0] — see schema.prisma comment.
    const updated = await prisma.shopProduct.update({
      where: { id: product.id },
      data: { ...rest, ...(images ? { images, imageUrl: images[0] } : {}) },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// A shop's products have no separate "listing" layer (the shop sells its own
// items directly), so — unlike a warehouse SKU — nothing else references a
// shop product, and it's always safe to remove outright.
shopRouter.delete('/products/:id', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const product = await assertOwnsProduct(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);
    await prisma.shopProduct.delete({ where: { id: product.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Driver applications to become a courier for this shop (see
// delivery.routes.ts for the driver-side "apply" endpoint).
shopRouter.get('/:shopId/delivery-applications', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsShop(String(req.params.shopId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const applications = await prisma.deliveryApplication.findMany({
      where: {
        shopId: String(req.params.shopId),
        ...(status ? { status: status as 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REJECTED' } : {}),
      },
      include: { driver: { include: { user: { select: { fullName: true, phoneNumber: true } } } } },
      orderBy: { requestedAt: 'desc' },
    });
    res.json(applications);
  } catch (err) {
    next(err);
  }
});

// The shop's packing queue — orders waiting to be boxed (see
// dispatch.routes.ts for the "mark ready for pickup" transition).
shopRouter.get('/:shopId/orders', requireAuth, requireRole(UserRole.STORE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsShop(String(req.params.shopId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const orders = await prisma.order.findMany({
      where: {
        shopId: String(req.params.shopId),
        ...(status ? { status: status as 'PACKING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'DELIVERED' } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});
