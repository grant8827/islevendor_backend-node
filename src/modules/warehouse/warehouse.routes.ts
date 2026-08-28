import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { imageUrlSchema } from '../../lib/validation.js';
import { createWithGeneratedSku } from '../../lib/sku.js';

export const warehouseRouter = Router();

const createWarehouseSchema = z.object({
  name: z.string().min(1),
  addressLine: z.string().min(1),
  parish: z.string().default('Kingston'),
  lat: z.number(),
  lng: z.number(),
  // What resellers earn (as a % of this warehouse's own wholesale price) for
  // selling a SKU — see Warehouse.resellerCommissionPercent's doc comment.
  // Defaults to the schema's own default when omitted.
  resellerCommissionPercent: z.number().int().min(0).max(100).optional(),
});

// A warehouse operator registers their depot, including its spatial point —
// written via raw SQL since Prisma can't set a `geometry` column directly.
warehouseRouter.post('/', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = createWarehouseSchema.parse(req.body);

    // Raw INSERT bypasses Prisma Client's id generation (its @default(uuid())
    // is applied client-side, not as a DB DEFAULT) — generate it ourselves.
    // resellerCommissionPercent, when omitted, falls back to the column's own
    // DB default (COALESCE) rather than a hardcoded literal here.
    const id = randomUUID();
    const [warehouse] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO warehouses (id, user_id, name, address_line, parish, location, reseller_commission_percent)
      VALUES (${id}::uuid, ${req.user!.sub}::uuid, ${input.name}, ${input.addressLine}, ${input.parish},
              ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326),
              COALESCE(${input.resellerCommissionPercent ?? null}, 20))
      RETURNING id
    `;

    res.status(201).json({ id: warehouse.id });
  } catch (err) {
    next(err);
  }
});

// Browse all registered warehouses — used by resellers deciding who to apply to.
warehouseRouter.get('/', async (req, res, next) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      select: {
        id: true,
        name: true,
        addressLine: true,
        parish: true,
        resellerCommissionPercent: true,
        _count: { select: { products: true } },
      },
    });
    res.json(warehouses);
  } catch (err) {
    next(err);
  }
});

// The reseller-side "job board": every ACTIVE vacancy, across every
// warehouse, newest first — a warehouse with no active vacancy simply has
// no rows here (see Vacancy's doc comment in schema.prisma). Public, same
// openness as GET '/' above; applying still goes through the existing
// POST /authorizations (authorization.routes.ts).
warehouseRouter.get('/vacancies', async (req, res, next) => {
  try {
    const vacancies = await prisma.vacancy.findMany({
      where: { isActive: true },
      include: {
        warehouse: {
          select: {
            id: true,
            name: true,
            addressLine: true,
            parish: true,
            resellerCommissionPercent: true,
            _count: { select: { products: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(vacancies);
  } catch (err) {
    next(err);
  }
});

const createProductSchema = z.object({
  warehouseId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  category: z.string().min(1),
  wholesalePriceJmd: z.number().positive(),
  // This warehouse's own B2B discount off its wholesale price — see
  // MasterProduct.discountPercent's doc comment for how it cascades into
  // the reseller's and platform's cut, and the customer's final price.
  discountPercent: z.number().int().min(0).max(90).default(0),
  condition: z.enum(['NEW', 'USED']).default('NEW'),
  // Free text shown to customers — return policy, warranty, care
  // instructions, etc.
  productDetails: z.string().max(4000).optional(),
  stockQuantity: z.number().int().min(0).default(0),
  // images[0] is the main photo; the rest are gallery-only. SKU is no
  // longer taken from the seller — it's generated server-side below.
  images: z.array(imageUrlSchema).min(1),
});

warehouseRouter.post('/products', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = createProductSchema.parse(req.body);

    // Which of the owner's (possibly several) warehouses this product
    // belongs to is an explicit choice on the add-product form, not
    // implied by whichever warehouse happens to be selected in the
    // dashboard's switcher — see warehouse/ProductsPanel.jsx.
    const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
    if (!warehouse) throw new HttpError(404, 'Warehouse not found');
    if (warehouse.userId !== req.user!.sub && req.user!.role !== UserRole.ADMIN) {
      throw new HttpError(403, 'You do not own this warehouse');
    }

    const product = await createWithGeneratedSku(input.category, (sku) =>
      prisma.masterProduct.create({
        data: {
          warehouseId: input.warehouseId,
          sku,
          title: input.title,
          description: input.description,
          category: input.category,
          wholesalePriceJmd: input.wholesalePriceJmd,
          discountPercent: input.discountPercent,
          condition: input.condition,
          productDetails: input.productDetails,
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

async function assertOwnsProduct(productId: string, userId: string, isAdmin: boolean) {
  const product = await prisma.masterProduct.findUnique({ where: { id: productId }, include: { warehouse: true } });
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.warehouse.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this product');
  return product;
}

const updateProductSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  category: z.string().min(1).optional(),
  wholesalePriceJmd: z.number().positive().optional(),
  discountPercent: z.number().int().min(0).max(90).optional(),
  condition: z.enum(['NEW', 'USED']).optional(),
  productDetails: z.string().max(4000).nullable().optional(),
  stockQuantity: z.number().int().min(0).optional(),
  images: z.array(imageUrlSchema).min(1).optional(),
  isActive: z.boolean().optional(),
});

// Edit a product's fields, and/or suspend/unsuspend it (isActive) — one
// endpoint for both, since the dashboard's edit form and its suspend toggle
// are really the same "update this product" action.
warehouseRouter.patch('/products/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const { images, ...rest } = updateProductSchema.parse(req.body);
    const product = await assertOwnsProduct(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const updated = await prisma.masterProduct.update({
      where: { id: product.id },
      // imageUrl always mirrors images[0] — see schema.prisma comment.
      data: { ...rest, ...(images ? { images, imageUrl: images[0] } : {}) },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Permanently removes a product — blocked if any reseller has it listed, since
// that would silently vanish items off their storefronts. Suspend instead.
warehouseRouter.delete('/products/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const product = await assertOwnsProduct(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const listingCount = await prisma.storeListing.count({ where: { masterProductId: product.id } });
    if (listingCount > 0) {
      throw new HttpError(409, 'This product is listed by one or more resellers — suspend it instead, or ask them to remove it first');
    }

    await prisma.masterProduct.delete({ where: { id: product.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

warehouseRouter.get('/products', async (req, res, next) => {
  try {
    const products = await prisma.masterProduct.findMany({
      where: { warehouseId: req.query.warehouseId as string | undefined },
      orderBy: { createdAt: 'desc' },
    });
    res.json(products);
  } catch (err) {
    next(err);
  }
});

// The warehouse dashboard's landing check: every warehouse this user owns
// (an owner can run more than one depot), so the dashboard can offer a
// selector — or the "create your first warehouse" form if this is empty.
warehouseRouter.get('/mine', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      where: { userId: req.user!.sub },
      orderBy: { name: 'asc' },
    });
    res.json(warehouses);
  } catch (err) {
    next(err);
  }
});

async function assertOwnsWarehouse(warehouseId: string, userId: string, isAdmin: boolean) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new HttpError(404, 'Warehouse not found');
  if (warehouse.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this warehouse');
  return warehouse;
}

const updateWarehouseSchema = z.object({
  resellerCommissionPercent: z.number().int().min(0).max(100).optional(),
});

// Edit warehouse settings — today just the reseller commission % that
// Vacancy postings (below) advertise to prospective resellers.
warehouseRouter.patch('/:warehouseId', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = updateWarehouseSchema.parse(req.body);
    const warehouse = await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const updated = await prisma.warehouse.update({ where: { id: warehouse.id }, data: input });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const vacancySchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

// This warehouse's own vacancy postings (owner-side "Vacancies" tab) —
// active or not, unlike the public GET /vacancies above which only ever
// shows active ones to resellers.
warehouseRouter.get('/:warehouseId/vacancies', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const vacancies = await prisma.vacancy.findMany({
      where: { warehouseId: String(req.params.warehouseId) },
      orderBy: { createdAt: 'desc' },
    });
    res.json(vacancies);
  } catch (err) {
    next(err);
  }
});

warehouseRouter.post('/:warehouseId/vacancies', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = vacancySchema.parse(req.body);
    const warehouse = await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const vacancy = await prisma.vacancy.create({
      data: { warehouseId: warehouse.id, title: input.title, description: input.description },
    });
    res.status(201).json(vacancy);
  } catch (err) {
    next(err);
  }
});

async function assertOwnsVacancy(vacancyId: string, userId: string, isAdmin: boolean) {
  const vacancy = await prisma.vacancy.findUnique({ where: { id: vacancyId }, include: { warehouse: true } });
  if (!vacancy) throw new HttpError(404, 'Vacancy not found');
  if (vacancy.warehouse.userId !== userId && !isAdmin) throw new HttpError(403, 'You do not own this vacancy');
  return vacancy;
}

const updateVacancySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// Edit a vacancy's fields, and/or toggle it active/inactive — one endpoint
// for both, same "edit form and its suspend toggle are the same action"
// pattern as PATCH /products/:id.
warehouseRouter.patch('/vacancies/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = updateVacancySchema.parse(req.body);
    const vacancy = await assertOwnsVacancy(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const updated = await prisma.vacancy.update({ where: { id: vacancy.id }, data: input });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

warehouseRouter.delete('/vacancies/:id', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const vacancy = await assertOwnsVacancy(String(req.params.id), req.user!.sub, req.user!.role === UserRole.ADMIN);
    await prisma.vacancy.delete({ where: { id: vacancy.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Reseller applications to sell this warehouse's stock (see authorization.routes.ts
// for the reseller-side "apply" endpoint).
warehouseRouter.get('/:warehouseId/authorizations', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const authorizations = await prisma.resellerAuthorization.findMany({
      where: {
        warehouseId: String(req.params.warehouseId),
        ...(status ? { status: status as 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REJECTED' } : {}),
      },
      include: { store: { select: { id: true, storeName: true, slug: true } } },
      orderBy: { requestedAt: 'desc' },
    });
    res.json(authorizations);
  } catch (err) {
    next(err);
  }
});

// Driver applications to become a courier for this warehouse (see
// delivery.routes.ts for the driver-side "apply" endpoint).
warehouseRouter.get('/:warehouseId/delivery-applications', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const applications = await prisma.deliveryApplication.findMany({
      where: {
        warehouseId: String(req.params.warehouseId),
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

async function assertResellerRelationship(warehouseId: string, storeId: string) {
  const authorization = await prisma.resellerAuthorization.findUnique({
    where: { storeId_warehouseId: { storeId, warehouseId } },
  });
  if (!authorization || authorization.status === 'REJECTED') {
    throw new HttpError(404, 'This store has no relationship with your warehouse');
  }
  return authorization;
}

// Which of this warehouse's products has this specific reseller been
// granted permission to sell? Powers the "assign items" checklist.
warehouseRouter.get('/:warehouseId/resellers/:storeId/grants', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);
    await assertResellerRelationship(String(req.params.warehouseId), String(req.params.storeId));

    const grants = await prisma.resellerProductGrant.findMany({
      where: { storeId: String(req.params.storeId), masterProduct: { warehouseId: String(req.params.warehouseId) } },
      select: { masterProductId: true },
    });
    res.json(grants.map((g) => g.masterProductId));
  } catch (err) {
    next(err);
  }
});

const setGrantSchema = z.object({
  masterProductId: z.string().uuid(),
  granted: z.boolean(),
});

// The core of "only what's been added to their account is sellable": the
// warehouse toggles a single product's grant for a specific reseller.
// Revoking also deactivates any listing the reseller already made for it.
warehouseRouter.put('/:warehouseId/resellers/:storeId/grants', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = setGrantSchema.parse(req.body);
    const warehouseId = String(req.params.warehouseId);
    const storeId = String(req.params.storeId);

    await assertOwnsWarehouse(warehouseId, req.user!.sub, req.user!.role === UserRole.ADMIN);
    await assertResellerRelationship(warehouseId, storeId);

    const product = await prisma.masterProduct.findUnique({ where: { id: input.masterProductId } });
    if (!product || product.warehouseId !== warehouseId) {
      throw new HttpError(404, 'Product not found in this warehouse');
    }

    if (input.granted) {
      await prisma.resellerProductGrant.upsert({
        where: { storeId_masterProductId: { storeId, masterProductId: product.id } },
        create: { storeId, masterProductId: product.id },
        update: {},
      });
    } else {
      await prisma.$transaction([
        prisma.resellerProductGrant.deleteMany({ where: { storeId, masterProductId: product.id } }),
        prisma.storeListing.updateMany({ where: { storeId, masterProductId: product.id }, data: { isActive: false } }),
      ]);
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// The warehouse's packing queue when filtered to ?status=PACKING, or —
// called with no status — the "Orders" dashboard tab's full order history,
// each row including its item title and rating/feedback if the customer has
// left one (see dispatch.routes.ts for the "mark ready for pickup" transition).
warehouseRouter.get('/:warehouseId/orders', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const orders = await prisma.order.findMany({
      where: {
        warehouseId: String(req.params.warehouseId),
        ...(status ? { status: status as 'PACKING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'DELIVERED' } : {}),
      },
      include: {
        resellerStore: { select: { storeName: true } },
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

// Feedback (rating + optional written comment) left on this warehouse's
// stock. An AFFILIATE order's item is a StoreListing, which both the
// warehouse that supplied it and the reseller who sold it can see feedback
// for — this query and commerce.routes.ts's GET /stores/:storeId/feedback
// are the same rows filtered from each side's own relationship to that
// listing. A STORE order's feedback never appears here — see shop.routes.ts.
warehouseRouter.get('/:warehouseId/feedback', requireAuth, requireRole(UserRole.WAREHOUSE, UserRole.ADMIN), async (req, res, next) => {
  try {
    await assertOwnsWarehouse(String(req.params.warehouseId), req.user!.sub, req.user!.role === UserRole.ADMIN);

    const feedback = await prisma.productRating.findMany({
      where: { storeListing: { masterProduct: { warehouseId: String(req.params.warehouseId) } } },
      include: {
        customer: { select: { fullName: true } },
        storeListing: {
          select: {
            masterProduct: { select: { title: true } },
            store: { select: { storeName: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(feedback);
  } catch (err) {
    next(err);
  }
});
