import { Router, type Request } from 'express';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertWarehouseAccess } from '../../lib/warehouseAccess.js';

export const deliveryRouter = Router();

// A driver applies to become a regular courier for a warehouse or a shop —
// exactly one of the two, mirroring how Order tells an affiliate leg from a
// store leg (see DeliveryApplication in schema.prisma).
const applySchema = z
  .object({
    warehouseId: z.string().uuid().optional(),
    shopId: z.string().uuid().optional(),
  })
  .refine((v) => Boolean(v.warehouseId) !== Boolean(v.shopId), {
    message: 'Provide exactly one of warehouseId or shopId',
  });

async function requireDriverProfile(userId: string) {
  const driver = await prisma.driverProfile.findUnique({ where: { userId } });
  if (!driver) throw new HttpError(400, 'Complete your driver application before applying to deliver');
  return driver;
}

deliveryRouter.post('/', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const input = applySchema.parse(req.body);
    const driver = await requireDriverProfile(req.user!.sub);

    const where = input.warehouseId
      ? { driverId_warehouseId: { driverId: driver.id, warehouseId: input.warehouseId } }
      : { driverId_shopId: { driverId: driver.id, shopId: input.shopId! } };

    if (input.warehouseId) {
      const warehouse = await prisma.warehouse.findUnique({ where: { id: input.warehouseId } });
      if (!warehouse) throw new HttpError(404, 'Warehouse not found');
    } else {
      const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
      if (!shop) throw new HttpError(404, 'Shop not found');
    }

    const existing = await prisma.deliveryApplication.findUnique({ where });
    if (existing?.status === 'APPROVED') throw new HttpError(409, 'Already approved to deliver for this warehouse/shop');
    if (existing?.status === 'PENDING') throw new HttpError(409, 'Application already pending');

    const application = await prisma.deliveryApplication.upsert({
      where,
      create: { driverId: driver.id, warehouseId: input.warehouseId, shopId: input.shopId },
      update: { status: 'PENDING', decidedAt: null },
    });

    res.status(201).json(application);
  } catch (err) {
    next(err);
  }
});

// A driver's view of their own applications, across every warehouse/shop.
deliveryRouter.get('/mine', requireAuth, requireRole(UserRole.DRIVER, UserRole.ADMIN), async (req, res, next) => {
  try {
    const driver = await prisma.driverProfile.findUnique({ where: { userId: req.user!.sub } });
    if (!driver) return res.json([]);

    const applications = await prisma.deliveryApplication.findMany({
      where: { driverId: driver.id },
      include: {
        warehouse: { select: { id: true, name: true, parish: true } },
        shop: { select: { id: true, shopName: true, parish: true } },
      },
      orderBy: { requestedAt: 'desc' },
    });
    res.json(applications);
  } catch (err) {
    next(err);
  }
});

const decideSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
});

async function assertApplicationAccess(applicationId: string, user: NonNullable<Request['user']>) {
  const application = await prisma.deliveryApplication.findUnique({
    where: { id: applicationId },
    include: { shop: true },
  });
  if (!application) throw new HttpError(404, 'Application not found');

  if (application.warehouseId) {
    // Owner, admins and staff of the warehouse may all decide applications.
    await assertWarehouseAccess(application.warehouseId, user);
  } else if (application.shop?.userId !== user.sub && user.role !== UserRole.ADMIN) {
    throw new HttpError(403, 'You do not own this warehouse/shop');
  }
  return application;
}

// A warehouse or store operator approves/rejects a pending application, or
// suspends/unsuspends (APPROVED <-> SUSPENDED) an existing courier — mirrors
// authorization.routes.ts's PATCH /:id for reseller applications.
deliveryRouter.patch(
  '/:id',
  requireAuth,
  requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const input = decideSchema.parse(req.body);
      const application = await assertApplicationAccess(String(req.params.id), req.user!);

      const updated = await prisma.deliveryApplication.update({
        where: { id: application.id },
        data: { status: input.status, decidedAt: new Date() },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// Fully revokes a driver's relationship with this warehouse/shop.
deliveryRouter.delete(
  '/:id',
  requireAuth,
  requireRole(UserRole.WAREHOUSE, UserRole.STORE, UserRole.ADMIN),
  async (req, res, next) => {
    try {
      const application = await assertApplicationAccess(String(req.params.id), req.user!);
      await prisma.deliveryApplication.delete({ where: { id: application.id } });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
